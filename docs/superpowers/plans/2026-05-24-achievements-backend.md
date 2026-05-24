# Achievements Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an SQLite-backed achievements system to `karl-score` that tracks command-milestone unlocks transactionally with `score_events`, and exposes unlock state to the super-agent and future UI.

**Architecture:** New module `crates/score/src/achievements.rs` holds a hard-coded `CATALOG` of `Rule`s. `ScoreStore::open` adds two tables (`achievements`, `user_achievements`) and upserts the catalog. `ScoreStore::append` and `append_with_context` wrap their insert in a transaction, call `achievements::evaluate(&tx, …)`, persist new unlocks in the same tx, and return `Vec<Unlock>`. The agent context builder gains `achievements_summary(&ScoreStore) -> String` for the cached system prompt.

**Tech Stack:** Rust, `rusqlite` (bundled), `tokio`, `tempfile` (tests), workspace deps already wired.

**Spec:** `docs/superpowers/specs/2026-05-24-achievements-backend-design.md`

---

## File Structure

- **Create:** `crates/score/src/achievements.rs` — `Rule`, `Progress`, `Unlock`, `CATALOG`, `evaluate()`, all `eval_*` helpers, unit tests.
- **Modify:** `crates/score/src/lib.rs` — `pub mod achievements;` and re-exports.
- **Modify:** `crates/score/src/store.rs` — migration adds 2 tables, catalog upsert, `append`/`append_with_context` return `Result<Vec<Unlock>>`, new methods `list_achievements`, `recent_unlocks`.
- **Modify:** `crates/score/src/types.rs` — add `AchievementView`, `UnlockedAchievement`.
- **Modify:** `crates/agent/src/context.rs` (or equivalent) — add `achievements_summary(&ScoreStore) -> String`.
- **Modify:** `crates/app/src/lib.rs` — adjust callers of `append*` to consume `Vec<Unlock>` and broadcast `AchievementUnlocked` events. Extend the existing event enum.
- **Modify:** existing tests in `crates/score/tests/*.rs` and `crates/agent/tests/record_llm_call.rs` — adjust to discard the new return value (`let _ = store.append(...)?;`).
- **Create:** `crates/score/tests/achievements.rs` — integration tests against a real `ScoreStore`.

---

## Vocabulary Note

`score_events.kind` is `'prompt' | 'commit'`. There is no generic "command" — the MVP catalog uses prompts as the proxy for "commands run". `executor` is the CLI/tool name (e.g. `"claude"`, `"codex"`, `"copilot"`). The rule ids in the spec map to these:

| Spec id | Concrete SQL |
|---|---|
| `first_command` | `SELECT COUNT(*) FROM score_events WHERE kind='prompt'` ≥ 1 |
| `ten_commands` | same ≥ 10 |
| `century_club` | same ≥ 100 |
| `distinct_tools_10` | `SELECT COUNT(DISTINCT executor) FROM score_events WHERE kind='prompt'` ≥ 10 |

---

## Task 1: Add achievements module skeleton + types

**Files:**
- Create: `crates/score/src/achievements.rs`
- Modify: `crates/score/src/lib.rs`
- Modify: `crates/score/src/types.rs`

- [ ] **Step 1: Create `achievements.rs` with types only (no logic yet)**

```rust
// crates/score/src/achievements.rs
use rusqlite::{Connection, Transaction};

#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub threshold: Option<i64>,
    pub eval: fn(&Connection) -> rusqlite::Result<Progress>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress {
    pub current: i64,
    pub target: i64,
}

impl Progress {
    pub fn unlocked(&self) -> bool {
        self.current >= self.target
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unlock {
    pub id: &'static str,
    pub title: &'static str,
    pub unlocked_at: i64,
    pub progress: i64,
}

// Catalog and evaluate() filled in by Task 3.
pub static CATALOG: &[Rule] = &[];

pub fn evaluate(
    _tx: &Transaction,
    _now_ms: i64,
    _trigger: Option<&str>,
) -> rusqlite::Result<Vec<Unlock>> {
    Ok(Vec::new())
}
```

- [ ] **Step 2: Wire module into `lib.rs`**

Add to `crates/score/src/lib.rs` (near other `pub mod` declarations):

```rust
pub mod achievements;
```

- [ ] **Step 3: Add view types to `types.rs`**

Append to `crates/score/src/types.rs`:

```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AchievementView {
    pub id: String,
    pub title: String,
    pub description: String,
    pub category: String,
    pub threshold: Option<i64>,
    pub unlocked_at: Option<i64>,
    pub progress: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UnlockedAchievement {
    pub id: String,
    pub title: String,
    pub unlocked_at: i64,
}
```

(If `serde` is already imported at top of file, do not duplicate the `use` line.)

- [ ] **Step 4: Verify the crate still compiles**

Run: `cargo build -p karl-score`
Expected: clean build, possibly with unused-code warnings (acceptable at this stage).

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/achievements.rs crates/score/src/lib.rs crates/score/src/types.rs
git commit -m "feat(score): add achievements module skeleton and view types"
```

---

## Task 2: Add migration tables for achievements

**Files:**
- Modify: `crates/score/src/store.rs` (inside `ScoreStore::open`, after existing `CREATE TABLE` statements, before the `Ok(Self { ... })` return)

- [ ] **Step 1: Write a failing integration test**

Create `crates/score/tests/achievements.rs`:

```rust
use karl_score::ScoreStore;
use tempfile::TempDir;

#[test]
fn open_creates_achievements_tables() {
    let dir = TempDir::new().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let conn = store.connection();
    let c = conn.lock().unwrap();

    let count: i64 = c
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type='table' AND name IN ('achievements','user_achievements')",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(count, 2);
}
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `cargo test -p karl-score --test achievements open_creates_achievements_tables`
Expected: FAIL — `no such table` or `assertion `left == right` failed: left: 0, right: 2`.

- [ ] **Step 3: Add migration in `ScoreStore::open`**

In `crates/score/src/store.rs`, inside `ScoreStore::open`, after the existing `CREATE TABLE IF NOT EXISTS external_watermarks ...` statement and before constructing `Self`, append:

```rust
conn.execute_batch(
    "CREATE TABLE IF NOT EXISTS achievements (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        description  TEXT NOT NULL,
        category     TEXT NOT NULL,
        threshold    INTEGER,
        created_at   INTEGER NOT NULL
     );
     CREATE TABLE IF NOT EXISTS user_achievements (
        achievement_id TEXT PRIMARY KEY REFERENCES achievements(id),
        unlocked_at    INTEGER NOT NULL,
        progress       INTEGER NOT NULL DEFAULT 0,
        trigger_event  TEXT
     );
     CREATE INDEX IF NOT EXISTS idx_user_ach_unlocked
        ON user_achievements(unlocked_at);",
)?;
```

(If `execute_batch` is not in scope, fully qualify: `conn.execute_batch(...)`.)

- [ ] **Step 4: Run the test and confirm it passes**

Run: `cargo test -p karl-score --test achievements open_creates_achievements_tables`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/tests/achievements.rs
git commit -m "feat(score): create achievements and user_achievements tables"
```

---

## Task 3: Implement the rule catalog and `evaluate`

**Files:**
- Modify: `crates/score/src/achievements.rs`

- [ ] **Step 1: Write failing tests for each rule eval function**

Append to `crates/score/tests/achievements.rs`:

```rust
use karl_score::achievements::{CATALOG, evaluate, Progress};
use karl_score::EventKind;

fn open_store() -> (TempDir, ScoreStore) {
    let dir = TempDir::new().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    (dir, store)
}

#[test]
fn catalog_has_expected_rules() {
    let ids: Vec<_> = CATALOG.iter().map(|r| r.id).collect();
    assert!(ids.contains(&"first_command"));
    assert!(ids.contains(&"ten_commands"));
    assert!(ids.contains(&"century_club"));
    assert!(ids.contains(&"distinct_tools_10"));
}

#[test]
fn first_command_evaluates_unlocked_after_one_prompt() {
    let (_d, store) = open_store();
    // direct insert via existing append (still returns () in this task)
    store.append(1_700_000_000_000, EventKind::Prompt, "claude").unwrap();

    let conn = store.connection();
    let c = conn.lock().unwrap();
    let rule = CATALOG.iter().find(|r| r.id == "first_command").unwrap();
    let p = (rule.eval)(&c).unwrap();
    assert!(p.unlocked(), "expected unlocked, got {:?}", p);
}

#[test]
fn distinct_tools_requires_ten_unique_executors() {
    let (_d, store) = open_store();
    for i in 0..9 {
        store.append(1_700_000_000_000 + i, EventKind::Prompt, "claude").unwrap();
    }
    let rule = CATALOG.iter().find(|r| r.id == "distinct_tools_10").unwrap();
    {
        let conn = store.connection();
        let c = conn.lock().unwrap();
        let p = (rule.eval)(&c).unwrap();
        assert!(!p.unlocked());
    }
    for (i, exec) in ["codex","copilot","pi","hermes","a","b","c","d","e","f"].iter().enumerate() {
        store.append(1_700_000_001_000 + i as i64, EventKind::Prompt, exec).unwrap();
    }
    let conn = store.connection();
    let c = conn.lock().unwrap();
    let p = (rule.eval)(&c).unwrap();
    assert!(p.unlocked(), "expected unlocked, got {:?}", p);
}
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `cargo test -p karl-score --test achievements`
Expected: `catalog_has_expected_rules` and the eval tests FAIL (empty catalog).

- [ ] **Step 3: Implement catalog + eval helpers**

Replace `achievements.rs` body (keeping types from Task 1):

```rust
use rusqlite::{Connection, Transaction, params};

#[derive(Clone, Copy, Debug)]
pub struct Rule {
    pub id: &'static str,
    pub title: &'static str,
    pub description: &'static str,
    pub category: &'static str,
    pub threshold: Option<i64>,
    pub eval: fn(&Connection) -> rusqlite::Result<Progress>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Progress { pub current: i64, pub target: i64 }
impl Progress {
    pub fn unlocked(&self) -> bool { self.current >= self.target }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Unlock {
    pub id: &'static str,
    pub title: &'static str,
    pub unlocked_at: i64,
    pub progress: i64,
}

fn count_prompts(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row(
        "SELECT COUNT(*) FROM score_events WHERE kind='prompt'",
        [],
        |r| r.get(0),
    )
}

fn distinct_executors(c: &Connection) -> rusqlite::Result<i64> {
    c.query_row(
        "SELECT COUNT(DISTINCT executor) FROM score_events WHERE kind='prompt'",
        [],
        |r| r.get(0),
    )
}

fn eval_prompt_count_1(c: &Connection)   -> rusqlite::Result<Progress> { Ok(Progress { current: count_prompts(c)?, target: 1 }) }
fn eval_prompt_count_10(c: &Connection)  -> rusqlite::Result<Progress> { Ok(Progress { current: count_prompts(c)?, target: 10 }) }
fn eval_prompt_count_100(c: &Connection) -> rusqlite::Result<Progress> { Ok(Progress { current: count_prompts(c)?, target: 100 }) }
fn eval_distinct_executors_10(c: &Connection) -> rusqlite::Result<Progress> { Ok(Progress { current: distinct_executors(c)?, target: 10 }) }

pub static CATALOG: &[Rule] = &[
    Rule { id: "first_command",     title: "Hello, World",      description: "Run your first command.",         category: "commands", threshold: Some(1),   eval: eval_prompt_count_1 },
    Rule { id: "ten_commands",      title: "Getting Warmed Up", description: "Run 10 commands.",                category: "commands", threshold: Some(10),  eval: eval_prompt_count_10 },
    Rule { id: "century_club",      title: "Century Club",      description: "Run 100 commands.",               category: "commands", threshold: Some(100), eval: eval_prompt_count_100 },
    Rule { id: "distinct_tools_10", title: "Toolbelt",          description: "Use 10 distinct executors/CLIs.", category: "commands", threshold: Some(10),  eval: eval_distinct_executors_10 },
];

/// Evaluates every rule not yet present in `user_achievements`.
/// Inserts new unlocks inside the given transaction and returns them.
pub fn evaluate(
    tx: &Transaction,
    now_ms: i64,
    trigger: Option<&str>,
) -> rusqlite::Result<Vec<Unlock>> {
    let mut unlocked_ids = std::collections::HashSet::new();
    {
        let mut stmt = tx.prepare("SELECT achievement_id FROM user_achievements")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for row in rows { unlocked_ids.insert(row?); }
    }

    let mut new_unlocks = Vec::new();
    for rule in CATALOG {
        if unlocked_ids.contains(rule.id) { continue; }
        let p = (rule.eval)(tx)?;
        if p.unlocked() {
            tx.execute(
                "INSERT OR IGNORE INTO user_achievements
                 (achievement_id, unlocked_at, progress, trigger_event)
                 VALUES (?1, ?2, ?3, ?4)",
                params![rule.id, now_ms, p.current, trigger],
            )?;
            new_unlocks.push(Unlock {
                id: rule.id,
                title: rule.title,
                unlocked_at: now_ms,
                progress: p.current,
            });
        }
    }
    Ok(new_unlocks)
}
```

- [ ] **Step 4: Run tests, confirm all pass**

Run: `cargo test -p karl-score --test achievements`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/achievements.rs crates/score/tests/achievements.rs
git commit -m "feat(score): implement achievement rule catalog and evaluator"
```

---

## Task 4: Catalog upsert on `ScoreStore::open`

**Files:**
- Modify: `crates/score/src/store.rs`

- [ ] **Step 1: Write failing test**

Append to `crates/score/tests/achievements.rs`:

```rust
#[test]
fn open_upserts_catalog_into_achievements_table() {
    let dir = TempDir::new().unwrap();
    let _store = ScoreStore::open(dir.path()).unwrap();
    let store = ScoreStore::open(dir.path()).unwrap(); // re-open
    let conn = store.connection();
    let c = conn.lock().unwrap();
    let n: i64 = c.query_row("SELECT COUNT(*) FROM achievements", [], |r| r.get(0)).unwrap();
    assert_eq!(n as usize, CATALOG.len());

    let title: String = c.query_row(
        "SELECT title FROM achievements WHERE id='century_club'",
        [], |r| r.get(0),
    ).unwrap();
    assert_eq!(title, "Century Club");
}
```

- [ ] **Step 2: Run, confirm fail**

Run: `cargo test -p karl-score --test achievements open_upserts_catalog_into_achievements_table`
Expected: FAIL (`0 != 4`).

- [ ] **Step 3: Add upsert after migration in `ScoreStore::open`**

In `crates/score/src/store.rs`, immediately after the `execute_batch` from Task 2 and before `Self` construction, add:

```rust
let now_ms = std::time::SystemTime::now()
    .duration_since(std::time::UNIX_EPOCH)
    .map(|d| d.as_millis() as i64)
    .unwrap_or(0);
{
    let tx = conn.transaction()?;
    for rule in crate::achievements::CATALOG {
        tx.execute(
            "INSERT INTO achievements(id, title, description, category, threshold, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(id) DO UPDATE SET
                title=excluded.title,
                description=excluded.description,
                category=excluded.category,
                threshold=excluded.threshold",
            params![rule.id, rule.title, rule.description, rule.category, rule.threshold, now_ms],
        )?;
    }
    tx.commit()?;
}
```

Note: if `conn` is not `mut` at this point in `open`, change its binding to `let mut conn = ...`.

- [ ] **Step 4: Run, confirm pass**

Run: `cargo test -p karl-score --test achievements`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/tests/achievements.rs
git commit -m "feat(score): upsert achievement catalog on store open"
```

---

## Task 5: Make `append` / `append_with_context` return `Vec<Unlock>`

**Files:**
- Modify: `crates/score/src/store.rs`
- Modify: all existing call sites (see grep list in Step 4)

- [ ] **Step 1: Write failing test**

Append:

```rust
use karl_score::achievements::Unlock;

#[test]
fn append_unlocks_first_command_and_returns_it() {
    let (_d, store) = open_store();
    let unlocks: Vec<Unlock> =
        store.append(1_700_000_000_000, EventKind::Prompt, "claude").unwrap();
    assert!(unlocks.iter().any(|u| u.id == "first_command"));

    // Second append must not re-unlock.
    let unlocks2 = store.append(1_700_000_000_001, EventKind::Prompt, "claude").unwrap();
    assert!(!unlocks2.iter().any(|u| u.id == "first_command"));
}
```

- [ ] **Step 2: Run, confirm fail**

Run: `cargo test -p karl-score --test achievements append_unlocks_first_command_and_returns_it`
Expected: FAIL — return type mismatch (compile error). Compile error counts as a failing test for this step.

- [ ] **Step 3: Refactor `append` to use a transaction and return `Vec<Unlock>`**

Replace the body of `append` in `crates/score/src/store.rs`:

```rust
pub fn append(
    &self,
    timestamp_ms: i64,
    kind: EventKind,
    executor: &str,
) -> Result<Vec<crate::achievements::Unlock>> {
    let day = day_from_ms_local(timestamp_ms);
    let kind_s = match kind {
        EventKind::Prompt => "prompt",
        EventKind::Commit => "commit",
    };
    let mut c = self.conn.lock().unwrap();
    let tx = c.transaction()?;
    tx.execute(
        "INSERT INTO score_events(timestamp_ms, kind, executor, day) VALUES (?1, ?2, ?3, ?4)",
        params![timestamp_ms, kind_s, executor, day],
    )?;
    let unlocks = crate::achievements::evaluate(&tx, timestamp_ms, Some(executor))?;
    tx.commit()?;
    Ok(unlocks)
}
```

And `append_with_context`:

```rust
pub fn append_with_context(
    &self,
    timestamp_ms: i64,
    kind: EventKind,
    executor: &str,
    agent: Option<&str>,
    ctx: &Context,
) -> Result<Vec<crate::achievements::Unlock>> {
    let day = day_from_ms_local(timestamp_ms);
    let kind_s = match kind {
        EventKind::Prompt => "prompt",
        EventKind::Commit => "commit",
    };
    let mut c = self.conn.lock().unwrap();
    let tx = c.transaction()?;
    tx.execute(
        "INSERT INTO score_events(timestamp_ms, kind, executor, day, repo, branch, group_name, agent)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![timestamp_ms, kind_s, executor, day, ctx.repo, ctx.branch, ctx.group_name, agent],
    )?;
    let unlocks = crate::achievements::evaluate(&tx, timestamp_ms, Some(executor))?;
    tx.commit()?;
    Ok(unlocks)
}
```

- [ ] **Step 4: Fix all callers**

Run: `cargo build --workspace 2>&1 | grep -E "^error" | head`

For each compile error of the form "expected `()`, found `Vec<Unlock>`", change the call site from:
```rust
store.append(...)?;
```
to:
```rust
let _ = store.append(...)?;
```
unless the caller is `crates/app/src/lib.rs`, which Task 7 handles.

Known caller files to inspect:
- `crates/agent/tests/record_llm_call.rs`
- `crates/score/tests/session.rs`
- `crates/score/tests/external_claude_code.rs`
- `crates/score/tests/breakdown.rs`
- `crates/score/tests/external_codex.rs`
- `crates/score/tests/spec_watcher.rs`
- `crates/score/tests/store.rs`
- `crates/score/tests/recorder.rs`
- `crates/score/tests/specs.rs`
- `crates/score/src/recorder.rs` if it calls `append*` internally
- `crates/score/src/external/*` if any

- [ ] **Step 5: Verify workspace builds and all score tests pass**

Run: `cargo build --workspace && cargo test -p karl-score`
Expected: clean build, all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -u
git commit -m "feat(score): append* return unlocked achievements transactionally"
```

---

## Task 6: `list_achievements` and `recent_unlocks` API

**Files:**
- Modify: `crates/score/src/store.rs`

- [ ] **Step 1: Write failing tests**

Append to `crates/score/tests/achievements.rs`:

```rust
use karl_score::{AchievementView, UnlockedAchievement};

#[test]
fn list_achievements_returns_full_catalog_with_unlock_state() {
    let (_d, store) = open_store();
    let _ = store.append(1_700_000_000_000, EventKind::Prompt, "claude").unwrap();

    let views: Vec<AchievementView> = store.list_achievements().unwrap();
    assert_eq!(views.len(), CATALOG.len());

    let first = views.iter().find(|v| v.id == "first_command").unwrap();
    assert!(first.unlocked_at.is_some());
    assert_eq!(first.progress, 1);

    let century = views.iter().find(|v| v.id == "century_club").unwrap();
    assert!(century.unlocked_at.is_none());
}

#[test]
fn recent_unlocks_returns_most_recent_first() {
    let (_d, store) = open_store();
    let _ = store.append(1_700_000_000_000, EventKind::Prompt, "claude").unwrap();

    let rows: Vec<UnlockedAchievement> = store.recent_unlocks(10).unwrap();
    assert!(!rows.is_empty());
    assert_eq!(rows[0].id, "first_command");
}
```

Ensure `crates/score/src/lib.rs` re-exports the view types:

```rust
pub use types::{AchievementView, UnlockedAchievement /* , existing re-exports */};
```

- [ ] **Step 2: Run, confirm fail**

Run: `cargo test -p karl-score --test achievements`
Expected: compile error (methods missing).

- [ ] **Step 3: Implement methods on `ScoreStore`**

Append to `impl ScoreStore` in `crates/score/src/store.rs`:

```rust
pub fn list_achievements(&self) -> Result<Vec<crate::AchievementView>> {
    let c = self.conn.lock().unwrap();
    let mut out = Vec::with_capacity(crate::achievements::CATALOG.len());
    for rule in crate::achievements::CATALOG {
        let progress = (rule.eval)(&c)?;
        let unlocked_at: Option<i64> = c.query_row(
            "SELECT unlocked_at FROM user_achievements WHERE achievement_id = ?1",
            params![rule.id],
            |r| r.get(0),
        ).ok();
        out.push(crate::AchievementView {
            id: rule.id.to_string(),
            title: rule.title.to_string(),
            description: rule.description.to_string(),
            category: rule.category.to_string(),
            threshold: rule.threshold,
            unlocked_at,
            progress: progress.current,
        });
    }
    Ok(out)
}

pub fn recent_unlocks(&self, limit: u32) -> Result<Vec<crate::UnlockedAchievement>> {
    let c = self.conn.lock().unwrap();
    let mut stmt = c.prepare(
        "SELECT ua.achievement_id, a.title, ua.unlocked_at
         FROM user_achievements ua
         JOIN achievements a ON a.id = ua.achievement_id
         ORDER BY ua.unlocked_at DESC
         LIMIT ?1",
    )?;
    let rows = stmt.query_map(params![limit as i64], |r| {
        Ok(crate::UnlockedAchievement {
            id: r.get(0)?,
            title: r.get(1)?,
            unlocked_at: r.get(2)?,
        })
    })?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `cargo test -p karl-score --test achievements`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/src/lib.rs
git commit -m "feat(score): expose list_achievements and recent_unlocks"
```

---

## Task 7: Agent context summary

**Files:**
- Modify: `crates/agent/src/context.rs` (find existing file via `ls crates/agent/src/` — there is a `context` module already used; if path differs, place the function in the most-similar existing module rather than creating a new file).

- [ ] **Step 1: Write failing test**

Create `crates/agent/tests/achievements_summary.rs`:

```rust
use karl_score::{EventKind, ScoreStore};
use tempfile::TempDir;

#[test]
fn summary_reports_unlock_count_and_latest() {
    let dir = TempDir::new().unwrap();
    let store = ScoreStore::open(dir.path()).unwrap();
    let _ = store.append(1_700_000_000_000, EventKind::Prompt, "claude").unwrap();

    let s = karl_agent::context::achievements_summary(&store);
    assert!(s.contains("1/"), "got: {}", s);
    assert!(s.to_lowercase().contains("hello, world") || s.contains("first"), "got: {}", s);
}
```

Adjust the `karl_agent` crate name if different — check `crates/agent/Cargo.toml` `[package].name`.

- [ ] **Step 2: Run, confirm fail**

Run: `cargo test -p <agent-crate-name> --test achievements_summary`
Expected: compile error (function missing).

- [ ] **Step 3: Implement `achievements_summary`**

Add to `crates/agent/src/context.rs` (or wherever the context module lives; create `pub mod context;` in agent `lib.rs` if needed):

```rust
use karl_score::ScoreStore;

pub fn achievements_summary(store: &ScoreStore) -> String {
    let views = match store.list_achievements() {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let total = views.len();
    let unlocked: Vec<_> = views.iter().filter(|v| v.unlocked_at.is_some()).collect();
    let mut latest = unlocked.clone();
    latest.sort_by_key(|v| std::cmp::Reverse(v.unlocked_at.unwrap_or(0)));
    let latest_str = latest.first()
        .map(|v| format!(" Latest: {} ({}).", v.title, v.description))
        .unwrap_or_default();
    format!("Achievements: {}/{} unlocked.{}", unlocked.len(), total, latest_str)
}
```

If the agent crate does not yet depend on `karl-score`, add to its `Cargo.toml`:

```toml
karl-score = { path = "../score" }
```

- [ ] **Step 4: Run, confirm pass**

Run: `cargo test -p <agent-crate-name> --test achievements_summary`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -u
git commit -m "feat(agent): expose achievements_summary for cached system prompt"
```

---

## Task 8: Broadcast `AchievementUnlocked` from app

**Files:**
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Inspect existing event enum**

Run: `grep -n "enum.*Event\|AchievementUnlocked\|broadcast\|emit" crates/app/src/lib.rs | head -30`

Identify the existing app-level event enum (or Tauri `emit` site) used for agent/UI updates. Treat its module path as `<EventEnum>` below.

- [ ] **Step 2: Add the variant**

Add to the existing enum:

```rust
AchievementUnlocked {
    id: String,
    title: String,
    unlocked_at: i64,
},
```

If the enum derives `Serialize`/`Clone`/etc., the new variant inherits them — no extra work needed.

- [ ] **Step 3: Fan unlocks out from `append*` call sites in `crates/app/src/lib.rs`**

Wherever the app calls `store.append(...)` or `store.append_with_context(...)`, replace:

```rust
store.append(ts, kind, exec)?;
```

with:

```rust
let unlocks = store.append(ts, kind, exec)?;
for u in unlocks {
    let _ = event_tx.send(<EventEnum>::AchievementUnlocked {
        id: u.id.to_string(),
        title: u.title.to_string(),
        unlocked_at: u.unlocked_at,
    });
}
```

Use the actual broadcaster handle from the surrounding code (likely a `tokio::sync::broadcast::Sender` or Tauri `AppHandle::emit`). Mirror whatever pattern is already used for other events in that function.

- [ ] **Step 4: Build the workspace**

Run: `cargo build --workspace`
Expected: clean build.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): broadcast AchievementUnlocked events from append path"
```

---

## Task 9: End-to-end sanity test

**Files:**
- Modify: `crates/score/tests/achievements.rs`

- [ ] **Step 1: Add a flow test**

```rust
#[test]
fn full_flow_unlocks_century_club_at_event_100() {
    let (_d, store) = open_store();
    let mut last_unlocks: Vec<Unlock> = Vec::new();
    for i in 0..100 {
        last_unlocks = store
            .append(1_700_000_000_000 + i, EventKind::Prompt, "claude")
            .unwrap();
    }
    // The 100th append should unlock century_club.
    assert!(last_unlocks.iter().any(|u| u.id == "century_club"));

    let views = store.list_achievements().unwrap();
    let century = views.iter().find(|v| v.id == "century_club").unwrap();
    assert!(century.unlocked_at.is_some());
    assert_eq!(century.progress, 100);
}
```

- [ ] **Step 2: Run all score tests**

Run: `cargo test -p karl-score`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/score/tests/achievements.rs
git commit -m "test(score): end-to-end achievements flow"
```

---

## Task 10: Final verification

- [ ] **Step 1: Full workspace test**

Run: `cargo test --workspace`
Expected: green.

- [ ] **Step 2: Clippy clean on touched crates**

Run: `cargo clippy -p karl-score -p <agent-crate-name> -p karl-app -- -D warnings`
(Substitute actual crate names from `Cargo.toml`s. If clippy surfaces pre-existing warnings unrelated to this work, leave them and note in the PR.)

- [ ] **Step 3: Confirm no regressions in existing append callers**

Run: `cargo test -p karl-score --tests`
Expected: all PASS.

- [ ] **Step 4: Push branch**

```bash
git push -u origin feat/achievements-backend
```

---

## Self-Review Notes

- **Spec coverage:** tables (T2), catalog upsert (T4), rule engine + eval (T3), transactional `append*` returning unlocks (T5), `list_achievements` / `recent_unlocks` (T6), agent summary (T7), event broadcast (T8), tests throughout. Backfill method is explicitly deferred — spec marked it optional.
- **Placeholder scan:** all code blocks contain real Rust. Two unavoidable lookups remain: the exact app-level event enum name (T8 Step 1) and the agent crate name (T7), because they were not visible from grep output alone. Each task includes the exact `grep` to resolve the lookup before editing.
- **Type consistency:** `Unlock` carries `id: &'static str` and `title: &'static str` (catalog references); when persisted into broadcast events they are `.to_string()`-converted to owned `String` (T8). `AchievementView`/`UnlockedAchievement` use owned `String`. `Vec<Unlock>` is the return type of both `append` and `append_with_context` consistently.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-24-achievements-backend.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
