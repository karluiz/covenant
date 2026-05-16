use karl_agent::provider::openai_compat::OpenAiCompatProvider;
use karl_agent::provider::{Capabilities, LlmProvider, ProviderConfig, ProviderKind};

#[test]
fn reports_no_caching_or_thinking() {
    let p = OpenAiCompatProvider::new(ProviderConfig {
        kind: ProviderKind::OpenAiCompat,
        api_key: None,
        base_url: Some("http://localhost:11434/v1".into()),
    });
    let caps = p.capabilities();
    assert!(!caps.prompt_caching);
    assert!(!caps.extended_thinking);
    assert!(caps.tool_use);
    assert_eq!(p.kind(), ProviderKind::OpenAiCompat);
}
