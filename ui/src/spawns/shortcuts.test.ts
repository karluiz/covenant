import { describe, expect, it } from "vitest";
import { spawnShortcutLabel, buildSpawnCmdline, SPAWN_SHORTCUT_MAX } from "./shortcuts";
import type { SpawnSpec } from "./types";

const spec = (over: Partial<SpawnSpec>): SpawnSpec => ({
  id: "x",
  label: "X",
  icon: null,
  command: "x",
  args: [],
  model: null,
  env: {},
  cwd: null,
  default: false,
  ...over,
});

describe("spawnShortcutLabel", () => {
  it("assigns ⌃1..⌃9 to the first nine, by index", () => {
    expect(spawnShortcutLabel(0)).toBe("⌃1");
    expect(spawnShortcutLabel(8)).toBe("⌃9");
  });

  it("returns null past the cap", () => {
    expect(spawnShortcutLabel(SPAWN_SHORTCUT_MAX)).toBeNull();
    expect(spawnShortcutLabel(9)).toBeNull();
    expect(spawnShortcutLabel(42)).toBeNull();
  });
});

describe("buildSpawnCmdline", () => {
  it("joins command and args without a trailing newline", () => {
    expect(buildSpawnCmdline(spec({ command: "codex", args: ["--full"] }), null)).toBe(
      "codex --full",
    );
  });

  it("injects the Claude theme for the claude executor", () => {
    const line = buildSpawnCmdline(spec({ command: "claude" }), "dark");
    expect(line).toBe(`claude --settings '{"theme":"dark"}'`);
  });

  it("does not inject when the user already pinned a theme", () => {
    const line = buildSpawnCmdline(
      spec({ command: "claude", args: ["--theme", "light"] }),
      "dark",
    );
    expect(line).toBe("claude --theme light");
  });

  it("does not inject for non-claude executors", () => {
    expect(buildSpawnCmdline(spec({ command: "codex" }), "dark")).toBe("codex");
  });

  it("skips injection when no theme is provided", () => {
    expect(buildSpawnCmdline(spec({ command: "claude" }), null)).toBe("claude");
  });
});
