import { describe, it, expect } from "vitest";
import { branchFact } from "./format";
import type { GitWorktreeSummary } from "../api";

function wt(over: Partial<GitWorktreeSummary>): GitWorktreeSummary {
  return {
    path: "/w", branch: "agent/x", head: "abc", current: false, detached: false,
    bare: false, dirty_count: 0, state: "active", merged: false,
    last_commit_unix: null, off_convention: false, is_main: false, locked: null,
    ...over,
  };
}

describe("branchFact", () => {
  it("explains WHY a spent worktree is safe", () => {
    expect(branchFact(wt({ state: "spent", merged: true }), "main")).toBe("merged into main");
    expect(branchFact(wt({ state: "spent", merged: false, branch: null }), "main")).toBe("deleted upstream");
  });
  it("falls back to the branch name otherwise, null for main", () => {
    expect(branchFact(wt({}), "main")).toBe("agent/x");
    expect(branchFact(wt({ branch: null, detached: true }), "main")).toBe("detached");
    expect(branchFact(wt({ is_main: true, branch: "main" }), "main")).toBeNull();
  });
});
