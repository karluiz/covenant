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

    const close = document.createElement("button");
    close.className = "cd-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    right.prepend(close);

    frame.append(left, right);
    this.host.appendChild(frame);
  }

  private async refresh(): Promise<void> {
    this.changes = await gitChanges(this.repoRoot);
    this.renderRailInto();
  }

  private renderRailInto(): void {
    if (!this.railEl) return;
    const handlers: RailHandlers = {
      onSelect: (path, staged) => void this.showDiff(path, staged),
      onStage: (path) => void this.stage(path),
      onUnstage: (path) => void this.unstage(path),
    };
    this.railEl.replaceChildren(renderRail(this.changes, handlers, this.filter));
  }

  private async showDiff(path: string, staged: boolean): Promise<void> {
    if (!this.diffEl) return;
    this.selectedPath = path;
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
