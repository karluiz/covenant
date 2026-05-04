# Spec Auto-Detect → Propose Mission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a new spec file appears in the repo (`docs/specs/*.md` or `docs/superpowers/specs/*-design.md`), Covenant detects it and proposes "use as mission?" via a statusbar toast on eligible tabs, plus a "last call" modal when the user pulls Engage AOM on a tab without a mission.

**Architecture:** Rust backend owns one `SpecDetector` per repo_root. On boot it snapshots existing specs into a new SQLite table (`seen_specs`) so preexisting files never trigger. A `notify` crate watcher fires on file creation; if the path is not in `seen_specs` it inserts and emits a `spec:candidate` Tauri event with source classification (`Covenant` for `docs/specs/`, `Superpowers` for `docs/superpowers/specs/`). Frontend filters per-tab (cwd ⊂ repo_root, no mission, operator assigned), shows toast in statusbar, and caches pending candidates so Engage AOM can show a last-call modal.

**Tech Stack:** Rust + Tokio + `notify = "6"` (new dep) + rusqlite. TypeScript + Tauri IPC + xterm-free statusbar UI.

**Important simplification vs spec:** The spec mentions hooking the `mission:published` event for the Covenant path. That event does not exist today and adding it would cross-touch `drafts.rs`. Since the publish flow moves the file into `docs/specs/` on disk, the FS watcher already catches it — classification is path-based. We rely on the watcher for both sources. `seen_specs` dedupe guarantees one candidate per file regardless of how it appeared.

---

## File Structure

**Backend (Rust):**
- `crates/app/Cargo.toml` — add `notify = "6"`.
- `crates/app/src/storage.rs` — extend `SCHEMA` with `seen_specs` table.
- `crates/app/src/spec_detector.rs` — **new file**, ~400 lines. Pure functions: classify path, parse goal snippet, decide candidate. Stateful: `SpecDetector` struct owning the watcher + sqlite handle + Tauri AppHandle for emitting.
- `crates/app/src/lib.rs` — register Tauri commands + start `SpecDetector` on first repo open.

**Frontend (TS):**
- `ui/src/api.ts` — three wrappers + types.
- `ui/src/aom/spec-prompt.ts` — **new file**, ~250 lines. Listener, per-tab filter, dismiss state, pending-candidate cache (10 min TTL), statusbar toast render, Engage-AOM modal helper.
- `ui/src/aom/banner.ts` — intercept Engage AOM when no mission to call the helper.
- `ui/src/main.ts` — bootstrap the listener on app start.
- `ui/src/styles.css` — toast + modal styles (≤ 80 lines appended).

**Tests:**
- `crates/app/src/spec_detector.rs` — unit tests inline (`#[cfg(test)] mod tests`).
- `ui/src/aom/spec-prompt.test.ts` — unit tests for `specPromptState`.

---

## Task 1: Add `notify` crate dependency

**Files:**
- Modify: `crates/app/Cargo.toml`

- [ ] **Step 1: Add the dep**

Open `crates/app/Cargo.toml`. Find the `[dependencies]` block (alphabetical-ish; locate the line with `serde_yaml = "0.9"`). Add after it:

```toml
notify = "6"
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo check -p covenant`
Expected: builds clean (a fetch may happen on first run). If it errors with a version conflict, ESCALATE before forcing a workspace bump.

- [ ] **Step 3: Commit**

```bash
git add crates/app/Cargo.toml Cargo.lock
git commit -m "deps: add notify crate for FS watcher in spec detector"
```

---

## Task 2: Add `seen_specs` table to storage schema

**Files:**
- Modify: `crates/app/src/storage.rs:38-134` (SCHEMA constant)
- Test: `crates/app/src/storage.rs` (inline tests block at end of file)

- [ ] **Step 1: Write the failing test**

Open `crates/app/src/storage.rs`. Find the existing `#[cfg(test)] mod tests` block at the end of the file (or create one if absent). Add:

```rust
#[test]
fn seen_specs_table_exists_and_supports_upsert() {
    use rusqlite::Connection;
    let conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(super::SCHEMA).expect("apply schema");

    conn.execute(
        "INSERT INTO seen_specs (repo_root, path, first_seen_at) VALUES (?1, ?2, ?3)",
        rusqlite::params!["/tmp/repo", "docs/specs/3.1-foo.md", 1234_i64],
    )
    .expect("insert");

    // Idempotent upsert via PK conflict + INSERT OR IGNORE.
    let inserted: usize = conn
        .execute(
            "INSERT OR IGNORE INTO seen_specs (repo_root, path, first_seen_at) VALUES (?1, ?2, ?3)",
            rusqlite::params!["/tmp/repo", "docs/specs/3.1-foo.md", 9999_i64],
        )
        .expect("upsert");
    assert_eq!(inserted, 0, "should ignore duplicate");

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM seen_specs", [], |r| r.get(0))
        .expect("count");
    assert_eq!(count, 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant storage::tests::seen_specs_table_exists_and_supports_upsert`
Expected: FAIL with `no such table: seen_specs`.

- [ ] **Step 3: Add the table to SCHEMA**

In `crates/app/src/storage.rs`, find the closing `\";` of the `SCHEMA` constant (around line 134). Insert before that closing line:

```sql
CREATE TABLE IF NOT EXISTS seen_specs (
    repo_root          TEXT NOT NULL,
    path               TEXT NOT NULL,
    first_seen_at      INTEGER NOT NULL,
    PRIMARY KEY (repo_root, path)
);

CREATE INDEX IF NOT EXISTS idx_seen_specs_repo
    ON seen_specs(repo_root);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant storage::tests::seen_specs_table_exists_and_supports_upsert`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/storage.rs
git commit -m "feat(storage): add seen_specs table for spec detector dedupe"
```

---

## Task 3: Path classifier (`SpecSource`) + ignore rules

**Files:**
- Create: `crates/app/src/spec_detector.rs`
- Modify: `crates/app/src/lib.rs` (add `mod spec_detector;`)

- [ ] **Step 1: Write the failing tests**

Create `crates/app/src/spec_detector.rs` with:

```rust
//! Spec auto-detection: watches the repo for new spec files and emits
//! candidate events the UI can turn into "use as mission?" toasts.
//!
//! Classification is path-based:
//! - `docs/specs/*.md` (excluding `_template.md` and `drafts/**`) → Covenant
//! - `docs/superpowers/specs/*-design.md` → Superpowers
//! - anything else → not a candidate (returns None)

use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecSource {
    Covenant,
    Superpowers,
}

/// Classify a path relative to `repo_root`. Returns None if the path is
/// not a recognized spec location.
pub fn classify_spec(repo_root: &Path, path: &Path) -> Option<SpecSource> {
    let rel = path.strip_prefix(repo_root).ok()?;
    let s = rel.to_string_lossy();
    let s = s.replace('\\', "/");

    if !s.ends_with(".md") {
        return None;
    }

    // Covenant: docs/specs/<id>-<name>.md, no nested dirs, no template
    if let Some(rest) = s.strip_prefix("docs/specs/") {
        if rest.contains('/') {
            return None; // drafts/ or any nested path
        }
        if rest == "_template.md" || rest == "next-features.md" {
            return None;
        }
        return Some(SpecSource::Covenant);
    }

    // Superpowers: docs/superpowers/specs/<date>-<topic>-design.md
    if let Some(rest) = s.strip_prefix("docs/superpowers/specs/") {
        if rest.contains('/') {
            return None;
        }
        return Some(SpecSource::Superpowers);
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/tmp/repo")
    }

    #[test]
    fn covenant_spec_classified() {
        let p = root().join("docs/specs/3.16-foo.md");
        assert_eq!(classify_spec(&root(), &p), Some(SpecSource::Covenant));
    }

    #[test]
    fn superpowers_spec_classified() {
        let p = root().join("docs/superpowers/specs/2026-05-04-foo-design.md");
        assert_eq!(classify_spec(&root(), &p), Some(SpecSource::Superpowers));
    }

    #[test]
    fn template_ignored() {
        let p = root().join("docs/specs/_template.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn next_features_ignored() {
        let p = root().join("docs/specs/next-features.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn drafts_subdir_ignored() {
        let p = root().join("docs/specs/drafts/wip-foo.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn non_md_ignored() {
        let p = root().join("docs/specs/3.1-foo.txt");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn outside_repo_ignored() {
        let p = PathBuf::from("/elsewhere/docs/specs/3.1-foo.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn unrelated_path_ignored() {
        let p = root().join("README.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }
}
```

In `crates/app/src/lib.rs`, find the existing `mod` declarations (top of file, alphabetical block). Add:

```rust
mod spec_detector;
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `cargo test -p covenant spec_detector::tests::`
Expected: all 8 tests PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/spec_detector.rs crates/app/src/lib.rs
git commit -m "feat(spec_detector): add path-based spec source classifier"
```

---

## Task 4: Goal snippet parser

**Files:**
- Modify: `crates/app/src/spec_detector.rs`

- [ ] **Step 1: Write the failing tests**

Append to the `tests` module in `crates/app/src/spec_detector.rs`:

```rust
#[test]
fn extracts_goal_under_h2() {
    let md = "# 3.16 — Foo\n\n## Goal\n\nDoes the thing.\nMore detail.\n\n## Out of scope\n";
    assert_eq!(
        extract_goal_snippet(md, 200),
        "Does the thing. More detail."
    );
}

#[test]
fn truncates_at_limit_with_ellipsis() {
    let md = format!("## Goal\n\n{}", "a".repeat(300));
    let out = extract_goal_snippet(&md, 50);
    assert_eq!(out.len(), 51); // 50 chars + "…"
    assert!(out.ends_with('…'));
}

#[test]
fn returns_empty_when_no_goal_section() {
    let md = "# Title\n\nSome text without a goal heading.";
    assert_eq!(extract_goal_snippet(md, 200), "");
}

#[test]
fn extract_title_from_h1() {
    let md = "# 3.16 — Foo Bar\n\n## Goal\n";
    assert_eq!(extract_title(md), Some("3.16 — Foo Bar".to_string()));
}

#[test]
fn extract_title_returns_none_without_h1() {
    let md = "## Goal\n";
    assert_eq!(extract_title(md), None);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant spec_detector::tests::extracts_goal_under_h2`
Expected: FAIL with `cannot find function ... extract_goal_snippet`.

- [ ] **Step 3: Implement the parsers**

In `crates/app/src/spec_detector.rs`, above the `#[cfg(test)]` block, add:

```rust
/// Extract the H1 title (e.g. "3.16 — Foo") from a spec markdown body.
/// Returns the trimmed text after the first `# ` line, or None.
pub fn extract_title(md: &str) -> Option<String> {
    for line in md.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            let t = rest.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Extract a flat one-paragraph snippet from the `## Goal` section,
/// truncated to `max_chars` (with a trailing "…" if truncated).
/// Returns "" if no Goal section is present.
pub fn extract_goal_snippet(md: &str, max_chars: usize) -> String {
    let mut in_goal = false;
    let mut buf = String::new();

    for line in md.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("## ") {
            if in_goal {
                break; // next section ends Goal
            }
            // Match the heading word case-insensitively, allow trailing text.
            let heading = trimmed.trim_start_matches("## ").trim();
            if heading.eq_ignore_ascii_case("goal")
                || heading.to_ascii_lowercase().starts_with("goal ")
            {
                in_goal = true;
            }
            continue;
        }
        if !in_goal {
            continue;
        }
        if trimmed.starts_with('>') {
            continue; // skip blockquotes (template comments)
        }
        if trimmed.is_empty() {
            if !buf.is_empty() {
                buf.push(' ');
            }
            continue;
        }
        if !buf.is_empty() && !buf.ends_with(' ') {
            buf.push(' ');
        }
        buf.push_str(trimmed);
    }

    let flat = buf.trim().to_string();
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let truncated: String = flat.chars().take(max_chars).collect();
    format!("{}…", truncated)
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p covenant spec_detector::tests::`
Expected: all tests in module PASS (now 13 total).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/spec_detector.rs
git commit -m "feat(spec_detector): add title and goal snippet markdown parsers"
```

---

## Task 5: Initial snapshot scan (idempotent)

**Files:**
- Modify: `crates/app/src/spec_detector.rs`

- [ ] **Step 1: Write the failing test**

Append to the `tests` module in `crates/app/src/spec_detector.rs`:

```rust
#[test]
fn snapshot_inserts_existing_specs_and_skips_unrelated() {
    use rusqlite::Connection;
    use std::fs;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("docs/specs/drafts")).unwrap();
    fs::create_dir_all(root.join("docs/superpowers/specs")).unwrap();
    fs::write(root.join("docs/specs/3.1-foo.md"), b"# 3.1 — Foo\n").unwrap();
    fs::write(root.join("docs/specs/_template.md"), b"# template\n").unwrap();
    fs::write(root.join("docs/specs/drafts/wip.md"), b"# wip\n").unwrap();
    fs::write(
        root.join("docs/superpowers/specs/2026-05-04-bar-design.md"),
        b"# bar\n",
    )
    .unwrap();
    fs::write(root.join("README.md"), b"# readme").unwrap();

    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::storage::SCHEMA).unwrap();

    let inserted = snapshot_existing(&conn, root, 1234).unwrap();
    assert_eq!(inserted, 2, "only 2 valid specs counted");

    let rows: Vec<String> = conn
        .prepare("SELECT path FROM seen_specs ORDER BY path")
        .unwrap()
        .query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .filter_map(|r| r.ok())
        .collect();
    assert!(rows.iter().any(|p| p.ends_with("3.1-foo.md")));
    assert!(rows
        .iter()
        .any(|p| p.ends_with("2026-05-04-bar-design.md")));
}

#[test]
fn snapshot_is_idempotent() {
    use rusqlite::Connection;
    use std::fs;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("docs/specs")).unwrap();
    fs::write(root.join("docs/specs/3.1-foo.md"), b"# 3.1\n").unwrap();

    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::storage::SCHEMA).unwrap();

    let first = snapshot_existing(&conn, root, 100).unwrap();
    let second = snapshot_existing(&conn, root, 200).unwrap();
    assert_eq!(first, 1);
    assert_eq!(second, 0, "second snapshot inserts nothing");
}
```

Note: the `storage::SCHEMA` constant is private. Make it `pub(crate)`. Open `crates/app/src/storage.rs` and change `const SCHEMA: &str` to `pub(crate) const SCHEMA: &str`.

Also, ensure `tempfile` is a dev-dependency. Check `crates/app/Cargo.toml` `[dev-dependencies]`. If absent, add:

```toml
[dev-dependencies]
tempfile = "3"
```

(If already present from earlier specs, do nothing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant spec_detector::tests::snapshot_inserts_existing_specs_and_skips_unrelated`
Expected: FAIL with `cannot find function ... snapshot_existing`.

- [ ] **Step 3: Implement snapshot**

In `crates/app/src/spec_detector.rs`, above the `#[cfg(test)]` block, add:

```rust
use rusqlite::Connection;

/// Recursively walk the spec directories under `repo_root` and insert
/// every recognized spec into `seen_specs`. Returns the number of new
/// rows inserted (existing rows are ignored — idempotent).
pub fn snapshot_existing(
    conn: &Connection,
    repo_root: &Path,
    now_unix_ms: i64,
) -> rusqlite::Result<usize> {
    let mut inserted = 0usize;
    for sub in ["docs/specs", "docs/superpowers/specs"] {
        let dir = repo_root.join(sub);
        if !dir.is_dir() {
            continue;
        }
        let entries = match std::fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            if classify_spec(repo_root, &path).is_none() {
                continue;
            }
            let path_str = path.to_string_lossy().into_owned();
            let root_str = repo_root.to_string_lossy().into_owned();
            let n = conn.execute(
                "INSERT OR IGNORE INTO seen_specs (repo_root, path, first_seen_at) \
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![root_str, path_str, now_unix_ms],
            )?;
            inserted += n;
        }
    }
    Ok(inserted)
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p covenant spec_detector::tests::`
Expected: all snapshot tests PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/spec_detector.rs crates/app/src/storage.rs crates/app/Cargo.toml
git commit -m "feat(spec_detector): add idempotent snapshot of existing specs"
```

---

## Task 6: Candidate decision (`maybe_emit_candidate`)

**Files:**
- Modify: `crates/app/src/spec_detector.rs`

- [ ] **Step 1: Write the failing test**

Append to `tests`:

```rust
#[test]
fn new_spec_decides_emit_and_records() {
    use rusqlite::Connection;
    use std::fs;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    fs::create_dir_all(root.join("docs/specs")).unwrap();
    let path = root.join("docs/specs/3.16-foo.md");
    fs::write(
        &path,
        b"# 3.16 — Foo\n\n## Goal\n\nDo the foo thing.\n\n## Out\n",
    )
    .unwrap();

    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::storage::SCHEMA).unwrap();

    let cand = maybe_emit_candidate(&conn, root, &path, 1234)
        .unwrap()
        .expect("should emit");
    assert_eq!(cand.source, SpecSource::Covenant);
    assert_eq!(cand.title.as_deref(), Some("3.16 — Foo"));
    assert_eq!(cand.goal_snippet, "Do the foo thing.");

    // Second call: row exists, no emit.
    let cand2 = maybe_emit_candidate(&conn, root, &path, 5678).unwrap();
    assert!(cand2.is_none());
}

#[test]
fn unrecognized_path_does_not_emit() {
    use rusqlite::Connection;
    use tempfile::TempDir;

    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch(crate::storage::SCHEMA).unwrap();

    let path = root.join("README.md");
    let out = maybe_emit_candidate(&conn, root, &path, 0).unwrap();
    assert!(out.is_none());
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant spec_detector::tests::new_spec_decides_emit_and_records`
Expected: FAIL with `cannot find ... maybe_emit_candidate` or `SpecCandidate`.

- [ ] **Step 3: Implement candidate type + decision**

In `crates/app/src/spec_detector.rs`, above the `#[cfg(test)]` block:

```rust
#[derive(Debug, Clone, serde::Serialize)]
pub struct SpecCandidate {
    pub repo_root: String,
    pub path: String,
    pub source: SpecSource,
    pub title: Option<String>,
    pub goal_snippet: String,
}

/// If `path` classifies as a spec AND the path is not yet in `seen_specs`,
/// insert it and return a `SpecCandidate` to emit. Otherwise return None.
pub fn maybe_emit_candidate(
    conn: &Connection,
    repo_root: &Path,
    path: &Path,
    now_unix_ms: i64,
) -> rusqlite::Result<Option<SpecCandidate>> {
    let Some(source) = classify_spec(repo_root, path) else {
        return Ok(None);
    };
    let path_str = path.to_string_lossy().into_owned();
    let root_str = repo_root.to_string_lossy().into_owned();

    let inserted = conn.execute(
        "INSERT OR IGNORE INTO seen_specs (repo_root, path, first_seen_at) \
         VALUES (?1, ?2, ?3)",
        rusqlite::params![&root_str, &path_str, now_unix_ms],
    )?;
    if inserted == 0 {
        return Ok(None); // already seen
    }

    let body = std::fs::read_to_string(path).unwrap_or_default();
    let title = extract_title(&body);
    let goal_snippet = extract_goal_snippet(&body, 200);

    Ok(Some(SpecCandidate {
        repo_root: root_str,
        path: path_str,
        source,
        title,
        goal_snippet,
    }))
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p covenant spec_detector::tests::`
Expected: PASS (all candidate tests + previous tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/spec_detector.rs
git commit -m "feat(spec_detector): add maybe_emit_candidate dedupe + candidate type"
```

---

## Task 7: `SpecDetector` lifecycle with FS watcher + Tauri emit

**Files:**
- Modify: `crates/app/src/spec_detector.rs`
- Modify: `crates/app/src/lib.rs`

This task adds the runtime owner. It is integration-shaped; we test it manually in Task 11. Unit-test coverage stays on the pure functions above.

- [ ] **Step 1: Add the runtime struct**

Append to `crates/app/src/spec_detector.rs`:

```rust
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

/// Owns the FS watcher and the SQLite handle for one repo_root.
pub struct SpecDetector {
    _watcher: RecommendedWatcher,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl SpecDetector {
    /// Start a detector for `repo_root`. Performs the snapshot, then
    /// watches `docs/specs` and `docs/superpowers/specs` for new files.
    /// On a hit, emits a `spec:candidate` Tauri event with payload
    /// `SpecCandidate`.
    ///
    /// `db_path` is the absolute path to the covenant SQLite file; the
    /// detector opens its own connection so the watcher thread does not
    /// share `AppState`'s mutex.
    pub fn start(
        app: AppHandle,
        repo_root: PathBuf,
        db_path: PathBuf,
    ) -> Result<Self, String> {
        // Snapshot existing on a blocking spawn.
        {
            let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
            snapshot_existing(&conn, &repo_root, now_ms()).map_err(|e| e.to_string())?;
        }

        let (tx, mut rx) = mpsc::unbounded_channel::<PathBuf>();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            let Ok(event) = res else { return };
            if !matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(notify::event::ModifyKind::Name(_))
            ) {
                return;
            }
            for path in event.paths {
                let _ = tx.send(path);
            }
        })
        .map_err(|e| e.to_string())?;

        for sub in ["docs/specs", "docs/superpowers/specs"] {
            let dir = repo_root.join(sub);
            if !dir.is_dir() {
                continue;
            }
            // Non-recursive: drafts/ subdir is intentionally excluded by
            // classify_spec, but we still avoid recursive watching to
            // keep noise low.
            if let Err(e) = watcher.watch(&dir, RecursiveMode::NonRecursive) {
                tracing::warn!(?dir, %e, "spec_detector: failed to watch dir");
            }
        }

        let app_clone = app.clone();
        let root_clone = repo_root.clone();
        let db_clone = db_path.clone();
        tokio::spawn(async move {
            let conn = match Connection::open(&db_clone) {
                Ok(c) => Arc::new(Mutex::new(c)),
                Err(e) => {
                    tracing::error!(%e, "spec_detector: open conn failed");
                    return;
                }
            };
            while let Some(path) = rx.recv().await {
                if !path.is_file() {
                    continue;
                }
                let cand = {
                    let conn = conn.lock().unwrap();
                    match maybe_emit_candidate(&conn, &root_clone, &path, now_ms()) {
                        Ok(c) => c,
                        Err(e) => {
                            tracing::warn!(%e, ?path, "spec_detector: decide failed");
                            continue;
                        }
                    }
                };
                if let Some(cand) = cand {
                    if let Err(e) = app_clone.emit("spec:candidate", &cand) {
                        tracing::warn!(%e, "spec_detector: emit failed");
                    } else {
                        tracing::info!(path = %cand.path, source = ?cand.source, "spec_detector: emitted candidate");
                    }
                }
            }
        });

        Ok(Self { _watcher: watcher })
    }
}

#[tauri::command]
pub async fn mark_spec_seen(
    state: tauri::State<'_, crate::AppState>,
    repo_root: String,
    path: String,
) -> Result<(), String> {
    let conn = state.db.acquire().await.map_err(|e| e.to_string())?;
    let r = repo_root;
    let p = path;
    let now = now_ms();
    tokio::task::spawn_blocking(move || {
        conn.with(|c| {
            c.execute(
                "INSERT OR IGNORE INTO seen_specs (repo_root, path, first_seen_at) \
                 VALUES (?1, ?2, ?3)",
                rusqlite::params![r, p, now],
            )
            .map(|_| ())
        })
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e: rusqlite::Error| e.to_string())
}
```

> **Note for the implementer:** the `state.db.acquire().await` + `conn.with(|c| ...)` shape above mirrors how other commands in `crates/app/src/` access SQLite. If the actual `AppState`/`Storage` API differs, ESCALATE — do NOT improvise a new path. Look at how `drafts.rs::publish_draft` or any similar command opens its connection and follow the same pattern. The contract is: command receives `tauri::State<AppState>`, runs the SQL on `tokio::task::spawn_blocking`, returns Result.

- [ ] **Step 2: Wire registration in `lib.rs`**

Open `crates/app/src/lib.rs`. Find the existing `tauri::generate_handler![...]` block. Add `spec_detector::mark_spec_seen` to the list (alphabetical-ish).

Find where `AppState` is constructed and tabs/repos are opened (look for existing repo-root lifecycle — `tab_manifest`, `drafts`, etc.). Add a `spec_detectors: Mutex<HashMap<PathBuf, SpecDetector>>` field if a per-repo registry doesn't already exist; otherwise reuse it.

If no obvious lifecycle hook exists, ESCALATE — the wiring point depends on how the app currently learns about the active repo_root, and getting it wrong silently disables the feature. Document the chosen hook in this task's PR description.

For the simplest first wiring, expose a Tauri command `start_spec_detector(repo_root: String)` that the frontend calls once on app boot per repo, and store the returned detector in the registry to keep the watcher alive:

```rust
#[tauri::command]
pub async fn start_spec_detector(
    state: tauri::State<'_, crate::AppState>,
    app: AppHandle,
    repo_root: String,
) -> Result<(), String> {
    let path = PathBuf::from(&repo_root);
    let db_path = state.db_path().clone(); // or whatever the equivalent is
    let mut reg = state.spec_detectors.lock().await;
    if reg.contains_key(&path) {
        return Ok(());
    }
    let det = SpecDetector::start(app, path.clone(), db_path)?;
    reg.insert(path, det);
    Ok(())
}
```

Add `spec_detector::start_spec_detector` to the `generate_handler!` list.

- [ ] **Step 3: Verify it builds**

Run: `cargo check -p covenant`
Expected: builds clean. If the AppState shape for `db_path` / `spec_detectors` doesn't exist yet, add the field and a constructor update; copy the pattern from any existing `Mutex<HashMap<...>>` field in `AppState`.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/spec_detector.rs crates/app/src/lib.rs
git commit -m "feat(spec_detector): wire FS watcher + Tauri commands and event"
```

---

## Task 8: TS API wrappers + types

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Add the wrappers**

Open `ui/src/api.ts`. Locate the existing `import { invoke } ...` block and the convention for command wrappers (look for `draftsApi` or similar). Append:

```ts
export type SpecSource = "covenant" | "superpowers";

export interface SpecCandidate {
  repo_root: string;
  path: string;
  source: SpecSource;
  title: string | null;
  goal_snippet: string;
}

export const specDetectorApi = {
  start: (repoRoot: string): Promise<void> =>
    invoke("start_spec_detector", { repoRoot }),

  markSeen: (repoRoot: string, path: string): Promise<void> =>
    invoke("mark_spec_seen", { repoRoot, path }),
};

/**
 * Subscribe to spec candidates emitted by the detector. The handler is
 * called once per new spec. Returns an unsubscribe function.
 */
export async function subscribeSpecCandidates(
  handler: (cand: SpecCandidate) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<SpecCandidate>("spec:candidate", (e) => {
    handler(e.payload);
  });
  return unlisten;
}
```

- [ ] **Step 2: Verify it typechecks**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(api): add specDetectorApi wrappers and SpecCandidate type"
```

---

## Task 9: `specPromptState` — pure filter logic with tests

**Files:**
- Create: `ui/src/aom/spec-prompt-state.ts`
- Create: `ui/src/aom/spec-prompt.test.ts`

We split the pure logic (filter + dismiss + cache) from the DOM-touching toast renderer so we can unit-test it.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/aom/spec-prompt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  createSpecPromptState,
  type TabSnapshot,
} from "./spec-prompt-state";
import type { SpecCandidate } from "../api";

const cand = (over: Partial<SpecCandidate> = {}): SpecCandidate => ({
  repo_root: "/tmp/repo",
  path: "/tmp/repo/docs/specs/3.16-foo.md",
  source: "covenant",
  title: "3.16 — Foo",
  goal_snippet: "Does the foo.",
  ...over,
});

const tab = (over: Partial<TabSnapshot> = {}): TabSnapshot => ({
  id: "t1",
  cwd: "/tmp/repo/sub",
  hasMission: false,
  hasOperator: true,
  ...over,
});

describe("specPromptState", () => {
  it("returns eligible tabs only (cwd ⊂ repo, no mission, has operator)", () => {
    const s = createSpecPromptState();
    const tabs = [
      tab({ id: "ok" }),
      tab({ id: "wrong-repo", cwd: "/elsewhere" }),
      tab({ id: "with-mission", hasMission: true }),
      tab({ id: "no-operator", hasOperator: false }),
    ];
    const elig = s.eligibleTabs(cand(), tabs);
    expect(elig.map((t) => t.id)).toEqual(["ok"]);
  });

  it("dismiss prevents future toasts for that tab/path", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 1000);
    s.dismiss("t1", c.path);
    expect(s.isDismissed("t1", c.path)).toBe(true);
    expect(s.isDismissed("t2", c.path)).toBe(false);
  });

  it("getPendingForTab returns candidates within the 10-min window", () => {
    const s = createSpecPromptState();
    const c1 = cand({ path: "/r/a.md" });
    const c2 = cand({ path: "/r/b.md" });
    s.recordCandidate(c1, 0);
    s.recordCandidate(c2, 9 * 60 * 1000);

    const pending = s.getPendingForTab(
      tab(),
      [tab()],
      10 * 60 * 1000 - 1, // now
    );
    expect(pending.map((c) => c.path)).toEqual(["/r/a.md", "/r/b.md"]);
  });

  it("getPendingForTab drops candidates older than 10 min", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    const pending = s.getPendingForTab(tab(), [tab()], 11 * 60 * 1000);
    expect(pending).toEqual([]);
  });

  it("getPendingForTab excludes dismissed", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    s.dismiss("t1", c.path);
    const pending = s.getPendingForTab(tab(), [tab()], 1000);
    expect(pending).toEqual([]);
  });

  it("acceptOnTab clears the candidate from pending for that tab", () => {
    const s = createSpecPromptState();
    const c = cand();
    s.recordCandidate(c, 0);
    s.acceptOnTab("t1", c.path);
    const pending = s.getPendingForTab(tab(), [tab()], 1000);
    expect(pending).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd ui && npx vitest run aom/spec-prompt.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `spec-prompt-state.ts`**

Create `ui/src/aom/spec-prompt-state.ts`:

```ts
import type { SpecCandidate } from "../api";

export interface TabSnapshot {
  id: string;
  cwd: string;
  hasMission: boolean;
  hasOperator: boolean;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

interface PendingEntry {
  candidate: SpecCandidate;
  receivedAtMs: number;
}

export interface SpecPromptState {
  eligibleTabs(c: SpecCandidate, tabs: TabSnapshot[]): TabSnapshot[];
  recordCandidate(c: SpecCandidate, nowMs: number): void;
  dismiss(tabId: string, path: string): void;
  isDismissed(tabId: string, path: string): boolean;
  acceptOnTab(tabId: string, path: string): void;
  getPendingForTab(
    tab: TabSnapshot,
    allTabs: TabSnapshot[],
    nowMs: number,
  ): SpecCandidate[];
}

export function createSpecPromptState(): SpecPromptState {
  // path -> entry (one entry per spec; UI iterates across pending)
  const pending = new Map<string, PendingEntry>();
  // tabId -> set of paths the tab has dismissed or accepted
  const consumed = new Map<string, Set<string>>();

  const isUnder = (cwd: string, root: string): boolean => {
    const norm = (p: string) => p.replace(/\/+$/, "");
    const r = norm(root);
    const c = norm(cwd);
    return c === r || c.startsWith(r + "/");
  };

  const consume = (tabId: string, path: string) => {
    let s = consumed.get(tabId);
    if (!s) {
      s = new Set();
      consumed.set(tabId, s);
    }
    s.add(path);
  };

  return {
    eligibleTabs(c, tabs) {
      return tabs.filter(
        (t) => isUnder(t.cwd, c.repo_root) && !t.hasMission && t.hasOperator,
      );
    },
    recordCandidate(c, nowMs) {
      pending.set(c.path, { candidate: c, receivedAtMs: nowMs });
    },
    dismiss(tabId, path) {
      consume(tabId, path);
    },
    isDismissed(tabId, path) {
      return consumed.get(tabId)?.has(path) ?? false;
    },
    acceptOnTab(tabId, path) {
      consume(tabId, path);
    },
    getPendingForTab(tab, allTabs, nowMs) {
      const out: SpecCandidate[] = [];
      for (const [path, entry] of pending) {
        if (nowMs - entry.receivedAtMs > PENDING_TTL_MS) continue;
        if (consumed.get(tab.id)?.has(path)) continue;
        const elig = this.eligibleTabs(entry.candidate, allTabs).some(
          (t) => t.id === tab.id,
        );
        if (!elig) continue;
        out.push(entry.candidate);
      }
      return out;
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run aom/spec-prompt.test.ts`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/aom/spec-prompt-state.ts ui/src/aom/spec-prompt.test.ts
git commit -m "feat(spec-prompt): add pure state module with filter and TTL cache"
```

---

## Task 10: Statusbar toast UI + bootstrap

**Files:**
- Create: `ui/src/aom/spec-prompt.ts`
- Modify: `ui/src/main.ts`
- Modify: `ui/src/styles.css`

This is DOM glue — manual verification only.

- [ ] **Step 1: Create the toast renderer**

Create `ui/src/aom/spec-prompt.ts`:

```ts
import {
  specDetectorApi,
  subscribeSpecCandidates,
  type SpecCandidate,
} from "../api";
import {
  createSpecPromptState,
  type SpecPromptState,
  type TabSnapshot,
} from "./spec-prompt-state";

/** Provided by the host (usually tabs/manager). */
export interface SpecPromptHost {
  listTabs(): TabSnapshot[];
  setMissionForTab(tabId: string, path: string): Promise<void>;
  /** Called when the toast is mounted; host returns the container. */
  statusbarContainer(): HTMLElement;
}

let stateSingleton: SpecPromptState | null = null;
let unlisten: (() => void) | null = null;
let hostRef: SpecPromptHost | null = null;

const TOAST_TIMEOUT_MS = 30_000;

export function getSpecPromptState(): SpecPromptState {
  if (!stateSingleton) stateSingleton = createSpecPromptState();
  return stateSingleton;
}

export async function startSpecPrompts(host: SpecPromptHost, repoRoot: string) {
  hostRef = host;
  await specDetectorApi.start(repoRoot);
  if (unlisten) unlisten();
  unlisten = await subscribeSpecCandidates((cand) => {
    onCandidate(cand);
  });
}

export function stopSpecPrompts() {
  unlisten?.();
  unlisten = null;
  hostRef = null;
}

function onCandidate(cand: SpecCandidate) {
  const state = getSpecPromptState();
  const host = hostRef;
  if (!host) return;
  state.recordCandidate(cand, Date.now());
  const tabs = host.listTabs();
  for (const tab of state.eligibleTabs(cand, tabs)) {
    if (state.isDismissed(tab.id, cand.path)) continue;
    renderToast(host, tab, cand);
  }
}

function renderToast(host: SpecPromptHost, tab: TabSnapshot, cand: SpecCandidate) {
  const root = host.statusbarContainer();
  const el = document.createElement("div");
  el.className = "spec-prompt-toast";
  el.dataset.tabId = tab.id;
  el.dataset.path = cand.path;
  const label =
    cand.source === "covenant"
      ? "Mission published"
      : "New spec detected";
  const fileName = cand.path.split("/").pop() ?? cand.path;
  el.innerHTML = `
    <div class="spec-prompt-toast-head">
      <span class="spec-prompt-toast-label">${escapeHtml(label)}</span>
      <span class="spec-prompt-toast-file">${escapeHtml(fileName)}</span>
    </div>
    <div class="spec-prompt-toast-snippet">${escapeHtml(cand.goal_snippet)}</div>
    <div class="spec-prompt-toast-actions">
      <button type="button" class="spec-prompt-toast-set">Set as mission</button>
      <button type="button" class="spec-prompt-toast-dismiss">Dismiss</button>
    </div>
  `;
  root.appendChild(el);

  const close = () => {
    el.remove();
  };

  const timer = setTimeout(() => {
    getSpecPromptState().dismiss(tab.id, cand.path);
    close();
  }, TOAST_TIMEOUT_MS);

  el.querySelector(".spec-prompt-toast-set")!.addEventListener("click", async () => {
    clearTimeout(timer);
    getSpecPromptState().acceptOnTab(tab.id, cand.path);
    try {
      await host.setMissionForTab(tab.id, cand.path);
    } catch (e) {
      console.error("setMissionForTab failed", e);
    }
    close();
  });
  el.querySelector(".spec-prompt-toast-dismiss")!.addEventListener("click", () => {
    clearTimeout(timer);
    getSpecPromptState().dismiss(tab.id, cand.path);
    close();
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Wire bootstrap in `main.ts`**

Open `ui/src/main.ts`. Find where the app discovers its repo root (search for `repoRoot` or `repo_root`). After that point, after the tab manager exists, add:

```ts
import { startSpecPrompts } from "./aom/spec-prompt";

// ...inside the bootstrap, after tabs manager + repoRoot are ready:
await startSpecPrompts(
  {
    listTabs: () => tabsManager.listTabSnapshots(),  // see step 3
    setMissionForTab: async (tabId, path) => {
      await tabsManager.setMissionPathForTab(tabId, path); // see step 3
    },
    statusbarContainer: () => document.querySelector("#statusbar")!, // adjust selector to actual statusbar
  },
  repoRoot,
);
```

If `#statusbar` is not the right selector, locate the actual statusbar container (search for `status-bar` / `statusbar` in `ui/src/`). Use that.

- [ ] **Step 3: Add the two helper methods on `tabsManager`**

Open `ui/src/tabs/manager.ts`. Add:

```ts
listTabSnapshots(): { id: string; cwd: string; hasMission: boolean; hasOperator: boolean }[] {
  return this.tabs.map((t) => ({
    id: t.id,
    cwd: t.cwd ?? "",
    hasMission: !!t.mission?.path,
    hasOperator: !!t.operatorId, // adjust to whatever field exists
  }));
}

async setMissionPathForTab(tabId: string, path: string): Promise<void> {
  const prev = this.activeTabId;
  this.activate(tabId); // or whatever the method is named
  try {
    await this.setMissionPathForActiveTab(path);
  } finally {
    if (prev && prev !== tabId) this.activate(prev);
  }
}
```

If the actual fields differ (e.g. operator stored differently), fix to match. ESCALATE if there is no obvious "operator assigned?" signal — the spec requires that filter.

- [ ] **Step 4: Add toast styles**

Append to `ui/src/styles.css`:

```css
/* === spec-prompt toast (3.16) === */
.spec-prompt-toast {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 12px;
  margin: 4px 8px;
  background: var(--bg-overlay);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
  max-width: 360px;
}
.spec-prompt-toast-head {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.spec-prompt-toast-label {
  font-weight: 600;
  color: var(--accent);
}
.spec-prompt-toast-file {
  font-family: var(--font-mono, monospace);
  color: var(--muted);
  font-size: 11px;
}
.spec-prompt-toast-snippet {
  color: var(--muted);
  line-height: 1.4;
}
.spec-prompt-toast-actions {
  display: flex;
  gap: 6px;
  margin-top: 4px;
}
.spec-prompt-toast-actions button {
  font-size: 11px;
  padding: 4px 10px;
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
  border-radius: 4px;
  cursor: pointer;
}
.spec-prompt-toast-actions .spec-prompt-toast-set {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
.spec-prompt-toast-actions button:hover {
  filter: brightness(1.1);
}
```

- [ ] **Step 5: Verify it typechecks**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/aom/spec-prompt.ts ui/src/main.ts ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(spec-prompt): render statusbar toast on new spec candidates"
```

---

## Task 11: Engage AOM "last call" modal

**Files:**
- Modify: `ui/src/aom/banner.ts` (or wherever Engage AOM is triggered)
- Modify: `ui/src/aom/spec-prompt.ts` (export helper)

- [ ] **Step 1: Export the helper**

Append to `ui/src/aom/spec-prompt.ts`:

```ts
/**
 * Returns the most recent pending candidate for `tabId`, or null.
 * Callers use this to show the "last call" modal at Engage AOM.
 */
export function getPendingSpecCandidateForTab(tabId: string): SpecCandidate | null {
  if (!hostRef) return null;
  const tabs = hostRef.listTabs();
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return null;
  const pending = getSpecPromptState().getPendingForTab(tab, tabs, Date.now());
  return pending[0] ?? null;
}
```

- [ ] **Step 2: Hook Engage AOM**

Open `ui/src/aom/banner.ts`. Find the Engage AOM button click handler (search for `engage` / `aom_engage` / similar). At the top of the handler, before any backend call, check whether the active tab has a mission. If NOT, call:

```ts
import {
  getPendingSpecCandidateForTab,
  getSpecPromptState,
} from "./spec-prompt";

// ...inside the engage handler:
const tab = activeTab(); // or whatever the existing helper is
if (!tab.mission?.path) {
  const cand = getPendingSpecCandidateForTab(tab.id);
  if (cand) {
    const choice = await showLastCallModal(cand);
    if (choice === "use") {
      await tabsManager.setMissionPathForTab(tab.id, cand.path);
      getSpecPromptState().acceptOnTab(tab.id, cand.path);
    } else if (choice === "cancel") {
      return; // abort engage
    }
    // "without" falls through to engage as-is
  }
}
// ... existing engage logic
```

Implement `showLastCallModal` in `banner.ts`:

```ts
type LastCallChoice = "use" | "without" | "cancel";

async function showLastCallModal(cand: SpecCandidate): Promise<LastCallChoice> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "spec-lastcall-overlay";
    const fileName = cand.path.split("/").pop() ?? cand.path;
    overlay.innerHTML = `
      <div class="spec-lastcall-modal">
        <h3>Detectamos <code>${escapeHtml(fileName)}</code></h3>
        <p>${escapeHtml(cand.goal_snippet)}</p>
        <p>¿Usarlo como misión antes de dormir?</p>
        <div class="spec-lastcall-actions">
          <button data-choice="use">Use it</button>
          <button data-choice="without">Engage without mission</button>
          <button data-choice="cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("button[data-choice]");
      if (!btn) return;
      const choice = btn.dataset.choice as LastCallChoice;
      overlay.remove();
      resolve(choice);
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
```

Add corresponding styles in `ui/src/styles.css`:

```css
.spec-lastcall-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.spec-lastcall-modal {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 20px;
  max-width: 480px;
  font-size: 13px;
}
.spec-lastcall-modal code {
  font-family: var(--font-mono, monospace);
  color: var(--accent);
}
.spec-lastcall-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
.spec-lastcall-actions button {
  padding: 6px 12px;
  border: 1px solid var(--border);
  background: transparent;
  color: inherit;
  border-radius: 4px;
  cursor: pointer;
}
.spec-lastcall-actions button[data-choice="use"] {
  background: var(--accent);
  color: var(--bg);
  border-color: var(--accent);
}
```

- [ ] **Step 3: Verify it typechecks**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/aom/banner.ts ui/src/aom/spec-prompt.ts ui/src/styles.css
git commit -m "feat(spec-prompt): last-call modal at Engage AOM for pending candidates"
```

---

## Task 12: Manual end-to-end verification

**Files:** none

- [ ] **Step 1: Start the app on the karlTerminal repo**

Run: `cargo tauri dev` (or whatever the dev command is in the README — search for `tauri dev` invocations).

- [ ] **Step 2: Verify snapshot suppresses retroactive toasts**

On launch, the app should NOT show any spec toast for the existing specs in `docs/specs/` or `docs/superpowers/specs/`.

- [ ] **Step 3: Verify a Superpowers spec triggers**

In a terminal:

```bash
cat > docs/superpowers/specs/2026-05-04-test-detect-design.md <<'EOF'
# Test detect

## Goal

Verify the detector emits a candidate.

## Out of scope

- Anything else.
EOF
```

Expected: a toast appears in the statusbar of every tab in the karlTerminal repo that has no mission and an operator assigned: `New spec detected — 2026-05-04-test-detect-design.md` with the snippet "Verify the detector emits a candidate."

- [ ] **Step 4: Verify Set / Dismiss flow**

- Click `Set as mission` on one tab → tab's mission becomes the new spec; toast disappears.
- Click `Dismiss` on another tab → toast disappears; engaging AOM after dismiss must NOT show the modal.

- [ ] **Step 5: Verify dedupe**

Edit the file (e.g. `echo " " >> docs/superpowers/specs/2026-05-04-test-detect-design.md`).

Expected: NO new toast.

- [ ] **Step 6: Verify Engage AOM "last call" modal**

Create a second new spec, then on a tab without a mission and without dismissing, click Engage AOM. Modal should appear with the three-button choice. Verify `Use it`, `Engage without mission`, and `Cancel` each behave per spec.

- [ ] **Step 7: Cleanup test files**

```bash
rm docs/superpowers/specs/2026-05-04-test-detect-design.md
rm docs/superpowers/specs/<any other test file you created>
```

Verify these deletions are not committed.

- [ ] **Step 8: Final commit (if any cleanup adjustments)**

If steps revealed a bug, fix it and commit. Otherwise, no commit needed.

---

## Self-Review Notes

- **Spec coverage:** every Acceptance Criterion in `docs/specs/3.16-spec-auto-detect-mission.md` maps to a task here:
  - Snapshot → Task 5
  - Superpowers/Covenant detection → Tasks 3 + 6 + 7
  - Toast labels per source → Task 10
  - Set/Dismiss → Task 10
  - Eligible tab filter (cwd, no mission, operator) → Task 9 (state) + Task 10 (wire)
  - Dedupe (edits don't refire) → Task 6
  - Engage AOM guard modal → Task 11
  - 10-min TTL window → Task 9
  - Cargo + tsc tests → all backend tasks + Task 9 + Task 10
- **Spec divergence:** the spec mentions a `mission:published` event hook into `drafts.rs`. This plan drops that and relies on the FS watcher instead, since (a) the event does not currently exist, (b) the published file does land in `docs/specs/` on disk, and (c) `seen_specs` dedupe makes the watcher path correct on its own. The behavioral acceptance criteria are unchanged.
- **Risks called out for ESCALATE:**
  - Notify crate version conflicts (Task 1).
  - AppState/Storage connection-acquisition shape if it differs from the assumed pattern (Task 7 step 1, step 2).
  - Lifecycle hook for "app discovers active repo_root" if no obvious wire-point exists (Task 7 step 2).
  - "Operator assigned?" tab field shape if it differs from `operatorId` (Task 10 step 3).
