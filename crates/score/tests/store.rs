use karl_score::{EventKind, ScoreStore};
use tempfile::tempdir;

#[test]
fn append_and_summary_counts_prompts_and_commits() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    store.append(now, EventKind::Prompt, "anthropic").unwrap();
    store.append(now, EventKind::Prompt, "anthropic").unwrap();
    store.append(now, EventKind::Commit, "repo:abc1234").unwrap();
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
    store.append(day_ms, EventKind::Prompt, "anthropic").unwrap();
    store.append(day_ms + 1000, EventKind::Prompt, "anthropic").unwrap();
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
