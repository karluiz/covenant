//! Provider abstraction. A `LlmProvider` is anything that can stream a
//! Messages-shaped request and return text + token usage. Implementations
//! live in `provider/anthropic.rs` and `provider/openai_compat.rs`.

pub mod anthropic;
pub mod openai_compat;

use crate::{AgentError, AgentEvent, AskRequest};
use async_trait::async_trait;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Anthropic,
    OpenAiCompat,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ProviderConfig {
    pub kind: ProviderKind,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub base_url: Option<String>,
}

impl ProviderConfig {
    pub fn with_defaults(mut self) -> Self {
        if self.base_url.is_none() {
            self.base_url = Some(match self.kind {
                ProviderKind::Anthropic => "https://api.anthropic.com".to_string(),
                ProviderKind::OpenAiCompat => "http://localhost:11434/v1".to_string(),
            });
        }
        self
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Capabilities {
    pub tool_use: bool,
    pub prompt_caching: bool,
    pub extended_thinking: bool,
}

#[async_trait]
pub trait LlmProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    fn capabilities(&self) -> Capabilities;
    async fn ask_streaming(
        &self,
        req: AskRequest,
        on_event: Box<dyn FnMut(AgentEvent) + Send>,
    ) -> Result<(), AgentError>;
}

use std::sync::{Arc, Mutex};

/// Collect a streamed call into a single String + final usage. Mirrors
/// the legacy `ask_oneshot_with_usage` but goes through the trait.
pub async fn collect_oneshot(
    provider: &dyn LlmProvider,
    req: AskRequest,
) -> Result<crate::AskResponse, AgentError> {
    let buffer = Arc::new(Mutex::new(String::new()));
    let usage = Arc::new(Mutex::new(crate::TokenUsage::default()));
    let stop_reason = Arc::new(Mutex::new(Option::<String>::None));
    let thinking = Arc::new(Mutex::new(String::new()));
    let buf_cb = buffer.clone();
    let usage_cb = usage.clone();
    let stop_cb = stop_reason.clone();
    let think_cb = thinking.clone();
    provider
        .ask_streaming(
            req,
            Box::new(move |evt| match evt {
                AgentEvent::Delta(t) => {
                    if let Ok(mut b) = buf_cb.lock() { b.push_str(&t); }
                }
                AgentEvent::ThinkingDelta(t) => {
                    if let Ok(mut b) = think_cb.lock() { b.push_str(&t); }
                }
                AgentEvent::Usage(u) => {
                    if let Ok(mut e) = usage_cb.lock() {
                        e.input_tokens = e.input_tokens.max(u.input_tokens);
                        e.output_tokens = e.output_tokens.max(u.output_tokens);
                        e.cache_creation_input_tokens =
                            e.cache_creation_input_tokens.max(u.cache_creation_input_tokens);
                        e.cache_read_input_tokens =
                            e.cache_read_input_tokens.max(u.cache_read_input_tokens);
                    }
                }
                AgentEvent::StopReason(r) => {
                    if let Ok(mut s) = stop_cb.lock() { *s = Some(r); }
                }
                _ => {}
            }),
        )
        .await?;
    let thinking_full = thinking.lock().map(|t| t.clone()).unwrap_or_default();
    let thinking_summary: String = thinking_full.chars().take(200).collect();
    Ok(crate::AskResponse {
        text: buffer.lock().map(|b| b.clone()).unwrap_or_default(),
        usage: usage.lock().map(|u| *u).unwrap_or_default(),
        stop_reason: stop_reason.lock().map(|s| s.clone()).unwrap_or_default(),
        thinking_summary,
        thinking_full: if thinking_full.is_empty() { vec![] } else { vec![thinking_full] },
    })
}

/// Trait-based variant of `crate::triage_oneshot`. Appends the structured-
/// output instructions, clamps max_tokens, runs the call via the provider,
/// parses the verdict.
pub async fn triage_via_provider(
    provider: &dyn LlmProvider,
    mut req: AskRequest,
) -> Result<(crate::TriageVerdict, crate::TokenUsage), AgentError> {
    req.system_prompt.push_str(crate::TRIAGE_OUTPUT_INSTRUCTIONS);
    if req.max_tokens == 0 || req.max_tokens > 128 {
        req.max_tokens = 64;
    }
    let resp = collect_oneshot(provider, req).await?;
    let verdict = crate::parse_triage_reply(&resp.text)?;
    Ok((verdict, resp.usage))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_defaults_to_official_base_url() {
        let cfg = ProviderConfig {
            kind: ProviderKind::Anthropic,
            api_key: Some("sk-ant".into()),
            base_url: None,
        }
        .with_defaults();
        assert_eq!(cfg.base_url.as_deref(), Some("https://api.anthropic.com"));
    }

    #[test]
    fn openai_compat_defaults_to_ollama() {
        let cfg = ProviderConfig {
            kind: ProviderKind::OpenAiCompat,
            api_key: None,
            base_url: None,
        }
        .with_defaults();
        assert_eq!(cfg.base_url.as_deref(), Some("http://localhost:11434/v1"));
    }
}
