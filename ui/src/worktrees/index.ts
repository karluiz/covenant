import {
  gitRepoSummary, worktreeSizes, worktreeDetail, gitChanges, devLiveWorktreeRoot,
  worktreeCleanTarget, worktreeReclaim, worktreeRelocate, worktreeMergeEnd, explainChanges,
  type GitRepoSummary, type GitWorktreeSummary, type ReclaimOutcome, type CommitBrief,
} from "../api";
import { worktreeStateClass, worktreeStateLabel, worktreeDefaultAction, STATE_HELP, ACTION_HELP } from "../status/worktree-state";
import { attachTooltip } from "../tooltip/tooltip";
import { Icons } from "../icons";
import { renderMarkdown } from "../ui/markdown";
import { worktreeLabel, compactPath, humanSize } from "./format";
import { splitSizes, sizeRequestPaths, subtractNested } from "./sizes";
import { groupWorktrees, spentReclaimPaths, type WorktreeGroup } from "./groups";
import { pushConfirmToast, pushInfoToast } from "../notifications/toast";

interface WorktreesOpts {
  onOpenTab: (path: string, label: string) => void;
  // Launch the default spawn IN this worktree (skips resolveLaunch — reuses the
  // existing checkout). Same path as the git popover's "Agent" row action.
  onResumeAgent: (path: string, label: string) => void;
  getOccupiedCwds: () => ReadonlySet<string>;
  // Presence: which open tab (if any) lives at this cwd, and how to jump to it.
  getTabForCwd?: (path: string) => { id: string; label: string } | null;
  onGoToTab?: (id: string) => void;
}

interface DetailData {
  subject: string | null;
  ins: number;
  del: number;
  base: string;
  ahead: number;
  behind: number;
  commits: CommitBrief[];
  files: { path: string; status: string; added: number; removed: number }[];
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
  private detail = new Map<string, DetailData>();
  // On-demand LLM explanation per worktree path. Cleared on refresh so an
  // explanation never outlives the diff it describes.
  private explains = new Map<string, { state: "loading" | "done" | "error"; text: string }>();
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
    this.explains.clear();
  }

  private async refresh(): Promise<void> {
    this.detail.clear();
    this.explains.clear();
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

  private renderList(host: HTMLElement): void {
    host.innerHTML = "";
    const wts = this.summary?.worktrees ?? [];
    const maxKb = Math.max(1, ...[...this.sizes.values()].map((s) => s.total));
    for (const group of groupWorktrees(wts, this.sizes)) {
      host.appendChild(this.renderGroupHead(group));
      for (const wt of group.worktrees) host.appendChild(this.renderRow(wt, maxKb));
    }
  }

  /// Group header: state label + count/total, and the one bulk verb on SPENT.
  private renderGroupHead(group: WorktreeGroup): HTMLElement {
    const head = document.createElement("div");
    head.className = "wt-group-head";
    const dot = document.createElement("span");
    dot.className = `wt-dot ${worktreeStateClass(group.state)}`;
    const label = document.createElement("span");
    label.className = "wt-group-label";
    label.textContent = worktreeStateLabel(group.state);
    attachTooltip(label, STATE_HELP[group.state]);
    const meta = document.createElement("span");
    meta.className = "wt-group-meta";
    const n = group.worktrees.length;
    meta.textContent = `${n} ${n === 1 ? "worktree" : "worktrees"}`
      + (group.totalKb !== null ? ` · ${humanSize(group.totalKb)}` : "");
    head.append(dot, label, meta);

    const paths = group.state === "spent" ? spentReclaimPaths(group.worktrees) : [];
    if (paths.length) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wt-group-reclaim";
      btn.innerHTML = `${Icons.trash({ size: 12 })}<span>Reclaim all</span>`;
      attachTooltip(btn, ACTION_HELP.reclaim!);
      btn.addEventListener("click", () => this.reclaimAll(paths));
      head.appendChild(btn);
    }
    return head;
  }

  /// Bulk reclaim every spent worktree. Freed KB is estimated from the cached
  /// sizes map (du of a deleted path is gone by the time we could re-measure).
  private reclaimAll(paths: string[]): void {
    const freedKb = paths.reduce((sum, p) => sum + (this.sizes.get(p)?.total ?? 0), 0);
    const freed = freedKb > 0 ? ` and free ~${humanSize(freedKb)}` : "";
    pushConfirmToast({
      message: `Remove ${paths.length} spent worktrees${freed}? Their branches are already merged or gone.`,
      confirmLabel: "Reclaim all",
      onConfirm: () => { void this.runReclaimAll(paths); },
    });
  }

  /// One backend call per path so the button can count progress and each row
  /// dims as it dies. Overhead is negligible next to deleting the checkouts.
  private async runReclaimAll(paths: string[]): Promise<void> {
    const btn = this.host.querySelector<HTMLButtonElement>(".wt-group-reclaim");
    const rows = new Map<string, HTMLElement>();
    for (const el of this.host.querySelectorAll<HTMLElement>(".wt-row[data-path]")) {
      rows.set(el.dataset.path ?? "", el);
    }
    const rowFor = (p: string): HTMLElement | null => rows.get(p) ?? null;
    if (btn) btn.disabled = true;
    const outcomes: ReclaimOutcome[] = [];
    for (const [i, p] of paths.entries()) {
      if (btn) btn.innerHTML = `${Icons.trash({ size: 12 })}<span>Reclaiming ${i + 1}/${paths.length}…</span>`;
      const row = rowFor(p);
      row?.classList.add("is-reclaiming");
      try {
        const out = await worktreeReclaim(this.repoRoot, [p]);
        outcomes.push(...out);
        row?.classList.toggle("is-reclaimed", out[0]?.removed ?? false);
      } catch (e) {
        outcomes.push({ path: p, removed: false, reason: String(e) });
      }
      row?.classList.remove("is-reclaiming");
    }
    const removed = outcomes.filter((o) => o.removed);
    const refused = outcomes.filter((o) => !o.removed);
    const freedDone = removed.reduce((sum, o) => sum + (this.sizes.get(o.path)?.total ?? 0), 0);
    let msg = `Reclaimed ${removed.length}`;
    if (freedDone > 0) msg += ` · freed ~${humanSize(freedDone)}`;
    for (const o of refused) msg += ` · ${compactPath(o.path)} refused: ${o.reason ?? "unknown"}`;
    pushInfoToast({ message: msg });
    this.selected = null;
    void this.refresh();
  }

  private renderRow(wt: GitWorktreeSummary, maxKb: number): HTMLElement {
    const size = this.sizes.get(wt.path);
    const row = document.createElement("button");
    row.type = "button";
    row.className = "wt-row" + (wt.path === this.selected ? " is-selected" : "");
    row.dataset.path = wt.path;
    row.addEventListener("click", () => { this.selected = wt.path; this.render(); });

    const dot = document.createElement("span");
    dot.className = `wt-dot ${worktreeStateClass(wt.state)}`;
    attachTooltip(dot, STATE_HELP[wt.state]);
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
    return row;
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
      const files = [...changes.unstaged, ...changes.staged].map((f) => ({
        path: f.path,
        status: f.status[0].toUpperCase(),
        added: f.added,
        removed: f.removed,
      }));
      this.detail.set(path, {
        subject: d.last_subject, ins: d.insertions, del: d.deletions,
        base: d.base_branch ?? "main", ahead: d.ahead ?? 0, behind: d.behind ?? 0,
        commits: d.commits_ahead ?? [], files,
      });
    } catch {
      this.detail.set(path, {
        subject: null, ins: 0, del: 0, base: "main", ahead: 0, behind: 0, commits: [], files: [],
      });
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

    // Title row — name + state pill, so the detail echoes the row you clicked
    // and explains the verb the action buttons expose.
    const head = document.createElement("div");
    head.className = "wt-d-head";
    const title = document.createElement("div");
    title.className = "wt-d-title";
    title.textContent = worktreeLabel(wt);
    head.appendChild(title);
    if (wt.current) {
      const here = document.createElement("span");
      here.className = "wt-d-state wt-d-here";
      here.textContent = "HERE";
      head.appendChild(here);
    } else {
      const pill = document.createElement("span");
      pill.className = "wt-d-state";
      const dot = document.createElement("span");
      dot.className = `wt-dot ${worktreeStateClass(wt.state)}`;
      const lbl = document.createElement("span");
      lbl.textContent = worktreeStateLabel(wt.state);
      pill.append(dot, lbl);
      attachTooltip(pill, STATE_HELP[wt.state]);
      head.appendChild(pill);
    }

    const path = document.createElement("div");
    path.className = "wt-d-path";
    path.textContent = compactPath(wt.path);

    const sync = this.renderSyncStrip(wt, d);
    const session = this.renderSession(wt);

    const subject = document.createElement("div");
    subject.className = "wt-d-subject";
    subject.textContent = d ? (d.subject ?? "(no commit yet)") : "…";

    const sections = document.createElement("div");
    sections.className = "wt-d-sections";
    if (d && d.commits.length) sections.appendChild(this.renderCommits(d));
    if (d && d.files.length) sections.appendChild(this.renderFiles(wt, d));
    if (size) sections.appendChild(this.renderDisk(wt, size));
    const explain = this.renderExplain(wt);
    if (explain) sections.appendChild(explain);

    const actions = this.renderActions(wt);

    host.append(head, path, ...(sync ? [sync] : []), ...(session ? [session] : []), subject, sections, actions);
  }

  /// P3 — the branch's arithmetic against the default branch, as chips.
  private renderSyncStrip(wt: GitWorktreeSummary, d: DetailData | undefined): HTMLElement | null {
    const strip = document.createElement("div");
    strip.className = "wt-d-sync";
    const chip = (text: string, cls = ""): void => {
      const c = document.createElement("span");
      c.className = `wt-d-chip ${cls}`.trim();
      c.textContent = text;
      strip.appendChild(c);
    };
    if (d) {
      if (d.ahead > 0) chip(`↑ ${d.ahead} ahead`);
      if (d.behind > 0) chip(`↓ ${d.behind} behind ${d.base}`, "wt-d-chip-warn");
    }
    chip(wt.last_commit_unix ? `last commit ${relativeTime(wt.last_commit_unix)}` : "no commits");
    return strip;
  }

  /// P5 — a session is open in this worktree; say so and offer the jump.
  private renderSession(wt: GitWorktreeSummary): HTMLElement | null {
    if (wt.current) return null;
    const tab = this.opts.getTabForCwd?.(wt.path);
    if (!tab) return null;
    const row = document.createElement("div");
    row.className = "wt-d-session";
    const dot = document.createElement("span");
    dot.className = "wt-dot status-git-pop-wt-active";
    const text = document.createElement("span");
    text.className = "wt-d-session-text";
    text.textContent = `Session open · tab “${tab.label}”`;
    row.append(dot, text);
    if (this.opts.onGoToTab) {
      const go = document.createElement("button");
      go.type = "button";
      go.className = "wt-d-session-go";
      go.textContent = "Go to tab →";
      go.addEventListener("click", () => {
        this.close();
        this.opts.onGoToTab!(tab.id);
      });
      row.appendChild(go);
    }
    return row;
  }

  /// P2 — what this branch adds over the default branch (capped at 8 by the backend).
  private renderCommits(d: DetailData): HTMLElement {
    const wrap = document.createElement("div");
    wrap.appendChild(sectionLabel(`Ahead of ${d.base} · ${d.ahead} ${d.ahead === 1 ? "commit" : "commits"}`));
    for (const c of d.commits) {
      const row = document.createElement("div");
      row.className = "wt-d-commit";
      const rail = document.createElement("span");
      rail.className = "wt-d-commit-rail";
      const s = document.createElement("span");
      s.className = "wt-d-commit-subject";
      s.textContent = c.subject;
      const t = document.createElement("span");
      t.className = "wt-d-commit-time";
      t.textContent = relativeTime(c.unix);
      row.append(rail, s, t);
      wrap.appendChild(row);
    }
    if (d.ahead > d.commits.length) {
      const more = document.createElement("div");
      more.className = "wt-d-file wt-d-more";
      more.textContent = `+${d.ahead - d.commits.length} more`;
      wrap.appendChild(more);
    }
    return wrap;
  }

  /// P1 — uncommitted files with per-file diffstat; click opens the diff.
  private renderFiles(wt: GitWorktreeSummary, d: DetailData): HTMLElement {
    const wrap = document.createElement("div");
    const n = d.files.length;
    wrap.appendChild(sectionLabel(`Changes · ${n} ${n === 1 ? "file" : "files"} · +${d.ins} / −${d.del}`));
    const maxTouched = Math.max(1, ...d.files.map((f) => f.added + f.removed));
    for (const f of d.files.slice(0, 40)) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "wt-d-filerow";
      const st = document.createElement("span");
      st.className = `wt-d-filest wt-d-filest-${f.status.toLowerCase()}`;
      st.textContent = f.status;
      const p = document.createElement("span");
      p.className = "wt-d-filepath";
      p.textContent = f.path;
      const nums = document.createElement("span");
      nums.className = "wt-d-filenums";
      const addN = document.createElement("span");
      addN.className = "wt-d-filenum-add";
      addN.textContent = `+${f.added}`;
      const delN = document.createElement("span");
      delN.className = "wt-d-filenum-del";
      delN.textContent = `−${f.removed}`;
      nums.append(addN, " ", delN);
      const bar = document.createElement("span");
      bar.className = "wt-d-filebar";
      const add = document.createElement("i");
      add.className = "wt-d-filebar-add";
      add.style.width = `${Math.round((f.added / maxTouched) * 100)}%`;
      const del = document.createElement("i");
      del.className = "wt-d-filebar-del";
      del.style.width = `${Math.round((f.removed / maxTouched) * 100)}%`;
      bar.append(add, del);
      row.append(st, p, nums, bar);
      row.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("covenant:open-changes", {
          detail: { cwd: wt.path, backTo: "worktrees", file: f.path },
        }));
        this.close();
      });
      wrap.appendChild(row);
    }
    if (d.files.length > 40) {
      const more = document.createElement("div");
      more.className = "wt-d-file wt-d-more";
      more.textContent = `+${d.files.length - 40} more`;
      wrap.appendChild(more);
    }
    return wrap;
  }

  /// P4 — disk split into checkout vs target/, with the verb inline.
  private renderDisk(wt: GitWorktreeSummary, size: { total: number; target: number }): HTMLElement {
    const wrap = document.createElement("div");
    wrap.appendChild(sectionLabel(`Disk · ${humanSize(size.total)}`));
    const checkout = Math.max(0, size.total - size.target);
    const bar = document.createElement("div");
    bar.className = "wt-d-diskbar";
    const co = document.createElement("i");
    co.className = "wt-d-disk-checkout";
    co.style.width = size.total > 0 ? `${Math.round((checkout / size.total) * 100)}%` : "100%";
    bar.appendChild(co);
    if (size.target > 0) {
      const tg = document.createElement("i");
      tg.className = "wt-d-disk-target";
      tg.style.width = `${Math.round((size.target / size.total) * 100)}%`;
      bar.appendChild(tg);
    }
    const legend = document.createElement("div");
    legend.className = "wt-d-disklegend";
    const coLeg = document.createElement("span");
    coLeg.innerHTML = `<i class="wt-d-disksw wt-d-disk-checkout"></i>checkout ${humanSize(checkout)}`;
    legend.appendChild(coLeg);
    if (size.target > 0) {
      const tgLeg = document.createElement("span");
      tgLeg.innerHTML = `<i class="wt-d-disksw wt-d-disk-target"></i>target/ ${humanSize(size.target)} · `;
      const clean = document.createElement("button");
      clean.type = "button";
      clean.className = "wt-d-cleanlink";
      clean.textContent = "Clean";
      clean.addEventListener("click", () => this.confirmCleanTarget(wt, size));
      tgLeg.appendChild(clean);
      legend.appendChild(tgLeg);
    }
    wrap.append(bar, legend);
    return wrap;
  }

  /// P6 — on-demand LLM explanation of the worktree's uncommitted diff.
  private renderExplain(wt: GitWorktreeSummary): HTMLElement | null {
    const ex = this.explains.get(wt.path);
    if (!ex) return null;
    const wrap = document.createElement("div");
    wrap.appendChild(sectionLabel("Explain"));
    const doc = document.createElement("div");
    doc.className = "wt-d-explain markdown-doc";
    if (ex.state === "loading") {
      doc.classList.add("wt-d-explain-loading");
      doc.textContent = "Reading the diff…";
    } else if (ex.state === "error") {
      doc.textContent = ex.text;
    } else {
      doc.innerHTML = renderMarkdown(ex.text);
    }
    wrap.appendChild(doc);
    return wrap;
  }

  private runExplain(wt: GitWorktreeSummary): void {
    if (this.explains.get(wt.path)?.state === "loading") return;
    this.explains.set(wt.path, { state: "loading", text: "" });
    this.render();
    void explainChanges(wt.path)
      .then((text) => this.explains.set(wt.path, { state: "done", text }))
      .catch((e) => this.explains.set(wt.path, { state: "error", text: String(e) }))
      .then(() => { if (this.open_ && this.selected === wt.path) this.render(); });
  }

  private confirmCleanTarget(wt: GitWorktreeSummary, size: { total: number; target: number }): void {
    const isLive = this.liveRoot === wt.path || wt.current;
    const warn = isLive
      ? " This worktree built the running app — cleaning target/ mid-run can crash the dev build."
      : "";
    pushConfirmToast({
      message: `Delete ${compactPath(wt.path)}/target/? (${humanSize(size.target)})${warn}`,
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
  }

  private renderActions(wt: GitWorktreeSummary): HTMLElement {
    const row = document.createElement("div");
    row.className = "wt-d-actions";
    // One left-aligned cluster: workflow verbs, then a hairline divider before
    // the single lifecycle verb (reclaim/prune/relocate) so it reads as a
    // separate category without floating off to the panel's far edge.
    const btn = (text: string, icon: string, cls: string, fn: () => void): HTMLButtonElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `wt-act ${cls}`.trim();
      b.innerHTML = `${icon}<span>${text}</span>`;
      b.addEventListener("click", fn);
      row.appendChild(b);
      return b;
    };
    const divider = (): void => {
      const s = document.createElement("span");
      s.className = "wt-act-sep";
      row.appendChild(s);
    };

    if (!wt.current && !wt.is_main) {
      // Agent is the primary workflow verb — resume the default spawn in place.
      btn("Agent", Icons.sparkles({ size: 14 }), "wt-act-primary", () => {
        this.opts.onResumeAgent(wt.path, worktreeLabel(wt));
        this.close();
      });
      btn("Open tab", Icons.terminalSquare({ size: 14 }), "", () => { this.opts.onOpenTab(wt.path, worktreeLabel(wt)); this.close(); });
    }
    btn("View diff", Icons.gitCompare({ size: 14 }), "", () => {
      window.dispatchEvent(new CustomEvent("covenant:open-changes", { detail: { cwd: wt.path, backTo: "worktrees" } }));
      this.close();
    });
    // Explain only makes sense with an uncommitted diff to read.
    if (wt.dirty_count > 0) {
      btn("Explain", Icons.sparkles({ size: 14 }), "", () => this.runExplain(wt));
      // Commit routes to the existing Changes composer — same surface View
      // diff opens, but named for the job when there is uncommitted work.
      btn("Commit", Icons.gitCommit({ size: 14 }), "", () => {
        window.dispatchEvent(new CustomEvent("covenant:open-changes", { detail: { cwd: wt.path, backTo: "worktrees" } }));
        this.close();
      });
    }

    // Merge & end — merge into the default branch, then reclaim. Only offered
    // while the branch is unmerged; spent worktrees already have Reclaim.
    if (!wt.is_main && !wt.current && !wt.merged && wt.branch) {
      const base = this.summary?.default_branch ?? "main";
      const mainWt = this.summary?.worktrees.find((w) => w.is_main) ?? null;
      const blocked =
        wt.dirty_count > 0 ? "Commit your changes first" :
        wt.locked ? `Locked: ${wt.locked}` :
        this.opts.getOccupiedCwds().has(wt.path) ? "A session is using this worktree" :
        mainWt && mainWt.dirty_count > 0 ? "Main checkout has uncommitted changes" :
        null;
      divider();
      const b = btn("Merge & end", Icons.gitMerge({ size: 14 }), "", () => {
        if (b.classList.contains("is-disabled")) return;
        pushConfirmToast({
          message: `Merge ${wt.branch} into ${base} and remove the worktree?`,
          confirmLabel: "Merge & end",
          onConfirm: () => {
            void worktreeMergeEnd(this.repoRoot, wt.path)
              .then((out) => {
                if (!out.removed) {
                  pushInfoToast({ message: `Merged, but not removed: ${out.reason ?? "refused"}` });
                } else {
                  pushInfoToast({ message: `Merged ${wt.branch} into ${base} and reclaimed ${worktreeLabel(wt)}` });
                  this.selected = null;
                }
                void this.refresh();
              })
              .catch((e) => pushInfoToast({ message: `Merge & end failed: ${String(e)}` }));
          },
        });
      });
      b.classList.toggle("is-disabled", blocked !== null);
      attachTooltip(b, blocked ?? `Merge ${wt.branch} into ${base}, then remove the worktree and branch`);
    }

    // State action — reuse the popover's verdict. Only wt.path (a real
    // gitRepoSummary worktree) is ever passed to these destructive commands.
    const act = worktreeDefaultAction(wt, this.opts.getOccupiedCwds());
    const help = ACTION_HELP[act];
    if (act === "prune" || act === "reclaim") {
      divider();
      const b = btn(act === "prune" ? "Prune" : "Reclaim", Icons.trash({ size: 14 }), "wt-act-danger", () => {
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
      if (help) attachTooltip(b, help);
    } else if (act === "relocate") {
      divider();
      const b = btn("Relocate", Icons.arrowRight({ size: 14 }), "", () => {
        void worktreeRelocate(this.repoRoot, wt.path)
          .then(() => void this.refresh())
          .catch((e) => pushInfoToast({ message: `Relocate failed: ${String(e)}` }));
      });
      if (help) attachTooltip(b, help);
    }
    return row;
  }
}

/// Uppercase mono section label — one per detail section (commits, changes, disk).
function sectionLabel(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "wt-d-seclabel";
  el.textContent = text;
  return el;
}

/// Coarse relative time for the detail panel ("3m ago", "2h ago", "5d ago").
function relativeTime(unixSecs: number): string {
  const secs = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (secs < 3600) return `${Math.max(1, Math.floor(secs / 60))}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}
