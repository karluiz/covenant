# Worktree Lifecycle — design

**Date:** 2026-07-18
**Branch:** `feat/worktree-lifecycle`
**Design record:** https://claude.ai/code/artifact/1553c105-6ccf-49f4-b1bb-f155805a90cc

## Problem

Agents create git worktrees constantly and nothing ever retires them. On this
machine, `karlTerminal` has 23 worktrees created by three mechanisms across five
naming conventions, totalling ~65 GB. Seventeen of them are merged into `main`
and clean — provably dead, ~44 GB reclaimable with zero risk.

Covenant already sees all of them. The git popover lists every worktree and
paints them green. That green is the bug: `GitWorktreeSummary` carries only
`dirty_count`, so `CLEAN` means "no uncommitted changes" — which is true of
every dead worktree on the list. The signal that reads as *healthy* is the same
signal that means *safe to delete*.

Two failures compound:

1. **No lifecycle.** A worktree is born when work starts and should die when the
   work lands. Nothing marks the death, so they accumulate forever.
2. **No homologation.** Each harness picks its own location. Claude's
   `EnterWorktree` uses `.claude/worktrees/`, the superpowers fallback uses
   `.worktrees/`, ad-hoc agents scatter siblings across `~/Sources/`
   (`karlTerminal-*`, `kt-*`, `covenant-*`). One worktree is nested inside
   another.

The target user is not only Karluiz. A developer who has never heard of agentic
development inherits this same mess the first time they let an agent work on
their repo, with no vocabulary to diagnose it.

## Goals

- Covenant can state, per worktree, whether it is alive or dead — and be right.
- Reclaiming dead worktrees is one confirmed action, not a git lesson.
- All harnesses produce worktrees in one location, enforced structurally rather
  than requested politely.
- No new persistence: state is derived from git.

## Non-goals

- Cross-repo worktree management. Scoped to the current repo; a developer with
  several agentic projects has this mess several times over, but that is a later
  question.
- Automatic garbage collection. Manual until the manual version is boring.
- Changing how branches are created, named, or merged.

## The state model

Five states, derived — never stored. Each has exactly one default action. The
one-action rule is the accessibility requirement: the user accepts a verdict,
they never choose a git command.

Four lifecycle states, mutually exclusive:

| State | Derived from | Action | Count today |
|---|---|---|---|
| `Active` | Uncommitted changes, or commits ahead of the default branch, or a live tab attached | Open | 2 |
| `Stale` | Unmerged and clean, no commit in 14 days | Decide | 4 |
| `Spent` | Branch merged into the default branch, working tree clean | Reclaim | 17 |
| `Orphan` | Registered in git, path missing from disk | Prune | 0 |

Plus one orthogonal flag:

| Flag | Derived from | Action when set | Count today |
|---|---|---|---|
| `off_convention` | Path outside the canonical root, or nested inside another worktree | Relocate | 12 |

`OffConvention` is orthogonal to the other four — a worktree can be both `Spent`
and `OffConvention`. It is carried as a separate boolean flag, not a sixth
variant, and the lifecycle state wins when choosing the default action (a Spent
worktree in the wrong place gets reclaimed, not relocated).

Precedence among the four lifecycle states, evaluated in order: `Orphan` →
`Active` → `Spent` → `Stale`. A worktree matching none of these is `Active`
(the conservative default — never propose deleting something we can't classify).

### Derivation

All inputs come from git plus one filesystem call:

- `git worktree list --porcelain` — path, branch, head, detached, bare
- `git status --porcelain` in each worktree — dirty count
- `git branch --merged <default>` — merged set
- `git log -1 --format=%ct <branch>` — last commit timestamp
- `du -sk <path>` — disk size

The default branch is resolved once per repo from
`git symbolic-ref refs/remotes/origin/HEAD`, falling back to `main`, then
`master`.

Disk size is the expensive input. It is computed lazily and cached in memory for
the session; the ledger renders without it and fills sizes in as they arrive.

### Safety rules

- **Reclaim only ever deletes `Spent`.** Merged-and-clean is the sole condition
  under which Covenant removes a worktree without a question.
- **`OffConvention` is a warning, never a deletion reason.** A worktree in the
  wrong place still works.
- **Relocation requires idle.** `git worktree move` under a live session pulls
  the floor out from under it. Idle means: no attached tab, no running executor
  process with that cwd, and a clean tree. All three.
- **The current worktree is never reclaimed or relocated.** Even if it qualifies.

## Homologation

### Canonical root

`.covenant/worktrees/<slug>` at the repo root, gitignored.

Harness-neutral by definition. Adopting `.claude/worktrees/` would repeat the
original mistake — treating one executor's default as everyone's convention.

`<slug>` is the branch name with any `feature/`, `feat/`, `fix/`, `chore/`, or
`worktree-` prefix stripped, with `/` replaced by `-`.

### Why configuring the harnesses does not work

The obvious approach — project the canonical path into each executor's config —
is dead on arrival. Claude's `EnterWorktree` hardcodes `.claude/worktrees/` and
exposes only `worktree.baseRef` (`fresh` | `head`). It refuses to even *enter* a
worktree outside that directory. At least one executor cannot be configured to
comply, and the next harness we add may be worse.

### The lever: remove the decision

Every harness picks a location only at the moment it decides to *create* a
worktree, and every one of them checks for existing isolation first and stands
down. Claude's own skill: *"If you are already in a linked worktree, do NOT
create another worktree."* Codex and copilot reach the same conclusion from
`AGENTS.md`.

So **Covenant creates the worktree and launches the executor inside it.** No
agent chooses a location because no agent reaches the question. This is the
project's ontology — Covenant is the source, executors are projections — applied
to the filesystem.

Two tiers, because compliance is never total:

- **Prevention (primary).** Spawns (`Spawn.cwd`) and ACP tabs (`cwd: PathBuf`)
  already carry a working directory. Launching into a fresh worktree is an
  addition to plumbing that exists.
- **Reconciliation (backstop).** Anything created behind Covenant's back
  surfaces as `OffConvention` and is offered relocation when idle. Detection is
  projection running backwards — the same move Canon already makes for foreign
  skills and agents.

The `AGENTS.md` rule still ships, but demoted: it is the fallback for work
Covenant did not launch, not the mechanism.

## Architecture

### Backend — `crates/app/src/git_tools.rs`

Extend the existing `GitWorktreeSummary` rather than introducing a parallel type;
the git popover and the ledger read the same struct.

```rust
pub enum WorktreeState { Active, Stale, Spent, Orphan }

pub struct GitWorktreeSummary {
    // existing
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub current: bool,
    pub detached: bool,
    pub bare: bool,
    pub dirty_count: u32,
    // new
    pub state: WorktreeState,
    pub off_convention: bool,
    pub merged: bool,
    pub last_commit_unix: Option<i64>,
    pub size_kb: Option<u64>,
}
```

New commands:

- `worktree_reclaim(paths: Vec<String>) -> ReclaimReport` — re-derives state
  server-side and refuses any path that is not `Spent`. Never trusts the
  frontend's classification. Runs `git worktree remove` then
  `git branch -d`, and `git worktree prune` once at the end.
- `worktree_relocate(path: String) -> Result<String>` — re-checks idle, then
  `git worktree move` to the canonical root. Returns the new path.
- `worktree_create(slug: String, base: Option<String>) -> String` — creates at
  the canonical root and returns the path, for spawn/ACP launch.

`ReclaimReport` carries per-path outcome (removed / refused with reason) so a
partial failure is legible rather than silent.

### Frontend

- `ui/src/git/` popover: render `state` instead of `CLEAN`, using the existing
  semantic dot. `Spent` must not read as healthy.
- New Worktrees section following the established `.rail-*` chrome: census strip
  over state counts, one `.rail-row` per worktree grouped by state, hover-reveal
  actions, `.rail-empty` when the repo has none. Bulk **Reclaim spent** in the
  section head, behind a confirm naming the count and the reclaimed size.

### Error handling

- Any git invocation failing for one worktree degrades that row to `Active` with
  the error surfaced in its tooltip — never silently drops it from the ledger,
  and never classifies it as deletable.
- `worktree_reclaim` is per-path fallible; one failure does not abort the batch.
- A repo with no worktrees, or a non-git cwd, renders `.rail-empty`.

## Testing

Rust, in `crates/app/src/git_tools.rs` tests plus a fixture repo helper:

- State derivation: one test per state, including the precedence order and the
  unclassifiable-defaults-to-Active rule.
- `off_convention` is orthogonal: a Spent worktree outside the root reclaims
  rather than relocates.
- `worktree_reclaim` refuses a non-Spent path even when asked directly — the
  central safety test.
- Reclaim never touches the current worktree.
- Slug derivation strips each prefix form.
- Extend `parses_worktree_porcelain` for nested-worktree paths.

Frontend (`vitest`): census counts group correctly; a `Spent` row does not render
the healthy dot.

## Phases

Each phase ships independently.

1. **Truth in the existing view.** Backend state derivation + the popover
   showing it. No new surface — the diagnosis appears where the user already
   looks. Delivers the ability to *see* the 44 GB.
2. **Ledger and reclaim.** The Worktrees section, per-row actions, bulk reclaim,
   relocation. Delivers the ability to *fix* it.
3. **Covenant hands out the worktree.** Spawn and ACP launch into a fresh
   canonical worktree; the Canon artifact projecting the rule into `AGENTS.md`
   and the other instruction files ships alongside as the backstop. Delivers the
   guarantee that it does not come back.

## Open questions

Deferred deliberately, not blocking phase 1:

- Automatic reclaim of `Spent` worktrees. Defensible — they are provably safe —
  and also the kind of thing that terrifies people the first time it runs.
- Cross-repo ledger.
