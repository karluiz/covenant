use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;

/// A worktree stops being stale-eligible for this long after its last commit.
pub const STALE_AFTER_DAYS: i64 = 14;

/// Where Covenant puts worktrees. Harness-neutral on purpose: adopting any one
/// executor's default (`.claude/worktrees/`) would make that executor's
/// convention everyone's problem.
pub const CANONICAL_WORKTREE_DIR: &str = ".covenant/worktrees";

/// Derived on every summary, never stored. See the design spec for the
/// precedence rationale.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorktreeState {
    /// Where the user is standing, has uncommitted work, or is recent unmerged work.
    Active,
    /// Unmerged and clean, but untouched for `STALE_AFTER_DAYS`. Needs a human decision.
    Stale,
    /// Merged into the default branch and clean. Provably safe to delete.
    Spent,
    /// Registered in git, gone from disk.
    Orphan,
}

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
    pub state: WorktreeState,
    pub merged: bool,
    pub last_commit_unix: Option<i64>,
    pub off_convention: bool,
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
    let canonical_root = canonical_or_self(&current_root.join(CANONICAL_WORKTREE_DIR));
    let mut worktrees = parse_worktree_list(&git(cwd, &["worktree", "list", "--porcelain"])?);

    // `git worktree list --porcelain` always lists the main worktree first —
    // that is a structural fact about the repository, independent of which
    // worktree `cwd` happens to be in. Use it to identify the main worktree
    // rather than the cwd-relative `current` flag: `current` means "this is
    // where this call was made from", not "this is the main worktree", and
    // the two diverge whenever `repo_summary` is called from a linked
    // worktree (the common case here, since Covenant's own workflow does
    // feature work inside `.covenant/worktrees/<slug>`).
    let main_worktree_root = worktrees
        .first()
        .map(|wt| canonical_or_self(Path::new(&wt.path)));

    let default_branch = default_branch(cwd);
    let merged: std::collections::HashSet<String> = git(
        cwd,
        &["branch", "--merged", &default_branch, "--format=%(refname:short)"],
    )
    .unwrap_or_default()
    .lines()
    .map(|l| l.trim().to_string())
    .filter(|l| !l.is_empty())
    .collect();

    let now_unix = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    for wt in &mut worktrees {
        let wt_path = Path::new(&wt.path);
        let path_exists = wt_path.is_dir();
        let wt_canonical = canonical_or_self(wt_path);
        wt.current = wt_canonical == current_root;
        let is_main_worktree = main_worktree_root.as_ref() == Some(&wt_canonical);
        wt.off_convention =
            !is_main_worktree && !wt.bare && !wt_canonical.starts_with(&canonical_root);
        wt.dirty_count = if path_exists {
            status_count(wt_path).unwrap_or(0)
        } else {
            0
        };
        wt.merged = wt
            .branch
            .as_ref()
            .is_some_and(|b| merged.contains(b) && *b != default_branch);
        wt.last_commit_unix = wt.branch.as_ref().and_then(|b| {
            git(cwd, &["log", "-1", "--format=%ct", b])
                .ok()
                .and_then(|s| s.trim().parse::<i64>().ok())
        });
        wt.state = derive_state(
            path_exists,
            wt.current,
            wt.dirty_count,
            wt.merged,
            wt.last_commit_unix,
            now_unix,
        );
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
                state: WorktreeState::Active,
                merged: false,
                last_commit_unix: None,
                off_convention: false,
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

/// Resolves the repo's default branch: origin's HEAD (verified to still exist
/// locally), else `main`, else `master`, else whatever branch is currently
/// checked out, else `main`.
fn default_branch(cwd: &Path) -> String {
    let resolves_locally =
        |name: &str| git(cwd, &["rev-parse", "--verify", "--quiet", name]).is_ok();

    if let Ok(sym) = git(cwd, &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]) {
        if let Some(name) = sym.trim().rsplit('/').next() {
            // origin/HEAD can go stale after a remote default-branch rename;
            // never trust it without confirming the branch still resolves.
            if !name.is_empty() && resolves_locally(name) {
                return name.to_string();
            }
        }
    }
    for candidate in ["main", "master"] {
        if resolves_locally(candidate) {
            return candidate.to_string();
        }
    }
    if let Ok(current) = git(cwd, &["branch", "--show-current"]) {
        let current = current.trim();
        if !current.is_empty() && resolves_locally(current) {
            return current.to_string();
        }
    }
    "main".to_string()
}

/// Precedence: Orphan -> Active -> Spent -> Stale, defaulting to Active.
/// Defaulting to Active is deliberate: anything we cannot classify must never
/// be proposed for deletion.
fn derive_state(
    path_exists: bool,
    current: bool,
    dirty_count: u32,
    merged: bool,
    last_commit_unix: Option<i64>,
    now_unix: i64,
) -> WorktreeState {
    if !path_exists {
        return WorktreeState::Orphan;
    }
    if current || dirty_count > 0 {
        return WorktreeState::Active;
    }
    if merged {
        return WorktreeState::Spent;
    }
    match last_commit_unix {
        Some(ts) if now_unix - ts > STALE_AFTER_DAYS * 86_400 => WorktreeState::Stale,
        _ => WorktreeState::Active,
    }
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

/// Directory name for a worktree of `branch`, under `CANONICAL_WORKTREE_DIR`.
pub fn worktree_slug(branch: &str) -> String {
    let stripped = ["feature/", "feat/", "fix/", "chore/", "worktree-"]
        .iter()
        .find_map(|p| branch.strip_prefix(p))
        .unwrap_or(branch);
    stripped.replace('/', "-")
}

/// Disk usage in KB per path. Missing paths are omitted. Slow — call off the
/// summary path, never inside `repo_summary`.
pub fn worktree_sizes(paths: Vec<String>) -> Vec<(String, u64)> {
    paths
        .into_iter()
        .filter(|p| Path::new(p).is_dir())
        .filter_map(|p| {
            // BSD `du -sk` can print a valid summary line to stdout while
            // still exiting non-zero (e.g. a permission-denied subdirectory
            // inside the worktree). Parse stdout regardless of exit status —
            // only omit the path when no number can be parsed out of it.
            // Per-path isolation: `filter_map` means one path's du failure
            // never affects the others.
            let out = Command::new("du").args(["-sk", &p]).output().ok()?;
            let text = String::from_utf8_lossy(&out.stdout);
            let kb = text.split_whitespace().next()?.parse::<u64>().ok()?;
            Some((p, kb))
        })
        .collect()
}

const MAX_DIFF_LINES: usize = 5000;

pub fn changes(cwd: &Path) -> Result<diff::Changes, String> {
    use diff::{ChangeStatus, FileChange};
    use std::collections::HashMap;

    let parse_side = |args: &[&str]| -> Result<HashMap<String, diff::NumStat>, String> {
        let raw = git(cwd, args)?;
        Ok(diff::parse_numstat(&raw)
            .into_iter()
            .map(|n| (n.path.clone(), n))
            .collect())
    };
    let unstaged_ns = parse_side(&["diff", "--numstat"])?;
    let staged_ns = parse_side(&["diff", "--cached", "--numstat"])?;

    // porcelain gives reliable status letters + rename old->new + untracked.
    let porcelain = git(cwd, &["status", "--porcelain"])?;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    for line in porcelain.lines() {
        if line.len() < 3 {
            continue;
        }
        let x = line.as_bytes()[0] as char; // staged (index) status
        let y = line.as_bytes()[1] as char; // worktree status
        let rest = &line[3..];
        let (old_path, path) = match rest.split_once(" -> ") {
            Some((o, n)) => (Some(o.to_string()), n.to_string()),
            None => (None, rest.to_string()),
        };
        if x == '?' && y == '?' {
            unstaged.push(FileChange {
                path,
                old_path: None,
                status: ChangeStatus::Untracked,
                added: 0,
                removed: 0,
                binary: false,
            });
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
                path: path.clone(),
                old_path: old_path.clone(),
                status,
                added: ns.map(|n| n.added).unwrap_or(0),
                removed: ns.map(|n| n.removed).unwrap_or(0),
                binary: ns.map(|n| n.binary).unwrap_or(false),
            });
        }
        if let Some(status) = map_status(y) {
            let ns = unstaged_ns.get(&path);
            unstaged.push(FileChange {
                path: path.clone(),
                old_path,
                status,
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

/// Apply a patch to the index only (optionally reversed), fed via stdin.
fn apply_cached(cwd: &Path, patch: &str, reverse: bool) -> Result<(), String> {
    use std::io::Write as _;
    use std::process::Stdio;
    let mut args = vec!["apply", "--cached", "--whitespace=nowarn"];
    if reverse {
        args.push("--reverse");
    }
    let mut child = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git failed to start: {e}"))?;
    child
        .stdin
        .take()
        .ok_or("git apply stdin unavailable")?
        .write_all(patch.as_bytes())
        .map_err(|e| format!("git apply stdin: {e}"))?;
    let out = child
        .wait_with_output()
        .map_err(|e| format!("git apply: {e}"))?;
    if !out.status.success() {
        return Err(command_error("git apply", &out));
    }
    Ok(())
}

/// Stage a single hunk of a tracked file's working diff. `hunk_index` matches
/// the hunk order `file_diff(_, _, staged=false)` returned for the same file.
pub fn stage_hunk(cwd: &Path, path: &str, hunk_index: usize) -> Result<diff::Changes, String> {
    let raw = git(cwd, &["diff", "--", path])?;
    let patch = diff::select_hunk_patch(&raw, hunk_index)
        .ok_or_else(|| format!("hunk {hunk_index} not found in diff of {path}"))?;
    apply_cached(cwd, &patch, false)?;
    changes(cwd)
}

/// Unstage a single hunk of a staged file (reverse-apply on the index).
pub fn unstage_hunk(cwd: &Path, path: &str, hunk_index: usize) -> Result<diff::Changes, String> {
    let raw = git(cwd, &["diff", "--cached", "--", path])?;
    let patch = diff::select_hunk_patch(&raw, hunk_index)
        .ok_or_else(|| format!("hunk {hunk_index} not found in staged diff of {path}"))?;
    apply_cached(cwd, &patch, true)?;
    changes(cwd)
}

pub fn commit(cwd: &Path, message: &str, push: bool) -> Result<diff::Changes, String> {
    let msg = message.trim();
    if msg.is_empty() {
        return Err("commit message is empty".into());
    }
    // Nothing staged → "commit all": stage every change (incl. untracked). When the
    // user has staged specific files, honour that and commit only those.
    if git(cwd, &["diff", "--cached", "--name-only"])?.trim().is_empty() {
        git(cwd, &["add", "-A"])?;
    }
    git(cwd, &["commit", "-m", msg])?;
    if push {
        git(cwd, &["push"])?;
    }
    changes(cwd)
}

/// Diff fed to the LLM for message generation: staged changes if any are staged,
/// otherwise the full working diff so Summarize works before manual staging.
pub fn staged_diff(cwd: &Path) -> Result<String, String> {
    let staged = git(cwd, &["diff", "--cached"])?;
    if !staged.trim().is_empty() {
        return Ok(staged);
    }
    // Untracked files aren't shown by `git diff`; include them via intent-to-add.
    git(cwd, &["add", "-AN"])?;
    let working = git(cwd, &["diff"]);
    let _ = git(cwd, &["reset", "-q"]); // undo intent-to-add, leave the index as it was
    working
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
            let out = Command::new("git")
                .arg("-C")
                .arg(cwd)
                .args(["diff", "--no-index", "--", "/dev/null", path])
                .output()
                .map_err(|e| format!("git failed to start: {e}"))?;
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
    pub enum LineKind {
        Context,
        Add,
        Del,
    }

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
    pub enum ChangeStatus {
        Modified,
        Added,
        Deleted,
        Renamed,
        Untracked,
    }

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
    pub struct Changes {
        pub staged: Vec<FileChange>,
        pub unstaged: Vec<FileChange>,
    }

    #[derive(Debug, Clone, PartialEq, Eq, Serialize)]
    #[serde(rename_all = "camelCase")]
    pub struct FileDiff {
        pub path: String,
        pub old_path: Option<String>,
        pub body: FileDiffBody,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct NumStat {
        pub added: u32,
        pub removed: u32,
        pub binary: bool,
        pub path: String,
    }

    /// git `--numstat` encodes renames as `old => new` or `pre{old => new}post`.
    /// Reduce to the destination path so it matches `git status --porcelain` paths.
    pub fn numstat_dest_path(raw: &str) -> String {
        let Some(arrow) = raw.find(" => ") else {
            return raw.to_string();
        };
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
        raw.lines()
            .filter_map(|line| {
                let mut p = line.splitn(3, '\t');
                let a = p.next()?;
                let r = p.next()?;
                let path = p.next()?;
                if path.is_empty() {
                    return None;
                }
                let binary = a == "-" || r == "-";
                Some(NumStat {
                    added: a.parse().unwrap_or(0),
                    removed: r.parse().unwrap_or(0),
                    binary,
                    path: numstat_dest_path(path),
                })
            })
            .collect()
    }

    /// Pure: parse `git diff` text for ONE file into a renderable body.
    pub fn parse_unified_diff(raw: &str, max_lines: usize) -> FileDiffBody {
        if raw
            .lines()
            .any(|l| l.starts_with("Binary files") && l.ends_with("differ"))
        {
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
                    if let Some(v) = tok.strip_prefix('-') {
                        os = v.split(',').next().unwrap_or("1").parse().unwrap_or(1);
                    }
                    if let Some(v) = tok.strip_prefix('+') {
                        ns = v.split(',').next().unwrap_or("1").parse().unwrap_or(1);
                    }
                }
                old_no = os;
                new_no = ns;
                hunks.push(Hunk {
                    old_start: os,
                    new_start: ns,
                    header,
                    lines: Vec::new(),
                });
                continue;
            }
            if hunks.is_empty() {
                continue;
            } // file headers before first hunk
            if line.starts_with("\\ No newline") {
                continue;
            }
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
                return FileDiffBody::TooLarge {
                    line_count: total_lines as u32,
                };
            }
            let (o, n) = match kind {
                LineKind::Context => {
                    let p = (Some(old_no), Some(new_no));
                    old_no += 1;
                    new_no += 1;
                    p
                }
                LineKind::Add => {
                    let p = (None, Some(new_no));
                    new_no += 1;
                    p
                }
                LineKind::Del => {
                    let p = (Some(old_no), None);
                    old_no += 1;
                    p
                }
            };
            if let Some(h) = hunks.last_mut() {
                h.lines.push(DiffLine {
                    kind,
                    old_no: o,
                    new_no: n,
                    text: text.to_string(),
                });
            }
        }
        FileDiffBody::Hunks { hunks }
    }

    /// Extract the file header plus the Nth hunk of a raw unified diff as a
    /// standalone patch `git apply` accepts. Raw passthrough — parsed lines are
    /// never re-rendered, so exact bytes and `\ No newline` markers survive.
    pub fn select_hunk_patch(raw: &str, index: usize) -> Option<String> {
        let mut header = String::new();
        let mut hunks: Vec<String> = Vec::new();
        for line in raw.split_inclusive('\n') {
            if line.starts_with("@@") {
                hunks.push(String::new());
            }
            match hunks.last_mut() {
                Some(h) => h.push_str(line),
                None => header.push_str(line),
            }
        }
        let hunk = hunks.get(index)?;
        let mut patch = format!("{header}{hunk}");
        if !patch.ends_with('\n') {
            patch.push('\n');
        }
        Some(patch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_run(cwd: &std::path::Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .unwrap();
        assert!(
            out.status.success(),
            "git {:?}: {}",
            args,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn init_repo(dir: &std::path::Path) {
        use std::fs;
        // Pin the initial branch name so tests don't inherit the machine's
        // `init.defaultBranch` config (git >= 2.28 supports `-b`).
        git_run(dir, &["init", "-q", "-b", "main"]);
        git_run(dir, &["config", "user.email", "t@t.t"]);
        git_run(dir, &["config", "user.name", "t"]);
        fs::write(dir.join("tracked.txt"), "one\ntwo\n").unwrap();
        git_run(dir, &["add", "."]);
        git_run(dir, &["commit", "-q", "-m", "init"]);
    }

    #[test]
    fn stage_then_unstage_moves_file_between_groups() {
        use std::fs;
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        init_repo(dir);
        fs::write(dir.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();

        let after_stage = stage(dir, "tracked.txt").unwrap();
        assert!(after_stage.staged.iter().any(|f| f.path == "tracked.txt"));
        assert!(!after_stage.unstaged.iter().any(|f| f.path == "tracked.txt"));

        let after_unstage = unstage(dir, "tracked.txt").unwrap();
        assert!(after_unstage
            .unstaged
            .iter()
            .any(|f| f.path == "tracked.txt"));
        assert!(!after_unstage.staged.iter().any(|f| f.path == "tracked.txt"));
    }

    #[test]
    fn select_hunk_patch_extracts_header_plus_one_hunk() {
        let raw = "diff --git a/f.txt b/f.txt\nindex 111..222 100644\n--- a/f.txt\n+++ b/f.txt\n\
@@ -1,2 +1,2 @@\n-one\n+ONE\n two\n\
@@ -9,2 +9,3 @@\n nine\n+nine-and-a-half\n ten\n\\ No newline at end of file\n";
        let p0 = diff::select_hunk_patch(raw, 0).unwrap();
        assert!(p0.starts_with("diff --git a/f.txt b/f.txt\n"));
        assert!(p0.contains("@@ -1,2 +1,2 @@"));
        assert!(!p0.contains("@@ -9,2 +9,3 @@"));

        let p1 = diff::select_hunk_patch(raw, 1).unwrap();
        assert!(p1.contains("@@ -9,2 +9,3 @@"));
        assert!(!p1.contains("@@ -1,2 +1,2 @@"));
        // The no-newline marker stays attached to its hunk.
        assert!(p1.ends_with("\\ No newline at end of file\n"));

        assert!(diff::select_hunk_patch(raw, 2).is_none());
        assert!(diff::select_hunk_patch("", 0).is_none());
    }

    #[test]
    fn stage_hunk_splits_file_across_groups_and_reverses() {
        use std::fs;
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        // A file long enough that two edits produce two separate hunks.
        let base: String = (1..=30).map(|i| format!("line{i}\n")).collect();
        git_run(dir, &["init", "-q"]);
        git_run(dir, &["config", "user.email", "t@t.t"]);
        git_run(dir, &["config", "user.name", "t"]);
        fs::write(dir.join("long.txt"), &base).unwrap();
        git_run(dir, &["add", "."]);
        git_run(dir, &["commit", "-q", "-m", "init"]);

        let edited = base
            .replace("line2\n", "LINE2\n")
            .replace("line28\n", "LINE28\n");
        fs::write(dir.join("long.txt"), edited).unwrap();

        // Two hunks in the working diff; stage only the first.
        let after = stage_hunk(dir, "long.txt", 0).unwrap();
        assert!(after.staged.iter().any(|f| f.path == "long.txt"));
        assert!(after.unstaged.iter().any(|f| f.path == "long.txt"));

        // The staged side holds exactly the first edit.
        let cached = git(dir, &["diff", "--cached", "--", "long.txt"]).unwrap();
        assert!(cached.contains("+LINE2"));
        assert!(!cached.contains("+LINE28"));

        // Reverse it: nothing staged again, both edits back in the working tree.
        let reverted = unstage_hunk(dir, "long.txt", 0).unwrap();
        assert!(!reverted.staged.iter().any(|f| f.path == "long.txt"));
        assert!(reverted.unstaged.iter().any(|f| f.path == "long.txt"));

        // Out-of-range hunk is a clean error.
        assert!(stage_hunk(dir, "long.txt", 9).is_err());
    }

    #[test]
    fn commit_clears_staged_and_rejects_empty_message() {
        use std::fs;
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        init_repo(dir);
        fs::write(dir.join("tracked.txt"), "one\ntwo\nthree\n").unwrap();
        stage(dir, "tracked.txt").unwrap();

        assert!(!staged_diff(dir).unwrap().trim().is_empty());
        assert!(commit(dir, "   ", false).is_err());

        let after = commit(dir, "feat: third line", false).unwrap();
        assert!(after.staged.is_empty());
        assert!(staged_diff(dir).unwrap().trim().is_empty());
    }

    #[test]
    fn changes_groups_staged_unstaged_untracked() {
        use std::fs;
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
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
        assert!(c
            .staged
            .iter()
            .any(|f| f.path == "staged.txt" && f.status == diff::ChangeStatus::Added));
        assert!(c
            .unstaged
            .iter()
            .any(|f| f.path == "tracked.txt" && f.status == diff::ChangeStatus::Modified));
        assert!(c
            .unstaged
            .iter()
            .any(|f| f.path == "new.txt" && f.status == diff::ChangeStatus::Untracked));
    }

    #[test]
    fn file_diff_untracked_is_all_additions() {
        use std::fs;
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        init_repo(dir);
        fs::write(dir.join("new.txt"), "a\nb\n").unwrap();
        let d = file_diff(dir, "new.txt", false).unwrap();
        let diff::FileDiffBody::Hunks { hunks } = d.body else {
            panic!("want hunks")
        };
        let adds = hunks[0]
            .lines
            .iter()
            .filter(|l| l.kind == diff::LineKind::Add)
            .count();
        assert_eq!(adds, 2);
    }

    #[test]
    fn parse_numstat_text_and_binary() {
        let raw = "3\t1\tsrc/a.rs\n-\t-\tpublic/x.bmp\n";
        let v = diff::parse_numstat(raw);
        assert_eq!(v.len(), 2);
        assert_eq!(
            v[0],
            diff::NumStat {
                added: 3,
                removed: 1,
                binary: false,
                path: "src/a.rs".into()
            }
        );
        assert_eq!(
            v[1],
            diff::NumStat {
                added: 0,
                removed: 0,
                binary: true,
                path: "public/x.bmp".into()
            }
        );
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
        let diff::FileDiffBody::Hunks { hunks } = body else {
            panic!("want hunks")
        };
        assert_eq!(hunks.len(), 1);
        let h = &hunks[0];
        assert_eq!((h.old_start, h.new_start), (1, 1));
        let kinds: Vec<_> = h.lines.iter().map(|l| l.kind).collect();
        assert_eq!(
            kinds,
            vec![
                diff::LineKind::Context,
                diff::LineKind::Del,
                diff::LineKind::Add
            ]
        );
        // context line carries both numbers; del has only old; add has only new
        assert_eq!((h.lines[0].old_no, h.lines[0].new_no), (Some(1), Some(1)));
        assert_eq!((h.lines[1].old_no, h.lines[1].new_no), (Some(2), None));
        assert_eq!((h.lines[2].old_no, h.lines[2].new_no), (None, Some(2)));
        assert_eq!(h.lines[1].text, "old");
    }

    #[test]
    fn parse_unified_diff_swallows_no_newline_marker() {
        let raw = "@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n";
        let diff::FileDiffBody::Hunks { hunks } = diff::parse_unified_diff(raw, 5000) else {
            panic!()
        };
        assert_eq!(hunks[0].lines.len(), 2); // marker is not a diff line
    }

    #[test]
    fn parse_unified_diff_detects_binary() {
        let raw = "diff --git a/x.bmp b/x.bmp\nBinary files a/x.bmp and b/x.bmp differ\n";
        assert!(matches!(
            diff::parse_unified_diff(raw, 5000),
            diff::FileDiffBody::Binary { .. }
        ));
    }

    #[test]
    fn parse_unified_diff_caps_large() {
        let mut raw = String::from("@@ -1,9999 +1,9999 @@\n");
        for _ in 0..6000 {
            raw.push_str("+x\n");
        }
        assert!(matches!(
            diff::parse_unified_diff(&raw, 5000),
            diff::FileDiffBody::TooLarge { .. }
        ));
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
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
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
        let entry = c
            .staged
            .iter()
            .find(|f| f.path == "renamed.txt")
            .expect("renamed.txt should appear in staged");
        assert_eq!(entry.status, diff::ChangeStatus::Renamed);
        // After adding a line the numstat should show at least 1 addition.
        assert!(
            entry.added > 0,
            "staged rename should carry added count, got {}",
            entry.added
        );
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

    const DAY: i64 = 86_400;

    #[test]
    fn orphan_wins_over_everything() {
        // Path gone from disk: nothing else matters.
        let s = derive_state(
            /* path_exists */ false,
            /* current */ false,
            /* dirty */ 3,
            /* merged */ true,
            /* last_commit */ Some(0),
            /* now */ 100 * DAY,
        );
        assert_eq!(s, WorktreeState::Orphan);
    }

    #[test]
    fn the_current_worktree_is_always_active() {
        // Merged and clean, but it is where the user is standing.
        let s = derive_state(true, true, 0, true, Some(100 * DAY), 100 * DAY);
        assert_eq!(s, WorktreeState::Active);
    }

    #[test]
    fn dirty_beats_merged() {
        // Merged but with uncommitted work: never propose deleting this.
        let s = derive_state(true, false, 1, true, Some(100 * DAY), 100 * DAY);
        assert_eq!(s, WorktreeState::Active);
    }

    #[test]
    fn merged_and_clean_is_spent() {
        let s = derive_state(true, false, 0, true, Some(100 * DAY), 100 * DAY);
        assert_eq!(s, WorktreeState::Spent);
    }

    #[test]
    fn unmerged_clean_and_old_is_stale() {
        let now = 100 * DAY;
        let s = derive_state(true, false, 0, false, Some(now - 15 * DAY), now);
        assert_eq!(s, WorktreeState::Stale);
    }

    #[test]
    fn unmerged_clean_and_recent_is_active() {
        let now = 100 * DAY;
        let s = derive_state(true, false, 0, false, Some(now - 13 * DAY), now);
        assert_eq!(s, WorktreeState::Active);
    }

    #[test]
    fn stale_boundary_is_exclusive_at_fourteen_days() {
        let now = 100 * DAY;
        // Exactly 14 days is not yet stale.
        assert_eq!(
            derive_state(true, false, 0, false, Some(now - 14 * DAY), now),
            WorktreeState::Active
        );
        assert_eq!(
            derive_state(true, false, 0, false, Some(now - 14 * DAY - 1), now),
            WorktreeState::Stale
        );
    }

    #[test]
    fn unknown_commit_date_defaults_to_active() {
        // Unclassifiable must never be deletable.
        let s = derive_state(true, false, 0, false, None, 100 * DAY);
        assert_eq!(s, WorktreeState::Active);
    }

    #[test]
    fn default_branch_falls_through_stale_origin_head() {
        if std::process::Command::new("git")
            .arg("--version")
            .output()
            .is_err()
        {
            return;
        }
        let tmp = tempfile::TempDir::new().unwrap();
        let dir = tmp.path();
        init_repo(dir); // creates local branch "main"

        // Simulate a stale origin/HEAD: the symref points at a branch name
        // that does not (or no longer) exists locally, e.g. after the
        // remote's default branch was renamed and origin/HEAD never resynced.
        // `symbolic-ref` doesn't validate the target, so this is enough to
        // reproduce a dangling origin/HEAD without a real remote.
        git_run(
            dir,
            &[
                "symbolic-ref",
                "refs/remotes/origin/HEAD",
                "refs/remotes/origin/gone",
            ],
        );

        let resolved = default_branch(dir);
        assert_ne!(resolved, "gone", "must not trust a dangling origin/HEAD");
        assert!(
            git_run_ok(dir, &["rev-parse", "--verify", "--quiet", &resolved]),
            "default_branch must resolve to a branch that actually exists, got {resolved:?}"
        );
    }

    fn git_run_ok(cwd: &std::path::Path, args: &[&str]) -> bool {
        std::process::Command::new("git")
            .arg("-C")
            .arg(cwd)
            .args(args)
            .output()
            .map(|out| out.status.success())
            .unwrap_or(false)
    }

    #[test]
    fn repo_summary_marks_a_merged_worktree_spent() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let base = String::from_utf8(
            std::process::Command::new("git")
                .arg("-C").arg(root)
                .args(["branch", "--show-current"])
                .output().unwrap().stdout,
        ).unwrap().trim().to_string();

        let wt = root.join("wt-merged");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "done"]);
        std::fs::write(wt.join("tracked.txt"), "changed\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "work"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "merge", "done"]);

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter()
            .find(|w| w.branch.as_deref() == Some("done"))
            .expect("worktree present");
        assert!(row.merged, "branch was merged into {base}");
        assert_eq!(row.state, WorktreeState::Spent);
        assert!(row.last_commit_unix.is_some());
    }

    #[test]
    fn worktrees_under_the_canonical_root_are_on_convention() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join(CANONICAL_WORKTREE_DIR).join("feature-x");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feature-x"]);

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter()
            .find(|w| w.branch.as_deref() == Some("feature-x")).unwrap();
        assert!(!row.off_convention);
    }

    #[test]
    fn worktrees_outside_the_canonical_root_are_flagged() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("somewhere-else");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "stray"]);

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter()
            .find(|w| w.branch.as_deref() == Some("stray")).unwrap();
        assert!(row.off_convention);
    }

    #[test]
    fn the_main_worktree_is_never_off_convention() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let summary = repo_summary(root).unwrap();
        let main_row = summary.worktrees.iter().find(|w| w.current).unwrap();
        assert!(!main_row.off_convention);
    }

    #[test]
    fn main_worktree_is_not_off_convention_when_called_from_a_linked_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join(CANONICAL_WORKTREE_DIR).join("feature-x");
        git_run(
            root,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feature-x"],
        );

        // Call repo_summary with the LINKED worktree's path as cwd — this is
        // the common case, since Covenant's own workflow does feature work
        // inside .covenant/worktrees/<slug>, not the main checkout.
        let summary = repo_summary(&wt).unwrap();

        let root_canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let main_row = summary
            .worktrees
            .iter()
            .find(|w| {
                std::path::Path::new(&w.path)
                    .canonicalize()
                    .unwrap_or_else(|_| std::path::PathBuf::from(&w.path))
                    == root_canonical
            })
            .expect("main worktree should be present in the summary");

        // Sanity check: this call was made FROM the linked worktree, so the
        // main worktree's `current` flag must be false. If this assertion
        // ever fails, the test stopped reproducing the bug scenario.
        assert!(
            !main_row.current,
            "sanity: cwd was the linked worktree, so the main worktree must not be `current`"
        );
        assert!(
            !main_row.off_convention,
            "the main worktree must never be off_convention, regardless of which worktree cwd is"
        );
    }

    #[test]
    fn slug_strips_branch_prefixes() {
        assert_eq!(worktree_slug("feat/canon-org-rename"), "canon-org-rename");
        assert_eq!(worktree_slug("feature/big-thing"), "big-thing");
        assert_eq!(worktree_slug("fix/notch-focus-gate"), "notch-focus-gate");
        assert_eq!(worktree_slug("chore/deps"), "deps");
        assert_eq!(worktree_slug("worktree-somnus-v2"), "somnus-v2");
        assert_eq!(worktree_slug("plain"), "plain");
        // Nested paths flatten rather than creating directories.
        assert_eq!(worktree_slug("feat/a/b"), "a-b");
    }

    #[test]
    fn sizes_are_reported_for_existing_paths_only() {
        let tmp = tempfile::TempDir::new().unwrap();
        let real = tmp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("f"), vec![0u8; 4096]).unwrap();
        let gone = tmp.path().join("gone").to_string_lossy().to_string();

        let out = worktree_sizes(vec![real.to_string_lossy().to_string(), gone]);
        assert_eq!(out.len(), 1, "missing paths are omitted, not zeroed");
        assert!(out[0].1 > 0);
    }
}
