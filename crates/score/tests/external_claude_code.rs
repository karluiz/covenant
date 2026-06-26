use std::io::Write;

#[test]
fn claude_code_parser_records_repo_context_from_cwd() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());

    // A real git repo so toplevel resolution works like it does for prompts.
    let repo_dir = tempfile::tempdir().unwrap();
    let repo_path = repo_dir.path().join("groowcity");
    std::fs::create_dir(&repo_path).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo_path)
        .status()
        .unwrap()
        .success());

    let jsonl_dir = tempfile::tempdir().unwrap();
    let jsonl = jsonl_dir.path().join("session.jsonl");
    {
        let mut f = std::fs::File::create(&jsonl).unwrap();
        writeln!(
            f,
            r#"{{"cwd":{cwd},"gitBranch":"main","message":{{"model":"claude-opus-4-7","usage":{{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#,
            cwd = serde_json::to_string(repo_path.to_str().unwrap()).unwrap(),
        )
        .unwrap();
        // A line without cwd must still be recorded (repo stays NULL).
        writeln!(f, r#"{{"message":{{"model":"claude-opus-4-7","usage":{{"input_tokens":40,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#).unwrap();
    }

    karl_score::external::claude_code::poll_one(&store, &jsonl).unwrap();

    let filter = karl_score::ScoreFilter {
        repo: Some("groowcity".into()),
        ..Default::default()
    };
    let m = store
        .breakdown_models(&filter, karl_score::ModelSource::External)
        .unwrap();
    assert_eq!(
        m.len(),
        1,
        "repo-filtered tokens must include the cwd-tagged call"
    );
    assert_eq!(m[0].calls, 1);
    assert_eq!(m[0].input_tokens, 100);

    let all = store
        .breakdown_models(
            &karl_score::ScoreFilter::default(),
            karl_score::ModelSource::External,
        )
        .unwrap();
    assert_eq!(
        all[0].calls, 2,
        "cwd-less line is still recorded without repo"
    );
}

#[test]
fn claude_code_parser_records_usage_with_watermark() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let jsonl_dir = tempfile::tempdir().unwrap();
    let jsonl = jsonl_dir.path().join("session.jsonl");
    {
        let mut f = std::fs::File::create(&jsonl).unwrap();
        writeln!(f, r#"{{"message":{{"model":"claude-opus-4-7","usage":{{"input_tokens":100,"output_tokens":50,"cache_read_input_tokens":10,"cache_creation_input_tokens":0}}}}}}"#).unwrap();
        writeln!(f, r#"{{"message":{{"model":"claude-opus-4-7","usage":{{"input_tokens":40,"output_tokens":20,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#).unwrap();
    }

    karl_score::external::claude_code::poll_one(&store, &jsonl).unwrap();
    let m = store
        .breakdown_models(
            &karl_score::ScoreFilter::default(),
            karl_score::ModelSource::External,
        )
        .unwrap();
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].calls, 2);
    assert_eq!(m[0].input_tokens, 140);

    karl_score::external::claude_code::poll_one(&store, &jsonl).unwrap();
    let m2 = store
        .breakdown_models(
            &karl_score::ScoreFilter::default(),
            karl_score::ModelSource::External,
        )
        .unwrap();
    assert_eq!(m2[0].calls, 2, "watermark should prevent re-parsing");
    karl_score::clear_recorder_for_test();
}
