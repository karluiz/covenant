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
