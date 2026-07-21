import { describe, expect, it, vi } from "vitest";
import {
  wantsWorktree,
  agentSlug,
  resolveLaunch,
  isolateCwd,
  isSilentWorktreeFailure,
} from "./worktree-launch";
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
    const s = agentSlug("copilot", new Date(2026, 6, 19, 10, 0, 0), () => 0.5);
    expect(s).toMatch(/^agent\/copilot-0719-[a-z0-9]{3}$/);
  });

  it("varies the suffix so two same-day launches do not collide", () => {
    const day = new Date("2026-07-19T10:00:00Z");
    const a = agentSlug(spec().id, day, () => 0.1);
    const b = agentSlug(spec().id, day, () => 0.9);
    expect(a).not.toBe(b);
  });

  it("produces a slug git accepts as a ref", () => {
    // No spaces, no double dots, no trailing slash, no leading dash.
    const s = agentSlug("pi agent", new Date("2026-07-19T10:00:00Z"), () => 0.5);
    expect(s).not.toMatch(/\s|\.\.|^-|\/$/);
  });

  it("separator_variants_of_an_id_normalise_together", () => {
    // Documented behaviour, not a bug: normalisation is lossy, so ids that
    // differ only by separator produce the same executor segment. The
    // random suffix — not this sanitising — is what actually prevents
    // worktree collisions (see the doc comment on agentSlug).
    const day = new Date(2026, 6, 19);
    const dash = agentSlug("agent-x", day, () => 0.5);
    const space = agentSlug("agent x", day, () => 0.5);
    const slash = agentSlug("agent/x", day, () => 0.5);
    const dot = agentSlug("agent.x", day, () => 0.5);
    const underscore = agentSlug("agent_x", day, () => 0.5);
    expect(dash).toBe(space);
    expect(dash).toBe(slash);
    expect(dash).toBe(dot);
    expect(dash).toBe(underscore);
  });

  it("does not alias the suffix at the rand()===1 boundary", () => {
    const day = new Date(2026, 6, 19);
    const low = agentSlug(spec().id, day, () => 0);
    const high = agentSlug(spec().id, day, () => 1);
    const suffixOf = (s: string) => s.slice(s.lastIndexOf("-") + 1);
    expect(suffixOf(low)).toHaveLength(3);
    expect(suffixOf(high)).toHaveLength(3);
    expect(suffixOf(low)).not.toBe(suffixOf(high));
  });
});

describe("isSilentWorktreeFailure", () => {
  it("recognizes git's own not-a-git-repository stderr", () => {
    expect(
      isSilentWorktreeFailure(
        "fatal: not a git repository (or any of the parent directories): .git",
      ),
    ).toBe(true);
  });

  it("does not silence an unrelated failure", () => {
    expect(isSilentWorktreeFailure("fatal: could not create work tree dir: Permission denied")).toBe(
      false,
    );
  });
});

describe("resolveLaunch", () => {
  const deps = () => ({
    create: vi.fn<(cwd: string, slug: string) => Promise<string>>(),
    now: () => new Date(2026, 6, 19, 10, 0, 0),
    rand: () => 0.5,
  });

  it("launches at the plain cwd, uncreated, when the spawn opts out", async () => {
    const d = deps();
    const result = await resolveLaunch(spec({ worktree: false }), "/repo", d);
    expect(result).toEqual({ cwd: "/repo", isolated: false });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("does not attempt creation when there is no base cwd", async () => {
    const d = deps();
    const result = await resolveLaunch(spec(), null, d);
    expect(result).toEqual({ cwd: null, isolated: false });
    expect(d.create).not.toHaveBeenCalled();
  });

  it("falls back to the plain cwd and surfaces the reason when create fails", async () => {
    const d = deps();
    d.create.mockRejectedValue(new Error("fatal: could not create work tree dir"));
    const result = await resolveLaunch(spec(), "/repo", d);
    expect(result.cwd).toBe("/repo");
    expect(result.isolated).toBe(false);
    expect(result.error).toContain("could not create work tree dir");
  });

  it("returns the worktree path and isolated:true on success", async () => {
    const d = deps();
    d.create.mockResolvedValue("/repo/.covenant/worktrees/agent/codex-0719-abc");
    const result = await resolveLaunch(spec(), "/repo", d);
    expect(result).toEqual({
      cwd: "/repo/.covenant/worktrees/agent/codex-0719-abc",
      isolated: true,
    });
    expect(d.create).toHaveBeenCalledWith("/repo", expect.stringMatching(/^agent\/codex-0719-/));
  });
});

describe("spec-less isolation (ACP chat tabs)", () => {
  const deps = (create: (c: string, s: string) => Promise<string>) => ({
    create,
    now: () => new Date(2026, 6, 19),
    rand: () => 0.5,
  });

  it("cuts a worktree named after the executor", async () => {
    const create = vi.fn(async (_c: string, slug: string) => `/wt/${slug}`);
    const r = await isolateCwd("/repo", "claude", deps(create));
    expect(create).toHaveBeenCalledWith("/repo", expect.stringMatching(/^agent\/claude-0719-/));
    expect(r).toMatchObject({ isolated: true });
    expect(r.cwd).toMatch(/^\/wt\/agent\/claude-0719-/);
  });

  it("launches in place, silently, outside a git repo", async () => {
    const r = await isolateCwd(
      "/tmp/x",
      "claude",
      deps(() => Promise.reject(new Error("fatal: not a git repository"))),
    );
    expect(r).toMatchObject({ cwd: "/tmp/x", isolated: false });
    expect(isSilentWorktreeFailure(r.error ?? "")).toBe(true);
  });

  it("has nothing to isolate without a cwd", async () => {
    const create = vi.fn();
    expect(await isolateCwd(null, "claude", deps(create as never))).toEqual({
      cwd: null,
      isolated: false,
    });
    expect(create).not.toHaveBeenCalled();
  });
});
