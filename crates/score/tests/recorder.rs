use karl_score::{record_prompt, set_recorder, ScoreStore, Summary};
use std::sync::{Arc, Mutex};
use tempfile::tempdir;

// Serialize the two tests that share global recorder state
static LOCK: Mutex<()> = Mutex::new(());

#[test]
fn record_prompt_appends_via_global_recorder() {
    let _guard = LOCK.lock().unwrap();
    let dir = tempdir().unwrap();
    let store = Arc::new(ScoreStore::open(dir.path()).unwrap());
    set_recorder(store.clone());
    record_prompt("anthropic");
    record_prompt("openai_compat");
    let s: Summary = store.summary().unwrap();
    assert_eq!(s.total_prompts, 2);
    karl_score::clear_recorder_for_test();
}

#[test]
fn record_prompt_is_noop_without_recorder_set() {
    let _guard = LOCK.lock().unwrap();
    karl_score::clear_recorder_for_test();
    record_prompt("anthropic"); // should not panic
}
