// Autonomous Operator Mode banner — appears at the bottom of the
// workspace whenever AOM is active. Persistent (no auto-dismiss),
// shows started time + decision counter, has a Stop button.
//
// The banner is the user's "the Operator is driving right now"
// reassurance signal. Without it, AOM would feel invisible — too
// risky for a mode that types into PTYs autonomously.

import {
  aomStart,
  aomStatus,
  aomStop,
  operatorPhaseOverview,
  type AomStatus,
  type OperatorPhase,
  type OperatorPhaseSnapshot,
} from "../api";
import { Icons } from "../icons";

const POLL_MS = 5_000;
/// Liveness poll cadence. The badge must never look frozen for more
/// than ~2s while AOM is active; 1s gives us a sub-2s worst case
/// staleness even if a tick lands just before the previous render.
const PHASE_POLL_MS = 1_000;

/// Listener for AOM TRANSITIONS (off→on, on→off, budget-hit).
/// `TabManager.refreshAllOperatorState()` uses this to refresh per-tab
/// bot badges; expensive-to-recompute consumers go here.
export type AomChangeListener = (next: AomStatus) => void;

/// Listener for EVERY status update (transitions + every 5s poll tick).
/// Used by the status-bar chip to keep the live cost / duration display
/// in sync without each consumer running its own poll timer.
export type AomUpdateListener = (next: AomStatus) => void;

export class AomBanner {
  private root: HTMLElement;
  private timeEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private costEl: HTMLElement | null = null;
  private onEnterAfk: (() => void) | null = null;
  /// When true, the banner stops painting its own floating pill. The
  /// instance still polls, fires events, and serves as the source of
  /// truth for AOM state — but rendering is delegated to whoever
  /// subscribes via `onUpdate` (currently the status-bar chip).
  private headless = false;
  private status: AomStatus = {
    enabled: false,
    started_at_unix_ms: 0,
    decisions_count: 0,
    budget_usd: 0,
    accumulated_cost_usd: 0,
    cost_cap_hit_at_unix_ms: null,
  };
  private poll: number | null = null;
  /// Liveness ticker — separate from the 5s status poll because it
  /// runs at 1s cadence and re-paints the phase label / elapsed
  /// counter only. Cheap (single Tauri RPC + a few text updates).
  private phasePoll: number | null = null;
  private phase: OperatorPhaseSnapshot = {
    phase: "idle",
    since_unix_ms: 0,
  };
  private phaseLabelEl: HTMLElement | null = null;
  private listeners: AomChangeListener[] = [];
  private updateListeners: AomUpdateListener[] = [];

  constructor(private readonly mountHost: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "aom-banner";
    this.root.hidden = true;
    this.mountHost.appendChild(this.root);
  }

  /// Suppress the floating-pill rendering. State, polling and events
  /// keep working — for the status-bar chip era we want the data
  /// pipeline but not the visual.
  setHeadless(headless: boolean): void {
    this.headless = headless;
    if (headless) {
      this.root.hidden = true;
      this.root.innerHTML = "";
    }
  }

  /// Current cached status — synchronous, useful right after hydrate.
  getStatus(): AomStatus {
    return this.status;
  }

  /// Sync with the backend on boot. If AOM was already on (which can
  /// happen on a hot reload of the webview), we want to render the
  /// banner immediately rather than wait for the user's first toggle.
  async hydrate(): Promise<void> {
    try {
      const s = await aomStatus();
      this.apply(s);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("aom_status failed", err);
    }
  }

  isOn(): boolean {
    return this.status.enabled;
  }

  setEnterAfkHandler(fn: () => void): void {
    this.onEnterAfk = fn;
  }

  /// Subscribe to AOM state transitions (toggle on, toggle off,
  /// budget-hit auto-stop). Listener fires AFTER the backend command
  /// resolves, so callers can rely on backend state being settled.
  onChange(listener: AomChangeListener): void {
    this.listeners.push(listener);
  }

  /// Subscribe to EVERY status update — fires on transitions AND on
  /// every poll tick (~5s). Cheap consumers (rendering metrics) wire
  /// here; expensive ones (TabManager refresh) stay on `onChange`.
  onUpdate(listener: AomUpdateListener): void {
    this.updateListeners.push(listener);
  }

  private fireUpdate(): void {
    for (const l of this.updateListeners) {
      try {
        l(this.status);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error("aom update listener failed", err);
      }
    }
  }

  /// Re-fetch AOM status from the backend and re-apply (and notify
  /// listeners). Use when an external event might have changed AOM
  /// state — e.g. the budget-hit auto-stop emits an event the banner
  /// itself doesn't poll for between intervals.
  async syncFromBackend(): Promise<void> {
    try {
      const s = await aomStatus();
      this.apply(s);
    } catch {
      /* transient — next poll will retry */
    }
  }

  async toggle(): Promise<void> {
    try {
      const next = this.status.enabled ? await aomStop() : await aomStart();
      this.apply(next);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("aom toggle failed", err);
    }
  }

  private apply(s: AomStatus): void {
    const prevEnabled = this.status.enabled;
    this.status = s;
    if (s.enabled) {
      if (!this.headless) this.render();
      this.startPolling();
    } else {
      this.root.hidden = true;
      this.stopPolling();
    }
    // Notify only on transitions — listeners refresh expensive state
    // (per-tab Operator badges); spamming them on every poll tick
    // would be wasteful.
    if (prevEnabled !== s.enabled) {
      for (const l of this.listeners) l(s);
    }
    // Update listeners ALWAYS fire (cheap consumers like the status
    // bar chip live-display the cost / duration).
    this.fireUpdate();
  }

  private render(): void {
    // TODO(task-17): the AOM banner currently shows mode-level state
    // (phase + cost + decisions) but not the *Operator entity* driving
    // the active tab. If/when product wants the active operator's chip
    // here, render `renderOperatorChip(activeOperator, 'md')` to the
    // left of the icon. Today no `activeOperator` is plumbed in.
    this.root.hidden = false;
    // Liveness Task 3: the primary readout is now `phase + elapsed`
    // (e.g. "observing 4s", "deciding…"). Cost is no longer the
    // headline metric — it lives in the tooltip on the cost element
    // so a glance still reads "what is AOM doing right now?". The
    // decision count sticks around because it's a useful "is anything
    // happening at all" sanity check while a long Deciding stretches.
    this.root.innerHTML = `
      <span class="aom-banner-icon">${Icons.zap({ size: 14 })}</span>
      <span class="aom-banner-label">AOM</span>
      <span class="aom-banner-phase" aria-label="operator phase"></span>
      <span class="aom-banner-sep">·</span>
      <span class="aom-banner-time" aria-label="time elapsed"></span>
      <span class="aom-banner-sep">·</span>
      <span class="aom-banner-count" aria-label="decisions made"></span>
      <span class="aom-banner-sep">·</span>
      <span class="aom-banner-cost" aria-label="cost vs budget"></span>
      <button type="button" class="aom-banner-afk" title="Enter AFK mode (⌘⇧A)">
        AFK
      </button>
      <button type="button" class="aom-banner-stop" title="Stop AOM">
        Stop
      </button>
    `;
    this.phaseLabelEl = this.root.querySelector(".aom-banner-phase");
    this.timeEl = this.root.querySelector(".aom-banner-time");
    this.countEl = this.root.querySelector(".aom-banner-count");
    this.costEl = this.root.querySelector(".aom-banner-cost");
    this.root
      .querySelector<HTMLButtonElement>(".aom-banner-stop")!
      .addEventListener("click", () => {
        void this.toggle();
      });
    this.root
      .querySelector<HTMLButtonElement>(".aom-banner-afk")!
      .addEventListener("click", () => {
        if (this.onEnterAfk) this.onEnterAfk();
      });
    this.refreshDisplay();
  }

  private refreshDisplay(): void {
    if (this.timeEl && this.status.started_at_unix_ms > 0) {
      const elapsed = Date.now() - this.status.started_at_unix_ms;
      this.timeEl.textContent = formatElapsed(elapsed);
    }
    if (this.countEl) {
      const n = this.status.decisions_count;
      this.countEl.textContent = `${n} decision${n === 1 ? "" : "s"}`;
    }
    if (this.costEl) {
      // Liveness Task 3: cost is no longer the primary signal. The
      // text is a compact "$X.XXX" so it doesn't visually compete
      // with the phase readout; the full "spent / budget" string
      // lives in the tooltip for users who want the detail.
      const spent = this.status.accumulated_cost_usd;
      const cap = this.status.budget_usd;
      this.costEl.textContent = `$${spent.toFixed(3)}`;
      this.costEl.title = `$${spent.toFixed(3)} / $${cap.toFixed(2)} budget`;
      // Color the cost cell when getting close to budget — gives the
      // user a visual cue without an extra alert. Threshold 80%.
      const ratio = cap > 0 ? spent / cap : 0;
      this.costEl.classList.toggle("aom-banner-cost-warn", ratio >= 0.8);
    }
    this.refreshPhaseDisplay();
  }

  /// Repaint the phase label using the most recent overview snapshot.
  /// Split out from `refreshDisplay` so the 1s phase ticker can update
  /// without re-rendering cost / decisions count (those still come
  /// from the 5s `aomStatus` poll).
  private refreshPhaseDisplay(): void {
    if (!this.phaseLabelEl) return;
    const { phase, since_unix_ms } = this.phase;
    const elapsed =
      since_unix_ms > 0 ? Math.max(0, Date.now() - since_unix_ms) : 0;
    this.phaseLabelEl.textContent = formatPhase(phase, elapsed);
    this.phaseLabelEl.dataset.phase = phase;
  }

  /// 5s poll while active — pulls the latest decisions count from the
  /// backend so subscribers reflect what the Operator just did. Cheap;
  /// the cost is one Tauri RPC per poll.
  private startPolling(): void {
    if (this.poll === null) {
      // Kick off the phase ticker alongside the status poll so the
      // first paint (right after `apply`) doesn't show stale "idle"
      // until the first 1s tick lands. The ticker re-renders only
      // the phase label / elapsed counter — cheap.
      this.startPhasePolling();
    }
    if (this.poll !== null) return;
    this.poll = window.setInterval(() => {
      void aomStatus()
        .then((s) => {
          const prevEnabled = this.status.enabled;
          this.status = s;
          if (!s.enabled) {
            this.stopPolling();
            this.root.hidden = true;
            // Transition to off captured by polling — emit both
            // change and update listeners.
            if (prevEnabled !== s.enabled) {
              for (const l of this.listeners) l(s);
            }
            this.fireUpdate();
            return;
          }
          if (!this.headless) this.refreshDisplay();
          this.fireUpdate();
        })
        .catch(() => {
          /* transient — try again next tick */
        });
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.poll !== null) {
      window.clearInterval(this.poll);
      this.poll = null;
    }
    this.stopPhasePolling();
  }

  /// 1s phase ticker — keeps the badge alive (phase label + elapsed
  /// counter) even when nothing else has changed. Runs only while AOM
  /// is on; stopped when AOM toggles off.
  private startPhasePolling(): void {
    if (this.phasePoll !== null) return;
    // Fire once immediately so the first paint reflects current phase.
    void this.tickPhase();
    this.phasePoll = window.setInterval(() => {
      void this.tickPhase();
    }, PHASE_POLL_MS);
  }

  private stopPhasePolling(): void {
    if (this.phasePoll !== null) {
      window.clearInterval(this.phasePoll);
      this.phasePoll = null;
    }
    // Reset to idle so a future re-enable doesn't flash a stale phase.
    this.phase = { phase: "idle", since_unix_ms: 0 };
    if (typeof document !== "undefined") {
      delete document.body.dataset.aomPhase;
    }
  }

  private async tickPhase(): Promise<void> {
    try {
      this.phase = await operatorPhaseOverview();
    } catch {
      /* transient — try again next tick */
      return;
    }
    if (!this.headless) this.refreshPhaseDisplay();
    // Mirror the global phase onto <body> as a data attribute so any
    // surface (per-tab badges, status bar chip) can react via CSS
    // without subscribing to a JS event. Cheap: one attribute write
    // per second, only changes when the phase actually moves.
    if (typeof document !== "undefined") {
      document.body.dataset.aomPhase = this.phase.phase;
    }
  }

  /// Latest phase snapshot — useful for non-poll consumers (per-tab
  /// badge tooltip, status bar) that want the current value without
  /// running their own ticker.
  getPhase(): OperatorPhaseSnapshot {
    return this.phase;
  }
}

/// Render `phase + elapsed` for the AOM banner. The elapsed counter is
/// dropped for transient phases (`deciding`, `triaging`) where the
/// visible signal is the trailing ellipsis + the per-tab badge pulse —
/// adding a counter there would invite "why is deciding taking 12s"
/// anxiety on what is normally a sub-3s spike.
function formatPhase(phase: OperatorPhase, elapsedMs: number): string {
  const seconds = Math.max(0, Math.floor(elapsedMs / 1000));
  switch (phase) {
    case "observing":
      return `observing ${seconds}s`;
    case "yielded":
      return `yielded ${seconds}s`;
    case "triaging":
      return "triaging…";
    case "deciding":
      return "deciding…";
    case "offline":
      return "offline";
    case "idle":
    default:
      return "idle";
  }
}

function formatElapsed(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
