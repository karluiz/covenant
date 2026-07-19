# Worktree Prevention — design

**Date:** 2026-07-19
**Branch:** `feat/worktree-prevention`
**Predecessor:** `2026-07-18-worktree-lifecycle-design.md` (shipped v0.9.38)

## Problem

The lifecycle work shipped in v0.9.38 gave Covenant the ability to *see* dead
worktrees and reclaim them — it cleaned up 16 worktrees and 44.4 GB on the
developer's machine the day it landed. What it did not do is stop the mess from
re-forming. Diagnosis and repair, no prevention.

The mess re-forms because **every coding agent picks its own worktree location**,
and each one picks differently: Claude's `EnterWorktree` hardcodes
`.claude/worktrees/`, the superpowers fallback uses `.worktrees/`, and ad-hoc
`git worktree add` calls scatter siblings across `~/Sources/`. Five conventions
on one repo.

The obvious fix — project the canonical path into each executor's config — is
dead on arrival. `EnterWorktree` exposes only `worktree.baseRef` and refuses to
even *enter* a worktree outside its hardcoded directory. At least one executor
cannot be configured to comply, and the next harness added may be worse.

## The lever

Every harness picks a location only at the moment it decides to **create** a
worktree, and every one of them checks for existing isolation first and stands
down. Claude's own skill says it outright: *"If you are already in a linked
worktree, do NOT create another worktree."* Codex and copilot reach the same
conclusion from `AGENTS.md`.

So **Covenant creates the worktree and launches the executor inside it.** No
agent chooses a location, because no agent reaches the question. Homologation
becomes structural rather than requested.

This is the project's ontology — Covenant is the source, executors are
projections — applied to the filesystem.

## Goals

- Launching any executor produces an isolated worktree at the canonical root,
  with no per-executor configuration and no human having to remember.
- A new executor added tomorrow inherits the behaviour without being added to
  any list.
- Prevention generates no garbage of its own: a worktree that was never written
  to leaves no trace.
- No new persistence. Every decision is derived, consistent with the lifecycle
  feature it builds on.

## Non-goals

- The Canon artifact projecting the convention into `AGENTS.md` / `CLAUDE.md` /
  copilot instructions. Separate subsystem, separate cycle — and it drops in
  priority once Covenant hands out the worktree, since a written rule becomes
  the backstop for work Covenant did not launch rather than the mechanism.
- Renaming the branch from the LLM-suggested tab title. Fast-follow.
- Cross-repo scope. Still one repo at a time.
- Changing anything about how the lifecycle states are derived or reclaimed.

## The trigger

`SpawnSpec` gains one field:

```rust
/// Launch this spawn inside a fresh worktree at the canonical root.
/// Defaults to true for every spawn except the base shell — a new executor
/// inherits isolation without being added to any list.
#[serde(default = "default_worktree")]
pub worktree: bool,
```

Surfaced in Harnesses alongside the existing per-executor trust / model / env
settings.

**The default is the design decision.** Three candidates were considered:

| Basis | Why rejected / chosen |
|---|---|
| `acp: true` | Covers copilot and pi, misses claude and codex on PTY. |
| A list of known executor ids | Works today; a new executor is born unprotected, which is the original failure mode wearing a new hat. |
| **Every spawn except the base shell** | **Chosen.** Survives the executor that does not exist yet. |

The distinction is *executor spawn vs. plain shell spawn*, never one named
executor vs. the others.

## Creation

New command, deferred from the lifecycle spec:

```rust
pub fn create_worktree(cwd: &Path, slug: &str, base: Option<&str>) -> Result<String, String>
```

- **Location:** `<main worktree root>/.covenant/worktrees/<slug>`. The main
  worktree is identified structurally — always the first entry of
  `git worktree list --porcelain` — reusing the single existing mechanism.
  Deriving this from the calling cwd caused two Critical defects in the
  predecessor; there must not be a second way to find main.
- **Slug:** `agent/<executor>-<MMDD>-<suffix>`, where `<suffix>` is a short
  random discriminator. Readable enough to answer "where did this branch come
  from" months later — the existing `worktree-a3dd4e8417b0e2ebe` branches in
  this repo are the counter-example.
- **Base ref:** `origin/<default branch>`, falling back to the local default
  branch when there is no `origin` or no network. The agent should start from
  shared main, not from the half-finished state of whatever branch the user is
  standing on.

### Launch paths

An earlier draft of this spec claimed "both launch paths already carry a working
directory". That was wrong, and the correction changes user-visible behaviour.
There are three paths, and only one opens anything new:

| Path | Today |
|---|---|
| `createAcpTab({cwd})` | Opens a new ACP tab with a cwd. The worktree drops in unchanged. |
| `runSpawn` (PTY) | Writes the cmdline into the session you are **already in** via `writeToSession`. No new tab, no cwd to set. `SpawnSpec.cwd` exists as a field but this path never uses it. |
| `defaultAgentCmdline` | Preloads a cmdline into a fresh tab. |

The PTY path is the most used one — Ctrl+N, the spawn picker, "Start agent" in
the pane context menu — and it is the path that filled `.claude/worktrees/`.

**Decision: in worktree mode, a PTY spawn opens a new tab** cwd'd into the
worktree, via the existing `createTab({ cwd, initialCommand })`. Agents are then
born isolated on every path, consistently.

This is a real behaviour change: today Ctrl+N runs the agent where you are
standing; it will open a tab instead. Accepted deliberately. The alternatives
were rejected: writing `cd <worktree>` into the current terminal hijacks the
user's own cwd and strands them in a directory that may be removed on close,
and limiting worktrees to ACP spawns would exempt exactly the executors that
caused the original mess.

A spawn with `worktree: false` keeps today's in-place behaviour untouched.

## Retirement

On tab close, the worktree is removed **silently** when all four hold:

1. Its cwd is under the canonical root.
2. It has no commits of its own — `git rev-list <base>..HEAD --count` is 0.
3. Its working tree is clean.
4. No other open tab has a cwd inside it.

A worktree with no commits and a clean tree contains nothing. Removing it is
lossless — the same class of proof that makes `Spent` safe to reclaim, reached
by a different route. Anything else stays on disk and the lifecycle ledger
classifies it later as `Active`, `Stale`, or `Spent`.

**No new persistence.** All four conditions are derived: three from git, the
fourth from `listTabSnapshots()` — the same channel the relocate guard already
uses. Nothing marks a worktree as "Covenant-created"; there is no registry to
drift out of sync. This is the same discipline as the lifecycle states.

## Degradation

Isolation must never be the reason an agent fails to start.

- **Not a git repo:** launch in the cwd exactly as today, silently.
- **Already inside a worktree:** still get a fresh one from `origin/<default>`.
  Never nested — nesting is one of the pathologies the ledger flags.
- **`create_worktree` fails** (disk, permissions, a colliding slug): launch in
  the cwd and surface the reason in a toast. Degraded, never blocked.

## Testing

Rust, in `crates/app/src/git_tools.rs`:

- Slug derivation is deterministic given its inputs, and legal as a git ref.
- Base ref resolves with `origin/HEAD` present, with it stale, and with no
  `origin` at all.
- **Creation lands under the MAIN worktree root when called from a linked
  worktree** — the exact bug shape that shipped twice in the predecessor.
- Creation from inside an existing worktree does not nest.
- Retirement refuses a worktree with commits, refuses a dirty one, and refuses
  one whose path is outside the canonical root.

Frontend (`vitest`):

- A spawn with `worktree: false` launches in the plain cwd.
- Retirement is skipped when another tab snapshot shares the worktree's cwd.
- A `create_worktree` failure still launches the agent.

## Open questions

- Whether the LLM tab title should rename the branch once it lands. Deferred by
  agreement — it needs the title pipeline to be reliable first, and the slug is
  serviceable without it.
