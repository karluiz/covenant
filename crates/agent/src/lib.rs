//! Anthropic Messages API client for Covenant's super-agent.
//!
//! M3.2b minimal: streaming SSE responses with prompt caching on the
//! system block. The crate is *only* the HTTP client — world-model
//! assembly, rate limiting, settings reads, and Tauri plumbing live in
//! `covenant`. This separation keeps the agent reusable (CLI tool,
//! tests, etc.) and the API surface deliberately small.

pub mod pi_rpc;
pub mod provider;
pub mod respond_tool;
pub mod safety;
pub mod spec_author;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("anthropic api key is empty")]
    MissingKey,
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("anthropic api {status}: {body}")]
    Api { status: u16, body: String },
}

#[derive(Debug, Clone)]
pub struct AskRequest {
    pub api_key: String,
    pub model: String,
    /// Cached: gets a `cache_control: ephemeral` block. Keep stable
    /// across calls to actually get cache hits — Anthropic's cache key
    /// is the byte content.
    pub system_prompt: String,
    pub user_message: String,
    pub max_tokens: u32,
    /// Enable Anthropic extended thinking with this token budget.
    /// `None` means thinking disabled (legacy behavior).
    pub thinking_budget: Option<u32>,
    /// If `Some`, sent in the `tools` array and `tool_choice` is forced
    /// to this name so the model must invoke it.
    pub force_tool: Option<serde_json::Value>,
}

/// Events emitted as the response streams in.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// A text fragment of the assistant message. Concat all `Delta`s in
    /// order to get the full reply.
    Delta(String),
    /// Token-usage update. Anthropic emits this in two places:
    /// `message_start` (input + cache tokens, output_tokens=1 placeholder),
    /// and `message_delta` (final output_tokens). Each event reports
    /// the latest known counts; collectors should max-merge per field
    /// (a 0 from one event must not overwrite a non-zero from another).
    Usage(TokenUsage),
    /// Stream finished cleanly (`message_stop` from Anthropic).
    Done,
    /// A text fragment of a thinking block. Only emitted when extended
    /// thinking is enabled. Treat like Delta but for the model's
    /// internal reasoning, not its user-facing output.
    ThinkingDelta(String),
    /// The stop_reason from message_delta. Common values:
    /// "end_turn", "max_tokens", "stop_sequence", "tool_use", "refusal".
    StopReason(String),
    /// Streaming JSON fragment of a tool_use input block.
    ToolInputDelta { tool_name: String, fragment: String },
    /// Tool_use content block closed. The accumulated JSON is parsed
    /// upstream by the caller using `respond_tool::ToolInputAccumulator`.
    ToolInputDone { tool_name: String },
}

/// Token counts for a single Messages API call. All fields are 0 if the
/// API response didn't include the corresponding field (older API
/// versions, partial events). Cost is computed downstream — this crate
/// is HTTP only.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TokenUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub cache_creation_input_tokens: u32,
    pub cache_read_input_tokens: u32,
}

/// One-shot result with usage. New API; the legacy `ask_oneshot`
/// stays for callers that don't care about cost.
#[derive(Debug, Clone)]
pub struct AskResponse {
    pub text: String,
    pub usage: TokenUsage,
    /// Anthropic stop_reason from message_delta. Common values:
    /// "end_turn", "max_tokens", "stop_sequence", "tool_use", "refusal".
    /// `None` if not received (older API or partial events).
    pub stop_reason: Option<String>,
    /// First ≤200 chars of the model's thinking blocks, joined.
    /// Empty when thinking was disabled or none emitted.
    pub thinking_summary: String,
    /// Full text of every thinking block, in order. Empty when disabled.
    pub thinking_full: Vec<String>,
}

/// One-shot variant: drive a streaming call internally and return the
/// fully concatenated assistant text. Used by the summarizer where
/// nothing benefits from streaming.
pub async fn ask_oneshot(req: AskRequest) -> Result<String, AgentError> {
    Ok(ask_oneshot_with_usage(req).await?.text)
}

/// One-shot with token-usage capture. Used by the Operator's AOM cost
/// accumulator. Same wire path as `ask_oneshot`; the only extra cost
/// is two atomic field updates per call.
pub async fn ask_oneshot_with_usage(req: AskRequest) -> Result<AskResponse, AgentError> {
    let buffer = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let usage = std::sync::Arc::new(std::sync::Mutex::new(TokenUsage::default()));
    let thinking_buffer = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let stop_reason = std::sync::Arc::new(std::sync::Mutex::new(Option::<String>::None));
    let buf_for_cb = buffer.clone();
    let usage_for_cb = usage.clone();
    let thinking_for_cb = thinking_buffer.clone();
    let stop_reason_for_cb = stop_reason.clone();
    ask_streaming(req, move |event| {
        match event {
            AgentEvent::Delta(text) => {
                if let Ok(mut b) = buf_for_cb.lock() {
                    b.push_str(&text);
                }
            }
            AgentEvent::Usage(u) => {
                // Max-merge per field. Anthropic's two events report
                // different views of the same call; a later event with
                // 0 in one field must not overwrite a prior non-zero.
                if let Ok(mut existing) = usage_for_cb.lock() {
                    existing.input_tokens = existing.input_tokens.max(u.input_tokens);
                    existing.output_tokens = existing.output_tokens.max(u.output_tokens);
                    existing.cache_creation_input_tokens = existing
                        .cache_creation_input_tokens
                        .max(u.cache_creation_input_tokens);
                    existing.cache_read_input_tokens = existing
                        .cache_read_input_tokens
                        .max(u.cache_read_input_tokens);
                }
            }
            AgentEvent::Done => {}
            AgentEvent::ThinkingDelta(text) => {
                if let Ok(mut t) = thinking_for_cb.lock() {
                    t.push_str(&text);
                }
            }
            AgentEvent::StopReason(r) => {
                if let Ok(mut s) = stop_reason_for_cb.lock() {
                    *s = Some(r);
                }
            }
            AgentEvent::ToolInputDelta { .. } => {}
            AgentEvent::ToolInputDone { .. } => {}
        }
    })
    .await?;
    let thinking_full_str = thinking_buffer
        .lock()
        .map(|t| t.clone())
        .unwrap_or_default();
    let thinking_full: Vec<String> = if thinking_full_str.is_empty() {
        vec![]
    } else {
        vec![thinking_full_str.clone()]
    };
    let thinking_summary: String = thinking_full_str.chars().take(200).collect();
    Ok(AskResponse {
        text: buffer.lock().map(|b| b.clone()).unwrap_or_default(),
        usage: usage.lock().map(|u| *u).unwrap_or_default(),
        stop_reason: stop_reason.lock().map(|s| s.clone()).unwrap_or_default(),
        thinking_summary,
        thinking_full,
    })
}

/// Drive a streaming Messages API call. `on_event` is called from the
/// same task as the caller (no spawn between them).
pub async fn ask_streaming<F>(req: AskRequest, on_event: F) -> Result<(), AgentError>
where
    F: FnMut(AgentEvent) + Send + 'static,
{
    use crate::provider::{LlmProvider, ProviderConfig, ProviderKind};
    let provider = crate::provider::anthropic::AnthropicProvider::new(
        ProviderConfig {
            kind: ProviderKind::Anthropic,
            api_key: Some(req.api_key.clone()),
            base_url: None,
        }
        .with_defaults(),
    );
    provider.ask_streaming(req, Box::new(on_event)).await
}

/// Default model for the cheap triage tier (Task 2 of the AOM
/// liveness plan). Hardcoded as a fallback when the caller doesn't
/// override via settings.
pub const DEFAULT_TRIAGE_MODEL: &str = "claude-haiku-4-5-20251001";

/// Triage classifier verdicts. The triage tier decides whether a tick
/// is even worth handing to the bigger decision model.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TriageAction {
    /// Hand the tick to the configured Opus/Sonnet decision model.
    Act,
    /// Executor is busy / making progress — emit a Wait, accumulate cost,
    /// move on without escalating.
    Wait,
    /// Nothing useful is going to come out of polling this session for
    /// a while. Apply a short cooldown.
    Yield,
}

/// Structured output of the triage call.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TriageVerdict {
    pub action: TriageAction,
    /// Confidence 0..=1; callers gate "Act" on a threshold.
    pub confidence: f32,
    pub rationale: String,
}

/// System-prompt fragment appended to whatever the caller passes.
/// Forces the structured JSON shape we parse.
pub const TRIAGE_OUTPUT_INSTRUCTIONS: &str =
    "\n\nYou are a fast triage classifier in front of a more expensive decision model. \
Decide whether the candidate moment is worth escalating.\n\
- act: there is a clear pending prompt or stuck state that warrants a real decision.\n\
- wait: the executor is making progress (output churn, spinner, partial answers). Stay quiet.\n\
- yield: nothing useful will happen for a while; back off polling this session.\n\
Respond ONLY with one JSON object on a single line, no prose, no fences:\n\
{\"action\": \"act|wait|yield\", \"confidence\": 0.0-1.0, \"rationale\": \"...\"}";

/// Parse a triage model reply. Tolerant of leading/trailing prose or
/// code fences — extracts the first balanced JSON object.
pub fn parse_triage_reply(text: &str) -> Result<TriageVerdict, AgentError> {
    let candidate = extract_first_json_object(text).unwrap_or_else(|| text.trim().to_string());
    let value: serde_json::Value =
        serde_json::from_str(&candidate).map_err(|e| AgentError::Api {
            status: 0,
            body: format!(
                "triage reply not JSON: {e} — raw: {}",
                truncate_for_err(text)
            ),
        })?;
    let action_str = value
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let action = match action_str.as_str() {
        "act" => TriageAction::Act,
        "wait" => TriageAction::Wait,
        "yield" => TriageAction::Yield,
        other => {
            return Err(AgentError::Api {
                status: 0,
                body: format!("triage reply: unknown action {other:?}"),
            });
        }
    };
    let confidence = value
        .get("confidence")
        .and_then(|v| v.as_f64())
        .map(|f| f.clamp(0.0, 1.0) as f32)
        .unwrap_or(0.0);
    let rationale = value
        .get("rationale")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    Ok(TriageVerdict {
        action,
        confidence,
        rationale,
    })
}

fn extract_first_json_object(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let start = bytes.iter().position(|b| *b == b'{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, b) in bytes.iter().enumerate().skip(start) {
        let c = *b;
        if in_str {
            if esc {
                esc = false;
            } else if c == b'\\' {
                esc = true;
            } else if c == b'"' {
                in_str = false;
            }
            continue;
        }
        match c {
            b'"' => in_str = true,
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

fn truncate_for_err(s: &str) -> String {
    const MAX: usize = 240;
    if s.len() <= MAX {
        s.to_string()
    } else {
        format!("{}…", &s[..MAX])
    }
}

/// Triage variant of `ask_oneshot_with_usage`. Hardcoded JSON-only
/// instructions appended to the caller's system prompt fragment so
/// callers can keep the cached prefix identical between triage and
/// decision calls (cache-hit friendly).
///
/// `req.max_tokens` is clamped to a small ceiling — the verdict is
/// tiny and we don't want the model to ramble.
pub async fn triage_oneshot(req: AskRequest) -> Result<(TriageVerdict, TokenUsage), AgentError> {
    let mut req = req;
    // Append the structured-output rules. Caller's system_prompt is
    // the cached prefix; the triage instructions go AFTER so the
    // cached bytes stay byte-identical with the big-model call.
    req.system_prompt.push_str(TRIAGE_OUTPUT_INSTRUCTIONS);
    if req.max_tokens == 0 || req.max_tokens > 128 {
        req.max_tokens = 64;
    }
    let resp = ask_oneshot_with_usage(req).await?;
    let verdict = parse_triage_reply(&resp.text)?;
    Ok((verdict, resp.usage))
}

#[cfg(test)]
mod triage_tests {
    use super::*;

    #[test]
    fn parses_canonical_act_reply() {
        let raw = r#"{"action":"act","confidence":0.92,"rationale":"prompt awaiting answer"}"#;
        let v = parse_triage_reply(raw).expect("parse");
        assert_eq!(v.action, TriageAction::Act);
        assert!((v.confidence - 0.92).abs() < 1e-4);
        assert_eq!(v.rationale, "prompt awaiting answer");
    }

    #[test]
    fn parses_wait_reply() {
        let raw = r#"{"action": "wait", "confidence": 0.4, "rationale": "spinner churning"}"#;
        let v = parse_triage_reply(raw).expect("parse");
        assert_eq!(v.action, TriageAction::Wait);
    }

    #[test]
    fn parses_yield_reply() {
        let raw = r#"{"action":"yield","confidence":0.8,"rationale":"idle"}"#;
        let v = parse_triage_reply(raw).expect("parse");
        assert_eq!(v.action, TriageAction::Yield);
    }

    #[test]
    fn tolerates_prose_around_json() {
        let raw =
            "Sure thing! ```json\n{\"action\":\"act\",\"confidence\":0.7,\"rationale\":\"x\"}\n```";
        let v = parse_triage_reply(raw).expect("parse");
        assert_eq!(v.action, TriageAction::Act);
    }

    #[test]
    fn clamps_confidence_to_unit_range() {
        let raw = r#"{"action":"act","confidence":1.7,"rationale":""}"#;
        let v = parse_triage_reply(raw).expect("parse");
        assert!(v.confidence <= 1.0 && v.confidence >= 0.0);
    }

    #[test]
    fn unknown_action_errors() {
        let raw = r#"{"action":"sleep","confidence":0.1,"rationale":""}"#;
        assert!(parse_triage_reply(raw).is_err());
    }

    #[test]
    fn missing_confidence_defaults_zero() {
        let raw = r#"{"action":"act","rationale":"no conf"}"#;
        let v = parse_triage_reply(raw).expect("parse");
        assert_eq!(v.action, TriageAction::Act);
        assert_eq!(v.confidence, 0.0);
    }

    #[test]
    fn non_json_errors() {
        assert!(parse_triage_reply("definitely not json").is_err());
    }
}
