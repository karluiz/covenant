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
/// Value fallback: order matters — most-specific first.
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
