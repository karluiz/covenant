import { describe, expect, it } from "vitest";
import { probePostRevealStarvation } from "./starvation";

/// The shipped 0.11.3 probe chained plain setTimeouts with no visibility
/// check. WebKit throttles background timers to ~1s, so every switch
/// followed by an alt-tab recorded ~18s of starvation that never happened
/// (observed live: spikes pegged at 1013/965/963ms — the throttle, not the
/// main thread). A sample taken while the window is not visible is
/// unmeasurable, so it must come back null instead of fabricated.
function harness(visibleSequence: boolean[]) {
  let t = 0;
  const queue: Array<{ fn: () => void; ms: number }> = [];
  let visIdx = 0;
  const results: Array<number | null> = [];
  probePostRevealStarvation((v) => results.push(v), {
    tickMs: 50,
    ticks: 4,
    now: () => t,
    schedule: (fn, ms) => queue.push({ fn, ms }),
    isVisible: () => visibleSequence[Math.min(visIdx++, visibleSequence.length - 1)],
  });
  const advance = (byMs: number): void => {
    const next = queue.shift();
    if (!next) return;
    t += byMs;
    next.fn();
  };
  return { results, advance, pending: () => queue.length };
}

describe("probePostRevealStarvation", () => {
  it("reports zero starvation when every tick lands on time", () => {
    const h = harness([true, true, true, true, true]);
    for (let i = 0; i < 4; i++) h.advance(50);
    expect(h.results).toEqual([0]);
  });

  it("sums only the drift beyond the tick interval", () => {
    const h = harness([true, true, true, true, true]);
    h.advance(50);   // on time      → 0
    h.advance(250);  // 200ms late   → 200
    h.advance(50);   // on time      → 0
    h.advance(130);  // 80ms late    → 80
    expect(h.results).toEqual([280]);
  });

  it("returns null when the window stops being visible mid-probe", () => {
    const h = harness([true, true, false, true, true]);
    h.advance(50);
    h.advance(50);
    h.advance(1000); // would have looked like 950ms of starvation
    expect(h.results).toEqual([null]);
  });

  it("returns null immediately when the window is not visible at the start", () => {
    const h = harness([false]);
    h.advance(50);
    expect(h.results).toEqual([null]);
  });

  it("stops scheduling once it has reported", () => {
    const h = harness([true, true, false]);
    h.advance(50);
    h.advance(50);
    h.advance(50); // third tick sees a non-visible window and reports
    expect(h.results).toEqual([null]);
    expect(h.pending()).toBe(0);
    h.advance(50); // nothing left to run — no second report
    expect(h.results).toEqual([null]);
  });
});
