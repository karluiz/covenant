// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import {
  VitalsCluster,
  prettifyModel,
  formatTokPerMin,
  latencyBand,
} from "./vitals";
import type { Vitals } from "../api";

function fixture(overrides: Partial<Vitals> = {}): Vitals {
  return {
    tok_per_min: 0,
    spark: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    cache_hit_pct: null,
    last_model: null,
    last_latency_ms: null,
    in_flight: null,
    idle_secs: 0,
    is_idle: false,
    ...overrides,
  };
}

describe("prettifyModel", () => {
  it("maps known prefixes", () => {
    expect(prettifyModel("claude-sonnet-4-6")).toBe("Sonnet 4.6");
    expect(prettifyModel("claude-opus-4-7")).toBe("Opus 4.7");
    expect(prettifyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
  });
  it("falls back gracefully on unknown ids", () => {
    expect(prettifyModel("gpt-4-turbo")).toBe("Gpt-4-turbo");
  });
});

describe("formatTokPerMin", () => {
  it("uses k-suffix above 1000", () => {
    expect(formatTokPerMin(1200)).toBe("1.2k tok/min");
    expect(formatTokPerMin(950)).toBe("950 tok/min");
  });
});

describe("latencyBand", () => {
  it("maps ms to color band", () => {
    expect(latencyBand(50)).toBe("ok");
    expect(latencyBand(300)).toBe("warn");
    expect(latencyBand(800)).toBe("bad");
  });
});

describe("VitalsCluster rendering", () => {
  it("hides cache pill when cache_hit_pct is null", () => {
    const c = new VitalsCluster();
    c.setVitals(fixture({ tok_per_min: 100, last_model: "claude-sonnet-4-6" }));
    const pill = c.el.querySelector(".sb-vitals-pill--cache");
    expect(pill?.classList.contains("is-hidden")).toBe(true);
  });

  it("shows cache pill with formatted percent", () => {
    const c = new VitalsCluster();
    c.setVitals(
      fixture({ tok_per_min: 100, last_model: "m", cache_hit_pct: 78 }),
    );
    const pill = c.el.querySelector(".sb-vitals-pill--cache");
    expect(pill?.classList.contains("is-hidden")).toBe(false);
    expect(pill?.textContent).toBe("cache 78%");
  });

  it("toggles is-idle class", () => {
    const c = new VitalsCluster();
    c.setVitals(fixture({ is_idle: true, idle_secs: 120 }));
    expect(c.el.classList.contains("is-idle")).toBe(true);
  });

  it("recomputes latency dot color band", () => {
    const c = new VitalsCluster();
    c.setVitals(fixture({ tok_per_min: 1, last_latency_ms: 50, last_model: "m" }));
    expect(c.el.querySelector(".sb-vitals-lat-dot--ok")).not.toBeNull();

    c.setVitals(fixture({ tok_per_min: 1, last_latency_ms: 300, last_model: "m" }));
    expect(c.el.querySelector(".sb-vitals-lat-dot--warn")).not.toBeNull();

    c.setVitals(fixture({ tok_per_min: 1, last_latency_ms: 800, last_model: "m" }));
    expect(c.el.querySelector(".sb-vitals-lat-dot--bad")).not.toBeNull();

    c.dispose();
  });
});
