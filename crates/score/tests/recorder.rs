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

#[test]
fn current_context_resolves_repo_from_current_session() {
    let _guard = LOCK.lock().unwrap();
    let dir = tempdir().unwrap();
    let repo_path = dir.path().join("groowcity");
    std::fs::create_dir(&repo_path).unwrap();
    assert!(std::process::Command::new("git")
        .args(["init", "-q"])
        .current_dir(&repo_path)
        .status()
        .unwrap()
        .success());

    karl_score::set_current_session(Some(karl_score::CurrentSession {
        session_id: "test-current-ctx".into(),
        cwd: repo_path,
        group_name: Some("g1".into()),
        workspace: None,
    }));
    let ctx = karl_score::current_context();
    karl_score::set_current_session(None);

    assert_eq!(ctx.repo.as_deref(), Some("groowcity"));
    assert_eq!(ctx.group_name.as_deref(), Some("g1"));
}

#[test]
fn current_context_is_default_without_session() {
    let _guard = LOCK.lock().unwrap();
    karl_score::set_current_session(None);
    let ctx = karl_score::current_context();
    assert_eq!(ctx.repo, None);
    assert_eq!(ctx.branch, None);
}

#[test]
fn record_spec_emits_cartographer_and_is_idempotent() {
    let _guard = LOCK.lock().unwrap();
    let dir = tempdir().unwrap();
    let store = Arc::new(ScoreStore::open(dir.path()).unwrap());
    set_recorder(store.clone());

    let ctx = karl_score::Context {
        repo: Some("karlTerminal".into()),
        branch: Some("main".into()),
        group_name: None,
        workspace: None,
    };
    karl_score::record_spec("docs/specs/foo.md", &ctx);

    let conn = store.connection();
    {
        let c = conn.lock().unwrap();
        let awards: i64 = c
            .query_row(
                "SELECT count(*) FROM achievement_awards \
                 WHERE achievement_id='cartographer' AND tier=1",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(awards, 1, "first spec should award Cartographer tier I");
        let progress: i64 = c
            .query_row(
                "SELECT progress FROM achievement_progress WHERE achievement_id='cartographer'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(progress, 1);
    }

    // Re-recording the same spec path is a no-op (append_spec returns false; the
    // dedupe_key also guards) — progress must not advance.
    karl_score::record_spec("docs/specs/foo.md", &ctx);
    {
        let c = conn.lock().unwrap();
        let progress: i64 = c
            .query_row(
                "SELECT progress FROM achievement_progress WHERE achievement_id='cartographer'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(progress, 1, "duplicate spec must not advance progress");
    }

    karl_score::clear_recorder_for_test();
}

#[test]
fn record_spec_without_repo_does_not_emit_cartographer() {
    let _guard = LOCK.lock().unwrap();
    let dir = tempdir().unwrap();
    let store = Arc::new(ScoreStore::open(dir.path()).unwrap());
    set_recorder(store.clone());

    let ctx = karl_score::Context {
        repo: None,
        branch: None,
        group_name: None,
        workspace: None,
    };
    karl_score::record_spec("/tmp/loose-spec.md", &ctx);

    let conn = store.connection();
    let c = conn.lock().unwrap();
    let facts: i64 = c
        .query_row("SELECT count(*) FROM achievement_facts", [], |r| r.get(0))
        .unwrap();
    assert_eq!(facts, 0, "repo-less spec should emit no achievement fact");
    drop(c);
    karl_score::clear_recorder_for_test();
}
