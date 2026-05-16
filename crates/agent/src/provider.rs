//! Provider abstraction. A `LlmProvider` is anything that can stream a
//! Messages-shaped request and return text + token usage. Implementations
//! live in `provider/anthropic.rs` and `provider/openai_compat.rs`.

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
