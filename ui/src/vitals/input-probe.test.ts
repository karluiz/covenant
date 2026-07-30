import { describe, expect, it } from "vitest";
import {
  INPUT_SAMPLE_MIN_INTERVAL_MS,
  INPUT_SAMPLE_TIMEOUT_MS,
  InputLatencyProbe,
  isPrintableKey,
} from "./input-probe";

function makeProbe(start = 0) {
  let t = start;
  const samples: Array<{ value: number; aux: number }> = [];
  const probe = new InputLatencyProbe({
    now: () => t,
    onSample: (value, aux) => samples.push({ value, aux }),
  });
  return { probe, samples, tick: (ms: number) => { t += ms; } };
}

describe("InputLatencyProbe", () => {
  it("samples keystroke → echo arrival (aux) → painted (value)", () => {
    const { probe, samples, tick } = makeProbe();
    probe.onKeystroke("s1", true, true);
    tick(12); // PTY round trip
    const done = probe.onOutputChunk("s1");
    expect(done).toBeTypeOf("function");
    tick(8); // parse + paint
    done!();
    expect(samples).toEqual([{ value: 20, aux: 12 }]);
  });

  it("ignores keystrokes when not at a prompt or not printable", () => {
    const { probe } = makeProbe();
    probe.onKeystroke("s1", false, true);
    expect(probe.onOutputChunk("s1")).toBeNull();
    probe.onKeystroke("s1", true, false);
    expect(probe.onOutputChunk("s1")).toBeNull();
  });

  it("rate-limits to one sample per second", () => {
    const { probe, samples, tick } = makeProbe();
    probe.onKeystroke("s1", true, true);
    probe.onOutputChunk("s1")!();
    tick(INPUT_SAMPLE_MIN_INTERVAL_MS - 1);
    probe.onKeystroke("s1", true, true);
    expect(probe.onOutputChunk("s1")).toBeNull(); // still rate-limited
    tick(2);
    probe.onKeystroke("s1", true, true);
    probe.onOutputChunk("s1")!();
    expect(samples).toHaveLength(2);
  });

  it("discards echoes past the timeout (busy shell, not an echo)", () => {
    const { probe, samples, tick } = makeProbe();
    probe.onKeystroke("s1", true, true);
    tick(INPUT_SAMPLE_TIMEOUT_MS + 1);
    expect(probe.onOutputChunk("s1")).toBeNull();
    expect(samples).toEqual([]);
  });

  it("discards a paint that lands past the timeout", () => {
    const { probe, samples, tick } = makeProbe();
    probe.onKeystroke("s1", true, true);
    tick(100);
    const done = probe.onOutputChunk("s1")!;
    tick(INPUT_SAMPLE_TIMEOUT_MS); // paint way too late
    done();
    expect(samples).toEqual([]);
  });

  it("only matches output from the sampled session", () => {
    const { probe } = makeProbe();
    probe.onKeystroke("s1", true, true);
    expect(probe.onOutputChunk("other")).toBeNull();
    expect(probe.onOutputChunk("s1")).toBeTypeOf("function");
  });

  it("cancel() drops the in-flight sample (tab switch)", () => {
    const { probe, samples } = makeProbe();
    probe.onKeystroke("s1", true, true);
    probe.cancel();
    expect(probe.onOutputChunk("s1")).toBeNull();
    expect(samples).toEqual([]);
  });
});

describe("isPrintableKey", () => {
  it("accepts single printable chars, rejects control/multi-byte sequences", () => {
    expect(isPrintableKey("a")).toBe(true);
    expect(isPrintableKey(" ")).toBe(true);
    expect(isPrintableKey("\x1b[A")).toBe(false); // arrow key
    expect(isPrintableKey("\r")).toBe(false);
    expect(isPrintableKey("\x7f")).toBe(false); // backspace/DEL
    expect(isPrintableKey("ab")).toBe(false); // paste
  });
});
