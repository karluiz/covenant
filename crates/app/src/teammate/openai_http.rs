//! OpenAI-format Chat Completions HTTP client used by the teammate
//! tool-use loop for OpenAI-compat + Azure Foundry providers.
//!
//! Mirrors `anthropic_http.rs` but speaks OpenAI's `tool_calls` shape
//! instead of Anthropic's `tool_use` blocks. The dispatcher loops on
//! `finish_reason == "tool_calls"` until the model returns plain text.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

const DEFAULT_TIMEOUT_SECS: u64 = 180;

#[derive(Error, Debug)]
pub enum OpenAiHttpError {
    #[error("missing API key")]
    MissingKey,
    #[error("http error: {0}")]
    Reqwest(String),
    #[error("openai api {status}: {body}")]
    Api { status: u16, body: String },
    #[error("parse: {0}")]
    Parse(String),
}

impl From<reqwest::Error> for OpenAiHttpError {
    fn from(e: reqwest::Error) -> Self {
        Self::Reqwest(e.to_string())
    }
}

/// Auth header style. OpenAI-compat uses `Authorization: Bearer`; Azure
/// (both AzureOpenAi and AiInference modes) uses `api-key`.
#[derive(Debug, Clone, Copy)]
pub enum AuthStyle {
    Bearer,
    AzureKey,
}

#[derive(Debug, Clone, Serialize)]
pub struct OpenAiMessage {
    pub role: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

impl OpenAiMessage {
    pub fn system(text: impl Into<String>) -> Self {
        Self {
            role: "system".into(),
            content: Some(Value::String(text.into())),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }
    pub fn user(text: impl Into<String>) -> Self {
        Self {
            role: "user".into(),
            content: Some(Value::String(text.into())),
            tool_calls: None,
            tool_call_id: None,
            name: None,
        }
    }
    pub fn assistant_with_tool_calls(content: Option<String>, tool_calls: Vec<Value>) -> Self {
        Self {
            role: "assistant".into(),
            content: content.map(Value::String),
            tool_calls: Some(tool_calls),
            tool_call_id: None,
            name: None,
        }
    }
    pub fn tool_result(tool_call_id: impl Into<String>, text: impl Into<String>) -> Self {
        Self {
            role: "tool".into(),
            content: Some(Value::String(text.into())),
            tool_calls: None,
            tool_call_id: Some(tool_call_id.into()),
            name: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct OpenAiResponseMessage {
    #[serde(default)]
    pub content: Option<String>,
    #[serde(default)]
    pub tool_calls: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OpenAiChoice {
    pub message: OpenAiResponseMessage,
    #[serde(default)]
    pub finish_reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OpenAiResponse {
    pub choices: Vec<OpenAiChoice>,
}

/// POST a chat-completions request. `model` is None for Azure OpenAI
/// (deployment is encoded in the URL and including `model` is rejected
/// by some api-versions). Pass Some(_) for OpenAI-compat + Azure
/// AiInference mode.
pub async fn post(
    auth: AuthStyle,
    api_key: &str,
    url: &str,
    model: Option<&str>,
    messages: &[OpenAiMessage],
    tools: &[Value],
    max_tokens: u32,
) -> Result<OpenAiResponse, OpenAiHttpError> {
    if api_key.trim().is_empty() {
        return Err(OpenAiHttpError::MissingKey);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(DEFAULT_TIMEOUT_SECS))
        .build()?;
    let mut body = serde_json::json!({
        "max_tokens": max_tokens,
        "messages": messages,
    });
    if let Some(m) = model {
        body["model"] = Value::String(m.to_string());
    }
    if !tools.is_empty() {
        body["tools"] = Value::Array(tools.to_vec());
        body["tool_choice"] = Value::String("auto".into());
    }
    let mut req = client
        .post(url)
        .header("content-type", "application/json")
        .json(&body);
    req = match auth {
        AuthStyle::Bearer => req.header("authorization", format!("Bearer {}", api_key)),
        AuthStyle::AzureKey => req.header("api-key", api_key),
    };
    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(OpenAiHttpError::Api {
            status: status.as_u16(),
            body,
        });
    }
    let parsed: OpenAiResponse = resp
        .json()
        .await
        .map_err(|e| OpenAiHttpError::Parse(e.to_string()))?;
    Ok(parsed)
}

/// Convert the Anthropic-style tool definition produced by `tools.rs`
/// (`{name, description, input_schema}`) into OpenAI function-tool shape
/// (`{type:"function", function:{name, description, parameters}}`).
pub fn convert_tool_def(anthropic_def: &Value) -> Value {
    let name = anthropic_def.get("name").cloned().unwrap_or(Value::Null);
    let description = anthropic_def
        .get("description")
        .cloned()
        .unwrap_or(Value::Null);
    let parameters = anthropic_def
        .get("input_schema")
        .cloned()
        .unwrap_or(Value::Null);
    serde_json::json!({
        "type": "function",
        "function": { "name": name, "description": description, "parameters": parameters }
    })
}

/// Extract `(tool_call_id, function_name, args_json)` triples from an
/// assistant response message. `arguments` arrives as a JSON-encoded
/// string in OpenAI's shape; we parse it eagerly so callers get a Value.
pub fn collect_tool_calls(tool_calls: &[Value]) -> Vec<(String, String, Value)> {
    let mut out = Vec::new();
    for tc in tool_calls {
        let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        let function = tc.get("function");
        let name = function
            .and_then(|f| f.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args_raw = function
            .and_then(|f| f.get("arguments"))
            .and_then(|v| v.as_str())
            .unwrap_or("{}");
        let args: Value = serde_json::from_str(args_raw).unwrap_or(Value::Null);
        out.push((id, name, args));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn convert_tool_def_shapes_function() {
        let anthropic = serde_json::json!({
            "name": "read_file",
            "description": "Read a file.",
            "input_schema": { "type": "object", "properties": { "path": { "type": "string" } } }
        });
        let oa = convert_tool_def(&anthropic);
        assert_eq!(oa["type"], "function");
        assert_eq!(oa["function"]["name"], "read_file");
        assert_eq!(oa["function"]["description"], "Read a file.");
        assert_eq!(oa["function"]["parameters"]["type"], "object");
    }

    #[test]
    fn collect_tool_calls_parses_arguments() {
        let tcs = vec![serde_json::json!({
            "id": "call_1",
            "type": "function",
            "function": { "name": "read_file", "arguments": "{\"path\":\"a.rs\"}" }
        })];
        let out = collect_tool_calls(&tcs);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].0, "call_1");
        assert_eq!(out[0].1, "read_file");
        assert_eq!(out[0].2["path"], "a.rs");
    }

    #[test]
    fn collect_tool_calls_handles_malformed_args() {
        let tcs = vec![serde_json::json!({
            "id": "call_x",
            "function": { "name": "read_file", "arguments": "not-json" }
        })];
        let out = collect_tool_calls(&tcs);
        assert_eq!(out[0].2, Value::Null);
    }
}
