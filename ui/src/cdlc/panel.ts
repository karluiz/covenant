import type { CdlcStatus } from "../api";
import { cdlcLocalStatus } from "../api";

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
      this.renderStatus(await cdlcLocalStatus(cwd));
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
        row.textContent = `${i.name}  ${i.version}  ${i.source}`;
        skills.appendChild(row);
      }
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

  close(): void {
    this.root.remove();
    this.opts.onClose?.();
  }
}
