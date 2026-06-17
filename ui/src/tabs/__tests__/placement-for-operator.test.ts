import { describe, expect, it } from "vitest";
import { resolveOperatorPlacement } from "../manager";

describe("resolveOperatorPlacement — pure helper", () => {
  const rows = [
    { operator: "op-A", cwd: "/work/a", groupId: "g1", color: "#111" },
    { operator: null,   cwd: "/work/x", groupId: null, color: null },
    { operator: "op-B", cwd: "/work/b", groupId: "g2", color: "#222" },
  ];

  it("returns the placement of the tab driven by the operator", () => {
    expect(resolveOperatorPlacement(rows, "op-B")).toEqual({
      cwd: "/work/b", groupId: "g2", color: "#222",
    });
  });

  it("returns null when no tab is driven by that operator", () => {
    expect(resolveOperatorPlacement(rows, "op-Z")).toBeNull();
  });

  it("returns the first match when the operator drives multiple tabs", () => {
    const multi = [
      { operator: "op-A", cwd: "/first", groupId: "g1", color: "#1" },
      { operator: "op-A", cwd: "/second", groupId: "g2", color: "#2" },
    ];
    expect(resolveOperatorPlacement(multi, "op-A")?.cwd).toBe("/first");
  });
});
