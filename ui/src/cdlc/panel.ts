import type { CdlcStatus, Org, PkgMeta } from "../api";
import { cdlcLocalStatus, cdlcMyOrgs, cdlcSearch, cdlcPublish, cdlcInstallRegistry } from "../api";

function errorLine(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "cdlc-error";
  p.textContent = text;
  return p;
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
        const row = document.createElement("div");
        row.className = "cdlc-skill-row";
        const label = document.createElement("span");
        label.textContent = `${i.name}  ${i.version}  ${i.source}`;
        row.appendChild(label);
        if (this.orgs.length > 0 && !i.source.startsWith("registry:")) {
          const pub = document.createElement("button");
          pub.className = "cdlc-publish-btn";
          pub.textContent = "Publish";
          pub.addEventListener("click", () => void this.publish(i.name));
          row.appendChild(pub);
        }
        skills.appendChild(row);
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
          for (const r of rows) {
            const rr = document.createElement("div");
            rr.className = "cdlc-search-result";
            rr.textContent = `${r.name} ${r.version} (${r.installs} installs) — ${r.publisher_login}`;
            const inst = document.createElement("button");
            inst.textContent = "Install";
            inst.addEventListener("click", () => void this.install(this.orgs[0].slug, r.name, r.version));
            rr.appendChild(inst);
            results.appendChild(rr);
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

  close(): void {
    this.root.remove();
    this.opts.onClose?.();
  }
}
