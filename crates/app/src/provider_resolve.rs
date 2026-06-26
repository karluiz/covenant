//! Single resolver that turns a `Role` into an instantiated
//! `Arc<dyn LlmProvider>` + the model string. Every place that used to
//! build an `AskRequest` with the bare `anthropic_api_key` now goes
//! through this.

use std::sync::Arc;

use karl_agent::provider::{
    anthropic::AnthropicProvider,
    azure_foundry::{default_api_version, AzureFoundryConfig, AzureFoundryProvider},
    openai_compat::OpenAiCompatProvider,
    LlmProvider, ProviderConfig, ProviderKind,
};

use crate::settings::{Role, Settings};

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("no route configured for role {0:?}")]
    NoRoute(Role),
    #[error("route points at provider id `{0}` which is not configured")]
    UnknownProvider(String),
    #[error("Azure Foundry provider missing endpoint (base_url)")]
    MissingAzureEndpoint,
    #[error("Azure Foundry provider missing api_key")]
    MissingAzureApiKey,
    #[error("Azure Foundry provider missing azure_mode")]
    MissingAzureMode,
    #[error("Azure OpenAI mode requires a deployment name")]
    MissingAzureDeployment,
}

pub struct ResolvedRoute {
    pub provider: Arc<dyn LlmProvider>,
    pub model: String,
}

impl std::fmt::Debug for ResolvedRoute {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ResolvedRoute")
            .field("kind", &self.provider.kind())
            .field("model", &self.model)
            .finish()
    }
}

pub fn resolve_route(settings: &Settings, role: Role) -> Result<ResolvedRoute, ResolveError> {
    let route = settings
        .model_routes
        .get(&role)
        .ok_or(ResolveError::NoRoute(role))?;
    let entry = settings
        .providers
        .get(&route.provider_id)
        .ok_or_else(|| ResolveError::UnknownProvider(route.provider_id.clone()))?;
    let cfg = ProviderConfig {
        kind: entry.kind,
        api_key: entry.api_key.clone(),
        base_url: entry.base_url.clone(),
    }
    .with_defaults();
    let provider: Arc<dyn LlmProvider> = match entry.kind {
        ProviderKind::Anthropic => Arc::new(AnthropicProvider::new(cfg)),
        ProviderKind::OpenAiCompat => Arc::new(OpenAiCompatProvider::new(cfg)),
        ProviderKind::AzureFoundry => {
            let mode = entry.azure_mode.ok_or(ResolveError::MissingAzureMode)?;
            let endpoint = entry
                .base_url
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or(ResolveError::MissingAzureEndpoint)?;
            let api_key = entry
                .api_key
                .clone()
                .filter(|s| !s.trim().is_empty())
                .ok_or(ResolveError::MissingAzureApiKey)?;
            if mode == karl_agent::provider::azure_foundry::AzureMode::AzureOpenAi
                && entry.azure_deployment.is_none()
            {
                return Err(ResolveError::MissingAzureDeployment);
            }
            let api_version = entry
                .azure_api_version
                .clone()
                .unwrap_or_else(|| default_api_version(mode).to_string());
            Arc::new(AzureFoundryProvider::new(AzureFoundryConfig {
                mode,
                endpoint,
                api_key,
                api_version,
                deployment: entry.azure_deployment.clone(),
            }))
        }
    };
    Ok(ResolvedRoute {
        provider,
        model: route.model.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_default_summary_route_to_anthropic() {
        let s = Settings::default();
        let r = resolve_route(&s, Role::Summary).expect("route");
        assert_eq!(r.model, "claude-sonnet-4-6");
        assert_eq!(r.provider.kind(), ProviderKind::Anthropic);
    }

    #[test]
    fn errors_on_route_pointing_at_missing_provider() {
        let mut s = Settings::default();
        s.model_routes.get_mut(&Role::Summary).unwrap().provider_id = "nonexistent".into();
        let err = resolve_route(&s, Role::Summary).unwrap_err();
        assert!(matches!(err, ResolveError::UnknownProvider(_)));
    }

    use crate::settings::ProviderEntry;
    use karl_agent::provider::azure_foundry::AzureMode;

    fn settings_with_azure_route(mode: AzureMode, deployment: Option<&str>) -> Settings {
        let mut s = Settings::default();
        s.providers.insert(
            "azure".into(),
            ProviderEntry {
                kind: ProviderKind::AzureFoundry,
                label: "Azure".into(),
                api_key: Some("k".into()),
                base_url: Some("https://example.openai.azure.com".into()),
                azure_mode: Some(mode),
                azure_api_version: None,
                azure_deployment: deployment.map(|s| s.to_string()),
            },
        );
        s.model_routes.get_mut(&Role::Summary).unwrap().provider_id = "azure".into();
        s.model_routes.get_mut(&Role::Summary).unwrap().model = "x".into();
        s
    }

    #[test]
    fn resolves_role_to_azure_foundry() {
        let s = settings_with_azure_route(AzureMode::AiInference, None);
        let r = resolve_route(&s, Role::Summary).expect("route");
        assert_eq!(r.provider.kind(), ProviderKind::AzureFoundry);
    }

    #[test]
    fn errors_when_azure_openai_mode_missing_deployment() {
        let s = settings_with_azure_route(AzureMode::AzureOpenAi, None);
        let err = resolve_route(&s, Role::Summary).unwrap_err();
        assert!(matches!(err, ResolveError::MissingAzureDeployment));
    }

    #[test]
    fn errors_when_azure_endpoint_missing() {
        let mut s = settings_with_azure_route(AzureMode::AiInference, None);
        s.providers.get_mut("azure").unwrap().base_url = None;
        let err = resolve_route(&s, Role::Summary).unwrap_err();
        assert!(matches!(err, ResolveError::MissingAzureEndpoint));
    }
}
