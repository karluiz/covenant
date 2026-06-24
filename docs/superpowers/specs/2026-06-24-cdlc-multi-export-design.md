# CDLC Multi-Export Tool — Design

**Date:** 2026-06-24
**Status:** Approved (brainstorm) — ready for implementation plan
**Scope:** The exporter only. Agent *authoring* happens in a separate session.

## Problem

Covenant operators live in a proprietary format (`SOUL.md` + SQLite). Every
executor (Claude Code, codex, copilot, opencode, …) has converged on a native
**agent** file — frontmatter + system-prompt body — yet Covenant exports none of
it. Separately, CDLC already projects **skills** into executor-native dirs, but
that logic is hardcoded for skills and can't carry agents or regulatory context.

We want one **multi-export tool** inside CDLC: given any artifact
(`agent | skill | context`) and any executor, write it in that executor's native
format. Agents become a portable standard file, distributed everywhere, with one
canonical source of truth per repo.

## Decisions (from brainstorm)

1. **Format + distribution (both).** The standard agent `.md` is the canonical
   operator representation **and** CDLC projects it per-executor.
2. **Per-repo scope.** Operators live in `.covenant/cdlc/agents/*.md`, committed,
   travelling with the repo. Matches CDLC's per-repo regulatory premise.
3. **Namespaced extension block.** Standard agent keys at top level; Covenant-only
   fields under a `covenant:` key.
4. **Definition in file, runtime state in SQLite.** XP/gamification and earned
   decision history stay local, never in the committed file.
5. **Context is always-on + on-demand.** A short authored `summary:` rides every
   request via the instruction file; the full body is deferred to a skill file.

## Source of truth — `.covenant/cdlc/` (per-repo, committed)

```
.covenant/cdlc/
  agents/*.md          # operator personas — canonical agent format (NEW)
  skills/*/SKILL.md    # capabilities (exists today)
  context/*.md         # regulatory specs; each has `summary:` frontmatter (NEW)
  evals/               # context TDD scenarios — internal, NOT exported
  cdlc.toml            # loop state + provenance (exists)
```

### Agent file format (`agents/*.md`)

```markdown
---
name: kyc-reviewer
description: Reviews KYC flows against SBS regs
model: claude-sonnet-4-6
tools: [Read, Grep, gh_pr_view]
covenant:
  escalate_threshold: 0.7
  voice: formal
  hard_constraints: "no git push --force"
  color: "#6B7280"
  emoji: "🛡️"
  tags: [kyc, peru, compliance]
---
<persona body = system prompt>
```

- **Standard keys** (`name`, `description`, `model`, `tools`, body) are what every
  executor reads.
- **`covenant:` block** holds runtime semantics with no native equivalent. It is
  **stripped on every export** so executors always receive a clean native file.
- **XP / earned state** is NOT in this file. It lives in SQLite keyed by
  `(operator, user)`. Committing it would share one operator's XP across everyone
  and conflict on every decision.

### Context file format (`context/*.md`)

```markdown
---
summary: Mask all PII; never log card numbers; KYC review must cite SBS article.
---
<full regulatory text — the SBS KYC rulebook>
```

- `summary:` is **authored**, not derived. The exporter uses it for the always-on
  digest; the body is the deferred full text.

## The exporter

### Neutral artifact

Every source file loads into one shape:

```rust
struct Artifact {
    kind: ArtifactKind,        // Agent | Skill | Context
    name: String,
    summary: Option<String>,   // context: from frontmatter; agent: description
    frontmatter: Frontmatter,  // standard keys only (covenant block already split off)
    body: String,
}
```

### Two host strategies (generalized from today's `project.rs`)

1. **`FilePerItem(dir)`** — write `<dir>/<name>.md` (or `<dir>/<name>/SKILL.md`),
   injecting/normalizing frontmatter. Used by executors with native multi-file
   dirs: Claude (`.claude/agents/`, `.claude/skills/`), opencode (`.opencode/agent/`).
2. **`ManagedBlock(file)`** — upsert one `<!-- cdlc:start -->…<!-- cdlc:end -->`
   block into a single instruction file. Used by executors with one instruction
   file: codex (`AGENTS.md`), copilot (`.github/copilot-instructions.md`).

Both already exist in `project.rs`; this design lifts them out of the
skills-specific code path.

### Executor table

Each executor declares a host strategy + a path map per artifact kind.
Export = `for each artifact, for each executor: strategy.write(executor.path_for(kind), artifact)`.

| kind | file-per-item (Claude, opencode) | managed-block (codex, copilot) |
|---|---|---|
| **agent** | one `.md`, `covenant:` block **stripped** | active operator's body → block |
| **skill** | skill dir (exists) | body → block (exists) |
| **context** | `summary` → instruction file; **full body → skill dir** | `summary` → block only (nowhere to defer full text) |

Notes:
- **agent → managed-block executors:** those tools run one persona at a time, so
  the block carries *the currently-attached operator's* body, not a roster.
- **context → file-per-item executors:** two targets at once — the `summary` into
  the instruction file (e.g. `CLAUDE.md`), the full body as
  `.claude/skills/<name>/SKILL.md`. Cheap always-on + free on-demand.
- **context → managed-block executors:** summary only; they have no skills dir to
  defer the full text into.

### Properties

- **Idempotent + re-runnable** — re-export produces identical files; empty source
  strips the managed block but preserves surrounding user content (today's
  behaviour, preserved).
- **Extensible by data, not code** — new artifact kind = one path-map row; new
  executor = declare strategy + paths. **No new writer functions.**

## v1 scope

- **In:** claude, codex, copilot (machinery already exists in `project.rs`).
- **Deferred (add a table row when the write-path lands):** opencode, pi, hermes.
- **Out of scope this session:** agent authoring (separate session); `evals/`
  (internal TDD, not exported); registry publish/install (CDLC Phase 2).

## Implementation shape

Refactor `crates/cdlc/src/project.rs`:
1. Introduce `Artifact` + `ArtifactKind` and a loader per source dir
   (`agents/`, `skills/`, `context/`).
2. Extract the two host strategies into reusable writers.
3. Replace the hardcoded skills projection with the executor table driving
   both strategies over all artifact kinds.
4. Agent loader splits the `covenant:` frontmatter block off before export and
   keeps it for Covenant's own Operator hydration.

This is a refactor of existing projection code into a 2-strategy table — not a
new subsystem.
