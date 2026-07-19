import type { GitWorktreeSummary } from "../api";

export type WorktreeState = "active" | "stale" | "spent" | "orphan";
export type WorktreeAction = "open" | "decide" | "reclaim" | "prune" | "relocate" | "none";

const LABELS: Record<WorktreeState, string> = {
  active: "active",
  stale: "stale",
  spent: "spent",
  orphan: "orphan",
};

export function worktreeStateLabel(state: WorktreeState): string {
  return LABELS[state];
}

export function worktreeStateClass(state: WorktreeState): string {
  return `status-git-pop-wt-${state}`;
}

/**
 * One action per worktree — the user accepts a verdict rather than choosing a
 * git command. Lifecycle state wins over the off-convention flag: a spent
 * worktree gets deleted, not moved.
 *
 * `occupiedCwds` is the set of cwds every currently open tab sits in — NOT
 * just the calling tab's cwd (that's `wt.current`, which only tells us
 * "matches the tab this popover happened to open from"). `relocate_worktree`
 * on the Rust side cannot see open tabs at all (a layering fact: it's a pure
 * git/filesystem function); this is where that half of "idle" actually gets
 * enforced, because this is the only layer that has both the worktree paths
 * and the open tabs' cwds in hand. Without it: tab A opens the popover from
 * `main`, tab B sits in a stray worktree running a long build (tree clean,
 * output gitignored) — Relocate would succeed and leave tab B's shell cwd'd
 * into a path that no longer exists.
 */
export function worktreeDefaultAction(
  wt: GitWorktreeSummary,
  occupiedCwds: ReadonlySet<string> = EMPTY_CWDS,
): WorktreeAction {
  if (wt.current) return "none";
  if (wt.is_main) return "none";
  if (wt.state === "orphan") return "prune";
  if (wt.state === "spent") return "reclaim";
  if (wt.off_convention) {
    return hasOccupiedTab(wt.path, occupiedCwds) ? "none" : "relocate";
  }
  if (wt.state === "stale") return "decide";
  return "open";
}

const EMPTY_CWDS: ReadonlySet<string> = new Set();

/** True when some open tab's cwd is `wtPath` itself or nested inside it. */
function hasOccupiedTab(wtPath: string, cwds: ReadonlySet<string>): boolean {
  const target = stripTrailingSlash(wtPath);
  for (const cwd of cwds) {
    const c = stripTrailingSlash(cwd);
    if (c === target || c.startsWith(`${target}/`)) return true;
  }
  return false;
}

function stripTrailingSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}
