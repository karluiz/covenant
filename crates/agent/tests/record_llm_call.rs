/// Integration test: ask_oneshot_with_usage (via collect_oneshot + AnthropicProvider)
/// fires karl_score::record_llm_call with the correct token counts.
use std::sync::Arc;

use karl_agent::provider::{
    anthropic::AnthropicProvider, collect_oneshot, ProviderConfig, ProviderKind,
};
use karl_agent::AskRequest;
use karl_score::{ModelSource, ScoreFilter, ScoreStore};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// Spin up a bare TCP server that accepts one connection, reads the HTTP
/// request headers, and responds with a minimal SSE stream whose usage
/// fields are input_tokens=42, output_tokens=7.
async fn stub_server_addr() -> String {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        // drain the request
        let mut buf = vec![0u8; 4096];
        let _ = stream.read(&mut buf).await;

        let sse_body = concat!(
            "data: {\"type\":\"message_start\",\"message\":{\"usage\":{\"input_tokens\":42,\"output_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}}\n\n",
            "data: {\"type\":\"message_delta\",\"usage\":{\"output_tokens\":7,\"input_tokens\":0,\"cache_creation_input_tokens\":0,\"cache_read_input_tokens\":0}}\n\n",
            "data: {\"type\":\"message_stop\"}\n\n",
        );

        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n{}\r\n0\r\n\r\n",
            sse_body.len(),
            sse_body
        );
        stream.write_all(response.as_bytes()).await.unwrap();
        stream.flush().await.unwrap();
    });

    format!("http://127.0.0.1:{}", addr.port())
}

#[tokio::test]
async fn collect_oneshot_records_llm_call_with_correct_usage() {
    // Set up a temporary ScoreStore and wire it as the global recorder.
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(ScoreStore::open(dir.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let base_url = stub_server_addr().await;

    let provider = AnthropicProvider::new(ProviderConfig {
        kind: ProviderKind::Anthropic,
        api_key: Some("sk-test".into()),
        base_url: Some(base_url),
    });

    let req = AskRequest {
        api_key: "sk-test".into(),
        model: "claude-test-stub".into(),
        system_prompt: "sys".into(),
        user_message: "hi".into(),
        max_tokens: 64,
        thinking_budget: None,
        force_tool: None,
    };

    collect_oneshot(&provider, req).await.unwrap();

    let rows = store
        .breakdown_models(&ScoreFilter::default(), ModelSource::Internal)
        .unwrap();

    assert_eq!(rows.len(), 1, "expected exactly one model row");
    let row = &rows[0];
    assert_eq!(row.input_tokens, 42, "input_tokens mismatch");
    assert_eq!(row.output_tokens, 7, "output_tokens mismatch");

    // `collect_oneshot` must NOT record a prompt event. It is transport,
    // and most of its callers are background work (operator polling,
    // summarizer, triage) — counting them turned the Covenant Score into
    // a graph of the app talking to itself. Prompts are recorded at the
    // user-submit commands instead; token usage still lands above.
    let conn = store.connection();
    let prompt_rows: i64 = conn
        .lock()
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM score_events WHERE kind = 'prompt'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(
        prompt_rows, 0,
        "collect_oneshot must not record prompt events"
    );

    karl_score::clear_recorder_for_test();
}
