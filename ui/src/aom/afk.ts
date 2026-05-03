// AOM AFK ("Battery Mode") — full-window overlay surfacing the
// operator's decision stream + budget. For "leave it running
// overnight, glance at it in the morning."
//
// Subscribes to live `operator-decision` events; seeds initial feed
// from `listOperatorDecisions()` filtered to the current AOM window.
// Reads cost/budget/elapsed from `aomStatus()` (5s poll). No new
// backend code — pure frontend overlay.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { aomStatus, type AomStatus } from "../api";
import type { TabManager } from "../tabs/manager";

interface DecisionEvent {
  id: number | null;
  session_id: string;
  action: "reply" | "escalate" | "wait" | string;
  reply_text: string | null;
  rationale: string | null;
  escalation: string | null;
  executed: boolean;
  cost_usd: number;
  timestamp_unix_ms: number;
}

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
  private unlistenDecision: UnlistenFn | null = null;

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

    void listen<DecisionEvent>("operator-decision", (event) => {
      this.pushDecision(event.payload);
    }).then((un) => {
      // If close() ran before listen() resolved, immediately detach.
      if (this.root === null) un();
      else this.unlistenDecision = un;
    });
  }

  close(): void {
    if (!this.root) return;
    if (this.poll !== null) {
      window.clearInterval(this.poll);
      this.poll = null;
    }
    if (this.unlistenDecision) {
      this.unlistenDecision();
      this.unlistenDecision = null;
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

  private pushDecision(d: DecisionEvent): void {
    if (!this.root) return;
    const feed = this.root.querySelector<HTMLElement>(".afk-feed");
    if (!feed) return;

    // Drop the empty-state on first card.
    const empty = feed.querySelector(".afk-feed-empty");
    if (empty) empty.remove();

    const card = renderDecisionCard(d);
    card.addEventListener("click", () => {
      this.deps.manager.activate(d.session_id);
      this.close();
    });
    feed.appendChild(card);
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

function renderDecisionCard(d: DecisionEvent): HTMLElement {
  let cls: string;
  let title: string;
  let body: string;
  switch (d.action) {
    case "reply":
      cls = d.executed ? "ok" : "muted";
      title = d.executed ? "REPLY" : "REPLY (dry)";
      body = formatReplyLine(d.reply_text, d.rationale);
      break;
    case "escalate":
      cls = "warn";
      title = "ESCALATE";
      body = d.escalation ?? d.rationale ?? "(no detail)";
      break;
    case "wait":
      cls = "muted";
      title = "WAIT";
      body = d.rationale ?? "(no detail)";
      break;
    default:
      cls = "muted";
      title = d.action.toUpperCase();
      body = d.rationale ?? "";
  }
  const tabSlug = shortSession(d.session_id);
  const time = formatClock(d.timestamp_unix_ms);

  const card = document.createElement("button");
  card.type = "button";
  card.className = `afk-card afk-card-${cls}`;
  card.innerHTML = `
    <span class="afk-card-time">${escapeHtml(time)}</span>
    <span class="afk-card-tab">…${escapeHtml(tabSlug)}</span>
    <span class="afk-card-action">${escapeHtml(title)}</span>
    <span class="afk-card-body"></span>
  `;
  card.querySelector<HTMLElement>(".afk-card-body")!.textContent = body;
  return card;
}

function formatReplyLine(text: string | null, rationale: string | null): string {
  const safe = (text ?? "").replace(/\n/g, "\\n").trim();
  const head = safe.length > 60 ? `"${safe.slice(0, 60)}…"` : `"${safe}"`;
  return rationale ? `${head} — ${rationale}` : head;
}

function shortSession(id: string): string {
  return id.length > 6 ? id.slice(-6) : id;
}

function formatClock(unixMs: number): string {
  const d = new Date(unixMs);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
