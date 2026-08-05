import { describe, expect, it } from "vitest";
import {
  buildContinuePrompt,
  clipContinuePrompt,
  eligibleContinueSpawns,
  waitForExecutor,
  MAX_CONTINUE_PROMPT_CHARS,
} from "./continue-with";
import type { SpawnSpec } from "./spawns/types";

function spec(over: Partial<SpawnSpec> & Pick<SpawnSpec, "id" | "command">): SpawnSpec {
  return {
    label: over.label ?? over.id,
    icon: null,
    args: over.args ?? [],
    env: {},
    cwd: null,
    default: false,
    ...over,
  };
}

describe("buildContinuePrompt", () => {
  it("includes source, dest, cwd, branch, blocks oldest-first, and instruction", () => {
    const text = buildContinuePrompt({
      sourceExecutor: "claude",
      destLabel: "Cursor",
      cwd: "/repo/wt",
      branch: "agent/foo",
      recent: [
        { command: "ls", exit_code: 0, tail: "a\n" },
        { command: "cargo test", exit_code: 1, tail: "FAIL\n" },
      ],
    });
    expect(text).toContain("Source: claude · cwd /repo/wt · branch agent/foo");
    expect(text).toContain("continue with Cursor");
    expect(text.indexOf("$ ls")).toBeLessThan(text.indexOf("$ cargo test"));
    expect(text).toContain("(exit 1)");
    expect(text).toContain("FAIL");
    expect(text).toMatch(/Pick up where the previous harness left off/);
  });

  it("omits branch segment when branch is null", () => {
    const text = buildContinuePrompt({
      sourceExecutor: "claude",
      destLabel: "Codex",
      cwd: "/r",
      branch: null,
      recent: [],
    });
    expect(text).toContain("Source: claude · cwd /r");
    expect(text).not.toMatch(/Source:.*· branch /);
  });

  it("still produces a usable brief when recent is empty", () => {
    const text = buildContinuePrompt({
      sourceExecutor: "claude",
      destLabel: "Codex",
      cwd: "/r",
      branch: null,
      recent: [],
    });
    expect(text).toContain("Continue this work from another harness");
    expect(text).toContain("cwd /r");
  });

  it("clips only the recent-context body when oversized, so ## Instruction always survives", () => {
    // Five ~4 KB tails (the real shape: CONTINUE_BLOCK_COUNT blocks of
    // tail_4kb output) blow well past MAX_CONTINUE_PROMPT_CHARS.
    const recent = Array.from({ length: 5 }, (_, i) => ({
      command: `cmd-${i}`,
      exit_code: 0,
      tail: "x".repeat(4000),
    }));
    const text = buildContinuePrompt({
      sourceExecutor: "claude",
      destLabel: "Cursor",
      cwd: "/repo",
      branch: "main",
      recent,
    });
    expect(text.length).toBeLessThanOrEqual(MAX_CONTINUE_PROMPT_CHARS);
    expect(text).toContain("[truncated]");
    expect(text).toContain("## Instruction");
    expect(text).toContain("Pick up where the previous harness left off");
    // The instruction is the last section — clipping the context body must
    // not have eaten into it.
    expect(text.indexOf("## Instruction")).toBeGreaterThan(
      text.indexOf("## Recent terminal context"),
    );
  });
});

describe("clipContinuePrompt", () => {
  it("returns text unchanged under the cap", () => {
    expect(clipContinuePrompt("hi", 100)).toBe("hi");
  });

  it("truncates from the tail of the given text and notes truncation", () => {
    const huge = "x".repeat(MAX_CONTINUE_PROMPT_CHARS + 500);
    const out = clipContinuePrompt(huge);
    expect(out.length).toBeLessThanOrEqual(MAX_CONTINUE_PROMPT_CHARS);
    expect(out).toContain("[truncated]");
  });
});

describe("eligibleContinueSpawns", () => {
  it("drops ACP specs and the current executor", () => {
    const list = eligibleContinueSpawns(
      [
        spec({ id: "1", command: "claude", label: "Claude" }),
        spec({ id: "2", command: "agent", label: "Cursor" }),
        spec({ id: "3", command: "codex", label: "Codex", acp: true }),
        spec({ id: "4", command: "gh", args: ["copilot"], label: "Copilot" }),
      ],
      "claude",
    );
    expect(list.map((s) => s.id)).toEqual(["2", "4"]);
  });

  it("returns empty when nothing remains", () => {
    expect(
      eligibleContinueSpawns([spec({ id: "1", command: "claude" })], "claude"),
    ).toEqual([]);
  });
});

describe("waitForExecutor", () => {
  it("resolves true when getExecutor becomes non-null", async () => {
    let n = 0;
    const ok = await waitForExecutor({
      getExecutor: () => (++n >= 3 ? "cursor" : null),
      timeoutMs: 1000,
      pollMs: 1,
      sleep: async () => {},
    });
    expect(ok).toBe(true);
  });

  it("resolves false on timeout", async () => {
    const ok = await waitForExecutor({
      getExecutor: () => null,
      timeoutMs: 5,
      pollMs: 1,
      sleep: async () => {},
    });
    expect(ok).toBe(false);
  });
});
