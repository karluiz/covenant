import { describe, expect, it } from "vitest";
import { supervisionTooltip } from "./supervision-tooltip";
import type { GroupFinding } from "../convergence/findings";

const NOW = 1_700_000_000_000;

function finding(over: Partial<GroupFinding> = {}): GroupFinding {
  return {
    groupId: "g1",
    operatorName: "Zeta",
    message: "cockpit committed canon wave 3",
    atUnixMs: NOW - 12 * 60_000,
    ...over,
  };
}

function obj(c: ReturnType<typeof supervisionTooltip>) {
  if (typeof c === "string") throw new Error("expected structured content");
  return c;
}

describe("supervisionTooltip", () => {
  it("names the operator, the mode, the reach and the last thing it said", () => {
    const c = obj(
      supervisionTooltip({
        operatorName: "Zeta",
        intervene: false,
        tabCount: 4,
        findings: [finding()],
        nowMs: NOW,
      }),
    );
    expect(c.title).toBe("Zeta is supervising this group");
    expect(c.meta).toBe("Observes only · 4 tabs · 1 finding");
    expect(c.preview).toBe("“cockpit committed canon wave 3” — 12m ago");
    expect(c.kbd).toBe("⌘⇧M");
  });

  it("marks an intervening supervisor in amber — it can write to your tabs", () => {
    const c = obj(
      supervisionTooltip({
        operatorName: "Zeta",
        intervene: true,
        tabCount: 2,
        findings: [finding(), finding()],
        nowMs: NOW,
      }),
    );
    expect(c.meta).toBe("Decides for you · 2 tabs · 2 findings");
    expect(c.metaTone).toBe("warn");
  });

  it("an observer is never a warning", () => {
    const c = obj(
      supervisionTooltip({
        operatorName: "Zeta",
        intervene: false,
        tabCount: 1,
        findings: [],
        nowMs: NOW,
      }),
    );
    expect(c.metaTone).toBeUndefined();
    expect(c.meta).toBe("Observes only · 1 tab · no findings yet");
  });

  it("drops the quote block entirely when nothing has been said", () => {
    const c = obj(
      supervisionTooltip({
        operatorName: "Zeta",
        intervene: false,
        tabCount: 4,
        findings: [],
        nowMs: NOW,
      }),
    );
    expect(c.preview).toBeUndefined();
  });

  it("falls back to a bare title when the operator isn't cached, and drops an empty tab count", () => {
    const c = obj(
      supervisionTooltip({
        operatorName: null,
        intervene: false,
        tabCount: 0,
        findings: [],
        nowMs: NOW,
      }),
    );
    expect(c.title).toBe("Supervised");
    expect(c.meta).toBe("Observes only · no findings yet");
  });

  it("shows the NEWEST finding — the store is newest-first", () => {
    const c = obj(
      supervisionTooltip({
        operatorName: "Zeta",
        intervene: false,
        tabCount: 3,
        findings: [
          finding({ message: "newest", atUnixMs: NOW - 30_000 }),
          finding({ message: "older", atUnixMs: NOW - 3 * 3600_000 }),
        ],
        nowMs: NOW,
      }),
    );
    expect(c.preview).toBe("“newest” — 30s ago");
  });
});
