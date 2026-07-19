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
| `Active` | The current worktree, or uncommitted changes, or unmerged with a commit inside `STALE_AFTER_DAYS` | Open | 2 |
| `Stale` | Unmerged and clean, no commit in 14 days | Decide | 4 |
| `Spent` | Branch merged into the default branch, working tree clean | Reclaim | 17 |
| `Orphan` | Registered in git, path missing from disk | Prune | 0 |

`Active` and `Stale` are disjoint complements over the unmerged-and-clean set,
split by age. An earlier draft defined `Active` as "commits ahead of the default
branch", which collides with `Stale` — every unmerged branch is ahead.

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
`master`, then the current branch. **Every candidate is verified to resolve
locally before being used** — a stale `origin/HEAD` after a default-branch
rename would otherwise make `git branch --merged` fail, silently emptying the
merged set so nothing is ever `Spent` and the whole feature quietly does nothing.

Disk size is the expensive input. It is NOT a field on `GitWorktreeSummary` and
is never computed during `repo_summary` — `du` over ~23 worktrees takes seconds
and would block every popover open. It has its own command, `worktree_sizes`,
called only when a size is actually needed (to fill in the reclaim confirmation).

**The canonical root is derived from the MAIN worktree, never from the calling
cwd.** `repo_summary` is invoked with the active terminal tab's cwd, which in
this project is usually a linked worktree; deriving the root from it made
correctly-placed worktrees report `off_convention` and, worse, made `relocate`
target a path nested inside a sibling worktree. The main worktree is identified
structurally — `git worktree list --porcelain` always returns it first — and
that single mechanism is reused everywhere. Note that `GitWorktreeSummary.current`
means "matches the calling cwd", NOT "is the main worktree"; conflating the two
was the source of two separate defects during implementation.

### Safety rules

- **Reclaim deletes `Spent`, and prunes `Orphan`.** Merged-and-clean is the only
  condition under which Covenant removes a worktree's *files*. `Orphan` is
  accepted too, but it is a different operation: the directory is already gone,
  so only the stale git admin record is dropped, and **the branch is never
  deleted** — an orphan's branch may hold the last copy of unmerged work.
- **The caller's classification is never trusted.** `reclaim_worktrees`
  re-derives state itself via `repo_summary` and refuses anything it does not
  compute as `Spent` or `Orphan`. A stale UI or a hand-crafted IPC call cannot
  destroy live work.
- **Merge status is re-verified immediately before removal.** `git worktree
  remove` re-checks cleanliness on its own but not merge status, so a worktree
  that gained an unmerged commit after the state snapshot would otherwise lose
  its checkout. `git branch -d` (lowercase, refuses unmerged) is a second,
  independent net beneath that.
- **`OffConvention` is a warning, never a deletion reason.** A worktree in the
  wrong place still works.
- **Relocation requires idle.** `git worktree move` under a live session pulls
  the floor out from under it. Idle means: no attached tab, no running executor
  process with that cwd, and a clean tree. All three — but split across two
  layers, because `git_tools` is a pure git/filesystem module with no
  visibility into sessions. `relocate_worktree` (Rust) enforces the clean-tree
  half plus the calling-worktree/main-worktree guards; it cannot see open tabs
  at all. The no-attached-tab half is enforced by the caller instead:
  `worktreeDefaultAction` (`ui/src/status/worktree-state.ts`) withholds the
  Relocate action for any worktree with a live tab cwd'd into it, using the
  tab manager's `listTabSnapshots()` (which already covers background tabs,
  not just the focused one — every executor process in Covenant runs inside a
  tab, so this also covers "no running executor process with that cwd" in
  practice). A worktree relocated via a hand-crafted IPC call rather than the
  popover is not protected by this frontend guard.
- **Neither the current worktree nor the MAIN worktree is ever relocated.**
  Even if it qualifies. `relocate_worktree` enforces this with two explicit,
  separate guards, because they are two different worktrees whenever the call
  originates from a linked one.
- **Reclaim protects the current worktree and the main worktree by different
  means, and only one of them is an explicit guard.** The current worktree is
  protected structurally: it can never classify as `Spent` or `Orphan` in the
  first place (`derive_state` forces `current` to `Active`), so
  `reclaim_worktrees`'s own state gate refuses it before any removal is
  attempted. The MAIN worktree has no such gate — `reclaim_worktrees` never
  special-cases "is this the main worktree" — and relies entirely on `git
  worktree remove`'s own hard refusal to remove a repository's main working
  tree. That is a real guard, just not one Covenant wrote; it only becomes
  reachable at all when the main worktree happens to pass every other check
  (clean, checked out on a branch already merged into the default branch).

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
}
```

`size_kb` is deliberately absent — see Derivation above.

New commands:

- `worktree_reclaim(cwd, paths: Vec<String>) -> Vec<ReclaimOutcome>` — re-derives
  state server-side and refuses any path it does not itself compute as `Spent` or
  `Orphan`. For `Spent`: re-verifies merge status, then `git worktree remove`,
  then `git branch -d`. For `Orphan`: drops the admin record only, branch
  untouched. `git worktree prune` runs once at the end.
- `worktree_relocate(cwd, path: String) -> Result<String>` — re-checks idle, then
  `git worktree move` to the canonical root. Returns the new path.
- `worktree_sizes(paths: Vec<String>) -> Vec<(String, u64)>` — `du -sk` per path,
  missing paths omitted, per-path failures isolated.

`ReclaimOutcome` carries per-path outcome (`removed` plus a `reason` when
refused) so a partial failure is legible rather than silent.

Deferred to the prevention phase: `worktree_create(slug, base) -> String`, which
creates at the canonical root for spawn/ACP launch.

### Frontend

**The git popover IS the ledger.** It already lists every worktree with sections,
counts, filtering, and per-row buttons, so it gains the state and the actions
rather than a second surface being built beside it. Zero new panels: the
diagnosis appears where the user already looks.

- `ui/src/status/bar.ts` popover: render `state` instead of `CLEAN`, using the
  existing semantic dot. `Spent` must not read as healthy.
- Per-row action button carrying the single default verb, plus a bulk
  **Reclaim N spent** in the section head, behind a confirm naming the count and
  the reclaimed size.
- `ui/src/status/worktree-state.ts` holds the pure state→label/class/verb
  mapping so it is unit-testable without mounting the bar.
- Confirmation uses `pushConfirmToast`, never `window.confirm` — a native modal
  blocks the entire webview. Toast copy is NOT escaped (toasts render via
  `textContent`); row markup IS.
- The popover renders once and has no refresh path, so a successful mutation
  closes it rather than leaving stale rows on screen.

### Error handling

- Any git invocation failing for one worktree degrades that row to `Active` —
  never silently dropped, and never classified as deletable.
- `worktree_reclaim` is per-path fallible; one failure does not abort the batch,
  and a partial failure is reported as partial, never as success.

## Testing

Rust, in `crates/app/src/git_tools.rs` tests plus a fixture repo helper:

- State derivation: one test per state, including the precedence order and the
  unclassifiable-defaults-to-Active rule.
- `off_convention` is orthogonal: a Spent worktree outside the root reclaims
  rather than relocates.
- `worktree_reclaim` refuses a non-Spent, non-Orphan path even when asked
  directly — the central safety test.
- An `Orphan` reclaim drops the admin record and leaves the branch intact.
- Reclaim refuses the current worktree (structurally, via `derive_state`
  forcing it `Active`) and separately refuses the MAIN worktree when called
  from a linked one (via `git worktree remove`'s own refusal, with no
  explicit main-worktree gate in `reclaim_worktrees` — the test proves the
  removal is stopped by git, not by an earlier check) — tested separately.
- Relocate lands under the MAIN root, not nested in the calling worktree, and
  leaves the calling worktree clean.
- Slug derivation strips each prefix form.
- Extend `parses_worktree_porcelain` for nested-worktree paths.

Frontend (`vitest`): a `Spent` row does not render the healthy dot; each state
gets a distinct dot class; the bulk reclaim does not fire without confirmation;
a partial failure is reported honestly; a path containing a double quote cannot
break out of its `data-path` attribute.

## Phases

Each phase ships independently.

1. **Diagnosis and repair *(shipped)*.** Backend state derivation, the popover
   telling the truth, and the reclaim / relocate / prune actions wired into it.
   Delivers both the ability to *see* the 44 GB and the ability to *reclaim* it.
   Originally planned as two phases; merged because seeing without fixing is
   half a feature.
2. **Covenant hands out the worktree.** Spawn and ACP launch into a fresh
   canonical worktree; the Canon artifact projecting the rule into `AGENTS.md`
   and the other instruction files ships alongside as the backstop. Delivers the
   guarantee that it does not come back.

## Open questions

Deferred deliberately, not blocking phase 1:

- Automatic reclaim of `Spent` worktrees. Defensible — they are provably safe —
  and also the kind of thing that terrifies people the first time it runs.
- Cross-repo ledger.
