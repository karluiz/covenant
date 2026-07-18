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
 */
export function worktreeDefaultAction(wt: GitWorktreeSummary): WorktreeAction {
  if (wt.current) return "none";
  if (wt.state === "orphan") return "prune";
  if (wt.state === "spent") return "reclaim";
  if (wt.off_convention) return "relocate";
  if (wt.state === "stale") return "decide";
  return "open";
}
