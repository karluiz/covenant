//! OpenAI Chat Completions compatible provider. Targets any endpoint
//! that speaks the `/v1/chat/completions` streaming protocol — Ollama
//! (native at :11434/v1), LM Studio, llama.cpp `server`, vLLM, LocalAI,
//! and OpenAI itself.
//!
//! Phase 1 supports streaming text + usage tracking. Tool use, prompt
//! caching, and extended thinking are NOT translated — capabilities()
//! reports prompt_caching=false / extended_thinking=false so callers can
//! adapt (e.g. larger summarizer debounce).

use async_trait::async_trait;
use futures_util::StreamExt;

use crate::provider::{Capabilities, LlmProvider, ProviderConfig, ProviderKind};
use crate::provider::openai_sse;
use crate::{AgentError, AgentEvent, AskRequest};

pub struct OpenAiCompatProvider {
    cfg: ProviderConfig,
}

impl OpenAiCompatProvider {
    pub fn new(cfg: ProviderConfig) -> Self {
        Self { cfg }
    }

    fn url(&self) -> String {
        let base = self
            .cfg
            .base_url
            .as_deref()
            .unwrap_or("http://localhost:11434/v1");
        format!("{}/chat/completions", base.trim_end_matches('/'))
    }
}

#[async_trait]
impl LlmProvider for OpenAiCompatProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::OpenAiCompat
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            tool_use: true,
            prompt_caching: false,
            extended_thinking: false,
        }
    }

    async fn ask_streaming(
        &self,
        req: AskRequest,
        mut on_event: Box<dyn FnMut(AgentEvent) + Send>,
    ) -> Result<(), AgentError> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()?;

        let body = serde_json::json!({
            "model": req.model,
            "max_tokens": req.max_tokens,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": [
                { "role": "system", "content": req.system_prompt },
                { "role": "user",   "content": req.user_message },
            ],
        });

        let mut request = client
            .post(self.url())
            .header("content-type", "application/json")
            .json(&body);
        if let Some(key) = self.cfg.api_key.as_deref().filter(|k| !k.trim().is_empty()) {
            request = request.bearer_auth(key);
        }

        let response = request.send().await?;
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
            while let Some(idx) = openai_sse::find_double_newline(&buffer) {
                let raw: Vec<u8> = buffer.drain(..idx + 2).collect();
                let text = String::from_utf8_lossy(&raw);
                let done = openai_sse::handle_event_block(&text, &mut |e| on_event(e));
                if done {
                    return Ok(());
                }
            }
        }
        on_event(AgentEvent::Done);
        Ok(())
    }
}
