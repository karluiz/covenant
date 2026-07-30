import { describe, expect, it } from "vitest";
import { resolveTabState, tabStateLabel, type TabStateInput } from "./tab-state";

const none: TabStateInput = {
  blocked: false,
  idleAgent: false,
  driving: false,
  serving: false,
  liveWorktree: false,
  shared: false,
};

describe("resolveTabState", () => {
  it("says nothing when nothing is happening", () => {
    expect(resolveTabState(none)).toEqual({ kind: null, all: [], extra: 0 });
  });

  it("maps each flag to its own state", () => {
    expect(resolveTabState({ ...none, blocked: true }).kind).toBe("attention");
    expect(resolveTabState({ ...none, idleAgent: true }).kind).toBe("waiting");
    expect(resolveTabState({ ...none, driving: true }).kind).toBe("driving");
    expect(resolveTabState({ ...none, serving: true }).kind).toBe("serving");
    expect(resolveTabState({ ...none, liveWorktree: true }).kind).toBe("live");
    expect(resolveTabState({ ...none, shared: true }).kind).toBe("shared");
  });

  it("gives the slot to the most severe state and counts the rest", () => {
    const st = resolveTabState({
      blocked: true,
      idleAgent: true,
      driving: true,
      serving: true,
      liveWorktree: true,
      shared: true,
    });
    expect(st.kind).toBe("attention");
    expect(st.extra).toBe(5);
    expect(st.all).toEqual([
      "attention",
      "waiting",
      "driving",
      "serving",
      "live",
      "shared",
    ]);
  });

  it("holds the ladder order pairwise", () => {
    // The one behavior that must not drift: a louder state always wins.
    expect(resolveTabState({ ...none, idleAgent: true, driving: true }).kind).toBe("waiting");
    expect(resolveTabState({ ...none, driving: true, serving: true }).kind).toBe("driving");
    expect(resolveTabState({ ...none, serving: true, liveWorktree: true }).kind).toBe("serving");
    expect(resolveTabState({ ...none, liveWorktree: true, shared: true }).kind).toBe("live");
  });

  it("reports every true state, so the tooltip can name the losers", () => {
    const st = resolveTabState({ ...none, serving: true, shared: true });
    expect(st.all).toEqual(["serving", "shared"]);
    expect(st.extra).toBe(1);
    expect(st.all.slice(1).map(tabStateLabel)).toEqual(["Sharing read-only"]);
  });
});
