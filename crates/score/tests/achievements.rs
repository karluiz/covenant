use karl_score::ScoreStore;
use tempfile::tempdir;

#[test]
fn open_runs_v4_migration_and_creates_achievement_tables() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    assert!(store.table_exists("achievement_facts").unwrap());
    assert!(store.table_exists("achievement_progress").unwrap());
    assert!(store.table_exists("achievement_awards").unwrap());
}
