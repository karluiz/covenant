import { describe, expect, it } from "vitest";
import { worktreeStateLabel, worktreeStateClass, worktreeDefaultAction } from "./worktree-state";

const wt = (over: Partial<Parameters<typeof worktreeDefaultAction>[0]> = {}) => ({
  path: "/repo/.covenant/worktrees/x",
  branch: "x",
  head: "abc",
  current: false,
  detached: false,
  bare: false,
  dirty_count: 0,
  state: "spent" as const,
  merged: true,
  last_commit_unix: 0,
  off_convention: false,
  ...over,
});

describe("worktree state presentation", () => {
  it("never labels a spent worktree as clean", () => {
    expect(worktreeStateLabel("spent")).toBe("spent");
    expect(worktreeStateLabel("spent")).not.toBe("clean");
  });

  it("gives each state its own dot class", () => {
    const classes = (["active", "stale", "spent", "orphan"] as const).map(worktreeStateClass);
    expect(new Set(classes).size).toBe(4);
    expect(worktreeStateClass("spent")).not.toBe(worktreeStateClass("active"));
  });

  it("reclaims a spent worktree even when it is off-convention", () => {
    // Deleting beats moving: no point relocating something we are about to remove.
    expect(worktreeDefaultAction(wt({ off_convention: true }))).toBe("reclaim");
  });

  it("relocates an off-convention worktree that is still alive", () => {
    expect(worktreeDefaultAction(wt({ state: "active", merged: false, off_convention: true })))
      .toBe("relocate");
  });

  it("offers open for a healthy active worktree", () => {
    expect(worktreeDefaultAction(wt({ state: "active", merged: false }))).toBe("open");
  });

  it("offers prune for an orphan", () => {
    expect(worktreeDefaultAction(wt({ state: "orphan" }))).toBe("prune");
  });

  it("never offers an action for the current worktree", () => {
    expect(worktreeDefaultAction(wt({ current: true, state: "active" }))).toBe("none");
  });
});
