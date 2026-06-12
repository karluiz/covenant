use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

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

#[test]
fn scan_known_repos_scans_registered_paths() {
    let tmp = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();

    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("groowcity");
    std::fs::create_dir(&repo).unwrap();
    make_repo_with_commit(&repo);

    karl_score::register_cwd(&repo);
    let n = karl_score::commit_scanner::scan_known_repos(&store, "test@x.com", 0);
    assert_eq!(n, 1, "registered repo must be scanned");

    let conn = store.connection();
    let c = conn.lock().unwrap();
    let repo_name: String = c
        .query_row(
            "SELECT repo FROM score_events WHERE kind='commit' LIMIT 1",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(repo_name, "groowcity");
}

#[test]
fn register_cwd_resolves_toplevel_from_subdir_and_dedupes() {
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
    let plain = tempdir().unwrap();
    karl_score::register_cwd(plain.path());
    let known = karl_score::known_repo_paths();
    let canonical = plain.path().canonicalize().unwrap();
    assert!(
        !known.contains(&canonical),
        "non-git dirs must not be registered"
    );
}
