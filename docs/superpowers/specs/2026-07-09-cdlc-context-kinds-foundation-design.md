# CDLC Context Kinds — Foundation (Sub-project 1)

**Date:** 2026-07-09
**Status:** Design approved, spec under review
**Branch:** `feat/cdlc-context-kinds-foundation`

## Problem

Canon (the shipped implementation of the Context Development LifeCycle) is
conceptually a system for *everything a Covenant executor carries into its
context*. In practice it presents as a **skills manager**:

- The rail panel (`ui/src/canon/panel.ts` `renderStatus`) renders **only** a
  "Skills" section — agents and context, which the backend already authors and
  projects, are invisible.
- The miner ("Mine context") immediately asks for a **SKILL NAME**, conflating
  "context" with "skill".
- `CanonStatus` carries `installed` (skills) + `context_files` (bare names);
  there is no enumeration of agents, and context has no summary surfaced.

The product direction (chosen: **first-class context kinds**, option B) is for
Canon to be the single authoring surface for every context class — agent,
context, skill, and later command, mcp, spec, memory. This sub-project lays the
foundation: an explicit `ContextKind` contract and full UI parity for the three
kinds that already exist.

## Goal

Make **Agent**, **Context**, and **Skill** equal, first-class, visible context
units — enumerated through one backend contract and surfaced in both the rail
and the cockpit — so subsequent sub-projects add a new kind by plugging into the
contract rather than reinventing enumeration and UI.

## Non-goals (later sub-projects)

- Packaging / publish / eval for agents and context (only skills round-trip the
  registry today; that stays true here).
- New kinds: Command, Mcp, Spec-as-kind, Memory.
- Generalizing the projection engine into a trait. Projection already handles
  the three kinds correctly; abstracting it with a single projection style would
  be speculative. It gets generalized when the second projection style (Command)
  arrives with a concrete second case.

## Design

### 1. Backend model (`crates/canon`)

Introduce the contract without over-abstracting:

```rust
pub enum ContextKind { Agent, Context, Skill }
// Command / Mcp / Spec / Memory join in later sub-projects.
```

Each variant knows its **source dir** (`agents/`, `context/`, `skills/` under
`.covenant/canon/`) and its **display label**.

New enumeration function:

```rust
pub struct ContextUnit {
    pub kind: ContextKind,
    pub name: String,
    pub summary: Option<String>,   // Context: authored summary; Skill: SKILL.md description if cheap; Agent: None
    pub projectable: bool,         // true for all three today
    pub packageable: bool,         // true only for Skill today
}

pub fn list_context(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError>;
```

`list_context` reads the three source dirs (reusing existing helpers:
`read_dir_md` for agents/context, the manifest for installed skills,
`parse_summary` for context summaries) and returns a uniform, sorted list.

Extend `CanonStatus` (`crates/canon/src/install.rs`):

- Add `pub agents: Vec<AgentRef>` where `AgentRef { name: String }`.
- Change `context_files: Vec<String>` → `pub contexts: Vec<ContextRef>` where
  `ContextRef { name: String, summary: Option<String> }`.
- `installed: Vec<InstalledRef>` (skills) is unchanged.

`status()` populates the new fields from the same dirs `project_with_active`
already reads. This keeps "what the UI lists" and "what gets projected" reading
the same sources.

**Projection is untouched.** `project_with_active` / `projection_status`
continue to work exactly as today.

### 2. UI — rail (`ui/src/canon/panel.ts`)

`renderStatus` renders three sections driven by the enriched status instead of a
single hardcoded Skills section:

- **Agents** — count + one row per agent (name).
- **Context** — count + one row per context doc (name + summary as meta).
- **Skills** — unchanged rows (count, version · source, publish/eval actions).

Each section reuses the existing `skillCard` row builder and shows an empty-hint
when its list is empty (e.g. "No agents authored."). Section order:
Agents → Context → Skills. Rows for agents/context get a "preview" fetcher
(read the source `.md`) but **no** publish/eval actions (those are skill-only,
per non-goals).

### 3. UI — cockpit (`ui/src/canon/cockpit/view.ts`)

The cockpit nav already routes `org / members / skills / registry / context /
loop`. Add an **`agents`** section between `members` and `skills`:

- `SectionKey` gains `"agents"`.
- Nav entry `{ key: "agents", label: "Agents" }` + header copy ("Operator
  personas projected to your executors.").
- `renderAgentsSection()` lists authored agents with an open-to-edit affordance,
  mirroring the existing `renderContextSection()` pattern (read/edit the source
  `.md`, no registry actions).

### 4. Miner copy honesty (`ui/src/canon/miner/*`)

No logic change. Clarify that mining produces a skill: under the "Mine context"
title, the existing "SKILL NAME" field keeps its label, but a one-line note is
added — *"Mined context is packaged as a skill."* — so the vocabulary jump
stops being surprising.

## Testing

- `crates/canon`: unit test for `list_context` — a temp repo with one agent, one
  context (with `summary:`), and one installed skill returns three `ContextUnit`s
  with correct kinds/summaries, sorted.
- `crates/canon`: `status()` returns populated `agents` + `contexts` (with
  summary) alongside `installed`.
- `ui/src/canon/panel.test.ts`: extend to assert the rail renders all three
  sections, correct counts, and empty-hints when a kind is absent.

## File touch-list

- `crates/canon/src/lib.rs` — export `ContextKind`, `ContextUnit`, `list_context`.
- `crates/canon/src/types.rs` or a new `kind.rs` — `ContextKind`, `ContextUnit`.
- `crates/canon/src/install.rs` — enrich `CanonStatus` (agents + contexts), populate in `status()`.
- `crates/canon/src/project.rs` — (read-only) reuse helpers for `list_context`; no projection change.
- `crates/app/src/canon*.rs` — thread the enriched `CanonStatus` through the Tauri command.
- `ui/src/api.ts` — update `CanonStatus` TS type (agents, contexts).
- `ui/src/canon/panel.ts` — three-section `renderStatus`.
- `ui/src/canon/panel.test.ts` — extended assertions.
- `ui/src/canon/cockpit/view.ts` — `agents` nav section + `renderAgentsSection`.
- `ui/src/canon/miner/view.ts` (or wherever the "Mine context" form lives) — one-line note.

## Ponytail boundaries

- `// ponytail:` no projection trait yet — generalize when Command lands (real 2nd case).
- `// ponytail:` Skill `summary` in `ContextUnit` uses the SKILL.md description only if cheaply parseable; else `None`. No new parser.
