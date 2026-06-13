# Operator Achievement Emitters — Design

**Date:** 2026-06-13
**Status:** Approved (pending spec review)
**Scope:** Wire all 9 currently-dormant achievement emitters in the Covenant achievement engine.

---

## Background

Covenant has a complete, tested achievement engine in `crates/score`:

- **Definitions/catalog:** `crates/score/src/achievements.rs` — 10 achievements, each with `trigger_kinds` (the fact kinds that advance it), `subject` (Operator / Orchestrator / Project / System), `scope` (Global / Repo / Operator / Orchestrator), tier table, and reputation weights.
- **Engine + storage:** `crates/score/src/store.rs` — `record_achievement_fact()` inserts an immutable fact (idempotent via `dedupe_key`), increments per-`(achievement, subject, scope)` progress, and inserts award rows for newly-crossed tiers.
- **Public API:** `crates/score/src/lib.rs` — `record_achievement_fact(fact) -> Vec<AchievementAward>`, plus the existing precedent emitter `record_spec()` which emits a `project_note_created` fact for **cartographer**.
- **Context:** `current_context()` resolves repo/branch from the current session's cwd; `set_current_session()` is called by the UI on active-session change. **Context carries no operator identity.**

Today **only** `cartographer` is wired (spec→`project_note_created`). The other 9 achievements have definitions, storage, and UI but no production emitter.

The `AchievementFact` builder exists: `AchievementFact::new(kind, subject).with_subject(id).with_repo(r).with_task(t).with_verification(v).with_dedupe(k)`.

**Critical pitfall (from `record_spec` source comment):** `record_achievement_fact` re-acquires the store lock. Emitting while holding that lock deadlocks. All emit helpers must build the fact and call `record_achievement_fact` **after** any store lock is released.

---

## Goals

Wire emitters for the 9 dormant achievements:

| # | id | subject | scope | fact kind(s) |
|---|---|---|---|---|
| 1 | finisher | Operator | Operator | `task_verified` |
| 2 | clean_run | Operator | Operator | `clean_run` |
| 3 | recovery_artist | Orchestrator | Global | `task_recovered` |
| 4 | build_steward | Operator | Repo | `build_command_passed`, `test_command_passed`, `lint_command_passed` |
| 5 | guardian | System | Global | `risky_action_blocked`, `risky_action_confirmed`, `risky_action_rewritten` |
| 6 | secret_keeper | System | Global | `secret_redacted` |
| 7 | spec_keeper | Operator | Repo | `spec_kept` |
| 8 | good_delegate | Orchestrator | Global | `orchestrator_task_delegated` |
| 9 | command_librarian | Project | Repo | `project_command_learned` |

**Decisions taken during brainstorming:**

- **#8 good_delegate, #9 command_librarian:** no trigger source exists (no delegation mechanic, no project-command registry). **Wire the emit helper + tests now, leave dormant** — no fabricated trigger. They become earnable when those features are built.
- **#2 clean_run, #7 spec_keeper:** use **full per-task state tracking**, not loose heuristics.

---

## Architecture

### Emitter layer — centralized typed helpers in `karl_score`

Add one helper per fact kind in `crates/score/src/lib.rs`, alongside `record_spec`. Each helper:

- builds the `AchievementFact` (subject, repo, task, verification),
- constructs the dedupe key (convention owned in one place),
- calls `record_achievement_fact` after the store lock is released.

Proposed signatures:

```rust
pub fn record_task_verified(operator: &str, repo: Option<&str>, task_id: &str);
pub fn record_clean_run(operator: &str, repo: Option<&str>, task_id: &str);
pub fn record_task_recovered(orchestrator: &str, task_id: &str);
pub fn record_build_pass(kind: BuildKind, operator: &str, repo: &str, command: &str);
pub fn record_risky_action(outcome: RiskyOutcome);          // blocked | confirmed | rewritten
pub fn record_secret_redacted(kind_hint: &str);
pub fn record_spec_kept(operator: &str, repo: &str, spec_path: &str);
// dormant — wired + tested, no production caller yet:
pub fn record_task_delegated(orchestrator: &str, task_id: &str);
pub fn record_project_command_learned(repo: &str, command: &str, kind: BuildKind);
```

`BuildKind` (Build/Test/Lint) maps to the three `*_command_passed` fact kinds. `RiskyOutcome` maps to the three `risky_action_*` kinds.

Call sites in `app`/`agent` stay one-liners.

**Rejected alternatives:** inline `AchievementFact::new().with_*()` at call sites (scatters dedupe conventions + lock-reentrancy footgun across crates); single bus-derived consumer (bus events carry no operator identity and it would duplicate the supervisor state machine).

### Subject keys

- Operator / Orchestrator subjects: `OperatorId.to_string()` — durable; display names can change and would split progress.
- Project / Repo scope: repo name (matches the cartographer precedent).
- Orchestrator subject for recovery_artist: the task's `operator_id` (the operator coordinating the task).

### Dedupe key conventions

- `task_verified:{task_id}` — one finisher per task.
- `clean_run:{task_id}` — one per task.
- `task_recovered:{task_id}` — one per task.
- `{build|test|lint}_command_passed:{repo}:{hash(command)}` — collapses re-runs of the same command in a repo.
- `risky_action_{outcome}:{ts_ms}` and `secret_redacted:{ts_ms}` — System events fire repeatedly; timestamp keeps each distinct (these are meant to accumulate).
- `spec_kept:{repo}:{task_id}` — one per task per repo.
- `project_note_created:{repo}:{path}` — unchanged (existing cartographer).

---

## Per-achievement wiring

### finisher (`task_verified`) — UserAccepted

Emit in `complete_task_inner` (`crates/app/src/teammate/commands.rs`) after the task is marked Done. `task.operator_id` and `task.spawned_session` are available; repo from `current_context()` or the spawned session's cwd.

### clean_run (`clean_run`) — UserAccepted

The task supervisor (`crates/app/src/teammate/task_supervisor.rs`) sees every `BlockFinished` per task. Extend `TaskCtx` with `saw_failed_block: bool`, set true on any non-zero exit. At `complete_task_inner`, look up the task's flags via a new `TaskSupervisor::task_flags(session) -> Option<TaskFlags>`; emit `clean_run` iff `saw_failed_block == false`.

### recovery_artist (`task_recovered`) — CommandPassed

Extend `TaskCtx` with `ever_blocked: bool`, set true whenever status enters Blocked. At `complete_task_inner`, emit `task_recovered` iff `ever_blocked == true`. (Definition: blocked at some point, then completed — so it fires at completion, not at un-block.)

### build_steward (`*_command_passed`) — CommandPassed

In the supervisor `run_bus` loop, on an exit-0 `BlockFinished`, classify the command:

- build: `cargo build`, `npm run build`, `make build`, `go build`, …
- test: `cargo test`, `npm test`, `pytest`, `go test`, `make test`, …
- lint: `cargo clippy`, `npm run lint`, `eslint`, `ruff`, …

Classification is pattern-based (no authoritative registry). Repo from the block's `cwd`; operator from `TaskCtx.operator_id`. Only fires for blocks belonging to a tracked task (operator attribution requires it).

### guardian (`risky_action_*`) — SelfReport

Emit at the safety-enforcement boundary in `crates/app/src/safety.rs` callers (e.g. where `is_dangerous` gates an action): `risky_action_blocked` when an action is refused, `risky_action_confirmed`/`risky_action_rewritten` for the gated-then-allowed paths. System-scoped, no identity. **Exact call sites confirmed during implementation (TDD).**

### secret_keeper (`secret_redacted`) — SelfReport

Emit where secret masking actually changes its input (operator mind flush path, `crates/app/src/operator.rs`, and/or `safety::mask_secrets`). Fire only when the masked output differs from the input. System-scoped. **Exact call sites confirmed during implementation.**

### spec_keeper (`spec_kept`) — SelfReport — HIGHEST RISK

"Spec read or created **before the first code edit** in the task." The task timeline does not cleanly emit *spec read* or *first code edit* events today.

**Proposed definition (confirm at review):** within a task, a spec path under the repo (matching the spec_watcher's `**/specs/**` / `*.md` convention) is **created or modified before the first non-spec source-file modification after task start**.

**Signal sources to evaluate during implementation:**

- spec create/modify: existing `spec_watcher` (`crates/score/src/spec_watcher.rs`).
- "first code edit" boundary: either `ExecutorPhase::Reading`/`Writing` (`crates/blocks/src/executor_phase.rs`, if it carries a path) or filesystem mtime watching of the task's repo scoped to the task lifetime.

Tracker lives in per-task supervisor state (`spec_before_edit: Option<bool>`, latched on the first relevant event). Emit at `complete_task_inner` if satisfied.

If no adequate "edit" signal is reachable without disproportionate work, fall back to the brainstormed pragmatic form (operator-attributed spec read/create in the repo during the task, without strict ordering) — but only after surfacing that during implementation, not silently.

### good_delegate (`orchestrator_task_delegated`) — dormant

Add `record_task_delegated` + tests. No production caller. Becomes live when a delegation mechanic (orchestrator splits/spawns a subtask) exists.

### command_librarian (`project_command_learned`) — dormant

Add `record_project_command_learned` + tests. No production caller. Becomes live when a project-command registry exists.

---

## Testing

- **`crates/score`:** unit tests for each helper — correct fact kind, subject, scope, verification, dedupe key; dormant helpers tested for the fact they would emit. Reuse the existing in-memory store test pattern in `store.rs`.
- **`task_supervisor.rs`:** extend the existing `Inner` test harness for `saw_failed_block` and `ever_blocked` transitions and for build/test/lint command classification.
- **`complete_task_inner`:** tests that finisher always emits; clean_run emits only when no failed block; recovery_artist emits only when ever_blocked.
- Follow project TDD discipline; one commit per feature (not per TDD step); all code edits in a git worktree.

---

## Out of scope

- Building the delegation mechanic or project-command registry (#8/#9 stay dormant).
- UI changes — the achievements card already renders any earned/in-progress achievement.
- Backfill of historical facts.
