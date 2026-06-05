// Activity tab — persistent feed of Operator decisions.
//
// Holds events in memory and re-renders on every change so we can:
//   - show a 30-min stacked sparkline of typed/escalated/waited volume
//   - collapse consecutive identical events into a × N run
//   - detect "loop" incidents (operator typed the same reply N×, executor
//     escalated each time) and render them as a single resolvable card
//   - filter by kind via chips, with live counts
//   - hide per-row cost noise unless it's an outlier (or on hover)
//
// Live events arrive over `operator-decision` / `operator-startup-action`
// just like before; we normalize them into ActEvent and append.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import {
  listOperatorDecisions,
  type OperatorDecisionRow,
} from "../api";

/* ── wire shapes (mirrors activity-feed.ts) ──────────────────────── */

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

/* ── normalized event ────────────────────────────────────────────── */

type Kind = "typed" | "dry-run" | "escalated" | "waited" | "startup" | "other";

interface ActEvent {
  ts: number;
  kind: Kind;
  rawAction: string;
  body: string;
  cost: number;
  sessionShort: string;
  // Operator display name at decision time (Phase 3 attribution).
  // Null for pre-attribution rows / sessions with no operator.
  operatorName: string | null;
}

/* ── helpers ─────────────────────────────────────────────────────── */

const MAX_EVENTS = 500;
const RUN_WINDOW_MS = 120_000;       // collapse runs within 2 min
const INCIDENT_WINDOW_MS = 5 * 60_000; // 5 min
const INCIDENT_MIN_CYCLES = 2;       // ≥2 escalate+typed pairs

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

function relativeTime(ts: number, nowMs: number = Date.now()): string {
  const delta = Math.floor((nowMs - ts) / 1000);
  if (delta < 5) return "just now";
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h`;
  return `${Math.floor(delta / 86400)}d`;
}

function classifyKind(action: string, executed: boolean): Kind {
  switch (action) {
    case "reply": return executed ? "typed" : "dry-run";
    case "escalate": return "escalated";
    case "wait": return "waited";
    default: return "other";
  }
}

function bodyForDecision(
  kind: Kind,
  replyText: string | null,
  rationale: string | null,
  escalation: string | null,
): string {
  switch (kind) {
    case "typed":
    case "dry-run": {
      const t = (replyText ?? "").replace(/\n/g, " ").trim();
      return t.length === 0 ? "(empty)" : t;
    }
    case "escalated":
      return (escalation ?? rationale ?? "(no detail)").replace(/\n/g, " ").trim();
    case "waited":
      return (rationale ?? "(pending)").replace(/\n/g, " ").trim();
    default:
      return (rationale ?? "").replace(/\n/g, " ").trim();
  }
}

function truncate(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  return { text: s.slice(0, max).trimEnd() + "…", truncated: true };
}

function bucketLabel(ts: number, nowMs: number): string {
  const min = Math.floor((nowMs - ts) / 60_000);
  if (min < 1) return "Just now";
  if (min < 10) return "Past 10 min";
  if (min < 30) return "10–30 min ago";
  if (min < 60) return "30–60 min ago";
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ago`;
  return `Earlier`;
}

/* ── view class ──────────────────────────────────────────────────── */

export type ActivityBadgeCallback = (count: number) => void;

type Filter = "all" | "typed" | "escalated" | "waited";

export class ActivityView {
  private el: HTMLElement;
  private headerEl: HTMLElement;
  private sparkEl: HTMLElement;
  private filtersEl: HTMLElement;
  private listEl: HTMLElement;

  private unlistenDecision?: UnlistenFn;
  private unlistenStartup?: UnlistenFn;
  private operatorId: string | null = null;
  private onBadge: ActivityBadgeCallback | null = null;
  private unseenCount = 0;
  private visible = false;
  private renderTimer: number | null = null;

  private events: ActEvent[] = []; // newest LAST (we sort on push)
  private filter: Filter = "all";

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "teammate-panel-activity";

    this.headerEl = document.createElement("div");
    this.headerEl.className = "tp-activity-kpi";
    this.el.appendChild(this.headerEl);

    this.sparkEl = document.createElement("div");
    this.sparkEl.className = "tp-activity-spark";
    this.el.appendChild(this.sparkEl);

    this.filtersEl = document.createElement("div");
    this.filtersEl.className = "tp-activity-filters";
    this.el.appendChild(this.filtersEl);

    this.listEl = document.createElement("div");
    this.listEl.className = "tp-activity-list";
    this.el.appendChild(this.listEl);

    this.filtersEl.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement)?.closest<HTMLElement>("[data-filter]");
      if (!chip) return;
      const f = chip.dataset["filter"] as Filter;
      if (!f) return;
      this.filter = f;
      this.scheduleRender();
    });

    this.listEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const expand = target.closest<HTMLElement>("[data-action='expand-run']");
      if (expand) {
        const row = expand.closest<HTMLElement>(".tp-act-row");
        row?.classList.toggle("tp-act-row--expanded");
        return;
      }
      const incidentAction = target.closest<HTMLElement>("[data-action]");
      if (incidentAction) {
        const action = incidentAction.dataset["action"];
        if (action === "incident-expand") {
          incidentAction.closest<HTMLElement>(".tp-act-incident")?.classList.toggle("tp-act-incident--expanded");
        }
      }
    });
  }

  getElement(): HTMLElement {
    return this.el;
  }

  async start(operatorId: string, onBadge: ActivityBadgeCallback): Promise<void> {
    this.operatorId = operatorId;
    this.onBadge = onBadge;
    this.unseenCount = 0;
    this.events = [];

    // Seed from recent history.
    try {
      const rows = await listOperatorDecisions(MAX_EVENTS);
      const filtered = rows.filter(
        (r) => !r.operator_id || r.operator_id === operatorId,
      );
      for (const r of filtered) this.absorbDecisionRow(r);
    } catch (e) {
      console.warn("[activity-view] seed failed", e);
    }
    this.sortAndCap();
    this.scheduleRender();

    // Live events.
    try {
      this.unlistenDecision = await listen<DecisionEvent>(
        "operator-decision",
        (event) => {
          const d = event.payload;
          if (d.operator_id && d.operator_id !== this.operatorId) return;
          this.absorbDecisionEvent(d);
          this.sortAndCap();
          this.scheduleRender();
          if (!this.visible) {
            this.unseenCount++;
            this.onBadge?.(this.unseenCount);
          }
        },
      );
      this.unlistenStartup = await listen<StartupActionEvent>(
        "operator-startup-action",
        (event) => {
          const e = event.payload;
          this.events.push({
            ts: Date.now(),
            kind: "startup",
            rawAction: "startup",
            body: e.action,
            cost: 0,
            sessionShort: shortSession(e.session_id),
            operatorName: null,
          });
          this.sortAndCap();
          this.scheduleRender();
          if (!this.visible) {
            this.unseenCount++;
            this.onBadge?.(this.unseenCount);
          }
        },
      );
    } catch {
      // Tauri IPC unavailable (test environment). Historical seed still works.
    }

    // Re-render every 30s so relative times + sparkline stay fresh.
    this.renderTimer = window.setInterval(() => this.scheduleRender(), 30_000);
  }

  stop(): void {
    this.unlistenDecision?.();
    this.unlistenDecision = undefined;
    this.unlistenStartup?.();
    this.unlistenStartup = undefined;
    if (this.renderTimer !== null) {
      window.clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (v) {
      this.unseenCount = 0;
      this.onBadge?.(0);
    }
  }

  /* ── absorb wire events ────────────────────────────────────────── */

  private absorbDecisionRow(r: OperatorDecisionRow): void {
    const kind = classifyKind(r.action, r.executed);
    const body = bodyForDecision(
      kind,
      r.reply_text ?? null,
      r.rationale ?? null,
      null,
    );
    this.events.push({
      ts: r.timestamp_unix_ms ?? 0,
      kind,
      rawAction: r.action,
      body,
      cost: (r as { cost_usd?: number }).cost_usd ?? 0,
      sessionShort: shortSession(r.session_id_short ?? ""),
      operatorName: r.operator_name ?? null,
    });
  }

  private absorbDecisionEvent(d: DecisionEvent): void {
    const kind = classifyKind(d.action, d.executed);
    const body = bodyForDecision(kind, d.reply_text, d.rationale, d.escalation);
    this.events.push({
      ts: d.timestamp_unix_ms || Date.now(),
      kind,
      rawAction: d.action,
      body,
      cost: d.cost_usd ?? 0,
      sessionShort: shortSession(d.session_id),
      operatorName: d.operator_name ?? null,
    });
  }

  private sortAndCap(): void {
    this.events.sort((a, b) => a.ts - b.ts); // oldest first
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
  }

  /* ── render pipeline ───────────────────────────────────────────── */

  private scheduleRender(): void {
    // Coalesce bursty event storms into one repaint per frame.
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.render();
    });
  }
  private renderQueued = false;

  private render(): void {
    const now = Date.now();
    this.renderKpi(now);
    this.renderSparkline(now);
    this.renderFilters();
    this.renderList(now);
  }

  private renderKpi(now: number): void {
    const counts = { typed: 0, escalated: 0, waited: 0 };
    let total = 0;
    let peak = 0;
    let costCount = 0;
    for (const e of this.events) {
      if (e.kind === "typed" || e.kind === "dry-run") counts.typed++;
      else if (e.kind === "escalated") counts.escalated++;
      else if (e.kind === "waited") counts.waited++;
      if (e.cost > 0) {
        total += e.cost;
        if (e.cost > peak) peak = e.cost;
        costCount++;
      }
    }
    const avg = costCount > 0 ? total / costCount : 0;

    if (this.events.length === 0) {
      this.headerEl.innerHTML = "";
      return;
    }

    this.headerEl.innerHTML = `
      <div class="tp-act-kpi-counts">
        <span class="tp-act-num tp-act-num--ok"><span class="dot"></span>${counts.typed}<span class="lbl">replied</span></span>
        <span class="tp-act-num tp-act-num--warn"><span class="dot"></span>${counts.escalated}<span class="lbl">escalated</span></span>
        <span class="tp-act-num tp-act-num--mute"><span class="dot"></span>${counts.waited}<span class="lbl">waited</span></span>
      </div>
      <div class="tp-act-kpi-money">
        <span class="sum">Σ&nbsp;$${total.toFixed(2)}</span>
        <span class="meta">⌀ $${avg.toFixed(3)} · peak $${peak.toFixed(3)}</span>
      </div>
    `;
    void now;
  }

  private renderSparkline(now: number): void {
    const BUCKETS = 30;
    const BUCKET_MS = 60_000;
    type Bin = { t: number; e: number; w: number };
    const bins: Bin[] = Array.from({ length: BUCKETS }, () => ({ t: 0, e: 0, w: 0 }));
    for (const ev of this.events) {
      const ageMin = Math.floor((now - ev.ts) / BUCKET_MS);
      if (ageMin < 0 || ageMin >= BUCKETS) continue;
      const idx = BUCKETS - 1 - ageMin;
      if (ev.kind === "typed" || ev.kind === "dry-run") bins[idx]!.t++;
      else if (ev.kind === "escalated") bins[idx]!.e++;
      else if (ev.kind === "waited") bins[idx]!.w++;
    }
    let maxBin = 0;
    for (const b of bins) {
      const total = b.t + b.e + b.w;
      if (total > maxBin) maxBin = total;
    }
    if (maxBin === 0) {
      this.sparkEl.innerHTML = "";
      return;
    }
    const MAX_H = 32;
    const cols = bins
      .map((b, i) => {
        const isNow = i === BUCKETS - 1;
        const scale = MAX_H / maxBin;
        const parts: string[] = [];
        if (b.t > 0) parts.push(`<span class="t" style="height:${(b.t * scale).toFixed(1)}px"></span>`);
        if (b.e > 0) parts.push(`<span class="e" style="height:${(b.e * scale).toFixed(1)}px"></span>`);
        if (b.w > 0) parts.push(`<span class="w" style="height:${(b.w * scale).toFixed(1)}px"></span>`);
        return `<div class="tp-act-spark-col${isNow ? " is-now" : ""}">${parts.join("")}</div>`;
      })
      .join("");
    this.sparkEl.innerHTML = `
      <div class="tp-act-spark-row">${cols}</div>
      <div class="tp-act-spark-axis"><span>-30m</span><span>now</span></div>
    `;
  }

  private renderFilters(): void {
    if (this.events.length === 0) {
      this.filtersEl.innerHTML = "";
      return;
    }
    const counts = { all: this.events.length, typed: 0, escalated: 0, waited: 0 };
    for (const e of this.events) {
      if (e.kind === "typed" || e.kind === "dry-run") counts.typed++;
      else if (e.kind === "escalated") counts.escalated++;
      else if (e.kind === "waited") counts.waited++;
    }
    const chip = (f: Filter, label: string, swatch: string, n: number): string =>
      `<button class="tp-act-chip${this.filter === f ? " is-active" : ""}" data-filter="${f}" type="button">
        ${swatch ? `<span class="sw sw-${swatch}"></span>` : ""}${label}<span class="n">${n}</span>
      </button>`;
    this.filtersEl.innerHTML =
      chip("all", "all", "", counts.all) +
      chip("typed", "typed", "ok", counts.typed) +
      chip("escalated", "escalated", "warn", counts.escalated) +
      chip("waited", "waited", "mute", counts.waited);
  }

  private renderList(now: number): void {
    if (this.events.length === 0) {
      this.listEl.innerHTML = `<div class="tp-activity-empty">No activity yet.</div>`;
      return;
    }

    // Newest-first for display.
    const events = this.events.slice().reverse();

    // Filter
    const filtered = events.filter((e) => {
      if (this.filter === "all") return true;
      if (this.filter === "typed") return e.kind === "typed" || e.kind === "dry-run";
      if (this.filter === "escalated") return e.kind === "escalated";
      if (this.filter === "waited") return e.kind === "waited";
      return true;
    });

    // Compute outlier cost threshold = ~p90 of nonzero costs, so only the
    // top tail surfaces in amber. With long-tail distributions, mean×2
    // catches too many rows; a percentile is more stable.
    const nonzeroCosts = filtered.map((e) => e.cost).filter((c) => c > 0).sort((a, b) => a - b);
    const outlierThreshold = nonzeroCosts.length > 0
      ? nonzeroCosts[Math.floor(nonzeroCosts.length * 0.9)] ?? Infinity
      : Infinity;

    // Group into render items: incidents | runs | singles.
    type Item =
      | { kind: "incident"; cycles: ActEvent[]; first: number; last: number; cost: number }
      | { kind: "run"; events: ActEvent[]; }
      | { kind: "single"; event: ActEvent };

    const items: Item[] = [];
    let i = 0;
    while (i < filtered.length) {
      // Try incident match starting here: escalated, typed-X, escalated, typed-X, …
      const ev = filtered[i]!;
      if (ev.kind === "escalated") {
        const cycles: ActEvent[] = [ev];
        let j = i + 1;
        let expectingTyped = true;
        let typedBody: string | null = null;
        while (j < filtered.length) {
          const next = filtered[j]!;
          if (Math.abs(ev.ts - next.ts) > INCIDENT_WINDOW_MS) break;
          if (expectingTyped) {
            if (next.kind !== "typed" && next.kind !== "dry-run") break;
            if (typedBody === null) typedBody = next.body;
            else if (next.body !== typedBody) break;
            cycles.push(next);
            expectingTyped = false;
          } else {
            if (next.kind !== "escalated") break;
            cycles.push(next);
            expectingTyped = true;
          }
          j++;
        }
        // Count escalate+typed pairs.
        const escCount = cycles.filter((c) => c.kind === "escalated").length;
        const typedCount = cycles.filter((c) => c.kind === "typed" || c.kind === "dry-run").length;
        const pairs = Math.min(escCount, typedCount);
        if (pairs >= INCIDENT_MIN_CYCLES) {
          const last = cycles[0]!.ts;
          const first = cycles[cycles.length - 1]!.ts;
          const cost = cycles.reduce((s, c) => s + c.cost, 0);
          items.push({ kind: "incident", cycles, first, last, cost });
          i += cycles.length;
          continue;
        }
      }

      // Try run-collapse: same kind+body within RUN_WINDOW_MS.
      const run: ActEvent[] = [ev];
      let k = i + 1;
      while (k < filtered.length) {
        const next = filtered[k]!;
        if (next.kind !== ev.kind || next.body !== ev.body) break;
        if (Math.abs(run[run.length - 1]!.ts - next.ts) > RUN_WINDOW_MS) break;
        run.push(next);
        k++;
      }
      if (run.length >= 2) {
        items.push({ kind: "run", events: run });
        i = k;
      } else {
        items.push({ kind: "single", event: ev });
        i++;
      }
    }

    // Emit with sticky time buckets.
    const out: string[] = [];
    let lastBucket = "";
    for (const item of items) {
      const ts = item.kind === "incident" ? item.last
        : item.kind === "run" ? item.events[0]!.ts
        : item.event.ts;
      const bucket = bucketLabel(ts, now);
      if (bucket !== lastBucket) {
        out.push(`<div class="tp-act-bucket">${bucket}</div>`);
        lastBucket = bucket;
      }
      if (item.kind === "incident") out.push(renderIncident(item.cycles, item.first, item.last, item.cost, now));
      else if (item.kind === "run") out.push(renderRun(item.events, now, outlierThreshold));
      else out.push(renderSingle(item.event, now, outlierThreshold));
    }
    this.listEl.innerHTML = out.join("");
  }
}

/* ── row renderers (module-scope, no class state needed) ─────────── */

/** NULL-safe operator chip for an activity row. Empty string when no
 *  operator name (pre-attribution rows / sessions with no operator). */
export function operatorChipHtml(name: string | null): string {
  if (!name) return "";
  return `<span class="tp-act-op">${escapeHtml(name)}</span>`;
}

function renderSingle(e: ActEvent, now: number, outlierThreshold: number): string {
  const cls = `tp-act-row tp-act-row--${e.kind}`;
  const time = relativeTime(e.ts, now);
  const { text, truncated } = truncate(e.body, 90);
  const bodyHtml = (e.kind === "typed" || e.kind === "dry-run")
    ? `<span class="tp-act-quote">${escapeHtml(text)}</span>`
    : escapeHtml(text);
  const costShow = e.cost > 0 && e.cost >= outlierThreshold;
  const costHtml = e.cost > 0
    ? `<span class="tp-act-cost${costShow ? " is-outlier" : ""}" title="$${e.cost.toFixed(4)}">$${e.cost.toFixed(3)}</span>`
    : `<span class="tp-act-cost"></span>`;
  const titleAttr = truncated ? ` title="${escapeHtml(e.body)}"` : "";
  return `
    <div class="${cls}"${titleAttr}>
      <span class="tp-act-time">${escapeHtml(time)}</span>
      <span class="tp-act-ico" aria-hidden="true">${iconFor(e.kind)}</span>
      <span class="tp-act-kind">${labelFor(e.kind)}</span>
      ${operatorChipHtml(e.operatorName)}
      <span class="tp-act-body">${bodyHtml}</span>
      ${costHtml}
    </div>
  `;
}

function renderRun(events: ActEvent[], now: number, outlierThreshold: number): string {
  const head = events[0]!;
  const cls = `tp-act-row tp-act-row--${head.kind} tp-act-row--run`;
  const time = relativeTime(head.ts, now);
  const totalCost = events.reduce((s, e) => s + e.cost, 0);
  const { text, truncated } = truncate(head.body, 80);
  const bodyHtml = (head.kind === "typed" || head.kind === "dry-run")
    ? `<span class="tp-act-quote">${escapeHtml(text)}</span>`
    : escapeHtml(text);
  const costShow = totalCost > 0 && totalCost >= outlierThreshold;
  const costHtml = totalCost > 0
    ? `<span class="tp-act-cost${costShow ? " is-outlier" : ""}">$${totalCost.toFixed(3)}</span>`
    : `<span class="tp-act-cost"></span>`;
  const titleAttr = truncated ? ` title="${escapeHtml(head.body)}"` : "";
  // Expanded detail: list each timestamp.
  const detail = events
    .map((e) => `<div class="tp-act-run-item">${escapeHtml(relativeTime(e.ts, now))}${e.cost > 0 ? ` · $${e.cost.toFixed(3)}` : ""}</div>`)
    .join("");
  return `
    <div class="${cls}"${titleAttr}>
      <span class="tp-act-time">${escapeHtml(time)}</span>
      <span class="tp-act-ico" aria-hidden="true">${iconFor(head.kind)}</span>
      <span class="tp-act-kind">${labelFor(head.kind)}</span>
      ${operatorChipHtml(head.operatorName)}
      <span class="tp-act-body">
        ${bodyHtml}
        <span class="tp-act-runpill">× ${events.length}</span>
        <button class="tp-act-expand" data-action="expand-run" type="button">expand</button>
      </span>
      ${costHtml}
      <div class="tp-act-run-detail">${detail}</div>
    </div>
  `;
}

function renderIncident(cycles: ActEvent[], first: number, last: number, cost: number, now: number): string {
  const escCount = cycles.filter((c) => c.kind === "escalated").length;
  const typedReply = cycles.find((c) => c.kind === "typed" || c.kind === "dry-run");
  const replyBody = typedReply?.body ?? "(no reply)";
  const { text: replyShort } = truncate(replyBody, 60);
  const span = `${relativeTime(first, now)}–${relativeTime(last, now)} ago · $${cost.toFixed(3)}`;
  const items = cycles
    .map((c) => `<div class="tp-act-incident-item">
      <span class="tp-act-time">${escapeHtml(relativeTime(c.ts, now))}</span>
      <span class="tp-act-ico" aria-hidden="true">${iconFor(c.kind)}</span>
      <span class="tp-act-kind">${labelFor(c.kind)}</span>
      <span class="tp-act-body">${escapeHtml(truncate(c.body, 80).text)}</span>
    </div>`)
    .join("");
  return `
    <div class="tp-act-incident">
      <div class="tp-act-incident-head">
        <span class="tp-act-incident-badge">loop</span>
        <span class="tp-act-incident-summary">Operator replied <strong>“${escapeHtml(replyShort)}”</strong> ${escCount}× — executor rejected each time</span>
        <span class="tp-act-incident-span">${escapeHtml(span)}</span>
      </div>
      <div class="tp-act-incident-body">
        <button type="button" data-action="incident-expand" class="tp-act-incident-toggle">Show ${cycles.length} events</button>
        <div class="tp-act-incident-detail">${items}</div>
      </div>
    </div>
  `;
}

function iconFor(kind: Kind): string {
  switch (kind) {
    case "typed":
    case "dry-run":
      return "◈";
    case "escalated":
      return "⚠";
    case "waited":
      return "⏸";
    case "startup":
      return "▶";
    default:
      return "·";
  }
}

function labelFor(kind: Kind): string {
  switch (kind) {
    case "typed": return "typed";
    case "dry-run": return "dry-run";
    case "escalated": return "escalated";
    case "waited": return "waited";
    case "startup": return "startup";
    default: return "action";
  }
}
