// Familiar status indicator — small colored dot rendered alongside
// the active tab's status segments. Polls the bound Familiar's
// snapshot + audit on a 5s cadence and maps the result to one of:
//
//   ok      — synced recently and no pending directives
//   pending — at least one proposed directive awaits decision
//   lost    — no events for 5+ minutes (stale / disconnected)
//   off     — no Familiar bound to the active tab
//
// Click dispatches `familiars:open` so main.ts can show the Roster
// without this module reaching into Roster directly (keeps the
// indicator a leaf — no upward imports).
//
// The indicator is bound to a single familiar id at a time. The
// status bar instantiates one and re-binds it on tab activation.

import { Familiars } from "./api";

export type IndicatorState = "ok" | "pending" | "lost" | "off";

export class FamiliarStatusIndicator {
  private el: HTMLSpanElement;
  private familiarId: string | null = null;
  private timer: number | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("span");
    this.el.className = "familiar-status-dot off";
    this.el.title = "Familiar";
    this.el.addEventListener("click", () => {
      document.dispatchEvent(
        new CustomEvent("familiars:open", {
          detail: { familiarId: this.familiarId },
        }),
      );
    });
    parent.appendChild(this.el);
  }

  /// Bind (or rebind) the indicator to a Familiar id. Pass null to
  /// detach — the dot becomes "off" and polling stops.
  bind(familiarId: string | null): void {
    if (this.familiarId === familiarId) return;
    this.familiarId = familiarId;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    if (familiarId) {
      void this.refresh();
      this.timer = window.setInterval(() => { void this.refresh(); }, 5000);
    } else {
      this.set("off");
    }
  }

  private set(state: IndicatorState): void {
    this.el.className = `familiar-status-dot ${state}`;
    this.el.title = `Familiar: ${state}`;
  }

  private async refresh(): Promise<void> {
    const id = this.familiarId;
    if (!id) return;
    try {
      const snap = await Familiars.snapshot(id);
      const sinceMs = Date.now() - 24 * 3600 * 1000;
      const audit = await Familiars.audit(id, sinceMs);
      // Bail if rebinding raced with the in-flight fetch.
      if (this.familiarId !== id) return;
      const pending = audit.some((d) => d.state === "proposed");
      const ageMs = snap.last_event_ms === 0
        ? Number.MAX_SAFE_INTEGER
        : Date.now() - snap.last_event_ms;
      if (pending) this.set("pending");
      else if (ageMs > 5 * 60_000) this.set("lost");
      else this.set("ok");
    } catch {
      if (this.familiarId !== id) return;
      this.set("lost");
    }
  }
}
