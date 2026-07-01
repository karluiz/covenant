# Operator Autonomous Task Completion — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator autonomously mark a Task `Done` when its interactive executor (e.g. `claude`) has finished the work — reading the executor's screen, optionally asking it directly, then auto-completing.

**Architecture:** Add a 4th `OperatorAction::Complete { rationale }` verb to the existing AOM tick loop (`crates/app/src/operator.rs`). The loop already re-engages at-rest executors every 45s, reads their screen, and can type into their PTY (`Reply`). We stash the active task's identity on the per-session `Attached` state at attach time, expose it in the decision, document a `COMPLETE` action in a task-only prompt block, and on `Complete` call the existing `complete_task_inner` (mark Done + release runtime) and emit the UI events.

**Tech Stack:** Rust, Tokio, Tauri 2, existing teammate task subsystem (`crates/app/src/teammate/`).

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]` / `main()` (project convention).
- Errors: `thiserror` in libs, `anyhow` at bin boundary; here use `Result<_, String>` to match surrounding operator/teammate code.
- Conventional Commits; one feature-relevant change per commit.
- Do NOT modify the `OUTPUT_FORMAT` const (`operator.rs:272`) — the COMPLETE verb is documented only in the conditional task block to preserve prompt-cache stability and to gate it to task sessions.
- All agent-driven edits run in a git worktree (see Execution Handoff).
- `complete_task_inner` signature (reuse, do not reimplement): `pub(crate) async fn complete_task_inner(storage: &Arc<Storage>, runtime: &Arc<TeammateRuntime>, task_id: TaskId, now_ms: u64) -> Result<(Task, TaskMessage), String>` (`crates/app/src/teammate/commands.rs:693`).

---

### Task 1: Add the `Complete` action variant and satisfy all exhaustive matches

**Files:**
- Modify: `crates/app/src/operator.rs` (enum `OperatorAction` ~313, `kind()` ~327, `parse_response` ~4666/4688, execution matches ~3099 and ~3212, `action_for_record` ~3487, `xp_amount` ~3336)
- Test: `crates/app/src/operator.rs` (existing `#[cfg(test)] mod tests`)

**Interfaces:**
- Produces: `OperatorAction::Complete { rationale: String }`; `OperatorAction::kind()` returns `"complete"` for it; `parse_response` maps an `ACTION: COMPLETE` block to it.

- [ ] **Step 1: Write the failing test**

Add to the operator tests module (near the other `parse_response` tests):

```rust
#[test]
fn parse_response_parses_complete() {
    let resp = "ACTION: COMPLETE\nRATIONALE: executor printed Done and the deliverable exists";
    let action = parse_response(resp, None).expect("should parse");
    match action {
        OperatorAction::Complete { rationale } => {
            assert!(rationale.contains("deliverable"));
        }
        other => panic!("expected Complete, got {:?}", other.kind()),
    }
    assert_eq!(
        OperatorAction::Complete { rationale: "x".into() }.kind(),
        "complete"
    );
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant --lib operator::tests::parse_response_parses_complete 2>&1 | tail -20`
Expected: FAIL — compile error (`no variant Complete`) or `expected Complete`.

- [ ] **Step 3: Add the variant + `kind()` arm**

In `operator.rs:313` enum, after `Wait`:

```rust
    Wait {
        rationale: String,
    },
    /// Mark the active teammate task Done. Only offered to sessions that
    /// have an attached task; a no-op if none is stashed.
    Complete {
        rationale: String,
    },
}
```

In `kind()` (`operator.rs:327`), add the arm:

```rust
            OperatorAction::Wait { .. } => "wait",
            OperatorAction::Complete { .. } => "complete",
```

- [ ] **Step 4: Add the `parse_response` arm**

In `parse_response` (`operator.rs:4688`), add before the `_ => None` arm (the `rationale` local is already in scope):

```rust
        "COMPLETE" => Some(OperatorAction::Complete {
            rationale: rationale.unwrap_or_default(),
        }),
```

- [ ] **Step 5: Satisfy the exhaustive execution matches (LIVE ~3099 and DRY-RUN ~3212)**

Both matches build the 6-tuple `(OperatorAction, bool, String, Option<String>, Option<String>, Option<String>)` = `(final_action, executed, action_str, reply_text, rationale, escalation_msg)`. For now (Task 4 fills the real side effect) add an identical arm to BOTH matches that produces a no-side-effect tuple:

```rust
                OperatorAction::Complete { rationale } => (
                    OperatorAction::Complete { rationale: rationale.clone() },
                    false,
                    "complete".to_string(),
                    None,
                    Some(rationale),
                    None,
                ),
```

- [ ] **Step 6: Satisfy `action_for_record` (~3487)**

Add the arm mapping to the existing `TurnAction::Ignore` (Complete is an end-state, not a reply/escalation the mind should replay):

```rust
        OperatorAction::Complete { .. } => crate::operator_mind::TurnAction::Ignore,
```

- [ ] **Step 7: (optional) XP arm (~3336, string match)**

`xp_amount` matches `action_str` (a `String`); the `_ => 0` arm already covers `"complete"`. Add a case only if a completed task should earn XP — leave as-is for now (0 XP). No change required.

- [ ] **Step 8: Run test to verify it passes + compiles**

Run: `cargo test -p covenant --lib operator::tests::parse_response_parses_complete 2>&1 | tail -20`
Expected: PASS. (If other exhaustive matches were missed, the compiler names them — add the same `Complete => ... Ignore`/tuple arm.)

- [ ] **Step 9: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): add Complete action variant + parser"
```

---

### Task 2: Stash the active task's identity on the per-session state

**Files:**
- Modify: `crates/app/src/operator.rs` (`Attached` struct ~517/559; attach initializer ~836; `set_task_archetype` ~1120; candidate snapshot tuple decl ~1918-1928, fill ~1987, destructure ~2043)
- Modify: `crates/app/src/teammate/commands.rs` (the `set_task_archetype` call site in `teammate_attach_session_to_task` ~1053)
- Test: `crates/app/src/operator.rs` tests module

**Interfaces:**
- Produces: `struct TaskIdent { pub id: crate::teammate::TaskId, pub title: String, pub deliverable: String }`; `OperatorWatcher::set_task_context(&self, session_id, archetype, ident: TaskIdent)`; a `task_ident: Option<TaskIdent>` local available in `run_tick` at the decision site.
- Consumes: Task 1's variant (indirectly, later tasks).

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn set_task_context_stashes_ident() {
    let w = OperatorWatcher::new_for_test(); // if no such ctor exists, see Step 3 note
    let sid = SessionId::new();
    w.attach_for_test(sid).await; // ensure an Attached exists
    let tid = crate::teammate::TaskId::new();
    w.set_task_context(
        sid,
        crate::teammate::types::TaskArchetype::Do,
        TaskIdent { id: tid, title: "Fix Windows".into(), deliverable: "app starts".into() },
    )
    .await;
    let inner = w.inner.lock().await;
    let att = inner.sessions.get(&sid).expect("attached");
    let ident = att.task_ident.as_ref().expect("ident set");
    assert_eq!(ident.title, "Fix Windows");
    assert_eq!(att.task_archetype, Some(crate::teammate::types::TaskArchetype::Do));
}
```

Note: if `new_for_test`/`attach_for_test` helpers don't exist, prefer testing `Attached`/`TaskIdent` construction directly, or add minimal `#[cfg(test)]` helpers. Do not add production-only test scaffolding beyond what the test needs.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant --lib operator::tests::set_task_context_stashes_ident 2>&1 | tail -20`
Expected: FAIL — `TaskIdent` / `set_task_context` / `task_ident` unknown.

- [ ] **Step 3: Add `TaskIdent` + field on `Attached`**

Near the top of `operator.rs` (with the other small structs), add:

```rust
/// Identity of the teammate Task a session is executing, when spawned by one.
/// Stashed at attach time so the tick loop can offer/perform `Complete`
/// without a session→task storage lookup (which doesn't exist).
#[derive(Clone, Debug)]
pub struct TaskIdent {
    pub id: crate::teammate::TaskId,
    pub title: String,
    pub deliverable: String,
}
```

In `struct Attached` (`operator.rs:517`), right after the `task_archetype` field (`operator.rs:559`):

```rust
    task_archetype: Option<crate::teammate::types::TaskArchetype>,
    /// Full task identity for the attached task, when known. Set alongside
    /// `task_archetype`. Enables the operator's `Complete` action.
    task_ident: Option<TaskIdent>,
```

In the attach initializer (`operator.rs:836`, where `task_archetype: None,` is set):

```rust
                task_archetype: None,
                task_ident: None,
```

- [ ] **Step 4: Extend the setter**

Replace `set_task_archetype` (`operator.rs:1120`) with a context setter that stores both (keep the name or rename — if renamed, update the caller in Step 5):

```rust
    pub async fn set_task_context(
        &self,
        session_id: SessionId,
        archetype: crate::teammate::types::TaskArchetype,
        ident: TaskIdent,
    ) {
        let mut inner = self.inner.lock().await;
        if let Some(att) = inner.sessions.get_mut(&session_id) {
            att.task_archetype = Some(archetype);
            att.task_ident = Some(ident);
            tracing::debug!(session = %session_id, task = %ident.id.0, "task context set");
        }
    }
```

- [ ] **Step 5: Update the call site in `teammate_attach_session_to_task`**

In `crates/app/src/teammate/commands.rs` at the `set_task_archetype` call (~1053), the full `Task` (`existing`, loaded via `teammate_get_task`) is in scope. Replace the call:

```rust
    state.operator.set_task_context(
        session,
        existing.archetype,
        crate::operator::TaskIdent {
            id: existing.id,
            title: existing.title.clone(),
            deliverable: existing.deliverable.clone(),
        },
    )
    .await;
```

(Confirm the local variable name of the loaded task at commands.rs:1051 — it is `existing` per the attach handler; adjust if different.)

- [ ] **Step 6: Thread `task_ident` through the candidate snapshot into `run_tick`**

`task_archetype` is already carried from the per-session state into the decision via the candidates vector. Mirror it exactly:
- Snapshot tuple type declaration (`operator.rs:1918-1928`): add `Option<TaskIdent>` in the same position group as the archetype.
- Fill site (`operator.rs:1987`, `att.task_archetype`): add `att.task_ident.clone()`.
- Destructure site (`operator.rs:2043`, `task_archetype,`): add `task_ident,`.

This makes `task_ident: Option<TaskIdent>` a local in the decision scope (same scope as `task_archetype`).

- [ ] **Step 7: Run test + build**

Run: `cargo test -p covenant --lib operator::tests::set_task_context_stashes_ident 2>&1 | tail -20`
Expected: PASS, and `cargo check -p covenant --lib` clean.

- [ ] **Step 8: Commit**

```bash
git add crates/app/src/operator.rs crates/app/src/teammate/commands.rs
git commit -m "feat(operator): stash active task identity on session state"
```

---

### Task 3: Prompt — task block that describes the deliverable and the COMPLETE verb

**Files:**
- Modify: `crates/app/src/operator.rs` (`build_system_prompt` ~3860; its call site ~2366; prompt `format!` ~3923-3947)
- Test: `crates/app/src/operator.rs` tests module

**Interfaces:**
- Consumes: `task_ident` local from Task 2 (at the call site).
- Produces: `build_system_prompt(..., task: Option<&TaskIdent>)` renders a task block containing the title, deliverable, and the `ACTION: COMPLETE` instructions when `task.is_some()`; empty otherwise.

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn system_prompt_offers_complete_only_with_task() {
    let ident = TaskIdent {
        id: crate::teammate::TaskId::new(),
        title: "Fix Windows startup".into(),
        deliverable: "app launches on Windows".into(),
    };
    let with = build_system_prompt(
        "persona", true, None, &[], "", false,
        crate::operator_registry::VoiceTone::Terse, 0.6, Some(crate::teammate::types::TaskArchetype::Do),
        Some(&ident),
    );
    assert!(with.contains("Fix Windows startup"));
    assert!(with.contains("ACTION: COMPLETE"));

    let without = build_system_prompt(
        "persona", true, None, &[], "", false,
        crate::operator_registry::VoiceTone::Terse, 0.6, None, None,
    );
    assert!(!without.contains("ACTION: COMPLETE"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant --lib operator::tests::system_prompt_offers_complete_only_with_task 2>&1 | tail -20`
Expected: FAIL — arity mismatch (`build_system_prompt` has no `task` param).

- [ ] **Step 3: Add the `task` parameter + task block**

Extend `build_system_prompt` (`operator.rs:3860`) signature with a final param:

```rust
    task_archetype: Option<crate::teammate::types::TaskArchetype>,
    task: Option<&TaskIdent>,
) -> String
```

Build the block near where `review_block` is built (`operator.rs:3915`):

```rust
    let task_block = match task {
        Some(t) => format!(
            "# Active task\n\
             This terminal tab is executing a task you dispatched:\n\
             - Title: {title}\n\
             - Deliverable: {deliverable}\n\
             \n\
             When the executor has clearly FINISHED this deliverable (its \
             screen shows completion and it is idle at a prompt), emit:\n\
             \n\
             ACTION: COMPLETE\n\
             RATIONALE: <one sentence on why it's done>\n\
             \n\
             If you are NOT sure it's done, use ACTION: REPLY to ask the \
             executor directly (e.g. \"Have you finished the task? Reply DONE, \
             or tell me what's left.\") and decide on the next check — or \
             ACTION: WAIT. NEVER emit COMPLETE on ambiguity.\n\n",
            title = t.title,
            deliverable = t.deliverable,
        ),
        None => String::new(),
    };
```

Insert `{task_block}` into the prompt `format!` (`operator.rs:3923`) adjacent to `{review_block}`, and add `task_block = task_block,` to the format args.

- [ ] **Step 4: Update the call site**

At `operator.rs:2366` (the `build_system_prompt(...)` call), pass the new arg after `task_archetype`:

```rust
            task_archetype,
            task_ident.as_ref(),
        );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test -p covenant --lib operator::tests::system_prompt_offers_complete_only_with_task 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): task-scoped prompt block + COMPLETE instructions"
```

---

### Task 4: Perform the completion in the LIVE execution arm

**Files:**
- Modify: `crates/app/src/operator.rs` (LIVE execution match `Complete` arm ~3099; the arm currently added in Task 1 as a no-op)
- Verification: build + manual in-app (no clean unit seam — this is Tauri/storage integration glue; see spec testing section)

**Interfaces:**
- Consumes: `OperatorAction::Complete` (Task 1), `task_ident` local (Task 2), `app: &AppHandle`, `inner: &Arc<AsyncMutex<Inner>>`, `session_id`, `complete_task_inner` (commands.rs:693).

- [ ] **Step 1: Replace the LIVE `Complete` arm (from Task 1) with the real side effect**

In the LIVE branch match (`operator.rs:3099`), replace the placeholder `Complete` arm with:

```rust
                OperatorAction::Complete { rationale } => {
                    let did = if let Some(ident) = task_ident.as_ref() {
                        let storage_arc = app.try_state::<std::sync::Arc<crate::storage::Storage>>();
                        let runtime = app
                            .try_state::<std::sync::Arc<crate::teammate::runtime::TeammateRuntime>>();
                        match (storage_arc, runtime) {
                            (Some(s), Some(r)) => {
                                let now_ms = std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_millis() as u64)
                                    .unwrap_or(0);
                                match crate::teammate::commands::complete_task_inner(
                                    s.inner(), r.inner(), ident.id, now_ms,
                                )
                                .await
                                {
                                    Ok((task, msg)) => {
                                        use tauri::Emitter;
                                        let _ = app.emit("teammate-task", &task);
                                        let _ = app.emit("teammate-message", &msg);
                                        // Clear the stash so we never re-complete
                                        // this task on the next 45s re-poll.
                                        if let Some(att) =
                                            inner.lock().await.sessions.get_mut(&session_id)
                                        {
                                            att.task_ident = None;
                                        }
                                        tracing::info!(
                                            session = %session_id, task = %ident.id.0,
                                            "operator auto-completed task"
                                        );
                                        true
                                    }
                                    Err(e) => {
                                        tracing::warn!(error = %e, "auto-complete failed");
                                        false
                                    }
                                }
                            }
                            _ => {
                                tracing::warn!("auto-complete: storage/runtime state missing");
                                false
                            }
                        }
                    } else {
                        false
                    };
                    (
                        OperatorAction::Complete { rationale: rationale.clone() },
                        did,
                        "complete".to_string(),
                        None,
                        Some(rationale),
                        None,
                    )
                }
```

Notes for the implementer:
- `complete_task_inner` takes `&Arc<Storage>` / `&Arc<TeammateRuntime>`; `State::inner()` yields `&Arc<...>`.
- Do NOT call `state.operator.disable_for_session(...)` here — it would re-lock the watcher `inner` we may already hold and can deadlock. Clearing `att.task_ident` under the `inner` lock is sufficient to stop re-completion; the executor tab reverts to normal at-rest watching (mostly `Wait`).
- Confirm `session_id` and `inner` are in scope at this match (they are the tick's current session and the loop's `inner` param). If the LIVE branch shadows a different binding, use the tick-scope names.

- [ ] **Step 2: Build**

Run: `cargo check -p covenant --lib 2>&1 | tail -20`
Expected: clean (pre-existing warnings only).

- [ ] **Step 3: Run the operator test suite (regression)**

Run: `cargo test -p covenant --lib operator:: 2>&1 | tail -25`
Expected: all pass (including Tasks 1–3 tests). See `reference_covenant_test_gotchas` if unrelated telegram/context tests hang — narrow the filter to `operator::`.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): auto-complete task via Complete action"
```

- [ ] **Step 5: Manual in-app verification (record result)**

1. `/respawn` (or `npm run tauri:dev`).
2. Enable AOM for an operator; dispatch a small `do` task to `claude` (e.g. "print hello and stop").
3. Let claude finish and go idle at its prompt.
4. Within ~1–2 re-poll cycles (≤~90s), confirm: the task flips `Active → Done` in the Tasks panel, a `✓`/Completed message appears in chat, and the operator stops nudging that tab.
5. Ambiguity check: dispatch a task where claude asks a question mid-way; confirm the operator does NOT mark it Done (it should `Reply`/probe or `Wait`).

---

## Self-Review

**Spec coverage:**
- "No Done transition exists / add autonomous completion" → Tasks 1 + 4.
- "Detection = LLM reads screen" → existing `tail` + Task 3 prompt (task block instructs reading completion).
- "Operator can ask the executor" → existing `Reply` action, documented in Task 3 task block.
- "Auto-complete (no confirm)" → Task 4 calls `complete_task_inner` directly + emits events.
- "Session→task link" → Task 2 stash (avoids missing storage query).
- "At-rest phase gate / 45s cadence come free" → unchanged existing loop; no task needed.
- Skipped items (achievement emits, `disable_for_session` parity, `ExecutorPhase::Done` pre-filter, confirm variant) are intentionally out of scope per the spec's YAGNI section — noted below, not implemented.

**Placeholder scan:** none — every code step shows real code; the only "confirm the local name" notes are lookups against exact line numbers, not deferred logic.

**Type consistency:** `TaskIdent { id, title, deliverable }` defined in Task 2, consumed by Tasks 3/4 with matching field names; `complete_task_inner` signature quoted verbatim; `OperatorAction::Complete { rationale }` consistent across Tasks 1/4.

## Deferred (follow-ups, not in this plan)

- Achievement emits on auto-complete (finisher/clean_run/spec_keeper) — currently only the manual button (`teammate_complete_task`) emits them. Extract a shared `complete_task_full` helper if we want parity.
- `disable_for_session` parity (fully stop engaging the tab, not just clear the stash) — deferred to avoid the watcher-`inner` re-lock deadlock; revisit with a lock-safe path.
- `ExecutorPhase::Done` as a cheap pre-filter before spending an LLM call — add if the screen-read proves noisy/expensive.
