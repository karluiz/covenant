# Operator Threads Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each operator multiple separate ChatGPT-style conversation threads, each with its own message history and context window, while persona/XP/sentiment/world-model stay global.

**Architecture:** Additive grouping layer over the existing flat `teammate_messages` table. Add a `teammate_threads` table and a nullable `thread_id` column on messages. Storage/commands filter by thread; the UI gains a header dropdown to switch threads. Existing history migrates into one "General" thread per operator. Tasks and Activity remain global (Chat-only scope).

**Tech Stack:** Rust (rusqlite, tokio, tauri commands), TypeScript (xterm.js panel, Tauri IPC). Spec: `docs/superpowers/specs/2026-05-31-operator-threads-design.md`.

**Commit convention (user preference):** one commit per task (feature), not per TDD step. Each task ends with a single commit.

**Build/test commands:**
- Rust crate tests: `cargo test -p karl-app teammate`
- Rust compile check: `cargo check -p karl-app`
- Frontend typecheck: `cd ui && npx tsc --noEmit`

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `crates/app/src/teammate/types.rs` | `ThreadId` newtype, `TeammateThread` struct, `thread_id` on `TaskMessage` | Modify |
| `crates/app/src/storage.rs` | schema, idempotent migration, thread CRUD, thread-scoped message insert/list | Modify |
| `crates/app/src/teammate/commands.rs` | thread Tauri commands; `thread_id` plumbed through send/list | Modify |
| `crates/app/src/lib.rs` (or wherever `invoke_handler` registers commands) | register 4 new commands | Modify |
| `ui/src/api.ts` | `TeammateThread` interface + typed command wrappers; `thread_id` on `TeammateMessage`/send/list | Modify |
| `ui/src/teammate/panel.ts` | thread row + dropdown, `activeThreadId` state, thread-scoped rendering, trash rescope | Modify |

---

## Task 1: Thread types + schema + migration

**Files:**
- Modify: `crates/app/src/teammate/types.rs`
- Modify: `crates/app/src/storage.rs:43` (SCHEMA const), migration block near `:567`
- Test: `crates/app/src/storage.rs` (inline `#[cfg(test)]` module, follows existing pattern at `:3542`)

- [ ] **Step 1: Add `ThreadId` newtype + `TeammateThread` + `thread_id` field**

In `types.rs`, after the `ArtifactId` block (`:31`/`:41`):

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ThreadId(pub Ulid);

impl ThreadId {
    pub fn new() -> Self { Self(Ulid::new()) }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeammateThread {
    pub id: ThreadId,
    pub operator_id: crate::operator_registry::OperatorId,
    pub title: String,
    pub created_at_unix_ms: u64,
    pub last_message_at_unix_ms: u64,
    pub archived: bool,
}
```

Add `thread_id` to `TaskMessage` (`:183`), right after `task_id`:

```rust
    pub task_id: Option<TaskId>,
    /// The conversation thread this message belongs to. `None` only for
    /// legacy rows not yet backfilled; all new messages carry a thread.
    pub thread_id: Option<ThreadId>,
```

Re-export `ThreadId` + `TeammateThread` wherever `TaskMessage`/`MessageId` are re-exported (check the `pub use` in `crates/app/src/teammate/mod.rs`; add them to the same list).

- [ ] **Step 2: Add the schema table + index in the `SCHEMA` const**

In `storage.rs`, inside the `SCHEMA` string, immediately AFTER the `teammate_tasks` block (ends `:214`) and BEFORE `teammate_messages` (`:216`) — threads must exist before messages reference them:

```sql
CREATE TABLE IF NOT EXISTS teammate_threads (
    id                      TEXT PRIMARY KEY,
    operator_id             TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    title                   TEXT NOT NULL,
    created_at_unix_ms      INTEGER NOT NULL,
    last_message_at_unix_ms INTEGER NOT NULL,
    archived                INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_threads_operator
    ON teammate_threads(operator_id, last_message_at_unix_ms DESC);
```

Note: a fresh DB gets `thread_id` via the migration ALTER in Step 3 (do NOT add the column to the `teammate_messages` CREATE in SCHEMA — keep all `thread_id` provisioning in one place so fresh and upgraded DBs take the identical path).

- [ ] **Step 3: Add the idempotent migration (column + index + backfill)**

In `storage.rs`, append to the migration block (after the `sentiment` ALTER at `:579`, before `tracing::info!(... "storage opened")` at `:582`). Follow the existing `let _ = conn.execute(...)` idempotent pattern:

```rust
        // Operator threads: split the flat per-operator chat into separate
        // conversations. `thread_id` is NULL on legacy rows until backfilled
        // below. Fresh DBs also take this path (SCHEMA omits the column).
        let _ = conn.execute(
            "ALTER TABLE teammate_messages ADD COLUMN thread_id TEXT \
             REFERENCES teammate_threads(id) ON DELETE CASCADE",
            [],
        );
        let _ = conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_messages_thread \
             ON teammate_messages(thread_id, created_at_unix_ms)",
            [],
        );
        // Backfill: every operator with orphaned (thread_id IS NULL) messages
        // gets one "General" thread; all its orphaned messages move into it.
        // Idempotent — operators with no NULL-thread rows are untouched.
        {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let orphan_ops: Vec<String> = {
                let mut stmt = conn.prepare(
                    "SELECT DISTINCT operator_id FROM teammate_messages \
                     WHERE thread_id IS NULL",
                )?;
                let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for op in orphan_ops {
                let tid = ulid::Ulid::new().to_string();
                conn.execute(
                    "INSERT INTO teammate_threads \
                     (id, operator_id, title, created_at_unix_ms, last_message_at_unix_ms, archived) \
                     VALUES (?1, ?2, 'General', ?3, ?3, 0)",
                    rusqlite::params![tid, op, now],
                )?;
                conn.execute(
                    "UPDATE teammate_messages SET thread_id = ?1 \
                     WHERE operator_id = ?2 AND thread_id IS NULL",
                    rusqlite::params![tid, op],
                )?;
            }
        }
```

(If `conn.prepare`/`?` isn't usable in this function's return type, mirror the surrounding code — the `new`/open function returns `Result<Self, StorageError>`, so `?` on `rusqlite::Error` must convert. Check the existing `?` usage in this function; the ALTERs use `let _ =` because they're expected to fail on re-run, but the backfill SELECT/INSERT use `?` since they must succeed. `StorageError` already has a `From<rusqlite::Error>` impl — confirm at the top of the file.)

- [ ] **Step 4: Write the migration test**

Add to the `#[cfg(test)]` module in `storage.rs` (mirror the pre-migration simulation test at `:3726`):

```rust
#[tokio::test]
async fn backfill_creates_general_thread_for_legacy_messages() {
    // Open a DB, raw-insert two messages with NULL thread_id for one operator,
    // then re-run the migration path (re-open) and assert exactly one thread
    // named "General" exists and both messages now point to it.
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    let store = Storage::open(&path).await.unwrap();
    // seed an operator + 2 messages with NULL thread_id via raw SQL
    {
        let c = store.conn();
        let c = c.lock().await;
        c.execute("INSERT INTO operators (id, name) VALUES ('op1','X')", []).ok();
        c.execute(
            "INSERT INTO teammate_messages \
             (id, operator_id, role, content_kind, content_json, created_at_unix_ms, thread_id) \
             VALUES ('m1','op1','user','text','\"hi\"',1, NULL)", []).unwrap();
        c.execute(
            "INSERT INTO teammate_messages \
             (id, operator_id, role, content_kind, content_json, created_at_unix_ms, thread_id) \
             VALUES ('m2','op1','operator','text','\"yo\"',2, NULL)", []).unwrap();
    }
    drop(store);
    // Re-open → migration backfill runs again
    let store = Storage::open(&path).await.unwrap();
    let c = store.conn();
    let c = c.lock().await;
    let n: i64 = c.query_row(
        "SELECT COUNT(*) FROM teammate_threads WHERE operator_id='op1' AND title='General'",
        [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "exactly one General thread");
    let nulls: i64 = c.query_row(
        "SELECT COUNT(*) FROM teammate_messages WHERE operator_id='op1' AND thread_id IS NULL",
        [], |r| r.get(0)).unwrap();
    assert_eq!(nulls, 0, "no orphaned messages remain");
}
```

(Adjust the `operators` insert columns to match the real `operators` schema — check the CREATE TABLE for `operators`; it may require more NOT NULL columns. Use the minimal valid insert.)

- [ ] **Step 5: Verify**

Run: `cargo test -p karl-app backfill_creates_general_thread_for_legacy_messages -- --nocapture`
Expected: PASS. Also `cargo check -p karl-app` compiles (the new `thread_id` field on `TaskMessage` will break existing constructors — fix them in Task 2/3; for THIS task's check, add `thread_id: None` to every `TaskMessage { ... }` literal the compiler flags so the crate compiles).

- [ ] **Step 6: Commit**

```bash
git add -f crates/app/src/teammate/types.rs crates/app/src/storage.rs
git commit -m "feat(threads): schema, ThreadId type, and legacy backfill migration"
```

---

## Task 2: Storage CRUD for threads + thread-scoped message I/O

**Files:**
- Modify: `crates/app/src/storage.rs` (`teammate_insert_message` `:2176`, `teammate_list_messages` `:2218`)
- Test: inline `#[cfg(test)]` in `storage.rs`

- [ ] **Step 1: Write failing tests for thread CRUD + scoped insert/list**

Add to the test module:

```rust
#[tokio::test]
async fn thread_crud_and_scoped_messages() {
    let dir = tempfile::tempdir().unwrap();
    let store = Storage::open(&dir.path().join("t.db")).await.unwrap();
    let op = crate::operator_registry::OperatorId(ulid::Ulid::new());
    // seed operator row so FK holds
    { let c = store.conn(); let c = c.lock().await;
      c.execute("INSERT INTO operators (id, name) VALUES (?1,'X')",
        rusqlite::params![op.0.to_string()]).unwrap(); }

    let t1 = store.teammate_create_thread(op, "Alpha").await.unwrap();
    let t2 = store.teammate_create_thread(op, "Beta").await.unwrap();
    let listed = store.teammate_list_threads(op).await.unwrap();
    assert_eq!(listed.len(), 2);

    // insert one message into each thread, list scoped
    let m = |tid| crate::teammate::TaskMessage {
        id: crate::teammate::MessageId::new(), operator_id: op, task_id: None,
        thread_id: Some(tid), role: crate::teammate::Role::User,
        content: crate::teammate::MessageContent::Text("x".into()),
        created_at_unix_ms: 10, confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None, sentiment: None,
    };
    store.teammate_insert_message(&m(t1)).await.unwrap();
    store.teammate_insert_message(&m(t1)).await.unwrap();
    store.teammate_insert_message(&m(t2)).await.unwrap();
    assert_eq!(store.teammate_list_messages_in_thread(t1, 200).await.unwrap().len(), 2);
    assert_eq!(store.teammate_list_messages_in_thread(t2, 200).await.unwrap().len(), 1);

    // rename + archive
    store.teammate_rename_thread(t1, "Renamed").await.unwrap();
    store.teammate_archive_thread(t2).await.unwrap();
    let after = store.teammate_list_threads(op).await.unwrap();
    assert_eq!(after.len(), 1, "archived thread excluded");
    assert_eq!(after[0].title, "Renamed");
}
```

- [ ] **Step 2: Run to confirm failure**

Run: `cargo test -p karl-app thread_crud_and_scoped_messages`
Expected: FAIL — methods `teammate_create_thread`, `teammate_list_threads`, `teammate_list_messages_in_thread`, `teammate_rename_thread`, `teammate_archive_thread` don't exist.

- [ ] **Step 3: Implement the thread CRUD methods**

Add to the `impl Storage` block near the other teammate methods (after `teammate_list_messages`). Mirror the `spawn_blocking` + `blocking_lock` pattern used by `teammate_insert_message`:

```rust
    pub async fn teammate_create_thread(
        &self,
        operator_id: crate::operator_registry::OperatorId,
        title: &str,
    ) -> Result<crate::teammate::ThreadId, StorageError> {
        let inner = self.inner.clone();
        let title = title.to_string();
        let op = operator_id.0.to_string();
        tokio::task::spawn_blocking(move || -> Result<crate::teammate::ThreadId, StorageError> {
            let id = crate::teammate::ThreadId::new();
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64).unwrap_or(0);
            let c = inner.blocking_lock();
            c.execute(
                "INSERT INTO teammate_threads \
                 (id, operator_id, title, created_at_unix_ms, last_message_at_unix_ms, archived) \
                 VALUES (?1, ?2, ?3, ?4, ?4, 0)",
                params![id.0.to_string(), op, title, now],
            )?;
            Ok(id)
        }).await.map_err(|e| StorageError::Join(e.to_string()))?
    }

    pub async fn teammate_list_threads(
        &self,
        operator_id: crate::operator_registry::OperatorId,
    ) -> Result<Vec<crate::teammate::TeammateThread>, StorageError> {
        let inner = self.inner.clone();
        let op = operator_id.0.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<crate::teammate::TeammateThread>, StorageError> {
            let c = inner.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, operator_id, title, created_at_unix_ms, last_message_at_unix_ms, archived \
                 FROM teammate_threads WHERE operator_id = ?1 AND archived = 0 \
                 ORDER BY last_message_at_unix_ms DESC",
            )?;
            let rows = stmt.query_map(params![op], |r| {
                Ok((
                    r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?, r.get::<_, i64>(4)?, r.get::<_, i64>(5)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (id, op_id, title, created, last, archived) = row?;
                out.push(crate::teammate::TeammateThread {
                    id: crate::teammate::ThreadId(
                        ulid::Ulid::from_string(&id).map_err(|e| StorageError::Other(e.to_string()))?),
                    operator_id: crate::operator_registry::OperatorId(
                        ulid::Ulid::from_string(&op_id).map_err(|e| StorageError::Other(e.to_string()))?),
                    title,
                    created_at_unix_ms: created as u64,
                    last_message_at_unix_ms: last as u64,
                    archived: archived != 0,
                });
            }
            Ok(out)
        }).await.map_err(|e| StorageError::Join(e.to_string()))?
    }

    pub async fn teammate_rename_thread(
        &self, thread_id: crate::teammate::ThreadId, title: &str,
    ) -> Result<(), StorageError> {
        let inner = self.inner.clone();
        let (tid, title) = (thread_id.0.to_string(), title.to_string());
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = inner.blocking_lock();
            c.execute("UPDATE teammate_threads SET title = ?1 WHERE id = ?2",
                params![title, tid])?;
            Ok(())
        }).await.map_err(|e| StorageError::Join(e.to_string()))?
    }

    pub async fn teammate_archive_thread(
        &self, thread_id: crate::teammate::ThreadId,
    ) -> Result<(), StorageError> {
        let inner = self.inner.clone();
        let tid = thread_id.0.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = inner.blocking_lock();
            c.execute("UPDATE teammate_threads SET archived = 1 WHERE id = ?1",
                params![tid])?;
            Ok(())
        }).await.map_err(|e| StorageError::Join(e.to_string()))?
    }

    pub async fn teammate_list_messages_in_thread(
        &self, thread_id: crate::teammate::ThreadId, limit: usize,
    ) -> Result<Vec<crate::teammate::TaskMessage>, StorageError> {
        // Same row-mapping as teammate_list_messages but filters by thread_id.
        let inner = self.inner.clone();
        let tid = thread_id.0.to_string();
        tokio::task::spawn_blocking(move || -> Result<Vec<crate::teammate::TaskMessage>, StorageError> {
            let c = inner.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, operator_id, task_id, thread_id, role, content_kind, content_json, \
                        created_at_unix_ms, confirmed_at_unix_ms, dismissed_at_unix_ms, sentiment \
                 FROM teammate_messages WHERE thread_id = ?1 \
                 ORDER BY created_at_unix_ms ASC LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![tid, limit as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?, r.get::<_, String>(4)?, r.get::<_, String>(5)?,
                    r.get::<_, String>(6)?, r.get::<_, i64>(7)?, r.get::<_, Option<i64>>(8)?,
                    r.get::<_, Option<i64>>(9)?, r.get::<_, Option<String>>(10)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (id, op_id, task_id, thr, _kind, _ck, content_json, ts, confirmed, dismissed, sent) = row?;
                out.push(crate::teammate::TaskMessage {
                    id: crate::teammate::MessageId(ulid::Ulid::from_string(&id)
                        .map_err(|e| StorageError::Other(e.to_string()))?),
                    operator_id: crate::operator_registry::OperatorId(ulid::Ulid::from_string(&op_id)
                        .map_err(|e| StorageError::Other(e.to_string()))?),
                    task_id: task_id.as_deref().map(ulid::Ulid::from_string).transpose()
                        .map_err(|e| StorageError::Other(e.to_string()))?
                        .map(crate::teammate::TaskId),
                    thread_id: thr.as_deref().map(ulid::Ulid::from_string).transpose()
                        .map_err(|e| StorageError::Other(e.to_string()))?
                        .map(crate::teammate::ThreadId),
                    role: serde_json::from_str(&format!("\"{}\"", _kind))
                        .map_err(|e| StorageError::Other(e.to_string()))?,
                    content: serde_json::from_str(&content_json)
                        .map_err(|e| StorageError::Other(e.to_string()))?,
                    created_at_unix_ms: ts as u64,
                    confirmed_at_unix_ms: confirmed.map(|v| v as u64),
                    dismissed_at_unix_ms: dismissed.map(|v| v as u64),
                    sentiment: sent.as_deref().and_then(crate::teammate::Sentiment::from_token),
                });
            }
            Ok(out)
        }).await.map_err(|e| StorageError::Join(e.to_string()))?
    }
```

NOTE: in the snippet above the column order in SELECT is `... role, content_kind, content_json ...`; bind them to the correct tuple positions — `role` is index 4, `content_kind` index 5 (unused), `content_json` index 6. Fix the destructuring so `role` is parsed from the role column, not `_kind`. (Copy the exact mapping from the existing `teammate_list_messages` at `:2218` and just add the `thread_id` column at the right index.)

- [ ] **Step 4: Update `teammate_insert_message` to persist `thread_id` + bump thread timestamp**

In `teammate_insert_message` (`:2176`), add `thread_id` to the INSERT column list and params, and after the insert, bump the thread's `last_message_at_unix_ms`:

```rust
            c.execute(
                "INSERT INTO teammate_messages \
                 (id, operator_id, task_id, thread_id, role, content_kind, content_json, created_at_unix_ms, sentiment) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    msg.id.0.to_string(),
                    msg.operator_id.0.to_string(),
                    msg.task_id.map(|t| t.0.to_string()),
                    msg.thread_id.map(|t| t.0.to_string()),
                    role,
                    content_kind,
                    content_json,
                    msg.created_at_unix_ms as i64,
                    msg.sentiment.map(|s| s.as_token()),
                ],
            )?;
            if let Some(tid) = msg.thread_id {
                c.execute(
                    "UPDATE teammate_threads SET last_message_at_unix_ms = ?1 WHERE id = ?2",
                    params![msg.created_at_unix_ms as i64, tid.0.to_string()],
                )?;
            }
```

- [ ] **Step 5: Run tests**

Run: `cargo test -p karl-app teammate` and `cargo test -p karl-app thread_crud_and_scoped_messages`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/storage.rs
git commit -m "feat(threads): thread CRUD + thread-scoped message insert/list"
```

---

## Task 3: Tauri commands — thread plumbing through send/list + 4 new commands

**Files:**
- Modify: `crates/app/src/teammate/commands.rs` (`teammate_send_text_message` `:24`, `teammate_list_messages_for_operator` `:12`)
- Modify: command registration (`invoke_handler!`/`generate_handler!` — grep `teammate_send_text_message` to find it)

- [ ] **Step 1: Thread `thread_id` through `teammate_send_text_message`**

Add the arg and use it for both the user message and the reply, and load thread-scoped history:

```rust
    operator_id: crate::operator_registry::OperatorId,
    thread_id: crate::teammate::ThreadId,
    text: String,
    active_session_id: Option<String>,
```

In the user `TaskMessage` literal (`:43`) add `thread_id: Some(thread_id),`. In the background task, replace the history load (`teammate_list_messages(operator_id, 200)`) with `teammate_list_messages_in_thread(thread_id, 200)`. In the reply `TaskMessage` literal (`:~180`) add `thread_id: Some(thread_id),`. The `app_bg.emit("teammate-message", &reply_msg)` now automatically carries `thread_id` because it serializes the whole struct.

- [ ] **Step 2: Add `thread_id` filter to `teammate_list_messages_for_operator`**

Rename/extend the command to take an optional thread filter. Replace its body to call `teammate_list_messages_in_thread` when a `thread_id` is provided:

```rust
#[tauri::command]
pub async fn teammate_list_messages_for_operator(
    storage: tauri::State<'_, std::sync::Arc<crate::storage::Storage>>,
    operator_id: crate::operator_registry::OperatorId,
    thread_id: crate::teammate::ThreadId,
    limit: usize,
) -> Result<Vec<crate::teammate::TaskMessage>, String> {
    storage.teammate_list_messages_in_thread(thread_id, limit)
        .await.map_err(|e| e.to_string())
}
```

- [ ] **Step 3: Add the 4 thread commands**

In `commands.rs`:

```rust
#[tauri::command]
pub async fn teammate_create_thread(
    storage: tauri::State<'_, std::sync::Arc<crate::storage::Storage>>,
    operator_id: crate::operator_registry::OperatorId,
    title: String,
) -> Result<crate::teammate::TeammateThread, String> {
    let id = storage.teammate_create_thread(operator_id, &title).await.map_err(|e| e.to_string())?;
    let threads = storage.teammate_list_threads(operator_id).await.map_err(|e| e.to_string())?;
    threads.into_iter().find(|t| t.id == id)
        .ok_or_else(|| "created thread not found".to_string())
}

#[tauri::command]
pub async fn teammate_list_threads(
    storage: tauri::State<'_, std::sync::Arc<crate::storage::Storage>>,
    operator_id: crate::operator_registry::OperatorId,
) -> Result<Vec<crate::teammate::TeammateThread>, String> {
    storage.teammate_list_threads(operator_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_rename_thread(
    storage: tauri::State<'_, std::sync::Arc<crate::storage::Storage>>,
    thread_id: crate::teammate::ThreadId,
    title: String,
) -> Result<(), String> {
    storage.teammate_rename_thread(thread_id, &title).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_archive_thread(
    storage: tauri::State<'_, std::sync::Arc<crate::storage::Storage>>,
    thread_id: crate::teammate::ThreadId,
) -> Result<(), String> {
    storage.teammate_archive_thread(thread_id).await.map_err(|e| e.to_string())
}
```

- [ ] **Step 4: Register the 4 commands**

Find the `tauri::generate_handler![...]` list (grep `teammate_list_messages_for_operator` across `crates/app/src`). Add `teammate_create_thread, teammate_list_threads, teammate_rename_thread, teammate_archive_thread` to it.

- [ ] **Step 5: Verify compile**

Run: `cargo check -p karl-app`
Expected: compiles. Fix any remaining `TaskMessage { ... }` literals missing `thread_id` (use `None` for system/error messages created outside a thread context — e.g. `emit_system_error`).

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/teammate/commands.rs crates/app/src/lib.rs
git commit -m "feat(threads): tauri commands for thread CRUD and thread-scoped chat"
```

---

## Task 4: TypeScript API bindings

**Files:**
- Modify: `ui/src/api.ts` (`TeammateMessage` `:425`, `teammateListMessages` `:441`, `teammateSendText` `:451`)

- [ ] **Step 1: Add `thread_id` to `TeammateMessage` + `TeammateThread` interface**

In `api.ts`, add to `TeammateMessage` (after `task_id`):

```typescript
  thread_id: string | null;
```

Add a new interface near it:

```typescript
export interface TeammateThread {
  id: string;
  operator_id: string;
  title: string;
  created_at_unix_ms: number;
  last_message_at_unix_ms: number;
  archived: boolean;
}
```

- [ ] **Step 2: Thread `threadId` through list/send wrappers + add thread command wrappers**

```typescript
export async function teammateListMessages(
  operatorId: string,
  threadId: string,
  limit = 200,
): Promise<TeammateMessage[]> {
  return invoke<TeammateMessage[]>("teammate_list_messages_for_operator", {
    operatorId, threadId, limit,
  });
}

export async function teammateSendText(
  operatorId: string,
  threadId: string,
  text: string,
  activeSessionId?: string | null,
): Promise<TeammateMessage> {
  return invoke<TeammateMessage>("teammate_send_text_message", {
    operatorId, threadId, text, activeSessionId: activeSessionId ?? null,
  });
}

export async function teammateListThreads(operatorId: string): Promise<TeammateThread[]> {
  return invoke<TeammateThread[]>("teammate_list_threads", { operatorId });
}
export async function teammateCreateThread(operatorId: string, title: string): Promise<TeammateThread> {
  return invoke<TeammateThread>("teammate_create_thread", { operatorId, title });
}
export async function teammateRenameThread(threadId: string, title: string): Promise<void> {
  return invoke<void>("teammate_rename_thread", { threadId, title });
}
export async function teammateArchiveThread(threadId: string): Promise<void> {
  return invoke<void>("teammate_archive_thread", { threadId });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: errors ONLY at `panel.ts` call sites of `teammateSendText`/`teammateListMessages` (fixed in Task 5). The `api.ts` file itself is clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(threads): typed api bindings for threads + thread-scoped chat"
```

---

## Task 5: Panel UI — thread row, dropdown, switching, trash rescope

**Files:**
- Modify: `ui/src/teammate/panel.ts` (`TeammatePanel`, header `:427`, `openFor` `:303`, `send` `:419`, thread render `:677`, tabs/trash `:501`)

- [ ] **Step 1: Add thread state fields to `TeammatePanel`**

Add private fields: `activeThreadId: string | null = null;` and `threads: TeammateThread[] = [];` and `threadDropdownOpen = false;`. Import `TeammateThread, teammateListThreads, teammateCreateThread, teammateRenameThread, teammateArchiveThread` from `../api`.

- [ ] **Step 2: Load/seed threads in `openFor`**

In `openFor(operator)`, after setting the current operator, load threads and pick the active one:

```typescript
this.threads = await teammateListThreads(operator.id);
if (this.threads.length === 0) {
  const t = await teammateCreateThread(operator.id, "New conversation");
  this.threads = [t];
}
this.activeThreadId = this.threads[0].id; // most-recent (list is DESC)
```

Then load messages with `teammateListMessages(operator.id, this.activeThreadId)` (update the existing message-load call to pass `activeThreadId`).

- [ ] **Step 3: Render the thread row + dropdown in the header**

After the operator name/model block in the header render (`:427`–`:462`), insert a thread row. Match the existing panel styling conventions (reuse class-name prefixes like `teammate-panel-*`). The row shows the active thread title + a chevron; clicking toggles `threadDropdownOpen` and re-renders. The dropdown lists `this.threads` (title + relative time), a pinned "+ New thread" item, a checkmark on `activeThreadId`, and a hover archive affordance. Use the existing relative-time helper if one exists in the file (grep `ago`/`relative`), else inline a simple `Xm/Xh/Xd` formatter.

New-thread handler:
```typescript
const t = await teammateCreateThread(this.operator.id, "New conversation");
this.threads.unshift(t);
this.activeThreadId = t.id;
this.threadDropdownOpen = false;
await this.loadAndRenderMessages(); // clears thread view to empty-state
```

Switch handler: set `activeThreadId`, close dropdown, reload messages for that thread.
Archive handler: `await teammateArchiveThread(id)`; remove from `this.threads`; if it was active, switch to `this.threads[0]` (create a fresh one if list becomes empty).
Rename handler: double-click the title → inline editable → `await teammateRenameThread(id, newTitle)`.

- [ ] **Step 4: Pass `activeThreadId` in `send()`**

In `send()` (`:419`), change `teammateSendText(this.operator.id, text, sessionId)` to `teammateSendText(this.operator.id, this.activeThreadId!, text, sessionId)`.

- [ ] **Step 5: Filter incoming `teammate-message` events by active thread**

In the `onTeammateMessage`/`teammate-message` listener, append the message to the visible thread ONLY when `msg.thread_id === this.activeThreadId`. Otherwise ignore (it belongs to another thread). If `msg.operator_id !== this.operator.id`, also ignore (existing behavior).

- [ ] **Step 6: Rescope the trash icon to the active thread**

The top-right trash (`:501` tabs bar area): change its handler from clearing all operator history to archiving the active thread (`teammateArchiveThread(this.activeThreadId)`), then switch to the next thread (or create a fresh "New conversation"). Update its tooltip via `attachTooltip` (per project rule — never `element.title`) to "Delete this thread".

- [ ] **Step 7: Typecheck + manual smoke**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS (no errors).
Manual: use the `respawn` skill to restart `tauri dev`, open an operator, confirm: thread row shows, dropdown opens, "+ New thread" gives an empty chat, sending in thread A then switching to thread B shows B's separate history, switching back shows A's.

- [ ] **Step 8: Commit**

```bash
git add ui/src/teammate/panel.ts
git commit -m "feat(threads): header thread switcher, per-thread chat, trash rescope"
```

---

## Task 6: Auto-titling new threads

**Files:**
- Modify: `crates/app/src/teammate/commands.rs` (`teammate_send_text_message` background task)
- Modify: `crates/app/src/teammate/llm.rs` (add a small title helper) OR reuse existing dispatch

- [ ] **Step 1: Add a title-generation helper**

In `llm.rs`, add a function that takes the first user message text and returns a 3–5 word title via a fast model. Reuse the existing Anthropic client/settings plumbing already used by `dispatch_reply`. Keep the prompt tiny:

```rust
pub async fn generate_thread_title(
    settings: &crate::Settings,
    first_user_message: &str,
) -> anyhow::Result<String> {
    // Single-shot, fast model, no tools. System: "Reply with a 3-5 word
    // title for a conversation that starts with the user's message. No
    // quotes, no punctuation at the end." Trim, cap to ~40 chars.
}
```

(Mirror the request-construction in `dispatch_reply` — same client, base URL, auth header. Use a cheap model id from settings if one exists, else the default chat model.)

- [ ] **Step 2: Trigger titling on the first message of a thread**

In `teammate_send_text_message`'s background task, after loading the thread-scoped history, detect "first message" = the loaded history (before the just-inserted user msg) was empty AND the thread's current title is `"New conversation"`. If so, spawn a non-blocking task:

```rust
let title = generate_thread_title(&settings, &user_text).await.unwrap_or_default();
if !title.is_empty() {
    let _ = storage_bg.teammate_rename_thread(thread_id, &title).await;
    let _ = app_bg.emit("teammate-thread-renamed",
        serde_json::json!({ "thread_id": thread_id.0.to_string(), "title": title }));
}
```

(Capture `user_text` before the user `TaskMessage` consumes `text` — clone it early in the command.)

- [ ] **Step 3: UI applies the rename event**

In `panel.ts`, listen for `teammate-thread-renamed`; if the thread is in `this.threads`, update its title and re-render the thread row/dropdown. Add a typed `onTeammateThreadRenamed` wrapper in `api.ts` mirroring `onTeammateMessage`.

- [ ] **Step 4: Verify**

Run: `cargo check -p karl-app` and `cd ui && npx tsc --noEmit` — both clean.
Manual (respawn): create a new thread, send "help me fix the failing auth tests", confirm the thread title updates from "New conversation" to something like "Fix auth tests" within a couple seconds.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/llm.rs crates/app/src/teammate/commands.rs ui/src/api.ts ui/src/teammate/panel.ts
git commit -m "feat(threads): auto-title new threads from first message"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** data model (T1), migration/backfill (T1), storage CRUD + scoped I/O (T2), commands + event payload `thread_id` (T3), api bindings (T4), header dropdown UI + switching + trash rescope (T5), auto-titling (T6). Tasks/Activity untouched = Chat-only scope ✓.
- **Type consistency:** `ThreadId`/`TeammateThread` defined T1, used identically in T2/T3; `thread_id` field added to `TaskMessage` (T1) and threaded through every constructor (T1 step 5, T3 step 5); `teammate_list_messages_in_thread` named consistently T2→T3.
- **Known follow-up to confirm during impl:** exact `operators` table required columns for test inserts (T1.4/T2.1); exact location of `generate_handler!` macro (T3.4); presence of a relative-time helper in `panel.ts` (T5.3). Each is called out inline.
