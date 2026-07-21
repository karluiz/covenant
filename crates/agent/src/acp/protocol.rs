//! ACP wire types. Inbound frames are JSON-RPC 2.0; `session/update`
//! notification payloads are internally tagged on `sessionUpdate`.
//! Everything tolerates unknown variants — the protocol is public preview.

use serde::{Deserialize, Serialize};
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionNotification {
    pub session_id: String,
    pub update: SessionUpdate,
}

/// One streamed update. `#[serde(other)] Unknown` swallows kinds we don't
/// model yet (plan, config_option_update, …) so preview-protocol drift
/// never kills a session.
///
/// `Serialize` is derived so the app layer can re-emit a typed
/// `SessionUpdate` to the frontend verbatim (see `acp_commands::AcpTabEvent`)
/// instead of round-tripping through a lossy re-serialization of a parsed
/// struct. `#[serde(other)]` only affects `Deserialize` codegen — on the
/// `Serialize` side `Unknown` just serializes as its own tagged variant,
/// which is never produced by the app (it's a deserialize-only catch-all),
/// so this asymmetry is inert in practice; covered by the round-trip test
/// below.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "sessionUpdate", rename_all = "snake_case")]
pub enum SessionUpdate {
    AgentMessageChunk {
        content: ContentBlock,
    },
    AgentThoughtChunk {
        content: ContentBlock,
    },
    /// Only seen during a `session/load` replay — live prompts never echo
    /// the user's message back (verified against copilot 1.0.68). Typed so
    /// the tag survives the re-emit to the frontend (Unknown would eat it).
    UserMessageChunk {
        content: ContentBlock,
    },
    ToolCall(ToolCallFields),
    ToolCallUpdate(ToolCallFields),
    AvailableCommandsUpdate {
        #[serde(default, rename = "availableCommands")]
        available_commands: Vec<AvailableCommand>,
    },
    #[serde(other)]
    Unknown,
}

/// One slash command advertised by `available_commands_update` (e.g.
/// `/compact`, `/autopilot`). Invoked by sending the command as plain
/// prompt text — verified against copilot 1.0.68.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AvailableCommand {
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    /// Free-form argument hint (wire shape: `{"hint": "focus instructions"}`).
    #[serde(default)]
    pub input: Option<Value>,
}

/// Shared field bag for `tool_call` and `tool_call_update` — the wire
/// sends the same camelCase keys on both, all optional on updates.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
/// Value fallback: order matters — most-specific first.
#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionRequest {
    pub session_id: String,
    pub tool_call: PermissionToolCall,
    pub options: Vec<PermissionOption>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
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

#[cfg(test)]
impl PermissionToolCall {
    /// Test-only constructor mirroring the real shape: `kind` set, and
    /// `rawInput.command` populated when a command is given so
    /// `command()` returns it.
    pub fn for_test(kind: &str, command: Option<&str>) -> Self {
        PermissionToolCall {
            tool_call_id: "call_test".to_string(),
            title: None,
            kind: Some(kind.to_string()),
            raw_input: command.map(|c| serde_json::json!({ "command": c })),
        }
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
    fn user_message_chunk_parses_typed_and_keeps_tag_on_reserialize() {
        // session/load replay frame. Must NOT fall into Unknown — the tag
        // has to survive the re-emit to the frontend for transcript restore.
        let f = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"user_message_chunk","content":{"type":"text","text":"fix the bug"}}}}"#,
        );
        let n = update_of(&f);
        match &n.update {
            SessionUpdate::UserMessageChunk { content } => {
                assert_eq!(content.as_text(), Some("fix the bug"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        let re = serde_json::to_value(&n.update).expect("re-serialize");
        assert_eq!(re["sessionUpdate"], "user_message_chunk");
        assert_eq!(re["content"]["text"], "fix the bug");
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
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"config_option_update","configOptions":[]}}}"#,
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"some_future_kind","whatever":true}}}"#,
        ] {
            let n = update_of(&parse(raw));
            assert!(matches!(n.update, SessionUpdate::Unknown));
        }
    }

    #[test]
    fn available_commands_update_parses_typed() {
        // Verbatim (trimmed) from copilot 1.0.68.
        let f = parse(
            r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"available_commands_update","availableCommands":[{"name":"compact","description":"Summarize conversation history to reduce context window usage. Optionally provide focus instructions.","input":{"hint":"focus instructions"}},{"name":"autopilot","description":"Toggle autopilot mode","input":{"hint":"[on|off]"}}]}}}"#,
        );
        match update_of(&f).update {
            SessionUpdate::AvailableCommandsUpdate { available_commands } => {
                assert_eq!(available_commands.len(), 2);
                assert_eq!(available_commands[0].name, "compact");
                assert!(available_commands[0]
                    .description
                    .as_deref()
                    .unwrap_or_default()
                    .starts_with("Summarize"));
                assert_eq!(
                    available_commands[1]
                        .input
                        .as_ref()
                        .and_then(|i| i.get("hint"))
                        .and_then(|h| h.as_str()),
                    Some("[on|off]")
                );
            }
            other => panic!("wrong variant: {other:?}"),
        }
    }
}
