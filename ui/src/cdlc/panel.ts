import "./styles.css";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { pushInfoToast } from "../notifications/toast";
import { renderMarkdown } from "../mission/preview";
import type { CdlcStatus, Org, PkgMeta, ScoreSummary, EvalSkillSummary, CdlcEvalProgress } from "../api";
import {
  cdlcLocalStatus, cdlcMyOrgs, cdlcSearch, cdlcPublish, cdlcInstallRegistry,
  cdlcPreview, cdlcReadLocal, cdlcExport, scoreSummaryFiltered,
  cdlcEvalSummary, cdlcRunEvals, onCdlcEvalProgress,
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

/** One labelled cell of the inference stat strip. `hero` tints the value with
 *  the group accent — the loop's standout number. */
function statCell(value: string, label: string, hero = false): HTMLElement {
  const cell = document.createElement("div");
  cell.className = hero ? "cdlc-stat is-hero" : "cdlc-stat";
  const v = document.createElement("span");
  v.className = "cdlc-stat-val";
  v.textContent = value;
  const l = document.createElement("span");
  l.className = "cdlc-stat-lbl";
  l.textContent = label;
  cell.append(v, l);
  return cell;
}

/** A labelled progress meter: name + value on top, a thin accent bar below.
 *  Used for adoption (installs, scaled to the busiest skill) and eval pass-rate. */
function meterRow(name: string, value: string, pct: number, ok = false): HTMLElement {
  const row = document.createElement("div");
  row.className = "cdlc-meter";
  const top = document.createElement("div");
  top.className = "cdlc-meter-top";
  const n = document.createElement("span");
  n.className = "cdlc-name";
  n.textContent = name;
  const v = document.createElement("span");
  v.className = "cdlc-meta";
  v.textContent = value;
  top.append(n, v);
  const track = document.createElement("div");
  track.className = "cdlc-bar";
  const fill = document.createElement("div");
  fill.className = ok ? "cdlc-bar-fill is-ok" : "cdlc-bar-fill";
  fill.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  track.appendChild(fill);
  row.append(top, track);
  return row;
}

/** Drop a leading YAML frontmatter block (--- … ---) so it doesn't render as
 *  a paragraph. The skill name already lives in the reader header. */
function stripFrontmatter(md: string): string {
  return md.replace(/^﻿?\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}

/** Full-screen rendered-markdown reader for a SKILL.md — same vibe as the
 *  spec preview. renderMarkdown HTML-escapes every segment, so the untrusted
 *  registry content is safe to innerHTML here. Esc / backdrop / esc button closes. */
function openMarkdownReader(title: string, fetchMd: () => Promise<string>): void {
  const overlay = document.createElement("div");
  overlay.className = "cdlc-reader";
  overlay.innerHTML = `
    <header class="cdlc-reader-head">
      <span class="cdlc-reader-title"></span>
      <button type="button" class="cdlc-reader-close" aria-label="Close (Esc)"><kbd class="settings-esc">esc</kbd></button>
    </header>
    <article class="cdlc-reader-body mission-page-preview-body">Loading…</article>`;
  (overlay.querySelector(".cdlc-reader-title") as HTMLElement).textContent = title;
  const body = overlay.querySelector(".cdlc-reader-body") as HTMLElement;

  const close = (): void => {
    overlay.remove();
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") close(); };
  overlay.querySelector(".cdlc-reader-close")?.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", onKey);

  document.body.appendChild(overlay);
  void fetchMd()
    .then((md) => { body.innerHTML = renderMarkdown(stripFrontmatter(md).trim() || "(empty)"); })
    .catch((e) => { body.textContent = `Failed to load: ${String(e)}`; });
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
  /** Open a folder picker to set the group's project folder (empty state CTA). */
  onPickFolder?: () => void;
}

export class CdlcPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private orgs: Org[] = [];
  private score: ScoreSummary | null = null;
  private adoption = new Map<string, number>(); // package name → org-wide installs
  private evalRates = new Map<string, { passed: number; total: number }>();

  /** The root element of the panel — used in tests and by callers that need
   *  to query the rendered content without going through a host element. */
  get element(): HTMLElement { return this.root; }

  constructor(private opts: CdlcPanelOpts) {
    this.root = document.createElement("div");
    this.root.className = "cdlc-panel";

    const head = document.createElement("div");
    head.className = "cdlc-head";
    if (opts.groupColor) head.style.setProperty("--cdlc-accent", opts.groupColor);
    const mark = document.createElement("span");
    mark.className = "cdlc-mark";
    head.appendChild(mark);
    const title = document.createElement("span");
    title.className = "cdlc-title";
    title.textContent = `CDLC — ${opts.groupLabel}`;
    head.appendChild(title);

    // Project every CDLC source (agents/skills/context) to executor-native files.
    if (opts.groupRootDir) {
      const exportBtn = document.createElement("button");
      exportBtn.className = "cdlc-project-btn";
      exportBtn.innerHTML = Icons.boxes({ size: 14 }) + "<span>Project</span>";
      attachTooltip(exportBtn, "Project CDLC to executors (.claude, AGENTS.md, copilot)");
      exportBtn.addEventListener("click", () => void this.exportNow(exportBtn));
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
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      empty.innerHTML = Icons.folderPlus({ size: 28 })
        + `<div class="rail-empty-title">No project folder</div>`
        + `<div class="rail-empty-hint">CDLC reads skills, agents and context from the group’s repo. Point this group at a folder to get started.</div>`;
      if (this.opts.onPickFolder) {
        const actions = document.createElement("div");
        actions.className = "rail-empty-actions";
        const btn = document.createElement("button");
        btn.className = "rail-empty-btn";
        btn.textContent = "Choose folder…";
        btn.addEventListener("click", () => this.opts.onPickFolder?.());
        actions.appendChild(btn);
        empty.appendChild(actions);
      }
      this.body.replaceChildren(empty);
      return;
    }
    // Loading notice — same treatment as Beacon, shown only on first fetch
    // (empty body) so background refreshes don't blank existing content.
    if (this.body.childElementCount === 0) {
      const loading = document.createElement("div");
      loading.className = "rail-notice is-loading";
      loading.textContent = "Loading…";
      this.body.replaceChildren(loading);
    }
    try {
      const [status, orgs, score, evalSummary] = await Promise.all([
        cdlcLocalStatus(cwd),
        cdlcMyOrgs().catch(() => [] as Org[]),
        scoreSummaryFiltered(this.opts.groupLabel ?? null).catch(() => null),
        cdlcEvalSummary(cwd).catch(() => [] as EvalSkillSummary[]),
      ]);
      this.orgs = orgs;
      this.score = score;
      this.evalRates = new Map(evalSummary.map((s) => [s.skill, { passed: s.passed, total: s.total }]));
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
        const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => void this.runEvals(i.name, runBtn));
        actions.push(runBtn);
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
      const maxInstalls = Math.max(1, ...registrySkills.map((i) => this.adoption.get(i.name) ?? 0));
      for (const i of registrySkills) {
        const n = this.adoption.get(i.name);
        const value = n === undefined ? "—" : `${n} ${n === 1 ? "install" : "installs"}`;
        loop.appendChild(meterRow(i.name, value, ((n ?? 0) / maxInstalls) * 100));
      }
    }

    // Inference — this group's footprint from the four Covenant primitives.
    if (this.score) {
      loop.appendChild(loopSubhead("Inference · this group"));
      const sc = this.score;
      const stats = document.createElement("div");
      stats.className = "cdlc-stats";
      stats.append(
        statCell(fmtTokens(sc.total_tokens), "tokens", true),
        statCell(sc.total_prompts.toLocaleString(), "prompts"),
        statCell(String(sc.total_specs), "specs"),
        statCell(String(sc.total_commits), "commits"),
      );
      loop.appendChild(stats);
    }

    // Eval — context-TDD pass-rate from the local runner.
    const skillsWithEvals = s.installed.filter((i) => this.evalRates.has(i.name));
    if (skillsWithEvals.length > 0) {
      loop.appendChild(loopSubhead("Eval pass-rate"));
      for (const i of skillsWithEvals) {
        const r = this.evalRates.get(i.name)!;
        const pct = r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
        loop.appendChild(meterRow(i.name, `${r.passed}/${r.total} · ${pct}%`, pct, true));
      }
    } else {
      const evalNote = document.createElement("p");
      evalNote.className = "cdlc-loop-note";
      evalNote.textContent = "Run evals on a skill to measure its context-TDD pass-rate.";
      loop.appendChild(evalNote);
    }

    this.body.append(skills, ctx, loop);
  }

  private async runEvals(skill: string, btn: HTMLButtonElement): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    if (!window.confirm(`Run evals for "${skill}"? Each eval is a full agent run plus a judge call — this can take minutes and costs tokens.`)) {
      return;
    }
    btn.disabled = true;
    let unlisten: (() => void) | undefined;
    let doneReason = "";
    try {
      unlisten = await onCdlcEvalProgress((e: CdlcEvalProgress) => {
        if (e.skill !== skill) return;
        if (e.status === "running") pushInfoToast({ message: `Eval ${e.eval_id}: running…` });
        else if (e.status === "pass") pushInfoToast({ message: `Eval ${e.eval_id}: PASS` });
        else if (e.status === "fail") pushInfoToast({ message: `Eval ${e.eval_id}: FAIL — ${e.reason}` });
        else if (e.status === "skipped") pushInfoToast({ message: `Evals skipped: ${e.reason}` });
        else if (e.status === "error") pushInfoToast({ message: `Eval ${e.eval_id}: error — ${e.reason}` });
        else if (e.status === "done") doneReason = e.reason;
      });
      await cdlcRunEvals(cwd, skill);
      // The backend signals an empty run via the done note — don't claim
      // "finished" when nothing actually ran.
      pushInfoToast({
        message:
          doneReason === "no evals found"
            ? `No evals for ${skill} — add .toml files under .covenant/cdlc/skills/${skill}/evals/`
            : `Evals finished for ${skill}`,
      });
      await this.refresh();
    } catch (e) {
      pushInfoToast({ message: `Run evals failed: ${String(e)}` });
    } finally {
      unlisten?.();
      btn.disabled = false;
    }
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
    const expand = iconButton(
      Icons.maximize({ size: 14 }),
      "Open full screen",
      () => openMarkdownReader(opts.name, opts.fetchPreview),
    );
    head.append(prev, expand, ...opts.actions);
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
