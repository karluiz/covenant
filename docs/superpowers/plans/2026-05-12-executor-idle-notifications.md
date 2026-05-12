# Executor Idle Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Notify the user (OS notification + existing tab badge) whenever an embedded CLI agent (claude, copilot, opencode, codex, gemini, aider) becomes idle waiting for input, independent of whether Operator or AOM is running.

**Architecture:** Reuse the existing `IdleDetector` → `SessionEvent::AgentIdleWaiting` pipeline. Add a new `Trigger::ExecutorIdle` notification variant with **per-session** 30s throttling, a settings toggle `on_executor_idle` (default `true`), and a long-lived task in `app/src/lib.rs` that subscribes to the session event bus and fans out via existing `notifications::dispatch()` (OS + email + telegram). UI tab badge is already implemented and unchanged.

**Tech Stack:** Rust (tokio broadcast, tauri-plugin-notification), existing `Notifier` infra in `crates/app/src/notify.rs`, existing `dispatch()` fan-out in `crates/app/src/notifications.rs`.

---

## File Structure

- **Modify** `crates/app/src/notify.rs` — add `Trigger::ExecutorIdle` variant + per-session throttle map; existing global throttle stays for Operator/AOM triggers.
- **Modify** `crates/app/src/settings.rs` — add `on_executor_idle: bool` field to `NotificationConfig` (default `true`); add migration default in `Default` impl.
- **Modify** `crates/app/src/lib.rs` — spawn an "executor idle subscriber" task at app startup that subscribes to the session bus and calls `dispatch()` when `SessionEvent::AgentIdleWaiting` fires.
- **Create** `crates/app/src/executor_idle.rs` — pure-logic subscriber module (testable in isolation): formats title/body, calls into `dispatch()`. Re-exported from `lib.rs`.
- **Test** `crates/app/src/notify.rs` (existing tests block) — per-session throttle behavior.
- **Test** `crates/app/src/executor_idle.rs` — subscriber formatting + settings gating.

---

## Task 1: Add `Trigger::ExecutorIdle` variant with per-session throttle

**Files:**
- Modify: `crates/app/src/notify.rs`

- [ ] **Step 1: Write the failing test for new variant + per-session throttle**

Append to the existing `#[cfg(test)] mod tests` block at the bottom of `crates/app/src/notify.rs`:

```rust
#[test]
fn executor_idle_throttle_is_per_session() {
    use karl_session::SessionId;
    let mut state = ThrottleState::default();
    let s1 = SessionId::new();
    let s2 = SessionId::new();
    let t0 = Instant::now();
    assert!(state.allow_per_session(Trigger::ExecutorIdle, s1, t0));
    // Same session within window → blocked
    assert!(!state.allow_per_session(Trigger::ExecutorIdle, s1, t0 + Duration::from_secs(5)));
    // Different session, same window → allowed
    assert!(state.allow_per_session(Trigger::ExecutorIdle, s2, t0 + Duration::from_secs(5)));
    // Same session, after window → allowed again
    assert!(state.allow_per_session(Trigger::ExecutorIdle, s1, t0 + Duration::from_secs(31)));
}

#[test]
fn executor_idle_is_enabled_respects_toggle() {
    let mut cfg = crate::settings::NotificationConfig::default();
    cfg.on_executor_idle = true;
    assert!(Trigger::ExecutorIdle.is_enabled(&cfg));
    cfg.on_executor_idle = false;
    assert!(!Trigger::ExecutorIdle.is_enabled(&cfg));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-app notify::tests::executor_idle -- --nocapture`
Expected: FAIL — `Trigger::ExecutorIdle` not defined, `allow_per_session` not defined, `on_executor_idle` not defined.

- [ ] **Step 3: Add variant + per-session throttle**

In `crates/app/src/notify.rs`:

Add to the `Trigger` enum (after `AomComplete`):

```rust
    /// CLI agent (claude/copilot/opencode/...) embedded in a tab is
    /// waiting for user input. Per-session throttle.
    ExecutorIdle,
```

Update `Trigger::severity`:

```rust
    pub fn severity(self) -> Severity {
        match self {
            Trigger::OperatorEscalate | Trigger::AomError => Severity::Escalation,
            Trigger::AomComplete | Trigger::ExecutorIdle => Severity::Info,
        }
    }
```

Update `Trigger::label`:

```rust
    fn label(self) -> &'static str {
        match self {
            Trigger::OperatorEscalate => "operator_escalate",
            Trigger::AomError => "aom_error",
            Trigger::AomComplete => "aom_complete",
            Trigger::ExecutorIdle => "executor_idle",
        }
    }
```

Update `Trigger::is_enabled`:

```rust
    fn is_enabled(self, cfg: &crate::settings::NotificationConfig) -> bool {
        match self {
            Trigger::OperatorEscalate => cfg.on_operator_escalate,
            Trigger::AomError => cfg.on_aom_error,
            Trigger::AomComplete => cfg.on_aom_complete,
            Trigger::ExecutorIdle => cfg.on_executor_idle,
        }
    }
```

Replace `ThrottleState` with:

```rust
#[derive(Default)]
struct ThrottleState {
    last_fire: HashMap<Trigger, Instant>,
    last_fire_per_session: HashMap<(Trigger, karl_session::SessionId), Instant>,
}

impl ThrottleState {
    fn allow(&mut self, trigger: Trigger, now: Instant) -> bool {
        match self.last_fire.get(&trigger).copied() {
            Some(prev) if now.duration_since(prev) < THROTTLE_WINDOW => false,
            _ => {
                self.last_fire.insert(trigger, now);
                true
            }
        }
    }

    fn allow_per_session(
        &mut self,
        trigger: Trigger,
        session: karl_session::SessionId,
        now: Instant,
    ) -> bool {
        let key = (trigger, session);
        match self.last_fire_per_session.get(&key).copied() {
            Some(prev) if now.duration_since(prev) < THROTTLE_WINDOW => false,
            _ => {
                self.last_fire_per_session.insert(key, now);
                true
            }
        }
    }
}
```

Find `Notifier::emit` and locate the throttle check (search for `.allow(trigger, now)`). Replace with branching logic so `ExecutorIdle` uses the per-session map. The full replacement reads roughly:

```rust
let throttle_ok = {
    let mut state = self.throttle.lock().await;
    match trigger {
        Trigger::ExecutorIdle => match session_id {
            Some(s) => state.allow_per_session(trigger, s, Instant::now()),
            None => state.allow(trigger, Instant::now()), // defensive fallback
        },
        _ => state.allow(trigger, Instant::now()),
    }
};
```

Adjust to match the surrounding lock style in `notify.rs` (it uses `tokio::sync::Mutex` async lock — keep that pattern).

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-app notify::tests -- --nocapture`
Expected: all existing notify tests + 2 new ones pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/notify.rs
git commit -m "feat(notify): add Trigger::ExecutorIdle with per-session throttle"
```

---

## Task 2: Add `on_executor_idle` setting

**Files:**
- Modify: `crates/app/src/settings.rs`

- [ ] **Step 1: Write the failing test**

Append to the existing settings test module:

```rust
#[test]
fn notification_config_default_enables_executor_idle() {
    let cfg = NotificationConfig::default();
    assert!(cfg.on_executor_idle, "executor idle notifications default on");
}

#[test]
fn notification_config_deserializes_without_executor_idle_field() {
    // Older settings files won't have the new field. Default must kick in.
    let json = r#"{"on_operator_escalate":true,"on_aom_error":true,"on_aom_complete":true}"#;
    let cfg: NotificationConfig = serde_json::from_str(json).expect("parse");
    assert!(cfg.on_executor_idle, "missing field falls back to default true");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-app settings::tests::notification_config -- --nocapture`
Expected: FAIL — `on_executor_idle` field does not exist.

- [ ] **Step 3: Add the field**

In `crates/app/src/settings.rs`, find `struct NotificationConfig` and add the field. Use `serde(default = "true_default")` so existing settings files migrate seamlessly:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct NotificationConfig {
    #[serde(default = "true_default")]
    pub on_operator_escalate: bool,
    #[serde(default = "true_default")]
    pub on_aom_error: bool,
    #[serde(default = "true_default")]
    pub on_aom_complete: bool,
    #[serde(default = "true_default")]
    pub on_executor_idle: bool,
    // ... keep existing fields below
}

fn true_default() -> bool { true }
```

In the `Default` impl, add `on_executor_idle: true,`. If `true_default` already exists, reuse it — do not duplicate.

- [ ] **Step 4: Run tests**

Run: `cargo test -p karl-app settings::tests -- --nocapture`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/settings.rs
git commit -m "feat(settings): on_executor_idle toggle (default true)"
```

---

## Task 3: Executor idle subscriber module

**Files:**
- Create: `crates/app/src/executor_idle.rs`
- Modify: `crates/app/src/lib.rs` (add `mod executor_idle;`)
- Test: same file (`#[cfg(test)]` block)

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/executor_idle.rs` with only test stubs first:

```rust
//! Subscriber that turns `SessionEvent::AgentIdleWaiting` into a user-
//! facing notification via `notifications::dispatch`. Runs as a single
//! tokio task spawned at app boot.

use karl_session::{SessionEvent, SessionId};

/// Pure formatter: turn an `AgentIdleWaiting` payload into (title, body).
/// Title is short for the OS popup; body shows the matched prompt line
/// when available, otherwise a generic "waiting for input" string.
pub fn format_notification(
    agent: &str,
    prompt_text: Option<&str>,
    quiet_ms: u64,
) -> (String, String) {
    let secs = quiet_ms / 1000;
    let title = format!("{agent} is waiting");
    let body = match prompt_text {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => format!("Idle for {secs}s — needs your input"),
    };
    (title, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_uses_prompt_text_when_present() {
        let (title, body) = format_notification("claude", Some("Do you want to proceed? (y/N)"), 5000);
        assert_eq!(title, "claude is waiting");
        assert_eq!(body, "Do you want to proceed? (y/N)");
    }

    #[test]
    fn format_falls_back_when_no_prompt_text() {
        let (title, body) = format_notification("copilot", None, 7000);
        assert_eq!(title, "copilot is waiting");
        assert!(body.contains("7s"));
    }

    #[test]
    fn format_handles_empty_prompt_text_as_missing() {
        let (_t, body) = format_notification("opencode", Some(""), 3000);
        assert!(body.contains("3s"));
    }
}
```

Register the module: in `crates/app/src/lib.rs`, find the existing `mod notify;` / `mod notifications;` declarations and add:

```rust
mod executor_idle;
```

- [ ] **Step 2: Run tests to verify they pass (module compiles, formatter logic correct)**

Run: `cargo test -p karl-app executor_idle::tests -- --nocapture`
Expected: PASS (3 tests).

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/executor_idle.rs crates/app/src/lib.rs
git commit -m "feat(executor_idle): notification formatter module"
```

---

## Task 4: Wire the subscriber task at app startup

**Files:**
- Modify: `crates/app/src/executor_idle.rs` (add `spawn` function)
- Modify: `crates/app/src/lib.rs` (call `executor_idle::spawn` from setup)

- [ ] **Step 1: Inspect existing setup to find where to spawn**

Run: `rg "session_bus|broadcast::Receiver|event_bus" crates/app/src/lib.rs -n | head -20`
Read the lines around `AppState { notifier, ... }` construction and around any existing `tokio::spawn` for bus consumers. Identify:
  - The `broadcast::Sender<SessionEvent>` (likely `events_tx` or `session_events`).
  - The clones of `notifier`, `email_notifier`, `settings` available at spawn time.

Record their concrete names; the next step inserts code using them.

- [ ] **Step 2: Write the spawn function**

Append to `crates/app/src/executor_idle.rs`:

```rust
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tracing::{debug, warn};

use crate::email::EmailNotifier;
use crate::notifications::{dispatch, DispatchCtx};
use crate::notify::{Notifier, Trigger};
use crate::settings::Settings;

/// Spawn the long-lived task that listens for `AgentIdleWaiting` on
/// the session event bus and fans out to OS + email + telegram via
/// [`dispatch`]. Returns the join handle so the caller can keep it
/// owned in `AppState` (preventing accidental drop).
pub fn spawn(
    mut rx: broadcast::Receiver<SessionEvent>,
    notifier: Notifier,
    email: Arc<EmailNotifier>,
    settings: Arc<AsyncMutex<Settings>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(SessionEvent::AgentIdleWaiting {
                    session,
                    agent,
                    prompt_text,
                    quiet_ms,
                }) => {
                    if !settings.lock().await.notifications.on_executor_idle {
                        debug!(target: "executor_idle", "skipped: toggle off");
                        continue;
                    }
                    let (title, body) = format_notification(
                        &agent,
                        prompt_text.as_deref(),
                        quiet_ms,
                    );
                    let _ = dispatch(
                        &notifier,
                        &email,
                        DispatchCtx {
                            trigger: Trigger::ExecutorIdle,
                            title,
                            body,
                            session_id: Some(session),
                        },
                    )
                    .await;
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(target: "executor_idle", lagged = n, "bus lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    debug!(target: "executor_idle", "bus closed, exiting");
                    break;
                }
            }
        }
    })
}
```

If `EmailNotifier` is not `Arc`-wrapped in your local tree, adjust the signature to match how `AppState` stores it (the file `lib.rs` already exposes `email_notifier: Arc<EmailNotifier>` per the existing code — use that).

- [ ] **Step 3: Call `spawn` from app setup in `lib.rs`**

In `crates/app/src/lib.rs`, locate the section where `notifier`, `email_notifier`, and the session event bus are all constructed (search for where `Notifier` is built). After all three exist, before they're moved into `AppState`, add:

```rust
let _executor_idle_task = crate::executor_idle::spawn(
    session_events_tx.subscribe(),
    notifier.clone(),
    email_notifier.clone(),
    settings.clone(),
);
```

Replace `session_events_tx` with the actual sender variable name (found in Step 1). Store the handle on `AppState` if the existing pattern stores other task handles there; otherwise leave as `_executor_idle_task` (binding to `_name` keeps the task alive for the lifetime of setup, but if setup exits the handle is dropped — verify by reading nearby code whether other long-lived tasks are stored on `AppState`. If yes, mirror that. If no, the binding pattern matches local convention).

- [ ] **Step 4: Build to verify wiring compiles**

Run: `cargo build -p karl-app`
Expected: clean build, no warnings about unused imports.

- [ ] **Step 5: Add integration smoke test**

Append to `crates/app/src/executor_idle.rs` test module:

```rust
#[tokio::test]
async fn subscriber_skips_when_toggle_off() {
    use karl_session::SessionId;
    use std::sync::Arc;
    use tokio::sync::{broadcast, Mutex as AsyncMutex};

    let (tx, rx) = broadcast::channel(16);

    // Build minimal notifier + email stubs. Both must accept a call
    // without panicking when the toggle is off (they should never be
    // invoked in that case).
    let settings = {
        let mut s = Settings::default();
        s.notifications.on_executor_idle = false;
        Arc::new(AsyncMutex::new(s))
    };

    // NB: Notifier::new and EmailNotifier::new signatures must be
    // matched here. If they require an AppHandle/SendGridClient,
    // construct test doubles from the existing test helpers in
    // notify.rs / email/mod.rs — those modules already expose them
    // for their own unit tests; re-use them. Do NOT introduce new
    // mocks.
    let notifier = crate::notify::Notifier::test_dummy();
    let email = Arc::new(crate::email::EmailNotifier::test_dummy(settings.clone()));

    let handle = spawn(rx, notifier, email, settings.clone());

    tx.send(SessionEvent::AgentIdleWaiting {
        session: SessionId::new(),
        agent: "claude".into(),
        prompt_text: Some("(y/N)".into()),
        quiet_ms: 5_000,
    })
    .unwrap();

    // Give the task one tick.
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    drop(tx); // closes the bus → task exits cleanly
    handle.await.unwrap();
}
```

If `Notifier::test_dummy` / `EmailNotifier::test_dummy` do not already exist, **do not add them as a side quest** — instead, in Step 5 itself, add minimal `#[cfg(test)] pub fn test_dummy(...)` constructors to each module that return an instance which performs no I/O (the existing test code in those modules already constructs such instances inline — extract that pattern into a `test_dummy` helper). Commit those test helpers as part of this task.

- [ ] **Step 6: Run tests**

Run: `cargo test -p karl-app executor_idle -- --nocapture`
Expected: 4 tests pass.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/executor_idle.rs crates/app/src/lib.rs crates/app/src/notify.rs crates/app/src/email/mod.rs
git commit -m "feat(executor_idle): subscribe bus and fan out via dispatch"
```

---

## Task 5: Settings UI toggle

**Files:**
- Modify: `ui/src/settings/notifications.ts` (or whichever file renders the existing on_operator_escalate / on_aom_error toggles — find via grep)

- [ ] **Step 1: Locate the existing notification settings UI**

Run: `rg "on_operator_escalate|on_aom_error|on_aom_complete" ui/src -n`
Identify the file rendering the three existing toggles and the TS type defining `NotificationConfig`.

- [ ] **Step 2: Extend the TS type**

In the type file (likely `ui/src/api.ts` or `ui/src/settings/types.ts`), add to the `NotificationConfig` interface:

```ts
  on_executor_idle: boolean;
```

- [ ] **Step 3: Add the toggle row to the UI**

In the settings panel file, copy the row for `on_aom_complete` and adapt:

```ts
renderToggleRow({
  key: "on_executor_idle",
  label: "CLI agent is waiting",
  description:
    "Notify when an embedded agent (claude, copilot, opencode, …) goes idle waiting for input.",
  value: cfg.on_executor_idle,
  onChange: (v) => setCfg({ ...cfg, on_executor_idle: v }),
});
```

Match the exact function signature / JSX of neighbouring rows — do not invent a new helper.

- [ ] **Step 4: Manual smoke test**

Run: `npm --prefix ui run dev` then open Settings → Notifications. Verify:
  1. The new toggle appears under the existing three.
  2. Default is ON.
  3. Toggling it persists across an app restart (`tauri dev` reload).

- [ ] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(ui): settings toggle for executor idle notifications"
```

---

## Task 6: End-to-end verification

**Files:** none (manual + cargo test)

- [ ] **Step 1: Full backend test pass**

Run: `cargo test --workspace`
Expected: all green.

- [ ] **Step 2: Manual end-to-end smoke**

  1. `npm --prefix ui run tauri dev`.
  2. Open a tab, start `claude` (or `copilot`, `opencode`).
  3. Wait for it to print a prompt like "Do you want to proceed? (y/N)" or similar and then sit idle.
  4. Within ~5s, verify:
     - Pulsing badge appears on the tab chip (existing behavior — regression check).
     - macOS notification appears with title `claude is waiting` and body containing the matched prompt line.
  5. Switch focus away, send another prompt from another tab — verify second OS notification fires (per-session throttle).
  6. Trigger same tab again within 30s — verify NO second notification (same-session throttle holds).
  7. Disable the toggle in Settings → trigger again → verify badge still shows but OS notification does NOT fire.

- [ ] **Step 3: Commit any test fixes needed**

```bash
git add -A
git commit -m "chore: stabilize executor idle e2e"
```

(Skip the commit if no changes.)

- [ ] **Step 4: Open PR**

Use the finishing-a-development-branch skill. Suggested title:
`feat: notify when embedded CLI agent goes idle`

---

## Self-Review Notes

**Spec coverage:**
- "Ambas" (badge + OS notif) → Tab badge: pre-existing, regression-checked in Task 6. OS notif: Task 4. ✓
- "Solo claude/copilot/opencode" → already gated by `KNOWN_AGENTS` in `crates/session/src/idle.rs`. No backend change needed. ✓
- "Feature con TDD" → every task is test-first. ✓
- Per-session throttle → Task 1. ✓
- 30s throttle reused from spec 3.6 → Task 1 uses existing `THROTTLE_WINDOW`. ✓
- Settings toggle → Task 2 (backend) + Task 5 (UI). ✓

**Placeholder scan:** none — all code blocks complete except Task 4 Step 1, which is an inspection step that produces a concrete variable name used in Step 3 (acceptable — the variable cannot be predicted without reading the local tree).

**Type consistency:**
- `Trigger::ExecutorIdle` used consistently in Tasks 1, 3, 4.
- `on_executor_idle` field name used consistently in Tasks 2, 4, 5.
- `format_notification` signature stable across Tasks 3 and 4.
