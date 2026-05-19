use karl_agent::provider::anthropic::AnthropicProvider;
use karl_agent::provider::{Capabilities, LlmProvider, ProviderConfig, ProviderKind};

#[test]
fn anthropic_provider_reports_full_capabilities() {
    let p = AnthropicProvider::new(
        ProviderConfig {
            kind: ProviderKind::Anthropic,
            api_key: Some("sk-ant".into()),
            base_url: None,
        }
        .with_defaults(),
    );
    assert_eq!(p.kind(), ProviderKind::Anthropic);
    let caps = p.capabilities();
    assert!(caps.tool_use);
    assert!(caps.prompt_caching);
    assert!(caps.extended_thinking);
}
