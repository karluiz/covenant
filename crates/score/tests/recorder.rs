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

#[test]
fn record_commit_with_context_persists_branch() {
    let _guard = LOCK.lock().unwrap();
    let dir = tempdir().unwrap();
    let store = Arc::new(ScoreStore::open(dir.path()).unwrap());
    set_recorder(store.clone());
    karl_score::record_commit_with_context("repoX", "abc1234", Some("featY".into()));
    let c = store.connection();
    let g = c.lock().unwrap();
    let (repo, branch): (String, String) = g
        .query_row(
            "SELECT repo, branch FROM score_events WHERE kind='commit'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!((repo.as_str(), branch.as_str()), ("repoX", "featY"));
    karl_score::clear_recorder_for_test();
}

#[test]
fn record_prompt_with_agent_persists_label() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());
    karl_score::record_prompt_with_agent("anthropic", Some("claude_code"));

    let conn = store.connection();
    let c = conn.lock().unwrap();
    let (executor, agent): (String, Option<String>) = c
        .query_row(
            "SELECT executor, agent FROM score_events ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(executor, "anthropic");
    assert_eq!(agent.as_deref(), Some("claude_code"));
    karl_score::clear_recorder_for_test();
}
