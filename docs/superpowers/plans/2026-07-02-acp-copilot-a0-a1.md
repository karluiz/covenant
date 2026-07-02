# ACP Copilot A0+A1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A structured ACP (Agent Client Protocol) client for `copilot --acp` in `crates/agent` (A0), plus a `dispatch_acp` operator tool that runs headless background Copilot tasks with policy-gated permissions (A1).

**Architecture:** Mirror the existing `pi_rpc` module layout exactly — `LineFramer` (reused as-is) → typed protocol → session with id-correlated JSON-RPC over the child's stdio → a `run_task` orchestrator. The one structural difference vs pi_rpc: ACP agents send *requests to the client* (`session/request_permission`) that we must answer inline; a sync `PermissionResolver` callback handles them, backed by `safety::classify`. A1 exposes `run_task` as an operator tool following the existing `run_command`/`gh_*` handler pattern in `crates/app/src/teammate/`.

**Tech Stack:** Rust, tokio (process/sync), serde/serde_json, thiserror, tracing. **Zero new dependencies** — everything needed is already in `crates/agent/Cargo.toml` and `crates/app`.

## Global Constraints

- No new crate dependencies. Do not touch any `Cargo.toml` except to verify existing deps.
- `thiserror` for errors in `crates/agent`; no `unwrap()` outside `#[cfg(test)]`.
- `tracing` with structured fields (`session_id = %...`), never string-interpolated.
- Conventional Commits, one commit per task.
- Run tests narrowly: `cargo test -p karl-agent acp::` and `cargo test -p covenant_lib teammate::tools` — never bare `cargo test` (telegram long-poll tests hang; see reference_covenant_test_gotchas).
- Wire truth: all fixture JSON in this plan was captured from a real `copilot --acp` 1.0.68 session (JSON-RPC 2.0, newline-delimited, numeric ids). Do not "fix" the fixtures to match ACP docs — the fixtures are the source of truth.
- The ACP protocol is public preview: parsers must tolerate unknown `sessionUpdate` kinds and unknown content-block types without erroring.

## File Structure

```
crates/agent/src/
├── lib.rs                  # MODIFY: + pub mod acp;
├── pi_rpc/session.rs       # MODIFY: make augmented_path/find_program_on_path pub(crate)
└── acp/
    ├── mod.rs              # CREATE: module docs + re-exports
    ├── protocol.rs         # CREATE: wire types (Task 1)
    ├── session.rs          # CREATE: AcpSession (Task 2)
    ├── policy.rs           # CREATE: headless permission policy (Task 3)
    └── run.rs              # CREATE: run_task orchestrator + report (Task 4)
crates/app/src/teammate/
├── tools.rs                # MODIFY: dispatch_acp tool def + handler (Task 5)
└── llm.rs                  # MODIFY: register in all_tool_defs + execute_tool match (Task 5)
```

---

### Task 1: ACP wire types (`protocol.rs`)

**Files:**
- Create: `crates/agent/src/acp/mod.rs`
- Create: `crates/agent/src/acp/protocol.rs`
- Modify: `crates/agent/src/lib.rs` (after line 9, `pub mod pi_rpc;` block — add `pub mod acp;` keeping alphabetical order, so before `pub mod pi_rpc;`)

**Interfaces:**
- Produces: `InboundFrame` + `FrameKind`, `SessionNotification`, `SessionUpdate` (tagged enum with `Unknown` fallback), `ContentBlock`, `ToolCallFields`, `PermissionRequest`/`PermissionToolCall`/`PermissionOption`, `RpcError`. Later tasks import all of these from `super::protocol`.

- [ ] **Step 1: Write `mod.rs` and register the module**

`crates/agent/src/acp/mod.rs`:

```rust
//! ACP (Agent Client Protocol) client for `copilot --acp` — JSON-RPC 2.0
//! over child stdio, newline-delimited. Mirrors the [`crate::pi_rpc`]
//! layout; reuses its [`crate::pi_rpc::framer::LineFramer`].
//!
//! Layout:
//!   - [`protocol`] — inbound frame + `session/update` wire types (A0-1)
//!   - [`session`]  — `AcpSession` spawn / request / reader task (A0-2)
//!   - [`policy`]   — headless permission resolution via `safety` (A0-3)
//!   - [`run`]      — one-shot `run_task` orchestrator (A0-4)
//!
//! Spec: https://agentclientprotocol.com — but fixtures in tests were
//! captured from copilot 1.0.68 and win over the spec on any conflict.

pub mod protocol;
// Uncommented by their own tasks — an empty stub can't back a `pub use`:
// pub mod policy;   // Task 3
// pub mod run;      // Task 4
// pub mod session;  // Task 2

pub use protocol::{
    ContentBlock, FrameKind, InboundFrame, PermissionOption, PermissionRequest,
    PermissionToolCall, RpcError, SessionNotification, SessionUpdate, ToolCallFields,
};
// pub use run::{run_task, AcpRunOpts, AcpRunReport};                     // Task 4
// pub use session::{AcpError, AcpSession, AcpSpawnOpts, PermissionResolver}; // Task 2
```

In `crates/agent/src/lib.rs` add `pub mod acp;` immediately before `pub mod pi_rpc;`.

Tasks 2, 3 and 4 each create their file, uncomment their own `pub mod`/`pub use` lines in `mod.rs`, and include `mod.rs` in their commit.

- [ ] **Step 2: Write the failing fixture tests**

`crates/agent/src/acp/protocol.rs` — put the test module in first with the types stubbed as `todo!` — simpler: write types and tests together in this file; the "failing" state is the file not existing. Full file:

```rust
//! ACP wire types. Inbound frames are JSON-RPC 2.0; `session/update`
//! notification payloads are internally tagged on `sessionUpdate`.
//! Everything tolerates unknown variants — the protocol is public preview.

use serde::Deserialize;
use serde_json::Value;

/// Any single JSONL frame read from the agent's stdout.
#[derive(Debug, Clone, Deserialize)]
pub struct InboundFrame {
    /// JSON-RPC id — number in practice (copilot), but the spec allows
    /// strings; keep the raw Value and echo it back verbatim on replies.
    pub id: Option<Value>,
    pub method: Option<String>,
    pub params: Option<Value>,
    #[serde(default)]
    pub result: Option<Value>,
    pub error: Option<RpcError>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FrameKind {
    /// Reply to one of our requests (id present, no method).
    Response,
    /// Agent-initiated request we must answer (id + method).
    Request,
    /// Fire-and-forget notification (method, no id).
    Notification,
    /// Nothing recognizable — log and drop.
    Invalid,
}

impl InboundFrame {
    pub fn kind(&self) -> FrameKind {
        match (self.id.is_some(), self.method.is_some()) {
            (true, true) => FrameKind::Request,
            (true, false) => FrameKind::Response,
            (false, true) => FrameKind::Notification,
            (false, false) => FrameKind::Invalid,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct RpcError {
    pub code: i64,
    pub message: String,
}

/// Params of a `session/update` notification.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotification {
    pub session_id: String,
    pub update: SessionUpdate,
}

/// One streamed update. `#[serde(other)] Unknown` swallows kinds we don't
/// model yet (plan, config_option_update, …) so preview-protocol drift
/// never kills a session.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum SessionUpdate {
    AgentMessageChunk { content: ContentBlock },
    AgentThoughtChunk { content: ContentBlock },
    ToolCall(ToolCallFields),
    ToolCallUpdate(ToolCallFields),
    #[serde(other)]
    Unknown,
}

/// Shared field bag for `tool_call` and `tool_call_update` — the wire
/// sends the same camelCase keys on both, all optional on updates.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallFields {
    pub tool_call_id: String,
    #[serde(default)]
    pub title: Option<String>,
    /// "edit" | "execute" | "read" | "other" (open set).
    #[serde(default)]
    pub kind: Option<String>,
    /// "pending" | "in_progress" | "completed" | "failed" (open set).
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub raw_input: Option<Value>,
    #[serde(default)]
    pub raw_output: Option<Value>,
    #[serde(default)]
    pub content: Vec<ContentBlock>,
}

impl ToolCallFields {
    /// Command string for execute-kind calls (`rawInput.command`).
    pub fn command(&self) -> Option<&str> {
        self.raw_input.as_ref()?.get("command")?.as_str()
    }

    /// Exit code if rawOutput carries a `shell_exit` entry.
    pub fn exit_code(&self) -> Option<i64> {
        let contents = self.raw_output.as_ref()?.get("contents")?.as_array()?;
        contents
            .iter()
            .find(|c| c.get("type").and_then(Value::as_str) == Some("shell_exit"))?
            .get("exitCode")?
            .as_i64()
    }
}

/// Content blocks appear inside chunks and tool results. Untagged with a
/// `Value` fallback: order matters — most-specific first.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum ContentBlock {
    Diff {
        path: String,
        #[serde(default, rename = "oldText")]
        old_text: Option<String>,
        #[serde(rename = "newText")]
        new_text: String,
    },
    Text {
        text: String,
    },
    Other(Value),
}

impl ContentBlock {
    /// Best-effort plain text: direct text, or nested `content.text`
    /// (the wire's `{"type":"content","content":{"type":"text",...}}`).
    pub fn as_text(&self) -> Option<&str> {
        match self {
            ContentBlock::Text { text } => Some(text),
            ContentBlock::Other(v) => v.get("content")?.get("text")?.as_str(),
            ContentBlock::Diff { .. } => None,
        }
    }
}

/// Params of an agent→client `session/request_permission` request.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub session_id: String,
    pub tool_call: PermissionToolCall,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionToolCall {
    pub tool_call_id: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub raw_input: Option<Value>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionOption {
    pub option_id: String,
    /// "allow_once" | "allow_always" | "reject_once" (open set).
    pub kind: String,
    #[serde(default)]
    pub name: Option<String>,
}

impl PermissionToolCall {
    pub fn command(&self) -> Option<&str> {
        self.raw_input.as_ref()?.get("command")?.as_str()
    }
}

// ---------------------------------------------------------------------------
// Tests — every fixture below is a verbatim line captured from
// `copilot --acp` 1.0.68 (paths shortened to /w).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(line: &str) -> InboundFrame {
        serde_json::from_str(line).expect("frame parses")
    }

    fn update_of(frame: &InboundFrame) -> SessionNotification {
        serde_json::from_value(frame.params.clone().expect("params"))
            .expect("session notification parses")
    }

    #[test]
    fn message_chunk() {
        let f = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Creating"}}}}"#,
        );
        assert_eq!(f.kind(), FrameKind::Notification);
        let n = update_of(&f);
        assert_eq!(n.session_id, "s1");
        match n.update {
            SessionUpdate::AgentMessageChunk { content } => {
                assert_eq!(content.as_text(), Some("Creating"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn tool_call_execute() {
        let f = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"call_1","title":"Run fib.py to confirm output","kind":"execute","status":"pending","rawInput":{"command":"python3 fib.py","description":"Run fib.py to confirm output"}}}}"#,
        );
        match update_of(&f).update {
            SessionUpdate::ToolCall(tc) => {
                assert_eq!(tc.kind.as_deref(), Some("execute"));
                assert_eq!(tc.command(), Some("python3 fib.py"));
                assert_eq!(tc.status.as_deref(), Some("pending"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn tool_call_update_with_diff() {
        let f = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_2","status":"completed","content":[{"type":"diff","path":"/w/fib.py","oldText":"","newText":"def fib(n):\n    return n\n"}],"rawOutput":{"content":"Added 1 file(s): /w/fib.py"}}}}"#,
        );
        match update_of(&f).update {
            SessionUpdate::ToolCallUpdate(tc) => {
                assert_eq!(tc.status.as_deref(), Some("completed"));
                match &tc.content[0] {
                    ContentBlock::Diff { path, new_text, .. } => {
                        assert_eq!(path, "/w/fib.py");
                        assert!(new_text.starts_with("def fib"));
                    }
                    other => panic!("wrong block: {other:?}"),
                }
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn tool_call_update_with_shell_exit() {
        let f = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"call_1","status":"completed","content":[{"type":"content","content":{"type":"text","text":"55\n<shellId: 0 completed with exit code 0>"}}],"rawOutput":{"content":"55\n","contents":[{"type":"shell_exit","shellId":"0","exitCode":0,"cwd":"/w","outputPreview":"55\n"}]}}}}"#,
        );
        match update_of(&f).update {
            SessionUpdate::ToolCallUpdate(tc) => {
                assert_eq!(tc.exit_code(), Some(0));
                assert!(tc.content[0].as_text().expect("text").starts_with("55"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }

    #[test]
    fn permission_request() {
        let f = parse(
            r#"{"jsonrpc":"2.0","id":1,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"call_1","title":"Run fib.py to confirm output","kind":"execute","status":"pending","rawInput":{"command":"python3 fib.py","commands":["python3 fib.py"]}},"options":[{"optionId":"allow_once","kind":"allow_once","name":"Allow once"},{"optionId":"allow_always","kind":"allow_always","name":"Always allow"},{"optionId":"reject_once","kind":"reject_once","name":"Deny"}]}}"#,
        );
        assert_eq!(f.kind(), FrameKind::Request);
        assert_eq!(f.method.as_deref(), Some("session/request_permission"));
        let req: PermissionRequest =
            serde_json::from_value(f.params.clone().expect("params")).expect("perm parses");
        assert_eq!(req.tool_call.kind.as_deref(), Some("execute"));
        assert_eq!(req.tool_call.command(), Some("python3 fib.py"));
        assert_eq!(req.options.len(), 3);
        assert_eq!(req.options[2].kind, "reject_once");
    }

    #[test]
    fn response_with_stop_reason() {
        let f = parse(r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#);
        assert_eq!(f.kind(), FrameKind::Response);
        let stop = f.result.expect("result")["stopReason"]
            .as_str()
            .map(str::to_string);
        assert_eq!(stop.as_deref(), Some("end_turn"));
    }

    #[test]
    fn unknown_update_kinds_are_tolerated() {
        for raw in [
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"compact"}]}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"some_future_kind","whatever":true}}}"#,
        ] {
            let n = update_of(&parse(raw));
            assert!(matches!(n.update, SessionUpdate::Unknown));
        }
    }
}
```

- [ ] **Step 3: Run tests, verify they pass**

Run: `cargo test -p karl-agent acp::protocol`
Expected: 7 tests PASS. If `#[serde(other)]` on the tagged enum errors at compile time, the fallback is: keep the enum without `Unknown`, wrap in `#[serde(untagged)] enum MaybeUpdate { Known(SessionUpdate), Unknown(Value) }` — but `#[serde(other)]` on a unit variant of an internally-tagged enum is supported by serde and should compile as written.

- [ ] **Step 4: Verify the whole crate still compiles**

Run: `cargo check -p karl-agent`
Expected: clean (stub files for `policy`/`run`/`session` in place).

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/acp/ crates/agent/src/lib.rs
git commit -m "feat(acp): ACP wire types with copilot-captured fixtures"
```

---

### Task 2: `AcpSession` (`session.rs`)

**Files:**
- Modify: `crates/agent/src/pi_rpc/session.rs:63,80` — change `fn augmented_path` and `fn find_program_on_path` to `pub(crate) fn`
- Create: `crates/agent/src/acp/session.rs` (replace stub)

**Interfaces:**
- Consumes: `LineFramer` (`crate::pi_rpc::framer`), Task 1 protocol types.
- Produces:
  - `pub struct AcpSpawnOpts { pub cwd: PathBuf, pub program: Option<PathBuf>, pub extra_args: Vec<String> }`
  - `pub type PermissionResolver = Arc<dyn Fn(&PermissionRequest) -> String + Send + Sync>` (returns the chosen `optionId`)
  - `pub struct AcpSession` with:
    - `pub async fn spawn(opts: AcpSpawnOpts, resolver: PermissionResolver) -> Result<Arc<Self>, AcpError>`
    - `pub async fn request(&self, method: &str, params: Value) -> Result<Value, AcpError>`
    - `pub async fn notify(&self, method: &str, params: Value) -> Result<(), AcpError>`
    - `pub fn events(&self) -> broadcast::Receiver<SessionNotification>`
    - `pub async fn shutdown(&self, timeout: Duration)`
  - `pub enum AcpError { Spawn{..}, MissingStream{..}, Closed, ResponseCancelled, Rpc(String), Serialize(..) }` (thiserror)

- [ ] **Step 1: Write the failing tests**

Test module at the bottom of the new `session.rs` (same fake-agent-via-`sh` technique as `pi_rpc/session.rs:491+`). Our client allocates numeric ids sequentially from 1, so scripts hardcode them.

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;

    fn spawn_opts(script: &str) -> AcpSpawnOpts {
        AcpSpawnOpts {
            cwd: std::env::temp_dir(),
            program: Some(PathBuf::from("sh")),
            extra_args: vec!["-c".into(), script.into()],
        }
    }

    /// Fake agent: answers `initialize` (our id 1), emits one
    /// notification, then a permission request; expects our outcome
    /// answer; exits.
    #[tokio::test]
    async fn correlates_and_answers_permission() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}\n'
printf '{"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","kind":"execute","rawInput":{"command":"ls"}},"options":[{"optionId":"allow_once","kind":"allow_once"},{"optionId":"reject_once","kind":"reject_once"}]}}\n'
read answer
case "$answer" in *'"id":77'*'allow_once'*) printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}\n';; esac
"#;
        let seen: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let seen2 = seen.clone();
        let resolver: PermissionResolver = Arc::new(move |req| {
            seen2
                .lock()
                .expect("lock")
                .push(req.tool_call.command().unwrap_or("").to_string());
            "allow_once".to_string()
        });
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");
        let mut events = session.events();

        let init = session
            .request("initialize", serde_json::json!({"protocolVersion": 1}))
            .await
            .expect("initialize");
        assert_eq!(init["protocolVersion"], 1);

        // First notification, then the post-permission one — proving the
        // reader answered id 77 with our resolver's optionId.
        let first = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely")
            .expect("recv");
        assert_eq!(first.session_id, "s1");
        let second = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely — permission answer never reached the agent")
            .expect("recv");
        match second.update {
            SessionUpdate::AgentMessageChunk { content } => {
                assert_eq!(content.as_text(), Some("ok"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        assert_eq!(seen.lock().expect("lock").as_slice(), ["ls"]);
        session.shutdown(Duration::from_secs(2)).await;
    }

    /// An RPC-level error result rejects the pending request.
    #[tokio::test]
    async fn rpc_error_surfaces() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"bad"}}\n'
"#;
        let resolver: PermissionResolver = Arc::new(|_| "reject_once".into());
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");
        let err = session
            .request("initialize", serde_json::json!({}))
            .await
            .expect_err("should fail");
        assert!(matches!(err, AcpError::Rpc(_)));
        session.shutdown(Duration::from_secs(2)).await;
    }

    /// Garbage lines are logged and skipped, session survives.
    #[tokio::test]
    async fn malformed_line_does_not_kill_reader() {
        let script = r#"printf 'not json\n{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"alive"}}}}\n'"#;
        let resolver: PermissionResolver = Arc::new(|_| "reject_once".into());
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");
        let mut events = session.events();
        let n = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely")
            .expect("recv");
        assert!(matches!(n.update, SessionUpdate::AgentMessageChunk { .. }));
        session.shutdown(Duration::from_secs(2)).await;
    }
}
```

- [ ] **Step 2: Run tests, verify they fail to compile** (no `AcpSession` yet)

Run: `cargo test -p karl-agent acp::session`

- [ ] **Step 3: Implement `AcpSession`**

Structure copied from `PiSession` (`pi_rpc/session.rs:159-459`), with these deltas — full skeleton:

```rust
//! Owns a `copilot --acp` child: single-writer stdin task, reader task
//! that frames stdout JSONL, correlates JSON-RPC responses, answers
//! agent→client requests inline, and broadcasts `session/update`
//! notifications. Mirrors [`crate::pi_rpc::session::PiSession`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::pi_rpc::framer::LineFramer;
use crate::pi_rpc::session::{augmented_path, find_program_on_path};

use super::protocol::{FrameKind, InboundFrame, PermissionRequest, SessionNotification};

const EVENT_CHANNEL_CAPACITY: usize = 1024;
const STDIN_CHANNEL_CAPACITY: usize = 128;

fn default_copilot_program() -> PathBuf {
    let path = augmented_path(std::env::var_os("PATH"));
    find_program_on_path("copilot", path.as_deref()).unwrap_or_else(|| PathBuf::from("copilot"))
}

#[derive(Debug, Clone)]
pub struct AcpSpawnOpts {
    /// Working directory; also passed as `--add-dir` so copilot's file
    /// tools are allowed to touch it.
    pub cwd: PathBuf,
    pub program: Option<PathBuf>,
    pub extra_args: Vec<String>,
}

/// Answers `session/request_permission` synchronously with an optionId.
pub type PermissionResolver = Arc<dyn Fn(&PermissionRequest) -> String + Send + Sync>;

#[derive(Debug, Error)]
pub enum AcpError {
    #[error("failed to spawn `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("child process did not expose {stream}")]
    MissingStream { stream: &'static str },
    #[error("session is shutting down")]
    Closed,
    #[error("response channel cancelled before reply arrived")]
    ResponseCancelled,
    #[error("agent returned error: {0}")]
    Rpc(String),
    #[error("serialize: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub struct AcpSession {
    events_tx: broadcast::Sender<SessionNotification>,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>>,
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
}
```

Key implementation points (the rest mirrors `PiSession` line-for-line):

- `spawn`: `Command::new(program)`, args `["--acp", "--add-dir", cwd]` + `extra_args`, `current_dir(cwd)`, PATH augmentation, `kill_on_drop(true)`, piped stdio (stderr `Stdio::null()`). Spawn `write_loop` (identical to pi's) and `read_loop`.
- `request`: allocate `let id = self.next_id.fetch_add(1, Ordering::Relaxed)` (start the counter at 1), insert oneshot into `pending`, write `{"jsonrpc":"2.0","id":id,"method":method,"params":params}` + `\n`, await the oneshot. `Err` slot cleanup on send failure, exactly like `PiSession::send_with_response`.
- `notify`: same without id/oneshot.
- `read_loop(stdout, events_tx, pending, stdin_tx, resolver)` — per line, parse `InboundFrame`; on parse failure `tracing::warn!` + skip. Then match `frame.kind()`:
  - `Response`: `id.as_i64()` → remove waiter → send `Ok(result.unwrap_or(Value::Null))` or `Err(AcpError::Rpc(error.message))`.
  - `Request`: if method == `"session/request_permission"`, parse `PermissionRequest` from params; on success call `resolver(&req)` and write `{"jsonrpc":"2.0","id":<echo raw id Value>,"result":{"outcome":{"outcome":"selected","optionId":<chosen>}}}` via `stdin_tx`. Any other method (fs/*, unknown): reply `{"jsonrpc":"2.0","id":<id>,"error":{"code":-32601,"message":"not supported by this client"}}`. The reader owns a clone of `stdin_tx` for these replies.
  - `Notification`: if method == `"session/update"`, parse `SessionNotification` from params and broadcast; other notifications → `tracing::debug!` and drop.
- `shutdown`: no abort command exists in ACP — just abort writer task, take child, `timeout(child.wait())` then `start_kill()`, then reap reader — same shape as `PiSession::shutdown` minus the `send(&PiCommand::Abort)`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `cargo test -p karl-agent acp::session`
Expected: 3 tests PASS. Also run `cargo test -p karl-agent pi_rpc::` to confirm the `pub(crate)` visibility change broke nothing.

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/acp/session.rs crates/agent/src/acp/mod.rs crates/agent/src/pi_rpc/session.rs
git commit -m "feat(acp): AcpSession — JSON-RPC stdio client with inline permission handling"
```

---

### Task 3: Headless permission policy (`policy.rs`)

**Files:**
- Create: `crates/agent/src/acp/policy.rs` (replace stub)

**Interfaces:**
- Consumes: `PermissionRequest`, `PermissionOption` (Task 1); `crate::safety::{classify, Risk}`.
- Produces: `pub fn resolve_headless(req: &PermissionRequest) -> String` and `pub fn resolve_headless_with_log(req: &PermissionRequest, denied: &std::sync::Mutex<Vec<String>>) -> String`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::protocol::PermissionRequest;

    fn req(kind: &str, command: Option<&str>) -> PermissionRequest {
        let raw_input = command
            .map(|c| serde_json::json!({ "command": c }))
            .unwrap_or(serde_json::json!({}));
        serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "toolCall": { "toolCallId": "t1", "kind": kind, "rawInput": raw_input },
            "options": [
                { "optionId": "allow_once", "kind": "allow_once", "name": "Allow once" },
                { "optionId": "allow_always", "kind": "allow_always", "name": "Always allow" },
                { "optionId": "reject_once", "kind": "reject_once", "name": "Deny" }
            ]
        }))
        .expect("fixture parses")
    }

    #[test]
    fn edits_and_reads_allowed() {
        assert_eq!(resolve_headless(&req("edit", None)), "allow_once");
        assert_eq!(resolve_headless(&req("read", None)), "allow_once");
    }

    #[test]
    fn safe_commands_allowed() {
        for cmd in ["ls", "git status", "python3 fib.py", "cargo check"] {
            assert_eq!(resolve_headless(&req("execute", Some(cmd))), "allow_once", "{cmd}");
        }
    }

    #[test]
    fn mutating_and_destructive_commands_denied() {
        for cmd in ["git push origin main", "rm -rf /tmp/x", "sudo ls", "npm install left-pad"] {
            assert_eq!(resolve_headless(&req("execute", Some(cmd))), "reject_once", "{cmd}");
        }
    }

    #[test]
    fn execute_without_command_string_denied() {
        assert_eq!(resolve_headless(&req("execute", None)), "reject_once");
    }

    #[test]
    fn unknown_kind_denied() {
        assert_eq!(resolve_headless(&req("mystery", None)), "reject_once");
    }

    #[test]
    fn never_picks_allow_always() {
        // Even for the friendliest input, a headless session must not
        // persist grants beyond itself.
        assert_ne!(resolve_headless(&req("edit", None)), "allow_always");
    }

    #[test]
    fn falls_back_to_first_option_when_kinds_are_alien() {
        let mut r = req("edit", None);
        for o in &mut r.options {
            o.kind = "weird".into();
            o.option_id = format!("w_{}", o.option_id);
        }
        assert_eq!(resolve_headless(&r), "w_allow_once");
    }

    #[test]
    fn denied_commands_are_logged() {
        let log = std::sync::Mutex::new(Vec::new());
        resolve_headless_with_log(&req("execute", Some("sudo make me a sandwich")), &log);
        let denied = log.lock().expect("lock");
        assert_eq!(denied.as_slice(), ["sudo make me a sandwich"]);
    }
}
```

- [ ] **Step 2: Run tests, verify they fail** — `cargo test -p karl-agent acp::policy`

- [ ] **Step 3: Implement**

```rust
//! Headless permission policy for autonomous ACP sessions. Deny-biased:
//! edits/reads inside the sandboxed cwd are fine (copilot enforces
//! --add-dir), execute only when `safety::classify` says Safe, and we
//! never persist a grant (`allow_always`) — a background task must not
//! widen future sessions.

use std::sync::Mutex;

use crate::safety::{classify, Risk};

use super::protocol::PermissionRequest;

/// Pick an optionId for a permission request with nobody watching.
pub fn resolve_headless(req: &PermissionRequest) -> String {
    static NO_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
    resolve_headless_with_log(req, &NO_LOG)
}

/// Same, but records denied execute commands into `denied` so callers
/// can report them (the operator tells the LLM what was blocked).
pub fn resolve_headless_with_log(req: &PermissionRequest, denied: &Mutex<Vec<String>>) -> String {
    let allow = match req.tool_call.kind.as_deref() {
        Some("edit") | Some("read") => true,
        Some("execute") => match req.tool_call.command() {
            Some(cmd) if classify(cmd) == Risk::Safe => true,
            Some(cmd) => {
                if let Ok(mut d) = denied.lock() {
                    d.push(cmd.to_string());
                }
                false
            }
            None => false,
        },
        _ => false,
    };
    pick_option(req, allow)
}

fn pick_option(req: &PermissionRequest, allow: bool) -> String {
    let wanted = if allow { "allow_once" } else { "reject_once" };
    if let Some(o) = req.options.iter().find(|o| o.kind == wanted) {
        return o.option_id.clone();
    }
    // Alien option kinds: for deny, prefer anything reject-ish; for
    // allow, prefer non-persistent; last resort first option.
    let fallback = if allow {
        req.options.iter().find(|o| !o.kind.contains("always"))
    } else {
        req.options.iter().find(|o| o.kind.contains("reject"))
    };
    fallback
        .or_else(|| req.options.first())
        .map(|o| o.option_id.clone())
        .unwrap_or_default()
}
```

Note: `static NO_LOG: Mutex<Vec<String>>` requires `Mutex::new` in const context — stable since Rust 1.63. If the toolchain complains, use `once_cell::sync::Lazy` (already a dep).

- [ ] **Step 4: Run tests, verify they pass** — `cargo test -p karl-agent acp::policy` → 9 PASS

- [ ] **Step 5: Commit**

```bash
git add crates/agent/src/acp/policy.rs crates/agent/src/acp/mod.rs
git commit -m "feat(acp): deny-biased headless permission policy over safety::classify"
```

---

### Task 4: `run_task` orchestrator (`run.rs`) + real-copilot smoke test

**Files:**
- Create: `crates/agent/src/acp/run.rs` (replace stub)

**Interfaces:**
- Consumes: `AcpSession`, `AcpSpawnOpts`, `AcpError` (Task 2); `resolve_headless_with_log` (Task 3); protocol types (Task 1).
- Produces:
  - `pub struct AcpRunOpts { pub cwd: PathBuf, pub prompt: String, pub timeout: Duration, pub program: Option<PathBuf> }`
  - `pub struct AcpRunReport { pub stop_reason: String, pub agent_text: String, pub tool_events: Vec<String>, pub denied: Vec<String> }`
  - `pub async fn run_task(opts: AcpRunOpts) -> Result<AcpRunReport, AcpError>` — timeout yields `Ok` with `stop_reason == "timeout"`, not `Err`.

- [ ] **Step 1: Write the failing tests**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::time::Duration;

    /// Full happy path against a scripted fake agent. Our request ids
    /// are deterministic (1=initialize, 2=session/new, 3=session/prompt).
    #[tokio::test]
    async fn collects_report_from_fake_agent() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}\n'
read line
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working on it. "}}}}\n'
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Run ls","kind":"execute","status":"pending","rawInput":{"command":"ls"}}}}\n'
printf '{"jsonrpc":"2.0","id":50,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","kind":"execute","rawInput":{"command":"ls"}},"options":[{"optionId":"allow_once","kind":"allow_once"},{"optionId":"reject_once","kind":"reject_once"}]}}\n'
read answer
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","rawOutput":{"contents":[{"type":"shell_exit","shellId":"0","exitCode":0}]}}}}\n'
printf '{"jsonrpc":"2.0","id":51,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t2","kind":"execute","rawInput":{"command":"sudo reboot"}},"options":[{"optionId":"allow_once","kind":"allow_once"},{"optionId":"reject_once","kind":"reject_once"}]}}\n'
read answer2
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done."}}}}\n'
printf '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'
"#;
        let report = run_task(AcpRunOpts {
            cwd: std::env::temp_dir(),
            prompt: "list files".into(),
            timeout: Duration::from_secs(10),
            program: Some(PathBuf::from("sh")),
            extra_args_for_tests: vec!["-c".into(), script.into()],
        })
        .await
        .expect("run ok");

        assert_eq!(report.stop_reason, "end_turn");
        assert_eq!(report.agent_text, "working on it. done.");
        assert_eq!(report.tool_events.len(), 1);
        assert!(report.tool_events[0].contains("execute"));
        assert!(report.tool_events[0].contains("completed"));
        assert!(report.tool_events[0].contains("exit 0"));
        assert_eq!(report.denied, vec!["sudo reboot".to_string()]);
    }

    /// A hung agent hits the timeout and still yields a partial report.
    #[tokio::test]
    async fn timeout_yields_partial_report() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}\n'
read line
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"stalling"}}}}\n'
sleep 30
"#;
        let report = run_task(AcpRunOpts {
            cwd: std::env::temp_dir(),
            prompt: "hang".into(),
            timeout: Duration::from_millis(1500),
            program: Some(PathBuf::from("sh")),
            extra_args_for_tests: vec!["-c".into(), script.into()],
        })
        .await
        .expect("timeout is not an Err");
        assert_eq!(report.stop_reason, "timeout");
        assert_eq!(report.agent_text, "stalling");
    }

    /// Real copilot end-to-end. Ignored by default: needs an installed,
    /// authenticated copilot >= 1.0.68 on PATH.
    /// Run: cargo test -p karl-agent acp::run::tests::smoke_real_copilot -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires installed+authenticated copilot CLI"]
    async fn smoke_real_copilot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let report = run_task(AcpRunOpts {
            cwd: dir.path().to_path_buf(),
            prompt: "Create a file hello.txt containing exactly the word: covenant".into(),
            timeout: Duration::from_secs(120),
            program: None,
            extra_args_for_tests: vec![],
        })
        .await
        .expect("run ok");
        eprintln!("report: {report:?}");
        assert_eq!(report.stop_reason, "end_turn");
        let content = std::fs::read_to_string(dir.path().join("hello.txt")).expect("file exists");
        assert!(content.contains("covenant"));
    }
}
```

- [ ] **Step 2: Run tests, verify they fail to compile** — `cargo test -p karl-agent acp::run`

- [ ] **Step 3: Implement**

```rust
//! One-shot headless ACP task: spawn → initialize → session/new →
//! session/prompt → collect updates → shutdown → report. This is the
//! whole A1 surface — the operator's `dispatch_acp` tool is a thin
//! wrapper around [`run_task`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::policy::resolve_headless_with_log;
use super::protocol::{SessionUpdate, ToolCallFields};
use super::session::{AcpError, AcpSession, AcpSpawnOpts, PermissionResolver};

#[derive(Debug, Clone)]
pub struct AcpRunOpts {
    pub cwd: PathBuf,
    pub prompt: String,
    pub timeout: Duration,
    /// Binary override; None → find `copilot` on PATH.
    pub program: Option<PathBuf>,
    /// Extra args for the child. Only tests use this (to run `sh -c`);
    /// production callers leave it empty.
    pub extra_args_for_tests: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AcpRunReport {
    /// "end_turn", "timeout", or whatever the agent reported.
    pub stop_reason: String,
    /// Concatenated agent_message_chunk text.
    pub agent_text: String,
    /// One line per finished tool call: `execute `ls` — completed (exit 0)`.
    pub tool_events: Vec<String>,
    /// Execute commands the policy refused.
    pub denied: Vec<String>,
}

#[derive(Default)]
struct Collector {
    text: String,
    /// toolCallId → latest known fields (updates are partial; merge).
    tools: HashMap<String, ToolCallFields>,
    order: Vec<String>,
}

pub async fn run_task(opts: AcpRunOpts) -> Result<AcpRunReport, AcpError> {
    let denied: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let denied_for_resolver = denied.clone();
    let resolver: PermissionResolver =
        Arc::new(move |req| resolve_headless_with_log(req, &denied_for_resolver));

    let session = AcpSession::spawn(
        AcpSpawnOpts {
            cwd: opts.cwd.clone(),
            program: opts.program.clone(),
            extra_args: opts.extra_args_for_tests.clone(),
        },
        resolver,
    )
    .await?;

    let collector: Arc<Mutex<Collector>> = Arc::new(Mutex::new(Collector::default()));
    let collector_task = {
        let collector = collector.clone();
        let mut events = session.events();
        tokio::spawn(async move {
            while let Ok(n) = events.recv().await {
                let mut c = match collector.lock() {
                    Ok(c) => c,
                    Err(_) => break,
                };
                match n.update {
                    SessionUpdate::AgentMessageChunk { content } => {
                        if let Some(t) = content.as_text() {
                            c.text.push_str(t);
                        }
                    }
                    SessionUpdate::ToolCall(f) | SessionUpdate::ToolCallUpdate(f) => {
                        if !c.tools.contains_key(&f.tool_call_id) {
                            c.order.push(f.tool_call_id.clone());
                        }
                        merge_tool(&mut c.tools, f);
                    }
                    _ => {}
                }
            }
        })
    };

    let init = session
        .request(
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } }
            }),
        )
        .await?;
    tracing::debug!(agent = ?init.get("agentInfo"), "acp initialize ok");

    let new_sess = session
        .request(
            "session/new",
            serde_json::json!({ "cwd": opts.cwd.to_string_lossy(), "mcpServers": [] }),
        )
        .await?;
    let session_id = new_sess
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let prompt_fut = session.request(
        "session/prompt",
        serde_json::json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": opts.prompt }]
        }),
    );

    let stop_reason = match tokio::time::timeout(opts.timeout, prompt_fut).await {
        Ok(Ok(result)) => result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        Ok(Err(e)) => {
            session.shutdown(Duration::from_secs(3)).await;
            collector_task.abort();
            return Err(e);
        }
        Err(_elapsed) => {
            // Best-effort cancel, then tear down. Partial report is
            // still useful to the operator.
            let _ = session
                .notify(
                    "session/cancel",
                    serde_json::json!({ "sessionId": session_id }),
                )
                .await;
            "timeout".to_string()
        }
    };

    session.shutdown(Duration::from_secs(3)).await;
    collector_task.abort();

    let c = collector.lock().map_err(|_| AcpError::Closed)?;
    let denied = denied.lock().map_err(|_| AcpError::Closed)?.clone();
    Ok(AcpRunReport {
        stop_reason,
        agent_text: c.text.clone(),
        tool_events: c.order.iter().filter_map(|id| c.tools.get(id)).map(tool_line).collect(),
        denied,
    })
}

/// Later frames win field-by-field; earlier non-empty values survive
/// partial updates (tool_call_update often omits title/kind).
fn merge_tool(tools: &mut HashMap<String, ToolCallFields>, f: ToolCallFields) {
    match tools.get_mut(&f.tool_call_id) {
        None => {
            tools.insert(f.tool_call_id.clone(), f);
        }
        Some(existing) => {
            if f.title.is_some() {
                existing.title = f.title;
            }
            if f.kind.is_some() {
                existing.kind = f.kind;
            }
            if f.status.is_some() {
                existing.status = f.status;
            }
            if f.raw_input.is_some() {
                existing.raw_input = f.raw_input;
            }
            if f.raw_output.is_some() {
                existing.raw_output = f.raw_output;
            }
            if !f.content.is_empty() {
                existing.content = f.content;
            }
        }
    }
}

fn tool_line(f: &ToolCallFields) -> String {
    let kind = f.kind.as_deref().unwrap_or("tool");
    let what = f
        .command()
        .map(|c| format!("`{c}`"))
        .or_else(|| f.title.clone())
        .unwrap_or_else(|| f.tool_call_id.clone());
    let status = f.status.as_deref().unwrap_or("unknown");
    match f.exit_code() {
        Some(code) => format!("{kind} {what} — {status} (exit {code})"),
        None => format!("{kind} {what} — {status}"),
    }
}
```

Note `AcpRunOpts` gains `extra_args_for_tests` (used by both tests); production callers pass `vec![]`.

- [ ] **Step 4: Run tests, verify they pass**

Run: `cargo test -p karl-agent acp::run`
Expected: 2 PASS, 1 ignored.

- [ ] **Step 5: Run the real smoke test once, manually**

Run: `cargo test -p karl-agent acp::run::tests::smoke_real_copilot -- --ignored --nocapture`
Expected: PASS (needs authenticated copilot; ~30-90s). If copilot is missing on the machine, note it in the task report and move on — the fake-agent tests are the gate.

- [ ] **Step 6: Commit**

```bash
git add crates/agent/src/acp/run.rs crates/agent/src/acp/mod.rs
git commit -m "feat(acp): run_task headless orchestrator with policy-gated permissions"
```

---

### Task 5: `dispatch_acp` operator tool (A1)

**Files:**
- Modify: `crates/app/src/teammate/tools.rs` — add `ToolError::Acp` variant (enum at tools.rs:15-33), `dispatch_acp_tool_def()`, `DispatchAcpArgs`, `pub async fn dispatch_acp`, `fn format_acp_report`
- Modify: `crates/app/src/teammate/llm.rs:588` — push the def in `all_tool_defs`; `llm.rs:542` — add the match arm
- Test: same-file `#[cfg(test)]` additions in `tools.rs`

**Interfaces:**
- Consumes: `karl_agent::acp::{run_task, AcpRunOpts, AcpRunReport}` (Task 4); existing `ToolEnv` (tools.rs:36-53), `ToolError`.
- Produces: `pub fn dispatch_acp_tool_def() -> Value`; `pub async fn dispatch_acp(env: &ToolEnv, args: &Value) -> Result<String, ToolError>`.

- [ ] **Step 1: Verify crates/app already depends on karl-agent**

Run: `grep -n "karl-agent" crates/app/Cargo.toml`
Expected: a path dependency line exists (the app already uses `karl_agent::safety` etc.). If absent, STOP and re-check — do not add deps without flagging it in the task report.

- [ ] **Step 2: Write the failing tests** (append to the existing `#[cfg(test)]` module in `tools.rs`)

```rust
#[tokio::test]
async fn dispatch_acp_rejects_cwd_escape() {
    let dir = tempfile::tempdir().expect("tempdir");
    let env = ToolEnv::new(dir.path().to_path_buf());
    let err = dispatch_acp(
        &env,
        &serde_json::json!({ "prompt": "x", "cwd": "../../etc" }),
    )
    .await
    .expect_err("must reject");
    assert!(err.to_string().contains("escapes"), "got: {err}");
}

#[tokio::test]
async fn dispatch_acp_requires_prompt() {
    let dir = tempfile::tempdir().expect("tempdir");
    let env = ToolEnv::new(dir.path().to_path_buf());
    let err = dispatch_acp(&env, &serde_json::json!({}))
        .await
        .expect_err("must reject");
    assert!(matches!(err, ToolError::InvalidArgs(_)));
}

#[test]
fn dispatch_acp_def_shape() {
    let def = dispatch_acp_tool_def();
    assert_eq!(def["name"], "dispatch_acp");
    assert_eq!(def["input_schema"]["required"][0], "prompt");
}

#[test]
fn format_acp_report_is_bounded_and_complete() {
    let report = karl_agent::acp::AcpRunReport {
        stop_reason: "end_turn".into(),
        agent_text: "x".repeat(10_000),
        tool_events: vec!["execute `ls` — completed (exit 0)".into()],
        denied: vec!["sudo reboot".into()],
    };
    let s = format_acp_report(&report);
    assert!(s.contains("end_turn"));
    assert!(s.contains("execute `ls`"));
    assert!(s.contains("sudo reboot"));
    assert!(s.len() < 6_000, "report must be truncated, got {}", s.len());
}
```

Adjust `ToolEnv::new(...)` to however the existing tests in that file construct a `ToolEnv` (there are existing tests for `read_file`/`run_command` — copy their constructor idiom exactly).

- [ ] **Step 3: Run tests, verify they fail to compile**

Run: `cargo test -p covenant_lib teammate::tools::` (check the actual lib name in `crates/app/Cargo.toml` `[lib] name`; memory says tests run as `covenant_lib`)

- [ ] **Step 4: Implement in `tools.rs`**

Add to `ToolError`:

```rust
    #[error("acp: {0}")]
    Acp(String),
```

Then:

```rust
pub fn dispatch_acp_tool_def() -> Value {
    serde_json::json!({
        "name": "dispatch_acp",
        "description": "Dispatch a self-contained coding task to a background GitHub Copilot session (no terminal tab). File edits are confined to the workspace; shell commands are auto-approved only when read-only-safe and denied otherwise. Blocks until done (default 240s, max 600s) and returns a report: the agent's final message, tool activity, and any denied commands. Use for delegable subtasks — write a script, draft a fix, run an analysis — not for interactive work.",
        "input_schema": {
            "type": "object",
            "required": ["prompt"],
            "additionalProperties": false,
            "properties": {
                "prompt": {
                    "type": "string",
                    "description": "Complete, self-contained instructions for the Copilot agent. Include all context it needs; it cannot ask follow-ups."
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional working directory, relative to the workspace root."
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "Max seconds to wait before returning a partial report (default 240, max 600)."
                }
            }
        }
    })
}

#[derive(Debug, serde::Deserialize)]
struct DispatchAcpArgs {
    prompt: String,
    #[serde(default)]
    cwd: Option<String>,
    #[serde(default)]
    timeout_secs: Option<u64>,
}

pub async fn dispatch_acp(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let parsed: DispatchAcpArgs =
        serde_json::from_value(args.clone()).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
    let root = env
        .root
        .canonicalize()
        .unwrap_or_else(|_| env.root.clone());
    let cwd = match parsed.cwd.as_deref() {
        None | Some("") | Some(".") => root.clone(),
        Some(rel) => {
            let canon = root
                .join(rel)
                .canonicalize()
                .map_err(|e| ToolError::InvalidArgs(format!("cwd: {e}")))?;
            if !canon.starts_with(&root) {
                return Err(ToolError::InvalidArgs(
                    "cwd escapes the workspace root".into(),
                ));
            }
            canon
        }
    };
    let timeout_secs = parsed.timeout_secs.unwrap_or(240).min(600);
    let report = karl_agent::acp::run_task(karl_agent::acp::AcpRunOpts {
        cwd,
        prompt: parsed.prompt,
        timeout: std::time::Duration::from_secs(timeout_secs),
        program: None,
        extra_args_for_tests: vec![],
    })
    .await
    .map_err(|e| ToolError::Acp(e.to_string()))?;
    Ok(format_acp_report(&report))
}

/// Bounded plain-text report for the LLM turn.
pub(crate) fn format_acp_report(report: &karl_agent::acp::AcpRunReport) -> String {
    // ponytail: 4000-char cap on agent text; raise if operators start
    // asking the agent to summarize its own truncated output.
    const TEXT_CAP: usize = 4000;
    let mut out = format!("stop_reason: {}\n", report.stop_reason);
    if !report.tool_events.is_empty() {
        out.push_str("tool activity:\n");
        for line in &report.tool_events {
            out.push_str("  - ");
            out.push_str(line);
            out.push('\n');
        }
    }
    if !report.denied.is_empty() {
        out.push_str("denied by policy (not executed):\n");
        for cmd in &report.denied {
            out.push_str("  - ");
            out.push_str(cmd);
            out.push('\n');
        }
    }
    out.push_str("agent message:\n");
    if report.agent_text.len() > TEXT_CAP {
        let cut = report
            .agent_text
            .char_indices()
            .take_while(|(i, _)| *i < TEXT_CAP)
            .last()
            .map(|(i, c)| i + c.len_utf8())
            .unwrap_or(TEXT_CAP.min(report.agent_text.len()));
        out.push_str(&report.agent_text[..cut]);
        out.push_str("\n[truncated]");
    } else {
        out.push_str(&report.agent_text);
    }
    out
}
```

Note on the escape test: `root.join("../../etc").canonicalize()` succeeds (the path exists) but fails `starts_with(&root)` → the error message must contain "escapes" (the first test asserts on it). If canonicalize fails (nonexistent path), `InvalidArgs("cwd: ...")` is also an acceptable rejection — but keep the test's `../../etc` which exists on macOS.

- [ ] **Step 5: Register in `llm.rs`**

In `all_tool_defs` (llm.rs:588), after `tools::propose_task_tool_def(),`:

```rust
        tools::dispatch_acp_tool_def(),
```

In the `execute_tool` match (llm.rs:542), after the `"read_terminal_screen"` arm:

```rust
        "dispatch_acp" => tools::dispatch_acp(tool_env, input).await,
```

- [ ] **Step 6: Run tests, verify they pass**

Run: `cargo test -p covenant_lib teammate::tools::`
Expected: new tests PASS (the two async ones don't spawn copilot: they fail on arg validation before reaching `run_task`), existing tests still green.

- [ ] **Step 7: Compile the whole app**

Run: `cargo check -p covenant_lib` (or the app crate name from `crates/app/Cargo.toml`)
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add crates/app/src/teammate/tools.rs crates/app/src/teammate/llm.rs
git commit -m "feat(teammate): dispatch_acp operator tool — headless Copilot subtasks via ACP"
```

---

## Out of scope (explicitly deferred)

- **A2**: `kind:"acp"` tab UI, per-operator gating of `dispatch_acp`, ExecutorPhase mapping via `NotchHub::set_phase`, model/mode selection.
- **A3**: ACP as default for copilot; claude/codex ACP adapters.
- Client-side `fs/read_text_file`/`fs/write_text_file` (we decline them; copilot uses its own file tools).
- Streaming progress from a running `dispatch_acp` into the teammate tile (the generic `teammate-tool-call` event already announces the call itself).

## Verification (whole feature)

1. `cargo test -p karl-agent acp::` — all unit tests green.
2. `cargo test -p karl-agent pi_rpc::` — no regression from the visibility change.
3. `cargo test -p covenant_lib teammate::` — operator tool green.
4. Manual smoke: `cargo test -p karl-agent acp::run::tests::smoke_real_copilot -- --ignored --nocapture`.
5. In-app (post-merge, PENDING like siblings): chat with an operator, ask it to "usa dispatch_acp para crear un script X en el repo", confirm the report lands in the thread and the file exists.
