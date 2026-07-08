# Operator Perception Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give an operator a per-operator "Perception" capability that auto-answers *trivial, safe* interactive ACP permission prompts on the human's behalf, with a hard safety floor and full auditability.

**Architecture:** A pure decision core (`acp::perception`) combines three inputs — a hard safety-floor verdict (reused `safety::classify`), a Haiku "is this trivial + which option" judge verdict, and a consecutive-auto-answer count — into `AutoAnswer(optionId, reason) | Escalate`. The interactive ACP forwarder (`acp_commands.rs`) already receives `PermissionPending` events and can answer the parked request via `respond_permission` (the same path a human click uses); Perception slots in there. The judge is an injected async closure so the core unit-tests without a model.

**Tech Stack:** Rust (tokio, serde), existing `crates/agent` ACP + safety, existing operator/inference infra, Tauri commands, vanilla-TS UI.

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]` / `main()`.
- Errors: `thiserror` in libs (`crates/agent`), `anyhow` only at the app boundary.
- The safety blocklist (`crates/agent/src/safety.rs::classify`) is a hard floor: Perception may be MORE conservative than the rules, NEVER more permissive. It runs before the judge is consulted for any allow.
- Perception only ever selects a **non-persistent** option (never a `kind` containing `always`). Reuse the deny-biased `policy::pick_option` invariants.
- Any judge failure (timeout, parse error, ambiguous reply, unknown optionId) → Escalate to human. Failure mode is always "ask the human", never "guess".
- Perception is **off by default** per operator.
- UI copy in English (`// per feedback_english_first_copy`); new panels/rows use `border-radius: 0` (`// per feedback_tasker_sharp_corners`); no native `title` tooltips — use `attachTooltip`.
- Triage model id: `agent::DEFAULT_TRIAGE_MODEL` = `"claude-haiku-4-5-20251001"`.
- Resolved defaults (were the spec's open questions): CAP = **5** consecutive auto-answers **per session**, reset on any escalation or any human `acp_respond_permission`. **No** inline undo affordance in v0 (grants are `once`; the audit chip's visibility suffices). Judge is a **Perception-owned** scoped call, NOT the AOM triage machinery.

---

### Task 1: Pure Perception decision core

The heart. No async, no model, no Tauri. Fully unit-tested.

**Files:**
- Create: `crates/agent/src/acp/perception.rs`
- Modify: `crates/agent/src/acp/mod.rs` (add `pub mod perception;` + re-exports)
- Test: inline `#[cfg(test)]` in `perception.rs`

**Interfaces:**
- Consumes: `super::protocol::PermissionRequest` (fields: `tool_call.kind: Option<String>`, `tool_call.command() -> Option<&str>`, `options: Vec<PermissionOption>` where each has `option_id: String`, `kind: String`); `crate::safety::{classify, Risk}`.
- Produces:
  - `pub enum JudgeVerdict { Trivial { option_id: String }, Uncertain }`
  - `pub enum PerceptionDecision { AutoAnswer { option_id: String, reason: String }, Escalate }`
  - `pub fn decide(req: &PermissionRequest, judge: &JudgeVerdict, consecutive: u32, cap: u32) -> PerceptionDecision`

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::protocol::{PermissionOption, PermissionRequest, ToolCall};

    // Minimal builders mirroring the real protocol shapes.
    fn opt(id: &str, kind: &str) -> PermissionOption {
        PermissionOption { option_id: id.into(), kind: kind.into() }
    }
    fn req(kind: &str, cmd: Option<&str>, opts: Vec<PermissionOption>) -> PermissionRequest {
        PermissionRequest {
            tool_call: ToolCall::for_test(kind, cmd),
            options: opts,
        }
    }

    #[test]
    fn trivial_safe_read_auto_answers() {
        let r = req("read", None, vec![opt("allow_once", "allow_once"), opt("reject_once", "reject_once")]);
        let d = decide(&r, &JudgeVerdict::Trivial { option_id: "allow_once".into() }, 0, 5);
        assert!(matches!(d, PerceptionDecision::AutoAnswer { option_id, .. } if option_id == "allow_once"));
    }

    #[test]
    fn risky_execute_escalates_even_when_judge_says_trivial() {
        // Floor must win over the judge.
        let r = req("execute", Some("sudo reboot"), vec![opt("allow_once", "allow_once"), opt("reject_once", "reject_once")]);
        let d = decide(&r, &JudgeVerdict::Trivial { option_id: "allow_once".into() }, 0, 5);
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn judge_uncertain_escalates() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let d = decide(&r, &JudgeVerdict::Uncertain, 0, 5);
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn judge_names_persistent_option_escalates() {
        // "always" options are never auto-selectable.
        let r = req("read", None, vec![opt("allow_always", "allow_always"), opt("allow_once", "allow_once")]);
        let d = decide(&r, &JudgeVerdict::Trivial { option_id: "allow_always".into() }, 0, 5);
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn judge_names_absent_option_escalates() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let d = decide(&r, &JudgeVerdict::Trivial { option_id: "nope".into() }, 0, 5);
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn cap_reached_escalates() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let d = decide(&r, &JudgeVerdict::Trivial { option_id: "allow_once".into() }, 5, 5);
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn safe_execute_auto_answers() {
        let r = req("execute", Some("ls -la"), vec![opt("allow_once", "allow_once"), opt("reject_once", "reject_once")]);
        let d = decide(&r, &JudgeVerdict::Trivial { option_id: "allow_once".into() }, 0, 5);
        assert!(matches!(d, PerceptionDecision::AutoAnswer { .. }));
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p agent acp::perception`
Expected: FAIL to compile — `perception` module / `decide` / `ToolCall::for_test` not defined.

- [ ] **Step 3: Write minimal implementation**

`crates/agent/src/acp/perception.rs`:

```rust
//! Pure decision core for operator "Perception": auto-answer trivial,
//! safe interactive ACP permission prompts. No async, no model, no I/O —
//! the async Haiku judge is computed by the caller and passed in as a
//! `JudgeVerdict`, keeping this unit-testable and deterministic.

use crate::safety::{classify, Risk};

use super::protocol::PermissionRequest;

/// The Haiku judge's verdict on a single permission prompt.
#[derive(Debug, Clone)]
pub enum JudgeVerdict {
    /// Trivial with an obviously-correct answer: pick this option.
    Trivial { option_id: String },
    /// Not trivial, or the judge wasn't confident — hand to the human.
    Uncertain,
}

/// What Perception does with a parked permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PerceptionDecision {
    AutoAnswer { option_id: String, reason: String },
    Escalate,
}

/// Combine the hard safety floor, the judge verdict, and the
/// consecutive-auto-answer count into a decision. Escalates on ANY doubt.
pub fn decide(
    req: &PermissionRequest,
    judge: &JudgeVerdict,
    consecutive: u32,
    cap: u32,
) -> PerceptionDecision {
    // Handback: too many auto-answers in a row without the human → stop.
    if consecutive >= cap {
        return PerceptionDecision::Escalate;
    }

    // Hard safety floor FIRST. An execute whose command isn't `Safe`
    // escalates regardless of what the judge said.
    if req.tool_call.kind.as_deref() == Some("execute") {
        match req.tool_call.command() {
            Some(cmd) if classify(cmd) == Risk::Safe => {}
            _ => return PerceptionDecision::Escalate,
        }
    }

    // Only now consult the judge.
    let JudgeVerdict::Trivial { option_id } = judge else {
        return PerceptionDecision::Escalate;
    };

    // The named option must exist AND be non-persistent (never "always").
    let ok = req.options.iter().any(|o| {
        &o.option_id == option_id && !o.kind.to_ascii_lowercase().contains("always")
    });
    if !ok {
        return PerceptionDecision::Escalate;
    }

    PerceptionDecision::AutoAnswer {
        option_id: option_id.clone(),
        reason: format!("trivial + safe ({})", req.tool_call.kind.as_deref().unwrap_or("?")),
    }
}
```

Add to `crates/agent/src/acp/mod.rs`:

```rust
pub mod perception;
pub use perception::{decide as perception_decide, JudgeVerdict, PerceptionDecision};
```

Add a test-only constructor to `ToolCall` in `crates/agent/src/acp/protocol.rs` (near the `ToolCall` definition):

```rust
#[cfg(test)]
impl ToolCall {
    pub fn for_test(kind: &str, command: Option<&str>) -> Self {
        // Mirror the real shape: `kind` set, `rawInput.command` populated
        // when a command is given so `command()` returns it.
        let mut tc = ToolCall::default();
        tc.kind = Some(kind.to_string());
        if let Some(c) = command {
            tc.raw_input = Some(serde_json::json!({ "command": c }));
        }
        tc
    }
}
```

> If `ToolCall` doesn't derive `Default` or `command()`/`raw_input` differ, adjust the builder to the real fields (read `protocol.rs` `struct ToolCall` + `fn command`). The test relies only on `kind` and `command()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p agent acp::perception`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/acp/perception.rs crates/agent/src/acp/mod.rs crates/agent/src/acp/protocol.rs
git commit -m "feat(perception): pure decision core — safety floor + judge + handback cap"
```

---

### Task 2: The Haiku judge (prompt + parser)

Builds a prompt from a `PermissionRequest`, calls the triage model, parses the reply into `JudgeVerdict`. Split into a **pure** prompt-builder + parser (tested) and a thin async send.

**Files:**
- Modify: `crates/agent/src/acp/perception.rs` (add `build_judge_prompt`, `parse_judge_reply`)
- Test: inline `#[cfg(test)]` in `perception.rs`

**Interfaces:**
- Consumes: `PermissionRequest`.
- Produces:
  - `pub fn build_judge_prompt(req: &PermissionRequest) -> String`
  - `pub fn parse_judge_reply(raw: &str, req: &PermissionRequest) -> JudgeVerdict`

- [ ] **Step 1: Write the failing tests**

```rust
#[test]
fn parse_valid_trivial_reply() {
    let r = req("read", None, vec![opt("allow_once", "allow_once")]);
    let v = parse_judge_reply(r#"{"trivial":true,"option_id":"allow_once"}"#, &r);
    assert!(matches!(v, JudgeVerdict::Trivial { option_id } if option_id == "allow_once"));
}

#[test]
fn parse_reply_with_prose_around_json() {
    let r = req("read", None, vec![opt("allow_once", "allow_once")]);
    let v = parse_judge_reply("Sure!\n{\"trivial\":true,\"option_id\":\"allow_once\"}\ndone", &r);
    assert!(matches!(v, JudgeVerdict::Trivial { .. }));
}

#[test]
fn parse_not_trivial_is_uncertain() {
    let r = req("read", None, vec![opt("allow_once", "allow_once")]);
    let v = parse_judge_reply(r#"{"trivial":false}"#, &r);
    assert!(matches!(v, JudgeVerdict::Uncertain));
}

#[test]
fn parse_garbage_is_uncertain() {
    let r = req("read", None, vec![opt("allow_once", "allow_once")]);
    assert!(matches!(parse_judge_reply("not json at all", &r), JudgeVerdict::Uncertain));
}

#[test]
fn parse_unknown_option_is_uncertain() {
    let r = req("read", None, vec![opt("allow_once", "allow_once")]);
    let v = parse_judge_reply(r#"{"trivial":true,"option_id":"ghost"}"#, &r);
    assert!(matches!(v, JudgeVerdict::Uncertain));
}

#[test]
fn prompt_lists_the_options() {
    let r = req("execute", Some("ls"), vec![opt("allow_once", "allow_once"), opt("reject_once", "reject_once")]);
    let p = build_judge_prompt(&r);
    assert!(p.contains("allow_once") && p.contains("reject_once") && p.contains("ls"));
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p agent acp::perception`
Expected: FAIL — `build_judge_prompt` / `parse_judge_reply` not defined.

- [ ] **Step 3: Write minimal implementation**

Append to `perception.rs`:

```rust
/// Build the judge prompt. Deliberately narrow: the model only decides
/// "is this trivial with one obviously-correct choice", never safety —
/// safety is the code-level floor in `decide`.
pub fn build_judge_prompt(req: &PermissionRequest) -> String {
    let kind = req.tool_call.kind.as_deref().unwrap_or("unknown");
    let cmd = req.tool_call.command().unwrap_or("");
    let opts = req
        .options
        .iter()
        .map(|o| format!("- {} (kind: {})", o.option_id, o.kind))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You gate an executor's permission prompt for a supervising operator.\n\
         Decide ONLY whether this is a trivial decision with one obviously-correct answer\n\
         that any reasonable engineer would pick without thinking (e.g. reading a file,\n\
         a recommended workflow default). If there is ANY doubt, say it is not trivial.\n\
         Do NOT reason about danger — that is handled separately.\n\n\
         tool kind: {kind}\ncommand: {cmd}\noptions:\n{opts}\n\n\
         Reply with ONLY JSON: {{\"trivial\": <bool>, \"option_id\": \"<one of the option ids, or omit>\"}}"
    )
}

/// Parse the judge reply. Anything malformed, non-trivial, or naming an
/// option not present in `req` collapses to `Uncertain` (→ escalate).
pub fn parse_judge_reply(raw: &str, req: &PermissionRequest) -> JudgeVerdict {
    // Extract the first {...} span so prose around the JSON is tolerated.
    let json = match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if b > a => &raw[a..=b],
        _ => return JudgeVerdict::Uncertain,
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return JudgeVerdict::Uncertain;
    };
    if v.get("trivial").and_then(|t| t.as_bool()) != Some(true) {
        return JudgeVerdict::Uncertain;
    }
    let Some(id) = v.get("option_id").and_then(|s| s.as_str()) else {
        return JudgeVerdict::Uncertain;
    };
    if req.options.iter().any(|o| o.option_id == id) {
        JudgeVerdict::Trivial { option_id: id.to_string() }
    } else {
        JudgeVerdict::Uncertain
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p agent acp::perception`
Expected: PASS (13 tests total).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/acp/perception.rs
git commit -m "feat(perception): Haiku judge prompt builder + defensive reply parser"
```

---

### Task 3: Per-operator `perception_enabled` flag

Clone the existing `acp_enabled` capability plumbing verbatim — struct field, defaults, setter, storage method, Tauri command.

**Files:**
- Modify: `crates/app/src/operator_registry.rs` (add field `perception_enabled: bool`; init `false` at EVERY `Operator { .. }` construction site — mirror every `acp_enabled: false` / `acp_enabled: existing.acp_enabled`; add `set_perception_enabled` + `operator_set_perception_enabled` mirroring `set_acp_enabled` at ~593 and ~985)
- Modify: `crates/app/src/storage.rs` (mirror whatever `operator_set_acp_enabled` persists — grep `acp_enabled` in storage.rs and clone the column/update)
- Modify: `crates/app/src/lib.rs` (register the new Tauri command in the `invoke_handler!`/command list next to the operator commands)
- Test: inline `#[cfg(test)]` in `operator_registry.rs` mirroring the nearest `acp_enabled` test if one exists; else a round-trip test.

**Interfaces:**
- Produces: `Operator.perception_enabled: bool`; `OperatorRegistry::set_perception_enabled(&self, storage, id, enabled) -> Result<..>`; Tauri command `operator_set_perception_enabled(state, id, enabled)`.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn perception_flag_defaults_false_and_toggles() {
    let (reg, storage) = test_registry().await; // reuse the existing test harness in this file
    let op = reg.create_default(&storage).await.unwrap();
    assert!(!op.perception_enabled);
    reg.set_perception_enabled(&storage, &op.id, true).await.unwrap();
    let got = reg.get(&op.id).await.unwrap();
    assert!(got.perception_enabled);
}
```

> Match `test_registry()` / `create_default` to the actual helpers already used by `acp_enabled` tests in this file. If none exist, construct the registry the same way the surrounding tests do.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant-app operator_registry::tests::perception_flag`
Expected: FAIL — no field `perception_enabled`.

(Adjust the crate name to the real `crates/app` package name from its `Cargo.toml`.)

- [ ] **Step 3: Write minimal implementation**

Add to `struct Operator` (after `acp_enabled`):

```rust
    /// When true, the operator auto-answers trivial+safe interactive ACP
    /// permission prompts (Perception). Off by default.
    #[serde(default)]
    pub perception_enabled: bool,
```

At every `Operator { ... }` literal that sets `acp_enabled: false`, add `perception_enabled: false,`. At the one that sets `acp_enabled: existing.acp_enabled`, add `perception_enabled: existing.perception_enabled,`.

Add the setter mirroring `set_acp_enabled`:

```rust
pub async fn set_perception_enabled(
    &self,
    storage: &Storage,
    id: &str,
    enabled: bool,
) -> Result<(), OperatorError> {
    storage
        .operator_set_perception_enabled(id.to_string(), enabled)
        .await?;
    if let Some(op) = self.inner.lock().await.get_mut(id) {
        op.perception_enabled = enabled;
    }
    Ok(())
}
```

Add `Storage::operator_set_perception_enabled` in `storage.rs` mirroring `operator_set_acp_enabled` (same table, `perception_enabled` column — add a migration/column if the schema is explicit; if operators are stored as a JSON blob, `#[serde(default)]` already covers old rows and the setter just re-serializes).

Add the Tauri command in `operator_registry.rs` (or wherever `operator_set_acp_enabled` command lives) and register it in `lib.rs`:

```rust
#[tauri::command]
pub async fn operator_set_perception_enabled(
    state: State<'_, AppState>,
    id: String,
    enabled: bool,
) -> Result<(), String> {
    state
        .operators
        .set_perception_enabled(&state.storage, &id, enabled)
        .await
        .map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant-app operator_registry::tests::perception_flag`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/storage.rs crates/app/src/lib.rs
git commit -m "feat(perception): per-operator perception_enabled flag (mirrors acp_enabled)"
```

---

### Task 4: Wire the interceptor into the ACP forwarder

Thread the flag to the session, and on `PermissionPending` run judge → decide → auto-answer or fall through, with the consecutive-count handback guard.

**Files:**
- Modify: `crates/app/src/acp_commands.rs` — add `perception_enabled: bool` to `SpawnAcpOpts` (~258); its caller passes the spawning operator's flag. In the forwarder loop (~653, the `AcpSessionEvent::PermissionPending` arm), branch on the flag.
- Modify: `crates/app/src/acp_commands.rs` — define an audit tab event `AcpTabEvent::PerceptionAutoAnswer { request_key, option_id, reason }`.
- Test: inline `#[cfg(test)]` — a forwarder-free unit test of the async decision helper with an injected stub judge.

**Interfaces:**
- Consumes: `agent::acp::{perception_decide, JudgeVerdict, PerceptionDecision, build_judge_prompt, parse_judge_reply}`; `session.respond_permission(&request_key, &option_id)`; `agent::DEFAULT_TRIAGE_MODEL`.
- Produces: `async fn perception_step(session, req, request_key, consecutive, judge) -> PerceptionOutcome` where `judge: impl Fn(String) -> Fut<String>` is injected (real = Haiku send; test = stub). `PerceptionOutcome = Answered { option_id, reason } | Escalated`.

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn perception_step_auto_answers_trivial_safe() {
    let req = PermissionRequest { /* read, allow_once + reject_once — build like protocol tests */ };
    let judge = |_p: String| async { r#"{"trivial":true,"option_id":"allow_once"}"#.to_string() };
    let out = perception_decide_async(&req, 0, 5, judge).await;
    assert!(matches!(out, PerceptionOutcome::Answered { option_id, .. } if option_id == "allow_once"));
}

#[tokio::test]
async fn perception_step_escalates_when_judge_uncertain() {
    let req = PermissionRequest { /* read, allow_once */ };
    let judge = |_p: String| async { r#"{"trivial":false}"#.to_string() };
    let out = perception_decide_async(&req, 0, 5, judge).await;
    assert!(matches!(out, PerceptionOutcome::Escalated));
}
```

> Split the pure-ish orchestration (`perception_decide_async`: build prompt → call judge → parse → `perception_decide`) from the side-effecting `respond_permission` so it tests without a live `AcpSession`. The forwarder calls `perception_decide_async`, then on `Answered` calls `session.respond_permission(...)` + emits the audit event.

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant-app acp_commands::tests::perception_step`
Expected: FAIL — `perception_decide_async` / `PerceptionOutcome` not defined.

- [ ] **Step 3: Write minimal implementation**

```rust
pub enum PerceptionOutcome {
    Answered { option_id: String, reason: String },
    Escalated,
}

/// Orchestrate one prompt: build → judge → parse → decide. No I/O beyond
/// the injected async `judge` closure, so it unit-tests with a stub.
pub async fn perception_decide_async<F, Fut>(
    req: &PermissionRequest,
    consecutive: u32,
    cap: u32,
    judge: F,
) -> PerceptionOutcome
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = String>,
{
    let prompt = agent::acp::build_judge_prompt(req);
    let raw = judge(prompt).await;
    let verdict = agent::acp::parse_judge_reply(&raw, req);
    match agent::acp::perception_decide(req, &verdict, consecutive, cap) {
        agent::acp::PerceptionDecision::AutoAnswer { option_id, reason } => {
            PerceptionOutcome::Answered { option_id, reason }
        }
        agent::acp::PerceptionDecision::Escalate => PerceptionOutcome::Escalated,
    }
}

const PERCEPTION_CAP: u32 = 5;
```

In the forwarder loop, replace the `PermissionPending` arm body:

```rust
AcpSessionEvent::PermissionPending { request_key, request } => {
    if perception_enabled_for_task {
        // Real judge: one-shot Haiku call. Locate the app's single-shot
        // completion entry (same one the operator triage uses,
        // `DEFAULT_TRIAGE_MODEL`) and call it here; on ANY error return a
        // string that parses to Uncertain (e.g. "").
        let judge = |prompt: String| {
            let infer = infer_handle.clone();
            async move { infer.triage_complete(agent::DEFAULT_TRIAGE_MODEL, &prompt).await.unwrap_or_default() }
        };
        let consec = perception_consecutive; // task-local counter
        match perception_decide_async(&request, consec, PERCEPTION_CAP, judge).await {
            PerceptionOutcome::Answered { option_id, reason } => {
                if let Some(sess) = registry_task.get(&session_id).await {
                    let _ = sess.respond_permission(&request_key, &option_id).await;
                }
                perception_consecutive += 1;
                let _ = app_for_task.emit(&topic_for_task, &AcpTabEvent::PerceptionAutoAnswer {
                    request_key, option_id, reason,
                });
                continue; // handled; do NOT forward the prompt to the UI
            }
            PerceptionOutcome::Escalated => {
                perception_consecutive = 0; // handing back resets the streak
                AcpTabEvent::PermissionPending { request_key, request }
            }
        }
    } else {
        AcpTabEvent::PermissionPending { request_key, request }
    }
}
```

Notes for the implementer:
- `perception_enabled_for_task` and `perception_consecutive` are captured/declared in the forwarder's `tokio::spawn` closure (like `topic_for_task`). Source `perception_enabled_for_task` from `SpawnAcpOpts.perception_enabled`.
- `infer_handle.triage_complete(model, prompt)` is a stand-in name: wire it to the crate's actual single-shot inference call. Grep `DEFAULT_TRIAGE_MODEL` + the operator triage send to find the real API; it must be a plain `async fn(model, prompt) -> Result<String>`. If none exists as a reusable primitive, add a thin `pub async fn triage_complete` next to the provider dispatch that does one non-streaming completion. Any `Err` → `unwrap_or_default()` → `""` → parses Uncertain → escalates (safe).
- Also reset `perception_consecutive = 0` in the `acp_respond_permission` command path (human answered), so a human click breaks the streak. (Store the counter where both the forwarder and the command can reach it, e.g. on the `tab_session` in the registry, rather than a pure task-local — adjust the declaration accordingly.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p covenant-app acp_commands::tests::perception_step`
Then: `cargo test -p agent && cargo test -p covenant-app acp`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/acp_commands.rs
git commit -m "feat(perception): forwarder intercepts PermissionPending, auto-answers or escalates + handback"
```

---

### Task 5: UI — capability toggle + audit chip

A toggle in the operator/Capabilities surface, and rendering the audit chip in the ACP tab.

**Files:**
- Modify: the operator capabilities UI (grep `acp_enabled` / `operator_set_acp_enabled` in `ui/src` to find the existing toggle; add a Perception toggle beside it calling `operator_set_perception_enabled`).
- Modify: `ui/src/api.ts` (add typed wrapper `operatorSetPerceptionEnabled(id, enabled)`).
- Modify: the ACP tab view (grep `PermissionPending` in `ui/src`; add a handler for `PerceptionAutoAnswer` that renders an inline audit chip).
- Test: manual (UI). Add a Vitest only if the chip has parsing logic worth testing.

**Interfaces:**
- Consumes: Tauri command `operator_set_perception_enabled`; tab event `PerceptionAutoAnswer { request_key, option_id, reason }`.

- [ ] **Step 1: Add the API wrapper**

In `ui/src/api.ts`:

```ts
export async function operatorSetPerceptionEnabled(id: string, enabled: boolean): Promise<void> {
  await invoke("operator_set_perception_enabled", { id, enabled });
}
```

- [ ] **Step 2: Add the toggle**

Beside the existing ACP toggle in the operator/Capabilities panel, add a Perception switch bound to `op.perception_enabled`, calling `operatorSetPerceptionEnabled(op.id, next)` on change. Label: `Perception` with sub-text `Auto-answer trivial, safe executor prompts`. Use `attachTooltip` for any hint (no native `title`). Sharp corners (`border-radius: 0`).

- [ ] **Step 3: Render the audit chip**

In the ACP tab event handler, add:

```ts
case "PerceptionAutoAnswer": {
  appendChip(`Perception ✓ auto-answered: ${ev.option_id} — ${ev.reason}`);
  break;
}
```

Style the chip distinctly (muted/accent) so auto-answers are visually distinct from human answers. Match the existing chip component.

- [ ] **Step 4: Build + manual verify**

Run: `npm run build` (from repo root) — TS type-check + bundle must pass.
Then manual: `npm run tauri:dev`, create an operator, toggle Perception on, spawn an ACP session, trigger a trivial prompt (e.g. a read), confirm it auto-answers with a chip and that a risky prompt (e.g. an execute of `sudo`) still stops for you. Screenshot for the PR.

- [ ] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/<capabilities-file> ui/src/<acp-tab-file>
git commit -m "feat(perception): capabilities toggle + ACP tab audit chip"
```

---

## Self-Review

**Spec coverage:**
- Per-operator toggle, off by default → Task 3 + Task 5. ✓
- ACP-only, insert at the permission seam → Task 4 (forwarder `PermissionPending`). ✓
- LLM-judged (Haiku) → Task 2 + Task 4 judge wiring. ✓
- Hard safety floor first, non-negotiable → Task 1 (`decide`) + tests `risky_execute_escalates_even_when_judge_says_trivial`, `safe_execute_auto_answers`. ✓
- Non-persistent option only → Task 1 test `judge_names_persistent_option_escalates`. ✓
- Audit chip → Task 4 event + Task 5 render. ✓
- Handback cap (5, per-session, reset on escalate/human) → Task 1 `cap_reached_escalates`, Task 4 counter + reset in forwarder and `acp_respond_permission`. ✓
- Judge failure → escalate → Task 2 parser collapses to Uncertain; Task 4 `unwrap_or_default()`. ✓
- Zero behavior change when off → Task 4 `else` arm forwards `PermissionPending` unchanged. ✓

**Placeholder scan:** The two spec open questions that were "TBD" are resolved in Global Constraints (CAP=5/per-session; no undo v0; own judge call). The only implementer-discretion points are named real APIs to grep-confirm (`ToolCall` fields, storage persistence shape, single-shot inference primitive, exact UI files) — each with a concrete fallback, not a blank.

**Type consistency:** `JudgeVerdict` / `PerceptionDecision` / `perception_decide` (Task 1) are consumed by name in Task 4; `build_judge_prompt` / `parse_judge_reply` (Task 2) consumed in Task 4's `perception_decide_async`; `perception_enabled` (Task 3) consumed by `SpawnAcpOpts` (Task 4) and UI (Task 5); `PerceptionAutoAnswer` event produced in Task 4, consumed in Task 5. Consistent.

## Known implementer confirmations (not placeholders — verify against tree)
- `crates/app` package name for `cargo test -p <name>` (read `crates/app/Cargo.toml`).
- `ToolCall` real fields / `command()` impl in `protocol.rs`.
- How `storage.rs` persists operators (JSON blob vs columns) — dictates whether a migration is needed.
- The single-shot inference primitive to back `triage_complete` (grep `DEFAULT_TRIAGE_MODEL`).
- Exact `ui/src` files for the capabilities toggle and ACP tab renderer.
