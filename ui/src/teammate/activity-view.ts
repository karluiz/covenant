// Activity tab — persistent, scrollable feed of Operator decisions.
//
// Unlike AomActivityFeed (ephemeral bottom-right toast cards that vanish
// after 4 seconds), this view lives inside the TeammatePanel sidebar and
// keeps a running log. On mount it seeds from `listOperatorDecisions()`
// then appends live events from `operator-decision` and
// `operator-startup-action`.  When the user switches to another tab the
// listener stays active so the badge count keeps ticking.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  listOperatorDecisions,
  type OperatorDecisionRow,
} from "../api";
// Note: OperatorDecisionRow may or may not carry cost_usd and escalation
// depending on which interface definition wins.  We access them defensively
// via (row as any).cost_usd / (row as any).escalation to stay safe.
import { Icons } from "../icons";

/* ── event shapes (mirrors activity-feed.ts) ────────────────────── */

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
  operator_id?: string | null;
  operator_name?: string | null;
}

interface StartupActionEvent {
  session_id: string;
  action: string;
}

/* ── helpers ─────────────────────────────────────────────────────── */

function shortSession(id: string): string {
  return id.length > 6 ? id.slice(-6) : id;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatReply(text: string | null, rationale: string | null): string {
  const safeText = (text ?? "").replace(/\n/g, "\\n").trim();
  const head =
    safeText.length > 60 ? `"${safeText.slice(0, 60)}…"` : `"${safeText}"`;
  return rationale ? `${head} — ${rationale}` : head;
}

function relativeTime(ts: number): string {
  const delta = Math.floor((Date.now() - ts) / 1000);
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

/* ── view class ──────────────────────────────────────────────────── */

export type ActivityBadgeCallback = (count: number) => void;

export class ActivityView {
  private el: HTMLElement;
  private listEl: HTMLElement;
  private summaryEl: HTMLElement;
  private unlistenDecision?: UnlistenFn;
  private unlistenStartup?: UnlistenFn;
  private operatorId: string | null = null;
  private onBadge: ActivityBadgeCallback | null = null;
  private unseenCount = 0;
  private visible = false;
  private timeUpdateTimer: number | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "teammate-panel-activity";

    this.summaryEl = document.createElement("div");
    this.summaryEl.className = "tp-activity-summary";
    this.el.appendChild(this.summaryEl);

    this.listEl = document.createElement("div");
    this.listEl.className = "tp-activity-list";
    this.el.appendChild(this.listEl);
  }

  getElement(): HTMLElement {
    return this.el;
  }

  async start(operatorId: string, onBadge: ActivityBadgeCallback): Promise<void> {
    this.operatorId = operatorId;
    this.onBadge = onBadge;
    this.unseenCount = 0;

    // Seed from recent history.
    try {
      const rows = await listOperatorDecisions(100);
      // Filter to this operator if the row carries operator_id.
      const filtered = rows.filter(
        (r) => !r.operator_id || r.operator_id === operatorId,
      );
      this.paintHistorical(filtered);
    } catch (e) {
      console.warn("[activity-view] seed failed", e);
    }

    // Live events.  Wrapped in try/catch so tests (no Tauri IPC) don't blow up.
    try {
      this.unlistenDecision = await listen<DecisionEvent>(
        "operator-decision",
        (event) => {
          const d = event.payload;
          if (d.operator_id && d.operator_id !== this.operatorId) return;
          this.pushDecisionCard(d);
        },
      );
      this.unlistenStartup = await listen<StartupActionEvent>(
        "operator-startup-action",
        (event) => this.pushStartupCard(event.payload),
      );
    } catch {
      // Tauri IPC unavailable (test environment). Historical seed still works.
    }

    // Update relative times every 30s.
    this.timeUpdateTimer = window.setInterval(() => this.refreshTimes(), 30_000);
  }

  stop(): void {
    this.unlistenDecision?.();
    this.unlistenDecision = undefined;
    this.unlistenStartup?.();
    this.unlistenStartup = undefined;
    if (this.timeUpdateTimer !== null) {
      window.clearInterval(this.timeUpdateTimer);
      this.timeUpdateTimer = null;
    }
  }

  /** Called when the Activity tab becomes visible/hidden. */
  setVisible(v: boolean): void {
    this.visible = v;
    if (v) {
      this.unseenCount = 0;
      this.onBadge?.(0);
    }
  }

  /* ── historical seed ──────────────────────────────────────────── */

  private paintHistorical(rows: OperatorDecisionRow[]): void {
    this.listEl.innerHTML = "";
    this.summaryEl.innerHTML = "";

    if (rows.length === 0) {
      this.listEl.innerHTML =
        '<div class="tp-activity-empty">No activity yet.</div>';
      return;
    }

    // Compute summary.
    let totalCost = 0;
    const counts: Record<string, number> = {};
    for (const r of rows) {
      totalCost += (r as any).cost_usd ?? 0;
      const a = r.action ?? "unknown";
      counts[a] = (counts[a] ?? 0) + 1;
    }
    this.renderSummary(counts, totalCost);

    // Cards — newest first.
    for (const r of rows) {
      const card = this.makeHistoricalCard(r);
      this.listEl.appendChild(card);
    }
  }

  private renderSummary(
    counts: Record<string, number>,
    totalCost: number,
  ): void {
    const parts: string[] = [];
    if (counts["reply"]) parts.push(`<span class="tp-act-dot tp-act-dot--ok"></span> ${counts["reply"]} replied`);
    if (counts["escalate"]) parts.push(`<span class="tp-act-dot tp-act-dot--warn"></span> ${counts["escalate"]} escalated`);
    if (counts["wait"]) parts.push(`<span class="tp-act-dot tp-act-dot--muted"></span> ${counts["wait"]} waited`);
    this.summaryEl.innerHTML =
      `<div class="tp-activity-summary-stats">${parts.join('<span class="tp-act-sep">·</span>')}</div>` +
      `<div class="tp-activity-summary-cost">Σ $${totalCost.toFixed(3)}</div>`;
  }

  private makeHistoricalCard(r: OperatorDecisionRow): HTMLElement {
    const { cls, icon, title, body } = this.classifyAction(
      r.action,
      r.executed,
      r.reply_text ?? null,
      r.rationale ?? null,
      null, // historical rows don't carry escalation
    );
    const tabSlug = shortSession(r.session_id_short ?? "");
    const costVal = (r as any).cost_usd ?? 0;
    const cost = costVal > 0 ? `$${costVal.toFixed(3)}` : "";
    const ts = r.timestamp_unix_ms ?? 0;
    return this.buildCard({ cls, icon, title, body, tabSlug, cost, ts });
  }

  /* ── live events ──────────────────────────────────────────────── */

  private pushDecisionCard(d: DecisionEvent): void {
    const { cls, icon, title, body } = this.classifyAction(
      d.action,
      d.executed,
      d.reply_text,
      d.rationale,
      d.escalation,
    );
    const tabSlug = shortSession(d.session_id);
    const cost = d.cost_usd > 0 ? `$${d.cost_usd.toFixed(3)}` : "";
    const ts = d.timestamp_unix_ms || Date.now();
    const card = this.buildCard({ cls, icon, title, body, tabSlug, cost, ts });

    // Remove the empty state if present.
    this.listEl.querySelector(".tp-activity-empty")?.remove();

    // Insert at top (newest first).
    this.listEl.prepend(card);

    // Animate in.
    card.classList.add("tp-activity-card--entering");
    requestAnimationFrame(() => card.classList.remove("tp-activity-card--entering"));

    if (!this.visible) {
      this.unseenCount++;
      this.onBadge?.(this.unseenCount);
    }
  }

  private pushStartupCard(e: StartupActionEvent): void {
    const card = this.buildCard({
      cls: "startup",
      icon: Icons.headphones({ size: 12 }),
      title: "startup",
      body: e.action,
      tabSlug: shortSession(e.session_id),
      cost: "",
      ts: Date.now(),
    });

    this.listEl.querySelector(".tp-activity-empty")?.remove();
    this.listEl.prepend(card);
    card.classList.add("tp-activity-card--entering");
    requestAnimationFrame(() => card.classList.remove("tp-activity-card--entering"));

    if (!this.visible) {
      this.unseenCount++;
      this.onBadge?.(this.unseenCount);
    }
  }

  /* ── shared rendering ─────────────────────────────────────────── */

  private classifyAction(
    action: string,
    executed: boolean,
    replyText: string | null,
    rationale: string | null,
    escalation: string | null,
  ): { cls: string; icon: string; title: string; body: string } {
    switch (action) {
      case "reply":
        return {
          cls: executed ? "ok" : "muted",
          icon: Icons.messageCircle({ size: 12 }),
          title: executed ? "typed" : "dry-run",
          body: formatReply(replyText, rationale),
        };
      case "escalate":
        return {
          cls: "warn",
          icon: Icons.alertTriangle({ size: 12 }),
          title: "escalated",
          body: escalation ?? rationale ?? "(no detail)",
        };
      case "wait":
        return {
          cls: "muted",
          icon: Icons.terminal({ size: 12 }),
          title: "wait",
          body: rationale ?? "(no detail)",
        };
      default:
        return {
          cls: "muted",
          icon: Icons.headphones({ size: 12 }),
          title: action,
          body: rationale ?? "",
        };
    }
  }

  private buildCard(opts: {
    cls: string;
    icon: string;
    title: string;
    body: string;
    tabSlug: string;
    cost: string;
    ts: number;
  }): HTMLElement {
    const card = document.createElement("div");
    card.className = `tp-activity-card tp-activity-${opts.cls}`;
    card.dataset.ts = String(opts.ts);
    // Compact layout: icon + TITLE · time · $cost
    //                  body row below (full width)
    card.innerHTML = `
      <span class="tp-activity-meta">
        <span class="tp-activity-icon">${opts.icon}</span>
        <span class="tp-activity-title">${escapeHtml(opts.title)}</span>
        <span class="tp-activity-time" data-role="time">${escapeHtml(relativeTime(opts.ts))}</span>
        ${opts.cost ? `<span class="tp-activity-cost">${escapeHtml(opts.cost)}</span>` : ""}
      </span>
      <span class="tp-activity-body"></span>
    `;
    card.querySelector<HTMLElement>(".tp-activity-body")!.textContent = opts.body;
    return card;
  }

  private refreshTimes(): void {
    for (const el of this.listEl.querySelectorAll<HTMLElement>('[data-role="time"]')) {
      const card = el.closest<HTMLElement>(".tp-activity-card");
      if (!card?.dataset.ts) continue;
      el.textContent = relativeTime(Number(card.dataset.ts));
    }
  }
}
