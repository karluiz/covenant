# Familiars Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Phase 1 MVP of Familiars — a per-operator companion AI with persistent memory, named identity, configurable style, tiered cost model, roster UI (⌘⇧M), and approved-directive flow.

**Architecture:** New Rust crate `crates/familiar` owns the agent loop, three-layer memory (event log + rolling Haiku summary + lazy Sonnet digests), and SQLite persistence per Familiar. The existing `crates/app` mounts Tauri commands and bridges the operator's `SessionEvent` bus into each Familiar's observer. New TS UI under `ui/src/familiars` implements the three-panel roster, status bar dot, and settings. Premium gating via existing settings infrastructure.

**Tech Stack:** Rust + Tokio + rusqlite (bundled) + the existing `crates/agent` Anthropic HTTP client (Haiku 4.5 + Sonnet 4.6, prompt caching). TypeScript + xterm.js host frame. SQLite per Familiar at `~/.karlTerminal/familiars/<familiar_id>.sqlite`.

**Spec:** `docs/superpowers/specs/2026-05-04-familiars-design.md`

---

## File Structure

**New Rust crate `crates/familiar/`:**
- `Cargo.toml` — workspace member
- `src/lib.rs` — public API surface, `pub use` re-exports
- `src/error.rs` — `FamiliarError` (thiserror)
- `src/identity.rs` — `Familiar`, `FamiliarId`, `Style`, `FamiliarConfig`
- `src/memory.rs` — SQLite-backed `Memory` with three layers (events, rolling, missions)
- `src/observer.rs` — `Observer`: subscribes to broadcast bus, persists events, triggers eager summarization
- `src/summarizer.rs` — Haiku eager + Sonnet lazy summarization
- `src/agent.rs` — chat loop: builds prompt, calls Anthropic, parses tool calls
- `src/directive.rs` — `Directive`, propose/approve/reject/inject/audit
- `src/manager.rs` — `FamiliarManager`: registry of live Familiars, lifecycle (spawn/sleep/wake)
- `src/cost.rs` — per-Familiar cost tracking + frozen-mode gate
- `src/prompts.rs` — system prompt builder, style variants
- `migrations/001_init.sql` — schema bootstrap
- `tests/` — integration tests with mock event bus

**Modified Rust:**
- `Cargo.toml` (workspace root) — add member
- `crates/app/Cargo.toml` — depend on `familiar`
- `crates/app/src/lib.rs` — wire `FamiliarManager` into Tauri state, register commands, bridge `SessionEvent` bus
- `crates/app/src/familiar_commands.rs` *(new)* — Tauri commands: list/chat/approve/reject/snapshot/config/audit
- `crates/app/src/settings.rs` — add `familiars_enabled`, `is_premium`

**New TS:**
- `ui/src/familiars/api.ts` — typed wrappers around Tauri commands
- `ui/src/familiars/roster.ts` — full-screen roster (⌘⇧M)
- `ui/src/familiars/list.ts` — left panel (Familiars list)
- `ui/src/familiars/chat.ts` — center panel (conversation + directive cards)
- `ui/src/familiars/snapshot.ts` — right panel (operator state)
- `ui/src/familiars/directive_card.ts` — approve/reject/edit
- `ui/src/familiars/status_indicator.ts` — status bar dot per tab
- `ui/src/familiars/settings_panel.ts` — settings UI
- `ui/src/familiars/audit_log.ts` — audit log viewer

**Modified TS:**
- `ui/src/api.ts` — re-export familiar API
- `ui/src/main.ts` — wire ⌘⇧M shortcut, mount roster
- `ui/src/styles.css` — roster + cards + status dot styles
- `ui/src/status/bar.ts` — embed status indicator
- `ui/src/settings/...` — embed Familiars panel
- `ui/index.html` — roster mount point

---

## Conventions

- TDD: every behavior change starts with a failing test.
- One commit per task. Commit messages: `feat(familiar): …`, `test(familiar): …`, `chore(familiar): …`.
- Rust: `thiserror` in `crates/familiar`, no `unwrap()` outside tests, `tracing` with `familiar_id` and `session_id` structured fields.
- TS: `strict: true`, no `as any`, all Tauri calls go through `ui/src/familiars/api.ts`.
- All cargo commands run from repo root: `cargo test -p familiar`, `cargo build -p familiar`, etc.
- All UI commands run from `ui/`: `npm test`, `npm run typecheck`.

---

## Task 1: Crate scaffold

**Files:**
- Create: `crates/familiar/Cargo.toml`
- Create: `crates/familiar/src/lib.rs`
- Create: `crates/familiar/src/error.rs`
- Modify: `Cargo.toml` (workspace root)

- [ ] **Step 1: Add workspace member**

In `Cargo.toml` (root) modify the `members` array:

```toml
members = [
    "crates/app",
    "crates/pty",
    "crates/blocks",
    "crates/session",
    "crates/agent",
    "crates/familiar",
]
```

- [ ] **Step 2: Create crate manifest**

Write `crates/familiar/Cargo.toml`:

```toml
[package]
name = "familiar"
version.workspace = true
edition.workspace = true
license.workspace = true
publish = false

[dependencies]
agent = { path = "../agent" }
session = { path = "../session" }
tokio = { workspace = true }
serde = { workspace = true }
serde_json = { workspace = true }
thiserror = { workspace = true }
tracing = { workspace = true }
ulid = { workspace = true }
rusqlite = { workspace = true }
strip-ansi-escapes = { workspace = true }
regex = { workspace = true }
bytes = { workspace = true }
futures-util = { workspace = true }

[dev-dependencies]
tokio = { workspace = true, features = ["test-util", "macros", "rt-multi-thread"] }
tempfile = "3"
```

- [ ] **Step 3: Create error module**

Write `crates/familiar/src/error.rs`:

```rust
use thiserror::Error;

#[derive(Debug, Error)]
pub enum FamiliarError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("agent: {0}")]
    Agent(#[from] agent::AgentError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("familiar not found: {0}")]
    NotFound(String),
    #[error("frozen: daily cap exceeded")]
    Frozen,
    #[error("safety blocked directive: {reason}")]
    SafetyBlocked { reason: String },
    #[error("invalid directive: {0}")]
    InvalidDirective(String),
}

pub type Result<T> = std::result::Result<T, FamiliarError>;
```

- [ ] **Step 4: Create lib root**

Write `crates/familiar/src/lib.rs`:

```rust
//! Familiars — per-operator companion AI with persistent memory.
//!
//! See `docs/superpowers/specs/2026-05-04-familiars-design.md`.

pub mod agent;
pub mod cost;
pub mod directive;
pub mod error;
pub mod identity;
pub mod manager;
pub mod memory;
pub mod observer;
pub mod prompts;
pub mod summarizer;

pub use error::{FamiliarError, Result};
pub use identity::{Familiar, FamiliarConfig, FamiliarId, Style};
pub use manager::FamiliarManager;
```

Create empty modules so the crate compiles:

```bash
for f in agent cost directive identity manager memory observer prompts summarizer; do
  echo "// stub" > crates/familiar/src/$f.rs
done
```

- [ ] **Step 5: Verify compile**

Run: `cargo build -p familiar`
Expected: builds with warnings about unused imports only.

- [ ] **Step 6: Commit**

```bash
git add Cargo.toml crates/familiar/
git commit -m "feat(familiar): scaffold crate"
```

---

## Task 2: Identity types

**Files:**
- Modify: `crates/familiar/src/identity.rs`
- Test: `crates/familiar/src/identity.rs` (inline `#[cfg(test)]`)

- [ ] **Step 1: Write failing test**

Replace `crates/familiar/src/identity.rs` with:

```rust
use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct FamiliarId(pub Ulid);

impl FamiliarId {
    pub fn new() -> Self { Self(Ulid::new()) }
    pub fn as_str(&self) -> String { self.0.to_string() }
}

impl std::fmt::Display for FamiliarId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Style {
    Concise,
    Formal,
    Conversational,
    Sarcastic,
}

impl Default for Style {
    fn default() -> Self { Style::Conversational }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FamiliarConfig {
    pub name: String,
    pub style: Style,
    pub daily_cap_usd: f64,
}

impl Default for FamiliarConfig {
    fn default() -> Self {
        Self { name: "Familiar".into(), style: Style::default(), daily_cap_usd: 5.0 }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Familiar {
    pub id: FamiliarId,
    pub session_id: String,   // operator session ULID as string
    pub config: FamiliarConfig,
    pub created_at: i64,      // unix ms
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn familiar_id_round_trips_through_string() {
        let id = FamiliarId::new();
        let s = id.as_str();
        let parsed: Ulid = s.parse().unwrap();
        assert_eq!(parsed, id.0);
    }

    #[test]
    fn default_config_has_sensible_cap() {
        let cfg = FamiliarConfig::default();
        assert!(cfg.daily_cap_usd > 0.0);
        assert_eq!(cfg.style, Style::Conversational);
    }

    #[test]
    fn style_serializes_lowercase() {
        let s = serde_json::to_string(&Style::Sarcastic).unwrap();
        assert_eq!(s, "\"sarcastic\"");
    }
}
```

- [ ] **Step 2: Run tests, verify pass**

Run: `cargo test -p familiar identity`
Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/familiar/src/identity.rs
git commit -m "feat(familiar): identity types (FamiliarId, Style, Config)"
```

---

## Task 3: Memory schema bootstrap

**Files:**
- Create: `crates/familiar/migrations/001_init.sql`
- Modify: `crates/familiar/src/memory.rs`
- Test: `crates/familiar/src/memory.rs` (inline)

- [ ] **Step 1: Write the migration SQL**

Write `crates/familiar/migrations/001_init.sql`:

```sql
CREATE TABLE IF NOT EXISTS familiar_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS familiar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms INTEGER NOT NULL,
    kind TEXT NOT NULL,
    session_id TEXT NOT NULL,
    payload_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON familiar_events(ts_ms);

CREATE TABLE IF NOT EXISTS familiar_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms INTEGER NOT NULL,
    summary TEXT NOT NULL,
    last_event_id INTEGER NOT NULL,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS familiar_missions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mission_id TEXT NOT NULL,
    started_ms INTEGER NOT NULL,
    finished_ms INTEGER,
    digest TEXT NOT NULL DEFAULT '',
    objective TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS familiar_directives (
    id TEXT PRIMARY KEY,         -- ulid
    proposed_ms INTEGER NOT NULL,
    decided_ms INTEGER,
    state TEXT NOT NULL,         -- proposed|approved|rejected|executed|safety_blocked
    kind TEXT NOT NULL,
    payload TEXT NOT NULL,
    rationale TEXT NOT NULL,
    block_reason TEXT
);

CREATE TABLE IF NOT EXISTS familiar_chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts_ms INTEGER NOT NULL,
    role TEXT NOT NULL,          -- user|assistant
    content TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS familiar_costs (
    day TEXT PRIMARY KEY,        -- YYYY-MM-DD
    spend_usd REAL NOT NULL DEFAULT 0
);
```

- [ ] **Step 2: Write failing test**

Replace `crates/familiar/src/memory.rs`:

```rust
use crate::error::Result;
use rusqlite::Connection;
use std::path::Path;

const MIGRATION: &str = include_str!("../migrations/001_init.sql");

pub struct Memory {
    conn: Connection,
}

impl Memory {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(MIGRATION)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(MIGRATION)?;
        Ok(Self { conn })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_creates_all_tables() {
        let m = Memory::open_in_memory().unwrap();
        let names: Vec<String> = m.conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in ["familiar_chat","familiar_costs","familiar_directives",
                         "familiar_events","familiar_meta","familiar_missions",
                         "familiar_summaries"] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn open_on_disk_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.sqlite");
        {
            let _ = Memory::open(&path).unwrap();
        }
        // Reopen — must succeed without re-creating
        let _ = Memory::open(&path).unwrap();
    }
}
```

- [ ] **Step 3: Run tests, verify pass**

Run: `cargo test -p familiar memory::tests`
Expected: 2 passed.

- [ ] **Step 4: Commit**

```bash
git add crates/familiar/migrations/ crates/familiar/src/memory.rs
git commit -m "feat(familiar): SQLite schema and Memory bootstrap"
```

---

## Task 4: Event log layer

**Files:**
- Modify: `crates/familiar/src/memory.rs`

- [ ] **Step 1: Write failing test**

Append inside the existing `mod tests` in `crates/familiar/src/memory.rs`:

```rust
    #[test]
    fn append_and_read_events() {
        let m = Memory::open_in_memory().unwrap();
        m.append_event(1_700_000_000_000, "BlockFinished", "sess-A",
                       r#"{"exit":0}"#).unwrap();
        m.append_event(1_700_000_001_000, "CwdChanged", "sess-A",
                       r#"{"cwd":"/tmp"}"#).unwrap();
        let events = m.events_since(0).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "BlockFinished");
        assert_eq!(events[1].session_id, "sess-A");
    }

    #[test]
    fn events_since_filters_by_id() {
        let m = Memory::open_in_memory().unwrap();
        for i in 0..5 {
            m.append_event(1000 + i, "X", "S", "{}").unwrap();
        }
        let from_3 = m.events_since(3).unwrap();
        assert_eq!(from_3.len(), 2); // ids 4, 5
    }
```

- [ ] **Step 2: Run, verify failure**

Run: `cargo test -p familiar memory`
Expected: FAIL — `append_event` not defined.

- [ ] **Step 3: Implement**

Add to `crates/familiar/src/memory.rs` above the test module:

```rust
#[derive(Debug, Clone)]
pub struct EventRow {
    pub id: i64,
    pub ts_ms: i64,
    pub kind: String,
    pub session_id: String,
    pub payload_json: String,
}

impl Memory {
    pub fn append_event(&self, ts_ms: i64, kind: &str, session_id: &str,
                        payload_json: &str) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO familiar_events(ts_ms, kind, session_id, payload_json)
             VALUES (?1,?2,?3,?4)",
            (ts_ms, kind, session_id, payload_json),
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn events_since(&self, after_id: i64) -> Result<Vec<EventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ts_ms, kind, session_id, payload_json
             FROM familiar_events WHERE id > ?1 ORDER BY id ASC")?;
        let rows = stmt.query_map([after_id], |r| Ok(EventRow {
            id: r.get(0)?, ts_ms: r.get(1)?, kind: r.get(2)?,
            session_id: r.get(3)?, payload_json: r.get(4)?,
        }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn last_event_id(&self) -> Result<i64> {
        let id: i64 = self.conn
            .query_row("SELECT COALESCE(MAX(id),0) FROM familiar_events", [], |r| r.get(0))?;
        Ok(id)
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p familiar memory`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/familiar/src/memory.rs
git commit -m "feat(familiar): event log read/write"
```

---

## Task 5: Rolling summary layer

**Files:**
- Modify: `crates/familiar/src/memory.rs`

- [ ] **Step 1: Write failing test**

Append to test module:

```rust
    #[test]
    fn write_and_read_latest_summary() {
        let m = Memory::open_in_memory().unwrap();
        assert!(m.latest_summary().unwrap().is_none());
        m.write_summary(1_700_000_000_000, "running tests", 42, 100, 50).unwrap();
        m.write_summary(1_700_000_500_000, "tests green", 99, 110, 55).unwrap();
        let s = m.latest_summary().unwrap().unwrap();
        assert_eq!(s.summary, "tests green");
        assert_eq!(s.last_event_id, 99);
    }
```

- [ ] **Step 2: Run, verify failure**

Run: `cargo test -p familiar write_and_read_latest_summary`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `crates/familiar/src/memory.rs` (above `#[cfg(test)]`):

```rust
#[derive(Debug, Clone)]
pub struct SummaryRow {
    pub id: i64,
    pub ts_ms: i64,
    pub summary: String,
    pub last_event_id: i64,
}

impl Memory {
    pub fn write_summary(&self, ts_ms: i64, summary: &str, last_event_id: i64,
                         tokens_in: i64, tokens_out: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO familiar_summaries(ts_ms, summary, last_event_id, tokens_in, tokens_out)
             VALUES (?1,?2,?3,?4,?5)",
            (ts_ms, summary, last_event_id, tokens_in, tokens_out),
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn latest_summary(&self) -> Result<Option<SummaryRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ts_ms, summary, last_event_id
             FROM familiar_summaries ORDER BY id DESC LIMIT 1")?;
        let mut rows = stmt.query_map([], |r| Ok(SummaryRow {
            id: r.get(0)?, ts_ms: r.get(1)?, summary: r.get(2)?, last_event_id: r.get(3)?,
        }))?;
        Ok(rows.next().transpose()?)
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p familiar memory`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/familiar/src/memory.rs
git commit -m "feat(familiar): rolling summary read/write"
```

---

## Task 6: Mission digest layer

**Files:**
- Modify: `crates/familiar/src/memory.rs`

- [ ] **Step 1: Write failing test**

Append to test module:

```rust
    #[test]
    fn mission_lifecycle() {
        let m = Memory::open_in_memory().unwrap();
        let id = m.start_mission("mission-1", 1000, "ship feature X").unwrap();
        assert!(id > 0);
        m.finish_mission("mission-1", 2000, "shipped: X merged in PR 42").unwrap();
        let row = m.mission("mission-1").unwrap().unwrap();
        assert_eq!(row.objective, "ship feature X");
        assert!(row.digest.starts_with("shipped"));
        assert_eq!(row.finished_ms, Some(2000));
    }
```

- [ ] **Step 2: Run, verify failure**

Run: `cargo test -p familiar mission_lifecycle`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `crates/familiar/src/memory.rs`:

```rust
#[derive(Debug, Clone)]
pub struct MissionRow {
    pub mission_id: String,
    pub started_ms: i64,
    pub finished_ms: Option<i64>,
    pub objective: String,
    pub digest: String,
}

impl Memory {
    pub fn start_mission(&self, mission_id: &str, started_ms: i64,
                         objective: &str) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO familiar_missions(mission_id, started_ms, objective)
             VALUES (?1,?2,?3)",
            (mission_id, started_ms, objective),
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn finish_mission(&self, mission_id: &str, finished_ms: i64,
                          digest: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE familiar_missions
             SET finished_ms=?1, digest=?2
             WHERE mission_id=?3",
            (finished_ms, digest, mission_id),
        )?;
        Ok(())
    }

    pub fn mission(&self, mission_id: &str) -> Result<Option<MissionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT mission_id, started_ms, finished_ms, objective, digest
             FROM familiar_missions WHERE mission_id=?1")?;
        let mut rows = stmt.query_map([mission_id], |r| Ok(MissionRow {
            mission_id: r.get(0)?, started_ms: r.get(1)?,
            finished_ms: r.get(2)?, objective: r.get(3)?, digest: r.get(4)?,
        }))?;
        Ok(rows.next().transpose()?)
    }

    pub fn recent_missions(&self, limit: i64) -> Result<Vec<MissionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT mission_id, started_ms, finished_ms, objective, digest
             FROM familiar_missions ORDER BY started_ms DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| Ok(MissionRow {
            mission_id: r.get(0)?, started_ms: r.get(1)?,
            finished_ms: r.get(2)?, objective: r.get(3)?, digest: r.get(4)?,
        }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p familiar memory`
Expected: 6 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/familiar/src/memory.rs
git commit -m "feat(familiar): mission digest store"
```

---

## Task 7: Chat history + directive log layers

**Files:**
- Modify: `crates/familiar/src/memory.rs`

- [ ] **Step 1: Write failing test**

Append:

```rust
    #[test]
    fn chat_round_trip() {
        let m = Memory::open_in_memory().unwrap();
        m.append_chat(100, "user", "hi").unwrap();
        m.append_chat(101, "assistant", "hello").unwrap();
        let hist = m.chat_history(10).unwrap();
        assert_eq!(hist.len(), 2);
        assert_eq!(hist[0].role, "user");
        assert_eq!(hist[1].content, "hello");
    }

    #[test]
    fn directive_log_round_trip() {
        let m = Memory::open_in_memory().unwrap();
        m.log_directive("01H...", 100, "proposed", "Stop", "stop X", "rationale", None).unwrap();
        m.update_directive_state("01H...", 200, "approved", None).unwrap();
        let row = m.directive("01H...").unwrap().unwrap();
        assert_eq!(row.state, "approved");
        assert_eq!(row.decided_ms, Some(200));
    }
```

- [ ] **Step 2: Run, verify failure**

Run: `cargo test -p familiar memory`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `crates/familiar/src/memory.rs`:

```rust
#[derive(Debug, Clone)]
pub struct ChatRow {
    pub ts_ms: i64,
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct DirectiveRow {
    pub id: String,
    pub proposed_ms: i64,
    pub decided_ms: Option<i64>,
    pub state: String,
    pub kind: String,
    pub payload: String,
    pub rationale: String,
    pub block_reason: Option<String>,
}

impl Memory {
    pub fn append_chat(&self, ts_ms: i64, role: &str, content: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO familiar_chat(ts_ms, role, content) VALUES (?1,?2,?3)",
            (ts_ms, role, content),
        )?;
        Ok(())
    }

    pub fn chat_history(&self, limit: i64) -> Result<Vec<ChatRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT ts_ms, role, content FROM familiar_chat
             ORDER BY id DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| Ok(ChatRow {
            ts_ms: r.get(0)?, role: r.get(1)?, content: r.get(2)?,
        }))?;
        let mut v: Vec<_> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        v.reverse();
        Ok(v)
    }

    pub fn log_directive(&self, id: &str, proposed_ms: i64, state: &str,
                         kind: &str, payload: &str, rationale: &str,
                         block_reason: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO familiar_directives(id, proposed_ms, state, kind, payload, rationale, block_reason)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            (id, proposed_ms, state, kind, payload, rationale, block_reason),
        )?;
        Ok(())
    }

    pub fn update_directive_state(&self, id: &str, decided_ms: i64,
                                   state: &str, block_reason: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE familiar_directives SET decided_ms=?1, state=?2, block_reason=?3
             WHERE id=?4",
            (decided_ms, state, block_reason, id),
        )?;
        Ok(())
    }

    pub fn directive(&self, id: &str) -> Result<Option<DirectiveRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, proposed_ms, decided_ms, state, kind, payload, rationale, block_reason
             FROM familiar_directives WHERE id=?1")?;
        let mut rows = stmt.query_map([id], |r| Ok(DirectiveRow {
            id: r.get(0)?, proposed_ms: r.get(1)?, decided_ms: r.get(2)?,
            state: r.get(3)?, kind: r.get(4)?, payload: r.get(5)?,
            rationale: r.get(6)?, block_reason: r.get(7)?,
        }))?;
        Ok(rows.next().transpose()?)
    }

    pub fn directives_since(&self, since_ms: i64) -> Result<Vec<DirectiveRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, proposed_ms, decided_ms, state, kind, payload, rationale, block_reason
             FROM familiar_directives WHERE proposed_ms >= ?1 ORDER BY proposed_ms DESC")?;
        let rows = stmt.query_map([since_ms], |r| Ok(DirectiveRow {
            id: r.get(0)?, proposed_ms: r.get(1)?, decided_ms: r.get(2)?,
            state: r.get(3)?, kind: r.get(4)?, payload: r.get(5)?,
            rationale: r.get(6)?, block_reason: r.get(7)?,
        }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p familiar memory`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/familiar/src/memory.rs
git commit -m "feat(familiar): chat history and directive log"
```

---

## Task 8: Cost tracking + frozen mode

**Files:**
- Modify: `crates/familiar/src/cost.rs`
- Modify: `crates/familiar/src/memory.rs` (add cost helpers)

- [ ] **Step 1: Memory cost helpers — write test**

Append to memory test module:

```rust
    #[test]
    fn cost_accumulates_per_day() {
        let m = Memory::open_in_memory().unwrap();
        m.add_spend("2026-05-04", 0.10).unwrap();
        m.add_spend("2026-05-04", 0.05).unwrap();
        m.add_spend("2026-05-05", 0.20).unwrap();
        assert!((m.spend_for_day("2026-05-04").unwrap() - 0.15).abs() < 1e-9);
        assert!((m.spend_for_day("2026-05-05").unwrap() - 0.20).abs() < 1e-9);
    }
```

- [ ] **Step 2: Run, verify failure**

Run: `cargo test -p familiar cost_accumulates_per_day`
Expected: FAIL.

- [ ] **Step 3: Implement memory cost helpers**

Add to `crates/familiar/src/memory.rs`:

```rust
impl Memory {
    pub fn add_spend(&self, day: &str, usd: f64) -> Result<()> {
        self.conn.execute(
            "INSERT INTO familiar_costs(day, spend_usd) VALUES (?1, ?2)
             ON CONFLICT(day) DO UPDATE SET spend_usd = spend_usd + ?2",
            (day, usd),
        )?;
        Ok(())
    }

    pub fn spend_for_day(&self, day: &str) -> Result<f64> {
        let v: f64 = self.conn.query_row(
            "SELECT COALESCE(spend_usd, 0) FROM familiar_costs WHERE day=?1",
            [day],
            |r| r.get(0),
        ).unwrap_or(0.0);
        Ok(v)
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p familiar memory`
Expected: 9 passed.

- [ ] **Step 5: Implement cost gate — write test**

Replace `crates/familiar/src/cost.rs`:

```rust
use crate::error::Result;
use crate::memory::Memory;

pub struct CostGate<'a> {
    memory: &'a Memory,
    cap_usd: f64,
}

impl<'a> CostGate<'a> {
    pub fn new(memory: &'a Memory, cap_usd: f64) -> Self {
        Self { memory, cap_usd }
    }

    pub fn current_day(now_ms: i64) -> String {
        let secs = (now_ms / 1000) as i64;
        let days = secs / 86_400;
        let (y, m, d) = days_to_ymd(days);
        format!("{:04}-{:02}-{:02}", y, m, d)
    }

    /// Returns true if frozen (cap exceeded).
    pub fn is_frozen(&self, now_ms: i64) -> Result<bool> {
        let day = Self::current_day(now_ms);
        let spend = self.memory.spend_for_day(&day)?;
        Ok(spend >= self.cap_usd)
    }

    pub fn record(&self, now_ms: i64, usd: f64) -> Result<()> {
        let day = Self::current_day(now_ms);
        self.memory.add_spend(&day, usd)
    }
}

fn days_to_ymd(mut days: i64) -> (i32, u32, u32) {
    // Civil-from-days (Howard Hinnant). 1970-01-01 = day 0.
    days += 719468;
    let era = if days >= 0 { days } else { days - 146096 } / 146097;
    let doe = (days - era * 146097) as u64;
    let yoe = (doe - doe/1460 + doe/36524 - doe/146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365*yoe + yoe/4 - yoe/100);
    let mp = (5*doy + 2) / 153;
    let d = (doy - (153*mp + 2)/5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    let y = (if m <= 2 { y + 1 } else { y }) as i32;
    (y, m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_format_is_iso() {
        // 2026-05-04 00:00:00 UTC = 1777996800000 ms
        assert_eq!(CostGate::current_day(1777996800000), "2026-05-04");
    }

    #[test]
    fn freezes_at_cap() {
        let m = Memory::open_in_memory().unwrap();
        let g = CostGate::new(&m, 1.0);
        assert!(!g.is_frozen(1777996800000).unwrap());
        g.record(1777996800000, 0.5).unwrap();
        assert!(!g.is_frozen(1777996800000).unwrap());
        g.record(1777996800000, 0.6).unwrap();
        assert!(g.is_frozen(1777996800000).unwrap());
    }
}
```

- [ ] **Step 6: Run, verify pass**

Run: `cargo test -p familiar cost`
Expected: 2 passed.

- [ ] **Step 7: Commit**

```bash
git add crates/familiar/src/cost.rs crates/familiar/src/memory.rs
git commit -m "feat(familiar): cost tracking and frozen-mode gate"
```

---

## Task 9: Prompt builder

**Files:**
- Modify: `crates/familiar/src/prompts.rs`

- [ ] **Step 1: Write failing test**

Replace `crates/familiar/src/prompts.rs`:

```rust
use crate::identity::{FamiliarConfig, Style};

pub fn system_prompt(cfg: &FamiliarConfig, rolling_summary: &str,
                     recent_missions: &str) -> String {
    let style_clause = match cfg.style {
        Style::Concise =>
            "Speak in short, direct sentences. No filler. Pack information densely.",
        Style::Formal =>
            "Speak with professional, measured prose. Avoid contractions.",
        Style::Conversational =>
            "Speak naturally, like a colleague chatting. Friendly but focused.",
        Style::Sarcastic =>
            "Speak with dry wit. Stay useful — sarcasm garnishes, never replaces, signal.",
    };

    format!(
"You are {name}, a Familiar — an AI companion bound to one operator in this user's terminal.
You observe everything that operator does and remember across sessions.

Your role:
- Discuss what the operator is doing with the coordinator (the user).
- Form opinions. You may disagree with the operator's choices.
- When the coordinator agrees on a course of action, propose a structured directive
  with the propose_directive tool — the coordinator approves it before it reaches the operator.

Style: {style_clause}

You have three layers of memory:
1. Rolling summary (recent operator activity, kept fresh).
2. Mission digests (past missions you can reference by date and objective).
3. Raw event log (only consulted when explicitly needed).

Current rolling summary:
---
{rolling_summary}
---

Recent missions (most recent first):
---
{recent_missions}
---

Rules:
- Never propose a directive that violates the safety blocklist (sudo, rm -rf, etc.).
  The system enforces this; if you try, the directive is auto-rejected and logged.
- When unsure what the operator is doing, say so — do not invent.
- When you cite past events, reference the mission or timestamp explicitly.
",
        name = cfg.name,
        style_clause = style_clause,
        rolling_summary = if rolling_summary.is_empty() { "(empty — operator has not run yet)" } else { rolling_summary },
        recent_missions = if recent_missions.is_empty() { "(none)" } else { recent_missions },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_name_and_style_hint() {
        let cfg = FamiliarConfig { name: "Marcus".into(),
                                    style: Style::Sarcastic, daily_cap_usd: 5.0 };
        let p = system_prompt(&cfg, "running tests", "");
        assert!(p.contains("Marcus"));
        assert!(p.contains("dry wit"));
        assert!(p.contains("running tests"));
    }

    #[test]
    fn empty_summary_has_placeholder() {
        let cfg = FamiliarConfig::default();
        let p = system_prompt(&cfg, "", "");
        assert!(p.contains("(empty"));
    }
}
```

- [ ] **Step 2: Run, verify pass**

Run: `cargo test -p familiar prompts`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/familiar/src/prompts.rs
git commit -m "feat(familiar): system prompt builder with style variants"
```

---

## Task 10: Summarizer — Haiku eager pipeline

**Files:**
- Modify: `crates/familiar/src/summarizer.rs`

This task wires the existing `agent::ask` HTTP client into a summarization function. The `agent` crate exposes a streaming Anthropic client (`agent::AskRequest`, `agent::ask_stream`). For tests we abstract the LLM behind a trait so we can mock it.

- [ ] **Step 1: Write failing test**

Replace `crates/familiar/src/summarizer.rs`:

```rust
use crate::error::Result;
use crate::memory::{EventRow, Memory};
use async_trait::async_trait;

#[async_trait]
pub trait Llm: Send + Sync {
    async fn complete(&self, system: &str, user: &str) -> Result<LlmResponse>;
}

#[derive(Debug, Clone)]
pub struct LlmResponse {
    pub text: String,
    pub tokens_in: i64,
    pub tokens_out: i64,
    pub cost_usd: f64,
}

pub struct Summarizer<'a, L: Llm> {
    pub memory: &'a Memory,
    pub llm: &'a L,
}

impl<'a, L: Llm> Summarizer<'a, L> {
    /// Folds new events into the rolling summary. Returns the new summary text
    /// and the cost incurred. Idempotent w.r.t. last_event_id.
    pub async fn run_eager(&self, now_ms: i64) -> Result<Option<String>> {
        let prev = self.memory.latest_summary()?;
        let after = prev.as_ref().map(|s| s.last_event_id).unwrap_or(0);
        let new_events = self.memory.events_since(after)?;
        if new_events.is_empty() { return Ok(None); }

        let prev_text = prev.as_ref().map(|s| s.summary.as_str()).unwrap_or("");
        let user = render_eager_input(prev_text, &new_events);
        let sys = "You maintain a rolling summary of what an operator is doing in a terminal. \
                   Update the summary to reflect the new events. Stay under 300 words. \
                   Preserve key decisions, blockers, and current focus.";
        let resp = self.llm.complete(sys, &user).await?;
        let last_id = new_events.last().map(|e| e.id).unwrap_or(after);
        self.memory.write_summary(now_ms, &resp.text, last_id, resp.tokens_in, resp.tokens_out)?;
        Ok(Some(resp.text))
    }
}

fn render_eager_input(prev: &str, events: &[EventRow]) -> String {
    let mut s = String::new();
    s.push_str("CURRENT SUMMARY:\n");
    s.push_str(if prev.is_empty() { "(none)\n" } else { prev });
    s.push_str("\n\nNEW EVENTS:\n");
    for e in events {
        s.push_str(&format!("[{}] {} {}: {}\n", e.ts_ms, e.session_id, e.kind, e.payload_json));
    }
    s.push_str("\nReturn the updated summary text only — no preamble.");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    struct MockLlm {
        responses: Mutex<Vec<LlmResponse>>,
        prompts_seen: Mutex<Vec<(String, String)>>,
    }
    impl MockLlm {
        fn new(resps: Vec<LlmResponse>) -> Self {
            Self { responses: Mutex::new(resps), prompts_seen: Mutex::new(vec![]) }
        }
    }
    #[async_trait]
    impl Llm for MockLlm {
        async fn complete(&self, sys: &str, user: &str) -> Result<LlmResponse> {
            self.prompts_seen.lock().unwrap().push((sys.into(), user.into()));
            Ok(self.responses.lock().unwrap().remove(0))
        }
    }

    #[tokio::test]
    async fn no_events_no_call() {
        let m = Memory::open_in_memory().unwrap();
        let llm = MockLlm::new(vec![]);
        let s = Summarizer { memory: &m, llm: &llm };
        assert!(s.run_eager(1000).await.unwrap().is_none());
        assert_eq!(llm.prompts_seen.lock().unwrap().len(), 0);
    }

    #[tokio::test]
    async fn first_run_seeds_summary() {
        let m = Memory::open_in_memory().unwrap();
        m.append_event(100, "BlockFinished", "S", r#"{"cmd":"ls","exit":0}"#).unwrap();
        let llm = MockLlm::new(vec![LlmResponse {
            text: "operator listed files".into(),
            tokens_in: 50, tokens_out: 10, cost_usd: 0.001,
        }]);
        let s = Summarizer { memory: &m, llm: &llm };
        let out = s.run_eager(200).await.unwrap();
        assert_eq!(out.as_deref(), Some("operator listed files"));
        let latest = m.latest_summary().unwrap().unwrap();
        assert_eq!(latest.summary, "operator listed files");
    }

    #[tokio::test]
    async fn second_run_only_sees_delta() {
        let m = Memory::open_in_memory().unwrap();
        m.append_event(100, "BlockFinished", "S", "{}").unwrap();
        let llm1 = MockLlm::new(vec![LlmResponse {
            text: "first".into(), tokens_in: 1, tokens_out: 1, cost_usd: 0.0,
        }]);
        Summarizer { memory: &m, llm: &llm1 }.run_eager(200).await.unwrap();

        m.append_event(300, "BlockFinished", "S", r#"{"new":true}"#).unwrap();
        let llm2 = MockLlm::new(vec![LlmResponse {
            text: "second".into(), tokens_in: 1, tokens_out: 1, cost_usd: 0.0,
        }]);
        Summarizer { memory: &m, llm: &llm2 }.run_eager(400).await.unwrap();

        let user_input = &llm2.prompts_seen.lock().unwrap()[0].1;
        assert!(user_input.contains(r#"{"new":true}"#));
        assert!(!user_input.contains(r#"BlockFinished S: {}"#)); // delta only
    }
}
```

- [ ] **Step 2: Add `async-trait` to deps**

In `crates/familiar/Cargo.toml`, add to `[dependencies]`:

```toml
async-trait = "0.1"
```

- [ ] **Step 3: Run, verify pass**

Run: `cargo test -p familiar summarizer`
Expected: 3 passed.

- [ ] **Step 4: Commit**

```bash
git add crates/familiar/Cargo.toml crates/familiar/src/summarizer.rs
git commit -m "feat(familiar): eager summarization with mockable LLM"
```

---

## Task 11: Summarizer — lazy mission digest

**Files:**
- Modify: `crates/familiar/src/summarizer.rs`

- [ ] **Step 1: Write failing test**

Append to `crates/familiar/src/summarizer.rs` test module:

```rust
    #[tokio::test]
    async fn mission_digest_writes_to_store() {
        let m = Memory::open_in_memory().unwrap();
        m.start_mission("M1", 1000, "ship feature").unwrap();
        m.append_event(1100, "BlockFinished", "S", r#"{"cmd":"git push"}"#).unwrap();
        m.append_event(1200, "BlockFinished", "S", r#"{"cmd":"npm test"}"#).unwrap();
        let llm = MockLlm::new(vec![LlmResponse {
            text: "Pushed feature; tests green.".into(),
            tokens_in: 100, tokens_out: 30, cost_usd: 0.05,
        }]);
        let s = Summarizer { memory: &m, llm: &llm };
        s.run_lazy_for_mission("M1", 1300).await.unwrap();
        let row = m.mission("M1").unwrap().unwrap();
        assert_eq!(row.digest, "Pushed feature; tests green.");
        assert_eq!(row.finished_ms, Some(1300));
    }
```

- [ ] **Step 2: Run, verify failure**

Run: `cargo test -p familiar mission_digest_writes_to_store`
Expected: FAIL — `run_lazy_for_mission` not defined.

- [ ] **Step 3: Implement**

Add to `Summarizer` impl in `crates/familiar/src/summarizer.rs`:

```rust
    pub async fn run_lazy_for_mission(&self, mission_id: &str, now_ms: i64)
        -> Result<String>
    {
        let row = self.memory.mission(mission_id)?
            .ok_or_else(|| crate::FamiliarError::NotFound(mission_id.into()))?;
        let events = self.memory.events_since(0)?
            .into_iter()
            .filter(|e| e.ts_ms >= row.started_ms
                     && row.finished_ms.map_or(true, |f| e.ts_ms <= f))
            .collect::<Vec<_>>();

        let prev = self.memory.latest_summary()?
            .map(|s| s.summary).unwrap_or_default();
        let user = format!(
"MISSION OBJECTIVE: {}
ROLLING SUMMARY AT END:
{}

EVENT TIMELINE:
{}

Produce a structured digest (≤2000 chars):
- Objective restated
- Key decisions (bulleted)
- Outcome (success / blocked / abandoned)
- Notable blockers
- One-line takeaway",
            row.objective,
            prev,
            events.iter()
                .map(|e| format!("[{}] {}: {}", e.ts_ms, e.kind, e.payload_json))
                .collect::<Vec<_>>().join("\n"),
        );
        let sys = "You produce concise mission digests. Output the digest only.";
        let resp = self.llm.complete(sys, &user).await?;
        self.memory.finish_mission(mission_id, now_ms, &resp.text)?;
        Ok(resp.text)
    }
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p familiar summarizer`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/familiar/src/summarizer.rs
git commit -m "feat(familiar): lazy mission digest"
```

---

## Task 12: Anthropic LLM adapter (non-mock)

**Files:**
- Modify: `crates/familiar/src/summarizer.rs` (add concrete `AnthropicLlm`)
- Modify: `crates/agent/src/lib.rs` (expose pricing helper if missing — only if needed)

- [ ] **Step 1: Write a real-LLM stub adapter**

Append to `crates/familiar/src/summarizer.rs` (outside the test module):

```rust
pub struct AnthropicLlm {
    pub api_key: String,
    pub model: String,
    pub price_in_per_mtok: f64,
    pub price_out_per_mtok: f64,
}

impl AnthropicLlm {
    pub fn haiku(api_key: String) -> Self {
        Self {
            api_key,
            model: "claude-haiku-4-5-20251001".into(),
            price_in_per_mtok: 0.80,
            price_out_per_mtok: 4.00,
        }
    }
    pub fn sonnet(api_key: String) -> Self {
        Self {
            api_key,
            model: "claude-sonnet-4-6".into(),
            price_in_per_mtok: 3.00,
            price_out_per_mtok: 15.00,
        }
    }
}

#[async_trait]
impl Llm for AnthropicLlm {
    async fn complete(&self, system: &str, user: &str) -> Result<LlmResponse> {
        let req = agent::AskRequest {
            api_key: self.api_key.clone(),
            model: self.model.clone(),
            system_cached: system.to_string(),
            user_message: user.to_string(),
            max_tokens: 1024,
        };
        let resp = agent::ask_blocking(req).await
            .map_err(crate::FamiliarError::Agent)?;
        let cost_usd = (resp.usage_input_tokens as f64 / 1_000_000.0) * self.price_in_per_mtok
                     + (resp.usage_output_tokens as f64 / 1_000_000.0) * self.price_out_per_mtok;
        Ok(LlmResponse {
            text: resp.text,
            tokens_in: resp.usage_input_tokens as i64,
            tokens_out: resp.usage_output_tokens as i64,
            cost_usd,
        })
    }
}
```

- [ ] **Step 2: Verify `agent::ask_blocking` exists**

Run: `grep -n "pub async fn ask\|pub fn ask_blocking" crates/agent/src/lib.rs`

If `ask_blocking` does not exist, add it. Open `crates/agent/src/lib.rs` and append:

```rust
/// Non-streaming convenience: collects the streamed response into one String
/// and returns usage counts. Used by Familiars where we don't need streaming.
pub async fn ask_blocking(req: AskRequest) -> std::result::Result<AskResponse, AgentError> {
    let mut text = String::new();
    let mut usage_in = 0u32;
    let mut usage_out = 0u32;
    let mut stream = ask_stream(req).await?;
    while let Some(chunk) = stream.next().await {
        match chunk? {
            AskEvent::Text(t) => text.push_str(&t),
            AskEvent::Usage { input_tokens, output_tokens } => {
                usage_in = input_tokens;
                usage_out = output_tokens;
            }
            _ => {}
        }
    }
    Ok(AskResponse { text, usage_input_tokens: usage_in, usage_output_tokens: usage_out })
}

#[derive(Debug, Clone)]
pub struct AskResponse {
    pub text: String,
    pub usage_input_tokens: u32,
    pub usage_output_tokens: u32,
}
```

If the existing `ask_stream` already returns text+usage in another shape, **adapt the adapter to the existing API** rather than changing the agent crate. Read the file first; add `ask_blocking` only if no equivalent exists.

- [ ] **Step 3: Verify compile**

Run: `cargo build -p familiar`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add crates/familiar/src/summarizer.rs crates/agent/src/lib.rs
git commit -m "feat(familiar): AnthropicLlm adapter for Haiku/Sonnet"
```

---

## Task 13: Observer wiring

**Files:**
- Modify: `crates/familiar/src/observer.rs`
- Test: same file inline

The Observer subscribes to the operator's broadcast channel of `SessionEvent` (already defined in `crates/session`). Each event is persisted, and after every N events or T seconds it triggers `Summarizer::run_eager`.

- [ ] **Step 1: Read the SessionEvent type**

Run: `grep -n "pub enum SessionEvent\|broadcast" crates/session/src/lib.rs | head -20`

Note its fields (used below). The serialization assumes `serde_json::to_string(&event)` works on it. If `SessionEvent` does not derive `Serialize`, derive it in `crates/session/src/lib.rs` (single-line change).

- [ ] **Step 2: Write Observer with test using a stub bus**

Replace `crates/familiar/src/observer.rs`:

```rust
use crate::error::Result;
use crate::memory::Memory;
use crate::summarizer::{Llm, Summarizer};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex;
use tokio::sync::broadcast;
use session::SessionEvent;

pub struct Observer<L: Llm + 'static> {
    pub memory: Arc<Mutex<Memory>>,
    pub llm: Arc<L>,
    pub session_filter: String,
    pub flush_every: usize,
    pub flush_after: Duration,
}

impl<L: Llm + 'static> Observer<L> {
    /// Drains the bus until the channel closes. Persists each event matching
    /// `session_filter`; after `flush_every` events or `flush_after` elapsed,
    /// runs the eager summarizer.
    pub async fn run(self, mut rx: broadcast::Receiver<SessionEvent>) -> Result<()> {
        let mut pending: usize = 0;
        let mut last_flush = tokio::time::Instant::now();
        loop {
            let event = match tokio::time::timeout(self.flush_after, rx.recv()).await {
                Ok(Ok(ev)) => Some(ev),
                Ok(Err(broadcast::error::RecvError::Closed)) => break,
                Ok(Err(broadcast::error::RecvError::Lagged(_))) => continue,
                Err(_) => None,  // timeout
            };
            if let Some(ev) = event {
                if event_session_id(&ev) != self.session_filter { continue; }
                let now = now_ms();
                let kind = event_kind(&ev);
                let payload = serde_json::to_string(&ev).unwrap_or("{}".into());
                {
                    let mem = self.memory.lock().await;
                    mem.append_event(now, &kind, &self.session_filter, &payload)?;
                }
                pending += 1;
            }
            let elapsed = last_flush.elapsed() >= self.flush_after;
            if pending >= self.flush_every || (pending > 0 && elapsed) {
                let mem = self.memory.lock().await;
                let s = Summarizer { memory: &mem, llm: self.llm.as_ref() };
                let _ = s.run_eager(now_ms()).await?;
                pending = 0;
                last_flush = tokio::time::Instant::now();
            }
        }
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default()
        .as_millis() as i64
}

fn event_kind(ev: &SessionEvent) -> String {
    match ev {
        SessionEvent::SessionOpened(_) => "SessionOpened",
        SessionEvent::SessionClosed(_) => "SessionClosed",
        SessionEvent::BlockStarted { .. } => "BlockStarted",
        SessionEvent::OutputChunk { .. } => "OutputChunk",
        SessionEvent::BlockFinished { .. } => "BlockFinished",
        SessionEvent::CwdChanged { .. } => "CwdChanged",
    }.into()
}

fn event_session_id(ev: &SessionEvent) -> String {
    match ev {
        SessionEvent::SessionOpened(s) | SessionEvent::SessionClosed(s) => s.to_string(),
        SessionEvent::BlockStarted { session, .. }
        | SessionEvent::OutputChunk { session, .. }
        | SessionEvent::BlockFinished { session, .. }
        | SessionEvent::CwdChanged { session, .. } => session.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::summarizer::LlmResponse;
    use async_trait::async_trait;
    use std::sync::Mutex as StdMutex;

    struct MockLlm {
        n: StdMutex<usize>,
    }
    #[async_trait]
    impl Llm for MockLlm {
        async fn complete(&self, _: &str, _: &str) -> Result<LlmResponse> {
            *self.n.lock().unwrap() += 1;
            Ok(LlmResponse { text: "ok".into(), tokens_in: 1, tokens_out: 1, cost_usd: 0.0 })
        }
    }

    // Real SessionEvent construction is environment-specific; integration is
    // exercised in crates/familiar/tests/observer.rs (see Task 14).
    #[test]
    fn placeholder_compiles() { let _ = (); }
}
```

If the variant names of `SessionEvent` differ (verified in step 1), adjust `event_kind` and `event_session_id` accordingly.

- [ ] **Step 3: Verify compile**

Run: `cargo build -p familiar`
Expected: builds. If not, fix variant names against actual `SessionEvent`.

- [ ] **Step 4: Commit**

```bash
git add crates/familiar/src/observer.rs
git commit -m "feat(familiar): observer drains bus and triggers eager summarization"
```

---

## Task 14: Observer integration test

**Files:**
- Create: `crates/familiar/tests/observer.rs`

- [ ] **Step 1: Write integration test**

Create `crates/familiar/tests/observer.rs`:

```rust
use familiar::memory::Memory;
use familiar::observer::Observer;
use familiar::summarizer::{Llm, LlmResponse};
use familiar::error::Result;
use async_trait::async_trait;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;
use tokio::sync::{broadcast, Mutex};

struct CountingLlm { n: StdMutex<usize> }
#[async_trait]
impl Llm for CountingLlm {
    async fn complete(&self, _: &str, _: &str) -> Result<LlmResponse> {
        *self.n.lock().unwrap() += 1;
        Ok(LlmResponse { text: "summary".into(), tokens_in: 1, tokens_out: 1, cost_usd: 0.0 })
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn observer_persists_and_summarizes() {
    let mem = Arc::new(Mutex::new(Memory::open_in_memory().unwrap()));
    let llm = Arc::new(CountingLlm { n: StdMutex::new(0) });
    let (tx, rx) = broadcast::channel(64);

    let obs = Observer {
        memory: mem.clone(),
        llm: llm.clone(),
        session_filter: "S1".into(),
        flush_every: 3,
        flush_after: Duration::from_millis(200),
    };

    let handle = tokio::spawn(async move { obs.run(rx).await });

    use ulid::Ulid;
    let s1 = Ulid::from_string("01H0000000000000000000000S").unwrap_or_else(|_| Ulid::new());
    // Emit 3 BlockFinished — adapt to actual SessionEvent shape.
    for i in 0..3 {
        let ev = session::SessionEvent::BlockFinished {
            session: s1,
            block: Ulid::new(),
            exit_code: i,
        };
        tx.send(ev).unwrap();
    }
    tokio::time::sleep(Duration::from_millis(400)).await;
    drop(tx);
    let _ = handle.await;

    let m = mem.lock().await;
    let evs = m.events_since(0).unwrap();
    assert!(evs.len() >= 3);
    assert!(*llm.n.lock().unwrap() >= 1, "summarizer should have run at least once");
}
```

If `SessionEvent::BlockFinished` field types differ, adapt. The point is: send 3 events on the bus, then assert events appear in the DB and the LLM was invoked.

- [ ] **Step 2: Run, verify pass**

Run: `cargo test -p familiar --test observer`
Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/familiar/tests/observer.rs
git commit -m "test(familiar): observer integration with broadcast bus"
```

---

## Task 15: Directive types + safety integration

**Files:**
- Modify: `crates/familiar/src/directive.rs`
- Modify: `crates/familiar/Cargo.toml` (add `app` safety dep — actually we keep it self-contained: re-implement minimal blocklist OR depend via thin trait)

We avoid a circular dep on `crates/app`. Define a `SafetyCheck` trait; the `app` layer provides the impl that delegates to `crates/app/src/safety.rs`.

- [ ] **Step 1: Write failing test**

Replace `crates/familiar/src/directive.rs`:

```rust
use crate::error::{FamiliarError, Result};
use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DirectiveKind {
    Stop,
    Focus,
    Avoid,
    Resume,
    Custom,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Directive {
    pub id: String,           // ulid
    pub kind: DirectiveKind,
    pub payload: String,
    pub rationale: String,
}

impl Directive {
    pub fn new(kind: DirectiveKind, payload: String, rationale: String) -> Self {
        Self { id: Ulid::new().to_string(), kind, payload, rationale }
    }

    /// The synthetic user message that will be injected into the operator's
    /// next cycle when this directive is approved.
    pub fn rendered_for_operator(&self) -> String {
        let tag = match self.kind {
            DirectiveKind::Stop => "STOP",
            DirectiveKind::Focus => "FOCUS",
            DirectiveKind::Avoid => "AVOID",
            DirectiveKind::Resume => "RESUME",
            DirectiveKind::Custom => "DIRECTIVE",
        };
        format!("[FAMILIAR_DIRECTIVE {}]\n{}\n\n(Rationale: {})",
                tag, self.payload, self.rationale)
    }
}

pub trait SafetyCheck: Send + Sync {
    /// Returns Err(reason) if the directive payload is unsafe.
    fn check(&self, d: &Directive) -> std::result::Result<(), String>;
}

/// Default minimal safety: blocks the high-risk patterns from the spec.
pub struct DefaultSafety;
impl SafetyCheck for DefaultSafety {
    fn check(&self, d: &Directive) -> std::result::Result<(), String> {
        let p = d.payload.to_lowercase();
        let blocked = [
            ("rm -rf", "rm -rf"),
            ("sudo ", "sudo"),
            ("doas ", "doas"),
            ("| sh", "pipe to sh"),
            ("| bash", "pipe to bash"),
            ("git push --force", "force push"),
            ("git push -f", "force push"),
            ("mkfs", "mkfs"),
            ("dd if=", "dd"),
        ];
        for (pat, label) in blocked {
            if p.contains(pat) {
                return Err(format!("blocked: {label}"));
            }
        }
        Ok(())
    }
}

pub fn ensure_safe(d: &Directive, safety: &dyn SafetyCheck) -> Result<()> {
    safety.check(d).map_err(|reason| FamiliarError::SafetyBlocked { reason })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendered_message_tags_kind() {
        let d = Directive::new(DirectiveKind::Stop, "stop touching auth".into(),
                               "you said it was risky".into());
        let r = d.rendered_for_operator();
        assert!(r.contains("[FAMILIAR_DIRECTIVE STOP]"));
        assert!(r.contains("stop touching auth"));
        assert!(r.contains("Rationale"));
    }

    #[test]
    fn safety_blocks_rm_rf() {
        let d = Directive::new(DirectiveKind::Custom, "rm -rf /".into(), "x".into());
        assert!(ensure_safe(&d, &DefaultSafety).is_err());
    }

    #[test]
    fn safety_blocks_force_push_to_main() {
        let d = Directive::new(DirectiveKind::Custom,
                                "git push --force origin main".into(), "x".into());
        assert!(ensure_safe(&d, &DefaultSafety).is_err());
    }

    #[test]
    fn safe_directive_passes() {
        let d = Directive::new(DirectiveKind::Focus, "focus on test 12".into(), "x".into());
        assert!(ensure_safe(&d, &DefaultSafety).is_ok());
    }
}
```

- [ ] **Step 2: Run, verify pass**

Run: `cargo test -p familiar directive`
Expected: 4 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/familiar/src/directive.rs
git commit -m "feat(familiar): directive types + minimal safety check"
```

---

## Task 16: Agent chat loop with propose_directive tool

**Files:**
- Modify: `crates/familiar/src/agent.rs`

The chat agent: on user input, builds a fresh prompt from current memory + style + history, calls Sonnet via `Llm::complete`, and parses the assistant text for an optional `<<DIRECTIVE>>...<</DIRECTIVE>>` JSON block (we use a structured tag rather than full Anthropic tool-use to keep the LLM trait simple; tool-use can be added later without API changes).

- [ ] **Step 1: Write failing test**

Replace `crates/familiar/src/agent.rs`:

```rust
use crate::directive::{Directive, DirectiveKind, ensure_safe, SafetyCheck};
use crate::error::Result;
use crate::identity::FamiliarConfig;
use crate::memory::Memory;
use crate::prompts::system_prompt;
use crate::summarizer::Llm;
use serde::Deserialize;

pub struct ChatAgent<'a, L: Llm> {
    pub memory: &'a Memory,
    pub llm: &'a L,
    pub safety: &'a dyn SafetyCheck,
    pub config: &'a FamiliarConfig,
}

#[derive(Debug, Clone)]
pub struct ChatTurn {
    pub assistant_text: String,
    pub proposed_directive: Option<Directive>,
    pub safety_block_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DirectivePayload {
    kind: String,
    payload: String,
    rationale: String,
}

impl<'a, L: Llm> ChatAgent<'a, L> {
    pub async fn turn(&self, now_ms: i64, user_text: &str) -> Result<ChatTurn> {
        self.memory.append_chat(now_ms, "user", user_text)?;
        let summary = self.memory.latest_summary()?
            .map(|s| s.summary).unwrap_or_default();
        let missions = self.memory.recent_missions(5)?;
        let missions_text = missions.iter()
            .map(|m| format!("- mission {} ({}): {}", m.mission_id, m.objective, m.digest))
            .collect::<Vec<_>>().join("\n");
        let history = self.memory.chat_history(20)?;
        let history_text = history.iter()
            .map(|c| format!("{}: {}", c.role, c.content))
            .collect::<Vec<_>>().join("\n");

        let sys = system_prompt(self.config, &summary, &missions_text);
        let user = format!(
"CHAT HISTORY:
{history_text}

If you want to propose a directive to the operator, include exactly one block:
<<DIRECTIVE>>
{{\"kind\":\"stop|focus|avoid|resume|custom\",\"payload\":\"...\",\"rationale\":\"...\"}}
<</DIRECTIVE>>

Otherwise just reply normally.");

        let resp = self.llm.complete(&sys, &user).await?;
        let (visible, parsed) = extract_directive(&resp.text);
        let mut proposed: Option<Directive> = None;
        let mut blocked: Option<String> = None;
        if let Some(p) = parsed {
            let kind = match p.kind.as_str() {
                "stop" => DirectiveKind::Stop,
                "focus" => DirectiveKind::Focus,
                "avoid" => DirectiveKind::Avoid,
                "resume" => DirectiveKind::Resume,
                _ => DirectiveKind::Custom,
            };
            let d = Directive::new(kind, p.payload, p.rationale);
            match ensure_safe(&d, self.safety) {
                Ok(()) => {
                    self.memory.log_directive(&d.id, now_ms, "proposed",
                        &format!("{:?}", d.kind), &d.payload, &d.rationale, None)?;
                    proposed = Some(d);
                }
                Err(crate::FamiliarError::SafetyBlocked { reason }) => {
                    self.memory.log_directive(&d.id, now_ms, "safety_blocked",
                        &format!("{:?}", d.kind), &d.payload, &d.rationale, Some(&reason))?;
                    blocked = Some(reason);
                }
                Err(e) => return Err(e),
            }
        }
        self.memory.append_chat(now_ms + 1, "assistant", &visible)?;
        Ok(ChatTurn {
            assistant_text: visible,
            proposed_directive: proposed,
            safety_block_reason: blocked,
        })
    }
}

fn extract_directive(text: &str) -> (String, Option<DirectivePayload>) {
    if let (Some(start), Some(end)) = (text.find("<<DIRECTIVE>>"), text.find("<</DIRECTIVE>>")) {
        if end > start {
            let json_part = &text[start + "<<DIRECTIVE>>".len() .. end];
            let visible = format!("{}{}", &text[..start], &text[end + "<</DIRECTIVE>>".len()..])
                .trim().to_string();
            if let Ok(p) = serde_json::from_str::<DirectivePayload>(json_part.trim()) {
                return (visible, Some(p));
            }
        }
    }
    (text.to_string(), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::directive::DefaultSafety;
    use crate::summarizer::LlmResponse;
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct CannedLlm(Mutex<Vec<String>>);
    #[async_trait]
    impl Llm for CannedLlm {
        async fn complete(&self, _: &str, _: &str) -> Result<LlmResponse> {
            let text = self.0.lock().unwrap().remove(0);
            Ok(LlmResponse { text, tokens_in: 1, tokens_out: 1, cost_usd: 0.0 })
        }
    }

    #[tokio::test]
    async fn plain_reply_records_history() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec!["all good".into()]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent { memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg };
        let turn = agent.turn(1000, "status?").await.unwrap();
        assert_eq!(turn.assistant_text, "all good");
        assert!(turn.proposed_directive.is_none());
        assert_eq!(m.chat_history(10).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn directive_extracted_and_logged() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec![
            "Sure, here's my proposal.\n<<DIRECTIVE>>{\"kind\":\"stop\",\"payload\":\"halt deploy\",\"rationale\":\"prod risk\"}<</DIRECTIVE>>".into()
        ]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent { memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg };
        let turn = agent.turn(1000, "stop?").await.unwrap();
        assert!(turn.proposed_directive.is_some());
        assert!(turn.assistant_text.contains("Sure"));
        assert!(!turn.assistant_text.contains("DIRECTIVE"));
    }

    #[tokio::test]
    async fn unsafe_directive_recorded_as_blocked() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec![
            "<<DIRECTIVE>>{\"kind\":\"custom\",\"payload\":\"rm -rf /\",\"rationale\":\"x\"}<</DIRECTIVE>>".into()
        ]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent { memory: &m, llm: &llm, safety: &DefaultSafety, config: &cfg };
        let turn = agent.turn(1000, "x").await.unwrap();
        assert!(turn.proposed_directive.is_none());
        assert!(turn.safety_block_reason.is_some());
    }
}
```

- [ ] **Step 2: Run, verify pass**

Run: `cargo test -p familiar agent`
Expected: 3 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/familiar/src/agent.rs
git commit -m "feat(familiar): chat agent with directive extraction + safety"
```

---

## Task 17: Manager — registry + lifecycle

**Files:**
- Modify: `crates/familiar/src/manager.rs`

- [ ] **Step 1: Write failing test**

Replace `crates/familiar/src/manager.rs`:

```rust
use crate::error::{FamiliarError, Result};
use crate::identity::{Familiar, FamiliarConfig, FamiliarId};
use crate::memory::Memory;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::Mutex;

pub struct FamiliarHandle {
    pub familiar: Familiar,
    pub memory: Arc<Mutex<Memory>>,
}

pub struct FamiliarManager {
    root: PathBuf,
    map: Arc<Mutex<HashMap<FamiliarId, FamiliarHandle>>>,
    by_session: Arc<Mutex<HashMap<String, FamiliarId>>>,
}

impl FamiliarManager {
    pub fn new(root: PathBuf) -> Self {
        Self { root, map: Default::default(), by_session: Default::default() }
    }

    pub async fn spawn(&self, session_id: String, config: FamiliarConfig)
        -> Result<FamiliarId>
    {
        let id = FamiliarId::new();
        let path = self.root.join(format!("{}.sqlite", id));
        let mem = Arc::new(Mutex::new(Memory::open(&path)?));
        let f = Familiar {
            id, session_id: session_id.clone(), config,
            created_at: now_ms(),
        };
        self.map.lock().await.insert(id, FamiliarHandle {
            familiar: f, memory: mem,
        });
        self.by_session.lock().await.insert(session_id, id);
        Ok(id)
    }

    pub async fn list(&self) -> Vec<Familiar> {
        self.map.lock().await.values().map(|h| h.familiar.clone()).collect()
    }

    pub async fn for_session(&self, session_id: &str) -> Option<FamiliarId> {
        self.by_session.lock().await.get(session_id).copied()
    }

    pub async fn memory_of(&self, id: FamiliarId) -> Result<Arc<Mutex<Memory>>> {
        self.map.lock().await.get(&id)
            .map(|h| h.memory.clone())
            .ok_or_else(|| FamiliarError::NotFound(id.to_string()))
    }

    pub async fn config_of(&self, id: FamiliarId) -> Result<FamiliarConfig> {
        self.map.lock().await.get(&id)
            .map(|h| h.familiar.config.clone())
            .ok_or_else(|| FamiliarError::NotFound(id.to_string()))
    }

    pub async fn update_config(&self, id: FamiliarId, cfg: FamiliarConfig) -> Result<()> {
        let mut m = self.map.lock().await;
        let h = m.get_mut(&id).ok_or_else(|| FamiliarError::NotFound(id.to_string()))?;
        h.familiar.config = cfg;
        Ok(())
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default()
        .as_millis() as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn spawn_and_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = FamiliarManager::new(dir.path().to_path_buf());
        let id = mgr.spawn("S1".into(), FamiliarConfig {
            name: "Marcus".into(), ..Default::default()
        }).await.unwrap();
        assert_eq!(mgr.list().await.len(), 1);
        assert_eq!(mgr.for_session("S1").await, Some(id));
        assert_eq!(mgr.config_of(id).await.unwrap().name, "Marcus");
    }

    #[tokio::test]
    async fn update_config_persists_in_handle() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = FamiliarManager::new(dir.path().to_path_buf());
        let id = mgr.spawn("S2".into(), FamiliarConfig::default()).await.unwrap();
        mgr.update_config(id, FamiliarConfig {
            name: "Iris".into(), daily_cap_usd: 10.0, ..Default::default()
        }).await.unwrap();
        assert_eq!(mgr.config_of(id).await.unwrap().name, "Iris");
    }
}
```

- [ ] **Step 2: Run, verify pass**

Run: `cargo test -p familiar manager`
Expected: 2 passed.

- [ ] **Step 3: Commit**

```bash
git add crates/familiar/src/manager.rs
git commit -m "feat(familiar): manager registry + lifecycle"
```

---

## Task 18: Approve / reject / inject directive

**Files:**
- Modify: `crates/familiar/src/manager.rs`

- [ ] **Step 1: Write failing test**

Append to `crates/familiar/src/manager.rs` test module:

```rust
    #[tokio::test]
    async fn approve_records_state() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = FamiliarManager::new(dir.path().to_path_buf());
        let id = mgr.spawn("S".into(), FamiliarConfig::default()).await.unwrap();
        // Pre-log a directive (as agent would have done)
        {
            let mem = mgr.memory_of(id).await.unwrap();
            let mem = mem.lock().await;
            mem.log_directive("D1", 100, "proposed", "Stop", "halt", "rationale", None).unwrap();
        }
        let injected = mgr.approve_directive(id, "D1", 200).await.unwrap();
        assert!(injected.contains("[FAMILIAR_DIRECTIVE STOP]"));
        let mem = mgr.memory_of(id).await.unwrap();
        let mem = mem.lock().await;
        assert_eq!(mem.directive("D1").unwrap().unwrap().state, "approved");
    }

    #[tokio::test]
    async fn reject_records_state() {
        let dir = tempfile::tempdir().unwrap();
        let mgr = FamiliarManager::new(dir.path().to_path_buf());
        let id = mgr.spawn("S".into(), FamiliarConfig::default()).await.unwrap();
        {
            let mem = mgr.memory_of(id).await.unwrap();
            let mem = mem.lock().await;
            mem.log_directive("D2", 100, "proposed", "Focus", "x", "y", None).unwrap();
        }
        mgr.reject_directive(id, "D2", 200).await.unwrap();
        let mem = mgr.memory_of(id).await.unwrap();
        let mem = mem.lock().await;
        assert_eq!(mem.directive("D2").unwrap().unwrap().state, "rejected");
    }
```

- [ ] **Step 2: Run, verify failure**

Run: `cargo test -p familiar manager`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `FamiliarManager` impl in `crates/familiar/src/manager.rs`:

```rust
use crate::directive::{Directive, DirectiveKind};

impl FamiliarManager {
    pub async fn approve_directive(&self, id: FamiliarId, directive_id: &str,
                                    now_ms: i64) -> Result<String> {
        let mem = self.memory_of(id).await?;
        let mem = mem.lock().await;
        let row = mem.directive(directive_id)?
            .ok_or_else(|| FamiliarError::NotFound(directive_id.into()))?;
        let kind = match row.kind.as_str() {
            "Stop" => DirectiveKind::Stop,
            "Focus" => DirectiveKind::Focus,
            "Avoid" => DirectiveKind::Avoid,
            "Resume" => DirectiveKind::Resume,
            _ => DirectiveKind::Custom,
        };
        let d = Directive {
            id: row.id.clone(), kind,
            payload: row.payload.clone(), rationale: row.rationale.clone(),
        };
        let rendered = d.rendered_for_operator();
        mem.update_directive_state(directive_id, now_ms, "approved", None)?;
        Ok(rendered)
    }

    pub async fn reject_directive(&self, id: FamiliarId, directive_id: &str,
                                   now_ms: i64) -> Result<()> {
        let mem = self.memory_of(id).await?;
        let mem = mem.lock().await;
        mem.update_directive_state(directive_id, now_ms, "rejected", None)?;
        Ok(())
    }

    pub async fn mark_executed(&self, id: FamiliarId, directive_id: &str,
                                now_ms: i64) -> Result<()> {
        let mem = self.memory_of(id).await?;
        let mem = mem.lock().await;
        mem.update_directive_state(directive_id, now_ms, "executed", None)?;
        Ok(())
    }
}
```

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p familiar manager`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/familiar/src/manager.rs
git commit -m "feat(familiar): approve/reject/execute directive flow"
```

---

## Task 19: Settings additions (`familiars_enabled`, `is_premium`)

**Files:**
- Modify: `crates/app/src/settings.rs`
- Test: same file inline

- [ ] **Step 1: Read current settings shape**

Run: `head -80 crates/app/src/settings.rs`

Note the struct that holds settings (likely `Settings` or similar). The fields below append to that struct.

- [ ] **Step 2: Add fields**

In `crates/app/src/settings.rs`, locate the settings struct and add (defaulting to false):

```rust
    #[serde(default)]
    pub familiars_enabled: bool,
    #[serde(default)]
    pub is_premium: bool,
```

- [ ] **Step 3: Add accessors with test**

Append to `crates/app/src/settings.rs`:

```rust
impl Settings {
    pub fn familiars_active(&self) -> bool {
        self.familiars_enabled && self.is_premium
    }
}

#[cfg(test)]
mod familiars_tests {
    use super::*;

    #[test]
    fn familiars_inactive_when_not_premium() {
        let mut s = Settings::default();
        s.familiars_enabled = true;
        s.is_premium = false;
        assert!(!s.familiars_active());
    }

    #[test]
    fn familiars_active_when_both() {
        let mut s = Settings::default();
        s.familiars_enabled = true;
        s.is_premium = true;
        assert!(s.familiars_active());
    }
}
```

If the struct is not literally `Settings`, replace with the actual name. If `Default` is not derived, build the struct explicitly in the tests.

- [ ] **Step 4: Run, verify pass**

Run: `cargo test -p app familiars_tests`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/settings.rs
git commit -m "feat(app): familiars_enabled + is_premium settings"
```

---

## Task 20: App wiring — manager state + bus bridge

**Files:**
- Modify: `crates/app/Cargo.toml`
- Modify: `crates/app/src/lib.rs`
- Create: `crates/app/src/familiar_commands.rs`

- [ ] **Step 1: Add dep**

In `crates/app/Cargo.toml` `[dependencies]`:

```toml
familiar = { path = "../familiar" }
```

- [ ] **Step 2: Wire FamiliarManager into Tauri state**

Find the `tauri::Builder::default()` chain in `crates/app/src/lib.rs`. Add before `.manage(...)` other state:

```rust
    let familiars_root = dirs::home_dir()
        .map(|p| p.join(".karlTerminal").join("familiars"))
        .unwrap_or_else(|| std::path::PathBuf::from("./.familiars"));
    std::fs::create_dir_all(&familiars_root).ok();
    let familiar_manager = std::sync::Arc::new(
        familiar::FamiliarManager::new(familiars_root)
    );
```

Then add `.manage(familiar_manager.clone())` to the builder chain.

If `dirs` isn't already a dep, add to `crates/app/Cargo.toml`: `dirs = "5"`.

- [ ] **Step 3: Bridge SessionEvent bus → observer**

In `crates/app/src/lib.rs`, find where the global `broadcast::Sender<SessionEvent>` is created (or create one if not present — likely already there for the operator). Add a helper:

```rust
pub fn spawn_familiar_observer_for(
    manager: std::sync::Arc<familiar::FamiliarManager>,
    bus_tx: tokio::sync::broadcast::Sender<session::SessionEvent>,
    session_id: String,
    familiar_id: familiar::FamiliarId,
    api_key: String,
) {
    tokio::spawn(async move {
        let mem = match manager.memory_of(familiar_id).await {
            Ok(m) => m,
            Err(_) => return,
        };
        let llm = std::sync::Arc::new(
            familiar::summarizer::AnthropicLlm::haiku(api_key)
        );
        let obs = familiar::observer::Observer {
            memory: mem,
            llm,
            session_filter: session_id,
            flush_every: 5,
            flush_after: std::time::Duration::from_secs(60),
        };
        let _ = obs.run(bus_tx.subscribe()).await;
    });
}
```

This is invoked when a Familiar is spawned for a given session (next task).

- [ ] **Step 4: Verify compile**

Run: `cargo build -p app`
Expected: builds. Fix import paths if needed.

- [ ] **Step 5: Commit**

```bash
git add crates/app/Cargo.toml crates/app/src/lib.rs
git commit -m "feat(app): mount FamiliarManager + observer bridge"
```

---

## Task 21: Tauri commands — list / config / chat

**Files:**
- Create: `crates/app/src/familiar_commands.rs`
- Modify: `crates/app/src/lib.rs` (mod + invoke_handler registration)

- [ ] **Step 1: Implement commands**

Create `crates/app/src/familiar_commands.rs`:

```rust
use familiar::{FamiliarManager, FamiliarId, FamiliarConfig, Style};
use familiar::summarizer::AnthropicLlm;
use familiar::agent::ChatAgent;
use familiar::directive::DefaultSafety;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct FamiliarSummary {
    pub id: String,
    pub session_id: String,
    pub name: String,
    pub style: String,
    pub daily_cap_usd: f64,
}

#[derive(Debug, Deserialize)]
pub struct ChatInput {
    pub familiar_id: String,
    pub user_text: String,
}

#[derive(Debug, Serialize)]
pub struct ChatOutput {
    pub assistant_text: String,
    pub directive_id: Option<String>,
    pub directive_kind: Option<String>,
    pub directive_payload: Option<String>,
    pub directive_rationale: Option<String>,
    pub safety_block_reason: Option<String>,
}

fn parse_id(s: &str) -> Result<FamiliarId, String> {
    let u: ulid::Ulid = s.parse().map_err(|e: ulid::DecodeError| e.to_string())?;
    Ok(FamiliarId(u))
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH).unwrap_or_default()
        .as_millis() as i64
}

#[tauri::command]
pub async fn familiar_list(mgr: State<'_, Arc<FamiliarManager>>)
    -> Result<Vec<FamiliarSummary>, String>
{
    let list = mgr.list().await;
    Ok(list.into_iter().map(|f| FamiliarSummary {
        id: f.id.to_string(),
        session_id: f.session_id,
        name: f.config.name,
        style: format!("{:?}", f.config.style).to_lowercase(),
        daily_cap_usd: f.config.daily_cap_usd,
    }).collect())
}

#[tauri::command]
pub async fn familiar_spawn(
    session_id: String,
    name: String,
    style: String,
    daily_cap_usd: f64,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<String, String> {
    let style = match style.as_str() {
        "concise" => Style::Concise,
        "formal" => Style::Formal,
        "sarcastic" => Style::Sarcastic,
        _ => Style::Conversational,
    };
    let cfg = FamiliarConfig { name, style, daily_cap_usd };
    let id = mgr.spawn(session_id, cfg).await.map_err(|e| e.to_string())?;
    Ok(id.to_string())
}

#[tauri::command]
pub async fn familiar_update_config(
    familiar_id: String, name: String, style: String, daily_cap_usd: f64,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<(), String> {
    let id = parse_id(&familiar_id)?;
    let style = match style.as_str() {
        "concise" => Style::Concise,
        "formal" => Style::Formal,
        "sarcastic" => Style::Sarcastic,
        _ => Style::Conversational,
    };
    mgr.update_config(id, FamiliarConfig { name, style, daily_cap_usd })
        .await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn familiar_chat(
    input: ChatInput,
    mgr: State<'_, Arc<FamiliarManager>>,
    api_key: State<'_, crate::AnthropicKey>,  // see step 2
) -> Result<ChatOutput, String> {
    let id = parse_id(&input.familiar_id)?;
    let mem = mgr.memory_of(id).await.map_err(|e| e.to_string())?;
    let cfg = mgr.config_of(id).await.map_err(|e| e.to_string())?;
    let llm = AnthropicLlm::sonnet(api_key.0.clone());
    let mem_guard = mem.lock().await;
    let safety = DefaultSafety;
    let agent = ChatAgent {
        memory: &mem_guard, llm: &llm, safety: &safety, config: &cfg,
    };
    let turn = agent.turn(now_ms(), &input.user_text).await
        .map_err(|e| e.to_string())?;
    Ok(ChatOutput {
        assistant_text: turn.assistant_text,
        directive_id: turn.proposed_directive.as_ref().map(|d| d.id.clone()),
        directive_kind: turn.proposed_directive.as_ref()
            .map(|d| format!("{:?}", d.kind).to_lowercase()),
        directive_payload: turn.proposed_directive.as_ref().map(|d| d.payload.clone()),
        directive_rationale: turn.proposed_directive.as_ref().map(|d| d.rationale.clone()),
        safety_block_reason: turn.safety_block_reason,
    })
}
```

- [ ] **Step 2: Define `AnthropicKey` state**

In `crates/app/src/lib.rs` add (near other state):

```rust
pub struct AnthropicKey(pub String);
```

And in the builder, after reading the key from settings/env:

```rust
    let anthropic_key = std::env::var("ANTHROPIC_API_KEY").unwrap_or_default();
    // ... .manage(AnthropicKey(anthropic_key))
```

If a key is already managed elsewhere, reuse it instead of creating a new wrapper.

- [ ] **Step 3: Register commands**

In `crates/app/src/lib.rs` add:

```rust
mod familiar_commands;
```

And in `tauri::generate_handler![...]`, add:

```rust
    familiar_commands::familiar_list,
    familiar_commands::familiar_spawn,
    familiar_commands::familiar_update_config,
    familiar_commands::familiar_chat,
```

- [ ] **Step 4: Verify compile**

Run: `cargo build -p app`
Expected: builds.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/familiar_commands.rs crates/app/src/lib.rs
git commit -m "feat(app): tauri commands list/spawn/config/chat for Familiars"
```

---

## Task 22: Tauri commands — approve / reject / snapshot / audit

**Files:**
- Modify: `crates/app/src/familiar_commands.rs`
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Add commands**

Append to `crates/app/src/familiar_commands.rs`:

```rust
#[derive(Debug, Serialize)]
pub struct SnapshotOut {
    pub rolling_summary: String,
    pub last_event_ms: i64,
    pub recent_missions: Vec<MissionOut>,
    pub spend_today_usd: f64,
    pub frozen: bool,
}

#[derive(Debug, Serialize)]
pub struct MissionOut {
    pub mission_id: String,
    pub objective: String,
    pub digest: String,
    pub started_ms: i64,
    pub finished_ms: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct DirectiveOut {
    pub id: String,
    pub state: String,
    pub kind: String,
    pub payload: String,
    pub rationale: String,
    pub proposed_ms: i64,
    pub decided_ms: Option<i64>,
    pub block_reason: Option<String>,
}

#[tauri::command]
pub async fn familiar_approve_directive(
    familiar_id: String, directive_id: String,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<String, String> {
    let id = parse_id(&familiar_id)?;
    let rendered = mgr.approve_directive(id, &directive_id, now_ms()).await
        .map_err(|e| e.to_string())?;
    // The caller (UI) is responsible for delivering `rendered` into the operator's
    // input queue. We return it so the UI can show preview + dispatch in one step.
    Ok(rendered)
}

#[tauri::command]
pub async fn familiar_reject_directive(
    familiar_id: String, directive_id: String,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<(), String> {
    let id = parse_id(&familiar_id)?;
    mgr.reject_directive(id, &directive_id, now_ms()).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn familiar_snapshot(
    familiar_id: String,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<SnapshotOut, String> {
    let id = parse_id(&familiar_id)?;
    let mem = mgr.memory_of(id).await.map_err(|e| e.to_string())?;
    let cfg = mgr.config_of(id).await.map_err(|e| e.to_string())?;
    let mem = mem.lock().await;
    let summary = mem.latest_summary().map_err(|e| e.to_string())?;
    let missions = mem.recent_missions(5).map_err(|e| e.to_string())?;
    let day = familiar::cost::CostGate::current_day(now_ms());
    let spend = mem.spend_for_day(&day).map_err(|e| e.to_string())?;
    Ok(SnapshotOut {
        rolling_summary: summary.as_ref().map(|s| s.summary.clone()).unwrap_or_default(),
        last_event_ms: summary.map(|s| s.ts_ms).unwrap_or(0),
        recent_missions: missions.into_iter().map(|m| MissionOut {
            mission_id: m.mission_id, objective: m.objective, digest: m.digest,
            started_ms: m.started_ms, finished_ms: m.finished_ms,
        }).collect(),
        spend_today_usd: spend,
        frozen: spend >= cfg.daily_cap_usd,
    })
}

#[tauri::command]
pub async fn familiar_audit(
    familiar_id: String, since_ms: i64,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<Vec<DirectiveOut>, String> {
    let id = parse_id(&familiar_id)?;
    let mem = mgr.memory_of(id).await.map_err(|e| e.to_string())?;
    let mem = mem.lock().await;
    let rows = mem.directives_since(since_ms).map_err(|e| e.to_string())?;
    Ok(rows.into_iter().map(|r| DirectiveOut {
        id: r.id, state: r.state, kind: r.kind, payload: r.payload,
        rationale: r.rationale, proposed_ms: r.proposed_ms,
        decided_ms: r.decided_ms, block_reason: r.block_reason,
    }).collect())
}
```

- [ ] **Step 2: Register handlers**

In `crates/app/src/lib.rs` `generate_handler!` add:

```rust
    familiar_commands::familiar_approve_directive,
    familiar_commands::familiar_reject_directive,
    familiar_commands::familiar_snapshot,
    familiar_commands::familiar_audit,
```

- [ ] **Step 3: Verify compile**

Run: `cargo build -p app`
Expected: builds.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/familiar_commands.rs crates/app/src/lib.rs
git commit -m "feat(app): approve/reject/snapshot/audit commands"
```

---

## Task 23: Approved-directive injection into operator

**Files:**
- Modify: `crates/app/src/operator.rs` (locate the operator's input channel)
- Modify: `crates/app/src/familiar_commands.rs`

The operator already accepts user messages from the UI. The approval flow returns the rendered string; the UI then calls the existing operator-input command (e.g., `operator_send_user_message` or similar). We do NOT add a new injection channel — we reuse the existing one.

- [ ] **Step 1: Identify operator user-input command**

Run: `grep -n "tauri::command" crates/app/src/lib.rs crates/app/src/operator*.rs | grep -i "send\|message\|input\|prompt"`

Note the command name (e.g., `operator_send_message`).

- [ ] **Step 2: Document UI flow contract**

Add a doc comment at the top of `crates/app/src/familiar_commands.rs`:

```rust
//! Tauri commands for Familiars.
//!
//! Approval flow:
//!   1. UI calls `familiar_chat` → may return `directive_*`.
//!   2. UI shows directive card. On approve, UI calls
//!      `familiar_approve_directive(familiar_id, directive_id)`.
//!   3. The returned string is the synthetic user message; UI calls
//!      the existing operator input command (e.g. operator_send_message)
//!      with `session_id` + that string. Operator picks it up next cycle.
//!   4. Once executed, UI calls `familiar_mark_executed` (Task 23.5 below).
```

- [ ] **Step 3: Add `familiar_mark_executed`**

Append to `crates/app/src/familiar_commands.rs`:

```rust
#[tauri::command]
pub async fn familiar_mark_executed(
    familiar_id: String, directive_id: String,
    mgr: State<'_, Arc<FamiliarManager>>,
) -> Result<(), String> {
    let id = parse_id(&familiar_id)?;
    mgr.mark_executed(id, &directive_id, now_ms()).await
        .map_err(|e| e.to_string())
}
```

Register in `generate_handler!`:

```rust
    familiar_commands::familiar_mark_executed,
```

- [ ] **Step 4: Verify compile**

Run: `cargo build -p app`
Expected: builds.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/familiar_commands.rs crates/app/src/lib.rs
git commit -m "feat(app): mark_executed command + approval-flow contract"
```

---

## Task 24: TS API wrapper

**Files:**
- Create: `ui/src/familiars/api.ts`
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Write the wrapper**

Create `ui/src/familiars/api.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export type Style = "concise" | "formal" | "conversational" | "sarcastic";

export interface FamiliarSummary {
  id: string;
  session_id: string;
  name: string;
  style: Style;
  daily_cap_usd: number;
}

export interface ChatOutput {
  assistant_text: string;
  directive_id: string | null;
  directive_kind: string | null;
  directive_payload: string | null;
  directive_rationale: string | null;
  safety_block_reason: string | null;
}

export interface MissionOut {
  mission_id: string;
  objective: string;
  digest: string;
  started_ms: number;
  finished_ms: number | null;
}

export interface SnapshotOut {
  rolling_summary: string;
  last_event_ms: number;
  recent_missions: MissionOut[];
  spend_today_usd: number;
  frozen: boolean;
}

export interface DirectiveOut {
  id: string;
  state: "proposed" | "approved" | "rejected" | "executed" | "safety_blocked";
  kind: string;
  payload: string;
  rationale: string;
  proposed_ms: number;
  decided_ms: number | null;
  block_reason: string | null;
}

export const Familiars = {
  list: () => invoke<FamiliarSummary[]>("familiar_list"),
  spawn: (session_id: string, name: string, style: Style, daily_cap_usd: number) =>
    invoke<string>("familiar_spawn", { sessionId: session_id, name, style, dailyCapUsd: daily_cap_usd }),
  updateConfig: (familiar_id: string, name: string, style: Style, daily_cap_usd: number) =>
    invoke<void>("familiar_update_config",
      { familiarId: familiar_id, name, style, dailyCapUsd: daily_cap_usd }),
  chat: (familiar_id: string, user_text: string) =>
    invoke<ChatOutput>("familiar_chat", { input: { familiar_id, user_text } }),
  approve: (familiar_id: string, directive_id: string) =>
    invoke<string>("familiar_approve_directive",
      { familiarId: familiar_id, directiveId: directive_id }),
  reject: (familiar_id: string, directive_id: string) =>
    invoke<void>("familiar_reject_directive",
      { familiarId: familiar_id, directiveId: directive_id }),
  markExecuted: (familiar_id: string, directive_id: string) =>
    invoke<void>("familiar_mark_executed",
      { familiarId: familiar_id, directiveId: directive_id }),
  snapshot: (familiar_id: string) =>
    invoke<SnapshotOut>("familiar_snapshot", { familiarId: familiar_id }),
  audit: (familiar_id: string, since_ms: number) =>
    invoke<DirectiveOut[]>("familiar_audit",
      { familiarId: familiar_id, sinceMs: since_ms }),
};
```

Tauri converts `snake_case` Rust args to `camelCase` JS keys for the top-level args (but not nested struct fields, which keep `serde` rename). Confirm against existing wrappers in `ui/src/api.ts` and adapt the casing if the project uses a different convention.

- [ ] **Step 2: Re-export in `ui/src/api.ts`**

Append:

```ts
export { Familiars } from "./familiars/api";
export type {
  FamiliarSummary, ChatOutput, MissionOut, SnapshotOut, DirectiveOut, Style,
} from "./familiars/api";
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/familiars/api.ts ui/src/api.ts
git commit -m "feat(ui): typed wrapper for Familiars commands"
```

---

## Task 25: Roster — left panel (Familiars list)

**Files:**
- Create: `ui/src/familiars/list.ts`

- [ ] **Step 1: Implement**

Create `ui/src/familiars/list.ts`:

```ts
import { Familiars, type FamiliarSummary } from "./api";

export class FamiliarList {
  private el: HTMLDivElement;
  private items: FamiliarSummary[] = [];
  private selected: string | null = null;
  private onSelect: (id: string) => void;

  constructor(parent: HTMLElement, onSelect: (id: string) => void) {
    this.el = document.createElement("div");
    this.el.className = "familiar-list";
    parent.appendChild(this.el);
    this.onSelect = onSelect;
  }

  async refresh() {
    this.items = await Familiars.list();
    this.render();
  }

  select(id: string | null) {
    this.selected = id;
    this.render();
  }

  private render() {
    this.el.innerHTML = "";
    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "familiar-list-empty";
      empty.textContent = "No Familiars yet.";
      this.el.appendChild(empty);
      return;
    }
    for (const f of this.items) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "familiar-row" + (f.id === this.selected ? " selected" : "");
      row.innerHTML = `
        <span class="familiar-dot"></span>
        <span class="familiar-name">${escapeHtml(f.name)}</span>
        <span class="familiar-session">${escapeHtml(f.session_id.slice(0, 6))}</span>`;
      row.addEventListener("click", () => this.onSelect(f.id));
      this.el.appendChild(row);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/familiars/list.ts
git commit -m "feat(ui): familiar list panel"
```

---

## Task 26: Roster — directive card

**Files:**
- Create: `ui/src/familiars/directive_card.ts`

- [ ] **Step 1: Implement**

Create `ui/src/familiars/directive_card.ts`:

```ts
import { Familiars } from "./api";

export interface DirectiveCardSpec {
  familiar_id: string;
  directive_id: string;
  kind: string;
  payload: string;
  rationale: string;
  /** Called with the rendered synthetic message after approval. */
  onApproved: (rendered: string) => Promise<void> | void;
  onRejected?: () => void;
}

export function renderDirectiveCard(spec: DirectiveCardSpec): HTMLElement {
  const card = document.createElement("div");
  card.className = "directive-card";
  card.innerHTML = `
    <div class="directive-head">
      <span class="directive-kind">${spec.kind.toUpperCase()}</span>
      <span class="directive-status">PROPOSED</span>
    </div>
    <pre class="directive-payload"></pre>
    <div class="directive-rationale"></div>
    <div class="directive-actions">
      <button class="btn-approve">Approve</button>
      <button class="btn-reject">Reject</button>
      <button class="btn-edit">Edit</button>
    </div>`;
  (card.querySelector(".directive-payload") as HTMLElement).textContent = spec.payload;
  (card.querySelector(".directive-rationale") as HTMLElement).textContent = spec.rationale;

  const setStatus = (s: string, cls: string) => {
    const el = card.querySelector(".directive-status") as HTMLElement;
    el.textContent = s;
    card.classList.remove("approved", "rejected", "executed");
    card.classList.add(cls);
  };

  card.querySelector(".btn-approve")!.addEventListener("click", async () => {
    const rendered = await Familiars.approve(spec.familiar_id, spec.directive_id);
    setStatus("APPROVED", "approved");
    await spec.onApproved(rendered);
  });
  card.querySelector(".btn-reject")!.addEventListener("click", async () => {
    await Familiars.reject(spec.familiar_id, spec.directive_id);
    setStatus("REJECTED", "rejected");
    spec.onRejected?.();
  });
  card.querySelector(".btn-edit")!.addEventListener("click", () => {
    const pre = card.querySelector(".directive-payload") as HTMLElement;
    pre.contentEditable = "true";
    pre.focus();
  });
  return card;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/familiars/directive_card.ts
git commit -m "feat(ui): directive card component"
```

---

## Task 27: Roster — chat panel

**Files:**
- Create: `ui/src/familiars/chat.ts`

- [ ] **Step 1: Implement**

Create `ui/src/familiars/chat.ts`:

```ts
import { Familiars, type ChatOutput } from "./api";
import { renderDirectiveCard } from "./directive_card";

export class ChatPanel {
  private el: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLTextAreaElement;
  private familiarId: string | null = null;

  /** Hook the host wires up to deliver the rendered message into the operator. */
  onApprovedDirective: (familiarId: string, rendered: string) => Promise<void> = async () => {};

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "chat-panel";
    this.log = document.createElement("div");
    this.log.className = "chat-log";
    this.input = document.createElement("textarea");
    this.input.className = "chat-input";
    this.input.placeholder = "Talk to your Familiar… (⌘↵ to send)";
    this.input.rows = 3;
    this.input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.send();
      }
    });
    this.el.append(this.log, this.input);
    parent.appendChild(this.el);
  }

  setFamiliar(id: string | null) {
    this.familiarId = id;
    this.log.innerHTML = "";
    if (!id) {
      const note = document.createElement("div");
      note.className = "chat-empty";
      note.textContent = "Pick a Familiar.";
      this.log.appendChild(note);
    }
  }

  private append(role: "user" | "assistant", text: string): HTMLElement {
    const row = document.createElement("div");
    row.className = `chat-msg chat-msg-${role}`;
    row.textContent = text;
    this.log.appendChild(row);
    this.log.scrollTop = this.log.scrollHeight;
    return row;
  }

  private async send() {
    if (!this.familiarId) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    this.append("user", text);
    let out: ChatOutput;
    try {
      out = await Familiars.chat(this.familiarId, text);
    } catch (e) {
      this.append("assistant", `error: ${e}`);
      return;
    }
    this.append("assistant", out.assistant_text);
    if (out.directive_id) {
      const card = renderDirectiveCard({
        familiar_id: this.familiarId,
        directive_id: out.directive_id,
        kind: out.directive_kind ?? "custom",
        payload: out.directive_payload ?? "",
        rationale: out.directive_rationale ?? "",
        onApproved: async (rendered) => {
          await this.onApprovedDirective(this.familiarId!, rendered);
          await Familiars.markExecuted(this.familiarId!, out.directive_id!);
        },
      });
      this.log.appendChild(card);
      this.log.scrollTop = this.log.scrollHeight;
    } else if (out.safety_block_reason) {
      this.append("assistant",
        `(directive auto-rejected by safety: ${out.safety_block_reason})`);
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/familiars/chat.ts
git commit -m "feat(ui): chat panel + directive integration"
```

---

## Task 28: Roster — snapshot panel

**Files:**
- Create: `ui/src/familiars/snapshot.ts`

- [ ] **Step 1: Implement**

Create `ui/src/familiars/snapshot.ts`:

```ts
import { Familiars, type SnapshotOut } from "./api";

export class SnapshotPanel {
  private el: HTMLDivElement;
  private familiarId: string | null = null;
  private timer: number | null = null;

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "snapshot-panel";
    parent.appendChild(this.el);
  }

  setFamiliar(id: string | null) {
    this.familiarId = id;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.el.innerHTML = "";
    if (id) {
      this.refresh();
      this.timer = window.setInterval(() => this.refresh(), 5000);
    }
  }

  private async refresh() {
    if (!this.familiarId) return;
    let s: SnapshotOut;
    try { s = await Familiars.snapshot(this.familiarId); }
    catch { return; }
    const lastSync = s.last_event_ms === 0 ? "never"
      : `${Math.max(0, Math.round((Date.now() - s.last_event_ms) / 1000))}s ago`;
    this.el.innerHTML = `
      <div class="snap-section">
        <h4>Familiar status</h4>
        <div>Last sync: ${lastSync}</div>
        <div class="snap-spend ${s.frozen ? "frozen" : ""}">
          Today: $${s.spend_today_usd.toFixed(2)}${s.frozen ? " (frozen)" : ""}
        </div>
      </div>
      <div class="snap-section">
        <h4>Rolling summary</h4>
        <pre class="snap-summary"></pre>
      </div>
      <div class="snap-section">
        <h4>Recent missions</h4>
        <ul class="snap-missions"></ul>
      </div>`;
    (this.el.querySelector(".snap-summary") as HTMLElement).textContent =
      s.rolling_summary || "(empty)";
    const ul = this.el.querySelector(".snap-missions") as HTMLElement;
    if (s.recent_missions.length === 0) {
      ul.innerHTML = "<li>(none)</li>";
    } else {
      for (const m of s.recent_missions) {
        const li = document.createElement("li");
        li.textContent = `${m.objective}${m.finished_ms ? "" : " (in progress)"}`;
        ul.appendChild(li);
      }
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/familiars/snapshot.ts
git commit -m "feat(ui): snapshot panel"
```

---

## Task 29: Roster — assemble three panels + ⌘⇧M

**Files:**
- Create: `ui/src/familiars/roster.ts`
- Modify: `ui/src/main.ts`
- Modify: `ui/index.html`

- [ ] **Step 1: Add mount point**

In `ui/index.html` add (inside `<body>`, after existing roots):

```html
<div id="familiars-roster" class="hidden"></div>
```

- [ ] **Step 2: Implement roster**

Create `ui/src/familiars/roster.ts`:

```ts
import { FamiliarList } from "./list";
import { ChatPanel } from "./chat";
import { SnapshotPanel } from "./snapshot";

export class Roster {
  private root: HTMLElement;
  private list: FamiliarList;
  private chat: ChatPanel;
  private snap: SnapshotPanel;
  private current: string | null = null;
  /** Host hook: deliver the approved directive into the operator session. */
  onDeliverDirective: (sessionId: string, rendered: string) => Promise<void> = async () => {};

  constructor() {
    this.root = document.getElementById("familiars-roster")!;
    this.root.classList.add("roster");
    this.root.innerHTML = `
      <div class="roster-left"></div>
      <div class="roster-center"></div>
      <div class="roster-right"></div>
      <button class="roster-close" aria-label="Close">✕</button>`;
    this.list = new FamiliarList(this.root.querySelector(".roster-left")!,
      (id) => this.select(id));
    this.chat = new ChatPanel(this.root.querySelector(".roster-center")!);
    this.snap = new SnapshotPanel(this.root.querySelector(".roster-right")!);
    this.root.querySelector(".roster-close")!.addEventListener(
      "click", () => this.hide());
    this.chat.onApprovedDirective = async (familiarId, rendered) => {
      const f = (await import("./api")).Familiars;
      const list = await f.list();
      const item = list.find(x => x.id === familiarId);
      if (item) await this.onDeliverDirective(item.session_id, rendered);
    };
  }

  async show() {
    this.root.classList.remove("hidden");
    await this.list.refresh();
  }

  hide() { this.root.classList.add("hidden"); }
  toggle() {
    if (this.root.classList.contains("hidden")) this.show();
    else this.hide();
  }

  private select(id: string) {
    this.current = id;
    this.list.select(id);
    this.chat.setFamiliar(id);
    this.snap.setFamiliar(id);
  }
}
```

- [ ] **Step 3: Wire shortcut + delivery hook**

In `ui/src/main.ts` (after other init code), append:

```ts
import { Roster } from "./familiars/roster";

const roster = new Roster();
// Hook to deliver an approved directive into the operator. This calls
// whichever existing command sends a user message to the operator
// session. Replace `operator_send_message` with the actual command name
// found in Task 23, Step 1.
roster.onDeliverDirective = async (sessionId, rendered) => {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("operator_send_message", { sessionId, message: rendered });
};

window.addEventListener("keydown", (e) => {
  if (e.metaKey && e.shiftKey && e.key.toLowerCase() === "m") {
    e.preventDefault();
    roster.toggle();
  }
});
```

- [ ] **Step 4: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/familiars/roster.ts ui/src/main.ts ui/index.html
git commit -m "feat(ui): roster shell + ⌘⇧M shortcut"
```

---

## Task 30: Roster styles

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Add styles**

Append to `ui/src/styles.css`:

```css
.hidden { display: none !important; }

#familiars-roster.roster {
  position: fixed; inset: 0; z-index: 1000;
  display: grid;
  grid-template-columns: 220px 1fr 320px;
  background: rgba(20, 20, 24, 0.97);
  color: #e5e7eb;
  font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.roster-left, .roster-center, .roster-right {
  border-left: 1px solid #2a2a2f;
  overflow: auto; padding: 12px;
}
.roster-left { border-left: none; }
.roster-close {
  position: absolute; top: 8px; right: 12px;
  background: transparent; color: #9ca3af; border: none;
  cursor: pointer; font-size: 16px;
}

.familiar-list-empty { color: #6b7280; padding: 8px; }
.familiar-row {
  display: flex; align-items: center; gap: 8px;
  width: 100%; text-align: left; cursor: pointer;
  background: transparent; border: 1px solid transparent;
  color: #e5e7eb; padding: 6px 8px; border-radius: 6px;
  margin-bottom: 4px;
}
.familiar-row.selected { background: #1f2937; border-color: #374151; }
.familiar-row:hover { background: #1a2230; }
.familiar-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: #34d399;
}
.familiar-name { flex: 1; }
.familiar-session { color: #6b7280; font-size: 11px; }

.chat-panel { display: flex; flex-direction: column; height: 100%; }
.chat-log { flex: 1; overflow: auto; padding-right: 6px; }
.chat-msg { padding: 6px 10px; border-radius: 6px; margin: 4px 0;
            white-space: pre-wrap; }
.chat-msg-user { background: #1e293b; align-self: flex-end; }
.chat-msg-assistant { background: #111827; }
.chat-empty { color: #6b7280; text-align: center; margin-top: 40px; }
.chat-input {
  margin-top: 8px; resize: none; padding: 8px;
  background: #0b1220; color: #e5e7eb; border: 1px solid #1f2937;
  border-radius: 6px; font: inherit;
}

.directive-card {
  border: 1px solid #6366f1; background: #1e1b4b;
  border-radius: 8px; padding: 10px; margin: 8px 0;
}
.directive-card.approved { border-color: #10b981; }
.directive-card.rejected { border-color: #ef4444; opacity: 0.6; }
.directive-head { display: flex; justify-content: space-between;
  font-size: 11px; color: #c7d2fe; margin-bottom: 6px; }
.directive-payload {
  background: #0f172a; border-radius: 4px; padding: 8px;
  font: inherit; white-space: pre-wrap; margin: 4px 0;
}
.directive-rationale { color: #9ca3af; font-size: 12px; margin: 6px 0; }
.directive-actions { display: flex; gap: 6px; }
.directive-actions button {
  padding: 4px 10px; cursor: pointer; border-radius: 4px;
  background: #312e81; color: #e0e7ff; border: 1px solid #4338ca;
}
.btn-approve { background: #065f46 !important; border-color: #10b981 !important; }
.btn-reject { background: #7f1d1d !important; border-color: #ef4444 !important; }

.snapshot-panel .snap-section { margin-bottom: 16px; }
.snapshot-panel h4 { font-size: 11px; text-transform: uppercase;
  color: #9ca3af; margin: 0 0 6px; letter-spacing: 0.05em; }
.snap-summary { background: #0f172a; padding: 8px; border-radius: 4px;
  white-space: pre-wrap; max-height: 200px; overflow: auto; }
.snap-missions { list-style: disc inside; margin: 0; padding: 0; }
.snap-spend.frozen { color: #f87171; font-weight: bold; }
```

- [ ] **Step 2: Sanity check (visual)**

Run: `cd ui && npm run dev`

Then in the running app press ⌘⇧M. Verify:
- Roster opens full-screen.
- Three panels visible.
- Close button (✕) hides it.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(ui): roster styles"
```

---

## Task 31: Status bar indicator

**Files:**
- Create: `ui/src/familiars/status_indicator.ts`
- Modify: `ui/src/status/bar.ts`

- [ ] **Step 1: Implement indicator**

Create `ui/src/familiars/status_indicator.ts`:

```ts
import { Familiars } from "./api";

export type IndicatorState = "ok" | "pending" | "lost" | "off";

export class FamiliarStatusIndicator {
  private el: HTMLSpanElement;
  private familiarId: string | null = null;
  private timer: number | null = null;
  private onClick: () => void;

  constructor(parent: HTMLElement, onClick: () => void) {
    this.el = document.createElement("span");
    this.el.className = "familiar-status-dot off";
    this.el.title = "Familiar";
    this.el.addEventListener("click", () => this.onClick());
    parent.appendChild(this.el);
    this.onClick = onClick;
  }

  bind(familiarId: string | null) {
    this.familiarId = familiarId;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    if (familiarId) {
      this.refresh();
      this.timer = window.setInterval(() => this.refresh(), 5000);
    } else {
      this.set("off");
    }
  }

  private set(state: IndicatorState) {
    this.el.className = `familiar-status-dot ${state}`;
    this.el.title = `Familiar: ${state}`;
  }

  private async refresh() {
    if (!this.familiarId) return;
    try {
      const snap = await Familiars.snapshot(this.familiarId);
      const audit = await Familiars.audit(this.familiarId, Date.now() - 24*3600*1000);
      const pending = audit.some(d => d.state === "proposed");
      const ageMs = snap.last_event_ms === 0 ? Number.MAX_SAFE_INTEGER
                                              : Date.now() - snap.last_event_ms;
      if (pending) this.set("pending");
      else if (ageMs > 5 * 60_000) this.set("lost");
      else this.set("ok");
    } catch { this.set("lost"); }
  }
}
```

- [ ] **Step 2: Wire into status bar**

In `ui/src/status/bar.ts` find where per-tab status nodes are constructed, and add:

```ts
import { FamiliarStatusIndicator } from "../familiars/status_indicator";

// inside the per-tab init (where `tabContainer` is the row element):
const indicator = new FamiliarStatusIndicator(tabContainer, () => {
  // Same hook as ⌘⇧M
  document.dispatchEvent(new CustomEvent("familiars:open", { detail: { familiarId } }));
});
indicator.bind(familiarId); // familiarId may be null until Familiar is spawned
```

Where `familiarId` comes from a per-tab map. If no such map exists yet, add a simple `Map<sessionId, familiarId>` populated when a Familiar is spawned (Task 32).

In `ui/src/main.ts` add a listener:

```ts
document.addEventListener("familiars:open", () => roster.show());
```

- [ ] **Step 3: Add styles**

Append to `ui/src/styles.css`:

```css
.familiar-status-dot {
  display: inline-block; width: 8px; height: 8px; border-radius: 50%;
  margin-left: 6px; cursor: pointer; vertical-align: middle;
}
.familiar-status-dot.ok { background: #34d399; }
.familiar-status-dot.pending { background: #fbbf24; }
.familiar-status-dot.lost { background: #ef4444; }
.familiar-status-dot.off { background: #4b5563; }
```

- [ ] **Step 4: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/familiars/status_indicator.ts ui/src/status/bar.ts ui/src/main.ts ui/src/styles.css
git commit -m "feat(ui): per-tab Familiar status indicator"
```

---

## Task 32: Spawn-on-tab-create flow

**Files:**
- Modify: `ui/src/tabs/manager.ts`
- Modify: `ui/src/main.ts`

When a tab's operator starts, spawn a Familiar for that session. We auto-name the first one "Familiar"; the user can rename in settings.

- [ ] **Step 1: Locate operator-start hook**

Run: `grep -n "operator_start\|operator_spawn\|aom_start\|onOperatorStart" ui/src/operator/*.ts ui/src/tabs/*.ts | head -20`

Note the function or event used.

- [ ] **Step 2: Hook spawn after operator start**

In the relevant TS file, after the operator successfully starts for a session, call:

```ts
import { Familiars } from "../familiars/api";

async function ensureFamiliarFor(sessionId: string) {
  const list = await Familiars.list();
  const existing = list.find(f => f.session_id === sessionId);
  if (existing) return existing.id;
  // Defaults; user can edit in settings.
  return await Familiars.spawn(sessionId, "Familiar", "conversational", 5.0);
}
```

Call `ensureFamiliarFor(sessionId)` from the operator-start hook **only when** the user has Familiars enabled. Read the setting via the existing settings API:

```ts
const settings = await getSettings(); // existing helper
if (settings.familiars_enabled && settings.is_premium) {
  await ensureFamiliarFor(sessionId);
}
```

If `getSettings` doesn't exist with that name, use whatever the project uses (e.g., `Settings.load()`).

- [ ] **Step 3: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/operator/*.ts
git commit -m "feat(ui): auto-spawn Familiar when operator starts (gated)"
```

---

## Task 33: Settings panel — Familiars section

**Files:**
- Create: `ui/src/familiars/settings_panel.ts`
- Modify: `ui/src/settings/...` (the existing settings UI module)

- [ ] **Step 1: Implement panel**

Create `ui/src/familiars/settings_panel.ts`:

```ts
import { Familiars, type Style, type FamiliarSummary } from "./api";

export function renderFamiliarsSettings(
  parent: HTMLElement,
  isPremium: boolean,
  enabled: boolean,
  setEnabled: (v: boolean) => Promise<void>,
) {
  parent.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = "settings-section";

  const head = document.createElement("h3");
  head.textContent = "Familiars";
  wrap.appendChild(head);

  if (!isPremium) {
    const note = document.createElement("p");
    note.className = "settings-note";
    note.textContent = "Familiars is a premium feature.";
    wrap.appendChild(note);
    parent.appendChild(wrap);
    return;
  }

  const toggleRow = document.createElement("label");
  toggleRow.className = "settings-row";
  const toggle = document.createElement("input");
  toggle.type = "checkbox";
  toggle.checked = enabled;
  toggle.addEventListener("change", () => setEnabled(toggle.checked));
  toggleRow.append(toggle, document.createTextNode(" Enable Familiars"));
  wrap.appendChild(toggleRow);

  const list = document.createElement("div");
  list.className = "settings-familiars-list";
  wrap.appendChild(list);

  Familiars.list().then(items => renderList(list, items));
  parent.appendChild(wrap);
}

function renderList(el: HTMLElement, items: FamiliarSummary[]) {
  el.innerHTML = "";
  if (items.length === 0) {
    el.textContent = "(no Familiars yet — they appear once an operator starts)";
    return;
  }
  for (const f of items) {
    const row = document.createElement("div");
    row.className = "settings-familiar-row";
    row.innerHTML = `
      <input type="text" class="f-name" value="${escapeAttr(f.name)}" />
      <select class="f-style">
        ${(["concise","formal","conversational","sarcastic"] as Style[])
          .map(s => `<option value="${s}" ${s===f.style?"selected":""}>${s}</option>`).join("")}
      </select>
      <input type="number" class="f-cap" min="0" step="0.5" value="${f.daily_cap_usd}" />
      <button class="f-save">Save</button>`;
    row.querySelector(".f-save")!.addEventListener("click", async () => {
      const name = (row.querySelector(".f-name") as HTMLInputElement).value;
      const style = (row.querySelector(".f-style") as HTMLSelectElement).value as Style;
      const cap = parseFloat((row.querySelector(".f-cap") as HTMLInputElement).value);
      await Familiars.updateConfig(f.id, name, style, cap);
    });
    el.appendChild(row);
  }
}

function escapeAttr(s: string): string {
  return s.replace(/[&<>"]/g, c =>
    ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]!));
}
```

- [ ] **Step 2: Mount in settings UI**

Find the settings UI entry (e.g., `ui/src/settings/panel.ts` or similar) and add a section call:

```ts
import { renderFamiliarsSettings } from "../familiars/settings_panel";

// Where other sections render:
const familiarsHost = document.createElement("div");
sectionsContainer.appendChild(familiarsHost);
renderFamiliarsSettings(
  familiarsHost,
  settings.is_premium,
  settings.familiars_enabled,
  async (v) => { settings.familiars_enabled = v; await saveSettings(settings); },
);
```

Adapt `settings`, `saveSettings`, etc. to the actual project API.

- [ ] **Step 3: Add styles**

Append to `ui/src/styles.css`:

```css
.settings-familiars-list { margin-top: 12px; display: grid; gap: 8px; }
.settings-familiar-row {
  display: grid; grid-template-columns: 1fr 140px 100px 80px;
  gap: 8px; align-items: center;
}
.settings-note { color: #9ca3af; font-style: italic; }
```

- [ ] **Step 4: Typecheck**

Run: `cd ui && npm run typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/familiars/settings_panel.ts ui/src/settings ui/src/styles.css
git commit -m "feat(ui): Familiars settings panel"
```

---

## Task 34: Audit log viewer

**Files:**
- Create: `ui/src/familiars/audit_log.ts`
- Modify: `ui/src/familiars/roster.ts` (add tab)

- [ ] **Step 1: Implement viewer**

Create `ui/src/familiars/audit_log.ts`:

```ts
import { Familiars, type DirectiveOut } from "./api";

export class AuditLog {
  private el: HTMLDivElement;
  private familiarId: string | null = null;
  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "audit-log hidden";
    parent.appendChild(this.el);
  }
  setFamiliar(id: string | null) {
    this.familiarId = id;
    if (id) this.refresh();
  }
  show() { this.el.classList.remove("hidden"); }
  hide() { this.el.classList.add("hidden"); }
  private async refresh() {
    if (!this.familiarId) return;
    let rows: DirectiveOut[] = [];
    try { rows = await Familiars.audit(this.familiarId, 0); } catch {}
    this.el.innerHTML = `<h4>Directive audit</h4>`;
    if (rows.length === 0) { this.el.append(document.createTextNode("(none)")); return; }
    const ul = document.createElement("ul");
    for (const r of rows) {
      const li = document.createElement("li");
      const when = new Date(r.proposed_ms).toLocaleString();
      li.innerHTML = `<span class="audit-state ${r.state}">${r.state}</span>
        <span class="audit-kind">${r.kind}</span>
        <code>${escape(r.payload)}</code>
        <span class="audit-when">${when}</span>
        ${r.block_reason ? `<div class="audit-block">blocked: ${escape(r.block_reason)}</div>` : ""}`;
      ul.appendChild(li);
    }
    this.el.appendChild(ul);
  }
}
function escape(s: string): string {
  return s.replace(/[&<>]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]!));
}
```

- [ ] **Step 2: Add a small toggle button in roster**

In `ui/src/familiars/roster.ts`, after creating the snapshot panel, add:

```ts
import { AuditLog } from "./audit_log";

// In constructor, after this.snap:
const auditHost = document.createElement("div");
this.root.querySelector(".roster-right")!.appendChild(auditHost);
this.audit = new AuditLog(auditHost);
const auditBtn = document.createElement("button");
auditBtn.className = "audit-toggle";
auditBtn.textContent = "Audit log";
auditBtn.addEventListener("click", () => {
  if (auditHost.querySelector(".audit-log")?.classList.contains("hidden"))
    this.audit.show();
  else this.audit.hide();
});
this.root.querySelector(".roster-right")!.appendChild(auditBtn);

// Add field:
private audit!: AuditLog;

// In `select(id)`:
this.audit.setFamiliar(id);
```

- [ ] **Step 3: Style**

Append to `ui/src/styles.css`:

```css
.audit-log { margin-top: 12px; border-top: 1px solid #2a2a2f; padding-top: 8px; }
.audit-log ul { list-style: none; padding: 0; margin: 6px 0; }
.audit-log li { padding: 4px 0; border-bottom: 1px solid #1f1f25; }
.audit-state { display: inline-block; min-width: 80px; padding: 1px 6px;
               border-radius: 3px; font-size: 11px; margin-right: 6px; }
.audit-state.proposed { background: #1f2937; color: #93c5fd; }
.audit-state.approved { background: #064e3b; color: #6ee7b7; }
.audit-state.executed { background: #052e16; color: #34d399; }
.audit-state.rejected { background: #4c1d1d; color: #fca5a5; }
.audit-state.safety_blocked { background: #7c2d12; color: #fdba74; }
.audit-when { color: #6b7280; font-size: 11px; margin-left: 6px; }
.audit-block { color: #f87171; font-size: 11px; margin-top: 2px; }
.audit-toggle {
  margin-top: 8px; background: transparent; color: #9ca3af;
  border: 1px solid #374151; padding: 3px 8px; border-radius: 4px;
  cursor: pointer; font: inherit;
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `cd ui && npm run typecheck`
Expected: no errors.

```bash
git add ui/src/familiars/audit_log.ts ui/src/familiars/roster.ts ui/src/styles.css
git commit -m "feat(ui): directive audit log viewer"
```

---

## Task 35: Premium gating at command boundary

**Files:**
- Modify: `crates/app/src/familiar_commands.rs`
- Modify: `crates/app/src/lib.rs` (expose settings handle if not already in state)

- [ ] **Step 1: Add gate helper**

Append to `crates/app/src/familiar_commands.rs`:

```rust
fn require_active(settings: &State<'_, std::sync::Arc<tokio::sync::Mutex<crate::settings::Settings>>>)
    -> Result<(), String>
{
    // Block at the command boundary if Familiars are not active.
    // Errors are propagated to JS and the UI is responsible for hiding the
    // feature when inactive — this is a defense-in-depth check.
    let s = futures_util::executor::block_on(settings.lock());
    if !s.familiars_active() {
        return Err("Familiars not enabled (premium feature).".into());
    }
    Ok(())
}
```

If settings is held differently, adapt. In each `#[tauri::command]` add as the **first** statement:

```rust
    require_active(&settings)?;
```

and accept the parameter:

```rust
    settings: State<'_, std::sync::Arc<tokio::sync::Mutex<crate::settings::Settings>>>,
```

Apply to: `familiar_list`, `familiar_spawn`, `familiar_update_config`, `familiar_chat`, `familiar_approve_directive`, `familiar_reject_directive`, `familiar_snapshot`, `familiar_audit`, `familiar_mark_executed`.

- [ ] **Step 2: Verify compile**

Run: `cargo build -p app`
Expected: builds.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/familiar_commands.rs
git commit -m "feat(app): gate Familiar commands behind premium+enabled"
```

---

## Task 36: End-to-end smoke (manual checklist)

**Files:**
- Create: `docs/superpowers/notes/2026-05-04-familiars-smoke.md`

- [ ] **Step 1: Write the smoke checklist**

Create `docs/superpowers/notes/2026-05-04-familiars-smoke.md`:

```markdown
# Familiars — Manual Smoke Test (Phase 1 MVP)

Pre: `ANTHROPIC_API_KEY` exported. Settings → set `is_premium = true` + `familiars_enabled = true`.

1. Launch app. Open a tab. Start an operator on it.
2. Verify status-bar dot turns green within ~10s of first operator command.
3. Press ⌘⇧M. Verify roster opens with one Familiar listed.
4. Click the Familiar. Send "what are you watching?". Assistant reply uses
   information from the operator's recent commands.
5. Send "propose stopping the next deploy". Assistant should propose a
   directive card (kind=stop). Click Approve. Verify the operator receives
   the synthetic message in its next cycle (visible in operator transcript).
6. Send a deliberately unsafe ask: "propose `rm -rf /`". Verify reply
   indicates safety block; audit log shows `safety_blocked`.
7. Settings → rename Familiar to "Marcus", style "sarcastic". Reopen
   roster. Send another message. Assistant signs as Marcus / tone shifts.
8. Lower `daily_cap_usd` to 0.01. Send chat. Verify subsequent eager
   summarization stops (snapshot shows frozen). Bump back to 5.0; verify resumes.
9. Close tab. Reopen app. Familiar still listed (persistence works).

If any step fails, file issue with reproduction steps.
```

- [ ] **Step 2: Run the smoke test**

Manually walk through steps 1–9.

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/notes/2026-05-04-familiars-smoke.md
git commit -m "docs(familiar): manual smoke test checklist"
```

---

## Task 37: README + spec cross-link

**Files:**
- Modify: `crates/familiar/README.md` (create)
- Modify: spec — add link to crate

- [ ] **Step 1: Create README**

Write `crates/familiar/README.md`:

```markdown
# familiar

Per-operator AI companion: persistent memory, named identity, configurable style,
approved-directive flow.

See `docs/superpowers/specs/2026-05-04-familiars-design.md` for the design.
See `docs/superpowers/plans/2026-05-04-familiars.md` for the implementation plan.

## Modules

- `identity` — `Familiar`, `FamiliarId`, `Style`, `FamiliarConfig`
- `memory` — SQLite store: events, summaries, missions, chat, directives, costs
- `observer` — drains `SessionEvent` bus, persists, triggers eager summarization
- `summarizer` — Haiku eager + Sonnet lazy, behind a mockable `Llm` trait
- `prompts` — system prompt builder with style variants
- `agent` — chat loop, parses `<<DIRECTIVE>>...<</DIRECTIVE>>` proposals
- `directive` — types + safety check (DefaultSafety blocklist)
- `manager` — `FamiliarManager` registry + lifecycle + approval flow
- `cost` — daily-cap gate + frozen-mode

## Storage

`~/.karlTerminal/familiars/<familiar_id>.sqlite`

## Tests

`cargo test -p familiar` — unit + integration (`tests/observer.rs`).
```

- [ ] **Step 2: Commit**

```bash
git add crates/familiar/README.md
git commit -m "docs(familiar): crate README"
```

---

## Final verification

- [ ] Run full Rust suite

```bash
cargo test --workspace
```

Expected: all green.

- [ ] Run UI typecheck + build

```bash
cd ui && npm run typecheck && npm run build
```

Expected: clean.

- [ ] Re-walk the smoke checklist (Task 36 step 2).

---

## Self-Review (author's notes baked in)

- **Spec coverage:** every section of the spec maps to tasks:
  - Architecture/components → Tasks 1–18
  - Memory model (3 layers) → Tasks 3–7
  - Phase C pathway → schema includes the tables; `recall_episode` is intentionally absent (Phase 2)
  - Directive flow → Tasks 15, 16, 18, 22, 23
  - UI Roster → Tasks 24–30
  - UI Phase 2 (inline ⌘K) → intentionally absent (Phase 2)
  - Status bar indicator → Task 31
  - Cost model (tiered) → Tasks 8, 10, 11, 12; daily cap enforcement at observer (Task 13 flush) and via `CostGate` (Task 8); frozen-mode surfaced in snapshot (Task 22)
  - Premium gating → Tasks 19, 35
  - Audit log → Tasks 7, 22, 34
  - Out-of-scope items → not implemented (intentional)

- **Open Questions surface in plan:**
  - Q1 Mastra: addressed — implement the *pattern* in Rust (Task 16 chat loop). No JS dep.
  - Q2 Operator→Familiar isolation: addressed — Familiar only sees `SessionEvent` bus, never the operator's prompt (Task 13).
  - Q3 Directive injection format: synthetic user message via `Directive::rendered_for_operator` (Task 15) reusing existing operator input command (Task 23).
  - Q4 Style prompts: drafted in Task 9; user iterates in settings post-launch.

- **Known follow-ups (not in MVP):**
  - The status indicator polls every 5s; consider event-driven push later.
  - `frozen mode` halts new summarization but does not pause the chat agent — chat will fail with `Frozen` once the cap is hit and the agent is invoked. Acceptable for MVP; surface a clearer error in Phase 2.
  - The observer-spawn helper `spawn_familiar_observer_for` (Task 20) is defined but **only called** from a Familiar-creation site that the UI triggers. Verify in Task 32 hookup that `ensureFamiliarFor` ultimately leads to an observer spawn — if not, add a Tauri-side hook in `familiar_spawn` that auto-starts the observer.
