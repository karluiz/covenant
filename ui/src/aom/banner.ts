// Autonomous Operator Mode banner — appears at the bottom of the
// workspace whenever AOM is active. Persistent (no auto-dismiss),
// shows started time + decision counter, has a Stop button.
//
// The banner is the user's "the Operator is driving right now"
// reassurance signal. Without it, AOM would feel invisible — too
// risky for a mode that types into PTYs autonomously.

import { aomStart, aomStatus, aomStop, type AomStatus } from "../api";
import { Icons } from "../icons";

const POLL_MS = 5_000;

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
    this.root.hidden = false;
    this.root.innerHTML = `
      <span class="aom-banner-icon">${Icons.zap({ size: 14 })}</span>
      <span class="aom-banner-label">AOM</span>
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
      this.costEl.textContent = `$${this.status.accumulated_cost_usd.toFixed(
        3,
      )} / $${this.status.budget_usd.toFixed(2)}`;
      // Color the cost cell when getting close to budget — gives the
      // user a visual cue without an extra alert. Threshold 80%.
      const ratio =
        this.status.budget_usd > 0
          ? this.status.accumulated_cost_usd / this.status.budget_usd
          : 0;
      this.costEl.classList.toggle("aom-banner-cost-warn", ratio >= 0.8);
    }
  }

  /// 5s poll while active — pulls the latest decisions count from the
  /// backend so subscribers reflect what the Operator just did. Cheap;
  /// the cost is one Tauri RPC per poll.
  private startPolling(): void {
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
