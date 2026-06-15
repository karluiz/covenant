# Spec Creator UX — design

> 2026-06-14 · branch `feat/spec-creator-ux`

Three UX defects in the immersive Spec Creator (`ui/src/spec-chat/`), reported
with screenshots:

1. On returning to / resuming a draft, the section nav chips (Goal, Out of
   scope, …) are **not marked**, and the right-panel cards fall back to skeleton
   placeholders even though those sections were already authored.
2. Section content (Goal in particular) is **read-only**; it should be editable
   and the edit should survive resume and flow into the published spec.
3. The `<!--section:goal-->…<!--/section-->` markers **leak raw** into the
   assistant prose in the reasoning column.

## Root causes

- **(1)** `stream-state.ts` `hydrate()` (l.85) restores `messages` and `finalMd`
  but never rebuilds the `sections` Map, and `phase` is left `null`. The top nav
  `.node` elements only ever get an `.active` class for the *current* streaming
  phase — there is no persistent `done` state. `immersive.ts:102` only passes
  `partial_md` as `finalMarkdown` when status is `Ready`, so in-progress drafts
  hydrate with no section content at all.
- **(2)** `live-spec.ts:41` sets section bodies via `textContent`; there is no
  `contentEditable`, no edit handler, and no backend command to persist an
  edited spec body.
- **(3)** Assistant prose (`m.content` committed at `activity-stream.ts:55`, and
  live `state.text()` at `:121`) is rendered with `esc()` verbatim, so the
  embedded section markers show up literally.

## Design

### Shared section util — `ui/src/spec-chat/sections.ts` (new)

Extract the canonical section list (currently duplicated in `live-spec.ts` and
`entrance.ts`) into one module:

- `SECTIONS: { key: SpecSectionKey; title: string }[]` — single source of truth.
- `titleForKey(key)` / `keyForTitle(title)` helpers.
- `parseSectionsFromMarkdown(md: string | null): Map<SpecSectionKey, SectionView>`
  — splits a spec markdown body on `## <Title>` headers and returns each
  section's body as `{ markdown, status: 'done' }`. Reuses the same
  title-matching regex `entrance.ts:sectionProgress` already relies on.

`live-spec.ts` and `entrance.ts` import from here instead of their local copies.

### Fix 1 — sections marked on return

- `stream-state.ts` `hydrate()` gains an optional `markdown` input. When present
  it calls `parseSectionsFromMarkdown` and seeds the `sections` Map (status
  `done`). `phase` stays `null` (nothing is "actively streaming" on resume) —
  the persistent `done` state below is what marks the chips.
- `immersive.ts` resume path passes `draft.partial_md` **always** (not gated on
  `Ready`) as the hydrate `markdown`. `finalMarkdown` gating for the publish
  button is unchanged (still only `Ready`).
- `live-spec.ts` `render()`: the top nav `.node` toggles a `.done` class when
  `state.section(key)?.status === 'done'`, independently of `.active` (which
  remains the live phase). CSS adds a `.node.done` treatment (filled dot + faint
  check) so completed sections stay visibly marked when not active.

### Fix 2 — editable sections (persist to backend)

- `live-spec.ts`: a section's `.content` becomes `contentEditable="true"` once it
  has content. On `blur` (debounced), capture `textContent`, call
  `state.editSection(key, markdown)`.
- `stream-state.ts` `editSection(key, md)`: updates the `sections` Map; if
  `finalMd` is already set, rebuilds `finalMd` from the Map (canonical
  `## Title\n\n<body>` join, in `SECTIONS` order) so edits flow into publish.
  Exposes the reconstructed markdown to the caller for persistence.
- **Anti-clobber guard:** `render()` skips rewriting a section's `.content` while
  that element is `document.activeElement`, so live `onChange` fires don't wipe
  the caret mid-edit.
- **Backend:** new Tauri command `spec_author_save_markdown(id, markdown)` —
  loads the draft, sets `partial_md`, `save_draft`. Registered in
  `crates/app/src/lib.rs` invoke handler. Wrapper `specAuthorSaveMarkdown` in
  `ui/src/api.ts`. `immersive.ts` calls it after an `editSection`.
- All sections with content are editable (one shared card component), not just
  Goal.

### Fix 3 — section markers as inline chip, not raw

- New `renderProse(text): DocumentFragment | html` util: replaces each
  `<!--section:KEY-->…<!--/section-->` block with an inline chip
  `✓ <Title> drafted`; surrounding prose is escaped as today. An **unclosed**
  `<!--section:KEY-->` (mid-stream, before `<!--/section-->` arrives) hides the
  body from the marker onward and shows a pending chip — the raw `## Goal …`
  body is never shown.
- Applied in `activity-stream.ts` for both committed messages (`:55`) and the
  live streaming bubble (`:121`).

## Testing (TDD)

- `sections.ts`: `parseSectionsFromMarkdown` — full doc, partial doc, empty/null,
  title round-trip.
- `stream-state`: `hydrate` with markdown seeds the Map; `editSection` updates
  Map and rebuilds `finalMd`.
- `live-spec`: nav `.node.done` reflects section status; edit guard skips the
  focused `.content`.
- `activity-stream` / prose util: closed marker → chip; unclosed marker → pending
  chip, no raw body; prose with no markers unchanged.
- Backend: `spec_author_save_markdown` round-trips `partial_md` through
  save/load.

## Out of scope

- Reordering sections, adding/removing sections by hand.
- Rich-text / markdown WYSIWYG editing (plain-text `contentEditable` only).
- Changing the agent's authoring flow or marker format.
