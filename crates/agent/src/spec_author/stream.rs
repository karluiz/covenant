//! Streaming tool-loop for the premium spec author.

use crate::spec_author::{tools, DraftMessage, DraftStatus, MessageRole, SpecDraft};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::path::Path;

/// One selectable answer in an `ask_user` question.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct QuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// Parsed `ask_user` tool input. Persisted in the transcript as an assistant
/// message wrapped in `<!--question:{json}-->` so resume rebuilds the card and
/// the model sees its own question on replay.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct AskUser {
    pub question: String,
    pub options: Vec<QuestionOption>,
}

pub const QUESTION_MARKER_OPEN: &str = "<!--question:";
pub const QUESTION_MARKER_CLOSE: &str = "-->";

/// Extract a persisted question from an assistant message, if present.
/// The close marker is matched from the END so `-->` inside the JSON payload
/// (e.g. an arrow in the question text) cannot truncate the parse.
pub fn parse_question_marker(text: &str) -> Option<AskUser> {
    let start = text.find(QUESTION_MARKER_OPEN)? + QUESTION_MARKER_OPEN.len();
    let end = text.rfind(QUESTION_MARKER_CLOSE)?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&text[start..end]).ok()
}

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
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub input: serde_json::Value,
}

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
#[allow(clippy::too_many_arguments)]
pub async fn step_streaming(
    dispatcher: &dyn StreamingDispatcher,
    draft: &mut SpecDraft,
    user_msg: String,
    images: Vec<crate::spec_author::ImageRef>,
    repo_root: &Path,
    system: &str,
    sink: &dyn StreamSink,
    max_tool_calls: usize,
) -> Result<(), String> {
    let mut msg = DraftMessage::user(user_msg);
    msg.images = images;
    draft.messages.push(msg);
    let mut tool_budget = max_tool_calls;

    loop {
        let turn = dispatcher
            .stream_turn(system, &draft.messages, sink)
            .await?;

        if !turn.text.is_empty() {
            draft
                .messages
                .push(DraftMessage::assistant(turn.text.clone()));
        }

        const KNOWN_SECTIONS: &[&str] = &[
            "goal",
            "out_of_scope",
            "acceptance",
            "file_boundaries",
            "complexity",
            "open_questions",
        ];
        for (key, md) in parse_section_markers(&turn.text) {
            if !KNOWN_SECTIONS.contains(&key.as_str()) {
                continue;
            }
            sink.emit(SpecStreamEvent::Phase {
                section: key.clone(),
            });
            sink.emit(SpecStreamEvent::SectionUpdate {
                section: key,
                markdown: md,
                status: "done".into(),
            });
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
            sink.emit(SpecStreamEvent::TurnDone {
                awaiting_user: true,
            });
            return Ok(());
        }

        // Repo tools run first; `ask_user` ends the turn. Only ONE question per
        // turn is honored — extras are dropped with explicit feedback, so the
        // one-question rule is enforced in code, not prompt.
        let (questions, repo_calls): (Vec<ToolCall>, Vec<ToolCall>) = turn
            .tool_calls
            .into_iter()
            .partition(|c| c.name == "ask_user");

        let mut feedback = String::new();
        for call in repo_calls {
            if tool_budget == 0 {
                sink.emit(SpecStreamEvent::Error {
                    message: "tool-call budget exhausted".into(),
                });
                sink.emit(SpecStreamEvent::TurnDone {
                    awaiting_user: true,
                });
                return Ok(());
            }
            tool_budget -= 1;
            let arg = call.input.to_string();
            sink.emit(SpecStreamEvent::ToolStart {
                id: call.id.clone(),
                tool: call.name.clone(),
                arg: arg.clone(),
            });
            let (result, summary) = tools::run_tool(repo_root, &call.name, &call.input);
            let ok = summary != "error";
            // Persist arg + summary on the header line so a resumed transcript can
            // rebuild the exact same chip (verb · arg · hit) the live stream showed.
            feedback.push_str(&format!(
                "[tool {} → {}] {} · {}\n{}\n\n",
                call.name,
                call.id,
                arg,
                summary,
                mask_secrets(&result)
            ));
            sink.emit(SpecStreamEvent::ToolResult {
                id: call.id.clone(),
                summary,
                ok,
            });
        }

        if let Some(first) = questions.first() {
            let parsed: Option<AskUser> = serde_json::from_value(first.input.clone()).ok();
            match parsed {
                Some(q) if !q.options.is_empty() => {
                    if questions.len() > 1 {
                        feedback.push_str(
                            "[ask_user dropped — only one question per turn; only the first was shown]\n\n",
                        );
                    }
                    if !feedback.is_empty() {
                        draft.messages.push(DraftMessage::user(feedback));
                    }
                    let marker = format!(
                        "{}{}{}",
                        QUESTION_MARKER_OPEN,
                        serde_json::to_string(&q).unwrap_or_default(),
                        QUESTION_MARKER_CLOSE
                    );
                    draft.messages.push(DraftMessage::assistant(marker));
                    sink.emit(SpecStreamEvent::Question {
                        question: q.question,
                        options: q.options,
                    });
                    sink.emit(SpecStreamEvent::TurnDone {
                        awaiting_user: true,
                    });
                    return Ok(());
                }
                _ => {
                    // Malformed ask_user: tell the model and let it retry.
                    feedback.push_str(
                        "[ask_user rejected — input must be {question, options:[{label, detail?}] (2-4)}]\n\n",
                    );
                }
            }
        }

        draft.messages.push(DraftMessage::user(feedback));
    }
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SpecStreamEvent {
    ThinkingDelta {
        text: String,
    },
    TextDelta {
        text: String,
    },
    ToolStart {
        id: String,
        tool: String,
        arg: String,
    },
    ToolResult {
        id: String,
        summary: String,
        ok: bool,
    },
    SectionUpdate {
        section: String,
        markdown: String,
        status: String,
    },
    Phase {
        section: String,
    },
    TurnDone {
        awaiting_user: bool,
    },
    Question {
        question: String,
        options: Vec<QuestionOption>,
    },
    Final {
        markdown: String,
    },
    Error {
        message: String,
    },
}

/// Callback sink the dispatcher pushes events into.
pub trait StreamSink: Send + Sync {
    fn emit(&self, event: SpecStreamEvent);
}

pub(crate) fn parse_section_markers(text: &str) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<!--section:") {
        let after = &rest[start + "<!--section:".len()..];
        let Some(key_end) = after.find("-->") else {
            break;
        };
        let key = after[..key_end].to_string();
        let body = &after[key_end + 3..];
        let Some(end) = body.find("<!--/section-->") else {
            break;
        };
        out.push((key, body[..end].trim().to_string()));
        rest = &body[end + "<!--/section-->".len()..];
    }
    out
}

/// Replace common secret token shapes with a placeholder before any text is
/// persisted into a draft or replayed to the model. CLAUDE.md pitfall #7.
pub(crate) fn mask_secrets(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for token in input.split_inclusive(|c: char| c.is_whitespace()) {
        let trimmed = token.trim_end();
        let ws = &token[trimmed.len()..];
        // Handle key=value pairs: preserve the key, redact only the value.
        if let Some(eq) = trimmed.find('=') {
            let key = &trimmed[..eq + 1]; // includes '='
            let val = &trimmed[eq + 1..];
            if looks_secret(val) {
                out.push_str(key);
                out.push_str("«redacted»");
                out.push_str(ws);
                continue;
            }
        }
        if looks_secret(trimmed) {
            out.push_str("«redacted»");
            out.push_str(ws);
        } else {
            out.push_str(token);
        }
    }
    out
}

fn looks_secret(t: &str) -> bool {
    let prefixes = [
        "sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "AKIA", "AIza", "xoxb-", "xoxp-", "xoxa-",
        "xoxr-",
    ];
    if prefixes.iter().any(|p| t.starts_with(p)) && t.len() >= 16 {
        return true;
    }
    // JWT-ish: three base64url segments separated by dots, each reasonably long
    let parts: Vec<&str> = t.split('.').collect();
    if parts.len() == 3
        && parts.iter().all(|p| {
            p.len() >= 8
                && p.chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        })
    {
        return true;
    }
    false
}

use futures_util::StreamExt;

/// Build the Anthropic `messages` array. Text-only messages stay plain strings
/// (prompt-cache friendly); messages with images become content-block arrays
/// with base64 image blocks before the text. Unreadable image files are
/// skipped — the text (which names the attachment) still flows.
pub fn anthropic_messages_json(messages: &[DraftMessage]) -> Vec<serde_json::Value> {
    use base64::Engine as _;
    messages
        .iter()
        .map(|m| {
            let role = match m.role {
                MessageRole::User => "user",
                MessageRole::Assistant => "assistant",
            };
            if m.images.is_empty() {
                return serde_json::json!({ "role": role, "content": m.content });
            }
            let mut blocks: Vec<serde_json::Value> = Vec::new();
            for img in &m.images {
                if let Ok(bytes) = std::fs::read(&img.path) {
                    blocks.push(serde_json::json!({
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": img.media_type,
                            "data": base64::engine::general_purpose::STANDARD.encode(bytes),
                        }
                    }));
                }
            }
            blocks.push(serde_json::json!({ "type": "text", "text": m.content }));
            serde_json::json!({ "role": role, "content": blocks })
        })
        .collect()
}

/// Same for OpenAI-shaped endpoints: image parts as data-URI `image_url`.
pub fn openai_messages_json(system: &str, messages: &[DraftMessage]) -> Vec<serde_json::Value> {
    use base64::Engine as _;
    let mut out: Vec<serde_json::Value> =
        vec![serde_json::json!({ "role": "system", "content": system })];
    for m in messages {
        let role = match m.role {
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
        };
        if m.images.is_empty() {
            out.push(serde_json::json!({ "role": role, "content": m.content }));
            continue;
        }
        let mut parts: Vec<serde_json::Value> = Vec::new();
        for img in &m.images {
            if let Ok(bytes) = std::fs::read(&img.path) {
                let uri = format!(
                    "data:{};base64,{}",
                    img.media_type,
                    base64::engine::general_purpose::STANDARD.encode(bytes)
                );
                parts.push(serde_json::json!({ "type": "image_url", "image_url": { "url": uri } }));
            }
        }
        parts.push(serde_json::json!({ "type": "text", "text": m.content }));
        out.push(serde_json::json!({ "role": role, "content": parts }));
    }
    out
}

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
        let api_messages = anthropic_messages_json(messages);

        // Opus 4.8 supports adaptive thinking only (`{type:"enabled", budget_tokens}`
        // 400s). `display:"summarized"` opts back into streamed thinking text (the
        // default is "omitted"). Thinking depth is controlled via output_config.effort.
        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 8192,
            "stream": true,
            "thinking": { "type": "adaptive", "display": "summarized" },
            "output_config": { "effort": "xhigh" },
            "system": [{ "type": "text", "text": system,
                "cache_control": { "type": "ephemeral" } }],
            "tools": tools::tool_specs(),
            "messages": api_messages,
        });

        let resp = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!(
                "anthropic {}: {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
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
                    let Some(data) = line.strip_prefix("data: ") else {
                        continue;
                    };
                    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                        continue;
                    };
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
        Ok(ModelTurn {
            tool_calls,
            text,
            emitted_spec,
        })
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
                tool_json.insert(
                    idx,
                    (
                        v["content_block"]["id"].as_str().unwrap_or("").to_string(),
                        v["content_block"]["name"]
                            .as_str()
                            .unwrap_or("")
                            .to_string(),
                        String::new(),
                    ),
                );
            }
        }
        Some("content_block_delta") => {
            let idx = v["index"].as_u64().unwrap_or(0) as usize;
            match v["delta"]["type"].as_str() {
                Some("thinking_delta") => {
                    if let Some(t) = v["delta"]["thinking"].as_str() {
                        sink.emit(SpecStreamEvent::ThinkingDelta {
                            text: t.to_string(),
                        });
                    }
                }
                Some("text_delta") => {
                    if let Some(t) = v["delta"]["text"].as_str() {
                        text.push_str(t);
                        sink.emit(SpecStreamEvent::TextDelta {
                            text: t.to_string(),
                        });
                    }
                }
                Some("input_json_delta") => {
                    if let Some(partial) = v["delta"]["partial_json"].as_str() {
                        if let Some(entry) = tool_json.get_mut(&idx) {
                            entry.2.push_str(partial);
                        }
                    }
                }
                _ => {}
            }
        }
        _ => {}
    }
}

// ── OpenAI / Azure Foundry streaming dispatcher ───────────────────────────────

/// How to authenticate against an OpenAI-shaped chat-completions endpoint.
#[derive(Clone, Copy, PartialEq)]
pub enum OpenAiAuth {
    /// `api-key: <key>` header (Azure).
    ApiKeyHeader,
    /// `Authorization: Bearer <key>` (OpenAI / openai-compat).
    Bearer,
}

/// Streaming dispatcher for OpenAI Chat Completions–shaped endpoints
/// (Azure Foundry `gpt-4o`, Ollama/openai-compat, etc.). Speaks the same
/// multi-turn tool-loop contract as the Anthropic dispatcher via
/// [`StreamingDispatcher`], so the Spec Creator works on either provider.
pub struct OpenAiStreamingDispatcher {
    /// Full chat/completions URL (Azure includes deployment + api-version).
    pub url: String,
    pub api_key: String,
    pub auth: OpenAiAuth,
    /// `None` for Azure OpenAI mode (deployment is in the URL); `Some` otherwise.
    pub model: Option<String>,
}

#[async_trait]
impl StreamingDispatcher for OpenAiStreamingDispatcher {
    async fn stream_turn(
        &self,
        system: &str,
        messages: &[DraftMessage],
        sink: &dyn StreamSink,
    ) -> Result<ModelTurn, String> {
        let client = reqwest::Client::new();
        let api_messages = openai_messages_json(system, messages);

        let mut body = serde_json::json!({
            "max_tokens": 4096,
            "stream": true,
            "stream_options": { "include_usage": true },
            "tools": tools::tool_specs_openai(),
            "tool_choice": "auto",
            "messages": api_messages,
        });
        if let Some(model) = &self.model {
            body.as_object_mut()
                .unwrap()
                .insert("model".into(), serde_json::Value::String(model.clone()));
        }

        let mut rb = client
            .post(&self.url)
            .header("content-type", "application/json");
        rb = match self.auth {
            OpenAiAuth::ApiKeyHeader => rb.header("api-key", &self.api_key),
            OpenAiAuth::Bearer => rb.bearer_auth(&self.api_key),
        };
        let resp = rb.json(&body).send().await.map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
            return Err(format!(
                "openai {}: {}",
                resp.status(),
                resp.text().await.unwrap_or_default()
            ));
        }

        let mut stream = resp.bytes_stream();
        let mut buf = String::new();
        let mut text = String::new();
        // tool-call accumulation keyed by the delta `index`: (id, name, args).
        let mut tool_acc: std::collections::BTreeMap<usize, (String, String, String)> =
            std::collections::BTreeMap::new();

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| e.to_string())?;
            buf.push_str(&String::from_utf8_lossy(&bytes));
            while let Some(pos) = buf.find('\n') {
                let line = buf[..pos].trim().to_string();
                buf.drain(..pos + 1);
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                if data == "[DONE]" {
                    continue;
                }
                let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                    continue;
                };
                parse_openai_chunk(&v, sink, &mut text, &mut tool_acc);
            }
        }

        let tool_calls: Vec<ToolCall> = tool_acc
            .into_values()
            .map(|(id, name, args)| {
                let input = serde_json::from_str(&args).unwrap_or(serde_json::json!({}));
                ToolCall { id, name, input }
            })
            .collect();
        let emitted_spec = crate::spec_author::extract_spec_pub(&text);
        Ok(ModelTurn {
            tool_calls,
            text,
            emitted_spec,
        })
    }
}

fn parse_openai_chunk(
    v: &serde_json::Value,
    sink: &dyn StreamSink,
    text: &mut String,
    tool_acc: &mut std::collections::BTreeMap<usize, (String, String, String)>,
) {
    let Some(delta) = v["choices"].get(0).and_then(|c| c.get("delta")) else {
        return;
    };
    if let Some(content) = delta["content"].as_str() {
        if !content.is_empty() {
            text.push_str(content);
            sink.emit(SpecStreamEvent::TextDelta {
                text: content.to_string(),
            });
        }
    }
    if let Some(calls) = delta["tool_calls"].as_array() {
        for call in calls {
            let idx = call["index"].as_u64().unwrap_or(0) as usize;
            let entry = tool_acc.entry(idx).or_default();
            if let Some(id) = call["id"].as_str() {
                if !id.is_empty() {
                    entry.0 = id.to_string();
                }
            }
            if let Some(name) = call["function"]["name"].as_str() {
                if !name.is_empty() {
                    entry.1 = name.to_string();
                }
            }
            if let Some(args) = call["function"]["arguments"].as_str() {
                entry.2.push_str(args);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct VecSink(Mutex<Vec<SpecStreamEvent>>);
    impl StreamSink for VecSink {
        fn emit(&self, e: SpecStreamEvent) {
            self.0.lock().unwrap().push(e);
        }
    }

    use crate::spec_author::{DraftStatus, Phase, SpecDraft};
    use ulid::Ulid;

    // Mock: first turn requests one list_dir; second turn answers with text.
    struct ScriptedDispatcher {
        calls: Mutex<usize>,
    }
    #[async_trait]
    impl StreamingDispatcher for ScriptedDispatcher {
        async fn stream_turn(
            &self,
            _sys: &str,
            _msgs: &[DraftMessage],
            sink: &dyn StreamSink,
        ) -> Result<ModelTurn, String> {
            let mut n = self.calls.lock().unwrap();
            *n += 1;
            if *n == 1 {
                sink.emit(SpecStreamEvent::ThinkingDelta {
                    text: "looking".into(),
                });
                Ok(ModelTurn {
                    tool_calls: vec![ToolCall {
                        id: "t1".into(),
                        name: "list_dir".into(),
                        input: serde_json::json!({"path":"."}),
                    }],
                    text: String::new(),
                    emitted_spec: None,
                })
            } else {
                sink.emit(SpecStreamEvent::TextDelta {
                    text: "What's the goal?".into(),
                });
                Ok(ModelTurn {
                    tool_calls: vec![],
                    text: "What's the goal?".into(),
                    emitted_spec: None,
                })
            }
        }
    }

    fn fresh_draft() -> SpecDraft {
        SpecDraft {
            id: Ulid::new(),
            messages: vec![],
            partial_md: None,
            last_updated: chrono::Utc::now(),
            status: DraftStatus::InProgress { phase: Phase::Goal },
            repo_root: None,
        }
    }

    #[tokio::test]
    async fn loop_executes_tool_then_answers() {
        let root = std::env::temp_dir();
        let sink = VecSink(Mutex::new(vec![]));
        let mut draft = fresh_draft();
        let disp = ScriptedDispatcher {
            calls: Mutex::new(0),
        };
        step_streaming(
            &disp,
            &mut draft,
            "hi".into(),
            vec![],
            &root,
            "sys",
            &sink,
            40,
        )
        .await
        .unwrap();
        let events = sink.0.lock().unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, SpecStreamEvent::ToolStart { .. })));
        assert!(events
            .iter()
            .any(|e| matches!(e, SpecStreamEvent::ToolResult { .. })));
        assert!(events.iter().any(|e| matches!(
            e,
            SpecStreamEvent::TurnDone {
                awaiting_user: true
            }
        )));
        assert!(draft.messages.len() >= 2);
    }

    struct AlwaysToolDispatcher;
    #[async_trait]
    impl StreamingDispatcher for AlwaysToolDispatcher {
        async fn stream_turn(
            &self,
            _s: &str,
            _m: &[DraftMessage],
            _sink: &dyn StreamSink,
        ) -> Result<ModelTurn, String> {
            Ok(ModelTurn {
                tool_calls: vec![ToolCall {
                    id: "x".into(),
                    name: "list_dir".into(),
                    input: serde_json::json!({"path":"."}),
                }],
                text: String::new(),
                emitted_spec: None,
            })
        }
    }

    #[tokio::test]
    async fn budget_exhaustion_terminates() {
        let sink = VecSink(Mutex::new(vec![]));
        let mut draft = fresh_draft();
        step_streaming(
            &AlwaysToolDispatcher,
            &mut draft,
            "hi".into(),
            vec![],
            &std::env::temp_dir(),
            "sys",
            &sink,
            2,
        )
        .await
        .unwrap();
        let events = sink.0.lock().unwrap();
        assert!(events
            .iter()
            .any(|e| matches!(e, SpecStreamEvent::Error { .. })));
    }

    // Mock: one turn with list_dir + two ask_user calls (tests ordering + drop).
    struct QuestionDispatcher;
    #[async_trait]
    impl StreamingDispatcher for QuestionDispatcher {
        async fn stream_turn(
            &self,
            _s: &str,
            _m: &[DraftMessage],
            _sink: &dyn StreamSink,
        ) -> Result<ModelTurn, String> {
            let ask = |q: &str| ToolCall {
                id: format!("q-{q}"),
                name: "ask_user".into(),
                input: serde_json::json!({
                    "question": q,
                    "options": [
                        {"label": "A (recomendado)", "detail": "why A"},
                        {"label": "B"}
                    ]
                }),
            };
            Ok(ModelTurn {
                tool_calls: vec![
                    ask("¿A o B?"),
                    ToolCall {
                        id: "t1".into(),
                        name: "list_dir".into(),
                        input: serde_json::json!({"path":"."}),
                    },
                    ask("¿segunda?"),
                ],
                text: String::new(),
                emitted_spec: None,
            })
        }
    }

    #[tokio::test]
    async fn ask_user_ends_turn_with_question_event() {
        let sink = VecSink(Mutex::new(vec![]));
        let mut draft = fresh_draft();
        step_streaming(
            &QuestionDispatcher,
            &mut draft,
            "hi".into(),
            vec![],
            &std::env::temp_dir(),
            "sys",
            &sink,
            40,
        )
        .await
        .unwrap();
        let events = sink.0.lock().unwrap();
        // Repo tool ran before the question.
        let tool_idx = events
            .iter()
            .position(|e| matches!(e, SpecStreamEvent::ToolResult { .. }))
            .unwrap();
        let q_idx = events
            .iter()
            .position(|e| matches!(e, SpecStreamEvent::Question { .. }))
            .unwrap();
        assert!(tool_idx < q_idx);
        // Exactly ONE question surfaced despite two ask_user calls.
        let q_count = events
            .iter()
            .filter(|e| matches!(e, SpecStreamEvent::Question { .. }))
            .count();
        assert_eq!(q_count, 1);
        match &events[q_idx] {
            SpecStreamEvent::Question { question, options } => {
                assert_eq!(question, "¿A o B?");
                assert_eq!(options.len(), 2);
                assert_eq!(options[0].detail.as_deref(), Some("why A"));
            }
            _ => unreachable!(),
        }
        assert!(matches!(
            events.last(),
            Some(SpecStreamEvent::TurnDone {
                awaiting_user: true
            })
        ));
        // Transcript: tool feedback (with drop note) then the question marker.
        let last = draft.messages.last().unwrap();
        assert_eq!(last.role, MessageRole::Assistant);
        let q = parse_question_marker(&last.content).unwrap();
        assert_eq!(q.question, "¿A o B?");
        let feedback = &draft.messages[draft.messages.len() - 2];
        assert_eq!(feedback.role, MessageRole::User);
        assert!(feedback.content.contains("only one question per turn"));
    }

    #[test]
    fn question_marker_roundtrip_survives_arrow_in_text() {
        let q = AskUser {
            question: "¿migrar A --> B?".into(),
            options: vec![QuestionOption {
                label: "sí".into(),
                detail: None,
            }],
        };
        let marker = format!(
            "{}{}{}",
            QUESTION_MARKER_OPEN,
            serde_json::to_string(&q).unwrap(),
            QUESTION_MARKER_CLOSE
        );
        assert_eq!(parse_question_marker(&marker).unwrap(), q);
        assert_eq!(parse_question_marker("no marker here"), None);
    }

    #[test]
    fn question_event_serializes() {
        let e = SpecStreamEvent::Question {
            question: "¿A o B?".into(),
            options: vec![QuestionOption {
                label: "A".into(),
                detail: Some("why".into()),
            }],
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "question");
        assert_eq!(v["options"][0]["label"], "A");
    }

    #[test]
    fn event_serializes_snake_case_tag() {
        let e = SpecStreamEvent::ToolStart {
            id: "1".into(),
            tool: "grep".into(),
            arg: "fn main".into(),
        };
        let v = serde_json::to_value(&e).unwrap();
        assert_eq!(v["kind"], "tool_start");
        assert_eq!(v["tool"], "grep");
    }

    #[test]
    fn extracts_section_markers() {
        let text = "Working on it.\n<!--section:goal-->Esc closes modals.<!--/section-->\nMore.";
        let secs = super::parse_section_markers(text);
        assert_eq!(
            secs,
            vec![("goal".to_string(), "Esc closes modals.".to_string())]
        );
    }

    #[test]
    fn sink_collects() {
        let sink = VecSink(Mutex::new(vec![]));
        sink.emit(SpecStreamEvent::TurnDone {
            awaiting_user: true,
        });
        assert_eq!(sink.0.lock().unwrap().len(), 1);
    }

    #[test]
    fn mask_secrets_redacts_common_tokens() {
        let masked = super::mask_secrets(
            "key=sk-ant-abc123def456ghi789 and jwt aaaaaaaa.bbbbbbbb.cccccccc end",
        );
        assert!(!masked.contains("sk-ant-abc123def456ghi789"));
        assert!(!masked.contains("aaaaaaaa.bbbbbbbb.cccccccc"));
        assert!(masked.contains("«redacted»"));
        assert!(masked.contains("key=")); // surrounding text preserved
        assert!(masked.contains("end"));
    }
}
