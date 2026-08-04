import { describe, expect, it } from "vitest";
import { buildSwitchVitals } from "./switch-vital";

/// 0.11.3 recorded the switch vital only for shell tabs (the ACP / browser /
/// pi early-returns in activate() precede the record call), and only measured
/// activate()-start → reveal rAF — which live measurement showed is 10-15ms
/// while the felt lag is elsewhere: the click waiting to be dispatched
/// (queuedMs) and the repaint after the reveal (repaintMs).

const base = {
  kind: "shell",
  elapsedMs: 12.34,
  repaintMs: 180.55,
  queuedMs: 44.4,
  starvedMs: 0,
  hiddenOutputBytes: 2048,
  hiddenOutputChunks: 3,
  tabCount: 13,
  fit: null,
  spannedHidden: false,
  frame1Ms: 42.2,
  gapStarvedMs: 3,
  grid: { cols: 210, rows: 58 },
  pressure: { bytesLast5s: 1_500_000, writersLast5s: 4 },
  focusedThroughout: true,
  mainLagMs: 12.6,
  gcdLagMs: 4.2,
  runloopModes: { default: 20, tracking: 1, notRunning: 0, other: 0 },
  mainPriMin: 46,
  timerLagMs: 7.8,
  keepaliveGapMs: 420,
};

describe("buildSwitchVitals", () => {
  it("emits a switch event and a repaint event", () => {
    const out = buildSwitchVitals(base);
    expect(out.map((e) => e.metric)).toEqual(["switch", "repaint"]);
    expect(out[0].value).toBe(12.3);
    expect(out[1].value).toBe(180.6);
  });

  it("carries starvation as the switch aux and the queue delay as the repaint aux", () => {
    const out = buildSwitchVitals({ ...base, starvedMs: 310 });
    expect(out[0].aux).toBe(310);
    expect(out[1].aux).toBe(44.4);
  });

  it("keeps aux null when starvation was unmeasurable (window not visible)", () => {
    const out = buildSwitchVitals({ ...base, starvedMs: null });
    expect(out[0].aux).toBeNull();
  });

  it("keeps the repaint aux null when the switch had no originating event", () => {
    const out = buildSwitchVitals({ ...base, queuedMs: null });
    expect(out[1].aux).toBeNull();
  });

  it("records non-terminal tab kinds, which 0.11.3 dropped entirely", () => {
    const out = buildSwitchVitals({ ...base, kind: "acp", fit: null });
    expect(out[0].detail.kind).toBe("acp");
    expect(out[0].detail).not.toHaveProperty("fitMs");
  });

  it("includes the geometry breadcrumb only for terminal tabs", () => {
    const out = buildSwitchVitals({
      ...base,
      fit: { fitMs: 3.21, nudgeMs: 1.5, colsDelta: -4, rowsDelta: 0, usedNudge: true, fitChangedDimensions: true },
    });
    expect(out[0].detail).toMatchObject({
      kind: "shell", fitMs: 3.2, nudgeMs: 1.5, colsDelta: -4, usedNudge: true,
    });
  });

  it("always carries the hidden-output context that correlated with the lag", () => {
    const out = buildSwitchVitals(base);
    for (const e of out) {
      expect(e.detail).toMatchObject({ hiddenOutputBytes: 2048, hiddenOutputChunks: 3, tabCount: 13 });
    }
  });

  it("puts the geometry breadcrumb on BOTH events — the repaint tail is the investigation surface", () => {
    const out = buildSwitchVitals({
      ...base,
      fit: { fitMs: 3.21, nudgeMs: 1.5, colsDelta: -4, rowsDelta: 0, usedNudge: true, fitChangedDimensions: true },
    });
    const repaint = out.find((e) => e.metric === "repaint");
    expect(repaint?.detail).toMatchObject({ fitMs: 3.2, colsDelta: -4 });
  });

  it("carries the gap discriminators and the grid on both events", () => {
    const out = buildSwitchVitals(base);
    for (const e of out) {
      expect(e.detail).toMatchObject({
        frame1Ms: 42.2, gapStarvedMs: 3, cols: 210, rows: 58, cells: 210 * 58,
      });
    }
  });

  it("carries global write pressure — the concurrent-agent trigger the user reports", () => {
    const out = buildSwitchVitals(base);
    for (const e of out) {
      expect(e.detail).toMatchObject({ writeBytesLast5s: 1_500_000, busyTabs: 4 });
    }
  });

  it("records focus continuity — recorded, never used to discard the sample", () => {
    const kept = buildSwitchVitals({ ...base, focusedThroughout: false });
    expect(kept.map((e) => e.metric)).toEqual(["switch", "repaint"]);
    for (const e of kept) expect(e.detail.focusedThroughout).toBe(false);
  });

  it("omits focus when it could not be determined", () => {
    const out = buildSwitchVitals({ ...base, focusedThroughout: null });
    expect(out[0].detail).not.toHaveProperty("focusedThroughout");
  });

  it("carries the native main-thread lag on both events — the A/B discriminator", () => {
    const out = buildSwitchVitals(base);
    for (const e of out) {
      expect(e.detail.mainLagMs).toBe(13);
      expect(e.detail.gcdLagMs).toBe(4);
    }
  });

  it("omits the main lag when the probe had no sample for the span", () => {
    const out = buildSwitchVitals({
      ...base,
      mainLagMs: null,
      gcdLagMs: null,
      runloopModes: null,
      mainPriMin: null,
    });
    expect(out[0].detail).not.toHaveProperty("mainLagMs");
    expect(out[0].detail).not.toHaveProperty("gcdLagMs");
    expect(out[0].detail).not.toHaveProperty("runloopModes");
    expect(out[0].detail).not.toHaveProperty("mainPriMin");
  });

  it("carries the runloop-mode histogram and min main-thread priority", () => {
    const out = buildSwitchVitals(base);
    for (const e of out) {
      expect(e.detail.runloopModes).toEqual({ default: 20, tracking: 1, notRunning: 0, other: 0 });
      expect(e.detail.mainPriMin).toBe(46);
      expect(e.detail.timerLagMs).toBe(8);
      expect(e.detail.keepaliveGapMs).toBe(420);
    }
  });

  it("omits pressure when it was not measured", () => {
    const out = buildSwitchVitals({ ...base, pressure: null });
    expect(out[0].detail).not.toHaveProperty("writeBytesLast5s");
    expect(out[0].detail).not.toHaveProperty("busyTabs");
  });

  it("omits gap fields that were not measured rather than reporting zero", () => {
    const out = buildSwitchVitals({ ...base, frame1Ms: null, gapStarvedMs: null, grid: null, pressure: null, focusedThroughout: null });
    expect(out[0].detail).not.toHaveProperty("frame1Ms");
    expect(out[0].detail).not.toHaveProperty("gapStarvedMs");
    expect(out[0].detail).not.toHaveProperty("cols");
  });

  it("omits the repaint event when the repaint frame never arrived", () => {
    const out = buildSwitchVitals({ ...base, repaintMs: null });
    expect(out.map((e) => e.metric)).toEqual(["switch"]);
  });

  // Real 0.11.4 data: a 3721ms switch whose synchronous work was 15ms and
  // whose post-reveal starvation was a healthy 12ms — the shape of "no
  // animation frame arrived". WebKit suspends rAF entirely while the window
  // is occluded, so an activation followed by an alt-tab produces the exact
  // same shape without anything being slow. Those samples must not pollute
  // the repaint percentiles.
  describe("when the window was not visible for the whole span", () => {
    it("drops the repaint event", () => {
      const out = buildSwitchVitals({ ...base, spannedHidden: true });
      expect(out.map((e) => e.metric)).toEqual(["switch"]);
    });

    it("still records the switch event, whose value is purely synchronous", () => {
      const out = buildSwitchVitals({ ...base, spannedHidden: true });
      expect(out[0].value).toBe(12.3);
    });

    it("leaves a trace so discarded samples are countable, not invisible", () => {
      const out = buildSwitchVitals({ ...base, spannedHidden: true });
      expect(out[0].detail.repaintDiscarded).toBe("window-not-visible");
    });

    it("adds no such flag on a clean sample", () => {
      const out = buildSwitchVitals(base);
      expect(out[0].detail).not.toHaveProperty("repaintDiscarded");
    });
  });
});
