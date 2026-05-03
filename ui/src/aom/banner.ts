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

/// Optional listener hook. main.ts uses it to call
/// `TabManager.refreshAllOperatorState()` whenever the AOM toggle
/// flips, so tab bot icons reflect the auto-enable/revert side-effect.
export type AomChangeListener = (next: AomStatus) => void;

export class AomBanner {
  private root: HTMLElement;
  private timeEl: HTMLElement | null = null;
  private countEl: HTMLElement | null = null;
  private costEl: HTMLElement | null = null;
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

  constructor(private readonly mountHost: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "aom-banner";
    this.root.hidden = true;
    this.mountHost.appendChild(this.root);
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

  /// Subscribe to AOM state transitions (toggle on, toggle off,
  /// budget-hit auto-stop). Listener fires AFTER the backend command
  /// resolves, so callers can rely on backend state being settled.
  onChange(listener: AomChangeListener): void {
    this.listeners.push(listener);
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
      this.render();
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
  }

  private render(): void {
    this.root.hidden = false;
    this.root.innerHTML = `
      <span class="aom-banner-icon">${Icons.bot({ size: 14 })}</span>
      <span class="aom-banner-label">AOM</span>
      <span class="aom-banner-time" aria-label="time elapsed"></span>
      <span class="aom-banner-sep">·</span>
      <span class="aom-banner-count" aria-label="decisions made"></span>
      <span class="aom-banner-sep">·</span>
      <span class="aom-banner-cost" aria-label="cost vs budget"></span>
      <button type="button" class="aom-banner-stop" title="Stop AOM (⌘⇧A)">
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
  /// backend so the banner reflects what the Operator just did. Cheap;
  /// the cost is one Tauri RPC per poll.
  private startPolling(): void {
    if (this.poll !== null) return;
    this.poll = window.setInterval(() => {
      void aomStatus()
        .then((s) => {
          this.status = s;
          if (!s.enabled) {
            this.stopPolling();
            this.root.hidden = true;
            return;
          }
          this.refreshDisplay();
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
