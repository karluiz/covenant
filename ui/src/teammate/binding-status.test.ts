import { describe, expect, it } from "vitest";
import { describeBindings, type BoundTab } from "./binding-status";

const tab = (id: string, name: string, role: "driver" | "observer" = "driver"): BoundTab => ({
  tabId: id,
  tabName: name,
  role,
});

describe("describeBindings (Phase 1: single-op model, role always 'driver')", () => {
  it("returns idle when no tabs are bound", () => {
    const result = describeBindings([]);
    expect(result.kind).toBe("idle");
    expect(result.label).toBe("idle");
    expect(result.tabs).toEqual([]);
  });

  it("returns 'active on <tab>' for a single binding", () => {
    const result = describeBindings([tab("t1", "enhances")]);
    expect(result.kind).toBe("active");
    expect(result.label).toBe("active on enhances");
  });

  it("joins multiple tab names with commas and uses pluralized count", () => {
    const result = describeBindings([
      tab("t1", "enhances"),
      tab("t2", "hermes"),
    ]);
    expect(result.kind).toBe("active");
    expect(result.label).toBe("active on 2 tabs · enhances, hermes");
  });

  it("truncates long tab lists at 3 names + overflow count", () => {
    const result = describeBindings([
      tab("a", "alpha"), tab("b", "bravo"),
      tab("c", "charlie"), tab("d", "delta"), tab("e", "echo"),
    ]);
    expect(result.label).toBe("active on 5 tabs · alpha, bravo, charlie +2");
  });
});

describe("describeBindings (Phase 2: driver + observers)", () => {
  it.todo("returns 'driving X' when there's one driver and no observers");
});
