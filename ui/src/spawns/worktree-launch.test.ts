import { describe, expect, it } from "vitest";
import { wantsWorktree, agentSlug } from "./worktree-launch";
import type { SpawnSpec } from "./types";

const spec = (over: Partial<SpawnSpec> = {}): SpawnSpec => ({
  id: "codex",
  label: "Codex",
  icon: null,
  command: "codex",
  args: [],
  env: {},
  cwd: null,
  default: false,
  ...over,
});

describe("worktree launch decision", () => {
  it("isolates a spawn whose flag is absent — an older spawns.json opts in", () => {
    expect(wantsWorktree(spec())).toBe(true);
  });

  it("honors an explicit opt-out", () => {
    expect(wantsWorktree(spec({ worktree: false }))).toBe(false);
  });

  it("honors an explicit opt-in", () => {
    expect(wantsWorktree(spec({ worktree: true }))).toBe(true);
  });

  it("builds a slug that names the executor and the day", () => {
    const s = agentSlug(spec({ id: "copilot" }), new Date("2026-07-19T10:00:00Z"), () => 0.5);
    expect(s).toMatch(/^agent\/copilot-0719-[a-z0-9]{3}$/);
  });

  it("varies the suffix so two same-day launches do not collide", () => {
    const day = new Date("2026-07-19T10:00:00Z");
    const a = agentSlug(spec(), day, () => 0.1);
    const b = agentSlug(spec(), day, () => 0.9);
    expect(a).not.toBe(b);
  });

  it("produces a slug git accepts as a ref", () => {
    // No spaces, no double dots, no trailing slash, no leading dash.
    const s = agentSlug(spec({ id: "pi agent" }), new Date("2026-07-19T10:00:00Z"), () => 0.5);
    expect(s).not.toMatch(/\s|\.\.|^-|\/$/);
  });
});
