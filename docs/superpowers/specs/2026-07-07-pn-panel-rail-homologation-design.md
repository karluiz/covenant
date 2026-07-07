# Covenant panel (project-notes) → rail-* homologation

**Date:** 2026-07-07
**Status:** Approved (approach B)

## Problem

The Covenant panel (⌘-club panel with tabs `commands / prompts / notes / docs / drafts`)
speaks two visual languages:

- **drafts** already uses the shared `rail-*` primitives (same as Tasker and the six
  homologated right-rail panels) but sits inside two padded containers
  (`.pn-body` 12px + `.pn-drafts-tab` 8px + gap 8px), so rows float ~20px from the
  panel edge and hairline separators never reach it.
- **commands / prompts / notes** use bespoke `pn-*` chrome: rounded cards, always-visible
  text buttons (`paste edit ×`), large gaps. Duplicates what `rail-*` already solves and
  wastes horizontal space.
- **docs** is a full-surface markdown editor — not a list; row homologation does not apply.

## Decision

Migrate the list tabs' markup to the shared `rail-*` primitives and delete the
duplicated `pn-*` row CSS (approach B). Same move as the right-rail homologation
(v0.8.108). One source of truth; edge-to-edge dense rows.

## Design

### Panel (`panel.ts` + `styles.css`)
- `.pn-body` gains a flush variant: `padding: 0` when the active tab is a list tab
  (`commands`, `prompts`, `notes`, `drafts`). `updateTabUI()` toggles `pn-body--flush`.
- `docs` keeps the padded body.
- Fullscreen keeps `24px 80px` (existing `.pn-fullscreen .pn-body` rule wins on
  specificity; verify, don't assume).

### drafts (`drafts-tab.ts`)
- No markup changes. `.pn-drafts-tab` loses `padding` and `gap`; keeps
  `flex column + height:100% + overflow-y:auto`.

### commands (`commands-tab.ts`)
- Row → `div.rail-row` (keep `dataset.id`):
  - `.rail-row-line > .rail-name` — title
  - `.rail-cmd` — command in mono, single line, ellipsis
  - `.rail-row-actions` — hover-reveal icon buttons: paste, edit, trash
    (`Icons` set, `attachTooltip` per button — never `title=`)
- `+ New command` button → `.rail-new`.
- Inline editor (`.pn-cmd-editor`) kept, wrapped so it gets side padding inside the
  flush body (e.g. `margin: 8px var(--rail-pad-x)`).

### prompts (`prompts-tab.ts`)
- Row → `rail-row` with `.rail-name` (title) + `.rail-meta` (body preview, one line,
  ellipsis) + hover-reveal actions: send, edit, trash.
- Drag-reorder handlers unchanged; drop indicators (`pn-prompt-drop-before/after`)
  restyled as accent top/bottom borders on `rail-row`.
- `+ New prompt` → `.rail-new`; editor same treatment as commands.

### notes (`notes-tab.ts`)
- Textarea input stays on top, inside a padded wrapper (`var(--rail-pad-x)`).
- `recent` label → `.rail-divider`.
- Note card → `rail-row`: body text (3-line clamp, not nowrap) + `.rail-meta` stamp +
  hover-reveal trash.

### CSS cleanup (`project-notes/styles.css`)
- Delete: `.pn-cmd-row`, `.pn-cmd-meta/title/code/actions` button chrome,
  `.pn-prompt-row` + meta/actions, `.pn-note-card` + stamp/body/del,
  `.pn-drafts-tab` padding/gap, `.pn-cmd-new`, `.pn-prompt-new`.
- Keep: editors (`.pn-cmd-editor`, `.pn-prompt-editor`), `.pn-note-input`,
  docs styles, panel shell.
- New: `.pn-body--flush`, drop-indicator overrides, note-body clamp — a few lines only.
- Multi-action rows need a shared `.rail-row-actions` group (the existing single
  `.rail-row-action` chrome positions one button); add the group container to the
  shared rail block in `ui/src/styles.css` if it doesn't exist yet.

### Tests
- Update `commands-tab.test.ts`, `prompts-tab.test.ts`, `notes-tab.test.ts`,
  `drafts-tab.test.ts`, `panel.test.ts` to the new class names / structure.
- Run from repo ROOT (`npm test`), not `ui/`.

## Constraints

- Sharp corners: any new surface is `border-radius: 0` (except 50% dots).
- No native tooltips — `attachTooltip` only.
- English-first copy (unchanged strings are already English).
- No new dependencies; frontend-only change.

## Out of scope

- docs tab visual changes.
- The Spec Creator surface itself.
- Right-rail panels (already homologated).
