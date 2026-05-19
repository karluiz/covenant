use karl_score::{filter::build_where, ScoreFilter, TimeRange};

#[test]
fn empty_filter_matches_all() {
    let w = build_where(&ScoreFilter::default());
    assert_eq!(w.sql, "1=1");
    assert!(w.params.is_empty());
}

#[test]
fn repo_and_branch_filter_builds_clause() {
    let f = ScoreFilter {
        repo: Some("k".into()),
        branch: Some("n".into()),
        ..Default::default()
    };
    let w = build_where(&f);
    assert!(w.sql.contains("repo = ?"));
    assert!(w.sql.contains("branch = ?"));
    assert_eq!(w.params.len(), 2);
}

#[test]
fn last7d_adds_timestamp_clause_and_one_param() {
    let f = ScoreFilter {
        range: TimeRange::Last7d,
        ..Default::default()
    };
    let w = build_where(&f);
    assert!(w.sql.contains("timestamp_ms >= ?"));
    assert_eq!(w.params.len(), 1);
}
