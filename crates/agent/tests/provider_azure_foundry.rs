use std::sync::{Arc, Mutex};

use karl_agent::provider::azure_foundry::{
    default_api_version, AzureFoundryConfig, AzureFoundryProvider, AzureMode,
};
use karl_agent::provider::LlmProvider;
use karl_agent::{AgentError, AgentEvent, AskRequest};
use wiremock::matchers::{header, method, path, query_param};
use wiremock::{Mock, MockServer, ResponseTemplate};

fn sse_body() -> String {
    [
        r#"data: {"choices":[{"delta":{"content":"he"}}]}"#,
        "",
        r#"data: {"choices":[{"delta":{"content":"llo"}}]}"#,
        "",
        r#"data: {"choices":[{"finish_reason":"stop"}],"usage":{"prompt_tokens":7,"completion_tokens":3}}"#,
        "",
        "data: [DONE]",
        "",
        "",
    ]
    .join("\n")
}

fn req(model: &str) -> AskRequest {
    AskRequest {
        api_key: String::new(),
        model: model.into(),
        system_prompt: "sys".into(),
        user_message: "hi".into(),
        max_tokens: 32,
        thinking_budget: None,
        force_tool: None,
    }
}

#[tokio::test]
async fn azure_openai_mode_hits_deployment_path_with_api_key_header() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/openai/deployments/my-dep/chat/completions"))
        .and(query_param("api-version", "2024-10-21"))
        .and(header("api-key", "secret"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body()),
        )
        .mount(&server)
        .await;

    let p = AzureFoundryProvider::new(AzureFoundryConfig {
        mode: AzureMode::AzureOpenAi,
        endpoint: server.uri(),
        api_key: "secret".into(),
        api_version: default_api_version(AzureMode::AzureOpenAi).into(),
        deployment: Some("my-dep".into()),
    });

    let text = Arc::new(Mutex::new(String::new()));
    let usage_input = Arc::new(Mutex::new(0u32));
    let text_cb = text.clone();
    let usage_cb = usage_input.clone();
    p.ask_streaming(
        req("ignored"),
        Box::new(move |e| match e {
            AgentEvent::Delta(s) => text_cb.lock().unwrap().push_str(&s),
            AgentEvent::Usage(u) => *usage_cb.lock().unwrap() = u.input_tokens,
            _ => {}
        }),
    )
    .await
    .expect("stream ok");

    assert_eq!(text.lock().unwrap().as_str(), "hello");
    assert_eq!(*usage_input.lock().unwrap(), 7);
}

#[tokio::test]
async fn ai_inference_mode_posts_to_models_chat_completions() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/models/chat/completions"))
        .and(query_param("api-version", "2024-05-01-preview"))
        .and(header("api-key", "k"))
        .respond_with(
            ResponseTemplate::new(200)
                .insert_header("content-type", "text/event-stream")
                .set_body_string(sse_body()),
        )
        .mount(&server)
        .await;

    let p = AzureFoundryProvider::new(AzureFoundryConfig {
        mode: AzureMode::AiInference,
        endpoint: server.uri(),
        api_key: "k".into(),
        api_version: default_api_version(AzureMode::AiInference).into(),
        deployment: None,
    });

    p.ask_streaming(req("Phi-3"), Box::new(|_| {}))
        .await
        .expect("stream ok");
}

#[tokio::test]
async fn non_2xx_response_surfaces_agent_error() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(401).set_body_string("unauthorized"))
        .mount(&server)
        .await;

    let p = AzureFoundryProvider::new(AzureFoundryConfig {
        mode: AzureMode::AiInference,
        endpoint: server.uri(),
        api_key: "bad".into(),
        api_version: default_api_version(AzureMode::AiInference).into(),
        deployment: None,
    });

    let err = p
        .ask_streaming(req("x"), Box::new(|_| {}))
        .await
        .expect_err("should fail");
    match err {
        AgentError::Api { status, .. } => assert_eq!(status, 401),
        other => panic!("expected Api error, got {other:?}"),
    }
}
