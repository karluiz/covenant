import {
  gitRepoSummary, worktreeSizes, worktreeDetail, gitChanges, devLiveWorktreeRoot,
  worktreeCleanTarget, worktreeReclaim, worktreeRelocate,
  type GitRepoSummary, type GitWorktreeSummary,
} from "../api";
import { worktreeStateClass, worktreeStateLabel, worktreeDefaultAction } from "../status/worktree-state";
import { worktreeLabel, compactPath, humanSize } from "./format";
import { splitSizes, sizeRequestPaths, subtractNested } from "./sizes";
import { pushConfirmToast, pushInfoToast } from "../notifications/toast";

interface WorktreesOpts {
  onOpenTab: (path: string, label: string) => void;
  getOccupiedCwds: () => ReadonlySet<string>;
}

/// Full-screen Worktrees management page. Mirrors PulseSurface
/// (ui/src/pulse/index.ts): a fixed overlay the terminal keeps focus behind,
/// so Escape is captured on the capture phase.
export class WorktreesSurface {
  private host: HTMLElement;
  private opts: WorktreesOpts;
  private open_ = false;
  private repoRoot = "";
  private summary: GitRepoSummary | null = null;
  private sizes = new Map<string, { total: number; target: number }>();
  private detail = new Map<string, { subject: string | null; ins: number; del: number; files: string[] }>();
  private selected: string | null = null;
  private liveRoot: string | null = null;

  private onKey = (e: KeyboardEvent): void => {
    if (this.open_ && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  constructor(host: HTMLElement, opts: WorktreesOpts) { this.host = host; this.opts = opts; }

  get isOpen(): boolean { return this.open_; }

  async open(repoRoot: string): Promise<void> {
    if (this.open_) return;
    this.open_ = true;
    this.repoRoot = repoRoot;
    document.body.classList.add("worktrees-fullscreen");
    document.addEventListener("keydown", this.onKey, true);
    this.mountShell();
    this.liveRoot = await devLiveWorktreeRoot().catch(() => null);
    await this.refresh();
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    document.removeEventListener("keydown", this.onKey, true);
    document.body.classList.remove("worktrees-fullscreen");
    this.host.innerHTML = "";
    this.sizes.clear();
    this.detail.clear();
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
      this.sizes = subtractNested(splitSizes(paths, raw));
    } catch { /* leave sizes empty — rows show "…" */ }
    if (this.open_) this.render();
  }

  private async loadDetail(path: string): Promise<void> {
    if (this.detail.has(path)) return;
    try {
      const [d, changes] = await Promise.all([worktreeDetail(path), gitChanges(path)]);
      const files = [...changes.unstaged, ...changes.staged].map((f) => `${f.status[0].toUpperCase()} ${f.path}`);
      this.detail.set(path, { subject: d.last_subject, ins: d.insertions, del: d.deletions, files });
    } catch {
      this.detail.set(path, { subject: null, ins: 0, del: 0, files: [] });
    }
    if (this.open_ && this.selected === path) this.render();
  }

  private renderDetail(host: HTMLElement): void {
    host.innerHTML = "";
    const wt = this.summary?.worktrees.find((w) => w.path === this.selected);
    if (!wt) { host.textContent = "Select a worktree."; return; }

    const d = this.detail.get(wt.path);
    if (!d) void this.loadDetail(wt.path);
    const size = this.sizes.get(wt.path);

    const title = document.createElement("div");
    title.className = "wt-d-title";
    title.textContent = worktreeLabel(wt);
    const path = document.createElement("div");
    path.className = "wt-d-path";
    path.textContent = compactPath(wt.path);

    const summary = document.createElement("div");
    summary.className = "wt-d-summary";
    const when = wt.last_commit_unix ? relativeTime(wt.last_commit_unix) : "no commits";
    const subj = d ? (d.subject ?? "(no commit yet)") : "…";
    const stat = d ? `${wt.dirty_count} changed · +${d.ins} / -${d.del}` : "…";
    summary.innerHTML = `<div class="wt-d-subject">${escapeHtml(subj)}</div>` +
      `<div class="wt-d-meta">${escapeHtml(when)} · ${escapeHtml(stat)}</div>`;

    const files = document.createElement("div");
    files.className = "wt-d-files";
    if (d && d.files.length) {
      for (const f of d.files.slice(0, 40)) {
        const row = document.createElement("div");
        row.className = "wt-d-file";
        row.textContent = f;
        files.appendChild(row);
      }
      if (d.files.length > 40) {
        const more = document.createElement("div");
        more.className = "wt-d-file wt-d-more";
        more.textContent = `+${d.files.length - 40} more`;
        files.appendChild(more);
      }
    }

    const disk = document.createElement("div");
    disk.className = "wt-d-disk";
    if (size) {
      disk.textContent = size.target > 0
        ? `disk ${humanSize(size.total)} · target/ ${humanSize(size.target)} reclaimable`
        : `disk ${humanSize(size.total)}`;
    }

    const actions = this.renderActions(wt, size);

    host.append(title, path, summary, files, disk, actions);
  }

  private renderActions(wt: GitWorktreeSummary, size?: { total: number; target: number }): HTMLElement {
    const row = document.createElement("div");
    row.className = "wt-d-actions";
    const btn = (text: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `wt-act ${cls}`;
      b.textContent = text;
      b.addEventListener("click", fn);
      row.appendChild(b);
      return b;
    };

    if (!wt.current && !wt.is_main) {
      btn("Open tab", "wt-act-open", () => { this.opts.onOpenTab(wt.path, worktreeLabel(wt)); this.close(); });
    }
    btn("View diff", "wt-act-diff", () => {
      window.dispatchEvent(new CustomEvent("covenant:open-changes", { detail: { cwd: wt.path } }));
      this.close();
    });

    // Clean build artifacts — extra warning on the live/current worktree.
    const isLive = this.liveRoot === wt.path || wt.current;
    const hasTarget = size ? size.target > 0 : false;
    if (hasTarget) {
      const freed = size ? ` (${humanSize(size.target)})` : "";
      btn("Clean build artifacts" + freed, "wt-act-clean", () => {
        const warn = isLive
          ? " This worktree built the running app — cleaning target/ mid-run can crash the dev build."
          : "";
        pushConfirmToast({
          message: `Delete ${compactPath(wt.path)}/target/?${warn}`,
          confirmLabel: "Clean",
          onConfirm: () => {
            void worktreeCleanTarget(wt.path)
              .then((kb) => {
                pushInfoToast({ message: `Freed ${humanSize(kb)} from ${worktreeLabel(wt)}` });
                void this.loadSizes();
              })
              .catch((e) => pushInfoToast({ message: `Clean failed: ${String(e)}` }));
          },
        });
      });
    }

    // State action — reuse the popover's verdict. Only wt.path (a real
    // gitRepoSummary worktree) is ever passed to these destructive commands.
    const act = worktreeDefaultAction(wt, this.opts.getOccupiedCwds());
    if (act === "prune" || act === "reclaim") {
      btn(act === "prune" ? "Prune" : "Reclaim", "wt-act-danger", () => {
        pushConfirmToast({
          message: `Remove worktree ${worktreeLabel(wt)}? This deletes the checkout and any untracked/ignored files in it.`,
          confirmLabel: act === "prune" ? "Prune" : "Reclaim",
          onConfirm: () => {
            void worktreeReclaim(this.repoRoot, [wt.path])
              .then((outcomes) => {
                const outcome = outcomes[0];
                if (outcome && !outcome.removed) {
                  pushInfoToast({ message: `Could not remove: ${outcome.reason ?? "refused"}` });
                  return;
                }
                this.selected = null;
                void this.refresh();
              })
              .catch((e) => pushInfoToast({ message: `Reclaim failed: ${String(e)}` }));
          },
        });
      });
    } else if (act === "relocate") {
      btn("Relocate", "wt-act", () => {
        void worktreeRelocate(this.repoRoot, wt.path)
          .then(() => void this.refresh())
          .catch((e) => pushInfoToast({ message: `Relocate failed: ${String(e)}` }));
      });
    }
    return row;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
}

/// Coarse relative time for the detail panel ("3m ago", "2h ago", "5d ago").
function relativeTime(unixSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
