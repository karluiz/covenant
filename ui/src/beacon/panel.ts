import { openUrl } from "@tauri-apps/plugin-opener";
import {
  beaconWorkflowRuns,
  beaconRerunWorkflow,
  beaconCancelWorkflow,
  beaconRunJobs,
  type BeaconState,
  type BeaconJob,
  type BeaconStep,
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
  return fmtSeconds(Math.max(0, Math.round((end - start) / 1000)));
}

/// GitHub ceremony detection for the fold heuristic. Setup ceremony only
/// counts as a LEADING run (a mid-workflow "Run actions/…" is real work);
/// post ceremony only as a TRAILING run.
const isSetupStep = (n: string) => n.startsWith("Set up ") || n.startsWith("Run actions/");
const isPostStep = (n: string) => n.startsWith("Post ") || n === "Complete job";

export type StepGroups = {
  setup: BeaconStep[];
  work: BeaconStep[];
  post: BeaconStep[];
  /// A group containing a failed step must render inline — failures never hide.
  setupFoldable: boolean;
  postFoldable: boolean;
};

/// Split a job's steps into ceremony (setup/post) and signal (work).
export function groupSteps(steps: BeaconStep[]): StepGroups {
  let i = 0;
  while (i < steps.length && isSetupStep(steps[i].name)) i++;
  let j = steps.length;
  while (j > i && isPostStep(steps[j - 1].name)) j--;
  const setup = steps.slice(0, i);
  const work = steps.slice(i, j);
  const post = steps.slice(j);
  const clean = (arr: BeaconStep[]) =>
    arr.length > 0 && !arr.some((s) => stateDotColor(s.state) === "bad");
  return { setup, work, post, setupFoldable: clean(setup), postFoldable: clean(post) };
}

/// Failed runs the panel should auto-expand (once per run id per session) so
/// a red beacon click lands directly on the wound.
export function failedRunsToOpen(
  runs: { id: number; state: string }[],
  alreadyOpened: ReadonlySet<number>,
): number[] {
  return runs
    .filter((r) => r.id && stateDotColor(r.state) === "bad" && !alreadyOpened.has(r.id))
    .map((r) => r.id);
}

export type RunDetailState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "jobs"; jobs: BeaconJob[] };

export type RunDetail = {
  expanded: ReadonlySet<number>;
  jobs: ReadonlyMap<number, RunDetailState>;
  /// Open ceremony folds, keyed "runId:jobId:setup|post".
  folds: ReadonlySet<string>;
  onToggle: (runId: number) => void;
  onToggleFold: (key: string) => void;
};

/// Visual mode of one step. "busy"-colored states split: only a genuinely
/// running step is "now"; queued/waiting/pending are "pend" (hollow, dim).
function stepMode(step: BeaconStep): "ok" | "fail" | "now" | "pend" | "idle" {
  const c = stateDotColor(step.state);
  if (c === "bad") return "fail";
  if (step.state === "in_progress") return "now";
  if (c === "busy") return "pend";
  return c === "ok" ? "ok" : "idle";
}

function stepGlyph(mode: ReturnType<typeof stepMode>): HTMLElement {
  const g = document.createElement("span");
  g.className = "rail-glyph";
  switch (mode) {
    case "ok":
      g.innerHTML = `<span class="rail-sg is-ok">✓</span>`;
      break;
    case "fail":
      g.innerHTML = `<span class="rail-sg is-fail">✕</span>`;
      break;
    case "now":
      g.innerHTML = `<span class="rail-dot is-run rail-pulse"></span>`;
      break;
    default:
      g.innerHTML = `<span class="rail-ring"></span>`;
  }
  return g;
}

function sumSeconds(steps: BeaconStep[]): number {
  let t = 0;
  for (const s of steps) {
    if (!s.started_at || !s.completed_at) continue;
    const a = Date.parse(s.started_at);
    const b = Date.parse(s.completed_at);
    if (!Number.isNaN(a) && !Number.isNaN(b)) t += Math.max(0, (b - a) / 1000);
  }
  return Math.round(t);
}

function fmtSeconds(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? `${s % 60}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? `${m % 60}m` : ""}`;
}

function renderStep(step: BeaconStep): HTMLElement {
  const mode = stepMode(step);
  const row = document.createElement("div");
  row.className = "rail-step";
  if (mode === "now") row.classList.add("is-now");
  if (mode === "fail") row.classList.add("is-fail-step");
  if (mode === "pend" || mode === "idle") row.classList.add("is-pend");
  const name = document.createElement("span");
  name.className = "rail-step-name";
  name.textContent = step.name;
  const dur = document.createElement("span");
  dur.className = "rail-step-dur";
  const d = step.started_at ? fmtDuration(step.started_at, step.completed_at) : "";
  dur.textContent = d || "—";
  if (mode === "now") dur.classList.add("is-live");
  row.append(stepGlyph(mode), name, dur);
  return row;
}

/// One dim summary row for a ceremony group (setup/post); click unfolds.
function renderFold(
  key: string,
  kind: "setup" | "post",
  steps: BeaconStep[],
  open: boolean,
  onToggle: (key: string) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "rail-fold";
  row.setAttribute("role", "button");
  row.setAttribute("tabindex", "0");
  row.setAttribute("aria-expanded", String(open));
  const glyph = document.createElement("span");
  glyph.className = "rail-glyph rail-fold-chev";
  glyph.textContent = open ? "▾" : "▸";
  const name = document.createElement("span");
  name.className = "rail-fold-name";
  name.textContent = `${kind} · ${steps.length} step${steps.length === 1 ? "" : "s"}`;
  const dur = document.createElement("span");
  dur.className = "rail-step-dur";
  const total = sumSeconds(steps);
  dur.textContent = total > 0 ? fmtSeconds(total) : "—";
  row.append(glyph, name, dur);
  const toggle = (e: Event) => {
    e.stopPropagation();
    onToggle(key);
  };
  row.addEventListener("click", toggle);
  row.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") toggle(e);
  });
  return row;
}

/// Jobs/steps detail block appended under an expanded run row: job header
/// with done-counter + progress bar, then the step taxonomy with ceremony
/// folds (setup/post) collapsed by default.
function renderJobs(runId: number, state: RunDetailState, detail: RunDetail): HTMLElement {
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
    const spine = stateSpine(job.state);
    const head = document.createElement("div");
    head.className = "rail-job-head";
    const glyph = document.createElement("span");
    glyph.className = "rail-glyph";
    glyph.innerHTML = `<span class="rail-dot is-${spine}${spine === "run" ? " rail-pulse" : ""}"></span>`;
    const name = document.createElement("span");
    name.className = "rail-job-name";
    name.textContent = job.name;
    const count = document.createElement("span");
    count.className = "rail-job-count";
    const done = job.steps.filter((s) => s.completed_at != null).length;
    count.textContent = job.steps.length ? `${done}/${job.steps.length}` : "";
    const dur = document.createElement("span");
    dur.className = "rail-job-dur";
    dur.textContent = fmtDuration(job.started_at, job.completed_at);
    if (spine === "run") dur.classList.add("is-live");
    head.append(glyph, name, count, dur);
    wrap.append(head);

    if (job.steps.length) {
      const bar = document.createElement("div");
      bar.className = `rail-job-bar${spine === "ok" ? " is-done" : spine === "fail" ? " is-fail" : ""}`;
      const fill = document.createElement("i");
      fill.style.width = `${Math.round((done / job.steps.length) * 100)}%`;
      bar.append(fill);
      wrap.append(bar);

      const g = groupSteps(job.steps);
      const emit = (kind: "setup" | "post", steps: BeaconStep[], foldable: boolean) => {
        if (!steps.length) return;
        if (!foldable) {
          for (const s of steps) wrap.append(renderStep(s));
          return;
        }
        const key = `${runId}:${job.id}:${kind}`;
        const open = detail.folds.has(key);
        wrap.append(renderFold(key, kind, steps, open, detail.onToggleFold));
        if (open) for (const s of steps) wrap.append(renderStep(s));
      };
      emit("setup", g.setup, g.setupFoldable);
      for (const s of g.work) wrap.append(renderStep(s));
      emit("post", g.post, g.postFoldable);
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

        // Meta strip: state pill + fixed slots on ONE line — the actor is
        // the only flexible slot, so it truncates first instead of wrapping.
        const meta = document.createElement("div");
        meta.className = "rail-meta is-strip";
        const dotColor = stateDotColor(run.state);
        const pill = document.createElement("span");
        pill.className = `rail-pill is-${
          dotColor === "busy" ? "busy" : dotColor === "bad" ? "fail" : dotColor === "ok" ? "ok" : "idle"
        }`;
        pill.textContent = run.state.replace(/_/g, " ");
        meta.append(pill);
        const addBit = (text: string, cls = ""): void => {
          const sep = document.createElement("span");
          sep.className = "rail-meta-sep";
          sep.textContent = "·";
          const bit = document.createElement("span");
          bit.className = `rail-meta-bit${cls ? ` ${cls}` : ""}`;
          bit.textContent = text;
          if (meta.childElementCount > 1) meta.append(sep);
          meta.append(bit);
        };
        if (run.run_number) addBit(`#${run.run_number}`);
        if (run.branch) addBit(run.branch, "is-ref");
        if (run.sha) addBit(run.sha);
        if (run.actor) addBit(run.actor, "is-actor");
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
          root.appendChild(
            renderJobs(run.id, detail!.jobs.get(run.id) ?? { kind: "loading" }, detail!),
          );
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
  /// Open ceremony folds ("runId:jobId:setup|post").
  private folds = new Set<string>();
  /// Failed runs already auto-expanded this session — user collapse wins after.
  private autoOpenedFails = new Set<number>();
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
      this.folds.clear();
      this.autoOpenedFails.clear();
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
        for (const key of [...this.folds]) {
          if (!ids.has(Number(key.split(":")[0]))) this.folds.delete(key);
        }
        // A newly-failed run auto-expands once, landing the user on the wound.
        for (const id of failedRunsToOpen(state.runs, this.autoOpenedFails)) {
          this.autoOpenedFails.add(id);
          if (!this.expanded.has(id)) {
            this.expanded.add(id);
            if (!this.jobsCache.has(id)) this.jobsCache.set(id, { kind: "loading" });
            void this.refreshJobs(id);
          }
        }
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
        folds: this.folds,
        onToggle: (runId) => this.toggleRun(runId),
        onToggleFold: (key) => {
          if (this.folds.has(key)) this.folds.delete(key);
          else this.folds.add(key);
          if (this.lastState) this.renderState(this.lastState);
        },
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
