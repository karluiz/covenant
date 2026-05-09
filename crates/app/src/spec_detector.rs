//! Spec auto-detection: watches the repo for new spec files and emits
//! candidate events the UI can turn into "use as mission?" toasts.
//!
//! Classification is path-based:
//! - `docs/specs/*.md` (excluding `_template.md`, `next-features.md`,
//!   and `drafts/**`) → Covenant
//! - `docs/superpowers/specs/*-design.md` → Superpowers
//! - anything else → not a candidate (returns None)

use std::path::{Path, PathBuf};
use rusqlite::Connection;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecSource {
    Covenant,
    Superpowers,
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
    pub fn start(
        app: AppHandle,
        repo_root: PathBuf,
        db_path: PathBuf,
    ) -> Result<Self, String> {
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
                EventKind::Create(_)
                    | EventKind::Modify(notify::event::ModifyKind::Name(_))
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
    let path = PathBuf::from(&repo_root);
    let db_path = state.storage.path().to_path_buf();
    let mut reg = state.spec_detectors.lock().await;
    if reg.contains_key(&path) {
        return Ok(());
    }
    let det = SpecDetector::start(app, path.clone(), db_path)?;
    reg.insert(path, det);
    Ok(())
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
        use tempfile::TempDir;
        use std::sync::Once;

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
        fs::write(root.join("docs/specs/3.1-foo.md"), "# 3.1 — Foo\n".as_bytes()).unwrap();
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
        assert!(rows
            .iter()
            .any(|p| p.ends_with("2026-05-04-bar-design.md")));
    }

    #[test]
    fn snapshot_is_idempotent() {
        use rusqlite::Connection;
        use std::fs;
        use tempfile::TempDir;
        use std::sync::Once;

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
