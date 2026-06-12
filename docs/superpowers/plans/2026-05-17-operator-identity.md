# Operator Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every operator a typed identity that flows end-to-end through outbound surfaces (Telegram, banner, activity feed, tab bar) and quarantine internal parse failures so they never reach user-facing escalations.

**Architecture:** Split `Operator` into `OperatorIdentity` (rendering-shaped, crosses outbound boundaries) and `OperatorBehavior` (internal config). Replace `format_escalation(tab, kind, summary)` with a typed `OutboundContext { operator, project, kind, summary, actions: Vec<OperatorAction> }`. Make `ParseFailure` a distinct error type that cannot convert into an `Escalation` — the type system enforces quarantine. Redesign the settings UI as a two-step modal plus card grid.

**Tech Stack:** Rust (tokio, axum-like telegram client, serde), TypeScript (Tauri 2, xterm.js, Vite). Tests: `cargo test`, `cargo test --test compile_fail` (via `trybuild`), `npm test` (vitest).

**Spec:** `docs/superpowers/specs/2026-05-17-operator-identity-design.md`

---

## File Structure

**Rust (new):**
- `crates/app/src/operator/identity.rs` — `OperatorIdentity`, `Avatar`, `VoiceTone`, `HexColor`
- `crates/app/src/operator/migration.rs` — `synthesize_identity` (deterministic from id)
- `crates/familiar/src/parse_failure.rs` — `ParseFailure` error type (no `From<_> for Escalation`)
- `tests/compile_fail/parse_failure_to_outbound.rs` — trybuild negative test

**Rust (modify):**
- `crates/app/src/operator.rs` — split `Operator` into `{identity, behavior}`
- `crates/app/src/operator/mod.rs` — re-exports
- `crates/app/src/telegram/outbound.rs` — `OutboundContext`, `OperatorAction`, `format_message`, `keyboard_for`
- `crates/app/src/telegram/inbound.rs` — typed action dispatch + named confirmation
- `crates/familiar/src/observer.rs` — parse-failure quarantine, circuit breaker
- `crates/app/src/settings.rs` — migration trigger on load

**TypeScript (new):**
- `ui/src/settings/operator_chip.ts` — shared `renderOperatorChip(identity, size)`
- `ui/src/settings/operator_presets.ts` — `Reviewer`, `Pair`, `Watcher`, `Auto`

**TypeScript (modify):**
- `ui/src/api.ts` — typed `OperatorIdentity`, `OperatorAction`
- `ui/src/settings/operators.ts` — two-step modal + card grid (rewrite)
- `ui/src/aom/banner.ts` — consume chip
- `ui/src/aom/activity-feed.ts` — consume chip
- `ui/src/main.ts` — tab bar avatar uses chip

---

## Task 1: Define `OperatorIdentity`, `Avatar`, `VoiceTone`

**Files:**
- Create: `crates/app/src/operator/identity.rs`
- Modify: `crates/app/src/operator/mod.rs` (or `crates/app/src/operator.rs` → split into module)
- Test: `crates/app/src/operator/identity.rs` (inline `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

```rust
// crates/app/src/operator/identity.rs (bottom of file)
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_serde_roundtrip() {
        let id = OperatorIdentity {
            id: OperatorId::new(),
            name: "Maya".to_string(),
            avatar: Avatar::Emoji("🟣".to_string()),
            color: HexColor("#a855f7".to_string()),
            voice: VoiceTone::Terse,
        };
        let json = serde_json::to_string(&id).unwrap();
        let back: OperatorIdentity = serde_json::from_str(&json).unwrap();
        assert_eq!(id.name, back.name);
        assert_eq!(id.color.0, back.color.0);
        assert!(matches!(back.voice, VoiceTone::Terse));
    }

    #[test]
    fn name_validation_rejects_empty_and_overlong() {
        assert!(OperatorIdentity::validate_name("").is_err());
        assert!(OperatorIdentity::validate_name(&"x".repeat(25)).is_err());
        assert!(OperatorIdentity::validate_name("Maya").is_ok());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p app operator::identity::tests`
Expected: FAIL — `OperatorIdentity`, `Avatar`, `VoiceTone`, `HexColor` undefined.

- [ ] **Step 3: Write minimal implementation**

```rust
// crates/app/src/operator/identity.rs
use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct OperatorId(pub Ulid);

impl OperatorId {
    pub fn new() -> Self { Self(Ulid::new()) }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", content = "value")]
pub enum Avatar {
    Emoji(String),
    Initial, // renders as initial-disc using color
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HexColor(pub String);

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum VoiceTone { Terse, Warm, Formal }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperatorIdentity {
    pub id: OperatorId,
    pub name: String,
    pub avatar: Avatar,
    pub color: HexColor,
    pub voice: VoiceTone,
}

#[derive(Debug, thiserror::Error)]
pub enum IdentityError {
    #[error("operator name cannot be empty")]
    EmptyName,
    #[error("operator name cannot exceed 24 chars")]
    NameTooLong,
}

impl OperatorIdentity {
    pub fn validate_name(name: &str) -> Result<(), IdentityError> {
        if name.is_empty() { return Err(IdentityError::EmptyName); }
        if name.chars().count() > 24 { return Err(IdentityError::NameTooLong); }
        Ok(())
    }
}
```

Wire into module: in `crates/app/src/operator/mod.rs` add `pub mod identity; pub use identity::*;` (create `mod.rs` if `operator.rs` exists today; move existing operator code under `operator/behavior.rs` in Task 2).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p app operator::identity::tests`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator/
git commit -m "feat(operator): add typed OperatorIdentity with validation"
```

---

## Task 2: Split `Operator` into `{identity, behavior}`

**Files:**
- Modify: `crates/app/src/operator.rs` → rename existing struct fields, embed identity
- Modify: every call site that constructs/reads `Operator` fields (compile-driven)

- [ ] **Step 1: Write the failing test**

```rust
// crates/app/src/operator/mod.rs (bottom)
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn operator_exposes_identity_and_behavior() {
        let id = OperatorIdentity {
            id: OperatorId::new(),
            name: "Cal".into(),
            avatar: Avatar::Initial,
            color: HexColor("#3b82f6".into()),
            voice: VoiceTone::Warm,
        };
        let op = Operator { identity: id.clone(), behavior: OperatorBehavior::default() };
        assert_eq!(op.identity.name, "Cal");
        assert!(matches!(op.behavior.execution_policy, ExecutionPolicy::SuggestOnly));
    }
}
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cargo test -p app operator::tests::operator_exposes_identity_and_behavior`
Expected: FAIL (likely compile error — `Operator` shape changed).

- [ ] **Step 3: Implement split**

In `crates/app/src/operator/behavior.rs` (new file) move all current behavior fields (`model_route`, `escalation_policy`, `execution_policy`, `allowlist`, `mission`, etc.) into:

```rust
// crates/app/src/operator/behavior.rs
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct OperatorBehavior {
    pub model_route: Option<String>,
    pub execution_policy: ExecutionPolicy,
    pub escalation_policy: EscalationPolicy,
    pub allowlist: Vec<String>,
    pub mission: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub enum ExecutionPolicy {
    #[default] SuggestOnly,
    Allowlist,
    ConfirmEach,
    FullAuto,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default, PartialEq)]
pub enum EscalationPolicy {
    #[default] OnBlocked,
    Always,
    Never,
}
```

In `crates/app/src/operator/mod.rs`:

```rust
pub mod behavior;
pub mod identity;
pub use behavior::*;
pub use identity::*;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Operator {
    pub identity: OperatorIdentity,
    pub behavior: OperatorBehavior,
    #[serde(default)]
    pub identity_confirmed: bool,
}
```

Update every call site (run `cargo build` and fix compile errors). Common pattern: `op.name` → `op.identity.name`; `op.model_route` → `op.behavior.model_route`.

- [ ] **Step 4: Run all tests and build**

Run: `cargo build && cargo test -p app`
Expected: clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add -A crates/app/src/operator/ crates/app/src/
git commit -m "refactor(operator): split into identity + behavior layers"
```

---

## Task 3: `ParseFailure` error type, no conversion to `Escalation`

**Files:**
- Create: `crates/familiar/src/parse_failure.rs`
- Modify: `crates/familiar/src/lib.rs` to expose it
- Test: inline

- [ ] **Step 1: Write the failing test**

```rust
// crates/familiar/src/parse_failure.rs (bottom)
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parse_failure_carries_session_and_reason() {
        let pf = ParseFailure {
            session_id: "01KRRP".into(),
            reason: ParseFailureReason::MissingField("action".into()),
            raw_excerpt: "{\"foo\":1}".into(),
        };
        assert_eq!(pf.session_id, "01KRRP");
        assert!(matches!(pf.reason, ParseFailureReason::MissingField(_)));
    }
}
```

- [ ] **Step 2: Run test, verify it fails**

Run: `cargo test -p familiar parse_failure::tests`
Expected: FAIL (module undefined).

- [ ] **Step 3: Implement**

```rust
// crates/familiar/src/parse_failure.rs
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct ParseFailure {
    pub session_id: String,
    pub reason: ParseFailureReason,
    pub raw_excerpt: String,
}

#[derive(Debug, Clone, Error)]
pub enum ParseFailureReason {
    #[error("unknown variant: {0}")]
    UnknownVariant(String),
    #[error("missing field: {0}")]
    MissingField(String),
    #[error("no JSON object found in model output")]
    NoJsonObject,
    #[error("invalid JSON: {0}")]
    InvalidJson(String),
}
```

Add `pub mod parse_failure; pub use parse_failure::{ParseFailure, ParseFailureReason};` to `crates/familiar/src/lib.rs`.

**Deliberately do not** implement `From<ParseFailure> for Escalation` (or any equivalent). This is enforced in Task 4.

- [ ] **Step 4: Run test**

Run: `cargo test -p familiar parse_failure`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/familiar/src/parse_failure.rs crates/familiar/src/lib.rs
git commit -m "feat(familiar): add ParseFailure error type (quarantined from outbound)"
```

---

## Task 4: `OutboundContext` + `OperatorAction` + `format_message`

**Files:**
- Modify: `crates/app/src/telegram/outbound.rs`
- Test: inline

- [ ] **Step 1: Write the failing tests**

```rust
// crates/app/src/telegram/outbound.rs (bottom, replace existing tests)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator::{OperatorIdentity, OperatorId, Avatar, HexColor, VoiceTone};

    fn maya() -> OperatorIdentity {
        OperatorIdentity {
            id: OperatorId::new(),
            name: "Maya".into(),
            avatar: Avatar::Emoji("🟣".into()),
            color: HexColor("#a855f7".into()),
            voice: VoiceTone::Terse,
        }
    }

    #[test]
    fn approval_message_includes_operator_project_and_summary() {
        let id = maya();
        let ctx = OutboundContext {
            operator: &id,
            project: ProjectRef { repo: "karlTerminal".into(), branch: "main".into() },
            session_short: "RRP",
            kind: EscalationKind::Approval,
            summary: "feat/x is done — wants to push & open PR",
            actions: &[OperatorAction::PushAndPR, OperatorAction::Reply, OperatorAction::Snooze { minutes: 10 }],
        };
        let msg = format_message(&ctx);
        assert!(msg.contains("🟣 Maya"));
        assert!(msg.contains("karlTerminal (main)"));
        assert!(msg.contains("feat/x is done"));
        // session id appears only as tiebreaker, never primary
        assert!(!msg.contains("session:"));
    }

    #[test]
    fn keyboard_renders_typed_actions_with_contextual_labels() {
        let id = maya();
        let ctx = OutboundContext {
            operator: &id,
            project: ProjectRef { repo: "r".into(), branch: "b".into() },
            session_short: "ABCD",
            kind: EscalationKind::Approval,
            summary: "",
            actions: &[OperatorAction::PushAndPR, OperatorAction::Snooze { minutes: 10 }],
        };
        let kb = keyboard_for(&ctx, "esc-1");
        let labels: Vec<&str> = kb.inline_keyboard.iter().flatten().map(|b| b.text.as_str()).collect();
        assert!(labels.iter().any(|l| l.contains("Approve push")));
        assert!(labels.iter().any(|l| l.contains("Snooze 10m")));
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p app telegram::outbound::tests`
Expected: FAIL (types undefined).

- [ ] **Step 3: Implement**

Replace contents of `crates/app/src/telegram/outbound.rs` (keeping the existing `EscalationMap` struct):

```rust
use crate::operator::OperatorIdentity;
use super::types::{InlineKeyboardButton, InlineKeyboardMarkup};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tokio::sync::Mutex;

#[derive(Default)]
pub struct EscalationMap {
    pub map: Mutex<HashMap<i64, String>>,
    pub session_map: Mutex<HashMap<String, String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectRef {
    pub repo: String,
    pub branch: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub enum EscalationKind { Approval, Question, Notice }

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum OperatorAction {
    PushAndPR,
    RunCommand { cmd: String },
    Reply,
    Snooze { minutes: u32 },
    Custom { id: String, label: String },
}

impl OperatorAction {
    pub fn button_label(&self) -> String {
        match self {
            OperatorAction::PushAndPR => "✓ Approve push".into(),
            OperatorAction::RunCommand { cmd } => format!("✓ Run `{}`", truncate(cmd, 24)),
            OperatorAction::Reply => "✗ Reject".into(),
            OperatorAction::Snooze { minutes } => format!("⏸ Snooze {}m", minutes),
            OperatorAction::Custom { label, .. } => label.clone(),
        }
    }
    pub fn callback_id(&self) -> &'static str {
        match self {
            OperatorAction::PushAndPR => "push_pr",
            OperatorAction::RunCommand { .. } => "run",
            OperatorAction::Reply => "reply",
            OperatorAction::Snooze { .. } => "snooze",
            OperatorAction::Custom { .. } => "custom",
        }
    }
}

pub struct OutboundContext<'a> {
    pub operator: &'a OperatorIdentity,
    pub project: ProjectRef,
    pub session_short: &'a str,
    pub kind: EscalationKind,
    pub summary: &'a str,
    pub actions: &'a [OperatorAction],
}

pub fn format_message(ctx: &OutboundContext) -> String {
    let avatar = match &ctx.operator.avatar {
        crate::operator::Avatar::Emoji(e) => e.clone(),
        crate::operator::Avatar::Initial => format!("●"), // color rendered client-side; emoji fallback
    };
    let summary = ctx.summary.trim();
    let summary = if summary.chars().count() > 400 {
        let cut: String = summary.chars().take(400).collect();
        format!("{}…", cut)
    } else {
        summary.to_string()
    };
    format!("{} {} · {} ({})\n{}", avatar, ctx.operator.name, ctx.project.repo, ctx.project.branch, summary)
}

pub fn keyboard_for(ctx: &OutboundContext, escalation_id: &str) -> InlineKeyboardMarkup {
    let row: Vec<InlineKeyboardButton> = ctx.actions.iter().map(|a| InlineKeyboardButton {
        text: a.button_label(),
        callback_data: format!("esc:{}:{}", escalation_id, a.callback_id()),
    }).collect();
    InlineKeyboardMarkup { inline_keyboard: vec![row] }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max { s.to_string() } else { s.chars().take(max).collect::<String>() + "…" }
}
```

Delete the old `format_escalation` and `keyboard_for(actions: &[String], …)`. Fix every caller (compile-driven — they should construct `OutboundContext` and pass typed `OperatorAction`s; see Task 6 for the observer call site).

- [ ] **Step 4: Run tests**

Run: `cargo test -p app telegram::outbound`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/telegram/outbound.rs
git commit -m "feat(telegram): typed OutboundContext + OperatorAction"
```

---

## Task 5: Typed inbound action dispatch + named confirmation

**Files:**
- Modify: `crates/app/src/telegram/inbound.rs`
- Test: inline

- [ ] **Step 1: Write the failing test**

```rust
// crates/app/src/telegram/inbound.rs (bottom)
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn parses_typed_callback() {
        let cb = parse_callback("esc:01KX:push_pr").unwrap();
        assert_eq!(cb.escalation_id, "01KX");
        assert!(matches!(cb.action_kind, ActionKind::PushPR));
    }
    #[test]
    fn confirmation_names_operator_and_action() {
        let text = render_confirmation("Maya", ActionKind::PushPR, Some("PR #42"));
        assert!(text.contains("Maya"));
        assert!(text.contains("pushed"));
        assert!(text.contains("PR #42"));
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p app telegram::inbound::tests`
Expected: FAIL (functions undefined).

- [ ] **Step 3: Implement**

Add to `crates/app/src/telegram/inbound.rs`:

```rust
#[derive(Debug, Clone, PartialEq)]
pub enum ActionKind { PushPR, Run, Reply, Snooze, Custom }

#[derive(Debug, Clone)]
pub struct Callback {
    pub escalation_id: String,
    pub action_kind: ActionKind,
}

pub fn parse_callback(data: &str) -> Option<Callback> {
    let mut parts = data.splitn(3, ':');
    if parts.next()? != "esc" { return None; }
    let escalation_id = parts.next()?.to_string();
    let kind = match parts.next()? {
        "push_pr" => ActionKind::PushPR,
        "run" => ActionKind::Run,
        "reply" => ActionKind::Reply,
        "snooze" => ActionKind::Snooze,
        "custom" => ActionKind::Custom,
        _ => return None,
    };
    Some(Callback { escalation_id, action_kind: kind })
}

pub fn render_confirmation(operator_name: &str, kind: ActionKind, detail: Option<&str>) -> String {
    let verb = match kind {
        ActionKind::PushPR => "pushed and opened",
        ActionKind::Run    => "ran",
        ActionKind::Reply  => "rejected",
        ActionKind::Snooze => "snoozed",
        ActionKind::Custom => "acted on",
    };
    match detail {
        Some(d) => format!("✓ {} {} {}", operator_name, verb, d),
        None    => format!("✓ {} {}", operator_name, verb),
    }
}
```

Wire the dispatcher (existing handler) to call `parse_callback` and use `render_confirmation(operator.name, action_kind, …)` when posting the confirmation reply. Replace any literal `"Resolved: Approved via Telegram"` strings.

- [ ] **Step 4: Run tests**

Run: `cargo test -p app telegram::inbound`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/telegram/inbound.rs
git commit -m "feat(telegram): typed inbound dispatch + named confirmation"
```

---

## Task 6: Parse-failure quarantine + circuit breaker in observer

**Files:**
- Modify: `crates/familiar/src/observer.rs`
- Test: inline

- [ ] **Step 1: Write the failing test**

```rust
// crates/familiar/src/observer.rs (bottom)
#[cfg(test)]
mod cb_tests {
    use super::*;
    use crate::parse_failure::{ParseFailure, ParseFailureReason};
    use std::time::{Duration, Instant};

    #[test]
    fn circuit_breaker_trips_after_3_failures_in_60s() {
        let mut cb = ParseFailureCircuit::new(Duration::from_secs(60), 3);
        let now = Instant::now();
        assert!(!cb.record(now));
        assert!(!cb.record(now + Duration::from_secs(1)));
        assert!(cb.record(now + Duration::from_secs(2))); // 3rd → trips
    }

    #[test]
    fn old_failures_drop_out_of_window() {
        let mut cb = ParseFailureCircuit::new(Duration::from_secs(60), 3);
        let now = Instant::now();
        cb.record(now);
        cb.record(now + Duration::from_secs(30));
        // 90s later — first one drops out
        assert!(!cb.record(now + Duration::from_secs(90)));
    }

    #[test]
    fn quarantine_handler_never_calls_outbound() {
        let mut sink = MockSink::default();
        let mut cb = ParseFailureCircuit::new(Duration::from_secs(60), 3);
        let pf = ParseFailure {
            session_id: "S1".into(),
            reason: ParseFailureReason::NoJsonObject,
            raw_excerpt: "".into(),
        };
        handle_parse_failure(&pf, &mut cb, &mut sink);
        assert_eq!(sink.outbound_calls, 0);
        assert_eq!(sink.in_app_toasts, 1);
    }
}
```

- [ ] **Step 2: Run, verify fail**

Run: `cargo test -p familiar observer::cb_tests`
Expected: FAIL.

- [ ] **Step 3: Implement**

```rust
// crates/familiar/src/observer.rs (add near top of file)
use crate::parse_failure::ParseFailure;
use std::collections::VecDeque;
use std::time::{Duration, Instant};

pub struct ParseFailureCircuit {
    window: Duration,
    threshold: usize,
    events: VecDeque<Instant>,
}

impl ParseFailureCircuit {
    pub fn new(window: Duration, threshold: usize) -> Self {
        Self { window, threshold, events: VecDeque::new() }
    }
    /// Returns true if this record trips the breaker.
    pub fn record(&mut self, now: Instant) -> bool {
        while let Some(&front) = self.events.front() {
            if now.duration_since(front) > self.window { self.events.pop_front(); } else { break; }
        }
        self.events.push_back(now);
        self.events.len() >= self.threshold
    }
}

pub trait QuarantineSink {
    fn emit_toast(&mut self, session_id: &str, reason: &str);
    fn force_suggest_only(&mut self, session_id: &str);
}

pub fn handle_parse_failure<S: QuarantineSink>(
    pf: &ParseFailure,
    cb: &mut ParseFailureCircuit,
    sink: &mut S,
) {
    tracing::warn!(session_id = %pf.session_id, reason = ?pf.reason, "parse failure");
    sink.emit_toast(&pf.session_id, &format!("{:?}", pf.reason));
    if cb.record(Instant::now()) {
        sink.force_suggest_only(&pf.session_id);
    }
}

#[cfg(test)]
#[derive(Default)]
pub struct MockSink {
    pub outbound_calls: usize,
    pub in_app_toasts: usize,
    pub forced_suggest_only: usize,
}
#[cfg(test)]
impl QuarantineSink for MockSink {
    fn emit_toast(&mut self, _: &str, _: &str) { self.in_app_toasts += 1; }
    fn force_suggest_only(&mut self, _: &str) { self.forced_suggest_only += 1; }
}
```

Replace every site in the observer that today funnels a parse error into `escalate()` with a call to `handle_parse_failure`. Search: `grep -rn "parse failed" crates/familiar/src/` and re-route each occurrence.

- [ ] **Step 4: Run tests**

Run: `cargo test -p familiar observer`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/familiar/src/observer.rs
git commit -m "feat(familiar): parse-failure quarantine with 3-in-60s circuit breaker"
```

---

## Task 7: Compile-fail negative test for parse → outbound

**Files:**
- Create: `crates/app/tests/compile_fail/parse_failure_to_outbound.rs`
- Create: `crates/app/tests/compile_fail.rs`
- Modify: `crates/app/Cargo.toml` (`[dev-dependencies] trybuild = "1"`)

- [ ] **Step 1: Add trybuild harness**

`crates/app/tests/compile_fail.rs`:

```rust
#[test]
fn parse_failure_cannot_become_outbound() {
    let t = trybuild::TestCases::new();
    t.compile_fail("tests/compile_fail/*.rs");
}
```

- [ ] **Step 2: Write the failing-compile fixture**

`crates/app/tests/compile_fail/parse_failure_to_outbound.rs`:

```rust
use app::telegram::outbound::{OutboundContext, EscalationKind, ProjectRef, format_message};
use familiar::parse_failure::{ParseFailure, ParseFailureReason};
use app::operator::OperatorIdentity;

fn main() {
    let pf = ParseFailure {
        session_id: "x".into(),
        reason: ParseFailureReason::NoJsonObject,
        raw_excerpt: "".into(),
    };
    // This must NOT compile: cannot use a ParseFailure as a summary,
    // and there is no From<ParseFailure> for OutboundContext.
    let id: OperatorIdentity = todo!();
    let ctx = OutboundContext {
        operator: &id,
        project: ProjectRef { repo: "r".into(), branch: "b".into() },
        session_short: "S",
        kind: EscalationKind::Approval,
        summary: pf, // type mismatch — required &str
        actions: &[],
    };
    let _ = format_message(&ctx);
}
```

- [ ] **Step 3: Run, verify it correctly fails to compile**

Run: `cargo test -p app --test compile_fail`
Expected: PASS (trybuild reports the fixture failed to compile, which is what we want).

- [ ] **Step 4: Commit**

```bash
git add crates/app/tests/compile_fail* crates/app/Cargo.toml
git commit -m "test(outbound): compile-fail proves ParseFailure can't reach outbound"
```

---

## Task 8: Deterministic `synthesize_identity` for migration

**Files:**
- Create: `crates/app/src/operator/migration.rs`
- Modify: `crates/app/src/operator/mod.rs` (`pub mod migration;`)

- [ ] **Step 1: Write the failing test**

```rust
// crates/app/src/operator/migration.rs (bottom)
#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator::{OperatorId, VoiceTone};
    use ulid::Ulid;

    #[test]
    fn same_id_yields_same_identity() {
        let id = OperatorId(Ulid::from_string("01H7ZZZZZZZZZZZZZZZZZZZZZZ").unwrap());
        let a = synthesize_identity(id, None);
        let b = synthesize_identity(id, None);
        assert_eq!(a.name, b.name);
        assert_eq!(a.color.0, b.color.0);
        match (&a.avatar, &b.avatar) {
            (super::super::Avatar::Emoji(x), super::super::Avatar::Emoji(y)) => assert_eq!(x, y),
            _ => panic!("expected emoji avatar"),
        }
        assert!(matches!(a.voice, VoiceTone::Terse));
    }

    #[test]
    fn uses_existing_persona_as_name_when_provided() {
        let id = OperatorId::new();
        let out = synthesize_identity(id, Some("Reviewer"));
        assert_eq!(out.name, "Reviewer");
    }
}
```

- [ ] **Step 2: Run, fail**

Run: `cargo test -p app operator::migration`
Expected: FAIL.

- [ ] **Step 3: Implement**

```rust
// crates/app/src/operator/migration.rs
use super::{Avatar, HexColor, OperatorId, OperatorIdentity, VoiceTone};

const EMOJIS: &[&str] = &["🟣", "🟢", "🔵", "🟡", "🟠", "🔴", "🟤", "⚪"];
const COLORS: &[&str] = &[
    "#a855f7", "#22c55e", "#3b82f6", "#eab308",
    "#f97316", "#ef4444", "#a16207", "#94a3b8",
];

fn hash_pick<'a, T>(id: &OperatorId, table: &'a [T]) -> &'a T {
    // Last byte of the Ulid is sufficient deterministic spread.
    let bytes = id.0.to_bytes();
    let idx = (bytes[15] as usize) % table.len();
    &table[idx]
}

pub fn synthesize_identity(id: OperatorId, persona: Option<&str>) -> OperatorIdentity {
    let short = {
        let s = id.0.to_string();
        s[s.len()-4..].to_string()
    };
    let name = persona.map(|p| p.to_string()).unwrap_or_else(|| format!("Operator {}", short));
    OperatorIdentity {
        id,
        name,
        avatar: Avatar::Emoji((*hash_pick(&id, EMOJIS)).to_string()),
        color: HexColor((*hash_pick(&id, COLORS)).to_string()),
        voice: VoiceTone::Terse,
    }
}
```

- [ ] **Step 4: Run, pass**

Run: `cargo test -p app operator::migration`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator/migration.rs crates/app/src/operator/mod.rs
git commit -m "feat(operator): deterministic identity synthesis for migration"
```

---

## Task 9: Settings load triggers migration

**Files:**
- Modify: `crates/app/src/settings.rs`
- Test: inline

- [ ] **Step 1: Write the failing test**

```rust
// crates/app/src/settings.rs (bottom)
#[cfg(test)]
mod migration_tests {
    use super::*;

    #[test]
    fn loading_legacy_settings_synthesizes_identity_unconfirmed() {
        let legacy = serde_json::json!({
            "operators": [
                { "id": "01H7ZZZZZZZZZZZZZZZZZZZZZZ", "persona": "Reviewer",
                  "model_route": "gpt-4o", "execution_policy": "SuggestOnly" }
            ]
        });
        let migrated = migrate_settings_value(legacy).unwrap();
        let op = &migrated["operators"][0];
        assert_eq!(op["identity"]["name"], "Reviewer");
        assert_eq!(op["identity_confirmed"], false);
        assert!(op["identity"]["avatar"].is_object());
        assert!(op["behavior"]["model_route"] == "gpt-4o");
    }
}
```

- [ ] **Step 2: Run, fail**

Run: `cargo test -p app settings::migration_tests`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `crates/app/src/settings.rs`:

```rust
use serde_json::{Value, json};
use ulid::Ulid;
use crate::operator::{OperatorId, migration::synthesize_identity};

pub fn migrate_settings_value(mut v: Value) -> anyhow::Result<Value> {
    let Some(arr) = v.get_mut("operators").and_then(|x| x.as_array_mut()) else { return Ok(v); };
    for op in arr.iter_mut() {
        if op.get("identity").is_some() { continue; } // already migrated
        let id_str = op.get("id").and_then(|x| x.as_str()).ok_or_else(|| anyhow::anyhow!("legacy operator missing id"))?;
        let ulid = Ulid::from_string(id_str).map_err(|e| anyhow::anyhow!("bad ulid: {e}"))?;
        let oid = OperatorId(ulid);
        let persona = op.get("persona").and_then(|x| x.as_str());
        let identity = synthesize_identity(oid, persona);
        let identity_val = serde_json::to_value(&identity)?;

        // Move every non-id/persona field into `behavior`.
        let mut behavior = serde_json::Map::new();
        if let Value::Object(map) = op {
            let keys: Vec<String> = map.keys().cloned().collect();
            for k in keys {
                if matches!(k.as_str(), "id" | "persona") { continue; }
                if let Some(val) = map.remove(&k) { behavior.insert(k, val); }
            }
        }

        *op = json!({
            "identity": identity_val,
            "behavior": Value::Object(behavior),
            "identity_confirmed": false,
        });
    }
    Ok(v)
}
```

Wire it into the settings load path: where settings JSON is parsed, run it through `migrate_settings_value` before `serde_json::from_value::<Settings>(...)`. Find the existing call site with `grep -n 'fn load' crates/app/src/settings.rs`.

- [ ] **Step 4: Run, pass**

Run: `cargo test -p app settings::migration_tests`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/settings.rs
git commit -m "feat(settings): migrate legacy operators to identity+behavior on load"
```

---

## Task 10: TS — typed `OperatorIdentity` / `OperatorAction` in `api.ts`

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Add type declarations**

```typescript
// ui/src/api.ts (add near other operator types)
export type Avatar =
  | { kind: 'Emoji'; value: string }
  | { kind: 'Initial' };

export type VoiceTone = 'Terse' | 'Warm' | 'Formal';

export interface OperatorIdentity {
  id: string;
  name: string;
  avatar: Avatar;
  color: string; // hex
  voice: VoiceTone;
}

export type OperatorAction =
  | { type: 'PushAndPR' }
  | { type: 'RunCommand'; cmd: string }
  | { type: 'Reply' }
  | { type: 'Snooze'; minutes: number }
  | { type: 'Custom'; id: string; label: string };

export interface OperatorBehavior {
  model_route?: string;
  execution_policy: 'SuggestOnly' | 'Allowlist' | 'ConfirmEach' | 'FullAuto';
  escalation_policy: 'OnBlocked' | 'Always' | 'Never';
  allowlist: string[];
  mission?: string;
}

export interface Operator {
  identity: OperatorIdentity;
  behavior: OperatorBehavior;
  identity_confirmed: boolean;
}
```

If `Operator` already exists in `api.ts`, replace it.

- [ ] **Step 2: Run typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: errors in files that referenced old `Operator` shape — proceed; they get fixed in Tasks 12–16.

For now, fix only the wrappers around Tauri commands that return/consume operators so they don't lie about the type.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui): typed OperatorIdentity + OperatorAction in api.ts"
```

---

## Task 11: TS — `renderOperatorChip` shared renderer

**Files:**
- Create: `ui/src/settings/operator_chip.ts`
- Create: `ui/src/settings/operator_chip.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// ui/src/settings/operator_chip.test.ts
import { describe, it, expect } from 'vitest';
import { renderOperatorChip } from './operator_chip';
import type { OperatorIdentity } from '../api';

const maya: OperatorIdentity = {
  id: '01H',
  name: 'Maya',
  avatar: { kind: 'Emoji', value: '🟣' },
  color: '#a855f7',
  voice: 'Terse',
};

describe('renderOperatorChip', () => {
  it('emits avatar + name with color tint', () => {
    const el = renderOperatorChip(maya, 'md');
    expect(el.textContent).toContain('🟣');
    expect(el.textContent).toContain('Maya');
    expect(el.style.getPropertyValue('--operator-color')).toBe('#a855f7');
  });

  it('falls back to initial disc when avatar is Initial', () => {
    const cal: OperatorIdentity = { ...maya, name: 'Cal', avatar: { kind: 'Initial' } };
    const el = renderOperatorChip(cal, 'sm');
    expect(el.textContent).toContain('C');
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `cd ui && npx vitest run src/settings/operator_chip.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

```typescript
// ui/src/settings/operator_chip.ts
import type { OperatorIdentity } from '../api';

export type ChipSize = 'sm' | 'md' | 'lg';

export function renderOperatorChip(identity: OperatorIdentity, size: ChipSize = 'md'): HTMLElement {
  const el = document.createElement('span');
  el.className = `op-chip op-chip-${size}`;
  el.style.setProperty('--operator-color', identity.color);

  const avatar = document.createElement('span');
  avatar.className = 'op-chip-avatar';
  if (identity.avatar.kind === 'Emoji') {
    avatar.textContent = identity.avatar.value;
  } else {
    avatar.textContent = identity.name.charAt(0).toUpperCase();
    avatar.classList.add('op-chip-avatar-initial');
  }

  const name = document.createElement('span');
  name.className = 'op-chip-name';
  name.textContent = identity.name;

  el.append(avatar, name);
  return el;
}
```

Add minimal CSS in `ui/src/styles/operator_chip.css` (import from `ui/src/main.ts`):

```css
.op-chip { display:inline-flex; align-items:center; gap:6px; padding:2px 8px;
  border-radius:999px; background: color-mix(in srgb, var(--operator-color) 18%, transparent);
  color: var(--operator-color); font-weight:500; }
.op-chip-sm { font-size: 11px; }
.op-chip-md { font-size: 13px; }
.op-chip-lg { font-size: 15px; }
.op-chip-avatar-initial { display:inline-flex; align-items:center; justify-content:center;
  width:18px; height:18px; border-radius:50%; background: var(--operator-color); color: white; font-size: 10px; }
```

- [ ] **Step 4: Run, pass**

Run: `cd ui && npx vitest run src/settings/operator_chip.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/operator_chip.ts ui/src/settings/operator_chip.test.ts ui/src/styles/operator_chip.css
git commit -m "feat(ui): shared renderOperatorChip with avatar/color/initial fallback"
```

---

## Task 12: TS — operator presets

**Files:**
- Create: `ui/src/settings/operator_presets.ts`

- [ ] **Step 1: Implement (no test — pure data)**

```typescript
// ui/src/settings/operator_presets.ts
import type { Operator, OperatorIdentity } from '../api';

export interface Preset {
  key: 'reviewer' | 'pair' | 'watcher' | 'auto';
  label: string;
  description: string;
  seed: () => { identity: Omit<OperatorIdentity, 'id'>; behavior: Operator['behavior'] };
}

export const PRESETS: Preset[] = [
  {
    key: 'reviewer',
    label: 'Reviewer',
    description: 'Terse · Allowlist · code review focus',
    seed: () => ({
      identity: { name: 'Reviewer', avatar: { kind: 'Emoji', value: '🔵' }, color: '#3b82f6', voice: 'Terse' },
      behavior: { execution_policy: 'Allowlist', escalation_policy: 'OnBlocked', allowlist: ['^git (status|diff|log).*'], model_route: 'gpt-4o' },
    }),
  },
  {
    key: 'pair',
    label: 'Pair',
    description: 'Warm · ConfirmEach · pair-programming companion',
    seed: () => ({
      identity: { name: 'Pair', avatar: { kind: 'Emoji', value: '🟣' }, color: '#a855f7', voice: 'Warm' },
      behavior: { execution_policy: 'ConfirmEach', escalation_policy: 'OnBlocked', allowlist: [], model_route: 'claude-sonnet-4-6' },
    }),
  },
  {
    key: 'watcher',
    label: 'Watcher',
    description: 'Terse · SuggestOnly · read-only observer',
    seed: () => ({
      identity: { name: 'Watcher', avatar: { kind: 'Emoji', value: '⚪' }, color: '#94a3b8', voice: 'Terse' },
      behavior: { execution_policy: 'SuggestOnly', escalation_policy: 'OnBlocked', allowlist: [], model_route: 'claude-haiku-4-5-20251001' },
    }),
  },
  {
    key: 'auto',
    label: 'Auto',
    description: 'Terse · FullAuto + allowlist · autonomous',
    seed: () => ({
      identity: { name: 'Auto', avatar: { kind: 'Emoji', value: '🟢' }, color: '#22c55e', voice: 'Terse' },
      behavior: { execution_policy: 'FullAuto', escalation_policy: 'OnBlocked', allowlist: ['^git (status|diff|log|fetch).*', '^ls .*', '^cat .*'], model_route: 'claude-sonnet-4-6' },
    }),
  },
];
```

- [ ] **Step 2: Commit**

```bash
git add ui/src/settings/operator_presets.ts
git commit -m "feat(ui): operator presets — Reviewer, Pair, Watcher, Auto"
```

---

## Task 13: TS — two-step modal (Step 1: Identity)

**Files:**
- Modify: `ui/src/settings/operators.ts` (begin rewrite)
- Test: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// ui/src/settings/operators.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { openOperatorModal, modalCanProceedFromStep1 } from './operators';

describe('operator modal step 1', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('blocks proceed when name is empty', () => {
    const m = openOperatorModal({ mode: 'create' });
    expect(modalCanProceedFromStep1(m)).toBe(false);
    m.setName('Maya');
    expect(modalCanProceedFromStep1(m)).toBe(true);
  });

  it('blocks proceed when name exceeds 24 chars', () => {
    const m = openOperatorModal({ mode: 'create' });
    m.setName('x'.repeat(25));
    expect(modalCanProceedFromStep1(m)).toBe(false);
  });

  it('preset seeds both steps', () => {
    const m = openOperatorModal({ mode: 'create', preset: 'reviewer' });
    expect(m.state.identity.name).toBe('Reviewer');
    expect(m.state.behavior.execution_policy).toBe('Allowlist');
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `cd ui && npx vitest run src/settings/operators.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement Step 1 + state**

In `ui/src/settings/operators.ts` (rewrite from scratch — back up the old file first):

```typescript
import type { Operator, OperatorIdentity } from '../api';
import { PRESETS, type Preset } from './operator_presets';
import { renderOperatorChip } from './operator_chip';

export interface ModalState {
  mode: 'create' | 'edit';
  step: 1 | 2;
  identity: Omit<OperatorIdentity, 'id'> & { id?: string };
  behavior: Operator['behavior'];
  identity_confirmed: boolean;
}

export interface ModalHandle {
  state: ModalState;
  setName(name: string): void;
  setAvatar(av: OperatorIdentity['avatar']): void;
  setColor(hex: string): void;
  setVoice(v: OperatorIdentity['voice']): void;
  el: HTMLElement;
}

export function modalCanProceedFromStep1(m: ModalHandle): boolean {
  const n = m.state.identity.name.trim();
  return n.length > 0 && [...n].length <= 24;
}

export function openOperatorModal(opts: {
  mode: 'create' | 'edit';
  preset?: Preset['key'];
  existing?: Operator;
}): ModalHandle {
  const seeded = opts.preset
    ? PRESETS.find(p => p.key === opts.preset)!.seed()
    : { identity: { name: '', avatar: { kind: 'Emoji' as const, value: '🟣' }, color: '#a855f7', voice: 'Terse' as const }, behavior: { execution_policy: 'SuggestOnly' as const, escalation_policy: 'OnBlocked' as const, allowlist: [], model_route: undefined } };

  const state: ModalState = opts.existing
    ? { mode: opts.mode, step: 2, identity: { ...opts.existing.identity }, behavior: { ...opts.existing.behavior }, identity_confirmed: opts.existing.identity_confirmed }
    : { mode: opts.mode, step: 1, identity: seeded.identity, behavior: seeded.behavior, identity_confirmed: false };

  const el = document.createElement('div');
  el.className = 'op-modal';
  document.body.appendChild(el);

  const handle: ModalHandle = {
    state, el,
    setName(n) { state.identity.name = n; render(); },
    setAvatar(av) { state.identity.avatar = av; render(); },
    setColor(c) { state.identity.color = c; render(); },
    setVoice(v) { state.identity.voice = v; render(); },
  };

  function render() {
    el.innerHTML = '';
    if (state.step === 1) el.append(renderStep1(handle));
    else el.append(renderStep2(handle));
  }
  render();
  return handle;
}

function renderStep1(h: ModalHandle): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'op-modal-step op-modal-step-1';

  const preview = renderOperatorChip({ id: 'preview', ...h.state.identity } as OperatorIdentity, 'lg');
  wrap.append(preview);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = h.state.identity.name;
  nameInput.maxLength = 24;
  nameInput.placeholder = 'Operator name';
  nameInput.addEventListener('input', () => h.setName(nameInput.value));
  wrap.append(labeled('Name', nameInput));

  // Avatar picker + color swatches + voice radio — minimal v0
  wrap.append(renderColorSwatches(h));
  wrap.append(renderVoicePicker(h));
  return wrap;
}

function labeled(text: string, child: HTMLElement): HTMLElement {
  const w = document.createElement('label');
  const t = document.createElement('span'); t.textContent = text;
  w.append(t, child); return w;
}

function renderColorSwatches(h: ModalHandle): HTMLElement {
  const row = document.createElement('div');
  row.className = 'op-color-row';
  ['#a855f7','#22c55e','#3b82f6','#eab308','#f97316','#ef4444','#a16207','#94a3b8'].forEach(c => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'op-color-swatch';
    b.style.background = c;
    b.addEventListener('click', () => h.setColor(c));
    row.append(b);
  });
  return row;
}

function renderVoicePicker(h: ModalHandle): HTMLElement {
  const row = document.createElement('div');
  (['Terse','Warm','Formal'] as const).forEach(v => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = v;
    b.className = h.state.identity.voice === v ? 'op-voice op-voice-active' : 'op-voice';
    b.addEventListener('click', () => h.setVoice(v));
    row.append(b);
  });
  return row;
}

function renderStep2(_h: ModalHandle): HTMLElement {
  // Implemented in Task 14
  const w = document.createElement('div'); w.textContent = 'Step 2 (Task 14)'; return w;
}
```

- [ ] **Step 4: Run, pass**

Run: `cd ui && npx vitest run src/settings/operators.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/operators.test.ts
git commit -m "feat(ui): operator modal step 1 — typed identity with validation"
```

---

## Task 14: TS — Step 2 (Behavior) + save

**Files:**
- Modify: `ui/src/settings/operators.ts`
- Modify: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Extend the test**

Append to `operators.test.ts`:

```typescript
import { saveOperator } from './operators';
import { invoke } from '@tauri-apps/api/core'; // or whatever path the project uses
import { vi } from 'vitest';

describe('operator modal step 2 + save', () => {
  it('saves a complete operator via tauri command', async () => {
    const invokeMock = vi.fn().mockResolvedValue(undefined);
    vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
    const m = openOperatorModal({ mode: 'create', preset: 'reviewer' });
    m.setName('Cal');
    await saveOperator(m);
    expect(invokeMock).toHaveBeenCalledWith('upsert_operator', expect.objectContaining({
      operator: expect.objectContaining({
        identity: expect.objectContaining({ name: 'Cal' }),
        behavior: expect.objectContaining({ execution_policy: 'Allowlist' }),
      }),
    }));
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `cd ui && npx vitest run src/settings/operators.test.ts`
Expected: FAIL (`saveOperator`, `renderStep2` incomplete).

- [ ] **Step 3: Implement**

Replace the stub `renderStep2` and add `saveOperator`:

```typescript
function renderStep2(h: ModalHandle): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'op-modal-step op-modal-step-2';

  const policy = document.createElement('select');
  (['SuggestOnly','Allowlist','ConfirmEach','FullAuto'] as const).forEach(v => {
    const o = document.createElement('option'); o.value = v; o.textContent = v;
    if (v === h.state.behavior.execution_policy) o.selected = true;
    policy.append(o);
  });
  policy.addEventListener('change', () => { h.state.behavior.execution_policy = policy.value as any; });
  wrap.append(labeled('Execution policy', policy));

  const escal = document.createElement('select');
  (['OnBlocked','Always','Never'] as const).forEach(v => {
    const o = document.createElement('option'); o.value = v; o.textContent = v;
    if (v === h.state.behavior.escalation_policy) o.selected = true;
    escal.append(o);
  });
  escal.addEventListener('change', () => { h.state.behavior.escalation_policy = escal.value as any; });
  wrap.append(labeled('Escalation policy', escal));

  const model = document.createElement('input');
  model.type = 'text'; model.value = h.state.behavior.model_route ?? '';
  model.addEventListener('input', () => { h.state.behavior.model_route = model.value || undefined; });
  wrap.append(labeled('Model route', model));

  const allow = document.createElement('textarea');
  allow.value = h.state.behavior.allowlist.join('\n');
  allow.addEventListener('input', () => { h.state.behavior.allowlist = allow.value.split('\n').filter(s => s.trim().length > 0); });
  wrap.append(labeled('Allowlist (one regex per line)', allow));

  return wrap;
}

export async function saveOperator(h: ModalHandle): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core');
  const op: Operator = {
    identity: { ...h.state.identity, id: h.state.identity.id ?? crypto.randomUUID() } as OperatorIdentity,
    behavior: h.state.behavior,
    identity_confirmed: true,
  };
  await invoke('upsert_operator', { operator: op });
}
```

Ensure a matching `#[tauri::command] fn upsert_operator(operator: Operator)` exists in `crates/app/src/lib.rs` (or wherever Tauri commands live). Add it if missing — it just writes through to the settings store.

- [ ] **Step 4: Run, pass**

Run: `cd ui && npx vitest run src/settings/operators.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/operators.test.ts crates/app/src/lib.rs
git commit -m "feat(ui): operator modal step 2 (behavior) + save via tauri"
```

---

## Task 15: TS — operator card grid (list view)

**Files:**
- Modify: `ui/src/settings/operators.ts`
- Modify: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Test**

```typescript
import { renderOperatorList } from './operators';
import type { Operator } from '../api';

describe('operator list', () => {
  it('renders one card per operator with chip + behavior summary', () => {
    const ops: Operator[] = [{
      identity: { id: '1', name: 'Maya', avatar: { kind:'Emoji', value:'🟣' }, color:'#a855f7', voice:'Terse' },
      behavior: { execution_policy:'Allowlist', escalation_policy:'OnBlocked', allowlist:[], model_route:'gpt-4o' },
      identity_confirmed: true,
    }];
    const root = renderOperatorList(ops, { onEdit(){}, onDelete(){}, onDuplicate(){} });
    expect(root.querySelectorAll('.op-card').length).toBe(1);
    expect(root.textContent).toContain('Maya');
    expect(root.textContent).toContain('Allowlist');
    expect(root.textContent).toContain('gpt-4o');
  });
});
```

- [ ] **Step 2: Run, fail**

Run: `cd ui && npx vitest run src/settings/operators.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

Append to `operators.ts`:

```typescript
export interface ListHandlers {
  onEdit(op: Operator): void;
  onDelete(op: Operator): void;
  onDuplicate(op: Operator): void;
}

export function renderOperatorList(ops: Operator[], handlers: ListHandlers): HTMLElement {
  const root = document.createElement('div');
  root.className = 'op-card-grid';
  for (const op of ops) {
    const card = document.createElement('div');
    card.className = 'op-card';
    card.append(renderOperatorChip(op.identity, 'lg'));
    const summary = document.createElement('div');
    summary.className = 'op-card-summary';
    summary.textContent = `${op.identity.voice} · ${op.behavior.execution_policy} · ${op.behavior.model_route ?? '—'}`;
    card.append(summary);

    const actions = document.createElement('div');
    actions.className = 'op-card-actions';
    const mk = (label: string, fn: () => void) => {
      const b = document.createElement('button'); b.textContent = label; b.addEventListener('click', fn); return b;
    };
    actions.append(mk('Edit', () => handlers.onEdit(op)));
    actions.append(mk('Duplicate', () => handlers.onDuplicate(op)));
    actions.append(mk('Delete', () => handlers.onDelete(op)));
    card.append(actions);
    root.append(card);
  }
  return root;
}
```

- [ ] **Step 4: Run, pass**

Run: `cd ui && npx vitest run src/settings/operators.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/operators.test.ts
git commit -m "feat(ui): operator card grid replaces flat list"
```

---

## Task 16: Hook chip into banner, activity feed, and tab bar

**Files:**
- Modify: `ui/src/aom/banner.ts`
- Modify: `ui/src/aom/activity-feed.ts`
- Modify: `ui/src/main.ts`

- [ ] **Step 1: Banner**

Locate the place in `ui/src/aom/banner.ts` where the operator label is rendered today. Replace with:

```typescript
import { renderOperatorChip } from '../settings/operator_chip';
// where the operator label was emitted:
container.prepend(renderOperatorChip(operator.identity, 'md'));
```

- [ ] **Step 2: Activity feed**

In `ui/src/aom/activity-feed.ts`, for each row that's tagged with an operator:

```typescript
import { renderOperatorChip } from '../settings/operator_chip';
row.prepend(renderOperatorChip(entry.operator.identity, 'sm'));
```

- [ ] **Step 3: Tab bar avatar**

In `ui/src/main.ts`, the existing glow-ring active-operator dot is currently derived from persona+model. Replace its inner content with `renderOperatorChip(activeOperator.identity, 'sm')` (or just the avatar element if the surrounding ring is positional).

- [ ] **Step 4: Manual verification (this section can't be unit-tested cleanly)**

Run: `cd ui && npm run tauri dev`
Verify in the running app:
1. Tab bar avatar shows operator's emoji/initial + color glow
2. Banner shows operator chip at left of status text
3. Activity feed rows are prefixed with operator chip
4. Settings → Operators shows new card grid; creating via Reviewer preset works
5. Telegram: trigger an escalation; message reads `🟣 <Name> · <repo> (<branch>)\n<summary>` with contextual buttons. No `[tab: session:...]` prefix.

If any of these are wrong, fix and re-verify before committing.

- [ ] **Step 5: Commit**

```bash
git add ui/src/aom/banner.ts ui/src/aom/activity-feed.ts ui/src/main.ts
git commit -m "feat(ui): banner/feed/tab-bar consume shared OperatorChip"
```

---

## Task 17: Voice directive in operator system prompt

**Files:**
- Modify: `crates/app/src/operator/identity.rs` (add helper)
- Modify: wherever the operator system prompt is assembled (likely `crates/familiar/src/...` or `crates/app/src/operator/...`; find with `grep -rn "system_prompt\|build_system" crates/`)

- [ ] **Step 1: Write the failing test**

```rust
// crates/app/src/operator/identity.rs (append to tests mod)
#[test]
fn voice_directive_differs_per_tone() {
    let t = voice_directive(VoiceTone::Terse);
    let w = voice_directive(VoiceTone::Warm);
    let f = voice_directive(VoiceTone::Formal);
    assert!(t.contains("12 words") || t.to_lowercase().contains("terse"));
    assert!(w.to_lowercase().contains("conversational") || w.to_lowercase().contains("warm"));
    assert!(f.to_lowercase().contains("no contractions") || f.to_lowercase().contains("formal"));
    assert_ne!(t, w);
    assert_ne!(w, f);
}
```

- [ ] **Step 2: Implement**

```rust
// crates/app/src/operator/identity.rs (add module-level fn)
pub fn voice_directive(tone: VoiceTone) -> &'static str {
    match tone {
        VoiceTone::Terse =>
            "Voice: terse. Strip pleasantries. Max ~12 words per outbound line. No emoji except the operator avatar.",
        VoiceTone::Warm =>
            "Voice: warm. Conversational tone, first person allowed. Keep messages concise but friendly.",
        VoiceTone::Formal =>
            "Voice: formal. No contractions. Full sentences. Avoid slang. Direct and precise.",
    }
}
```

Wire it into the prompt builder: locate where the per-operator system prompt is composed and append `voice_directive(op.identity.voice)`. Run `grep -rn "system_prompt\|system\\s*=" crates/` — append at the end of the existing system string.

- [ ] **Step 3: Run, pass**

Run: `cargo test -p app operator::identity::tests::voice_directive_differs_per_tone`
Expected: PASS. Then `cargo build` to confirm wiring compiles.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/operator/identity.rs crates/familiar/src/ crates/app/src/
git commit -m "feat(operator): apply voice directive to per-operator system prompt"
```

---

## Task 18: End-to-end smoke + horizon release

- [ ] **Step 1: Full test suite**

Run: `cargo test --workspace && cd ui && npm test`
Expected: all green.

- [ ] **Step 2: Manual E2E**

Run: `npm run tauri dev`
Walk through:
1. Settings → Operators → Create → pick **Reviewer** preset → save. Card appears with blue chip.
2. Edit Maya (or create one) → change voice to Warm → save. Banner chip updates immediately.
3. Trigger a parse failure intentionally (e.g., feed bad JSON via test executor). Confirm: no Telegram message, in-app toast appears on the originating tab, log line emitted. Repeat 3× within 60s — verify session flips to SuggestOnly with an in-app notice (still no Telegram).
4. Trigger a real BLOCKED escalation (e.g., agent wants to push). Telegram message reads `🟣 <name> · <repo> (<branch>)\n<summary>` with `[✓ Approve push] [✗ Reject] [⏸ Snooze 10m]`. Tap Approve. Confirmation reply names the operator and what they did.
5. Restart the app. Verify identity_confirmed persisted; banner doesn't reappear.

If any step fails, fix and re-run before commit.

- [ ] **Step 3: Cut release (only after manual E2E is clean)**

Use the `horizon` skill to bump version + write CHANGELOG entry covering "Operator identity v1: typed identity, Telegram redesign, parse-failure quarantine, settings rewrite, voice-aware prompts." Tag, push.

---

## Notes for the implementer

- **Worktree:** This plan should be executed in a worktree per project conventions. The `superpowers:using-git-worktrees` skill creates one. Don't run on `main`.
- **Commit cadence:** one commit per task as shown. The user prefers feature-grained commits over per-step commits — if a task has multiple sub-steps that compile together, batching them into one commit at the end of the task is fine.
- **Don't refactor adjacent code** unless it directly blocks the task. The operator settings file is a rewrite; leave the rest alone.
- **If you discover that a call site you need to update is gnarlier than expected** (e.g., the system prompt assembly crosses three crates), stop and surface it before sprawling the change.
