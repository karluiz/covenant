//! Tauri commands for the Settings → Providers UI: list models from
//! Anthropic (hardcoded catalogue) and probe an OpenAI-compatible
//! endpoint for its `/v1/models` list.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelInfo {
    pub id: String,
    pub label: Option<String>,
}

pub fn anthropic_models() -> Vec<ModelInfo> {
    [
        "claude-opus-4-7",
        "claude-sonnet-4-6",
        "claude-haiku-4-5",
        karl_agent::DEFAULT_TRIAGE_MODEL,
    ]
    .into_iter()
    .map(|id| ModelInfo {
        id: id.to_string(),
        label: None,
    })
    .collect::<Vec<_>>()
}

pub async fn probe_openai_compat_models(base_url: &str) -> Result<Vec<ModelInfo>, String> {
    let url = format!("{}/models", base_url.trim_end_matches('/'));
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{}: {}", resp.status(), url));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let items = body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|v| {
            let id = v.get("id").and_then(|s| s.as_str())?.to_string();
            Some(ModelInfo { id, label: None })
        })
        .collect())
}

pub async fn probe_azure_foundry_models(
    endpoint: &str,
    api_key: &str,
    mode: karl_agent::provider::azure_foundry::AzureMode,
    api_version: &str,
) -> Result<Vec<ModelInfo>, String> {
    use karl_agent::provider::azure_foundry::AzureMode;
    let base = endpoint.trim_end_matches('/');
    let url = match mode {
        // Azure OpenAI: list user-created *deployments* (the names used in
        // `/openai/deployments/{name}/chat/completions`), not base models.
        // The control-plane shape `{data:[{id, ...}]}` is the same.
        AzureMode::AzureOpenAi => {
            format!("{}/openai/deployments?api-version={}", base, api_version)
        }
        AzureMode::AiInference => format!("{}/models?api-version={}", base, api_version),
    };
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(&url)
        .header("api-key", api_key)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("{}: {}", resp.status(), url));
    }
    let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let items = body
        .get("data")
        .and_then(|d| d.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(items
        .into_iter()
        .filter_map(|v| {
            let id = v.get("id").and_then(|s| s.as_str())?.to_string();
            Some(ModelInfo { id, label: None })
        })
        .collect())
}

#[tauri::command]
pub async fn list_models_azure_foundry(
    endpoint: String,
    api_key: String,
    mode: karl_agent::provider::azure_foundry::AzureMode,
    api_version: String,
) -> Result<Vec<ModelInfo>, String> {
    probe_azure_foundry_models(&endpoint, &api_key, mode, &api_version).await
}

#[tauri::command]
pub fn list_models_anthropic() -> Vec<ModelInfo> {
    anthropic_models()
}

/// Result of a paid live probe against Anthropic's Messages API.
/// Counts come from the response's `usage` block.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnthropicProbeResult {
    pub input_tokens: u32,
    pub output_tokens: u32,
    pub model: String,
}

/// One-token live call against the Messages API to verify the key works.
/// Uses Haiku at `max_tokens=1` so the cost is ~0.000002 USD per probe.
pub async fn probe_anthropic_key(api_key: &str) -> Result<AnthropicProbeResult, String> {
    let trimmed = api_key.trim();
    if trimmed.is_empty() {
        return Err("API key is empty".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let body = serde_json::json!({
        "model": "claude-haiku-4-5",
        "max_tokens": 1,
        "messages": [{"role": "user", "content": "."}],
    });
    let resp = client
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", trimmed)
        .header("anthropic-version", "2023-06-01")
        .header("content-type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        /// Try to pull the human-readable message out of Anthropic's
        /// error shape: `{"type":"error","error":{"type":"...","message":"..."}}`
        if let Ok(json) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(msg) = json
                .pointer("/error/message")
                .and_then(|v| v.as_str())
            {
                return Err(format!("{} — {}", status, msg));
            }
        }
        return Err(format!("{}: {}", status, text));
    }
    let json: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("parse: {}", e))?;
    let input_tokens = json
        .pointer("/usage/input_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let output_tokens = json
        .pointer("/usage/output_tokens")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    let model = json
        .pointer("/model")
        .and_then(|v| v.as_str())
        .unwrap_or("claude-haiku-4-5")
        .to_string();
    Ok(AnthropicProbeResult {
        input_tokens,
        output_tokens,
        model,
    })
}

#[tauri::command]
pub async fn test_anthropic_key(api_key: String) -> Result<AnthropicProbeResult, String> {
    probe_anthropic_key(&api_key).await
}

#[tauri::command]
pub async fn list_models_openai_compat(base_url: String) -> Result<Vec<ModelInfo>, String> {
    probe_openai_compat_models(&base_url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_catalogue_includes_opus_and_sonnet() {
        let ids: Vec<_> = anthropic_models().into_iter().map(|m| m.id).collect();
        assert!(ids.iter().any(|i| i == "claude-opus-4-7"));
        assert!(ids.iter().any(|i| i == "claude-sonnet-4-6"));
    }

    #[tokio::test]
    async fn probe_azure_ai_inference_models_parses_data_array() {
        use wiremock::matchers::{header, method, path, query_param};
        use wiremock::{Mock, MockServer, ResponseTemplate};

        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/models"))
            .and(query_param("api-version", "2024-05-01-preview"))
            .and(header("api-key", "k"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "data": [{"id": "Phi-3"}, {"id": "Llama-3"}]
            })))
            .mount(&server)
            .await;

        let out = probe_azure_foundry_models(
            &server.uri(),
            "k",
            karl_agent::provider::azure_foundry::AzureMode::AiInference,
            "2024-05-01-preview",
        )
        .await
        .expect("ok");
        let ids: Vec<_> = out.into_iter().map(|m| m.id).collect();
        assert_eq!(ids, vec!["Phi-3", "Llama-3"]);
    }
}
