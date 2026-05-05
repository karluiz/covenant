//! Anthropic Messages API client for Covenant's super-agent.
//!
//! M3.2b minimal: streaming SSE responses with prompt caching on the
//! system block. The crate is *only* the HTTP client — world-model
//! assembly, rate limiting, settings reads, and Tauri plumbing live in
//! `covenant`. This separation keeps the agent reusable (CLI tool,
//! tests, etc.) and the API surface deliberately small.

pub mod spec_author;

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
    /// Token-usage update. Anthropic emits this in two places:
    /// `message_start` (input + cache tokens, output_tokens=1 placeholder),
    /// and `message_delta` (final output_tokens). Each event reports
    /// the latest known counts; collectors should max-merge per field
    /// (a 0 from one event must not overwrite a non-zero from another).
    Usage(TokenUsage),
    /// Stream finished cleanly (`message_stop` from Anthropic).
    Done,
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
    let buf_for_cb = buffer.clone();
    let usage_for_cb = usage.clone();
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
                    existing.cache_creation_input_tokens =
                        existing.cache_creation_input_tokens.max(u.cache_creation_input_tokens);
                    existing.cache_read_input_tokens =
                        existing.cache_read_input_tokens.max(u.cache_read_input_tokens);
                }
            }
            AgentEvent::Done => {}
        }
    })
    .await?;
    Ok(AskResponse {
        text: buffer.lock().map(|b| b.clone()).unwrap_or_default(),
        usage: usage.lock().map(|u| *u).unwrap_or_default(),
    })
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
                    "message_start" => {
                        // First usage snapshot — has input_tokens +
                        // cache_*_input_tokens; output_tokens is a
                        // placeholder (typically 1) until message_delta.
                        if let Some(usage) = value
                            .get("message")
                            .and_then(|m| m.get("usage"))
                            .and_then(parse_usage)
                        {
                            on_event(AgentEvent::Usage(usage));
                        }
                    }
                    "message_delta" => {
                        // Final-output update. Has the real
                        // output_tokens; input fields may be 0 here, so
                        // the collector must max-merge across events.
                        if let Some(usage) =
                            value.get("usage").and_then(parse_usage)
                        {
                            on_event(AgentEvent::Usage(usage));
                        }
                    }
                    "message_stop" => {
                        on_event(AgentEvent::Done);
                        return Ok(());
                    }
                    _ => {} // content_block_start/stop, ping — ignore
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

/// Map an Anthropic `usage` JSON object to our TokenUsage. Missing
/// fields default to 0 — the API has added fields over time and we
/// want to keep accepting older shapes.
fn parse_usage(v: &serde_json::Value) -> Option<TokenUsage> {
    let get = |k: &str| {
        v.get(k)
            .and_then(|x| x.as_u64())
            .map(|n| n as u32)
            .unwrap_or(0)
    };
    Some(TokenUsage {
        input_tokens: get("input_tokens"),
        output_tokens: get("output_tokens"),
        cache_creation_input_tokens: get("cache_creation_input_tokens"),
        cache_read_input_tokens: get("cache_read_input_tokens"),
    })
}
