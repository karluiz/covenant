import {
  gitChanges, gitFileDiff, gitStage, gitUnstage, gitCommit, generateCommitMessage,
  type Changes,
} from "../api";
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
  private msgEl: HTMLTextAreaElement | null = null;
  private commitBtn: HTMLButtonElement | null = null;
  private summarizeBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private selectedPath: string | null = null;
  // Capture phase: the terminal behind the fullscreen overlay keeps focus and
  // xterm calls stopPropagation() on Escape, so a bubble-phase listener never
  // fires. Mirrors the spec entrance's Esc handling.
  private onKey = (e: KeyboardEvent): void => {
    if (this.open_ && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  constructor(host: HTMLElement) { this.host = host; }

  get isOpen(): boolean { return this.open_; }

  async open(repoRoot: string): Promise<void> {
    this.repoRoot = repoRoot;
    this.open_ = true;
    document.body.classList.add("changes-fullscreen");
    document.addEventListener("keydown", this.onKey, true);
    this.mountShell();
    await this.refresh();
  }

  close(): void {
    this.open_ = false;
    this.filter = "";
    document.removeEventListener("keydown", this.onKey, true);
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
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    header.append(title, repo, spacer, close);

    const body = document.createElement("div");
    body.className = "cd-body";

    const left = document.createElement("div");
    left.className = "cd-left";
    const search = document.createElement("input");
    search.className = "cd-search";
    search.type = "search";
    search.placeholder = "Search files…";
    search.autocapitalize = "off";
    search.autocomplete = "off";
    search.spellcheck = false;
    search.setAttribute("autocorrect", "off");
    search.addEventListener("input", () => { this.filter = search.value; this.renderRailInto(); });
    const railHost = document.createElement("div");
    railHost.className = "cd-rail-host";
    this.railEl = railHost;
    left.append(search, railHost, this.buildCommitBar());

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

  /// Commit footer in the left column: AI-assist + message + Commit.
  /// Acts on whatever is staged; disabled while the index is empty.
  private buildCommitBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cd-commit";

    const msg = document.createElement("textarea");
    msg.className = "cd-commit-msg";
    msg.rows = 3;
    msg.placeholder = "Commit message…";
    msg.spellcheck = false;
    msg.addEventListener("input", () => this.syncCommitBar());
    // ⌘/Ctrl+Enter commits.
    msg.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); void this.commit(); }
    });
    this.msgEl = msg;

    const status = document.createElement("div");
    status.className = "cd-commit-status";
    this.statusEl = status;

    const row = document.createElement("div");
    row.className = "cd-commit-actions";
    const summarize = document.createElement("button");
    summarize.type = "button";
    summarize.className = "cd-summarize";
    // ponytail: inline SVG (no emoji); inherits currentColor for hover/disabled.
    summarize.innerHTML =
      `<svg class="cd-summarize-icon" viewBox="0 0 24 24" width="14" height="14" ` +
      `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ` +
      `stroke-linejoin="round" aria-hidden="true">` +
      `<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8` +
      `M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg><span>Summarize</span>`;
    summarize.addEventListener("click", () => void this.summarize());
    this.summarizeBtn = summarize;
    const commit = document.createElement("button");
    commit.type = "button";
    commit.className = "cd-commit-btn";
    commit.textContent = "Commit & Push";
    commit.addEventListener("click", () => void this.commit());
    this.commitBtn = commit;
    row.append(summarize, commit);

    bar.append(msg, status, row);
    return bar;
  }

  /// Enable/disable the bar. Summarize/Commit act on any change: staged if you've
  /// staged something, otherwise everything (the backend stages-all on commit).
  private syncCommitBar(): void {
    const hasChanges = this.changes.staged.length > 0 || this.changes.unstaged.length > 0;
    const hasMsg = !!this.msgEl?.value.trim();
    if (this.summarizeBtn) this.summarizeBtn.disabled = !hasChanges;
    if (this.commitBtn) this.commitBtn.disabled = !hasChanges || !hasMsg;
  }

  private statusTimer: number | null = null;

  private setStatus(text: string, err = false, fade = false): void {
    if (!this.statusEl) return;
    if (this.statusTimer !== null) { clearTimeout(this.statusTimer); this.statusTimer = null; }
    this.statusEl.textContent = text;
    this.statusEl.classList.toggle("cd-commit-status--err", err);
    this.statusEl.classList.remove("cd-commit-status--fade");
    if (!fade || !text) return;
    // Hold briefly, then fade out (CSS transition) and clear.
    this.statusTimer = window.setTimeout(() => {
      this.statusEl?.classList.add("cd-commit-status--fade");
      this.statusTimer = window.setTimeout(() => this.setStatus(""), 600);
    }, 1800);
  }

  private async summarize(): Promise<void> {
    if (!this.summarizeBtn || !this.msgEl) return;
    this.summarizeBtn.disabled = true;
    this.summarizeBtn.classList.add("cd-summarize--busy");
    this.setStatus("Summarizing…");
    try {
      this.msgEl.value = await generateCommitMessage(this.repoRoot);
      this.setStatus("");
      this.syncCommitBar();
      this.msgEl.focus();
    } catch (e) {
      this.setStatus(String(e), true);
    } finally {
      this.summarizeBtn.classList.remove("cd-summarize--busy");
      this.syncCommitBar();
    }
  }

  private async commit(): Promise<void> {
    if (!this.msgEl) return;
    const message = this.msgEl.value.trim();
    const hasChanges = this.changes.staged.length > 0 || this.changes.unstaged.length > 0;
    if (!message || !hasChanges) return;
    if (this.commitBtn) this.commitBtn.disabled = true;
    this.setStatus("Committing & pushing…");
    try {
      this.changes = await gitCommit(this.repoRoot, message, true);
      this.msgEl.value = "";
      this.selectedPath = null;
      this.renderEmptyDiff();
      this.renderRailInto();
      this.setStatus("Committed & pushed", false, true);
    } catch (e) {
      this.setStatus(String(e), true);
    } finally {
      this.syncCommitBar();
    }
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
    this.syncCommitBar();
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
