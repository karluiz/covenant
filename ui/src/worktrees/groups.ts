import type { GitWorktreeSummary } from "../api";
import type { WorktreeState } from "../status/worktree-state";

/** Display order: deletable first — the page's job is disk triage. */
const GROUP_ORDER: WorktreeState[] = ["spent", "stale", "orphan", "active"];

export interface WorktreeGroup {
  state: WorktreeState;
  worktrees: GitWorktreeSummary[];
  /** Sum of member sizes in KB — null until every member's size is loaded. */
  totalKb: number | null;
}

export function groupWorktrees(
  wts: GitWorktreeSummary[],
  sizes: ReadonlyMap<string, { total: number; target: number }>,
): WorktreeGroup[] {
  const out: WorktreeGroup[] = [];
  for (const state of GROUP_ORDER) {
    const members = wts.filter((w) => w.state === state);
    if (!members.length) continue;
    const size = (p: string) => sizes.get(p)?.total ?? -1;
    members.sort((a, b) => size(b.path) - size(a.path));
    const allLoaded = members.every((w) => sizes.has(w.path));
    const totalKb = allLoaded
      ? members.reduce((sum, w) => sum + (sizes.get(w.path)?.total ?? 0), 0)
      : null;
    out.push({ state, worktrees: members, totalKb });
  }
  return out;
}

/** Bulk-reclaim candidates: spent only, never the calling or main worktree.
 *  The Rust reclaim re-verifies each path is spent/orphan regardless. */
export function spentReclaimPaths(wts: GitWorktreeSummary[]): string[] {
  return wts.filter((w) => w.state === "spent" && !w.current && !w.is_main).map((w) => w.path);
}
