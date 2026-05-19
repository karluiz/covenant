//! Single resolver that turns a `Role` into an instantiated
//! `Arc<dyn LlmProvider>` + the model string. Every place that used to
//! build an `AskRequest` with the bare `anthropic_api_key` now goes
//! through this.

use std::sync::Arc;

use karl_agent::provider::{
    anthropic::AnthropicProvider, openai_compat::OpenAiCompatProvider, LlmProvider, ProviderConfig,
    ProviderKind,
};

use crate::settings::{Role, Settings};

#[derive(Debug, thiserror::Error)]
pub enum ResolveError {
    #[error("no route configured for role {0:?}")]
    NoRoute(Role),
    #[error("route points at provider id `{0}` which is not configured")]
    UnknownProvider(String),
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
}
