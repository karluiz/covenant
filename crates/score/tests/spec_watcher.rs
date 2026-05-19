use std::time::Duration;

#[test]
fn watcher_records_new_spec_file() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let workspace = tempfile::tempdir().unwrap();
    let specs_dir = workspace.path().join("docs").join("specs");
    std::fs::create_dir_all(&specs_dir).unwrap();

    let (handle, _stop) = karl_score::spec_watcher::start(vec![workspace.path().to_path_buf()]);
    std::thread::sleep(Duration::from_millis(200));

    let file = specs_dir.join("foo.md");
    std::fs::write(&file, "# spec").unwrap();
    std::thread::sleep(Duration::from_millis(1500));

    let br = store
        .breakdown_specs(&karl_score::ScoreFilter::default())
        .unwrap();
    assert_eq!(br.total, 1, "expected 1 spec, got breakdown {br:?}");
    drop(handle);
    karl_score::clear_recorder_for_test();
}
