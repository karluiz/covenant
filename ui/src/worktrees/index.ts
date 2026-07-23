import { gitRepoSummary, type GitRepoSummary } from "../api";

/// Full-screen Worktrees management page. Mirrors PulseSurface
/// (ui/src/pulse/index.ts): a fixed overlay the terminal keeps focus behind,
/// so Escape is captured on the capture phase.
export class WorktreesSurface {
  private host: HTMLElement;
  private open_ = false;
  private repoRoot = "";
  private summary: GitRepoSummary | null = null;

  private onKey = (e: KeyboardEvent): void => {
    if (this.open_ && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  constructor(host: HTMLElement) { this.host = host; }

  get isOpen(): boolean { return this.open_; }

  async open(repoRoot: string): Promise<void> {
    if (this.open_) return;
    this.open_ = true;
    this.repoRoot = repoRoot;
    document.body.classList.add("worktrees-fullscreen");
    document.addEventListener("keydown", this.onKey, true);
    this.mountShell();
    await this.refresh();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    document.removeEventListener("keydown", this.onKey, true);
    document.body.classList.remove("worktrees-fullscreen");
    this.host.innerHTML = "";
  }

  private async refresh(): Promise<void> {
    try {
      this.summary = await gitRepoSummary(this.repoRoot);
    } catch {
      this.summary = null;
    }
    this.render();
  }

  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "wt-frame";

    const header = document.createElement("div");
    header.className = "wt-header";
    const title = document.createElement("span");
    title.className = "wt-title";
    title.textContent = "Worktrees";
    const spacer = document.createElement("span");
    spacer.className = "wt-header-spacer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "wt-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    header.append(title, spacer, close);

    const body = document.createElement("div");
    body.className = "wt-body";

    frame.append(header, body);
    this.host.appendChild(frame);
  }

  // Replaced in Task 5.
  private render(): void {
    const body = this.host.querySelector(".wt-body");
    if (body) body.textContent = this.summary ? `${this.summary.worktrees.length} worktrees` : "Not a git repo";
  }
}
