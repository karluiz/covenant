# CDLC Multi-Export

The CDLC multi-export tool writes your governed context — **agents**, **skills**,
and **regulatory context** — into the native file each AI executor reads, so the
same source of truth reaches Claude Code, codex, and copilot at once.

## Source of truth: `.covenant/cdlc/` (per repo, committed)

Put your authored files here. Everything is plain markdown; nothing is generated
by hand into executor dirs.

```
.covenant/cdlc/
  agents/<name>.md       # operator personas (system prompts)
  context/<name>.md      # regulatory / standards specs
  skills/<name>/SKILL.md # capabilities (installed via the registry)
```

### `agents/<name>.md` — an operator persona

```markdown
---
name: kyc-reviewer
description: Reviews KYC flows against SBS regulations
model: claude-sonnet-4-6
tools: [Read, Grep]
covenant:                 # Covenant-only fields — STRIPPED on every export
  voice: formal
  hard_constraints: "no git push --force"
---
You are a KYC reviewer. Always cite the applicable SBS article…
```

The standard keys (`name`, `description`, `model`, `tools`, body) are what every
executor reads. The `covenant:` block holds runtime semantics with no native
equivalent and is **removed from every exported file** — executors only ever see
a clean native agent.

### `context/<name>.md` — regulatory context

```markdown
---
summary: Mask all PII; every KYC review cites the applicable SBS article.
---
# SBS KYC rulebook
<full regulatory text…>
```

The `summary:` is **authored** (not derived). It is the always-on digest that
rides every request; the full body is deferred so it only loads when needed.

## What gets written where

| Source | Claude (`.claude/`) | codex / copilot (managed block) |
|---|---|---|
| `agents/<n>.md` | `.claude/agents/<n>.md` (covenant block stripped) | the **active** operator's body |
| `skills/<n>/SKILL.md` | `.claude/skills/cdlc-<n>/SKILL.md` | `## <n> v<ver>` section |
| `context/<n>.md` | full body → `.claude/skills/cdlc-<n>/SKILL.md` | `summary:` only |

codex reads `AGENTS.md`; copilot reads `.github/copilot-instructions.md`. The
generated content lives inside a delimited block:

```
<!-- cdlc:start -->
… auto-generated …
<!-- cdlc:end -->
```

Hand-written content outside the block is never touched, and the block is
removed entirely when all sources are empty. Re-running the export is
idempotent — identical inputs produce identical files.

## How to run the export

1. **From the app** — open the CDLC panel (⌘⇧L) on a group with a project
   folder and click the **Re-export** icon (↻) in the panel header. It rewrites
   every executor file from the current `.covenant/cdlc/` sources.
2. **Automatically** — installing a skill from the registry re-runs the export
   as part of the install, so skills appear in every executor immediately.

> After editing `agents/` or `context/` by hand, click **Re-export** to push the
> changes out. (A file-watcher that re-exports on save is a planned follow-up.)

## Scope

- v1 targets **claude**, **codex**, **copilot**. Adding **pi / hermes / opencode**
  is one table row each once their native instruction path is defined.
- Authoring the `agents/*.md` files (producing the personas) is separate from
  the exporter, which only consumes them.
