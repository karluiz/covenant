use karl_score::{Context, EventKind, ScoreFilter, ScoreStore};

fn seed(
    store: &ScoreStore,
    ts: i64,
    kind: EventKind,
    repo: &str,
    branch: &str,
    group: Option<&str>,
) {
    store
        .append_with_context(
            ts,
            kind,
            "x",
            None,
            &Context {
                repo: Some(repo.into()),
                branch: Some(branch.into()),
                group_name: group.map(String::from),
            },
        )
        .unwrap();
}

#[test]
fn repos_breakdown_sums_and_sorts() {
    let d = tempfile::tempdir().unwrap();
    let s = ScoreStore::open(d.path()).unwrap();
    let t = 1_700_000_000_000;
    for _ in 0..5 {
        seed(&s, t, EventKind::Prompt, "kt", "main", Some("g"));
    }
    for _ in 0..3 {
        seed(&s, t, EventKind::Prompt, "cs", "main", Some("g"));
    }
    let rows = s.breakdown_repos(&ScoreFilter::default()).unwrap();
    assert_eq!(rows[0].repo, "kt");
    assert_eq!(rows[0].prompts, 5);
    assert_eq!(rows[1].repo, "cs");
    assert_eq!(rows[1].prompts, 3);
}

#[test]
fn branches_breakdown_filters_to_repo() {
    let d = tempfile::tempdir().unwrap();
    let s = ScoreStore::open(d.path()).unwrap();
    let t = 1_700_000_000_000;
    for _ in 0..4 {
        seed(&s, t, EventKind::Prompt, "kt", "notch", Some("g"));
    }
    for _ in 0..2 {
        seed(&s, t, EventKind::Prompt, "kt", "main", Some("g"));
    }
    for _ in 0..9 {
        seed(&s, t, EventKind::Prompt, "cs", "main", Some("g"));
    }
    let rows = s.breakdown_branches("kt", &ScoreFilter::default()).unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|r| r.prompts <= 4));
}

#[test]
fn groups_breakdown_sums_by_group() {
    let d = tempfile::tempdir().unwrap();
    let s = ScoreStore::open(d.path()).unwrap();
    let t = 1_700_000_000_000;
    for _ in 0..3 {
        seed(&s, t, EventKind::Prompt, "kt", "n", Some("a"));
    }
    for _ in 0..7 {
        seed(&s, t, EventKind::Prompt, "cs", "m", Some("b"));
    }
    let rows = s.breakdown_groups(&ScoreFilter::default()).unwrap();
    let a = rows.iter().find(|g| g.group_name == "a").unwrap();
    let b = rows.iter().find(|g| g.group_name == "b").unwrap();
    assert_eq!(a.prompts, 3);
    assert_eq!(b.prompts, 7);
}

#[test]
fn recent_sessions_bucket_by_15min_gap() {
    let d = tempfile::tempdir().unwrap();
    let s = ScoreStore::open(d.path()).unwrap();
    let t0 = 1_700_000_000_000;
    seed(&s, t0, EventKind::Prompt, "kt", "notch", Some("g"));
    seed(&s, t0 + 60_000, EventKind::Prompt, "kt", "notch", Some("g")); // same session
    seed(
        &s,
        t0 + 17 * 60_000,
        EventKind::Prompt,
        "kt",
        "notch",
        Some("g"),
    ); // new session (>15 min gap)
    let rows = s.recent_sessions(10).unwrap();
    assert_eq!(rows.len(), 2);
}

#[test]
fn breakdown_agents_ranks_by_prompt_count() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    karl_score::record_prompt_with_agent("anthropic", Some("claude_code"));
    karl_score::record_prompt_with_agent("anthropic", Some("claude_code"));
    karl_score::record_prompt_with_agent("anthropic", Some("codex"));
    karl_score::record_prompt_with_agent("anthropic", None);

    let cells = store
        .breakdown_agents(&karl_score::ScoreFilter::default())
        .unwrap();
    assert_eq!(cells[0].agent, "claude_code");
    assert_eq!(cells[0].prompts, 2);
    assert_eq!(cells[1].agent, "codex");
    assert_eq!(cells[1].prompts, 1);
    // None is collapsed under "shell"
    assert!(cells.iter().any(|c| c.agent == "shell" && c.prompts == 1));
    karl_score::clear_recorder_for_test();
}

#[test]
fn summary_includes_tokens_and_specs() {
    let tmp = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    karl_score::record_llm_call(
        karl_score::ModelSource::Internal,
        None,
        "anthropic",
        "m",
        karl_score::LlmUsage {
            input: 10,
            output: 5,
            cache_read: 0,
            cache_creation: 0,
        },
        &karl_score::Context::default(),
    );
    karl_score::record_spec("/x/y.md", &karl_score::Context::default());

    let s = store
        .summary_filtered(&karl_score::ScoreFilter::default())
        .unwrap();
    assert_eq!(s.total_tokens, 15);
    assert_eq!(s.total_specs, 1);
    karl_score::clear_recorder_for_test();
}
