import { afterEach, describe, expect, it, vi } from "vitest";
import { VITALS_BUFFER_CAP, VITALS_FLUSH_MS, VitalsCollector, type VitalEvent } from "./collector";

describe("VitalsCollector", () => {
  afterEach(() => vi.useRealTimers());

  it("buffers records and flushes one batch after the interval", async () => {
    vi.useFakeTimers();
    const sent: VitalEvent[][] = [];
    const c = new VitalsCollector(async (ev) => { sent.push(ev); });
    c.record("switch", 42, 10, { colsDelta: 0 });
    c.record("input", 18);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(VITALS_FLUSH_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual([
      { metric: "switch", value_ms: 42, aux_ms: 10, detail: { colsDelta: 0 } },
      { metric: "input", value_ms: 18, aux_ms: null, detail: null },
    ]);
  });

  it("arms no timer while idle and re-arms per batch", () => {
    vi.useFakeTimers();
    const c = new VitalsCollector(async () => {});
    expect(vi.getTimerCount()).toBe(0);
    c.record("boot", 1200);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(VITALS_FLUSH_MS);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps the buffer, dropping oldest", () => {
    vi.useFakeTimers();
    const sent: VitalEvent[][] = [];
    const c = new VitalsCollector(async (ev) => { sent.push(ev); });
    for (let i = 0; i < VITALS_BUFFER_CAP + 5; i++) c.record("input", i);
    c.flush();
    expect(sent[0]).toHaveLength(VITALS_BUFFER_CAP);
    expect(sent[0][0].value_ms).toBe(5); // 0..4 dropped
  });

  it("swallows send failures", () => {
    vi.useFakeTimers();
    const c = new VitalsCollector(async () => { throw new Error("backend down"); });
    c.record("switch", 10);
    expect(() => c.flush()).not.toThrow();
  });
});
