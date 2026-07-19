import type { SpawnSpec } from "./types";

/// Absent means isolated. A spawns.json written before this field existed
/// opts IN, so upgrading installs get isolation without a migration.
export function wantsWorktree(spec: SpawnSpec): boolean {
  return spec.worktree !== false;
}

/// `agent/<executor>-<MMDD>-<suffix>`. Readable enough to answer "where did
/// this branch come from" months later — the `worktree-a3dd4e8417b0e2ebe`
/// branches this repo accumulated are the counter-example.
///
/// The executor segment is a *lossy* normalisation of `spec.id`: distinct ids
/// that differ only by separator (`"agent/x"`, `"agent-x"`, `"agent x"`,
/// `"agent.x"`, `"agent_x"`) collapse to the identical segment `"agent-x"`.
/// That's intentional — an injective encoding isn't worth the readability
/// cost for a branch name a human has to type and recognise. It is the
/// random `suffix` below — not the `agent/` prefix and not the sanitising —
/// that keeps two worktrees from colliding on disk. If two launches do land
/// on the same slug (same day, same rand draw, colliding executor segment),
/// `create_worktree` fails with "already exists" and the launch path
/// degrades from that failure rather than crashing on it.
///
/// `now` and `rand` are injected so the slug is testable.
/// @param rand Must return a value in the closed range `[0, 1]`
///   (`Math.random()`'s `[0, 1)` is a safe subset). The suffix arithmetic
///   clamps so every value in that range — including the `1` boundary —
///   maps to a distinct 3-character base-36 suffix; nothing aliases with the
///   suffix produced by `rand() === 0`.
export function agentSlug(spec: SpawnSpec, now: Date, rand: () => number): string {
  const executor = spec.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    || "agent";
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const suffix = Math.min(Math.floor(rand() * 46656), 46655).toString(36).padStart(3, "0");
  return `agent/${executor}-${mm}${dd}-${suffix}`;
}

/// `worktreeCreate`'s failure message outside a git repository is literally
/// git's own stderr for `git rev-parse --show-toplevel` — "fatal: not a git
/// repository (or any of the parent directories): .git" — propagated up
/// through `repo_summary`. The design promises that path stays silent
/// ("launch in the cwd exactly as today"), so the call site uses this to
/// tell that one expected cause apart from a genuine failure (permissions,
/// a colliding slug, disk) that the user still needs to see.
export function isSilentWorktreeFailure(message: string): boolean {
  return /not a git repository/i.test(message);
}

/// Result of deciding where an agent launches. `cwd: null` only ever happens
/// when the caller had no cwd to begin with (e.g. a browser tab is active) —
/// `resolveLaunch` never turns a real cwd into `null`.
export interface LaunchResolution {
  cwd: string | null;
  isolated: boolean;
  /// Set only when a worktree was attempted and failed. `isSilentWorktreeFailure`
  /// tells the caller whether it's toast-worthy.
  error?: string;
}

export interface LaunchDeps {
  /// `worktreeCreate` from `../api`, injected so this stays a pure,
  /// test-without-mounting-the-app function.
  create: (cwd: string, slug: string) => Promise<string>;
  now: () => Date;
  rand: () => number;
}

/// The launch decision `runSpawn` used to make inline in `boot()` — pulled
/// out here so it's reachable from a test. Mirrors the three cases that were
/// previously untestable: opt-out launches at the plain cwd, a create
/// failure falls back to the plain cwd (still surfacing why), and success
/// hands back the worktree path with `isolated: true` — which is what tells
/// the PTY-spawn call site to open a NEW tab instead of writing into the
/// current session.
export async function resolveLaunch(
  spec: SpawnSpec,
  baseCwd: string | null,
  deps: LaunchDeps,
): Promise<LaunchResolution> {
  if (!wantsWorktree(spec) || !baseCwd) {
    return { cwd: baseCwd, isolated: false };
  }
  try {
    const cwd = await deps.create(baseCwd, agentSlug(spec, deps.now(), deps.rand));
    return { cwd, isolated: true };
  } catch (e) {
    return { cwd: baseCwd, isolated: false, error: String(e) };
  }
}
