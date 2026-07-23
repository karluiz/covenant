import { gitRepoSummary, worktreeSizes, type GitRepoSummary, type GitWorktreeSummary } from "../api";
import { worktreeStateClass, worktreeStateLabel } from "../status/worktree-state";
import { worktreeLabel, compactPath, humanSize } from "./format";
import { splitSizes, sizeRequestPaths } from "./sizes";

/// Full-screen Worktrees management page. Mirrors PulseSurface
/// (ui/src/pulse/index.ts): a fixed overlay the terminal keeps focus behind,
/// so Escape is captured on the capture phase.
export class WorktreesSurface {
  private host: HTMLElement;
  private open_ = false;
  private repoRoot = "";
  private summary: GitRepoSummary | null = null;
  private sizes = new Map<string, { total: number; target: number }>();
  private selected: string | null = null;

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
    void this.loadSizes();
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

  private render(): void {
    const body = this.host.querySelector(".wt-body");
    if (!body) return;
    body.innerHTML = "";
    if (!this.summary) { body.textContent = "Not a git repo."; return; }

    const left = document.createElement("div");
    left.className = "wt-left";
    const right = document.createElement("div");
    right.className = "wt-right";
    body.append(left, right);

    // Default selection: current worktree, else the first row.
    const wts = this.summary.worktrees;
    if (!this.selected || !wts.some((w) => w.path === this.selected)) {
      this.selected = (wts.find((w) => w.current) ?? wts[0])?.path ?? null;
    }
    this.renderList(left);
    this.renderDetail(right); // Task 6
  }

  private sortedWorktrees(): GitWorktreeSummary[] {
    const size = (p: string) => this.sizes.get(p)?.total ?? -1;
    return [...(this.summary?.worktrees ?? [])].sort((a, b) => size(b.path) - size(a.path));
  }

  private renderList(host: HTMLElement): void {
    host.innerHTML = "";
    const maxKb = Math.max(1, ...[...this.sizes.values()].map((s) => s.total));
    for (const wt of this.sortedWorktrees()) {
      const size = this.sizes.get(wt.path);
      const row = document.createElement("button");
      row.type = "button";
      row.className = "wt-row" + (wt.path === this.selected ? " is-selected" : "");
      row.addEventListener("click", () => { this.selected = wt.path; this.render(); });

      const dot = document.createElement("span");
      dot.className = `wt-dot ${worktreeStateClass(wt.state)}`;
      const label = document.createElement("span");
      label.className = "wt-row-label";
      label.textContent = worktreeLabel(wt);
      const path = document.createElement("span");
      path.className = "wt-row-path";
      path.textContent = compactPath(wt.path);

      const bar = document.createElement("span");
      bar.className = "wt-bar";
      const fill = document.createElement("span");
      fill.className = "wt-bar-fill";
      fill.style.width = size ? `${Math.round((size.total / maxKb) * 100)}%` : "0%";
      bar.appendChild(fill);

      const sizeEl = document.createElement("span");
      sizeEl.className = "wt-row-size";
      sizeEl.textContent = size ? humanSize(size.total) : "…";

      const badge = document.createElement("span");
      badge.className = "wt-row-badge";
      badge.textContent = wt.current ? "HERE"
        : wt.dirty_count > 0 ? `${wt.dirty_count} changed`
        : worktreeStateLabel(wt.state);

      row.append(dot, label, path, bar, sizeEl, badge);
      host.appendChild(row);
    }
  }

  private async loadSizes(): Promise<void> {
    if (!this.summary) return;
    const paths = this.summary.worktrees.map((w) => w.path);
    try {
      const raw = await worktreeSizes(sizeRequestPaths(paths));
      this.sizes = splitSizes(paths, raw);
    } catch { /* leave sizes empty — rows show "…" */ }
    if (this.open_) this.render();
  }

  // Task 6 replaces this with the real detail pane.
  private renderDetail(_host: HTMLElement): void {}
}
