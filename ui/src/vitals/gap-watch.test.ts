import { describe, expect, it } from "vitest";
import { startGapWatch } from "./gap-watch";

function harness() {
  let t = 0;
  const queue: Array<() => void> = [];
  const watch = startGapWatch({
    tickMs: 16,
    now: () => t,
    schedule: (fn) => queue.push(fn),
  });
  return {
    watch,
    /// Advance the clock by `ms`, then run the next queued tick.
    tick: (ms: number) => {
      t += ms;
      queue.shift()?.();
    },
    pending: () => queue.length,
  };
}

describe("startGapWatch", () => {
  it("reports no starvation when ticks land on schedule", () => {
    const h = harness();
    h.tick(16);
    h.tick(16);
    h.tick(16);
    const r = h.watch.stop();
    expect(r.starvedMs).toBe(0);
    expect(r.ticks).toBe(3);
  });

  it("accumulates only the lateness beyond the tick interval", () => {
    const h = harness();
    h.tick(16);   // on time     → 0
    h.tick(400);  // 384ms late  → 384
    h.tick(16);   // on time     → 0
    expect(h.watch.stop().starvedMs).toBe(384);
  });

  // The discriminator: frames stalled while the event loop stayed responsive.
  it("reports ~zero starvation across a long gap of punctual ticks", () => {
    const h = harness();
    for (let i = 0; i < 60; i++) h.tick(16); // ~1s of healthy loop
    const r = h.watch.stop();
    expect(r.ticks).toBe(60);
    expect(r.starvedMs).toBe(0);
  });

  it("reports zero ticks when stopped before the first one fires", () => {
    const h = harness();
    const r = h.watch.stop();
    expect(r).toEqual({ starvedMs: 0, ticks: 0 });
  });

  it("stops rescheduling once stopped", () => {
    const h = harness();
    h.tick(16);
    expect(h.pending()).toBe(1);
    h.watch.stop();
    h.tick(16);            // the pending tick runs but must not re-arm
    expect(h.pending()).toBe(0);
  });
});
