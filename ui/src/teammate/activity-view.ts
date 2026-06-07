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
import { EventDetailDrawer } from "./event-detail-drawer";

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
  /// In-flight command + chrome-stripped output tail at decision time.
  /// Present on rows seeded from `listOperatorDecisions`; the live
  /// `operator-decision` IPC event may omit them.
  in_flight_command?: string | null;
  output_excerpt?: string | null;
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
  /// Human context for the origin chip when the tab is closed and its name
  /// was never cached — so we show "claude" / the mission name instead of a
  /// raw ULID short. Seeded from the persisted decision row; live events
  /// (always open tabs) resolve a real tab name and don't need these.
  mission?: string | null;
  executor?: string | null;
  /// Raw fields surfaced in the detail drawer. Captured at absorb time so
  /// the drawer renders from structured data, not the flattened `body`.
  executed?: boolean;
  inFlightCommand?: string | null;
  outputExcerpt?: string | null;
  replyText?: string | null;
  rationale?: string | null;
  escalation?: string | null;
  operatorName?: string | null;
  operatorId?: string | null;
  /// Full expandable detail (in-flight command + escalation/rationale +
  /// reply + output tail). Empty string when there is nothing to expand.
  detail?: string;
}

/* ── helpers ─────────────────────────────────────────────────────── */

const MAX_EVENTS = 500;
const RUN_WINDOW_MS = 120_000;       // collapse runs within 2 min
const INCIDENT_WINDOW_MS = 5 * 60_000; // 5 min
const INCIDENT_MIN_CYCLES = 2;       // ≥2 escalate+typed pairs

function shortSession(id: string): string {
  return id.length > 6 ? id.slice(-6) : id;
}

/// Last path segment of a mission path, sans extension — "spec.md" → "spec",
/// "/work/covenant/docs/x.md" → "x". The human label for a closed session.
function missionBasename(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? path;
  return base.replace(/\.[^.]+$/, "");
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

/// Build the full expandable detail string for a decision row. Surfaces
/// the context the collapsed feed truncates away: the in-flight command,
/// the full escalation text (escalate rows), the rationale, the typed
/// reply, and a tail of the chrome-stripped executor output. Returns the
/// empty string when there is nothing worth expanding.
export function detailForDecision(d: {
  kind: string;
  inFlightCommand?: string | null;
  escalation?: string | null;
  rationale?: string | null;
  replyText?: string | null;
  outputExcerpt?: string | null;
}): string {
  const parts: string[] = [];
  if (d.inFlightCommand) parts.push(`$ ${d.inFlightCommand}`);
  if (d.kind === "escalated" && d.escalation) parts.push(d.escalation);
  if (d.rationale) parts.push(d.rationale);
  if (d.replyText) parts.push(`reply: ${d.replyText}`);
  if (d.outputExcerpt) parts.push(d.outputExcerpt.slice(-400));
  return parts.join("\n");
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

/// Resolves a decision row's session back to its originating tab so each
/// event can show where it came from and (when still live) jump there.
/// Optional everywhere — in tests / headless there's no tab manager, so the
/// view degrades to the old anonymous rows.
export interface ActivityTabBridge {
  /// `name` + whether the tab is still open. Null when the short id has
  /// never been seen on this machine (no cached name).
  resolveSession(short: string): { name: string; open: boolean } | null;
  /// Focus the live tab for this session short. False if it's closed.
  focusSessionShort(short: string): boolean;
}

type Filter = "all" | "typed" | "escalated" | "waited";

/// Resolved origin for a render group, threaded into the row renderers.
type OriginTab = { short: string; name: string; open: boolean } | null;

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
  private bridge: ActivityTabBridge | null = null;
  /// When true, drop events whose originating session is closed (or unknown
  /// — i.e. no live tab and no cached name). Lets the user collapse the
  /// historical ledger down to only what's happening on live tabs.
  private hideClosed = false;
  private drawer: EventDetailDrawer | null = null;
  /// Representative event per rendered item, indexed by data-act-idx — so a
  /// row click can recover the full event to open the detail drawer.
  private rendered: ActEvent[] = [];

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
      const target = e.target as HTMLElement;
      const toggle = target.closest<HTMLElement>("[data-action='toggle-hide-closed']");
      if (toggle) {
        this.hideClosed = !this.hideClosed;
        this.scheduleRender();
        return;
      }
      const chip = target.closest<HTMLElement>("[data-filter]");
      if (!chip) return;
      const f = chip.dataset["filter"] as Filter;
      if (!f) return;
      this.filter = f;
      this.scheduleRender();
    });

    this.listEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      // Jump to the originating tab when its chip is clicked (live tabs only).
      const tabChip = target.closest<HTMLElement>("[data-session-short]");
      if (tabChip) {
        const short = tabChip.dataset["sessionShort"];
        if (short) this.bridge?.focusSessionShort(short);
        return;
      }
      // Inline sub-list expanders (run ×N timeline / loop-incident cycles)
      // toggle in place — they don't open the drawer.
      const runExpand = target.closest<HTMLElement>("[data-action='expand-run']");
      if (runExpand) {
        runExpand.closest<HTMLElement>(".tp-act-row")?.classList.toggle("tp-act-row--expanded");
        return;
      }
      const incidentExpand = target.closest<HTMLElement>("[data-action='incident-expand']");
      if (incidentExpand) {
        incidentExpand.closest<HTMLElement>(".tp-act-incident")?.classList.toggle("tp-act-incident--expanded");
        return;
      }
      // Otherwise, a click anywhere on the row opens its detail drawer.
      const rowEl = target.closest<HTMLElement>("[data-act-idx]");
      if (rowEl) {
        const idx = Number(rowEl.dataset["actIdx"]);
        const ev = this.rendered[idx];
        if (ev) this.openDetail(ev);
      }
    });
  }

  getElement(): HTMLElement {
    return this.el;
  }

  async start(
    operatorId: string,
    onBadge: ActivityBadgeCallback,
    bridge?: ActivityTabBridge,
  ): Promise<void> {
    this.operatorId = operatorId;
    this.onBadge = onBadge;
    this.bridge = bridge ?? null;
    // Drawer mounts over the workspace (document.body), jumps via the bridge.
    this.drawer = new EventDetailDrawer(
      document.body,
      (short) => this.bridge?.focusSessionShort(short) ?? false,
    );
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
    this.drawer?.close();
    if (this.renderTimer !== null) {
      window.clearInterval(this.renderTimer);
      this.renderTimer = null;
    }
  }

  /// Open the detail drawer for one event. Maps the normalized ActEvent into
  /// the drawer's structured input and resolves its origin chip + jump.
  private openDetail(e: ActEvent): void {
    const origin = this.resolveOrigin(e);
    this.drawer?.open(
      {
        ts: e.ts,
        kindLabel: labelFor(e.kind),
        kindClass: e.kind,
        cost: e.cost,
        executed: e.executed,
        action: e.rawAction,
        replyText: e.replyText ?? null,
        rationale: e.rationale ?? null,
        escalation: e.escalation ?? null,
        inFlightCommand: e.inFlightCommand ?? null,
        outputExcerpt: e.outputExcerpt ?? null,
        operatorName: e.operatorName ?? null,
        operatorId: e.operatorId ?? null,
      },
      {
        label: origin?.name ?? null,
        open: origin?.open ?? false,
        sessionShort: e.sessionShort,
      },
    );
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
    const escalation = r.escalation ?? null;
    const body = bodyForDecision(
      kind,
      r.reply_text ?? null,
      r.rationale ?? null,
      escalation,
    );
    this.events.push({
      ts: r.timestamp_unix_ms ?? 0,
      kind,
      rawAction: r.action,
      body,
      cost: (r as { cost_usd?: number }).cost_usd ?? 0,
      sessionShort: shortSession(r.session_id_short ?? ""),
      mission: r.mission_path ?? null,
      executor: r.executor_name ?? null,
      executed: r.executed,
      inFlightCommand: r.in_flight_command ?? null,
      outputExcerpt: r.output_excerpt ?? null,
      replyText: r.reply_text ?? null,
      rationale: r.rationale ?? null,
      escalation,
      operatorName: r.operator_name ?? null,
      operatorId: r.operator_id ?? null,
      detail: detailForDecision({
        kind,
        inFlightCommand: r.in_flight_command ?? null,
        escalation,
        rationale: r.rationale ?? null,
        replyText: r.reply_text ?? null,
        outputExcerpt: r.output_excerpt ?? null,
      }),
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
      executed: d.executed,
      inFlightCommand: d.in_flight_command ?? null,
      outputExcerpt: d.output_excerpt ?? null,
      replyText: d.reply_text,
      rationale: d.rationale,
      escalation: d.escalation,
      operatorName: d.operator_name ?? null,
      operatorId: d.operator_id ?? null,
      detail: detailForDecision({
        kind,
        inFlightCommand: d.in_flight_command ?? null,
        escalation: d.escalation,
        rationale: d.rationale,
        replyText: d.reply_text,
        outputExcerpt: d.output_excerpt ?? null,
      }),
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
    // "Hide closed" toggle — only meaningful when we can resolve a session's
    // liveness (bridge present). Lets the user strip the historical ledger of
    // dead-tab events down to what's happening on live tabs right now.
    const hideToggle = this.bridge
      ? `<button class="tp-act-chip tp-act-chip--toggle${this.hideClosed ? " is-active" : ""}" data-action="toggle-hide-closed" type="button">
          ${this.hideClosed ? "live tabs only" : "hide closed"}
        </button>`
      : "";
    this.filtersEl.innerHTML =
      chip("all", "all", "", counts.all) +
      chip("typed", "typed", "ok", counts.typed) +
      chip("escalated", "escalated", "warn", counts.escalated) +
      chip("waited", "waited", "mute", counts.waited) +
      hideToggle;
  }

  /// Resolve an event to a human-readable origin chip. Priority:
  ///   1. live/cached tab name (clickable when the tab is still open)
  ///   2. mission name (basename of the mission path)
  ///   3. executor name ("claude", "codex", …)
  /// Returns null when none of those exist — we omit the chip entirely
  /// rather than surface a raw ULID short, which means nothing to a human.
  private resolveOrigin(e: ActEvent): OriginTab {
    const short = e.sessionShort;
    const info = short ? (this.bridge?.resolveSession(short) ?? null) : null;
    if (info?.open) return { short, name: info.name, open: true };
    const human =
      info?.name ??
      (e.mission ? missionBasename(e.mission) : null) ??
      e.executor ??
      null;
    if (!human) return null;
    return { short, name: human, open: false };
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
      if (this.hideClosed && this.bridge) {
        // Drop events from closed/unknown sessions — keep only live tabs.
        if (!this.bridge.resolveSession(e.sessionShort)?.open) return false;
      }
      if (this.filter === "all") return true;
      if (this.filter === "typed") return e.kind === "typed" || e.kind === "dry-run";
      if (this.filter === "escalated") return e.kind === "escalated";
      if (this.filter === "waited") return e.kind === "waited";
      return true;
    });

    if (filtered.length === 0) {
      this.listEl.innerHTML = this.hideClosed
        ? `<div class="tp-activity-empty">No activity on live tabs.</div>`
        : `<div class="tp-activity-empty">No activity yet.</div>`;
      return;
    }

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

    // Emit with sticky time buckets. Each item is stamped with its index
    // into `this.rendered` so a row click can recover the full event.
    const out: string[] = [];
    let lastBucket = "";
    this.rendered = [];
    for (const item of items) {
      const ts = item.kind === "incident" ? item.last
        : item.kind === "run" ? item.events[0]!.ts
        : item.event.ts;
      const bucket = bucketLabel(ts, now);
      if (bucket !== lastBucket) {
        out.push(`<div class="tp-act-bucket">${bucket}</div>`);
        lastBucket = bucket;
      }
      const rep = item.kind === "incident" ? item.cycles[0]!
        : item.kind === "run" ? item.events[0]!
        : item.event;
      const idx = this.rendered.length;
      this.rendered.push(rep);
      const origin = this.resolveOrigin(rep);
      if (item.kind === "incident") out.push(renderIncident(item.cycles, item.first, item.last, item.cost, now, origin, idx));
      else if (item.kind === "run") out.push(renderRun(item.events, now, outlierThreshold, origin, idx));
      else out.push(renderSingle(item.event, now, outlierThreshold, origin, idx));
    }
    this.listEl.innerHTML = out.join("");
  }
}

/* ── row renderers (module-scope, no class state needed) ─────────── */

/// Origin-tab chip: the tab a decision came from. Live tabs are clickable
/// (data-session-short drives focus); closed tabs render muted + non-clickable
/// with a "closed" marker so the user can tell stale ledger from live work.
/// No native `title=` (project rule) — liveness is conveyed visually.
export function tabChipHtml(origin: OriginTab): string {
  if (!origin) return "";
  if (origin.open) {
    return `<span class="tp-act-tab" role="button" tabindex="0" data-session-short="${escapeHtml(origin.short)}">${escapeHtml(origin.name)}</span>`;
  }
  return `<span class="tp-act-tab tp-act-tab--closed">${escapeHtml(origin.name)}<span class="tp-act-tab-closed">closed</span></span>`;
}

function renderSingle(e: ActEvent, now: number, outlierThreshold: number, origin: OriginTab, idx: number): string {
  const cls = `tp-act-row tp-act-row--${e.kind} tp-act-row--clickable`;
  const time = relativeTime(e.ts, now);
  const { text, truncated } = truncate(e.body, 90);
  const bodyHtml = (e.kind === "typed" || e.kind === "dry-run")
    ? `<span class="tp-act-quote">${escapeHtml(text)}</span>`
    : escapeHtml(text);
  const costShow = e.cost > 0 && e.cost >= outlierThreshold;
  const costHtml = e.cost > 0
    ? `<span class="tp-act-cost${costShow ? " is-outlier" : ""}">$${e.cost.toFixed(3)}</span>`
    : `<span class="tp-act-cost"></span>`;
  const titleAttr = truncated ? ` title="${escapeHtml(e.body)}"` : "";
  // The full detail now lives in the click-to-open drawer, not an inline blob.
  return `
    <div class="${cls}"${titleAttr} data-act-idx="${idx}">
      <span class="tp-act-time">${escapeHtml(time)}</span>
      <span class="tp-act-ico" aria-hidden="true">${iconFor(e.kind)}</span>
      <span class="tp-act-kind">${labelFor(e.kind)}</span>
      <span class="tp-act-body">${bodyHtml}</span>
      ${tabChipHtml(origin)}
      ${costHtml}
    </div>
  `;
}

function renderRun(events: ActEvent[], now: number, outlierThreshold: number, origin: OriginTab, idx: number): string {
  const head = events[0]!;
  const cls = `tp-act-row tp-act-row--${head.kind} tp-act-row--run tp-act-row--clickable`;
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
    <div class="${cls}"${titleAttr} data-act-idx="${idx}">
      <span class="tp-act-time">${escapeHtml(time)}</span>
      <span class="tp-act-ico" aria-hidden="true">${iconFor(head.kind)}</span>
      <span class="tp-act-kind">${labelFor(head.kind)}</span>
      <span class="tp-act-body">
        ${bodyHtml}
        <span class="tp-act-runpill">× ${events.length}</span>
        <button class="tp-act-expand" data-action="expand-run" type="button">expand</button>
      </span>
      ${tabChipHtml(origin)}
      ${costHtml}
      <div class="tp-act-run-detail">${detail}</div>
    </div>
  `;
}

function renderIncident(cycles: ActEvent[], first: number, last: number, cost: number, now: number, origin: OriginTab, idx: number): string {
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
    <div class="tp-act-incident tp-act-row--clickable" data-act-idx="${idx}">
      <div class="tp-act-incident-head">
        <span class="tp-act-incident-badge">loop</span>
        <span class="tp-act-incident-summary">Operator replied <strong>“${escapeHtml(replyShort)}”</strong> ${escCount}× — executor rejected each time</span>
        ${tabChipHtml(origin)}
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
