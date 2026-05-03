# Structure (file tree sidebar) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Zed-style file tree as a third sidebar view, with a minimal in-app textarea editor for one-file edits — the "escape hatch" so users don't leave Covenant for a one-line change.

**Architecture:** Thin Rust filesystem backend (3 Tauri commands: `list_dir`, `read_file_text`, `write_file_text`) using the `ignore` crate for `.gitignore` parsing on top of a hardcoded ignore set. Frontend tree component swaps with Blocks via a small sidebar nav; clicking a file opens an in-app `<textarea>` editor that splits horizontally with the terminal.

**Tech Stack:** Rust (`ignore` crate, `tokio::task::spawn_blocking` for fs ops), TypeScript (vanilla, no framework), Tauri 2 IPC.

**Resolved open questions** (per user confirmation 2026-05-02):
- Editor pane: in-app `<textarea>`, NOT shell-out.
- Refresh: manual button + auto re-list on folder expand. No watcher.
- Performance: lazy-load per directory, soft cap 5k visible nodes.
- Layout: editor splits horizontally with terminal (sidebar | editor | terminal).
- `ignore` crate: added to workspace deps.

---

## File Structure

**Create:**
- `crates/app/src/structure.rs` (~220 lines) — `list_dir`, `read_file_text`, `write_file_text` Tauri commands + helpers; gitignore via `ignore` crate.
- `ui/src/structure/tree.ts` (~320 lines) — tree component (lazy-load per folder, expand state in localStorage).
- `ui/src/structure/editor.ts` (~220 lines) — textarea editor + save flow + size guard.

**Modify:**
- `Cargo.toml` (workspace) — add `ignore` to `[workspace.dependencies]`.
- `crates/app/Cargo.toml` — add `ignore = { workspace = true }`.
- `crates/app/src/lib.rs` — register 3 new commands + add `mod structure;`.
- `ui/src/api.ts` — wrap 3 new Tauri commands.
- `ui/src/main.ts` — no-op (TabManager owns the sidebar nav).
- `ui/src/tabs/manager.ts` — mount sidebar nav, structure tree, editor pane per tab; refit xterm on editor show/hide.
- `ui/src/styles.css` — tree styles, editor styles, sidebar nav strip styles (≤ 200 lines appended).

**DO NOT touch:**
- `ui/src/blocks/`, `ui/src/recall/`, `ui/src/operator/`, `ui/src/aom/`, `ui/src/settings/`.
- `crates/agent/`, `crates/blocks/`, `crates/session/`, `crates/pty/`.

---

## Task 1: Add `ignore` crate to workspace dependencies

**Files:**
- Modify: `Cargo.toml` (workspace)
- Modify: `crates/app/Cargo.toml`

- [ ] **Step 1: Add to workspace deps**

In `Cargo.toml`, add inside `[workspace.dependencies]` block (after the existing `regex = "1"` line):

```toml
ignore = "0.4"
```

- [ ] **Step 2: Add to app crate**

In `crates/app/Cargo.toml`, add inside `[dependencies]` block (after `strip-ansi-escapes = { workspace = true }`):

```toml
ignore = { workspace = true }
```

- [ ] **Step 3: Verify the build resolves**

Run: `cargo check -p covenant`
Expected: clean build, downloads `ignore` crate.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml Cargo.lock crates/app/Cargo.toml
git commit -m "chore(deps): add ignore crate for .gitignore-aware tree walks"
```

---

## Task 2: `structure.rs` skeleton + `list_dir` with hardcoded ignore set (no .gitignore yet)

**Files:**
- Create: `crates/app/src/structure.rs`
- Test: inline `#[cfg(test)] mod tests` in same file

- [ ] **Step 1: Write failing test for hardcoded ignore set**

Create `crates/app/src/structure.rs` with this content:

```rust
//! Structure sidebar (3.3) — filesystem backend for the file tree.
//!
//! Three Tauri commands: `structure_list_dir`, `structure_read_file`,
//! `structure_write_file`. All fs ops run via `spawn_blocking` from the
//! command handlers in `lib.rs`. This module is pure functions over
//! `Path` arguments.

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

/// Names we always skip regardless of `.gitignore`. Matches by exact
/// basename — these are universal noise sources.
const HARDCODED_IGNORES: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    "__pycache__",
];

pub fn list_dir(cwd: &Path) -> Result<Vec<DirEntry>, String> {
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }
    let mut out = Vec::new();
    let read = std::fs::read_dir(cwd).map_err(|e| format!("read_dir: {e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if HARDCODED_IGNORES.iter().any(|n| *n == name) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_symlink = metadata.file_type().is_symlink();
        let kind = if metadata.is_dir() {
            EntryKind::Dir
        } else if metadata.is_file() {
            EntryKind::File
        } else {
            continue;
        };
        out.push(DirEntry {
            name,
            path: entry.path().display().to_string(),
            kind,
            is_symlink,
        });
    }
    out.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Dir, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_tree(tmp: &TempDir, names: &[&str]) {
        for n in names {
            let p = tmp.path().join(n);
            if n.ends_with('/') {
                fs::create_dir_all(&p).unwrap();
            } else {
                if let Some(parent) = p.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                fs::write(&p, b"").unwrap();
            }
        }
    }

    #[test]
    fn skips_hardcoded_ignores() {
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &["src/", "node_modules/", ".git/", "target/", "README.md"]);
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"]);
    }

    #[test]
    fn folders_first_then_alpha() {
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &["b.txt", "a.txt", "z_dir/", "a_dir/"]);
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_dir", "z_dir", "a.txt", "b.txt"]);
    }

    #[test]
    fn err_on_non_dir() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("file.txt");
        fs::write(&f, b"").unwrap();
        assert!(list_dir(&f).is_err());
    }
}
```

Add `mod structure;` to `crates/app/src/lib.rs` after `mod storage;`:

```rust
mod storage;
mod structure;
mod summarizer;
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p covenant structure::tests`
Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/structure.rs crates/app/src/lib.rs
git commit -m "feat(structure): list_dir with hardcoded ignore set"
```

---

## Task 3: Add `.gitignore` honoring to `list_dir`

**Files:**
- Modify: `crates/app/src/structure.rs`

- [ ] **Step 1: Write failing test for .gitignore**

Add this test inside the `#[cfg(test)] mod tests` block:

```rust
#[test]
fn honors_gitignore() {
    let tmp = TempDir::new().unwrap();
    make_tree(&tmp, &[
        "src/main.rs",
        "build/output.bin",
        "secret.env",
        "README.md",
        ".gitignore",
    ]);
    fs::write(tmp.path().join(".gitignore"), "build/\n*.env\n").unwrap();
    let entries = list_dir(tmp.path()).unwrap();
    let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
    // .gitignore itself is shown (gitignore patterns don't hide it),
    // but build/ and secret.env are filtered.
    assert!(names.contains(&"src"));
    assert!(names.contains(&"README.md"));
    assert!(names.contains(&".gitignore"));
    assert!(!names.contains(&"build"));
    assert!(!names.contains(&"secret.env"));
}

#[test]
fn gitignore_only_applies_inside_repo_or_with_root() {
    // No .gitignore = nothing extra is filtered (only hardcoded set).
    let tmp = TempDir::new().unwrap();
    make_tree(&tmp, &["foo.log", "bar.txt"]);
    let entries = list_dir(tmp.path()).unwrap();
    let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
    assert!(names.contains(&"foo.log"));
    assert!(names.contains(&"bar.txt"));
}
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `cargo test -p covenant structure::tests::honors_gitignore`
Expected: FAIL — `build` and `secret.env` still appear.

- [ ] **Step 3: Replace `list_dir` to use `ignore::gitignore::Gitignore`**

Replace the existing `list_dir` function in `crates/app/src/structure.rs` with:

```rust
pub fn list_dir(cwd: &Path) -> Result<Vec<DirEntry>, String> {
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }
    // Build a one-shot gitignore matcher rooted at this dir. The
    // `ignore` crate's WalkBuilder is overkill for one-level reads —
    // we just want the matcher. Errors loading .gitignore are
    // soft-fail: we still list the directory, just without those rules.
    let gi_path = cwd.join(".gitignore");
    let (matcher, _gi_err) = ignore::gitignore::Gitignore::new(&gi_path);
    let mut out = Vec::new();
    let read = std::fs::read_dir(cwd).map_err(|e| format!("read_dir: {e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if HARDCODED_IGNORES.iter().any(|n| *n == name) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_symlink = metadata.file_type().is_symlink();
        let kind = if metadata.is_dir() {
            EntryKind::Dir
        } else if metadata.is_file() {
            EntryKind::File
        } else {
            continue;
        };
        let abs = entry.path();
        if matcher.matched(&abs, matches!(kind, EntryKind::Dir)).is_ignore() {
            continue;
        }
        out.push(DirEntry {
            name,
            path: abs.display().to_string(),
            kind,
            is_symlink,
        });
    }
    out.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Dir, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cargo test -p covenant structure::tests`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/structure.rs
git commit -m "feat(structure): honor .gitignore via ignore crate"
```

---

## Task 4: `read_file_text` with size guard + binary detection

**Files:**
- Modify: `crates/app/src/structure.rs`

- [ ] **Step 1: Write failing tests**

Add to the existing test module:

```rust
#[test]
fn read_small_text_file() {
    let tmp = TempDir::new().unwrap();
    let f = tmp.path().join("hello.txt");
    fs::write(&f, "hello world\n").unwrap();
    let result = read_file_text(&f, 1024 * 1024).unwrap();
    assert_eq!(result.kind, ReadKind::Text);
    assert_eq!(result.content.as_deref(), Some("hello world\n"));
}

#[test]
fn read_too_large_returns_size_marker() {
    let tmp = TempDir::new().unwrap();
    let f = tmp.path().join("big.bin");
    fs::write(&f, vec![0u8; 2048]).unwrap();
    let result = read_file_text(&f, 1024).unwrap();
    assert_eq!(result.kind, ReadKind::TooLarge);
    assert!(result.content.is_none());
    assert_eq!(result.size_bytes, 2048);
}

#[test]
fn read_binary_returns_binary_marker() {
    let tmp = TempDir::new().unwrap();
    let f = tmp.path().join("a.bin");
    // Bytes including a NUL — our heuristic treats this as binary.
    fs::write(&f, b"abc\x00def").unwrap();
    let result = read_file_text(&f, 1024 * 1024).unwrap();
    assert_eq!(result.kind, ReadKind::Binary);
    assert!(result.content.is_none());
}

#[test]
fn read_missing_file_errors() {
    let tmp = TempDir::new().unwrap();
    let f = tmp.path().join("nope.txt");
    assert!(read_file_text(&f, 1024).is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant structure::tests::read_`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement `read_file_text`**

Add to `crates/app/src/structure.rs` (after `list_dir`, before `#[cfg(test)]`):

```rust
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ReadKind {
    Text,
    Binary,
    TooLarge,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ReadResult {
    pub kind: ReadKind,
    pub content: Option<String>,
    pub size_bytes: u64,
}

pub fn read_file_text(path: &Path, max_bytes: u64) -> Result<ReadResult, String> {
    let metadata = std::fs::metadata(path).map_err(|e| format!("stat: {e}"))?;
    if !metadata.is_file() {
        return Err(format!("not a file: {}", path.display()));
    }
    let size = metadata.len();
    if size > max_bytes {
        return Ok(ReadResult { kind: ReadKind::TooLarge, content: None, size_bytes: size });
    }
    let bytes = std::fs::read(path).map_err(|e| format!("read: {e}"))?;
    if bytes.contains(&0u8) {
        return Ok(ReadResult { kind: ReadKind::Binary, content: None, size_bytes: size });
    }
    match std::str::from_utf8(&bytes) {
        Ok(s) => Ok(ReadResult {
            kind: ReadKind::Text,
            content: Some(s.to_string()),
            size_bytes: size,
        }),
        Err(_) => Ok(ReadResult { kind: ReadKind::Binary, content: None, size_bytes: size }),
    }
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cargo test -p covenant structure::tests`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/structure.rs
git commit -m "feat(structure): read_file_text with size + binary guards"
```

---

## Task 5: `write_file_text`

**Files:**
- Modify: `crates/app/src/structure.rs`

- [ ] **Step 1: Write failing tests**

Add to test module:

```rust
#[test]
fn write_overwrites_existing_file() {
    let tmp = TempDir::new().unwrap();
    let f = tmp.path().join("a.txt");
    fs::write(&f, "old").unwrap();
    write_file_text(&f, "new content").unwrap();
    assert_eq!(fs::read_to_string(&f).unwrap(), "new content");
}

#[test]
fn write_creates_new_file() {
    let tmp = TempDir::new().unwrap();
    let f = tmp.path().join("new.txt");
    write_file_text(&f, "fresh").unwrap();
    assert_eq!(fs::read_to_string(&f).unwrap(), "fresh");
}

#[test]
fn write_to_missing_parent_errors() {
    let tmp = TempDir::new().unwrap();
    let f = tmp.path().join("nope/missing.txt");
    assert!(write_file_text(&f, "x").is_err());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant structure::tests::write_`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement `write_file_text`**

Add to `crates/app/src/structure.rs` (after `read_file_text`, before tests):

```rust
pub fn write_file_text(path: &Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.is_dir() {
            return Err(format!(
                "parent dir does not exist: {}",
                parent.display()
            ));
        }
    }
    std::fs::write(path, content.as_bytes())
        .map_err(|e| format!("write: {e}"))
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `cargo test -p covenant structure::tests`
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/structure.rs
git commit -m "feat(structure): write_file_text"
```

---

## Task 6: Wire 3 Tauri commands into `lib.rs`

**Files:**
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Add the command handlers**

Append these handlers to `crates/app/src/lib.rs` just before the `#[cfg_attr(mobile, tauri::mobile_entry_point)]` block at the bottom of the file:

```rust
#[tauri::command]
async fn structure_list_dir(cwd: String) -> Result<Vec<structure::DirEntry>, String> {
    let path = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || structure::list_dir(&path))
        .await
        .map_err(|e| format!("list_dir join: {e}"))?
}

/// Hard cap on the per-file read size to keep memory bounded. The
/// frontend can request a smaller threshold; we never honor a larger
/// one. 4 MiB is well above the 1 MiB UI default and below anything
/// that would stall the IPC bridge.
const MAX_READ_BYTES_HARD_CAP: u64 = 4 * 1024 * 1024;

#[tauri::command]
async fn structure_read_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<structure::ReadResult, String> {
    let p = PathBuf::from(path);
    let max = max_bytes.unwrap_or(1024 * 1024).min(MAX_READ_BYTES_HARD_CAP);
    tokio::task::spawn_blocking(move || structure::read_file_text(&p, max))
        .await
        .map_err(|e| format!("read_file join: {e}"))?
}

#[tauri::command]
async fn structure_write_file(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || structure::write_file_text(&p, &content))
        .await
        .map_err(|e| format!("write_file join: {e}"))?
}
```

- [ ] **Step 2: Register them in `invoke_handler`**

In the `tauri::generate_handler![...]` macro at the bottom of the file, add these lines after `get_dir_context,`:

```rust
            structure_list_dir,
            structure_read_file,
            structure_write_file,
```

- [ ] **Step 3: Verify the build**

Run: `cargo check -p covenant`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(structure): expose list_dir/read_file/write_file Tauri commands"
```

---

## Task 7: Add API wrappers in `ui/src/api.ts`

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Append type + wrapper exports**

Append at the end of `ui/src/api.ts`:

```typescript
// 3.3 Structure (file tree) ---------------------------------------------

export type EntryKind = "dir" | "file";

export interface DirEntry {
  name: string;
  path: string;
  kind: EntryKind;
  is_symlink: boolean;
}

export type ReadKind = "text" | "binary" | "too_large";

export interface ReadResult {
  kind: ReadKind;
  content: string | null;
  size_bytes: number;
}

export async function structureListDir(cwd: string): Promise<DirEntry[]> {
  return invoke<DirEntry[]>("structure_list_dir", { cwd });
}

export async function structureReadFile(
  path: string,
  maxBytes?: number,
): Promise<ReadResult> {
  return invoke<ReadResult>("structure_read_file", {
    path,
    maxBytes: maxBytes ?? null,
  });
}

export async function structureWriteFile(path: string, content: string): Promise<void> {
  return invoke<void>("structure_write_file", { path, content });
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(structure): typed api wrappers for tree/read/write"
```

---

## Task 8: `ui/src/structure/tree.ts` — tree component

**Files:**
- Create: `ui/src/structure/tree.ts`

- [ ] **Step 1: Write the component**

Create `ui/src/structure/tree.ts` with this content:

```typescript
// Structure (file tree) sidebar view — Zed-style lazy-loaded tree.
//
// One root = active tab's cwd. Folders load their children only when
// expanded; expanded state persists per-cwd in localStorage. Honors
// the backend's hardcoded ignore set + .gitignore (we don't see those
// entries at all). Manual refresh button re-lists from root.

import { Icons } from "../icons";
import { structureListDir, type DirEntry } from "../api";

export type FileClickHandler = (path: string) => void;

interface NodeState {
  entry: DirEntry;
  expanded: boolean;
  children: NodeState[] | null; // null = not loaded
  depth: number;
  el: HTMLLIElement;
}

const LS_KEY_PREFIX = "covenant.structure.expanded.";

function loadExpanded(cwd: string): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY_PREFIX + cwd);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) return new Set(arr);
  } catch {
    /* corrupt — ignore */
  }
  return new Set();
}

function saveExpanded(cwd: string, paths: Set<string>): void {
  try {
    localStorage.setItem(LS_KEY_PREFIX + cwd, JSON.stringify([...paths]));
  } catch {
    /* quota — non-fatal */
  }
}

export class StructureTree {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLUListElement;
  private readonly headerEl: HTMLElement;
  private readonly emptyEl: HTMLElement;
  private cwd: string | null = null;
  private nodes: NodeState[] = [];
  private expandedPaths: Set<string> = new Set();
  private visible = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly onFileClick: FileClickHandler,
  ) {
    this.root = document.createElement("div");
    this.root.className = "structure-host";
    this.root.hidden = true;

    this.headerEl = document.createElement("header");
    this.headerEl.className = "structure-header";
    this.root.appendChild(this.headerEl);

    this.listEl = document.createElement("ul");
    this.listEl.className = "structure-list";
    this.root.appendChild(this.listEl);

    this.emptyEl = document.createElement("div");
    this.emptyEl.className = "structure-empty";
    this.emptyEl.textContent = "Empty directory";
    this.emptyEl.hidden = true;
    this.root.appendChild(this.emptyEl);

    this.host.appendChild(this.root);
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  /// Re-root the tree at `cwd`. Idempotent: passing the same cwd re-uses
  /// the existing expanded state from localStorage. Triggers a fresh
  /// `list_dir` against the new root.
  async setCwd(cwd: string): Promise<void> {
    if (this.cwd === cwd && this.nodes.length > 0) return;
    this.cwd = cwd;
    this.expandedPaths = loadExpanded(cwd);
    this.renderHeader(cwd);
    await this.refreshRoot();
  }

  /// Manual refresh: forget loaded children at all depths and re-list.
  async refresh(): Promise<void> {
    if (this.cwd) await this.refreshRoot();
  }

  private renderHeader(cwd: string): void {
    this.headerEl.innerHTML = "";
    const label = document.createElement("span");
    label.className = "structure-cwd";
    label.title = cwd;
    label.textContent = shortenCwd(cwd);
    this.headerEl.appendChild(label);

    const refresh = document.createElement("button");
    refresh.type = "button";
    refresh.className = "structure-refresh";
    refresh.title = "Refresh";
    refresh.innerHTML = Icons.refresh ?? "↻";
    refresh.addEventListener("click", () => {
      void this.refresh();
    });
    this.headerEl.appendChild(refresh);
  }

  private async refreshRoot(): Promise<void> {
    if (!this.cwd) return;
    this.listEl.innerHTML = "";
    this.nodes = [];
    let entries: DirEntry[];
    try {
      entries = await structureListDir(this.cwd);
    } catch (err) {
      this.showError(String(err));
      return;
    }
    if (entries.length === 0) {
      this.emptyEl.hidden = false;
      return;
    }
    this.emptyEl.hidden = true;
    for (const entry of entries) {
      const node = this.makeNode(entry, 0);
      this.nodes.push(node);
      this.listEl.appendChild(node.el);
      // Restore expanded state (depth-first).
      if (this.expandedPaths.has(entry.path) && entry.kind === "dir") {
        await this.expand(node);
      }
    }
  }

  private makeNode(entry: DirEntry, depth: number): NodeState {
    const li = document.createElement("li");
    li.className = "structure-node";
    li.dataset.kind = entry.kind;
    li.style.setProperty("--depth", String(depth));

    const row = document.createElement("div");
    row.className = "structure-row";
    li.appendChild(row);

    const chevron = document.createElement("span");
    chevron.className = "structure-chevron";
    chevron.textContent = entry.kind === "dir" ? "▸" : "";
    row.appendChild(chevron);

    const icon = document.createElement("span");
    icon.className = "structure-icon";
    icon.textContent = entry.kind === "dir" ? "📁" : "📄";
    row.appendChild(icon);

    const name = document.createElement("span");
    name.className = "structure-name";
    name.textContent = entry.name;
    if (entry.is_symlink) {
      const badge = document.createElement("span");
      badge.className = "structure-symlink-badge";
      badge.title = "Symlink (not traversed)";
      badge.textContent = "↪";
      name.appendChild(badge);
    }
    row.appendChild(name);

    const node: NodeState = { entry, expanded: false, children: null, depth, el: li };

    row.addEventListener("click", () => {
      if (entry.kind === "dir" && !entry.is_symlink) {
        if (node.expanded) {
          this.collapse(node);
        } else {
          void this.expand(node);
        }
      } else if (entry.kind === "file") {
        this.onFileClick(entry.path);
      }
    });

    return node;
  }

  private async expand(node: NodeState): Promise<void> {
    if (node.expanded) return;
    if (node.entry.kind !== "dir") return;
    node.expanded = true;
    node.el.classList.add("structure-node-expanded");
    const chev = node.el.querySelector(".structure-chevron");
    if (chev) chev.textContent = "▾";
    if (this.cwd) {
      this.expandedPaths.add(node.entry.path);
      saveExpanded(this.cwd, this.expandedPaths);
    }
    if (node.children !== null) {
      // Already loaded — just re-show.
      const childList = node.el.querySelector(".structure-children");
      if (childList instanceof HTMLElement) childList.hidden = false;
      return;
    }
    let entries: DirEntry[];
    try {
      entries = await structureListDir(node.entry.path);
    } catch (err) {
      const errEl = document.createElement("div");
      errEl.className = "structure-error";
      errEl.textContent = String(err);
      node.el.appendChild(errEl);
      return;
    }
    const childList = document.createElement("ul");
    childList.className = "structure-children";
    node.children = [];
    for (const entry of entries) {
      const child = this.makeNode(entry, node.depth + 1);
      node.children.push(child);
      childList.appendChild(child.el);
      if (this.expandedPaths.has(entry.path) && entry.kind === "dir") {
        await this.expand(child);
      }
    }
    node.el.appendChild(childList);
  }

  private collapse(node: NodeState): void {
    if (!node.expanded) return;
    node.expanded = false;
    node.el.classList.remove("structure-node-expanded");
    const chev = node.el.querySelector(".structure-chevron");
    if (chev) chev.textContent = "▸";
    const childList = node.el.querySelector(".structure-children");
    if (childList instanceof HTMLElement) childList.hidden = true;
    if (this.cwd) {
      this.expandedPaths.delete(node.entry.path);
      saveExpanded(this.cwd, this.expandedPaths);
    }
  }

  private showError(msg: string): void {
    this.listEl.innerHTML = "";
    const err = document.createElement("div");
    err.className = "structure-error";
    err.textContent = msg;
    this.listEl.appendChild(err);
  }
}

function shortenCwd(cwd: string): string {
  // Show last 2 segments for compactness. Full path on hover.
  const parts = cwd.split("/").filter(Boolean);
  if (parts.length <= 2) return cwd;
  return ".../" + parts.slice(-2).join("/");
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

If `Icons.refresh` does not exist in `ui/src/icons/index.ts`, add it. Check first:

```bash
grep -n "refresh" ui/src/icons/index.ts
```

If missing, add a `refresh` entry mirroring an existing one (lucide `refresh-cw` SVG). Otherwise the fallback `"↻"` covers it — leave as-is.

- [ ] **Step 3: Commit**

```bash
git add ui/src/structure/tree.ts
git commit -m "feat(structure): tree component with lazy load + persistent expand"
```

---

## Task 9: Sidebar nav + mount tree in `tabs/manager.ts`

**Files:**
- Modify: `ui/src/tabs/manager.ts`
- Modify: `ui/src/styles.css` (nav styles only — tree styles in Task 11)

This task wires Structure into the per-tab sidebar so the user can switch between Blocks (default) and Structure. Recall keeps its existing contextual override.

- [ ] **Step 1: Add the import**

At the top of `ui/src/tabs/manager.ts`, near the existing `import { RecallManager }` line, add:

```typescript
import { StructureTree } from "../structure/tree";
```

- [ ] **Step 2: Locate the per-tab Tab interface**

In `ui/src/tabs/manager.ts` around the `Tab` interface (~line 110-130), add a new field:

```typescript
  structure: StructureTree;
  /// Which sidebar view is currently selected manually. Recall still
  /// overrides this when user is typing (existing behavior).
  sidebarView: "blocks" | "structure";
```

- [ ] **Step 3: Build sidebar nav and StructureTree alongside Blocks/Recall**

In the `spawn` method of `TabManager`, just after the line `recall = new RecallManager(...)` block ends (around line 723), insert:

```typescript
    // Sidebar nav strip — sits at the top of the sidebar column. Two
    // entries: Blocks (default) and Structure. Recall stays contextual.
    const navEl = document.createElement("nav");
    navEl.className = "sidebar-nav";

    const navBlocks = document.createElement("button");
    navBlocks.type = "button";
    navBlocks.className = "sidebar-nav-btn sidebar-nav-active";
    navBlocks.title = "Blocks";
    navBlocks.textContent = "Blocks";

    const navStructure = document.createElement("button");
    navStructure.type = "button";
    navStructure.className = "sidebar-nav-btn";
    navStructure.title = "Structure";
    navStructure.textContent = "Files";

    navEl.appendChild(navBlocks);
    navEl.appendChild(navStructure);
    blocksHost.insertBefore(navEl, blocksHost.firstChild);

    const structure = new StructureTree(blocksHost, (path) => {
      // Editor wiring is added in Task 11. For now, file clicks log.
      // eslint-disable-next-line no-console
      console.log("structure file click:", path);
    });

    const switchSidebar = (view: "blocks" | "structure") => {
      const tabHere = this.tabsById.get(sessionId as unknown as TabId);
      if (tabHere) tabHere.sidebarView = view;
      if (view === "blocks") {
        navBlocks.classList.add("sidebar-nav-active");
        navStructure.classList.remove("sidebar-nav-active");
        structure.hide();
        blocks!.show();
      } else {
        navStructure.classList.add("sidebar-nav-active");
        navBlocks.classList.remove("sidebar-nav-active");
        blocks!.hide();
        structure.show();
        if (tabRef.current?.cwd) void structure.setCwd(tabRef.current.cwd);
      }
    };

    navBlocks.addEventListener("click", () => switchSidebar("blocks"));
    navStructure.addEventListener("click", () => switchSidebar("structure"));
```

- [ ] **Step 4: Track structure on the Tab object**

Find the `const tab: Tab = {` block (around line 768). Add fields to the object literal:

```typescript
      structure,
      sidebarView: "blocks",
```

- [ ] **Step 5: Re-root structure on cwd_changed**

In the `onSessionEvent` handler inside `spawn`, find the `cwd_changed` branch (around line 680). After the existing `recall?.setCwd(event.cwd);` line, add:

```typescript
              if (tabRef.current?.structure.isVisible()) {
                void tabRef.current.structure.setCwd(event.cwd);
              }
```

- [ ] **Step 6: Add minimal sidebar-nav CSS**

Append to `ui/src/styles.css` (one block, will be expanded in Task 11):

```css
/* 3.3 Structure — sidebar nav strip */
.sidebar-nav {
  display: flex;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-panel);
}
.sidebar-nav-btn {
  flex: 1;
  padding: 4px 8px;
  font-size: 11px;
  background: transparent;
  color: var(--muted);
  border: 1px solid transparent;
  border-radius: 4px;
  cursor: pointer;
}
.sidebar-nav-btn:hover {
  color: var(--fg);
}
.sidebar-nav-active {
  color: var(--fg);
  background: rgba(255, 255, 255, 0.04);
  border-color: var(--border);
}
```

- [ ] **Step 7: Verify build**

Run: `cd ui && npx tsc --noEmit && cargo check -p covenant`
Expected: clean.

- [ ] **Step 8: Smoke test in dev server**

Run: `npm run tauri dev` (in repo root). In the running app, click "Files" in a sidebar and confirm the cwd's tree appears. Click a folder to expand. Reload — expanded state should persist.

- [ ] **Step 9: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(structure): sidebar nav + per-tab tree mount"
```

---

## Task 10: `ui/src/structure/editor.ts` — minimal textarea editor

**Files:**
- Create: `ui/src/structure/editor.ts`

This task creates the editor component. It is mounted into the per-tab pane in Task 11.

- [ ] **Step 1: Write the editor**

Create `ui/src/structure/editor.ts`:

```typescript
// Minimal in-app editor: <textarea> with ⌘S save and a "too large" /
// binary placeholder. No syntax highlighting, no LSP — explicitly out
// of scope per spec 3.3. The point is the one-line edit escape hatch.

import { structureReadFile, structureWriteFile } from "../api";

export interface EditorCallbacks {
  onSave?: (path: string) => void;
  onClose?: () => void;
  toast?: (message: string, severity?: "info" | "error") => void;
}

const SIZE_THRESHOLD_BYTES = 1024 * 1024; // 1 MiB per spec.

export class StructureEditor {
  private readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly pathLabelEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly textareaEl: HTMLTextAreaElement;
  private readonly placeholderEl: HTMLElement;
  private currentPath: string | null = null;
  private originalContent: string | null = null;
  private dirty = false;
  private visible = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: EditorCallbacks,
  ) {
    this.root = document.createElement("div");
    this.root.className = "structure-editor";
    this.root.hidden = true;

    this.headerEl = document.createElement("header");
    this.headerEl.className = "structure-editor-header";
    this.root.appendChild(this.headerEl);

    this.pathLabelEl = document.createElement("span");
    this.pathLabelEl.className = "structure-editor-path";
    this.headerEl.appendChild(this.pathLabelEl);

    this.statusEl = document.createElement("span");
    this.statusEl.className = "structure-editor-status";
    this.headerEl.appendChild(this.statusEl);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "structure-editor-close";
    closeBtn.title = "Close editor";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());
    this.headerEl.appendChild(closeBtn);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "structure-editor-body";
    this.root.appendChild(this.bodyEl);

    this.textareaEl = document.createElement("textarea");
    this.textareaEl.className = "structure-editor-textarea";
    this.textareaEl.spellcheck = false;
    this.textareaEl.addEventListener("input", () => {
      this.dirty = this.textareaEl.value !== (this.originalContent ?? "");
      this.renderStatus();
    });
    this.textareaEl.addEventListener("keydown", (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === "s") {
        e.preventDefault();
        void this.save();
      }
    });
    this.bodyEl.appendChild(this.textareaEl);

    this.placeholderEl = document.createElement("div");
    this.placeholderEl.className = "structure-editor-placeholder";
    this.placeholderEl.hidden = true;
    this.bodyEl.appendChild(this.placeholderEl);

    this.host.appendChild(this.root);
  }

  isVisible(): boolean {
    return this.visible;
  }

  async open(path: string): Promise<void> {
    this.currentPath = path;
    this.pathLabelEl.textContent = shortenPath(path);
    this.pathLabelEl.title = path;
    this.statusEl.textContent = "loading…";
    this.show();
    let result;
    try {
      result = await structureReadFile(path, SIZE_THRESHOLD_BYTES);
    } catch (err) {
      this.showPlaceholder(`Failed to read: ${err}`);
      return;
    }
    if (result.kind === "too_large") {
      this.showPlaceholder(
        `File too large to preview (${formatBytes(result.size_bytes)}). ` +
          `Edit it in your editor of choice.`,
      );
      return;
    }
    if (result.kind === "binary") {
      this.showPlaceholder("Binary file — not editable here.");
      return;
    }
    const text = result.content ?? "";
    this.originalContent = text;
    this.dirty = false;
    this.placeholderEl.hidden = true;
    this.textareaEl.hidden = false;
    this.textareaEl.value = text;
    this.renderStatus();
    requestAnimationFrame(() => this.textareaEl.focus());
  }

  async save(): Promise<void> {
    if (!this.currentPath) return;
    if (!this.dirty) return;
    try {
      await structureWriteFile(this.currentPath, this.textareaEl.value);
      this.originalContent = this.textareaEl.value;
      this.dirty = false;
      this.renderStatus();
      this.callbacks.toast?.("Saved", "info");
      this.callbacks.onSave?.(this.currentPath);
    } catch (err) {
      this.callbacks.toast?.(`Save failed: ${err}`, "error");
    }
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    this.host.classList.add("structure-editor-open");
  }

  close(): void {
    if (!this.visible) return;
    if (this.dirty) {
      const ok = window.confirm("Discard unsaved changes?");
      if (!ok) return;
    }
    this.visible = false;
    this.root.hidden = true;
    this.host.classList.remove("structure-editor-open");
    this.currentPath = null;
    this.originalContent = null;
    this.dirty = false;
    this.textareaEl.value = "";
    this.callbacks.onClose?.();
  }

  private showPlaceholder(message: string): void {
    this.textareaEl.hidden = true;
    this.placeholderEl.hidden = false;
    this.placeholderEl.textContent = message;
    this.originalContent = null;
    this.dirty = false;
    this.statusEl.textContent = "";
  }

  private renderStatus(): void {
    this.statusEl.textContent = this.dirty ? "modified · ⌘S to save" : "saved";
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/structure/editor.ts
git commit -m "feat(structure): minimal textarea editor with size + binary guards"
```

---

## Task 11: Mount editor pane + wire file-click → editor open

**Files:**
- Modify: `ui/src/tabs/manager.ts`
- Modify: `ui/src/styles.css`

The editor lives in the same pane as xterm. When open, it splits the pane horizontally — sidebar | editor | terminal. Closed, terminal takes the full width. xterm must `fit()` on every transition.

- [ ] **Step 1: Add import in `tabs/manager.ts`**

Add near the StructureTree import:

```typescript
import { StructureEditor } from "../structure/editor";
```

- [ ] **Step 2: Find where `pane`, `termHost`, `blocksHost` are constructed**

Around line 600-650 in the `spawn` method, find where the pane DOM is built. Look for `const pane = document.createElement("div");` and the line `pane.appendChild(termHost);`.

Refactor that section to insert an editor host BETWEEN `blocksHost` and `termHost`. Replace the pane setup (you'll see something like):

```typescript
    pane.appendChild(blocksHost);
    pane.appendChild(termHost);
```

with:

```typescript
    const editorHost = document.createElement("div");
    editorHost.className = "editor-host";
    editorHost.hidden = true;

    pane.appendChild(blocksHost);
    pane.appendChild(editorHost);
    pane.appendChild(termHost);
```

- [ ] **Step 3: Build the editor and wire it to file clicks**

After the StructureTree is created (Task 9 step 3 added it), replace the placeholder file-click handler with one that opens the editor. Find the line:

```typescript
    const structure = new StructureTree(blocksHost, (path) => {
      console.log("structure file click:", path);
    });
```

Replace it with:

```typescript
    const editor = new StructureEditor(editorHost, {
      toast: (msg, severity) => {
        // eslint-disable-next-line no-console
        if (severity === "error") console.error(msg);
        // Existing toast/notification system can be wired here later.
      },
      onClose: () => {
        editorHost.hidden = true;
        requestAnimationFrame(() => {
          try {
            fit.fit();
          } catch {
            /* ignore */
          }
        });
      },
    });

    const structure = new StructureTree(blocksHost, (path) => {
      editorHost.hidden = false;
      void editor.open(path);
      requestAnimationFrame(() => {
        try {
          fit.fit();
        } catch {
          /* ignore */
        }
      });
    });
```

- [ ] **Step 4: Track editor on the Tab object**

In the Tab interface, add:

```typescript
  editor: StructureEditor;
```

In the tab literal, add the field:

```typescript
      editor,
```

- [ ] **Step 5: Append editor + tree styles to `ui/src/styles.css`**

Append at the end of `ui/src/styles.css`:

```css
/* 3.3 Structure — file tree */
.structure-host {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: hidden;
}
.structure-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.structure-cwd {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.structure-refresh {
  background: transparent;
  border: 1px solid transparent;
  color: var(--muted);
  cursor: pointer;
  border-radius: 3px;
  padding: 2px 6px;
}
.structure-refresh:hover {
  color: var(--fg);
  border-color: var(--border);
}
.structure-list {
  list-style: none;
  margin: 0;
  padding: 4px 0;
  overflow-y: auto;
  flex: 1;
  font-size: 12px;
}
.structure-children {
  list-style: none;
  margin: 0;
  padding: 0;
}
.structure-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px 2px calc(8px + var(--depth, 0) * 12px);
  cursor: pointer;
  user-select: none;
}
.structure-row:hover {
  background: rgba(255, 255, 255, 0.04);
}
.structure-chevron {
  display: inline-block;
  width: 10px;
  color: var(--muted);
  font-size: 10px;
}
.structure-icon {
  width: 14px;
  text-align: center;
}
.structure-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}
.structure-symlink-badge {
  margin-left: 4px;
  color: var(--muted);
  font-size: 10px;
}
.structure-empty,
.structure-error {
  padding: 12px;
  font-size: 11px;
  color: var(--muted);
  font-style: italic;
}
.structure-error {
  color: #ff6b6b;
}

/* 3.3 Structure — editor pane */
.editor-host {
  flex: 1 1 50%;
  min-width: 240px;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  background: var(--bg-panel);
  display: flex;
}
.structure-editor {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
}
.structure-editor-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 11px;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.structure-editor-path {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--fg);
}
.structure-editor-status {
  font-size: 10px;
  color: var(--muted);
}
.structure-editor-close {
  background: transparent;
  border: none;
  color: var(--muted);
  cursor: pointer;
  padding: 0 4px;
}
.structure-editor-close:hover {
  color: var(--fg);
}
.structure-editor-body {
  flex: 1;
  display: flex;
  position: relative;
}
.structure-editor-textarea {
  flex: 1;
  width: 100%;
  height: 100%;
  resize: none;
  border: none;
  outline: none;
  padding: 10px 12px;
  background: transparent;
  color: var(--fg);
  font-family: var(--terminal-font, "SF Mono", monospace);
  font-size: 12px;
  line-height: 1.5;
  tab-size: 2;
}
.structure-editor-placeholder {
  flex: 1;
  padding: 16px;
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
}
```

- [ ] **Step 6: Verify build**

Run: `cd ui && npx tsc --noEmit && cargo check -p covenant`
Expected: clean.

- [ ] **Step 7: Smoke test**

Run `npm run tauri dev`. Workflow:

1. Switch sidebar to Files.
2. Click a small text file — editor should open, terminal should narrow.
3. Type, press ⌘S — status should change to "saved", verify on disk via `cat`.
4. Open a >1 MiB file — placeholder should appear.
5. Open a binary (e.g. `.png`) — placeholder.
6. Click ✕ — editor closes, terminal expands back, xterm refits without artifacts.
7. Reload app — expanded folders restored.

- [ ] **Step 8: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(structure): editor pane wiring + horizontal split with terminal"
```

---

## Task 12: Final type + cargo verification

- [ ] **Step 1: Type check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Cargo check**

Run: `cargo check -p covenant`
Expected: no errors.

- [ ] **Step 3: All tests**

Run: `cargo test -p covenant`
Expected: all existing + new tests pass (12 new in `structure::tests`).

- [ ] **Step 4: Acceptance criteria walk-through**

Manually verify each item from spec section "Acceptance criteria":
- [ ] Sidebar third view "Structure" present.
- [ ] Toggling uses sidebar nav (no global shortcut).
- [ ] Tree root = active tab cwd; tab switch re-roots.
- [ ] `.gitignore` honored + hardcoded set.
- [ ] Folders expand/collapse on click; persists per-cwd in localStorage.
- [ ] File click opens minimal editor pane.
- [ ] ⌘S saves; success toast.
- [ ] >1 MiB → "too large" placeholder.
- [ ] `npx tsc --noEmit` clean.
- [ ] `cargo check -p covenant` clean.

- [ ] **Step 5: Commit any cleanup**

If any tweaks were needed during the walk-through, commit them as `chore(structure): polish per acceptance walk-through`.

---

## Self-Review

**Spec coverage check:** Each acceptance-criteria item maps to a task above (1: Task 9; 2: Task 9; 3: Tasks 8+9; 4: Tasks 2+3; 5: Task 8; 6: Tasks 8+10+11; 7: Task 10; 8: Task 10; 9: Task 12; 10: Task 12).

**Out-of-scope reminders:** No LSP, no syntax highlighting, no multi-file editor tabs, no folder ops, no cross-file content search, no watcher, no symlink traversal — all enforced by what is and isn't implemented.

**Type consistency:** `DirEntry`, `ReadResult`, `EntryKind`, `ReadKind` mirrored exactly between `structure.rs` and `api.ts`. `structureListDir` / `structureReadFile` / `structureWriteFile` names consistent with their backing commands `structure_list_dir` / `structure_read_file` / `structure_write_file`.

**Risks called out in spec:** The largest risk per spec is the editor pane. Tree (Tasks 1-9) ships independently and is acceptance-criteria-complete except for items 6/7/8 — if Tasks 10-11 hit unexpected friction, ship after Task 9 with a "click to edit" disabled state and pick up the editor in a follow-up.
