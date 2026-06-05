/// Per-session operator status strip for the teammate panel header.
/// Renders one compact row per attached/enabled operator, fed by the
/// `operator-status` event (no polling). Pure DOM; the panel owns mount.

import type { OperatorPhase, OperatorStatus } from "../api";

/// Human label for a phase. Mirrors the AOM banner's `formatPhase` but
/// keeps the elapsed counter on the transient phases too (the strip is a
/// detail surface, not the glanceable banner). Exported for tests.
export function formatStripPhase(phase: OperatorPhase, elapsedMs: number): string {
  const s = Math.max(0, Math.floor(elapsedMs / 1000));
  switch (phase) {
    case "observing":
      return `observing ${s}s`;
    case "yielded":
      return `yielded ${s}s`;
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

/// Compose the one-line strip text for a single session. Exported so the
/// vitest suite can assert formatting without touching the DOM.
export function stripLineText(s: OperatorStatus, nowMs: number): string {
  const elapsed = s.phaseSinceUnixMs > 0 ? Math.max(0, nowMs - s.phaseSinceUnixMs) : 0;
  const phase = formatStripPhase(s.phase, elapsed);
  const mission = s.mission ? ` · ${s.mission.name}` : "";
  return `${s.operatorEmoji} ${s.operatorName} · ${phase}${mission}`;
}

export class OperatorStrip {
  private root: HTMLElement;
  /// session_id → latest status. Only enabled sessions are rendered.
  private bySession = new Map<string, OperatorStatus>();

  constructor(host: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "operator-strip";
    host.appendChild(this.root);
  }

  /// Apply one `operator-status` event. Disabled operators are dropped
  /// from the strip (the silent default — no row for "operator off").
  apply(s: OperatorStatus): void {
    if (s.enabled) {
      this.bySession.set(s.sessionId, s);
    } else {
      this.bySession.delete(s.sessionId);
    }
    this.render();
  }

  /// Remove a session's row (tab close).
  remove(sessionId: string): void {
    if (this.bySession.delete(sessionId)) this.render();
  }

  /// Snapshot for tests / external readers.
  count(): number {
    return this.bySession.size;
  }

  private render(): void {
    const now = Date.now();
    this.root.innerHTML = "";
    if (this.bySession.size === 0) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;
    // Stable order: live sessions first, then by name, for a calm strip.
    const rows = [...this.bySession.values()].sort((a, b) => {
      if (a.live !== b.live) return a.live ? -1 : 1;
      return a.operatorName.localeCompare(b.operatorName);
    });
    for (const s of rows) {
      const row = document.createElement("div");
      row.className = "operator-strip__row";
      row.dataset.session = s.sessionId;
      row.dataset.phase = s.phase;
      if (s.live) row.classList.add("is-live");
      row.textContent = stripLineText(s, now);
      this.root.appendChild(row);
    }
  }
}
