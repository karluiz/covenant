import { draftsApi, type DraftSummary } from "../drafts/api";

export interface DraftsTabOpts {
  groupId: string;
  groupRootDir: string | null;
  onOpenFile: (absolutePath: string) => void;
  onOpenWizard: (repoRoot: string) => void;
  onSetRootDir?: () => Promise<string | null>;
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
      this.renderNoRootDir();
      return;
    }
    this.newBtn.disabled = false;
    try {
      const drafts = await draftsApi.list(root);
      this.renderList(root, drafts);
    } catch (err) {
      console.error("drafts list failed", err);
      this.listEl.innerHTML = "";
      const wrap = document.createElement("div");
      wrap.className = "pn-empty pn-empty-inline";
      const title = document.createElement("div");
      title.className = "pn-empty-title";
      title.textContent = "Failed to load drafts";
      const hint = document.createElement("div");
      hint.className = "pn-empty-hint";
      hint.textContent = (err as Error)?.message ?? "Unknown error";
      wrap.appendChild(title);
      wrap.appendChild(hint);
      this.listEl.appendChild(wrap);
    }
  }

  private renderNoRootDir(): void {
    this.listEl.replaceChildren();

    const wrap = document.createElement("div");
    wrap.className = "pn-empty pn-empty-inline pn-drafts-no-root";

    const title = document.createElement("div");
    title.className = "pn-empty-title";
    title.textContent = "No root dir";

    const hint = document.createElement("div");
    hint.className = "pn-empty-hint";
    hint.textContent = "Choose the project folder for this group to track drafts.";

    wrap.appendChild(title);
    wrap.appendChild(hint);

    if (this.opts.onSetRootDir) {
      const action = document.createElement("button");
      action.type = "button";
      action.className = "pn-empty-action";
      action.textContent = "Set root dir…";
      action.addEventListener("click", () => {
        void this.setRootDirFromCta(action);
      });
      wrap.appendChild(action);
    }

    this.listEl.appendChild(wrap);
  }

  private async setRootDirFromCta(action: HTMLButtonElement): Promise<void> {
    action.disabled = true;
    try {
      const root = (await this.opts.onSetRootDir?.()) ?? null;
      if (!root) return;
      this.opts.groupRootDir = root;
      await this.refresh();
    } finally {
      if (!this.opts.groupRootDir) action.disabled = false;
    }
  }

  private renderList(root: string, drafts: DraftSummary[]): void {
    if (drafts.length === 0) {
      this.listEl.innerHTML =
        `<div class="pn-empty">
           <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h12l4 4v12H4z"/><path d="M14 4v4h4"/><path d="M8 13h8M8 17h5"/></svg>
           <div class="pn-empty-title">No drafts yet</div>
           <div class="pn-empty-hint">Click <span class="pn-kbd">+ New spec (AI-assisted)</span> to start one</div>
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
