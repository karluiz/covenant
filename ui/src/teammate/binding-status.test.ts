import { describe, expect, it } from "vitest";
import { describeBindings, type BoundTab } from "./binding-status";

const tab = (
  id: string,
  name: string,
  role: "driver" | "observer" = "driver",
): BoundTab => ({
  tabId: id,
  tabName: name,
  role,
});

describe("describeBindings — idle and single-role shapes", () => {
  it("returns idle when no tabs are bound", () => {
    const result = describeBindings([]);
    expect(result.kind).toBe("idle");
    expect(result.label).toBe("idle");
    expect(result.tabs).toEqual([]);
  });

  it("returns 'driving X' for a single driver binding", () => {
    const result = describeBindings([tab("t1", "enhances")]);
    expect(result.kind).toBe("active");
    expect(result.label).toBe("driving enhances");
  });

  it("joins multiple driver tabs with commas", () => {
    const result = describeBindings([
      tab("t1", "enhances"),
      tab("t2", "hermes"),
    ]);
    expect(result.kind).toBe("active");
    expect(result.label).toBe("driving enhances, hermes");
  });

  it("truncates long driver lists at 3 names + overflow count", () => {
    const result = describeBindings([
      tab("a", "alpha"),
      tab("b", "bravo"),
      tab("c", "charlie"),
      tab("d", "delta"),
      tab("e", "echo"),
    ]);
    expect(result.label).toBe("driving alpha, bravo, charlie +2");
  });
});

describe("describeBindings — driver + observer voices", () => {
  it("returns 'observing X' when there's one observer and no driver", () => {
    expect(describeBindings([tab("t1", "enhances", "observer")]).label)
      .toBe("observing enhances");
  });

  it("joins driver and observer halves with the middle-dot separator", () => {
    const label = describeBindings([
      tab("t1", "enhances", "driver"),
      tab("t2", "hermes", "observer"),
      tab("t3", "scout", "observer"),
    ]).label;
    expect(label).toBe("driving enhances · observing hermes, scout");
  });

  it("marks the mixed case with kind 'driving-observing'", () => {
    const result = describeBindings([
      tab("t1", "enhances", "driver"),
      tab("t2", "hermes", "observer"),
    ]);
    expect(result.kind).toBe("driving-observing");
  });
});
