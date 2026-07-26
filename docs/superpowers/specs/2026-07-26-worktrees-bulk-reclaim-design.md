# Worktrees triage + bulk reclaim — design

**Date:** 2026-07-26
**Surface:** `ui/src/worktrees/` (WorktreesSurface, ⌘⌥W)
**Problem:** The list is size-sorted, so a dozen identical "spent" rows mix with
active ones, nothing says "these are all safe to delete together", and deletion
is one-at-a-time through the detail panel.

## Changes

### 1. Group the list by lifecycle state

Replace the pure size-sort with fixed-order groups: **SPENT → STALE → ORPHAN →
ACTIVE**. Deletable first — the page's job is disk triage. Within a group, rows
stay size-desc. Empty groups don't render.

Group header row: `SPENT · 13 worktrees · 690 MB`. The size total sums only
loaded sizes; while sizes are still loading the header shows count only.

### 2. "Reclaim all" on the SPENT group header

Right-aligned button in the SPENT header, danger-styled.

- Confirm via `pushConfirmToast` (never `window.confirm`):
  "Remove N spent worktrees and free ~X? Their branches are already merged or gone."
- On confirm: one `worktreeReclaim(repoRoot, spentPaths)` call. Paths exclude
  `current` and `is_main` defensively; the Rust side re-verifies each path is
  spent/orphan and refuses otherwise (`git_tools.rs` reclaim guard).
- Result toast aggregates outcomes: `Reclaimed 12 · freed ~640 MB`, plus
  `· 1 refused: <reason>` per failure. Freed size estimated from the cached
  `sizes` map. Then `refresh()`.

### 3. "Why it's safe" fact in the detail panel

New `Branch` fact row for non-main worktrees:
- spent + `merged` → `merged into <default_branch>`
- spent + not merged → `deleted upstream`
- otherwise → the branch name (or `detached`)

Uses `GitWorktreeSummary.merged` + `GitRepoSummary.default_branch` — no new
backend data.

## Not doing

- No checkboxes / multi-select — spent is the only bulk-safe category.
- No new Rust commands; `worktree_reclaim` already takes a batch.
- No per-row layout changes beyond group headers.

## Tests

Pure grouping helper (partition by state in display order + per-group size
totals) unit-tested in `ui/src/worktrees/`. Existing tests untouched.

## Constraints

Sharp corners (border-radius 0), `attachTooltip` only, English copy, DESIGN.md
hard rules apply.
