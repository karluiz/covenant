import {
  gitChanges, gitFileDiff, gitStage, gitUnstage, gitStageHunk, gitUnstageHunk,
  gitCommit, generateCommitMessage, gitRepoSummary,
  type Changes, type FileChange, type GitRepoSummary,
} from "../api";
import { renderRail, splitPath, countsLabel, type RailHandlers } from "./rail";
import { renderDiffBody } from "./diff-view";
import { formatChord } from "../platform";

const SUBJECT_SOFT_LIMIT = 50;

export class ChangesSurface {
  private host: HTMLElement;
  private repoRoot = "";
  private changes: Changes = { staged: [], unstaged: [] };
  private summary: GitRepoSummary | null = null;
  private filter = "";
  private open_ = false;
  private railEl: HTMLElement | null = null;
  private diffEl: HTMLElement | null = null;
  private subjEl: HTMLInputElement | null = null;
  private subjCountEl: HTMLElement | null = null;
  private bodyEl: HTMLTextAreaElement | null = null;
  private commitBtn: HTMLButtonElement | null = null;
  private pushBtn: HTMLButtonElement | null = null;
  private summarizeBtn: HTMLButtonElement | null = null;
  private statusEl: HTMLElement | null = null;
  private branchEl: HTMLElement | null = null;
  private headSumEl: HTMLElement | null = null;
  private pushTargetEl: HTMLElement | null = null;
  private selectedPath: string | null = null;
  // Capture phase: the terminal behind the fullscreen overlay keeps focus and
  // xterm calls stopPropagation() on Escape, so a bubble-phase listener never
  // fires. Mirrors the spec entrance's Esc handling.
  private onKey = (e: KeyboardEvent): void => {
    if (!this.open_) return;
    if (e.key === "Escape") {
      e.preventDefault();
      // First Esc leaves the diff back to the overview; second closes.
      if (this.selectedPath !== null) {
        this.selectedPath = null;
        this.markSelected();
        this.renderOverview();
      } else {
        this.close();
      }
      return;
    }
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      this.moveSelection(e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "Enter" && this.selectedPath !== null) {
      e.preventDefault();
      const f = this.visibleFiles().find((v) => v.file.path === this.selectedPath);
      if (f) void this.showDiff(f.file.path, f.staged);
    } else if (e.key === " " && this.selectedPath !== null) {
      e.preventDefault();
      const f = this.visibleFiles().find((v) => v.file.path === this.selectedPath);
      if (f) void (f.staged ? this.unstage(f.file.path) : this.stage(f.file.path));
    }
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
    void this.loadSummary();
  }

  close(): void {
    this.open_ = false;
    this.filter = "";
    this.selectedPath = null;
    document.removeEventListener("keydown", this.onKey, true);
    document.body.classList.remove("changes-fullscreen");
    this.host.innerHTML = "";
  }

  /// Branch + push target are cosmetic context — never block the surface on them.
  private async loadSummary(): Promise<void> {
    try {
      this.summary = await gitRepoSummary(this.repoRoot);
    } catch {
      this.summary = null;
    }
    this.renderBranchChip();
    this.renderPushTarget();
  }

  private currentBranch(): string | null {
    return this.summary?.current_branch ?? null;
  }

  private pushTarget(): string {
    const branch = this.currentBranch();
    if (!branch) return "origin";
    const upstream = this.summary?.branches.find((b) => b.current)?.upstream;
    return upstream ?? `origin/${branch}`;
  }

  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "cd-frame";

    // Header — title, repo, branch chip left; aggregate diffstat + esc right.
    const header = document.createElement("div");
    header.className = "cd-header";
    const title = document.createElement("span");
    title.className = "cd-title";
    title.textContent = "Changes";
    const repo = document.createElement("span");
    repo.className = "cd-repo";
    repo.textContent = repoBasename(this.repoRoot);
    const branch = document.createElement("span");
    branch.className = "cd-branch";
    branch.hidden = true;
    this.branchEl = branch;
    const spacer = document.createElement("span");
    spacer.className = "cd-header-spacer";
    const headSum = document.createElement("span");
    headSum.className = "cd-head-sum";
    this.headSumEl = headSum;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "cd-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    header.append(title, repo, branch, spacer, headSum, close);

    const body = document.createElement("div");
    body.className = "cd-body";

    const left = document.createElement("div");
    left.className = "cd-left";
    const search = document.createElement("input");
    search.className = "cd-search";
    search.type = "search";
    search.placeholder = "Filter changed files…";
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
    this.renderOverview();
  }

  private renderBranchChip(): void {
    if (!this.branchEl) return;
    const branch = this.currentBranch();
    if (!branch) { this.branchEl.hidden = true; return; }
    this.branchEl.hidden = false;
    this.branchEl.innerHTML =
      `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" ` +
      `stroke-width="2" aria-hidden="true"><circle cx="6" cy="6" r="2.6"/>` +
      `<circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="9" r="2.6"/>` +
      `<path d="M6 8.6v6.8M18 11.6c0 3-4 3.5-9 3.6"/></svg>`;
    this.branchEl.appendChild(document.createTextNode(branch));
  }

  private renderPushTarget(): void {
    if (!this.pushTargetEl) return;
    this.pushTargetEl.textContent = `push → ${this.pushTarget()}`;
  }

  private allFiles(): { file: FileChange; staged: boolean }[] {
    return [
      ...this.changes.staged.map((file) => ({ file, staged: true })),
      ...this.changes.unstaged.map((file) => ({ file, staged: false })),
    ];
  }

  private visibleFiles(): { file: FileChange; staged: boolean }[] {
    const q = this.filter.trim().toLowerCase();
    return this.allFiles().filter((v) => !q || v.file.path.toLowerCase().includes(q));
  }

  private moveSelection(delta: number): void {
    const vis = this.visibleFiles();
    if (vis.length === 0) return;
    const i = vis.findIndex((v) => v.file.path === this.selectedPath);
    const next = i === -1 ? (delta > 0 ? 0 : vis.length - 1)
      : Math.min(vis.length - 1, Math.max(0, i + delta));
    this.selectedPath = vis[next].file.path;
    this.markSelected();
    this.railEl?.querySelector<HTMLElement>(".cd-file--selected")
      ?.scrollIntoView({ block: "nearest" });
  }

  private renderHeadSum(): void {
    if (!this.headSumEl) return;
    const files = this.allFiles();
    const add = files.reduce((s, v) => s + v.file.added, 0);
    const del = files.reduce((s, v) => s + v.file.removed, 0);
    this.headSumEl.innerHTML = files.length === 0 ? "" :
      `<span>${files.length} ${files.length === 1 ? "file" : "files"}</span>` +
      `<span><span class="cd-sum-add">+${add}</span> <span class="cd-sum-del">−${del}</span></span>`;
  }

  /// Commit composer — subject + body + AI assist + Commit / Commit & Push.
  private buildCommitBar(): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "cd-commit";

    const subjRow = document.createElement("div");
    subjRow.className = "cd-subj-row";
    const subj = document.createElement("input");
    subj.className = "cd-subj";
    subj.type = "text";
    subj.placeholder = "Summary (required)";
    subj.spellcheck = false;
    subj.autocapitalize = "off";
    subj.autocomplete = "off";
    subj.addEventListener("input", () => this.syncCommitBar());
    subj.addEventListener("keydown", (e) => this.onComposerKey(e));
    this.subjEl = subj;
    const subjCount = document.createElement("span");
    subjCount.className = "cd-subj-count";
    this.subjCountEl = subjCount;
    subjRow.append(subj, subjCount);

    const msgBody = document.createElement("textarea");
    msgBody.className = "cd-commit-body";
    msgBody.rows = 4;
    msgBody.placeholder = "Description (optional)";
    msgBody.spellcheck = false;
    msgBody.addEventListener("keydown", (e) => this.onComposerKey(e));
    this.bodyEl = msgBody;

    const status = document.createElement("div");
    status.className = "cd-commit-status";
    this.statusEl = status;

    const row = document.createElement("div");
    row.className = "cd-commit-actions";

    const summarize = document.createElement("button");
    summarize.type = "button";
    summarize.className = "cd-summarize";
    summarize.setAttribute("aria-label", "Generate commit message");
    summarize.innerHTML =
      `<svg class="cd-summarize-icon" viewBox="0 0 24 24" width="14" height="14" ` +
      `fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" ` +
      `stroke-linejoin="round" aria-hidden="true">` +
      `<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8` +
      `M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/></svg>`;
    summarize.addEventListener("click", () => void this.summarize());
    this.summarizeBtn = summarize;

    const commit = document.createElement("button");
    commit.type = "button";
    commit.className = "cd-commit-btn";
    commit.innerHTML = `<span>Commit</span><kbd class="cd-kbd">&#8984;&#9166;</kbd>`;
    commit.addEventListener("click", () => void this.commit(false));
    this.commitBtn = commit;

    const push = document.createElement("button");
    push.type = "button";
    push.className = "cd-push-btn";
    push.innerHTML = `<span>Commit &amp; Push</span>`;
    push.addEventListener("click", () => void this.commit(true));
    this.pushBtn = push;

    row.append(summarize, commit, push);

    const target = document.createElement("div");
    target.className = "cd-push-target";
    this.pushTargetEl = target;

    bar.append(subjRow, msgBody, status, row, target);
    return bar;
  }

  /// ⌘/Ctrl+Enter commits, ⌘/Ctrl+Shift+Enter commits & pushes — from either field.
  private onComposerKey(e: KeyboardEvent): void {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      void this.commit(e.shiftKey);
    }
  }

  private commitMessage(): string {
    const subject = this.subjEl?.value.trim() ?? "";
    const body = this.bodyEl?.value.trim() ?? "";
    return body ? `${subject}\n\n${body}` : subject;
  }

  /// Enable/disable the bar. Summarize/Commit act on any change: staged if you've
  /// staged something, otherwise everything (the backend stages-all on commit).
  private syncCommitBar(): void {
    const hasChanges = this.changes.staged.length > 0 || this.changes.unstaged.length > 0;
    const hasMsg = !!this.subjEl?.value.trim();
    if (this.summarizeBtn) this.summarizeBtn.disabled = !hasChanges;
    if (this.commitBtn) this.commitBtn.disabled = !hasChanges || !hasMsg;
    if (this.pushBtn) this.pushBtn.disabled = !hasChanges || !hasMsg;
    if (this.subjCountEl && this.subjEl) {
      const len = this.subjEl.value.length;
      this.subjCountEl.textContent = len === 0 ? "" : `${len}/${SUBJECT_SOFT_LIMIT}`;
      this.subjCountEl.classList.toggle("cd-subj-count--over", len > SUBJECT_SOFT_LIMIT);
    }
  }

  private statusTimer: number | null = null;

  private setStatus(text: string, err = false, fade = false): void {
    if (!this.statusEl) return;
    if (this.statusTimer !== null) { clearTimeout(this.statusTimer); this.statusTimer = null; }
    this.statusEl.classList.toggle("cd-commit-status--err", err);
    this.statusEl.classList.toggle("cd-commit-status--ok", fade && !err);
    this.statusEl.classList.remove("cd-commit-status--fade");

    if (!text) {
      this.statusEl.innerHTML = "";
      return;
    }

    if (err) {
      // Structured error banner with dismiss.
      const icon = `<svg class="cd-status-icon" viewBox="0 0 16 16" width="13" height="13" ` +
        `fill="currentColor" aria-hidden="true"><path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1ZM7 ` +
        `4.75a1 1 0 1 1 2 0v3.5a1 1 0 1 1-2 0V4.75Zm1 7.75a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>`;
      const dismiss = `<button type="button" class="cd-status-dismiss" aria-label="Dismiss">&times;</button>`;
      this.statusEl.innerHTML = `${icon}<span class="cd-status-text">${escHtml(text)}</span>${dismiss}`;
      this.statusEl.querySelector(".cd-status-dismiss")?.addEventListener("click", () => this.setStatus(""));
    } else if (fade) {
      // Success: checkmark + message.
      const icon = `<svg class="cd-status-icon" viewBox="0 0 16 16" width="13" height="13" ` +
        `fill="currentColor" aria-hidden="true"><path d="M8 16A8 8 0 1 1 8 0a8 8 0 0 1 0 16Zm` +
        `3.78-9.72a.75.75 0 0 0-1.06-1.06L7 8.94 5.28 7.22a.75.75 0 0 0-1.06 1.06l2.25 2.25a` +
        `.75.75 0 0 0 1.06 0l4.25-4.25Z"/></svg>`;
      this.statusEl.innerHTML = `${icon}<span class="cd-status-text">${escHtml(text)}</span>`;
    } else {
      // In-progress: spinner + message.
      const spinner = `<span class="cd-status-spinner"></span>`;
      this.statusEl.innerHTML = `${spinner}<span class="cd-status-text">${escHtml(text)}</span>`;
    }

    if (!fade) return;
    this.statusTimer = window.setTimeout(() => {
      this.statusEl?.classList.add("cd-commit-status--fade");
      this.statusTimer = window.setTimeout(() => this.setStatus(""), 600);
    }, 2400);
  }

  private async summarize(): Promise<void> {
    if (!this.summarizeBtn || !this.subjEl) return;
    this.summarizeBtn.disabled = true;
    this.summarizeBtn.classList.add("cd-summarize--busy");
    this.setStatus("Summarizing…");
    try {
      const message = await generateCommitMessage(this.repoRoot);
      // First line becomes the subject; the remainder the body.
      const nl = message.indexOf("\n");
      this.subjEl.value = nl === -1 ? message.trim() : message.slice(0, nl).trim();
      if (this.bodyEl) this.bodyEl.value = nl === -1 ? "" : message.slice(nl + 1).trim();
      this.setStatus("");
      this.syncCommitBar();
      this.subjEl.focus();
    } catch (e) {
      this.setStatus(String(e), true);
    } finally {
      this.summarizeBtn.classList.remove("cd-summarize--busy");
      this.syncCommitBar();
    }
  }

  private async commit(push = false): Promise<void> {
    const message = this.commitMessage();
    const hasChanges = this.changes.staged.length > 0 || this.changes.unstaged.length > 0;
    if (!message || !hasChanges) return;
    if (this.commitBtn) this.commitBtn.disabled = true;
    if (this.pushBtn) this.pushBtn.disabled = true;
    const verb = push ? `Committing & pushing to ${this.pushTarget()}` : "Committing";
    this.setStatus(`${verb}…`);
    try {
      this.changes = await gitCommit(this.repoRoot, message, push);
      if (this.subjEl) this.subjEl.value = "";
      if (this.bodyEl) this.bodyEl.value = "";
      this.selectedPath = null;
      this.renderOverview();
      this.renderRailInto();
      const done = push ? "Committed & pushed" : "Committed";
      this.setStatus(done, false, true);
    } catch (e) {
      this.setStatus(String(e), true);
    } finally {
      this.syncCommitBar();
    }
  }

  /// Changeset overview — shown until a file is selected, instead of dead space.
  private renderOverview(): void {
    if (!this.diffEl) return;
    const ov = document.createElement("div");
    ov.className = "cd-overview";

    const files = this.allFiles();
    const branch = this.currentBranch();

    const eyebrow = document.createElement("div");
    eyebrow.className = "cd-ov-eyebrow";
    eyebrow.textContent = branch ? `Working tree · ${branch}` : "Working tree";
    ov.appendChild(eyebrow);

    const head = document.createElement("h2");
    head.className = "cd-ov-head";
    head.textContent = files.length === 0
      ? "Working tree clean"
      : `${files.length} ${files.length === 1 ? "file" : "files"} changed`;
    ov.appendChild(head);

    if (files.length > 0) {
      const add = files.reduce((s, v) => s + v.file.added, 0);
      const del = files.reduce((s, v) => s + v.file.removed, 0);

      const sub = document.createElement("div");
      sub.className = "cd-ov-sub";
      sub.innerHTML = `<span class="cd-sum-add">+${add}</span> <span class="cd-sum-del">−${del}</span>`;
      ov.appendChild(sub);

      const bar = document.createElement("div");
      bar.className = "cd-ov-bar";
      bar.innerHTML =
        `<span class="cd-ov-bar-a" style="flex:${add}"></span>` +
        `<span class="cd-ov-bar-d" style="flex:${del}"></span>`;
      ov.appendChild(bar);

      const list = document.createElement("div");
      list.className = "cd-ov-list";
      const max = Math.max(...files.map((v) => v.file.added + v.file.removed), 1);
      for (const v of files) {
        const [dir, base] = splitPath(v.file.path);
        const rowBtn = document.createElement("button");
        rowBtn.type = "button";
        rowBtn.className = "cd-ov-row";
        const w = Math.max(((v.file.added + v.file.removed) / max) * 100, 4);
        rowBtn.innerHTML =
          `<span class="cd-status cd-status--${v.file.status}">${statusLetter(v.file)}</span>` +
          `<span class="cd-ov-path">${dir ? `<span class="cd-ov-dir">${escHtml(dir)}/</span>` : ""}${escHtml(base)}</span>` +
          `<span class="cd-ov-counts">${escHtml(countsLabel(v.file))}</span>` +
          `<span class="cd-ov-spark" style="width:${w}%">` +
          `<span class="cd-ov-bar-a" style="flex:${v.file.added}"></span>` +
          `<span class="cd-ov-bar-d" style="flex:${v.file.removed}"></span></span>`;
        rowBtn.addEventListener("click", () => void this.showDiff(v.file.path, v.staged));
        list.appendChild(rowBtn);
      }
      ov.appendChild(list);
    }

    const hints = document.createElement("div");
    hints.className = "cd-ov-hints";
    hints.innerHTML =
      `<span><kbd>↑</kbd><kbd>↓</kbd> navigate</span>` +
      `<span><kbd>space</kbd> stage / unstage</span>` +
      `<span><kbd>${formatChord(["enter"])}</kbd> open diff</span>` +
      `<span><kbd>${formatChord(["mod", "enter"])}</kbd> commit</span>` +
      `<span><kbd>esc</kbd> close</span>`;
    ov.appendChild(hints);

    this.diffEl.replaceChildren(ov);
    this.renderHeadSum();
  }

  private async refresh(): Promise<void> {
    this.changes = await gitChanges(this.repoRoot);
    this.renderRailInto();
    if (this.selectedPath === null) this.renderOverview();
  }

  private renderRailInto(): void {
    this.syncCommitBar();
    this.renderHeadSum();
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
      onStageAll: (paths) => void this.stageAll(paths, true),
      onUnstageAll: (paths) => void this.stageAll(paths, false),
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

    const view = document.createElement("div");
    view.className = "cd-diff-view";

    // Sticky file header: path, counts, stage/unstage toggle.
    const hd = document.createElement("div");
    hd.className = "cd-diff-hd";
    const [dir, base] = splitPath(path);
    const pathEl = document.createElement("span");
    pathEl.className = "cd-diff-path";
    pathEl.innerHTML = (dir ? `<span class="cd-ov-dir">${escHtml(dir)}/</span>` : "") + escHtml(base);
    const change = this.findChange(path);
    const countsEl = document.createElement("span");
    countsEl.className = "cd-diff-counts";
    if (change) countsEl.textContent = countsLabel(change.file);
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "cd-diff-stage";
    toggle.textContent = staged ? "Unstage file" : "Stage file";
    toggle.addEventListener("click", () => void (staged ? this.unstage(path) : this.stage(path)));
    hd.append(pathEl, countsEl, toggle);

    // Hunk-level staging only makes sense for tracked files with a hunk diff —
    // an untracked file's diff is synthetic (--no-index vs /dev/null).
    const canHunk = change !== null &&
      change.file.status !== "untracked" &&
      file.body.kind === "hunks";
    const hunkAction = canHunk ? {
      label: staged ? "Unstage hunk" : "Stage hunk",
      onAct: (i: number) => void this.applyHunk(path, staged, i),
    } : undefined;

    view.append(hd, renderDiffBody(file, hunkAction));
    this.diffEl.replaceChildren(view);
  }

  /// Stage/unstage a single hunk, then re-show the same side of the file if it
  /// still has changes there; otherwise the other side; otherwise the overview.
  private async applyHunk(path: string, staged: boolean, index: number): Promise<void> {
    try {
      this.changes = staged
        ? await gitUnstageHunk(this.repoRoot, path, index)
        : await gitStageHunk(this.repoRoot, path, index);
    } catch (e) {
      this.setStatus(String(e), true);
      return;
    }
    this.renderRailInto();
    const remaining = this.allFiles().filter((v) => v.file.path === path);
    const next = remaining.find((v) => v.staged === staged) ?? remaining[0];
    if (next) {
      await this.showDiff(path, next.staged);
    } else {
      this.selectedPath = null;
      this.renderOverview();
    }
  }

  private findChange(path: string): { file: FileChange; staged: boolean } | null {
    return this.allFiles().find((v) => v.file.path === path) ?? null;
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

  /// Stage/unstage a whole group. Sequential — the backend recomputes the
  /// change set on every call and the lists are short.
  private async stageAll(paths: string[], stage: boolean): Promise<void> {
    for (const p of paths) {
      this.changes = stage
        ? await gitStage(this.repoRoot, p)
        : await gitUnstage(this.repoRoot, p);
    }
    this.renderRailInto();
    if (this.selectedPath !== null && paths.includes(this.selectedPath)) {
      await this.showDiff(this.selectedPath, stage);
    }
  }
}

function statusLetter(f: FileChange): string {
  const letters: Record<FileChange["status"], string> = {
    modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "A",
  };
  return letters[f.status];
}

/// Last path segment of a repo root, for the header label.
function repoBasename(root: string): string {
  const trimmed = root.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i === -1 ? trimmed : trimmed.slice(i + 1);
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
