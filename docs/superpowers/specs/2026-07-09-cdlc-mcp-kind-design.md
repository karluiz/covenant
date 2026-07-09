# CDLC Mcp Kind (Sub-project 3)

**Date:** 2026-07-09
**Status:** Design approved, spec under review
**Branch:** `feat/cdlc-mcp-kind`
**Builds on:** Sub-projects 1 (`ContextKind` foundation) + 2 (Command kind), merged to main `420b59ce`.

## Problem

Agent, Context, Command, and Skill are first-class CDLC context kinds. The next
roadmap kind is **Mcp** — Model Context Protocol tool servers — so a repo can
author an MCP server once in Canon and project it into every executor that reads
a repo-committed MCP config.

Mcp is structurally different from the previous kinds:

1. It is **config (JSON/TOML), not per-file markdown** — the `read_dir_md`
   enumerator and the `<name>.md` `read_source` assumption do not apply.
2. Projection is a **merge into each executor's shared config file** (in that
   executor's native format), not writing a standalone file per item. The merge
   must not clobber MCP servers the user configured by hand.

## Goal

Add `Mcp` as a first-class context kind: authored under
`.covenant/canon/mcp/<name>.json`, enumerated, carried in `CanonStatus`,
surfaced in the rail and cockpit, and projected — by non-destructive merge — into
the repo-committed MCP config of Claude, opencode, and Codex.

## Verified executor MCP conventions (repo-committed only)

Confirmed against current official docs:

| Executor | Repo-committed MCP? | File + key | Per-server shape |
|---|---|---|---|
| Claude Code | Yes | `.mcp.json` (root), `mcpServers` | `{command, args, env}` or `{type: "http"\|"sse", url, headers}` |
| opencode | Yes | `opencode.json` (root), `mcp` | `{type: "local", command: [...], environment}` or `{type: "remote", url, headers}` |
| Codex CLI | Yes (trust-gated) | `.codex/config.toml` (root), `[mcp_servers.<name>]` | `command`, `args`, `env` or `url` |
| GitHub Copilot CLI | **No** — user-global `~/.copilot/mcp-config.json` only | — | — |

**Projection targets:** claude, opencode, codex. Copilot is excluded (no
repo-committed MCP file — projecting it would require writing to `~/`, outside
Canon's repo-scoped model). The Codex per-project trust gate and Claude's
`.mcp.json` approval settings are the executor's concern; Canon writes the file,
the user approves it in the executor.

## Design

### Canonical source shape

`.covenant/canon/mcp/<name>.json` — one JSON file per server, using **Claude's
per-server shape** (the most standard) plus an optional `description`:

```json
{ "type": "stdio", "command": "npx", "args": ["-y", "server"], "env": {"K": "v"}, "description": "…" }
```
```json
{ "type": "http", "url": "https://example.com/mcp", "headers": {"Authorization": "…"}, "description": "…" }
```

`type` defaults to `stdio` when `command` is present and no `type` is given.
Remote types are `http` / `sse`.

### 1. Backend model (`crates/canon`)

- `ContextKind::Mcp` — `dir() = "mcp"`, `label() = "Mcp"`.
- New enumerator `read_dir_json(dir) -> Vec<(String, String)>` (stem, raw JSON),
  mirroring `read_dir_md` but for `.json`. `list_context` uses it for the `mcp`
  dir; summary = the `description` field parsed from the JSON.
- `read_source` gains an `Mcp` arm returning `mcp/<name>.json` (the generic arm
  assumes `.md`).
- `CanonStatus` gains `mcp: Vec<McpRef>` where
  `McpRef { name: String, description: Option<String>, transport: String }`
  (`transport` = "stdio"/"http"/"sse", derived from the JSON).
- A parsed model `McpServer` (serde) for the canonical source shape, used by both
  status and projection.

### 2. Projection — non-destructive per-executor merge

Canon owns only servers **prefixed `canon-`**. Each projection pass, for each
target config: parse the existing file (or start empty), drop every existing
`canon-*` server, insert the current Canon set (renamed `canon-<name>`), write
back — leaving all non-`canon-` (user) servers untouched. This mirrors how Canon
skills use `canon-<name>` dirs.

- **claude** — `.mcp.json`, `mcpServers` object. Canon server JSON copied
  near-verbatim (drop `description`; Claude ignores unknown keys but we keep it
  clean). Stdio → `{command, args, env}`; remote → `{type, url, headers}`.
- **opencode** — `opencode.json`, `mcp` object. Transform: stdio →
  `{type: "local", command: [command, ...args], environment: env, enabled: true}`;
  remote → `{type: "remote", url, headers, enabled: true}`.
- **codex** — `.codex/config.toml`, `[mcp_servers.canon-<name>]` tables. Parse
  with the `toml` crate (already a dep), replace canon tables, serialize back.
  Stdio → `command`/`args`/`env`; remote → `url`.
- Wire all three into `project_with_active` (new `project_mcp(repo_root, servers)`).
- **De-projection:** when there are zero Canon MCP servers, still strip any
  leftover `canon-*` entries from each config (so removing the last server cleans
  up), mirroring how the managed block is stripped when empty.

### 3. Projection status

Extend `projection_status`: for each of claude/opencode/codex, parse its MCP
config, extract the `canon-*` servers, and compare (by name set + shape) against
what `project_mcp` would write. Report `Stale` on mismatch, `Synced` on match,
consistent with the existing file checks. (This is a structured compare, not the
byte-compare used for file-per-item kinds.)

### 4. UI + command wiring

- `canon_read_source` (app) gains a `"mcp"` arm; TS `canonReadSource` kind union
  gains `"mcp"`.
- **Rail** (`panel.ts`): a fifth `kindSection` **Mcp**, order Agents → Context →
  Commands → Mcp → Skills. Rows: `skillCard`, empty actions, meta =
  `description ?? transport`, preview `canonReadSource(cwd, "mcp", name)`, empty
  hint "No MCP servers authored."
- **Cockpit** (`view.ts`): an **Mcp** nav section after `commands`, mirroring
  `renderCommandsSection`, reading `CanonStatus.mcp`.

## Testing

- `crates/canon`: `list_context` yields an `Mcp` unit (description summary,
  transport) from an `mcp/<name>.json` fixture.
- `crates/canon`: `project_mcp` merges into each of the three configs — a test
  per executor that **seeds a pre-existing user server and asserts it survives**
  alongside the new `canon-<name>` server; a stdio and a remote case.
- `crates/canon`: de-projection removes `canon-*` when the source is emptied but
  keeps the user server.
- `crates/canon`: `projection_status` reports `Stale` when a projected canon MCP
  server is tampered.
- `crates/canon`: `status()` populates `mcp`.
- `ui/src/canon/panel.test.ts`: rail renders an Mcp section + empty hint.

## Non-goals (later)

- Copilot MCP (user-global only, outside the repo model).
- Packaging / publish / eval for MCP servers.
- Kinds Spec / Memory.
- Secret handling for MCP `env` / `headers` beyond writing them verbatim (values
  come from the authored source file; no masking layer in this sub-project —
  noted as a follow-up).

## File touch-list

- `crates/canon/src/project.rs` — `pub(crate) read_dir_json` (mirrors `read_dir_md`, for `.json`, shared by kind.rs); `project_mcp` (3 per-executor mergers); wire into `project_with_active`; `projection_status` MCP compare.
- `crates/canon/src/kind.rs` — `Mcp` variant; `list_context` mcp loop (uses `read_dir_json`); `McpServer` serde model + transport parse.
- `crates/canon/src/install.rs` — `McpRef`, `CanonStatus.mcp`, populate in `status()`; `read_source` `Mcp` arm (`mcp/<name>.json`).
- `crates/app/src/lib.rs` — `canon_read_source` `"mcp"` arm.
- `ui/src/api.ts` — `McpRef`, `CanonStatus.mcp`, `canonReadSource` union `+ "mcp"`.
- `ui/src/canon/panel.ts` — Mcp rail section.
- `ui/src/canon/panel.test.ts` — Mcp assertions.
- `ui/src/canon/cockpit/view.ts` — Mcp nav section.

## Ponytail boundaries

- `// ponytail:` Copilot excluded — no repo-committed MCP file; needs a `~/` writer, a deliberate deferral.
- `// ponytail:` `canon-` prefix is the ownership marker (same convention as skill dirs); no separate manifest of managed servers.
- `// ponytail:` MCP `env`/`headers` written verbatim from source — no secret masking layer yet (follow-up).
