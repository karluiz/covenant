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
    /// True for exactly one row: the worktree `git worktree list --porcelain`
    /// lists first. NOT the same as `current` (see the module-level note on
    /// that field) — this is what the frontend needs to tell "this is the
    /// repo's main worktree" apart from "this happens to be where the call
    /// came from", e.g. to withhold Reclaim on the main worktree when the
    /// popover is opened from a linked one.
    pub is_main: bool,
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
    /// The repo's default branch (`main`/`master`/whatever `origin/HEAD`
    /// resolves to) — NOT `current_branch`, which is `git branch
    /// --show-current` against the CALLING cwd. `merged`/reclaim eligibility
    /// is computed against this, so any copy that tells the user "this is
    /// already merged into X" must say this, not `current_branch`.
    pub default_branch: String,
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

    // The canonical worktree root is likewise always rooted at the MAIN
    // worktree, never at `current_root` (the calling `cwd`'s own toplevel).
    // Basing it on `current_root` made every linked worktree compute its
    // own, wrong, `.covenant/worktrees` root relative to itself — so a
    // correctly-placed linked worktree reported `off_convention = true`
    // when queried from its own cwd, and `relocate_worktree` (which derives
    // its destination the same way, see below) would nest a relocated
    // worktree inside whichever worktree the caller happened to be standing
    // in. Fall back to `current_root` only if `worktree list` somehow
    // returned nothing.
    let canonical_root = canonical_or_self(
        &main_worktree_root
            .clone()
            .unwrap_or_else(|| current_root.clone())
            .join(CANONICAL_WORKTREE_DIR),
    );

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
        wt.is_main = is_main_worktree;
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
        default_branch,
    })
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReclaimOutcome {
    pub path: String,
    pub removed: bool,
    /// Present when `removed` is false. Shown to the user verbatim.
    pub reason: Option<String>,
}

/// Removes worktrees that this function itself classifies as `Spent` or
/// `Orphan`. Refuses everything else.
///
/// The caller's classification is deliberately ignored: state is re-derived
/// here so a stale UI, or a direct IPC call, cannot delete live work.
///
/// `Spent` and `Orphan` get deliberately different treatment:
///   - `Spent` (merged + clean): removes the checkout AND deletes the
///     branch, ancestry-verified against the default branch (see the
///     `Spent` arm below for why plain `git branch -d` isn't safe here).
///   - `Orphan` (path already gone from disk): there is nothing on disk to
///     lose, so dropping git's stale admin record is safe — but the branch
///     is left untouched. An orphaned worktree's branch may be the only
///     remaining copy of unmerged work, and there is no working tree left
///     to run the merge re-check against anyway.
pub fn reclaim_worktrees(
    cwd: &Path,
    paths: Vec<String>,
) -> Result<Vec<ReclaimOutcome>, String> {
    let summary = repo_summary(cwd)?;
    // Every git call in the `Spent` arm below runs from the MAIN worktree,
    // never from `cwd`. `retire_worktree` hit and fixed the identical bug:
    // `git branch -d` checks merge status against the invoking repository's
    // CURRENT HEAD, not the default branch this function already verified
    // the branch is merged into — and `cwd` is routinely a linked worktree
    // (Covenant's own workflow calls this from inside
    // `.covenant/worktrees/<slug>`) sitting on an arbitrary branch. Reuse
    // the same `is_main` marker `repo_summary` already computes rather than
    // inventing a second mechanism.
    let main_root = summary
        .worktrees
        .iter()
        .find(|w| w.is_main)
        .map(|w| PathBuf::from(&w.path));
    let mut outcomes = Vec::with_capacity(paths.len());

    for path in paths {
        let target = canonical_or_self(Path::new(&path));
        let Some(wt) = summary
            .worktrees
            .iter()
            .find(|w| canonical_or_self(Path::new(&w.path)) == target)
        else {
            outcomes.push(ReclaimOutcome {
                path,
                removed: false,
                reason: Some("unknown worktree".into()),
            });
            continue;
        };

        match wt.state {
            WorktreeState::Spent => {
                let Some(main) = main_root.as_deref() else {
                    outcomes.push(ReclaimOutcome {
                        path,
                        removed: false,
                        reason: Some("no worktrees reported by git".into()),
                    });
                    continue;
                };
                let base = default_branch(main);

                // `repo_summary` snapshotted merge status once, at the top
                // of this call. `git worktree remove` re-validates
                // cleanliness on its own (it refuses a dirty tree), which
                // closes half of the TOCTOU gap, but it has no opinion on
                // merge status. So re-verify, right here, immediately
                // before deleting: if the branch picked up a new unmerged
                // commit since the snapshot (tree still clean, so the
                // dirty-check alone wouldn't catch it), refuse instead of
                // deleting the checkout out from under it.
                if let Some(branch) = &wt.branch {
                    if !branch_is_merged_into(main, branch, &base) {
                        outcomes.push(ReclaimOutcome {
                            path,
                            removed: false,
                            reason: Some(format!(
                                "branch \"{branch}\" is no longer confirmed merged into \"{base}\"; \
                                 left the checkout in place rather than risk deleting unmerged work"
                            )),
                        });
                        continue;
                    }
                }

                if let Err(e) = git(main, &["worktree", "remove", &wt.path]) {
                    outcomes.push(ReclaimOutcome { path, removed: false, reason: Some(e) });
                    continue;
                }
                // `-d`'s refusal is HEAD-relative — it checks merge status
                // against `main`'s CURRENT HEAD, not against `base` — so it
                // is not a meaningful safety signal here: the invoking
                // repo's main checkout is usually sitting on some other
                // feature branch, which this branch (already proved merged
                // into `base` above) may not be an ancestor of. Try `-d`
                // first (cheap, and correct whenever HEAD happens to be
                // `base`-compatible); if it refuses, fall back to an
                // explicit ancestry check against the SAME `base` the
                // re-verify above already confirmed this branch merges
                // into. Only a passing ancestry check may fall back to
                // `-D`; if it does not pass, the branch is left alone under
                // all circumstances. Failure here is non-fatal either way:
                // the directory is already gone and the lifecycle ledger
                // will surface a stray branch.
                if let Some(branch) = &wt.branch {
                    if git(main, &["branch", "-d", branch]).is_err() {
                        let is_ancestor =
                            git(main, &["merge-base", "--is-ancestor", branch, &base]).is_ok();
                        if is_ancestor {
                            let _ = git(main, &["branch", "-D", branch]);
                        }
                    }
                }
                outcomes.push(ReclaimOutcome { path, removed: true, reason: None });
            }

            WorktreeState::Orphan => {
                // The directory is already gone from disk. `git worktree
                // remove` handles that gracefully on its own — with nothing
                // left to check for dirtiness, it just drops the admin
                // entry, no `--force` needed (verified empirically: a plain
                // `git worktree remove <gone-path>` succeeds and prunes the
                // record). Composes fine with the unconditional `git
                // worktree prune` below, which is now a no-op for this
                // entry. NEVER touch the branch here — no merge re-check
                // either, since there is no working tree left to check
                // anything against. Runs from the main worktree for the same
                // reason the `Spent` arm above does — one cwd doctrine for
                // every git call this function makes, even though an admin
                // record drop and a repo-wide prune don't actually depend on
                // which worktree invokes them.
                let main = main_root.as_deref().unwrap_or(cwd);
                if let Err(e) = git(main, &["worktree", "remove", &wt.path]) {
                    outcomes.push(ReclaimOutcome { path, removed: false, reason: Some(e) });
                    continue;
                }
                outcomes.push(ReclaimOutcome { path, removed: true, reason: None });
            }

            other => {
                outcomes.push(ReclaimOutcome {
                    path,
                    removed: false,
                    reason: Some(format!("not spent or orphan (state: {other:?})").to_lowercase()),
                });
            }
        }
    }

    let _ = git(main_root.as_deref().unwrap_or(cwd), &["worktree", "prune"]);
    Ok(outcomes)
}

/// Creates a worktree for `slug` under the canonical root and returns its path.
///
/// `base` defaults to `origin/<default branch>` when that ref resolves,
/// falling back to the local default branch otherwise — an agent should
/// start from shared main, not from the half-finished state of whatever
/// branch the caller happens to be standing on, nor from a local `main` that
/// may itself be behind `origin/main`. See `preferred_base` for why this
/// preference lives here rather than inside `default_branch` itself.
///
/// The canonical root is anchored to the MAIN worktree, never to `cwd`:
/// `repo_summary` is normally called with a linked worktree's cwd (Covenant
/// does feature work inside `.covenant/worktrees/<slug>`), and anchoring to the
/// caller nests new worktrees inside sibling ones.
pub fn create_worktree(cwd: &Path, slug: &str, base: Option<&str>) -> Result<String, String> {
    if slug.trim().is_empty() {
        return Err("empty worktree slug".into());
    }
    let summary = repo_summary(cwd)?;
    // Identify the main worktree via `is_main` — the single mechanism
    // `retire_worktree` and `reclaim_worktrees` already use, rather than a
    // second, merely-equivalent-today spelling (`.first()`).
    let main_root = summary
        .worktrees
        .iter()
        .find(|w| w.is_main)
        .map(|w| PathBuf::from(&w.path))
        .ok_or_else(|| "no worktrees reported by git".to_string())?;

    let dir_name = slug.replace('/', "-");
    let root = main_root.join(CANONICAL_WORKTREE_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;
    let dest = root.join(&dir_name);
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }

    let base_ref = base.map(str::to_string).unwrap_or_else(|| preferred_base(cwd));
    let dest_str = dest.to_string_lossy().to_string();
    git(cwd, &["worktree", "add", "-q", &dest_str, "-b", slug, &base_ref])?;
    Ok(dest_str)
}

/// The ref an agent branch should be cut from when the caller didn't pin one:
/// `origin/<default branch>` when that remote-tracking ref resolves, else the
/// local default branch. Deliberately NOT folded into `default_branch` itself
/// — `retire_worktree`'s ahead-count and `reclaim_worktrees`' merge re-check
/// both depend on `default_branch`'s current local-name semantics, and this
/// preference is specific to "what should a freshly created agent branch be
/// based on", not "what name does this repo call its default branch".
fn preferred_base(cwd: &Path) -> String {
    let local = default_branch(cwd);
    let remote = format!("origin/{local}");
    if git(cwd, &["rev-parse", "--verify", "--quiet", &remote]).is_ok() {
        remote
    } else {
        local
    }
}

/// Moves a worktree under `CANONICAL_WORKTREE_DIR`. Returns the new path.
///
/// Refuses everything this layer can actually see: the calling worktree, the
/// repo's main worktree, and anything with an uncommitted change. That is
/// NOT the full idle guard the design spec describes ("no attached tab, no
/// running executor process with that cwd, and a clean tree — all three") —
/// `git_tools` is a pure git/filesystem layer with no visibility into open
/// tabs or running processes, and that is a layering fact, not an oversight.
/// The "no attached tab" half of idle is the CALLER's responsibility: the
/// status-bar git popover (`ui/src/status/worktree-state.ts`,
/// `worktreeDefaultAction`) is expected to withhold the Relocate action for
/// any worktree that has a live tab cwd'd into it before this function is
/// ever invoked.
pub fn relocate_worktree(cwd: &Path, path: &str) -> Result<String, String> {
    let summary = repo_summary(cwd)?;
    let target = canonical_or_self(Path::new(path));
    let wt = summary
        .worktrees
        .iter()
        .find(|w| canonical_or_self(Path::new(&w.path)) == target)
        .ok_or_else(|| "unknown worktree".to_string())?;

    if wt.current {
        return Err("cannot relocate the current worktree".into());
    }
    // `wt.current` only proves "this is the worktree cwd is in" — it does
    // NOT prove "this is the repo's main worktree" when the call originates
    // from a different, linked worktree (Covenant's own workflow does
    // feature work inside .covenant/worktrees/<slug>, so `cwd` is usually a
    // linked worktree, not main). `git worktree list --porcelain` always
    // lists the main worktree first — `repo_summary` relies on that exact
    // fact for `off_convention`, and `summary.worktrees` preserves that
    // ordering, so reuse it here rather than inventing a second mechanism.
    // The same `main_worktree` row also anchors the destination root below,
    // rather than `summary.repo_root` (which is the CALLING cwd's own
    // toplevel, not necessarily the main worktree's).
    let main_worktree = summary.worktrees.first();
    let is_main_worktree = main_worktree
        .map(|main| canonical_or_self(Path::new(&main.path)))
        .as_ref()
        == Some(&target);
    if is_main_worktree {
        return Err("cannot relocate the main worktree".into());
    }
    if wt.dirty_count > 0 {
        return Err(format!(
            "worktree has {} uncommitted change(s); commit or discard first",
            wt.dirty_count
        ));
    }
    if !wt.off_convention {
        return Ok(wt.path.clone());
    }

    let branch = wt
        .branch
        .as_deref()
        .ok_or_else(|| "cannot relocate a detached worktree".to_string())?;
    // The destination root is always under the MAIN worktree — NOT under
    // `summary.repo_root`, which is `git rev-parse --show-toplevel` run
    // against the calling `cwd` and is routinely a linked worktree itself.
    // Using it here nested the relocated worktree inside whichever worktree
    // the caller happened to be standing in, and dirtied that worktree's
    // tree with the newly-created `.covenant/` directory in the process.
    let main_root = main_worktree
        .map(|main| Path::new(main.path.as_str()))
        .unwrap_or_else(|| Path::new(&summary.repo_root));
    let root = main_root.join(CANONICAL_WORKTREE_DIR);
    std::fs::create_dir_all(&root).map_err(|e| format!("create {}: {e}", root.display()))?;

    let dest = root.join(worktree_slug(branch));
    if dest.exists() {
        return Err(format!("{} already exists", dest.display()));
    }
    let dest_str = dest.to_string_lossy().to_string();
    git(cwd, &["worktree", "move", &wt.path, &dest_str])?;
    Ok(dest_str)
}

/// Removes a worktree Covenant handed out, when it provably holds nothing.
///
/// Returns `Ok(true)` if it was removed, `Ok(false)` if it was deliberately
/// kept. Keeping is never an error — the lifecycle ledger classifies survivors
/// later as Active / Stale / Spent.
///
/// Conditions, all required: under the canonical root, not the main worktree,
/// no commits beyond its base, and a clean tree (untracked files count as
/// dirty — a scratch file is still someone's work).
///
/// The "no other tab is standing in it" condition lives in the caller: this
/// module has no visibility into sessions.
pub fn retire_worktree(cwd: &Path, path: &str) -> Result<bool, String> {
    let summary = repo_summary(cwd)?;
    let target = canonical_or_self(Path::new(path));

    let main_root = summary
        .worktrees
        .iter()
        .find(|w| w.is_main)
        .map(|w| canonical_or_self(Path::new(&w.path)))
        .ok_or_else(|| "no worktrees reported by git".to_string())?;

    // Resolve `target` to the worktree that CONTAINS it, not just the one it
    // names exactly. An agent `cd`-ing into a subdirectory of its own
    // worktree (e.g. `<worktree>/crates/app`) is completely normal — the tab
    // still owns that worktree, and requiring an exact path match meant
    // retirement silently never fired once the shell moved. Every linked
    // worktree lives inside the main worktree's own directory tree (under
    // `.covenant/worktrees`), so the main worktree is *always* a containing
    // candidate too; picking the LONGEST containing path is what keeps a
    // nested worktree from being mistaken for its parent. Every refusal
    // below (main, canonical root, clean, pristine, no commits beyond base)
    // then applies to the RESOLVED worktree, not the literal `target` path.
    let resolved = summary
        .worktrees
        .iter()
        .map(|w| (w, canonical_or_self(Path::new(&w.path))))
        .filter(|(_, root)| target.starts_with(root))
        .max_by_key(|(_, root)| root.as_os_str().len());
    let Some((wt, wt_root)) = resolved else {
        return Ok(false);
    };

    if wt_root == main_root {
        return Ok(false);
    }
    if !wt_root.starts_with(main_root.join(CANONICAL_WORKTREE_DIR)) {
        return Ok(false);
    }
    if wt.dirty_count > 0 {
        return Ok(false);
    }
    let Some(branch) = wt.branch.as_deref() else {
        return Ok(false);
    };

    // Every git call below runs from the MAIN worktree, never from `cwd`.
    // The caller is the closing tab, which passes the worktree being retired
    // (or a subdirectory of it) as its own cwd — git can refuse to remove
    // the worktree it was invoked from, and the directory is about to stop
    // existing either way.
    let main = main_root.as_path();

    // `--porcelain` in status already counts untracked files, so dirty_count
    // covers scratch files. What is left to prove is "no commits of its own".
    let base = default_branch(main);
    let ahead = git(main, &["rev-list", "--count", &format!("{base}..{branch}")])
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
        .unwrap_or(1); // unknown → assume it has work, keep it
    if ahead > 0 {
        return Ok(false);
    }

    // `dirty_count` above is `git status --porcelain`, which never reports
    // gitignored entries. `git worktree remove` (deliberately never called
    // with --force here) deletes them anyway — so a worktree that is clean
    // by `dirty_count`'s definition can still hold real content: an agent's
    // `npm install`, scratch notes written to a gitignored path, anything.
    // Re-check immediately before removal with `--ignored=matching`, which
    // does surface ignored entries (recursing into ignored directories
    // rather than reporting just the directory name), and refuse if it
    // reports anything at all. This is scoped to the removal gate only —
    // `derive_state`/`dirty_count` deliberately do not count ignored files,
    // so the lifecycle ledger doesn't misclassify a worktree as dirty just
    // because it has a populated `node_modules/`.
    if !worktree_is_pristine(Path::new(&wt.path)) {
        return Ok(false);
    }

    git(main, &["worktree", "remove", &wt.path])?;
    // `-d`'s refusal is HEAD-relative — it checks merge status against
    // main's CURRENT HEAD, not against `base` — so it is not a meaningful
    // safety signal here: a developer's main checkout is usually sitting on
    // some other feature branch, which the agent branch (cut from `base`)
    // may not be an ancestor of even though it carries zero commits beyond
    // `base`. Try `-d` first (cheap, and correct whenever HEAD happens to be
    // `base`-compatible); if it refuses, fall back to an explicit ancestry
    // check against the SAME `base` the `rev-list` gate above already
    // proved `ahead == 0` for. `rev-list <base>..<branch> == 0` plus
    // `merge-base --is-ancestor <branch> <base>` are both base-relative and
    // therefore both correct — the redundancy that motivated preferring
    // `-d` is preserved, it is just now measuring the right target. Only a
    // passing ancestry check may fall back to `-D`; if it does not pass,
    // the branch is left alone under all circumstances. Failure here is
    // non-fatal either way: the directory is already gone and the ledger
    // will surface a stray branch.
    if git(main, &["branch", "-d", branch]).is_err() {
        let is_ancestor = git(main, &["merge-base", "--is-ancestor", branch, &base]).is_ok();
        if is_ancestor {
            let _ = git(main, &["branch", "-D", branch]);
        }
    }
    let _ = git(main, &["worktree", "prune"]);
    Ok(true)
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
                is_main: false,
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

/// True only when `wt_path` has nothing on disk beyond git's own bookkeeping
/// — no tracked changes, no untracked files, and no gitignored files either.
/// Used exclusively as `retire_worktree`'s final removal gate: plain `git
/// status --porcelain` (what `dirty_count` uses) never reports ignored
/// entries, so it cannot see a populated gitignored directory. Any failure
/// to run the check is treated as "not pristine" — the safe default is to
/// refuse removal.
fn worktree_is_pristine(wt_path: &Path) -> bool {
    match git(wt_path, &["status", "--porcelain", "--ignored=matching"]) {
        Ok(text) => text.lines().all(|l| l.trim().is_empty()),
        Err(_) => false,
    }
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

/// Live (not cached) check of whether `branch`'s tip is an ancestor of
/// `target`'s tip — i.e. still fully merged. Used to re-verify merge status
/// right before a worktree removal, since the classification that decided
/// this worktree was `Spent` may be stale by the time we act on it. Any
/// failure to determine this (git not runnable, branch or target no longer
/// resolving) is treated as "not merged" — the safe default is to refuse.
fn branch_is_merged_into(cwd: &Path, branch: &str, target: &str) -> bool {
    Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["merge-base", "--is-ancestor", branch, target])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
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

    // Regression for the bulk-reclaim confirm toast naming the wrong branch:
    // it used `current_branch` (the CALLING cwd's branch) instead of the
    // repo's actual default branch. `repo_summary` already computes
    // `default_branch(cwd)` internally to derive `merged`; this asserts the
    // same value is exposed on the wire rather than recomputed (and
    // potentially drifting) on the frontend.
    #[test]
    fn repo_summary_reports_the_default_branch() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root); // creates on "main", see init_repo's pinned -b main

        let summary = repo_summary(root).unwrap();
        assert_eq!(summary.default_branch, "main");
    }

    #[test]
    fn repo_summary_default_branch_survives_a_feature_checkout() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        git_run(root, &["checkout", "-q", "-b", "feat/worktree-lifecycle"]);

        // `current_branch` now reflects the checked-out feature branch, but
        // `default_branch` must still report the repo's actual default —
        // this is exactly the divergence the bulk-reclaim confirm copy
        // needs to name correctly.
        let summary = repo_summary(root).unwrap();
        assert_eq!(summary.current_branch.as_deref(), Some("feat/worktree-lifecycle"));
        assert_eq!(summary.default_branch, "main");
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

    // `wt.current` means "matches the calling cwd", which is NOT the same
    // question as "is this the repo's main worktree" — the conflation two
    // Critical bugs already shipped from. `is_main` is the dedicated,
    // cwd-independent field the frontend needs to answer that second
    // question (e.g. to withhold Reclaim on main when queried from a linked
    // worktree, see `worktreeDefaultAction`).
    #[test]
    fn is_main_is_independent_of_the_calling_cwd() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let linked = root.join(CANONICAL_WORKTREE_DIR).join("side");
        git_run(root, &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "side"]);

        // Called from the MAIN worktree: main.current == true, main.is_main == true.
        let summary_from_main = repo_summary(root).unwrap();
        let main_row = summary_from_main.worktrees.iter().find(|w| w.current).unwrap();
        assert!(main_row.is_main);
        let linked_row_from_main = summary_from_main
            .worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some("side"))
            .unwrap();
        assert!(!linked_row_from_main.is_main);

        // Called from the LINKED worktree: main.current == false, but
        // main.is_main must still be true — this is the exact split
        // `current` cannot express on its own.
        let summary_from_linked = repo_summary(&linked).unwrap();
        let root_canonical = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
        let main_row_from_linked = summary_from_linked
            .worktrees
            .iter()
            .find(|w| {
                std::path::Path::new(&w.path)
                    .canonicalize()
                    .unwrap_or_else(|_| std::path::PathBuf::from(&w.path))
                    == root_canonical
            })
            .expect("main worktree present in the summary");
        assert!(!main_row_from_linked.current, "sanity: cwd was the linked worktree");
        assert!(
            main_row_from_linked.is_main,
            "is_main must not depend on which worktree the call originated from"
        );
    }

    // Reproduces the bug directly: `relocate_worktree`'s destination root was
    // being derived from `summary.repo_root`, i.e. `git rev-parse
    // --show-toplevel` run against the CALLING cwd — which is a linked
    // worktree in Covenant's own normal workflow, not the main worktree.
    // Relocating a *different*, stray worktree while `cwd` sits in some
    // other linked worktree must still land under the MAIN worktree's
    // canonical root, and must never touch the calling worktree's own tree.
    #[test]
    fn relocate_from_a_linked_worktree_lands_under_the_main_root_not_nested_in_the_caller() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);

        // The CALLER: a correctly-placed linked worktree, not the target.
        let caller = root.join(CANONICAL_WORKTREE_DIR).join("caller");
        git_run(
            root,
            &["worktree", "add", "-q", caller.to_str().unwrap(), "-b", "caller-branch"],
        );

        // The RELOCATION TARGET: a different, stray worktree.
        let stray = root.join("stray-place");
        git_run(
            root,
            &["worktree", "add", "-q", stray.to_str().unwrap(), "-b", "feat/other-thing"],
        );

        let moved = relocate_worktree(&caller, stray.to_str().unwrap()).unwrap();

        let expected = canonical_or_self(root)
            .join(CANONICAL_WORKTREE_DIR)
            .join("other-thing");
        assert_eq!(
            canonical_or_self(Path::new(&moved)),
            canonical_or_self(&expected),
            "must land under the MAIN worktree's canonical root, got {moved}"
        );
        assert!(
            !moved.contains("caller"),
            "must not be nested inside the calling worktree's own tree: {moved}"
        );

        // The calling worktree's tree must remain untouched by the relocation.
        let status = git(&caller, &["status", "--porcelain"]).unwrap();
        assert!(
            status.trim().is_empty(),
            "calling worktree was dirtied by an unrelated relocation: {status:?}"
        );
    }

    // Reproduces the bug directly: `off_convention` was computed from a
    // `canonical_root` derived from the CALLING cwd's own toplevel, not the
    // main worktree's. A correctly-placed linked worktree, queried with its
    // own cwd (the normal case for Covenant's own workflow), must report
    // `off_convention == false` for its own row.
    #[test]
    fn repo_summary_reports_a_correctly_placed_linked_worktree_as_on_convention_from_its_own_cwd()
    {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);

        let wt = root.join(CANONICAL_WORKTREE_DIR).join("feature-x");
        git_run(
            root,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "feature-x"],
        );

        // Query repo_summary FROM the linked worktree's own cwd.
        let summary = repo_summary(&wt).unwrap();
        let own_row = summary
            .worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some("feature-x"))
            .expect("the linked worktree's own row must be present");

        assert!(
            own_row.current,
            "sanity: cwd was this worktree, so its own row must be `current`"
        );
        assert!(
            !own_row.off_convention,
            "a correctly-placed linked worktree must not be off_convention \
             when queried from its own cwd"
        );
    }

    #[test]
    fn relocate_moves_a_stray_worktree_under_the_canonical_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let stray = root.join("stray-place");
        git_run(root, &["worktree", "add", "-q", stray.to_str().unwrap(), "-b", "feat/thing"]);

        let moved = relocate_worktree(root, stray.to_str().unwrap()).unwrap();
        assert!(moved.ends_with("/.covenant/worktrees/thing"), "got {moved}");
        assert!(Path::new(&moved).is_dir());
        assert!(!stray.exists());

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter()
            .find(|w| w.branch.as_deref() == Some("feat/thing")).unwrap();
        assert!(!row.off_convention);
    }

    #[test]
    fn relocate_refuses_a_dirty_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let stray = root.join("stray-dirty");
        git_run(root, &["worktree", "add", "-q", stray.to_str().unwrap(), "-b", "busy"]);
        std::fs::write(stray.join("tracked.txt"), "uncommitted\n").unwrap();

        let err = relocate_worktree(root, stray.to_str().unwrap()).unwrap_err();
        assert!(err.contains("uncommitted"), "got {err}");
        assert!(stray.exists());
    }

    #[test]
    fn relocate_refuses_the_current_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let err = relocate_worktree(root, root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("current"), "got {err}");
    }

    #[test]
    fn relocate_is_a_noop_for_a_worktree_already_in_place() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let good = root.join(CANONICAL_WORKTREE_DIR).join("ok");
        git_run(root, &["worktree", "add", "-q", good.to_str().unwrap(), "-b", "ok"]);

        let out = relocate_worktree(root, good.to_str().unwrap()).unwrap();
        assert_eq!(canonical_or_self(Path::new(&out)), canonical_or_self(&good));
        assert!(good.is_dir());
    }

    // The `current` guard only proves "this is the worktree cwd is in" — it
    // does NOT prove "this is the repo's main worktree" when the call
    // originates from a different, linked worktree (Covenant's own workflow:
    // feature work happens inside .covenant/worktrees/<slug>, so `cwd` is
    // usually a linked worktree, not main). This reproduces exactly that gap:
    // call `relocate_worktree` with the main worktree's path while `cwd` is a
    // different, linked worktree, so `current` is false on the main row and
    // can't be the thing that saves it.
    #[test]
    fn relocate_refuses_the_main_worktree_when_called_from_a_linked_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);

        let linked = root.join(CANONICAL_WORKTREE_DIR).join("side");
        git_run(root, &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "side"]);

        // Sanity check the setup actually reproduces the bug shape: called
        // from the linked worktree, the main worktree's `current` flag must
        // be false, or this test isn't exercising the gap at all.
        let summary = repo_summary(&linked).unwrap();
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
            .expect("main worktree present in the summary");
        assert!(!main_row.current, "sanity: cwd was the linked worktree");

        let err = relocate_worktree(&linked, root.to_str().unwrap()).unwrap_err();
        assert!(err.contains("main"), "got {err}");
        assert!(root.exists(), "main worktree directory still present");
        assert!(root.join(".git").exists(), "still a valid repository");
        assert!(
            git_run_ok(root, &["rev-parse", "--show-toplevel"]),
            "root is still a functioning git worktree"
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

    #[test]
    fn reclaim_removes_a_spent_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-done");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "done"]);
        std::fs::write(wt.join("tracked.txt"), "x\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "w"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "m", "done"]);

        let out = reclaim_worktrees(root, vec![wt.to_string_lossy().to_string()]).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].removed, "reason: {:?}", out[0].reason);
        assert!(!wt.exists(), "directory is gone");

        let branches = git(root, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(!branches.lines().any(|l| l.trim() == "done"), "branch deleted too");
    }

    #[test]
    fn reclaim_refuses_an_unmerged_worktree() {
        // Unmerged + clean + recently committed classifies as Active — this
        // doubles as the "Active is still refused" coverage.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-live");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "live"]);
        std::fs::write(wt.join("tracked.txt"), "x\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "w"]);

        let summary = repo_summary(root).unwrap();
        let row = summary.worktrees.iter().find(|w| w.branch.as_deref() == Some("live")).unwrap();
        assert_eq!(row.state, WorktreeState::Active, "sanity: setup must reproduce Active");

        let out = reclaim_worktrees(root, vec![wt.to_string_lossy().to_string()]).unwrap();
        assert_eq!(out.len(), 1);
        assert!(!out[0].removed);
        assert!(out[0].reason.as_deref().unwrap_or("").contains("not spent"));
        assert!(wt.exists(), "untouched");
    }

    #[test]
    fn reclaim_refuses_a_stale_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-stale");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "stale-branch"]);
        std::fs::write(wt.join("tracked.txt"), "x\n").unwrap();
        git_run(&wt, &["add", "."]);
        // Backdate the commit so it falls outside STALE_AFTER_DAYS: clean +
        // unmerged + old classifies as Stale (see derive_state).
        let old = "2000-01-01T00:00:00";
        let out = std::process::Command::new("git")
            .arg("-C")
            .arg(&wt)
            .args(["commit", "-q", "-m", "old work"])
            .env("GIT_AUTHOR_DATE", old)
            .env("GIT_COMMITTER_DATE", old)
            .output()
            .unwrap();
        assert!(out.status.success());

        let summary = repo_summary(root).unwrap();
        let row = summary
            .worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some("stale-branch"))
            .unwrap();
        assert_eq!(row.state, WorktreeState::Stale, "sanity: setup must reproduce Stale");

        let outcome = reclaim_worktrees(root, vec![wt.to_string_lossy().to_string()]).unwrap();
        assert_eq!(outcome.len(), 1);
        assert!(!outcome[0].removed);
        assert!(outcome[0].reason.as_deref().unwrap_or("").contains("not spent"));
        assert!(wt.exists(), "untouched");
    }

    // --- Finding 1: Prune (Orphan reclaim) ------------------------------

    #[test]
    fn reclaim_removes_an_orphan_worktree_but_keeps_the_branch() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-orphan");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "orphan-branch"]);
        std::fs::write(wt.join("tracked.txt"), "unmerged work\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "unmerged work"]);

        // Pre-canonicalize while the directory still exists: once it's gone,
        // `canonical_or_self` can no longer resolve it and falls back to the
        // raw string it was given (see the duplicate-path test above for the
        // same gotcha). Passing an already-canonical path keeps that
        // fallback matching the cached summary row's (canonical) path.
        let path = wt.canonicalize().unwrap().to_string_lossy().to_string();

        // Simulate the user deleting the directory out from under git,
        // without going through `git worktree remove` — this is exactly
        // what makes a worktree Orphan rather than Spent/Stale/Active.
        std::fs::remove_dir_all(&wt).unwrap();

        let summary = repo_summary(root).unwrap();
        let row = summary
            .worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some("orphan-branch"))
            .expect("orphan row present");
        assert_eq!(row.state, WorktreeState::Orphan, "sanity: setup must reproduce Orphan");

        let out = reclaim_worktrees(root, vec![path]).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out[0].removed, "reason: {:?}", out[0].reason);

        let listed = git(root, &["worktree", "list", "--porcelain"]).unwrap();
        assert!(
            !listed.contains("orphan-branch"),
            "admin entry should be gone: {listed}"
        );

        let branches = git(root, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(
            branches.lines().any(|l| l.trim() == "orphan-branch"),
            "branch must survive an orphan reclaim — it may be the only copy of unmerged work"
        );
    }

    #[test]
    fn reclaim_refuses_a_dirty_worktree_even_if_merged() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-dirty");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "dirty"]);
        std::fs::write(wt.join("tracked.txt"), "x\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "w"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "m", "dirty"]);
        std::fs::write(wt.join("tracked.txt"), "uncommitted\n").unwrap();

        let out = reclaim_worktrees(root, vec![wt.to_string_lossy().to_string()]).unwrap();
        assert!(!out[0].removed);
        assert!(wt.exists());
    }

    #[test]
    fn reclaim_refuses_the_current_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let out = reclaim_worktrees(root, vec![root.to_string_lossy().to_string()]).unwrap();
        assert!(!out[0].removed);
        assert!(root.exists());
    }

    #[test]
    fn reclaim_refuses_a_path_that_is_not_a_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let out = reclaim_worktrees(root, vec!["/tmp/not-a-worktree".to_string()]).unwrap();
        assert!(!out[0].removed);
        assert!(out[0].reason.as_deref().unwrap_or("").contains("unknown"));
    }

    #[test]
    fn one_refusal_does_not_abort_the_batch() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let good = root.join("wt-good");
        git_run(root, &["worktree", "add", "-q", good.to_str().unwrap(), "-b", "good"]);
        std::fs::write(good.join("tracked.txt"), "x\n").unwrap();
        git_run(&good, &["add", "."]);
        git_run(&good, &["commit", "-q", "-m", "w"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "m", "good"]);

        let out = reclaim_worktrees(
            root,
            vec!["/tmp/nope".to_string(), good.to_string_lossy().to_string()],
        )
        .unwrap();
        assert_eq!(out.len(), 2);
        assert!(out.iter().any(|o| o.removed), "the valid one still went through");
    }

    // --- Finding 1: TOCTOU on merge status -----------------------------
    //
    // `repo_summary` snapshots merge status once, at the top of
    // `reclaim_worktrees`; the actual removal happens later in the loop.
    // `git worktree remove` re-validates cleanliness itself, closing half
    // of that gap, but has no opinion on merge status. `branch_is_merged_into`
    // is the live re-check that closes the other half. A *genuine* race
    // (branch gains an unmerged commit mid-call, tree still clean) needs
    // real concurrency to reproduce and isn't attempted here; instead this
    // proves the mechanism directly against live git state.

    #[test]
    fn branch_is_merged_into_reflects_live_ancestry() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        git_run(root, &["checkout", "-q", "-b", "topic"]);
        std::fs::write(root.join("tracked.txt"), "topic work\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "topic work"]);
        git_run(root, &["checkout", "-q", "main"]);

        assert!(
            !branch_is_merged_into(root, "topic", "main"),
            "topic has a commit main doesn't"
        );

        git_run(root, &["merge", "-q", "--no-ff", "-m", "merge", "topic"]);

        assert!(
            branch_is_merged_into(root, "topic", "main"),
            "topic is now fully reachable from main"
        );
    }

    // A duplicate path within one batch happens to also give us a
    // deterministic, non-racy way to exercise the *wired-in* re-check: the
    // cached `summary` still reports the worktree as `Spent` for both
    // occurrences (it was computed once, at the top of the call, and the
    // loop's own removal of the first occurrence doesn't retroactively
    // change that cached value) — so the second occurrence passes the
    // `state != Spent` gate exactly like the first did, and is refused only
    // because the live re-check finds the branch (deleted by the first
    // occurrence's `git branch -d`) no longer resolves as merged. See also
    // Finding 3 below, which this same scenario also covers.
    #[test]
    fn reclaim_duplicate_path_in_one_batch_removes_once_and_the_repeat_is_refused_by_the_merge_recheck(
    ) {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let wt = root.join("wt-dup");
        git_run(root, &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "dup"]);
        std::fs::write(wt.join("tracked.txt"), "x\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "w"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "m", "dup"]);

        // Pre-canonicalize: once the first occurrence removes the
        // directory, `canonical_or_self` can no longer resolve it (the path
        // stops existing) and falls back to the raw string it was given.
        // Passing an already-canonical path here means that fallback still
        // matches the cached summary row's (canonical) path, so the second
        // occurrence is looked up successfully instead of bailing out
        // early on an "unknown worktree" path-matching miss — which would
        // otherwise short-circuit before ever reaching the merge recheck
        // this test means to exercise.
        let path = wt.canonicalize().unwrap().to_string_lossy().to_string();
        let out = reclaim_worktrees(root, vec![path.clone(), path]).unwrap();

        assert_eq!(out.len(), 2, "the batch completed rather than aborting");
        assert_eq!(
            out.iter().filter(|o| o.removed).count(),
            1,
            "exactly one occurrence actually removed the worktree"
        );
        let refused = out.iter().find(|o| !o.removed).expect("one refusal");
        assert!(
            refused
                .reason
                .as_deref()
                .unwrap_or("")
                .contains("no longer confirmed merged"),
            "the repeat was refused by the merge recheck, not a generic error: {:?}",
            refused.reason
        );
        assert!(!wt.exists(), "the worktree was still removed once");
    }

    // --- Finding 2: the main worktree has no explicit refusal ----------
    //
    // `reclaim_worktrees` never special-cases "is this the main worktree" —
    // it relies entirely on `git worktree remove`'s own hard refusal. That
    // is only exercised when every one of `reclaim_worktrees`'s own gates
    // (state == Spent, clean, not current) happens to pass for the main
    // worktree, which requires it to be checked out on a branch other than
    // the default one — e.g. a branch that has itself already been merged
    // into the default branch. This reproduces exactly that, called from a
    // *different*, linked worktree so `current` is false on the main row.
    #[test]
    fn reclaim_refuses_the_main_worktree_when_called_from_a_linked_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);

        let linked = root.join(CANONICAL_WORKTREE_DIR).join("side");
        git_run(root, &["worktree", "add", "-q", linked.to_str().unwrap(), "-b", "side"]);

        // Put the MAIN worktree on a branch that is merged into the default
        // branch and clean — the only way it can pass reclaim_worktrees's
        // own `Spent` gate at all.
        git_run(root, &["checkout", "-q", "-b", "merged-branch"]);
        std::fs::write(root.join("tracked.txt"), "more\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "work"]);
        git_run(root, &["checkout", "-q", "main"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "merge", "merged-branch"]);
        git_run(root, &["checkout", "-q", "merged-branch"]);

        // Sanity check the setup actually reproduces the bug shape: called
        // from the linked worktree, the main worktree's `current` flag must
        // be false and its state must classify as Spent, or this test isn't
        // exercising git's safety net at all.
        let summary = repo_summary(&linked).unwrap();
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
            .expect("main worktree present in the summary");
        assert!(!main_row.current, "sanity: cwd was the linked worktree");
        assert_eq!(
            main_row.state,
            WorktreeState::Spent,
            "sanity: this must pass reclaim_worktrees's own gates to prove \
             the removal is actually stopped by git, not by an earlier check"
        );

        let out = reclaim_worktrees(&linked, vec![root.to_string_lossy().to_string()]).unwrap();

        assert_eq!(out.len(), 1);
        assert!(!out[0].removed, "the main worktree must never be removed");
        assert!(root.exists(), "main worktree directory still present");
        assert!(root.join(".git").exists(), "still a valid repository");
        assert!(
            git_run_ok(root, &["rev-parse", "--show-toplevel"]),
            "root is still a functioning git worktree"
        );
    }

    #[test]
    fn reclaim_deletes_the_branch_even_when_main_has_diverged_from_default() {
        // Live-verification regression, identical bug shape to
        // `retire_deletes_the_branch_even_when_main_has_diverged_from_default`:
        // `git branch -d` refuses based on the invoking repo's CURRENT HEAD,
        // not the default branch `reclaim_worktrees` actually verified
        // merge status against. If the developer's main checkout has moved
        // to some other feature branch (the common case), the agent
        // branch — cut from the default branch and fully merged back into
        // it — can still be unmerged into THAT branch's history. Reproduced
        // live: `git branch -d agent/claude-0719-y72` failed with "not
        // fully merged" even though the branch was fully merged into main.
        // The worktree must still be removed; the branch must also be gone.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root); // default branch "main", tip = commit A

        // Fork a feature branch from A, and give it its own commit (F) —
        // this is the developer's real working branch, the one main will be
        // sitting on when reclaim runs.
        git_run(root, &["switch", "-q", "-c", "fix/gist-binary-guard"]);
        std::fs::write(root.join("feature-only.txt"), "wip\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "feature work"]);

        // Back on main, cut the agent worktree/branch and merge it back —
        // this is what makes it classify as Spent.
        git_run(root, &["switch", "-q", "main"]);
        let wt = root.join(CANONICAL_WORKTREE_DIR).join("agent-claude-0719-y72");
        git_run(
            root,
            &["worktree", "add", "-q", wt.to_str().unwrap(), "-b", "agent/claude-0719-y72"],
        );
        std::fs::write(wt.join("agent-work.txt"), "done\n").unwrap();
        git_run(&wt, &["add", "."]);
        git_run(&wt, &["commit", "-q", "-m", "agent work"]);
        git_run(root, &["merge", "-q", "--no-ff", "-m", "merge", "agent/claude-0719-y72"]);

        // Now move the MAIN checkout onto the feature branch (F), which does
        // NOT contain the merge commit. `git branch -d
        // agent/claude-0719-y72` from `root` checks merge status against F
        // (current HEAD) and must refuse, exactly as it did in live
        // verification, even though the branch is fully merged into "main".
        git_run(root, &["switch", "-q", "fix/gist-binary-guard"]);

        let summary = repo_summary(root).unwrap();
        let row = summary
            .worktrees
            .iter()
            .find(|w| w.branch.as_deref() == Some("agent/claude-0719-y72"))
            .expect("agent worktree row present");
        assert_eq!(
            row.state,
            WorktreeState::Spent,
            "sanity: setup must reproduce Spent even though main has diverged"
        );

        let path = wt.canonicalize().unwrap().to_string_lossy().to_string();
        let out = reclaim_worktrees(root, vec![path]).unwrap();

        assert_eq!(out.len(), 1);
        assert!(out[0].removed, "reason: {:?}", out[0].reason);
        assert!(!wt.exists(), "worktree directory is gone");

        let branches = git(root, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(
            !branches.lines().any(|l| l.trim() == "agent/claude-0719-y72"),
            "branch must be deleted via ancestry-against-base, not HEAD-relative -d",
        );
    }

    #[test]
    fn create_worktree_lands_under_the_canonical_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);

        let path = create_worktree(root, "agent/claude-0719-a3f", None).unwrap();
        let expected = canonical_or_self(
            &root.join(CANONICAL_WORKTREE_DIR).join("agent-claude-0719-a3f"),
        );
        assert_eq!(canonical_or_self(Path::new(&path)), expected, "got {path}");
        assert!(Path::new(&path).is_dir());
    }

    #[test]
    fn create_worktree_lands_under_the_MAIN_root_when_called_from_a_linked_worktree() {
        // The bug shape that shipped twice in the predecessor: deriving the
        // canonical root from the CALLING cwd instead of the main worktree.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let caller = root.join(CANONICAL_WORKTREE_DIR).join("caller");
        git_run(root, &["worktree", "add", "-q", caller.to_str().unwrap(), "-b", "caller"]);

        let path = create_worktree(&caller, "agent/codex-0719-b7c", None).unwrap();
        let expected = canonical_or_self(
            &root.join(CANONICAL_WORKTREE_DIR).join("agent-codex-0719-b7c"),
        );
        assert_eq!(canonical_or_self(Path::new(&path)), expected, "got {path}");
        assert!(!path.contains("caller"), "must not nest inside the caller: {path}");
        // The caller must not be dirtied as a side effect.
        assert_eq!(status_count(&caller).unwrap(), 0);
    }

    #[test]
    fn create_worktree_refuses_a_slug_that_already_exists() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        create_worktree(root, "agent/dup-0719-aaa", None).unwrap();
        let err = create_worktree(root, "agent/dup-0719-aaa", None).unwrap_err();
        assert!(err.contains("already exists"), "got {err}");
    }

    #[test]
    fn create_worktree_branches_from_the_default_branch_when_base_is_none() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        // Move the caller off main so "branches from HEAD" would be visibly wrong.
        git_run(root, &["switch", "-q", "-c", "side"]);
        std::fs::write(root.join("side-only.txt"), "x\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "side commit"]);

        let path = create_worktree(root, "agent/base-0719-ccc", None).unwrap();
        assert!(
            !Path::new(&path).join("side-only.txt").exists(),
            "must branch from the default branch, not the caller's HEAD",
        );
    }

    #[test]
    fn create_worktree_prefers_origin_default_over_a_lagging_local_default() {
        // The spec's whole point: an agent starts from shared main, not from
        // whatever the caller's local checkout happens to have. Set up an
        // `origin` whose default branch has moved ahead of the local one —
        // without a fetch-time origin/HEAD symref, since `default_branch`
        // itself only ever resolves a LOCAL name (see its own doc comment) —
        // and prove the new worktree is cut from `origin/main`, not the
        // locally-behind `main`.
        let tmp = tempfile::TempDir::new().unwrap();
        let bare = tmp.path().join("origin.git");
        std::fs::create_dir_all(&bare).unwrap();
        git_run(&bare, &["init", "-q", "--bare", "-b", "main"]);

        let root = tmp.path().join("work");
        std::fs::create_dir_all(&root).unwrap();
        init_repo(&root);
        git_run(&root, &["remote", "add", "origin", bare.to_str().unwrap()]);
        git_run(&root, &["push", "-q", "-u", "origin", "main"]);

        // Advance origin/main independently, from a second clone, so the
        // caller's local "main" falls behind it — a real lag, not a
        // fast-forward the caller could trivially pick up.
        let other = tmp.path().join("other-clone");
        git_run(tmp.path(), &["clone", "-q", bare.to_str().unwrap(), other.to_str().unwrap()]);
        git_run(&other, &["config", "user.email", "t@t.t"]);
        git_run(&other, &["config", "user.name", "t"]);
        std::fs::write(other.join("origin-only.txt"), "from origin\n").unwrap();
        git_run(&other, &["add", "."]);
        git_run(&other, &["commit", "-q", "-m", "origin advances"]);
        git_run(&other, &["push", "-q", "origin", "main"]);

        // Bring the remote-tracking ref up to date without moving local
        // "main" — this is `git fetch`, not `git pull`.
        git_run(&root, &["fetch", "-q", "origin"]);
        assert!(
            !root.join("origin-only.txt").exists(),
            "sanity: local main must still be behind"
        );

        let path = create_worktree(&root, "agent/remote-base-0719-iii", None).unwrap();
        assert!(
            Path::new(&path).join("origin-only.txt").exists(),
            "must branch from origin/main, not the locally-behind local main",
        );
    }

    #[test]
    fn create_worktree_honors_an_explicit_base() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        git_run(root, &["switch", "-q", "-c", "side"]);
        std::fs::write(root.join("side-only.txt"), "x\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "side commit"]);
        git_run(root, &["switch", "-q", "main"]);

        let path = create_worktree(root, "agent/explicit-0719-ddd", Some("side")).unwrap();
        assert!(Path::new(&path).join("side-only.txt").exists());
    }

    #[test]
    fn retire_removes_an_untouched_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/untouched-0719-aaa", None).unwrap();

        assert!(retire_worktree(root, &path).unwrap());
        assert!(!Path::new(&path).exists());
        let branches = git(root, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(
            !branches.lines().any(|l| l.trim() == "agent/untouched-0719-aaa"),
            "an empty worktree's branch has nothing in it either",
        );
    }

    #[test]
    fn retire_keeps_a_worktree_with_commits() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/worked-0719-bbb", None).unwrap();
        let wt = Path::new(&path);
        std::fs::write(wt.join("new.txt"), "real work\n").unwrap();
        git_run(wt, &["add", "."]);
        git_run(wt, &["commit", "-q", "-m", "real work"]);

        assert!(!retire_worktree(root, &path).unwrap());
        assert!(wt.exists());
    }

    #[test]
    fn retire_keeps_a_dirty_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/dirty-0719-ccc", None).unwrap();
        std::fs::write(Path::new(&path).join("tracked.txt"), "uncommitted\n").unwrap();

        assert!(!retire_worktree(root, &path).unwrap());
        assert!(Path::new(&path).exists());
    }

    #[test]
    fn retire_keeps_an_untracked_only_worktree() {
        // No commits and `git status` sees an untracked file: still someone's
        // work (a scratch file, a .env). Not ours to delete.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/scratch-0719-ddd", None).unwrap();
        std::fs::write(Path::new(&path).join("scratch.txt"), "notes\n").unwrap();

        assert!(!retire_worktree(root, &path).unwrap());
        assert!(Path::new(&path).exists());
    }

    #[test]
    fn retire_refuses_a_worktree_outside_the_canonical_root() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let stray = root.join("stray");
        git_run(root, &["worktree", "add", "-q", stray.to_str().unwrap(), "-b", "stray"]);

        assert!(!retire_worktree(root, stray.to_str().unwrap()).unwrap());
        assert!(stray.exists());
    }

    #[test]
    fn retire_refuses_the_main_worktree() {
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        assert!(!retire_worktree(root, root.to_str().unwrap()).unwrap());
        assert!(root.exists());
    }

    #[test]
    fn retire_called_with_the_worktree_itself_as_cwd_still_removes_it() {
        // The exact calling pattern the closing tab uses (Task 7): `cwd` IS
        // the worktree being retired. All git calls must run from the MAIN
        // worktree, never from `cwd`, since git can refuse to remove the
        // worktree it was invoked from, and that directory is about to stop
        // existing.
        //
        // The directory-removal assertion alone does not pin this: on some
        // git versions `worktree remove -C <dir> <dir>` succeeds anyway, and
        // only the subsequent `branch -d` / `worktree prune` calls fail once
        // `-C` points at a directory that no longer exists — those failures
        // are swallowed by `let _ =`. Asserting the branch is gone is what
        // actually catches a regression to `let main = cwd;`.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/self-0719-eee", None).unwrap();

        assert!(retire_worktree(Path::new(&path), &path).unwrap());
        assert!(!Path::new(&path).exists());
        let branches = git(root, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(
            !branches.lines().any(|l| l.trim() == "agent/self-0719-eee"),
            "branch delete must run from the main worktree, not the deleted cwd",
        );
    }

    #[test]
    fn retire_resolves_a_subdirectory_to_the_worktree_that_contains_it() {
        // The shell inside a worktree tab is free to `cd` around — into
        // `crates/app`, say. The tab still passes that path as its cwd when
        // it closes, and retirement must resolve it back to the worktree
        // root it belongs to rather than refusing on an exact-match miss.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let path = create_worktree(root, "agent/nested-0719-iii", None).unwrap();
        let wt = Path::new(&path);
        let subdir = wt.join("crates").join("app");
        std::fs::create_dir_all(&subdir).unwrap();

        assert!(retire_worktree(root, subdir.to_str().unwrap()).unwrap());
        assert!(!wt.exists());
    }

    #[test]
    fn retire_refuses_a_subdirectory_of_the_main_worktree() {
        // Containment resolution must not let a subdirectory of the MAIN
        // worktree resolve to anything retireable — the main worktree is
        // always a containing candidate (every linked worktree lives inside
        // its directory tree), so this pins that it still loses to the
        // main-worktree refusal rather than being retired by accident.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        let subdir = root.join("src");
        std::fs::create_dir_all(&subdir).unwrap();

        assert!(!retire_worktree(root, subdir.to_str().unwrap()).unwrap());
        assert!(root.exists());
    }

    #[test]
    fn retire_keeps_a_worktree_containing_only_gitignored_files() {
        // `dirty_count` comes from `git status --porcelain`, which never
        // reports gitignored entries — so a worktree containing nothing but
        // a populated gitignored directory (e.g. an agent's `npm install` +
        // scratch notes) reports dirty_count == 0 and ahead == 0, and would
        // otherwise sail through retirement even though `git worktree
        // remove` (no --force) deletes ignored files right along with
        // everything else.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        // .gitignore must be committed on the base branch so it takes effect
        // in the new worktree too.
        std::fs::write(root.join(".gitignore"), "ignored-dir/\n").unwrap();
        git_run(root, &["add", ".gitignore"]);
        git_run(root, &["commit", "-q", "-m", "add gitignore"]);

        let path = create_worktree(root, "agent/ignored-0719-ggg", None).unwrap();
        let wt = Path::new(&path);
        std::fs::create_dir_all(wt.join("ignored-dir")).unwrap();
        std::fs::write(
            wt.join("ignored-dir").join("notes.txt"),
            "agent scratch notes\n",
        )
        .unwrap();

        // Sanity: this is exactly the hole the fix closes — plain porcelain
        // status must not see the ignored file.
        assert_eq!(
            status_count(wt).unwrap(),
            0,
            "sanity: porcelain status must not see the ignored file"
        );

        assert!(
            !retire_worktree(root, &path).unwrap(),
            "must not retire — ignored content on disk"
        );
        assert!(
            wt.exists(),
            "worktree, and the ignored notes inside it, must survive"
        );
        assert!(wt.join("ignored-dir").join("notes.txt").exists());
    }

    #[test]
    fn retire_still_removes_a_worktree_with_no_ignored_files() {
        // The pristine gate must not false-positive just because a
        // `.gitignore` exists — only actual ignored *content* should refuse.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        std::fs::write(root.join(".gitignore"), "ignored-dir/\n").unwrap();
        git_run(root, &["add", ".gitignore"]);
        git_run(root, &["commit", "-q", "-m", "add gitignore"]);

        let path = create_worktree(root, "agent/pristine-0719-hhh", None).unwrap();
        assert!(retire_worktree(root, &path).unwrap());
        assert!(!Path::new(&path).exists());
    }

    #[test]
    fn retire_deletes_the_branch_even_when_main_has_diverged_from_default() {
        // Live-verification regression: `git branch -d` refuses based on the
        // invoking repo's CURRENT HEAD, not the default branch. If the
        // developer's main checkout has moved to some other feature branch
        // (the common case, not an edge case), the agent branch — which
        // still points at the default branch it was cut from — can be
        // unmerged into THAT branch's history even though it has zero
        // commits of its own relative to the default branch. The worktree
        // still gets removed; the branch is orphaned. Both must be gone.
        let tmp = tempfile::TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root); // default branch "main", tip = commit A

        // Fork a feature branch from A, and give it its own commit (F) —
        // this is the developer's real working branch.
        git_run(root, &["switch", "-q", "-c", "fix/gist-binary-guard"]);
        std::fs::write(root.join("feature-only.txt"), "wip\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "feature work"]);

        // Back on main, advance it independently (B) so the feature branch
        // does NOT contain main's new tip — a real divergence, not just a
        // fast-forward ahead of main.
        git_run(root, &["switch", "-q", "main"]);
        std::fs::write(root.join("main-only.txt"), "advance\n").unwrap();
        git_run(root, &["add", "."]);
        git_run(root, &["commit", "-q", "-m", "main advances"]);

        // Cut the agent branch from main's current tip (B): zero commits of
        // its own relative to "main", so the existing rev-list gate passes.
        let path = create_worktree(root, "agent/orphan-0719-fff", None).unwrap();

        // Now move the MAIN checkout onto the feature branch (F), which does
        // NOT contain B. `git branch -d agent/orphan-0719-fff` from `root`
        // checks merge status against F (current HEAD) and must refuse,
        // exactly as it did in live verification — even though the branch
        // is trivially an ancestor of "main" (it IS main's tip).
        git_run(root, &["switch", "-q", "fix/gist-binary-guard"]);

        assert!(retire_worktree(root, &path).unwrap());
        assert!(!Path::new(&path).exists());
        let branches = git(root, &["branch", "--format=%(refname:short)"]).unwrap();
        assert!(
            !branches.lines().any(|l| l.trim() == "agent/orphan-0719-fff"),
            "branch must be deleted via ancestry-against-base, not HEAD-relative -d",
        );
    }
}
