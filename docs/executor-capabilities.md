# Executor capability models

The **Capabilities** page (Settings → Capabilities) is a viewer/editor of the
**real files each executor reads on disk** — not a uniform abstraction. So the
sections it shows for a given tool mirror that tool's native capability model,
and they differ per executor. There is no universal "agent capability standard";
each tool realizes overlapping concepts differently.

This is the reference for which executor supports what, and where it lives.

## The matrix

✓ = a native file/dir Covenant can list and edit for that tool.

| Section  | Claude | opencode | Codex | Copilot | Pi | Hermes |
|----------|:------:|:--------:|:-----:|:-------:|:--:|:------:|
| Skills   | ✓ `.claude/skills/<n>/SKILL.md` | — | — | — | ✓ `~/.pi/skills` | — |
| Agents   | ✓ `.claude/agents/<n>.md` | ✓ `.opencode/agent/<n>.md` | —¹ | —¹ | —² | — |
| Commands | ✓ `.claude/commands/<n>.md` | — | ✓ `~/.codex/prompts` | — | ✓ `~/.pi/prompts` | — |
| Hooks    | ✓ `settings.json` | — | — | — | — | — |
| MCPs     | ✓ `settings.json`/`.mcp.json` | ✓ `opencode.json` | ✓ `config.toml` | ✓ | — | — |
| Memory   | ✓ `CLAUDE.md` | ✓ `AGENTS.md` | ✓ `AGENTS.md` | ✓ `.github/copilot-instructions.md` | — | ✓ `.hermes.md`/`AGENTS.md` |

Project scope mirrors the same paths under the repo root (e.g.
`<repo>/.claude/agents`, `<repo>/CLAUDE.md`).

**Only Claude Code supports all six** — it is the richest native model. Every
other executor supports a subset.

### Notes on "Agents"

The "Agents" section means a **multi-agent directory** (one `.md` per subagent).
That exists natively only for **Claude** (`.claude/agents`) and **opencode**
(`.opencode/agent`).

- **¹ Codex / Copilot** run **one persona at a time**, not a directory of
  subagents. The persona is a managed block inside `AGENTS.md` /
  `.github/copilot-instructions.md` — so it surfaces under **Memory**, not Agents.
- **² Pi** has no subagent concept; it materializes agents as **skills**
  (`~/.pi/skills`).

## Why CDLC projection exists

Because the same concept maps onto a different native shape per tool, you author
**once** in `.covenant/cdlc/` and **project** to every executor. The projection
map is the ground truth in `crates/cdlc/src/project.rs`:

```rust
const AGENT_DIRS: &[&str] = &[".claude/agents", ".opencode/agent"];
const SKILL_DIRS: &[&str] = &[".claude/skills", ".pi/skills"];
// memory targets: AGENTS.md (codex/opencode/hermes),
//                 .github/copilot-instructions.md (copilot),
//                 .hermes.md (hermes, only if it already exists)
```

So one authored agent becomes: a file in `.claude/agents` and `.opencode/agent`,
a managed block in `AGENTS.md` for codex/copilot, and a skill in `~/.pi/skills`.

The Covenant tool in the Capabilities page exposes this via **Project to
executors**, which runs the same `cdlc_export` engine.

See [`cdlc-multi-export.md`](./cdlc-multi-export.md) for the full export rules
(covenant-block stripping, managed blocks, idempotency).

## Adding an executor or a capability

The matrix is set by the adapters in `crates/capabilities/src/adapters/` (what
gets discovered) and `SECTIONS_BY_TOOL` in `ui/src/capabilities/panel.ts` (what
the page shows). To add a native capability for a tool, add its scan to the
adapter and a section row to that map — never show a section a tool has no real
files for.
