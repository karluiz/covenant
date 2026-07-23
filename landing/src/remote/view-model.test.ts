import { describe, it, expect } from "vitest";
import { splitTitle, phaseLabel, attentionSummary, groupTabs } from "./view-model";
import { sortTabs, resolveSelection, mirrorTransition } from "./view-model";
import type { TabInfo } from "./protocol";

function tab(sid: string, title: string, armed: boolean): TabInfo {
  return { session_id: sid, title, cwd: "~", executor: null, phase: "idle", armed };
}

describe("sortTabs", () => {
  it("puts armed tabs first", () => {
    const out = sortTabs([tab("s1", "Alpha › a", false), tab("s2", "Zeta › z", true)]);
    expect(out.map((t) => t.session_id)).toEqual(["s2", "s1"]);
  });
  it("sorts by title (case-insensitive) within the same armed state", () => {
    const out = sortTabs([tab("s1", "nxt › b", true), tab("s2", "COVENANT › a", true)]);
    expect(out.map((t) => t.session_id)).toEqual(["s2", "s1"]);
  });
  it("breaks title ties by session_id for determinism", () => {
    const out = sortTabs([tab("s2", "Same", true), tab("s1", "Same", true)]);
    expect(out.map((t) => t.session_id)).toEqual(["s1", "s2"]);
  });
  it("does not mutate the input array", () => {
    const input = [tab("s1", "b", false), tab("s2", "a", true)];
    sortTabs(input);
    expect(input[0].session_id).toBe("s1");
  });
});

describe("resolveSelection", () => {
  it("keeps the previous selection when its tab is still present (even unarmed)", () => {
    expect(resolveSelection("s1", [tab("s1", "a", false), tab("s2", "b", true)])).toBe("s1");
  });
  it("falls back to the first armed tab (sorted order) when the selection vanished", () => {
    expect(resolveSelection("gone", [tab("s1", "z", true), tab("s2", "a", true)])).toBe("s2");
  });
  it("selects the first armed tab when nothing was selected", () => {
    expect(resolveSelection(null, [tab("s1", "a", false), tab("s2", "b", true)])).toBe("s2");
  });
  it("returns null when no tab is armed", () => {
    expect(resolveSelection(null, [tab("s1", "a", false)])).toBeNull();
  });
  it("returns null for an empty tab list", () => {
    expect(resolveSelection("s1", [])).toBeNull();
  });
});

describe("mirrorTransition", () => {
  it("is a no-op when the armed selection is already mirrored and visible", () => {
    expect(mirrorTransition("s1", "s1", true, true)).toEqual({ stop: null, start: null });
  });
  it("starts when an armed tab is selected, visible, and nothing is mirrored", () => {
    expect(mirrorTransition(null, "s1", true, true)).toEqual({ stop: null, start: "s1" });
  });
  it("stops the old and starts the new when switching between armed tabs", () => {
    expect(mirrorTransition("s1", "s2", true, true)).toEqual({ stop: "s1", start: "s2" });
  });
  it("stops without starting when the new selection is not armed", () => {
    expect(mirrorTransition("s1", "s2", false, true)).toEqual({ stop: "s1", start: null });
  });
  it("stops when the detail pane is not visible (mobile list view)", () => {
    expect(mirrorTransition("s1", "s1", true, false)).toEqual({ stop: "s1", start: null });
  });
  it("stops when the selection is cleared", () => {
    expect(mirrorTransition("s1", null, false, true)).toEqual({ stop: "s1", start: null });
  });
  it("does nothing when not mirroring and detail is hidden", () => {
    expect(mirrorTransition(null, "s1", true, false)).toEqual({ stop: null, start: null });
  });
});


function ptab(sid: string, title: string, phase: string, armed = false): TabInfo {
  return { session_id: sid, title, cwd: "~", executor: "claude", phase, armed };
}

describe("attention ordering", () => {
  it("a waiting tab outranks a running one, unarmed", () => {
    const out = sortTabs([ptab("run", "b", "running"), ptab("wait", "a", "waiting")]);
    expect(out[0].session_id).toBe("wait");
  });
  it("armed still beats phase — an armed idle tab sits above an unarmed waiting one", () => {
    const out = sortTabs([ptab("wait", "a", "waiting", false), ptab("armed", "z", "idle", true)]);
    expect(out[0].session_id).toBe("armed");
  });
  it("orders the full urgency ladder waiting→done→running→thinking→idle", () => {
    const out = sortTabs([
      ptab("idle", "a", "idle"), ptab("think", "a", "thinking"),
      ptab("run", "a", "running"), ptab("done", "a", "done"), ptab("wait", "a", "waiting"),
    ]);
    expect(out.map((t) => t.session_id)).toEqual(["wait", "done", "run", "think", "idle"]);
  });
});

describe("splitTitle", () => {
  it("splits GROUP › leaf on the real separator", () => {
    expect(splitTitle("COVENANT › agent-claude-0722")).toEqual({ group: "COVENANT", leaf: "agent-claude-0722" });
  });
  it("returns a null group for an ungrouped title", () => {
    expect(splitTitle("app")).toEqual({ group: null, leaf: "app" });
  });
});

describe("phaseLabel", () => {
  it("maps waiting to the fail/attention tone", () => {
    expect(phaseLabel("waiting")).toEqual({ text: "waiting", tone: "wait" });
  });
  it("maps writing/reading to the run tone (they are activity)", () => {
    expect(phaseLabel("writing").tone).toBe("run");
    expect(phaseLabel("reading").tone).toBe("run");
  });
});

describe("attentionSummary", () => {
  it("names only the non-empty buckets, urgent first", () => {
    const tabs = [
      ptab("a", "x", "waiting"), ptab("b", "x", "waiting"),
      ptab("c", "x", "done"), ptab("d", "x", "running"),
      ...Array.from({ length: 15 }, (_, i) => ptab("i" + i, "x", "idle")),
    ];
    expect(attentionSummary(tabs)).toBe("2 waiting · 1 done · 1 active · 15 idle");
  });
  it("says 'no tabs' when empty", () => {
    expect(attentionSummary([])).toBe("no tabs");
  });
});

describe("groupTabs", () => {
  it("buckets by prefix and floats the group with the most urgent tab up", () => {
    const groups = groupTabs([
      ptab("d1", "Drama › damn", "idle"),
      ptab("c1", "COVENANT › a", "idle"),
      ptab("c2", "COVENANT › b", "waiting"),  // pulls COVENANT above Drama
    ]);
    expect(groups[0].key).toBe("COVENANT");
    expect(groups[0].active).toBe(1);
  });
  it("puts ungrouped tabs in a '' group", () => {
    const groups = groupTabs([ptab("a", "app", "idle")]);
    expect(groups[0].key).toBe("");
  });
});
