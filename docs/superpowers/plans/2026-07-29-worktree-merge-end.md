# Worktree "Merge & end" Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One button on the Worktrees page detail panel that merges an agent worktree's branch into the default branch (`--no-ff`, in the main checkout) and then reclaims the worktree via the existing `reclaim_worktrees`.

**Architecture:** New `git_tools::merge_and_end` does all safety re-verification server-side and delegates deletion to `reclaim_worktrees` (whose merge re-check passes after the merge). Thin Tauri command + `api.ts` wrapper. UI adds a gated "Merge & end" button (disabled + tooltip when preconditions fail) and a "Commit" button that routes to the existing Changes composer.

**Tech Stack:** Rust (git CLI via existing `git()` helper), Tauri IPC, TypeScript (no framework).

**Spec:** `docs/superpowers/specs/2026-07-29-worktree-merge-end-design.md`

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]`.
- Errors are `Result<_, String>` with human-readable reasons shown to the user verbatim (existing git_tools convention).
- No push, no squash — `git merge --no-ff --no-edit <branch>` only, run in the MAIN checkout (never `cwd`, which is routinely a linked worktree).
- UI: no native tooltips (`attachTooltip` only), inline SVG icons (`Icons.*`), sharp corners, English copy.
- All UI gating is advisory; the backend re-derives every precondition from a fresh `repo_summary`.

---

### Task 1: `git_tools::merge_and_end` (Rust core + tests)

**Files:**
- Modify: `crates/app/src/git_tools.rs` (new fn near `reclaim_worktrees` ~line 278; tests in the existing `#[cfg(test)] mod` using `init_repo`/`git_run` helpers at ~line 1740)

**Interfaces:**
- Consumes: `repo_summary`, `reclaim_worktrees`, `git()`, `canonical_or_self` (all existing, same file).
- Produces: `pub fn merge_and_end(cwd: &Path, worktree_path: &str) -> Result<ReclaimOutcome, String>` — later tasks call exactly this.

- [ ] **Step 1: Write the failing tests**

Add to the existing test module in `git_tools.rs` (reuse `git_run` and `init_repo`; follow the `if git --version fails, return` guard used by every git test):

```rust
/// Worktree with one committed change on a branch; returns (tmp, main_dir, wt_dir).
fn repo_with_feature_worktree() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
    let tmp = tempfile::TempDir::new().unwrap();
    let main = tmp.path().join("repo");
    std::fs::create_dir_all(&main).unwrap();
    init_repo(&main);
    let wt = tmp.path().join("repo/.covenant/worktrees/feat");
    git_run(&main, &["worktree", "add", "-b", "feat", wt.to_str().unwrap()]);
    std::fs::write(wt.join("feature.txt"), "new\n").unwrap();
    git_run(&wt, &["add", "."]);
    git_run(&wt, &["commit", "-q", "-m", "feat: work"]);
    (tmp, main, wt)
}

#[test]
fn merge_and_end_merges_no_ff_and_reclaims() {
    if std::process::Command::new("git").arg("--version").output().is_err() { return; }
    let (_tmp, main, wt) = repo_with_feature_worktree();

    let out = merge_and_end(&main, wt.to_str().unwrap()).unwrap();
    assert!(out.removed, "worktree should be reclaimed: {:?}", out.reason);

    // Merge commit exists on main with the conventional message.
    let subject = git(&main, &["log", "-1", "--format=%s"]).unwrap();
    assert_eq!(subject.trim(), "Merge branch 'feat'");
    // Merged content is present, checkout and branch are gone.
    assert!(main.join("feature.txt").exists());
    assert!(!wt.exists());
    assert!(git(&main, &["rev-parse", "--verify", "refs/heads/feat"]).is_err());
}

#[test]
fn merge_and_end_refuses_dirty_worktree() {
    if std::process::Command::new("git").arg("--version").output().is_err() { return; }
    let (_tmp, main, wt) = repo_with_feature_worktree();
    std::fs::write(wt.join("wip.txt"), "uncommitted\n").unwrap();

    let err = merge_and_end(&main, wt.to_str().unwrap()).unwrap_err();
    assert!(err.contains("uncommitted"), "got: {err}");
    assert!(wt.exists());
}

#[test]
fn merge_and_end_refuses_dirty_main_checkout() {
    if std::process::Command::new("git").arg("--version").output().is_err() { return; }
    let (_tmp, main, wt) = repo_with_feature_worktree();
    std::fs::write(main.join("tracked.txt"), "local edit\n").unwrap();

    let err = merge_and_end(&main, wt.to_str().unwrap()).unwrap_err();
    assert!(err.contains("main checkout"), "got: {err}");
    assert!(wt.exists());
}

#[test]
fn merge_and_end_conflict_aborts_and_leaves_both_trees_intact() {
    if std::process::Command::new("git").arg("--version").output().is_err() { return; }
    let (_tmp, main, wt) = repo_with_feature_worktree();
    // Conflicting edits to the same file on both branches.
    std::fs::write(wt.join("tracked.txt"), "feature version\n").unwrap();
    git_run(&wt, &["commit", "-aqm", "feat: edit tracked"]);
    std::fs::write(main.join("tracked.txt"), "main version\n").unwrap();
    git_run(&main, &["commit", "-aqm", "main: edit tracked"]);

    let err = merge_and_end(&main, wt.to_str().unwrap()).unwrap_err();
    assert!(err.contains("merge"), "got: {err}");
    // Aborted: main is clean and back on the pre-merge commit, worktree intact.
    let status = git(&main, &["status", "--porcelain"]).unwrap();
    assert!(status.trim().is_empty(), "main left dirty: {status}");
    let subject = git(&main, &["log", "-1", "--format=%s"]).unwrap();
    assert_eq!(subject.trim(), "main: edit tracked");
    assert!(wt.exists());
    assert!(git(&main, &["rev-parse", "--verify", "refs/heads/feat"]).is_ok());
}

#[test]
fn merge_and_end_refuses_main_checkout_on_other_branch() {
    if std::process::Command::new("git").arg("--version").output().is_err() { return; }
    let (_tmp, main, wt) = repo_with_feature_worktree();
    git_run(&main, &["switch", "-qc", "elsewhere"]);

    let err = merge_and_end(&main, wt.to_str().unwrap()).unwrap_err();
    assert!(err.contains("elsewhere"), "got: {err}");
    assert!(wt.exists());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant merge_and_end 2>&1 | tail -20`
(If the app crate name differs, check `crates/app/Cargo.toml` `[package] name` and use that after `-p`.)
Expected: compile error — `merge_and_end` not found.

- [ ] **Step 3: Implement `merge_and_end`**

Place directly below `reclaim_worktrees` in `git_tools.rs`:

```rust
/// Merges a worktree's branch into the default branch (`--no-ff`, run in the
/// MAIN checkout) and then reclaims the worktree via `reclaim_worktrees`.
///
/// Every precondition is re-derived here from a fresh `repo_summary` — the
/// UI's gating is advisory only. On merge conflict the merge is aborted and
/// both trees are left exactly as they were.
pub fn merge_and_end(cwd: &Path, worktree_path: &str) -> Result<ReclaimOutcome, String> {
    let summary = repo_summary(cwd)?;
    let target = canonical_or_self(Path::new(worktree_path));
    let wt = summary
        .worktrees
        .iter()
        .find(|w| canonical_or_self(Path::new(&w.path)) == target)
        .ok_or_else(|| "unknown worktree".to_string())?;
    let main = summary
        .worktrees
        .iter()
        .find(|w| w.is_main)
        .ok_or_else(|| "no main worktree reported by git".to_string())?;

    if wt.is_main {
        return Err("refusing to merge the main worktree into itself".into());
    }
    let branch = wt
        .branch
        .clone()
        .ok_or_else(|| "worktree is on a detached HEAD".to_string())?;
    if branch == summary.default_branch {
        return Err(format!("worktree is already on \"{}\"", summary.default_branch));
    }
    if wt.dirty_count > 0 {
        return Err(format!(
            "\"{branch}\" has {} uncommitted change(s) — commit them first",
            wt.dirty_count
        ));
    }
    if let Some(reason) = &wt.locked {
        return Err(format!("worktree is locked: {reason}"));
    }

    let main_root = PathBuf::from(&main.path);
    let main_branch = git(&main_root, &["branch", "--show-current"])?;
    let main_branch = main_branch.trim();
    if main_branch != summary.default_branch {
        return Err(format!(
            "main checkout is on \"{main_branch}\", not \"{}\"",
            summary.default_branch
        ));
    }
    if main.dirty_count > 0 {
        return Err(format!(
            "main checkout has {} uncommitted change(s)",
            main.dirty_count
        ));
    }

    if let Err(e) = git(&main_root, &["merge", "--no-ff", "--no-edit", &branch]) {
        // Abort whether or not a merge is actually in progress; a failed
        // pre-merge check leaves nothing to abort and the abort just errors.
        let _ = git(&main_root, &["merge", "--abort"]);
        return Err(format!("merge failed: {e}"));
    }

    let outcomes = reclaim_worktrees(cwd, vec![wt.path.clone()])?;
    outcomes
        .into_iter()
        .next()
        .ok_or_else(|| "reclaim returned no outcome".to_string())
}
```

Note: `git()`'s existing error string already includes stderr, which names the conflicting files — no extra formatting needed.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p covenant merge_and_end 2>&1 | tail -20`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/git_tools.rs
git commit -m "feat(git): merge_and_end — merge worktree branch into main, then reclaim"
```

---

### Task 2: IPC plumbing (Tauri command + api.ts)

**Files:**
- Modify: `crates/app/src/lib.rs` (new command next to `worktree_reclaim` ~line 2788; register in the handler list ~line 5895)
- Modify: `ui/src/api.ts` (wrapper next to `worktreeReclaim` ~line 1436)

**Interfaces:**
- Consumes: `git_tools::merge_and_end(cwd: &Path, worktree_path: &str) -> Result<ReclaimOutcome, String>` (Task 1).
- Produces: TS `worktreeMergeEnd(cwd: string, path: string): Promise<ReclaimOutcome>` — Task 3 calls exactly this. `ReclaimOutcome` type already exists in `api.ts`.

- [ ] **Step 1: Add the Tauri command in `lib.rs`**

Below `worktree_relocate`:

```rust
#[tauri::command]
async fn worktree_merge_end(
    cwd: String,
    path: String,
) -> Result<git_tools::ReclaimOutcome, String> {
    let root = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::merge_and_end(&root, &path))
        .await
        .map_err(|e| format!("worktree_merge_end join: {e}"))?
}
```

Register `worktree_merge_end,` in the `generate_handler![...]` list right after `worktree_relocate,`.

- [ ] **Step 2: Add the api.ts wrapper**

Below `worktreeRelocate`:

```ts
export async function worktreeMergeEnd(cwd: string, path: string): Promise<ReclaimOutcome> {
  return invoke("worktree_merge_end", { cwd, path });
}
```

- [ ] **Step 3: Verify both sides compile**

Run: `cargo check -p covenant 2>&1 | tail -5` (same `-p` caveat as Task 1) and `npm run build 2>&1 | tail -5` (from repo root)
Expected: both succeed with no errors.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(ipc): worktree_merge_end command + typed wrapper"
```

---

### Task 3: Worktrees page UI — Commit + Merge & end buttons

**Files:**
- Modify: `ui/src/worktrees/index.ts` (`renderActions`, ~line 571; import list, line 1–13)
- Modify: `ui/src/worktrees/worktrees.css` (disabled state near `.wt-act-danger`, ~line 193)

**Interfaces:**
- Consumes: `worktreeMergeEnd(cwd, path)` from `../api` (Task 2); existing `this.summary` (`GitRepoSummary | null`), `this.opts.getOccupiedCwds()`, `pushConfirmToast`/`pushInfoToast`, `attachTooltip`, `Icons`.
- Produces: user-facing buttons only; nothing downstream.

- [ ] **Step 1: Add imports**

In the import block of `ui/src/worktrees/index.ts`, add `worktreeMergeEnd` to the list imported from `"../api"`.

- [ ] **Step 2: Add the buttons in `renderActions`**

Insert after the `Explain` button block (after line 607) and before the `worktreeDefaultAction` state-action block:

```ts
    // Commit routes to the existing Changes composer — same surface View diff
    // opens, but named for the job when there is uncommitted work.
    if (wt.dirty_count > 0) {
      btn("Commit", Icons.gitCommit({ size: 14 }), "", () => {
        window.dispatchEvent(new CustomEvent("covenant:open-changes", { detail: { cwd: wt.path, backTo: "worktrees" } }));
        this.close();
      });
    }

    // Merge & end — merge into the default branch, then reclaim. Only offered
    // while the branch is unmerged; spent worktrees already have Reclaim.
    if (!wt.is_main && !wt.current && !wt.merged && wt.branch) {
      const base = this.summary?.default_branch ?? "main";
      const mainWt = this.summary?.worktrees.find((w) => w.is_main) ?? null;
      const blocked =
        wt.dirty_count > 0 ? "Commit your changes first" :
        wt.locked ? `Locked: ${wt.locked}` :
        this.opts.getOccupiedCwds().has(wt.path) ? "A session is using this worktree" :
        mainWt && mainWt.dirty_count > 0 ? "Main checkout has uncommitted changes" :
        null;
      divider();
      const b = btn("Merge & end", Icons.gitMerge({ size: 14 }), "wt-act-primary", () => {
        if (b.classList.contains("is-disabled")) return;
        pushConfirmToast({
          message: `Merge ${wt.branch} into ${base} and remove the worktree?`,
          confirmLabel: "Merge & end",
          onConfirm: () => {
            void worktreeMergeEnd(this.repoRoot, wt.path)
              .then((out) => {
                if (!out.removed) {
                  pushInfoToast({ message: `Merged, but not removed: ${out.reason ?? "refused"}` });
                } else {
                  pushInfoToast({ message: `Merged ${wt.branch} into ${base} and reclaimed ${worktreeLabel(wt)}` });
                  this.selected = null;
                }
                void this.refresh();
              })
              .catch((e) => pushInfoToast({ message: `Merge & end failed: ${String(e)}` }));
          },
        });
      });
      b.classList.toggle("is-disabled", blocked !== null);
      attachTooltip(b, blocked ?? `Merge ${wt.branch} into ${base}, then remove the worktree and branch`);
    }
```

`Icons.gitMerge` and `Icons.gitCommit` do not exist yet. Add them to `ui/src/icons/index.ts` next to `gitCompare` (~line 141), following the exact same pattern (lucide paths, 24×24 viewBox handled by the `svg()` helper):

```ts
  /** Git merge — branch joining back into its base. Lucide `git-merge`. */
  gitMerge: (o?: IconOptions): string =>
    svg(
      `<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 21V9a9 9 0 0 0 9 9"/>`,
      o,
    ),

  /** Git commit — a commit dot on its line. Lucide `git-commit-horizontal`. */
  gitCommit: (o?: IconOptions): string =>
    svg(
      `<circle cx="12" cy="12" r="3"/><line x1="3" x2="9" y1="12" y2="12"/><line x1="15" x2="21" y1="12" y2="12"/>`,
      o,
    ),
```

Include `ui/src/icons/index.ts` in this task's commit.

- [ ] **Step 3: Add the disabled style**

In `ui/src/worktrees/worktrees.css`, next to the other `.wt-act` modifiers (~line 193):

```css
.wt-act.is-disabled { opacity: 0.45; cursor: default; }
.wt-act.is-disabled:hover { background: none; }
```

(Class + click-guard instead of the `disabled` attribute so `attachTooltip` still receives hover events.)

- [ ] **Step 4: Verify**

Run: `npm run build 2>&1 | tail -5` and `npm test 2>&1 | tail -10` (both from repo root)
Expected: build clean, existing Vitest suites pass (no new UI tests — gating is trivial field derivation).

- [ ] **Step 5: Commit**

```bash
git add ui/src/worktrees/index.ts ui/src/worktrees/worktrees.css
git commit -m "feat(worktrees): Merge & end + Commit actions on detail panel"
```

---

### Task 4: Full-suite verification

**Files:** none new.

- [ ] **Step 1: Run everything**

From repo root:
```bash
cargo test -p covenant git_tools 2>&1 | tail -10
npm test 2>&1 | tail -10
npm run build 2>&1 | tail -5
```
Expected: all green. (Do NOT run the bare `cargo test --workspace` — telegram tests hang under the broad runner on macOS.)

- [ ] **Step 2: Commit any stragglers / fixups**

Only if verification forced changes; otherwise nothing to do.
