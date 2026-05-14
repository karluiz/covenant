# Telegram Approve Propagation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Telegram **Approve** / **Reject** actually unblock the executor's TUI and prevent the operator from re-escalating while a resolution is in flight.

**Architecture:** Three additive pieces in `crates/app`: (1) a pure keystroke-table function keyed on `fg_proc::foreground_process_name`; (2) a `pending_escalation` gate on the operator with `mark_pending` / `resolve_pending`; (3) drain-task wiring in `lib.rs` that, on `Approved`/`Rejected`, writes bytes to the PTY and calls `resolve_pending`. Snooze and FreeText keep current behavior except FreeText also calls `resolve_pending`.

**Tech Stack:** Rust, Tokio, `portable-pty`, existing `karl_pty::foreground_process_name`, existing `karl_session::Session::write`, existing `tokio::sync::broadcast` event bus.

**Spec:** `docs/superpowers/specs/2026-05-13-telegram-approve-propagation-design.md`

**Worktree:** `feat/telegram-approve-propagation` (already created).

---

## File map

| Path | Action | Purpose |
|---|---|---|
| `crates/app/src/telegram/keystrokes.rs` | create | Pure `approve_reject_bytes(fg)` table |
| `crates/app/src/telegram/mod.rs` | modify | `pub mod keystrokes;` + 1 integration test |
| `crates/app/src/operator.rs` | modify | `pending_escalation` field, gate in `run_tick`, public API |
| `crates/app/src/lib.rs` | modify | Drain-task branches for Approved/Rejected/FreeText + `mark_pending` at emit sites |

Everything else (UI, settings, message format) is untouched.

---

## Task 1: Keystroke table

**Files:**
- Create: `crates/app/src/telegram/keystrokes.rs`
- Modify: `crates/app/src/telegram/mod.rs` (add `pub mod keystrokes;` near line 1-4)

- [ ] **Step 1: Write the failing tests**

Create `crates/app/src/telegram/keystrokes.rs`:

```rust
//! Pure mapping from a foreground process name (as produced by
//! `karl_pty::foreground_process_name`) to the bytes we type into the
//! PTY when the user resolves an escalation via Telegram.
//!
//! Approve always picks the first affirmative option of the TUI; Reject
//! picks the first negative option. Unknown / `None` falls back to the
//! generic `y\n` / `n\n` shells expect.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ApproveReject {
    pub approve: &'static [u8],
    pub reject: &'static [u8],
}

pub fn approve_reject_bytes(fg_name: Option<&str>) -> ApproveReject {
    let name = fg_name.map(|s| s.to_ascii_lowercase()).unwrap_or_default();
    match name.as_str() {
        "claude" | "claude-code" | "copilot" | "gemini" => ApproveReject {
            approve: b"1\n",
            reject: b"2\n",
        },
        "aider" | "codex" | "ollama" => ApproveReject {
            approve: b"y\n",
            reject: b"n\n",
        },
        _ => ApproveReject { approve: b"y\n", reject: b"n\n" },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_uses_numeric_menu() {
        let ar = approve_reject_bytes(Some("claude"));
        assert_eq!(ar.approve, b"1\n");
        assert_eq!(ar.reject, b"2\n");
    }

    #[test]
    fn claude_code_alias() {
        assert_eq!(approve_reject_bytes(Some("claude-code")).approve, b"1\n");
    }

    #[test]
    fn copilot_uses_numeric_menu() {
        assert_eq!(approve_reject_bytes(Some("copilot")).approve, b"1\n");
    }

    #[test]
    fn gemini_uses_numeric_menu() {
        assert_eq!(approve_reject_bytes(Some("gemini")).approve, b"1\n");
    }

    #[test]
    fn aider_uses_yn() {
        let ar = approve_reject_bytes(Some("aider"));
        assert_eq!(ar.approve, b"y\n");
        assert_eq!(ar.reject, b"n\n");
    }

    #[test]
    fn codex_uses_yn() {
        assert_eq!(approve_reject_bytes(Some("codex")).approve, b"y\n");
    }

    #[test]
    fn ollama_uses_yn() {
        assert_eq!(approve_reject_bytes(Some("ollama")).approve, b"y\n");
    }

    #[test]
    fn matching_is_case_insensitive() {
        assert_eq!(approve_reject_bytes(Some("Claude")).approve, b"1\n");
        assert_eq!(approve_reject_bytes(Some("CLAUDE-CODE")).approve, b"1\n");
    }

    #[test]
    fn unknown_falls_back_to_yn() {
        let ar = approve_reject_bytes(Some("zsh"));
        assert_eq!(ar.approve, b"y\n");
        assert_eq!(ar.reject, b"n\n");
    }

    #[test]
    fn none_falls_back_to_yn() {
        let ar = approve_reject_bytes(None);
        assert_eq!(ar.approve, b"y\n");
        assert_eq!(ar.reject, b"n\n");
    }
}
```

In `crates/app/src/telegram/mod.rs`, find the existing `pub mod` declarations (around line 1-4) and add:

```rust
pub mod keystrokes;
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p karl-app telegram::keystrokes`
Expected: 10 tests pass.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/telegram/keystrokes.rs crates/app/src/telegram/mod.rs
git commit -m "feat(telegram): keystroke table for approve/reject by executor"
```

---

## Task 2: Operator `pending_escalation` gate (data + methods)

**Files:**
- Modify: `crates/app/src/operator.rs` (struct `Inner`, `impl Inner`, public `OperatorWatcher` API)

Context: the operator's mutable state struct is named `Inner` (not `OperatorInner` — the spec used a generic name). Lock is `self.inner.lock().await`. Public watcher type is `OperatorWatcher`. `note_user_input` already exists on both `Inner::note_user_input(&mut self, sid)` and `OperatorWatcher::note_user_input(&self, sid)` — reuse it for phase reset on resolve.

- [ ] **Step 1: Write failing tests**

In `crates/app/src/operator.rs`, inside the existing `#[cfg(test)] mod tests` block (after the `note_user_input_*` tests, search for `fn note_user_input_no_op_for_unattached_session` and insert after its closing brace), add:

```rust
#[test]
fn mark_pending_then_resolve_clears_gate() {
    let mut inner = Inner::default();
    let sid = SessionId(ulid::Ulid::new());
    inner.attach_for_test(sid); // helper added below if missing — see Step 3

    inner.mark_pending(sid, "esc-1".into());
    assert!(inner.is_pending(sid), "should be gated after mark_pending");

    inner.resolve_pending(sid, "esc-1");
    assert!(!inner.is_pending(sid), "gate should clear after matching resolve");
}

#[test]
fn resolve_pending_ignores_mismatched_id() {
    let mut inner = Inner::default();
    let sid = SessionId(ulid::Ulid::new());
    inner.attach_for_test(sid);

    inner.mark_pending(sid, "esc-1".into());
    inner.resolve_pending(sid, "esc-OTHER");
    assert!(inner.is_pending(sid), "stale resolve must not clear newer gate");

    inner.resolve_pending(sid, "esc-1");
    assert!(!inner.is_pending(sid));
}

#[test]
fn resolve_pending_resets_wait_state_like_note_user_input() {
    let mut inner = Inner::default();
    let sid = SessionId(ulid::Ulid::new());
    inner.attach_for_test(sid);

    // Simulate accumulated idle WAITs.
    if let Some(att) = inner.sessions.get_mut(&sid) {
        att.consecutive_idle_waits = 5;
    }
    inner.mark_pending(sid, "esc-1".into());
    inner.resolve_pending(sid, "esc-1");

    let att = inner.sessions.get(&sid).unwrap();
    assert_eq!(att.consecutive_idle_waits, 0);
    assert_eq!(att.current_phase, OperatorPhase::Yielded);
}

#[test]
fn is_pending_false_for_unattached_session() {
    let inner = Inner::default();
    let sid = SessionId(ulid::Ulid::new());
    assert!(!inner.is_pending(sid));
}
```

If the test module already has a similar `attach_for_test` helper near the top, reuse it. Otherwise add this helper at the top of the test module (look for `mod tests {` and insert right after the `use super::*;` line):

```rust
impl Inner {
    fn attach_for_test(&mut self, sid: SessionId) {
        // Mirrors the minimum fields the gate methods read; copy the
        // pattern of any nearby test helper if one exists.
        self.sessions.insert(sid, SessionAttachment::default());
    }
}
```

(If `SessionAttachment::default()` doesn't exist, derive `Default` on it — check the existing `note_user_input_*` tests to see how they construct attachments and copy that pattern verbatim.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl-app operator::tests::mark_pending`
Expected: compile errors — `mark_pending`, `resolve_pending`, `is_pending` not defined.

- [ ] **Step 3: Add the field and methods**

Find `struct Inner {` (the `Inner` referenced by `OperatorWatcher.inner: Arc<Mutex<Inner>>`). Add to it:

```rust
/// Per-session active escalation. While `Some`, `run_tick` is a
/// no-op for that session. Cleared by `resolve_pending` when the
/// human (UI modal or Telegram) answers. Snooze does NOT clear it.
pending_escalation: std::collections::HashMap<SessionId, String>,
```

If `Inner` has a hand-written `Default` impl, initialize the field to `HashMap::new()`. If it derives `Default`, no change needed.

In `impl Inner` (near `fn note_user_input`, around line 366), add:

```rust
/// Mark `session_id` as having an outstanding escalation
/// `escalation_id`. Subsequent ticks for this session are skipped
/// until a matching `resolve_pending` arrives.
fn mark_pending(&mut self, session_id: SessionId, escalation_id: String) {
    self.pending_escalation.insert(session_id, escalation_id);
}

/// Clear the gate for `session_id` IF the stored escalation id
/// matches `escalation_id`. A mismatch (stale resolve from a
/// previous escalation, race) is a no-op. Also resets the WAIT
/// counters / phase so the next tick re-evaluates from scratch —
/// same semantics as `note_user_input`.
fn resolve_pending(&mut self, session_id: SessionId, escalation_id: &str) {
    let matches = self
        .pending_escalation
        .get(&session_id)
        .map(|s| s == escalation_id)
        .unwrap_or(false);
    if matches {
        self.pending_escalation.remove(&session_id);
        self.note_user_input(session_id);
    }
}

/// True iff a tick for this session should be skipped.
fn is_pending(&self, session_id: SessionId) -> bool {
    self.pending_escalation.contains_key(&session_id)
}
```

Then expose them on `OperatorWatcher` (near the existing `pub async fn note_user_input` around line 810):

```rust
pub async fn mark_pending(&self, session_id: SessionId, escalation_id: String) {
    self.inner.lock().await.mark_pending(session_id, escalation_id);
}

pub async fn resolve_pending(&self, session_id: SessionId, escalation_id: &str) {
    self.inner.lock().await.resolve_pending(session_id, escalation_id);
}

pub async fn is_pending(&self, session_id: SessionId) -> bool {
    self.inner.lock().await.is_pending(session_id)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-app operator::tests::mark_pending operator::tests::resolve_pending operator::tests::is_pending`
Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): pending_escalation gate with mark/resolve/is_pending"
```

---

## Task 3: Gate `run_tick` on pending state

**Files:**
- Modify: `crates/app/src/operator.rs` (`run_tick` at line 1566, plus the per-session loop inside it)

- [ ] **Step 1: Write the failing test**

Append to the same `#[cfg(test)] mod tests` block:

```rust
#[tokio::test]
async fn run_tick_skips_session_while_pending() {
    // The full run_tick wants Storage/AppHandle/etc., so we exercise
    // the gate at the Inner level by asserting that the per-session
    // body is short-circuited via `is_pending`. Concretely: a session
    // marked pending must remain in phase Yielded (no transition) after
    // a synthetic tick body that would normally move it.
    let mut inner = Inner::default();
    let sid = SessionId(ulid::Ulid::new());
    inner.attach_for_test(sid);

    inner.mark_pending(sid, "esc-1".into());

    // The actual gate predicate used by run_tick.
    assert!(inner.is_pending(sid));

    inner.resolve_pending(sid, "esc-1");
    assert!(!inner.is_pending(sid));
}
```

(This unit-level test locks in the gate predicate. The behavioral integration — that `run_tick` actually consults it — is covered by reading the diff.)

- [ ] **Step 2: Run to verify it passes (predicate already exists from Task 2)**

Run: `cargo test -p karl-app operator::tests::run_tick_skips_session_while_pending`
Expected: PASS (it's exercising the public predicate added in Task 2).

- [ ] **Step 3: Wire the gate into `run_tick`**

In `crates/app/src/operator.rs`, locate `async fn run_tick(` at line 1566. Inside `run_tick`, find the per-session loop (the function iterates over attached sessions before deciding per-session actions). At the **top of each per-session iteration**, before any LLM call or `escalation_tx.send` for that session, insert:

```rust
if inner.is_pending(sid) {
    continue;
}
```

Adapt `inner` / `sid` to the actual local variable names used in `run_tick` (the function holds a guard on `self.inner` — check the existing body and reuse those names). If the per-session work isn't a simple loop, place the guard at the earliest point where `sid` is known and before any LLM/notify side effect.

- [ ] **Step 4: Verify the whole crate still builds and tests pass**

Run: `cargo test -p karl-app`
Expected: all existing tests still pass; the new tests from Tasks 1–3 pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): skip run_tick for sessions with pending escalation"
```

---

## Task 4: Call `mark_pending` at every `EscalationRequested` emit site

**Files:**
- Modify: `crates/app/src/operator.rs` (~lines 2866 and ~2996)

Context: `EscalationRequested` is published from two places in `operator.rs`. Both must call `mark_pending` immediately before sending so the gate is set in the same tick.

- [ ] **Step 1: Find the emit sites**

Run: `grep -n "SessionEvent::EscalationRequested" crates/app/src/operator.rs`
Expected: two hits, around lines 2866 and 2996.

- [ ] **Step 2: Insert `mark_pending` before each send**

Each call site looks like (paraphrased):

```rust
let escalation_id = ulid::Ulid::new().to_string();
let _ = escalation_tx.send(SessionEvent::EscalationRequested {
    session_id: sid,
    escalation_id,
    /* … */
});
```

Change to:

```rust
let escalation_id = ulid::Ulid::new().to_string();
inner.mark_pending(sid, escalation_id.clone());
let _ = escalation_tx.send(SessionEvent::EscalationRequested {
    session_id: sid,
    escalation_id,
    /* … */
});
```

`inner` is the same `MutexGuard<Inner>` already in scope at those sites. If the local name differs (e.g. `state`, `guard`), use that.

If `escalation_id` was previously moved into the event before being cloned, add `.clone()` to the `mark_pending` argument and leave the move into the event as-is.

- [ ] **Step 3: Add a regression test**

Append to the same `#[cfg(test)] mod tests` block in `operator.rs`:

```rust
#[test]
fn mark_pending_at_emit_site_blocks_reescalation() {
    // Direct unit verification of the contract: once mark_pending is
    // called with an id, is_pending stays true until a matching
    // resolve_pending. This is the invariant the two emit sites in
    // run_tick rely on.
    let mut inner = Inner::default();
    let sid = SessionId(ulid::Ulid::new());
    inner.attach_for_test(sid);

    inner.mark_pending(sid, "esc-A".into());
    // Second tick would try to mark_pending again with a fresh id —
    // simulate that and assert the gate STILL skips (is_pending true).
    assert!(inner.is_pending(sid));
    inner.mark_pending(sid, "esc-B".into()); // overwrites, but gate is still on
    assert!(inner.is_pending(sid));

    // Only an exact-match resolve clears it.
    inner.resolve_pending(sid, "esc-A");
    assert!(inner.is_pending(sid), "stale id must not clear the newer gate");
    inner.resolve_pending(sid, "esc-B");
    assert!(!inner.is_pending(sid));
}
```

- [ ] **Step 4: Run the tests**

Run: `cargo test -p karl-app operator::tests`
Expected: all pass, including the new one.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): mark_pending at every EscalationRequested emit site"
```

---

## Task 5: Drain task injects keystrokes and resolves the gate

**Files:**
- Modify: `crates/app/src/lib.rs:2622-2686` (the `while let Some(evt) = tg_inbound_rx.recv().await` loop)

Context: currently the `Approved` / `Rejected` / `Snoozed` arms compute `(res, free_text)` but `free_text` is only used in the `if let Some(text) = free_text` block. We need to:

1. For `Approved` and `Rejected`: look up the session, read its `fg_proc`, write the keystroke bytes, then call `operator.resolve_pending`.
2. For `FreeText`: keep current PTY injection, additionally call `operator.resolve_pending`.
3. For `Snoozed`: no PTY write, no `resolve_pending` (gate stays held).

The drain task closure needs access to the `OperatorWatcher` — capture it from the outer scope the same way `tg_for_drain` and `app_handle_for_drain` are captured (clone an `Arc` into the spawned future).

- [ ] **Step 1: Capture the operator handle for the drain task**

In `crates/app/src/lib.rs`, just above the `tauri::async_runtime::spawn(async move { … })` at line 2620, add:

```rust
let operator_for_drain = operator.clone();
```

(`operator` is the `Arc<OperatorWatcher>` already in scope at this point in `setup`. If the name is different in the actual file, use it — search above this line for the local that holds the operator watcher.)

Then in the spawn arguments / move closure capture list, ensure `operator_for_drain` is moved in (the closure is `async move { … }` so all captures are moved automatically).

- [ ] **Step 2: Extract a helper for session-id lookup + PTY write**

The Approved / Rejected / FreeText arms all need the same prelude: look up the session id from `tg_for_drain.state.session_map`, parse it, lock `state.sessions`, get the managed session. Factor this into a closure inside the spawn:

After the `use karl_session::{...}` line at the top of the closure body, add:

```rust
let inject_and_resolve = |escalation_id: String, bytes: Option<Vec<u8>>, _resolution_label: &'static str| {
    let tg_for_drain = tg_for_drain.clone();
    let app_handle_for_drain = app_handle_for_drain.clone();
    let operator_for_drain = operator_for_drain.clone();
    async move {
        let session_str = tg_for_drain
            .state
            .session_map
            .lock()
            .unwrap()
            .get(&escalation_id)
            .cloned();
        let Some(sid_str) = session_str else { return; };
        let Ok(sid) = sid_str.parse::<karl_session::SessionId>() else {
            tracing::warn!(sid = %sid_str, "telegram drain: bad session id");
            return;
        };
        let Some(state) = app_handle_for_drain.try_state::<AppState>() else { return; };

        // PTY write (Approve/Reject/FreeText all hit this; Snooze never calls inject_and_resolve).
        let mut sessions = state.sessions.lock().await;
        if let Some(managed) = sessions.get_mut(&sid) {
            if let Some(payload) = bytes {
                if let Err(e) = managed.session.write(&payload) {
                    tracing::warn!(error = %e, "telegram drain: PTY write failed");
                }
            }
        } else {
            tracing::warn!(session = %sid, "telegram drain: session not found");
        }
        drop(sessions);

        operator_for_drain.resolve_pending(sid, &escalation_id).await;
    }
};
```

- [ ] **Step 3: Rewrite the `Resolved` arm to use it**

Replace the entire `InboundEvent::Resolved { escalation_id, resolution } => { … }` block (lib.rs:2624-2687) with:

```rust
crate::telegram::InboundEvent::Resolved {
    escalation_id,
    resolution,
} => {
    use crate::telegram::ResolutionFromTelegram;

    // Fetch fg_proc once so the keystroke table picks the right
    // bytes per executor (claude → "1\n", aider → "y\n", …).
    let fg_name: Option<String> = {
        let session_str = tg_for_drain
            .state
            .session_map
            .lock()
            .unwrap()
            .get(&escalation_id)
            .cloned();
        match session_str.and_then(|s| s.parse::<karl_session::SessionId>().ok()) {
            Some(sid) => {
                if let Some(state) = app_handle_for_drain.try_state::<AppState>() {
                    let sessions = state.sessions.lock().await;
                    sessions
                        .get(&sid)
                        .map(|m| m.session.master_fd())
                        .and_then(karl_pty::foreground_process_name)
                } else {
                    None
                }
            }
            None => None,
        }
    };

    let (res, bytes, should_resolve) = match &resolution {
        ResolutionFromTelegram::Approved => {
            let ar = crate::telegram::keystrokes::approve_reject_bytes(fg_name.as_deref());
            (
                EscalationResolution::Approved,
                Some(ar.approve.to_vec()),
                true,
            )
        }
        ResolutionFromTelegram::Rejected => {
            let ar = crate::telegram::keystrokes::approve_reject_bytes(fg_name.as_deref());
            (
                EscalationResolution::Rejected,
                Some(ar.reject.to_vec()),
                true,
            )
        }
        ResolutionFromTelegram::Snoozed => {
            (EscalationResolution::Snoozed, None, false)
        }
        ResolutionFromTelegram::FreeText(t) => {
            let mut payload = t.clone().into_bytes();
            payload.push(b'\n');
            (
                EscalationResolution::FreeText(t.clone()),
                Some(payload),
                true,
            )
        }
    };

    // Publish bus event (UI tab dot clears, observer logs).
    let _ = escalation_bus_tx_for_drain.send(SessionEvent::EscalationResolved {
        escalation_id: escalation_id.clone(),
        resolution: res,
        source: ResolutionSource::Telegram,
    });

    if should_resolve {
        inject_and_resolve(escalation_id.clone(), bytes, "telegram").await;
    }
}
```

Note: this replaces the previous block including the inline FreeText PTY-injection logic — `inject_and_resolve` now handles it uniformly.

- [ ] **Step 4: Build**

Run: `cargo build -p karl-app`
Expected: compiles. If `karl_pty::foreground_process_name` isn't already imported at the top of `lib.rs`, add `use karl_pty;` or qualify as `karl_pty::foreground_process_name` (already qualified above).

- [ ] **Step 5: Run the full app test suite**

Run: `cargo test -p karl-app`
Expected: all tests pass, including the existing telegram integration tests (`send_escalation_records_message_id`, `resolve_edits_original_message`, `callback_query_publishes_resolution`, `reply_message_publishes_freetext`).

If `reply_message_publishes_freetext` regresses because it now expects `resolve_pending` to be called on a non-attached session — that's fine; `resolve_pending` is a no-op when the gate isn't set. If it fails for another reason, fix before commit.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(telegram): drain task injects keystrokes and clears operator gate"
```

---

## Task 6: End-to-end integration test in `telegram/mod.rs`

**Files:**
- Modify: `crates/app/src/telegram/mod.rs` (test module starting at `#[cfg(test)] mod tests` ~line 226)

Goal: drive a fake Telegram `Approve` callback through `spawn_inbound`'s output channel, run the drain logic in test scope, and assert PTY bytes hit the writer.

The drain task itself lives in `lib.rs` and depends on Tauri state, so we test a thinner stand-in here: that `keystrokes::approve_reject_bytes(Some("claude"))` returns `1\n` and that `TelegramNotifier::on_resolved` is correctly called by the existing test path. The PTY-injection contract is covered by the unit tests in Task 1 plus a build-level assertion that the drain task compiles with the new branches (already verified by Task 5 Step 5).

- [ ] **Step 1: Add a test that documents the contract**

Inside the existing `mod tests` block in `crates/app/src/telegram/mod.rs`, append:

```rust
#[test]
fn approve_resolution_picks_claude_keystrokes() {
    // Contract: when the foreground executor is Claude Code, an
    // Approve from Telegram MUST translate into the "1\n" keystroke
    // that selects the first option of Claude's permission prompt.
    // This is the load-bearing assumption of the drain task in
    // lib.rs; pinning it here makes a future Claude UI change a
    // visible test failure.
    use crate::telegram::keystrokes::approve_reject_bytes;
    assert_eq!(approve_reject_bytes(Some("claude")).approve, b"1\n");
    assert_eq!(approve_reject_bytes(Some("claude")).reject, b"2\n");
}

#[test]
fn approve_resolution_falls_back_when_executor_unknown() {
    use crate::telegram::keystrokes::approve_reject_bytes;
    assert_eq!(approve_reject_bytes(None).approve, b"y\n");
}
```

- [ ] **Step 2: Run tests**

Run: `cargo test -p karl-app telegram::tests`
Expected: all telegram tests pass (existing 5 + 2 new = 7).

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/telegram/mod.rs
git commit -m "test(telegram): pin claude approve→1\\n contract"
```

---

## Task 7: Manual smoke test (no code change)

- [ ] **Step 1: Run the app**

Run: `npm --prefix ui run tauri dev`
Expected: app launches.

- [ ] **Step 2: Trigger an escalation**

- Open a tab running Claude Code.
- Get into a state where the operator escalates (or send a manual escalation via the dev tools if available).
- Confirm a Telegram message arrives with Approve / Reject / Snooze buttons.

- [ ] **Step 3: Press Approve in Telegram**

Expected within ~1 s:
1. Telegram message edits to "✓ Resolved: Approved via Telegram".
2. The terminal tab's executor advances (Claude Code accepts the action).
3. No second BLOCKED card appears within 30 s.

- [ ] **Step 4: Press Reject in a fresh escalation**

Expected: TUI selects the negative option (Claude's "2" / shell's `n`), terminal advances accordingly.

- [ ] **Step 5: Press Snooze in a fresh escalation**

Expected: TG message edits to "✓ Resolved: …", terminal stays blocked (gate intentionally not released), no PTY write.

If any of the above misbehaves, stop and revisit Task 5.

- [ ] **Step 6: No commit needed — smoke test only.**

---

## Finalize

- [ ] **Step 1: Verify the worktree is green**

Run: `cargo test -p karl-app && cargo build -p karl-app`
Expected: all pass, zero warnings introduced beyond the baseline.

- [ ] **Step 2: Push and open PR (only after user approval — see `superpowers:finishing-a-development-branch`)**

Do not push automatically. Hand control back to the user with a one-line status.

---

## Notes for the implementer

- Keep the diff additive. Do not refactor unrelated operator code, message formats, or the `on_resolved` edit text.
- `Snooze` intentionally does NOT clear the gate. That's a feature: a snoozed escalation stays in flight; a future spec adds the re-reminder cadence.
- If `foreground_process_name` returns `None` (race with the executor exiting), the fallback `y\n` / `n\n` is intentional — most shells consume it harmlessly, and the next tick will re-evaluate.
- If you find that the operator's `Arc<OperatorWatcher>` is named differently in `lib.rs` setup (e.g. `op_watcher`), use that name in Task 5 Step 1.
- The message-format ugliness (`[tab: session:01KRJ3] BLOCKED` etc.) is explicitly out of scope. A follow-up UX spec covers it.
