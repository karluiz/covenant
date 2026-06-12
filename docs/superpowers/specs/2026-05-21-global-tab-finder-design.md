# Global Tab Finder — Design

**Status:** Draft
**Date:** 2026-05-21
**Owner:** Karluiz

## Problem

We have multiple workspaces (hibernated when inactive) and many tabs per workspace. There's no fast way to jump to a known tab that lives in a different workspace — the user has to switch workspace first, then scan the tabbar. We want a global, keyboard-driven finder that surfaces matching tabs across every workspace.

## Goals

- ⌘⇧P opens the workspace switcher popover with a focused search input.
- Typing filters live across **all** workspaces (active + inactive/hibernated).
- Match fields: tab **title** (custom name with fallback to default), **group name**, **workspace name**.
- Enter on any result switches workspace if needed, then activates the target tab.
- Empty query → existing workspace list (unchanged behavior).

## Non-Goals (deferred)

- MRU/recent ordering across workspaces.
- Searching tab cwd, block history, or command output (the existing ⌘P file-content palette owns block/file search).
- New global keybinding — we reuse ⌘⇧P.

## UX

### Invocation

`⌘⇧P` opens the existing workspace switcher popover (no new shortcut). The popover gains an autofocused `<input class="workspace-search">` row at the top.

### Two render modes

- **Empty query** — current workspace list (one row per workspace, with dot, name, `N tabs · 3m ago`). Unchanged from today.
- **Active query** — flat list of matching tab rows, grouped under workspace headers. The headers are sticky-ish visual separators only; rows are the selectable units.

### Row shape (result mode)

```
● migration                BANCO-CHILE · workspace-1
  src/main                 ws-1
  zsh 3                    workspace-2
```

Each row:

- Leading dot: filled if the row is the *active tab in the active workspace*; outlined dot tinted with group color otherwise.
- Primary: tab `title` (custom_name ?? default_title).
- Secondary (muted): `GROUP · WORKSPACE`. Group omitted if the tab has no group.

### Keyboard

- ↑/↓ move selection across the flat result list (skipping headers).
- Enter activates the selected row.
- Esc: 1st press clears query (returns to workspace list mode); 2nd press closes the popover.
- Tab inside the input does nothing special (no mode toggle — there's only one mode).

### Filter & ranking

Lowercase substring match across `title`, `groupName`, `workspaceName`. Results ordered by:

1. `title` starts-with query
2. `title` contains query
3. `groupName` contains query
4. `workspaceName` contains query

Within each tier, preserve the canonical order: workspaces in their existing `list()` order, tabs in their `tabIndex` order. Cap visible results at 50.

### Activation

```ts
async runSelect({ workspaceId, tabIndex }) {
  if (workspaceId !== this.ws.activeId()) {
    await this.runSwitch(workspaceId, name);    // existing toast + busy chip
  }
  this.tabManager.activateIndex(tabIndex);
  this.closePopover();
}
```

Same-workspace selection is instant. Cross-workspace selection reuses the existing "Switching to …" toast in `WorkspaceSwitcher.runSwitch`.

## Architecture

### Data access — `WorkspaceManager.listAllTabs()`

New method on `WorkspaceManager`:

```ts
export interface TabRow {
  workspaceId: string;
  workspaceName: string;
  workspaceColor: string | null;
  workspaceActive: boolean;
  groupId: string | null;
  groupName: string | null;
  groupColor: string | null;
  tabIndex: number;             // index in the workspace's manifest body
  title: string;                // custom_name ?? default_title
  isActiveTabInWorkspace: boolean;
}

listAllTabs(): TabRow[];
```

Implementation: for the active workspace, read live state via `tabManager.serializeManifest()` so titles/cwd are fresh. For inactive workspaces, read from the in-memory `Workspace.tabs` / `Workspace.groups`. Flatten in workspace-list order, then tabIndex order.

### Tab identity across hibernation

Inactive workspace tabs' `session_id` is stale (PTYs were killed). We address tabs by `{ workspaceId, tabIndex }` — never by `sessionId` — and resolve to a live session at activation time (after the workspace switch has rehydrated the manifest).

### `TabManager.activateIndex(i)`

Thin wrapper that activates the tab at position `i` in the live tab list. If the index is out of range (manifest drifted between selection and activation, e.g. tab closed elsewhere), no-op + log a `tracing`-style warning to the console.

### `WorkspaceSwitcher` changes

`ui/src/workspaces/switcher.ts`:

1. Hold `WorkspaceManager` **and** `TabManager` (constructor gains a second arg). Wire it from `main.ts`.
2. `renderPopover()` becomes a dispatcher: empty query → existing list renderer; non-empty → new `renderResults(rows)`.
3. New private `query` state (string), `selectedIndex` (number), and `lastResults: TabRow[]` cache for keyboard nav.
4. Pure helper `filterAndRankTabs(query, rows): TabRow[]` extracted for testability.
5. Search input: `input` event → updates `query`, recomputes results, re-renders the list region only (not the header/footer).
6. Wire ↑/↓/Enter/Esc on the popover's `keydown` (in addition to the existing Esc-closes handler).

### Selection state on re-render

Re-rendering the list while typing should preserve the selected row when the previously-selected `{ workspaceId, tabIndex }` is still present; otherwise reset to index 0.

## File-Level Plan

- `ui/src/workspaces/manager.ts` — add `TabRow`, `listAllTabs()`, expose `activeId()` if not already public.
- `ui/src/workspaces/switcher.ts` — search input, two render modes, keyboard nav, `runSelect`, constructor gains `TabManager`.
- `ui/src/tabs/manager.ts` — add `activateIndex(i: number): void` (or expose existing equivalent).
- `ui/src/styles.css` — `.workspace-search`, `.workspace-result-row`, `.workspace-result-group-header`, dimmed/active row variants. Match existing switcher visuals; no new color tokens.
- `ui/src/main.ts` — pass `TabManager` into `WorkspaceSwitcher`.
- `ui/src/workspaces/manager.test.ts` — extend with a `listAllTabs` test (mixed active/inactive).
- `ui/src/workspaces/switcher-search.test.ts` — new unit test for `filterAndRankTabs`.

## Testing

**Unit**

- `listAllTabs` returns rows from both the active workspace (live) and inactive workspaces (snapshot), with correct `workspaceActive`/`isActiveTabInWorkspace` flags.
- `filterAndRankTabs`:
  - empty query → empty array (caller decides to show workspace list)
  - title startsWith ranks above title contains
  - group/workspace hits appear after title hits
  - case-insensitive
  - cap at 50

**Manual**

- ⌘⇧P → list mode shows workspaces (regression check).
- ⌘⇧P → type `banc` → cross-workspace results appear, grouped under workspace headers.
- Enter on row in current workspace → tab activates instantly, no toast.
- Enter on row in inactive workspace → "Switching to …" toast, workspace switches, target tab focused after rehydration.
- ↑/↓ wraps within result list, Esc clears query then closes on second press.

## Risks & Mitigations

- **Manifest drift between selection and activation** — `activateIndex` no-ops on out-of-range. Acceptable given the narrow window.
- **Stale titles in inactive workspaces** — manifest holds the title at hibernation time. Acceptable; we don't run PTYs for finder display.
- **Popover height with many results** — already scrollable (`overflow-y: auto`); the 50-result cap bounds DOM size.

## Out of Scope

- MRU sort, fuzzy matching (substring is enough for now), preview of tab block history, drag-to-reorder from finder results.
