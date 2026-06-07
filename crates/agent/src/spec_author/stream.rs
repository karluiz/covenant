//! Streaming tool-loop for the premium spec author.

use serde::Serialize;
use crate::spec_author::{tools, DraftMessage, MessageRole, SpecDraft, DraftStatus};
use async_trait::async_trait;
use std::path::Path;

/// One model turn's parsed output from a streaming response.
pub struct ModelTurn {
    /// Tool calls the model requested this turn (empty = it answered).
    pub tool_calls: Vec<ToolCall>,
    /// Assistant prose accumulated this turn.
    pub text: String,
    /// True if the text contained a closed <spec>…</spec>.
    pub emitted_spec: Option<String>,
}

#[derive(Clone)]
pub struct ToolCall { pub id: String, pub name: String, pub input: serde_json::Value }

/// Streams one model turn, pushing thinking/text/tool events into `sink` as they
/// arrive, and returns the parsed turn.
#[async_trait]
pub trait StreamingDispatcher: Send + Sync {
    async fn stream_turn(
        &self,
        system: &str,
        messages: &[DraftMessage],
        sink: &dyn StreamSink,
    ) -> Result<ModelTurn, String>;
}

/// Run the agentic tool-loop for one user message: repeatedly stream a turn,
/// execute any tool calls (emitting tool_start/tool_result), feed results back,
/// until the model answers or emits a spec. Enforces `max_tool_calls`.
pub async fn step_streaming<D: StreamingDispatcher>(
    dispatcher: &D,
    draft: &mut SpecDraft,
    user_msg: String,
    repo_root: &Path,
    system: &str,
    sink: &dyn StreamSink,
    max_tool_calls: usize,
) -> Result<(), String> {
    draft.messages.push(DraftMessage { role: MessageRole::User, content: user_msg });
    let mut tool_budget = max_tool_calls;

    loop {
        let turn = dispatcher.stream_turn(system, &draft.messages, sink).await?;

        if !turn.text.is_empty() {
            draft.messages.push(DraftMessage {
                role: MessageRole::Assistant, content: turn.text.clone() });
        }

        if let Some(md) = turn.emitted_spec {
            if crate::spec_author::validate_spec_markdown(&md).is_ok() {
                draft.partial_md = Some(md.clone());
                draft.status = DraftStatus::Ready;
                sink.emit(SpecStreamEvent::Final { markdown: md });
                return Ok(());
            }
        }

        if turn.tool_calls.is_empty() {
            sink.emit(SpecStreamEvent::TurnDone { awaiting_user: true });
            return Ok(());
        }

        let mut feedback = String::new();
        for call in turn.tool_calls {
            if tool_budget == 0 {
                sink.emit(SpecStreamEvent::Error {
                    message: "tool-call budget exhausted".into() });
                sink.emit(SpecStreamEvent::TurnDone { awaiting_user: true });
                return Ok(());
            }
            tool_budget -= 1;
            let arg = call.input.to_string();
            sink.emit(SpecStreamEvent::ToolStart {
                id: call.id.clone(), tool: call.name.clone(), arg });
            let (result, summary) = tools::run_tool(repo_root, &call.name, &call.input);
            sink.emit(SpecStreamEvent::ToolResult {
                id: call.id.clone(), summary, ok: !result.starts_with("error") });
            feedback.push_str(&format!("[tool {} → {}]\n{}\n\n", call.name, call.id, result));
        }
        draft.messages.push(DraftMessage { role: MessageRole::User, content: feedback });
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpecStreamEvent {
    ThinkingDelta { text: String },
    TextDelta { text: String },
    ToolStart { id: String, tool: String, arg: String },
    ToolResult { id: String, summary: String, ok: bool },
    SectionUpdate { section: String, markdown: String, status: String },
    Phase { section: String },
    TurnDone { awaiting_user: bool },
    Final { markdown: String },
    Error { message: String },
}

/// Callback sink the dispatcher pushes events into.
pub trait StreamSink: Send + Sync {
    fn emit(&self, event: SpecStreamEvent);
}

use futures_util::StreamExt;

pub struct AnthropicStreamingDispatcher {
    pub api_key: String,
    pub model: String,
}

#[async_trait]
impl StreamingDispatcher for AnthropicStreamingDispatcher {
    async fn stream_turn(
        &self,
        system: &str,
        messages: &[DraftMessage],
        sink: &dyn StreamSink,
    ) -> Result<ModelTurn, String> {
        let client = reqwest::Client::new();
        let api_messages: Vec<serde_json::Value> = messages.iter().map(|m| {
            let role = match m.role { MessageRole::User => "user", MessageRole::Assistant => "assistant" };
            serde_json::json!({ "role": role, "content": m.content })
        }).collect();

        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 8192,
            "stream": true,
            "thinking": { "type": "enabled", "budget_tokens": 4000 },
            "system": [{ "type": "text", "text": system,
                "cache_control": { "type": "ephemeral" } }],
            "tools": tools::tool_specs(),
            "messages": api_messages,
        });

        let resp = client.post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!("anthropic {}: {}", resp.status(),
                resp.text().await.unwrap_or_default()));
        }

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut text = String::new();
        let mut tool_json: std::collections::HashMap<usize, (String, String, String)> =
            std::collections::HashMap::new(); // idx -> (id, name, partial_input)

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buf.find("\n\n") {
                let frame = buf[..pos].to_string();
                buf.drain(..pos + 2);
                for line in frame.lines() {
                    let Some(data) = line.strip_prefix("data: ") else { continue };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else { continue };
                    parse_sse_event(&v, sink, &mut text, &mut tool_json);
                }
            }
        }

        let mut tool_calls: Vec<ToolCall> = Vec::new();
        for (_idx, (id, name, raw)) in tool_json.into_iter() {
            let input = serde_json::from_str(&raw).unwrap_or(serde_json::json!({}));
            tool_calls.push(ToolCall { id, name, input });
        }
        let emitted_spec = crate::spec_author::extract_spec_pub(&text);
        Ok(ModelTurn { tool_calls, text, emitted_spec })
    }
}

fn parse_sse_event(
    v: &serde_json::Value,
    sink: &dyn StreamSink,
    text: &mut String,
    tool_json: &mut std::collections::HashMap<usize, (String, String, String)>,
) {
    match v["type"].as_str() {
        Some("content_block_start") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            if v["content_block"]["type"] == "tool_use" {
                tool_json.insert(idx, (
                    v["content_block"]["id"].as_str().unwrap_or("").to_string(),
                    v["content_block"]["name"].as_str().unwrap_or("").to_string(),
                    String::new()));
            }
        }
        Some("content_block_delta") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            match v["delta"]["type"].as_str() {
                Some("thinking_delta") => {
                    if let Some(t) = v["delta"]["thinking"].as_str() {
                        sink.emit(SpecStreamEvent::ThinkingDelta { text: t.to_string() });
                    }
                }
                Some("text_delta") => {
                    if let Some(t) = v["delta"]["text"].as_str() {
                        text.push_str(t);
                        sink.emit(SpecStreamEvent::TextDelta { text: t.to_string() });
                    }
                }
                Some("input_json_delta") => {
                    if let Some(partial) = v["delta"]["partial_json"].as_str() {
                        if let Some(entry) = tool_json.get_mut(&idx) { entry.2.push_str(partial); }
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct VecSink(Mutex<Vec<SpecStreamEvent>>);
    impl StreamSink for VecSink {
        fn emit(&self, e: SpecStreamEvent) { self.0.lock().unwrap().push(e); }
    }

    use crate::spec_author::{SpecDraft, DraftStatus, Phase};
    use ulid::Ulid;

    // Mock: first turn requests one list_dir; second turn answers with text.
    struct ScriptedDispatcher { calls: Mutex<usize> }
    #[async_trait]
    impl StreamingDispatcher for ScriptedDispatcher {
        async fn stream_turn(&self, _sys: &str, _msgs: &[DraftMessage], sink: &dyn StreamSink)
            -> Result<ModelTurn, String> {
            let mut n = self.calls.lock().unwrap();
            *n += 1;
            if *n == 1 {
                sink.emit(SpecStreamEvent::ThinkingDelta { text: "looking".into() });
                Ok(ModelTurn {
                    tool_calls: vec![ToolCall { id: "t1".into(), name: "list_dir".into(),
                        input: serde_json::json!({"path":"."}) }],
                    text: String::new(), emitted_spec: None })
            } else {
                sink.emit(SpecStreamEvent::TextDelta { text: "What's the goal?".into() });
                Ok(ModelTurn { tool_calls: vec![], text: "What's the goal?".into(),
                    emitted_spec: None })
            }
        }
    }

    fn fresh_draft() -> SpecDraft {
        SpecDraft { id: Ulid::new(), messages: vec![], partial_md: None,
            last_updated: chrono::Utc::now(),
            status: DraftStatus::InProgress { phase: Phase::Goal } }
    }

    #[tokio::test]
    async fn loop_executes_tool_then_answers() {
        let root = std::env::temp_dir();
        let sink = VecSink(Mutex::new(vec![]));
        let mut draft = fresh_draft();
        let disp = ScriptedDispatcher { calls: Mutex::new(0) };
        step_streaming(&disp, &mut draft, "hi".into(), &root, "sys", &sink, 40).await.unwrap();
        let events = sink.0.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, SpecStreamEvent::ToolStart { .. })));
        assert!(events.iter().any(|e| matches!(e, SpecStreamEvent::ToolResult { .. })));
        assert!(events.iter().any(|e| matches!(e, SpecStreamEvent::TurnDone { awaiting_user: true })));
        assert!(draft.messages.len() >= 2);
    }

    struct AlwaysToolDispatcher;
    #[async_trait]
    impl StreamingDispatcher for AlwaysToolDispatcher {
        async fn stream_turn(&self, _s: &str, _m: &[DraftMessage], _sink: &dyn StreamSink)
            -> Result<ModelTurn, String> {
            Ok(ModelTurn { tool_calls: vec![ToolCall { id: "x".into(),
                name: "list_dir".into(), input: serde_json::json!({"path":"."}) }],
                text: String::new(), emitted_spec: None })
        }
    }

    #[tokio::test]
    async fn budget_exhaustion_terminates() {
        let sink = VecSink(Mutex::new(vec![]));
        let mut draft = fresh_draft();
        step_streaming(&AlwaysToolDispatcher, &mut draft, "hi".into(),
            &std::env::temp_dir(), "sys", &sink, 2).await.unwrap();
        let events = sink.0.lock().unwrap();
        assert!(events.iter().any(|e| matches!(e, SpecStreamEvent::Error { .. })));
    }

    #[test]
    fn event_serializes_snake_case_tag() {
        let e = SpecStreamEvent::ToolStart {
            id: "1".into(), tool: "grep".into(), arg: "fn main".into() };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "tool_start");
        assert_eq!(v["tool"], "grep");
    }

    #[test]
    fn sink_collects() {
        let sink = VecSink(Mutex::new(vec![]));
        sink.emit(SpecStreamEvent::TurnDone { awaiting_user: true });
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }
}
