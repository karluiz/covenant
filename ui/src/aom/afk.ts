// AOM AFK ("Battery Mode") — full-window overlay surfacing the
// operator's decision stream + budget. For "leave it running
// overnight, glance at it in the morning."
//
// Subscribes to live `operator-decision` events; seeds initial feed
// from `listOperatorDecisions()` filtered to the current AOM window.
// Reads cost/budget/elapsed from `aomStatus()` (5s poll). No new
// backend code — pure frontend overlay.

import { aomStatus, type AomStatus } from "../api";
import type { TabManager } from "../tabs/manager";

export interface AfkOverlayDeps {
  manager: TabManager;
  /// Called when AFK exits — main.ts uses this to refit the active
  /// terminal so xterm cell metrics are accurate after the overlay
  /// goes away.
  onExit?: () => void;
}

export class AfkOverlay {
  private root: HTMLElement | null = null;
  private poll: number | null = null;
  private status: AomStatus | null = null;

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly deps: AfkOverlayDeps,
  ) {}

  isOpen(): boolean {
    return this.root !== null;
  }

  open(): void {
    if (this.isOpen()) return;
    const root = document.createElement("div");
    root.className = "afk-overlay";
    root.innerHTML = `
      <header class="afk-header">
        <div class="afk-header-stats">
          <span class="afk-stat afk-stat-cost">—</span>
          <span class="afk-stat afk-stat-elapsed">—</span>
          <span class="afk-stat afk-stat-tabs">—</span>
        </div>
      </header>
      <main class="afk-feed" tabindex="-1">
        <div class="afk-feed-empty">No decisions yet.</div>
      </main>
      <footer class="afk-footer">
        <button type="button" class="afk-wakeup">Wake up</button>
        <span class="afk-hint">Esc to exit</span>
      </footer>
    `;
    this.mountHost.appendChild(root);
    this.root = root;
    root
      .querySelector<HTMLButtonElement>(".afk-wakeup")!
      .addEventListener("click", () => this.close());

    void this.refreshHeader();
    this.poll = window.setInterval(() => void this.refreshHeader(), 5_000);
  }

  close(): void {
    if (!this.root) return;
    if (this.poll !== null) {
      window.clearInterval(this.poll);
      this.poll = null;
    }
    this.root.remove();
    this.root = null;
    this.status = null;
    this.deps.onExit?.();
  }

  private async refreshHeader(): Promise<void> {
    if (!this.root) return;
    try {
      this.status = await aomStatus();
    } catch {
      return;
    }
    this.renderHeader();
  }

  private renderHeader(): void {
    if (!this.root || !this.status) return;
    const s = this.status;
    const costEl = this.root.querySelector<HTMLElement>(".afk-stat-cost");
    const elapsedEl = this.root.querySelector<HTMLElement>(".afk-stat-elapsed");
    const tabsEl = this.root.querySelector<HTMLElement>(".afk-stat-tabs");
    if (costEl) {
      costEl.textContent = `$${s.accumulated_cost_usd.toFixed(
        3,
      )} / $${s.budget_usd.toFixed(2)}`;
      const ratio = s.budget_usd > 0 ? s.accumulated_cost_usd / s.budget_usd : 0;
      costEl.classList.toggle("afk-stat-warn", ratio >= 0.8);
    }
    if (elapsedEl) {
      const ms = s.started_at_unix_ms > 0 ? Date.now() - s.started_at_unix_ms : 0;
      elapsedEl.textContent = formatElapsed(ms);
    }
    if (tabsEl) {
      const n = this.deps.manager.aomActiveTabCount();
      tabsEl.textContent = `${n} tab${n === 1 ? "" : "s"}`;
    }
  }
}

function formatElapsed(ms: number): string {
  if (ms <= 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s === 0) return "just now";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
