# Unified Command Palette — Design

**Date:** 2026-06-08
**Status:** Approved (brainstorming → spec)
**Replaces:** the anchored `WorkspaceSwitcher` popover with a centered, sectioned command palette.

---

## Goal

Turn the workspace switcher (today: an anchored popover that is a workspace list with a search box bolted on) into a **core-feeling command palette** that searches **workspaces + tabs + actions** in one blended, sectioned, fuzzy-ranked list. ⌘⌥T + Enter should jump back to the most-recent target with zero typing.

This is a top-level navigation primitive, on par with `recall/palette.ts` (⌘P) and `search/palette.ts` (⌘⇧F). It must match their house style.

---

## Scope

**In:**
- Centered modal overlay (Spotlight/VSCode-style) with dimmed backdrop.
- Three result kinds, blended and ranked, then partitioned into sections: **Workspaces / Tabs / Actions**.
- Fuzzy ranking via the existing `mentions/fuzzy.ts` `fuzzyScore()`.
- Empty-query quick-switch default (frecency: recent workspaces, then current workspace's tabs).
- Keep ⌘⌥T and ⌘⇧P as open triggers; ⌘⌥N still fires New-workspace directly.
- Keep the tabbar chip + its right-click context menu; re-point its click to open the palette.

**Out (YAGNI, layer later):**
- Prefix sigils (`>`, `@`).
- Filter chips.
- Action arguments / sub-palettes.
- Persistence of palette state.
- Restyling the chip itself.

---

## Architecture

### New file: `ui/src/workspaces/palette.ts`
Class `CommandPalette`, modeled exactly on `RecallPalette`:
- `overlay` (`.command-palette-overlay`, click-outside closes) + `card` (`.command-palette-card`).
- Label chip, single `<input>`, `<ul role="listbox">`.
- Ticket-based inflight cancellation pattern (`++this.inflight`) — even though providers are synchronous today, keep the shape for future async tab metadata.
- **mousemove (not mouseenter)** to set cursor, so keyboard scrolling doesn't trigger phantom hover (same rationale as recall palette, lines 211–219).
- `isOpen()` / `toggle()` / `open()` / `close()` API.

Constructor dependencies (injected, no globals):
```ts
constructor(
  mountHost: HTMLElement,
  manager: WorkspaceManager,         // workspace + tab data, switch operations
  actions: PaletteAction[],          // static action registry
  focusTerminal?: () => void,        // return focus to xterm after run
)
```

### Changed file: `ui/src/workspaces/switcher.ts`
- **Keep:** chip rendering, the right-click row/chip context menu (color + rename), `createAndSwitch()`.
- **Delete:** the popover open/render/search/keyboard logic (everything that the new palette supersedes).
- **Re-point:** chip click and `togglePopover()` now delegate to `CommandPalette.toggle()`.

### Changed file: `ui/src/workspaces/finder.ts`
- Replace the substring-tier `filterAndRankTabs` with a **unified provider** that emits `PaletteItem[]` across all three kinds and ranks them with `fuzzyScore`.
- Keep `TabRow` (still the shape `manager.listAllTabs()` returns); map `TabRow` → `PaletteItem`.

### New file: `ui/src/workspaces/actions.ts`
Static action registry. v1:
| Action | `run` |
|---|---|
| New workspace | `manager.createAndSwitch()` |
| Rename current workspace | open rename affordance for active workspace |
| Close current tab | close active tab in active workspace |

Easily extensible — adding an action is one array entry.

---

## Data model

```ts
export type PaletteKind = "workspace" | "tab" | "action";

export interface PaletteItem {
  kind: PaletteKind;
  id: string;             // stable key for dedupe/highlight
  title: string;          // primary label (fuzzy-matched)
  subtitle?: string;      // "18 tabs · 1m ago" | "in pandoras › raven"
  color?: string | null;  // workspace dot color
  icon?: string;          // action glyph
  score: number;          // fuzzy rank, higher = better
  run: () => void | Promise<void>;
}

export interface PaletteAction {
  id: string;
  title: string;
  icon?: string;
  run: () => void | Promise<void>;
}
```

Providers:
- **Workspaces** — from `WorkspaceManager` (`WorkspaceView[]`). `subtitle` = `"N tabs · <age> ago"`. `run` = switch to workspace.
- **Tabs** — from `manager.listAllTabs()` (`TabRow[]`). `subtitle` = `"in <workspace> › <group?>"`. `run` = switch workspace + activate `tabIndex`.
- **Actions** — from the static registry. `run` = invoke.

---

## Search & ranking

- For a non-empty query: compute `fuzzyScore(query, item.title)` for every item; items scoring 0 (no subsequence match) are dropped. Optional secondary weaker pass on `subtitle`. One unified ranked pool.
- **Partition** the ranked pool into sections by `kind`, preserving rank order within each section.
- **Per-section caps** on render: 5 workspaces, 8 tabs, 6 actions (constants, tunable).

### Empty-query default (quick-switch)
- **Workspaces** section: all workspaces sorted by `last_used_at` desc (most-recent on top).
- **Tabs** section: current workspace's tabs (active tab excluded or shown last).
- **Actions** section: hidden when query is empty (no noise on the fast path).
- Result: ⌘⌥T + Enter selects the most-recent workspace/tab and jumps.

---

## Rendering & interaction

- Sections rendered in fixed order **Workspaces → Tabs → Actions**, each with a group header (`.command-palette-section-header`), only when that section has ≥1 item.
- Cursor is a **flat index over the flattened visible item list** (headers excluded). ↑/↓ traverse across section boundaries; headers are visually skipped.
- `Enter` → `await item.run()` then `close()` then `focusTerminal?.()`.
- `Esc` → if query non-empty, clear query (first press); else close (matching current switcher two-stage Esc).
- Click on a row runs it; mousemove sets cursor.
- Matched substring in `title` wrapped in `<mark>` (reuse `highlightMatch`/`escapeHtml` helpers; extract to a shared util if cleaner than duplicating).

---

## Keybindings (wiring in `main.ts`, unchanged triggers)
- `⌘⌥T` → `palette.toggle()`
- `⌘⇧P` → `palette.toggle()`
- `⌘⌥N` → `manager.createAndSwitch()` (direct, no palette)

---

## CSS (`ui/src/styles.css`)
New `.command-palette-*` block mirroring `.recall-palette-*` (centered overlay, dimmed backdrop, card, input row, label chip, listbox). Add:
- `.command-palette-section-header` — small uppercase muted label (uppercase via CSS per house convention).
- `.command-palette-item` rows: grid `dot/icon | title | subtitle`, `.active` + hover states using `--ink-rgb` alpha.
- True-Dark: elevated/selected surfaces use neutral (text-primary) alpha lifts, **not** accent tints.
Remove now-dead `.workspace-popover*`, `.workspace-search*`, `.workspace-result*` rules superseded by the palette (keep `.workspace-rowmenu*` context-menu and chip styles).

---

## Testing

Unit (vitest, following existing palette test conventions):
1. Unified provider: exact-prefix title across kinds ranks above looser matches.
2. Section partitioning + per-section caps respected.
3. Empty-query frecency: most-recent workspace first; actions hidden.
4. Flat-cursor traversal skips headers, wraps correctly.
5. Each v1 action's `run` invokes the right manager method (spy/mock).

DOM-level:
6. Open → type → Enter runs the selected item's `run` and closes.
7. Two-stage Esc (clear, then close).

---

## Files touched
- **New:** `ui/src/workspaces/palette.ts`, `ui/src/workspaces/actions.ts`, plus test files.
- **Changed:** `ui/src/workspaces/switcher.ts` (strip popover, keep chip+menu), `ui/src/workspaces/finder.ts` (unified provider), `ui/src/main.ts` (keybinding wiring), `ui/src/styles.css`.
- **Reused:** `ui/src/mentions/fuzzy.ts` (`fuzzyScore`), `ui/src/workspaces/manager.ts` (data + switch ops).
