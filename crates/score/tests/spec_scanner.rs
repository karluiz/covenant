use std::path::Path;
use std::process::Command;
use std::sync::Mutex;
use tempfile::tempdir;

// Serialize tests that touch the global repo-path registry.
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

fn make_repo(dir: &Path) {
    run(dir, &["init", "-q"]);
}

fn write_spec(root: &Path, rel: &str, mtime: Option<&str>) {
    let p = root.join(rel);
    std::fs::create_dir_all(p.parent().unwrap()).unwrap();
    std::fs::write(&p, "# spec").unwrap();
    if let Some(t) = mtime {
        assert!(Command::new("touch")
            .args(["-t", t])
            .arg(&p)
            .status()
            .unwrap()
            .success());
    }
}

fn spec_rows(store: &karl_score::ScoreStore, repo: &str) -> Vec<(String, String)> {
    let conn = store.connection();
    let c = conn.lock().unwrap();
    let mut stmt = c
        .prepare("SELECT path, day FROM specs WHERE repo = ?1 ORDER BY path")
        .unwrap();
    let rows = stmt
        .query_map([repo], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })
        .unwrap();
    rows.collect::<Result<Vec<_>, _>>().unwrap()
}

#[test]
fn scan_records_covenant_and_superpowers_specs_with_mtime_days() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();

    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("spec-repo");
    std::fs::create_dir(&repo).unwrap();
    make_repo(&repo);
    // Historical mtime → historical day attribution (backfill honesty).
    write_spec(&repo, "docs/specs/feature-a.md", Some("202001020304"));
    write_spec(
        &repo,
        "docs/superpowers/specs/2026-01-01-b-design.md",
        None, // now
    );

    karl_score::register_cwd(&repo);
    let n = karl_score::spec_scanner::scan_known_repos(&store);
    assert!(n >= 2, "both spec flavors must be recorded, got {n}");

    let rows = spec_rows(&store, "spec-repo");
    assert_eq!(rows.len(), 2);
    let old = rows
        .iter()
        .find(|(p, _)| p.ends_with("feature-a.md"))
        .expect("covenant spec recorded");
    assert_eq!(old.1, "2020-01-02", "day must come from file mtime");
    assert!(
        rows.iter().any(|(p, _)| p.ends_with("b-design.md")),
        "superpowers spec recorded"
    );
}

#[test]
fn rescan_is_idempotent() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();

    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("idem-spec-repo");
    std::fs::create_dir(&repo).unwrap();
    make_repo(&repo);
    write_spec(&repo, "specs/one.md", None);

    karl_score::register_cwd(&repo);
    karl_score::spec_scanner::scan_known_repos(&store);
    karl_score::spec_scanner::scan_known_repos(&store);
    assert_eq!(spec_rows(&store, "idem-spec-repo").len(), 1);
}

#[test]
fn scan_prunes_vendored_and_worktree_dirs() {
    let _guard = LOCK.lock().unwrap();
    let tmp = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(tmp.path()).unwrap();

    let repo_dir = tempdir().unwrap();
    let repo = repo_dir.path().join("pruned-spec-repo");
    std::fs::create_dir(&repo).unwrap();
    make_repo(&repo);
    write_spec(&repo, "node_modules/pkg/specs/junk.md", None);
    write_spec(&repo, "target/docs/specs/junk.md", None);
    write_spec(&repo, ".claude/worktrees/w1/docs/specs/dup.md", None);
    write_spec(&repo, "docs/specs/real.md", None);

    karl_score::register_cwd(&repo);
    karl_score::spec_scanner::scan_known_repos(&store);

    let rows = spec_rows(&store, "pruned-spec-repo");
    assert_eq!(
        rows.len(),
        1,
        "only the real spec counts, vendored/build/worktree copies are pruned: {rows:?}"
    );
    assert!(rows[0].0.ends_with("docs/specs/real.md"));
}
