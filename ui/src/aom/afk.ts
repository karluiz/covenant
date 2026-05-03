// AOM AFK ("Battery Mode") — full-window overlay surfacing the
// operator's decision stream + budget. For "leave it running
// overnight, glance at it in the morning."
//
// Subscribes to live `operator-decision` events; seeds initial feed
// from `listOperatorDecisions()` filtered to the current AOM window.
// Reads cost/budget/elapsed from `aomStatus()` (5s poll). No new
// backend code — pure frontend overlay.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  aomStatus,
  listOperatorDecisions,
  operatorList,
  type AomStatus,
  type Operator,
  type OperatorDecisionRow,
} from "../api";
import { renderAvatarHtml } from "../operator/avatars";
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
  /// Operator that fired this decision, if present in the event payload.
  operator_id?: string | null;
}

export interface AfkOverlayDeps {
  manager: TabManager;
  /// Open the morning report panel (⌘⇧R surface). AFK calls this when
  /// the user clicks "Run complete — open report?" after AOM ends.
  openReport: () => void;
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
  private autoScroll = true;
  private activeOperatorIds = new Set<string>();
  private opCache: Map<string, Operator> = new Map();

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
        <div class="afk-active-operators" data-role="active-operators"></div>
      </header>
      <main class="afk-feed-wrap">
        <div class="afk-feed" tabindex="-1">
          <div class="afk-feed-empty">No decisions yet.</div>
        </div>
        <button type="button" class="afk-live-pill" hidden>Back to live</button>
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

    const feed = root.querySelector<HTMLElement>(".afk-feed")!;
    const pill = root.querySelector<HTMLButtonElement>(".afk-live-pill")!;
    feed.addEventListener("scroll", () => {
      const atBottom =
        feed.scrollHeight - feed.scrollTop - feed.clientHeight < 32;
      this.autoScroll = atBottom;
      pill.hidden = atBottom;
    });
    pill.addEventListener("click", () => {
      this.autoScroll = true;
      feed.scrollTop = feed.scrollHeight;
      pill.hidden = true;
    });

    this.activeOperatorIds.clear();
    this.poll = window.setInterval(() => void this.refreshHeader(), 5_000);
    void this.refreshOpCache();
    void this.bootstrap();
  }

  private async refreshOpCache(): Promise<void> {
    try {
      const ops = await operatorList();
      this.opCache.clear();
      for (const op of ops) {
        this.opCache.set(op.id, op);
      }
      this.renderActiveOperators();
    } catch {
      // Non-fatal.
    }
  }

  private renderActiveOperators(): void {
    if (!this.root) return;
    const el = this.root.querySelector<HTMLElement>("[data-role='active-operators']");
    if (!el) return;
    if (this.activeOperatorIds.size === 0) {
      el.innerHTML = "";
      return;
    }
    const chips = Array.from(this.activeOperatorIds)
      .map((id) => {
        const op = this.opCache.get(id);
        const color = op?.color ?? "#6B7280";
        const name = op ? op.name : `…${id.slice(-6)}`;
        const avatarHtml = op ? renderAvatarHtml(op.emoji, 24) : "";
        return `<span class="afk-op-chip" style="background:${escapeHtml(color)}" title="${escapeHtml(name)}">${avatarHtml}<span>${escapeHtml(name)}</span></span>`;
      })
      .join("");
    el.innerHTML = `<span class="afk-active-label">Active operators:</span>${chips}`;
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
    // Reset to "live" so a re-open after the user scrolled up
    // doesn't strand the next session at an arbitrary offset with no
    // pill visible (the pill only re-appears via the live-card path,
    // not on seed).
    this.autoScroll = true;
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
    if (this.status && !this.status.enabled) {
      this.renderRunComplete();
    }
  }

  private renderRunComplete(): void {
    if (!this.root) return;
    const footer = this.root.querySelector<HTMLElement>(".afk-footer");
    if (!footer || footer.classList.contains("afk-footer-complete")) return;
    footer.classList.add("afk-footer-complete");
    footer.innerHTML = `
      <span class="afk-complete-msg">Run complete.</span>
      <button type="button" class="afk-open-report">Open report</button>
      <button type="button" class="afk-wakeup">Wake up</button>
      <span class="afk-hint">Esc to exit</span>
    `;
    footer
      .querySelector<HTMLButtonElement>(".afk-open-report")!
      .addEventListener("click", () => {
        this.deps.openReport();
        this.close();
      });
    footer
      .querySelector<HTMLButtonElement>(".afk-wakeup")!
      .addEventListener("click", () => this.close());
  }

  private pushDecision(d: DecisionEvent): void {
    if (!this.root) return;
    const feed = this.root.querySelector<HTMLElement>(".afk-feed");
    if (!feed) return;

    if (d.operator_id) {
      this.activeOperatorIds.add(d.operator_id);
      this.renderActiveOperators();
    }

    // Drop the empty-state on first card.
    const empty = feed.querySelector(".afk-feed-empty");
    if (empty) empty.remove();

    const card = renderDecisionCard(d);
    card.addEventListener("click", () => {
      this.deps.manager.activate(d.session_id);
      this.close();
    });
    feed.appendChild(card);
    if (this.autoScroll) {
      feed.scrollTop = feed.scrollHeight;
    } else {
      const pill = this.root.querySelector<HTMLButtonElement>(".afk-live-pill");
      if (pill) pill.hidden = false;
    }
  }

  /// Sequenced startup: header → listener attach → seed history. Each
  /// `await` re-checks `this.root` after resuming so a same-tick close()
  /// doesn't leak a listener or render to a torn-down overlay.
  private async bootstrap(): Promise<void> {
    await this.refreshHeader();
    if (!this.root) return; // closed during await
    const un = await listen<DecisionEvent>("operator-decision", (event) => {
      this.pushDecision(event.payload);
    });
    if (this.root === null) {
      un();
      return;
    }
    this.unlistenDecision = un;
    await this.seedFeed();
  }

  private async seedFeed(): Promise<void> {
    if (!this.root) return;
    let rows: OperatorDecisionRow[];
    try {
      rows = await listOperatorDecisions(200);
    } catch {
      return;
    }
    // Scope to the current AOM session — earlier decisions belong to a
    // previous run and would be misleading in the live feed. If the
    // status fetch failed (refreshHeader swallowed the error) or AOM
    // has never started (started_at_unix_ms === 0), refuse to seed
    // rather than fall back to "show every decision ever".
    const startMs = this.status?.started_at_unix_ms;
    if (!startMs) return;
    const scoped = rows.filter((r) => r.timestamp_unix_ms >= startMs);
    // listOperatorDecisions returns newest-first; reverse so chronological
    // order matches live (newest at bottom).
    scoped.reverse();
    if (!this.root) return;
    const feed = this.root.querySelector<HTMLElement>(".afk-feed");
    if (!feed) return;
    if (scoped.length > 0) {
      const empty = feed.querySelector(".afk-feed-empty");
      if (empty) empty.remove();
    }
    for (const r of scoped) {
      if (r.operator_id) {
        this.activeOperatorIds.add(r.operator_id);
      }
      feed.appendChild(renderSeededCard(r));
    }
    this.renderActiveOperators();
    if (this.autoScroll) {
      feed.scrollTop = feed.scrollHeight;
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

function renderSeededCard(r: OperatorDecisionRow): HTMLElement {
  let cls: string;
  let title: string;
  let body: string;
  switch (r.action) {
    case "reply":
      cls = r.executed ? "ok" : "muted";
      title = r.executed ? "REPLY" : "REPLY (dry)";
      body = formatReplyLine(r.reply_text, r.rationale);
      break;
    case "escalate":
      cls = "warn";
      title = "ESCALATE";
      // OperatorDecisionRow has no `escalation` field (unlike the live
      // event); rationale is the canonical source. Don't fall back to
      // reply_text — for an escalate row, that field is either null or
      // the next reply's content, not the escalation message.
      body = r.rationale ?? "(no detail)";
      break;
    case "wait":
      cls = "muted";
      title = "WAIT";
      body = r.rationale ?? "(no detail)";
      break;
    default:
      cls = "muted";
      title = r.action.toUpperCase();
      body = r.rationale ?? "";
  }
  const time = formatClock(r.timestamp_unix_ms);
  // No `<button>`: seeded rows can't click-jump (we only have the short
  // session id, not the full SessionId). Render as plain div for parity.
  const card = document.createElement("div");
  card.className = `afk-card afk-card-${cls} afk-card-seeded`;
  card.innerHTML = `
    <span class="afk-card-time">${escapeHtml(time)}</span>
    <span class="afk-card-tab">…${escapeHtml(r.session_id_short)}</span>
    <span class="afk-card-action">${escapeHtml(title)}</span>
    <span class="afk-card-body"></span>
  `;
  card.querySelector<HTMLElement>(".afk-card-body")!.textContent = body;
  return card;
}
