import { gitChanges, gitFileDiff, gitStage, gitUnstage, type Changes } from "../api";
import { renderRail, type RailHandlers } from "./rail";
import { renderDiffBody } from "./diff-view";

export class ChangesSurface {
  private host: HTMLElement;
  private repoRoot = "";
  private changes: Changes = { staged: [], unstaged: [] };
  private filter = "";
  private open_ = false;
  private railEl: HTMLElement | null = null;
  private diffEl: HTMLElement | null = null;
  private selectedPath: string | null = null;

  constructor(host: HTMLElement) { this.host = host; }

  get isOpen(): boolean { return this.open_; }

  async open(repoRoot: string): Promise<void> {
    this.repoRoot = repoRoot;
    this.open_ = true;
    document.body.classList.add("changes-fullscreen");
    this.mountShell();
    await this.refresh();
  }

  close(): void {
    this.open_ = false;
    this.filter = "";
    document.body.classList.remove("changes-fullscreen");
    this.host.innerHTML = "";
  }

  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "cd-frame";

    // Header bar — title + repo name on the left, Close on the right.
    const header = document.createElement("div");
    header.className = "cd-header";
    const title = document.createElement("span");
    title.className = "cd-title";
    title.textContent = "Changes";
    const repo = document.createElement("span");
    repo.className = "cd-repo";
    repo.textContent = repoBasename(this.repoRoot);
    const spacer = document.createElement("span");
    spacer.className = "cd-header-spacer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cd-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    header.append(title, repo, spacer, close);

    const body = document.createElement("div");
    body.className = "cd-body";

    const left = document.createElement("div");
    left.className = "cd-left";
    const search = document.createElement("input");
    search.className = "cd-search";
    search.placeholder = "Search files…";
    search.addEventListener("input", () => { this.filter = search.value; this.renderRailInto(); });
    const railHost = document.createElement("div");
    railHost.className = "cd-rail-host";
    this.railEl = railHost;
    left.append(search, railHost);

    const right = document.createElement("div");
    right.className = "cd-right";
    const diffHost = document.createElement("div");
    diffHost.className = "cd-diff-host";
    this.diffEl = diffHost;
    right.appendChild(diffHost);

    body.append(left, right);
    frame.append(header, body);
    this.host.appendChild(frame);
    this.renderEmptyDiff();
  }

  /// Placeholder shown in the diff pane until a file is selected.
  private renderEmptyDiff(): void {
    if (!this.diffEl) return;
    const empty = document.createElement("div");
    empty.className = "cd-diff-empty";
    empty.textContent = "Select a file to view its diff";
    this.diffEl.replaceChildren(empty);
  }

  private async refresh(): Promise<void> {
    this.changes = await gitChanges(this.repoRoot);
    this.renderRailInto();
  }

  private renderRailInto(): void {
    if (!this.railEl) return;
    if (this.changes.staged.length === 0 && this.changes.unstaged.length === 0) {
      const clean = document.createElement("div");
      clean.className = "cd-clean";
      clean.textContent = "Working tree clean";
      this.railEl.replaceChildren(clean);
      return;
    }
    const handlers: RailHandlers = {
      onSelect: (path, staged) => void this.showDiff(path, staged),
      onStage: (path) => void this.stage(path),
      onUnstage: (path) => void this.unstage(path),
    };
    this.railEl.replaceChildren(renderRail(this.changes, handlers, this.filter));
    this.markSelected();
  }

  /// Re-apply the selected highlight after a rail re-render.
  private markSelected(): void {
    if (!this.railEl) return;
    for (const row of this.railEl.querySelectorAll<HTMLElement>(".cd-file")) {
      row.classList.toggle("cd-file--selected", row.dataset.path === this.selectedPath);
    }
  }

  private async showDiff(path: string, staged: boolean): Promise<void> {
    if (!this.diffEl) return;
    this.selectedPath = path;
    this.markSelected();
    const file = await gitFileDiff(this.repoRoot, path, staged);
    this.diffEl.replaceChildren(renderDiffBody(file));
  }

  private async stage(path: string): Promise<void> {
    this.changes = await gitStage(this.repoRoot, path);
    this.renderRailInto();
    if (path === this.selectedPath) {
      await this.showDiff(path, true);
    }
  }

  private async unstage(path: string): Promise<void> {
    this.changes = await gitUnstage(this.repoRoot, path);
    this.renderRailInto();
    if (path === this.selectedPath) {
      await this.showDiff(path, false);
    }
  }
}

/// Last path segment of a repo root, for the header label.
function repoBasename(root: string): string {
  const trimmed = root.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}
