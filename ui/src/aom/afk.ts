// AOM AFK ("Battery Mode") — full-window overlay surfacing the
// operator's decision stream + budget. For "leave it running
// overnight, glance at it in the morning."
//
// Subscribes to live `operator-decision` events; seeds initial feed
// from `listOperatorDecisions()` filtered to the current AOM window.
// Reads cost/budget/elapsed from `aomStatus()` (5s poll). No new
// backend code — pure frontend overlay.

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
  }

  close(): void {
    if (!this.root) return;
    this.root.remove();
    this.root = null;
    this.deps.onExit?.();
  }
}
