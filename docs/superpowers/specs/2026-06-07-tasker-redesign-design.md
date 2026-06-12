# Tasker Redesign — Design Spec

**Date:** 2026-06-07
**Status:** Approved (brainstorming)
**Area:** `ui/src/tasker/` (right-rail task panel)

## Problem

The Tasker panel (an earlier executor-generated Microsoft-To-Do-style todo
list) does not feel native to Covenant, and its status model is broken:

1. **Wrong accent.** The active filter pill uses raw `#3b82f6`; Covenant's
   accent is `--accent #7aa2f7`.
2. **Off-palette grays.** The panel references a non-existent `--text` token
   throughout, silently falling back to hardcoded `#d5d9de` instead of the
   real `--text-primary #f5f6f7` / `--text-secondary`.
3. **Box-in-box-in-box.** A bordered task card holds bordered form fields
   holding a bordered priority grid. Covenant rails are flat and quiet.
4. **Heavy inline form.** Expanding a task explodes a large always-visible
   Title/Description/Priority/Due form that dominates the rail.
5. **Native `prompt()`** is used to create a project — breaks the aesthetic
   and violates the no-native-dialogs house rule.
6. **No way to set a task "Active."** The checkbox only toggles
   `done ↔ pending`. The `active` status exists in the type but has no UI,
   so the **Active filter is always empty**.

## Goals

- Make Tasker visually homogeneous with sibling right-rail panels
  (Activity / Teammate / Project Notes): real tokens, flat surfaces.
- Fix the lifecycle so all four filters (All/Active/Pending/Done) work.
- Replace the heavy inline form with lightweight inline editing.
- Remove the native `prompt()`.

## Non-Goals (YAGNI)

Subtasks, tags, recurrence, time tracking (estimate/spent), and
session/group association. These fields stay in `types.ts` but get **no UI**
in this pass. `cancelled` status stays in the type but is unused in the UI.

## Design

### Visual system

- Remove every hardcoded color fallback and the `--text` references. Use:
  `--sidebar-bg`, `--border`, `--text-primary`, `--text-secondary`,
  `--text-tertiary` (where defined), and `--accent`. Where a token is
  genuinely absent in the theme, add it to `:root` in `ui/src/styles.css`
  rather than hardcoding in `tasker/styles.css`.
- **Flat rows:** task rows have no per-card border. Separation comes from
  hover tint (`color-mix(... var(--text-primary) ~3.5%)`) and the existing
  project dividers. This matches the Activity/Teammate rails.
- Project/list names render **uppercase via CSS** (`text-transform`), never
  by mutating strings (house rule).
- Tooltips, if any, route through `attachTooltip` from
  `ui/src/tooltip/tooltip.ts` — never `element.title`.

### Task row

Layout: `[checkbox] [priority dot] [title] … [due chip]`.

- **Hover** reveals a `▷ start` affordance (text/icon) on Pending rows.
- **Active** task: 2px `--accent` stripe on the left edge + an `❚❚` glyph
  inside its checkbox slot + a subtle accent-tinted row background.
- **Done** task: dimmed (~0.58 opacity) + strikethrough title.
- Due chip shows relative date (Today/Tomorrow/weekday/short date); overdue
  (and not done) uses the red treatment.
- A `＋ Add task` affordance sits at the bottom of an expanded project (kept
  from current behavior).

### Status model (the core fix)

Three active states: `pending → active → done`.

Transitions:
- `▷ start` (hover affordance on the row): `pending → active`.
- **Checkbox**: completes from any state → `done` (sets `completedAt`).
  Clicking a **done** task's checkbox reopens it → `pending`
  (clears `completedAt`).
- Inside an **open** (expanded) task, the **status chip** opens a popover to
  jump directly to any of Pending / Active / Done.

Filter semantics (existing filter type `TaskStatus | "all"`):
- `all` → every task.
- `active` / `pending` / `done` → `t.status === filter`.

All four filters now have real contents.

### Inline editing (replaces the form)

Clicking a row toggles an expanded, **borderless** edit block indented under
the row (no nested boxes):

1. **Title** — edited in place (click title text → editable input; Enter/blur
   commits).
2. **Note** — a single borderless, auto-growing line
   (placeholder: "Add notes, links, acceptance criteria…"). Commits on blur /
   ⌘↩.
3. **Chip row** — `[status] [priority] [due] … [Delete]`:
   - **status chip** → popover (Pending/Active/Done).
   - **priority chip** → popover (Low/Normal/High/Urgent, each with its dot).
   - **due chip** → compact date picker; clearing removes the due date.
   - **Delete** chip → right-aligned, red treatment; deletes the task.

Popovers are small Covenant-styled menus (surface `#1e2128`-equivalent via
token, `--border`, soft shadow). They close on outside-click / Esc.

### New list (replaces `prompt()`)

The `＋` action in the panel header reveals an **inline composer** row: a
borderless text input ("New list name…"). **Enter** creates the project and
expands it; **Esc** cancels. No native dialog.

## Components / Boundaries

- `tasker/types.ts` — unchanged (fields already present).
- `tasker/storage.ts` — `TaskStorage` (localStorage CRUD). Add no new public
  methods unless a transition needs one; `updateTask` already covers
  status/priority/dueDate/title/description. Verify `completedAt` is set and
  cleared on the done↔reopen path.
- `tasker/panel.ts` — `TaskerPanel`: rendering + event wiring. Refactor the
  render methods for rows, the inline edit block, popovers, and the new-list
  composer. Replace `showNewProjectDialog()`'s `prompt()` with the inline
  composer state. Add popover open/close state. Keep the full re-render model
  (`render()` after each mutation) — it is simple and the list is small.
- `tasker/styles.css` — rewrite against real tokens; remove fallbacks and the
  `--text` references; flatten surfaces; add popover + composer styles.

State held by `TaskerPanel` (additions): `composingProjectId` (exists),
`selectedTask` (exists), plus transient popover state (which chip/task is
open) and a new-list-composer-open flag.

## Error / Edge Handling

- Empty title on create/rename → no-op (current behavior).
- localStorage write failures → swallowed (current behavior, private mode).
- Reopening a done task clears `completedAt`.
- Due date cleared → `dueDate` becomes `undefined`.
- Outside-click / Esc closes any open popover and the new-list composer.

## Testing (Vitest + jsdom)

New/updated tests in `ui/src/tasker/`:

1. **Status transitions:** start flips pending→active; checkbox completes
   any state→done and sets `completedAt`; checkbox on done reopens→pending and
   clears `completedAt`; status-chip popover sets each state directly.
2. **Filter contents:** with a task in each state, each filter shows exactly
   the matching tasks; `all` shows everything; Active filter is non-empty.
3. **Inline edit:** create via composer; edit title in place; edit note;
   change priority via popover; set/clear due date; delete task.
4. **New-list composer:** `＋` opens composer; Enter creates + expands;
   Esc cancels; empty name is a no-op.
5. **Regression:** `window.prompt` is never called (spy asserts 0 calls).

## Rollout

UI-only (TS + CSS); Vite HMR picks it up — no `respawn` needed. The module is
already wired into the build (typechecks today). Ship in a normal patch.
