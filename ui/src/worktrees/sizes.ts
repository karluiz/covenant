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

/** Subtract nested worktree sizes from any worktree that physically contains
 * them. Linked worktrees live under `<main>/.covenant/worktrees/*`, so `du` on
 * the main worktree counts each child's bytes too — this de-double-counts so a
 * row reflects only its own footprint. Only `total` is adjusted; `target` is a
 * direct child dir that never contains sibling worktrees. */
export function subtractNested(
  sizes: Map<string, { total: number; target: number }>,
): Map<string, { total: number; target: number }> {
  const paths = [...sizes.keys()];
  const out = new Map<string, { total: number; target: number }>();
  for (const [p, s] of sizes) {
    let total = s.total;
    for (const other of paths) {
      const child = sizes.get(other);
      if (other !== p && child && isNestedUnder(other, p)) {
        total -= child.total;
      }
    }
    out.set(p, { total: Math.max(0, total), target: s.target });
  }
  return out;
}

function isNestedUnder(child: string, parent: string): boolean {
  const pp = parent.endsWith("/") ? parent.slice(0, -1) : parent;
  return child.startsWith(`${pp}/`);
}
