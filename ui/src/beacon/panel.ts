import { openUrl } from "@tauri-apps/plugin-opener";
import {
  beaconWorkflowRuns,
  beaconRerunWorkflow,
  beaconCancelWorkflow,
  beaconRunJobs,
  type BeaconState,
  type BeaconJob,
} from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";

const POLL_MS = 25_000;

/// Returns true only for absolute http: or https: URLs.
export function isHttpUrl(u: string | null | undefined): u is string {
  if (!u) return false;
  try {
    const parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/// Map a GitHub Actions run state to a dot color class suffix.
export function stateDotColor(state: string): string {
  switch (state) {
    case "success":
      return "ok";
    case "in_progress":
    case "queued":
    case "requested":
    case "waiting":
    case "pending":
      return "busy";
    case "failure":
    case "timed_out":
    case "startup_failure":
    case "error":
      return "bad";
    default:
      return "idle"; // cancelled, skipped, neutral, action_required, stale, unknown
  }
}

/// Map a run state to a rail-row `data-spine` value (ok|run|fail|idle).
export function stateSpine(state: string): string {
  switch (stateDotColor(state)) {
    case "ok":
      return "ok";
    case "busy":
      return "run";
    case "bad":
      return "fail";
    default:
      return "idle";
  }
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/// "41s" / "3m10s" / "1h5m". Open-ended spans (running) measure to `now`.
export function fmtDuration(startIso: string | null, endIso: string | null, now = Date.now()): string {
  if (!startIso) return "";
  const start = Date.parse(startIso);
  if (Number.isNaN(start)) return "";
  const end = endIso ? Date.parse(endIso) : now;
  if (Number.isNaN(end)) return "";
  const s = Math.max(0, Math.round((end - start) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

export type RunDetailState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "jobs"; jobs: BeaconJob[] };

export type RunDetail = {
  expanded: ReadonlySet<number>;
  jobs: ReadonlyMap<number, RunDetailState>;
  onToggle: (runId: number) => void;
};

/// Jobs/steps detail block appended under an expanded run row.
function renderJobs(state: RunDetailState): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "rail-jobs";
  if (state.kind === "loading") {
    const el = document.createElement("div");
    el.className = "rail-jobs-loading";
    el.textContent = "Loading jobs…";
    wrap.append(el);
    return wrap;
  }
  if (state.kind === "error") {
    const el = document.createElement("div");
    el.className = "rail-jobs-error";
    el.textContent = state.message.replace(/^github:\s*/i, "");
    wrap.append(el);
    return wrap;
  }
  for (const job of state.jobs) {
    const line = document.createElement("div");
    line.className = "rail-job-line";
    const dot = document.createElement("span");
    dot.className = `rail-dot is-${stateSpine(job.state)}`;
    const name = document.createElement("span");
    name.className = "rail-job-name";
    name.textContent = job.name;
    const dur = document.createElement("span");
    dur.className = "rail-job-dur";
    dur.textContent = fmtDuration(job.started_at, job.completed_at);
    line.append(dot, name, dur);
    wrap.append(line);
    if (job.steps.length) {
      const steps = document.createElement("div");
      steps.className = "rail-steps";
      for (const step of job.steps) {
        const row = document.createElement("div");
        row.className = "rail-step";
        const sdot = document.createElement("span");
        sdot.className = `rail-dot is-${stateSpine(step.state)}`;
        const sname = document.createElement("span");
        sname.className = "rail-step-name";
        sname.textContent = step.name;
        const sdur = document.createElement("span");
        sdur.className = "rail-step-dur";
        sdur.textContent = fmtDuration(step.started_at, step.completed_at);
        row.append(sdot, sname, sdur);
        steps.append(row);
      }
      wrap.append(steps);
    }
  }
  return wrap;
}

function notice(text: string, cls = ""): HTMLElement {
  const el = document.createElement("div");
  el.className = `rail-notice ${cls}`.trim();
  el.textContent = text;
  return el;
}

/// Centered empty state for repos with no Actions workflows.
function emptyState(title: string, hint: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "rail-empty";
  el.innerHTML =
    Icons.radioTower({ size: 28 }) +
    `<div class="rail-empty-title"></div>` +
    `<div class="rail-empty-hint"></div>`;
  el.querySelector(".rail-empty-title")!.textContent = title;
  el.querySelector(".rail-empty-hint")!.textContent = hint;
  return el;
}

/// Structured, actionable error state. Backend messages are shaped
/// "github: <cause> — <remedy>" (beacon.rs) — split on " — " into
/// title/hint, then offer Reconnect (auth errors) or Retry (transient).
function errorState(
  message: string,
  actions?: { onRetry?: () => void; onReconnect?: () => void },
): HTMLElement {
  const clean = message.replace(/^github:\s*/i, "");
  const dash = clean.indexOf(" — ");
  const title = dash === -1 ? clean : clean.slice(0, dash);
  const hint = dash === -1 ? "" : clean.slice(dash + 3);
  const needsAuth = /token (invalid|expired)|reconnect/i.test(message);

  const el = document.createElement("div");
  el.className = "rail-empty is-error";
  el.innerHTML =
    Icons.alertTriangle({ size: 28 }) +
    `<div class="rail-empty-title"></div>` +
    `<div class="rail-empty-hint"></div>`;
  el.querySelector(".rail-empty-title")!.textContent = title;
  el.querySelector(".rail-empty-hint")!.textContent = hint;

  const act = document.createElement("div");
  act.className = "rail-empty-actions";
  if (needsAuth && actions?.onReconnect) {
    const b = document.createElement("button");
    b.className = "rail-empty-btn";
    b.textContent = "Reconnect GitHub";
    b.addEventListener("click", actions.onReconnect);
    act.append(b);
  }
  if (actions?.onRetry) {
    const b = document.createElement("button");
    b.className = "rail-empty-btn";
    b.textContent = "Retry";
    b.addEventListener("click", actions.onRetry);
    act.append(b);
  }
  if (act.childElementCount) el.append(act);
  return el;
}

/// Loading placeholder — shown only on the first fetch (empty body) so the
/// 25s poll doesn't blank existing cards on every refresh.
export function renderLoading(root: HTMLElement): void {
  root.replaceChildren(notice("Loading workflows", "is-loading"));
}

/// Pure render of a state into `root`. No fetching, no polling.
/// `onPick(path)` is invoked when the user selects a sub-repo (`repos` state).
export function renderBeacon(
  root: HTMLElement,
  state: BeaconState,
  onPick?: (path: string) => void,
  errorActions?: { onRetry?: () => void; onReconnect?: () => void },
  runActions?: { onRerun?: (runId: number) => void; onCancel?: (runId: number) => void },
  detail?: RunDetail,
): void {
  root.replaceChildren();
  switch (state.kind) {
    case "not_authed":
      root.appendChild(notice("Sign in with GitHub to see workflows."));
      return;
    case "no_repo":
      root.appendChild(notice("No GitHub remote in this folder."));
      return;
    case "repos": {
      root.appendChild(
        notice(
          `No remote here — ${state.dirs.length} sub-repo${state.dirs.length === 1 ? "" : "s"} found. Pick one:`,
        ),
      );
      for (const dir of state.dirs) {
        const row = document.createElement("div");
        row.className = "rail-row";
        row.setAttribute("data-spine", "idle");
        row.setAttribute("role", "button");
        row.setAttribute("tabindex", "0");
        const line = document.createElement("div");
        line.className = "rail-row-line";
        const name = document.createElement("span");
        name.className = "rail-name";
        name.textContent = dir.repo;
        line.append(name);
        row.append(line);
        const open = () => onPick?.(dir.path);
        row.addEventListener("click", open);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") open();
        });
        root.appendChild(row);
      }
      return;
    }
    case "error":
      root.appendChild(errorState(state.message, errorActions));
      return;
    case "ok": {
      if (state.runs.length === 0) {
        root.appendChild(
          emptyState(
            "No workflows yet",
            `${state.repo} has no GitHub Actions. Add a workflow under .github/workflows to light up Beacon.`,
          ),
        );
        return;
      }
      for (const run of state.runs) {
        const clickable = isHttpUrl(run.url);
        const expanded = !!detail && detail.expanded.has(run.id);
        const row = document.createElement("div");
        row.className = "rail-row";
        row.setAttribute("data-spine", stateSpine(run.state));

        const line = document.createElement("div");
        line.className = "rail-row-line";
        if (detail) {
          const chev = document.createElement("span");
          chev.className = `rail-chev${expanded ? " is-open" : ""}`;
          chev.innerHTML = Icons.chevronRight({ size: 12 });
          line.append(chev);
        }
        const name = document.createElement("span");
        name.className = "rail-name";
        name.textContent = run.name || "(workflow)";
        const when = document.createElement("span");
        when.className = "rail-when";
        when.textContent = relTime(run.updated_at);
        line.append(name, when);

        const meta = document.createElement("div");
        meta.className = "rail-meta";
        const runLabel = run.run_number ? `#${run.run_number}` : "";
        const bits = [
          run.state.replace(/_/g, " "),
          runLabel,
          run.branch,
          run.sha,
          run.actor,
        ].filter(Boolean) as string[];
        meta.textContent = bits.join(" · ");
        row.append(line, meta);

        // Row interaction: expand/collapse when detail is wired; otherwise
        // (legacy callers without detail) fall back to opening the URL.
        const openRun = () =>
          void openUrl(run.url!).catch((e) => console.error("beacon openUrl failed", e));
        if (detail && run.id) {
          row.setAttribute("role", "button");
          row.setAttribute("tabindex", "0");
          row.setAttribute("aria-expanded", String(expanded));
          row.addEventListener("click", () => detail.onToggle(run.id));
          row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") detail.onToggle(run.id);
          });
        } else if (clickable) {
          row.setAttribute("role", "link");
          row.setAttribute("tabindex", "0");
          row.addEventListener("click", openRun);
          row.addEventListener("keydown", (e) => {
            if (e.key === "Enter" || e.key === " ") openRun();
          });
        } else {
          // Non-interactive row: don't imply it's clickable.
          row.style.cursor = "default";
        }

        // Action cluster: ↗ open-on-GitHub + re-run/cancel.
        const actions = document.createElement("div");
        actions.className = "rail-row-actions";
        if (clickable) {
          const openBtn = document.createElement("button");
          openBtn.type = "button";
          // is-neutral: bare .rail-row-action hovers danger-red (cancel/rerun);
          // opening GitHub is benign navigation.
          openBtn.className = "rail-row-action is-neutral";
          openBtn.setAttribute("aria-label", "Open on GitHub");
          openBtn.innerHTML = Icons.externalLink({ size: 13 });
          attachTooltip(openBtn, "Open on GitHub");
          openBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            openRun();
          });
          actions.append(openBtn);
        }
        if (runActions && run.id) {
          const busy = stateDotColor(run.state) === "busy";
          const action = document.createElement("button");
          action.type = "button";
          action.className = "rail-row-action";
          if (busy) {
            action.setAttribute("aria-label", "Cancel run");
            action.innerHTML = Icons.ban({ size: 13 });
            attachTooltip(action, "Cancel run");
            action.addEventListener("click", (e) => {
              e.stopPropagation();
              runActions.onCancel?.(run.id);
            });
          } else {
            action.setAttribute("aria-label", "Re-run workflow");
            action.innerHTML = Icons.refresh({ size: 13 });
            attachTooltip(action, "Re-run workflow");
            action.addEventListener("click", (e) => {
              e.stopPropagation();
              runActions.onRerun?.(run.id);
            });
          }
          actions.append(action);
        }
        if (actions.childElementCount) row.appendChild(actions);

        root.appendChild(row);
        if (expanded) {
          root.appendChild(renderJobs(detail!.jobs.get(run.id) ?? { kind: "loading" }));
        }
      }
      return;
    }
  }
}

export class BeaconPanel {
  private root: HTMLElement;
  private timer: number | null = null;
  private generation = 0;
  private body: HTMLElement;
  /// Sub-repo the user drilled into (overrides cwd), and the cwd it was
  /// chosen under — if cwd changes (tab switch / cd), the drill-down resets.
  private selectedPath: string | null = null;
  private baseCwd: string | null = null;
  /// Run-detail expansion state — survives the 25s poll re-render.
  private expanded = new Set<number>();
  private jobsCache = new Map<number, RunDetailState>();
  private jobsInflight = new Set<number>();
  private lastState: BeaconState | null = null;

  constructor(
    host: HTMLElement,
    private opts: {
      getCwd: () => string | null;
      onClose: () => void;
      onReconnect?: () => void;
      /// Fired after every successful poll — feeds the titlebar indicator.
      onState?: (state: BeaconState) => void;
    },
  ) {
    this.root = document.createElement("div");
    this.root.className = "rail-panel";

    const header = document.createElement("div");
    header.className = "rail-header";

    const titleWrap = document.createElement("div");
    titleWrap.className = "rail-title";
    const dot = document.createElement("span");
    dot.className = "rail-dot is-ok";
    const label = document.createElement("span");
    label.className = "rail-title-label";
    label.textContent = "Beacon";
    titleWrap.append(dot, label);

    const actions = document.createElement("div");
    actions.className = "rail-actions";
    const refresh = document.createElement("button");
    refresh.className = "rail-btn";
    refresh.setAttribute("aria-label", "Refresh");
    refresh.innerHTML = Icons.refresh({ size: 15 });
    refresh.addEventListener("click", () => this.render());
    attachTooltip(refresh, "Refresh");
    const close = document.createElement("button");
    close.className = "rail-btn";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = Icons.x({ size: 15 });
    close.addEventListener("click", () => this.opts.onClose());
    attachTooltip(close, "Close");
    actions.append(refresh, close);

    header.append(titleWrap, actions);

    this.body = document.createElement("div");
    this.body.className = "rail-body";

    this.root.append(header, this.body);
    host.replaceChildren(this.root);
  }

  /// Fetch once and (re)start the visible-only poll loop.
  render(): void {
    void this.fetch();
    this.stopTimer();
    this.timer = window.setInterval(() => void this.fetch(), POLL_MS);
  }

  private async fetch(): Promise<void> {
    const gen = ++this.generation;
    const base = this.opts.getCwd();
    // cwd moved → drop any sub-repo drill-down and run-detail state.
    if (base !== this.baseCwd) {
      this.baseCwd = base;
      this.selectedPath = null;
      this.expanded.clear();
      this.jobsCache.clear();
    }
    const cwd = this.selectedPath ?? base;
    if (!cwd) {
      renderBeacon(this.body, { kind: "no_repo" });
      return;
    }
    if (this.body.childElementCount === 0) renderLoading(this.body);
    try {
      const state = await beaconWorkflowRuns(cwd);
      if (gen !== this.generation) return; // superseded
      this.lastState = state;
      this.opts.onState?.(state);
      if (state.kind === "ok") {
        // Drop expansion state for runs that no longer exist.
        const ids = new Set(state.runs.map((r) => r.id));
        for (const id of [...this.expanded]) if (!ids.has(id)) this.expanded.delete(id);
        for (const id of [...this.jobsCache.keys()]) if (!ids.has(id)) this.jobsCache.delete(id);
        // Live-refresh jobs for expanded, still-running runs on each poll.
        for (const r of state.runs) {
          if (this.expanded.has(r.id) && stateDotColor(r.state) === "busy") {
            void this.refreshJobs(r.id);
          }
        }
      }
      this.renderState(state);
    } catch (e) {
      if (gen !== this.generation) return;
      // Feed the indicator too — while the panel is open its own poll is
      // paused, and a silent error path would freeze a stale busy/fail icon.
      this.opts.onState?.({ kind: "error", message: String(e) });
      renderBeacon(this.body, { kind: "error", message: String(e) }, undefined, {
        onRetry: () => this.render(),
        onReconnect: this.opts.onReconnect,
      });
      if (this.selectedPath) this.prependBack();
    }
  }

  /// Render `state` with all callbacks + run-detail wiring. Reused by the
  /// poll (fetch) and by local expansion toggles/job refreshes.
  private renderState(state: BeaconState): void {
    const cwd = this.selectedPath ?? this.baseCwd;
    renderBeacon(
      this.body,
      state,
      (path) => {
        this.selectedPath = path;
        void this.fetch();
      },
      { onRetry: () => this.render(), onReconnect: this.opts.onReconnect },
      {
        onRerun: (runId) => {
          if (!cwd) return;
          void this.runAction(() => beaconRerunWorkflow(cwd, runId));
        },
        onCancel: (runId) => {
          if (!cwd) return;
          if (!confirm("Cancel this workflow run?")) return;
          void this.runAction(() => beaconCancelWorkflow(cwd, runId));
        },
      },
      {
        expanded: this.expanded,
        jobs: this.jobsCache,
        onToggle: (runId) => this.toggleRun(runId),
      },
    );
    if (this.selectedPath) this.prependBack();
  }

  private toggleRun(runId: number): void {
    if (this.expanded.has(runId)) {
      this.expanded.delete(runId);
    } else {
      this.expanded.add(runId);
      if (!this.jobsCache.has(runId)) this.jobsCache.set(runId, { kind: "loading" });
      void this.refreshJobs(runId);
    }
    if (this.lastState) this.renderState(this.lastState);
  }

  private async refreshJobs(runId: number): Promise<void> {
    const cwd = this.selectedPath ?? this.baseCwd;
    if (!cwd) return;
    // No generation guard here: the poll bumps generation every 25s, which
    // would drop a manual expand's in-flight result and strand the row on
    // "Loading jobs…" (non-busy runs are never re-fetched). Staleness is
    // handled by `expanded` membership — cwd changes clear it.
    if (this.jobsInflight.has(runId)) return;
    this.jobsInflight.add(runId);
    try {
      const jobs = await beaconRunJobs(cwd, runId);
      if (!this.expanded.has(runId)) return;
      this.jobsCache.set(runId, { kind: "jobs", jobs });
    } catch (e) {
      if (!this.expanded.has(runId)) return;
      this.jobsCache.set(runId, { kind: "error", message: String(e) });
    } finally {
      this.jobsInflight.delete(runId);
    }
    if (this.lastState) this.renderState(this.lastState);
  }

  /// Rerun/cancel a run, then refresh the list. On failure, surface the
  /// error inline instead of leaving the button silently dead.
  private async runAction(action: () => Promise<void>): Promise<void> {
    try {
      await action();
      void this.fetch();
    } catch (e) {
      renderBeacon(this.body, { kind: "error", message: String(e) }, undefined, {
        onRetry: () => this.render(),
        onReconnect: this.opts.onReconnect,
      });
    }
  }

  /// "← all repos" sub-stream shown while drilled into a sub-repo.
  private prependBack(): void {
    const bar = document.createElement("div");
    bar.className = "rail-substream";
    const label = document.createElement("span");
    label.textContent = "sub-repo";
    const back = document.createElement("button");
    back.textContent = "← all repos";
    back.addEventListener("click", () => {
      this.selectedPath = null;
      void this.fetch();
    });
    bar.append(label, back);
    this.body.prepend(bar);
  }

  private stopTimer(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
  }

  /// Stop polling. Called when the panel is hidden.
  close(): void {
    this.stopTimer();
    this.generation++; // drop any in-flight fetch
  }
}
