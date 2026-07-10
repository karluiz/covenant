# CDLC Memory Kind (Sub-project 5)

**Date:** 2026-07-10
**Status:** Design approved, proceeding to plan
**Branch:** `feat/cdlc-memory-kind`
**Builds on:** Sub-projects 1–4 (Agent/Context/Skill + Command + Mcp + Spec), merged to main `aeb3e88c`.

## Problem

Agent, Context, Command, Mcp, Spec, and Skill are first-class CDLC context
kinds. The final roadmap kind is **Memory** — durable, accreted atomic facts
(decisions, preferences, learnings) that a group wants every executor to
*remember* across sessions. This is the model of Claude Code's own auto-memory
(`MEMORY.md` index + per-fact files with `type:` frontmatter), and the
`capabilities` crate already models `Capability::Memory` = an executor's
instruction/memory file (`CLAUDE.md` / `AGENTS.md`).

Memory is distinct from the existing **Context** kind:

- **Context** = authored reference knowledge (rules, conventions, domain). Each
  doc projects a per-doc `## <name> (context)` summary into the managed block
  AND a full on-demand skill body.
- **Memory** = accreted atomic recall. Each fact projects a single bullet under
  one grouped `## Memory` section in the managed block. No skill body.

## Goal

Add `Memory` as a first-class context kind: authored under
`.covenant/canon/memory/<slug>.md` (atomic facts with `description:`
frontmatter), enumerated, carried in `CanonStatus`, surfaced in rail + cockpit,
and **projected into every executor's managed block** so the executor remembers
the facts each session. This closes the roadmap: agent · context · command ·
mcp · spec · memory · skill.

## Design

### 1. Backend model (`crates/canon`)

- `ContextKind::Memory` — `dir() = "memory"` (under `.covenant/canon/`, like the
  other file-per-item kinds), `label() = "Memory"`.
- Enumerated via the existing `read_dir_md` (memory facts are `.md` with
  frontmatter, exactly like agents/context/commands). Summary = `description:`
  frontmatter (via `parse_frontmatter_str`).
- `list_context` Memory loop: `summary = description`, `projectable = true`,
  `packageable = false`.
- **`read_source` needs NO change** — Memory falls into the existing default arm
  (`canon_dir(repo_root).join(kind.dir()).join("{name}.md")` →
  `.covenant/canon/memory/<name>.md`).
- `CanonStatus` gains `memory: Vec<MemoryRef>` where
  `MemoryRef { name: String, description: Option<String> }`.

### 2. Projection — one grouped section in the managed block

Memory reuses the managed-block machinery entirely; it writes NO file-per-item
and NO skill dir.

- `managed_body(...)` gains a `memories: &[(String, String)]` parameter. After
  the agent/skill/context sections, it appends **one** section:
  ```
  ## Memory

  - <fact 1>
  - <fact 2>
  ```
  Each bullet = the fact's `description:` (via `parse_frontmatter_str`), falling
  back to the first non-empty line of the body after frontmatter. The `## Memory`
  section is omitted when there are no memory facts.
- `memories` is read (`read_dir_md` on the `memory` dir) and threaded into
  `managed_body` at **both** call sites: `project_with_active` and
  `projection_status`.
- **No new per-executor checks:** Memory rides the managed block that
  `check_managed` already verifies. It reaches codex + opencode (via `AGENTS.md`),
  copilot (via `.github/copilot-instructions.md`), hermes (via `.hermes.md` when
  present), and claude (via `CLAUDE.md` → `AGENTS.md` symlink). The empty-source
  guard in `projection_status` extends to include `memories.is_empty()`.

### 3. UI + command wiring

- `canon_read_source` (app) gains a `"memory"` arm; TS `canonReadSource` kind
  union gains `"memory"`.
- **Rail** (`panel.ts`): a `kindSection` **Memory**, order
  Agents → Context → **Memory** → Commands → Mcp → Specs → Skills (Memory sits
  next to Context — both are persistent knowledge). Rows: `skillCard`, empty
  `actions`, meta = the description, `fetchPreview: () => canonReadSource(cwd, "memory", name)`,
  empty hint "No memories authored."
- **Cockpit** (`view.ts`): a **Memory** nav section, mirroring
  `renderContextSection`/`renderMcpSection`, reading `CanonStatus.memory`.

## Testing

- `crates/canon`: `list_context` yields a `Memory` unit (description summary,
  `projectable = true`) from a `memory/<slug>.md` fixture.
- `crates/canon`: `managed_body` with memory facts emits a `## Memory` section
  containing the fact bullet; omits the section when there are no facts.
- `crates/canon`: `project_with_active` writes `## Memory` into `AGENTS.md`;
  `projection_status` reports `Stale` when the projected block is tampered.
- `crates/canon`: `status()` populates `memory`.
- `ui/src/canon/panel.test.ts`: rail renders a Memory section + empty hint.

## Non-goals (later / rejected)

- Type-aware projection (all facts project uniformly as bullets, regardless of
  `type: user|feedback|project|reference`).
- Packaging / publish / eval for memory.
- Automatic accretion / curation — Canon authors/projects/lists memory facts;
  it does not accumulate them on its own (that stays a human/agent action).

## File touch-list

- `crates/canon/src/kind.rs` — `Memory` variant, `dir()`/`label()`, `list_context` memory loop.
- `crates/canon/src/install.rs` — `MemoryRef`, `CanonStatus.memory`, populate in `status()`.
- `crates/canon/src/project.rs` — `managed_body` memory param + `## Memory` section; read `memories` + thread into `project_with_active` + `projection_status`; extend empty guard.
- `crates/app/src/lib.rs` — `canon_read_source` `"memory"` arm.
- `ui/src/api.ts` — `MemoryRef`, `CanonStatus.memory`, `canonReadSource` union `+ "memory"`.
- `ui/src/canon/panel.ts` — Memory rail section.
- `ui/src/canon/panel.test.ts` — Memory assertions.
- `ui/src/canon/cockpit/view.ts` — Memory nav section.

## Ponytail boundaries

- `// ponytail:` Memory bullets use `description` (or body first line) — no
  full-body projection; memory facts are atomic by design.
- `// ponytail:` one grouped `## Memory` section, not per-fact headings — keeps
  the always-on block compact (token cost).
- `// ponytail:` `type:` frontmatter is carried in the source but not used to
  differentiate projection yet — add sectioning by type if a need appears.
