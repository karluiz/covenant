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
  it("rejects when either side is empty/null", () => {
    expect(cwdUnderRoot("", ROOT)).toBe(false);
    expect(cwdUnderRoot(ROOT, null)).toBe(false);
    expect(cwdUnderRoot(null, null)).toBe(false);
  });
});
