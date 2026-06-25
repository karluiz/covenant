import "./styles.css";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import type { CdlcStatus, Org, PkgMeta } from "../api";
import {
  cdlcLocalStatus, cdlcMyOrgs, cdlcSearch, cdlcPublish, cdlcInstallRegistry,
  cdlcPreview, cdlcReadLocal,
} from "../api";

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

  constructor(private opts: CdlcPanelOpts) {
    this.root = document.createElement("div");
    this.root.className = "cdlc-panel";

    const head = document.createElement("div");
    head.className = "cdlc-head";
    head.textContent = `CDLC — ${opts.groupLabel}`;
    if (opts.groupColor) head.style.setProperty("--cdlc-accent", opts.groupColor);

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
      const [status, orgs] = await Promise.all([
        cdlcLocalStatus(cwd),
        cdlcMyOrgs().catch(() => [] as Org[]),
      ]);
      this.orgs = orgs;
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

    // Loop section (Phase 2 placeholder)
    const loop = document.createElement("section");
    loop.className = "cdlc-loop";
    const lh = document.createElement("h3");
    lh.textContent = "Loop";
    const lp = document.createElement("p");
    lp.textContent = "Eval & adoption metrics arrive in Phase 2.";
    loop.append(lh, lp);

    this.body.append(skills, ctx, loop);
  }

  private async publish(name: string): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd || this.orgs.length === 0) return;
    const org = this.orgs[0].slug; // v1: publish to the caller's first org
    try {
      await cdlcPublish(cwd, org, name);
      await this.refresh();
    } catch (e) {
      this.body.appendChild(errorLine(`Publish failed: ${String(e)}`));
    }
  }

  private async install(org: string, name: string, version: string): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    try {
      await cdlcInstallRegistry(cwd, org, name, version, this.opts.groupLabel ?? null, null);
      await this.refresh();
    } catch (e) {
      this.body.appendChild(errorLine(`Install failed: ${String(e)}`));
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
