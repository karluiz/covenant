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

#[tauri::command]
pub fn list_models_anthropic() -> Vec<ModelInfo> {
    anthropic_models()
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
}
