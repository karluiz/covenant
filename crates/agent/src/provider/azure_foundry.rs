//! Azure AI Foundry provider. Supports two modes:
//!  - `AzureOpenAi`: per-deployment endpoint
//!    `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`
//!  - `AiInference`: unified `/models` endpoint
//!    `{endpoint}/models/chat/completions?api-version=…`
//! Auth is `api-key` header in both modes (Bearer/Entra ID deferred).
//! Body shape is OpenAI Chat Completions; SSE handling reuses
//! `provider::openai_sse`.

use async_trait::async_trait;
use futures_util::StreamExt;

use crate::provider::{openai_sse, Capabilities, LlmProvider, ProviderKind};
use crate::{AgentError, AgentEvent, AskRequest};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AzureMode {
    AzureOpenAi,
    AiInference,
}

pub fn default_api_version(mode: AzureMode) -> &'static str {
    match mode {
        AzureMode::AzureOpenAi => "2024-10-21",
        AzureMode::AiInference => "2024-05-01-preview",
    }
}

#[derive(Debug, Clone)]
pub struct AzureFoundryConfig {
    pub mode: AzureMode,
    pub endpoint: String,
    pub api_key: String,
    pub api_version: String,
    pub deployment: Option<String>,
}

pub struct AzureFoundryProvider {
    cfg: AzureFoundryConfig,
}

impl AzureFoundryProvider {
    pub fn new(cfg: AzureFoundryConfig) -> Self {
        Self { cfg }
    }

    fn url(&self) -> String {
        let base = self.cfg.endpoint.trim_end_matches('/');
        match self.cfg.mode {
            AzureMode::AzureOpenAi => {
                let dep = self.cfg.deployment.as_deref().unwrap_or("");
                format!(
                    "{}/openai/deployments/{}/chat/completions?api-version={}",
                    base, dep, self.cfg.api_version
                )
            }
            AzureMode::AiInference => format!(
                "{}/models/chat/completions?api-version={}",
                base, self.cfg.api_version
            ),
        }
    }

    fn body(&self, req: &AskRequest) -> serde_json::Value {
        let mut b = serde_json::json!({
            "max_tokens": req.max_tokens,
            "stream": true,
            "stream_options": { "include_usage": true },
            "messages": [
                { "role": "system", "content": req.system_prompt },
                { "role": "user",   "content": req.user_message },
            ],
        });
        // In Azure OpenAI mode the deployment in the URL is authoritative —
        // sending `model` is rejected by some api-versions.
        if matches!(self.cfg.mode, AzureMode::AiInference) {
            b.as_object_mut()
                .unwrap()
                .insert("model".into(), serde_json::Value::String(req.model.clone()));
        }
        b
    }
}

#[async_trait]
impl LlmProvider for AzureFoundryProvider {
    fn kind(&self) -> ProviderKind {
        ProviderKind::AzureFoundry
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

        let response = client
            .post(self.url())
            .header("content-type", "application/json")
            .header("api-key", &self.cfg.api_key)
            .json(&self.body(&req))
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(AgentError::Api {
                provider: "azure_foundry",
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(mode: AzureMode, deployment: Option<&str>) -> AzureFoundryConfig {
        AzureFoundryConfig {
            mode,
            endpoint: "https://example.openai.azure.com".into(),
            api_key: "k".into(),
            api_version: default_api_version(mode).to_string(),
            deployment: deployment.map(|s| s.to_string()),
        }
    }

    fn req(model: &str) -> AskRequest {
        AskRequest {
            api_key: String::new(),
            model: model.into(),
            system_prompt: "s".into(),
            user_message: "u".into(),
            max_tokens: 16,
            thinking_budget: None,
            force_tool: None,
        }
    }

    #[test]
    fn azure_openai_url_includes_deployment_and_api_version() {
        let p = AzureFoundryProvider::new(cfg(AzureMode::AzureOpenAi, Some("gpt4o")));
        assert_eq!(
            p.url(),
            "https://example.openai.azure.com/openai/deployments/gpt4o/chat/completions?api-version=2024-10-21"
        );
    }

    #[test]
    fn ai_inference_url_uses_models_path() {
        let p = AzureFoundryProvider::new(cfg(AzureMode::AiInference, None));
        assert!(p
            .url()
            .ends_with("/models/chat/completions?api-version=2024-05-01-preview"));
    }

    #[test]
    fn ai_inference_body_includes_model_field() {
        let p = AzureFoundryProvider::new(cfg(AzureMode::AiInference, None));
        let b = p.body(&req("Phi-3-medium"));
        assert_eq!(
            b.get("model").and_then(|v| v.as_str()),
            Some("Phi-3-medium")
        );
    }

    #[test]
    fn azure_openai_body_omits_model_field() {
        let p = AzureFoundryProvider::new(cfg(AzureMode::AzureOpenAi, Some("gpt4o")));
        let b = p.body(&req("ignored"));
        assert!(b.get("model").is_none());
    }

    #[test]
    fn default_api_versions_per_mode() {
        assert_eq!(default_api_version(AzureMode::AzureOpenAi), "2024-10-21");
        assert_eq!(
            default_api_version(AzureMode::AiInference),
            "2024-05-01-preview"
        );
    }
}
