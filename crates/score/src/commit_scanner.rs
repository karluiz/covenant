use crate::{EventKind, ScoreStore};
use std::path::Path;
use std::process::Command;

/// Scan `repo_path` for commits by `author_email` whose unix-timestamp is
/// strictly greater than `since_ts_seconds`. Each commit is appended to
/// `store`. Returns count appended.
pub fn scan_repo_since(
    repo_path: &Path,
    author_email: &str,
    since_ts_seconds: i64,
    store: &ScoreStore,
) -> std::io::Result<u32> {
    let out = Command::new("git")
        .args([
            "log",
            &format!("--author={author_email}"),
            &format!("--since=@{since_ts_seconds}"),
            "--pretty=format:%H %ct",
        ])
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
