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
/// `now` and `rand` are injected so the slug is testable.
export function agentSlug(spec: SpawnSpec, now: Date, rand: () => number): string {
  const executor = spec.id.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    || "agent";
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const suffix = Math.floor(rand() * 46656).toString(36).padStart(3, "0").slice(-3);
  return `agent/${executor}-${mm}${dd}-${suffix}`;
}
