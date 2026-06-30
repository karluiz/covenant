// Status bar center-zone vitals cluster. Lives to the left of the
// executor chip. Subscribes to backend `vitals_update` events via
// `onVitalsUpdate` in api.ts; fades out after 60s idle.
//
// See docs/superpowers/specs/2026-05-18-statusbar-vitals-design.md for
// the full data + UX contract.

import type { Vitals } from "../api";
import { attachTooltip } from "../tooltip/tooltip";

/// Sparkline dimensions. 12 buckets, ~5px each + padding = ~60px wide.
const SPARK_W = 60;
const SPARK_H = 18;
const SPARK_PAD = 1;

/// Map a raw model id to a friendly display name. Prefix-match because
/// Anthropic appends date suffixes (e.g. `claude-haiku-4-5-20251001`).
export function prettifyModel(raw: string): string {
  const id = raw.toLowerCase();
  if (id.startsWith("claude-sonnet-4-6")) return "Sonnet 4.6";
  if (id.startsWith("claude-opus-4-7")) return "Opus 4.7";
  if (id.startsWith("claude-haiku-4-5")) return "Haiku 4.5";
  if (id.startsWith("claude-sonnet-4-5")) return "Sonnet 4.5";
  // Fallback: first 12 chars, capitalized.
  const trim = raw.slice(0, 12);
  return trim.charAt(0).toUpperCase() + trim.slice(1);
}

export function formatTokPerMin(n: number): string {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(1);
    return `${k}k tok/min`;
  }
  return `${n} tok/min`;
}

/// 0..=100 → CSS class suffix for the latency dot color.
export function latencyBand(ms: number): "ok" | "warn" | "bad" {
  if (ms <= 100) return "ok";
  if (ms <= 500) return "warn";
  return "bad";
}

/// Compact token count: 14370 → "14.4k", 980 → "980".
export function formatTokensShort(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
}

/// Context-fill % → color band. Executors auto-compact near ~95%, so
/// amber warns from 80% and red from 92%.
export function contextBand(pct: number): "ok" | "warn" | "bad" {
  if (pct >= 92) return "bad";
  if (pct >= 80) return "warn";
  return "ok";
}

/// Pill text for the context chip. `%` when the window is known, else the
/// absolute occupancy (pi/opencode on providers we can't size).
export function formatContext(tokens: number, pct: number | null): string {
  if (pct !== null) return `ctx ${pct}%`;
  return `ctx ${formatTokensShort(tokens)}`;
}

function renderSparkPath(spark: number[]): string {
  const max = Math.max(1, ...spark);
  const step = (SPARK_W - SPARK_PAD * 2) / (spark.length - 1);
  const pts: string[] = [];
  for (let i = 0; i < spark.length; i++) {
    const x = SPARK_PAD + i * step;
    const norm = spark[i] / max;
    const y = SPARK_H - SPARK_PAD - norm * (SPARK_H - SPARK_PAD * 2);
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return pts.join(" ");
}

export class VitalsCluster {
  readonly el: HTMLElement;
  private spark: SVGPolylineElement;
  private rateText: HTMLElement;
  private cachePill: HTMLElement;
  private ctxPill: HTMLElement;
  private modelPill: HTMLElement;
  private sep: HTMLElement;
  private latDot: HTMLElement;
  private latText: HTMLElement;

  /// Wall-clock ticker for in-flight elapsed (runs only while in-flight).
  /// Started/stopped from setVitals() depending on payload.in_flight.
  private inFlightTimer: number | null = null;

  constructor() {
    const el = document.createElement("div");
    el.className = "sb-vitals";
    el.setAttribute("aria-label", "LLM activity vitals");
    attachTooltip(
      el,
      "LLM activity — Covenant's internal calls (summarizer, fix-proposer, " +
        "operator triage) plus the active executor's calls when its " +
        "transcript is readable. Not strictly the executor's bill.",
    );

    // Sparkline.
    const svg = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "svg",
    );
    svg.setAttribute("class", "sb-vitals-spark");
    svg.setAttribute("viewBox", `0 0 ${SPARK_W} ${SPARK_H}`);
    svg.setAttribute("width", String(SPARK_W));
    svg.setAttribute("height", String(SPARK_H));
    svg.setAttribute("aria-hidden", "true");
    const poly = document.createElementNS(
      "http://www.w3.org/2000/svg",
      "polyline",
    );
    poly.setAttribute("class", "sb-vitals-spark__line");
    poly.setAttribute("fill", "none");
    poly.setAttribute("stroke", "currentColor");
    poly.setAttribute("stroke-width", "1.4");
    poly.setAttribute("stroke-linecap", "round");
    poly.setAttribute("stroke-linejoin", "round");
    svg.appendChild(poly);
    el.appendChild(svg);

    // Rate text.
    const rate = document.createElement("span");
    rate.className = "sb-vitals-rate";
    attachTooltip(
      rate,
      "Tokens per minute over the last 60s (input + output + cache_creation; " +
        "cache_read excluded).",
    );
    el.appendChild(rate);

    // Cache pill.
    const cache = document.createElement("span");
    cache.className = "sb-vitals-pill sb-vitals-pill--cache";
    attachTooltip(
      cache,
      "Cache hit rate over the last 5 minutes — cache_read / " +
        "(cache_read + input + cache_creation).",
    );
    el.appendChild(cache);

    // Context-window fill pill.
    const ctx = document.createElement("span");
    ctx.className = "sb-vitals-pill sb-vitals-pill--ctx";
    attachTooltip(
      ctx,
      "Context-window fill of the most recent call — prompt tokens " +
        "(input + cache) vs the model's window. Shows absolute tokens when " +
        "the provider's window isn't known. Amber ≥80%, red ≥92% " +
        "(executors auto-compact near 95%).",
    );
    el.appendChild(ctx);

    // Model pill.
    const model = document.createElement("span");
    model.className = "sb-vitals-pill sb-vitals-pill--model";
    attachTooltip(model, "Model of the most recent observed LLM call.");
    el.appendChild(model);

    // Separator (middle dot).
    const sep = document.createElement("span");
    sep.className = "sb-vitals-sep";
    sep.textContent = "·";
    sep.setAttribute("aria-hidden", "true");
    el.appendChild(sep);

    // Latency (dot + text).
    const latWrap = document.createElement("span");
    latWrap.className = "sb-vitals-lat";
    attachTooltip(
      latWrap,
      "Latency of the most recent observed LLM call. Green ≤100ms, " +
        "amber ≤500ms, red >500ms.",
    );
    const dot = document.createElement("span");
    dot.className = "sb-vitals-lat-dot";
    const latText = document.createElement("span");
    latText.className = "sb-vitals-lat-text";
    latWrap.appendChild(dot);
    latWrap.appendChild(latText);
    el.appendChild(latWrap);

    this.el = el;
    this.spark = poly;
    this.rateText = rate;
    this.cachePill = cache;
    this.ctxPill = ctx;
    this.modelPill = model;
    this.sep = sep;
    this.latDot = dot;
    this.latText = latText;
  }

  /// Public entry — called by main.ts on every `vitals_update` event.
  /// Synchronous: the backend already limits emits to ~1Hz (spec §5.3),
  /// so no additional UI throttling is needed.
  setVitals(v: Vitals): void {
    this.apply(v);
  }

  /// Disconnect timers. Call before discarding the instance.
  dispose(): void {
    this.stopInFlightTimer();
  }

  // -- internals -----------------------------------------------------------

  private apply(v: Vitals): void {
    // Idle: fade the whole cluster, skip per-chip updates. Treat an
    // in-flight call as active even if an older backend payload still
    // marks it idle (fresh sessions have no completed call yet).
    const effectivelyIdle = v.is_idle && v.in_flight === null;
    this.el.classList.toggle("is-idle", effectivelyIdle);
    if (effectivelyIdle) {
      this.stopInFlightTimer();
      return;
    }

    // Sparkline + rate (always shown when cluster visible).
    this.spark.setAttribute("points", renderSparkPath(v.spark));
    this.rateText.textContent = formatTokPerMin(v.tok_per_min);

    // Cache pill (omit when null).
    if (v.cache_hit_pct === null) {
      this.cachePill.classList.add("is-hidden");
    } else {
      this.cachePill.classList.remove("is-hidden");
      this.cachePill.textContent = `cache ${v.cache_hit_pct}%`;
    }

    // Context pill. Hidden until we've seen a call (context_tokens > 0).
    if (v.context_tokens <= 0) {
      this.ctxPill.classList.add("is-hidden");
    } else {
      this.ctxPill.classList.remove("is-hidden");
      this.ctxPill.textContent = formatContext(v.context_tokens, v.context_pct);
      const band = v.context_pct !== null ? contextBand(v.context_pct) : "ok";
      this.ctxPill.classList.remove(
        "sb-vitals-pill--ctx-ok",
        "sb-vitals-pill--ctx-warn",
        "sb-vitals-pill--ctx-bad",
      );
      this.ctxPill.classList.add(`sb-vitals-pill--ctx-${band}`);
    }

    // Model pill (omit when null). During a session's first in-flight
    // call, there may be no `last_model` yet; show the in-flight model
    // so the cluster doesn't look half-empty while the agent is working.
    const displayModel = v.last_model ?? v.in_flight?.model ?? null;
    if (displayModel === null) {
      this.modelPill.classList.add("is-hidden");
    } else {
      this.modelPill.classList.remove("is-hidden");
      this.modelPill.textContent = prettifyModel(displayModel);
    }

    // Latency or in-flight elapsed.
    if (v.in_flight !== null) {
      this.startInFlightTimer(v.in_flight.started_unix_ms);
      this.applyInFlight(v.in_flight.started_unix_ms);
    } else if (v.last_latency_ms !== null) {
      this.stopInFlightTimer();
      this.applyLatency(v.last_latency_ms);
    } else {
      this.stopInFlightTimer();
      this.latDot.className = "sb-vitals-lat-dot is-hidden";
      this.latText.textContent = "";
    }

    // Separator visibility — hide if both latency-side and pills-side
    // would collapse (defensive; rare).
    const hasRight =
      v.in_flight !== null || v.last_latency_ms !== null;
    this.sep.classList.toggle("is-hidden", !hasRight);
  }

  private applyLatency(ms: number): void {
    const band = latencyBand(ms);
    this.latDot.className = `sb-vitals-lat-dot sb-vitals-lat-dot--${band}`;
    this.latText.textContent = `${ms}ms`;
  }

  private applyInFlight(startedUnixMs: number): void {
    const elapsed = Date.now() - startedUnixMs;
    this.latDot.className = "sb-vitals-lat-dot sb-vitals-lat-dot--inflight";
    this.latText.textContent = `${(elapsed / 1000).toFixed(1)}s`;
  }

  private startInFlightTimer(startedUnixMs: number): void {
    if (this.inFlightTimer !== null) return;
    this.inFlightTimer = window.setInterval(() => {
      this.applyInFlight(startedUnixMs);
    }, 100);
  }

  private stopInFlightTimer(): void {
    if (this.inFlightTimer !== null) {
      window.clearInterval(this.inFlightTimer);
      this.inFlightTimer = null;
    }
  }
}
