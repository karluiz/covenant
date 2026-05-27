//! Anthropic Messages API provider implementation.

use async_trait::async_trait;
use futures_util::StreamExt;

use super::{Capabilities, LlmProvider, ProviderConfig, ProviderKind};
use crate::{AgentError, AgentEvent, AskRequest, TokenUsage};

const ANTHROPIC_VERSION: &str = "2023-06-01";

pub struct AnthropicProvider {
    config: ProviderConfig,
}

impl AnthropicProvider {
    pub fn new(config: ProviderConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl LlmProvider for AnthropicProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::Anthropic
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tool_use: true,
            prompt_caching: true,
            extended_thinking: true,
        }
    }

    async fn ask_streaming(
        &self,
        req: AskRequest,
        mut on_event: Box<dyn FnMut(AgentEvent) + Send>,
    ) -> Result<(), AgentError> {
        // Resolver-driven callers (operator, familiars, etc.) leave
        // `req.api_key` empty and expect the provider to use the key
        // baked into its `ProviderConfig` at construction time. Honor
        // the per-request key when present (legacy direct callers),
        // otherwise fall back to the config.
        let api_key = if req.api_key.trim().is_empty() {
            self.config
                .api_key
                .as_deref()
                .map(str::trim)
                .filter(|k| !k.is_empty())
                .map(str::to_string)
                .ok_or(AgentError::MissingKey)?
        } else {
            req.api_key.clone()
        };

        let base_url = self
            .config
            .base_url
            .as_deref()
            .unwrap_or("https://api.anthropic.com");
        let url = format!("{}/v1/messages", base_url.trim_end_matches('/'));

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()?;

        let mut body = serde_json::json!({
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
        if let Some(tool) = req.force_tool.as_ref() {
            body["tools"] = serde_json::json!([tool]);
            let name = tool.get("name").and_then(|n| n.as_str()).unwrap_or("");
            body["tool_choice"] = serde_json::json!({ "type": "tool", "name": name });
        }
        if let Some(budget) = req.thinking_budget {
            body["thinking"] = serde_json::json!({
                "type": "enabled",
                "budget_tokens": budget,
            });
        }

        let response = client
            .post(&url)
            .header("x-api-key", &api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AgentError::Api {
                provider: "anthropic",
                status: status.as_u16(),
                body,
            });
        }

        let mut stream = response.bytes_stream();
        let mut buffer: Vec<u8> = Vec::with_capacity(8 * 1024);

        while let Some(chunk) = stream.next().await {
            let chunk = chunk?;
            buffer.extend_from_slice(&chunk);

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
                    let event_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");
                    dispatch_event(event_type, &value, &mut on_event);
                    if event_type == "message_stop" {
                        return Ok(());
                    }
                }
            }
        }

        on_event(AgentEvent::Done);
        Ok(())
    }
}

fn dispatch_event(
    event_type: &str,
    value: &serde_json::Value,
    on_event: &mut dyn FnMut(AgentEvent),
) {
    match event_type {
        "content_block_delta" => {
            let delta = value.get("delta");
            let delta_type = delta
                .and_then(|d| d.get("type"))
                .and_then(|t| t.as_str())
                .unwrap_or("");
            match delta_type {
                "text_delta" => {
                    if let Some(text) = delta.and_then(|d| d.get("text")).and_then(|t| t.as_str()) {
                        on_event(AgentEvent::Delta(text.to_string()));
                    }
                }
                "thinking_delta" => {
                    if let Some(text) = delta
                        .and_then(|d| d.get("thinking"))
                        .and_then(|t| t.as_str())
                    {
                        on_event(AgentEvent::ThinkingDelta(text.to_string()));
                    }
                }
                "input_json_delta" => {
                    if let Some(frag) = delta
                        .and_then(|d| d.get("partial_json"))
                        .and_then(|t| t.as_str())
                    {
                        on_event(AgentEvent::ToolInputDelta {
                            tool_name: String::new(),
                            fragment: frag.to_string(),
                        });
                    }
                }
                _ => {}
            }
        }
        "message_start" => {
            if let Some(usage) = value
                .get("message")
                .and_then(|m| m.get("usage"))
                .and_then(parse_usage)
            {
                on_event(AgentEvent::Usage(usage));
            }
        }
        "message_delta" => {
            if let Some(usage) = value.get("usage").and_then(parse_usage) {
                on_event(AgentEvent::Usage(usage));
            }
            if let Some(reason) = value
                .get("delta")
                .and_then(|d| d.get("stop_reason"))
                .and_then(|r| r.as_str())
            {
                on_event(AgentEvent::StopReason(reason.to_string()));
            }
        }
        "content_block_start" => {
            let cb = value.get("content_block");
            if cb.and_then(|c| c.get("type")).and_then(|t| t.as_str()) == Some("tool_use") {
                let name = cb
                    .and_then(|c| c.get("name"))
                    .and_then(|n| n.as_str())
                    .unwrap_or("")
                    .to_string();
                on_event(AgentEvent::ToolInputDelta {
                    tool_name: name,
                    fragment: String::new(),
                });
            }
        }
        "content_block_stop" => {
            on_event(AgentEvent::ToolInputDone {
                tool_name: String::new(),
            });
        }
        "message_stop" => {
            on_event(AgentEvent::Done);
        }
        _ => {}
    }
}

fn find_double_newline(buf: &[u8]) -> Option<usize> {
    buf.windows(2).position(|w| w == b"\n\n")
}

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
