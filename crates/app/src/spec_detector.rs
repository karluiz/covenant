//! Spec auto-detection: watches the repo for new spec files and emits
//! candidate events the UI can turn into "use as mission?" toasts.
//!
//! Classification is path-based:
//! - `docs/specs/*.md` (excluding `_template.md`, `next-features.md`,
//!   and `drafts/**`) → Covenant
//! - `docs/superpowers/specs/*-design.md` → Superpowers
//! - anything else → not a candidate (returns None)

use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecSource {
    Covenant,
    Superpowers,
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn git_toplevel(start: &Path) -> Option<PathBuf> {
    let out = Command::new("git")
        .arg("-C")
        .arg(start)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let root = text.trim();
    if root.is_empty() {
        None
    } else {
        Some(canonical_or_self(Path::new(root)))
    }
}

fn git_worktree_roots(start: &Path) -> Vec<PathBuf> {
    let out = match Command::new("git")
        .arg("-C")
        .arg(start)
        .args(["worktree", "list", "--porcelain"])
        .output()
    {
        Ok(out) if out.status.success() => out,
        _ => return Vec::new(),
    };
    let Ok(text) = String::from_utf8(out.stdout) else {
        return Vec::new();
    };

    let mut roots = Vec::new();
    let mut current: Option<(PathBuf, bool)> = None;
    let flush = |current: &mut Option<(PathBuf, bool)>, roots: &mut Vec<PathBuf>| {
        let Some((path, bare)) = current.take() else {
            return;
        };
        if bare {
            return;
        }
        let path = canonical_or_self(&path);
        if !roots.iter().any(|p| p == &path) {
            roots.push(path);
        }
    };

    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            flush(&mut current, &mut roots);
            current = Some((PathBuf::from(path), false));
        } else if line == "bare" {
            if let Some((_, bare)) = current.as_mut() {
                *bare = true;
            }
        }
    }
    flush(&mut current, &mut roots);
    roots
}

/// Resolve the directory whose spec folders should be watched for a tab.
///
/// The UI passes the tab's current cwd, which may be a nested directory inside
/// a git worktree. Always watching that exact cwd misses specs written at the
/// worktree root (`docs/specs/**`). Prefer git's worktree top-level; outside
/// git, walk upward to the nearest existing spec folder; finally fall back to
/// the cwd itself so non-git projects still get a detector.
pub fn resolve_detector_root(start: &Path) -> PathBuf {
    let start = if start.is_file() {
        start.parent().unwrap_or(start)
    } else {
        start
    };
    let start = canonical_or_self(start);

    if let Some(root) = git_toplevel(&start) {
        return root;
    }

    let mut cur = start.clone();
    loop {
        if cur.join("docs/specs").is_dir() || cur.join("docs/superpowers/specs").is_dir() {
            return cur;
        }
        let Some(parent) = cur.parent() else {
            break;
        };
        cur = parent.to_path_buf();
    }

    start
}

/// Resolve all detector roots that should be active for a tab cwd.
///
/// For git repositories this includes every non-bare sibling worktree, not only
/// the main checkout — and crucially, *regardless* of whether the worktree's
/// spec dirs exist yet. An executor often writes the spec to a worktree mid-
/// session, creating `docs/superpowers/specs/<spec>.md` only at that moment;
/// gating on pre-existing dirs meant such worktrees were never watched and the
/// spec went undetected. `SpecDetector::start` create_dir_all's the spec dirs
/// for each root, so adding a worktree here arms its watcher even if empty.
///
/// This does not litter: a worktree is a full checkout, so the tracked
/// `docs/specs/` already exists in it; only the gitignored
/// `docs/superpowers/specs/` is created when absent.
pub fn resolve_detector_roots(start: &Path) -> Vec<PathBuf> {
    let primary = resolve_detector_root(start);
    let mut roots = Vec::new();
    roots.push(primary.clone());

    for wt in git_worktree_roots(&primary) {
        if !roots.iter().any(|p| p == &wt) {
            roots.push(wt);
        }
    }

    roots
}

/// Classify a path relative to `repo_root`. Returns None if the path is
/// not a recognized spec location.
pub fn classify_spec(repo_root: &Path, path: &Path) -> Option<SpecSource> {
    let rel = path.strip_prefix(repo_root).ok()?;
    let s = rel.to_string_lossy();
    let s = s.replace('\\', "/");

    if !s.ends_with(".md") {
        return None;
    }

    if let Some(rest) = s.strip_prefix("docs/specs/") {
        if rest.contains('/') {
            return None; // drafts/ or any nested path
        }
        if rest == "_template.md" || rest == "next-features.md" {
            return None;
        }
        return Some(SpecSource::Covenant);
    }

    if let Some(rest) = s.strip_prefix("docs/superpowers/specs/") {
        if rest.contains('/') {
            return None;
        }
        return Some(SpecSource::Superpowers);
    }

    None
}

/// Extract the H1 title (e.g. "3.16 — Foo") from a spec markdown body.
/// Returns the trimmed text after the first `# ` line, or None.
pub fn extract_title(md: &str) -> Option<String> {
    for line in md.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            let t = rest.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Extract a flat one-paragraph snippet from the `## Goal` section,
/// truncated to `max_chars` (with a trailing "…" if truncated).
/// Returns "" if no Goal section is present.
pub fn extract_goal_snippet(md: &str, max_chars: usize) -> String {
    let mut in_goal = false;
    let mut buf = String::new();

    for line in md.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("## ") {
            if in_goal {
                break; // next section ends Goal
            }
            let heading = trimmed.trim_start_matches("## ").trim();
            if heading.eq_ignore_ascii_case("goal")
                || heading.to_ascii_lowercase().starts_with("goal ")
            {
                in_goal = true;
            }
            continue;
        }
        if !in_goal {
            continue;
        }
        if trimmed.starts_with('>') {
            continue; // skip blockquotes (template comments)
        }
        if trimmed.is_empty() {
            if !buf.is_empty() {
                buf.push(' ');
            }
            continue;
        }
        if !buf.is_empty() && !buf.ends_with(' ') {
            buf.push(' ');
        }
        buf.push_str(trimmed);
    }

    let flat = buf.trim().to_string();
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let truncated: String = flat.chars().take(max_chars).collect();
    format!("{}…", truncated)
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct SpecCandidate {
    pub repo_root: String,
    pub path: String,
    pub source: SpecSource,
    pub title: Option<String>,
    pub goal_snippet: String,
}

/// If `path` classifies as a spec AND the path is not yet in `seen_specs`,
/// insert it and return a `SpecCandidate` to emit. Otherwise return None.
pub fn maybe_emit_candidate(
    conn: &Connection,
    repo_root: &Path,
    path: &Path,
    now_unix_ms: i64,
) -> rusqlite::Result<Option<SpecCandidate>> {
    let Some(source) = classify_spec(repo_root, path) else {
        return Ok(None);
    };
    let path_str = path.to_string_lossy().into_owned();
    let root_str = repo_root.to_string_lossy().into_owned();

    let inserted = conn.execute(
        "INSERT OR IGNORE INTO seen_specs (repo_root, path, first_seen_at) \
         VALUES (?1, ?2, ?3)",
        rusqlite::params![&root_str, &path_str, now_unix_ms],
    )?;
    if inserted == 0 {
        return Ok(None);
    }

    let body = std::fs::read_to_string(path).unwrap_or_default();
    let title = extract_title(&body);
    let goal_snippet = extract_goal_snippet(&body, 200);

    Ok(Some(SpecCandidate {
        repo_root: root_str,
        path: path_str,
        source,
        title,
        goal_snippet,
    }))
}

/// Recursively walk the spec directories under `repo_root` and insert
/// every recognized spec into `seen_specs`. Returns the number of new
/// rows inserted (existing rows are ignored — idempotent).
pub fn snapshot_existing(
    conn: &Connection,
    repo_root: &Path,
    now_unix_ms: i64,
) -> rusqlite::Result<usize> {
    let mut inserted = 0usize;
    for sub in ["docs/specs", "docs/superpowers/specs"] {
        let dir = repo_root.join(sub);
        if !dir.is_dir() {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if classify_spec(repo_root, &path).is_none() {
                continue;
            }
            let path_str = path.to_string_lossy().into_owned();
            let root_str = repo_root.to_string_lossy().into_owned();
            let n = conn.execute(
                "INSERT OR IGNORE INTO seen_specs (repo_root, path, first_seen_at) \
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![root_str, path_str, now_unix_ms],
            )?;
            inserted += n;
        }
    }
    Ok(inserted)
}

use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Owns the FS watcher for one repo_root. Dropping this stops the watcher.
pub struct SpecDetector {
    _watcher: RecommendedWatcher,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl SpecDetector {
    /// Start a detector for `repo_root`. Performs the initial snapshot
    /// (so existing specs do not generate retroactive events), then
    /// watches `docs/specs` and `docs/superpowers/specs` for new files.
    /// On a hit, emits a `spec:candidate` Tauri event with payload
    /// `SpecCandidate`.
    ///
    /// `db_path` is the absolute path to the covenant SQLite file; the
    /// detector opens its own connection so the watcher thread does not
    /// share `AppState`'s storage mutex.
    pub fn start(app: AppHandle, repo_root: PathBuf, db_path: PathBuf) -> Result<Self, String> {
        // Snapshot existing on startup so we don't fire for preexisting files.
        {
            let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
            snapshot_existing(&conn, &repo_root, now_ms()).map_err(|e| e.to_string())?;
        }

        let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            // Fire on file create or move-into-place (rename "to" event).
            let interesting = matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
            );
            if !interesting {
                return;
            }
            for path in event.paths {
                let _ = tx.send(path);
            }
        })
        .map_err(|e| e.to_string())?;

        for sub in ["docs/specs", "docs/superpowers/specs"] {
            let dir = repo_root.join(sub);
            if !dir.is_dir() {
                if let Err(e) = std::fs::create_dir_all(&dir) {
                    tracing::warn!(dir = %dir.display(), %e, "spec_detector: mkdir failed; skipping watch");
                    continue;
                }
            }
            if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
                tracing::warn!(dir = %dir.display(), %e, "spec_detector: failed to watch dir");
            } else {
                tracing::info!(dir = %dir.display(), "spec_detector: watching");
            }
        }

        let app_clone = app.clone();
        let root_clone = repo_root.clone();
        let db_clone = db_path.clone();
        tokio::spawn(async move {
            let conn = match Connection::open(&db_clone) {
                Ok(c) => c,
                Err(e) => {
                    tracing::error!(%e, "spec_detector: open conn failed");
                    return;
                }
            };
            while let Some(path) = rx.recv().await {
                if !path.is_file() {
                    continue;
                }
                let cand = match maybe_emit_candidate(&conn, &root_clone, &path, now_ms()) {
                    Ok(c) => c,
                    Err(e) => {
                        tracing::warn!(%e, path = %path.display(), "spec_detector: decide failed");
                        continue;
                    }
                };
                if let Some(cand) = cand {
                    if let Err(e) = app_clone.emit("spec:candidate", &cand) {
                        tracing::warn!(%e, "spec_detector: emit failed");
                    } else {
                        tracing::info!(path = %cand.path, source = ?cand.source, "spec_detector: emitted candidate");
                    }
                }
            }
        });

        Ok(Self { _watcher: watcher })
    }
}

#[tauri::command]
pub async fn start_spec_detector(
    state: tauri::State<'_, crate::AppState>,
    app: AppHandle,
    repo_root: String,
) -> Result<(), String> {
    let requested = PathBuf::from(&repo_root);
    let roots = resolve_detector_roots(&requested);
    let db_path = state.storage.path().to_path_buf();
    let mut reg = state.spec_detectors.lock().await;

    let mut touched = false;
    let mut last_err: Option<String> = None;
    for path in roots {
        if reg.contains_key(&path) {
            touched = true;
            continue;
        }
        match SpecDetector::start(app.clone(), path.clone(), db_path.clone()) {
            Ok(det) => {
                reg.insert(path, det);
                touched = true;
            }
            Err(e) => {
                tracing::warn!(requested = %requested.display(), root = %path.display(), error = %e, "spec_detector: start failed");
                last_err = Some(e);
            }
        }
    }

    if touched {
        Ok(())
    } else {
        Err(last_err.unwrap_or_else(|| "no spec detector roots resolved".to_string()))
    }
}

#[tauri::command]
pub async fn mark_spec_seen(
    state: tauri::State<'_, crate::AppState>,
    repo_root: String,
    path: String,
) -> Result<(), String> {
    let db_path = state.storage.path().to_path_buf();
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR IGNORE INTO seen_specs (repo_root, path, first_seen_at) \
             VALUES (?1, ?2, ?3)",
            rusqlite::params![repo_root, path, now_ms()],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/tmp/repo")
    }

    #[test]
    fn covenant_spec_classified() {
        let p = root().join("docs/specs/3.16-foo.md");
        assert_eq!(classify_spec(&root(), &p), Some(SpecSource::Covenant));
    }

    #[test]
    fn superpowers_spec_classified() {
        let p = root().join("docs/superpowers/specs/2026-05-04-foo-design.md");
        assert_eq!(classify_spec(&root(), &p), Some(SpecSource::Superpowers));
    }

    #[test]
    fn template_ignored() {
        let p = root().join("docs/specs/_template.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn next_features_ignored() {
        let p = root().join("docs/specs/next-features.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn drafts_subdir_ignored() {
        let p = root().join("docs/specs/drafts/wip-foo.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn non_md_ignored() {
        let p = root().join("docs/specs/3.1-foo.txt");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn outside_repo_ignored() {
        let p = PathBuf::from("/elsewhere/docs/specs/3.1-foo.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn unrelated_path_ignored() {
        let p = root().join("README.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn resolve_detector_root_walks_up_to_existing_spec_dirs() {
        use std::fs;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs/specs")).unwrap();
        fs::create_dir_all(root.join("packages/app/src")).unwrap();

        let got = resolve_detector_root(&root.join("packages/app/src"));
        assert_eq!(got, root.canonicalize().unwrap());
    }

    #[test]
    fn resolve_detector_roots_include_git_worktrees_with_spec_dirs() {
        use std::fs;
        use std::process::Command;
        use tempfile::TempDir;

        if Command::new("git").arg("--version").output().is_err() {
            return;
        }

        let tmp = TempDir::new().unwrap();
        let main = tmp.path().join("repo");
        let worktree = tmp.path().join("repo-hermes");
        fs::create_dir_all(&main).unwrap();

        let run = |cwd: &std::path::Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };

        run(&main, &["init"]);
        run(&main, &["config", "user.email", "covenant@example.test"]);
        run(&main, &["config", "user.name", "Covenant Tests"]);
        fs::write(main.join("README.md"), "# repo\n").unwrap();
        run(&main, &["add", "README.md"]);
        run(&main, &["commit", "-m", "init"]);
        run(
            &main,
            &[
                "worktree",
                "add",
                "-b",
                "feature/hermes",
                worktree.to_str().unwrap(),
            ],
        );
        fs::create_dir_all(worktree.join("docs/specs")).unwrap();

        let roots = resolve_detector_roots(&main);
        assert!(roots.contains(&main.canonicalize().unwrap()));
        assert!(roots.contains(&worktree.canonicalize().unwrap()));
    }

    #[test]
    fn resolve_detector_roots_include_worktrees_without_spec_dirs() {
        // A worktree whose spec dirs do not yet exist must still be watched:
        // an executor may create `docs/superpowers/specs/<spec>.md` mid-session,
        // and the detector that owns the worktree root is the one that watches
        // (and create_dir_all's) those dirs. Gating on pre-existing dirs missed
        // exactly that case (spec written to a worktree after the session began).
        use std::fs;
        use std::process::Command;
        use tempfile::TempDir;

        if Command::new("git").arg("--version").output().is_err() {
            return;
        }

        let tmp = TempDir::new().unwrap();
        let main = tmp.path().join("repo");
        let worktree = tmp.path().join("repo-internal-browser");
        fs::create_dir_all(&main).unwrap();

        let run = |cwd: &std::path::Path, args: &[&str]| {
            let out = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(args)
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&out.stderr)
            );
        };

        run(&main, &["init"]);
        run(&main, &["config", "user.email", "covenant@example.test"]);
        run(&main, &["config", "user.name", "Covenant Tests"]);
        fs::write(main.join("README.md"), "# repo\n").unwrap();
        run(&main, &["add", "README.md"]);
        run(&main, &["commit", "-m", "init"]);
        run(
            &main,
            &[
                "worktree",
                "add",
                "-b",
                "feature/internal-browser",
                worktree.to_str().unwrap(),
            ],
        );
        // Note: no docs/ dirs created in the worktree.

        let roots = resolve_detector_roots(&main);
        assert!(
            roots.contains(&worktree.canonicalize().unwrap()),
            "worktree without spec dirs must still be a detector root"
        );
    }

    #[test]
    fn extracts_goal_under_h2() {
        let md = "# 3.16 — Foo\n\n## Goal\n\nDoes the thing.\nMore detail.\n\n## Out of scope\n";
        assert_eq!(
            extract_goal_snippet(md, 200),
            "Does the thing. More detail."
        );
    }

    #[test]
    fn truncates_at_limit_with_ellipsis() {
        let md = format!("## Goal\n\n{}", "a".repeat(300));
        let out = extract_goal_snippet(&md, 50);
        assert!(out.ends_with('…'));
        // 50 ASCII chars + "…" — but len() counts bytes; check char count instead
        assert_eq!(out.chars().count(), 51);
    }

    #[test]
    fn returns_empty_when_no_goal_section() {
        let md = "# Title\n\nSome text without a goal heading.";
        assert_eq!(extract_goal_snippet(md, 200), "");
    }

    #[test]
    fn extract_title_from_h1() {
        let md = "# 3.16 — Foo Bar\n\n## Goal\n";
        assert_eq!(extract_title(md), Some("3.16 — Foo Bar".to_string()));
    }

    #[test]
    fn extract_title_returns_none_without_h1() {
        let md = "## Goal\n";
        assert_eq!(extract_title(md), None);
    }

    #[test]
    fn snapshot_inserts_existing_specs_and_skips_unrelated() {
        use rusqlite::Connection;
        use std::fs;
        use std::sync::Once;
        use tempfile::TempDir;

        static INIT: Once = Once::new();
        INIT.call_once(|| unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        });

        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs/specs/drafts")).unwrap();
        fs::create_dir_all(root.join("docs/superpowers/specs")).unwrap();
        fs::write(
            root.join("docs/specs/3.1-foo.md"),
            "# 3.1 — Foo\n".as_bytes(),
        )
        .unwrap();
        fs::write(root.join("docs/specs/_template.md"), b"# template\n").unwrap();
        fs::write(root.join("docs/specs/drafts/wip.md"), b"# wip\n").unwrap();
        fs::write(
            root.join("docs/superpowers/specs/2026-05-04-bar-design.md"),
            b"# bar\n",
        )
        .unwrap();
        fs::write(root.join("README.md"), b"# readme").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::SCHEMA).unwrap();

        let inserted = snapshot_existing(&conn, root, 1234).unwrap();
        assert_eq!(inserted, 2, "only 2 valid specs counted");

        let rows: Vec<String> = conn
            .prepare("SELECT path FROM seen_specs ORDER BY path")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .filter_map(|r| r.ok())
            .collect();
        assert!(rows.iter().any(|p| p.ends_with("3.1-foo.md")));
        assert!(rows.iter().any(|p| p.ends_with("2026-05-04-bar-design.md")));
    }

    #[test]
    fn snapshot_is_idempotent() {
        use rusqlite::Connection;
        use std::fs;
        use std::sync::Once;
        use tempfile::TempDir;

        static INIT: Once = Once::new();
        INIT.call_once(|| unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        });

        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs/specs")).unwrap();
        fs::write(root.join("docs/specs/3.1-foo.md"), b"# 3.1\n").unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::SCHEMA).unwrap();

        let first = snapshot_existing(&conn, root, 100).unwrap();
        let second = snapshot_existing(&conn, root, 200).unwrap();
        assert_eq!(first, 1);
        assert_eq!(second, 0, "second snapshot inserts nothing");
    }

    #[test]
    fn new_spec_decides_emit_and_records() {
        use rusqlite::Connection;
        use std::fs;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs/specs")).unwrap();
        let path = root.join("docs/specs/3.16-foo.md");
        fs::write(
            &path,
            "# 3.16 — Foo\n\n## Goal\n\nDo the foo thing.\n\n## Out\n".as_bytes(),
        )
        .unwrap();

        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::SCHEMA).unwrap();

        let cand = maybe_emit_candidate(&conn, root, &path, 1234)
            .unwrap()
            .expect("should emit");
        assert_eq!(cand.source, SpecSource::Covenant);
        assert_eq!(cand.title.as_deref(), Some("3.16 — Foo"));
        assert_eq!(cand.goal_snippet, "Do the foo thing.");

        // Second call: row exists, no emit.
        let cand2 = maybe_emit_candidate(&conn, root, &path, 5678).unwrap();
        assert!(cand2.is_none());
    }

    #[test]
    fn unrecognized_path_does_not_emit() {
        use rusqlite::Connection;
        use tempfile::TempDir;

        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::SCHEMA).unwrap();

        let path = root.join("README.md");
        let out = maybe_emit_candidate(&conn, root, &path, 0).unwrap();
        assert!(out.is_none());
    }
}
