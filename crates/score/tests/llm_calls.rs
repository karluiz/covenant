use karl_score::{Context, LlmUsage, ModelSource, ScoreFilter};

#[test]
fn aggregates_models_by_source() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let ctx = Context::default();
    karl_score::record_llm_call(
        ModelSource::Internal,
        None,
        "anthropic",
        "claude-opus-4-7",
        LlmUsage {
            input: 100,
            output: 50,
            cache_read: 0,
            cache_creation: 0,
        },
        &ctx,
    );
    karl_score::record_llm_call(
        ModelSource::Internal,
        None,
        "anthropic",
        "claude-opus-4-7",
        LlmUsage {
            input: 30,
            output: 10,
            cache_read: 0,
            cache_creation: 0,
        },
        &ctx,
    );
    karl_score::record_llm_call(
        ModelSource::External,
        Some("claude_code"),
        "anthropic",
        "claude-sonnet-4-6",
        LlmUsage {
            input: 200,
            output: 80,
            cache_read: 50,
            cache_creation: 0,
        },
        &ctx,
    );

    let internal = store
        .breakdown_models(&ScoreFilter::default(), ModelSource::Internal)
        .unwrap();
    assert_eq!(internal.len(), 1);
    assert_eq!(internal[0].model, "claude-opus-4-7");
    assert_eq!(internal[0].calls, 2);
    assert_eq!(internal[0].input_tokens, 130);
    assert_eq!(internal[0].output_tokens, 60);

    let external = store
        .breakdown_models(&ScoreFilter::default(), ModelSource::External)
        .unwrap();
    assert_eq!(external.len(), 1);
    assert_eq!(external[0].agent.as_deref(), Some("claude_code"));
    karl_score::clear_recorder_for_test();
}
