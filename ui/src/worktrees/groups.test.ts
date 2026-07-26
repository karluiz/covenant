import { describe, it, expect } from "vitest";
import { groupWorktrees, spentReclaimPaths } from "./groups";
import type { GitWorktreeSummary } from "../api";

function wt(over: Partial<GitWorktreeSummary>): GitWorktreeSummary {
  return {
    path: "/w", branch: "b", head: "abc", current: false, detached: false,
    bare: false, dirty_count: 0, state: "active", merged: false,
    last_commit_unix: null, off_convention: false, is_main: false, locked: null,
    ...over,
  };
}

describe("groupWorktrees", () => {
  it("orders groups spent→stale→orphan→active, omits empty, sorts size-desc", () => {
    const wts = [
      wt({ path: "/act", state: "active" }),
      wt({ path: "/sp-small", state: "spent" }),
      wt({ path: "/sp-big", state: "spent" }),
      wt({ path: "/st", state: "stale" }),
    ];
    const sizes = new Map([
      ["/act", { total: 100, target: 0 }],
      ["/sp-small", { total: 10, target: 0 }],
      ["/sp-big", { total: 90, target: 0 }],
      ["/st", { total: 50, target: 0 }],
    ]);
    const groups = groupWorktrees(wts, sizes);
    expect(groups.map((g) => g.state)).toEqual(["spent", "stale", "active"]);
    expect(groups[0].worktrees.map((w) => w.path)).toEqual(["/sp-big", "/sp-small"]);
    expect(groups[0].totalKb).toBe(100);
  });

  it("reports totalKb null until every member size is loaded, missing-size rows last", () => {
    const wts = [wt({ path: "/a", state: "spent" }), wt({ path: "/b", state: "spent" })];
    const sizes = new Map([["/b", { total: 5, target: 0 }]]);
    const groups = groupWorktrees(wts, sizes);
    expect(groups[0].totalKb).toBeNull();
    expect(groups[0].worktrees.map((w) => w.path)).toEqual(["/b", "/a"]);
  });
});

describe("spentReclaimPaths", () => {
  it("returns spent paths, excluding current and main", () => {
    const wts = [
      wt({ path: "/sp", state: "spent" }),
      wt({ path: "/sp-here", state: "spent", current: true }),
      wt({ path: "/sp-main", state: "spent", is_main: true }),
      wt({ path: "/act", state: "active" }),
    ];
    expect(spentReclaimPaths(wts)).toEqual(["/sp"]);
  });
});
