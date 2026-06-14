# Operator Achievement Emitters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire emitters for the 9 dormant achievements so operator/system/orchestrator/project actions actually advance the achievement engine.

**Architecture:** Pure `*_fact()` builders in `crates/score/src/achievements.rs` (side-effect-free, unit-tested directly) with thin `record_*()` wrappers in `crates/score/src/lib.rs` that build a fact and call the existing `record_achievement_fact`. Triggers are wired at: the task supervisor (per-task `saw_failed_block`/`ever_blocked` flags + build/test/lint classification), `teammate_complete_task` (finisher/clean_run/recovery_artist), the safety blocklist site (guardian), the operator-mind secret-mask flush (secret_keeper), and a new per-session spec-before-edit tracker hooked into `NotchHub::set_phase` (spec_keeper). `good_delegate` and `command_librarian` get builders + wrappers + tests but **no production caller** (dormant by decision).

**Tech Stack:** Rust, Tokio, `rusqlite` (score store), `parking_lot::Mutex`, Tauri commands.

**Spec:** `docs/superpowers/specs/2026-06-13-operator-achievement-emitters-design.md`

---

## Conventions used throughout

- **Subject key:** `OperatorId.to_string()` for operator/orchestrator subjects; repo name for project/repo scope.
- **Emit after lock release:** `record_achievement_fact` re-acquires the store lock — never call a `record_*` helper while holding it (mirrors the `record_spec` comment in `lib.rs`).
- **Builder API (already exists):** `AchievementFact::new(kind, SubjectKind).with_subject(id).with_repo(r).with_task(t).with_verification(v).with_dedupe(k)`.
- **Fact kinds must match `trigger_kinds` in the catalog exactly** (`crates/score/src/achievements.rs:295-442`).
- **TDD + commits:** write the failing test first; one commit per task (feature), not per TDD step.

---

## File Structure

- `crates/score/src/achievements.rs` — add `BuildKind`, `RiskyOutcome` enums + 9 pure `*_fact()` builders + their unit tests.
- `crates/score/src/lib.rs` — add 9 `record_*()` public wrappers.
- `crates/app/src/teammate/task_supervisor.rs` — add `saw_failed_block`/`ever_blocked` to `TaskCtx`, set them in `observe_block_finished`, add `TaskFlags` + `TaskSupervisor::task_flags()`, and build/test/lint emit in `run_bus`.
- `crates/app/src/teammate/build_classify.rs` (new) — pure `classify_command(cmd) -> Option<BuildKind>`.
- `crates/app/src/teammate/commands.rs` — emit finisher/clean_run/recovery_artist in `teammate_complete_task`; pure `plan_completion_emits()` helper + tests.
- `crates/app/src/operator.rs` — guardian emit at the `is_dangerous` block site (`:2980`); secret_keeper emit at the mask flush (`:3482`).
- `crates/app/src/rc_agent.rs` — guardian emit at the `is_dangerous` block site (`:432`).
- `crates/app/src/teammate/spec_edit_tracker.rs` (new) — per-session spec-before-edit state machine.
- `crates/app/src/notch.rs` — feed `ExecutorPhase` into the spec-edit tracker inside `set_phase`.
- `crates/app/src/teammate/mod.rs` — register the two new modules.

---

## Task 1: Pure fact builders + enums in `score`

**Files:**
- Modify: `crates/score/src/achievements.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block at the bottom of `crates/score/src/achievements.rs` (create the block if absent, `use super::*;`):

```rust
#[test]
fn task_verified_fact_targets_finisher() {
    let f = task_verified_fact("op-123", Some("myrepo"), "task-9");
    assert_eq!(f.kind, "task_verified");
    assert_eq!(f.subject_type, SubjectKind::Operator);
    assert_eq!(f.subject_id.as_deref(), Some("op-123"));
    assert_eq!(f.verification, Some(VerificationLevel::UserAccepted));
    assert_eq!(f.dedupe_key.as_deref(), Some("task_verified:task-9"));
    assert!(definitions_for_kind(&f.kind).iter().any(|d| d.id == "finisher"));
}

#[test]
fn clean_run_fact_targets_clean_run() {
    let f = clean_run_fact("op-1", None, "t-1");
    assert_eq!(f.kind, "clean_run");
    assert_eq!(f.subject_type, SubjectKind::Operator);
    assert_eq!(f.dedupe_key.as_deref(), Some("clean_run:t-1"));
    assert!(definitions_for_kind(&f.kind).iter().any(|d| d.id == "clean_run"));
}

#[test]
fn task_recovered_fact_is_orchestrator_global() {
    let f = task_recovered_fact("op-1", "t-1");
    assert_eq!(f.kind, "task_recovered");
    assert_eq!(f.subject_type, SubjectKind::Orchestrator);
    assert_eq!(f.subject_id.as_deref(), Some("op-1"));
    assert_eq!(f.dedupe_key.as_deref(), Some("task_recovered:t-1"));
    assert!(definitions_for_kind(&f.kind).iter().any(|d| d.id == "recovery_artist"));
}

#[test]
fn build_pass_facts_map_to_build_steward() {
    for (k, expect) in [
        (BuildKind::Build, "build_command_passed"),
        (BuildKind::Test, "test_command_passed"),
        (BuildKind::Lint, "lint_command_passed"),
    ] {
        let f = build_pass_fact(k, "op-1", "repo", "cargo test");
        assert_eq!(f.kind, expect);
        assert_eq!(f.subject_type, SubjectKind::Operator);
        assert_eq!(f.repo.as_deref(), Some("repo"));
        assert_eq!(f.verification, Some(VerificationLevel::CommandPassed));
        assert!(definitions_for_kind(&f.kind).iter().any(|d| d.id == "build_steward"));
    }
}

#[test]
fn risky_action_facts_map_to_guardian() {
    for (o, expect) in [
        (RiskyOutcome::Blocked, "risky_action_blocked"),
        (RiskyOutcome::Confirmed, "risky_action_confirmed"),
        (RiskyOutcome::Rewritten, "risky_action_rewritten"),
    ] {
        let f = risky_action_fact(o, 1234);
        assert_eq!(f.kind, expect);
        assert_eq!(f.subject_type, SubjectKind::System);
        assert_eq!(f.dedupe_key.as_deref(), Some(format!("{expect}:1234").as_str()));
        assert!(definitions_for_kind(&f.kind).iter().any(|d| d.id == "guardian"));
    }
}

#[test]
fn secret_redacted_fact_targets_secret_keeper() {
    let f = secret_redacted_fact("operator_mind", 99);
    assert_eq!(f.kind, "secret_redacted");
    assert_eq!(f.subject_type, SubjectKind::System);
    assert_eq!(f.dedupe_key.as_deref(), Some("secret_redacted:operator_mind:99"));
    assert!(definitions_for_kind(&f.kind).iter().any(|d| d.id == "secret_keeper"));
}

#[test]
fn spec_kept_fact_targets_spec_keeper() {
    let f = spec_kept_fact("op-1", "repo", "t-1");
    assert_eq!(f.kind, "spec_kept");
    assert_eq!(f.subject_type, SubjectKind::Operator);
    assert_eq!(f.repo.as_deref(), Some("repo"));
    assert_eq!(f.dedupe_key.as_deref(), Some("spec_kept:repo:t-1"));
    assert!(definitions_for_kind(&f.kind).iter().any(|d| d.id == "spec_keeper"));
}

#[test]
fn dormant_facts_target_their_definitions() {
    let d = task_delegated_fact("op-1", "t-1");
    assert_eq!(d.kind, "orchestrator_task_delegated");
    assert!(definitions_for_kind(&d.kind).iter().any(|x| x.id == "good_delegate"));
    let c = project_command_learned_fact("repo", "cargo test", BuildKind::Test);
    assert_eq!(c.kind, "project_command_learned");
    assert!(definitions_for_kind(&c.kind).iter().any(|x| x.id == "command_librarian"));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cargo test -p karl-score achievements::tests`
Expected: FAIL — `BuildKind`, `RiskyOutcome`, and the `*_fact` fns don't exist.

- [ ] **Step 3: Add enums + builders**

Add near the top of `crates/score/src/achievements.rs` (after the existing enums):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BuildKind {
    Build,
    Test,
    Lint,
}

impl BuildKind {
    fn passed_kind(self) -> &'static str {
        match self {
            BuildKind::Build => "build_command_passed",
            BuildKind::Test => "test_command_passed",
            BuildKind::Lint => "lint_command_passed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RiskyOutcome {
    Blocked,
    Confirmed,
    Rewritten,
}

impl RiskyOutcome {
    fn kind(self) -> &'static str {
        match self {
            RiskyOutcome::Blocked => "risky_action_blocked",
            RiskyOutcome::Confirmed => "risky_action_confirmed",
            RiskyOutcome::Rewritten => "risky_action_rewritten",
        }
    }
}

/// Stable short hash for dedupe keys (avoids unbounded key length).
fn short_hash(s: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

// ─── Pure fact builders ─────────────────────────────────────────────────────

pub fn task_verified_fact(operator: &str, repo: Option<&str>, task_id: &str) -> AchievementFact {
    let mut f = AchievementFact::new("task_verified", SubjectKind::Operator)
        .with_subject(operator)
        .with_task(task_id)
        .with_verification(VerificationLevel::UserAccepted)
        .with_dedupe(format!("task_verified:{task_id}"));
    if let Some(r) = repo {
        f = f.with_repo(r);
    }
    f
}

pub fn clean_run_fact(operator: &str, repo: Option<&str>, task_id: &str) -> AchievementFact {
    let mut f = AchievementFact::new("clean_run", SubjectKind::Operator)
        .with_subject(operator)
        .with_task(task_id)
        .with_verification(VerificationLevel::UserAccepted)
        .with_dedupe(format!("clean_run:{task_id}"));
    if let Some(r) = repo {
        f = f.with_repo(r);
    }
    f
}

pub fn task_recovered_fact(orchestrator: &str, task_id: &str) -> AchievementFact {
    AchievementFact::new("task_recovered", SubjectKind::Orchestrator)
        .with_subject(orchestrator)
        .with_task(task_id)
        .with_verification(VerificationLevel::CommandPassed)
        .with_dedupe(format!("task_recovered:{task_id}"))
}

pub fn build_pass_fact(kind: BuildKind, operator: &str, repo: &str, command: &str) -> AchievementFact {
    AchievementFact::new(kind.passed_kind(), SubjectKind::Operator)
        .with_subject(operator)
        .with_repo(repo)
        .with_verification(VerificationLevel::CommandPassed)
        .with_dedupe(format!("{}:{}:{}", kind.passed_kind(), repo, short_hash(command)))
}

pub fn risky_action_fact(outcome: RiskyOutcome, ts_ms: i64) -> AchievementFact {
    AchievementFact::new(outcome.kind(), SubjectKind::System)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("{}:{}", outcome.kind(), ts_ms))
}

pub fn secret_redacted_fact(site: &str, ts_ms: i64) -> AchievementFact {
    AchievementFact::new("secret_redacted", SubjectKind::System)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("secret_redacted:{site}:{ts_ms}"))
}

pub fn spec_kept_fact(operator: &str, repo: &str, task_id: &str) -> AchievementFact {
    AchievementFact::new("spec_kept", SubjectKind::Operator)
        .with_subject(operator)
        .with_repo(repo)
        .with_task(task_id)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("spec_kept:{repo}:{task_id}"))
}

pub fn task_delegated_fact(orchestrator: &str, task_id: &str) -> AchievementFact {
    AchievementFact::new("orchestrator_task_delegated", SubjectKind::Orchestrator)
        .with_subject(orchestrator)
        .with_task(task_id)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("orchestrator_task_delegated:{task_id}"))
}

pub fn project_command_learned_fact(repo: &str, command: &str, kind: BuildKind) -> AchievementFact {
    let _ = kind; // kind retained for future metadata; not part of the key
    AchievementFact::new("project_command_learned", SubjectKind::Project)
        .with_subject(repo)
        .with_repo(repo)
        .with_verification(VerificationLevel::SelfReport)
        .with_dedupe(format!("project_command_learned:{repo}:{}", short_hash(command)))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test -p karl-score achievements::tests`
Expected: PASS (all new tests green).

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/achievements.rs
git commit -m "feat(score): pure achievement fact builders for the 9 dormant emitters"
```

---

## Task 2: Public `record_*` wrappers in `score::lib`

**Files:**
- Modify: `crates/score/src/lib.rs`

- [ ] **Step 1: Write the failing test**

Add a test module at the bottom of `crates/score/src/lib.rs`:

```rust
#[cfg(test)]
mod emit_tests {
    use super::*;
    use std::sync::Arc;

    // The global recorder is process-wide; this test owns it for its duration.
    #[test]
    fn record_task_verified_awards_finisher() {
        let tmp = tempfile::tempdir().unwrap();
        let store = Arc::new(ScoreStore::open(tmp.path()).unwrap());
        set_recorder(store.clone());

        record_task_verified("op-abc", Some("repo"), "task-1");

        let awards = store.achievement_awards_recent(10).unwrap();
        assert!(
            awards.iter().any(|a| a.achievement_id == "finisher" && a.subject_id.as_deref() == Some("op-abc")),
            "expected a finisher award, got {awards:?}"
        );
        clear_recorder_for_test();
    }
}
```

(If `tempfile` is not already a dev-dependency of `karl_score`, add `tempfile = "3"` under `[dev-dependencies]` in `crates/score/Cargo.toml`. Check first: `rg tempfile crates/score/Cargo.toml`.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-score emit_tests`
Expected: FAIL — `record_task_verified` not found.

- [ ] **Step 3: Add the wrappers**

Add after `record_spec` in `crates/score/src/lib.rs` (re-export the enums for callers):

```rust
pub use achievements::{BuildKind, RiskyOutcome};

pub fn record_task_verified(operator: &str, repo: Option<&str>, task_id: &str) {
    let _ = record_achievement_fact(achievements::task_verified_fact(operator, repo, task_id));
}

pub fn record_clean_run(operator: &str, repo: Option<&str>, task_id: &str) {
    let _ = record_achievement_fact(achievements::clean_run_fact(operator, repo, task_id));
}

pub fn record_task_recovered(orchestrator: &str, task_id: &str) {
    let _ = record_achievement_fact(achievements::task_recovered_fact(orchestrator, task_id));
}

pub fn record_build_pass(kind: BuildKind, operator: &str, repo: &str, command: &str) {
    let _ = record_achievement_fact(achievements::build_pass_fact(kind, operator, repo, command));
}

pub fn record_risky_action(outcome: RiskyOutcome) {
    let ts = chrono::Utc::now().timestamp_millis();
    let _ = record_achievement_fact(achievements::risky_action_fact(outcome, ts));
}

pub fn record_secret_redacted(site: &str) {
    let ts = chrono::Utc::now().timestamp_millis();
    let _ = record_achievement_fact(achievements::secret_redacted_fact(site, ts));
}

pub fn record_spec_kept(operator: &str, repo: &str, task_id: &str) {
    let _ = record_achievement_fact(achievements::spec_kept_fact(operator, repo, task_id));
}

// Dormant — wired + tested, no production caller yet (good_delegate).
pub fn record_task_delegated(orchestrator: &str, task_id: &str) {
    let _ = record_achievement_fact(achievements::task_delegated_fact(orchestrator, task_id));
}

// Dormant — wired + tested, no production caller yet (command_librarian).
pub fn record_project_command_learned(repo: &str, command: &str, kind: BuildKind) {
    let _ = record_achievement_fact(achievements::project_command_learned_fact(repo, command, kind));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-score emit_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/lib.rs crates/score/Cargo.toml
git commit -m "feat(score): public record_* wrappers for achievement emitters (2 left dormant)"
```

---

## Task 3: Per-task flags in the task supervisor

**Files:**
- Modify: `crates/app/src/teammate/task_supervisor.rs`

- [ ] **Step 1: Write the failing tests**

Add to the `#[cfg(test)] mod tests` block in `task_supervisor.rs`:

```rust
#[test]
fn flags_track_failure_and_recovery() {
    let mut inner = Inner::new(Duration::from_secs(60));
    let (o, task) = (op(), TaskId::new());
    let s = SessionId::new();
    inner.register(s, ctx(o, task));
    let t = Instant::now();

    // clean so far
    let f0 = inner.flags(s).unwrap();
    assert!(!f0.saw_failed_block);
    assert!(!f0.ever_blocked);

    inner.observe_block_finished(s, "cargo test", Some(1), t); // fail -> blocked
    let f1 = inner.flags(s).unwrap();
    assert!(f1.saw_failed_block);
    assert!(f1.ever_blocked);

    inner.observe_block_finished(s, "cargo test", Some(0), t); // recover
    let f2 = inner.flags(s).unwrap();
    assert!(f2.saw_failed_block, "failure flag is sticky for the task lifetime");
    assert!(f2.ever_blocked, "ever_blocked is sticky");
}

#[test]
fn flags_clean_when_no_failures() {
    let mut inner = Inner::new(Duration::from_secs(60));
    let (o, task) = (op(), TaskId::new());
    let s = SessionId::new();
    inner.register(s, ctx(o, task));
    inner.observe_block_finished(s, "ls", Some(0), Instant::now());
    let f = inner.flags(s).unwrap();
    assert!(!f.saw_failed_block);
    assert!(!f.ever_blocked);
}

#[test]
fn flags_none_for_unknown_session() {
    let inner = Inner::new(Duration::from_secs(60));
    assert!(inner.flags(SessionId::new()).is_none());
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p covenant task_supervisor::tests::flags`
Expected: FAIL — no `flags` method, no `saw_failed_block`/`ever_blocked` fields.
(Note: the app package is `covenant` and its lib target is `covenant_lib`. `cargo test -p covenant <filter>` runs the lib tests. Confirmed against `crates/app/Cargo.toml`.)

- [ ] **Step 3: Add fields, populate them, expose `flags`**

In `TaskCtx` (after `last_failed_cmd`):

```rust
    /// True once any block in this task exited non-zero. Sticky for the
    /// task lifetime. Drives `clean_run`.
    pub saw_failed_block: bool,
    /// True once this task entered Blocked at least once. Sticky. Drives
    /// `recovery_artist` (recovered-then-completed).
    pub ever_blocked: bool,
```

In `register_task` and the test `ctx()` helper, initialise both to `false`.

In `observe_block_finished`, at the very top after `let ctx = self.by_session.get_mut(&session)?;`:

```rust
    let nonzero = matches!(exit_code, Some(c) if c != 0);
    if nonzero {
        ctx.saw_failed_block = true;
    }
```

(Replace the existing `let nonzero = ...` line — don't duplicate it.) Then where the status transitions to `Blocked` (the `ctx.status = TaskStatus::Blocked;` line), add right after it:

```rust
                ctx.ever_blocked = true;
```

Add the `TaskFlags` type and accessor:

```rust
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskFlags {
    pub saw_failed_block: bool,
    pub ever_blocked: bool,
}

impl Inner {
    pub fn flags(&self, session: SessionId) -> Option<TaskFlags> {
        self.by_session.get(&session).map(|c| TaskFlags {
            saw_failed_block: c.saw_failed_block,
            ever_blocked: c.ever_blocked,
        })
    }
}

impl TaskSupervisor {
    /// Read the accumulated per-task flags for `session`, if still tracked.
    /// Call before `forget_task`.
    pub fn task_flags(&self, session: SessionId) -> Option<TaskFlags> {
        self.inner.lock().flags(session)
    }
}
```

Update the test `ctx()` helper to set both new fields to `false`.

- [ ] **Step 4: Run to verify pass**

Run: `cargo test -p covenant task_supervisor::tests`
Expected: PASS (new + existing supervisor tests green).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/task_supervisor.rs
git commit -m "feat(teammate): track per-task saw_failed_block/ever_blocked flags"
```

---

## Task 4: build_steward — classify + emit on passing build/test/lint

**Files:**
- Create: `crates/app/src/teammate/build_classify.rs`
- Modify: `crates/app/src/teammate/mod.rs`, `crates/app/src/teammate/task_supervisor.rs`

- [ ] **Step 1: Write the failing test (classifier)**

Create `crates/app/src/teammate/build_classify.rs`:

```rust
//! Pure classification of a shell command into a build/test/lint kind, for
//! the `build_steward` achievement. Pattern-based; there is no authoritative
//! command registry.

use karl_score::BuildKind;

/// Returns the build kind a command represents, or None if it is not a
/// recognised build/test/lint invocation.
pub fn classify_command(cmd: &str) -> Option<BuildKind> {
    let c = cmd.trim().to_ascii_lowercase();
    // Lint first: `cargo clippy` must not be caught by the `cargo` build arm.
    if c.contains("clippy") || c.contains("eslint") || c.contains("ruff")
        || c.contains("npm run lint") || c.contains("yarn lint")
    {
        return Some(BuildKind::Lint);
    }
    if c.contains("cargo test") || c.contains("npm test") || c.contains("npm run test")
        || c.contains("pytest") || c.contains("go test") || c.contains("make test")
        || c.contains("yarn test")
    {
        return Some(BuildKind::Test);
    }
    if c.contains("cargo build") || c.contains("npm run build") || c.contains("make build")
        || c.contains("go build") || c.contains("cargo check") || c.contains("yarn build")
    {
        return Some(BuildKind::Build);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_each_kind() {
        assert_eq!(classify_command("cargo build --release"), Some(BuildKind::Build));
        assert_eq!(classify_command("cargo test -p foo"), Some(BuildKind::Test));
        assert_eq!(classify_command("cargo clippy --all"), Some(BuildKind::Lint));
        assert_eq!(classify_command("npm run lint"), Some(BuildKind::Lint));
        assert_eq!(classify_command("pytest -q"), Some(BuildKind::Test));
    }

    #[test]
    fn ignores_unrelated_commands() {
        assert_eq!(classify_command("ls -la"), None);
        assert_eq!(classify_command("git status"), None);
        assert_eq!(classify_command("echo cargo build is great"), Some(BuildKind::Build)); // documented over-match
    }
}
```

Register the module in `crates/app/src/teammate/mod.rs`:

```rust
pub mod build_classify;
```

- [ ] **Step 2: Run to verify pass (classifier is self-contained)**

Run: `cargo test -p covenant build_classify`
Expected: PASS. (This step writes test+impl together because the classifier is pure and small; the emit wiring in Step 3 is exercised manually/in-app since it needs the live bus.)

- [ ] **Step 3: Emit in the supervisor bus loop**

In `crates/app/src/teammate/task_supervisor.rs`, in `run_bus`, the `BlockFinished` arm currently destructures `{ session, command, exit_code, .. }`. Add `cwd` to the pattern and emit after the existing decision handling:

```rust
                Ok(karl_session::SessionEvent::BlockFinished {
                    session, command, exit_code, cwd, ..
                }) => {
                    let decision = {
                        let mut g = self.inner.lock();
                        g.observe_block_finished(session, &command, exit_code, Instant::now())
                    };
                    // build_steward: a passing build/test/lint attributable to
                    // the task's operator. Resolve operator from the tracked
                    // TaskCtx; skip if the session isn't a tracked task.
                    if matches!(exit_code, Some(0)) {
                        if let Some(kind) = crate::teammate::build_classify::classify_command(&command) {
                            let op = { self.inner.lock().operator_for(session) };
                            if let Some(op) = op {
                                if let Some(repo) = karl_score::context::repo_name_for_cwd(&cwd) {
                                    karl_score::record_build_pass(kind, &op.to_string(), &repo, &command);
                                }
                            }
                        }
                    }
                    if let Some((ctx, d)) = decision {
                        self.apply_decision(ctx, d).await;
                    }
                }
```

Add `operator_for` to `Inner`:

```rust
    pub fn operator_for(&self, session: SessionId) -> Option<OperatorId> {
        self.by_session.get(&session).map(|c| c.operator_id)
    }
```

**Repo resolution:** `karl_score::context::repo_name_for_cwd(cwd) -> Option<String>` already exists at `crates/score/src/context.rs:117` but is `pub(crate)`. Change its visibility to `pub`:

```rust
// crates/score/src/context.rs:117 — was `pub(crate) fn`
pub fn repo_name_for_cwd(cwd: &Path) -> Option<String> {
```

`context` is already `pub mod context;` in `lib.rs:5`, so `karl_score::context::repo_name_for_cwd` resolves once the fn is `pub`. No new helper needed.

- [ ] **Step 4: Build to verify it compiles**

Run: `cargo build -p covenant`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/build_classify.rs crates/app/src/teammate/mod.rs crates/app/src/teammate/task_supervisor.rs crates/score/src/context.rs crates/score/src/lib.rs
git commit -m "feat(achievements): emit build_steward on passing build/test/lint per task"
```

---

## Task 5: Completion emits — finisher, clean_run, recovery_artist

**Files:**
- Modify: `crates/app/src/teammate/commands.rs`

- [ ] **Step 1: Write the failing test (pure plan fn)**

Add to (or create) the `#[cfg(test)] mod tests` block in `crates/app/src/teammate/commands.rs`:

```rust
#[test]
fn completion_plan_emits_finisher_always_and_gates_others() {
    use crate::teammate::task_supervisor::TaskFlags;
    use super::{plan_completion_emits, CompletionFact};

    // clean, never blocked -> finisher + clean_run
    let p = plan_completion_emits(TaskFlags { saw_failed_block: false, ever_blocked: false });
    assert!(p.contains(&CompletionFact::Finisher));
    assert!(p.contains(&CompletionFact::CleanRun));
    assert!(!p.contains(&CompletionFact::Recovered));

    // had a failure, was blocked, recovered -> finisher + recovered, NO clean_run
    let p = plan_completion_emits(TaskFlags { saw_failed_block: true, ever_blocked: true });
    assert!(p.contains(&CompletionFact::Finisher));
    assert!(!p.contains(&CompletionFact::CleanRun));
    assert!(p.contains(&CompletionFact::Recovered));
}
```

- [ ] **Step 2: Run to verify failure**

Run: `cargo test -p covenant completion_plan_emits`
Expected: FAIL — `plan_completion_emits`/`CompletionFact` not defined.

- [ ] **Step 3: Add the pure plan fn + wire it into `teammate_complete_task`**

Add near `complete_task_inner` in `commands.rs`:

```rust
/// Which completion-gated achievement facts a finished task should emit,
/// given the supervisor's accumulated per-task flags. Pure + testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CompletionFact {
    Finisher,
    CleanRun,
    Recovered,
}

pub(crate) fn plan_completion_emits(
    flags: crate::teammate::task_supervisor::TaskFlags,
) -> Vec<CompletionFact> {
    let mut out = vec![CompletionFact::Finisher]; // verified completion always counts
    if !flags.saw_failed_block {
        out.push(CompletionFact::CleanRun);
    }
    if flags.ever_blocked {
        out.push(CompletionFact::Recovered);
    }
    out
}
```

In `teammate_complete_task` (the `#[tauri::command]` at line ~626), emit **before** `supervisor.forget_task(s)`:

```rust
    let (task, msg) =
        complete_task_inner(storage.inner(), runtime.inner(), task_id, now_unix_ms()).await?;
    if let Some(s) = task.spawned_session {
        // Achievement emits: read flags while the task is still tracked.
        let flags = supervisor.task_flags(s).unwrap_or_default();
        let operator = task.operator_id.to_string();
        let repo = karl_score::current_context().repo;
        for fact in plan_completion_emits(flags) {
            match fact {
                CompletionFact::Finisher =>
                    karl_score::record_task_verified(&operator, repo.as_deref(), &task_id.to_string()),
                CompletionFact::CleanRun =>
                    karl_score::record_clean_run(&operator, repo.as_deref(), &task_id.to_string()),
                CompletionFact::Recovered =>
                    karl_score::record_task_recovered(&operator, &task_id.to_string()),
            }
        }
        supervisor.forget_task(s);
        state.operator.disable_for_session(&app, s, "task_completed").await;
    }
    let _ = app.emit("teammate-task", &task);
    let _ = app.emit("teammate-message", &msg);
    Ok(())
```

(If `TaskFlags` does not derive `Default`, it does per Task 3 — `unwrap_or_default()` yields all-false, i.e. treat an untracked completed task as a clean finish.)

- [ ] **Step 4: Run to verify pass + build**

Run: `cargo test -p covenant completion_plan_emits && cargo build -p covenant`
Expected: test PASS, clean build.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/commands.rs
git commit -m "feat(achievements): emit finisher/clean_run/recovery_artist on task completion"
```

---

## Task 6: guardian — emit when the safety blocklist stops an action

**Files:**
- Modify: `crates/app/src/operator.rs`, `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Add the emit at the operator block site**

In `crates/app/src/operator.rs` around line 2980, the block site is:

```rust
                    if let Some(reason) = safety::is_dangerous(&text, &deny_extra_regexes) {
```

Inside that `if let` body (after the existing handling that refuses/blocks the command), add:

```rust
                        karl_score::record_risky_action(karl_score::RiskyOutcome::Blocked);
```

- [ ] **Step 2: Add the emit at the rc_agent block site**

In `crates/app/src/rc_agent.rs` around line 432:

```rust
    let danger = crate::safety::is_dangerous(data, &[]);
```

Where `danger` is `Some(...)` and the action is consequently refused, add in that branch:

```rust
        karl_score::record_risky_action(karl_score::RiskyOutcome::Blocked);
```

- [ ] **Step 3: Build**

Run: `cargo build -p covenant`
Expected: clean build.

- [ ] **Step 4: Sanity test the fact path (reuses Task 1 coverage)**

Run: `cargo test -p karl-score achievements::tests::risky_action_facts_map_to_guardian`
Expected: PASS (confirms the kind→guardian mapping the emit relies on).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs crates/app/src/rc_agent.rs
git commit -m "feat(achievements): emit guardian when the safety blocklist blocks an action"
```

---

## Task 7: secret_keeper — emit when masking redacts something

**Files:**
- Modify: `crates/app/src/operator.rs`

- [ ] **Step 1: Detect a redaction at the mind flush + emit**

In `crates/app/src/operator.rs` around line 3482 the flush loop runs:

```rust
    for (id, mut m) in to_flush {
        crate::operator_mind::mask_in_place(&mut m, |s| crate::safety::mask_secrets(s));
```

Replace the `mask_in_place` call with a version that records whether any field changed, then emit once per flush if so:

```rust
    for (id, mut m) in to_flush {
        let mut redacted = false;
        crate::operator_mind::mask_in_place(&mut m, |s| {
            let out = crate::safety::mask_secrets(s);
            if out != s {
                redacted = true;
            }
            out
        });
        if redacted {
            karl_score::record_secret_redacted("operator_mind");
        }
```

(Leave the rest of the loop body — `storage.mind_save(...)` etc. — unchanged.)

- [ ] **Step 2: Build**

Run: `cargo build -p covenant`
Expected: clean build.

- [ ] **Step 3: Sanity test the fact path**

Run: `cargo test -p karl-score achievements::tests::secret_redacted_fact_targets_secret_keeper`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(achievements): emit secret_keeper when operator-mind masking redacts a secret"
```

---

## Task 8: spec_keeper — per-session spec-before-edit tracker

**Files:**
- Create: `crates/app/src/teammate/spec_edit_tracker.rs`
- Modify: `crates/app/src/teammate/mod.rs`, `crates/app/src/notch.rs`, `crates/app/src/teammate/commands.rs`, `crates/app/src/lib.rs`

- [ ] **Step 1: Write the failing tests (state machine)**

Create `crates/app/src/teammate/spec_edit_tracker.rs`:

```rust
//! Per-session tracker for the `spec_keeper` achievement: did the executor
//! read or create a spec BEFORE its first non-spec code edit, within a task?
//!
//! Fed from `NotchHub::set_phase` (every ExecutorPhase carries the file it
//! targets). Queried at task completion.

use std::collections::HashMap;

use karl_session::{ExecutorPhase, SessionId};
use parking_lot::Mutex;

#[derive(Clone, Copy, Debug, Default)]
struct State {
    saw_spec: bool,
    saw_code_edit: bool,
    satisfied: bool,
}

#[derive(Default)]
pub struct SpecEditTracker {
    by_session: Mutex<HashMap<SessionId, State>>,
}

/// A spec path is anything under a `specs/` directory (matches the spec
/// watcher convention) or a superpowers spec doc.
fn is_spec_file(path: &str) -> bool {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    p.contains("/specs/") || p.contains("/docs/superpowers/")
}

impl SpecEditTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Observe a phase transition for `session`. Latches `satisfied` the
    /// first time a code edit happens, recording whether a spec was seen
    /// before it.
    pub fn note_phase(&self, session: SessionId, phase: &ExecutorPhase) {
        let mut g = self.by_session.lock();
        let st = g.entry(session).or_default();
        match phase {
            ExecutorPhase::Reading { file } | ExecutorPhase::Writing { file }
                if is_spec_file(file) =>
            {
                if !st.saw_code_edit {
                    st.saw_spec = true;
                }
            }
            ExecutorPhase::Writing { file } if !is_spec_file(file) => {
                if !st.saw_code_edit {
                    st.saw_code_edit = true;
                    st.satisfied = st.saw_spec;
                }
            }
            _ => {}
        }
    }

    /// Did this session read/create a spec before its first code edit?
    pub fn satisfied(&self, session: SessionId) -> bool {
        self.by_session.lock().get(&session).map(|s| s.satisfied).unwrap_or(false)
    }

    pub fn forget(&self, session: SessionId) {
        self.by_session.lock().remove(&session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(f: &str) -> ExecutorPhase { ExecutorPhase::Reading { file: f.into() } }
    fn writing(f: &str) -> ExecutorPhase { ExecutorPhase::Writing { file: f.into() } }

    #[test]
    fn spec_read_before_edit_is_satisfied() {
        let t = SpecEditTracker::new();
        let s = SessionId::new();
        t.note_phase(s, &reading("/repo/specs/feature.md"));
        t.note_phase(s, &writing("/repo/src/main.rs"));
        assert!(t.satisfied(s));
    }

    #[test]
    fn edit_before_spec_is_not_satisfied() {
        let t = SpecEditTracker::new();
        let s = SessionId::new();
        t.note_phase(s, &writing("/repo/src/main.rs"));
        t.note_phase(s, &reading("/repo/specs/feature.md"));
        assert!(!t.satisfied(s));
    }

    #[test]
    fn creating_a_spec_counts_as_spec_activity() {
        let t = SpecEditTracker::new();
        let s = SessionId::new();
        t.note_phase(s, &writing("/repo/specs/new.md")); // creating a spec
        t.note_phase(s, &writing("/repo/src/lib.rs"));
        assert!(t.satisfied(s));
    }

    #[test]
    fn no_activity_is_not_satisfied() {
        let t = SpecEditTracker::new();
        assert!(!t.satisfied(SessionId::new()));
    }
}
```

Register in `crates/app/src/teammate/mod.rs`:

```rust
pub mod spec_edit_tracker;
```

- [ ] **Step 2: Run to verify pass (state machine is self-contained)**

Run: `cargo test -p covenant spec_edit_tracker`
Expected: PASS.

- [ ] **Step 3: Manage the tracker + feed it from `set_phase`**

In `crates/app/src/lib.rs` near where the supervisor is created and managed (`app.manage(supervisor);`, ~line 3340), construct and manage the tracker:

```rust
            let spec_edit_tracker =
                std::sync::Arc::new(crate::teammate::spec_edit_tracker::SpecEditTracker::new());
            app.manage(spec_edit_tracker.clone());
```

Give `NotchHub` access to it. Find how `NotchHub` is constructed in `lib.rs` (`rg -n "NotchHub::new|NotchHub {" crates/app/src/lib.rs crates/app/src/notch.rs`) and pass an `Arc<SpecEditTracker>` into it (add a field). Then in `NotchHub::set_phase` (`crates/app/src/notch.rs:180`), at the top of the method body:

```rust
    pub async fn set_phase(&self, session: SessionId, phase: karl_session::ExecutorPhase) {
        self.spec_edit_tracker.note_phase(session, &phase);
        // ... existing body unchanged ...
```

(If threading the tracker through `NotchHub` is awkward, the equivalent alternative is a process-global `OnceCell<Arc<SpecEditTracker>>` in `spec_edit_tracker.rs` with a `global()` accessor, set during setup and read in `set_phase`. Prefer the field; fall back to the global only if construction order forbids it — and note which you chose in the commit message.)

- [ ] **Step 4: Emit at completion + forget on cleanup**

In `crates/app/src/teammate/commands.rs` `teammate_complete_task`, add the tracker to the command's state and emit spec_kept inside the `if let Some(s) = task.spawned_session` block (alongside the Task 5 emits, before `forget_task`):

```rust
    supervisor: State<'_, Arc<crate::teammate::task_supervisor::TaskSupervisor>>,
    spec_tracker: State<'_, Arc<crate::teammate::spec_edit_tracker::SpecEditTracker>>,
```

```rust
        // spec_keeper: spec read/created before first code edit, this task.
        if spec_tracker.satisfied(s) {
            if let Some(repo) = repo.as_deref() {
                karl_score::record_spec_kept(&operator, repo, &task_id.to_string());
            }
        }
        spec_tracker.forget(s);
```

Also call `spec_tracker.forget(s)` in `teammate_cancel_active_task` (mirror the `supervisor.forget_task(s)` call) so cancelled tasks don't leak tracker state — add the same `spec_tracker: State<...>` param there.

- [ ] **Step 5: Build + run all new tests**

Run: `cargo build -p covenant && cargo test -p covenant spec_edit_tracker`
Expected: clean build, tests PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/teammate/spec_edit_tracker.rs crates/app/src/teammate/mod.rs crates/app/src/notch.rs crates/app/src/teammate/commands.rs crates/app/src/lib.rs
git commit -m "feat(achievements): emit spec_keeper via per-session spec-before-edit tracker"
```

---

## Task 9: Full-suite verification

- [ ] **Step 1: Run the score + teammate suites**

Run: `cargo test -p karl-score && cargo test -p covenant teammate`
Expected: PASS. (Per the test-gotchas memory: avoid a broad bare `cargo test` that sweeps telegram long-poll tests; scope by crate/filter. macOS has no `timeout`.)

- [ ] **Step 2: Workspace build**

Run: `cargo build`
Expected: clean.

- [ ] **Step 3: Commit any test-only fixups** (if needed)

```bash
git add -A && git commit -m "test(achievements): suite fixups after emitter wiring"
```

---

## Notes / risks

- **good_delegate, command_librarian** are intentionally dormant — `record_task_delegated` / `record_project_command_learned` exist + are tested but have no production caller. Wiring them needs a delegation mechanic and a project-command registry respectively (out of scope).
- **spec_keeper** depends on `ExecutorPhase::{Reading,Writing}` carrying accurate file paths (confirmed at `crates/session/src/lib.rs` — `Writing { file: String }`, `Reading { file: String }`). Executors that don't surface per-file phases won't earn it; that's acceptable and honest.
- **build_steward / spec_keeper repo** comes from `current_context()` at completion or the block cwd in the bus loop; if no git repo is resolvable, the repo-scoped emit is skipped (same policy as the existing cartographer emit).
- **Subagent isolation:** per project conventions, execute each task in a git worktree; parallel subagents need separate worktrees.
- **Crate names for `-p`:** score package is `karl-score` (crate import `karl_score`); app package is `covenant` (lib target `covenant_lib`). Use `-p karl-score` / `-p covenant`.
- **Task 4 repo helper:** `karl_score::context::repo_name_for_cwd` already exists but is `pub(crate)` (`crates/score/src/context.rs:117`) — change it to `pub` rather than adding a new one.
