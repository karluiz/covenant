//! Smoke tests for the extended-thinking extension to AskRequest/Response.
//! Doesn't make real API calls — verifies struct surface.

use karl_agent::{AgentEvent, AskRequest, AskResponse, TokenUsage};

#[test]
fn ask_request_thinking_budget_default_is_none() {
    let req = AskRequest {
        api_key: "x".into(),
        model: "claude-opus-4-7".into(),
        system_prompt: "s".into(),
        user_message: "u".into(),
        max_tokens: 1024,
        thinking_budget: None,
        force_tool: None,
    };
    assert!(req.thinking_budget.is_none());
}

#[test]
fn ask_request_with_thinking_budget_set() {
    let req = AskRequest {
        api_key: "x".into(),
        model: "claude-opus-4-7".into(),
        system_prompt: "s".into(),
        user_message: "u".into(),
        max_tokens: 1024,
        thinking_budget: Some(2000),
        force_tool: None,
    };
    assert_eq!(req.thinking_budget, Some(2000));
}

#[test]
fn ask_response_default_has_empty_thinking_and_no_stop_reason() {
    let r = AskResponse {
        text: "hi".into(),
        usage: TokenUsage::default(),
        stop_reason: None,
        thinking_summary: String::new(),
        thinking_full: vec![],
    };
    assert!(r.thinking_summary.is_empty());
    assert!(r.thinking_full.is_empty());
    assert!(r.stop_reason.is_none());
}

#[test]
fn agent_event_thinking_delta_variant_constructs() {
    let e = AgentEvent::ThinkingDelta("reasoning step".into());
    match e {
        AgentEvent::ThinkingDelta(s) => assert_eq!(s, "reasoning step"),
        _ => panic!("wrong variant"),
    }
}

#[test]
fn agent_event_stop_reason_variant_constructs() {
    let e = AgentEvent::StopReason("max_tokens".into());
    match e {
        AgentEvent::StopReason(s) => assert_eq!(s, "max_tokens"),
        _ => panic!("wrong variant"),
    }
}
