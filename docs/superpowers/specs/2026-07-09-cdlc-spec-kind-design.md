# CDLC Spec Kind (Sub-project 4)

**Date:** 2026-07-09
**Status:** Design approved, spec under review
**Branch:** `feat/cdlc-spec-kind`
**Builds on:** Sub-projects 1–3 (ContextKind foundation + Command + Mcp), merged to main `5b44d59d`.

## Problem

Agent, Context, Command, Mcp, and Skill are first-class CDLC context kinds — each
authored under `.covenant/canon/<kind>/` and projected into every executor. The
roadmap lists **Spec** next, but a spec is structurally different: it is a
**per-task anchor** (goal / out-of-scope / acceptance criteria / file boundaries)
created by the Spec Creator, living in `docs/specs/<id>.md`, and the "Set spec"
modal picks the *one* active spec that anchors a tab. Specs are **not** persistent
always-on context — a repo has many, and projecting all of them into every
executor would be noise.

So Spec does not fit the "author once → project to every executor" model. It gets
**surface parity only**: enumerated and readable in Canon alongside the other
kinds, but **not projected** to any executor config.

## Goal

Add `Spec` as a first-class *enumerable, readable* context kind: `list_context`
surfaces the repo's `docs/specs/*.md`, `CanonStatus` carries them, and the rail +
cockpit show a Specs section (read/preview). No projection.

## Design

### The one structural difference

Spec is the **only kind whose source lives at the repo root (`docs/specs/`), not
under `.covenant/canon/`**, and the only kind with `projectable = false`. Every
place that assumes `.covenant/canon/<dir()>` or projects must special-case (or
simply skip) Spec.

### 1. Backend model (`crates/canon`)

- `ContextKind::Spec` — `label() = "Spec"`. `dir()` returns `"docs/specs"` but is
  interpreted **relative to the repo root** for Spec (documented exception),
  unlike the canon-relative dirs of the other kinds.
- New enumerator `read_specs(repo_root) -> Vec<(String, String)>` (stem, title):
  reads `<repo_root>/docs/specs/*.md`, sorted; **skips** non-`.md` entries
  (so `drafts/` and `assets/` subdirs are naturally excluded) and any file whose
  name starts with `_` (e.g. `_template.md`). Title = the first Markdown heading
  line (`#`/`##`, stripped of leading `#`s and whitespace); fallback to the file
  stem when there is no heading.
- `list_context` Spec loop: `summary = title`, **`projectable = false`**,
  `packageable = false`.
- `read_source` gains a `Spec` arm returning `repo_root.join("docs/specs").join(format!("{name}.md"))` — it does NOT prepend `canon_dir`, unlike every other kind.
- `CanonStatus` gains `specs: Vec<SpecRef>` where `SpecRef { name: String, title: String }`, populated in `status()` from `read_specs`.
- **Projection untouched:** `project_with_active` and `projection_status` are NOT
  modified — Spec projects to nothing.

### 2. UI (rail + cockpit)

- **Rail** (`ui/src/canon/panel.ts`): a `kindSection` **Specs**, order Agents →
  Context → Commands → Mcp → Specs → Skills. Rows: `skillCard` with empty
  `actions`, meta = the title, `fetchPreview: () => canonReadSource(cwd, "spec", name)`.
  Empty hint "No specs published."
- **Cockpit** (`ui/src/canon/cockpit/view.ts`): a **Specs** nav section after
  `mcp`, mirroring `renderMcpSection`, reading `CanonStatus.specs`.
- `canonReadSource` kind union gains `"spec"`; the app `canon_read_source` match
  gains a `"spec"` arm.

### 3. Command wiring

- `crates/app/src/lib.rs` — `canon_read_source` accepts `kind = "spec"`.

## Testing

- `crates/canon`: `read_specs` reads `docs/specs/*.md`, extracts the first-heading
  title, EXCLUDES a `_template.md` and a `drafts/` subdir file, sorts.
- `crates/canon`: `list_context` yields a `Spec` unit with `projectable = false`
  and the title as summary.
- `crates/canon`: `read_source(Spec, ...)` reads from `docs/specs/`, not
  `.covenant/canon/`.
- `crates/canon`: `status()` populates `specs`.
- `ui/src/canon/panel.test.ts`: rail renders a Specs section + empty hint.

## Non-goals (later / rejected)

- Projecting the anchored spec as a task brief (option B — rejected: per-tab vs
  per-repo mismatch).
- Packaging / publish / eval for specs.
- The `Memory` kind (Sub-project 5).
- Editing/creating specs from the Canon surface (that stays the Spec Creator's
  job — Canon only surfaces + reads).

## File touch-list

- `crates/canon/src/kind.rs` — `Spec` variant, `dir()`/`label()`, `read_specs`, `list_context` spec loop.
- `crates/canon/src/install.rs` — `SpecRef`, `CanonStatus.specs`, populate in `status()`; `read_source` `Spec` arm (repo-root path).
- `crates/app/src/lib.rs` — `canon_read_source` `"spec"` arm.
- `ui/src/api.ts` — `SpecRef`, `CanonStatus.specs`, `canonReadSource` union `+ "spec"`.
- `ui/src/canon/panel.ts` — Specs rail section.
- `ui/src/canon/panel.test.ts` — Specs assertions.
- `ui/src/canon/cockpit/view.ts` — Specs nav section.

## Ponytail boundaries

- `// ponytail:` Spec is surface-only — no projection, because a spec is a
  per-task anchor, not always-on context. Revisit only if "project the anchored
  spec" gains a real use case.
- `// ponytail:` title parse is first-heading only; no frontmatter/ID parsing —
  the file stem carries the ID already.
- `// ponytail:` no cap on the Specs list length; it scrolls like Skills.
