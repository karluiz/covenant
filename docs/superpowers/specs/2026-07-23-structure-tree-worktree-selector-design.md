# Structure tree worktree selector — design

**Date:** 2026-07-23
**Status:** Approved

## Problem

The Files tree header (`ui/src/structure/tree.ts`) shows the tree root path as a
plain truncated label and blindly follows the shell cwd (`CwdChanged` →
`structure.setCwd`). To look at the main tree (or a sibling worktree) while a
terminal sits in a linked worktree, the user has to open another terminal just
to browse files. The path label should become a selector that re-roots the
tree without touching the terminal.

## Decisions (user-approved)

- **Trigger:** the path label itself becomes a clickable button with a chevron,
  opening a dropdown. Only when the cwd's repo has more than one worktree;
  otherwise it stays the plain label it is today.
- **Pin behavior:** explicit pin. Picking a tree pins the view and ignores
  subsequent shell `cd`s. A "Follow terminal" row in the dropdown returns to
  the current follow-the-shell mode. A subtle pin indicator shows when pinned.
- **Scope:** view-only. The terminal, its cwd, and its session are never
  touched. Editor opens and the Changes button already operate on the tree's
  cwd, so they inherit the viewed root for free.

## Design

### Data

`gitRepoSummary(cwd)` (existing Tauri command `git_repo_summary`) already
returns `worktrees: GitWorktreeSummary[]` with `path`, `branch`, `is_main`,
`current`, `state`. No backend changes.

### Pin state — inside `StructureTree`

- New fields: `pinnedRoot: string | null`, `lastTerminalCwd: string | null`.
- `setCwd(cwd)` is reinterpreted as "the terminal reports its cwd": always
  store `lastTerminalCwd = cwd`; when pinned, return without re-rooting.
  When not pinned, behave exactly as today.
- `pinTo(path)`: set `pinnedRoot`, re-root to `path` (same path as current
  `setCwd` body), re-render header with pin indicator.
- `unpin()`: clear `pinnedRoot`, re-root to `lastTerminalCwd`.
- Because the pin lives inside the class, `tabs/manager.ts` needs **no
  changes** — it keeps calling `setCwd` on every `CwdChanged` — and both
  instances (terminal-tab tree and ACP-tab tree) get the feature for free.
- Per-tab, in-memory only. Not persisted across restarts.

### Header / selector UI

In `renderHeader(cwd)`:

- Probe `gitRepoSummary(cwd)` (async, cached 5s server-side like
  `getDirContext`). If the repo has ≤1 worktree and not pinned → plain label,
  as today.
- Otherwise the label renders as a button: truncated path + small chevron.
  When pinned, a pin glyph (inline SVG via `Icons.*`, never emoji) precedes
  the path and the tooltip (via `attachTooltip`, never `element.title` for the
  new button) reads "Pinned to <path> — click to change".
- Click → popover menu anchored to the label, styled like existing rail/context
  menus (sharp corners, `border-radius: 0` per DESIGN.md). Rows:
  1. **Follow terminal** — check glyph when not pinned.
  2. **main** worktree — short name + branch.
  3. Each linked worktree — directory basename + branch.
  The row matching the currently viewed root is marked. Selecting a row calls
  `pinTo(path)` (or `unpin()` for Follow terminal) and closes the menu.
- Dismiss on outside click / Escape.

### Branch chip & actions

`renderBranch(cwd)` and the Changes button already capture the tree's cwd —
when pinned they show the viewed root's branch and diff. No changes beyond
what re-rooting already triggers.

### Error handling

- Pinned worktree disappears (pruned/deleted): `refreshRoot`'s existing error
  path additionally auto-unpins back to `lastTerminalCwd` when
  `pinnedRoot` is set and listing it fails.
- `gitRepoSummary` probe fails or cwd not a repo: selector silently degrades
  to the plain label. Never blocks rendering the tree.

### Testing

Unit tests beside the target (`ui/src/structure/`), following existing
patterns:

- `setCwd` while pinned does not re-root but records `lastTerminalCwd`.
- `unpin()` restores the last terminal cwd.
- Refresh failure while pinned auto-unpins.
- Header renders plain label when repo has one worktree; button when more.

## Out of scope

- Persisting the pin across restarts.
- Switching the *terminal's* cwd from the selector.
- Any change to the git popover's worktree lifecycle actions.
