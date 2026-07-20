# Context Crawler — inventory-first redesign

**Date:** 2026-07-20
**Status:** design approved, plan pending
**Supersedes the entry model of:** Context Miner (`crates/agent/src/context_miner.rs`, `ui/src/canon/miner/`)

## Problem

The Context Miner is multi-kind on the inside and unitary on the outside.

`MinerOpts { skill_name, focus }` makes both fields a **gate**: the UI form
requires "Package name" before Start, and `system_prompt` tells the model it is
extracting knowledge *"for a skill named '{name}', focused on: {focus}"*. The
model therefore goes looking for **one thing the user already named**. The
multi-kind routing added later (`MinerFinding.kind`, `default_kind`,
`split_by_kind`) redirects findings *inside that single search* — it never turns
the run into a sweep of the repo.

Two consequences:

1. You cannot ask "what context does this repo hold?" — only "find me X".
2. The generative surface (miner) and the detective surface (`canon/src/detect.rs`,
   which finds foreign skills/agents/commands/mcp already on disk) answer the same
   user question from two different screens.

A third defect becomes dominant once whole-repo sweeps are the normal mode: only
the `skill` arm of the compiler guards collisions (it overwrites). `write_memory_entry`
/ `write_command_entry` / `write_subagent_entry` all funnel through
`write_md_entries` → `unique_slug`, which appends `-2`, `-3`, … forever. Crawling
the same repo three times leaves three copies of the same memory.

## Design

Three changes, in dependency order.

### 1. The run has no target — it produces an inventory

Drop `skill_name` from the gate. `focus` survives as an **optional** narrowing
hint, not a requirement. The system prompt is reframed: *survey this repository
and report every durable context unit it can yield.*

`MinerOpts` becomes:

```rust
pub struct CrawlOpts {
    pub focus: String,        // may be empty — no longer a gate
    pub depth: MinerDepth,    // unchanged (Quick | Thorough)
    pub max_units: usize,     // new, default 12
    pub max_findings: usize,  // unchanged, default 40
    pub max_tool_calls: usize,// unchanged, default 120
}
```

The hard turn ceiling stays (`max_tool_calls + max_findings + 8`) and gains
`max_units` in the sum, for the same reason it exists today: a model spamming
invalid tool calls must still terminate.

### 2. The agent proposes units explicitly

New tool alongside `emit_finding`:

```json
{
  "name": "propose_unit",
  "input_schema": {
    "required": ["kind", "name", "summary"],
    "properties": {
      "kind":    { "enum": ["skill", "memory", "command"] },
      "name":    { "type": "string" },
      "summary": { "type": "string" }
    }
  }
}
```

`emit_finding` gains a required `unit` field naming the unit the finding belongs
to. Contract:

- The agent calls `propose_unit` **before** the first `emit_finding` for that unit.
- A finding whose `unit` names no proposed unit is dropped (same posture as the
  existing `parse_finding` validation — never invent structure the model did not
  assert).
- `subagent` stays unreachable from the model, exactly as today: it is not in the
  `kind` enum, and the parser coerces anything unexpected. Subagent remains a
  manual re-route in curation.
- Unit identity is `slugify(name)`, unique across **all** kinds — not
  `(kind, slug)`. `emit_finding` addresses its unit by name alone, so a lookup
  cannot know the kind; two units sharing a name would be unaddressable. Two
  `propose_unit` calls colliding on the slug with the **same** kind merge into
  one unit (first `summary` wins); with a **different** kind the second is
  rejected and the model is told to pick a distinct name.

  Note this is the crawler's in-run identity. State resolution against Canon on
  disk *is* kind-scoped — `memory/x.md` and `skills/x/` are different artifacts —
  so `resolve_state` keys on `(kind, slug)`. The two are not in conflict: one
  addresses units within a run, the other addresses files on disk.

**What a unit means per kind** (this is what materialization writes):

| Kind | Unit → artifact | Findings per unit |
|---|---|---|
| `skill` | `.covenant/canon/skills/<slug>/{SKILL.md,skill.toml}` | N (sections, ordered by `CATEGORY_ORDER`) |
| `memory` | `.covenant/canon/memory/<slug>.md` | 1 |
| `command` | `.covenant/canon/commands/<slug>.md` | 1 |
| `subagent` | `.covenant/canon/agents/<slug>.md` | 1 |

Only `skill` is a package. For the other three the unit *is* the entry, so the
agent proposing a memory unit with 3 findings is a modelling error — the parser
keeps the first finding and drops the rest, and the UI shows the unit's finding
count so the user sees it.

### 3. Every inventory row carries its Canon state

Before the inventory renders, each unit is resolved against
`canon::kind::list_context(repo_root)` by `(kind, slug)`:

| State | Meaning | Default | Action |
|---|---|---|---|
| `new` | no Canon source, not detected | checked | **Materialize** |
| `exists` | identical name already in Canon | unchecked | — (Open) |
| `changed` | name exists, crawler found different content | unchecked | **Update** |
| `detected` | foreign item on disk, no Canon source (`ContextUnit.detected_in`) | unchecked | **Adopt** |

`changed` vs `exists` is decided by comparing the compiled body against the file
on disk — byte comparison of the rendered artifact, not a semantic diff.
`ponytail:` a byte compare will report `changed` for cosmetic drift; that is the
conservative direction (offers Update rather than hiding a real change).

`detected` rows come from `scan_detected()` and are **merged into the same list**,
not a separate column. They are not crawl output; they are the same question
answered from disk. Adopt calls the existing `canon_adopt(cwd, kind, name)` and
needs no new backend.

**Compiler change:** `write_md_entries` gains an `overwrite: bool`. When true it
writes `<slug>.md` unconditionally instead of walking `unique_slug` to `-2`.
`unique_slug` stays for the `overwrite: false` path (a genuine `new` unit whose
slug happens to collide with something Canon does not know about). This is the
fix for the `-2/-3` accumulation across all three md-backed kinds;
`write_skill_package` already overwrites and is untouched.

## Data flow

```
CrawlOpts (focus?, depth)
  → run_crawl loop  ──emit──▶ CrawlEvent::UnitProposed  ─┐
                    ──emit──▶ CrawlEvent::Finding        ─┤ streamed live
                    ──emit──▶ ToolStart/ToolResult/RunDone┘
  → Vec<CrawlUnit { kind, name, summary, findings }>
  → resolve_states(repo_root, units) + scan_detected(repo_root)
  → InventoryRow { unit, state, action }[]
  → user curates (check/uncheck, re-route kind, edit bodies)
  → canon_compile_findings(selected)  // + adopt() for detected rows
```

Streaming is preserved: units appear as rows the moment `propose_unit` fires and
fill with findings as they arrive, so the UI still shows work happening rather
than a spinner. State resolution is the only step that waits for `RunDone`.

## UI

The existing 3-zone layout survives; the zones change contents.

- **Gate:** one optional "Focus" field + depth toggle + Start. No package name.
- **Activity (left):** unchanged tool-call stream.
- **Inventory (center):** replaces the flat finding-card list. Rows grouped by
  kind, each row = kind glyph, name, state badge, summary, finding count.
  Expanding a row shows its findings with the current accept/discard/edit/re-route
  controls. Follows the shared `.rail-row` chrome (`project_canon_unified_rows`).
- **Preview (right):** unchanged in spirit — shows the compiled artifacts for the
  checked rows, grouped by destination path.
- **Footer:** `N units · M findings · K to write`, and one **Write to repo** button
  that runs Materialize/Update/Adopt per row according to its action.

Naming: the surface is renamed **Context Crawler** in UI copy. Rust module,
Tauri commands and TS paths keep `miner`/`canon_mine_*` — renaming them buys
nothing and touches `generate_handler!`, `api.ts` and four call sites.

## Testing

Rust (`cargo test -p covenant canon` and `-p agent` — never the whole `covenant`
crate, `telegram::tests` hangs):

- `parse_unit` accepts a valid `propose_unit`, rejects `subagent` kind, rejects
  empty name/summary.
- A finding naming an unproposed unit is dropped.
- Two `propose_unit` calls with names slugifying equal merge, first summary wins.
- A `memory` unit with 3 findings keeps 1.
- `write_md_entries(overwrite: true)` rewrites `<slug>.md` in place; three
  successive writes leave exactly one file (the regression this fixes).
- `resolve_states` returns `new` / `exists` / `changed` / `detected` against a
  fixture Canon dir.

TS (`npm test` from repo root): inventory grouping/dedupe in `state.ts`, row
state → action mapping, `compilePreview` over multiple units.

Live verification via the `verify` skill against the dev build, on a real repo,
crawled twice — the second crawl must show `exists`/`changed`, not a fresh
duplicate set.

## Out of scope

- **Incremental / diff-aware crawling** (only mine what changed since last crawl).
  Wants a persisted crawl manifest; the state column already prevents the damage.
- **Persisting the inventory across app restarts.** A run is ephemeral; re-crawl
  is cheap enough and now idempotent.
- **`mcp` and `spec` as crawl outputs.** MCP arrives only via detection (a server
  is a config fact, not mined knowledge); specs have their own authoring surface.
- **The `observe` and `interview` procedences** from
  `project_canon_detection_adoption` sub-project C. This spec is the `crawl` leg.
- **Org-transversal push** (sub-project B).
