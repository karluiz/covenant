use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use tempfile::tempdir;

// Serialize tests that touch the global recorder / repo-path registry.
static LOCK: Mutex<()> = Mutex::new(());

fn run(dir: &Path, args: &[&str]) {
    assert!(
        Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap()
            .success(),
        "git {args:?} failed in {dir:?}"
    );
}

fn make_repo_with_commit(dir: &Path) {
    run(dir, &["init", "-q"]);
    run(dir, &["config", "user.email", "test@x.com"]);
    run(dir, &["config", "user.name", "Test"]);
    std::fs::write(dir.join("f.txt"), "hi").unwrap();
    run(dir, &["add", "."]);
    run(dir, &["commit", "-q", "-m", "init"]);
}

fn commit_count(store: &karl_score::ScoreStore, repo: &str) -> i64 {
    let conn = store.connection();
    let c = conn.lock().unwrap();
    c.query_row(
        "SELECT COUNT(*) FROM score_events WHERE kind='commit' AND repo=?1",
        [repo],
        |r| r.get(0),
    )
    .unwrap()
}

#[test]
fn scan_known_repos_scans_registered_paths() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();

    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("groowcity");
    std::fs::create_dir(&repo).unwrap();
    make_repo_with_commit(&repo);

    karl_score::register_cwd(&repo);
    karl_score::commit_scanner::scan_known_repos(&store, "test@x.com");
    assert_eq!(commit_count(&store, "groowcity"), 1);
}

#[test]
fn scan_known_repos_backfills_full_history_on_first_scan() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();

    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("backfill-repo");
    std::fs::create_dir(&repo).unwrap();
    make_repo_with_commit(&repo);
    // An old commit, well before "now - 24h" windows.
    std::fs::write(repo.join("g.txt"), "old").unwrap();
    run(&repo, &["add", "."]);
    run(
        &repo,
        &[
            "-c",
            "user.email=test@x.com",
            "commit",
            "-q",
            "-m",
            "old",
            "--date",
            "2020-01-02T03:04:05",
        ],
    );

    karl_score::register_cwd(&repo);
    karl_score::commit_scanner::scan_known_repos(&store, "test@x.com");
    assert_eq!(
        commit_count(&store, "backfill-repo"),
        2,
        "first scan must import the repo's full history, not a recent window"
    );
}

#[test]
fn scan_known_repos_rescan_does_not_duplicate() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();

    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("dedup-scan-repo");
    std::fs::create_dir(&repo).unwrap();
    make_repo_with_commit(&repo);

    karl_score::register_cwd(&repo);
    karl_score::commit_scanner::scan_known_repos(&store, "test@x.com");
    karl_score::commit_scanner::scan_known_repos(&store, "test@x.com");
    assert_eq!(
        commit_count(&store, "dedup-scan-repo"),
        1,
        "rescans (and overlapping windows) must not duplicate commits"
    );
}

#[test]
fn duplicate_commit_insert_is_ignored() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();
    let ctx = karl_score::Context {
        repo: Some("dup-ins".into()),
        branch: Some("main".into()),
        group_name: None,
        workspace: None,
    };
    for _ in 0..2 {
        store
            .append_with_context(
                1_700_000_000_000,
                karl_score::EventKind::Commit,
                "dup-ins:abc1234",
                None,
                &ctx,
            )
            .unwrap();
    }
    assert_eq!(commit_count(&store, "dup-ins"), 1);
}

#[test]
fn registered_paths_persist_to_store_when_recorder_set() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(tmp.path()).unwrap());
    karl_score::set_recorder(store.clone());

    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("persist-repo");
    std::fs::create_dir(&repo).unwrap();
    make_repo_with_commit(&repo);

    karl_score::register_cwd(&repo);
    karl_score::clear_recorder_for_test();

    let canonical = repo.canonicalize().unwrap();
    let persisted = store.repo_paths().unwrap();
    assert!(
        persisted.contains(&canonical),
        "registry must survive relaunch via the store: {persisted:?}"
    );

    // A fresh store (fresh process simulation) scans persisted paths even if
    // the in-memory registry never saw them.
    let n = karl_score::commit_scanner::scan_known_repos(&store, "test@x.com");
    assert!(n >= 1);
    assert_eq!(commit_count(&store, "persist-repo"), 1);
}

#[test]
fn register_cwd_resolves_toplevel_from_subdir_and_dedupes() {
    let _guard = LOCK.lock().unwrap();
    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("dedup-repo");
    let sub = repo.join("src");
    std::fs::create_dir_all(&sub).unwrap();
    make_repo_with_commit(&repo);

    karl_score::register_cwd(&repo);
    karl_score::register_cwd(&sub); // same repo via subdir

    let canonical = repo.canonicalize().unwrap();
    let known = karl_score::known_repo_paths();
    let hits = known.iter().filter(|p| **p == canonical).count();
    assert_eq!(hits, 1, "subdir and root must register one canonical path");
}

#[test]
fn register_cwd_ignores_non_repos() {
    let _guard = LOCK.lock().unwrap();
    let plain = tempdir().unwrap();
    karl_score::register_cwd(plain.path());
    let known = karl_score::known_repo_paths();
    let canonical = plain.path().canonicalize().unwrap();
    assert!(
        !known.contains(&canonical),
        "non-git dirs must not be registered"
    );
}
