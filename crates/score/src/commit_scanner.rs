use crate::{EventKind, ScoreStore};
use std::path::Path;
use std::process::Command;

/// Scan every known repo (in-memory registry ∪ persisted repo_paths) for new
/// commits by `author_email`. Each repo keeps its own cursor: the first scan
/// backfills full history, later scans only look past the cursor. Duplicate
/// rows are impossible regardless — commits carry a unique (repo, executor)
/// index. Returns total appended.
pub fn scan_known_repos(store: &ScoreStore, author_email: &str) -> u32 {
    let mut paths: std::collections::HashSet<std::path::PathBuf> =
        crate::known_repo_paths().into_iter().collect();
    paths.extend(store.repo_paths().unwrap_or_default());
    let mut n = 0u32;
    for p in paths {
        let mut since = store.get_commit_cursor(&p).unwrap_or(0);
        // Self-heal: cursor advanced but nothing ever recorded for this repo
        // → a previous scan failed or over-filtered. Backfill from scratch;
        // the unique commit index makes that idempotent.
        let repo_name = p.file_name().and_then(|s| s.to_str()).unwrap_or("repo");
        if since > 0 && !store.has_commits_for_repo(repo_name).unwrap_or(true) {
            since = 0;
        }
        let now_s = chrono::Utc::now().timestamp();
        if let Ok(c) = scan_repo_since(&p, author_email, since, store) {
            n += c;
            let _ = store.set_commit_cursor(&p, now_s);
        }
    }
    n
}

/// Scan `repo_path` for commits by `author_email` whose unix-timestamp is
/// strictly greater than `since_ts_seconds`. Each commit is appended to
/// `store`. Returns count appended.
pub fn scan_repo_since(
    repo_path: &Path,
    author_email: &str,
    since_ts_seconds: i64,
    store: &ScoreStore,
) -> std::io::Result<u32> {
    // since=0 means full-history backfill: omit --since entirely. Use RFC3339
    // for the cutoff — git's approxidate does NOT read "@0" as the epoch (it
    // filters like "today 00:00") and small @N values parse unpredictably.
    let mut args = vec![
        "log".to_string(),
        format!("--author={author_email}"),
        "--pretty=format:%H %ct".to_string(),
    ];
    if since_ts_seconds > 0 {
        let cutoff = chrono::DateTime::from_timestamp(since_ts_seconds, 0)
            .unwrap_or_default()
            .to_rfc3339();
        args.push(format!("--since={cutoff}"));
    }
    let out = Command::new("git")
        .args(&args)
        .current_dir(repo_path)
        .output()?;
    if !out.status.success() {
        return Ok(0);
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let repo_name = repo_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("repo")
        .to_string();
    let branch = Command::new("git")
        .current_dir(repo_path)
        .args(["branch", "--show-current"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8(o.stdout).ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let mut n = 0u32;
    for line in s.lines() {
        let mut parts = line.split_whitespace();
        let (Some(sha), Some(ts)) = (parts.next(), parts.next()) else {
            continue;
        };
        let Ok(ts_s) = ts.parse::<i64>() else {
            continue;
        };
        if ts_s <= since_ts_seconds {
            continue;
        }
        let ctx = crate::types::Context {
            repo: Some(repo_name.clone()),
            branch: branch.clone(),
            group_name: None,
            workspace: None,
        };
        let exec = format!("{repo_name}:{}", &sha[..sha.len().min(7)]);
        let _ = store.append_with_context(ts_s * 1000, EventKind::Commit, &exec, None, &ctx);
        n += 1;
    }
    Ok(n)
}
