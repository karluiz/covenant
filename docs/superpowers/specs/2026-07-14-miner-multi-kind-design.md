# Context Miner — multi-kind routing

**Date:** 2026-07-14
**Status:** approved, ready for plan

## Problem

The Context Miner mines a repo into candidate findings, but the compile step
has a single destination: `write_skill_package`. Everything curated becomes one
**skill**. Yet CDLC recognizes multiple context kinds (skill, subagent, command,
memory, mcp, spec). A "mine context" feature that only emits skills undersells
the ontology. We want a single mining run to route curated findings to the kind
each one actually belongs to.

## Scope

**In (v1):** route findings to **skill · memory · command · subagent**.

**Out:** operators (delegation originates from the principal, not the repo —
never auto-mined), MCP and specs (not derivable from a passive crawl).
Registry publication of compiled artifacts stays on the existing per-kind flow —
no new work.

## Design

### 1. Agent suggests a kind

`emit_finding` gains an optional field `suggested_kind` ∈
`{skill, memory, command, subagent}`, default `skill`.

A new finding **category** `workflow` is added (repeated dev workflows: build,
test, deploy, migrations) alongside the existing five. `CATEGORIES` becomes
`["convention", "pattern", "gotcha", "domain_rule", "glossary", "workflow"]`.

Default category → kind mapping (applied when the model omits `suggested_kind`):

| Category | Default kind |
|---|---|
| `domain_rule`, `glossary` | memory |
| `workflow` | command |
| `convention`, `pattern`, `gotcha` | skill |

`subagent` is **never auto-suggested** — the agent does not decide to create
personas. It is a manual promotion during curation.

The system prompt is updated to mention the kinds and when each fits, but the
model is told the mapping is a hint; the human curates.

### 2. Curation = routing

Each finding card gains a kind selector (chip group; default = suggested kind).
The user accepts and re-routes in place. Re-routing to `subagent` is allowed for
any accepted finding.

The live preview groups accepted findings **by destination kind** instead of
rendering one SKILL.md. Each group shows the target path it will write.

`MinerFinding` (Rust) and the finding card state (`miner/state.ts`) carry a
`kind` field. The reducer gets a `setFindingKind(state, id, kind)` action.

### 3. Compile per kind

`canon_compile_skill` generalizes to `canon_compile_findings`. It groups
accepted findings by `kind` and dispatches to a writer per kind. All writers
live in `crates/canon/src/compile.rs`.

| Kind | Destination | Form |
|---|---|---|
| skill | `.covenant/canon/skills/<name>/` | today's `write_skill_package` (SKILL.md + skill.toml), fed the findings routed to skill |
| memory | `.covenant/canon/memory/<slug>.md` | one file per finding — a durable fact. Frontmatter `description`, body = `body_md`, evidence footer |
| command | `.covenant/canon/commands/<slug>.md` | one file per finding — body = the workflow as a command instruction |
| subagent | `.covenant/canon/agents/<slug>.md` | one file per finding promoted to a persona |

`<name>` is the package name from the form (skill bucket only). `<slug>` is
derived from the finding title (lowercase, dash-joined, deduped against existing
files in the target dir — suffix `-2`, `-3` on collision). Memory/command/
subagent do not use the form name.

`canon_compile_findings` returns the set of written paths grouped by kind so the
UI can report "wrote 3 skills entries, 2 memory, 1 command".

Empty-group kinds are skipped (no empty skill package). If **only** skill
findings exist, behavior is identical to today.

### 4. Form copy

- "SKILL NAME" → "PACKAGE NAME" (still required; names the skill bucket).
  Sub-label: "names the skill package; other kinds derive names from findings".
- Header line "Mined context is packaged as a skill." →
  "Findings route to skills, memory, commands or subagents during curation."

## Files touched

- `crates/agent/src/context_miner.rs` — `CATEGORIES` += `workflow`; `MinerFinding`
  gains `kind`; `emit_finding` schema gains `suggested_kind`; default-mapping fn;
  system prompt copy.
- `crates/canon/src/compile.rs` — `write_memory_entry`, `write_command_entry`,
  `write_subagent_entry`, `slugify`, `dedupe_slug`; keep `write_skill_package`.
- `crates/app/src/canon_miner.rs` — `canon_compile_skill` → `canon_compile_findings`
  (group by kind, dispatch, aggregate written paths).
- `ui/src/api.ts` — command rename + return type (paths grouped by kind).
- `ui/src/canon/miner/state.ts` — finding `kind`; `setFindingKind`; preview
  groups by kind; add `workflow` to `CATEGORY_ORDER`.
- `ui/src/canon/miner/view.ts` — kind chip selector per card; grouped preview;
  add `workflow` to `CATEGORY_ORDER`/`CATEGORY_LABELS`.
- `ui/src/canon/miner/*` form component — form copy.

## Testing

- `compile.rs`: one test per new writer (writes to correct dir, slug dedupe,
  frontmatter shape); existing skill tests unchanged.
- `context_miner.rs`: `suggested_kind` parses; default mapping per category;
  `workflow` accepted as a valid category.
- `canon_miner.rs` / reducer: findings split across kinds compile to the right
  dirs; skill-only findings behave as before.
- `miner/state` reducer: `setFindingKind` re-routes; preview regroups.

## Non-goals / ceilings

- No registry-publish changes — compiled artifacts flow through the existing
  per-kind publish path.
- Slug dedupe is filesystem-scan based (O(n) per write); fine at curation scale.
