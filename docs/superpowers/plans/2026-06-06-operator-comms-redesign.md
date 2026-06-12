# Operator → User Communication Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the operator's Telegram channel conversational and quiet — it never reports a working executor as "stuck," never floods, answers "what's going on?" with a real cross-tab status, and surfaces rich context — by gating the operator on the executor phase that `NotchHub` already computes.

**Architecture:** Approach A-hybrid. A phase gate (reading `NotchHub::phase_snapshot`) forbids the operator from engaging while the executor is in a working phase (`Thinking`/`Running`/`Reading`/`Writing`). When at rest, the existing decision LLM runs against a chrome-stripped excerpt; loop escalations are reframed so only real triggers ping; a coalescer edits the live Telegram message instead of posting duplicates; inbound free-text routes to a deterministic English cross-tab status reply.

**Tech Stack:** Rust (Tokio, Tauri 2, rusqlite), TypeScript (vitest), Anthropic Messages API. Crates: `karl-blocks` (phase detector), `karl_session` (events), `covenant` (= `crates/app`: operator, notch, telegram, storage), `familiar` (prompts). UI under `ui/`.

**Test commands (memorize):**
- `karl-blocks`: `cargo test -p karl-blocks`
- app crate: `cargo test -p covenant --lib <module>::tests` (e.g. `notch::tests`, `operator::tests`, `storage::tests`, `telegram`)
- UI unit: `npm run test` (vitest) · UI typecheck: `npm run build` (`tsc && vite build`)

**Reference:** spec at `docs/superpowers/specs/2026-06-06-operator-comms-redesign-design.md`. Key existing code:
- `crates/blocks/src/executor_phase.rs`: `ExecutorPhase { Idle, Thinking, Running{cmd}, Writing{file}, Reading{file}, Waiting{reason}, Done{summary} }` + `ExecutorPhaseDetector`.
- `crates/app/src/notch.rs`: `NotchHub` keeps a per-session detector, `ingest()` feeds bytes, broadcasts `SessionEvent::ExecutorStateChanged`. `Entry { display, agent, .. }`.
- `crates/app/src/operator.rs`: `run_tick(...)` (the 500ms loop), `OperatorAction { Reply, Escalate, Wait }`, loop detectors (~2698-2831), `render_user_message` (~3854), `strip_spinner_churn` (~4076), `detect_decision_point` (~3898), `EscalationRequested` emit (~3150). Test module at line 4662. Package = `covenant`.
- `crates/app/src/telegram/{mod,outbound,inbound,types,client}.rs`: `send_escalation`, `on_resolved`, `OutboundState { map, session_map, status }`, `format_message`, `keyboard_for`, `InboundEvent { Resolved, UnknownReply }`, `SendMessageReq`, `TelegramClient::{send_message, edit_message_text}`.
- `crates/app/src/lib.rs`: escalation→Telegram subscriber (~3118), inbound drain (~3224), Spanish scold (~3318), PTY inject `managed.session.write(&payload)`.
- `crates/app/src/storage.rs`: `operator_decisions` table, idempotent `ALTER TABLE ADD COLUMN` migrations in `Storage::open()`, `save_operator_decision`, `list_operator_decisions`, `OperatorDecisionRow`.
- `ui/src/teammate/activity-view.ts`: `DecisionEvent`, `ActEvent`, `classifyKind`, `bodyForDecision`, `truncate`, render fns. `ui/src/api.ts`: `OperatorDecisionRow`, `listOperatorDecisions`.

**Crate name note:** `crates/app`'s Cargo package is `covenant`. `crates/blocks` is `karl-blocks`. `crates/session` is `karl_session`.

---

## Part A — Phase gate (the spine)

Wire the operator's decision loop to the phase `NotchHub` already computes. This kills the double-type loop and every "stuck/Whirlpooling" escalation in one move.

### Task A1: `NotchHub::phase_snapshot`

**Files:**
- Modify: `crates/app/src/notch.rs` (add method to `impl NotchHub`, near `snapshot()` ~line 366)
- Test: `crates/app/src/notch.rs` (`#[cfg(test)] mod tests`, ~line 576)

- [ ] **Step 1: Write the failing tests** (add to `mod tests`)

```rust
    #[tokio::test]
    async fn phase_snapshot_reports_display_and_agent() {
        let (tx, _rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_foreground_agent(sid, Some("claude".into())).await;
        hub.ingest(sid, b"$ cargo test\n").await;
        let (phase, agent) = hub.phase_snapshot(sid).await.expect("snapshot");
        assert!(matches!(phase, ExecutorPhase::Running { .. }));
        assert_eq!(agent.as_deref(), Some("claude"));
    }

    #[tokio::test]
    async fn phase_snapshot_none_for_unregistered() {
        let hub = NotchHub::new();
        assert!(hub.phase_snapshot(SessionId::new()).await.is_none());
    }
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p covenant --lib notch::tests::phase_snapshot`
Expected: FAIL — `no method named phase_snapshot`.

- [ ] **Step 3: Implement** (add inside `impl NotchHub`, just above `pub async fn snapshot`)

```rust
    /// Snapshot the current display phase + foreground agent for one session.
    /// The operator's decision loop reads this to gate on real executor state.
    /// `None` when the session isn't registered (no agent detected here).
    pub async fn phase_snapshot(
        &self,
        session: SessionId,
    ) -> Option<(karl_session::ExecutorPhase, Option<String>)> {
        let map = self.sessions.lock().await;
        map.get(&session).map(|e| (e.display.clone(), e.agent.clone()))
    }
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p covenant --lib notch::tests::phase_snapshot`
Expected: PASS (both tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/notch.rs
git commit -m "feat(notch): phase_snapshot query for the operator gate"
```

### Task A2: operator gate helper (pure, unit-tested)

**Files:**
- Modify: `crates/app/src/operator.rs` (free fns near `detect_decision_point` ~line 3898)
- Test: `crates/app/src/operator.rs` (`mod tests` ~line 4662)

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn working_phases_suppress_engage() {
        use karl_session::ExecutorPhase::*;
        for p in [
            Thinking,
            Running { cmd: "cargo test".into() },
            Reading { file: "x".into() },
            Writing { file: "y".into() },
        ] {
            let snap = (p, Some("claude".to_string()));
            assert!(should_suppress_for_phase(Some(&snap)), "{snap:?} must suppress");
        }
    }

    #[test]
    fn at_rest_phases_do_not_suppress() {
        use karl_session::ExecutorPhase::*;
        for p in [Idle, Waiting { reason: "y/n".into() }, Done { summary: None }] {
            let snap = (p, Some("claude".to_string()));
            assert!(!should_suppress_for_phase(Some(&snap)));
        }
    }

    #[test]
    fn no_agent_or_unregistered_does_not_suppress() {
        use karl_session::ExecutorPhase::*;
        assert!(!should_suppress_for_phase(None));
        // working phase but no foreground agent → not our concern, don't suppress
        let snap = (Running { cmd: "x".into() }, None);
        assert!(!should_suppress_for_phase(Some(&snap)));
    }
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p covenant --lib operator::tests::working_phases_suppress_engage`
Expected: FAIL — `cannot find function should_suppress_for_phase`.

- [ ] **Step 3: Implement** (add near `detect_decision_point`)

```rust
/// True when the executor is actively working and the operator must NOT
/// engage (no typing, no escalation). `Thinking`/`Running`/`Reading`/`Writing`
/// are busy; only `Waiting`/`Idle`/`Done` are at-rest states where the
/// operator may act.
fn executor_is_working(phase: &karl_session::ExecutorPhase) -> bool {
    use karl_session::ExecutorPhase::*;
    matches!(phase, Thinking | Running { .. } | Reading { .. } | Writing { .. })
}

/// Suppress this operator tick when an executor agent is in foreground AND it
/// is in a working phase. `snapshot` is the result of
/// `NotchHub::phase_snapshot`: `None` (session not registered / no agent) →
/// do NOT suppress (fall through to legacy idle/decision-point logic).
fn should_suppress_for_phase(
    snapshot: Option<&(karl_session::ExecutorPhase, Option<String>)>,
) -> bool {
    match snapshot {
        Some((phase, Some(_agent))) => executor_is_working(phase),
        _ => false,
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p covenant --lib operator::tests` (the three new tests pass; rest unaffected)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): phase-gate helper (working phases suppress engage)"
```

### Task A3: wire the gate into `run_tick`

**Files:**
- Modify: `crates/app/src/operator.rs` (`run_tick`, immediately after the `if !trigger_by_idle && !trigger_by_stable { continue; }` block ~line 188-201)

- [ ] **Step 1: Add the gate** (insert right after that `continue` guard, before loop-detection / LLM call)

```rust
        // PHASE GATE (spine): never engage while the executor agent is
        // actively working. Reading/Writing/Running/Thinking are busy; only
        // Waiting/Idle/Done are at-rest states where we may type or escalate.
        // Reads the live phase the notch hub already computes for the UI.
        // This prevents typing into a busy executor (the double-type loop)
        // and authoring "stuck/Whirlpooling" escalations during long work.
        if let Some(app_state) = app.try_state::<crate::AppState>() {
            let snap = app_state.notch_hub.phase_snapshot(session_id).await;
            if should_suppress_for_phase(snap.as_ref()) {
                tracing::debug!(
                    session = %session_id,
                    "operator gate: executor working — observing only"
                );
                continue;
            }
        }
```

- [ ] **Step 2: Ensure `tauri::Manager` is in scope**

`app.try_state` requires `tauri::Manager`. Confirm `use tauri::Manager;` (or `tauri::Manager` via a glob) is imported at the top of `operator.rs`; add it if missing.
Run: `rg -n "use tauri::" crates/app/src/operator.rs`

- [ ] **Step 3: Build + clippy**

Run: `cargo build -p covenant && cargo clippy -p covenant --lib 2>&1 | tail -20`
Expected: compiles; no new warnings in `operator.rs`.

- [ ] **Step 4: Run operator tests (no regressions)**

Run: `cargo test -p covenant --lib operator::tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): gate decision loop on live executor phase"
```

---

## Part B — Chrome normalizer + system prompt

Stop the LLM from reading Claude Code's spinner/timer/TUI chrome as state, in the rare at-rest ticks where it still runs.

### Task B1: `normalize_executor_chrome`

**Files:**
- Modify: `crates/app/src/operator.rs` (free fn next to `strip_spinner_churn` ~line 4076)
- Test: `crates/app/src/operator.rs` (`mod tests`)

- [ ] **Step 1: Write the failing tests**

```rust
    #[test]
    fn chrome_normalizer_strips_cc_status_lines() {
        let raw = "\
building project\n\
✱ Whirlpooling… (27m 51s · ↓ 19.6k tokens)\n\
  Tip: Use /permissions to pre-approve\n\
esc to interrupt · ctrl+o to expand\n\
error[E0382]: borrow of moved value\n";
        let out = normalize_executor_chrome(raw);
        assert!(!out.contains("Whirlpooling"), "spinner line leaked: {out:?}");
        assert!(!out.to_lowercase().contains("esc to interrupt"));
        assert!(!out.contains("ctrl+o"));
        assert!(!out.contains("Tip:"));
        // Real signal survives:
        assert!(out.contains("error[E0382]"));
        assert!(out.contains("building project"));
    }

    #[test]
    fn chrome_normalizer_strips_ghost_try_placeholder() {
        let raw = "Try \"refactor the parser\"\n> \n";
        let out = normalize_executor_chrome(raw);
        assert!(!out.contains("Try \""), "ghost placeholder leaked: {out:?}");
    }

    #[test]
    fn chrome_normalizer_keeps_real_prompt() {
        let raw = "Apply 3 migrations to prod? [y/N]\n";
        let out = normalize_executor_chrome(raw);
        assert!(out.contains("[y/N]"));
    }
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p covenant --lib operator::tests::chrome_normalizer`
Expected: FAIL — `cannot find function normalize_executor_chrome`.

- [ ] **Step 3: Implement** (place directly after `strip_spinner_churn`)

```rust
/// Strip Claude Code / agent TUI chrome from an already-ANSI-stripped excerpt
/// before it reaches the operator LLM. Removes whole lines that are spinner
/// gerunds, elapsed/token status, interrupt/expand hints, "Tip:" lines, and
/// ghost `Try "..."` input placeholders — none of which are executor state.
/// Real output, tool results, prompts, and errors are kept. Complements
/// `strip_spinner_churn` (which only removes inline glyph/timer churn for
/// hashing); this operates line-wise for the model excerpt.
fn normalize_executor_chrome(s: &str) -> String {
    use std::sync::OnceLock;
    static GERUND: OnceLock<Regex> = OnceLock::new();
    static GHOST_TRY: OnceLock<Regex> = OnceLock::new();
    // A spinner status line: optional leading glyph, a capitalized gerund with
    // ellipsis, optionally followed by a parenthesized timer/token recap.
    let gerund = GERUND.get_or_init(|| {
        Regex::new(r"^\s*[✶✷✸✹✺✻✦★☆◐◓◑◒*•∶∴]?\s*[A-Z][A-Za-z-]+ing(?:…|\.{3}).*$").unwrap()
    });
    let ghost_try = GHOST_TRY.get_or_init(|| Regex::new(r#"^\s*Try\s+".*"\s*$"#).unwrap());
    s.lines()
        .filter(|line| {
            let t = line.trim();
            if t.is_empty() {
                return true; // keep blank lines (cheap, preserves shape)
            }
            if gerund.is_match(t) || ghost_try.is_match(t) {
                return false;
            }
            let lower = t.to_lowercase();
            if lower.contains("esc to interrupt")
                || lower.contains("ctrl+o to expand")
                || lower.contains("ctrl+b to run in background")
                || lower.starts_with("tip:")
            {
                return false;
            }
            true
        })
        .map(strip_spinner_churn) // also remove inline timer/glyph churn per kept line
        .collect::<Vec<_>>()
        .join("\n")
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p covenant --lib operator::tests::chrome_normalizer`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): normalize_executor_chrome strips TUI chrome from LLM excerpt"
```

### Task B2: apply normalizer in `render_user_message`

**Files:**
- Modify: `crates/app/src/operator.rs` (`render_user_message` ~line 3854)

- [ ] **Step 1: Edit the excerpt construction**

Replace:
```rust
    let stripped = strip_ansi_escapes::strip_str(String::from_utf8_lossy(tail).as_ref());
    let excerpt = take_last_chars(&stripped, MODEL_EXCERPT_CHARS);
```
With:
```rust
    let stripped = strip_ansi_escapes::strip_str(String::from_utf8_lossy(tail).as_ref());
    let cleaned = normalize_executor_chrome(&stripped);
    let excerpt = take_last_chars(&cleaned, MODEL_EXCERPT_CHARS);
```

- [ ] **Step 2: Rewrite the CRITICAL READING NOTE** in the same `format!` (the block that currently says spinners "represent the CURRENT state — they are NOT stale history"). Replace that sentence region with:

```rust
         CRITICAL READING NOTE — the <executor_output> below is the \
         BOTTOM of the executor's terminal buffer (≈ last screen the \
         user can see), with spinner/timer/token status chrome already \
         removed. The executor is only handed to you when it is at REST \
         (waiting, idle, or just finished) — it is NOT actively working. \
         Decide based on whether the last lines show a question / numbered \
         menu / prompt glyph (`›` `❯` `>`): if so, the executor is waiting \
         on input. Never escalate merely because something looks slow or \
         long-running.\n\n\
```

- [ ] **Step 3: Build + run the existing render test (if any) + operator tests**

Run: `cargo test -p covenant --lib operator::tests`
Expected: PASS. (If a test asserted the old "CURRENT state" wording, update its expectation to match the new note.)

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): feed chrome-stripped excerpt + correct spinner framing to LLM"
```

---

## Part C — Reframe loop escalations (kill silent-flood sources)

With the phase gate, `general` and `idle-wait` loops should no longer ping (a working executor never engages; an idle-but-fine executor is not a ping trigger per the locked decision). Keep `repeat-reply` (executor genuinely not accepting input is a real "needs you").

### Task C1: suppress non-actionable loop escalations

**Files:**
- Modify: `crates/app/src/operator.rs` (the `let action = if looped { ... }` block ~line 308-339)
- Test: `crates/app/src/operator.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test** — a pure helper that decides whether a loop kind should escalate.

```rust
    #[test]
    fn only_repeat_reply_loop_escalates() {
        assert!(loop_should_escalate(Some("repeat-reply")));
        assert!(!loop_should_escalate(Some("general")));
        assert!(!loop_should_escalate(Some("idle-wait")));
        assert!(!loop_should_escalate(None));
    }
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p covenant --lib operator::tests::only_repeat_reply_loop_escalates`
Expected: FAIL — `cannot find function loop_should_escalate`.

- [ ] **Step 3: Implement helper** (near the other operator free fns)

```rust
/// Which loop-detector outcomes still warrant a user ping. With the phase
/// gate in place, `general` and `idle-wait` loops indicate a working or
/// merely-idle executor — neither is one of the four ping triggers, so they
/// only cool the tab + note the world model. `repeat-reply` means the
/// executor is genuinely not accepting our input → a real "needs you".
fn loop_should_escalate(kind: Option<&str>) -> bool {
    matches!(kind, Some("repeat-reply"))
}
```

- [ ] **Step 4: Use it in the `looped` handling.** Change the block so a detected loop still sets the cooldown (already done in the detector block) but only converts to `Escalate` when `loop_should_escalate(loop_kind)`; otherwise keep the original parsed action as `Wait` and log. Replace:

```rust
        let action = if looped {
            tracing::warn!( /* ...existing... */ );
            let why = match loop_kind { /* ...existing... */ };
            OperatorAction::Escalate { notification: why, rationale: /* ...existing... */ }
        } else {
            parsed_action
        };
```
With:
```rust
        let action = if looped && loop_should_escalate(loop_kind) {
            tracing::warn!(
                session = %session_id,
                cooldown_secs = LOOP_COOLDOWN.as_secs(),
                kind = loop_kind.unwrap_or("?"),
                "operator repeat-reply loop — escalating (executor not accepting input)"
            );
            OperatorAction::Escalate {
                notification: format!(
                    "Your executor isn't accepting input — I typed the same reply twice and it didn't take. It may need Enter pressed manually, or the submit key is wrong for this TUI. Paused {}s.",
                    LOOP_COOLDOWN.as_secs()
                ),
                rationale: format!(
                    "loop guard (repeat-reply): action={} parked to avoid runaway cost",
                    parsed_action.kind()
                ),
            }
        } else if looped {
            // general / idle-wait: cool the tab silently. Not a ping trigger.
            tracing::info!(
                session = %session_id,
                kind = loop_kind.unwrap_or("?"),
                "operator loop cooled silently (not a ping trigger)"
            );
            OperatorAction::Wait {
                rationale: format!("loop guard ({}): cooled silently", loop_kind.unwrap_or("?")),
            }
        } else {
            parsed_action
        };
```

- [ ] **Step 5: Run, verify pass + no regressions**

Run: `cargo test -p covenant --lib operator::tests`
Expected: PASS. (If an existing test asserted idle-wait/general produced an `Escalate`, update it to expect a silent `Wait` — this is the intended behavior change.)

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): only repeat-reply loops ping; general/idle cool silently"
```

---

## Part D — Coalescer + contextual buttons + richer message

Dedup repeated escalations into one self-updating Telegram message, and make the message data-rich.

### Task D1: coalescer state on `OutboundState`

**Files:**
- Modify: `crates/app/src/telegram/outbound.rs` (`OutboundState` ~line 13)
- Test: `crates/app/src/telegram/mod.rs` (`mod tests` ~line 287)

- [ ] **Step 1: Extend `OutboundState`** — add an active-ping map keyed by `(session_id, kind)`.

```rust
use std::time::Instant;

/// One live (unresolved) escalation we may coalesce onto instead of posting
/// a duplicate. Keyed by (session_id, escalation-kind) in `OutboundState`.
pub struct ActivePing {
    pub message_id: i64,
    pub escalation_id: String,
    pub last_sent: Instant,
    pub count: u32,
}

#[derive(Default)]
pub struct OutboundState {
    pub map: Mutex<HashMap<i64, String>>,            // message_id -> escalation_id
    pub session_map: Mutex<HashMap<String, String>>, // escalation_id -> session_id
    pub status: AtomicU8,
    /// (session_id, kind_key) -> live ping, for coalescing repeats.
    pub active: Mutex<HashMap<(String, String), ActivePing>>,
}

/// Stable string key for an EscalationKind so we can map without Hash derive.
pub fn kind_key(kind: &EscalationKind) -> String {
    format!("{kind:?}")
}
```
(Add `use std::time::Instant;` and ensure `EscalationKind` is imported in `outbound.rs`.)

- [ ] **Step 2: Build**

Run: `cargo build -p covenant`
Expected: compiles (field is unused for now — allow dead_code if clippy complains, it will be used in D2).

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/telegram/outbound.rs
git commit -m "feat(telegram): coalescer state (active-ping map) on OutboundState"
```

### Task D2: coalesce in `send_escalation`

**Files:**
- Modify: `crates/app/src/telegram/mod.rs` (`send_escalation` ~line 87, after `let chat = ...; drop(s);`)
- Test: `crates/app/src/telegram/mod.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test** — second identical escalation edits, doesn't re-send. Use the existing fake client (`client::fake`, see `mod tests` patterns like `send_escalation_records_message_id`). Model it on existing tests; assert the fake recorded exactly one `send_message` and ≥1 `edit_message_text` after two `send_escalation` calls with the same session+kind.

```rust
    #[tokio::test]
    async fn duplicate_escalation_edits_instead_of_resending() {
        let (notifier, fake) = test_notifier_enabled(); // helper used by existing tests
        let op = sample_operator_ref();
        let proj = sample_project_ref();
        let mk = |eid: &str| SendEscalationArgs {
            operator: &op, project: &proj, session_short: "abcd",
            kind: &EscalationKind::Loop, summary: "executor not accepting input",
            actions: &[OperatorAction::Reply], escalation_id: eid,
            session_id: "SESસame", tab_id: Some("SESસame"),
        };
        notifier.send_escalation(&mk("e1")).await.unwrap();
        notifier.send_escalation(&mk("e2")).await.unwrap();
        assert_eq!(fake.sent_count(), 1, "second identical escalation must not re-send");
        assert!(fake.edit_count() >= 1, "second escalation must edit the live message");
    }
```
(If the fake lacks `sent_count`/`edit_count`, add counters to `client::fake` in `client.rs` — small, mirror its existing recording. `test_notifier_enabled`/`sample_operator_ref`/`sample_project_ref`: reuse or add tiny helpers modeled on the existing `send_escalation_records_message_id` setup.)

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p covenant --lib telegram::tests::duplicate_escalation_edits_instead_of_resending`
Expected: FAIL (currently both calls send).

- [ ] **Step 3: Implement coalescing** — in `send_escalation`, after computing `token`/`chat` and building `ctx`, branch before the `send_message`:

```rust
    const COALESCE_WINDOW: std::time::Duration = std::time::Duration::from_secs(120);
    let key = (args.session_id.to_string(), outbound::kind_key(args.kind));
    {
        let mut active = self.state.active.lock().unwrap();
        if let Some(p) = active.get_mut(&key) {
            if p.last_sent.elapsed() < COALESCE_WINDOW {
                let mid = p.message_id;
                p.count += 1;
                p.last_sent = Instant::now();
                let count = p.count;
                drop(active);
                // Edit the live message in place; keep its keyboard.
                let text = format!("{}\n\n(updated ×{count})", format_message(&ctx));
                self.client
                    .edit_message_text(&token, &chat, mid, text, false)
                    .await?;
                return Ok(());
            }
        }
    }
```
Then, in the existing post-send bookkeeping (after `let result = self.client.send_message(...).await?;` records `map`/`session_map`), also record the active ping:
```rust
    self.state.active.lock().unwrap().insert(
        key,
        outbound::ActivePing {
            message_id: result.message_id,
            escalation_id: args.escalation_id.to_string(),
            last_sent: Instant::now(),
            count: 1,
        },
    );
```
(Imports: `use std::time::Instant;` in `mod.rs`.)

- [ ] **Step 4: Run, verify pass + existing telegram tests green**

Run: `cargo test -p covenant --lib telegram`
Expected: PASS (new test + existing).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/telegram/mod.rs crates/app/src/telegram/client.rs
git commit -m "feat(telegram): coalesce duplicate escalations into one edited message"
```

### Task D3: clear coalescer entry on resolve

**Files:**
- Modify: `crates/app/src/telegram/mod.rs` (`on_resolved` ~line 179)

- [ ] **Step 1: After `on_resolved` looks up & removes the `map` entry, also drop the matching `active` entry** so a future escalation of the same kind starts a fresh message:

```rust
    // Remove any coalescer entry pointing at this escalation so the next
    // escalation of the same kind posts a fresh message instead of editing
    // a resolved one.
    self.state
        .active
        .lock()
        .unwrap()
        .retain(|_, p| p.escalation_id != escalation_id);
```
(Place near the top of `on_resolved`, after `escalation_id` is available.)

- [ ] **Step 2: Build + telegram tests**

Run: `cargo test -p covenant --lib telegram`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/telegram/mod.rs
git commit -m "feat(telegram): drop coalescer entry on escalation resolve"
```

### Task D4: contextual buttons + richer message format

**Files:**
- Modify: `crates/app/src/telegram/outbound.rs` (`format_message` ~line 33)
- Modify: `crates/app/src/operator.rs` (escalation emit ~line 3150 — choose actions per kind)
- Test: `crates/app/src/telegram/outbound.rs` (`mod tests` ~line 125)

- [ ] **Step 1: Write the failing test** for the new format (header carries a trigger label; body kept).

```rust
    #[test]
    fn format_message_has_trigger_header_and_body() {
        let op = sample_operator_ref();
        let proj = sample_project_ref();
        let ctx = OutboundContext {
            operator: &op, project: &proj, session_short: "abcd",
            kind: &EscalationKind::Blocklist,
            summary: "blocked: git push --force to main",
            actions: &[OperatorAction::PushAndPR],
        };
        let m = format_message(&ctx);
        assert!(m.contains("blocked"), "kept the summary");
        assert!(m.contains("blocked"), "label present");
        // Repo/branch line preserved:
        assert!(m.contains(&proj.repo));
    }
```

- [ ] **Step 2: Run, verify fail/pass** (this may already pass for body; add the label assertion that fails)

Run: `cargo test -p covenant --lib telegram::outbound`

- [ ] **Step 3: Implement** — give `format_message` a trigger label derived from `kind`, and keep the existing body. Replace `format_message`:

```rust
fn trigger_label(kind: &EscalationKind) -> &'static str {
    match kind {
        EscalationKind::Blocklist => "blocked",
        EscalationKind::Loop => "needs you",
        EscalationKind::Blocked => "needs you",
    }
}

pub fn format_message(ctx: &OutboundContext) -> String {
    let trimmed = if ctx.summary.chars().count() > 500 {
        let mut s: String = ctx.summary.chars().take(499).collect();
        s.push('…');
        s
    } else {
        ctx.summary.to_string()
    };
    format!(
        "{emoji} {name} · {repo} ({branch})  —  {label}\n{trimmed}",
        emoji = display_emoji(&ctx.operator.emoji, &ctx.operator.color),
        name = ctx.operator.name,
        repo = ctx.project.repo,
        branch = ctx.project.branch,
        label = trigger_label(ctx.kind),
    )
}
```
(Match `EscalationKind`'s real variants — confirm them with `rg -n "enum EscalationKind" crates/session`. Adjust arms if there are more.)

- [ ] **Step 4: Contextual actions in operator emit.** In the `EscalationRequested` send (operator.rs ~3150), choose `actions` by `kind` instead of the fixed `[PushAndPR, Reply, Snooze]`:

```rust
                    let actions = match kind {
                        EscalationKind::Blocklist => vec![
                            SessionOperatorAction::PushAndPR, // "Approve once"-style; reuse
                            SessionOperatorAction::Reply,     // Reject
                            SessionOperatorAction::Snooze { minutes: 10 },
                        ],
                        EscalationKind::Loop | EscalationKind::Blocked => vec![
                            SessionOperatorAction::Reply,     // Reject / dismiss
                            SessionOperatorAction::Snooze { minutes: 10 },
                        ],
                    };
                    let _ = escalation_tx.send(SessionEvent::EscalationRequested {
                        session: session_id,
                        escalation_id,
                        kind,
                        summary: strip_ansi_escapes::strip_str(msg),
                        actions,
                        operator: op.to_session_ref(),
                        project: project_ref,
                    });
```
(Keep using the real `kind` value; note `kind` is moved into the event — compute `actions` before the send while `kind` is still borrowable, or clone `kind` for the match.)

- [ ] **Step 5: Run telegram + operator tests**

Run: `cargo test -p covenant --lib telegram && cargo test -p covenant --lib operator::tests`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/telegram/outbound.rs crates/app/src/operator.rs
git commit -m "feat(telegram): trigger-labeled message + contextual action buttons"
```

---

## Part E — Conversational inbound (English status reply, threaded)

Replace the Spanish scold with a real, English, threaded cross-tab status. Deterministic (no LLM) for this plan; LLM narrative is a follow-up (see Open Items).

### Task E1: `reply_to_message_id` on `SendMessageReq`

**Files:**
- Modify: `crates/app/src/telegram/types.rs` (`SendMessageReq` ~line 4)

- [ ] **Step 1: Add the field**

```rust
#[derive(Debug, Serialize)]
pub struct SendMessageReq {
    pub chat_id: String,
    pub text: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_markup: Option<InlineKeyboardMarkup>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reply_to_message_id: Option<i64>,
}
```

- [ ] **Step 2: Fix all existing `SendMessageReq { .. }` literals** to add `reply_to_message_id: None`.

Run: `rg -n "SendMessageReq \{" crates/app/src` — update each site (at least `mod.rs` `send_escalation`, `lib.rs` UnknownReply — the latter is replaced in E3).

- [ ] **Step 3: Build**

Run: `cargo build -p covenant`
Expected: compiles.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/telegram/types.rs crates/app/src/telegram/mod.rs
git commit -m "feat(telegram): SendMessageReq.reply_to_message_id for threaded replies"
```

### Task E2: inbound `Question` event

**Files:**
- Modify: `crates/app/src/telegram/inbound.rs` (`InboundEvent` ~line 10; the message-handling ~line 98-111; and the non-reply message path)
- Test: `crates/app/src/telegram/inbound.rs` (`#[cfg(test)]` ~line 184)

- [ ] **Step 1: Add a `Question` variant** to `InboundEvent` (replace `UnknownReply`):

```rust
#[derive(Debug)]
pub enum InboundEvent {
    Resolved { escalation_id: String, resolution: ResolutionFromTelegram },
    /// A free-text message that is NOT an answer to an open escalation:
    /// a non-reply message, or a reply to an already-closed escalation.
    /// Routed to the cross-tab status responder.
    Question { chat_id: i64, message_id: i64, text: String },
}
```

- [ ] **Step 2: Route messages.** In the inbound loop where messages are parsed: a reply to a known (open) escalation → `Resolved{FreeText}` (unchanged); a reply to an unknown/closed escalation → `Question`; a plain text message with no `reply_to` → `Question`. Replace the `reply_to_message` block (and add the no-reply branch):

```rust
                if let Some(text) = msg.text.clone() {
                    if let Some(reply) = msg.reply_to_message {
                        let known = {
                            let map = state.map.lock().unwrap();
                            map.get(&reply.message_id).cloned()
                        };
                        match known {
                            Some(eid) => {
                                let _ = tx.send(InboundEvent::Resolved {
                                    escalation_id: eid,
                                    resolution: ResolutionFromTelegram::FreeText(text),
                                });
                            }
                            None => {
                                let _ = tx.send(InboundEvent::Question {
                                    chat_id: msg.chat.id,
                                    message_id: msg.message_id,
                                    text,
                                });
                            }
                        }
                    } else {
                        let _ = tx.send(InboundEvent::Question {
                            chat_id: msg.chat.id,
                            message_id: msg.message_id,
                            text,
                        });
                    }
                }
```
(Adjust to the surrounding loop's variable names; `msg.message_id` and `msg.chat.id` exist per `IncomingMessage`/`Chat`.)

- [ ] **Step 3: Write/adjust a test** — a non-reply text message publishes `Question`. Model on the existing `reply_message_publishes_freetext` test.

```rust
    #[test]
    fn plain_message_publishes_question() {
        // build an Update with message.text = "what's going on?", no reply_to,
        // run the same parse routine the loop uses, assert InboundEvent::Question.
        // (Mirror the harness used by reply_message_publishes_freetext.)
    }
```
Fill in using that test's exact construction pattern.

- [ ] **Step 4: Run inbound tests**

Run: `cargo test -p covenant --lib telegram::inbound`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/telegram/inbound.rs
git commit -m "feat(telegram): inbound Question event for non-answer messages"
```

### Task E3: cross-tab status responder (replace Spanish scold)

**Files:**
- Modify: `crates/app/src/lib.rs` (inbound drain ~line 3224; replace the `UnknownReply` arm with a `Question` arm)
- Add: `crates/app/src/telegram/status.rs` (pure formatter) + register `mod status;`
- Test: `crates/app/src/telegram/status.rs`

- [ ] **Step 1: Write the failing test** for a pure status formatter.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::{ExecutorPhase, SessionEvent, SessionId};

    #[test]
    fn formats_cross_tab_status_in_english() {
        let evs = vec![
            SessionEvent::ExecutorStateChanged {
                session: SessionId::new(),
                phase: ExecutorPhase::Running { cmd: "cargo test".into() },
                agent: Some("claude".into()),
                tab_label: Some("main".into()),
            },
            SessionEvent::ExecutorStateChanged {
                session: SessionId::new(),
                phase: ExecutorPhase::Waiting { reason: "[y/N]".into() },
                agent: Some("claude".into()),
                tab_label: Some("api".into()),
            },
        ];
        let out = format_status(&evs);
        assert!(out.contains("main"));
        assert!(out.contains("working") || out.contains("cargo test"));
        assert!(out.contains("api"));
        assert!(out.contains("waiting"));
        assert!(!out.contains("escalación")); // no Spanish
    }

    #[test]
    fn empty_status_is_friendly_english() {
        assert!(format_status(&[]).to_lowercase().contains("nothing"));
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p covenant --lib telegram::status`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement `status.rs`**

```rust
//! Deterministic English cross-tab status reply for inbound Telegram
//! questions ("what's going on?"). Reads the notch hub's current phase per
//! session — no LLM call.

use karl_session::{ExecutorPhase, SessionEvent};

fn phase_phrase(p: &ExecutorPhase) -> String {
    match p {
        ExecutorPhase::Idle => "idle".into(),
        ExecutorPhase::Thinking => "working (thinking)".into(),
        ExecutorPhase::Running { cmd } => format!("working — running `{cmd}`"),
        ExecutorPhase::Reading { file } => format!("working — reading {file}"),
        ExecutorPhase::Writing { file } => format!("working — writing {file}"),
        ExecutorPhase::Waiting { reason } => format!("waiting on you ({reason})"),
        ExecutorPhase::Done { .. } => "finished — at rest".into(),
    }
}

/// Render a one-line-per-tab status report from notch snapshots.
pub fn format_status(events: &[SessionEvent]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for ev in events {
        if let SessionEvent::ExecutorStateChanged { phase, agent, tab_label, session } = ev {
            if agent.is_none() {
                continue;
            }
            let tab = tab_label
                .clone()
                .unwrap_or_else(|| format!("session:{}", &session.to_string()[..6.min(session.to_string().len())]));
            lines.push(format!("• {tab} — {}", phase_phrase(phase)));
        }
    }
    if lines.is_empty() {
        return "Nothing active right now — no executor agents are running.".into();
    }
    format!("Here's what's going on:\n{}", lines.join("\n"))
}
```
Register the module: add `pub mod status;` to `crates/app/src/telegram/mod.rs`.

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p covenant --lib telegram::status`
Expected: PASS.

- [ ] **Step 5: Wire the drain arm** in `lib.rs`. Replace the `InboundEvent::UnknownReply { .. }` arm with:

```rust
                crate::telegram::InboundEvent::Question { chat_id, message_id, text: _ } => {
                    let snap = if let Some(state) = app_handle_for_drain.try_state::<AppState>() {
                        state.notch_hub.snapshot().await
                    } else {
                        Vec::new()
                    };
                    let body = crate::telegram::status::format_status(&snap);
                    let s = tg_for_drain.settings.lock().await;
                    let token = s.telegram.bot_token.clone();
                    let chat = chat_id.to_string();
                    drop(s);
                    if !token.is_empty() {
                        let _ = tg_for_drain
                            .client
                            .send_message(
                                &token,
                                crate::telegram::types::SendMessageReq {
                                    chat_id: chat,
                                    text: body,
                                    reply_markup: None,
                                    parse_mode: None,
                                    reply_to_message_id: Some(message_id),
                                },
                            )
                            .await;
                    }
                }
```
(`AppState` is already referenced in this task via `app_handle_for_drain.try_state::<AppState>()` for PTY inject; `tauri::Manager` is in scope there.)

- [ ] **Step 6: Build + run**

Run: `cargo build -p covenant && cargo test -p covenant --lib telegram`
Expected: compiles; PASS.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/lib.rs crates/app/src/telegram/mod.rs crates/app/src/telegram/status.rs
git commit -m "feat(telegram): English threaded cross-tab status reply (kills Spanish scold)"
```

### Task E4: English-ify the familiar summary headers

**Files:**
- Modify: `crates/familiar/src/prompts.rs` (`summary_prompt` ~line 84-88)

- [ ] **Step 1: Translate the hardcoded Spanish section headers** to English (they contradict the prompt's own "respond in the coordinator's language" instruction). Replace:

```
## Decisiones autónomas
## Costos
## Bloqueos resueltos
## Misiones
## Open items pendientes
```
With:
```
## Autonomous decisions
## Costs
## Blockers resolved
## Missions
## Open items
```

- [ ] **Step 2: Build the familiar crate**

Run: `cargo build -p familiar` (confirm package name with `rg -n '^name' crates/familiar/Cargo.toml`; adjust if different)
Expected: compiles.

- [ ] **Step 3: Commit**

```bash
git add crates/familiar/src/prompts.rs
git commit -m "fix(familiar): English section headers (English-first copy)"
```

---

## Part F — Activity feed richness

Persist + surface the escalation text and in-flight context the feed currently discards.

### Task F1: persist `escalation` + `trigger_class` columns

**Files:**
- Modify: `crates/app/src/storage.rs` (migration block ~line 521-599; `OperatorDecisionRow` ~411; `save_operator_decision` ~1219; `list_operator_decisions` ~1514)
- Test: `crates/app/src/storage.rs` (`mod tests` ~line 3007)

- [ ] **Step 1: Write the failing test** — save a decision with escalation text, list it back.

```rust
    #[tokio::test]
    async fn persists_and_reads_escalation_text() {
        let (s, _g) = fresh();
        let sid = SessionId::new();
        let id = s
            .save_operator_decision(
                sid, 1, Some("claude".into()), "out".into(), "escalate".into(),
                None, Some("rat".into()), false, 0.0, None, Some("claude".into()),
                None, None, None,
                Some("Your executor isn't accepting input".into()), // new: escalation
            )
            .await
            .unwrap();
        let rows = s.list_operator_decisions(10).await.unwrap();
        let row = rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(row.escalation.as_deref(), Some("Your executor isn't accepting input"));
    }
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p covenant --lib storage::tests::persists_and_reads_escalation_text`
Expected: FAIL — arg count / field missing.

- [ ] **Step 3: Add idempotent migrations** (in `Storage::open()` migration block):

```rust
        let _ = conn.execute(
            "ALTER TABLE operator_decisions ADD COLUMN escalation TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE operator_decisions ADD COLUMN trigger_class TEXT",
            [],
        );
```

- [ ] **Step 4: Add `escalation: Option<String>` to `OperatorDecisionRow`** (after `rationale`), add the param to `save_operator_decision` (new last arg `escalation: Option<String>`), include it in the `INSERT` column list/params, and `SELECT` + map it in `list_operator_decisions`.

In `save_operator_decision` signature add: `escalation: Option<String>,` (last param). INSERT becomes:
```rust
            "INSERT INTO operator_decisions
             (session_id, timestamp_unix_ms, in_flight_command,
              output_excerpt, action, reply_text, rationale, executed,
              cost_usd, mission_path, executor_name, operator_id, operator_name,
              applied_memory_id, escalation)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
            params![ /* ...existing 14... */ , escalation ],
```
In `list_operator_decisions`, add `escalation` to the `SELECT` and to the row map: `escalation: r.get(15)?,` (after the existing 0..14 columns — keep index order consistent with the SELECT list).

- [ ] **Step 5: Update the caller** `operator.rs` `save_operator_decision(...)` (~3036) — pass the escalation text. For `Escalate` actions pass the notification; otherwise `None`:
```rust
                escalation_for_row, // = match &action { OperatorAction::Escalate { notification, .. } => Some(notification.clone()), _ => None }
```
Add a `let escalation_for_row = ...;` before the call.

- [ ] **Step 6: Run + build**

Run: `cargo test -p covenant --lib storage::tests && cargo build -p covenant`
Expected: PASS / compiles.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/storage.rs crates/app/src/operator.rs
git commit -m "feat(storage): persist escalation text + trigger_class on operator decisions"
```

### Task F2: expose `escalation` + `in_flight_command` to the UI

**Files:**
- Modify: `crates/app/src/storage.rs` (`OperatorDecisionRow` already updated) — confirm `in_flight_command` is already in the row (it is).
- Modify: `ui/src/api.ts` (`OperatorDecisionRow` ~851) — add `escalation: string | null;` and `trigger_class: string | null;`
- (`in_flight_command`, `output_excerpt` already on the api.ts row.)

- [ ] **Step 1: Add fields to the api.ts interface**

```typescript
  /// Escalation notification text (only for action === "escalate").
  escalation: string | null;
  /// Trigger class tag for coalescing/grouping (null for legacy rows).
  trigger_class: string | null;
```

- [ ] **Step 2: Typecheck**

Run: `npm run build`
Expected: passes (`tsc` clean).

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): escalation + trigger_class on OperatorDecisionRow type"
```

### Task F3: expandable activity rows with full detail

**Files:**
- Modify: `ui/src/teammate/activity-view.ts` (`DecisionEvent` ~23, `ActEvent` ~46, `absorbDecisionEvent` ~307, `renderSingle` ~559)
- Test: `ui/src/teammate/activity-view.test.ts` (new vitest file)

- [ ] **Step 1: Write the failing vitest** for `bodyForDecision` already preferring escalation, plus a new `detailFor` helper that returns the in-flight command + full escalation/rationale.

```typescript
import { describe, it, expect } from "vitest";
import { detailForDecision } from "./activity-view";

describe("activity detail", () => {
  it("includes in-flight command and full escalation", () => {
    const d = detailForDecision({
      kind: "escalated",
      inFlightCommand: "claude --dangerously-skip-permissions",
      escalation: "Your executor isn't accepting input",
      rationale: "loop guard (repeat-reply)",
      replyText: null,
      outputExcerpt: "…tail…",
    });
    expect(d).toContain("claude --dangerously-skip-permissions");
    expect(d).toContain("Your executor isn't accepting input");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `npm run test -- activity-view`
Expected: FAIL — `detailForDecision` not exported.

- [ ] **Step 3: Implement** — extend `DecisionEvent` with `in_flight_command?: string | null; output_excerpt?: string | null;` (populated from the list API), carry them onto `ActEvent` (add `inFlightCommand`, `escalationFull`, `rationaleFull`, `outputTail` optional fields), set them in `absorbDecisionEvent`, and export:

```typescript
export function detailForDecision(d: {
  kind: string;
  inFlightCommand?: string | null;
  escalation?: string | null;
  rationale?: string | null;
  replyText?: string | null;
  outputExcerpt?: string | null;
}): string {
  const parts: string[] = [];
  if (d.inFlightCommand) parts.push(`$ ${d.inFlightCommand}`);
  if (d.kind === "escalated" && d.escalation) parts.push(d.escalation);
  if (d.rationale) parts.push(d.rationale);
  if (d.replyText) parts.push(`reply: ${d.replyText}`);
  if (d.outputExcerpt) parts.push(d.outputExcerpt.slice(-400));
  return parts.join("\n");
}
```
In `renderSingle`, when the row is `escalated` (or any row with non-empty detail), render an `expand` button + a hidden `<div class="tp-act-detail">${escapeHtml(detail)}</div>` (mirror the existing `renderRun` expand markup so the panel's existing click handler toggles it; if a click handler exists for `data-action="expand-run"`, add a `data-action="expand-detail"` handler or reuse the same toggle class). Persist the full text in the DOM (not just `title`) so it survives re-render.

- [ ] **Step 4: Wire the new fields through the fetch** — the panel that calls `listOperatorDecisions` and feeds `absorbDecisionEvent` must pass `in_flight_command`/`output_excerpt`/`escalation` from the api row into `DecisionEvent`. Confirm with `rg -n "absorbDecisionEvent|listOperatorDecisions" ui/src`.

- [ ] **Step 5: Run + typecheck**

Run: `npm run test -- activity-view && npm run build`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add ui/src/teammate/activity-view.ts ui/src/teammate/activity-view.test.ts
git commit -m "feat(ui): expandable activity rows surfacing escalation + in-flight command"
```

---

## Part G — Verification

### Task G1: full test sweep

- [ ] **Step 1: Backend**

Run: `cargo test -p covenant && cargo test -p karl-blocks`
Expected: all PASS.

- [ ] **Step 2: UI**

Run: `npm run test && npm run build`
Expected: vitest PASS, `tsc` clean.

- [ ] **Step 3: Clippy**

Run: `cargo clippy -p covenant --lib 2>&1 | tail -30`
Expected: no new warnings in touched files.

### Task G2: golden manual scenario (the screenshot)

- [ ] **Step 1: Reproduce-and-confirm.** With a Claude Code executor tab running a long `cargo test` (so `NotchHub` reports `Running`/`Thinking` for minutes), confirm via logs (`RUST_LOG=debug`) that the operator logs `operator gate: executor working — observing only` and emits **zero** `EscalationRequested` events for that tab. Then let the executor reach a real `[y/N]` prompt and confirm a single `needs you` Telegram message appears (not a flood), with contextual buttons.

- [ ] **Step 2: Inbound.** From Telegram, send "what's going on?" as a **non-reply** message → confirm an English, threaded cross-tab status reply (no Spanish, no scold).

- [ ] **Step 3: Coalescing.** Force two escalations of the same kind within 120s (e.g. two repeat-reply loops) → confirm one message that edits to "(updated ×2)", not two messages.

- [ ] **Step 4: Record results** in the PR description with the observed log lines / screenshots.

---

## Open Items (explicit follow-ups, not in this plan)

1. **LLM-synthesized status narrative.** E3 ships a deterministic phase list. Upgrading to a natural-language report over per-session world-model summaries needs a world-model handle reachable from the inbound drain; defer until that handle exists.
2. **Auto-resolve on phase transition.** Editing a live ping to "✏️ resolved itself" when the executor resumes needs a notch→coalescer signal (subscribe the telegram notifier to `ExecutorStateChanged`). Valuable, but more plumbing; D3 already clears coalescer state on explicit resolve.
3. **Mission-done execution button.** `[Approve push]` notify-only for now (per spec decision); wiring it to actually push/PR touches the blocklist/protected-branch path.
4. **`Failure` trigger polish.** Rides existing `MissionFailed`/`send_mission_event`; routing it through the new coalescer + format is a small follow-up.
5. **Retry button on `Failure`.** Out of scope (spec).
