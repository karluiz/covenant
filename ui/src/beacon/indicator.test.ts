// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { beaconWorkflowRuns } = vi.hoisted(() => ({
  beaconWorkflowRuns: vi.fn(),
}));
vi.mock("../api", () => ({ beaconWorkflowRuns }));

import { aggregateRuns, BeaconIndicator } from "./indicator";
import type { BeaconState } from "../api";

const r = (id: number, state: string) => ({ id, state });

describe("aggregateRuns", () => {
  it("busy wins over everything", () => {
    const { agg } = aggregateRuns([r(2, "in_progress"), r(1, "failure")], null, false);
    expect(agg).toBe("busy");
  });

  it("unacked failure flags fail; acked failure stays quiet", () => {
    expect(aggregateRuns([r(9, "failure"), r(1, "success")], null, false).agg).toBe("fail");
    expect(aggregateRuns([r(9, "failure"), r(1, "success")], 9, false).agg).toBe("quiet");
  });

  it("a NEW failure re-flags even after an older ack", () => {
    expect(aggregateRuns([r(10, "failure")], 9, false).agg).toBe("fail");
  });

  it("busy → all green transitions to ok (flash), then quiet", () => {
    expect(aggregateRuns([r(1, "success")], null, true).agg).toBe("ok");
    expect(aggregateRuns([r(1, "success")], null, false).agg).toBe("quiet");
  });
});

describe("BeaconIndicator", () => {
  let btn: HTMLElement;
  beforeEach(() => {
    vi.useFakeTimers();
    btn = document.createElement("button");
  });
  afterEach(() => vi.useRealTimers());

  const okState = (runs: { id: number; state: string }[]): BeaconState =>
    ({ kind: "ok", repo: "o/r", runs } as BeaconState);

  it("feed() applies is-busy / is-fail classes", () => {
    const ind = new BeaconIndicator(btn, () => "/repo");
    ind.feed(okState([r(1, "in_progress")]));
    expect(btn.classList.contains("is-busy")).toBe(true);
    ind.feed(okState([r(1, "failure")]));
    expect(btn.classList.contains("is-busy")).toBe(false);
    expect(btn.classList.contains("is-fail")).toBe(true);
  });

  it("opening the panel acknowledges the failure", () => {
    const ind = new BeaconIndicator(btn, () => "/repo");
    ind.feed(okState([r(5, "failure")]));
    expect(btn.classList.contains("is-fail")).toBe(true);
    ind.setPanelOpen(true);
    expect(btn.classList.contains("is-fail")).toBe(false);
    // Same failure doesn't re-flag on the next feed…
    ind.feed(okState([r(5, "failure")]));
    expect(btn.classList.contains("is-fail")).toBe(false);
    // …but a new one does.
    ind.setPanelOpen(false);
    ind.feed(okState([r(6, "failure")]));
    expect(btn.classList.contains("is-fail")).toBe(true);
  });

  it("busy → success flashes is-ok, then clears after 5s", () => {
    const ind = new BeaconIndicator(btn, () => "/repo");
    ind.feed(okState([r(1, "in_progress")]));
    ind.feed(okState([r(1, "success")]));
    expect(btn.classList.contains("is-ok")).toBe(true);
    vi.advanceTimersByTime(5100);
    expect(btn.classList.contains("is-ok")).toBe(false);
  });

  it("non-ok states go quiet without classes", () => {
    const ind = new BeaconIndicator(btn, () => "/repo");
    ind.feed(okState([r(1, "in_progress")]));
    ind.feed({ kind: "not_authed" } as BeaconState);
    expect(btn.className).toBe("");
  });
});
