import "./styles.css";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { pushInfoToast } from "../notifications/toast";
import type { CdlcStatus, Org, PkgMeta, ScoreSummary } from "../api";
import {
  cdlcLocalStatus, cdlcMyOrgs, cdlcSearch, cdlcPublish, cdlcInstallRegistry,
  cdlcPreview, cdlcReadLocal, cdlcExport, scoreSummaryFiltered,
} from "../api";

function loopSubhead(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "cdlc-subhead";
  el.textContent = text;
  return el;
}
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function errorLine(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "cdlc-error";
  p.textContent = text;
  return p;
}

/** Compact square action button: an icon + a tooltip (no visible text), so
 *  rows stay legible in the narrow rail. The SVG string is trusted (from Icons). */
function iconButton(svg: string, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "cdlc-icon-btn";
  b.innerHTML = svg;
  b.setAttribute("aria-label", label);
  attachTooltip(b, label);
  b.addEventListener("click", onClick);
  return b;
}

export interface CdlcPanelOpts {
  groupId: string;
  groupLabel: string;
  groupColor?: string | null;
  groupRootDir?: string | null;
  onClose?: () => void;
  onNewContext?: () => void;
}

export class CdlcPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private orgs: Org[] = [];
  private score: ScoreSummary | null = null;
  private adoption = new Map<string, number>(); // package name → org-wide installs

  constructor(private opts: CdlcPanelOpts) {
    this.root = document.createElement("div");
    this.root.className = "cdlc-panel";

    const head = document.createElement("div");
    head.className = "cdlc-head";
    if (opts.groupColor) head.style.setProperty("--cdlc-accent", opts.groupColor);
    const title = document.createElement("span");
    title.className = "cdlc-title";
    title.textContent = `CDLC — ${opts.groupLabel}`;
    head.appendChild(title);

    // Re-export every CDLC source (agents/skills/context) to executor-native files.
    if (opts.groupRootDir) {
      const exportBtn = iconButton(
        Icons.refresh({ size: 15 }),
        "Re-export to executors (.claude, AGENTS.md, copilot)",
        () => void this.exportNow(exportBtn),
      );
      head.appendChild(exportBtn);
    }

    const closeBtn = document.createElement("button");
    closeBtn.className = "cdlc-close-btn";
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => this.close());
    head.appendChild(closeBtn);

    this.body = document.createElement("div");
    this.body.className = "cdlc-body";

    this.root.append(head, this.body);
  }

  setOrgs(orgs: Org[]): void {
    this.orgs = orgs;
  }

  /** The group this panel is scoped to — used to re-scope on group switch. */
  get groupId(): string {
    return this.opts.groupId;
  }

  mount(host: HTMLElement): this {
    host.appendChild(this.root);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) {
      this.body.textContent = "This group has no project folder.";
      return;
    }
    try {
      const [status, orgs, score] = await Promise.all([
        cdlcLocalStatus(cwd),
        cdlcMyOrgs().catch(() => [] as Org[]),
        scoreSummaryFiltered(this.opts.groupLabel ?? null).catch(() => null),
      ]);
      this.orgs = orgs;
      this.score = score;
      // Adoption: org-wide install counts for skills installed from the registry.
      this.adoption = new Map();
      if (orgs.length > 0) {
        const pkgs = await cdlcSearch(orgs[0].slug, null).catch(() => [] as PkgMeta[]);
        for (const p of pkgs) this.adoption.set(p.name, p.installs);
      }
      this.renderStatus(status);
    } catch (e) {
      this.body.textContent = `Failed to read CDLC: ${String(e)}`;
    }
  }

  renderStatus(s: CdlcStatus): void {
    this.body.replaceChildren();
    const cwd = this.opts.groupRootDir ?? null;

    // Skills section
    const skills = document.createElement("section");
    skills.className = "cdlc-skills";
    const sh = document.createElement("h3");
    sh.textContent = "Skills";
    skills.appendChild(sh);
    if (s.installed.length === 0) {
      const p = document.createElement("p");
      p.textContent = "No skills installed.";
      skills.appendChild(p);
    } else {
      for (const i of s.installed) {
        const actions: HTMLButtonElement[] = [];
        if (this.orgs.length > 0 && !i.source.startsWith("registry:")) {
          actions.push(iconButton(Icons.upload({ size: 15 }), "Publish to registry", () => void this.publish(i.name)));
        }
        skills.appendChild(this.skillCard({
          name: i.name,
          meta: `${i.version} · ${i.source}`,
          className: "cdlc-skill-row",
          fetchPreview: () => (cwd ? cdlcReadLocal(cwd, i.name) : Promise.resolve("(no project folder)")),
          actions,
        }));
      }
    }

    if (this.orgs.length > 0) {
      const searchRow = document.createElement("div");
      searchRow.className = "cdlc-search-row";
      const input = document.createElement("input");
      input.placeholder = `Search ${this.orgs[0].slug} registry…`;
      const go = document.createElement("button");
      go.textContent = "Search";
      const results = document.createElement("div");
      results.className = "cdlc-search-results";
      go.addEventListener("click", () => {
        void cdlcSearch(this.orgs[0].slug, input.value || null).then((rows: PkgMeta[]) => {
          results.replaceChildren();
          if (rows.length === 0) {
            results.replaceChildren();
            const none = document.createElement("p");
            none.className = "cdlc-empty";
            none.textContent = "No packages found.";
            results.appendChild(none);
          }
          const org = this.orgs[0].slug;
          for (const r of rows) {
            const inst = iconButton(Icons.download({ size: 15 }), "Install", () => void this.install(org, r.name, r.version));
            const installs = `${r.installs} ${r.installs === 1 ? "install" : "installs"}`;
            results.appendChild(this.skillCard({
              name: r.name,
              meta: `${r.version} · ${installs} · ${r.publisher_login}`,
              description: r.description,
              className: "cdlc-search-result",
              fetchPreview: () => cdlcPreview(org, r.name, r.version).then((p) => p.skill_md),
              actions: [inst],
            }));
          }
        }).catch((e) => { results.replaceChildren(errorLine(String(e))); });
      });
      searchRow.append(input, go);
      skills.append(searchRow, results);
    }

    // Context section
    const ctx = document.createElement("section");
    ctx.className = "cdlc-context";
    const ch = document.createElement("h3");
    ch.textContent = "Context";
    ctx.appendChild(ch);

    const newBtn = document.createElement("button");
    newBtn.className = "cdlc-new-context-btn";
    newBtn.textContent = "New context";
    newBtn.addEventListener("click", () => {
      this.opts.onNewContext?.();
    });
    ctx.appendChild(newBtn);

    for (const f of s.contextFiles) {
      const row = document.createElement("div");
      row.className = "cdlc-context-row";
      row.textContent = f;
      ctx.appendChild(row);
    }

    // Loop section — Observe/Adapt: adoption + inference footprint.
    const loop = document.createElement("section");
    loop.className = "cdlc-loop";
    const lh = document.createElement("h3");
    lh.textContent = "Loop";
    loop.appendChild(lh);

    // Adoption — org-wide installs for skills installed from the registry.
    const registrySkills = s.installed.filter((i) => i.source.startsWith("registry:"));
    if (registrySkills.length > 0) {
      loop.appendChild(loopSubhead("Adoption"));
      for (const i of registrySkills) {
        const row = document.createElement("div");
        row.className = "cdlc-loop-row";
        const name = document.createElement("span");
        name.className = "cdlc-name";
        name.textContent = i.name;
        const val = document.createElement("span");
        val.className = "cdlc-meta";
        const n = this.adoption.get(i.name);
        val.textContent = n === undefined ? "—" : `${n} ${n === 1 ? "install" : "installs"}`;
        row.append(name, val);
        loop.appendChild(row);
      }
    }

    // Inference — this group's footprint from the four Covenant primitives.
    if (this.score) {
      loop.appendChild(loopSubhead("Inference · this group"));
      const m = document.createElement("p");
      m.className = "cdlc-loop-metric";
      const sc = this.score;
      m.textContent = `${sc.total_specs} specs · ${sc.total_prompts} prompts · ${sc.total_commits} commits · ${fmtTokens(sc.total_tokens)} tokens`;
      loop.appendChild(m);
    }

    // Eval — deferred (the behavior-under-context TDD runner).
    const evalNote = document.createElement("p");
    evalNote.className = "cdlc-loop-note";
    evalNote.textContent = "Eval pass-rate (context-TDD) arrives in a later phase.";
    loop.appendChild(evalNote);

    this.body.append(skills, ctx, loop);
  }

  private async exportNow(btn: HTMLButtonElement): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    btn.disabled = true;
    try {
      await cdlcExport(cwd);
      await this.refresh();
      pushInfoToast({ message: `CDLC exported to .claude · AGENTS.md · copilot (${this.opts.groupLabel})` });
    } catch (e) {
      pushInfoToast({ message: `CDLC export failed: ${String(e)}` });
    } finally {
      btn.disabled = false;
    }
  }

  private async publish(name: string): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd || this.orgs.length === 0) return;
    const org = this.orgs[0].slug; // v1: publish to the caller's first org
    try {
      await cdlcPublish(cwd, org, name);
      await this.refresh();
      pushInfoToast({ message: `Published ${name} to ${org}` });
    } catch (e) {
      pushInfoToast({ message: `Publish failed: ${String(e)}` });
    }
  }

  private async install(org: string, name: string, version: string): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    try {
      await cdlcInstallRegistry(cwd, org, name, version, this.opts.groupLabel ?? null, null);
      await this.refresh();
      pushInfoToast({ message: `Installed ${name} ${version} · projected to executors` });
    } catch (e) {
      pushInfoToast({ message: `Install failed: ${String(e)}` });
    }
  }

  /** A skill/package card: name + meta + actions, a one-line description,
   *  and a Preview toggle that lazy-loads the full SKILL.md (rendered as
   *  plain text — registry content is untrusted, never innerHTML). */
  private skillCard(opts: {
    name: string;
    meta: string;
    description?: string;
    className: string;
    fetchPreview: () => Promise<string>;
    actions: HTMLButtonElement[];
  }): HTMLElement {
    const card = document.createElement("div");
    card.className = opts.className;

    const head = document.createElement("div");
    head.className = "cdlc-card-head";
    const name = document.createElement("span");
    name.className = "cdlc-name";
    name.textContent = opts.name;
    const meta = document.createElement("span");
    meta.className = "cdlc-meta";
    meta.textContent = opts.meta;
    head.append(name, meta);

    const pre = document.createElement("pre");
    pre.className = "cdlc-preview";
    pre.hidden = true;
    let loaded = false;
    const prev = document.createElement("button");
    prev.className = "cdlc-preview-btn cdlc-icon-btn";
    prev.innerHTML = Icons.eye({ size: 15 });
    prev.setAttribute("aria-label", "Preview");
    attachTooltip(prev, "Preview SKILL.md");
    prev.addEventListener("click", () => {
      const show = pre.hidden;
      pre.hidden = !show;
      prev.innerHTML = show ? Icons.eyeOff({ size: 15 }) : Icons.eye({ size: 15 });
      if (show && !loaded) {
        loaded = true;
        pre.textContent = "Loading…";
        void opts.fetchPreview()
          .then((md) => { pre.textContent = md.trim() || "(empty)"; })
          .catch((e) => { pre.textContent = `Failed to load: ${String(e)}`; loaded = false; });
      }
    });
    head.append(prev, ...opts.actions);
    card.appendChild(head);

    if (opts.description?.trim()) {
      const desc = document.createElement("p");
      desc.className = "cdlc-result-desc";
      desc.textContent = opts.description;
      card.appendChild(desc);
    }
    card.appendChild(pre);
    return card;
  }

  close(): void {
    this.root.remove();
    this.opts.onClose?.();
  }
}
