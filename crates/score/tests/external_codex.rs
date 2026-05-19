use std::io::Write;

#[test]
fn codex_parser_records_usage() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let dir = tempfile::tempdir().unwrap();
    let jsonl = dir.path().join("rollout-x.jsonl");
    let mut f = std::fs::File::create(&jsonl).unwrap();
    writeln!(
        f,
        r#"{{"model":"gpt-5","usage":{{"prompt_tokens":80,"completion_tokens":40}}}}"#
    )
    .unwrap();

    karl_score::external::codex::poll_one(&store, &jsonl).unwrap();
    let m = store
        .breakdown_models(
            &karl_score::ScoreFilter::default(),
            karl_score::ModelSource::External,
        )
        .unwrap();
    assert_eq!(m[0].model, "gpt-5");
    assert_eq!(m[0].input_tokens, 80);
    assert_eq!(m[0].output_tokens, 40);
    karl_score::clear_recorder_for_test();
}
