#[test]
fn record_spec_dedup_and_query() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    karl_score::record_spec("/work/repo/docs/a.md", &karl_score::Context {
        repo: Some("repo".into()), branch: None, group_name: None,
    });
    // dup path: should be a no-op
    karl_score::record_spec("/work/repo/docs/a.md", &karl_score::Context::default());
    karl_score::record_spec("/work/repo/docs/b.md", &karl_score::Context::default());

    let f = karl_score::ScoreFilter::default();
    let br = store.breakdown_specs(&f).unwrap();
    assert_eq!(br.total, 2);
    assert_eq!(br.recent.len(), 2);
    karl_score::clear_recorder_for_test();
}
