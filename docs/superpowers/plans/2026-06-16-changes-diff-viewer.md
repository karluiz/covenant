# Changes — git diff viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full-screen "Changes" surface that lists a repo's staged/unstaged files and renders each file's unified diff, with stage/unstage actions.

**Architecture:** Backend extends `crates/app/src/git_tools.rs` with a pure diff parser + four `spawn_blocking` Tauri commands over the existing `git()` helper. Frontend adds `ui/src/changes/` — a master-detail surface (file rail + diff pane) mounted like the Tasker board, opened from the status-bar git chip and ⌘⇧G.

**Tech Stack:** Rust (std `Command`, serde, `tempfile` dev-dep), TypeScript + Vite, Vitest, CodeMirror/`@lezer/highlight` (highlighting task only).

## Global Constraints

- Rust: `thiserror` in libs / `anyhow` at app boundary; no `unwrap()` outside `#[cfg(test)]`/`main()`; all git I/O via `spawn_blocking`; reuse the existing `git(cwd, &[&str]) -> Result<String, String>` helper in `git_tools.rs`.
- TypeScript: `strict: true`, no implicit any, no `as any` without justifying comment; every Tauri command wrapped in `ui/src/api.ts` with typed returns.
- UI copy English-only. No native tooltips (`element.title`) — route through `attachTooltip` from `ui/src/tooltip/tooltip.ts`.
- On True Dark/OLED, elevated/selected surfaces use neutral (text-primary) lifts, not accent tints.
- Commits: Conventional Commits; one feature per commit. Co-Author trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- Work happens in worktree `.worktrees/changes-diff` on branch `feat/changes-diff-viewer`.

---

## File Structure

- `crates/app/src/git_tools.rs` — add `diff` submodule (types + pure parsers) and `changes`/`file_diff`/`stage`/`unstage` fns + tests.
- `crates/app/src/lib.rs` — 4 `#[tauri::command]` wrappers + invoke_handler registration.
- `ui/src/api.ts` — TS interfaces mirroring serde output + 4 wrappers.
- `ui/src/changes/diff-view.ts` — render a `FileDiff` body to DOM.
- `ui/src/changes/rail.ts` — file list (groups, search, badges, stage/unstage, Viewed).
- `ui/src/changes/index.ts` — surface lifecycle, repo resolution, wiring.
- `ui/src/changes/highlight.ts` — optional per-line syntax highlight (Task 8).
- `ui/src/changes/changes.css` — styles incl. True Dark block.
- `ui/src/changes/*.test.ts` — Vitest.
- `ui/src/status/bar.ts` + `ui/src/main.ts` — entry points (Task 7).

---

## Task 1: Backend — diff types + pure parsers

**Files:**
- Modify: `crates/app/src/git_tools.rs` (append a `pub mod diff` + types)
- Test: inline `#[cfg(test)]` in `git_tools.rs`

**Interfaces:**
- Produces:
  - `parse_unified_diff(raw: &str, max_lines: usize) -> FileDiffBody`
  - `parse_numstat(raw: &str) -> Vec<NumStat>` where `NumStat { added: u32, removed: u32, binary: bool, path: String }`
  - Types: `FileChange`, `ChangeStatus`, `Changes`, `FileDiff`, `FileDiffBody`, `Hunk`, `DiffLine`, `LineKind`.

- [ ] **Step 1: Write failing tests**

Add to the `#[cfg(test)] mod tests` block in `git_tools.rs`:

```rust
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
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `cargo test -p covenant_app git_tools::tests::parse_ -- --nocapture`
Expected: FAIL — `diff` module / functions not found.

- [ ] **Step 3: Implement the `diff` module**

Append to `git_tools.rs` (above the `#[cfg(test)]` block):

```rust
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
                path: path.to_string(),
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
```

Note: the `+++`/`---` file header lines start with `+`/`-` but appear before the first `@@`, so the `hunks.is_empty()` guard skips them. Verify the test that includes `--- a/f.txt`/`+++ b/f.txt` still passes (those lines precede `@@`).

- [ ] **Step 4: Run tests — verify pass**

Run: `cargo test -p covenant_app git_tools::tests::parse_`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/git_tools.rs
git commit -m "feat(changes): pure git diff + numstat parsers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Backend — `changes()` and `file_diff()`

**Files:**
- Modify: `crates/app/src/git_tools.rs`
- Test: inline `#[cfg(test)]`

**Interfaces:**
- Consumes: `diff::*` from Task 1, the existing `git(cwd, &[&str])` helper.
- Produces:
  - `pub fn changes(cwd: &Path) -> Result<diff::Changes, String>`
  - `pub fn file_diff(cwd: &Path, path: &str, staged: bool) -> Result<diff::FileDiff, String>`

- [ ] **Step 1: Write failing tests**

Add to `#[cfg(test)] mod tests`. Reuse the temp-repo helper style from `spec_detector` tests:

```rust
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
```

- [ ] **Step 2: Run — verify fail**

Run: `cargo test -p covenant_app git_tools::tests::changes_ git_tools::tests::file_diff_`
Expected: FAIL — `changes`/`file_diff` not found.

- [ ] **Step 3: Implement**

Add to `git_tools.rs` (module scope, not inside `mod diff`):

```rust
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

pub fn file_diff(cwd: &Path, path: &str, staged: bool) -> Result<diff::FileDiff, String> {
    // Untracked file isn't known to git diff; use --no-index against /dev/null.
    let raw = if staged {
        git(cwd, &["diff", "--cached", "--", path])?
    } else {
        match git(cwd, &["diff", "--", path]) {
            Ok(s) if !s.trim().is_empty() => s,
            _ => {
                // --no-index returns exit code 1 on differences; capture stdout regardless.
                let out = Command::new("git").arg("-C").arg(cwd)
                    .args(["diff", "--no-index", "--", "/dev/null", path])
                    .output().map_err(|e| format!("git failed to start: {e}"))?;
                String::from_utf8_lossy(&out.stdout).to_string()
            }
        }
    };
    Ok(diff::FileDiff {
        path: path.to_string(),
        old_path: None,
        body: diff::parse_unified_diff(&raw, MAX_DIFF_LINES),
    })
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cargo test -p covenant_app git_tools::tests::changes_ git_tools::tests::file_diff_`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/git_tools.rs
git commit -m "feat(changes): git_changes + per-file diff backend

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Backend — stage/unstage + Tauri commands

**Files:**
- Modify: `crates/app/src/git_tools.rs`, `crates/app/src/lib.rs`
- Test: inline `#[cfg(test)]` in `git_tools.rs`

**Interfaces:**
- Consumes: `changes()`, `file_diff()`, `git()`.
- Produces: `pub fn stage(cwd, path) -> Result<diff::Changes>`, `pub fn unstage(cwd, path) -> Result<diff::Changes>`; Tauri commands `git_changes`, `git_file_diff`, `git_stage`, `git_unstage`.

- [ ] **Step 1: Write failing test**

```rust
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
```

- [ ] **Step 2: Run — verify fail**

Run: `cargo test -p covenant_app git_tools::tests::stage_then_unstage`
Expected: FAIL — `stage`/`unstage` not found.

- [ ] **Step 3: Implement fns + commands**

Add to `git_tools.rs`:

```rust
pub fn stage(cwd: &Path, path: &str) -> Result<diff::Changes, String> {
    git(cwd, &["add", "--", path])?;
    changes(cwd)
}

pub fn unstage(cwd: &Path, path: &str) -> Result<diff::Changes, String> {
    // `restore --staged` is a no-op-safe unstage on any git >= 2.23.
    git(cwd, &["restore", "--staged", "--", path])?;
    changes(cwd)
}
```

Add to `lib.rs` near `git_switch_branch` (each runs on `spawn_blocking`, matching `git_repo_summary`):

```rust
#[tauri::command]
async fn git_changes(cwd: String) -> Result<git_tools::diff::Changes, String> {
    let path = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::changes(&path))
        .await
        .map_err(|e| format!("git_changes join: {e}"))?
}

#[tauri::command]
async fn git_file_diff(cwd: String, path: String, staged: bool) -> Result<git_tools::diff::FileDiff, String> {
    let cwd = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::file_diff(&cwd, &path, staged))
        .await
        .map_err(|e| format!("git_file_diff join: {e}"))?
}

#[tauri::command]
async fn git_stage(cwd: String, path: String) -> Result<git_tools::diff::Changes, String> {
    let cwd = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::stage(&cwd, &path))
        .await
        .map_err(|e| format!("git_stage join: {e}"))?
}

#[tauri::command]
async fn git_unstage(cwd: String, path: String) -> Result<git_tools::diff::Changes, String> {
    let cwd = std::path::PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::unstage(&cwd, &path))
        .await
        .map_err(|e| format!("git_unstage join: {e}"))?
}
```

Register in the `tauri::generate_handler![...]` list (next to `git_switch_branch`):

```rust
            git_repo_summary,
            git_switch_branch,
            git_changes,
            git_file_diff,
            git_stage,
            git_unstage,
```

- [ ] **Step 4: Run — verify pass + build**

Run: `cargo test -p covenant_app git_tools::tests::stage_then_unstage && cargo check -p covenant_app`
Expected: test PASS, `cargo check` clean.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/git_tools.rs crates/app/src/lib.rs
git commit -m "feat(changes): stage/unstage + tauri commands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Frontend — typed API wrappers

**Files:**
- Modify: `ui/src/api.ts`

**Interfaces:**
- Produces (TS, mirrors serde camelCase from Tasks 1–3):
  ```ts
  type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";
  type LineKind = "context" | "add" | "del";
  interface DiffLine { kind: LineKind; oldNo: number | null; newNo: number | null; text: string; }
  interface Hunk { oldStart: number; newStart: number; header: string; lines: DiffLine[]; }
  type FileDiffBody =
    | { kind: "hunks"; hunks: Hunk[] }
    | { kind: "binary"; sizeBytes: number }
    | { kind: "tooLarge"; lineCount: number };
  interface FileChange { path: string; oldPath: string | null; status: ChangeStatus; added: number; removed: number; binary: boolean; }
  interface Changes { staged: FileChange[]; unstaged: FileChange[]; }
  interface FileDiff { path: string; oldPath: string | null; body: FileDiffBody; }
  ```
- Wrappers: `gitChanges`, `gitFileDiff`, `gitStage`, `gitUnstage`.

- [ ] **Step 1: Add interfaces + wrappers**

Append to `ui/src/api.ts` (after `gitSwitchBranch`):

```ts
export type ChangeStatus = "modified" | "added" | "deleted" | "renamed" | "untracked";
export type LineKind = "context" | "add" | "del";
export interface DiffLine { kind: LineKind; oldNo: number | null; newNo: number | null; text: string; }
export interface Hunk { oldStart: number; newStart: number; header: string; lines: DiffLine[]; }
export type FileDiffBody =
  | { kind: "hunks"; hunks: Hunk[] }
  | { kind: "binary"; sizeBytes: number }
  | { kind: "tooLarge"; lineCount: number };
export interface FileChange {
  path: string; oldPath: string | null; status: ChangeStatus;
  added: number; removed: number; binary: boolean;
}
export interface Changes { staged: FileChange[]; unstaged: FileChange[]; }
export interface FileDiff { path: string; oldPath: string | null; body: FileDiffBody; }

export async function gitChanges(cwd: string): Promise<Changes> {
  return invoke<Changes>("git_changes", { cwd });
}
export async function gitFileDiff(cwd: string, path: string, staged: boolean): Promise<FileDiff> {
  return invoke<FileDiff>("git_file_diff", { cwd, path, staged });
}
export async function gitStage(cwd: string, path: string): Promise<Changes> {
  return invoke<Changes>("git_stage", { cwd, path });
}
export async function gitUnstage(cwd: string, path: string): Promise<Changes> {
  return invoke<Changes>("git_unstage", { cwd, path });
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(changes): typed api wrappers for git diff commands

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Frontend — diff renderer

**Files:**
- Create: `ui/src/changes/diff-view.ts`, `ui/src/changes/diff-view.test.ts`

**Interfaces:**
- Consumes: `FileDiff`, `FileDiffBody`, `Hunk` from `api.ts`.
- Produces: `renderDiffBody(file: FileDiff): HTMLElement`.

- [ ] **Step 1: Write failing tests**

`ui/src/changes/diff-view.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { renderDiffBody } from "./diff-view";
import type { FileDiff } from "../api";

const hunkFile: FileDiff = {
  path: "f.txt", oldPath: null,
  body: { kind: "hunks", hunks: [{
    oldStart: 1, newStart: 1, header: "",
    lines: [
      { kind: "context", oldNo: 1, newNo: 1, text: "ctx" },
      { kind: "del", oldNo: 2, newNo: null, text: "old" },
      { kind: "add", oldNo: null, newNo: 2, text: "new" },
    ],
  }] },
};

describe("renderDiffBody", () => {
  it("renders one row per diff line with kind classes", () => {
    const el = renderDiffBody(hunkFile);
    expect(el.querySelectorAll(".cd-line").length).toBe(3);
    expect(el.querySelector(".cd-line--add")?.textContent).toContain("new");
    expect(el.querySelector(".cd-line--del")?.textContent).toContain("old");
  });

  it("shows old/new line numbers in the gutter", () => {
    const el = renderDiffBody(hunkFile);
    const ctx = el.querySelector(".cd-line--context")!;
    expect(ctx.querySelector(".cd-num-old")?.textContent).toBe("1");
    expect(ctx.querySelector(".cd-num-new")?.textContent).toBe("1");
  });

  it("renders a binary placeholder", () => {
    const el = renderDiffBody({ path: "x.bmp", oldPath: null, body: { kind: "binary", sizeBytes: 12000 } });
    expect(el.querySelector(".cd-binary")?.textContent).toMatch(/binary/i);
  });

  it("renders a too-large notice", () => {
    const el = renderDiffBody({ path: "big.txt", oldPath: null, body: { kind: "tooLarge", lineCount: 9000 } });
    expect(el.querySelector(".cd-toolarge")?.textContent).toMatch(/9000/);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd ui && npx vitest run src/changes/diff-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `diff-view.ts`**

```ts
import type { FileDiff, Hunk } from "../api";

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function renderHunk(h: Hunk): HTMLElement {
  const wrap = el("div", "cd-hunk");
  if (h.header) wrap.appendChild(el("div", "cd-hunk-header", h.header));
  for (const line of h.lines) {
    const row = el("div", `cd-line cd-line--${line.kind}`);
    row.appendChild(el("span", "cd-num cd-num-old", line.oldNo === null ? "" : String(line.oldNo)));
    row.appendChild(el("span", "cd-num cd-num-new", line.newNo === null ? "" : String(line.newNo)));
    const marker = line.kind === "add" ? "+" : line.kind === "del" ? "-" : " ";
    row.appendChild(el("span", "cd-marker", marker));
    row.appendChild(el("span", "cd-text", line.text));
    wrap.appendChild(row);
  }
  return wrap;
}

export function renderDiffBody(file: FileDiff): HTMLElement {
  const root = el("div", "cd-diff");
  root.dataset.path = file.path;
  const body = file.body;
  if (body.kind === "binary") {
    const kb = Math.max(1, Math.round(body.sizeBytes / 1024));
    root.appendChild(el("div", "cd-binary", `[binary] ${file.path} — ${kb} KB (no text diff)`));
    return root;
  }
  if (body.kind === "tooLarge") {
    root.appendChild(el("div", "cd-toolarge", `Diff too large to display (${body.lineCount} lines).`));
    return root;
  }
  for (const h of body.hunks) root.appendChild(renderHunk(h));
  return root;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd ui && npx vitest run src/changes/diff-view.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/changes/diff-view.ts ui/src/changes/diff-view.test.ts
git commit -m "feat(changes): unified diff renderer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Frontend — file rail

**Files:**
- Create: `ui/src/changes/rail.ts`, `ui/src/changes/rail.test.ts`

**Interfaces:**
- Consumes: `Changes`, `FileChange` from `api.ts`; `resolveFileIcon` from `../structure/file-icons`.
- Produces:
  ```ts
  interface RailHandlers {
    onSelect(path: string, staged: boolean): void;
    onStage(path: string): void;
    onUnstage(path: string): void;
  }
  function renderRail(changes: Changes, handlers: RailHandlers, filter?: string): HTMLElement;
  ```

- [ ] **Step 1: Write failing tests**

`ui/src/changes/rail.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";
import { renderRail } from "./rail";
import type { Changes } from "../api";

const changes: Changes = {
  staged: [{ path: "a.ts", oldPath: null, status: "added", added: 8, removed: 0, binary: false }],
  unstaged: [
    { path: "src/bar.ts", oldPath: null, status: "modified", added: 43, removed: 2, binary: false },
    { path: "x.bmp", oldPath: null, status: "untracked", added: 0, removed: 0, binary: true },
  ],
};
const noop = { onSelect() {}, onStage() {}, onUnstage() {} };

describe("renderRail", () => {
  it("renders Staged and Unstaged groups with counts", () => {
    const el = renderRail(changes, noop);
    const groups = el.querySelectorAll(".cd-group-title");
    expect(groups[0].textContent).toMatch(/Staged.*1/);
    expect(groups[1].textContent).toMatch(/Unstaged.*2/);
  });

  it("shows +/- counts and binary tag", () => {
    const el = renderRail(changes, noop);
    expect(el.textContent).toContain("+43");
    expect(el.textContent).toMatch(/binary/i);
  });

  it("filters rows by substring", () => {
    const el = renderRail(changes, noop, "bar");
    const rows = el.querySelectorAll(".cd-file");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("bar.ts");
  });

  it("calls onStage from an unstaged row's stage button", () => {
    const onStage = vi.fn();
    const el = renderRail(changes, { ...noop, onStage });
    const row = [...el.querySelectorAll<HTMLElement>(".cd-file")].find(r => r.textContent?.includes("bar.ts"))!;
    row.querySelector<HTMLElement>(".cd-stage-btn")!.click();
    expect(onStage).toHaveBeenCalledWith("src/bar.ts");
  });

  it("calls onSelect when a row is clicked", () => {
    const onSelect = vi.fn();
    const el = renderRail(changes, { ...noop, onSelect });
    const row = [...el.querySelectorAll<HTMLElement>(".cd-file")].find(r => r.textContent?.includes("a.ts"))!;
    row.click();
    expect(onSelect).toHaveBeenCalledWith("a.ts", true);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd ui && npx vitest run src/changes/rail.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `rail.ts`**

```ts
import type { Changes, FileChange } from "../api";

export interface RailHandlers {
  onSelect(path: string, staged: boolean): void;
  onStage(path: string): void;
  onUnstage(path: string): void;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

const STATUS_LETTER: Record<FileChange["status"], string> = {
  modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "?",
};

function row(f: FileChange, staged: boolean, h: RailHandlers): HTMLElement {
  const el = document.createElement("div");
  el.className = "cd-file";
  el.dataset.path = f.path;
  el.addEventListener("click", () => h.onSelect(f.path, staged));

  const name = document.createElement("span");
  name.className = "cd-file-name";
  name.textContent = basename(f.path);
  el.appendChild(name);

  const status = document.createElement("span");
  status.className = `cd-status cd-status--${f.status}`;
  status.textContent = STATUS_LETTER[f.status];
  el.appendChild(status);

  const counts = document.createElement("span");
  counts.className = "cd-counts";
  counts.textContent = f.binary ? "binary" : `+${f.added} −${f.removed}`;
  el.appendChild(counts);

  const btn = document.createElement("button");
  btn.className = "cd-stage-btn";
  btn.textContent = staged ? "Unstage" : "Stage";
  btn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    staged ? h.onUnstage(f.path) : h.onStage(f.path);
  });
  el.appendChild(btn);
  return el;
}

function group(title: string, files: FileChange[], staged: boolean, h: RailHandlers): HTMLElement {
  const g = document.createElement("div");
  g.className = "cd-group";
  const t = document.createElement("div");
  t.className = "cd-group-title";
  t.textContent = `${title} (${files.length})`;
  g.appendChild(t);
  for (const f of files) g.appendChild(row(f, staged, h));
  return g;
}

export function renderRail(changes: Changes, handlers: RailHandlers, filter = ""): HTMLElement {
  const f = filter.trim().toLowerCase();
  const match = (x: FileChange) => !f || x.path.toLowerCase().includes(f);
  const root = document.createElement("div");
  root.className = "cd-rail";
  root.appendChild(group("Staged", changes.staged.filter(match), true, handlers));
  root.appendChild(group("Unstaged", changes.unstaged.filter(match), false, handlers));
  return root;
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd ui && npx vitest run src/changes/rail.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/changes/rail.ts ui/src/changes/rail.test.ts
git commit -m "feat(changes): file rail with groups + stage actions

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: Frontend — surface lifecycle, CSS, entry points

**Files:**
- Create: `ui/src/changes/index.ts`, `ui/src/changes/index.test.ts`, `ui/src/changes/changes.css`
- Modify: `ui/src/main.ts` (mount + ⌘⇧G), `ui/src/status/bar.ts` ("View changes" action), `ui/src/styles.css` (import)

**Interfaces:**
- Consumes: `gitChanges`, `gitFileDiff`, `gitStage`, `gitUnstage` from `api.ts`; `renderRail`, `renderDiffBody`.
- Produces:
  ```ts
  class ChangesSurface {
    constructor(host: HTMLElement);
    async open(repoRoot: string): Promise<void>;
    close(): void;
    get isOpen(): boolean;
  }
  ```

- [ ] **Step 1: Write failing test** (lifecycle, with mocked api)

`ui/src/changes/index.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../api", () => ({
  gitChanges: vi.fn(async () => ({
    staged: [],
    unstaged: [{ path: "f.txt", oldPath: null, status: "modified", added: 1, removed: 0, binary: false }],
  })),
  gitFileDiff: vi.fn(async () => ({
    path: "f.txt", oldPath: null,
    body: { kind: "hunks", hunks: [{ oldStart: 1, newStart: 1, header: "", lines: [
      { kind: "add", oldNo: null, newNo: 1, text: "x" }] }] },
  })),
  gitStage: vi.fn(), gitUnstage: vi.fn(),
}));

import { ChangesSurface } from "./index";

describe("ChangesSurface", () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement("div"); document.body.appendChild(host); });

  it("opens, sets fullscreen flag, and renders the rail", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");
    expect(s.isOpen).toBe(true);
    expect(document.body.classList.contains("changes-fullscreen")).toBe(true);
    expect(host.querySelector(".cd-file")).toBeTruthy();
  });

  it("close clears the fullscreen flag", async () => {
    const s = new ChangesSurface(host);
    await s.open("/repo");
    s.close();
    expect(s.isOpen).toBe(false);
    expect(document.body.classList.contains("changes-fullscreen")).toBe(false);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd ui && npx vitest run src/changes/index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `index.ts`**

```ts
import { gitChanges, gitFileDiff, gitStage, gitUnstage, type Changes } from "../api";
import { renderRail, type RailHandlers } from "./rail";
import { renderDiffBody } from "./diff-view";

export class ChangesSurface {
  private host: HTMLElement;
  private repoRoot = "";
  private changes: Changes = { staged: [], unstaged: [] };
  private filter = "";
  private open_ = false;
  private railEl: HTMLElement | null = null;
  private diffEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;

  constructor(host: HTMLElement) { this.host = host; }

  get isOpen(): boolean { return this.open_; }

  async open(repoRoot: string): Promise<void> {
    this.repoRoot = repoRoot;
    this.open_ = true;
    document.body.classList.add("changes-fullscreen");
    this.mountShell();
    await this.refresh();
  }

  close(): void {
    this.open_ = false;
    document.body.classList.remove("changes-fullscreen");
    this.host.innerHTML = "";
  }

  private mountShell(): void {
    this.host.innerHTML = "";
    const frame = document.createElement("div");
    frame.className = "cd-frame";

    const left = document.createElement("div");
    left.className = "cd-left";
    const search = document.createElement("input");
    search.className = "cd-search";
    search.placeholder = "Search files…";
    search.addEventListener("input", () => { this.filter = search.value; this.renderRailInto(); });
    this.searchEl = search;
    const railHost = document.createElement("div");
    railHost.className = "cd-rail-host";
    this.railEl = railHost;
    left.append(search, railHost);

    const right = document.createElement("div");
    right.className = "cd-right";
    const diffHost = document.createElement("div");
    diffHost.className = "cd-diff-host";
    this.diffEl = diffHost;
    right.appendChild(diffHost);

    const close = document.createElement("button");
    close.className = "cd-close";
    close.textContent = "Close";
    close.addEventListener("click", () => this.close());
    right.prepend(close);

    frame.append(left, right);
    this.host.appendChild(frame);
  }

  private async refresh(): Promise<void> {
    this.changes = await gitChanges(this.repoRoot);
    this.renderRailInto();
  }

  private renderRailInto(): void {
    if (!this.railEl) return;
    const handlers: RailHandlers = {
      onSelect: (path, staged) => void this.showDiff(path, staged),
      onStage: (path) => void this.stage(path),
      onUnstage: (path) => void this.unstage(path),
    };
    this.railEl.replaceChildren(renderRail(this.changes, handlers, this.filter));
  }

  private async showDiff(path: string, staged: boolean): Promise<void> {
    if (!this.diffEl) return;
    const file = await gitFileDiff(this.repoRoot, path, staged);
    this.diffEl.replaceChildren(renderDiffBody(file));
  }

  private async stage(path: string): Promise<void> {
    this.changes = await gitStage(this.repoRoot, path);
    this.renderRailInto();
  }

  private async unstage(path: string): Promise<void> {
    this.changes = await gitUnstage(this.repoRoot, path);
    this.renderRailInto();
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run: `cd ui && npx vitest run src/changes/index.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write CSS**

`ui/src/changes/changes.css`:

```css
body.changes-fullscreen .cd-frame {
  position: fixed; inset: 0; z-index: 60;
  display: grid; grid-template-columns: 320px 1fr;
  background: var(--bg-primary); color: var(--text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
}
.cd-left { border-right: 1px solid var(--border-subtle); overflow: auto; padding: 8px; }
.cd-search { width: 100%; padding: 6px 8px; margin-bottom: 8px;
  background: var(--bg-elevated); color: var(--text-primary);
  border: 1px solid var(--border-subtle); border-radius: 6px; }
.cd-group-title { font-size: 11px; text-transform: uppercase; opacity: .7; margin: 8px 4px; }
.cd-file { display: flex; align-items: center; gap: 8px; padding: 4px 8px;
  border-radius: 6px; cursor: pointer; }
.cd-file:hover { background: var(--bg-hover); }
.cd-file-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cd-status--modified { color: #d7a700; }
.cd-status--added, .cd-status--untracked { color: #3fb950; }
.cd-status--deleted { color: #f85149; }
.cd-counts { font-size: 11px; opacity: .8; }
.cd-stage-btn { opacity: 0; font-size: 11px; }
.cd-file:hover .cd-stage-btn { opacity: 1; }
.cd-right { display: flex; flex-direction: column; overflow: auto; }
.cd-close { align-self: flex-end; margin: 8px; }
.cd-diff-host { padding: 0 8px 24px; }
.cd-line { display: grid; grid-template-columns: 48px 48px 16px 1fr;
  white-space: pre; font-size: 12px; line-height: 1.5; }
.cd-num { text-align: right; padding-right: 8px; opacity: .5; user-select: none; }
.cd-line--add { background: rgba(63,185,80,.15); }
.cd-line--del { background: rgba(248,81,73,.15); }
.cd-hunk-header { opacity: .6; padding: 8px 0 2px; }
.cd-binary, .cd-toolarge { opacity: .7; padding: 24px 8px; }

/* True Dark / OLED: neutral lifts, no accent tint on selected surfaces */
body.theme-true-dark.changes-fullscreen .cd-file:hover { background: rgba(255,255,255,.06); }
```

Import it. In `ui/src/styles.css` add near the other module imports:

```css
@import "./changes/changes.css";
```

- [ ] **Step 6: Wire entry points**

In `ui/src/main.ts`: instantiate one `ChangesSurface` against a host element and open it from a ⌘⇧G handler, resolving the repo root via the focused tab's cwd + `gitRepoSummary`. Add (adapt to main.ts's existing tab/keydown structure):

```ts
import { ChangesSurface } from "./changes/index";
import { gitRepoSummary } from "./api";

const changesHost = document.createElement("div");
document.body.appendChild(changesHost);
const changesSurface = new ChangesSurface(changesHost);

async function openChanges(): Promise<void> {
  const cwd = activeTabCwd(); // existing helper that returns the focused tab's cwd
  if (!cwd) return;
  try {
    const summary = await gitRepoSummary(cwd);
    await changesSurface.open(summary.repoRoot);
  } catch { /* not a git repo — no-op */ }
}

window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "g") {
    e.preventDefault();
    if (changesSurface.isOpen) changesSurface.close(); else void openChanges();
  }
});
```

In `ui/src/status/bar.ts`: in the existing branch popover, add a "View changes" action that calls the same `openChanges` (export it from main.ts or pass a callback the bar already receives — follow the existing popover-action wiring, e.g. the `onSwitchBranch` callback pattern).

- [ ] **Step 7: Verify build + full UI test run**

Run: `cd ui && npx tsc --noEmit && npx vitest run src/changes`
Expected: typecheck clean, all `src/changes` tests PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/changes ui/src/styles.css ui/src/main.ts ui/src/status/bar.ts
git commit -m "feat(changes): full-screen surface + ⌘⇧G entry + status-bar action

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Frontend — per-line syntax highlighting (deferrable enhancement)

> Integration-risk task. Diff already renders without it; ship Tasks 1–7 first. If the lezer wiring fights you, leave the plain-text renderer in place — this is purely additive.

**Files:**
- Create: `ui/src/changes/highlight.ts`, `ui/src/changes/highlight.test.ts`
- Modify: `ui/src/changes/diff-view.ts` (apply highlight to `.cd-text`)

**Interfaces:**
- Consumes: `languageForPath` from `../structure/languages` (returns a CodeMirror `Extension | null`).
- Produces: `highlightInto(textEl: HTMLElement, code: string, path: string): void` — replaces `textEl`'s plain text with token `<span>`s; on any failure or unknown language, leaves the plain text untouched (idempotent, lossless fallback).

- [ ] **Step 1: Write failing tests**

```ts
import { describe, it, expect } from "vitest";
import { highlightInto } from "./highlight";

describe("highlightInto", () => {
  it("leaves text intact for unknown languages", () => {
    const el = document.createElement("span");
    el.textContent = "const x = 1";
    highlightInto(el, "const x = 1", "file.unknownext");
    expect(el.textContent).toBe("const x = 1");
  });

  it("preserves the full text content for a known language", () => {
    const el = document.createElement("span");
    const code = "const x = 1;";
    el.textContent = code;
    highlightInto(el, code, "a.ts");
    // tokens may add spans, but concatenated text must equal the source
    expect(el.textContent).toBe(code);
  });
});
```

- [ ] **Step 2: Run — verify fail**

Run: `cd ui && npx vitest run src/changes/highlight.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `highlight.ts`**

Use `@lezer/highlight`'s `highlightTree` over the language parser. `languageForPath` returns an `Extension`; extract the `Language` via CodeMirror's `Prec`/`LanguageSupport` is brittle, so resolve the parser directly through `@codemirror/language`'s `language` facet by constructing an `EditorState`. Keep it defensive — any throw → bail to plain text:

```ts
import { EditorState } from "@codemirror/state";
import { language as languageFacet, defaultHighlightStyle } from "@codemirror/language";
import { highlightTree } from "@lezer/highlight";
import { languageForPath } from "../structure/languages";

export function highlightInto(textEl: HTMLElement, code: string, path: string): void {
  try {
    const ext = languageForPath(path, code);
    if (!ext) return;
    const state = EditorState.create({ doc: code, extensions: [ext] });
    const lang = state.facet(languageFacet);
    if (!lang) return;
    const tree = lang.parser.parse(code);
    const frag = document.createDocumentFragment();
    let pos = 0;
    const put = (from: number, to: number, cls: string) => {
      if (from > pos) frag.appendChild(document.createTextNode(code.slice(pos, from)));
      const span = document.createElement("span");
      if (cls) span.className = cls;
      span.textContent = code.slice(from, to);
      frag.appendChild(span);
      pos = to;
    };
    highlightTree(tree, defaultHighlightStyle, (from, to, classes) => put(from, to, classes));
    if (pos < code.length) frag.appendChild(document.createTextNode(code.slice(pos)));
    // only swap if we actually produced output covering the text
    if (frag.textContent === code) textEl.replaceChildren(frag);
  } catch {
    /* keep plain text */
  }
}
```

In `diff-view.ts`, replace the plain `.cd-text` creation with a highlight-applying variant:

```ts
import { highlightInto } from "./highlight";
// inside renderHunk, where the text span is built:
const textSpan = el("span", "cd-text", line.text);
// path comes from the FileDiff; thread it through renderHunk(h, path)
highlightInto(textSpan, line.text, path);
row.appendChild(textSpan);
```

Thread `file.path` from `renderDiffBody` → `renderHunk(h, file.path)`.

- [ ] **Step 4: Run — verify pass**

Run: `cd ui && npx vitest run src/changes`
Expected: all `src/changes` tests PASS (highlight + unchanged diff-view tests — text content invariants hold).

- [ ] **Step 5: Commit**

```bash
git add ui/src/changes
git commit -m "feat(changes): per-line syntax highlighting with plain-text fallback

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Final verification

- [ ] `cargo test -p covenant_app git_tools` — all backend tests pass.
- [ ] `cd ui && npx tsc --noEmit && npx vitest run src/changes` — typecheck + all surface tests pass.
- [ ] Manual (use the `run` / `respawn` skill): open Covenant in a dirty repo, hit ⌘⇧G, confirm rail lists staged/unstaged files, clicking renders the diff, Stage/Unstage moves files between groups, a `.bmp` shows the binary placeholder (not a garbage dump).
- [ ] Update memory: add a `project_changes_diff_viewer.md` entry.
