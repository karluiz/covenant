import { describe, it, expect, beforeEach } from "vitest";
import { RightRailController, type RailAdapters } from "./right-rail";

/** Recording fake — captures the exact adapter call sequence. */
function makeFake() {
  const calls: string[] = [];
  const adapters: RailAdapters = {
    open: (t) => calls.push(`open:${t}`),
    close: (t) => calls.push(`close:${t}`),
    setFolded: (f) => calls.push(`fold:${f}`),
    highlight: (t) => calls.push(`hi:${t ?? "none"}`),
  };
  return { calls, adapters };
}

describe("RightRailController", () => {
  let fake: ReturnType<typeof makeFake>;
  beforeEach(() => { fake = makeFake(); });

  it("toggle from folded opens target, unfolds, highlights it", () => {
    const c = new RightRailController(fake.adapters, null);
    fake.calls.length = 0;
    c.toggle("blocks");
    expect(c.target).toBe("blocks");
    expect(fake.calls).toEqual(["open:blocks", "fold:false", "hi:blocks"]);
  });

  it("toggle to a different target closes the old one first (exclusivity)", () => {
    const c = new RightRailController(fake.adapters, "blocks");
    fake.calls.length = 0;
    c.toggle("teammate");
    expect(c.target).toBe("teammate");
    expect(fake.calls).toEqual(["close:blocks", "open:teammate", "fold:false", "hi:teammate"]);
  });

  it("toggle on the active target folds and clears the highlight", () => {
    const c = new RightRailController(fake.adapters, "notes");
    fake.calls.length = 0;
    c.toggle("notes");
    expect(c.target).toBeNull();
    expect(fake.calls).toEqual(["close:notes", "fold:true", "hi:none"]);
  });

  it("toggleFold while open folds + clears, remembering the target", () => {
    const c = new RightRailController(fake.adapters, "tasker");
    fake.calls.length = 0;
    c.toggleFold();
    expect(c.target).toBeNull();
    expect(fake.calls).toEqual(["close:tasker", "fold:true", "hi:none"]);
  });

  it("toggleFold while folded restores the last target", () => {
    const c = new RightRailController(fake.adapters, "tasker");
    c.toggleFold();           // fold (remembers tasker)
    fake.calls.length = 0;
    c.toggleFold();           // restore
    expect(c.target).toBe("tasker");
    expect(fake.calls).toEqual(["open:tasker", "fold:false", "hi:tasker"]);
  });

  it("toggleFold while folded with no history restores blocks", () => {
    const c = new RightRailController(fake.adapters, null);
    fake.calls.length = 0;
    c.toggleFold();
    expect(c.target).toBe("blocks");
    expect(fake.calls).toEqual(["open:blocks", "fold:false", "hi:blocks"]);
  });

  it("clicking a toggle while folded unfolds with no stale target", () => {
    const c = new RightRailController(fake.adapters, "blocks");
    c.toggleFold();           // fold blocks
    fake.calls.length = 0;
    c.toggle("teammate");
    expect(c.target).toBe("teammate");
    expect(fake.calls).toEqual(["open:teammate", "fold:false", "hi:teammate"]);
  });

  it("handleExternalClose syncs state without re-closing the panel", () => {
    const c = new RightRailController(fake.adapters, "notes");
    fake.calls.length = 0;
    c.handleExternalClose("notes");   // panel closed itself
    expect(c.target).toBeNull();
    expect(fake.calls).toEqual(["fold:true", "hi:none"]); // no close:notes
  });

  it("handleExternalClose for a non-current target is a no-op", () => {
    const c = new RightRailController(fake.adapters, "blocks");
    fake.calls.length = 0;
    c.handleExternalClose("notes");
    expect(c.target).toBe("blocks");
    expect(fake.calls).toEqual([]);
  });

  it("syncView swaps highlight between blocks/structure without open/close", () => {
    const c = new RightRailController(fake.adapters, "blocks");
    fake.calls.length = 0;
    c.syncView("structure");
    expect(c.target).toBe("structure");
    expect(fake.calls).toEqual(["hi:structure"]);
  });

  it("syncView is a no-op when current is not a view", () => {
    const c = new RightRailController(fake.adapters, "teammate");
    fake.calls.length = 0;
    c.syncView("blocks");
    expect(c.target).toBe("teammate");
    expect(fake.calls).toEqual([]);
  });

  it("open() from folded opens the target (and does not fold on re-open)", () => {
    const c = new RightRailController(fake.adapters, null);
    fake.calls.length = 0;
    c.open("notes");
    expect(c.target).toBe("notes");
    expect(fake.calls).toEqual(["open:notes", "fold:false", "hi:notes"]);
    // Unlike toggle(), a second open() of the same target is a no-op, not a fold.
    fake.calls.length = 0;
    c.open("notes");
    expect(c.target).toBe("notes");
    expect(fake.calls).toEqual([]);
  });
});
