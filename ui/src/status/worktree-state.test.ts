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
  is_main: false,
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

  it("never offers Reclaim on the main worktree, even when it classifies as spent", () => {
    // The scenario the fix targets: popover opened from a linked worktree,
    // so `current` is false on the main row, but `is_main` is true.
    expect(worktreeDefaultAction(wt({ is_main: true, state: "spent", current: false })))
      .toBe("none");
  });

  it("never offers Relocate on the main worktree, even when off-convention", () => {
    expect(
      worktreeDefaultAction(
        wt({ is_main: true, state: "active", merged: false, off_convention: true, current: false }),
      ),
    ).toBe("none");
  });

  it("withholds Relocate when another open tab's cwd sits inside the worktree", () => {
    const occupied = new Set(["/repo/.covenant/worktrees/x/nested/dir"]);
    expect(
      worktreeDefaultAction(
        wt({ state: "active", merged: false, off_convention: true }),
        occupied,
      ),
    ).toBe("none");
  });

  it("withholds Relocate when an open tab's cwd is exactly the worktree root", () => {
    const occupied = new Set(["/repo/.covenant/worktrees/x"]);
    expect(
      worktreeDefaultAction(
        wt({ state: "active", merged: false, off_convention: true }),
        occupied,
      ),
    ).toBe("none");
  });

  it("does not withhold Relocate for an unrelated open tab, or a sibling with a shared prefix", () => {
    const occupied = new Set([
      "/repo/.covenant/worktrees/y",
      "/repo/.covenant/worktrees/x-sibling", // shares a string prefix, not a path prefix
    ]);
    expect(
      worktreeDefaultAction(
        wt({ state: "active", merged: false, off_convention: true }),
        occupied,
      ),
    ).toBe("relocate");
  });

  it("still offers Relocate for an off-convention worktree when no tab occupies it", () => {
    expect(
      worktreeDefaultAction(wt({ state: "active", merged: false, off_convention: true }), new Set()),
    ).toBe("relocate");
  });
});
