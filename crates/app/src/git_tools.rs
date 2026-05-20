use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitBranchSummary {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub last_commit: Option<String>,
    /// Non-null when this branch is checked out by any worktree.
    pub worktree_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitWorktreeSummary {
    pub path: String,
    pub branch: Option<String>,
    pub head: Option<String>,
    pub current: bool,
    pub detached: bool,
    pub bare: bool,
    pub dirty_count: u32,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitRepoSummary {
    pub repo_name: String,
    pub repo_root: String,
    pub current_branch: Option<String>,
    pub detached_head: Option<String>,
    pub dirty_count: u32,
    pub branches: Vec<GitBranchSummary>,
    pub worktrees: Vec<GitWorktreeSummary>,
}

pub fn repo_summary(cwd: &Path) -> Result<GitRepoSummary, String> {
    if !cwd.is_dir() {
        return Err("cwd is not a directory".into());
    }

    let repo_root = git(cwd, &["rev-parse", "--show-toplevel"])?;
    let repo_root = repo_root.trim().to_string();
    if repo_root.is_empty() {
        return Err("not inside a git worktree".into());
    }

    let repo_name = display_repo_name(Path::new(&repo_root));

    let current_branch = git(cwd, &["branch", "--show-current"])
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let detached_head = if current_branch.is_none() {
        git(cwd, &["rev-parse", "--short", "HEAD"])
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    } else {
        None
    };

    let current_root = canonical_or_self(Path::new(&repo_root));
    let mut worktrees = parse_worktree_list(&git(cwd, &["worktree", "list", "--porcelain"])?);
    for wt in &mut worktrees {
        wt.current = canonical_or_self(Path::new(&wt.path)) == current_root;
        wt.dirty_count = status_count(Path::new(&wt.path)).unwrap_or(0);
    }

    let mut branch_to_worktree: HashMap<String, String> = HashMap::new();
    for wt in &worktrees {
        if let Some(branch) = &wt.branch {
            branch_to_worktree.insert(branch.clone(), wt.path.clone());
        }
    }

    let branch_lines = git(
        cwd,
        &[
            "for-each-ref",
            "--sort=-committerdate",
            "--format=%(refname:short)%00%(committerdate:relative)%00%(upstream:short)",
            "refs/heads",
        ],
    )?;
    let mut branches = Vec::new();
    for line in branch_lines.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.split('\0');
        let Some(name) = parts.next().map(str::trim).filter(|s| !s.is_empty()) else {
            continue;
        };
        let last_commit = parts
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        let upstream = parts
            .next()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(ToString::to_string);
        branches.push(GitBranchSummary {
            name: name.to_string(),
            current: current_branch.as_deref() == Some(name),
            upstream,
            last_commit,
            worktree_path: branch_to_worktree.get(name).cloned(),
        });
    }

    Ok(GitRepoSummary {
        repo_name,
        repo_root,
        current_branch,
        detached_head,
        dirty_count: status_count(cwd).unwrap_or(0),
        branches,
        worktrees,
    })
}

pub fn switch_branch(cwd: &Path, branch: &str) -> Result<GitRepoSummary, String> {
    validate_branch_name(branch)?;
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .arg("switch")
        .arg(branch)
        .output()
        .map_err(|e| format!("git switch failed to start: {e}"))?;
    if !out.status.success() {
        return Err(command_error("git switch", &out));
    }
    repo_summary(cwd)
}

fn validate_branch_name(branch: &str) -> Result<(), String> {
    let b = branch.trim();
    if b.is_empty() || b != branch || b.starts_with('-') || b.contains('\0') || b.contains('\n') {
        return Err("invalid branch name".into());
    }
    let out = Command::new("git")
        .args(["check-ref-format", "--branch", branch])
        .output()
        .map_err(|e| format!("git check-ref-format failed to start: {e}"))?;
    if !out.status.success() {
        return Err("invalid branch name".into());
    }
    Ok(())
}

fn parse_worktree_list(text: &str) -> Vec<GitWorktreeSummary> {
    let mut out = Vec::new();
    let mut current: Option<GitWorktreeSummary> = None;

    for line in text.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(wt) = current.take() {
                out.push(wt);
            }
            current = Some(GitWorktreeSummary {
                path: path.to_string(),
                branch: None,
                head: None,
                current: false,
                detached: false,
                bare: false,
                dirty_count: 0,
            });
            continue;
        }

        let Some(wt) = current.as_mut() else {
            continue;
        };
        if let Some(head) = line.strip_prefix("HEAD ") {
            wt.head = Some(head.to_string());
        } else if let Some(branch) = line.strip_prefix("branch ") {
            wt.branch = Some(
                branch
                    .strip_prefix("refs/heads/")
                    .unwrap_or(branch)
                    .to_string(),
            );
        } else if line == "detached" {
            wt.detached = true;
        } else if line == "bare" {
            wt.bare = true;
        }
    }

    if let Some(wt) = current.take() {
        out.push(wt);
    }
    out
}

fn status_count(cwd: &Path) -> Result<u32, String> {
    let text = git(cwd, &["status", "--porcelain"])?;
    Ok(text.lines().filter(|l| !l.trim().is_empty()).count() as u32)
}

pub fn display_repo_name(repo_root: &Path) -> String {
    if repo_declares_covenant(repo_root) {
        return "COVENANT".to_string();
    }
    repo_root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| repo_root.to_string_lossy().to_string())
}

fn repo_declares_covenant(repo_root: &Path) -> bool {
    let Ok(package_json) = std::fs::read_to_string(repo_root.join("package.json")) else {
        return false;
    };
    package_json.contains(r#""name": "covenant""#) || package_json.contains(r#""name":"covenant""#)
}

fn canonical_or_self(path: &Path) -> PathBuf {
    path.canonicalize().unwrap_or_else(|_| path.to_path_buf())
}

fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .map_err(|e| format!("git failed to start: {e}"))?;
    if !out.status.success() {
        return Err(command_error("git", &out));
    }
    String::from_utf8(out.stdout).map_err(|e| format!("git output was not UTF-8: {e}"))
}

fn command_error(label: &str, out: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        format!("{label} exited with status {}", out.status)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_worktree_porcelain() {
        let text = "worktree /repo\nHEAD abc123\nbranch refs/heads/main\n\nworktree /repo-feature\nHEAD def456\nbranch refs/heads/feat/ui\n\nworktree /repo-detached\nHEAD fedcba\ndetached\n";
        let trees = parse_worktree_list(text);
        assert_eq!(trees.len(), 3);
        assert_eq!(trees[0].path, "/repo");
        assert_eq!(trees[0].branch.as_deref(), Some("main"));
        assert_eq!(trees[1].branch.as_deref(), Some("feat/ui"));
        assert!(trees[2].detached);
        assert_eq!(trees[2].branch, None);
    }
}
