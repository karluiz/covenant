import { draftsApi, type DraftSummary } from "../drafts/api";

export interface DraftsTabOpts {
  groupId: string;
  groupRootDir: string | null;
  onOpenFile: (absolutePath: string) => void;
  onOpenWizard: (repoRoot: string) => void;
}

export class DraftsTab {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private newBtn: HTMLButtonElement;

  constructor(private opts: DraftsTabOpts) {
    this.container = document.createElement("div");
    this.container.className = "pn-drafts-tab";

    this.newBtn = document.createElement("button");
    this.newBtn.type = "button";
    this.newBtn.className = "pn-drafts-new";
    this.newBtn.textContent = "+ New spec (AI-assisted)";
    this.newBtn.addEventListener("click", () => {
      if (this.opts.groupRootDir) this.opts.onOpenWizard(this.opts.groupRootDir);
    });

    this.listEl = document.createElement("div");
    this.listEl.className = "pn-drafts-list";

    this.container.appendChild(this.newBtn);
    this.container.appendChild(this.listEl);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const root = this.opts.groupRootDir;
    if (!root) {
      this.newBtn.disabled = true;
      this.listEl.innerHTML =
        `<div class="pn-empty pn-empty-inline">
           <div class="pn-empty-title">No root dir</div>
           <div class="pn-empty-hint">Set a root dir for this group to track drafts.</div>
         </div>`;
      return;
    }
    this.newBtn.disabled = false;
    try {
      const drafts = await draftsApi.list(root);
      this.renderList(root, drafts);
    } catch (err) {
      console.error("drafts list failed", err);
      this.listEl.innerHTML =
        `<div class="pn-empty pn-empty-inline">
           <div class="pn-empty-title">Failed to load drafts</div>
           <div class="pn-empty-hint">${(err as Error).message ?? "Unknown error"}</div>
         </div>`;
    }
  }

  private renderList(root: string, drafts: DraftSummary[]): void {
    if (drafts.length === 0) {
      this.listEl.innerHTML =
        `<div class="pn-empty pn-empty-inline">
           <div class="pn-empty-title">No drafts</div>
           <div class="pn-empty-hint">Agents will write drafts here, or start one with the button above.</div>
         </div>`;
      return;
    }
    this.listEl.innerHTML = "";
    for (const d of drafts) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pn-drafts-item";
      item.innerHTML =
        `<span class="pn-drafts-title"></span>
         <span class="pn-drafts-meta"></span>`;
      (item.querySelector(".pn-drafts-title") as HTMLElement).textContent = d.title;
      (item.querySelector(".pn-drafts-meta") as HTMLElement).textContent =
        `${d.slug} · ${relTime(d.updated_at)}`;
      const absolutePath = `${root}/docs/specs/${d.slug}.md`;
      item.addEventListener("click", () => this.opts.onOpenFile(absolutePath));
      this.listEl.appendChild(item);
    }
  }
}

function relTime(iso: string): string {
  const dt = Date.now() - new Date(iso).getTime();
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}
