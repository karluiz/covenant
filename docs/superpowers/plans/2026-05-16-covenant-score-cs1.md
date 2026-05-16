# Covenant Score CS-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship CS-1: local-only Covenant Score with SQLite event store, prompt-count instrumentation in `crates/agent` LLM dispatch, periodic git commit scanner, status-bar chip and Score modal (signed-out look, local stats).

**Architecture:**
- New `crates/score` crate owns the SQLite store, types, scanners, and a global "record" entrypoint.
- `crates/agent` provider dispatch (`collect_oneshot`) invokes a process-global `PromptRecorder` set by the app.
- `crates/app` wires the recorder at startup, exposes Tauri commands, runs the commit scanner task.
- UI adds `ui/src/score/` (chip + modal) and hooks the chip into the existing status bar.

**Tech Stack:** Rust (rusqlite bundled, tokio, chrono, ulid), TS, Tauri 2.

---

## File Structure

**New files:**
- `crates/score/Cargo.toml`
- `crates/score/src/lib.rs` — re-exports + `init` + global `record_prompt` / `record_commit`
- `crates/score/src/types.rs` — `EventKind`, `ScoreEvent`, `DailyCell`, `Summary`
- `crates/score/src/store.rs` — SQLite open, schema, append, aggregate queries
- `crates/score/src/commit_scanner.rs` — periodic `git log` scanner
- `crates/score/tests/store.rs` — integration tests against temp dirs
- `crates/app/src/score_commands.rs` — Tauri commands (`score_summary`, `score_heatmap`)
- `ui/src/score/api.ts` — typed wrappers
- `ui/src/score/chip.ts` — status-bar segment factory
- `ui/src/score/modal.ts` — modal renderer
- `ui/src/score/styles.css` — modal + heatmap styles

**Modified files:**
- `Cargo.toml` (workspace root) — add `crates/score` member
- `crates/agent/Cargo.toml` — depend on `karl-score` workspace dep
- `crates/agent/src/provider/mod.rs` — call `karl_score::record_prompt(...)` inside `collect_oneshot`
- `crates/app/Cargo.toml` — depend on `karl-score`
- `crates/app/src/lib.rs` — init score store at startup, register commands, spawn scanner
- `ui/src/status/bar.ts` — append score segment before version segment
- `ui/src/main.ts` — import + register score module
- `ui/src/styles.css` — `@import` score styles

---

## Task 1: Workspace skeleton + types

**Files:**
- Create: `crates/score/Cargo.toml`
- Create: `crates/score/src/lib.rs`
- Create: `crates/score/src/types.rs`
- Modify: `Cargo.toml` (root)

- [ ] **Step 1: Add workspace member**

In `/Users/carlosgallardoarenas/Sources/karlTerminal/Cargo.toml` add `"crates/score",` to `[workspace] members`.

- [ ] **Step 2: Create `crates/score/Cargo.toml`**

```toml
[package]
name = "karl-score"
version.workspace = true
edition.workspace = true
authors.workspace = true
license.workspace = true
publish.workspace = true
description = "Covenant Score — local prompt/commit tracking"

[dependencies]
rusqlite = { workspace = true }
tokio = { workspace = true }
chrono = { version = "0.4", features = ["serde"] }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
once_cell = "1"

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 3: Create `crates/score/src/types.rs`**

```rust
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EventKind {
    Prompt,
    Commit,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScoreEvent {
    pub timestamp_ms: i64,
    pub kind: EventKind,
    /// "anthropic" / "openai_compat" / "<repo>:<sha7>" for commits
    pub executor: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DailyCell {
    /// ISO date (YYYY-MM-DD), local tz of recording device.
    pub day: String,
    pub prompts: u32,
    pub commits: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Summary {
    pub total_prompts: u64,
    pub total_commits: u64,
    pub today_prompts: u32,
    pub today_commits: u32,
    pub current_streak: u32,
    pub longest_streak: u32,
}

pub fn day_from_ms_local(ms: i64) -> String {
    let dt: DateTime<Utc> = DateTime::from_timestamp_millis(ms).unwrap_or_default();
    let local = dt.with_timezone(&chrono::Local);
    local.format("%Y-%m-%d").to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn day_format_matches_iso() {
        let d = day_from_ms_local(0);
        // 1970-01-01 in any tz produces YYYY-MM-DD shape
        assert_eq!(d.len(), 10);
        assert_eq!(&d[4..5], "-");
    }
}
```

- [ ] **Step 4: Create `crates/score/src/lib.rs` stub**

```rust
//! Covenant Score — local prompt/commit tracking. Append-only SQLite
//! store backs a tiny aggregation layer used by the status-bar chip
//! and Score modal.

pub mod commit_scanner;
pub mod store;
pub mod types;

pub use store::ScoreStore;
pub use types::{DailyCell, EventKind, ScoreEvent, Summary};
```

Note: commit_scanner + store come later — for this task create empty modules so it compiles:

```rust
// crates/score/src/store.rs
pub struct ScoreStore;
```
```rust
// crates/score/src/commit_scanner.rs
// placeholder
```

- [ ] **Step 5: Build to confirm workspace integration**

Run: `cargo check -p karl-score`
Expected: clean build.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/score
git commit -m "feat(score): scaffold karl-score crate with event types"
```

---

## Task 2: SQLite store — append + daily aggregate

**Files:**
- Replace: `crates/score/src/store.rs`
- Create: `crates/score/tests/store.rs`

- [ ] **Step 1: Write the failing test**

`crates/score/tests/store.rs`:

```rust
use karl_score::{EventKind, ScoreStore};
use tempfile::tempdir;

#[test]
fn append_and_summary_counts_prompts_and_commits() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    store.append(now, EventKind::Prompt, "anthropic").unwrap();
    store.append(now, EventKind::Prompt, "anthropic").unwrap();
    store.append(now, EventKind::Commit, "repo:abc1234").unwrap();
    let s = store.summary().unwrap();
    assert_eq!(s.total_prompts, 2);
    assert_eq!(s.total_commits, 1);
    assert_eq!(s.today_prompts, 2);
    assert_eq!(s.today_commits, 1);
}

#[test]
fn heatmap_returns_one_cell_per_day_with_data() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let day_ms = 86_400_000i64;
    // Three events on day 0, two on day 1 (relative epoch).
    store.append(0, EventKind::Prompt, "anthropic").unwrap();
    store.append(1000, EventKind::Prompt, "anthropic").unwrap();
    store.append(2000, EventKind::Prompt, "anthropic").unwrap();
    store.append(day_ms, EventKind::Prompt, "anthropic").unwrap();
    store.append(day_ms + 1000, EventKind::Prompt, "anthropic").unwrap();
    let cells = store.heatmap_all().unwrap();
    assert_eq!(cells.len(), 2);
    assert_eq!(cells[0].prompts, 3);
    assert_eq!(cells[1].prompts, 2);
}

#[test]
fn streak_increments_for_consecutive_days_and_breaks_on_gap() {
    let dir = tempdir().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let now = chrono::Local::now();
    let one_day = chrono::Duration::days(1);
    for offset in [3i64, 2, 1, 0] {
        let ts = (now - one_day * offset as i32).timestamp_millis();
        store.append(ts, EventKind::Prompt, "anthropic").unwrap();
    }
    let s = store.summary().unwrap();
    assert_eq!(s.current_streak, 4);
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl-score`
Expected: compile error (`ScoreStore::open` not found).

- [ ] **Step 3: Implement the store**

Replace `crates/score/src/store.rs`:

```rust
use crate::types::{day_from_ms_local, DailyCell, EventKind, Summary};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ScoreError {
    #[error("sqlite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ScoreError>;

pub struct ScoreStore {
    conn: Arc<Mutex<Connection>>,
    #[allow(dead_code)]
    path: PathBuf,
}

impl ScoreStore {
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("score.sqlite");
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS score_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                executor TEXT NOT NULL,
                day TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_day ON score_events(day);
            CREATE INDEX IF NOT EXISTS idx_events_kind ON score_events(kind);",
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), path })
    }

    pub fn append(&self, timestamp_ms: i64, kind: EventKind, executor: &str) -> Result<()> {
        let day = day_from_ms_local(timestamp_ms);
        let kind_s = match kind { EventKind::Prompt => "prompt", EventKind::Commit => "commit" };
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO score_events(timestamp_ms, kind, executor, day) VALUES (?1, ?2, ?3, ?4)",
            params![timestamp_ms, kind_s, executor, day],
        )?;
        Ok(())
    }

    pub fn heatmap_all(&self) -> Result<Vec<DailyCell>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(
            "SELECT day,
                    SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END) AS p,
                    SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END) AS k
             FROM score_events
             GROUP BY day
             ORDER BY day ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(DailyCell {
                day: r.get(0)?,
                prompts: r.get::<_, i64>(1)? as u32,
                commits: r.get::<_, i64>(2)? as u32,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn summary(&self) -> Result<Summary> {
        let cells = self.heatmap_all()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let mut total_p: u64 = 0;
        let mut total_c: u64 = 0;
        let mut today_p = 0u32;
        let mut today_c = 0u32;
        for cell in &cells {
            total_p += cell.prompts as u64;
            total_c += cell.commits as u64;
            if cell.day == today {
                today_p = cell.prompts;
                today_c = cell.commits;
            }
        }
        let (current_streak, longest_streak) = compute_streaks(&cells, &today);
        Ok(Summary { total_prompts: total_p, total_commits: total_c,
                     today_prompts: today_p, today_commits: today_c,
                     current_streak, longest_streak })
    }
}

/// Walk cells ascending; streak counts consecutive ISO days with prompts>=1.
/// `current_streak` ends at today (or yesterday if today is 0 — today doesn't
/// break the streak until midnight per spec).
fn compute_streaks(cells: &[DailyCell], today: &str) -> (u32, u32) {
    use chrono::NaiveDate;
    let parse = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
    let mut longest = 0u32;
    let mut run = 0u32;
    let mut prev: Option<NaiveDate> = None;
    let mut last_active: Option<NaiveDate> = None;
    for cell in cells {
        if cell.prompts == 0 { continue; }
        let d = match parse(&cell.day) { Some(d) => d, None => continue };
        match prev {
            Some(p) if (d - p).num_days() == 1 => run += 1,
            _ => run = 1,
        }
        longest = longest.max(run);
        prev = Some(d);
        last_active = Some(d);
    }
    let today_d = parse(today);
    let current = match (last_active, today_d) {
        (Some(la), Some(td)) => {
            let gap = (td - la).num_days();
            if gap <= 1 { run } else { 0 }
        }
        _ => 0,
    };
    (current, longest)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-score`
Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/score
git commit -m "feat(score): SQLite event store with daily aggregates and streak math"
```

---

## Task 3: Global prompt recorder hook

**Files:**
- Modify: `crates/score/src/lib.rs`
- Create: `crates/score/tests/recorder.rs`

- [ ] **Step 1: Write the failing test**

`crates/score/tests/recorder.rs`:

```rust
use karl_score::{record_prompt, set_recorder, ScoreStore, Summary};
use std::sync::Arc;
use tempfile::tempdir;

#[test]
fn record_prompt_appends_via_global_recorder() {
    let dir = tempdir().unwrap();
    let store = Arc::new(ScoreStore::open(dir.path()).unwrap());
    set_recorder(store.clone());
    record_prompt("anthropic");
    record_prompt("openai_compat");
    let s: Summary = store.summary().unwrap();
    assert_eq!(s.total_prompts, 2);
}

#[test]
fn record_prompt_is_noop_without_recorder_set() {
    karl_score::clear_recorder_for_test();
    record_prompt("anthropic"); // should not panic
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p karl-score --test recorder`
Expected: compile errors (functions missing).

- [ ] **Step 3: Implement recorder in `crates/score/src/lib.rs`**

```rust
pub mod commit_scanner;
pub mod store;
pub mod types;

pub use store::{ScoreError, ScoreStore};
pub use types::{DailyCell, EventKind, ScoreEvent, Summary};

use once_cell::sync::OnceCell;
use std::sync::{Arc, Mutex};

static RECORDER: OnceCell<Mutex<Option<Arc<ScoreStore>>>> = OnceCell::new();

fn slot() -> &'static Mutex<Option<Arc<ScoreStore>>> {
    RECORDER.get_or_init(|| Mutex::new(None))
}

pub fn set_recorder(store: Arc<ScoreStore>) {
    if let Ok(mut g) = slot().lock() {
        *g = Some(store);
    }
}

#[doc(hidden)]
pub fn clear_recorder_for_test() {
    if let Ok(mut g) = slot().lock() { *g = None; }
}

pub fn record_prompt(executor: &str) {
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append(now, EventKind::Prompt, executor) {
                tracing::warn!(target: "score", error = %e, "record_prompt failed");
            }
        }
    }
}

pub fn record_commit(repo: &str, sha7: &str) {
    let now = chrono::Utc::now().timestamp_millis();
    let exec = format!("{repo}:{sha7}");
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            let _ = store.append(now, EventKind::Commit, &exec);
        }
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-score`
Expected: all tests pass (5 total now).

- [ ] **Step 5: Commit**

```bash
git add crates/score
git commit -m "feat(score): global recorder for prompt/commit events"
```

---

## Task 4: Wire `record_prompt` into agent provider dispatch

**Files:**
- Modify: `crates/agent/Cargo.toml`
- Modify: `crates/agent/src/provider/mod.rs`

- [ ] **Step 1: Add dep**

In `crates/agent/Cargo.toml` add under `[dependencies]`:

```toml
karl-score = { path = "../score" }
```

- [ ] **Step 2: Instrument `collect_oneshot`**

In `crates/agent/src/provider/mod.rs`, at the top of `collect_oneshot` (line ~61, before the `let buffer = …`), add:

```rust
let executor_label = match provider.kind() {
    ProviderKind::Anthropic => "anthropic",
    ProviderKind::OpenAiCompat => "openai_compat",
};
karl_score::record_prompt(executor_label);
```

- [ ] **Step 3: Build to confirm**

Run: `cargo check -p karl-agent`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add crates/agent
git commit -m "feat(score): record prompt count from agent provider dispatch"
```

---

## Task 5: Commit scanner

**Files:**
- Replace: `crates/score/src/commit_scanner.rs`
- Modify: `crates/score/Cargo.toml` (add `tokio` if not already)
- Modify: `crates/score/tests/store.rs` — add a scanner integration test

- [ ] **Step 1: Write the failing test**

Append to `crates/score/tests/store.rs`:

```rust
use karl_score::commit_scanner::scan_repo_since;
use std::process::Command;
use tempfile::tempdir;

#[test]
fn scan_repo_since_counts_new_commits() {
    let repo = tempdir().unwrap();
    let run = |args: &[&str]| {
        Command::new("git").args(args).current_dir(repo.path()).output().unwrap();
    };
    run(&["init", "-q"]);
    run(&["config", "user.email", "test@x.com"]);
    run(&["config", "user.name", "test"]);
    std::fs::write(repo.path().join("a.txt"), "1").unwrap();
    run(&["add", "."]);
    run(&["commit", "-m", "one"]);
    std::fs::write(repo.path().join("a.txt"), "2").unwrap();
    run(&["commit", "-am", "two"]);

    let dir = tempdir().unwrap();
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let n = scan_repo_since(repo.path(), "test@x.com", 0, &store).unwrap();
    assert_eq!(n, 2);
    let s = store.summary().unwrap();
    assert_eq!(s.total_commits, 2);
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p karl-score`
Expected: compile error (`scan_repo_since` missing).

- [ ] **Step 3: Implement scanner**

Replace `crates/score/src/commit_scanner.rs`:

```rust
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
    let repo_name = repo_path.file_name()
        .and_then(|n| n.to_str()).unwrap_or("repo").to_string();
    let mut n = 0u32;
    for line in s.lines() {
        let mut parts = line.split_whitespace();
        let (Some(sha), Some(ts)) = (parts.next(), parts.next()) else { continue };
        let Ok(ts_s) = ts.parse::<i64>() else { continue };
        if ts_s <= since_ts_seconds { continue; }
        let exec = format!("{repo_name}:{}", &sha[..sha.len().min(7)]);
        let _ = store.append(ts_s * 1000, EventKind::Commit, &exec);
        n += 1;
    }
    Ok(n)
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p karl-score`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/score
git commit -m "feat(score): git commit scanner using git log shell-out"
```

---

## Task 6: App-side wiring — startup + Tauri commands

**Files:**
- Modify: `crates/app/Cargo.toml`
- Create: `crates/app/src/score_commands.rs`
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Add dep**

In `crates/app/Cargo.toml` `[dependencies]`:

```toml
karl-score = { path = "../score" }
```

- [ ] **Step 2: Create `crates/app/src/score_commands.rs`**

```rust
use karl_score::{DailyCell, ScoreStore, Summary};
use std::sync::Arc;
use tauri::State;

pub struct ScoreState(pub Arc<ScoreStore>);

#[tauri::command]
pub fn score_summary(state: State<'_, ScoreState>) -> Result<Summary, String> {
    state.0.summary().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_heatmap(state: State<'_, ScoreState>) -> Result<Vec<DailyCell>, String> {
    state.0.heatmap_all().map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Wire in `crates/app/src/lib.rs`**

Near the top of `lib.rs`, add `mod score_commands;` next to other `mod` declarations.

Inside the Tauri builder `.setup()` closure, just after `data_dir` is computed (around line 2848), before `app.manage(AppState { … })`:

```rust
// Covenant Score — open store and install global recorder so the
// agent crate can call karl_score::record_prompt() without holding
// a State handle.
let score_store = Arc::new(
    karl_score::ScoreStore::open(&data_dir)
        .expect("open score store"),
);
karl_score::set_recorder(score_store.clone());
app.manage(score_commands::ScoreState(score_store.clone()));

// Periodic commit scanner — every 5 minutes scans the cwd of every
// active session for new commits by the local git user.
let scanner_store = score_store.clone();
tauri::async_runtime::spawn(async move {
    use std::time::Duration;
    let mut since = (chrono::Utc::now() - chrono::Duration::hours(24)).timestamp();
    loop {
        tokio::time::sleep(Duration::from_secs(300)).await;
        let email = std::process::Command::new("git")
            .args(["config", "--global", "user.email"])
            .output().ok()
            .and_then(|o| String::from_utf8(o.stdout).ok())
            .map(|s| s.trim().to_string())
            .unwrap_or_default();
        if email.is_empty() { continue; }
        // Walk recent cwds — for v1 use the data_dir's parent project list
        // or just the current process cwd as a starting point; richer
        // tracking comes in CS-1b.
        if let Ok(cwd) = std::env::current_dir() {
            let _ = karl_score::commit_scanner::scan_repo_since(
                &cwd, &email, since, &scanner_store);
        }
        since = chrono::Utc::now().timestamp();
    }
});
```

Then register the commands in the `tauri::generate_handler![…]` macro (find the existing list and append `score_commands::score_summary, score_commands::score_heatmap,`).

- [ ] **Step 4: Build**

Run: `cargo check -p karl-app`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/app
git commit -m "feat(score): wire score store, recorder, commands, and scanner in app"
```

---

## Task 7: UI — typed API + status-bar chip

**Files:**
- Create: `ui/src/score/api.ts`
- Create: `ui/src/score/chip.ts`
- Modify: `ui/src/status/bar.ts`

- [ ] **Step 1: Create `ui/src/score/api.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export interface Summary {
  total_prompts: number;
  total_commits: number;
  today_prompts: number;
  today_commits: number;
  current_streak: number;
  longest_streak: number;
}

export interface DailyCell {
  day: string;
  prompts: number;
  commits: number;
}

export async function scoreSummary(): Promise<Summary> {
  return invoke<Summary>("score_summary");
}

export async function scoreHeatmap(): Promise<DailyCell[]> {
  return invoke<DailyCell[]>("score_heatmap");
}
```

- [ ] **Step 2: Create `ui/src/score/chip.ts`**

```ts
import { scoreSummary, type Summary } from "./api";

export interface ScoreChip {
  el: HTMLElement;
  refresh: () => Promise<void>;
  setOnClick: (h: () => void) => void;
}

export function makeScoreChip(): ScoreChip {
  const el = document.createElement("button");
  el.className = "status-segment status-score";
  el.setAttribute("aria-label", "Covenant score — click to open");
  el.style.cursor = "pointer";

  const text = document.createElement("span");
  text.className = "score-chip-text";
  text.textContent = "Sign in";
  el.appendChild(text);

  let onClick: (() => void) | null = null;
  el.addEventListener("click", () => onClick?.());

  async function refresh(): Promise<void> {
    try {
      const s: Summary = await scoreSummary();
      if (s.total_prompts === 0 && s.total_commits === 0) {
        text.textContent = "Sign in";
      } else {
        const streak = s.current_streak > 0 ? ` · ${s.current_streak}d` : "";
        text.textContent = `${s.total_prompts} prompts${streak}`;
      }
    } catch (e) {
      console.warn("score chip refresh failed", e);
    }
  }

  return {
    el,
    refresh,
    setOnClick: (h) => { onClick = h; },
  };
}
```

- [ ] **Step 3: Mount the chip in `ui/src/status/bar.ts`**

At top of file, add import:

```ts
import { makeScoreChip, type ScoreChip } from "../score/chip";
import { openScoreModal } from "../score/modal";
```

In the StatusBar class (after the `telegramSegment(...)` append, around line 615 — just BEFORE the version segment append), insert the score chip rendering. Add a field on the class:

```ts
private scoreChip: ScoreChip | null = null;
```

Inside the render method, replace the block that pushes telegram + version with:

```ts
this.host.appendChild(telegramSegment(this.currentTgStatus));

if (!this.scoreChip) {
  this.scoreChip = makeScoreChip();
  this.scoreChip.setOnClick(() => openScoreModal());
}
void this.scoreChip.refresh();
this.host.appendChild(this.scoreChip.el);

this.host.appendChild(
  versionSegment(__APP_VERSION__, () => this.onVersionChipClick?.()),
);
```

Note: `openScoreModal` is implemented in Task 8 — for now stub it with a no-op import to keep the build green:

```ts
// ui/src/score/modal.ts (stub for Task 7 build)
export function openScoreModal(): void {
  console.log("score modal not implemented yet");
}
```

- [ ] **Step 4: Build + typecheck**

Run: `cd ui && npm run build`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add ui/src/score ui/src/status/bar.ts
git commit -m "feat(score): status-bar chip rendering prompts + streak"
```

---

## Task 8: UI — Score modal (signed-out look, Layout A)

**Files:**
- Replace: `ui/src/score/modal.ts`
- Create: `ui/src/score/styles.css`
- Modify: `ui/src/styles.css` (add `@import "./score/styles.css";`)

- [ ] **Step 1: Create `ui/src/score/styles.css`**

```css
.score-modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.55);
  backdrop-filter: blur(4px);
  z-index: 2000;
  display: flex; align-items: center; justify-content: center;
}
.score-modal {
  background: #0a0d11;
  border: 1px solid #1a2128;
  border-radius: 10px;
  padding: 28px;
  color: #c8d4dc;
  font-family: ui-monospace, "SF Mono", monospace;
  font-size: 12px;
  width: 760px; max-width: 92vw;
  box-shadow: 0 20px 60px rgba(0,0,0,0.6), 0 0 40px rgba(95,179,196,0.06);
}
.score-modal h3 { color: #e8f1f5; font-size: 16px; margin: 0 0 4px; }
.score-modal .sub { color: #5a6873; font-size: 11px; margin-bottom: 18px; }
.score-stat-row { display: flex; gap: 14px; margin-bottom: 18px; }
.score-stat { flex: 1; padding: 12px; background: rgba(95,179,196,0.04);
  border: 1px solid #1a2a30; border-radius: 6px; }
.score-stat .v { font-size: 22px; color: #7dd3e0; font-weight: 500; }
.score-stat .l { font-size: 9px; text-transform: uppercase;
  letter-spacing: 0.12em; color: #4a5860; margin-top: 4px; }
.score-heatmap { display: grid; grid-template-columns: repeat(53, 10px);
  gap: 3px; padding: 4px 0; }
.score-cell { width: 10px; height: 10px; border-radius: 2px;
  background: #0f1419; border: 1px solid #1a2128; }
.score-cell.l1 { background: rgba(95,179,196,0.2); border-color: rgba(95,179,196,0.3); }
.score-cell.l2 { background: rgba(95,179,196,0.4); border-color: rgba(95,179,196,0.5); }
.score-cell.l3 { background: rgba(95,179,196,0.65);
  border-color: rgba(95,179,196,0.75);
  box-shadow: 0 0 4px rgba(95,179,196,0.4); }
.score-cell.l4 { background: #5fe8d6; border-color: #5fe8d6;
  box-shadow: 0 0 8px rgba(95,232,214,0.7); }
.score-legend { display: flex; align-items: center; gap: 6px; font-size: 10px;
  color: #5a6873; justify-content: flex-end; margin-top: 8px; }
.score-cta { margin-top: 18px; padding: 14px;
  border: 1px solid #2a5a64; border-radius: 8px;
  background: linear-gradient(180deg, rgba(95,179,196,0.06), rgba(95,179,196,0.02));
  display: flex; align-items: center; gap: 14px; }
.score-cta .text { flex: 1; }
.score-cta h4 { color: #e8f1f5; font-size: 13px; margin: 0 0 4px; }
.score-cta p { color: #7a8893; font-size: 11px; margin: 0; line-height: 1.5; }
.score-cta button { background: #1a2128; border: 1px solid #2a3540;
  color: #e8f1f5; border-radius: 6px; padding: 10px 16px;
  font-family: inherit; font-size: 12px; cursor: pointer; }
.score-cta button:hover { background: #232b34; border-color: #3a4854; }
```

- [ ] **Step 2: Append import in `ui/src/styles.css`**

Add at the top (next to other `@import` lines):

```css
@import "./score/styles.css";
```

- [ ] **Step 3: Replace `ui/src/score/modal.ts`**

```ts
import { scoreHeatmap, scoreSummary, type DailyCell, type Summary }
  from "./api";

function intensityClass(prompts: number): string {
  if (prompts === 0) return "";
  if (prompts <= 5) return "l1";
  if (prompts <= 15) return "l2";
  if (prompts <= 40) return "l3";
  return "l4";
}

/// Render 53 weeks × 7 days = 371 cells ending today, filling in the
/// known DailyCell rows by day key. Missing days render as empty.
function renderHeatmap(cells: DailyCell[]): HTMLElement {
  const byDay = new Map<string, number>();
  for (const c of cells) byDay.set(c.day, c.prompts);

  const grid = document.createElement("div");
  grid.className = "score-heatmap";

  const today = new Date();
  // Start 52 weeks ago, aligned to the start of that week.
  const start = new Date(today);
  start.setDate(start.getDate() - 52 * 7 - today.getDay());

  for (let week = 0; week < 53; week++) {
    for (let day = 0; day < 7; day++) {
      const d = new Date(start);
      d.setDate(start.getDate() + week * 7 + day);
      const key = d.toISOString().slice(0, 10);
      const count = byDay.get(key) ?? 0;
      const cell = document.createElement("div");
      cell.className = `score-cell ${intensityClass(count)}`.trim();
      cell.title = `${key} — ${count} prompts`;
      grid.appendChild(cell);
    }
  }
  return grid;
}

export async function openScoreModal(): Promise<void> {
  const existing = document.querySelector(".score-modal-backdrop");
  if (existing) { existing.remove(); return; }

  const [summary, cells]: [Summary, DailyCell[]] =
    await Promise.all([scoreSummary(), scoreHeatmap()]);

  const back = document.createElement("div");
  back.className = "score-modal-backdrop";
  back.addEventListener("click", (e) => {
    if (e.target === back) back.remove();
  });

  const modal = document.createElement("div");
  modal.className = "score-modal";
  modal.innerHTML = `
    <h3>Covenant Score</h3>
    <div class="sub">Tracking local · No sincronizado</div>
    <div class="score-stat-row">
      <div class="score-stat"><div class="v">${summary.total_prompts}</div>
        <div class="l">Total prompts</div></div>
      <div class="score-stat"><div class="v">${summary.today_prompts}</div>
        <div class="l">Today</div></div>
      <div class="score-stat"><div class="v">${summary.current_streak}d</div>
        <div class="l">Current streak</div></div>
      <div class="score-stat"><div class="v">${summary.total_commits}</div>
        <div class="l">Total commits</div></div>
    </div>
    <div class="score-heatmap-wrap"></div>
    <div class="score-legend">
      <span>Less</span>
      <span class="score-cell"></span>
      <span class="score-cell l1"></span>
      <span class="score-cell l2"></span>
      <span class="score-cell l3"></span>
      <span class="score-cell l4"></span>
      <span>More</span>
    </div>
    <div class="score-cta">
      <div class="text">
        <h4>Conecta GitHub para sincronizar</h4>
        <p>Backup, multi-dispositivo, y perfil público (próximamente).</p>
      </div>
      <button type="button" disabled title="Sign-in shipping in CS-2">
        Sign in with GitHub
      </button>
    </div>
  `;
  modal.querySelector(".score-heatmap-wrap")!.appendChild(renderHeatmap(cells));

  back.appendChild(modal);
  document.body.appendChild(back);
}
```

- [ ] **Step 4: Build + run dev**

Run: `cd ui && npm run build`
Expected: clean.

- [ ] **Step 5: Manual UI verification**

Run: `npm run tauri dev` from project root.
Expected:
- Status bar shows `Sign in   v0.5.20` (or similar) on the right.
- After any in-app prompt to Claude/Ollama via the agent panel: chip updates to `N prompts` after `~5s` (next chip refresh on tab switch / refresh trigger).
- Clicking the chip opens the modal with the heatmap (sparse on first run) and four stat tiles. Sign-in button visible but disabled with tooltip "shipping in CS-2".

- [ ] **Step 6: Commit**

```bash
git add ui
git commit -m "feat(score): signed-out Score modal with heatmap and stats"
```

---

## Self-review notes

- Spec coverage: chip ✓, modal layout A ✓, prompts metric ✓, commits metric ✓ (basic — only scans `cwd`; multi-repo richer scan deferred to CS-1b), streak ✓, signed-out CTA ✓, local SQLite ✓, no XP formula ✓.
- Out of scope for CS-1 (call out in PR): PTY-executor prompt detection (Claude Code / Codex inside the PTY), multi-repo scanner, OAuth, Azure backend, public profile.
- Refresh: the chip refreshes on every status-bar render. For livelier feedback, an explicit `refresh()` call after sending a prompt could be added in a follow-up.
