# Files rail footer — design

**Date:** 2026-07-24
**Status:** Approved

## Problem

The Files structure tree (`ui/src/structure/tree.ts`) spends two chrome rows
above the tree:

1. Path label (worktree selector) + action buttons
2. Branch chip strip (`.structure-branch`)

That mid strip duplicates context the global status bar already shows for the
session cwd, and it steals vertical space from the file list. The path/branch
belong with “where this tree is rooted,” not stacked under the actions.

## Decisions (user-approved)

- **Layout B — rail footer:** move path + branch into a fixed footer at the
  bottom of the Files rail. Header becomes title + actions only.
- **No second global bottom bar.** The existing status bar stays the session
  identity strip; the Files footer is tree-local.
- **Branch chip is display-only in v1.** Branch switching remains on the
  status-bar git popover (one switcher).
- **Pin / worktree selector behavior unchanged** — only relocates from header
  to footer.
- **Scope is Files only** — other rails are not migrated in this change.

## Design

### Layout

Compose with the shared rail tokens from `docs/DESIGN.md`:

| Region | Token / class | Content |
|---|---|---|
| Header | `--rail-header-h` (40px), prefer `.rail-header` / `.rail-actions` | Title `Files` + new file, new folder, show-ignored, view changes, refresh |
| Body | flex `1fr`, scrolls | Existing tree list / empty / waiting |
| Footer | `--rail-footer-h` (30px), `.rail-footer` (or structure-scoped equivalent that matches those metrics) | Truncated path (+ chevron when selector applies) + optional branch chip |

Delete the mid-header `.structure-branch` row and its border seam. Net chrome
above the tree drops from ~two rows to one; “where we are” remains always
visible below the list.

### Behavior by state

| State | Footer |
|---|---|
| Following shell cwd | Path of tree root + branch chip when `getDirContext` reports git |
| Pinned to another worktree | Pin glyph + pinned path + that root’s branch. Status bar may show a different session branch — intentional |
| Not a git repo | Path only; no empty chip |
| Waiting for shell cwd | `Waiting for shell cwd…` (no chip) |

### Interactions

- **Path (and chevron):** same worktree selector popover as today
  (`decorateWorktreeSelector` / pin / follow terminal). Tooltip via
  `attachTooltip`; no native `title=` for new interactive chrome.
- **Branch chip:** non-interactive in v1 (no click handler, no role=button).
- **Header actions:** unchanged semantics; only their host row loses the path.
- **Global status bar:** no layout or content changes.

### Data / wiring

No backend changes. Reuse:

- `getDirContext(cwd)` for the branch chip (same probe `renderBranch` uses today)
- `cachedRepoSummary` / `gitRepoSummary` for the worktree selector
- Existing pin fields (`pinnedRoot`, `lastTerminalCwd`) and `setCwd` /
  `pinTo` / `unpin` contracts from the 2026-07-23 worktree-selector design

`renderBranch` targets the footer container instead of the mid strip. Header
render no longer mounts the path label.

### CSS

- Retire mid-strip rules: `.structure-branch`, `.structure-branch-chip`,
  `.structure-branch-name` as header-adjacent layout (chip styles may move
  under a footer-scoped selector).
- Footer path reuses `.structure-cwd` / `.structure-cwd-selector` /
  `.structure-cwd-pin` / `.structure-cwd-text` (or thin renames under
  `.structure-footer …`) so selector + ellipsis behavior stay intact.
- Align heights/padding with `.rail-footer` (`30px`, hairline `border-top`,
  mono micro type). One flat `--sidebar-bg` material — no new elevation.

### Error handling

Unchanged from today:

- Stale async probes drop if `this.cwd` changed mid-flight
- Branch probe failure → hide chip
- Pinned root listing failure → existing auto-unpin path

### Testing

Extend `ui/src/structure/tree.test.ts`:

- Rooted tree renders path in the footer, not in the header
- Git repo shows branch chip in the footer; non-repo omits it
- Header contains action buttons and does not contain a second branch row
- Pin glyph still appears on the path when pinned

### Out of scope

- Second window-level status strip
- Status bar redesign
- Clickable branch chip / duplicate git switcher
- Homologating other right-rail panels to this footer pattern
- Changing the Files action set or title

## Implementation touch points

- `ui/src/structure/tree.ts` — split header vs footer render; relocate
  `renderBranch` / path / worktree selector
- `ui/src/styles.css` — remove mid-strip; style structure footer to match
  `--rail-footer-h`
- `ui/src/structure/tree.test.ts` — DOM assertions above
