/** Paths to ask `worktreeSizes` for: each worktree plus its `target/`, so one
 * du call yields both the total and the reclaimable build-cache size. */
export function sizeRequestPaths(paths: string[]): string[] {
  return [...paths, ...paths.map((p) => `${p}/target`)];
}

/** Fold a flat `[path, kb]` list (from `sizeRequestPaths`) back into per-worktree
 * totals. Missing entries (e.g. a worktree with no target/ yet) default to 0. */
export function splitSizes(
  paths: string[],
  sizes: ReadonlyArray<readonly [string, number]>,
): Map<string, { total: number; target: number }> {
  const byPath = new Map(sizes.map(([p, kb]) => [p, kb] as const));
  const out = new Map<string, { total: number; target: number }>();
  for (const p of paths) {
    out.set(p, { total: byPath.get(p) ?? 0, target: byPath.get(`${p}/target`) ?? 0 });
  }
  return out;
}
