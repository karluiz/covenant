//! Wire types for Pi's RPC protocol. Names mirror the spec verbatim:
//! command/event discriminants are `snake_case`, struct fields are
//! `camelCase`. Do not rename — these go directly on the wire.
//!
//! Source of truth: Pi's `docs/rpc.md`. Variants we don't model yet are
//! captured by [`PiEvent::Unknown`] / [`PiResponse::Unknown`] so the
//! reader never drops a line it can't classify.

use serde::{Deserialize, Serialize};
use serde_json::Value;

// ---------------------------------------------------------------------------
// Inbound envelope: every JSONL line from `pi --mode rpc` is one of these.
// We keep a top-level untagged envelope so a single `serde_json::from_slice`
// call routes both responses and events into a single channel without a
// second peek-then-parse pass.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PiEnvelope {
    Response(PiResponse),
    Event(PiEvent),
}

// ---------------------------------------------------------------------------
// Responses (correlated to commands by `id`).
// ---------------------------------------------------------------------------

/// Wire shape: `{"type":"response", "command":"<name>", "success":bool,
/// "id":"<id>", "data":<value>?, "error":"<msg>"?}`.
///
/// We intentionally keep `data` typed as `serde_json::Value` instead of
/// enumerating every command's response shape. The set of typed accessors
/// lives next to consumer code (`get_state`, `get_session_stats`, …); the
/// raw response stays generic so adding a command doesn't require touching
/// this file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiResponse {
    #[serde(rename = "type")]
    pub kind: ResponseTag,
    pub command: String,
    pub success: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ResponseTag {
    Response,
}

// ---------------------------------------------------------------------------
// Outbound commands.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PiCommand {
    // ---- Prompting ----
    Prompt {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none", rename = "streamingBehavior")]
        streaming_behavior: Option<StreamingBehavior>,
        #[serde(skip_serializing_if = "Option::is_none")]
        images: Option<Vec<PromptImage>>,
    },
    Steer {
        message: String,
    },
    FollowUp {
        message: String,
    },
    Abort,
    NewSession {
        #[serde(skip_serializing_if = "Option::is_none", rename = "parentSession")]
        parent_session: Option<String>,
    },

    // ---- State ----
    GetState {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetMessages {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },

    // ---- Model ----
    SetModel {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        provider: String,
        #[serde(rename = "modelId")]
        model_id: String,
    },
    CycleModel,
    GetAvailableModels {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },

    // ---- Thinking ----
    SetThinkingLevel {
        level: ThinkingLevel,
    },
    CycleThinkingLevel,

    // ---- Queue modes ----
    SetSteeringMode {
        mode: QueueMode,
    },
    SetFollowUpMode {
        mode: QueueMode,
    },

    // ---- Compaction & retry ----
    Compact {
        #[serde(
            skip_serializing_if = "Option::is_none",
            rename = "customInstructions"
        )]
        custom_instructions: Option<String>,
    },
    SetAutoCompaction {
        enabled: bool,
    },
    SetAutoRetry {
        enabled: bool,
    },
    AbortRetry,

    // ---- Bash (we expose via RPC for parity; the UI prefers shell tabs) ----
    Bash {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        command: String,
    },
    AbortBash,

    // ---- Session management ----
    GetSessionStats {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    ExportHtml {
        #[serde(skip_serializing_if = "Option::is_none", rename = "outputPath")]
        output_path: Option<String>,
    },
    SwitchSession {
        #[serde(rename = "sessionPath")]
        session_path: String,
    },
    Fork {
        #[serde(rename = "entryId")]
        entry_id: String,
    },
    Clone,
    GetForkMessages {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    GetLastAssistantText {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    SetSessionName {
        name: String,
    },
    GetCommands {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },

    // ---- Extension UI (responses go via this command, not a separate enum) ----
    ExtensionUiResponse {
        id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        value: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        confirmed: Option<bool>,
        #[serde(skip_serializing_if = "Option::is_none")]
        cancelled: Option<bool>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StreamingBehavior {
    Steer,
    FollowUp,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingLevel {
    Off,
    Minimal,
    Low,
    Medium,
    High,
    #[serde(rename = "xhigh")]
    XHigh,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum QueueMode {
    All,
    OneAtATime,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    #[serde(rename = "type")]
    pub kind: String, // always "image" per spec
    pub data: String, // base64
    pub mime_type: String,
}

// ---------------------------------------------------------------------------
// Inbound events (no `id` field per spec).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PiEvent {
    // Core lifecycle
    AgentStart,
    AgentEnd {
        messages: Vec<AgentMessage>,
    },
    TurnStart,
    TurnEnd {
        message: AssistantMessage,
        #[serde(default, rename = "toolResults")]
        tool_results: Vec<ToolResultMessage>,
    },

    // Message streaming
    MessageStart {
        message: AgentMessage,
    },
    MessageUpdate {
        message: AgentMessage,
        #[serde(rename = "assistantMessageEvent")]
        assistant_message_event: DeltaEvent,
    },
    MessageEnd {
        message: AgentMessage,
    },

    // Tool execution
    ToolExecutionStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
    },
    ToolExecutionUpdate {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        args: Value,
        #[serde(rename = "partialResult")]
        partial_result: Value,
    },
    ToolExecutionEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolName")]
        tool_name: String,
        result: Value,
        #[serde(default, rename = "isError")]
        is_error: bool,
    },

    // Queue & context
    QueueUpdate {
        #[serde(default)]
        steering: Vec<String>,
        #[serde(default, rename = "followUp")]
        follow_up: Vec<String>,
    },
    CompactionStart {
        reason: CompactionReason,
    },
    CompactionEnd {
        reason: CompactionReason,
        #[serde(default)]
        result: Option<CompactionResult>,
        #[serde(default)]
        aborted: bool,
        #[serde(default, rename = "willRetry")]
        will_retry: bool,
    },

    // Retry
    AutoRetryStart {
        attempt: u32,
        #[serde(rename = "maxAttempts")]
        max_attempts: u32,
        #[serde(rename = "delayMs")]
        delay_ms: u64,
        #[serde(default, rename = "errorMessage")]
        error_message: Option<String>,
    },
    AutoRetryEnd {
        success: bool,
        attempt: u32,
        #[serde(default, rename = "finalError")]
        final_error: Option<String>,
    },

    // Extensions
    ExtensionError {
        #[serde(rename = "extensionPath")]
        extension_path: String,
        event: String,
        error: String,
    },
    ExtensionUiRequest {
        id: String,
        method: UiMethod,
        #[serde(flatten)]
        params: Value,
    },

    /// Synthetic event injected by [`super::session::PiSession`] when the
    /// child process exits. Not part of Pi's wire format — never emitted
    /// by `pi` itself. UI uses it to flip the tab to a crashed state.
    #[serde(skip_deserializing)]
    ProcessExited { code: Option<i32> },

    /// Catch-all for event variants we haven't modeled yet. Keeps the
    /// reader from dropping lines on protocol additions. The full JSON
    /// is preserved so consumers can downcast or log it.
    #[serde(other, skip_serializing)]
    Unknown,
}

// ---------------------------------------------------------------------------
// Delta events (streaming chunks inside MessageUpdate).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum DeltaEvent {
    Start,
    TextStart {
        #[serde(rename = "contentIndex")]
        content_index: u32,
    },
    TextDelta {
        #[serde(rename = "contentIndex")]
        content_index: u32,
        delta: String,
        #[serde(default)]
        partial: Option<Value>,
    },
    TextEnd {
        #[serde(rename = "contentIndex")]
        content_index: u32,
    },
    ThinkingStart {
        #[serde(rename = "contentIndex")]
        content_index: u32,
    },
    ThinkingDelta {
        #[serde(rename = "contentIndex")]
        content_index: u32,
        delta: String,
    },
    ThinkingEnd {
        #[serde(rename = "contentIndex")]
        content_index: u32,
    },
    ToolcallStart {
        #[serde(rename = "contentIndex")]
        content_index: u32,
    },
    ToolcallDelta {
        #[serde(rename = "contentIndex")]
        content_index: u32,
        delta: String,
    },
    ToolcallEnd {
        #[serde(rename = "contentIndex")]
        content_index: u32,
    },
    Done,
    Error {
        message: String,
    },
    /// Future variants don't crash the stream.
    #[serde(other)]
    Unknown,
}

// ---------------------------------------------------------------------------
// Message shapes (carried inside events).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "role", rename_all = "camelCase")]
pub enum AgentMessage {
    User(UserMessage),
    Assistant(AssistantMessage),
    ToolResult(ToolResultMessage),
    BashExecution(BashExecutionMessage),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MessageRole {
    User,
    Assistant,
    ToolResult,
    BashExecution,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserMessage {
    pub content: String,
    #[serde(default)]
    pub timestamp: Option<i64>,
    #[serde(default)]
    pub attachments: Vec<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssistantMessage {
    pub content: Vec<AssistantContent>,
    #[serde(default)]
    pub model: Option<String>,
    #[serde(default, rename = "stopReason")]
    pub stop_reason: Option<StopReason>,
    #[serde(default)]
    pub usage: Option<Value>,
    #[serde(default)]
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum AssistantContent {
    Text {
        text: String,
    },
    Thinking {
        thinking: String,
    },
    ToolCall {
        id: String,
        name: String,
        #[serde(default)]
        arguments: Value,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum StopReason {
    Stop,
    Length,
    ToolUse,
    Error,
    Aborted,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolResultMessage {
    #[serde(rename = "toolCallId")]
    pub tool_call_id: String,
    #[serde(rename = "toolName")]
    pub tool_name: String,
    #[serde(default)]
    pub content: Vec<ToolResultContent>,
    #[serde(default, rename = "isError")]
    pub is_error: bool,
    #[serde(default)]
    pub timestamp: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum ToolResultContent {
    Text { text: String },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BashExecutionMessage {
    pub command: String,
    pub output: String,
    #[serde(default, rename = "exitCode")]
    pub exit_code: Option<i32>,
    #[serde(default)]
    pub cancelled: bool,
    #[serde(default)]
    pub truncated: bool,
    #[serde(default)]
    pub timestamp: Option<i64>,
}

// ---------------------------------------------------------------------------
// Compaction / state-snapshot shapes.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompactionReason {
    Manual,
    Threshold,
    Overflow,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactionResult {
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default, rename = "firstKeptEntryId")]
    pub first_kept_entry_id: Option<String>,
    #[serde(default, rename = "tokensBefore")]
    pub tokens_before: Option<u64>,
}

/// Typed view of the `data` payload returned by `get_state`. Held loosely
/// because Pi's spec doesn't pin every field — extra keys are ignored.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PiState {
    #[serde(default)]
    pub model: Option<Value>,
    #[serde(default, rename = "thinkingLevel")]
    pub thinking_level: Option<ThinkingLevel>,
    #[serde(default, rename = "isStreaming")]
    pub is_streaming: bool,
    #[serde(default, rename = "sessionPath")]
    pub session_path: Option<String>,
    #[serde(default, rename = "messageCount")]
    pub message_count: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PiSessionStats {
    #[serde(default, rename = "inputTokens")]
    pub input_tokens: Option<u64>,
    #[serde(default, rename = "outputTokens")]
    pub output_tokens: Option<u64>,
    #[serde(default, rename = "totalCost")]
    pub total_cost: Option<f64>,
    #[serde(default, rename = "contextWindowUsed")]
    pub context_window_used: Option<u64>,
}

// ---------------------------------------------------------------------------
// Extension UI methods.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum UiMethod {
    Select,
    Confirm,
    Input,
    Editor,
    Notify,
    SetStatus,
    SetWidget,
    SetTitle,
    SetEditorText,
}

// ---------------------------------------------------------------------------
// Tests — fixture parsing against the spec's literal JSON examples.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn parse<T: for<'de> Deserialize<'de>>(s: &str) -> T {
        serde_json::from_str(s).unwrap_or_else(|e| panic!("parse {s:?}: {e}"))
    }

    #[test]
    fn serializes_prompt_command() {
        let cmd = PiCommand::Prompt {
            id: Some("req-1".into()),
            message: "Hello, world!".into(),
            streaming_behavior: None,
            images: None,
        };
        let s = serde_json::to_string(&cmd).unwrap();
        // Field order is stable in serde_json with no extra config.
        assert_eq!(s, r#"{"type":"prompt","id":"req-1","message":"Hello, world!"}"#);
    }

    #[test]
    fn serializes_set_model_command() {
        let cmd = PiCommand::SetModel {
            id: None,
            provider: "anthropic".into(),
            model_id: "claude-sonnet-4-20250514".into(),
        };
        let s = serde_json::to_string(&cmd).unwrap();
        assert_eq!(
            s,
            r#"{"type":"set_model","provider":"anthropic","modelId":"claude-sonnet-4-20250514"}"#
        );
    }

    #[test]
    fn serializes_set_thinking_level() {
        let cmd = PiCommand::SetThinkingLevel {
            level: ThinkingLevel::XHigh,
        };
        let s = serde_json::to_string(&cmd).unwrap();
        assert_eq!(s, r#"{"type":"set_thinking_level","level":"xhigh"}"#);
    }

    #[test]
    fn serializes_steering_mode_kebab() {
        let cmd = PiCommand::SetSteeringMode {
            mode: QueueMode::OneAtATime,
        };
        let s = serde_json::to_string(&cmd).unwrap();
        assert_eq!(s, r#"{"type":"set_steering_mode","mode":"one-at-a-time"}"#);
    }

    #[test]
    fn parses_response_success_with_data() {
        let r: PiResponse = parse(
            r#"{"type":"response","command":"get_state","success":true,"data":{"isStreaming":false}}"#,
        );
        assert_eq!(r.command, "get_state");
        assert!(r.success);
        assert!(r.data.is_some());
    }

    #[test]
    fn parses_response_failure() {
        let r: PiResponse = parse(
            r#"{"type":"response","command":"set_model","success":false,"error":"Model not found: invalid/model"}"#,
        );
        assert!(!r.success);
        assert_eq!(r.error.as_deref(), Some("Model not found: invalid/model"));
    }

    #[test]
    fn parses_envelope_routes_response() {
        let env: PiEnvelope = parse(
            r#"{"type":"response","command":"abort","success":true,"id":"x"}"#,
        );
        match env {
            PiEnvelope::Response(r) => assert_eq!(r.id.as_deref(), Some("x")),
            _ => panic!("expected response"),
        }
    }

    #[test]
    fn parses_envelope_routes_event() {
        let env: PiEnvelope = parse(r#"{"type":"agent_start"}"#);
        match env {
            PiEnvelope::Event(PiEvent::AgentStart) => {}
            other => panic!("expected agent_start, got {other:?}"),
        }
    }

    #[test]
    fn parses_turn_end_event() {
        let env: PiEnvelope = parse(
            r#"{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"toolResults":[]}"#,
        );
        match env {
            PiEnvelope::Event(PiEvent::TurnEnd { message, tool_results }) => {
                assert_eq!(tool_results.len(), 0);
                assert_eq!(message.content.len(), 1);
                match &message.content[0] {
                    AssistantContent::Text { text } => assert_eq!(text, "hi"),
                    _ => panic!(),
                }
            }
            other => panic!("expected turn_end, got {other:?}"),
        }
    }

    #[test]
    fn parses_text_delta_event() {
        let env: PiEnvelope = parse(
            r#"{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"Hello "}]},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}"#,
        );
        match env {
            PiEnvelope::Event(PiEvent::MessageUpdate {
                assistant_message_event: DeltaEvent::TextDelta { delta, content_index, .. },
                ..
            }) => {
                assert_eq!(delta, "Hello ");
                assert_eq!(content_index, 0);
            }
            other => panic!("expected message_update/text_delta, got {other:?}"),
        }
    }

    #[test]
    fn parses_tool_execution_start() {
        let env: PiEnvelope = parse(
            r#"{"type":"tool_execution_start","toolCallId":"call_abc","toolName":"bash","args":{"command":"ls"}}"#,
        );
        match env {
            PiEnvelope::Event(PiEvent::ToolExecutionStart {
                tool_call_id, tool_name, args,
            }) => {
                assert_eq!(tool_call_id, "call_abc");
                assert_eq!(tool_name, "bash");
                assert_eq!(args["command"], "ls");
            }
            other => panic!("expected tool_execution_start, got {other:?}"),
        }
    }

    #[test]
    fn parses_queue_update_with_defaults() {
        // `followUp` omitted — must default to empty vec, not fail to parse.
        let env: PiEnvelope = parse(r#"{"type":"queue_update","steering":["foo"]}"#);
        match env {
            PiEnvelope::Event(PiEvent::QueueUpdate { steering, follow_up }) => {
                assert_eq!(steering, vec!["foo"]);
                assert!(follow_up.is_empty());
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parses_compaction_end_event() {
        let env: PiEnvelope = parse(
            r#"{"type":"compaction_end","reason":"threshold","result":{"summary":"…","tokensBefore":150000},"aborted":false,"willRetry":false}"#,
        );
        match env {
            PiEnvelope::Event(PiEvent::CompactionEnd { reason, result, aborted, will_retry }) => {
                assert_eq!(reason, CompactionReason::Threshold);
                assert!(!aborted);
                assert!(!will_retry);
                let r = result.expect("result");
                assert_eq!(r.tokens_before, Some(150000));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parses_extension_ui_request_with_extra_fields() {
        // `params` flattens whatever the method-specific keys are. We only
        // need to extract id + method to wire the response; consumer code
        // pulls the rest from `params`.
        let env: PiEnvelope = parse(
            r#"{"type":"extension_ui_request","id":"uuid-1","method":"select","title":"Allow?","options":["Allow","Block"]}"#,
        );
        match env {
            PiEnvelope::Event(PiEvent::ExtensionUiRequest { id, method, params }) => {
                assert_eq!(id, "uuid-1");
                assert_eq!(method, UiMethod::Select);
                assert_eq!(params["title"], "Allow?");
                assert_eq!(params["options"][1], "Block");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn unknown_event_does_not_fail_parse() {
        // Future Pi versions may add event types; ensure the reader keeps
        // making progress instead of crashing.
        let env: PiEnvelope = parse(r#"{"type":"some_future_event","foo":1}"#);
        match env {
            PiEnvelope::Event(PiEvent::Unknown) => {}
            other => panic!("expected Unknown, got {other:?}"),
        }
    }

    #[test]
    fn parses_user_message_role() {
        let m: AgentMessage = parse(
            r#"{"role":"user","content":"hi","timestamp":1733234567890}"#,
        );
        match m {
            AgentMessage::User(u) => {
                assert_eq!(u.content, "hi");
                assert_eq!(u.timestamp, Some(1733234567890));
            }
            _ => panic!(),
        }
    }

    #[test]
    fn parses_tool_result_message() {
        let m: AgentMessage = parse(
            r#"{"role":"toolResult","toolCallId":"c1","toolName":"bash","content":[{"type":"text","text":"out"}],"isError":false}"#,
        );
        match m {
            AgentMessage::ToolResult(t) => {
                assert_eq!(t.tool_call_id, "c1");
                assert!(!t.is_error);
                assert_eq!(t.content.len(), 1);
            }
            _ => panic!(),
        }
    }
}
