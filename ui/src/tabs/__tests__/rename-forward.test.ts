import { describe, expect, it } from "vitest";
import { shouldForwardRename } from "../manager";

describe("shouldForwardRename", () => {
  it("forwards when a previously-unnamed pi tab is named", () => {
    expect(
      shouldForwardRename({
        executor: "pi",
        kind: "pi",
        previousCustomName: null,
        newCustomName: "deploy review",
      }),
    ).toBe(true);
  });

  it("forwards when previous name is whitespace-only", () => {
    expect(
      shouldForwardRename({
        executor: "pi",
        kind: "pi",
        previousCustomName: "   ",
        newCustomName: "deploy review",
      }),
    ).toBe(true);
  });

  it("does not forward when the tab was already named (re-rename)", () => {
    expect(
      shouldForwardRename({
        executor: "pi",
        kind: "pi",
        previousCustomName: "old name",
        newCustomName: "new name",
      }),
    ).toBe(false);
  });

  it("does not forward when the new name is empty (clearing)", () => {
    expect(
      shouldForwardRename({
        executor: "pi",
        kind: "pi",
        previousCustomName: null,
        newCustomName: null,
      }),
    ).toBe(false);
  });

  it("does not forward for non-pi executors", () => {
    for (const executor of ["claude", "codex", "copilot", "opencode"]) {
      expect(
        shouldForwardRename({
          executor,
          kind: "shell",
          previousCustomName: null,
          newCustomName: "session a",
        }),
      ).toBe(false);
    }
  });

  it("does not forward for a plain shell tab with no executor", () => {
    expect(
      shouldForwardRename({
        executor: null,
        kind: "shell",
        previousCustomName: null,
        newCustomName: "session a",
      }),
    ).toBe(false);
  });
});
