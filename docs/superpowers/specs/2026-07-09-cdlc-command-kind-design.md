# CDLC Command Kind (Sub-project 2)

**Date:** 2026-07-09
**Status:** Design approved, spec under review
**Branch:** `feat/cdlc-command-kind`
**Builds on:** Sub-project 1 (`ContextKind` foundation, merged to main `b7ab2e9e`)

## Problem

Sub-project 1 made Agent, Context, and Skill first-class enumerable context
units via `ContextKind` / `list_context` / an enriched `CanonStatus`, surfaced
in the Canon rail and cockpit. The roadmap (option B: first-class context kinds)
next adds **Command** — reusable slash-command prompt templates — as the fourth
kind, so a repo can author `/deploy`, `/review`, etc. once in Canon and project
them into every executor that supports project-level slash commands.

## Goal

Add `Command` as a first-class context kind: authored under
`.covenant/canon/commands/<name>.md`, enumerated by `list_context`, carried in
`CanonStatus`, projected to each executor's real command directory, and surfaced
in the rail and cockpit — plugging into the Sub-project 1 contract rather than
reinventing enumeration or UI.

## Verified executor command conventions

Researched against current official docs (2025/2026):

| Executor | Project-level commands? | Path | Invocation | Confidence |
|---|---|---|---|---|
| Claude Code | Yes | `.claude/commands/<name>.md` | `/name` | High |
| opencode | Yes | `.opencode/commands/<name>.md` | `/name` | High |
| pi | Yes | `.pi/prompts/<name>.md` | `/name` | Medium |
| Codex CLI | **No** (user-global only, deprecated) | — | — | High |
| GitHub Copilot | IDE only (not CLI); `.github/prompts/<name>.prompt.md` | different ext + frontmatter | Medium |

**Projection targets for this sub-project:** claude, opencode, pi — the three
with an identical `<name>.md` convention. Codex is not projected (no project
support — we do not invent a path). Copilot uses a different extension
(`.prompt.md`) and frontmatter and is IDE-only, so it is deferred.

## Design

### 1. Backend model (`crates/canon`)

- **`ContextKind::Command`** — `dir() = "commands"`, `label() = "Command"`
  (`crates/canon/src/kind.rs`).
- **`list_context`** enumerates commands: kind `Command`, name from the file
  stem, `summary` from the frontmatter. Commands conventionally use
  `description:` (not `summary:`), so a small helper reads `description:` for
  commands (falling back to `summary:` for uniformity). `projectable = true`,
  `packageable = false`.
- **`CanonStatus`** gains `commands: Vec<CommandRef>` where
  `CommandRef { name: String, description: Option<String> }`. `status()`
  populates it by filtering `list_context()` for `Command`.
- **`read_source`** is unchanged: its generic non-Skill arm already resolves
  `commands/<name>.md` from `ContextKind::Command.dir()`.
- **Projection (the new work):**
  - `const COMMAND_DIRS: &[&str] = &[".claude/commands", ".opencode/commands", ".pi/prompts"]`.
  - `project_commands(repo_root, commands)` writes each `<name>.md` (body via
    `strip_covenant_block`, matching `project_agents`) into every `COMMAND_DIRS`
    entry.
  - Since agents and commands are now the identical file-per-item shape, extract
    a shared helper `project_file_per_item(repo_root, dirs, items)` that both
    `project_agents` and `project_commands` call. This is the minimal DRY the
    Sub-project 1 plan deferred ("generalize when Command lands") — a helper for
    two real callers, not a trait.
  - Call `project_commands` in `project_with_active`.
  - Extend `projection_status` so command files count toward each executor's
    synced/stale state (otherwise projected commands would never show as stale).

### 2. UI (rail + cockpit)

- **Rail** (`ui/src/canon/panel.ts`): a fourth `kindSection`, **Commands**,
  order Agents → Context → Commands → Skills. Rows reuse `skillCard` with empty
  `actions` and `fetchPreview: () => canonReadSource(cwd, "command", name)`.
  Empty hint: "No commands authored."
- **Cockpit** (`ui/src/canon/cockpit/view.ts`): a **Commands** nav section
  inserted **between `context` and `skills`** (nav order
  `org / members / agents / context / commands / skills / registry / loop`, so
  it matches the rail order Agents → Context → Commands → Skills), mirroring
  `renderContextSection` / `renderAgentsSection`, reading
  `CanonStatus.commands`.
- **`canonReadSource`** already accepts `"command"`? No — its TS union is
  `"agent" | "context" | "skill"`. Extend the union to include `"command"`, and
  the Rust command's `match` to accept `"command"`.

### 3. Tests

- `crates/canon`: `list_context` returns a `Command` unit (with `description`
  as summary) for a `commands/<name>.md` fixture.
- `crates/canon`: `project_commands` writes the file into all three
  `COMMAND_DIRS`; `projection_status` reports stale when a projected command is
  tampered.
- `crates/canon`: `status()` populates `commands`.
- `ui/src/canon/panel.test.ts`: rail renders a Commands section + empty hint.

## Non-goals (later)

- Codex command projection (no project-level support), Copilot `.prompt.md`
  projection (different shape, IDE-only).
- Packaging / publish / eval for commands (skill remains the only registry unit).
- Kinds Mcp / Spec / Memory.

## File touch-list

- `crates/canon/src/kind.rs` — `Command` variant, `description:`-aware summary in `list_context`.
- `crates/canon/src/install.rs` — `CommandRef`, `CanonStatus.commands`, populate in `status()`.
- `crates/canon/src/project.rs` — `COMMAND_DIRS`, `project_commands`, `project_file_per_item` helper, call in `project_with_active`, extend `projection_status`.
- `crates/app/src/lib.rs` — `canon_read_source` match accepts `"command"`.
- `ui/src/api.ts` — `CommandRef`, `CanonStatus.commands`, `canonReadSource` kind union `+ "command"`.
- `ui/src/canon/panel.ts` — Commands rail section.
- `ui/src/canon/panel.test.ts` — Commands section assertions.
- `ui/src/canon/cockpit/view.ts` — Commands nav section.

## Ponytail boundaries

- `// ponytail:` COMMAND_DIRS is claude/opencode/pi only — codex has no
  project-level commands, copilot needs a different ext/frontmatter; add those
  when demanded (COMMAND_DIRS is not enough for copilot — it needs its own
  writer, so it is a deliberate deferral, not a one-line add).
- `// ponytail:` `project_file_per_item` DRYs agents+commands (two callers), not
  a projection trait — the SKILL-dir and managed-block styles stay as-is.
