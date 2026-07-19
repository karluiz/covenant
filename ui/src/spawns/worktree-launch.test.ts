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
    // Local-time components, not a UTC instant — agentSlug reads
    // now.getMonth()/getDate() in local time, so a UTC fixture would read as
    // the previous day on any runner west of UTC (e.g. UTC-11).
    const s = agentSlug(spec({ id: "copilot" }), new Date(2026, 6, 19, 10, 0, 0), () => 0.5);
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

  it("separator_variants_of_an_id_normalise_together", () => {
    // Documented behaviour, not a bug: normalisation is lossy, so ids that
    // differ only by separator produce the same executor segment. The
    // random suffix — not this sanitising — is what actually prevents
    // worktree collisions (see the doc comment on agentSlug).
    const day = new Date(2026, 6, 19);
    const dash = agentSlug(spec({ id: "agent-x" }), day, () => 0.5);
    const space = agentSlug(spec({ id: "agent x" }), day, () => 0.5);
    const slash = agentSlug(spec({ id: "agent/x" }), day, () => 0.5);
    const dot = agentSlug(spec({ id: "agent.x" }), day, () => 0.5);
    const underscore = agentSlug(spec({ id: "agent_x" }), day, () => 0.5);
    expect(dash).toBe(space);
    expect(dash).toBe(slash);
    expect(dash).toBe(dot);
    expect(dash).toBe(underscore);
  });

  it("does not alias the suffix at the rand()===1 boundary", () => {
    const day = new Date(2026, 6, 19);
    const low = agentSlug(spec(), day, () => 0);
    const high = agentSlug(spec(), day, () => 1);
    const suffixOf = (s: string) => s.slice(s.lastIndexOf("-") + 1);
    expect(suffixOf(low)).toHaveLength(3);
    expect(suffixOf(high)).toHaveLength(3);
    expect(suffixOf(low)).not.toBe(suffixOf(high));
  });
});
