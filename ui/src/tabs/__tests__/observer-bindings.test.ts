import { describe, expect, it } from "vitest";
import {
  computeAddObserver,
  computeRemoveObserver,
  stripObserverOnPromote,
} from "../manager";

// The full TabsManager has dozens of constructor-time deps (xterm, Tauri
// IPC, status bar, …), so we test the observer logic via the pure helpers
// the manager methods delegate to. The wrapper methods (addObserver /
// removeObserver / setTabOperator) on TabsManager only add persistence +
// re-render + emit on top of these, which are exercised manually per the
// plan's Task 9.

describe("observer bindings — pure helpers", () => {
  it("computeAddObserver is idempotent", () => {
    const before = ["op-1"];
    const after = computeAddObserver(null, before, "op-1");
    expect(after).toBe(before); // same ref → no change
  });

  it("computeAddObserver appends a new observer", () => {
    const before = ["op-1"];
    const after = computeAddObserver(null, before, "op-2");
    expect(after).toEqual(["op-1", "op-2"]);
    expect(after).not.toBe(before);
  });

  it("computeAddObserver refuses the current primary writer", () => {
    const before: string[] = [];
    const after = computeAddObserver("op-1", before, "op-1");
    expect(after).toBe(before); // unchanged
    expect(after).not.toContain("op-1");
  });

  it("computeRemoveObserver is a no-op when not present", () => {
    const before: string[] = [];
    const after = computeRemoveObserver(before, "op-1");
    expect(after).toBe(before);
  });

  it("computeRemoveObserver drops the matching id", () => {
    const before = ["op-1", "op-2", "op-3"];
    const after = computeRemoveObserver(before, "op-2");
    expect(after).toEqual(["op-1", "op-3"]);
  });

  it("stripObserverOnPromote removes the new driver from observers", () => {
    expect(stripObserverOnPromote(["op-2", "op-3"], "op-2")).toEqual(["op-3"]);
  });

  it("stripObserverOnPromote is a no-op copy when driver wasn't observing", () => {
    const before = ["op-2", "op-3"];
    const after = stripObserverOnPromote(before, "op-4");
    expect(after).toEqual(["op-2", "op-3"]);
    expect(after).not.toBe(before); // fresh copy
  });

  it("stripObserverOnPromote returns a copy when demoting (null driver)", () => {
    const before = ["op-2", "op-3"];
    const after = stripObserverOnPromote(before, null);
    expect(after).toEqual(["op-2", "op-3"]);
    expect(after).not.toBe(before);
  });
});
