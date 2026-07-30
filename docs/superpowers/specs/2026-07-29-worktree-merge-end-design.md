# Merge & end — worktree detail action

2026-07-29 · Worktrees page (⌘⌥W) detail panel

## What

One button that merges an agent worktree's branch into main and reclaims the
worktree, completing the lifecycle without leaving the panel.

## Backend

New command `worktree_merge_end(repo_root, worktree_path)` in
`crates/app/src/git_tools.rs` (+ Tauri wrapper in `lib.rs`, typed in
`ui/src/api.ts`):

1. Resolve the worktree's branch, the default branch, and the main checkout
   path from `repo_summary` data.
2. Refuse (Err with human-readable reason) if: worktree dirty, branch == default
   branch, main checkout not on the default branch, main checkout dirty,
   worktree occupied by a session.
3. In the **main checkout**: `git merge --no-ff <branch>` (default message,
   matches existing history: `Merge branch 'agent/…'`).
4. Conflict → `git merge --abort`, Err with the conflicting files. Worktree
   untouched.
5. Success → call existing `reclaim_worktrees` for this path (its merge
   re-check now passes; deletes checkout + branch). Return the reclaim outcome.

No push. No squash. Local only, like everything else in the popover.

## UI (`ui/src/worktrees/index.ts` renderActions)

- **Commit** button: shown only when `dirty_count > 0`. Dispatches
  `covenant:open-changes` for the worktree (the existing commit composer).
- **Merge & end** button: rendered for non-main, non-current worktrees whose
  branch is not yet merged. Disabled + tooltip when a precondition fails:
  - dirty worktree → "Commit your changes first"
  - main checkout dirty / not on default branch → "Main checkout has
    uncommitted changes" / "Main checkout is on <branch>"
  - occupied → "A session is using this worktree"
- Enabled → confirm toast: "Merge <branch> into main and remove the worktree?"
  → command → success toast + panel refresh; failure toast with the backend
  reason.
- Already-merged worktrees keep the existing Reclaim button; Merge & end is
  not shown for them.

Gating reads existing `GitWorktreeSummary` fields (`merged`, `dirty_count`,
main entry's `dirty_count`); the backend re-verifies everything anyway.

## Tests

- Rust: merge-and-reclaim happy path; refusal on dirty worktree; refusal on
  dirty main checkout; conflict aborts cleanly and leaves both trees intact.
- No new UI test surface beyond existing patterns (button gating is trivial
  derivation from summary fields).

## Out of scope

Push after merge, squash strategy, PR creation, running from the git popover
(worktrees page only for now).
