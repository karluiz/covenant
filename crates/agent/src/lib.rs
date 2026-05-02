//! Anthropic Messages API client for karl-terminal's super-agent.
//!
//! M3.2b minimal: streaming SSE responses with prompt caching on the
//! system block. The crate is *only* the HTTP client — world-model
//! assembly, rate limiting, settings reads, and Tauri plumbing live in
//! `karl-app`. This separation keeps the agent reusable (CLI tool,
//! tests, etc.) and the API surface deliberately small.

use futures_util::StreamExt;
use thiserror::Error;

const ANTHROPIC_URL: &str = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION: &str = "2023-06-01";

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
}

/// Events emitted as the response streams in.
#[derive(Debug, Clone)]
pub enum AgentEvent {
    /// A text fragment of the assistant message. Concat all `Delta`s in
    /// order to get the full reply.
    Delta(String),
    /// Stream finished cleanly (`message_stop` from Anthropic).
    Done,
}

/// Drive a streaming Messages API call. `on_event` is called from the
/// same task as the caller (no spawn between them).
pub async fn ask_streaming<F>(req: AskRequest, mut on_event: F) -> Result<(), AgentError>
where
    F: FnMut(AgentEvent) + Send + 'static,
{
    if req.api_key.trim().is_empty() {
        return Err(AgentError::MissingKey);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()?;

    let body = serde_json::json!({
        "model": req.model,
        "max_tokens": req.max_tokens,
        "stream": true,
        "system": [
            {
                "type": "text",
                "text": req.system_prompt,
                "cache_control": { "type": "ephemeral" }
            }
        ],
        "messages": [
            { "role": "user", "content": req.user_message }
        ]
    });

    let response = client
        .post(ANTHROPIC_URL)
        .header("x-api-key", &req.api_key)
        .header("anthropic-version", ANTHROPIC_VERSION)
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await?;

    let status = response.status();
    if !status.is_success() {
        let body = response.text().await.unwrap_or_default();
        return Err(AgentError::Api {
            status: status.as_u16(),
            body,
        });
    }

    let mut stream = response.bytes_stream();
    let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buffer.extend_from_slice(&chunk);

        // SSE events are terminated by a blank line. Drain complete
        // events from the buffer; keep partial trailing bytes.
        while let Some(idx) = find_double_newline(&buffer) {
            let raw: Vec<u8> = buffer.drain(..idx + 2).collect();
            let text = String::from_utf8_lossy(&raw);

            for line in text.lines() {
                let Some(data) = line.strip_prefix("data:") else {
                    continue;
                };
                let data = data.trim_start();
                if data.is_empty() || data == "[DONE]" {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<serde_json::Value>(data) else {
                    tracing::trace!(payload = %data, "skipping unparseable sse data");
                    continue;
                };
                let event_type =
                    value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                match event_type {
                    "content_block_delta" => {
                        if let Some(text) = value
                            .get("delta")
                            .and_then(|d| d.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            on_event(AgentEvent::Delta(text.to_string()));
                        }
                    }
                    "message_stop" => {
                        on_event(AgentEvent::Done);
                        return Ok(());
                    }
                    _ => {} // message_start, content_block_start/stop, ping, message_delta — ignore
                }
            }
        }
    }

    on_event(AgentEvent::Done);
    Ok(())
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}
