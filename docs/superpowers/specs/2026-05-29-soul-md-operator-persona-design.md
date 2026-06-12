# SOUL.md — Operator Persona as a Living Document

**Date:** 2026-05-29
**Status:** Design approved (pending spec review)
**Author:** Karluiz + Claude

---

## Problem

An operator's persona today is a single free-form `persona: String` textarea
persisted as a SQLite column and injected verbatim under a `# PERSONA` header
in the system prompt. Identity is fragmented across separate columns
(`voice`, `hard_constraints`, `escalate_threshold`, `model`, `emoji`, `color`),
the creation flow is "fill a form → INSERT a row", and nothing about it feels
like authoring a *being*. It is weak on four axes the user named:

1. **Shallow content** — a blank box with no shape.
2. **Not a real document** — a DB string, not a file you can edit/share/version.
3. **Lifeless creation UX** — a form, not an act of creation.
4. **Fragmented identity** — character scattered across columns.

## Goal

Re-conceive an operator as a **living document** — a `SOUL.md` file the user
authors, edits in any editor, hot-reloads, and shares. The file is the soul;
the database holds only runtime state.

---

## Decisions (locked)

| Question | Decision |
|---|---|
| Soul body style | **Origin Letter** — literary, first-person ("I was made to wait so you wouldn't have to") |
| Source of truth | **File is the soul, DB is the body** — SOUL.md owns identity; DB holds runtime state only |
| File location | **App data dir** — `<app_config_dir>/operators/<slug>/SOUL.md` (same dir as `history.db`) |
| Frontmatter editing | **Both** — raw YAML in-file is source of truth; split editor mirrors knobs as synced form controls |
| Creation flow | **Archetypes** — gallery of bundled souls → seed → split editor (Origin-Letter library, shareable `.md`) |
| Scope | **Full** — format + migration + hot-reload + archetype gallery + split editor in one plan |
| Safety | **Stays in code** — `safety.rs` blocklist + `HARD_CONSTRAINTS` const untouched; per-operator `hard_constraints` deny-regexes preserved (moved into frontmatter, not prose); soul prose reinforces judgment only |

> **Implementation refinement (HOW, not WHAT):** rather than nest a `Soul` object
> inside `Operator` and rewrite ~12 call sites across `operator.rs`,
> `teammate/llm.rs`, `telegram/outbound.rs`, and `to_session_ref`, the plan keeps
> `Operator`'s flat field surface (`name`, `emoji`, `color`, `tags`, `persona`,
> `escalate_threshold`, `model`, `voice`, `hard_constraints`) and changes the
> **source of truth**: those fields are *hydrated from* `SOUL.md` on load and
> hot-reload; `create`/`update` write the file first. The DB row keeps a
> denormalized copy as cache/fallback plus runtime state (`id`, `soul_path`,
> `xp`, `is_default`, timestamps). Behavior and UX are identical to the approved
> design; only the Rust struct shape differs from the sketch above. This is the
> low-blast-radius path.

---

## SOUL.md format

YAML frontmatter (shareable identity + machine config) + markdown body (the soul).

```markdown
---
name: Atlas
avatar: pack2:guardian
color: "#c4a7ff"
model: claude-sonnet-4-6
voice: warm              # terse | warm | formal
escalate_threshold: 0.55
tags: [deploys, night]
---

# Atlas

I was made to wait so you wouldn't have to.
I'm patient with broken builds, impatient with work that drifts from the ask.
While you're gone I will never force-push, reach for a secret, or spend what
can't be refunded — for those I come find you.
```

- **Frontmatter** is the machine contract: `name`, `avatar`, `color`, `model`,
  `voice`, `escalate_threshold`, `tags`. All optional except `name`; missing
  fields fall back to documented defaults (voice `terse`, threshold `0.6`,
  model = system default, avatar `🤖`, color `#6B7280`).
- **Body** is the soul — injected into the system prompt where `# PERSONA` is
  today.
- **`hard_constraints`** stays a *structured* frontmatter field (multiline
  string), **not** prose. Each non-empty line compiles into a per-operator deny
  regex at `operator.rs:1890-1897` (`deny_extra_for_session`) — folding it into
  the body would silently disable those regexes. It lives in the file (unifying
  identity) but keeps its enforcement wiring. The body MAY also narrate the hard
  lines for the LLM's judgment; enforcement is the frontmatter field + code.

---

## Architecture

### Source of truth split

**SOUL.md owns** (was DB columns): `name`, `avatar`/`emoji`, `color`, `model`,
`voice`, `escalate_threshold`, `tags`, persona body, (folded) `hard_constraints`.

**DB owns** (runtime/app state only): `id`, `soul_path`, `xp`, `is_default`,
`created_at_unix_ms`, `updated_at_unix_ms`.

> `xp` mutates constantly (per-decision) — it must never live in a hand-edited
> file. `is_default` and pin state are app concerns, not identity.

### Storage layout

```
<app_config_dir>/                       # macOS: ~/Library/Application Support/<bundle-id>/
├── history.db                          # existing — operators table slims to runtime state
└── operators/
    ├── atlas/SOUL.md
    └── vigil/SOUL.md
```

`<slug>` derives from `name` (kebab-case, ascii, collision-suffixed). The DB
`soul_path` column is the authoritative pointer (handles renames without moving
files; an explicit rename may move the dir but the pointer is what's read).

### New module: `crates/app/src/soul.rs`

Pure parse/serialize/validate. No I/O of its own beyond what the registry hands it.

```rust
pub struct Soul {
    pub frontmatter: SoulFrontmatter,   // name, avatar, color, model, voice, threshold, tags
    pub body: String,                   // the markdown soul (already trimmed)
}

pub fn parse(raw: &str) -> Result<Soul, SoulError>;     // split `---` fences, serde_yaml the head
pub fn serialize(soul: &Soul) -> String;                // round-trips; stable key order
pub fn validate(soul: &Soul) -> Result<(), SoulError>;  // name 1..=64, threshold 0.0..=1.0, voice enum
```

- Frontmatter parsed with `serde_yaml`. Body is everything after the closing
  `---`.
- **Round-trip tested**: `parse(serialize(s)) == s` for the canonical shape.
- **Malformed frontmatter** → `SoulError`; the registry keeps the last-good
  in-memory `Operator` and surfaces a soft, non-fatal warning. A bad edit never
  bricks an operator.

### Registry: `operator_registry.rs`

`Operator` slims to runtime + a parsed `Soul` snapshot:

```rust
pub struct Operator {
    pub id: OperatorId,
    pub soul_path: PathBuf,
    pub xp: u64,
    pub is_default: bool,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    pub soul: Soul,              // parsed from soul_path; identity lives here
}
```

- `load(storage)` reads each runtime row, reads+parses its `SOUL.md`, builds the
  in-memory `Operator`.
- `create(...)` writes the `SOUL.md` file first, then inserts the runtime row.
- Accessors that used to read `op.persona`, `op.voice`, etc. now read
  `op.soul.body`, `op.soul.frontmatter.voice`, …

### Hot-reload

Reuse the mission watch cadence (`MISSION_REFRESH_EVERY_TICKS`, ~2.5s). Per tick,
stat each `soul_path`; on mtime change, re-`parse` and swap the in-memory `Soul`.
External-editor edits and in-app saves both flow through the same reload path.

### Prompt injection: `operator.rs`

`build_system_prompt` consumes `op.soul.body` where it consumed `persona`, and
`op.soul.frontmatter.voice` for the voice directive. `HARD_CONSTRAINTS`,
`EXECUTOR_RECOMMENDATION_DIRECTIVE`, `OUTPUT_FORMAT`, and the `safety.rs`
blocklist are **unchanged**. The body is rendered under the existing persona slot.

---

## Creation / edit UX

### Archetype gallery (new operator)

- Bundled souls in repo asset dir `operator-souls/*.md` (alongside
  `shell-integration/`): `guardian.md`, `scout.md`, `surgeon.md`, `diplomat.md`,
  `archivist.md`, plus an in-UI **Blank** option.
- Gallery cards render name, opening lines, and temperament (parsed from each
  archetype's frontmatter + body).
- Selecting an archetype seeds `<app_config_dir>/operators/<slug>/SOUL.md` by
  copying the archetype, then opens the split editor.

### Split editor (create + edit)

- **Left**: SOUL.md source (frontmatter + markdown), monospace.
- **Right**: live markdown render of the body **+** synced form controls for the
  frontmatter knobs (voice dropdown, model dropdown, threshold slider, avatar,
  color). Editing a control rewrites the YAML; editing the YAML updates the
  controls. YAML is source of truth; controls are a mirror.
- **Save** writes the file → registry reload. No separate "persona textarea".
- Reuse the app's existing markdown renderer for the preview if one exists;
  otherwise a minimal renderer scoped to the preview pane.

### Deferred

Flow 3 ("✨ draft from a sentence" — LLM-drafted Origin Letter from one prompt)
is out of scope for this plan; lands later as a button that pre-fills the editor.

---

## Migration

On boot, for each legacy `operators` row lacking a `soul_path`:

1. Compose a `SOUL.md`: frontmatter from columns
   (`name`, `emoji`→`avatar`, `color`, `model`, `voice`, `escalate_threshold`,
   `tags`); body = existing `persona`, with any non-empty `hard_constraints`
   appended under a short "Hard lines" note.
2. Write to `<app_config_dir>/operators/<slug>/SOUL.md`.
3. Set `soul_path` on the row.
4. Read identity from the file thereafter.

Legacy identity columns are **retained for one release** as a read fallback if a
`SOUL.md` fails to parse, then dropped in a follow-up migration. The schema adds
`soul_path TEXT`.

---

## Files touched

**Rust**
- `crates/app/src/soul.rs` *(new)* — parse/serialize/validate frontmatter + body.
- `crates/app/src/operator_registry.rs` — slim `Operator`, load/parse SOUL,
  `create` writes file, hot-reload swap, accessor updates.
- `crates/app/src/storage.rs` — migration: add `soul_path`, generate SOUL.md per
  legacy row, slim/retain columns as fallback.
- `crates/app/src/operator.rs` — `build_system_prompt` reads `op.soul`; wire
  hot-reload into the existing mission-watch tick.
- Tauri commands: `operator_create` (archetype + initial fields),
  `operator_soul_read` / `operator_soul_write`, `operator_list_archetypes`.

**TypeScript**
- `ui/src/api.ts` — reshape `Operator`/`OperatorDraft`; soul read/write +
  archetype-list wrappers.
- `ui/src/settings/operators.ts` — archetype gallery + split editor replace the
  persona textarea.
- `ui/src/settings/operator_presets.ts` → archetype loader.

**Assets**
- `operator-souls/*.md` — bundled archetype souls.

**Dependencies**
- `serde_yaml` (frontmatter). Reuse existing markdown render for preview if present.

---

## Testing

- `soul.rs`: parse/serialize round-trip; malformed frontmatter → `SoulError`;
  missing-body and missing-optional-field defaults; validation bounds
  (name length, threshold range, voice enum).
- Migration: legacy row → SOUL.md generated, identity preserved, `soul_path` set;
  `hard_constraints` folded into body.
- Hot-reload: mtime change re-parses and swaps the in-memory body; parse failure
  keeps last-good + warns.
- Create-from-archetype: writes correct file, copies archetype body, inserts
  runtime row with `soul_path`.
- Prompt assembly: `build_system_prompt` emits the soul body and frontmatter
  voice; `HARD_CONSTRAINTS` / safety blocklist unchanged.

---

## Non-goals

- LLM-drafted souls (flow 3).
- Sharing/import UI beyond "copy the file" (the format makes it trivial; no
  in-app marketplace).
- Changing the decision loop, escalation logic, or safety blocklist.
