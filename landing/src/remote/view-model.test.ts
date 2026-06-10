import { describe, it, expect } from "vitest";
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
