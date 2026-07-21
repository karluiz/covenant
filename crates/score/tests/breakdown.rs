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
                workspace: None,
            },
        )
        .unwrap();
}

fn seed_ws(store: &ScoreStore, ts: i64, group: &str, workspace: Option<&str>) {
    store
        .append_with_context(
            ts,
            EventKind::Prompt,
            "x",
            None,
            &Context {
                repo: None,
                branch: None,
                group_name: Some(group.into()),
                workspace: workspace.map(String::from),
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
fn groups_breakdown_collapses_casing_and_badges_a_single_workspace() {
    let d = tempfile::tempdir().unwrap();
    let s = ScoreStore::open(d.path()).unwrap();
    let t = 1_700_000_000_000;
    // One logical group: casing typos AND workspaces all fold into one row.
    // Keying by workspace too would split the panel into near-duplicate rows
    // (and strand legacy null-workspace events in a bare row of their own).
    for _ in 0..3 {
        seed_ws(&s, t, "COVENANT", Some("ws-a"));
    }
    for _ in 0..2 {
        seed_ws(&s, t, "COVEnant", Some("ws-a"));
    }
    for _ in 0..7 {
        seed_ws(&s, t, "Covenant", Some("ws-b"));
    }
    // Legacy event with no workspace attribution at all.
    seed_ws(&s, t, "Covenant", None);

    let rows = s.breakdown_groups(&ScoreFilter::default()).unwrap();
    assert_eq!(rows.len(), 1, "one row per logical group");
    assert_eq!(rows[0].prompts, 13);
    assert_eq!(
        rows[0].workspace, None,
        "two named workspaces is ambiguous — no badge"
    );

    // A group living in exactly one named workspace DOES get the badge, and
    // trailing legacy nulls don't suppress it.
    let d2 = tempfile::tempdir().unwrap();
    let s2 = ScoreStore::open(d2.path()).unwrap();
    seed_ws(&s2, t, "Solo", Some("ws-a"));
    seed_ws(&s2, t, "solo", None);
    let rows2 = s2.breakdown_groups(&ScoreFilter::default()).unwrap();
    assert_eq!(rows2.len(), 1);
    assert_eq!(rows2[0].prompts, 2);
    assert_eq!(rows2[0].workspace.as_deref(), Some("ws-a"));
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
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();
    let t = 1_700_000_000_000;
    // Append straight to the store rather than through `set_recorder` +
    // `record_prompt_with_agent`: the recorder is a process-global, so two
    // tests in this binary using it race and steal each other's events.
    let prompt = |agent: Option<&str>| {
        store
            .append_with_context(
                t,
                EventKind::Prompt,
                "anthropic",
                agent,
                &Context::default(),
            )
            .unwrap()
    };
    prompt(Some("claude_code"));
    prompt(Some("claude_code"));
    prompt(Some("codex"));
    prompt(None);

    let cells = store
        .breakdown_agents(&karl_score::ScoreFilter::default())
        .unwrap();
    assert_eq!(cells[0].agent, "claude_code");
    assert_eq!(cells[0].prompts, 2);
    assert_eq!(cells[1].agent, "codex");
    assert_eq!(cells[1].prompts, 1);
    // None is collapsed under "shell"
    assert!(cells.iter().any(|c| c.agent == "shell" && c.prompts == 1));
}

#[test]
fn summary_includes_tokens_and_specs() {
    let tmp = tempfile::tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();
    let t = 1_700_000_000_000;
    // Same reason as above: no process-global recorder in a parallel test.
    store
        .append_llm_call(
            t,
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
            &Context::default(),
        )
        .unwrap();
    store
        .append_spec(t, "/x/y.md", &Context::default())
        .unwrap();

    let s = store
        .summary_filtered(&karl_score::ScoreFilter::default())
        .unwrap();
    assert_eq!(s.total_tokens, 15);
    assert_eq!(s.total_specs, 1);
}

#[test]
fn skill_usage_counts_per_unit_strips_prefix_and_honors_group_filter() {
    let d = tempfile::tempdir().unwrap();
    let s = ScoreStore::open(d.path()).unwrap();
    let t = 1_700_000_000_000;
    let use_in = |group: &str, name: &str| {
        s.append_with_context(
            t,
            EventKind::SkillUse,
            &format!("skill:{name}"),
            None,
            &Context {
                repo: None,
                branch: None,
                group_name: Some(group.into()),
                workspace: None,
            },
        )
        .unwrap()
    };
    use_in("a", "kyc");
    use_in("a", "kyc");
    use_in("a", "pty-conventions");
    use_in("b", "kyc");
    // A prompt must never leak into the usage breakdown.
    seed(&s, t, EventKind::Prompt, "kt", "n", Some("a"));

    let all = s.skill_usage(&ScoreFilter::default()).unwrap();
    assert_eq!(all.len(), 2, "one row per unit, prompts excluded");
    assert_eq!(all[0].skill, "kyc", "sorted most-used first");
    assert_eq!(all[0].uses, 3);

    let group_a = s
        .skill_usage(&ScoreFilter {
            group_name: Some("a".into()),
            ..ScoreFilter::default()
        })
        .unwrap();
    assert_eq!(group_a.iter().find(|r| r.skill == "kyc").unwrap().uses, 2);
}
