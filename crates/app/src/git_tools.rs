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

const MAX_DIFF_LINES: usize = 5000;

pub fn changes(cwd: &Path) -> Result<diff::Changes, String> {
    use diff::{ChangeStatus, FileChange};
    use std::collections::HashMap;

    let parse_side = |args: &[&str]| -> Result<HashMap<String, diff::NumStat>, String> {
        let raw = git(cwd, args)?;
        Ok(diff::parse_numstat(&raw).into_iter().map(|n| (n.path.clone(), n)).collect())
    };
    let unstaged_ns = parse_side(&["diff", "--numstat"])?;
    let staged_ns = parse_side(&["diff", "--cached", "--numstat"])?;

    // porcelain gives reliable status letters + rename old->new + untracked.
    let porcelain = git(cwd, &["status", "--porcelain"])?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 3 { continue; }
        let x = line.as_bytes()[0] as char; // staged (index) status
        let y = line.as_bytes()[1] as char; // worktree status
        let rest = &line[3..];
        let (old_path, path) = match rest.split_once(" -> ") {
            Some((o, n)) => (Some(o.to_string()), n.to_string()),
            None => (None, rest.to_string()),
        };
        if x == '?' && y == '?' {
            unstaged.push(FileChange { path, old_path: None, status: ChangeStatus::Untracked, added: 0, removed: 0, binary: false });
            continue;
        }
        let map_status = |c: char| match c {
            'A' => Some(ChangeStatus::Added),
            'M' => Some(ChangeStatus::Modified),
            'D' => Some(ChangeStatus::Deleted),
            'R' => Some(ChangeStatus::Renamed),
            _ => None,
        };
        if let Some(status) = map_status(x) {
            let ns = staged_ns.get(&path);
            staged.push(FileChange {
                path: path.clone(), old_path: old_path.clone(), status,
                added: ns.map(|n| n.added).unwrap_or(0),
                removed: ns.map(|n| n.removed).unwrap_or(0),
                binary: ns.map(|n| n.binary).unwrap_or(false),
            });
        }
        if let Some(status) = map_status(y) {
            let ns = unstaged_ns.get(&path);
            unstaged.push(FileChange {
                path: path.clone(), old_path, status,
                added: ns.map(|n| n.added).unwrap_or(0),
                removed: ns.map(|n| n.removed).unwrap_or(0),
                binary: ns.map(|n| n.binary).unwrap_or(false),
            });
        }
    }
    Ok(diff::Changes { staged, unstaged })
}

pub fn stage(cwd: &Path, path: &str) -> Result<diff::Changes, String> {
    git(cwd, &["add", "--", path])?;
    changes(cwd)
}

pub fn unstage(cwd: &Path, path: &str) -> Result<diff::Changes, String> {
    // `restore --staged` is a no-op-safe unstage on any git >= 2.23.
    git(cwd, &["restore", "--staged", "--", path])?;
    changes(cwd)
}

pub fn file_diff(cwd: &Path, path: &str, staged: bool) -> Result<diff::FileDiff, String> {
    // Untracked file isn't known to git diff; use --no-index against /dev/null.
    let raw = if staged {
        git(cwd, &["diff", "--cached", "--", path])?
    } else {
        let tracked = git(cwd, &["diff", "--", path])?;
        if !tracked.trim().is_empty() {
            tracked
        } else {
            // --no-index returns exit code 1 on differences; capture stdout regardless.
            let out = Command::new("git").arg("-C").arg(cwd)
                .args(["diff", "--no-index", "--", "/dev/null", path])
                .output().map_err(|e| format!("git failed to start: {e}"))?;
            String::from_utf8_lossy(&out.stdout).to_string()
        }
    };
    Ok(diff::FileDiff {
        path: path.to_string(),
        old_path: None,
        body: diff::parse_unified_diff(&raw, MAX_DIFF_LINES),
    })
}

pub mod diff {
    use serde::Serialize;

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "lowercase")]
    pub enum LineKind { Context, Add, Del }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct DiffLine {
        pub kind: LineKind,
        pub old_no: Option<u32>,
        pub new_no: Option<u32>,
        pub text: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Hunk {
        pub old_start: u32,
        pub new_start: u32,
        pub header: String,
        pub lines: Vec<DiffLine>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(tag = "kind", rename_all = "camelCase")]
    pub enum FileDiffBody {
        Hunks { hunks: Vec<Hunk> },
        Binary { size_bytes: u64 },
        TooLarge { line_count: u32 },
    }
    // NOTE: serde internally-tagged enums require STRUCT variants. Always
    // construct/match with brace syntax: `FileDiffBody::Hunks { hunks }`.

    #[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "lowercase")]
    pub enum ChangeStatus { Modified, Added, Deleted, Renamed, Untracked }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FileChange {
        pub path: String,
        pub old_path: Option<String>,
        pub status: ChangeStatus,
        pub added: u32,
        pub removed: u32,
        pub binary: bool,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct Changes { pub staged: Vec<FileChange>, pub unstaged: Vec<FileChange> }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FileDiff {
        pub path: String,
        pub old_path: Option<String>,
        pub body: FileDiffBody,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NumStat { pub added: u32, pub removed: u32, pub binary: bool, pub path: String }

    /// git `--numstat` encodes renames as `old => new` or `pre{old => new}post`.
    /// Reduce to the destination path so it matches `git status --porcelain` paths.
    pub fn numstat_dest_path(raw: &str) -> String {
        let Some(arrow) = raw.find(" => ") else { return raw.to_string(); };
        // brace form: prefix{old => new}suffix
        if let (Some(open), Some(close)) = (
            raw[..arrow].rfind('{'),
            raw[arrow..].find('}').map(|i| arrow + i),
        ) {
            let prefix = &raw[..open];
            let new_part = &raw[arrow + 4..close];
            let suffix = &raw[close + 1..];
            return format!("{prefix}{new_part}{suffix}");
        }
        raw[arrow + 4..].to_string()
    }

    pub fn parse_numstat(raw: &str) -> Vec<NumStat> {
        raw.lines().filter_map(|line| {
            let mut p = line.splitn(3, '\t');
            let a = p.next()?; let r = p.next()?; let path = p.next()?;
            if path.is_empty() { return None; }
            let binary = a == "-" || r == "-";
            Some(NumStat {
                added: a.parse().unwrap_or(0),
                removed: r.parse().unwrap_or(0),
                binary,
                path: numstat_dest_path(path),
            })
        }).collect()
    }

    /// Pure: parse `git diff` text for ONE file into a renderable body.
    pub fn parse_unified_diff(raw: &str, max_lines: usize) -> FileDiffBody {
        if raw.lines().any(|l| l.starts_with("Binary files") && l.ends_with("differ")) {
            return FileDiffBody::Binary { size_bytes: 0 };
        }
        let mut hunks: Vec<Hunk> = Vec::new();
        let mut total_lines = 0usize;
        let mut old_no = 0u32;
        let mut new_no = 0u32;
        for line in raw.lines() {
            if let Some(rest) = line.strip_prefix("@@") {
                // "@@ -old_start,old_len +new_start,new_len @@ header"
                let (ranges, header) = match rest.split_once("@@") {
                    Some((a, b)) => (a, b.trim().to_string()),
                    None => (rest, String::new()),
                };
                let (mut os, mut ns) = (1u32, 1u32);
                for tok in ranges.split_whitespace() {
                    if let Some(v) = tok.strip_prefix('-') { os = v.split(',').next().unwrap_or("1").parse().unwrap_or(1); }
                    if let Some(v) = tok.strip_prefix('+') { ns = v.split(',').next().unwrap_or("1").parse().unwrap_or(1); }
                }
                old_no = os; new_no = ns;
                hunks.push(Hunk { old_start: os, new_start: ns, header, lines: Vec::new() });
                continue;
            }
            if hunks.is_empty() { continue; } // file headers before first hunk
            if line.starts_with("\\ No newline") { continue; }
            let (kind, text) = if let Some(t) = line.strip_prefix('+') {
                (LineKind::Add, t)
            } else if let Some(t) = line.strip_prefix('-') {
                (LineKind::Del, t)
            } else if let Some(t) = line.strip_prefix(' ') {
                (LineKind::Context, t)
            } else {
                continue; // diff --git / index / +++ / --- lines
            };
            total_lines += 1;
            if total_lines > max_lines {
                return FileDiffBody::TooLarge { line_count: total_lines as u32 };
            }
            let (o, n) = match kind {
                LineKind::Context => { let p = (Some(old_no), Some(new_no)); old_no += 1; new_no += 1; p }
                LineKind::Add => { let p = (None, Some(new_no)); new_no += 1; p }
                LineKind::Del => { let p = (Some(old_no), None); old_no += 1; p }
            };
            if let Some(h) = hunks.last_mut() {
                h.lines.push(DiffLine { kind, old_no: o, new_no: n, text: text.to_string() });
            }
        }
        FileDiffBody::Hunks { hunks }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_run(cwd: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git").arg("-C").arg(cwd).args(args).output().unwrap();
        assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    }

    fn init_repo(dir: &std::path::Path) {
        use std::fs;
        git_run(dir, &["init", "-q"]);
        git_run(dir, &["config", "user.email", "t@t.t"]);
        git_run(dir, &["config", "user.name", "t"]);
        fs::write(dir.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_run(dir, &["add", "."]);
        git_run(dir, &["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn stage_then_unstage_moves_file_between_groups() {
        use std::fs;
        if std::process::Command::new("git").arg("--version").output().is_err() { return; }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        init_repo(dir);
        fs::write(dir.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();

        let after_stage = stage(dir, "tracked.txt").unwrap();
        assert!(after_stage.staged.iter().any(|f| f.path == "tracked.txt"));
        assert!(!after_stage.unstaged.iter().any(|f| f.path == "tracked.txt"));

        let after_unstage = unstage(dir, "tracked.txt").unwrap();
        assert!(after_unstage.unstaged.iter().any(|f| f.path == "tracked.txt"));
        assert!(!after_unstage.staged.iter().any(|f| f.path == "tracked.txt"));
    }

    #[test]
    fn changes_groups_staged_unstaged_untracked() {
        use std::fs;
        if std::process::Command::new("git").arg("--version").output().is_err() { return; }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        init_repo(dir);
        // unstaged edit
        fs::write(dir.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        // staged new file
        fs::write(dir.join("staged.txt"), "hi\n").unwrap();
        git_run(dir, &["add", "staged.txt"]);
        // untracked
        fs::write(dir.join("new.txt"), "fresh\n").unwrap();

        let c = changes(dir).unwrap();
        assert!(c.staged.iter().any(|f| f.path == "staged.txt" && f.status == diff::ChangeStatus::Added));
        assert!(c.unstaged.iter().any(|f| f.path == "tracked.txt" && f.status == diff::ChangeStatus::Modified));
        assert!(c.unstaged.iter().any(|f| f.path == "new.txt" && f.status == diff::ChangeStatus::Untracked));
    }

    #[test]
    fn file_diff_untracked_is_all_additions() {
        use std::fs;
        if std::process::Command::new("git").arg("--version").output().is_err() { return; }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        init_repo(dir);
        fs::write(dir.join("new.txt"), "a\nb\n").unwrap();
        let d = file_diff(dir, "new.txt", false).unwrap();
        let diff::FileDiffBody::Hunks { hunks } = d.body else { panic!("want hunks") };
        let adds = hunks[0].lines.iter().filter(|l| l.kind == diff::LineKind::Add).count();
        assert_eq!(adds, 2);
    }

    #[test]
    fn parse_numstat_text_and_binary() {
        let raw = "3\t1\tsrc/a.rs\n-\t-\tpublic/x.bmp\n";
        let v = diff::parse_numstat(raw);
        assert_eq!(v.len(), 2);
        assert_eq!(v[0], diff::NumStat { added: 3, removed: 1, binary: false, path: "src/a.rs".into() });
        assert_eq!(v[1], diff::NumStat { added: 0, removed: 0, binary: true, path: "public/x.bmp".into() });
    }

    #[test]
    fn parse_unified_diff_classifies_and_numbers_lines() {
        let raw = "\
diff --git a/f.txt b/f.txt
index e69de29..0cfbf08 100644
--- a/f.txt
+++ b/f.txt
@@ -1,2 +1,2 @@
 ctx
-old
+new
";
        let body = diff::parse_unified_diff(raw, 5000);
        let diff::FileDiffBody::Hunks { hunks } = body else { panic!("want hunks") };
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        assert_eq!((h.old_start, h.new_start), (1, 1));
        let kinds: Vec<_> = h.lines.iter().map(|l| l.kind).collect();
        assert_eq!(kinds, vec![diff::LineKind::Context, diff::LineKind::Del, diff::LineKind::Add]);
        // context line carries both numbers; del has only old; add has only new
        assert_eq!((h.lines[0].old_no, h.lines[0].new_no), (Some(1), Some(1)));
        assert_eq!((h.lines[1].old_no, h.lines[1].new_no), (Some(2), None));
        assert_eq!((h.lines[2].old_no, h.lines[2].new_no), (None, Some(2)));
        assert_eq!(h.lines[1].text, "old");
    }

    #[test]
    fn parse_unified_diff_swallows_no_newline_marker() {
        let raw = "@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n";
        let diff::FileDiffBody::Hunks { hunks } = diff::parse_unified_diff(raw, 5000) else { panic!() };
        assert_eq!(hunks[0].lines.len(), 2); // marker is not a diff line
    }

    #[test]
    fn parse_unified_diff_detects_binary() {
        let raw = "diff --git a/x.bmp b/x.bmp\nBinary files a/x.bmp and b/x.bmp differ\n";
        assert!(matches!(diff::parse_unified_diff(raw, 5000), diff::FileDiffBody::Binary { .. }));
    }

    #[test]
    fn parse_unified_diff_caps_large() {
        let mut raw = String::from("@@ -1,9999 +1,9999 @@\n");
        for _ in 0..6000 { raw.push_str("+x\n"); }
        assert!(matches!(diff::parse_unified_diff(&raw, 5000), diff::FileDiffBody::TooLarge { .. }));
    }

    // ---- numstat_dest_path unit tests ----

    #[test]
    fn numstat_dest_path_plain_unchanged() {
        assert_eq!(diff::numstat_dest_path("src/a.rs"), "src/a.rs");
    }

    #[test]
    fn numstat_dest_path_simple_rename() {
        assert_eq!(diff::numstat_dest_path("old.txt => new.txt"), "new.txt");
    }

    #[test]
    fn numstat_dest_path_brace_rename() {
        assert_eq!(diff::numstat_dest_path("src/{a => b}.rs"), "src/b.rs");
    }

    // ---- staged rename surfaces non-zero numstat counts ----

    #[test]
    fn changes_staged_rename_has_nonzero_counts() {
        use std::fs;
        if std::process::Command::new("git").arg("--version").output().is_err() { return; }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        init_repo(dir);
        // Write a file with content, commit it, then rename + edit and stage.
        fs::write(dir.join("original.txt"), "line1\nline2\nline3\n").unwrap();
        git_run(dir, &["add", "original.txt"]);
        git_run(dir, &["commit", "-q", "-m", "add original"]);
        // Rename via git mv and also modify the file.
        git_run(dir, &["mv", "original.txt", "renamed.txt"]);
        fs::write(dir.join("renamed.txt"), "line1\nline2\nline3\nline4\n").unwrap();
        git_run(dir, &["add", "renamed.txt"]);

        let c = changes(dir).unwrap();
        let entry = c.staged.iter().find(|f| f.path == "renamed.txt")
            .expect("renamed.txt should appear in staged");
        assert_eq!(entry.status, diff::ChangeStatus::Renamed);
        // After adding a line the numstat should show at least 1 addition.
        assert!(entry.added > 0, "staged rename should carry added count, got {}", entry.added);
    }

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
