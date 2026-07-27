import { describe, it, expect } from "vitest";
import { cwdUnderRoot } from "./live-worktree";

const ROOT = "/Users/k/Sources/karlTerminal/.covenant/worktrees/agent-foo";

describe("cwdUnderRoot", () => {
  it("matches the root itself", () => {
    expect(cwdUnderRoot(ROOT, ROOT)).toBe(true);
  });
  it("matches a subdir of the root", () => {
    expect(cwdUnderRoot(ROOT + "/ui/src", ROOT)).toBe(true);
  });
  it("rejects a sibling worktree with a shared prefix", () => {
    expect(cwdUnderRoot(ROOT + "-2", ROOT)).toBe(false);
  });
  it("rejects a linked worktree physically nested under the main root", () => {
    const MAIN = "/Users/k/Sources/karlTerminal";
    expect(cwdUnderRoot(MAIN + "/.covenant/worktrees/agent-bar", MAIN)).toBe(false);
    expect(cwdUnderRoot(MAIN + "/.covenant/worktrees/agent-bar/ui/src", MAIN)).toBe(false);
    expect(cwdUnderRoot(MAIN + "/.claude/worktrees/agent-bar", MAIN)).toBe(false);
    // main-root subdirs still match
    expect(cwdUnderRoot(MAIN + "/ui/src", MAIN)).toBe(true);
  });
  it("rejects when either side is empty/null", () => {
    expect(cwdUnderRoot("", ROOT)).toBe(false);
    expect(cwdUnderRoot(ROOT, null)).toBe(false);
    expect(cwdUnderRoot(null, null)).toBe(false);
  });
});
