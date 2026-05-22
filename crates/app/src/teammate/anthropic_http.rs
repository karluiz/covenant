//! Direct (non-streaming) HTTP client for the Anthropic Messages API
//! used by the teammate tool-use loop. Bypasses karl_agent because:
//!
//! 1. The tool-use loop is naturally multi-turn (assistant emits tool_use
//!    blocks → we execute → user replies with tool_result → repeat).
//!    karl_agent's AskRequest only carries a single `user_message: String`.
//! 2. We need the raw assistant content blocks back (text + tool_use)
//!    rather than a flattened text stream.
//!
//! Streaming + tool result deltas would be the eventual richer design;
//! for Phase 4a we use the simpler request/response shape.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const ANTHROPIC_VERSION: &str = "2023-06-01";
const DEFAULT_TIMEOUT_SECS: u64 = 180;

#[derive(Error, Debug)]
pub enum AnthropicHttpError {
    #[error("missing API key for Anthropic provider")]
    MissingKey,
    #[error("http error: {0}")]
    Reqwest(String),
    #[error("anthropic returned {status}: {body}")]
    Api { status: u16, body: String },
    #[error("could not parse anthropic response: {0}")]
    Parse(String),
}

impl From<reqwest::Error> for AnthropicHttpError {
    fn from(e: reqwest::Error) -> Self { Self::Reqwest(e.to_string()) }
}

/// One inbound message in the Anthropic Messages API format. `content`
/// can be a plain string (most common for user turns we construct) or
/// an array of content blocks (assistant turns we echo back, or user
/// turns carrying tool_result blocks).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnthropicMessage {
    pub role: String,        // "user" | "assistant"
    pub content: Value,      // string | array of blocks
}

impl AnthropicMessage {
    pub fn user_text<S: Into<String>>(text: S) -> Self {
        Self { role: "user".into(), content: Value::String(text.into()) }
    }
    pub fn assistant_blocks(blocks: Value) -> Self {
        Self { role: "assistant".into(), content: blocks }
    }
    pub fn user_tool_results(blocks: Value) -> Self {
        Self { role: "user".into(), content: blocks }
    }
}

/// Token usage on a response. `cache_*` fields are 0 when the provider
/// didn't return them. Mirrors `karl_agent::TokenUsage` shape.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct AnthropicUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
    #[serde(default)]
    pub cache_creation_input_tokens: u32,
    #[serde(default)]
    pub cache_read_input_tokens: u32,
}

/// Decoded response from POST /v1/messages.
#[derive(Debug, Clone, Deserialize)]
pub struct AnthropicResponse {
    pub stop_reason: Option<String>,
    /// Raw content array (text + tool_use blocks). We pass it back
    /// verbatim to the next turn when the model invokes tools.
    pub content: Vec<Value>,
    #[serde(default)]
    pub usage: AnthropicUsage,
}

/// Post a Messages API request to Anthropic. System prompt is cached
/// (cache_control: ephemeral). Caller passes the entire `messages`
/// array — we don't mutate it. `tools` may be empty.
pub async fn post(
    api_key: &str,
    base_url: &str,
    model: &str,
    system_prompt: &str,
    messages: &[AnthropicMessage],
    tools: &[Value],
    max_tokens: u32,
) -> Result<AnthropicResponse, AnthropicHttpError> {
    if api_key.trim().is_empty() {
        return Err(AnthropicHttpError::MissingKey);
    }
    let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()?;

    let mut body = serde_json::json!({
        "model": model,
        "max_tokens": max_tokens,
        "system": [{
            "type": "text",
            "text": system_prompt,
            "cache_control": { "type": "ephemeral" },
        }],
        "messages": messages,
    });
    if !tools.is_empty() {
        body["tools"] = serde_json::Value::Array(tools.to_vec());
        body["tool_choice"] = serde_json::json!({ "type": "auto" });
    }

    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(AnthropicHttpError::Api { status: status.as_u16(), body });
    }
    let parsed: AnthropicResponse = resp
        .json()
        .await
        .map_err(|e| AnthropicHttpError::Parse(e.to_string()))?;
    Ok(parsed)
}

/// Helper: extract concatenated text from the content blocks of an
/// assistant response. Skips tool_use blocks. Returns empty if no
/// text blocks present.
pub fn extract_text(content: &[Value]) -> String {
    let mut out = String::new();
    for block in content {
        if block.get("type").and_then(|t| t.as_str()) == Some("text") {
            if let Some(text) = block.get("text").and_then(|t| t.as_str()) {
                if !out.is_empty() { out.push('\n'); }
                out.push_str(text);
            }
        }
    }
    out
}

/// Helper: collect tool_use blocks from the content. Each returned
/// tuple is (tool_use_id, tool_name, raw input JSON).
pub fn collect_tool_uses(content: &[Value]) -> Vec<(String, String, Value)> {
    let mut out = Vec::new();
    for block in content {
        if block.get("type").and_then(|t| t.as_str()) != Some("tool_use") { continue; }
        let id = block.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let name = block.get("name").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let input = block.get("input").cloned().unwrap_or(Value::Null);
        out.push((id, name, input));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_text_concatenates_text_blocks_skips_tool_use() {
        let content = serde_json::json!([
            { "type": "text", "text": "hola" },
            { "type": "tool_use", "id": "x", "name": "read_file", "input": {} },
            { "type": "text", "text": "después de leer:" },
        ]);
        let blocks: Vec<Value> = content.as_array().unwrap().clone();
        assert_eq!(extract_text(&blocks), "hola\ndespués de leer:");
    }

    #[test]
    fn collect_tool_uses_returns_id_name_input() {
        let content = serde_json::json!([
            { "type": "text", "text": "thinking…" },
            { "type": "tool_use", "id": "tu_1", "name": "read_file", "input": { "path": "a.rs" } },
            { "type": "tool_use", "id": "tu_2", "name": "read_file", "input": { "path": "b.rs" } },
        ]);
        let blocks: Vec<Value> = content.as_array().unwrap().clone();
        let calls = collect_tool_uses(&blocks);
        assert_eq!(calls.len(), 2);
        assert_eq!(calls[0].0, "tu_1");
        assert_eq!(calls[0].1, "read_file");
        assert_eq!(calls[0].2["path"], "a.rs");
        assert_eq!(calls[1].0, "tu_2");
        assert_eq!(calls[1].2["path"], "b.rs");
    }

    #[test]
    fn user_helpers_build_expected_shapes() {
        let m = AnthropicMessage::user_text("hi");
        assert_eq!(m.role, "user");
        assert_eq!(m.content, Value::String("hi".into()));

        let blocks = serde_json::json!([{ "type": "text", "text": "hello back" }]);
        let a = AnthropicMessage::assistant_blocks(blocks.clone());
        assert_eq!(a.role, "assistant");
        assert_eq!(a.content, blocks);
    }
}
