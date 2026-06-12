# TASKER Kanban Board — Design

**Date:** 2026-06-08
**Branch:** `worktree-tasker-kanban`
**Status:** Approved (design), pending implementation plan

## Summary

Add a **Board** view to the TASKER panel: a kanban board whose columns are task
statuses, scoped to one project at a time. The board is reached by a `List | Board`
toggle in the TASKER header; switching to Board expands the panel to fullscreen using
the same mechanism Project Notes already uses for its `⤢` fullscreen.

The feature is **view-only over existing data**. Tasks already carry `status`
(`pending | active | done | cancelled`) and a parent project, so there is **no backend
work, no type changes, and no storage migration**. Persistence stays in
`localStorage` via the existing `TaskStorage`.

This is variant **A** ("status columns, one project") from brainstorming. Variants B
(swimlanes) and C (project-as-columns) are explicitly out of scope.

## Goals

- A fullscreen kanban view of one project's tasks, columns = status.
- Drag a card between columns to change its status, persisted immediately.
- Create tasks inline per column.
- Reuse existing task vocabulary (priority spine, checkbox, due badge, tags) and the
  existing task-details affordance.
- Keep `panel.ts` focused — board logic lives in a separate module.

## Non-Goals (MVP)

- Manual reordering of cards within a column (needs a new `order` field — deferred).
- A `Cancelled` column (cancelled tasks stay in the List view only).
- Swimlanes / cross-project board (variants B and C).
- Backend persistence or multi-device sync.

## Behavior

### View toggle and expand

- The TASKER header gains a segmented control: **`List | Board`**.
- **List** mode is today's rail, unchanged.
- **Board** mode expands `#tasker-panel` to fullscreen, mirroring Project Notes'
  `.pn-fullscreen`: `position: fixed; inset: 38px 0 0 0; z-index: 80; width: 100vw`,
  borders removed. The terminal underneath is covered, not reflowed.
- Exiting Board (flip to **List**, press `Esc`, or `×`):
  - Flip to **List** → collapse back to the rail, panel stays open.
  - `Esc` → same as flipping to List.
  - `×` → close the panel entirely.
- The active view mode is persisted in `localStorage` under `covenant.tasker.view`
  (`"list" | "board"`) and restored on panel open.

### Columns

- Three columns, fixed order:
  - **To Do** ← `pending`
  - **In Progress** ← `active`
  - **Done** ← `done`
- Each column header shows its name (with a status swatch) and a live count.
- `cancelled` tasks are **not** rendered on the board; they remain visible in List.

### Project scope and switcher

- The board shows **one project at a time**.
- A `▾` project switcher sits in the board toolbar. Selecting a project re-renders the
  board with that project's tasks.
- Default project on open = last-viewed project, persisted under
  `covenant.tasker.board-project` (project id). Fallback to the first project if the
  stored id no longer exists.
- If only one project exists, the switcher renders the project name without a dropdown.

### Cards

- A card mirrors the List row's vocabulary:
  - priority spine on the left (`urgent`/`high`/`normal`/`low` colors),
  - a checkbox that toggles `done`,
  - title,
  - due-date badge (when set),
  - tag badge(s) (when set),
  - a description indicator (when the task has a description).
- Clicking a card opens the existing task-details affordance (reuses the panel's
  `selectedTask` flow), so editing on the board matches editing in the list. In Board
  (fullscreen) mode it surfaces as a right-anchored overlay sheet, since the inline
  expand-in-place used in List has no anchor on the board.
- Within a column, cards are ordered by **priority (urgent → low), then due date,
  then creation time**. No manual drag-to-reorder in the MVP.

### Inline create

- Each column footer has a **`+ Add task`** control.
- Adding creates a task in the **current project** with the **column's status**
  (e.g. `+ Add task` under *In Progress* creates an `active` task). Reuses the existing
  inline composer.

### Drag and drop

- Implemented with **pointer events + `document.elementFromPoint`**, not HTML5 DnD
  (the Tauri WKWebView swallows in-page HTML5 drag events). This follows the existing
  tab-strip drag in `ui/src/tabs/manager.ts`.
- A 5px movement threshold distinguishes a drag from a click.
- During drag, a floating ghost of the card follows the pointer; the hovered column
  highlights via a CSS class (e.g. `.kb-col--drop`).
- On drop over a column, the task's `status` is set to that column's status and
  persisted. On drop outside any column (or back on the origin), nothing changes.
- Setting status to `done` sets `completedAt`; moving out of `done` clears it —
  reusing the panel's existing status-change semantics.

## Architecture

### New modules

- **`ui/src/tasker/board.ts`** — `BoardView` class.
  - Responsibility: render the three columns and their cards for a given project,
    handle pointer-drag between columns, and handle inline add.
  - Interface: constructed with a host element and a small deps object
    (`storage`, `onTaskSelect(taskId)`, `onChange()`). Exposes
    `render(projectId: string)` and `destroy()`.
  - It is a **pure view** over `TaskStorage` — it holds no task state of its own; all
    mutations go through `storage` and trigger a re-render.
  - Depends on: `TaskStorage`, the `Task`/`Project`/`TaskStatus` types, the tooltip
    helper (`attachTooltip`).

- **`ui/src/tasker/board.css`** — board styling (columns, cards, drag ghost, drop
  highlight) using Covenant design tokens, with `body.theme-light` and
  `body.theme-true-dark` overrides. Imported from the panel's CSS entry the same way
  `tasker/styles.css` is.

### Changed files

- **`ui/src/tasker/panel.ts`** — owns the integration:
  - renders the `List | Board` segmented toggle and the project switcher,
  - holds `viewMode` state (persisted to `covenant.tasker.view`) and the board project
    id (persisted to `covenant.tasker.board-project`),
  - toggles the `body.tasker-board` class on enter/exit and wires `Esc`,
  - instantiates `BoardView`, passes `onTaskSelect` (→ existing details flow) and
    `onChange` (→ refresh counts / re-render), and tears it down on close.
  - Board rendering is delegated to `BoardView`; `panel.ts` does not grow a second
    render path of its own.

- **`ui/src/styles.css`** (global) — `body.tasker-board` rules that take
  `#tasker-panel` fullscreen (mirroring the existing `.pn-fullscreen` block), and
  restore on exit. No grid-collapse gymnastics are required because the fullscreen
  panel overlays the layout at `z-index: 80`.

### Unchanged

- `ui/src/tasker/types.ts` — no new fields.
- `ui/src/tasker/storage.ts` — existing CRUD is sufficient (`updateTask`,
  `createTask`, `getAllTasks`/per-project read).
- No Rust / Tauri command changes.

## Data Flow

1. **Toggle** → `panel` sets `viewMode`, toggles `body.tasker-board`, persists the
   mode, and renders: List → existing render path; Board → `BoardView.render(projectId)`.
2. **Drop** → `BoardView` calls `storage.updateTask(id, { status })` (and
   sets/clears `completedAt`), then re-renders the affected columns and updates counts
   via `onChange`.
3. **Add** → `BoardView` calls `storage.createTask({ projectId, status })`, then
   re-renders.
4. **Card click** → `BoardView` calls `onTaskSelect(id)`; the panel opens its existing
   task-details affordance.
5. **Switch project** → panel persists the new project id and calls
   `BoardView.render(newProjectId)`.

## Testing

Vitest + jsdom, matching the existing `ui/src/tasker/panel.test.ts` style.

- Toggling to Board sets `viewMode = "board"` and adds `body.tasker-board`; toggling
  back (and `Esc`) removes it.
- `BoardView.render` buckets a project's tasks into the three columns and shows correct
  counts; `cancelled` tasks are excluded.
- Simulating a pointer drop of a card on a different column updates the task's `status`
  (and sets/clears `completedAt`) in storage.
- `+ Add task` under *In Progress* creates an `active` task in the current project.
- Switching the project switcher re-renders with the other project's tasks.
- Cards order within a column by priority → due date → creation time.
- Drag is wired through pointer events (no `dragstart`/`drop` HTML5 listeners).

## Risks / Notes

- **Fullscreen interaction with other right-rail panels:** entering Board must close
  competing panels (Teammate / Project Notes / Activity) the same way opening TASKER
  already does, so two surfaces never claim the rail at once.
- **Pointer-drag correctness:** follow `tabs/manager.ts` precisely (activation
  threshold, ghost element, `elementFromPoint` hit-testing, cleanup on pointerup) to
  avoid the known HTML5-DnD-swallowed pitfall.
- **True Dark / light themes:** columns and cards must use the neutral-lift tokens on
  True Dark (elevated surfaces need text-primary-based lifts, not accent tints) and
  flip correctly under `body.theme-light`.
- **Deferred `order` field:** when manual reorder is added later, it introduces a
  `Task.order` field and a one-time backfill; designed to be additive.
