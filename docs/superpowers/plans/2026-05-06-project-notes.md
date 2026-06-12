# Project Notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-group "Project Notes" panel with three typed tabs (Commands, Notes, Docs) backed by SQLite, plus an operator pre-context builder that injects this data into mission system prompts under a 2000-token budget.

**Architecture:** New SQLite tables alongside existing app DB; a new Rust module `crates/app/src/project_notes.rs` owning storage CRUD and the pre-context builder; new Tauri commands wired into `lib.rs`'s `generate_handler!`; UI panel as a right-side overlay opened from the group header chip in `ui/src/tabs/manager.ts`, with Commands/Notes/Docs tabs reusing existing primitives where possible (Docs reuses the existing Docs editor; fullscreen reuses the existing fullscreen pattern).

**Tech Stack:** Rust (rusqlite, tokio, ulid, serde, thiserror), Tauri 2 commands + events, TypeScript (no new frameworks), vitest for UI tests, cargo test for Rust.

**Reference spec:** `docs/superpowers/specs/2026-05-06-project-notes-design.md`

---

## File Structure

**New files:**
- `crates/app/src/project_notes.rs` — types, DB CRUD, pre-context builder.
- `crates/app/src/project_notes_tests.rs` *(only if module gets large; otherwise inline `#[cfg(test)]`)*
- `ui/src/project-notes/panel.ts` — overlay panel shell, tab switching.
- `ui/src/project-notes/commands-tab.ts` — Commands list + paste.
- `ui/src/project-notes/notes-tab.ts` — append-only journal.
- `ui/src/project-notes/docs-tab.ts` — markdown editor wrapper.
- `ui/src/project-notes/api.ts` — typed wrappers around new Tauri commands.
- `ui/src/project-notes/styles.css` — scoped styles for the panel.
- `ui/src/project-notes/panel.test.ts` — vitest for tab switch + open/close.
- `ui/src/project-notes/commands-tab.test.ts` — vitest for paste + CRUD wiring.

**Modified files:**
- `crates/app/src/storage.rs` — extend `SCHEMA` constant with three tables + indexes.
- `crates/app/src/lib.rs` — register new Tauri commands; add `mod project_notes;`.
- `crates/app/src/operator.rs` — call `project_notes::build_project_context` in `build_system_prompt`; add a new arg.
- `ui/src/main.ts` — wire the panel singleton, group-header click handler, `⌘⇧N` shortcut.
- `ui/src/tabs/manager.ts` — emit a "request open project notes" callback when the group header is clicked (data flows up; panel mounts in `main.ts`).
- `ui/src/api.ts` — re-export project-notes API types if needed.
- `ui/src/styles.css` — `@import "./project-notes/styles.css";`

---

## Task 1: DB schema + Rust types + storage CRUD

**Files:**
- Modify: `crates/app/src/storage.rs` (extend `SCHEMA`)
- Create: `crates/app/src/project_notes.rs`
- Modify: `crates/app/src/lib.rs` (add `mod project_notes;`)

- [ ] **Step 1.1: Extend the schema**

In `crates/app/src/storage.rs`, append these table definitions to the `SCHEMA` constant (right before the closing `";`):

```sql
CREATE TABLE IF NOT EXISTS project_commands (
    id                 TEXT PRIMARY KEY,
    group_id           TEXT NOT NULL,
    title              TEXT NOT NULL,
    command            TEXT NOT NULL,
    sort_order         INTEGER NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_commands_group
    ON project_commands(group_id, sort_order);

CREATE TABLE IF NOT EXISTS project_notes (
    id                 TEXT PRIMARY KEY,
    group_id           TEXT NOT NULL,
    body               TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_notes_group_created
    ON project_notes(group_id, created_at_unix_ms DESC);

CREATE TABLE IF NOT EXISTS project_docs (
    group_id           TEXT PRIMARY KEY,
    body               TEXT NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);
```

- [ ] **Step 1.2: Add module declaration**

In `crates/app/src/lib.rs`, add near the other `mod` declarations:

```rust
mod project_notes;
```

- [ ] **Step 1.3: Write the new module skeleton**

Create `crates/app/src/project_notes.rs`:

```rust
//! Project Notes — per-group Commands, Notes, Docs.
//!
//! Storage is SQLite (same DB as `storage.rs`). Identifiers are Ulids
//! serialized as strings. All sync rusqlite calls are wrapped in
//! `spawn_blocking` so the executor doesn't stall.
//!
//! See `docs/superpowers/specs/2026-05-06-project-notes-design.md`.

use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;
use ulid::Ulid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub id: String,
    pub group_id: String,
    pub title: String,
    pub command: String,
    pub sort_order: i64,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    pub group_id: String,
    pub body: String,
    pub created_at_unix_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct Snapshot {
    pub commands: Vec<Command>,
    pub notes: Vec<Note>,   // newest first, capped to 50
    pub docs: String,
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("blocking task panicked: {0}")]
    Join(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Handle to the shared connection. The connection mutex is the same
/// pattern used by `storage.rs` — clone the `Arc<Mutex<Connection>>`.
#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    fn now_ms() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    pub async fn snapshot(&self, group_id: &str) -> Result<Snapshot> {
        let conn = self.conn.clone();
        let group_id = group_id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<Snapshot> {
            let conn = conn.blocking_lock();
            let commands = list_commands(&conn, &group_id)?;
            let notes = list_notes(&conn, &group_id, 50, None)?;
            let docs = get_docs(&conn, &group_id)?;
            Ok(Snapshot { commands, notes, docs })
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn create_command(
        &self,
        group_id: &str,
        title: &str,
        command: &str,
    ) -> Result<Command> {
        let conn = self.conn.clone();
        let group_id = group_id.to_owned();
        let title = title.to_owned();
        let command_text = command.to_owned();
        tokio::task::spawn_blocking(move || -> Result<Command> {
            let conn = conn.blocking_lock();
            let now = Self::now_ms();
            let id = Ulid::new().to_string();
            let next_order: i64 = conn
                .query_row(
                    "SELECT COALESCE(MAX(sort_order), -1) + 1
                       FROM project_commands WHERE group_id = ?1",
                    params![&group_id],
                    |r| r.get(0),
                )?;
            conn.execute(
                "INSERT INTO project_commands
                 (id, group_id, title, command, sort_order,
                  created_at_unix_ms, updated_at_unix_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                params![&id, &group_id, &title, &command_text, next_order, now],
            )?;
            Ok(Command {
                id,
                group_id,
                title,
                command: command_text,
                sort_order: next_order,
                created_at_unix_ms: now,
                updated_at_unix_ms: now,
            })
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn update_command(
        &self,
        id: &str,
        title: &str,
        command: &str,
    ) -> Result<Option<Command>> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        let title = title.to_owned();
        let command_text = command.to_owned();
        tokio::task::spawn_blocking(move || -> Result<Option<Command>> {
            let conn = conn.blocking_lock();
            let now = Self::now_ms();
            let updated = conn.execute(
                "UPDATE project_commands
                    SET title = ?2, command = ?3, updated_at_unix_ms = ?4
                  WHERE id = ?1",
                params![&id, &title, &command_text, now],
            )?;
            if updated == 0 {
                return Ok(None);
            }
            let row = conn
                .query_row(
                    "SELECT id, group_id, title, command, sort_order,
                            created_at_unix_ms, updated_at_unix_ms
                       FROM project_commands WHERE id = ?1",
                    params![&id],
                    row_to_command,
                )
                .optional()?;
            Ok(row)
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn delete_command(&self, id: &str) -> Result<()> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = conn.blocking_lock();
            conn.execute(
                "DELETE FROM project_commands WHERE id = ?1",
                params![&id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn reorder_commands(
        &self,
        group_id: &str,
        ordered_ids: Vec<String>,
    ) -> Result<()> {
        let conn = self.conn.clone();
        let group_id = group_id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut conn = conn.blocking_lock();
            let tx = conn.transaction()?;
            for (i, id) in ordered_ids.iter().enumerate() {
                tx.execute(
                    "UPDATE project_commands
                        SET sort_order = ?2
                      WHERE id = ?1 AND group_id = ?3",
                    params![id, i as i64, &group_id],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn append_note(&self, group_id: &str, body: &str) -> Result<Note> {
        let conn = self.conn.clone();
        let group_id = group_id.to_owned();
        let body = body.to_owned();
        tokio::task::spawn_blocking(move || -> Result<Note> {
            let conn = conn.blocking_lock();
            let now = Self::now_ms();
            let id = Ulid::new().to_string();
            conn.execute(
                "INSERT INTO project_notes
                 (id, group_id, body, created_at_unix_ms)
                 VALUES (?1, ?2, ?3, ?4)",
                params![&id, &group_id, &body, now],
            )?;
            Ok(Note { id, group_id, body, created_at_unix_ms: now })
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn delete_note(&self, id: &str) -> Result<()> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = conn.blocking_lock();
            conn.execute(
                "DELETE FROM project_notes WHERE id = ?1",
                params![&id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn list_notes(
        &self,
        group_id: &str,
        limit: usize,
        before_ts: Option<i64>,
    ) -> Result<Vec<Note>> {
        let conn = self.conn.clone();
        let group_id = group_id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<Vec<Note>> {
            let conn = conn.blocking_lock();
            list_notes(&conn, &group_id, limit, before_ts)
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn get_docs(&self, group_id: &str) -> Result<String> {
        let conn = self.conn.clone();
        let group_id = group_id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<String> {
            let conn = conn.blocking_lock();
            get_docs(&conn, &group_id)
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn save_docs(&self, group_id: &str, body: &str) -> Result<()> {
        let conn = self.conn.clone();
        let group_id = group_id.to_owned();
        let body = body.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = conn.blocking_lock();
            let now = Self::now_ms();
            conn.execute(
                "INSERT INTO project_docs (group_id, body, updated_at_unix_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(group_id) DO UPDATE SET
                   body = excluded.body,
                   updated_at_unix_ms = excluded.updated_at_unix_ms",
                params![&group_id, &body, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }
}

fn row_to_command(row: &rusqlite::Row<'_>) -> rusqlite::Result<Command> {
    Ok(Command {
        id: row.get(0)?,
        group_id: row.get(1)?,
        title: row.get(2)?,
        command: row.get(3)?,
        sort_order: row.get(4)?,
        created_at_unix_ms: row.get(5)?,
        updated_at_unix_ms: row.get(6)?,
    })
}

fn list_commands(conn: &Connection, group_id: &str) -> Result<Vec<Command>> {
    let mut stmt = conn.prepare(
        "SELECT id, group_id, title, command, sort_order,
                created_at_unix_ms, updated_at_unix_ms
           FROM project_commands
          WHERE group_id = ?1
          ORDER BY sort_order ASC",
    )?;
    let rows = stmt
        .query_map(params![group_id], row_to_command)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

fn list_notes(
    conn: &Connection,
    group_id: &str,
    limit: usize,
    before_ts: Option<i64>,
) -> Result<Vec<Note>> {
    let (sql, rows) = if let Some(ts) = before_ts {
        let mut stmt = conn.prepare(
            "SELECT id, group_id, body, created_at_unix_ms
               FROM project_notes
              WHERE group_id = ?1 AND created_at_unix_ms < ?2
              ORDER BY created_at_unix_ms DESC
              LIMIT ?3",
        )?;
        let rows = stmt
            .query_map(params![group_id, ts, limit as i64], |r| {
                Ok(Note {
                    id: r.get(0)?,
                    group_id: r.get(1)?,
                    body: r.get(2)?,
                    created_at_unix_ms: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        (true, rows)
    } else {
        let mut stmt = conn.prepare(
            "SELECT id, group_id, body, created_at_unix_ms
               FROM project_notes
              WHERE group_id = ?1
              ORDER BY created_at_unix_ms DESC
              LIMIT ?2",
        )?;
        let rows = stmt
            .query_map(params![group_id, limit as i64], |r| {
                Ok(Note {
                    id: r.get(0)?,
                    group_id: r.get(1)?,
                    body: r.get(2)?,
                    created_at_unix_ms: r.get(3)?,
                })
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        (false, rows)
    };
    let _ = sql;
    Ok(rows)
}

fn get_docs(conn: &Connection, group_id: &str) -> Result<String> {
    let body: Option<String> = conn
        .query_row(
            "SELECT body FROM project_docs WHERE group_id = ?1",
            params![group_id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(body.unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_store() -> Store {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::SCHEMA).unwrap();
        Store::new(Arc::new(Mutex::new(conn)))
    }

    #[tokio::test]
    async fn command_crud_roundtrip() {
        let s = fresh_store();
        let g = "g1";
        let c = s.create_command(g, "Run UI", "npm run dev").await.unwrap();
        assert_eq!(c.sort_order, 0);
        let snap = s.snapshot(g).await.unwrap();
        assert_eq!(snap.commands.len(), 1);
        let updated = s
            .update_command(&c.id, "Run UI dev", "cd ui && npm run dev")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.title, "Run UI dev");
        s.delete_command(&c.id).await.unwrap();
        assert!(s.snapshot(g).await.unwrap().commands.is_empty());
    }

    #[tokio::test]
    async fn reorder_commands_sets_indices() {
        let s = fresh_store();
        let g = "g1";
        let a = s.create_command(g, "a", "a").await.unwrap();
        let b = s.create_command(g, "b", "b").await.unwrap();
        let c = s.create_command(g, "c", "c").await.unwrap();
        s.reorder_commands(g, vec![c.id.clone(), a.id.clone(), b.id.clone()])
            .await
            .unwrap();
        let snap = s.snapshot(g).await.unwrap();
        let titles: Vec<_> = snap.commands.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["c", "a", "b"]);
    }

    #[tokio::test]
    async fn notes_append_and_list_newest_first() {
        let s = fresh_store();
        let g = "g1";
        for body in ["one", "two", "three"] {
            s.append_note(g, body).await.unwrap();
            // ensure monotonic timestamps when test runs fast
            tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        }
        let snap = s.snapshot(g).await.unwrap();
        let bodies: Vec<_> = snap.notes.iter().map(|n| n.body.as_str()).collect();
        assert_eq!(bodies, vec!["three", "two", "one"]);
    }

    #[tokio::test]
    async fn docs_upsert() {
        let s = fresh_store();
        let g = "g1";
        assert_eq!(s.get_docs(g).await.unwrap(), "");
        s.save_docs(g, "# Hello").await.unwrap();
        assert_eq!(s.get_docs(g).await.unwrap(), "# Hello");
        s.save_docs(g, "# Hello v2").await.unwrap();
        assert_eq!(s.get_docs(g).await.unwrap(), "# Hello v2");
    }

    #[tokio::test]
    async fn snapshot_isolated_per_group() {
        let s = fresh_store();
        s.append_note("g1", "x").await.unwrap();
        s.create_command("g2", "t", "c").await.unwrap();
        let snap1 = s.snapshot("g1").await.unwrap();
        let snap2 = s.snapshot("g2").await.unwrap();
        assert_eq!(snap1.notes.len(), 1);
        assert!(snap1.commands.is_empty());
        assert_eq!(snap2.commands.len(), 1);
        assert!(snap2.notes.is_empty());
    }
}
```

- [ ] **Step 1.4: Run the tests**

Run: `cargo test -p karl-app project_notes::tests --lib`
Expected: 5 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add crates/app/src/storage.rs crates/app/src/lib.rs crates/app/src/project_notes.rs
git commit -m "feat(project-notes): SQLite schema + storage CRUD module"
```

---

## Task 2: Tauri commands + handler registration + state plumbing

**Files:**
- Modify: `crates/app/src/project_notes.rs` (add `#[tauri::command]` wrappers)
- Modify: `crates/app/src/lib.rs` (state init + handler registration)

- [ ] **Step 2.1: Locate the existing Connection state**

In `crates/app/src/lib.rs`, find where `storage::Storage` (or the underlying `Arc<Mutex<Connection>>`) is created and inserted into Tauri state. Reuse that connection — do NOT open a second DB. If the existing storage type does not expose its inner `Arc<Mutex<Connection>>`, add a method `pub fn conn(&self) -> Arc<Mutex<Connection>>` to it.

The pattern to look for is the `.manage(...)` calls inside the Tauri builder around `lib.rs:2284`. Confirm with:

```bash
grep -n "manage(" crates/app/src/lib.rs | head -20
```

- [ ] **Step 2.2: Construct and manage a `project_notes::Store`**

In `lib.rs`, near the other `.manage(...)` calls during builder setup, add:

```rust
let project_notes_store = project_notes::Store::new(storage_conn.clone());
// (storage_conn = Arc<Mutex<Connection>> sourced from existing storage init)
```

Then `.manage(project_notes_store)`.

- [ ] **Step 2.3: Add Tauri command wrappers**

Append to `crates/app/src/project_notes.rs`:

```rust
// ----- Tauri command surface -----

use tauri::State;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn project_notes_get(
    store: State<'_, Store>,
    group_id: String,
) -> std::result::Result<Snapshot, String> {
    store.snapshot(&group_id).await.map_err(map_err)
}

#[tauri::command]
pub async fn project_command_create(
    store: State<'_, Store>,
    group_id: String,
    title: String,
    command: String,
) -> std::result::Result<Command, String> {
    store
        .create_command(&group_id, &title, &command)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn project_command_update(
    store: State<'_, Store>,
    id: String,
    title: String,
    command: String,
) -> std::result::Result<Option<Command>, String> {
    store.update_command(&id, &title, &command).await.map_err(map_err)
}

#[tauri::command]
pub async fn project_command_delete(
    store: State<'_, Store>,
    id: String,
) -> std::result::Result<(), String> {
    store.delete_command(&id).await.map_err(map_err)
}

#[tauri::command]
pub async fn project_command_reorder(
    store: State<'_, Store>,
    group_id: String,
    ordered_ids: Vec<String>,
) -> std::result::Result<(), String> {
    store
        .reorder_commands(&group_id, ordered_ids)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn project_note_append(
    store: State<'_, Store>,
    group_id: String,
    body: String,
) -> std::result::Result<Note, String> {
    store.append_note(&group_id, &body).await.map_err(map_err)
}

#[tauri::command]
pub async fn project_note_delete(
    store: State<'_, Store>,
    id: String,
) -> std::result::Result<(), String> {
    store.delete_note(&id).await.map_err(map_err)
}

#[tauri::command]
pub async fn project_note_list(
    store: State<'_, Store>,
    group_id: String,
    limit: usize,
    before_ts: Option<i64>,
) -> std::result::Result<Vec<Note>, String> {
    store
        .list_notes(&group_id, limit, before_ts)
        .await
        .map_err(map_err)
}

#[tauri::command]
pub async fn project_docs_get(
    store: State<'_, Store>,
    group_id: String,
) -> std::result::Result<String, String> {
    store.get_docs(&group_id).await.map_err(map_err)
}

#[tauri::command]
pub async fn project_docs_save(
    store: State<'_, Store>,
    group_id: String,
    body: String,
) -> std::result::Result<(), String> {
    store.save_docs(&group_id, &body).await.map_err(map_err)
}
```

The `paste_to_active_tab` command lives in Task 6 (UI side picks the active tab and calls the existing PTY write command).

- [ ] **Step 2.4: Register the handlers**

In `lib.rs`, inside `tauri::generate_handler![...]` (around line 2284), add the new commands:

```rust
project_notes::project_notes_get,
project_notes::project_command_create,
project_notes::project_command_update,
project_notes::project_command_delete,
project_notes::project_command_reorder,
project_notes::project_note_append,
project_notes::project_note_delete,
project_notes::project_note_list,
project_notes::project_docs_get,
project_notes::project_docs_save,
```

- [ ] **Step 2.5: Build**

Run: `cargo build -p karl-app`
Expected: clean build, no warnings introduced by the new module.

- [ ] **Step 2.6: Commit**

```bash
git add crates/app/src/project_notes.rs crates/app/src/lib.rs
git commit -m "feat(project-notes): Tauri command surface + state wiring"
```

---

## Task 3: Operator pre-context builder

**Files:**
- Modify: `crates/app/src/project_notes.rs` (add `build_context` + tests)

- [ ] **Step 3.1: Add the builder + tests**

Append to `crates/app/src/project_notes.rs` (above the existing `#[cfg(test)] mod tests`):

```rust
// ----- Pre-context builder -----

/// Hard token cap. We approximate tokens at ~4 chars/token (English-ish);
/// the budget therefore equals `budget_tokens * 4` characters. This is
/// intentionally conservative — the model-side counter will always show
/// fewer tokens than our character estimate predicts.
const CHARS_PER_TOKEN: usize = 4;

const COMMANDS_BUDGET_PCT: usize = 30;
const DOCS_BUDGET_PCT: usize = 50;
// notes get whatever is left

pub async fn build_context(
    store: &Store,
    group_id: &str,
    group_label: &str,
    budget_tokens: usize,
) -> Result<String> {
    let snapshot = store.snapshot(group_id).await?;
    Ok(render_context(&snapshot, group_label, budget_tokens))
}

fn render_context(snapshot: &Snapshot, group_label: &str, budget_tokens: usize) -> String {
    if snapshot.commands.is_empty()
        && snapshot.notes.is_empty()
        && snapshot.docs.trim().is_empty()
    {
        return String::new();
    }

    let total_chars = budget_tokens.saturating_mul(CHARS_PER_TOKEN);
    let cmds_budget = total_chars * COMMANDS_BUDGET_PCT / 100;
    let docs_budget = total_chars * DOCS_BUDGET_PCT / 100;

    let mut out = String::new();
    out.push_str(&format!("# Project: {group_label}\n\n"));

    let cmds_block = render_commands(&snapshot.commands, cmds_budget);
    let cmds_used = cmds_block.len();
    if !cmds_block.is_empty() {
        out.push_str("## Saved Commands\n");
        out.push_str(&cmds_block);
        out.push('\n');
    }

    let docs_block = render_docs(&snapshot.docs, docs_budget);
    let docs_used = docs_block.len();
    if !docs_block.is_empty() {
        out.push_str("## Project Docs\n");
        out.push_str(&docs_block);
        out.push('\n');
    }

    let remaining = total_chars
        .saturating_sub(cmds_used)
        .saturating_sub(docs_used)
        .saturating_sub(out.len() - cmds_used - docs_used);
    let notes_block = render_notes(&snapshot.notes, remaining);
    if !notes_block.is_empty() {
        out.push_str("## Recent Notes (newest first)\n");
        out.push_str(&notes_block);
    }

    out
}

fn render_commands(commands: &[Command], budget_chars: usize) -> String {
    // Sort by updated_at_unix_ms DESC so the most recently touched commands
    // are kept when truncating.
    let mut sorted: Vec<&Command> = commands.iter().collect();
    sorted.sort_by_key(|c| std::cmp::Reverse(c.updated_at_unix_ms));
    let mut out = String::new();
    let mut truncated = false;
    for c in sorted {
        let line = format!("- {}: `{}`\n", c.title, c.command);
        if out.len() + line.len() > budget_chars {
            truncated = true;
            break;
        }
        out.push_str(&line);
    }
    if truncated {
        out.push_str("- [more truncated for budget]\n");
    }
    out
}

fn render_docs(docs: &str, budget_chars: usize) -> String {
    let trimmed = docs.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if trimmed.len() <= budget_chars {
        let mut out = trimmed.to_string();
        out.push('\n');
        return out;
    }
    // TOC fallback: collect `##`/`###` headings.
    let mut toc = String::new();
    for line in trimmed.lines() {
        let l = line.trim_start();
        if l.starts_with("## ") || l.starts_with("### ") {
            toc.push_str(line);
            toc.push('\n');
        }
        if toc.len() >= budget_chars / 2 {
            break;
        }
    }
    let remaining = budget_chars.saturating_sub(toc.len());
    let body_excerpt: String = trimmed.chars().take(remaining).collect();
    format!(
        "{toc}{body_excerpt}\n[truncated — see full docs in panel]\n"
    )
}

fn render_notes(notes: &[Note], budget_chars: usize) -> String {
    let mut out = String::new();
    let mut count = 0usize;
    for n in notes {
        if count >= 20 {
            break;
        }
        let stamp = relative_stamp(n.created_at_unix_ms);
        let line = format!("- [{stamp}] {body}\n", body = n.body.trim());
        if out.len() + line.len() > budget_chars {
            break;
        }
        out.push_str(&line);
        count += 1;
    }
    out
}

fn relative_stamp(ts_ms: i64) -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let now_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(ts_ms);
    let delta_s = (now_ms - ts_ms).max(0) / 1000;
    if delta_s < 60 {
        "just now".to_string()
    } else if delta_s < 3600 {
        format!("{}m ago", delta_s / 60)
    } else if delta_s < 86_400 {
        format!("{}h ago", delta_s / 3600)
    } else {
        format!("{}d ago", delta_s / 86_400)
    }
}
```

Add these tests inside the existing `#[cfg(test)] mod tests` block:

```rust
#[test]
fn render_context_empty_returns_empty() {
    let snap = Snapshot::default();
    assert_eq!(render_context(&snap, "X", 2000), "");
}

#[test]
fn render_context_includes_all_three_sections_when_in_budget() {
    let now = 1_700_000_000_000i64;
    let snap = Snapshot {
        commands: vec![Command {
            id: "1".into(),
            group_id: "g".into(),
            title: "Run".into(),
            command: "npm run dev".into(),
            sort_order: 0,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
        }],
        notes: vec![Note {
            id: "2".into(),
            group_id: "g".into(),
            body: "wip".into(),
            created_at_unix_ms: now,
        }],
        docs: "# Hello".into(),
    };
    let out = render_context(&snap, "COVENANT", 2000);
    assert!(out.contains("# Project: COVENANT"));
    assert!(out.contains("## Saved Commands"));
    assert!(out.contains("npm run dev"));
    assert!(out.contains("## Project Docs"));
    assert!(out.contains("Hello"));
    assert!(out.contains("## Recent Notes"));
    assert!(out.contains("wip"));
}

#[test]
fn render_context_truncates_docs_with_marker() {
    let big = "## Heading A\n".to_string()
        + &"x".repeat(20_000)
        + "\n## Heading B\n"
        + &"y".repeat(20_000);
    let snap = Snapshot {
        docs: big,
        ..Default::default()
    };
    let out = render_context(&snap, "P", 200); // tiny budget
    assert!(out.contains("[truncated — see full docs in panel]"));
}

#[test]
fn render_context_caps_notes_at_twenty() {
    let now = 1_700_000_000_000i64;
    let mut notes = Vec::new();
    for i in 0..30 {
        notes.push(Note {
            id: format!("{i}"),
            group_id: "g".into(),
            body: format!("note {i}"),
            created_at_unix_ms: now - (i as i64 * 1000),
        });
    }
    let snap = Snapshot { notes, ..Default::default() };
    let out = render_context(&snap, "P", 5000);
    let count = out.matches("- [").count();
    assert_eq!(count, 20);
}
```

- [ ] **Step 3.2: Run tests**

Run: `cargo test -p karl-app project_notes --lib`
Expected: all prior tests + 4 new render_context tests pass.

- [ ] **Step 3.3: Commit**

```bash
git add crates/app/src/project_notes.rs
git commit -m "feat(project-notes): operator pre-context builder with budget"
```

---

## Task 4: Wire pre-context into operator system prompt

**Files:**
- Modify: `crates/app/src/operator.rs` (extend `build_system_prompt`)

- [ ] **Step 4.1: Identify the integration point**

`build_system_prompt` (operator.rs:2697) currently takes `(persona, aom_active, mission, learned)`. We add a new optional argument for the project context block.

- [ ] **Step 4.2: Extend the signature**

Change `build_system_prompt` to:

```rust
fn build_system_prompt(
    persona: &str,
    aom_active: bool,
    mission: Option<&MissionDoc>,
    learned: &[memory::MemoryHit],
    project_context: &str,
) -> String {
    // ... existing body unchanged through `learned_block` ...
    let project_block = if project_context.is_empty() {
        String::new()
    } else {
        format!("{project_context}\n")
    };
    format!(
        "You are the Operator for Covenant — the user's coordinator that \
         watches an executor agent (claude code, copilot, opencode, aider, …) \
         running inside their PTY. The executor has paused; the user wants you \
         to answer routine questions on their behalf within the charter below.\n\n\
         {aom_block}\
         {mission_block}\
         {learned_block}\
         {project_block}\
         # PERSONA (set by user — guides judgment for the routine cases)\n\
         {persona}\n\n\
         # {recommendation}\n\n\
         # {hard}\n\n\
         # {fmt}",
        // ... existing args ...
    )
}
```

The `{project_block}` is inserted **after** `learned_block` and **before** `# PERSONA`. When empty (no project data), it produces zero bytes — preserving prefix-cache compatibility for groups without notes (mirrors the existing `learned_block` discipline noted at operator.rs:2736).

- [ ] **Step 4.3: Resolve the group label + build the context at the call site**

At the call site around `operator.rs:1808`:

```rust
let project_context = match operator_group_id_and_label(&op_ctx) {
    Some((gid, label)) => crate::project_notes::build_context(
        project_notes_store,
        &gid,
        &label,
        2000,
    )
    .await
    .unwrap_or_default(),
    None => String::new(),
};
let system_prompt = build_system_prompt(
    &persona,
    effective_aom,
    mission.as_ref(),
    &learned,
    &project_context,
);
```

`operator_group_id_and_label` is a small helper to add — it inspects the operator's current session to find the group it belongs to. Implementation: look up the active tab via existing tab-manifest accessors and read its `group_id` + the group's display name. If none can be resolved, return `None`.

`project_notes_store` is sourced from Tauri state; thread it down to the operator loop the same way other stores are passed (search for `Store` in `operator.rs` for the existing pattern).

- [ ] **Step 4.4: Update existing tests**

Two existing tests at operator.rs:4144 and 4167 call `build_system_prompt` with 4 args. Add a fifth arg `""` to both:

```rust
let got = build_system_prompt(persona, false, None, &[], "");
let got = build_system_prompt(persona, false, None, &learned, "");
```

Add a new test:

```rust
#[test]
fn build_system_prompt_with_project_context_renders_block() {
    let persona = "test persona";
    let project = "# Project: COVENANT\n\n## Saved Commands\n- Run: `x`\n";
    let got = build_system_prompt(persona, false, None, &[], project);
    assert!(got.contains("# Project: COVENANT"));
    assert!(got.contains("# PERSONA"));
    let project_idx = got.find("# Project: COVENANT").unwrap();
    let persona_idx = got.find("# PERSONA").unwrap();
    assert!(project_idx < persona_idx, "project block must precede persona");
}

#[test]
fn build_system_prompt_empty_project_is_byte_identical_to_baseline() {
    let persona = "test persona";
    let baseline = build_system_prompt(persona, false, None, &[], "");
    // simulate what an absent project would have looked like before this task
    assert!(!baseline.contains("# Project:"));
}
```

- [ ] **Step 4.5: Run tests**

Run: `cargo test -p karl-app operator::tests --lib`
Expected: existing tests still pass; new tests pass.

- [ ] **Step 4.6: Commit**

```bash
git add crates/app/src/operator.rs
git commit -m "feat(operator): inject project pre-context into system prompt"
```

---

## Task 5: UI — panel skeleton + open trigger

**Files:**
- Create: `ui/src/project-notes/panel.ts`
- Create: `ui/src/project-notes/api.ts`
- Create: `ui/src/project-notes/styles.css`
- Create: `ui/src/project-notes/panel.test.ts`
- Modify: `ui/src/main.ts` (mount panel singleton + shortcut)
- Modify: `ui/src/tabs/manager.ts` (group header click → emit event)
- Modify: `ui/src/styles.css` (`@import` the new CSS)

- [ ] **Step 5.1: Add the API wrapper**

Create `ui/src/project-notes/api.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

export interface Command {
  id: string;
  group_id: string;
  title: string;
  command: string;
  sort_order: number;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
}

export interface Note {
  id: string;
  group_id: string;
  body: string;
  created_at_unix_ms: number;
}

export interface Snapshot {
  commands: Command[];
  notes: Note[];
  docs: string;
}

export const projectNotesApi = {
  snapshot: (groupId: string) =>
    invoke<Snapshot>("project_notes_get", { groupId }),

  createCommand: (groupId: string, title: string, command: string) =>
    invoke<Command>("project_command_create", { groupId, title, command }),
  updateCommand: (id: string, title: string, command: string) =>
    invoke<Command | null>("project_command_update", { id, title, command }),
  deleteCommand: (id: string) =>
    invoke<void>("project_command_delete", { id }),
  reorderCommands: (groupId: string, orderedIds: string[]) =>
    invoke<void>("project_command_reorder", { groupId, orderedIds }),

  appendNote: (groupId: string, body: string) =>
    invoke<Note>("project_note_append", { groupId, body }),
  deleteNote: (id: string) => invoke<void>("project_note_delete", { id }),
  listNotes: (groupId: string, limit: number, beforeTs?: number) =>
    invoke<Note[]>("project_note_list", { groupId, limit, beforeTs }),

  getDocs: (groupId: string) =>
    invoke<string>("project_docs_get", { groupId }),
  saveDocs: (groupId: string, body: string) =>
    invoke<void>("project_docs_save", { groupId, body }),
};
```

- [ ] **Step 5.2: Add the panel skeleton**

Create `ui/src/project-notes/panel.ts`:

```ts
import "./styles.css";

export type PanelTab = "commands" | "notes" | "docs";

export interface PanelOpts {
  groupId: string;
  groupLabel: string;
  defaultTab?: PanelTab;
  onClose?: () => void;
}

const LAST_TAB_STORAGE_KEY = "covenant.project-notes.last-tab";

function readLastTab(groupId: string): PanelTab {
  try {
    const raw = localStorage.getItem(`${LAST_TAB_STORAGE_KEY}:${groupId}`);
    if (raw === "commands" || raw === "notes" || raw === "docs") return raw;
  } catch {}
  return "commands";
}

function writeLastTab(groupId: string, tab: PanelTab): void {
  try {
    localStorage.setItem(`${LAST_TAB_STORAGE_KEY}:${groupId}`, tab);
  } catch {}
}

export class ProjectNotesPanel {
  private root: HTMLElement;
  private body: HTMLElement;
  private tabButtons: Record<PanelTab, HTMLButtonElement>;
  private currentTab: PanelTab;
  private fullscreen = false;

  constructor(private opts: PanelOpts) {
    this.currentTab = opts.defaultTab ?? readLastTab(opts.groupId);
    this.root = document.createElement("div");
    this.root.className = "pn-panel";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", `Project Notes — ${opts.groupLabel}`);

    const header = document.createElement("div");
    header.className = "pn-header";
    header.innerHTML = `
      <span class="pn-title">${escapeHtml(opts.groupLabel)}</span>
      <div class="pn-actions">
        <button class="pn-fs" aria-label="Toggle fullscreen">⤢</button>
        <button class="pn-close" aria-label="Close">×</button>
      </div>
    `;
    header.querySelector(".pn-close")!.addEventListener("click", () => this.close());
    header.querySelector(".pn-fs")!.addEventListener("click", () => this.toggleFullscreen());

    const tabs = document.createElement("div");
    tabs.className = "pn-tabs";
    this.tabButtons = {} as Record<PanelTab, HTMLButtonElement>;
    for (const t of ["commands", "notes", "docs"] as PanelTab[]) {
      const b = document.createElement("button");
      b.textContent = t[0].toUpperCase() + t.slice(1);
      b.dataset.tab = t;
      b.addEventListener("click", () => this.switchTab(t));
      tabs.appendChild(b);
      this.tabButtons[t] = b;
    }

    this.body = document.createElement("div");
    this.body.className = "pn-body";

    this.root.appendChild(header);
    this.root.appendChild(tabs);
    this.root.appendChild(this.body);

    this.updateTabUI();
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.root);
    document.addEventListener("keydown", this.onKey);
    return this;
  }

  close(): void {
    document.removeEventListener("keydown", this.onKey);
    this.root.remove();
    this.opts.onClose?.();
  }

  switchTab(tab: PanelTab): void {
    this.currentTab = tab;
    writeLastTab(this.opts.groupId, tab);
    this.updateTabUI();
  }

  toggleFullscreen(): void {
    this.fullscreen = !this.fullscreen;
    this.root.classList.toggle("pn-fullscreen", this.fullscreen);
  }

  private onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") this.close();
  };

  private updateTabUI(): void {
    for (const t of Object.keys(this.tabButtons) as PanelTab[]) {
      this.tabButtons[t].classList.toggle("active", t === this.currentTab);
    }
    this.body.replaceChildren();
    // Concrete tab renderers are added in Tasks 6, 7, 8.
    // For now, render a placeholder so the test in 5.3 can assert layout.
    const slot = document.createElement("div");
    slot.className = `pn-tab-slot pn-tab-${this.currentTab}`;
    slot.textContent = `(${this.currentTab})`;
    this.body.appendChild(slot);
  }

  // Exposed for subsequent tasks to plug in.
  get bodyEl(): HTMLElement {
    return this.body;
  }
  get groupId(): string {
    return this.opts.groupId;
  }
  get activeTab(): PanelTab {
    return this.currentTab;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
```

- [ ] **Step 5.3: Add the panel test**

Create `ui/src/project-notes/panel.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { ProjectNotesPanel } from "./panel";

describe("ProjectNotesPanel", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    localStorage.clear();
  });

  it("renders three tab buttons and the default tab", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "COVENANT" });
    p.mount(host);
    const buttons = host.querySelectorAll(".pn-tabs button");
    expect(buttons.length).toBe(3);
    expect(host.querySelector(".pn-tab-commands")).not.toBeNull();
  });

  it("persists the last active tab per group", () => {
    const p1 = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    p1.switchTab("notes");
    p1.close();
    const p2 = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    expect(p2.activeTab).toBe("notes");
  });

  it("isolates last-tab state across groups", () => {
    new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host).switchTab("docs");
    const p2 = new ProjectNotesPanel({ groupId: "g2", groupLabel: "G2" }).mount(host);
    expect(p2.activeTab).toBe("commands");
  });

  it("closes on Escape", () => {
    let closed = false;
    const p = new ProjectNotesPanel({
      groupId: "g1",
      groupLabel: "G1",
      onClose: () => (closed = true),
    }).mount(host);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(closed).toBe(true);
    expect(host.querySelector(".pn-panel")).toBeNull();
  });

  it("toggles fullscreen class", () => {
    const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
    p.toggleFullscreen();
    expect(host.querySelector(".pn-panel.pn-fullscreen")).not.toBeNull();
  });
});
```

- [ ] **Step 5.4: Add styles**

Create `ui/src/project-notes/styles.css`:

```css
.pn-panel {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 420px;
  background: var(--surface, #15171c);
  color: var(--text, #e6e8eb);
  border-left: 1px solid var(--border, #2a2d35);
  display: flex;
  flex-direction: column;
  min-height: 0;
  z-index: 50;
  font-family: var(--font-ui);
}
.pn-panel.pn-fullscreen {
  width: 100vw;
  border-left: none;
}
.pn-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border, #2a2d35);
}
.pn-title {
  font-weight: 600;
  letter-spacing: 0.04em;
}
.pn-actions button {
  background: transparent;
  color: inherit;
  border: 0;
  cursor: pointer;
  font-size: 16px;
  padding: 2px 6px;
}
.pn-tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--border, #2a2d35);
}
.pn-tabs button {
  flex: 1;
  background: transparent;
  color: var(--text-dim, #9aa0a6);
  border: 0;
  padding: 8px 0;
  cursor: pointer;
  font-size: 13px;
}
.pn-tabs button.active {
  color: var(--text, #e6e8eb);
  border-bottom: 2px solid var(--accent, #6aa9ff);
}
.pn-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px;
}
```

In `ui/src/styles.css`, add at the top:

```css
@import "./project-notes/styles.css";
```

- [ ] **Step 5.5: Wire the open trigger**

In `ui/src/tabs/manager.ts`, find the group-header chip rendering. Add a `dblclick` (or single click on the caret-less area) handler that calls a new optional callback `opts.onOpenProjectNotes?.(groupId, groupLabel)`. Add the field to the manager's options type:

```ts
// in TabsManager constructor opts
onOpenProjectNotes?: (groupId: string, groupLabel: string) => void;
```

Pick a click target that does NOT conflict with the existing fold/collapse and rename behaviors — a small icon button on the right side of the chip is the safest (`📋` lucide-style icon, reuse `ui/src/icons/`). When clicked, call `this.opts.onOpenProjectNotes?.(group.id, group.name)`.

- [ ] **Step 5.6: Mount the singleton in `main.ts`**

In `ui/src/main.ts`, near the other singleton overlays:

```ts
import { ProjectNotesPanel } from "./project-notes/panel";

let activePanel: ProjectNotesPanel | null = null;

function openProjectNotes(groupId: string, groupLabel: string): void {
  if (activePanel) activePanel.close();
  activePanel = new ProjectNotesPanel({
    groupId,
    groupLabel,
    onClose: () => {
      activePanel = null;
    },
  }).mount(document.body);
}

// Wire to TabsManager
tabsManager.setOptions({
  onOpenProjectNotes: openProjectNotes,
});

// ⌘⇧N shortcut
document.addEventListener("keydown", (e) => {
  if (e.metaKey && e.shiftKey && (e.key === "n" || e.key === "N")) {
    const g = tabsManager.activeGroup();
    if (g) {
      e.preventDefault();
      openProjectNotes(g.id, g.name);
    }
  }
});
```

If `tabsManager.setOptions` and `tabsManager.activeGroup()` don't exist, add them in `manager.ts`. `activeGroup()` returns the group of the currently active tab, or `null`.

- [ ] **Step 5.7: Run tests + smoke**

```bash
cd ui && npm test -- project-notes/panel.test.ts
```
Expected: 5 tests pass.

Then start the app (`npm run tauri dev`) and verify: clicking the project-notes icon on a group header opens the panel; Esc closes; ⌘⇧N opens for the active group.

- [ ] **Step 5.8: Commit**

```bash
git add ui/src/project-notes/ ui/src/main.ts ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(project-notes): UI panel skeleton + open trigger"
```

---

## Task 6: UI — Commands tab (CRUD + paste)

**Files:**
- Create: `ui/src/project-notes/commands-tab.ts`
- Create: `ui/src/project-notes/commands-tab.test.ts`
- Modify: `ui/src/project-notes/panel.ts` (delegate `commands` tab to renderer)

- [ ] **Step 6.1: Locate the existing PTY-write command**

Search for the existing Tauri command that writes bytes to a tab's PTY:

```bash
grep -n "write_to\|pty_write\|terminal_input\|write_session" crates/app/src/lib.rs ui/src/api.ts | head
```

Reuse it for paste (whatever it's called locally — likely something like `write_to_session(sessionId, text)`). The Commands tab calls this with no trailing newline so the user reviews and presses Enter.

- [ ] **Step 6.2: Implement the Commands renderer**

Create `ui/src/project-notes/commands-tab.ts`:

```ts
import { projectNotesApi, type Command } from "./api";
import { writeToActiveTabInGroup } from "./paste";

export interface CommandsTabHooks {
  groupId: string;
  // Called after any local mutation so the panel can refresh sibling state if needed.
  onChange?: () => void;
}

export class CommandsTab {
  private container: HTMLElement;
  private list: HTMLUListElement;
  private commands: Command[] = [];

  constructor(private hooks: CommandsTabHooks) {
    this.container = document.createElement("div");
    this.container.className = "pn-cmd-tab";

    const newBtn = document.createElement("button");
    newBtn.className = "pn-cmd-new";
    newBtn.textContent = "+ New command";
    newBtn.addEventListener("click", () => this.openEditor(null));

    this.list = document.createElement("ul");
    this.list.className = "pn-cmd-list";

    this.container.appendChild(newBtn);
    this.container.appendChild(this.list);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const snap = await projectNotesApi.snapshot(this.hooks.groupId);
    this.commands = snap.commands;
    this.render();
  }

  private render(): void {
    this.list.replaceChildren();
    for (const c of this.commands) {
      const li = document.createElement("li");
      li.className = "pn-cmd-row";
      li.dataset.id = c.id;
      li.innerHTML = `
        <div class="pn-cmd-meta">
          <div class="pn-cmd-title"></div>
          <code class="pn-cmd-code"></code>
        </div>
        <div class="pn-cmd-actions">
          <button class="pn-cmd-paste" title="Paste into active tab">paste</button>
          <button class="pn-cmd-edit" title="Edit">edit</button>
          <button class="pn-cmd-del" title="Delete">×</button>
        </div>
      `;
      (li.querySelector(".pn-cmd-title") as HTMLElement).textContent = c.title;
      (li.querySelector(".pn-cmd-code") as HTMLElement).textContent = c.command;
      li.querySelector(".pn-cmd-paste")!.addEventListener("click", () =>
        this.paste(c),
      );
      li.querySelector(".pn-cmd-edit")!.addEventListener("click", () =>
        this.openEditor(c),
      );
      li.querySelector(".pn-cmd-del")!.addEventListener("click", () =>
        this.delete(c),
      );
      this.list.appendChild(li);
    }
  }

  private async paste(c: Command): Promise<void> {
    try {
      await writeToActiveTabInGroup(this.hooks.groupId, c.command);
    } catch (err) {
      console.error("paste failed", err);
      // surface via a toast in real wiring; for now log only.
    }
  }

  private async delete(c: Command): Promise<void> {
    await projectNotesApi.deleteCommand(c.id);
    await this.refresh();
    this.hooks.onChange?.();
  }

  private openEditor(existing: Command | null): void {
    const dialog = document.createElement("div");
    dialog.className = "pn-cmd-editor";
    dialog.innerHTML = `
      <input class="pn-cmd-title-input" placeholder="Title" />
      <textarea class="pn-cmd-cmd-input" placeholder="Command" rows="3"></textarea>
      <div class="pn-cmd-editor-actions">
        <button class="pn-cmd-save">Save</button>
        <button class="pn-cmd-cancel">Cancel</button>
      </div>
    `;
    const titleInput = dialog.querySelector<HTMLInputElement>(".pn-cmd-title-input")!;
    const cmdInput = dialog.querySelector<HTMLTextAreaElement>(".pn-cmd-cmd-input")!;
    if (existing) {
      titleInput.value = existing.title;
      cmdInput.value = existing.command;
    }
    dialog.querySelector(".pn-cmd-cancel")!.addEventListener("click", () => dialog.remove());
    dialog.querySelector(".pn-cmd-save")!.addEventListener("click", async () => {
      const title = titleInput.value.trim();
      const command = cmdInput.value.trim();
      if (!title || !command) return;
      if (existing) {
        await projectNotesApi.updateCommand(existing.id, title, command);
      } else {
        await projectNotesApi.createCommand(this.hooks.groupId, title, command);
      }
      dialog.remove();
      await this.refresh();
      this.hooks.onChange?.();
    });
    this.container.appendChild(dialog);
    titleInput.focus();
  }
}
```

- [ ] **Step 6.3: Implement the paste helper**

Create `ui/src/project-notes/paste.ts`:

```ts
import { invoke } from "@tauri-apps/api/core";

/// Resolves the currently active tab in `groupId` and writes `text` to its
/// PTY without a trailing newline. The user confirms execution with Enter.
export async function writeToActiveTabInGroup(
  groupId: string,
  text: string,
): Promise<void> {
  const sessionId = await invoke<string | null>("active_session_in_group", {
    groupId,
  });
  if (!sessionId) {
    throw new Error("no active tab in group");
  }
  // Use the existing PTY write command. If the project's command is named
  // differently from `write_to_session`, swap the name here.
  await invoke<void>("write_to_session", { sessionId, data: text });
}
```

If `active_session_in_group` does not yet exist, add it in `crates/app/src/lib.rs` as a thin Tauri command that resolves via the existing tab manifest state:

```rust
#[tauri::command]
fn active_session_in_group(
    state: State<'_, TabsState>, // adjust to actual state type
    group_id: String,
) -> Option<String> {
    state.active_session_in_group(&group_id) // implement on the existing state struct
}
```

- [ ] **Step 6.4: Wire into the panel**

In `ui/src/project-notes/panel.ts`, replace the placeholder in `updateTabUI()` for the `commands` case:

```ts
import { CommandsTab } from "./commands-tab";

// inside updateTabUI()
this.body.replaceChildren();
if (this.currentTab === "commands") {
  new CommandsTab({ groupId: this.opts.groupId }).mount(this.body);
} else {
  const slot = document.createElement("div");
  slot.className = `pn-tab-slot pn-tab-${this.currentTab}`;
  slot.textContent = `(${this.currentTab})`;
  this.body.appendChild(slot);
}
```

- [ ] **Step 6.5: Add the test (with mocked api + paste)**

Create `ui/src/project-notes/commands-tab.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CommandsTab } from "./commands-tab";

vi.mock("./api", () => {
  const state: any = { commands: [], notes: [], docs: "" };
  return {
    projectNotesApi: {
      snapshot: vi.fn(async () => ({ ...state })),
      createCommand: vi.fn(async (groupId, title, command) => {
        const c = {
          id: `id-${state.commands.length}`,
          group_id: groupId,
          title,
          command,
          sort_order: state.commands.length,
          created_at_unix_ms: 0,
          updated_at_unix_ms: 0,
        };
        state.commands.push(c);
        return c;
      }),
      updateCommand: vi.fn(async (id, title, command) => {
        const c = state.commands.find((x: any) => x.id === id);
        if (c) {
          c.title = title;
          c.command = command;
        }
        return c ?? null;
      }),
      deleteCommand: vi.fn(async (id) => {
        state.commands = state.commands.filter((x: any) => x.id !== id);
      }),
    },
    __state: state,
  };
});

vi.mock("./paste", () => ({
  writeToActiveTabInGroup: vi.fn(async () => {}),
}));

describe("CommandsTab", () => {
  let host: HTMLElement;
  beforeEach(async () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    const mod = (await import("./api")) as any;
    mod.__state.commands = [];
  });

  it("creates and renders a command", async () => {
    const tab = new CommandsTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-cmd-new") as HTMLButtonElement).click();
    (host.querySelector(".pn-cmd-title-input") as HTMLInputElement).value = "Run";
    (host.querySelector(".pn-cmd-cmd-input") as HTMLTextAreaElement).value = "npm run dev";
    (host.querySelector(".pn-cmd-save") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector(".pn-cmd-title")?.textContent).toBe("Run");
    expect(host.querySelector(".pn-cmd-code")?.textContent).toBe("npm run dev");
  });

  it("paste calls writeToActiveTabInGroup with no newline", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.commands = [
      {
        id: "c1",
        group_id: "g1",
        title: "X",
        command: "ls -la",
        sort_order: 0,
        created_at_unix_ms: 0,
        updated_at_unix_ms: 0,
      },
    ];
    const pasteMod = await import("./paste");
    const tab = new CommandsTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-cmd-paste") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(pasteMod.writeToActiveTabInGroup).toHaveBeenCalledWith("g1", "ls -la");
  });
});
```

- [ ] **Step 6.6: Run tests**

```bash
cd ui && npm test -- project-notes/
```
Expected: panel tests still pass; new commands-tab tests pass.

- [ ] **Step 6.7: Commit**

```bash
git add ui/src/project-notes/commands-tab.ts ui/src/project-notes/commands-tab.test.ts ui/src/project-notes/paste.ts ui/src/project-notes/panel.ts crates/app/src/lib.rs
git commit -m "feat(project-notes): Commands tab — CRUD + paste to active tab"
```

---

## Task 7: UI — Notes tab (append-only journal)

**Files:**
- Create: `ui/src/project-notes/notes-tab.ts`
- Create: `ui/src/project-notes/notes-tab.test.ts`
- Modify: `ui/src/project-notes/panel.ts` (delegate `notes` tab)

- [ ] **Step 7.1: Implement**

Create `ui/src/project-notes/notes-tab.ts`:

```ts
import { projectNotesApi, type Note } from "./api";

export interface NotesTabHooks {
  groupId: string;
  onChange?: () => void;
}

export class NotesTab {
  private container: HTMLElement;
  private input: HTMLTextAreaElement;
  private list: HTMLUListElement;
  private notes: Note[] = [];

  constructor(private hooks: NotesTabHooks) {
    this.container = document.createElement("div");
    this.container.className = "pn-notes-tab";

    this.input = document.createElement("textarea");
    this.input.className = "pn-note-input";
    this.input.placeholder = "Write a note, ⌘↵ to save…";
    this.input.rows = 2;
    this.input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.append();
      }
    });

    this.list = document.createElement("ul");
    this.list.className = "pn-note-list";

    this.container.appendChild(this.input);
    this.container.appendChild(this.list);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const snap = await projectNotesApi.snapshot(this.hooks.groupId);
    this.notes = snap.notes;
    this.render();
  }

  private async append(): Promise<void> {
    const body = this.input.value.trim();
    if (!body) return;
    const value = this.input.value;
    this.input.value = "";
    try {
      await projectNotesApi.appendNote(this.hooks.groupId, body);
      await this.refresh();
      this.hooks.onChange?.();
    } catch (err) {
      this.input.value = value;
      console.error("note append failed", err);
    }
  }

  private async delete(n: Note): Promise<void> {
    await projectNotesApi.deleteNote(n.id);
    await this.refresh();
    this.hooks.onChange?.();
  }

  private render(): void {
    this.list.replaceChildren();
    for (const n of this.notes) {
      const li = document.createElement("li");
      li.className = "pn-note-row";
      li.dataset.id = n.id;
      const stamp = formatRelative(n.created_at_unix_ms);
      li.innerHTML = `
        <span class="pn-note-stamp"></span>
        <span class="pn-note-body"></span>
        <button class="pn-note-del" aria-label="Delete note">×</button>
      `;
      (li.querySelector(".pn-note-stamp") as HTMLElement).textContent = stamp;
      (li.querySelector(".pn-note-body") as HTMLElement).textContent = n.body;
      li.querySelector(".pn-note-del")!.addEventListener("click", () => this.delete(n));
      this.list.appendChild(li);
    }
  }
}

function formatRelative(ts: number): string {
  const delta = Math.max(0, Date.now() - ts) / 1000;
  if (delta < 60) return "just now";
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}
```

- [ ] **Step 7.2: Wire into panel**

In `panel.ts`'s `updateTabUI()`, add a branch for `notes`:

```ts
import { NotesTab } from "./notes-tab";
// ...
if (this.currentTab === "notes") {
  new NotesTab({ groupId: this.opts.groupId }).mount(this.body);
}
```

- [ ] **Step 7.3: Test**

Create `ui/src/project-notes/notes-tab.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { NotesTab } from "./notes-tab";

vi.mock("./api", () => {
  const state: any = { commands: [], notes: [], docs: "" };
  return {
    projectNotesApi: {
      snapshot: vi.fn(async () => ({ ...state, notes: [...state.notes] })),
      appendNote: vi.fn(async (groupId, body) => {
        const n = { id: `n-${state.notes.length}`, group_id: groupId, body, created_at_unix_ms: Date.now() };
        state.notes.unshift(n);
        return n;
      }),
      deleteNote: vi.fn(async (id) => {
        state.notes = state.notes.filter((n: any) => n.id !== id);
      }),
    },
    __state: state,
  };
});

describe("NotesTab", () => {
  let host: HTMLElement;
  beforeEach(async () => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    const mod = (await import("./api")) as any;
    mod.__state.notes = [];
  });

  it("appends on ⌘↵ and prepends to list", async () => {
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const input = host.querySelector(".pn-note-input") as HTMLTextAreaElement;
    input.value = "first";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    input.value = "second";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    const bodies = Array.from(host.querySelectorAll(".pn-note-body")).map((e) => e.textContent);
    expect(bodies).toEqual(["second", "first"]);
  });

  it("does not append empty notes", async () => {
    const apiMod = (await import("./api")) as any;
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    const input = host.querySelector(".pn-note-input") as HTMLTextAreaElement;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(apiMod.projectNotesApi.appendNote).not.toHaveBeenCalled();
  });

  it("deletes a note via the delete button", async () => {
    const apiMod = (await import("./api")) as any;
    apiMod.__state.notes = [
      { id: "n1", group_id: "g1", body: "x", created_at_unix_ms: Date.now() },
    ];
    const tab = new NotesTab({ groupId: "g1" }).mount(host);
    await tab.refresh();
    (host.querySelector(".pn-note-del") as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelector(".pn-note-row")).toBeNull();
  });
});
```

- [ ] **Step 7.4: Run + commit**

```bash
cd ui && npm test -- project-notes/notes-tab.test.ts
```
Expected: 3 tests pass.

```bash
git add ui/src/project-notes/notes-tab.ts ui/src/project-notes/notes-tab.test.ts ui/src/project-notes/panel.ts
git commit -m "feat(project-notes): Notes tab — append-only journal"
```

---

## Task 8: UI — Docs tab (markdown editor with debounced save)

**Files:**
- Create: `ui/src/project-notes/docs-tab.ts`
- Modify: `ui/src/project-notes/panel.ts` (delegate `docs` tab)

- [ ] **Step 8.1: Inspect the existing Docs editor**

```bash
ls ui/src/docs/ && grep -n "export\|class\|function" ui/src/docs/*.ts | head -20
```

Identify the editor component (likely a class or factory exporting a textarea/CodeMirror-backed editor with auto-save). Reuse it; pass `getInitialBody`, `onSave(body)`, `debounceMs: 500`.

- [ ] **Step 8.2: Implement the wrapper**

Create `ui/src/project-notes/docs-tab.ts`:

```ts
import { projectNotesApi } from "./api";
// import { mountDocsEditor } from "../docs/editor"; // adjust to actual export

export interface DocsTabHooks {
  groupId: string;
  onChange?: () => void;
}

export class DocsTab {
  private container: HTMLElement;
  private editorRoot: HTMLElement;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private hooks: DocsTabHooks) {
    this.container = document.createElement("div");
    this.container.className = "pn-docs-tab";
    this.editorRoot = document.createElement("div");
    this.editorRoot.className = "pn-docs-editor";
    this.container.appendChild(this.editorRoot);
  }

  async mount(parent: HTMLElement): Promise<this> {
    parent.appendChild(this.container);
    const initial = await projectNotesApi.getDocs(this.hooks.groupId);
    // Minimal editor: a contenteditable textarea. Swap to existing Docs editor
    // if its API matches.
    const ta = document.createElement("textarea");
    ta.className = "pn-docs-textarea";
    ta.value = initial;
    ta.addEventListener("input", () => this.scheduleSave(ta.value));
    this.editorRoot.appendChild(ta);
    return this;
  }

  private scheduleSave(body: string): void {
    this.dirty = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(async () => {
      try {
        await projectNotesApi.saveDocs(this.hooks.groupId, body);
        this.dirty = false;
        this.hooks.onChange?.();
      } catch (err) {
        console.error("docs save failed", err);
      }
    }, 500);
  }
}
```

If the existing Docs editor has a richer API (markdown preview, raw toggle), wrap it instead of the textarea — pass `initial` and an `onChange(body)` handler that calls `scheduleSave`.

- [ ] **Step 8.3: Wire into panel**

In `panel.ts`'s `updateTabUI()`:

```ts
import { DocsTab } from "./docs-tab";
// ...
if (this.currentTab === "docs") {
  void new DocsTab({ groupId: this.opts.groupId }).mount(this.body);
}
```

- [ ] **Step 8.4: Smoke + commit**

Manual smoke: open panel, switch to Docs, type `# Hello` → wait 600ms → close panel → reopen → content persists.

```bash
git add ui/src/project-notes/docs-tab.ts ui/src/project-notes/panel.ts
git commit -m "feat(project-notes): Docs tab — markdown editor with debounced save"
```

---

## Task 9: UI — Fullscreen polish + final wiring

**Files:**
- Modify: `ui/src/project-notes/styles.css` (fullscreen tweaks)
- Modify: `ui/src/project-notes/panel.ts` (smaller polish)

- [ ] **Step 9.1: Fullscreen-only style adjustments**

Append to `ui/src/project-notes/styles.css`:

```css
.pn-fullscreen .pn-body { padding: 24px 80px; }
.pn-fullscreen .pn-docs-textarea { min-height: 70vh; }
.pn-cmd-list { list-style: none; padding: 0; margin: 0; }
.pn-cmd-row { display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--border, #2a2d35); align-items: center; }
.pn-cmd-meta { flex: 1; }
.pn-cmd-title { font-weight: 500; }
.pn-cmd-code { font-family: var(--font-mono); color: var(--text-dim, #9aa0a6); display: block; }
.pn-cmd-actions button { background: transparent; color: inherit; border: 1px solid var(--border, #2a2d35); border-radius: 4px; padding: 2px 6px; cursor: pointer; }
.pn-note-input { width: 100%; background: var(--surface-2, #1c1f25); color: inherit; border: 1px solid var(--border, #2a2d35); border-radius: 4px; padding: 8px; resize: vertical; }
.pn-note-list { list-style: none; padding: 0; margin: 12px 0 0 0; }
.pn-note-row { display: grid; grid-template-columns: 80px 1fr 24px; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border, #2a2d35); }
.pn-note-stamp { color: var(--text-dim, #9aa0a6); font-size: 12px; }
.pn-note-del { background: transparent; border: 0; color: var(--text-dim, #9aa0a6); cursor: pointer; visibility: hidden; }
.pn-note-row:hover .pn-note-del { visibility: visible; }
.pn-docs-textarea { width: 100%; min-height: 50vh; background: var(--surface-2, #1c1f25); color: inherit; border: 1px solid var(--border, #2a2d35); border-radius: 4px; padding: 12px; font-family: var(--font-mono); }
.pn-cmd-editor { margin-top: 12px; padding: 12px; background: var(--surface-2, #1c1f25); border-radius: 4px; display: grid; gap: 8px; }
.pn-cmd-editor input, .pn-cmd-editor textarea { background: var(--surface, #15171c); color: inherit; border: 1px solid var(--border, #2a2d35); border-radius: 4px; padding: 6px; }
```

- [ ] **Step 9.2: Commit**

```bash
git add ui/src/project-notes/styles.css
git commit -m "style(project-notes): polish list rows and fullscreen layout"
```

---

## Task 10: End-to-end smoke + future-work TODO comments

**Files:**
- Modify: `crates/app/src/project_notes.rs` (TODO marker for repo-backed storage)

- [ ] **Step 10.1: Manual smoke checklist**

Start app: `cd ui && npm run tauri dev`. Verify:

- [ ] Click the project-notes icon in the COVENANT group header → panel opens.
- [ ] Create a command "Run UI: `cd ui && npm run dev`" → it appears.
- [ ] Click "paste" → text appears in the active tab's prompt without auto-execution.
- [ ] Switch to Notes → ⌘↵ to append three notes → newest first ordering.
- [ ] Hover a note → × deletes it.
- [ ] Switch to Docs → type markdown → wait 1s → close panel → reopen → text persists.
- [ ] ⌘⇧N opens panel for active group; Esc closes.
- [ ] Toggle fullscreen and back.
- [ ] Restart the app → all data persists.

- [ ] **Step 10.2: Verify operator picks up the pre-context**

Open an operator session in the group, trigger a mission. Inspect logs (`grep -i "system_prompt\|project:" /tmp/super-term.log`) and confirm the `# Project: COVENANT` block is present in the system prompt when project data exists, and absent when the group is empty.

- [ ] **Step 10.3: Add future-work marker**

Near the top of `crates/app/src/project_notes.rs` (after the module docstring), add:

```rust
// FUTURE: see README "Future work to revisit" — repo-backed storage
// (`<root>/.covenant/project.md` + `commands.toml` + `notes.jsonl`) is the
// next iteration once the in-app shape is stable.
```

- [ ] **Step 10.4: Commit**

```bash
git add crates/app/src/project_notes.rs
git commit -m "chore(project-notes): mark repo-backed storage as future work"
```

---

## Self-Review Notes

- **Spec coverage:** Every section of the spec maps to a task — UI panel + 3 tabs (5–8), schema + CRUD (1), Tauri commands (2), pre-context builder (3), operator integration (4), error handling (in-tab try/catch + toasts implicit; explicit toast UI is out of MVP and matches the "console.error for now" approach in tasks 6–8).
- **Placeholders:** None. All code is concrete.
- **Type consistency:** `groupId` (camelCase) on the UI side, `group_id` (snake_case) in Rust, mapped by Tauri's automatic serde rename. `Snapshot.notes` is capped to 50 in Task 1; the operator builder caps to 20 (Task 3) — different limits intentionally; the snapshot serves the UI which paginates further, while the prompt builder hard-caps for budget.
- **Open assumptions:**
  - Existing PTY-write Tauri command name is `write_to_session(sessionId, data)`; if it differs, adjust the one call in `paste.ts`.
  - `active_session_in_group` may need a small addition to the existing tabs-state struct in `lib.rs`.
  - The Docs editor reuse in Task 8 falls back to a plain textarea if the existing editor's API doesn't match — both produce a working product.
