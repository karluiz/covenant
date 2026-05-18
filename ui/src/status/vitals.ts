// Status bar center-zone vitals cluster. Lives to the left of the
// executor chip. Subscribes to backend `vitals_update` events via
// `onVitalsUpdate` in api.ts; fades out after 60s idle.
//
// See docs/superpowers/specs/2026-05-18-statusbar-vitals-design.md for
// the full data + UX contract.

import type { Vitals } from "../api";

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
    el.title =
      "LLM activity — Covenant's internal calls (summarizer, fix-proposer, " +
      "operator triage) plus the active executor's calls when its " +
      "transcript is readable. Not strictly the executor's bill.";

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
    rate.title =
      "Tokens per minute over the last 60s (input + output + cache_creation; " +
      "cache_read excluded).";
    el.appendChild(rate);

    // Cache pill.
    const cache = document.createElement("span");
    cache.className = "sb-vitals-pill sb-vitals-pill--cache";
    cache.title =
      "Cache hit rate over the last 5 minutes — cache_read / " +
      "(cache_read + input + cache_creation).";
    el.appendChild(cache);

    // Model pill.
    const model = document.createElement("span");
    model.className = "sb-vitals-pill sb-vitals-pill--model";
    model.title = "Model of the most recent observed LLM call.";
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
    latWrap.title =
      "Latency of the most recent observed LLM call. Green ≤100ms, " +
      "amber ≤500ms, red >500ms.";
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
    // Idle: fade the whole cluster, skip per-chip updates.
    this.el.classList.toggle("is-idle", v.is_idle);
    if (v.is_idle) {
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

    // Model pill (omit when null).
    if (v.last_model === null) {
      this.modelPill.classList.add("is-hidden");
    } else {
      this.modelPill.classList.remove("is-hidden");
      this.modelPill.textContent = prettifyModel(v.last_model);
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
