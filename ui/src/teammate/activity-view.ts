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
  type Operator,
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
  private pickerEl: HTMLElement;
  private listEl: HTMLElement;
  private summaryEl: HTMLElement;
  private unlistenDecision?: UnlistenFn;
  private unlistenStartup?: UnlistenFn;
  /// Cached raw rows (newest first) — kept so we can re-paint on every
  /// selection change without round-tripping the backend.
  private rowsCache: OperatorDecisionRow[] = [];
  /// All known operators (avatar/name/color lookup + picker source).
  private operators: Operator[] = [];
  private operatorsById = new Map<string, Operator>();
  /// Selected operator IDs. `null` = combined (show all). Empty set =
  /// system-only rows (no operator) — same as null in practice but kept
  /// distinct so an explicit "deselect all" doesn't auto-revert.
  private selectedIds: Set<string> | null = null;
  private dropdownEl: HTMLElement | null = null;
  private dismissDropdown: ((e: Event) => void) | null = null;
  private onBadge: ActivityBadgeCallback | null = null;
  private unseenCount = 0;
  private visible = false;
  private timeUpdateTimer: number | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "teammate-panel-activity";

    this.pickerEl = document.createElement("div");
    this.pickerEl.className = "tp-activity-picker";
    this.el.appendChild(this.pickerEl);

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

  async start(operators: Operator[], onBadge: ActivityBadgeCallback): Promise<void> {
    this.operators = operators;
    this.operatorsById = new Map(operators.map((o) => [o.id, o]));
    this.onBadge = onBadge;
    this.unseenCount = 0;
    this.selectedIds = null;
    this.renderPicker();

    // Seed from recent history. Backend returns everything; we filter
    // in-process so selection changes are instant.
    try {
      this.rowsCache = await listOperatorDecisions(100);
      this.paintHistorical();
    } catch (e) {
      console.warn("[activity-view] seed failed", e);
    }

    // Live events.  Wrapped in try/catch so tests (no Tauri IPC) don't blow up.
    try {
      this.unlistenDecision = await listen<DecisionEvent>(
        "operator-decision",
        (event) => this.handleDecisionEvent(event.payload),
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
    this.closeDropdown();
  }

  /* ── selection model ──────────────────────────────────────────── */

  private passes(opId: string | null | undefined): boolean {
    if (!opId) return true; // system rows always pass
    if (this.selectedIds === null) return true;
    return this.selectedIds.has(opId);
  }

  private setSelection(next: Set<string> | null): void {
    this.selectedIds = next;
    this.renderPicker();
    this.paintHistorical();
  }

  /* ── picker UI ────────────────────────────────────────────────── */

  private renderPicker(): void {
    this.pickerEl.innerHTML = "";
    if (this.operators.length === 0) return;

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tp-activity-picker-btn";

    const visibleOps = this.selectedIds === null
      ? this.operators
      : this.operators.filter((o) => this.selectedIds!.has(o.id));

    // Avatar stack (up to 3, +N badge for the rest).
    const stack = document.createElement("span");
    stack.className = "tp-activity-picker-stack";
    const show = visibleOps.slice(0, 3);
    for (const op of show) stack.appendChild(this.operatorAvatar(op, 14));
    if (visibleOps.length > show.length) {
      const more = document.createElement("span");
      more.className = "tp-activity-picker-more";
      more.textContent = `+${visibleOps.length - show.length}`;
      stack.appendChild(more);
    }

    const label = document.createElement("span");
    label.className = "tp-activity-picker-label";
    label.textContent = this.selectedIds === null
      ? "All agents"
      : visibleOps.length === 0
        ? "No agents"
        : visibleOps.length === 1
          ? visibleOps[0].name
          : visibleOps.map((o) => o.name).join(" + ");

    const arrow = document.createElement("span");
    arrow.className = "tp-activity-picker-arrow";
    arrow.textContent = "▾";

    btn.append(stack, label, arrow);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.dropdownEl) this.closeDropdown();
      else this.openDropdown(btn);
    });
    this.pickerEl.appendChild(btn);
  }

  private openDropdown(anchor: HTMLElement): void {
    this.closeDropdown();
    const drop = document.createElement("div");
    drop.className = "tp-activity-picker-drop";

    const head = document.createElement("div");
    head.className = "tp-activity-picker-drop-head";
    head.textContent = "Show activity for";
    drop.appendChild(head);

    // "All" row — special-cases the null state.
    drop.appendChild(this.pickerRow({
      isAll: true,
      selected: this.selectedIds === null,
      label: "All agents",
      count: this.countFor(null),
      onClick: () => { this.setSelection(null); this.closeDropdown(); },
    }));

    const sep = document.createElement("div");
    sep.className = "tp-activity-picker-drop-sep";
    drop.appendChild(sep);

    const subhead = document.createElement("div");
    subhead.className = "tp-activity-picker-drop-head";
    subhead.textContent = "Or pick agents";
    drop.appendChild(subhead);

    for (const op of this.operators) {
      const selected = this.selectedIds !== null && this.selectedIds.has(op.id);
      drop.appendChild(this.pickerRow({
        operator: op,
        selected,
        label: op.name,
        count: this.countFor(op.id),
        onClick: () => {
          // Toggle within an explicit set. From the "all" state, a single
          // pick switches to that one (most common case); cmd/shift could
          // multi-select later — for now, click toggles inclusion.
          const next = new Set(this.selectedIds ?? []);
          if (selected) next.delete(op.id);
          else next.add(op.id);
          // If we just toggled the single remaining selection off, fall
          // back to "all" rather than the awkward empty state.
          this.setSelection(next.size === 0 ? null : next);
          // Keep open so the user can multi-select; close on outside click.
          this.renderDropdown(drop);
        },
      }));
    }

    document.body.appendChild(drop);
    const r = anchor.getBoundingClientRect();
    drop.style.top = `${r.bottom + 6}px`;
    drop.style.left = `${r.left}px`;
    drop.style.minWidth = `${r.width}px`;
    this.dropdownEl = drop;

    this.dismissDropdown = (e: Event) => {
      const t = e.target as Node;
      if (drop.contains(t) || anchor.contains(t)) return;
      this.closeDropdown();
    };
    setTimeout(() => document.addEventListener("mousedown", this.dismissDropdown!), 0);
  }

  private renderDropdown(drop: HTMLElement): void {
    // Re-paint the open dropdown after a multi-select toggle. Cheaper
    // than tearing down and re-positioning.
    const anchor = this.pickerEl.querySelector<HTMLElement>(".tp-activity-picker-btn");
    if (!anchor) return;
    drop.remove();
    if (this.dismissDropdown) {
      document.removeEventListener("mousedown", this.dismissDropdown);
      this.dismissDropdown = null;
    }
    this.dropdownEl = null;
    this.openDropdown(anchor);
  }

  private pickerRow(args: {
    isAll?: boolean;
    operator?: Operator;
    selected: boolean;
    label: string;
    count: number;
    onClick: () => void;
  }): HTMLElement {
    const row = document.createElement("div");
    row.className = "tp-activity-picker-opt";
    if (args.selected) row.classList.add("is-selected");

    const check = document.createElement("span");
    check.className = "tp-activity-picker-check";
    check.textContent = "✓";
    row.appendChild(check);

    if (args.operator) row.appendChild(this.operatorAvatar(args.operator, 14));
    else if (args.isAll) {
      const stack = document.createElement("span");
      stack.className = "tp-activity-picker-stack";
      for (const op of this.operators.slice(0, 3)) stack.appendChild(this.operatorAvatar(op, 12));
      row.appendChild(stack);
    }

    const name = document.createElement("span");
    name.className = "tp-activity-picker-name";
    name.textContent = args.label;
    row.appendChild(name);

    const count = document.createElement("span");
    count.className = "tp-activity-picker-count";
    count.textContent = String(args.count);
    row.appendChild(count);

    row.addEventListener("click", (e) => { e.stopPropagation(); args.onClick(); });
    return row;
  }

  private closeDropdown(): void {
    this.dropdownEl?.remove();
    this.dropdownEl = null;
    if (this.dismissDropdown) {
      document.removeEventListener("mousedown", this.dismissDropdown);
      this.dismissDropdown = null;
    }
  }

  private countFor(opId: string | null): number {
    if (opId === null) return this.rowsCache.length;
    return this.rowsCache.filter((r) => r.operator_id === opId).length;
  }

  private operatorAvatar(op: Operator, size: number): HTMLElement {
    const av = document.createElement("span");
    av.className = "tp-activity-av";
    av.style.width = `${size}px`;
    av.style.height = `${size}px`;
    av.style.background = op.color || "#888";
    return av;
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

  private paintHistorical(): void {
    this.listEl.innerHTML = "";
    this.summaryEl.innerHTML = "";

    const rows = this.rowsCache.filter((r) => this.passes(r.operator_id));
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
    return this.buildCard({ cls, icon, title, body, tabSlug, cost, ts, operatorId: r.operator_id ?? null });
  }

  /* ── live events ──────────────────────────────────────────────── */

  private handleDecisionEvent(d: DecisionEvent): void {
    // Live events always go into the cache so the picker counts stay
    // accurate even when the agent's chip is currently filtered out.
    // Synthesize a minimal OperatorDecisionRow shape from the event.
    const row = {
      id: d.id,
      session_id: d.session_id,
      session_id_short: shortSession(d.session_id),
      action: d.action,
      reply_text: d.reply_text,
      rationale: d.rationale,
      executed: d.executed,
      timestamp_unix_ms: d.timestamp_unix_ms || Date.now(),
      operator_id: d.operator_id ?? null,
      operator_name: d.operator_name ?? null,
      cost_usd: d.cost_usd,
    } as unknown as OperatorDecisionRow;
    this.rowsCache.unshift(row);
    if (this.rowsCache.length > 500) this.rowsCache.length = 500;
    this.renderPicker(); // counts changed

    if (!this.passes(d.operator_id)) {
      // Still count toward the badge so the user knows new things happened
      // somewhere, even if it's filtered out of the current view.
      if (!this.visible) {
        this.unseenCount++;
        this.onBadge?.(this.unseenCount);
      }
      return;
    }
    this.pushDecisionCard(d);
  }

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
    const card = this.buildCard({ cls, icon, title, body, tabSlug, cost, ts, operatorId: d.operator_id ?? null });

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
      operatorId: null,
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
    operatorId: string | null;
  }): HTMLElement {
    const card = document.createElement("div");
    card.className = `tp-activity-card tp-activity-${opts.cls}`;
    card.dataset.ts = String(opts.ts);
    const meta = document.createElement("span");
    meta.className = "tp-activity-meta";
    // Operator chip — only when a row carries an operator and we're
    // showing combined / multi-agent (so the user can tell who did what).
    const op = opts.operatorId ? this.operatorsById.get(opts.operatorId) : null;
    const showWho = op && (this.selectedIds === null || this.selectedIds.size > 1);
    if (showWho) {
      const who = document.createElement("span");
      who.className = "tp-activity-who";
      who.appendChild(this.operatorAvatar(op!, 10));
      const n = document.createElement("span");
      n.textContent = op!.name;
      who.appendChild(n);
      meta.appendChild(who);
    }
    meta.insertAdjacentHTML("beforeend",
      `<span class="tp-activity-icon">${opts.icon}</span>` +
      `<span class="tp-activity-title">${escapeHtml(opts.title)}</span>` +
      `<span class="tp-activity-time" data-role="time">${escapeHtml(relativeTime(opts.ts))}</span>` +
      (opts.cost ? `<span class="tp-activity-cost">${escapeHtml(opts.cost)}</span>` : ""));
    card.appendChild(meta);
    const body = document.createElement("span");
    body.className = "tp-activity-body";
    body.textContent = opts.body;
    card.appendChild(body);
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
