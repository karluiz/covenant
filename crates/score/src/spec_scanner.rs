//! Periodic spec scanner — walks every known repo for `**/specs/**/*.md`
//! files and records them in the score store, mtime-stamped so backfilled
//! history lands on its real days. Idempotent via the UNIQUE specs.path
//! index. Twin of `commit_scanner`; unlike `spec_watcher` (env-gated,
//! event-driven) this needs no configuration: it feeds off the same
//! persisted repo registry the commit scanner uses.

use crate::ScoreStore;
use std::path::Path;

/// Directories never walked: VCS internals, vendored deps, build output,
/// and agent worktrees (which would double-count every spec in the repo).
const PRUNED: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    "vendor",
    ".claude",
    ".covenant",
    ".worktrees",
];

/// Scan every known repo (in-memory registry ∪ persisted repo_paths) for
/// spec files. Returns how many new specs were recorded.
pub fn scan_known_repos(store: &ScoreStore) -> u32 {
    let mut paths: std::collections::HashSet<std::path::PathBuf> =
        crate::known_repo_paths().into_iter().collect();
    paths.extend(store.repo_paths().unwrap_or_default());
    let mut n = 0u32;
    for root in paths {
        n += scan_repo(&root, store);
    }
    n
}

fn scan_repo(root: &Path, store: &ScoreStore) -> u32 {
    let repo = root.file_name().and_then(|s| s.to_str()).map(String::from);
    let mut n = 0u32;
    let walk = walkdir::WalkDir::new(root)
        .into_iter()
        .filter_entry(|e| !is_pruned(e.path()));
    for entry in walk.filter_map(Result::ok) {
        let p = entry.path();
        if !entry.file_type().is_file() || !is_spec_path(p) {
            continue;
        }
        let mtime_ms = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
        let ctx = crate::Context {
            repo: repo.clone(),
            branch: None,
            group_name: None,
            workspace: None,
        };
        match store.append_spec(mtime_ms, &p.to_string_lossy(), &ctx) {
            Ok(true) => n += 1,
            Ok(false) => {}
            Err(e) => {
                tracing::warn!(target: "score", error = %e, "spec scan append failed");
            }
        }
    }
    n
}

fn is_pruned(p: &Path) -> bool {
    p.file_name()
        .and_then(|s| s.to_str())
        .map(|name| PRUNED.contains(&name))
        .unwrap_or(false)
}

fn is_spec_path(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("md")
        && p.components().any(|c| c.as_os_str() == "specs")
}
