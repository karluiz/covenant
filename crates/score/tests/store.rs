use karl_score::{EventKind, ScoreStore};
use tempfile::tempdir;

#[test]
fn append_and_summary_counts_prompts_and_commits() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    store.append(now, EventKind::Prompt, "anthropic").unwrap();
    store.append(now, EventKind::Prompt, "anthropic").unwrap();
    store
        .append(now, EventKind::Commit, "repo:abc1234")
        .unwrap();
    let s = store.summary().unwrap();
    assert_eq!(s.total_prompts, 2);
    assert_eq!(s.total_commits, 1);
    assert_eq!(s.today_prompts, 2);
    assert_eq!(s.today_commits, 1);
}

#[test]
fn heatmap_returns_one_cell_per_day_with_data() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let day_ms = 86_400_000i64;
    store.append(0, EventKind::Prompt, "anthropic").unwrap();
    store.append(1000, EventKind::Prompt, "anthropic").unwrap();
    store.append(2000, EventKind::Prompt, "anthropic").unwrap();
    store
        .append(day_ms, EventKind::Prompt, "anthropic")
        .unwrap();
    store
        .append(day_ms + 1000, EventKind::Prompt, "anthropic")
        .unwrap();
    let cells = store.heatmap_all().unwrap();
    assert_eq!(cells.len(), 2);
    assert_eq!(cells[0].prompts, 3);
    assert_eq!(cells[1].prompts, 2);
}

#[test]
fn streak_increments_for_consecutive_days_and_breaks_on_gap() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let now = chrono::Local::now();
    let one_day = chrono::Duration::days(1);
    for offset in [3i64, 2, 1, 0] {
        let ts = (now - one_day * offset as i32).timestamp_millis();
        store.append(ts, EventKind::Prompt, "anthropic").unwrap();
    }
    let s = store.summary().unwrap();
    assert_eq!(s.current_streak, 4);
}

#[test]
fn migration_adds_context_columns_on_existing_db() {
    let dir = tempfile::tempdir().unwrap();
    // Pre-create a v1 DB without context columns
    {
        let conn = rusqlite::Connection::open(dir.path().join("score.sqlite")).unwrap();
        conn.execute_batch(
            "CREATE TABLE score_events(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            executor TEXT NOT NULL,
            day TEXT NOT NULL)",
        )
        .unwrap();
        conn.execute("INSERT INTO score_events(timestamp_ms,kind,executor,day) VALUES (1,'prompt','x','2026-01-01')", []).unwrap();
    }
    // Open with new code — should ALTER and preserve row
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let c = store.connection();
    let g = c.lock().unwrap();
    let cnt: i64 = g
        .query_row(
            "SELECT COUNT(*) FROM score_events WHERE repo IS NULL",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(cnt, 1);
}

#[test]
fn append_with_context_stores_fields() {
    let dir = tempfile::tempdir().unwrap();
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let ctx = karl_score::Context {
        repo: Some("karlTerminal".into()),
        branch: Some("notch".into()),
        group_name: Some("main".into()),
        workspace: None,
    };
    store
        .append_with_context(
            1_700_000_000_000,
            karl_score::EventKind::Prompt,
            "anthropic",
            None,
            &ctx,
        )
        .unwrap();
    let c = store.connection();
    let g = c.lock().unwrap();
    let row: (String, String, String) = g
        .query_row(
            "SELECT repo, branch, group_name FROM score_events",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(row, ("karlTerminal".into(), "notch".into(), "main".into()));
}

#[test]
fn summary_filtered_by_repo() {
    let dir = tempfile::tempdir().unwrap();
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let kt = karl_score::Context {
        repo: Some("kt".into()),
        branch: Some("n".into()),
        group_name: None,
        workspace: None,
    };
    let cs = karl_score::Context {
        repo: Some("cs".into()),
        branch: Some("m".into()),
        group_name: None,
        workspace: None,
    };
    for _ in 0..3 {
        store
            .append_with_context(
                1_700_000_000_000,
                karl_score::EventKind::Prompt,
                "a",
                None,
                &kt,
            )
            .unwrap();
    }
    for _ in 0..7 {
        store
            .append_with_context(
                1_700_000_000_000,
                karl_score::EventKind::Prompt,
                "a",
                None,
                &cs,
            )
            .unwrap();
    }
    let s = store
        .summary_filtered(&karl_score::ScoreFilter {
            repo: Some("kt".into()),
            ..Default::default()
        })
        .unwrap();
    assert_eq!(s.total_prompts, 3);
}

#[test]
fn heatmap_filtered_by_repo() {
    let dir = tempfile::tempdir().unwrap();
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let kt = karl_score::Context {
        repo: Some("kt".into()),
        branch: None,
        group_name: None,
        workspace: None,
    };
    for _ in 0..4 {
        store
            .append_with_context(
                1_700_000_000_000,
                karl_score::EventKind::Prompt,
                "a",
                None,
                &kt,
            )
            .unwrap();
    }
    let cs = karl_score::Context {
        repo: Some("cs".into()),
        branch: None,
        group_name: None,
        workspace: None,
    };
    for _ in 0..2 {
        store
            .append_with_context(
                1_700_000_000_000,
                karl_score::EventKind::Prompt,
                "a",
                None,
                &cs,
            )
            .unwrap();
    }
    let cells = store
        .heatmap_filtered(&karl_score::ScoreFilter {
            repo: Some("kt".into()),
            ..Default::default()
        })
        .unwrap();
    let total: u32 = cells.iter().map(|c| c.prompts).sum();
    assert_eq!(total, 4);
}

#[test]
fn migration_v3_creates_specs_and_llm_calls_and_agent_column() {
    let tmp = tempfile::tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();
    let conn = store.connection();
    let c = conn.lock().unwrap();

    let v: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .unwrap();
    assert!(v >= 3, "expected user_version >= 3, got {v}");

    // agent column present on score_events
    let cols: Vec<String> = c
        .prepare("PRAGMA table_info(score_events)")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(1))
        .unwrap()
        .map(|r| r.unwrap())
        .collect();
    assert!(cols.contains(&"agent".to_string()));

    // tables exist
    c.execute(
        "INSERT INTO specs(ts_ms, day, path) VALUES (1, '1970-01-01', 'a')",
        [],
    )
    .unwrap();
    c.execute(
        "INSERT INTO llm_calls(ts_ms, day, source, provider, model, input_tokens, output_tokens) \
         VALUES (1, '1970-01-01', 'internal', 'anthropic', 'claude-opus-4-7', 100, 50)",
        [],
    )
    .unwrap();
}

use karl_score::commit_scanner::scan_repo_since;
use std::process::Command;

#[test]
fn scan_repo_since_counts_new_commits() {
    let repo = tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git")
            .args(args)
            .current_dir(repo.path())
            .output()
            .unwrap();
    };
    run(&["init", "-q"]);
    run(&["config", "user.email", "test@x.com"]);
    run(&["config", "user.name", "test"]);
    std::fs::write(repo.path().join("a.txt"), "1").unwrap();
    run(&["add", "."]);
    run(&["commit", "-m", "one"]);
    std::fs::write(repo.path().join("a.txt"), "2").unwrap();
    run(&["commit", "-am", "two"]);

    let dir = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let n = scan_repo_since(repo.path(), "test@x.com", 0, &store).unwrap();
    assert_eq!(n, 2);
    let s = store.summary().unwrap();
    assert_eq!(s.total_commits, 2);
}
