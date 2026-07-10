# Project Notes v2 — simplify, capture, Canon-style expand

**Date:** 2026-07-10
**Branch:** `feat/project-notes-v2`
**Status:** approved design

## Problem

The project-notes right-rail panel exposes five tabs — `commands · prompts · notes · docs · drafts` — that don't explain themselves. Users can't tell a "note" from a "doc" from a "draft". The expanded (fullscreen) view just stretches the rail to full width, leaving bare tabs floating in black, unlike the polished Canon / Settings shell. And there is no fast path to capture an interesting piece of agent output into the project's knowledge.

## Goals

1. Reduce the panel to a self-explaining taxonomy.
2. Merge `notes` + `docs` into one **Notes** surface: a stream of editable entry cards.
3. Add an **"Add to notes"** item to the terminal selection context menu that captures the selection (with source attribution) into Notes.
4. Replace the fullscreen "stretch" with a **Canon-style expanded shell**: left nav with grouped sections, a section header (title + one-line description), and subtle-bordered cards.

Non-goals: changing how commands or prompts are stored/executed; building a new drafts experience (Spec Creator already owns drafts).

## Taxonomy — 3 tabs, 2 groups

Collapsed rail tab strip drops from five to three: `Commands · Prompts · Notes`.

Expanded view renders them as a Canon-style left nav with two group headers:

```
LIBRARY          — things you fire
  Commands
  Prompts
KNOWLEDGE        — what the project knows
  Notes
```

- `docs` tab removed. On first load, each group's existing `project_docs` blob (if non-empty) is migrated into **one Note entry** so nothing is lost, then the docs surface is deleted (not hidden).
- `drafts` tab removed from this panel. Spec Creator already owns drafts. No deep-link button in v2 (scope call, confirmed).
- Prompts stays **global** (unchanged storage) — only its presentation moves under the LIBRARY group.

## Notes = stream of entry cards

Each note is an editable / deletable card, reverse-chron, with `+ New note` at the top. Two provenance shapes:

- **Hand-written:** `text` + timestamp.
- **Captured:** `text` + source line, e.g. `from Claude · tab 2 · 2m ago`.

### Backing changes (`crates/app/src/project_notes.rs`, `storage.rs`)

- `project_notes` table gains a nullable `source` TEXT column.
- Notes stop being append-only: add `update_note(id, body)` + Tauri command `project_note_update`.
- `append_note` gains an optional `source` argument.
- Migration: on `project_notes_get` (or a one-time migration path), if `project_docs` has a non-empty blob for the group and it hasn't been migrated yet, append it as a Note (no source) and clear/drop the docs row. Guard so it runs once per group.
- Delete `get_docs` / `save_docs` and the `project_docs_get` / `project_docs_save` Tauri commands after migration lands. Drop `project_docs` table creation from `storage.rs` (leave a no-op if the table already exists — SQLite tolerates the leftover; we simply stop reading it).

### Frontend (`ui/src/project-notes/`)

- `notes-tab.ts`: cards become editable (click to edit inline or an edit affordance), render the `source` line when present.
- `api.ts`: `appendNote(groupId, body, source?)`, add `updateNote(id, body)`, drop `getDocs`/`saveDocs`. `Note` type gains `source?: string`. `Snapshot` drops `docs`.
- Delete `docs-tab.ts` and `drafts-tab.ts` and their wiring in `panel.ts`.
- `panel.ts`: tab list becomes `"commands" | "prompts" | "notes"`.

## "Add to notes" context-menu item

In the terminal selection menu (`ui/src/tabs/manager.ts`, immediately after the "Create prompt" item at ~`manager.ts:1512`):

- Label: **Add to notes**, notepad/plus icon.
- Gated on a non-empty selection (same gate as Copy / Create prompt).
- On click: build `source` from the pane's executor label + tab title (e.g. `Claude · tab 2`), then `projectNotesApi.appendNote(groupId, selection, source)`.
- Toast confirmation, same pattern as Create prompt.
- `groupId` comes from the same per-group context the menu already resolves for the Commands section.

## Expanded view = Canon shell

Replace the `.pn-fullscreen` "stretch the rail" behavior with the Canon cockpit layout (`ui/src/canon/cockpit/view.ts` + `cockpit.css`, class `.canon-cockpit` / `.canon-cockpit-nav`) — the Image #4 look:

- Fixed left nav: uppercase group headers (`LIBRARY`, `KNOWLEDGE`) + item rows, active-item highlight, an `esc` affordance top-right.
- Right pane: a **section header** = title + one-line description, then the section's content in subtle-bordered cards.
- Section descriptions (the self-explaining copy the current UI lacks):
  - Commands — *"Shell snippets you run in this project."*
  - Prompts — *"Reusable prompts you send to an agent."*
  - Notes — *"Things worth keeping — captures and your own notes."*

Collapsed rail stays visually as-is (just three tabs). Only the expanded state adopts the new shell. Reuse Canon's cockpit CSS classes/tokens rather than forking styles, so borders/spacing match exactly.

## Testing

- Rust: `project_notes.rs` tests for `update_note`, `append_note` with `source`, and the docs→note migration (run once, idempotent, non-empty only).
- TS: `notes-tab` renders `source` line when present and omits it when absent; edit updates a card; `panel` shows exactly three tabs.
- Manual/in-app: "Add to notes" from a selection creates a captured card with the right source line; expanded view matches Canon shell in True Dark.

## Migration & safety

- Docs→note migration is one-way and guarded to run once per group; verify on a DB with existing docs content before shipping.
- No secrets handling change; captured text is user-selected terminal output (same trust level as Create prompt, which already exists).

## Files touched (map)

- `crates/app/src/project_notes.rs` — schema, `update_note`, `source`, migration, delete docs fns.
- `crates/app/src/storage.rs` — `project_notes.source` column; stop creating `project_docs`.
- `ui/src/project-notes/api.ts` — API + types.
- `ui/src/project-notes/notes-tab.ts` — editable cards + source line.
- `ui/src/project-notes/panel.ts` — 3 tabs; new expanded Canon shell.
- `ui/src/project-notes/docs-tab.ts`, `drafts-tab.ts` — deleted.
- `ui/src/tabs/manager.ts` — "Add to notes" item.
- Reuse `ui/src/canon/cockpit/cockpit.css` for expanded-shell styling.
