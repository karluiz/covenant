// Evals cockpit — the full-screen module a run actually deserves (⌘⌥E).
//
// Master–detail over three columns: runs (live from the backend registry +
// history from eval-history.jsonl) → cases → transcript. Every view here is
// a viewport over backend state hydrated via canon_list_eval_runs, so the
// cockpit can open mid-run, after a reload, or days later and show the same
// truth. Mirrors WorktreesSurface (ui/src/worktrees/index.ts): a fixed
// overlay, Escape captured on the capture phase.

import {
  canonCancelEvals,
  canonEvalDetail,
  canonListEvalRuns,
  canonListEvals,
  canonRunEvals,
  onCanonEvalProgress,
  type CanonEvalProgress,
  type CanonEvalRunDetail,
  type EvalHistoryRecord,
  type EvalRunCase,
  type EvalRunSnapshot,
  type EvalRunsList,
} from "../api";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { Icons } from "../icons";
import { renderMarkdown } from "../ui/markdown";
import { pushInfoToast } from "../notifications/toast";
import { attachTooltip } from "../tooltip/tooltip";
import { openEvalManager } from "./evals";

/** Total/baseline percentages + lift derived from a detail's weighted-criteria
 *  score. Null for a legacy record (`max_score === 0`) — the case detail
 *  falls back to today's pass/fail-only rendering, unchanged. */
export function scoreSummary(
  d: Pick<CanonEvalRunDetail, "score" | "max_score" | "baseline_score">,
): { pct: number; basePct: number | null; lift: number | null } | null {
  if (!d.max_score) return null;
  const pct = Math.round((d.score / d.max_score) * 100);
  const basePct = d.baseline_score == null
    ? null
    : Math.round((d.baseline_score / d.max_score) * 100);
  return { pct, basePct, lift: basePct == null ? null : pct - basePct };
}

/** "75%" from a run's score/max_score, or "" when no criteria data exists
 *  (legacy record, `max_score` zero/absent) — callers render nothing then. */
export function runScoreLabel(r: { score?: number; max_score?: number }): string {
  if (!r.max_score) return "";
  return `${Math.round(((r.score ?? 0) / r.max_score) * 100)}%`;
}

/** What the rail selects: a live registry run, or one history record (a past
 *  run, pinned by `atMs`). `atMs: null` = unit focus with no specific run —
 *  the unit's last recorded state. */
type Sel =
  | { type: "live"; runId: string }
  | { type: "unit"; kind: string; name: string; atMs: number | null };

type DetailTab = "transcript" | "baseline" | "judge" | "scenario";

function timeAgo(ms: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

function fmtElapsed(fromMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - fromMs) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function dotClass(status: string): string {
  if (status === "running") return "is-running";
  if (status === "pass") return "is-pass";
  if (status === "fail" || status === "error") return "is-fail";
  return "is-idle";
}

export class EvalsCockpit {
  private host: HTMLElement;
  private open_ = false;
  private cwd = "";
  private data: EvalRunsList | null = null;
  private sel: Sel | null = null;
  private selCase: string | null = null;
  private tab: DetailTab = "transcript";
  private mdView: "preview" | "source" = "preview";
  /** Authored eval ids per unit key — the case list for a unit selection. */
  private unitCases = new Map<string, string[]>();
  /** Last-run detail per `<kind>/<name>/<eval_id>`; null = fetched, none. */
  private details = new Map<string, CanonEvalRunDetail | null>();
  /** Case keys (`<kind>/<name>/<eval_id>`) with an in-flight retry — disables
   *  that case's retry button until the request settles. */
  private retrying = new Set<string>();
  private unlisten: UnlistenFn | null = null;
  private ticker: ReturnType<typeof setInterval> | undefined;

  private onKey = (e: KeyboardEvent): void => {
    if (this.open_ && e.key === "Escape") { e.preventDefault(); this.close(); }
  };

  constructor(host: HTMLElement) { this.host = host; }

  get isOpen(): boolean { return this.open_; }

  async toggle(cwd: string, focus?: { kind: string; name: string }): Promise<void> {
    if (this.open_) { this.close(); return; }
    await this.open(cwd, focus);
  }

  async open(cwd: string, focus?: { kind: string; name: string }): Promise<void> {
    if (this.open_) { this.close(); }
    this.open_ = true;
    this.cwd = cwd;
    document.body.classList.add("evals-fullscreen");
    document.addEventListener("keydown", this.onKey, true);
    this.mountShell();
    this.unlisten = await onCanonEvalProgress((e) => this.onProgress(e)).catch(() => null);
    // Live elapsed cells tick without re-rendering the columns.
    this.ticker = setInterval(() => this.tickElapsed(), 1000);
    await this.refresh(focus);
  }

  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    document.removeEventListener("keydown", this.onKey, true);
    document.body.classList.remove("evals-fullscreen");
    this.unlisten?.();
    this.unlisten = null;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = undefined;
    this.host.innerHTML = "";
    this.data = null;
    this.sel = null;
    this.selCase = null;
    this.unitCases.clear();
    this.details.clear();
    this.retrying.clear();
  }

  private async refresh(focus?: { kind: string; name: string }): Promise<void> {
    try {
      this.data = await canonListEvalRuns(this.cwd);
    } catch {
      this.data = { live: [], history: [] };
    }
    // Default selection: the focused unit's live run, else first live, else
    // the focused/first unit from history.
    const live = this.data.live;
    if (focus) {
      const run = live.find((r) => !r.done && r.kind === focus.kind && r.name === focus.name)
        ?? live.find((r) => r.kind === focus.kind && r.name === focus.name);
      this.sel = run ? { type: "live", runId: run.run_id } : { type: "unit", ...focus, atMs: null };
      this.selCase = null;
    } else if (!this.sel) {
      const first = live[0];
      if (first) {
        this.sel = { type: "live", runId: first.run_id };
      } else {
        const h = this.data.history[0];
        this.sel = h ? { type: "unit", kind: h.kind, name: h.name, atMs: h.at_ms } : null;
      }
    }
    this.render();
  }

  // --- live events ---------------------------------------------------------

  private onProgress(e: CanonEvalProgress): void {
    if (!this.open_ || !this.data) return;
    const run = e.run_id
      ? this.data.live.find((r) => r.run_id === e.run_id)
      : this.data.live.find((r) => !r.done && r.kind === e.kind && r.name === e.name);
    if (!run) {
      // A run this snapshot has never seen (just started) — rehydrate.
      if (e.status !== "done" && e.status !== "push_failed") void this.refresh();
      return;
    }
    if (e.status === "done") {
      run.done = true;
      run.cancelled = e.reason === "cancelled";
      for (const c of run.cases) {
        if (c.status === "pending" || c.status === "running") {
          c.status = "skipped";
          c.reason = run.cancelled ? "cancelled" : "not reached";
        }
      }
    } else if (e.eval_id !== "" && e.status !== "push_failed") {
      let c = run.cases.find((x) => x.eval_id === e.eval_id);
      if (!c) {
        c = {
          eval_id: e.eval_id, status: "pending", reason: "", arm: "",
          duration_ms: null, started_at_ms: null,
        };
        run.cases.push(c);
      }
      c.status = e.status as EvalRunCase["status"];
      c.reason = e.reason;
      c.arm = e.arm ?? "";
      if (e.duration_ms != null) c.duration_ms = e.duration_ms;
      if (e.status === "running" && c.started_at_ms == null) c.started_at_ms = Date.now();
      // A fresh verdict invalidates any cached detail for this case.
      if (e.status === "pass" || e.status === "fail") {
        this.details.delete(`${run.kind}/${run.name}/${e.eval_id}`);
      }
    }
    this.render();
  }

  private tickElapsed(): void {
    for (const cell of this.host.querySelectorAll<HTMLElement>("[data-live-since]")) {
      cell.textContent = fmtElapsed(Number(cell.dataset.liveSince));
    }
  }

  // --- shell + rendering ---------------------------------------------------

  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "evc-frame";

    const header = document.createElement("div");
    header.className = "evc-header";
    const title = document.createElement("span");
    title.className = "evc-title";
    title.textContent = "Evals";
    const spacer = document.createElement("span");
    spacer.className = "evc-header-spacer";
    const close = document.createElement("button");
    close.type = "button";
    close.className = "evc-close";
    close.setAttribute("aria-label", "Close (Esc)");
    close.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
    close.addEventListener("click", () => this.close());
    header.append(title, spacer, close);

    const body = document.createElement("div");
    body.className = "evc-body";
    body.append(
      el("div", "evc-rail"),
      el("div", "evc-cases"),
      el("div", "evc-detail"),
    );
    frame.append(header, body);
    this.host.appendChild(frame);
  }

  private render(): void {
    this.renderRail();
    this.renderCases();
    this.renderDetail();
  }

  private selectedRun(): EvalRunSnapshot | null {
    if (!this.data || this.sel?.type !== "live") return null;
    const id = this.sel.runId;
    return this.data.live.find((r) => r.run_id === id) ?? null;
  }

  private selectedUnit(): { kind: string; name: string } | null {
    if (this.sel?.type === "unit") return { kind: this.sel.kind, name: this.sel.name };
    const run = this.selectedRun();
    return run ? { kind: run.kind, name: run.name } : null;
  }

  /** The history record the selection pins, if any. */
  private selectedRecord(): EvalHistoryRecord | null {
    if (!this.data || this.sel?.type !== "unit" || this.sel.atMs === null) return null;
    const { kind, name, atMs } = this.sel;
    return this.data.history.find((h) =>
      h.kind === kind && h.name === name && h.at_ms === atMs) ?? null;
  }

  /** True when no newer record exists for this unit — the on-disk detail
   *  store (last-run-wins) still holds THIS run's transcripts. */
  private isLatestRecord(rec: EvalHistoryRecord): boolean {
    return !this.data!.history.some((h) =>
      h.kind === rec.kind && h.name === rec.name && h.at_ms > rec.at_ms);
  }

  // --- rail ---------------------------------------------------------------

  private renderRail(): void {
    const rail = this.host.querySelector<HTMLElement>(".evc-rail");
    if (!rail || !this.data) return;
    rail.innerHTML = "";

    const running = this.data.live.filter((r) => !r.done);
    const finished = this.data.live.filter((r) => r.done);
    // A finished live run already appended its history record — drop that
    // record so the run doesn't show twice.
    const history = this.data.history.filter((h) =>
      !finished.some((r) => r.kind === h.kind && r.name === h.name && h.at_ms >= r.started_at_ms));

    if (running.length) {
      rail.appendChild(section("Running")); // uppercased via CSS
      for (const run of running) rail.appendChild(this.railRunRow(run));
    }
    if (finished.length || history.length) {
      rail.appendChild(section("History"));
      for (const run of finished) rail.appendChild(this.railRunRow(run));
      for (const h of history) rail.appendChild(this.railHistoryRow(h));
    }
    if (!running.length && !finished.length && !history.length) {
      const empty = el("div", "evc-empty");
      empty.textContent = "No eval runs yet — run evals from any unit in Canon, or press Run in Manage.";
      rail.appendChild(empty);
    }
  }

  /** The history record a just-finished live run appended, if any — carries
   *  the aggregate score the live registry snapshot itself doesn't track. */
  private historyFor(run: EvalRunSnapshot): EvalHistoryRecord | undefined {
    return this.data?.history.find((h) =>
      h.kind === run.kind && h.name === run.name && h.at_ms >= run.started_at_ms);
  }

  private railRunRow(run: EvalRunSnapshot): HTMLElement {
    const row = el("button", "evc-run-row") as HTMLButtonElement;
    row.type = "button";
    const selected = this.sel?.type === "live" && this.sel.runId === run.run_id;
    row.classList.toggle("is-selected", selected);
    const settled = run.cases.filter((c) => c.status !== "pending" && c.status !== "running").length;
    const passed = run.cases.filter((c) => c.status === "pass").length;
    const dot = el("span", `evc-dot ${run.done ? dotClass(passed === run.cases.length ? "pass" : "fail") : "is-running"}`);
    const name = el("span", "evc-run-name");
    name.textContent = run.name;
    const meta = el("span", "evc-run-meta");
    if (run.done) {
      const scoreLabel = runScoreLabel(this.historyFor(run) ?? {});
      const scoreBit = scoreLabel ? ` · ${scoreLabel}` : "";
      meta.textContent = `${run.kind} · ${passed}/${run.cases.length} pass${scoreBit}${run.cancelled ? " · stopped" : ""}`;
    } else {
      meta.textContent = `${run.kind} · ${settled}/${run.cases.length} · `;
      const elapsed = el("span", "");
      elapsed.dataset.liveSince = String(run.started_at_ms);
      elapsed.textContent = fmtElapsed(run.started_at_ms);
      meta.appendChild(elapsed);
    }
    row.append(dot, name, meta);
    row.addEventListener("click", () => {
      this.sel = { type: "live", runId: run.run_id };
      this.selCase = null;
      this.render();
    });
    return row;
  }

  private railHistoryRow(h: EvalHistoryRecord): HTMLElement {
    const row = el("button", "evc-run-row") as HTMLButtonElement;
    row.type = "button";
    const selected = this.sel?.type === "unit" && this.sel.kind === h.kind
      && this.sel.name === h.name && this.sel.atMs === h.at_ms;
    row.classList.toggle("is-selected", selected);
    const dot = el("span", `evc-dot ${h.passed === h.total ? "is-pass" : "is-fail"}`);
    const name = el("span", "evc-run-name");
    name.textContent = h.name;
    const meta = el("span", "evc-run-meta");
    const scoreLabel = runScoreLabel(h);
    const scoreBit = scoreLabel ? ` · ${scoreLabel}` : "";
    meta.textContent = `${h.kind} · ${h.passed}/${h.total} pass${scoreBit} · ${timeAgo(h.at_ms)}`;
    row.append(dot, name, meta);
    row.addEventListener("click", () => {
      this.sel = { type: "unit", kind: h.kind, name: h.name, atMs: h.at_ms };
      this.selCase = null;
      this.render();
    });
    return row;
  }

  // --- cases --------------------------------------------------------------

  private renderCases(): void {
    const host = this.host.querySelector<HTMLElement>(".evc-cases");
    if (!host) return;
    host.innerHTML = "";
    const unit = this.selectedUnit();
    if (!unit) return;
    const run = this.selectedRun();

    const rec = this.selectedRecord();

    const head = el("div", "evc-cases-head");
    const title = el("span", "evc-cases-title");
    title.textContent = unit.name;
    const sub = el("span", "evc-cases-sub");
    sub.textContent = run && !run.done
      ? `${unit.kind} · running`
      : rec ? `${unit.kind} · ${timeAgo(rec.at_ms)}` : unit.kind;
    head.append(title, sub);

    if (run && !run.done) {
      const stop = el("button", "evc-stop") as HTMLButtonElement;
      stop.type = "button";
      stop.textContent = "Stop";
      stop.addEventListener("click", () => {
        stop.disabled = true;
        stop.textContent = "Stopping…";
        canonCancelEvals(unit.kind, unit.name).catch((e) => {
          stop.disabled = false;
          stop.textContent = "Stop";
          pushInfoToast({ message: `Stop failed: ${String(e)}` });
        });
      });
      head.appendChild(stop);
    }
    const manage = el("button", "evc-manage") as HTMLButtonElement;
    manage.type = "button";
    manage.innerHTML = `${Icons.checklist({ size: 12 })}<span>Manage</span>`;
    manage.addEventListener("click", () => {
      void openEvalManager(this.cwd, unit.kind, unit.name, () => this.refresh());
    });
    head.appendChild(manage);
    host.appendChild(head);

    const list = el("div", "evc-case-list");
    host.appendChild(list);

    if (run) {
      for (const c of run.cases) list.appendChild(this.caseRow(c.eval_id, c, unit.kind, unit.name));
      return;
    }
    // A pinned history record carries its own per-case verdicts — render THAT
    // run, not the unit's last recorded state.
    if (rec && rec.cases.length > 0) {
      for (const c of rec.cases) {
        list.appendChild(this.caseRow(c.eval_id, {
          eval_id: c.eval_id,
          status: c.pass ? "pass" : "fail",
          reason: c.reason,
          arm: "",
          duration_ms: c.duration_ms,
          started_at_ms: null,
        }, unit.kind, unit.name));
      }
      return;
    }
    // Unit (history) selection: authored ids now, verdicts lazily per case.
    const key = `${unit.kind}/${unit.name}`;
    const ids = this.unitCases.get(key);
    if (!ids) {
      canonListEvals(this.cwd, unit.kind, unit.name)
        .then((evs) => {
          this.unitCases.set(key, evs.map((e) => e.id));
          this.render();
        })
        .catch(() => this.unitCases.set(key, []));
      const loading = el("div", "evc-empty");
      loading.textContent = "Loading…";
      list.appendChild(loading);
      return;
    }
    for (const id of ids) {
      const d = this.details.get(`${key}/${id}`);
      const pseudo: EvalRunCase | null = d
        ? {
            eval_id: id,
            status: d.pass ? "pass" : "fail",
            reason: d.reason,
            arm: "",
            duration_ms: d.duration_ms,
            started_at_ms: null,
          }
        : null;
      list.appendChild(this.caseRow(id, pseudo, unit.kind, unit.name));
      // Prefetch the verdict so dots fill in without a click.
      if (d === undefined) this.fetchDetail(unit.kind, unit.name, id);
    }
    if (ids.length === 0) {
      const empty = el("div", "evc-empty");
      empty.textContent = "No evals authored for this unit.";
      list.appendChild(empty);
    }
  }

  private caseRow(id: string, c: EvalRunCase | null, kind: string, name: string): HTMLElement {
    const row = el("button", "evc-case") as HTMLButtonElement;
    row.type = "button";
    row.classList.toggle("is-selected", this.selCase === id);
    const dot = el("span", `evc-dot ${c ? dotClass(c.status) : "is-idle"}`);
    const label = el("span", "evc-case-id");
    label.textContent = id;
    const note = el("span", "evc-case-note");
    if (c?.status === "running") {
      note.textContent = c.arm === "baseline" ? "baseline arm" : "";
    } else if (c && (c.status === "skipped" || c.status === "error")) {
      note.textContent = c.reason;
    }
    const dur = el("span", "evc-case-dur");
    if (c?.status === "running" && c.started_at_ms != null) {
      dur.dataset.liveSince = String(c.started_at_ms);
      dur.textContent = fmtElapsed(c.started_at_ms);
    } else if (c?.duration_ms != null) {
      dur.textContent = `${Math.round(c.duration_ms / 1000)}s`;
    } else {
      dur.textContent = "—";
    }
    // A span, not a button — `row` is already a <button> and nested buttons
    // are invalid HTML (see the same pattern in canon/panel.ts's org rename).
    const retryKey = `${kind}/${name}/${id}`;
    const busy = this.retrying.has(retryKey);
    const retry = el("span", `evc-case-retry${busy ? " is-busy" : ""}`);
    retry.innerHTML = Icons.refresh({ size: 12 });
    retry.setAttribute("role", "button");
    retry.setAttribute("aria-label", "Re-run this case");
    retry.setAttribute("aria-disabled", String(busy));
    attachTooltip(retry, "Re-run this case");
    retry.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.retrying.has(retryKey)) return;
      this.retrying.add(retryKey);
      this.render();
      canonRunEvals(this.cwd, kind, name, { only: id })
        .catch((err) => pushInfoToast({ message: `Retry failed: ${String(err)}` }))
        .finally(() => {
          this.retrying.delete(retryKey);
          this.render();
        });
    });
    row.append(dot, label, note, dur, retry);
    row.addEventListener("click", () => {
      this.selCase = id;
      this.render();
    });
    return row;
  }

  // --- detail --------------------------------------------------------------

  private detailKey(kind: string, name: string, id: string): string {
    return `${kind}/${name}/${id}`;
  }

  private fetchDetail(kind: string, name: string, id: string): void {
    const key = this.detailKey(kind, name, id);
    if (this.details.has(key)) return;
    canonEvalDetail(this.cwd, kind, name, id)
      .then((d) => { this.details.set(key, d); this.render(); })
      .catch(() => { this.details.set(key, null); this.render(); });
  }

  private renderDetail(): void {
    const host = this.host.querySelector<HTMLElement>(".evc-detail");
    if (!host) return;
    host.innerHTML = "";
    const unit = this.selectedUnit();
    if (!unit || !this.selCase) {
      const empty = el("div", "evc-empty");
      empty.textContent = "Select a case to read its transcript.";
      host.appendChild(empty);
      return;
    }
    const id = this.selCase;
    const run = this.selectedRun();
    const liveCase = run?.cases.find((c) => c.eval_id === id) ?? null;

    if (liveCase && (liveCase.status === "running" || liveCase.status === "pending")) {
      const empty = el("div", "evc-empty");
      empty.textContent = liveCase.status === "running"
        ? "Running — the transcript lands when this case settles."
        : "Queued — up to 2 sandboxes run at a time.";
      host.appendChild(empty);
      return;
    }

    // A superseded history record: the detail store is last-run-wins, so its
    // transcripts belong to a NEWER run. Show what the record itself kept.
    const rec = this.selectedRecord();
    if (rec && rec.cases.length > 0 && !this.isLatestRecord(rec)) {
      const c = rec.cases.find((x) => x.eval_id === id);
      const body = el("div", "evc-detail-body");
      if (!c) {
        const empty = el("div", "evc-empty");
        empty.textContent = "This eval was not part of that run.";
        host.appendChild(empty);
        return;
      }
      body.appendChild(textBlock("Judge reason", c.reason || "(no reason recorded)"));
      const note = el("div", "evc-retention-note");
      note.textContent =
        "Transcript not retained — only the latest run's transcripts are kept on disk.";
      body.appendChild(note);
      host.appendChild(body);
      const verdict = el("div", "evc-verdict");
      const v = el("span", c.pass ? "evc-verdict-pass" : "evc-verdict-fail");
      v.textContent = c.pass ? "Pass" : "Fail";
      const meta = el("span", "evc-verdict-meta");
      meta.textContent =
        `${Math.round(c.duration_ms / 1000)}s · ${new Date(rec.at_ms).toLocaleString()}`;
      verdict.append(v, meta);
      host.appendChild(verdict);
      return;
    }

    const key = this.detailKey(unit.kind, unit.name, id);
    const d = this.details.get(key);
    if (d === undefined) {
      this.fetchDetail(unit.kind, unit.name, id);
      const empty = el("div", "evc-empty");
      empty.textContent = "Loading…";
      host.appendChild(empty);
      return;
    }
    if (d === null) {
      const empty = el("div", "evc-empty");
      empty.textContent = liveCase && (liveCase.status === "skipped" || liveCase.status === "error")
        ? `No transcript — ${liveCase.reason || "the case never ran"}.`
        : "No run recorded for this eval yet.";
      host.appendChild(empty);
      return;
    }

    const summary = scoreSummary(d);
    if (summary) host.appendChild(this.criteriaBlock(d, summary));

    const tabs = el("div", "evc-tabs");
    const tabDefs: { id: DetailTab; label: string; available: boolean }[] = [
      { id: "transcript", label: "Transcript", available: true },
      { id: "baseline", label: "Baseline", available: d.baseline_transcript !== null },
      { id: "judge", label: "Judge", available: true },
      { id: "scenario", label: "Scenario", available: true },
    ];
    if (!tabDefs.find((t) => t.id === this.tab)?.available) this.tab = "transcript";
    for (const t of tabDefs) {
      const b = el("button", "evc-tab") as HTMLButtonElement;
      b.type = "button";
      b.textContent = t.label;
      b.disabled = !t.available;
      b.classList.toggle("is-selected", this.tab === t.id);
      b.addEventListener("click", () => { this.tab = t.id; this.render(); });
      tabs.appendChild(b);
    }
    host.appendChild(tabs);

    const body = el("div", "evc-detail-body");
    if (this.tab === "transcript") {
      body.appendChild(this.markdownBlock(d.transcript || "(empty transcript)"));
    } else if (this.tab === "baseline") {
      body.appendChild(this.markdownBlock(d.baseline_transcript ?? ""));
    } else if (this.tab === "judge") {
      body.appendChild(textBlock("Rubric", d.rubric));
      body.appendChild(textBlock("Judge reason", d.reason));
    } else {
      body.appendChild(textBlock("Scenario", d.scenario));
    }
    host.appendChild(body);

    const verdict = el("div", "evc-verdict");
    const v = el("span", d.pass ? "evc-verdict-pass" : "evc-verdict-fail");
    v.textContent = d.pass ? "Pass" : "Fail"; // uppercased via CSS
    verdict.appendChild(v);
    const bits: string[] = [];
    bits.push(d.baseline_pass === null ? "no baseline" : `baseline ${d.baseline_pass ? "pass" : "fail"}`);
    bits.push(`${Math.round(d.duration_ms / 1000)}s`);
    if (d.executor_model) bits.push(`agent ${d.executor_model}`);
    if (d.judge_model) bits.push(`judge ${d.judge_model}`);
    bits.push(new Date(d.ran_at_ms).toLocaleString());
    const meta = el("span", "evc-verdict-meta");
    meta.textContent = bits.join(" · ");
    verdict.appendChild(meta);
    host.appendChild(verdict);
  }

  /** Tessl-style criteria breakdown — one row per rubric criterion, then a
   *  Total/Baseline/Lift summary. Only rendered when `scoreSummary` finds
   *  weighted-criteria data; legacy details never reach this. */
  private criteriaBlock(
    d: CanonEvalRunDetail,
    summary: { pct: number; basePct: number | null; lift: number | null },
  ): HTMLElement {
    const wrap = el("div", "evc-score-summary");
    for (const c of d.criteria) {
      const row = el("div", "evc-crit-row");
      const dot = el("span", `evc-dot ${c.pass ? "is-pass" : "is-fail"}`);
      const id = el("span", "evc-crit-id");
      id.textContent = c.id;
      const reason = el("span", "evc-crit-reason");
      reason.textContent = c.reason;
      const points = el("span", "evc-crit-points");
      points.textContent = `${c.pass ? c.points : 0}/${c.points}`;
      row.append(dot, id, reason, points);
      wrap.appendChild(row);
      // Attach only when the reason actually overflows its column — a live
      // DOM read (forces layout), harmless since this row is already mounted.
      requestAnimationFrame(() => {
        if (reason.scrollWidth > reason.clientWidth) attachTooltip(reason, c.reason);
      });
    }

    const sep = el("div", "evc-crit-sep");
    wrap.appendChild(sep);

    const total = el("div", "evc-crit-row evc-crit-summary-row");
    const totalLabel = el("span", "evc-crit-summary-label");
    totalLabel.textContent = "Total";
    const totalPoints = el("span", "evc-crit-points");
    totalPoints.textContent = `${d.score}/${d.max_score} (${summary.pct}%)`;
    total.append(totalLabel, totalPoints);
    wrap.appendChild(total);

    const baseline = el("div", "evc-crit-row evc-crit-summary-row");
    const baselineLabel = el("span", "evc-crit-summary-label");
    baselineLabel.textContent = "Baseline";
    const baselinePoints = el("span", "evc-crit-points");
    baselinePoints.textContent = d.baseline_score == null || summary.basePct == null
      ? "— not measured"
      : `${d.baseline_score}/${d.max_score} (${summary.basePct}%)`;
    baseline.append(baselineLabel, baselinePoints);
    wrap.appendChild(baseline);

    const lift = el("div", "evc-crit-row evc-crit-summary-row");
    const liftLabel = el("span", "evc-crit-summary-label");
    liftLabel.textContent = "Lift";
    const liftValue = el("span", "evc-crit-points");
    if (summary.lift == null) {
      liftValue.textContent = "—";
    } else {
      liftValue.textContent = `${summary.lift > 0 ? "+" : ""}${summary.lift}%`;
      if (summary.lift > 0) liftValue.classList.add("is-pass");
      else if (summary.lift < 0) liftValue.classList.add("is-fail");
    }
    lift.append(liftLabel, liftValue);
    wrap.appendChild(lift);

    return wrap;
  }

  /** Transcript body with a Preview (rendered markdown) / Source (raw) toggle. */
  private markdownBlock(text: string): HTMLElement {
    const wrap = el("div", "evc-md-wrap");
    const bar = el("div", "evc-md-bar");
    for (const v of ["preview", "source"] as const) {
      const b = el("button", "evc-md-mode") as HTMLButtonElement;
      b.type = "button";
      b.textContent = v === "preview" ? "Preview" : "Source";
      b.classList.toggle("is-selected", this.mdView === v);
      b.addEventListener("click", () => { this.mdView = v; this.render(); });
      bar.appendChild(b);
    }
    wrap.appendChild(bar);
    if (this.mdView === "preview") {
      const doc = el("article", "evc-md markdown-body markdown-doc");
      doc.innerHTML = renderMarkdown(text);
      wrap.appendChild(doc);
    } else {
      wrap.appendChild(pre(text));
    }
    return wrap;
  }
}

// --- tiny DOM helpers -------------------------------------------------------

function el(tag: string, className: string): HTMLElement {
  const e = document.createElement(tag);
  if (className) e.className = className;
  return e;
}

function section(label: string): HTMLElement {
  const s = el("div", "evc-section");
  s.textContent = label;
  return s;
}

function pre(text: string): HTMLElement {
  const p = el("pre", "evc-pre");
  p.textContent = text;
  return p;
}

function textBlock(caption: string, text: string): HTMLElement {
  const wrap = el("div", "evc-text-block");
  const cap = el("div", "evc-text-cap");
  cap.textContent = caption;
  const val = el("div", "evc-text-val");
  val.textContent = text;
  wrap.append(cap, val);
  return wrap;
}
