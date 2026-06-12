# Tasker Panel Redesign — Design

**Date:** 2026-06-07
**Status:** Approved (design)
**Scope:** Visual + interaction redesign of the Tasker right-rail panel (`ui/src/tasker/`). Plus a bug fix for the custom date picker not rendering (clipping).

## Problem

The current Tasker panel reads as messy: dashed/dotted borders on group sections and "Add task", a heavy nested box around the expanded task with inconsistent chip buttons (Pending / Normal / Add date pills + a loose red trash chip), and weak visual hierarchy (projects, tasks, and chips all carry similar visual weight). Separately, the custom calendar popover does not render — it is clipped by `.tasker-task { overflow:hidden }` and the panel's `transform` (from the open animation's `both` fill) which turns it into the containing block for the `position:fixed` menu.

## Direction

**Linear / dense** (chosen over "calm list" and "soft cards"). Hierarchy comes from density, color spines, and hairline dividers — not boxes.

### Inline editing controls (chosen over pill-popovers)

In the expanded task detail, fields are edited inline where possible — fewer clicks, controls always visible.

## Components

All changes are within `ui/src/tasker/panel.ts` (markup + event wiring) and `ui/src/tasker/styles.css` (visual language). No changes to `storage.ts`, `types.ts`, or the data model.

### 1. Header + filters
No structural change. Tighten spacing. Filter buttons stay as pills; the active filter uses the accent fill (existing behavior). "New list" trigger ("+") stays in the header.

### 2. Group headers (Inbox / project name)
- Separated by a hairline top border (`1px solid var(--border)`), no background band.
- Name rendered UPPERCASE via CSS `text-transform` (never by mutating the string — see project convention).
- Fold triangle (▶ / ▼) on the left, task count chip on the right.
- Remove the `.tasker-tasks` background overlay (already done — flat).

### 3. Task row (collapsed)
Single line: `[checkbox] [title] … [due muted] [⋯]`.
- A 2px left **spine** colored by priority replaces the inline priority dot:
  - low `#22c55e`, normal `#eab308`, high `#f97316`, urgent `#ef4444` (existing palette).
- Due date shows as a muted right-aligned label when set.
- The `⋯` overflow affordance and the `start` action appear on hover (and when the row is selected).
- No dashed borders anywhere.

### 4. Expanded detail — key:value sheet
Inset (~`padding-left: 35px`), slightly darker background (`rgba(0,0,0,.18)`), same colored left spine as the row.

Fields, each as a `key:value` line with a fixed-width (~66px) muted key:
- **Status** — a 3-segment inline switch: `Pending · Active · Done`. The active segment uses the accent fill. Clicking a segment sets status (sets `completedAt` when → done, clears it otherwise). Replaces the status popover menu.
- **Priority** — 4 selectable dots (low/normal/high/urgent) using the palette above. The selected dot gets a ring (`outline`/`box-shadow`). Clicking a dot sets priority. Replaces the priority popover menu.
- **Due** — a pill `📅 Add date` (or the formatted date when set). Opens the custom calendar popover (see §6). A "Clear date" affordance lives inside the calendar.
- **Notes** — full-width textarea, muted placeholder. Unchanged behavior (`change` persists `description`).
- **Delete** — a small muted text action at the bottom-right of the sheet; turns red on hover. Replaces the loose red trash chip.

The status/priority popover menus (`renderStatusMenu`, `renderPriorityMenu`) and the `openMenu` `"status"`/`"priority"` kinds are removed. `openMenu` is reduced to the date case (or replaced by a dedicated `datePickerTaskId` field).

### 5. Add task
Quiet `＋ New task` row (no dashed border). Above the empty state when the group is empty; below the task list when tasks exist (already implemented this way).

### 6. Date picker (bug fix)
The custom calendar (built this session — Mon-first 6×7 grid, prev/next/today nav, today ringed, selected filled with accent, "Clear date") must actually render. Fix the clipping:

- **Portal the calendar to `document.body`** instead of leaving it nested inside `.tasker-task`. As a child of `<body>`, it is not clipped by ancestor `overflow` and is not captured by the panel's `transform` containing block.
- Keep `position: fixed`; compute `top`/`left` from the Due chip's `getBoundingClientRect()`. Prefer below the chip; flip above if it would overflow the viewport bottom; clamp horizontally to the viewport.
- Manage lifecycle: create the element on open, position it, remove it on selection / clear / outside-click / panel re-render / panel close. The outside-click handler must treat clicks inside the portaled calendar as "inside".

## Data flow
Unchanged. All interactions call existing `TaskStorage` methods (`updateTask`, `deleteTask`) then re-render. The calendar writes `dueDate` (ms at local midnight) or `undefined`.

## Error handling
No new failure modes. Date parsing uses `new Date(`${yyyy-mm-dd}T00:00:00`)`. Positioning falls back to sane defaults if `getBoundingClientRect` returns zeros (e.g. jsdom in tests).

## Testing
Update `ui/src/tasker/panel.test.ts` to the new markup/interactions:
- Status set via the segmented switch (click the `Active`/`Done` segment).
- Priority set via the priority dots.
- Due set via the calendar day button; cleared via "Clear date" (calendar may be portaled to `document.body` — query there, not only under `host`).
- Delete via the new sheet delete action.
- Empty-state and add-task affordances unchanged.

## Out of scope
- Data model / storage changes.
- Drag-to-reorder, recurring tasks, subtasks.
- Project (list) management beyond what exists.
