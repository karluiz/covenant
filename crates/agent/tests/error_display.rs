//! Verifies `AgentError::Api` Display includes the originating provider
//! name. Hardcoded labels were the root cause of "anthropic api 400"
//! showing up on Azure Foundry failures.

use karl_agent::AgentError;

#[test]
fn anthropic_display_carries_provider_name() {
    let e = AgentError::Api {
        provider: "anthropic",
        status: 429,
        body: "rate_limited".into(),
    };
    let s = e.to_string();
    assert!(s.contains("anthropic"), "got: {s}");
    assert!(s.contains("429"), "got: {s}");
    assert!(s.contains("rate_limited"), "got: {s}");
}

#[test]
fn azure_foundry_display_carries_provider_name() {
    let e = AgentError::Api {
        provider: "azure_foundry",
        status: 400,
        body: "{\"error\":{\"message\":\"The response was filtered\"}}".into(),
    };
    let s = e.to_string();
    assert!(s.contains("azure_foundry"), "got: {s}");
    assert!(!s.contains("anthropic"), "must not say anthropic: {s}");
}

#[test]
fn openai_compat_display_carries_provider_name() {
    let e = AgentError::Api {
        provider: "openai_compat",
        status: 401,
        body: "unauthorized".into(),
    };
    let s = e.to_string();
    assert!(s.contains("openai_compat"), "got: {s}");
    assert!(!s.contains("anthropic"), "must not say anthropic: {s}");
}

#[test]
fn internal_fallback_is_labelled() {
    let e = AgentError::Api {
        provider: "internal",
        status: 0,
        body: "triage reply: unknown action \"foo\"".into(),
    };
    let s = e.to_string();
    assert!(s.contains("internal"), "got: {s}");
    assert!(s.contains("0"), "status should render: {s}");
}
