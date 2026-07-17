# Canon — Detection & Adoption (Sub-project A)

**Date:** 2026-07-17
**Branch:** `feat/canon-detection-adoption`
**Status:** Approved design, pending implementation plan

## Problem

Canon has nine modules (Operators, Subagents, Commands, MCP, Specs, Memory,
Skills, Registry, Context, Loop). Half of them — Subagents, Commands, Memory,
MCP — have no in-app population path: their empty state tells you to go
hand-author a markdown file on disk.

Worse, Canon **lies**. It only "sees" what lives in its own source dir
`.covenant/canon/*`. If a teammate installed a skill straight into
`.claude/skills/`, added a server to `.mcp.json`, or dropped a
`.claude/commands/foo.md`, Canon shows an empty state — even though the repo is
full of abilities you already have the moment you clone. Canon should be the
place where the whole org sees its real organizational context; today it shows a
fraction of it.

This is the first of three sub-projects. It is **reflection, not generation** —
the opposite end from the Context Miner. Sub-project B (org-scoped transversal
skills, `required`/`offered`) and C (miner seams: observe/import/interview) build
on top and are documented separately.

## Core insight: detection is projection run backwards

Canon already projects `source → executor dirs`:

- `AGENT_DIRS   = [".claude/agents", ".opencode/agent"]`
- `SKILL_DIRS   = [".claude/skills", ".pi/skills"]`  (as `canon-<name>/SKILL.md`)
- `COMMAND_DIRS = [".claude/commands", ".opencode/commands", ".pi/prompts"]`
- MCP → `.mcp.json`, opencode, codex configs (keys prefixed `canon-`)

Detection reads those **same** dirs and finds items Canon did **not** put there —
then offers to adopt them back into the source. Same directory map, reversed. No
new "where to look" mapping is invented; the constants in `project.rs` are the
single source of truth for both directions.

## The "detected vs. managed" discriminator

An item is **detected** (foreign) when it sits in an executor dir but Canon
didn't project it:

| Kind     | Executor dirs                                          | Canon-managed              | Detected (foreign)          |
|----------|--------------------------------------------------------|----------------------------|-----------------------------|
| Skill    | `.claude/skills`, `.pi/skills`                         | dir prefixed `canon-`      | dir **not** prefixed `canon-` |
| Subagent | `.claude/agents`, `.opencode/agent`                   | stem in source `agents/`   | stem **not** in source      |
| Command  | `.claude/commands`, `.opencode/commands`, `.pi/prompts`| stem in source `commands/` | stem **not** in source      |
| MCP      | `.mcp.json` `mcpServers`                               | key prefixed `canon-`      | key **not** prefixed `canon-` |

Memory / Context / Spec have no executor-native install location — they are
Canon-native concepts. There is nothing foreign to detect for them, so **v1
covers exactly skill, agent, command, mcp.** The other three sections are
unchanged.

To avoid scanning the same foreign skill once per executor dir, a foreign item is
keyed by `(kind, name)` and reported once even when it appears in multiple
executor dirs (e.g. a skill hand-installed into both `.claude/skills` and
`.pi/skills`). The first-found path is retained for display and adoption.

## Architecture

### Data layer — `crates/canon`

**`ContextUnit` gains a `detected_in` field.**

```rust
// ContextUnit { kind, name, summary, projectable, packageable, detected_in }
//   detected_in: Option<String>
//     None       => Canon-managed (has a .covenant/canon source)
//     Some(path) => detected/foreign, found in this executor dir
pub detected_in: Option<String>,
```

Lazy over a tagged `Provenance` enum: a nullable path is the whole state
(`None` = managed, `Some` = detected + where). Serializes cleanly as
`detectedIn` without nesting a second `kind` field. Existing consumers set
`detected_in: None`.

**New `crates/canon/src/detect.rs`:**

- Make `AGENT_DIRS`, `SKILL_DIRS`, `COMMAND_DIRS` `pub(crate)` in `project.rs`.
- `pub fn scan_detected(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError>`:
  reads the executor dirs above and returns foreign units per the discriminator
  table. Summaries reuse the existing frontmatter helpers
  (`parse_frontmatter_str` for `description`, skill/agent name from frontmatter or
  stem). MCP summary from the server's `description`.
- Dedup by `(kind, name)`; skip any name that already has a Canon source (that
  item is managed, not foreign — it shows once via `list_context`).

**`list_context()` merges managed + detected.** After enumerating the Canon
sources (unchanged), append `scan_detected()` results, skipping any `(kind,
name)` already present as a Canon unit. Result: one row per ability, correctly
badged.

**New `pub fn adopt(repo_root, kind: ContextKind, name: &str) -> Result<ContextUnit, CanonError>`:**

- Locate the foreign item via `scan_detected` (re-scan; cheap, avoids a stale
  handle). Error `NotDetected` if it isn't foreign anymore.
- Copy its content into `.covenant/canon/<kind.dir()>/`:
  - **agent / command:** copy the `.md` into the source dir verbatim.
  - **mcp:** write the server config as `.covenant/canon/mcp/<name>.json`.
  - **skill:** copy the whole skill dir into `.covenant/canon/skills/<name>/`,
    add an `InstalledRef { name, version (from skill.toml or "0.0.0"),
    source: "detected", sha, signer: None, installed_at }` to the manifest.
- Run `project(repo_root)` to normalize (skills get re-emitted as `canon-<name>`).
- **Skills only:** after projecting, remove the foreign un-prefixed skill dir
  (`.claude/skills/<name>`, `.pi/skills/<name>`) so `<name>` and `canon-<name>`
  don't both shadow the executor. Agents/commands don't duplicate — their
  projected name equals the source name, so the file that was foreign simply
  becomes the projection.
- Return the adopted unit (now `detected_in: None`).

### Command layer — `crates/app`

- `canon_list_context` (existing): output now carries `provenance` per unit — a
  serde change, no new read API.
- New `canon_adopt(repo_root: String, kind: String, name: String)` Tauri command
  → `canon::adopt`, returns the adopted `ContextUnit`.

### UI layer — `ui/src/canon/cockpit`

- Every section already renders from `list_context()`. A `Detected` unit renders
  like a managed one plus:
  - a tenuous mono **"detected"** badge,
  - an **"Adopt"** action → `canon_adopt(kind, name)` → refresh the section.
- **Empty state changes.** If a section has detected units, it renders the
  detected list (not the "author a file" hint). Only a truly empty section (no
  managed, no detected) shows a hint, reworded from "author a `.md`" to point at
  installing a skill or mining context.

## Scope (v1 — ponytail)

- Kinds: skill / agent / command / mcp only. Memory / context / spec unchanged.
- Plugins (`.claude/plugins/`): **deferred** — no 1:1 mapping to a Canon kind.
- Adopt is one-at-a-time; no "adopt all" batch in v1.
- `detected_in` carries only the source path, no git-blame / author attribution.
- Skill version on adopt: read `skill.toml` if present, else `"0.0.0"`.

## Testing

Rust regression in `crates/canon` (scope with `-p covenant canon` — the full
`cargo test` hangs on pre-existing `telegram::tests`):

- Plant a foreign `.claude/agents/foo.md` with no Canon source. Assert
  `list_context` returns it with `detected_in: Some(...)`. Call `adopt`; assert
  the file now exists under `.covenant/canon/agents/foo.md` and the unit reads
  `detected_in: None`.
- Plant a foreign skill dir `.claude/skills/kyc` (no `canon-` prefix). Assert
  detected; after `adopt`, assert `.covenant/canon/skills/kyc/` exists, the
  manifest has a `detected`-sourced ref, `.claude/skills/canon-kyc/` exists, and
  the foreign `.claude/skills/kyc/` is gone (no duplicate).
- A `canon-`-prefixed skill dir and a source-backed agent are **not** reported as
  detected (managed items stay single-listed).

## Out of scope (later sub-projects)

- **B — Org transversal (`required`/`offered`):** org publishes an ability, Canon
  projects it into every member's every repo with governance levels. Needs the
  covenant server + project-down + enforcement. Builds on adoption (you adopt,
  then promote to org-transversal).
- **C — Miner seams:** observe (PTY event bus), import (skill.sh / other Canons),
  interview. Generative depth.
