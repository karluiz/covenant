# Teammate Task Cards in DM — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the user DMs an operator with an actionable request, the operator responds with a structured task card (Archetype/Deliverable/Scope) that the user can Confirm / Edit / Cancel. Confirming a `Do` task spawns a new tab bound to the operator.

**Architecture:** Add an LLM tool `propose_task` so the operator emits structured output instead of free text. Persist the proposal as `MessageContent::Propose`. UI renders a task card. Confirm triggers a backend transition (`Task` row created, operator state → `OnTask`) and the UI then spawns a new tab via the existing `tabsManager.createTab` path, calling back into the backend to attach the new SessionId.

**Tech Stack:** Rust + Tokio + rusqlite (backend), Tauri 2 (IPC), TypeScript + vanilla DOM (frontend), Anthropic Messages API with tool_use.

**Spec:** `docs/superpowers/specs/2026-05-22-teammate-task-cards-design.md`

---

## File Map

**New files:**
- `ui/src/teammate/task-card.ts` — renders the Propose card with Confirmar/Editar/Cancelar buttons + edit form
- `ui/src/teammate/task-card.test.ts` — unit tests for the card renderer

**Modified files:**
- `crates/app/src/teammate/tools.rs` — add `propose_task_tool_def()`
- `crates/app/src/teammate/llm.rs` — emit `MessageContent::Propose` when model calls `propose_task`; expose helper that returns `MessageContent` (not just String)
- `crates/app/src/teammate/commands.rs` — store Propose reply via new helper; add `teammate_confirm_task`, `teammate_cancel_task_proposal`, `teammate_edit_task_proposal`, `teammate_attach_session_to_task`; replace `teammate_list_tasks` stub with a real query
- `crates/app/src/teammate/mod.rs` — re-export new command symbols if needed
- `crates/app/src/lib.rs` — register the four new Tauri commands in `invoke_handler`
- `crates/app/src/storage.rs` — add `teammate_list_tasks_for_operator`, `teammate_get_message`, `teammate_mark_message_confirmed`, `teammate_mark_message_dismissed`, `teammate_update_message_content`, `teammate_update_task_spawned_session`; ALTER `teammate_messages` to add `confirmed_at_unix_ms` + `dismissed_at_unix_ms`
- `ui/src/api.ts` — tighten `TeammateContent` to a tagged union; add `taskDraft`, `propose`, `taskUpdate`, `report` types; add `teammateConfirmTask`, `teammateCancelTaskProposal`, `teammateEditTaskProposal`, `teammateAttachSessionToTask`, `teammateListTasks`; add `onTeammateTask` listener for `teammate-task` event; expose `TaskArchetype`, `Task` types
- `ui/src/teammate/panel.ts` — switch on `content.kind`; render Propose via `task-card.ts`; render `task_update` as a system line; wire confirm handler to call `tabsManager.createTab` + `teammateAttachSessionToTask`
- `ui/src/teammate/panel.test.ts` — add Propose rendering + confirm-click test

---

## Task 1: Add `confirmed_at_unix_ms` and `dismissed_at_unix_ms` columns to `teammate_messages`

**Files:**
- Modify: `crates/app/src/storage.rs` (SCHEMA block + migration block)

- [ ] **Step 1: Update SCHEMA to include the new columns**

In `crates/app/src/storage.rs`, find the `CREATE TABLE IF NOT EXISTS teammate_messages` block (around line 205) and replace it:

```sql
CREATE TABLE IF NOT EXISTS teammate_messages (
    id                  TEXT PRIMARY KEY,
    operator_id         TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    task_id             TEXT REFERENCES teammate_tasks(id) ON DELETE SET NULL,
    role                TEXT NOT NULL,
    content_kind        TEXT NOT NULL,
    content_json        TEXT NOT NULL,
    created_at_unix_ms  INTEGER NOT NULL,
    confirmed_at_unix_ms INTEGER,
    dismissed_at_unix_ms INTEGER
);
```

- [ ] **Step 2: Add idempotent ALTERs for existing DBs**

In the migration block in `Storage::open` (right after the existing `ALTER TABLE` calls around line 459), append:

```rust
// 5.x Teammate task cards: track whether a Propose message has been
// confirmed (turned into a Task) or dismissed (user cancelled the
// proposal). Both NULL for older rows.
let _ = conn.execute(
    "ALTER TABLE teammate_messages ADD COLUMN confirmed_at_unix_ms INTEGER",
    [],
);
let _ = conn.execute(
    "ALTER TABLE teammate_messages ADD COLUMN dismissed_at_unix_ms INTEGER",
    [],
);
```

- [ ] **Step 3: Build and verify the migration compiles**

Run: `cargo build -p karl-app`
Expected: clean build, no errors.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/storage.rs
git commit -m "feat(teammate/storage): track confirmed/dismissed timestamps on proposals"
```

---

## Task 2: Add storage helpers for proposals and tasks

**Files:**
- Modify: `crates/app/src/storage.rs`
- Test: `crates/app/src/storage.rs` (inline `#[cfg(test)]` block at end of file, or extend existing tests module)

- [ ] **Step 1: Write failing test for `teammate_mark_message_confirmed`**

Append to the tests at the bottom of `crates/app/src/storage.rs` (inside the existing `#[cfg(test)] mod tests { ... }` if present, otherwise create one):

```rust
#[cfg(test)]
mod task_card_storage_tests {
    use super::*;
    use crate::operator_registry::OperatorId;
    use crate::teammate::{MessageContent, MessageId, ProposeTask, Role, TaskArchetype, TaskDraft, TaskMessage, TaskScope};
    use ulid::Ulid;

    fn tmp_storage() -> Storage {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        // Keep tempdir alive by leaking — fine for a unit test process.
        Box::leak(Box::new(dir));
        Storage::open(&path).expect("open storage")
    }

    fn sample_op_id() -> OperatorId { OperatorId(Ulid::new()) }

    fn make_propose_msg(op: OperatorId) -> TaskMessage {
        TaskMessage {
            id: MessageId::new(),
            operator_id: op,
            task_id: None,
            role: Role::Operator,
            content: MessageContent::Propose(ProposeTask {
                draft: TaskDraft {
                    archetype: TaskArchetype::Do,
                    title: "Revisar migración".into(),
                    deliverable: "resumen + riesgos".into(),
                    scope: TaskScope::default(),
                },
                rationale: "user asked for an audit".into(),
            }),
            created_at_unix_ms: 1_700_000_000_000,
        }
    }

    #[tokio::test]
    async fn mark_message_confirmed_sets_timestamp_and_returns_msg() {
        let s = tmp_storage();
        let op = sample_op_id();
        // operators FK: insert a minimal operator row so the FK passes.
        // (Storage exposes operator_upsert in this codebase.)
        s.operator_upsert(&crate::operator_registry::Operator {
            id: op, name: "T".into(), emoji: "🤖".into(), color: "#000".into(),
            tags: vec![], persona: "".into(), escalate_threshold: 0.6,
            model: "x".into(), hard_constraints: "".into(),
            voice: crate::operator_registry::VoiceTone::Terse,
            is_default: false, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
        }).await.unwrap();

        let msg = make_propose_msg(op);
        s.teammate_insert_message(&msg).await.unwrap();
        s.teammate_mark_message_confirmed(msg.id, 1_700_000_000_500).await.unwrap();

        let fetched = s.teammate_get_message(msg.id).await.unwrap().expect("found");
        assert_eq!(fetched.confirmed_at_unix_ms, Some(1_700_000_000_500));
        assert_eq!(fetched.dismissed_at_unix_ms, None);
    }
}
```

The test will not compile yet — `teammate_mark_message_confirmed`, `teammate_get_message`, and the `confirmed_at_unix_ms`/`dismissed_at_unix_ms` fields on the returned struct don't exist.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cargo test -p karl-app task_card_storage_tests::mark_message_confirmed_sets_timestamp_and_returns_msg`
Expected: build error referencing `teammate_mark_message_confirmed` or `teammate_get_message`.

- [ ] **Step 3: Extend `TaskMessage` with timestamps and add new helpers**

In `crates/app/src/teammate/types.rs`, extend `TaskMessage`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMessage {
    pub id: MessageId,
    pub operator_id: OperatorId,
    pub task_id: Option<TaskId>,
    pub role: Role,
    pub content: MessageContent,
    pub created_at_unix_ms: u64,
    #[serde(default)]
    pub confirmed_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub dismissed_at_unix_ms: Option<u64>,
}
```

In `crates/app/src/storage.rs`, update the existing `teammate_insert_message` to keep working (it doesn't write the new columns — that's fine, they default NULL).

Update `teammate_list_messages` SELECT to read both new columns and populate them in the returned struct. Replace its query block (around line 1864–1920) so:

```rust
let mut stmt = c.prepare(
    "SELECT id, operator_id, task_id, role, content_kind, content_json, \
            created_at_unix_ms, confirmed_at_unix_ms, dismissed_at_unix_ms \
     FROM teammate_messages WHERE operator_id = ?1 \
     ORDER BY created_at_unix_ms ASC LIMIT ?2",
)?;
```

And in the row map, after `created_at_unix_ms`:

```rust
let confirmed_at_unix_ms: Option<i64> = row.get(7)?;
let dismissed_at_unix_ms: Option<i64> = row.get(8)?;
// ... build TaskMessage with these fields cast to Option<u64>
```

Add three new methods to `impl Storage`:

```rust
pub async fn teammate_get_message(
    &self,
    id: crate::teammate::MessageId,
) -> Result<Option<crate::teammate::TaskMessage>, StorageError> {
    let inner = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<Option<crate::teammate::TaskMessage>, StorageError> {
        let c = inner.blocking_lock();
        let mut stmt = c.prepare(
            "SELECT id, operator_id, task_id, role, content_kind, content_json, \
                    created_at_unix_ms, confirmed_at_unix_ms, dismissed_at_unix_ms \
             FROM teammate_messages WHERE id = ?1",
        )?;
        let row = stmt.query_row([id.0.to_string()], |row| {
            let id_s: String = row.get(0)?;
            let op_s: String = row.get(1)?;
            let task_s: Option<String> = row.get(2)?;
            let role_s: String = row.get(3)?;
            let _kind_s: String = row.get(4)?;
            let content_s: String = row.get(5)?;
            let created: i64 = row.get(6)?;
            let confirmed: Option<i64> = row.get(7)?;
            let dismissed: Option<i64> = row.get(8)?;
            Ok((id_s, op_s, task_s, role_s, content_s, created, confirmed, dismissed))
        }).optional()?;
        let Some((id_s, op_s, task_s, role_s, content_s, created, confirmed, dismissed)) = row else {
            return Ok(None);
        };
        let id = ulid::Ulid::from_string(&id_s).map_err(|e| StorageError::Other(e.to_string()))?;
        let op = ulid::Ulid::from_string(&op_s).map_err(|e| StorageError::Other(e.to_string()))?;
        let task = task_s.as_deref().map(ulid::Ulid::from_string).transpose()
            .map_err(|e| StorageError::Other(e.to_string()))?;
        let role: crate::teammate::Role = serde_json::from_value(serde_json::Value::String(role_s))
            .map_err(|e| StorageError::Other(e.to_string()))?;
        let content: crate::teammate::MessageContent = serde_json::from_str(&content_s)
            .map_err(|e| StorageError::Other(e.to_string()))?;
        Ok(Some(crate::teammate::TaskMessage {
            id: crate::teammate::MessageId(id),
            operator_id: crate::operator_registry::OperatorId(op),
            task_id: task.map(crate::teammate::TaskId),
            role,
            content,
            created_at_unix_ms: created as u64,
            confirmed_at_unix_ms: confirmed.map(|v| v as u64),
            dismissed_at_unix_ms: dismissed.map(|v| v as u64),
        }))
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn teammate_mark_message_confirmed(
    &self,
    id: crate::teammate::MessageId,
    now_unix_ms: u64,
) -> Result<(), StorageError> {
    let inner = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = inner.blocking_lock();
        c.execute(
            "UPDATE teammate_messages SET confirmed_at_unix_ms = ?1 WHERE id = ?2",
            params![now_unix_ms as i64, id.0.to_string()],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn teammate_mark_message_dismissed(
    &self,
    id: crate::teammate::MessageId,
    now_unix_ms: u64,
) -> Result<(), StorageError> {
    let inner = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = inner.blocking_lock();
        c.execute(
            "UPDATE teammate_messages SET dismissed_at_unix_ms = ?1 WHERE id = ?2",
            params![now_unix_ms as i64, id.0.to_string()],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn teammate_update_message_content(
    &self,
    id: crate::teammate::MessageId,
    content: &crate::teammate::MessageContent,
) -> Result<(), StorageError> {
    let inner = self.inner.clone();
    let json = serde_json::to_string(content).map_err(|e| StorageError::Other(e.to_string()))?;
    let kind = match content {
        crate::teammate::MessageContent::Text(_)         => "text",
        crate::teammate::MessageContent::TaskDraft(_)    => "task_draft",
        crate::teammate::MessageContent::TaskUpdate {..} => "task_update",
        crate::teammate::MessageContent::Propose(_)      => "propose",
        crate::teammate::MessageContent::Report(_)       => "report",
    };
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = inner.blocking_lock();
        c.execute(
            "UPDATE teammate_messages SET content_kind = ?1, content_json = ?2 WHERE id = ?3",
            params![kind, json, id.0.to_string()],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn teammate_list_tasks_for_operator(
    &self,
    op: crate::operator_registry::OperatorId,
) -> Result<Vec<crate::teammate::Task>, StorageError> {
    let inner = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<crate::teammate::Task>, StorageError> {
        let c = inner.blocking_lock();
        let mut stmt = c.prepare(
            "SELECT id, operator_id, archetype, title, body, deliverable, status, \
                    scope_json, spawned_session, created_at_unix_ms, updated_at_unix_ms, \
                    completed_at_unix_ms, cost_usd_cents \
             FROM teammate_tasks WHERE operator_id = ?1 \
             ORDER BY created_at_unix_ms DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([op.0.to_string()], |row| {
            let id_s: String = row.get(0)?;
            let op_s: String = row.get(1)?;
            let archetype_s: String = row.get(2)?;
            let title: String = row.get(3)?;
            let body: String = row.get(4)?;
            let deliverable: String = row.get(5)?;
            let status_s: String = row.get(6)?;
            let scope_json: String = row.get(7)?;
            let spawned: Option<String> = row.get(8)?;
            let created: i64 = row.get(9)?;
            let updated: i64 = row.get(10)?;
            let completed: Option<i64> = row.get(11)?;
            let cost: i64 = row.get(12)?;
            Ok((id_s, op_s, archetype_s, title, body, deliverable, status_s, scope_json, spawned, created, updated, completed, cost))
        })?;
        let mut out = Vec::new();
        for r in rows {
            let (id_s, op_s, archetype_s, title, body, deliverable, status_s, scope_json, spawned, created, updated, completed, cost) = r?;
            let id = ulid::Ulid::from_string(&id_s).map_err(|e| StorageError::Other(e.to_string()))?;
            let op = ulid::Ulid::from_string(&op_s).map_err(|e| StorageError::Other(e.to_string()))?;
            let archetype = match archetype_s.as_str() {
                "watch"  => crate::teammate::TaskArchetype::Watch,
                "do"     => crate::teammate::TaskArchetype::Do,
                "review" => crate::teammate::TaskArchetype::Review,
                other => return Err(StorageError::Other(format!("bad archetype {other}"))),
            };
            let status = match status_s.as_str() {
                "draft"     => crate::teammate::TaskStatus::Draft,
                "active"    => crate::teammate::TaskStatus::Active,
                "blocked"   => crate::teammate::TaskStatus::Blocked,
                "done"      => crate::teammate::TaskStatus::Done,
                "cancelled" => crate::teammate::TaskStatus::Cancelled,
                other => return Err(StorageError::Other(format!("bad status {other}"))),
            };
            let scope: crate::teammate::TaskScope = serde_json::from_str(&scope_json)
                .map_err(|e| StorageError::Other(e.to_string()))?;
            let spawned_session = spawned.as_deref().map(|s| s.parse::<karl_session::SessionId>())
                .transpose().map_err(|e| StorageError::Other(e.to_string()))?;
            out.push(crate::teammate::Task {
                id: crate::teammate::TaskId(id),
                operator_id: crate::operator_registry::OperatorId(op),
                archetype, title, body, deliverable, status, scope,
                spawned_session,
                created_at_unix_ms: created as u64,
                updated_at_unix_ms: updated as u64,
                completed_at_unix_ms: completed.map(|v| v as u64),
                cost_usd_cents: cost as u32,
            });
        }
        Ok(out)
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn teammate_update_task_spawned_session(
    &self,
    id: crate::teammate::TaskId,
    session: karl_session::SessionId,
    now_unix_ms: u64,
) -> Result<(), StorageError> {
    let inner = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = inner.blocking_lock();
        c.execute(
            "UPDATE teammate_tasks SET spawned_session = ?1, updated_at_unix_ms = ?2 WHERE id = ?3",
            params![session.to_string(), now_unix_ms as i64, id.0.to_string()],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}
```

Note: the existing `teammate_list_messages` was updating row fields without `confirmed_at_unix_ms` / `dismissed_at_unix_ms`. Update the `out.push(crate::teammate::TaskMessage { ... })` call in that function to also set these two fields.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-app task_card_storage_tests`
Expected: PASS.

- [ ] **Step 5: Run full crate tests to confirm nothing regressed**

Run: `cargo test -p karl-app`
Expected: all tests pass (other tests touching `TaskMessage` may need `..Default::default()` style or explicit `confirmed_at_unix_ms: None, dismissed_at_unix_ms: None` — fix them in this step).

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/storage.rs crates/app/src/teammate/types.rs
git commit -m "feat(teammate/storage): add proposal + task helpers, expose timestamps"
```

---

## Task 3: Add `propose_task` LLM tool definition

**Files:**
- Modify: `crates/app/src/teammate/tools.rs`

- [ ] **Step 1: Write failing test for `propose_task_tool_def`**

Append to the `#[cfg(test)] mod tests` block at the bottom of `crates/app/src/teammate/tools.rs`:

```rust
#[test]
fn propose_task_tool_def_has_required_shape() {
    let def = propose_task_tool_def();
    assert_eq!(def["name"], "propose_task");
    let schema = &def["input_schema"];
    assert_eq!(schema["type"], "object");
    let required = schema["required"].as_array().expect("required array");
    let required_keys: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
    assert!(required_keys.contains(&"archetype"));
    assert!(required_keys.contains(&"title"));
    assert!(required_keys.contains(&"deliverable"));
    assert!(required_keys.contains(&"rationale"));
    let archetype_enum = schema["properties"]["archetype"]["enum"]
        .as_array().expect("archetype enum");
    let values: Vec<&str> = archetype_enum.iter().filter_map(|v| v.as_str()).collect();
    assert_eq!(values, vec!["do", "review", "watch"]);
}
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cargo test -p karl-app teammate::tools::tests::propose_task_tool_def_has_required_shape`
Expected: FAIL — `propose_task_tool_def` not found.

- [ ] **Step 3: Add `propose_task_tool_def`**

Append to `crates/app/src/teammate/tools.rs` (after `read_file_tool_def`):

```rust
/// Anthropic tool definition for `propose_task`. The model calls this
/// when the user's message is an actionable, multi-step request (not
/// just Q&A). No execution handler — the LLM dispatcher consumes the
/// tool_use payload directly and turns it into a Propose message.
pub fn propose_task_tool_def() -> serde_json::Value {
    serde_json::json!({
        "name": "propose_task",
        "description":
            "Propose a structured task when the user is asking for actionable, multi-step work. \
             Do NOT call this for chitchat, clarifying questions, or simple Q&A — for those, \
             just answer in plain text. Call this only when the user wants you to DO, REVIEW, \
             or WATCH something concrete.",
        "input_schema": {
            "type": "object",
            "required": ["archetype", "title", "deliverable", "rationale"],
            "properties": {
                "archetype": {
                    "type": "string",
                    "enum": ["do", "review", "watch"],
                    "description":
                        "'do' = perform the work in a new tab; 'review' = inspect a PR/file; \
                         'watch' = subscribe to a trigger (CI, file touch, exit code)."
                },
                "title":       { "type": "string" },
                "deliverable": { "type": "string", "description": "What the user will get when this is done." },
                "rationale":   { "type": "string", "description": "Why you chose this archetype + scope." },
                "scope": {
                    "type": "object",
                    "properties": {
                        "paths": { "type": "array", "items": { "type": "string" } },
                        "tabs":  { "type": "array", "items": { "type": "string" } }
                    }
                }
            }
        }
    })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-app teammate::tools::tests::propose_task_tool_def_has_required_shape`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/tools.rs
git commit -m "feat(teammate/tools): add propose_task tool definition for structured output"
```

---

## Task 4: Make the LLM dispatcher emit `MessageContent::Propose` when the operator calls `propose_task`

**Files:**
- Modify: `crates/app/src/teammate/llm.rs`

- [ ] **Step 1: Write the failing test**

Append to the `#[cfg(test)] mod tests` block at the bottom of `crates/app/src/teammate/llm.rs`:

```rust
#[test]
fn parse_propose_task_tool_use_builds_propose_content() {
    // Simulate Anthropic content blocks with a tool_use for propose_task.
    let content_blocks = serde_json::json!([
        {
            "type": "tool_use",
            "id": "toolu_01abc",
            "name": "propose_task",
            "input": {
                "archetype": "do",
                "title": "Revisar migración de auth",
                "deliverable": "resumen + lista de riesgos + PR draft",
                "rationale": "user asked for an audit and a write-up",
                "scope": { "paths": ["crates/app/src/auth_mig.rs"] }
            }
        }
    ]);
    let result = extract_propose_from_content(&content_blocks)
        .expect("expected a Propose payload");
    use crate::teammate::types::{MessageContent, TaskArchetype};
    let MessageContent::Propose(p) = result else {
        panic!("expected Propose variant");
    };
    assert!(matches!(p.draft.archetype, TaskArchetype::Do));
    assert_eq!(p.draft.title, "Revisar migración de auth");
    assert_eq!(p.draft.deliverable, "resumen + lista de riesgos + PR draft");
    assert_eq!(p.rationale, "user asked for an audit and a write-up");
    assert_eq!(p.draft.scope.paths.len(), 1);
}

#[test]
fn extract_propose_returns_none_when_no_propose_task_block() {
    let content_blocks = serde_json::json!([
        { "type": "text", "text": "hola" }
    ]);
    assert!(extract_propose_from_content(&content_blocks).is_none());
}
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cargo test -p karl-app teammate::llm::tests::parse_propose_task_tool_use_builds_propose_content`
Expected: FAIL — `extract_propose_from_content` not found.

- [ ] **Step 3: Implement `extract_propose_from_content` and wire it into the dispatch loop**

Add a `pub(crate)` function to `crates/app/src/teammate/llm.rs` (above the `#[cfg(test)]` block):

```rust
/// If the assistant turn contains a `propose_task` tool_use block,
/// build a `MessageContent::Propose` from its input. Returns None if no
/// such block is present. Multiple propose_task calls in one turn:
/// take the first; ignore the rest (the prompt forbids multiples).
pub(crate) fn extract_propose_from_content(
    content: &serde_json::Value,
) -> Option<crate::teammate::MessageContent> {
    let arr = content.as_array()?;
    for block in arr {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
            continue;
        }
        if block.get("name").and_then(|v| v.as_str()) != Some("propose_task") {
            continue;
        }
        let input = block.get("input")?;
        let archetype_s = input.get("archetype")?.as_str()?;
        let archetype = match archetype_s {
            "do"     => crate::teammate::TaskArchetype::Do,
            "review" => crate::teammate::TaskArchetype::Review,
            "watch"  => crate::teammate::TaskArchetype::Watch,
            _ => return None,
        };
        let title = input.get("title")?.as_str()?.to_string();
        let deliverable = input.get("deliverable")?.as_str()?.to_string();
        let rationale = input.get("rationale")?.as_str()?.to_string();
        let scope = input.get("scope")
            .and_then(|s| serde_json::from_value::<crate::teammate::TaskScope>(s.clone()).ok())
            .unwrap_or_default();
        return Some(crate::teammate::MessageContent::Propose(
            crate::teammate::ProposeTask {
                draft: crate::teammate::TaskDraft {
                    archetype, title, deliverable, scope,
                },
                rationale,
            },
        ));
    }
    None
}
```

- [ ] **Step 4: Add the `propose_task` tool to the tools array and short-circuit on Propose in the dispatch loop**

In `dispatch_reply_with_tools` (around line 209), change:

```rust
let tools = vec![tools::read_file_tool_def()];
```
to:
```rust
let tools = vec![tools::read_file_tool_def(), tools::propose_task_tool_def()];
```

Then in the `if stop == "tool_use"` branch (around line 230), BEFORE iterating tool calls, check for `propose_task` first and return early. Replace the existing `if stop == "tool_use" { ... }` block content with:

```rust
if stop == "tool_use" {
    // Fast-path: propose_task is "structured output". If the assistant
    // emitted one, the conversation ends — we surface it as a Propose
    // message instead of looping for more tool calls.
    if let Some(propose) = extract_propose_from_content(&serde_json::Value::Array(resp.content.clone())) {
        return Ok(DispatchOutcome::Propose(propose));
    }

    // 1) Echo the assistant turn back so the next request keeps
    //    the conversation continuous.
    let content_value = serde_json::Value::Array(resp.content.clone());
    messages.push(AnthropicMessage::assistant_blocks(content_value));

    // 2) Execute every tool call in this turn.
    let calls = anthropic_http::collect_tool_uses(&resp.content);
    let mut tool_results: Vec<serde_json::Value> = Vec::with_capacity(calls.len());
    for (id, name, input) in calls {
        let (out_text, ok, err) = match name.as_str() {
            "read_file" => match tools::read_file(&tool_env, &input) {
                Ok(text) => (text, true, None),
                Err(e) => (format!("error: {}", e), false, Some(e.to_string())),
            },
            "propose_task" => {
                // Already handled above — reaching here means the
                // first iteration found no propose; this iteration is
                // ambiguous. Treat as unknown to push the model toward
                // a clean text answer next turn.
                (
                    "propose_task already considered; respond with text now.".into(),
                    false,
                    Some("propose_task in non-leading position".into()),
                )
            }
            _ => (
                format!("unknown tool: {}", name),
                false,
                Some(format!("unknown tool: {}", name)),
            ),
        };
        on_progress(ToolProgress::ToolCall {
            tool: name.clone(),
            args: input,
            ok,
            error: err,
        });
        tool_results.push(serde_json::json!({
            "type": "tool_result",
            "tool_use_id": id,
            "content": out_text,
            "is_error": !ok,
        }));
    }
    messages.push(AnthropicMessage::user_tool_results(
        serde_json::Value::Array(tool_results),
    ));
    continue;
}
```

Note: this changes the return type. Define a new enum near the top of `llm.rs` (under the existing error/types):

```rust
/// What `dispatch_reply_with_tools` returns: either plain assistant text
/// or a structured task proposal that should be persisted as
/// MessageContent::Propose.
#[derive(Debug, Clone)]
pub enum DispatchOutcome {
    Text(String),
    Propose(crate::teammate::MessageContent),
}
```

Change the function signature:

```rust
pub async fn dispatch_reply_with_tools<F>(
    operator: &Operator,
    thread: &[TaskMessage],
    settings: &Settings,
    world_context: Option<&str>,
    tool_env: ToolEnv,
    mut on_progress: F,
) -> Result<DispatchOutcome, TeammateLlmError>
```

And the existing terminal `Ok(text)` returns become `Ok(DispatchOutcome::Text(text))`.

Also change the fallback at the top:
```rust
if resolved.provider.kind() != ProviderKind::Anthropic {
    return dispatch_reply(operator, thread, settings, world_context)
        .await
        .map(DispatchOutcome::Text);
}
```

- [ ] **Step 5: Update the test in step 1 if needed and re-run**

The test calls `extract_propose_from_content` directly, so signature changes to `dispatch_reply_with_tools` don't affect it.

Run: `cargo test -p karl-app teammate::llm::tests`
Expected: both new tests pass; pre-existing tests in `llm.rs` still pass.

- [ ] **Step 6: Fix the call site in `commands.rs`**

In `crates/app/src/teammate/commands.rs`, around line 134 where `dispatch_reply_with_tools` is awaited, replace:

```rust
let reply_text = if let Some(root) = active_cwd {
    // ...
    match crate::teammate::llm::dispatch_reply_with_tools(...).await {
        Ok(t) => t,
        Err(e) => { ... return; }
    }
} else {
    match crate::teammate::llm::dispatch_reply(...).await { ... }
};
let reply_msg = TaskMessage {
    // ... content: MessageContent::Text(reply_text), ...
};
```

with:

```rust
use crate::teammate::llm::DispatchOutcome;
let outcome: DispatchOutcome = if let Some(root) = active_cwd {
    let tool_env = crate::teammate::tools::ToolEnv::new(root, 200 * 1024);
    let app_for_progress = app_bg.clone();
    let op_id_for_progress = operator_id;
    let progress = move |p: crate::teammate::llm::ToolProgress| {
        let payload = serde_json::json!({
            "operator_id": op_id_for_progress,
            "progress": p,
        });
        let _ = app_for_progress.emit("teammate-tool-call", payload);
    };
    match crate::teammate::llm::dispatch_reply_with_tools(
        &operator, &thread, &settings, world_context_opt, tool_env, progress,
    ).await {
        Ok(o) => o,
        Err(e) => {
            tracing::warn!(error = %e, "teammate: tool-use dispatch failed");
            emit_system_error(&app_bg, &storage_bg, operator_id, &format!("{e}")).await;
            return;
        }
    }
} else {
    match crate::teammate::llm::dispatch_reply(
        &operator, &thread, &settings, world_context_opt,
    ).await {
        Ok(t) => DispatchOutcome::Text(t),
        Err(e) => {
            tracing::warn!(error = %e, "teammate: dispatch failed");
            emit_system_error(&app_bg, &storage_bg, operator_id, &format!("{e}")).await;
            return;
        }
    }
};
let reply_content = match outcome {
    DispatchOutcome::Text(t)    => MessageContent::Text(t),
    DispatchOutcome::Propose(c) => c,
};
let reply_msg = TaskMessage {
    id: MessageId::new(),
    operator_id,
    task_id: None,
    role: TmRole::Operator,
    content: reply_content,
    created_at_unix_ms: now_ms(),
    confirmed_at_unix_ms: None,
    dismissed_at_unix_ms: None,
};
```

(The other `TaskMessage { ... }` literals in this file — the user message at line 44 and the system error at line 186 — also need `confirmed_at_unix_ms: None, dismissed_at_unix_ms: None` added.)

- [ ] **Step 7: Build the whole workspace and run all tests**

Run: `cargo build -p karl-app && cargo test -p karl-app`
Expected: clean build; all tests pass.

- [ ] **Step 8: Commit**

```bash
git add crates/app/src/teammate/llm.rs crates/app/src/teammate/commands.rs
git commit -m "feat(teammate/llm): emit MessageContent::Propose when operator calls propose_task"
```

---

## Task 5: Add the four task-lifecycle Tauri commands

**Files:**
- Modify: `crates/app/src/teammate/commands.rs`
- Modify: `crates/app/src/lib.rs` (register commands)

- [ ] **Step 1: Write the failing test**

Append to `crates/app/src/teammate/commands.rs` (inside a new `#[cfg(test)] mod tests { ... }` block at the bottom, or a new file `crates/app/src/teammate/commands_test.rs` imported via `#[cfg(test)] mod commands_test;` in `mod.rs`). Keep it simple and self-contained by directly exercising helper functions, not the Tauri command attributes:

```rust
#[cfg(test)]
mod task_lifecycle_tests {
    use super::*;
    use crate::operator_registry::{Operator, OperatorId, OperatorRegistry, VoiceTone};
    use crate::storage::Storage;
    use crate::teammate::{
        MessageContent, MessageId, ProposeTask, Role, TaskArchetype,
        TaskDraft, TaskMessage, TaskScope,
    };
    use std::sync::Arc;
    use ulid::Ulid;

    async fn seed_storage() -> (Arc<Storage>, OperatorId, MessageId) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        Box::leak(Box::new(dir));
        let storage = Arc::new(Storage::open(&path).unwrap());

        let op_id = OperatorId(Ulid::new());
        storage.operator_upsert(&Operator {
            id: op_id, name: "T".into(), emoji: "🤖".into(), color: "#000".into(),
            tags: vec![], persona: "".into(), escalate_threshold: 0.6,
            model: "x".into(), hard_constraints: "".into(),
            voice: VoiceTone::Terse, is_default: false,
            created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
        }).await.unwrap();

        let msg_id = MessageId::new();
        let msg = TaskMessage {
            id: msg_id,
            operator_id: op_id,
            task_id: None,
            role: Role::Operator,
            content: MessageContent::Propose(ProposeTask {
                draft: TaskDraft {
                    archetype: TaskArchetype::Do,
                    title: "Revisar migración".into(),
                    deliverable: "resumen".into(),
                    scope: TaskScope::default(),
                },
                rationale: "audit".into(),
            }),
            created_at_unix_ms: 1_700_000_000_000,
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
        };
        storage.teammate_insert_message(&msg).await.unwrap();
        (storage, op_id, msg_id)
    }

    #[tokio::test]
    async fn confirm_proposal_creates_task_and_marks_message() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let registry = Arc::new(OperatorRegistry::new_in_memory());
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());

        let task = confirm_task_inner(&storage, &runtime, op_id, msg_id, 1_700_000_000_500)
            .await
            .expect("confirm should succeed");

        assert!(matches!(task.status, crate::teammate::TaskStatus::Active));
        assert!(matches!(task.archetype, crate::teammate::TaskArchetype::Do));
        assert_eq!(task.spawned_session, None, "spawn happens in UI; backend leaves it None initially");

        let fetched = storage.teammate_get_message(msg_id).await.unwrap().unwrap();
        assert_eq!(fetched.confirmed_at_unix_ms, Some(1_700_000_000_500));

        // Operator state should be OnTask.
        let st = runtime.state_of(op_id);
        assert!(matches!(st, Some(crate::teammate::OperatorState::OnTask { .. })));
    }

    #[tokio::test]
    async fn confirm_twice_returns_error() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());
        confirm_task_inner(&storage, &runtime, op_id, msg_id, 1).await.unwrap();
        let err = confirm_task_inner(&storage, &runtime, op_id, msg_id, 2).await.unwrap_err();
        assert!(err.contains("already confirmed"), "got: {err}");
    }

    #[tokio::test]
    async fn cancel_proposal_sets_dismissed() {
        let (storage, _op_id, msg_id) = seed_storage().await;
        cancel_task_proposal_inner(&storage, msg_id, 1_700_000_000_999).await.unwrap();
        let fetched = storage.teammate_get_message(msg_id).await.unwrap().unwrap();
        assert_eq!(fetched.dismissed_at_unix_ms, Some(1_700_000_000_999));
    }
}
```

This references three helpers — `confirm_task_inner`, `cancel_task_proposal_inner`, and `runtime.state_of` — and a constructor `OperatorRegistry::new_in_memory()` / `TeammateRuntime::new()` that already exist (verify; if not, add a minimal `state_of` accessor on the runtime as part of this task).

- [ ] **Step 2: Run the test to confirm it fails**

Run: `cargo test -p karl-app teammate::commands::task_lifecycle_tests`
Expected: FAIL — `confirm_task_inner` / `cancel_task_proposal_inner` not found.

- [ ] **Step 3: Implement the helpers and the Tauri commands**

Append to `crates/app/src/teammate/commands.rs`:

```rust
use crate::teammate::types::{ProposeTask, Task, TaskArchetype, TaskDraft, TaskId, TaskStatus, UpdateKind};
use crate::teammate::runtime::TeammateRuntime;

/// Pure inner: confirm a Propose message → persist a Task → transition
/// operator state. Spawning the actual session happens in the UI (see
/// `teammate_attach_session_to_task`).
pub(crate) async fn confirm_task_inner(
    storage: &Arc<Storage>,
    runtime: &Arc<TeammateRuntime>,
    operator_id: OperatorId,
    message_id: MessageId,
    now_unix_ms: u64,
) -> Result<Task, String> {
    let msg = storage.teammate_get_message(message_id).await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "message not found".to_string())?;
    if msg.confirmed_at_unix_ms.is_some() {
        return Err("proposal already confirmed".into());
    }
    if msg.dismissed_at_unix_ms.is_some() {
        return Err("proposal was cancelled".into());
    }
    let propose = match msg.content {
        MessageContent::Propose(p) => p,
        _ => return Err("message is not a proposal".into()),
    };
    if msg.operator_id != operator_id {
        return Err("operator mismatch".into());
    }

    let task = Task {
        id: TaskId::new(),
        operator_id,
        archetype: propose.draft.archetype,
        title: propose.draft.title.clone(),
        body: propose.rationale.clone(),
        deliverable: propose.draft.deliverable.clone(),
        status: TaskStatus::Active,
        scope: propose.draft.scope.clone(),
        spawned_session: None,
        created_at_unix_ms: now_unix_ms,
        updated_at_unix_ms: now_unix_ms,
        completed_at_unix_ms: None,
        cost_usd_cents: 0,
    };
    storage.teammate_insert_task(&task).await.map_err(|e| e.to_string())?;
    storage.teammate_mark_message_confirmed(message_id, now_unix_ms).await
        .map_err(|e| e.to_string())?;
    runtime.start_task(operator_id, task.id, None).map_err(|e| e.to_string())?;

    // Append a TaskUpdate::Started message so the chat shows progress.
    let started = TaskMessage {
        id: MessageId::new(),
        operator_id,
        task_id: Some(task.id),
        role: Role::System,
        content: MessageContent::TaskUpdate { task: task.id, kind: UpdateKind::Started },
        created_at_unix_ms: now_unix_ms,
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
    };
    storage.teammate_insert_message(&started).await.map_err(|e| e.to_string())?;
    Ok(task)
}

pub(crate) async fn cancel_task_proposal_inner(
    storage: &Arc<Storage>,
    message_id: MessageId,
    now_unix_ms: u64,
) -> Result<(), String> {
    let msg = storage.teammate_get_message(message_id).await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "message not found".to_string())?;
    if msg.confirmed_at_unix_ms.is_some() {
        return Err("proposal already confirmed".into());
    }
    if !matches!(msg.content, MessageContent::Propose(_)) {
        return Err("message is not a proposal".into());
    }
    storage.teammate_mark_message_dismissed(message_id, now_unix_ms).await
        .map_err(|e| e.to_string())
}

pub(crate) async fn edit_task_proposal_inner(
    storage: &Arc<Storage>,
    message_id: MessageId,
    new_draft: TaskDraft,
) -> Result<(), String> {
    let msg = storage.teammate_get_message(message_id).await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "message not found".to_string())?;
    let existing = match msg.content {
        MessageContent::Propose(p) => p,
        _ => return Err("message is not a proposal".into()),
    };
    if msg.confirmed_at_unix_ms.is_some() || msg.dismissed_at_unix_ms.is_some() {
        return Err("proposal is closed".into());
    }
    let updated = MessageContent::Propose(ProposeTask {
        draft: new_draft,
        rationale: existing.rationale,
    });
    storage.teammate_update_message_content(message_id, &updated).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_confirm_task(
    app: tauri::AppHandle,
    storage: State<'_, Arc<Storage>>,
    runtime: State<'_, Arc<TeammateRuntime>>,
    operator_id: OperatorId,
    message_id: MessageId,
) -> Result<Task, String> {
    use tauri::Emitter;
    let now = now_unix_ms();
    let task = confirm_task_inner(storage.inner(), runtime.inner(), operator_id, message_id, now).await?;
    let _ = app.emit("teammate-task", &task);
    // Also surface the TaskUpdate::Started message to the rail.
    if let Ok(thread) = storage.teammate_list_messages(operator_id, 1).await {
        if let Some(last) = thread.last() {
            let _ = app.emit("teammate-message", last);
        }
    }
    Ok(task)
}

#[tauri::command]
pub async fn teammate_cancel_task_proposal(
    storage: State<'_, Arc<Storage>>,
    message_id: MessageId,
) -> Result<(), String> {
    cancel_task_proposal_inner(storage.inner(), message_id, now_unix_ms()).await
}

#[tauri::command]
pub async fn teammate_edit_task_proposal(
    storage: State<'_, Arc<Storage>>,
    message_id: MessageId,
    draft: TaskDraft,
) -> Result<(), String> {
    edit_task_proposal_inner(storage.inner(), message_id, draft).await
}

#[tauri::command]
pub async fn teammate_attach_session_to_task(
    app: tauri::AppHandle,
    storage: State<'_, Arc<Storage>>,
    runtime: State<'_, Arc<TeammateRuntime>>,
    operator_id: OperatorId,
    task_id: TaskId,
    session_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let session = session_id.parse::<karl_session::SessionId>()
        .map_err(|e| format!("bad session id: {e}"))?;
    let now = now_unix_ms();
    storage.teammate_update_task_spawned_session(task_id, session, now).await
        .map_err(|e| e.to_string())?;
    // Transition runtime: the operator was OnTask { session: None } —
    // finish_task then start_task with the session. (Runtime currently
    // rejects start_task when already OnTask, so we update by swapping.)
    let _ = runtime.finish_task(operator_id, task_id);
    runtime.start_task(operator_id, task_id, Some(session)).map_err(|e| e.to_string())?;
    let _ = app.emit("teammate-task", serde_json::json!({
        "task_id": task_id,
        "spawned_session": session.to_string(),
    }));
    Ok(())
}

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
```

Replace the existing `teammate_list_tasks` stub with:

```rust
#[tauri::command]
pub async fn teammate_list_tasks(
    storage: State<'_, Arc<Storage>>,
    operator_id: OperatorId,
) -> Result<Vec<Task>, String> {
    storage.teammate_list_tasks_for_operator(operator_id).await
        .map_err(|e| e.to_string())
}
```

Add a `state_of` method to `TeammateRuntime` if it doesn't exist. In `crates/app/src/teammate/runtime.rs`:

```rust
pub fn state_of(&self, op: OperatorId) -> Option<OperatorState> {
    self.state.blocking_lock().get(&op).cloned()
}
```

(Use whatever lock primitive the runtime uses today — match the existing pattern in that file.)

- [ ] **Step 4: Register the new commands in `lib.rs`**

In `crates/app/src/lib.rs`, find the `invoke_handler` registration (the one that includes `teammate_send_text_message` and `teammate_list_tasks`) and add:

```rust
crate::teammate::commands::teammate_confirm_task,
crate::teammate::commands::teammate_cancel_task_proposal,
crate::teammate::commands::teammate_edit_task_proposal,
crate::teammate::commands::teammate_attach_session_to_task,
```

Make sure `TeammateRuntime` is registered as managed state. Search for `TeammateRuntime::new` — if it's already created and `.manage()`d, nothing to do. If not, in the `tauri::Builder::default()` chain add:

```rust
.manage(Arc::new(crate::teammate::runtime::TeammateRuntime::new()))
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cargo test -p karl-app teammate::commands::task_lifecycle_tests`
Expected: all three tests PASS.

- [ ] **Step 6: Run full crate tests**

Run: `cargo test -p karl-app`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/teammate/commands.rs crates/app/src/teammate/runtime.rs crates/app/src/lib.rs
git commit -m "feat(teammate/commands): add confirm/cancel/edit/attach_session task lifecycle"
```

---

## Task 6: Update the frontend API types and wrappers

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Replace the `TeammateContent` union with a fully tagged union**

In `ui/src/api.ts`, replace lines 310–326 (the Teammate types block) with:

```ts
export type TeammateRole = "user" | "operator" | "system";

export type TaskArchetype = "do" | "review" | "watch";
export type TaskStatus    = "draft" | "active" | "blocked" | "done" | "cancelled";
export type UpdateKind    = "started" | "progress" | "blocked" | "resumed" | "completed" | "cancelled";

export interface TaskScope {
  paths?: string[];
  tabs?:  string[];
  watch_predicate?: unknown;
}

export interface TaskDraft {
  archetype:   TaskArchetype;
  title:       string;
  deliverable: string;
  scope:       TaskScope;
}

export interface ProposeTask {
  draft:     TaskDraft;
  rationale: string;
}

export interface TaskReport {
  summary:      string;
  artifact_ids: string[];
}

export interface Task {
  id: string;
  operator_id: string;
  archetype: TaskArchetype;
  title: string;
  body: string;
  deliverable: string;
  status: TaskStatus;
  scope: TaskScope;
  spawned_session: string | null;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
  completed_at_unix_ms: number | null;
  cost_usd_cents: number;
}

export type TeammateContent =
  | { kind: "text";        data: string }
  | { kind: "task_draft";  data: TaskDraft }
  | { kind: "task_update"; data: { task: string; kind: UpdateKind } }
  | { kind: "propose";     data: ProposeTask }
  | { kind: "report";      data: TaskReport };

export interface TeammateMessage {
  id: string;
  operator_id: string;
  task_id: string | null;
  role: TeammateRole;
  content: TeammateContent;
  created_at_unix_ms: number;
  confirmed_at_unix_ms: number | null;
  dismissed_at_unix_ms: number | null;
}
```

- [ ] **Step 2: Add the new wrappers right after `teammateSendText`**

```ts
export async function teammateConfirmTask(
  operatorId: string,
  messageId: string,
): Promise<Task> {
  return invoke<Task>("teammate_confirm_task", { operatorId, messageId });
}

export async function teammateCancelTaskProposal(
  messageId: string,
): Promise<void> {
  return invoke<void>("teammate_cancel_task_proposal", { messageId });
}

export async function teammateEditTaskProposal(
  messageId: string,
  draft: TaskDraft,
): Promise<void> {
  return invoke<void>("teammate_edit_task_proposal", { messageId, draft });
}

export async function teammateAttachSessionToTask(
  operatorId: string,
  taskId: string,
  sessionId: string,
): Promise<void> {
  return invoke<void>("teammate_attach_session_to_task", {
    operatorId, taskId, sessionId,
  });
}

export async function teammateListTasks(operatorId: string): Promise<Task[]> {
  return invoke<Task[]>("teammate_list_tasks", { operatorId });
}

export async function onTeammateTask(
  handler: (task: Task) => void,
): Promise<() => void> {
  const { listen } = await import("@tauri-apps/api/event");
  const unlisten = await listen<Task>("teammate-task", (e) => handler(e.payload));
  return unlisten;
}
```

- [ ] **Step 3: Verify TypeScript compiles**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

If `panel.ts` references `msg.content.kind` or the `TeammateOther` union shape, fix those in the next task — for now, if tsc errors point only to `panel.ts`, that's expected and fixed in Task 8.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui/api): tighten teammate content union; add task lifecycle wrappers"
```

---

## Task 7: Build the task card component

**Files:**
- Create: `ui/src/teammate/task-card.ts`
- Create: `ui/src/teammate/task-card.test.ts`

- [ ] **Step 1: Write failing tests**

Create `ui/src/teammate/task-card.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { renderTaskCard } from "./task-card";
import type { ProposeTask, TeammateMessage } from "../api";

function sampleMessage(confirmed = false, dismissed = false): TeammateMessage {
  const propose: ProposeTask = {
    draft: {
      archetype: "do",
      title: "Revisar migración de auth",
      deliverable: "resumen + riesgos + PR draft",
      scope: { paths: ["crates/app/src/auth_mig.rs"] },
    },
    rationale: "user asked for an audit",
  };
  return {
    id: "msg1",
    operator_id: "op1",
    task_id: null,
    role: "operator",
    content: { kind: "propose", data: propose },
    created_at_unix_ms: 0,
    confirmed_at_unix_ms: confirmed ? 1 : null,
    dismissed_at_unix_ms: dismissed ? 1 : null,
  };
}

describe("renderTaskCard", () => {
  it("renders archetype badge, title, deliverable, scope, and three buttons", () => {
    const el = renderTaskCard(sampleMessage(), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(),
    });
    expect(el.querySelector('[data-archetype="do"]')).not.toBeNull();
    expect(el.textContent).toContain("Revisar migración de auth");
    expect(el.textContent).toContain("resumen + riesgos + PR draft");
    expect(el.textContent).toContain("crates/app/src/auth_mig.rs");
    expect(el.querySelector('[data-action="confirm"]')).not.toBeNull();
    expect(el.querySelector('[data-action="edit"]')).not.toBeNull();
    expect(el.querySelector('[data-action="cancel"]')).not.toBeNull();
  });

  it("invokes onConfirm when Confirmar is clicked", () => {
    const onConfirm = vi.fn();
    const el = renderTaskCard(sampleMessage(), {
      onConfirm, onCancel: vi.fn(), onEdit: vi.fn(),
    });
    (el.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("shows confirmed state and disables buttons when already confirmed", () => {
    const el = renderTaskCard(sampleMessage(true), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(),
    });
    expect(el.classList.contains("task-card--confirmed")).toBe(true);
    const confirmBtn = el.querySelector('[data-action="confirm"]') as HTMLButtonElement;
    expect(confirmBtn.disabled).toBe(true);
  });

  it("shows cancelled state when dismissed", () => {
    const el = renderTaskCard(sampleMessage(false, true), {
      onConfirm: vi.fn(), onCancel: vi.fn(), onEdit: vi.fn(),
    });
    expect(el.classList.contains("task-card--cancelled")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `cd ui && npx vitest run src/teammate/task-card.test.ts`
Expected: file not found / module resolution error.

- [ ] **Step 3: Implement `renderTaskCard`**

Create `ui/src/teammate/task-card.ts`:

```ts
import type { ProposeTask, TaskArchetype, TeammateMessage } from "../api";

export interface TaskCardHandlers {
  onConfirm: (messageId: string) => void;
  onCancel:  (messageId: string) => void;
  onEdit:    (messageId: string) => void;
}

const ARCHETYPE_LABEL: Record<TaskArchetype, string> = {
  do: "Do", review: "Review", watch: "Watch",
};

export function renderTaskCard(
  msg: TeammateMessage,
  handlers: TaskCardHandlers,
): HTMLElement {
  if (msg.content.kind !== "propose") {
    throw new Error(`renderTaskCard called with non-propose content: ${msg.content.kind}`);
  }
  const propose: ProposeTask = msg.content.data;
  const { archetype, title, deliverable, scope } = propose.draft;

  const card = document.createElement("div");
  card.className = "task-card";
  card.dataset.messageId = msg.id;
  const confirmed = msg.confirmed_at_unix_ms !== null;
  const cancelled = msg.dismissed_at_unix_ms !== null;
  if (confirmed) card.classList.add("task-card--confirmed");
  if (cancelled) card.classList.add("task-card--cancelled");

  const header = document.createElement("div");
  header.className = "task-card__header";
  const badge = document.createElement("span");
  badge.className = "task-card__badge";
  badge.dataset.archetype = archetype;
  badge.textContent = ARCHETYPE_LABEL[archetype];
  const titleEl = document.createElement("span");
  titleEl.className = "task-card__title";
  titleEl.textContent = title;
  header.append(badge, titleEl);

  const rows = document.createElement("dl");
  rows.className = "task-card__rows";
  rows.append(
    row("Archetype", `${ARCHETYPE_LABEL[archetype]} · ${archetypeHint(archetype)}`),
    row("Deliverable", deliverable),
  );
  const scopeStr = formatScope(scope);
  if (scopeStr) rows.append(row("Scope", scopeStr));

  const actions = document.createElement("div");
  actions.className = "task-card__actions";
  const confirmBtn = button("confirm", "Confirmar", () => handlers.onConfirm(msg.id));
  const editBtn    = button("edit",    "Editar",    () => handlers.onEdit(msg.id));
  const cancelBtn  = button("cancel",  "Cancelar",  () => handlers.onCancel(msg.id));
  if (confirmed || cancelled) {
    confirmBtn.disabled = true;
    editBtn.disabled = true;
    cancelBtn.disabled = true;
  }
  actions.append(confirmBtn, editBtn, cancelBtn);

  if (confirmed) {
    const footer = document.createElement("div");
    footer.className = "task-card__footer";
    footer.textContent = "confirmed";
    card.append(header, rows, actions, footer);
  } else if (cancelled) {
    const footer = document.createElement("div");
    footer.className = "task-card__footer";
    footer.textContent = "cancelled";
    card.append(header, rows, actions, footer);
  } else {
    card.append(header, rows, actions);
  }
  return card;
}

function row(label: string, value: string): HTMLElement {
  const dt = document.createElement("dt"); dt.textContent = label;
  const dd = document.createElement("dd"); dd.textContent = value;
  const wrap = document.createElement("div");
  wrap.className = "task-card__row";
  wrap.append(dt, dd);
  return wrap;
}

function button(action: "confirm" | "edit" | "cancel", label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.dataset.action = action;
  b.className = `task-card__btn task-card__btn--${action}`;
  b.textContent = label;
  b.addEventListener("click", onClick);
  return b;
}

function archetypeHint(a: TaskArchetype): string {
  switch (a) {
    case "do":     return "spawnea tab nuevo";
    case "review": return "inspecciona PR/archivo";
    case "watch":  return "suscribe a trigger";
  }
}

function formatScope(scope: { paths?: string[]; tabs?: string[] }): string {
  const parts: string[] = [];
  if (scope.paths?.length) parts.push(scope.paths.join(", "));
  if (scope.tabs?.length)  parts.push(`tabs: ${scope.tabs.length}`);
  return parts.join(" · ");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && npx vitest run src/teammate/task-card.test.ts`
Expected: all 4 tests PASS.

- [ ] **Step 5: Add minimal CSS for the card**

Open `ui/src/styles.css` and append:

```css
.task-card {
  border: 1px solid var(--border-soft, rgba(255,255,255,0.08));
  border-radius: 10px;
  padding: 12px;
  background: var(--surface-elevated, #1c1c20);
  margin: 4px 0;
  max-width: 360px;
}
.task-card__header { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
.task-card__badge {
  font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: rgba(160, 120, 220, 0.18); color: #c8a8ff;
}
.task-card__badge[data-archetype="review"] { background: rgba(80, 200, 120, 0.18); color: #88e3a8; }
.task-card__badge[data-archetype="watch"]  { background: rgba(240, 180, 80,  0.18); color: #f0c870; }
.task-card__title { font-weight: 600; }
.task-card__rows { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin: 0; font-size: 12px; }
.task-card__row { display: contents; }
.task-card__row dt { color: var(--text-dim, #888); }
.task-card__row dd { margin: 0; }
.task-card__actions { display: flex; gap: 8px; margin-top: 10px; }
.task-card__btn {
  padding: 6px 12px; border-radius: 6px; font-size: 12px; cursor: pointer;
  border: 1px solid var(--border-soft, rgba(255,255,255,0.10));
  background: transparent; color: inherit;
}
.task-card__btn--confirm { background: #3b82f6; color: white; border-color: transparent; }
.task-card__btn[disabled] { opacity: 0.45; cursor: default; }
.task-card--confirmed .task-card__btn--confirm { background: rgba(80, 200, 120, 0.20); color: #88e3a8; }
.task-card--cancelled  { opacity: 0.55; }
.task-card__footer { margin-top: 8px; font-size: 11px; color: var(--text-dim, #888); }
```

- [ ] **Step 6: Commit**

```bash
git add ui/src/teammate/task-card.ts ui/src/teammate/task-card.test.ts ui/src/styles.css
git commit -m "feat(ui/teammate): task card component for Propose messages"
```

---

## Task 8: Render task cards inside the DM and wire confirm → spawn tab → attach session

**Files:**
- Modify: `ui/src/teammate/panel.ts`
- Modify: `ui/src/teammate/panel.test.ts`

- [ ] **Step 1: Write failing test for Propose rendering and confirm flow**

Append to `ui/src/teammate/panel.test.ts`:

```ts
describe("TeammatePanel propose rendering", () => {
  it("renders a task card for propose messages and dispatches confirm", async () => {
    const operator = {
      id: "op1", name: "Mibli", emoji: "🧪", color: "#aaa",
      tags: [], persona: "", escalate_threshold: 0.6,
      model: "claude-sonnet-4-6", hard_constraints: "",
      voice: "terse", is_default: true,
      created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
    } as unknown as import("../api").Operator;

    const proposeMsg: import("../api").TeammateMessage = {
      id: "msg-propose",
      operator_id: "op1",
      task_id: null,
      role: "operator",
      content: {
        kind: "propose",
        data: {
          draft: {
            archetype: "do",
            title: "Revisar migración de auth",
            deliverable: "resumen",
            scope: { paths: ["crates/app/src/auth_mig.rs"] },
          },
          rationale: "audit",
        },
      },
      created_at_unix_ms: 0,
      confirmed_at_unix_ms: null,
      dismissed_at_unix_ms: null,
    };

    const confirmTask = vi.fn().mockResolvedValue({
      id: "task-1", operator_id: "op1", archetype: "do", title: "Revisar migración de auth",
      body: "", deliverable: "resumen", status: "active",
      scope: { paths: ["crates/app/src/auth_mig.rs"] },
      spawned_session: null,
      created_at_unix_ms: 1, updated_at_unix_ms: 1, completed_at_unix_ms: null,
      cost_usd_cents: 0,
    });
    const createTab = vi.fn().mockResolvedValue({ sessionId: "S-NEW" });
    const attachSession = vi.fn().mockResolvedValue(undefined);

    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new TeammatePanel(host, {
      listMessages: async () => [proposeMsg],
      sendText:     async () => proposeMsg,
      listOperators: async () => [operator],
      onMessage:    async () => () => {},
      onToolCall:   async () => () => {},
      confirmTask,
      cancelTaskProposal: vi.fn(),
      editTaskProposal:   vi.fn(),
      attachSessionToTask: attachSession,
      spawnTabForTask: createTab,
    });
    await panel.openFor(operator);

    const card = host.querySelector(".task-card") as HTMLElement;
    expect(card).not.toBeNull();
    (card.querySelector('[data-action="confirm"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(confirmTask).toHaveBeenCalledWith("op1", "msg-propose");
    expect(createTab).toHaveBeenCalled();
    expect(attachSession).toHaveBeenCalledWith("op1", "task-1", "S-NEW");
  });
});
```

- [ ] **Step 2: Extend `TeammatePanelDeps` and wire injection**

At the top of `ui/src/teammate/panel.ts`, extend the imports:

```ts
import type { Operator, Task, TeammateMessage, TeammateToolCall } from "../api";
import {
  onTeammateMessage, onTeammateToolCall, operatorLevelFromXp, operatorList,
  teammateAttachSessionToTask, teammateCancelTaskProposal, teammateConfirmTask,
  teammateEditTaskProposal, teammateListMessages, teammateSendText,
} from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { renderTaskCard } from "./task-card";
```

Extend `TeammatePanelDeps`:

```ts
export interface TeammatePanelDeps {
  listMessages:  (operatorId: string, limit?: number) => Promise<TeammateMessage[]>;
  sendText:      (operatorId: string, text: string, activeSessionId?: string | null) => Promise<TeammateMessage>;
  listOperators: () => Promise<Operator[]>;
  onMessage?:    (handler: (msg: TeammateMessage) => void) => Promise<() => void>;
  onToolCall?:   (handler: (call: TeammateToolCall) => void) => Promise<() => void>;
  getActiveSessionId?: () => string | null;
  confirmTask?:        (operatorId: string, messageId: string) => Promise<Task>;
  cancelTaskProposal?: (messageId: string) => Promise<void>;
  editTaskProposal?:   (messageId: string, draft: import("../api").TaskDraft) => Promise<void>;
  attachSessionToTask?: (operatorId: string, taskId: string, sessionId: string) => Promise<void>;
  /// Wraps tabsManager.createTab. Returned shape gives the new SessionId
  /// once the tab is mounted and the backend spawn has completed.
  spawnTabForTask?: (task: Task) => Promise<{ sessionId: string }>;
}

const DEFAULT_DEPS: TeammatePanelDeps = {
  listMessages:  teammateListMessages,
  sendText:      teammateSendText,
  listOperators: operatorList,
  onMessage:     onTeammateMessage,
  onToolCall:    onTeammateToolCall,
  confirmTask:         teammateConfirmTask,
  cancelTaskProposal:  teammateCancelTaskProposal,
  editTaskProposal:    teammateEditTaskProposal,
  attachSessionToTask: teammateAttachSessionToTask,
  // spawnTabForTask is wired by the caller that owns tabsManager — see
  // the panel mount site in main.ts (Task 9).
};
```

- [ ] **Step 3: Update `paintMessage` to render task cards**

Find the existing `paintMessage` method (around line 170–210 in `panel.ts`). Replace the early `if (msg.content.kind !== "text") return;` line with a switch:

```ts
private paintMessage(msg: TeammateMessage): void {
  if (!this.threadEl) return;
  switch (msg.content.kind) {
    case "text":
      this.paintTextBubble(msg);
      return;
    case "propose":
      this.paintProposeCard(msg);
      return;
    case "task_update":
      this.paintSystemLine(msg, taskUpdateSummary(msg.content.data.kind));
      return;
    case "task_draft":
    case "report":
      // MVP: render as a small system line; full rendering arrives with
      // the OPERATORS page increment.
      this.paintSystemLine(msg, `(${msg.content.kind})`);
      return;
  }
}
```

Refactor the existing bubble-rendering code into `paintTextBubble(msg)` (move the body of the old `paintMessage` there, dropping the early-return guard).

Add the two new helpers:

```ts
private paintProposeCard(msg: TeammateMessage): void {
  if (!this.threadEl) return;
  const card = renderTaskCard(msg, {
    onConfirm: (id) => { void this.handleConfirm(id, msg); },
    onCancel:  (id) => { void this.handleCancel(id); },
    onEdit:    (id) => { this.openEditDialog(id, msg); },
  });
  const wrap = document.createElement("div");
  wrap.className = "teammate-row teammate-row--operator";
  wrap.appendChild(card);
  this.threadEl.appendChild(wrap);
  this.scrollToBottom();
}

private paintSystemLine(msg: TeammateMessage, text: string): void {
  if (!this.threadEl) return;
  const row = document.createElement("div");
  row.className = "teammate-row teammate-row--system";
  row.textContent = text;
  this.threadEl.appendChild(row);
  this.scrollToBottom();
}

private async handleConfirm(messageId: string, msg: TeammateMessage): Promise<void> {
  if (!this.operator) return;
  const { confirmTask, spawnTabForTask, attachSessionToTask } = this.deps;
  if (!confirmTask) return;
  try {
    const task = await confirmTask(this.operator.id, messageId);
    if (task.archetype === "do" && spawnTabForTask && attachSessionToTask) {
      const { sessionId } = await spawnTabForTask(task);
      await attachSessionToTask(this.operator.id, task.id, sessionId);
    }
    // Re-render the original message with confirmed state. Simplest:
    // re-fetch the thread.
    if (this.operator) {
      const refreshed = await this.deps.listMessages(this.operator.id, 200);
      this.paintMessages(refreshed);
    }
  } catch (e) {
    console.error("confirmTask failed", e);
  }
}

private async handleCancel(messageId: string): Promise<void> {
  const { cancelTaskProposal } = this.deps;
  if (!cancelTaskProposal || !this.operator) return;
  try {
    await cancelTaskProposal(messageId);
    const refreshed = await this.deps.listMessages(this.operator.id, 200);
    this.paintMessages(refreshed);
  } catch (e) {
    console.error("cancelTaskProposal failed", e);
  }
}

private openEditDialog(messageId: string, msg: TeammateMessage): void {
  // MVP: prompt-based edit. Replace with inline form in a later
  // increment. For Do tasks the title is the only critical field
  // a user usually wants to tweak.
  if (msg.content.kind !== "propose") return;
  const current = msg.content.data.draft;
  const nextTitle = window.prompt("Editar título de la tarea:", current.title);
  if (!nextTitle || nextTitle === current.title) return;
  const { editTaskProposal } = this.deps;
  if (!editTaskProposal || !this.operator) return;
  void editTaskProposal(messageId, { ...current, title: nextTitle })
    .then(() => this.deps.listMessages(this.operator!.id, 200))
    .then((refreshed) => this.paintMessages(refreshed))
    .catch((e) => console.error("editTaskProposal failed", e));
}
```

Add a helper at module scope:

```ts
function taskUpdateSummary(kind: import("../api").UpdateKind): string {
  switch (kind) {
    case "started":   return "tab abierto · tarea iniciada";
    case "progress":  return "actualización en curso";
    case "blocked":   return "bloqueado";
    case "resumed":   return "retomada";
    case "completed": return "completada";
    case "cancelled": return "cancelada";
  }
}
```

- [ ] **Step 4: Run the new test**

Run: `cd ui && npx vitest run src/teammate/panel.test.ts`
Expected: PASS.

- [ ] **Step 5: Run all UI tests**

Run: `cd ui && npx vitest run`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/teammate/panel.ts ui/src/teammate/panel.test.ts
git commit -m "feat(ui/teammate): render task cards inline; wire confirm/edit/cancel"
```

---

## Task 9: Wire `spawnTabForTask` at the panel mount site

**Files:**
- Modify: `ui/src/main.ts` (or wherever `TeammatePanel` is constructed — search for `new TeammatePanel(`)

- [ ] **Step 1: Find the panel construction site**

Run: `grep -rn "new TeammatePanel" ui/src/`
Expected: a single hit (likely in `main.ts` or a sidebar mount file).

- [ ] **Step 2: Inject `spawnTabForTask`**

At that construction site, replace `new TeammatePanel(host)` (or `new TeammatePanel(host, {...})`) with:

```ts
new TeammatePanel(host, {
  // keep any existing deps...
  spawnTabForTask: async (task) => {
    // tabsManager is the existing TabsManager singleton — adjust import path.
    const tab = await tabsManager.createTab({
      customName: `${operator?.name ?? "task"} · ${task.title.slice(0, 24)}`,
      cwd: null, // root of project; later increments may use task.scope.paths[0]
    });
    if (!tab) throw new Error("createTab returned null");
    // Tab exposes its session id once spawned. createTab in this
    // codebase awaits spawn before returning, so tab.sessionId is set.
    const sessionId = (tab as { sessionId?: string }).sessionId;
    if (!sessionId) throw new Error("tab has no sessionId after createTab");
    return { sessionId };
  },
});
```

Note: If `tab.sessionId` is not directly exposed, look for a property/method on `Tab` that returns the backing `SessionId` (e.g. `tab.id`, `tab.session`, or a getter). Use that. Inspect `ui/src/tabs/manager.ts` around line 1720+ to confirm the field name and adjust.

- [ ] **Step 3: Run the dev build and verify the chat path still type-checks**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(ui/teammate): wire spawnTabForTask via tabsManager.createTab"
```

---

## Task 10: Manual smoke test

**Files:** none

- [ ] **Step 1: Run the app**

Use the `/run` skill (or `npm run tauri dev` from the repo root if invoking yourself).
Expected: app launches; no compile errors.

- [ ] **Step 2: Open DM with Mibli**

Open the teammate rail (right sidebar). Select Mibli.

- [ ] **Step 3: Send the trigger prompt**

Type: `Mibli, revisa la migración de auth y dime qué romperías`.

Expected:
- Operator replies with a task card showing `Do · Revisar migración de auth`, deliverable, scope (or no scope if model omitted), and three buttons.

- [ ] **Step 4: Click Confirmar**

Expected:
- A new tab opens (named e.g. `Mibli · Revisar migración…`).
- The card flips to confirmed state ("confirmed" footer; buttons disabled).
- A system line `tab abierto · tarea iniciada` appears below the card.

- [ ] **Step 5: Send a chitchat message and verify no card**

Type: `hola`.
Expected: regular text bubble reply, no card. (The tool description should keep the LLM from proposing a task here.)

- [ ] **Step 6: Send another actionable prompt, then click Cancelar**

Type: `Mibli, abre el dashboard de Grafana`.
On the resulting card, click Cancelar.
Expected: card shows "cancelled" state; no tab spawned.

- [ ] **Step 7: Commit any UX adjustments observed during smoke**

If any styling or copy needs tweaking, do it in this step. Otherwise skip.

```bash
# (only if changes made)
git add -A
git commit -m "fix(ui/teammate): smoke-test polish"
```

---

## Self-Review

**Spec coverage check (against `docs/superpowers/specs/2026-05-22-teammate-task-cards-design.md`):**

- `propose_task` tool def → Task 3 ✓
- LLM dispatcher emits `MessageContent::Propose` → Task 4 ✓
- `teammate_confirm_task` → Task 5 ✓
- `teammate_cancel_task_proposal` → Task 5 ✓
- `teammate_edit_task_proposal` → Task 5 ✓
- Real `teammate_list_tasks` → Task 5 ✓
- Schema alters for confirmed/dismissed timestamps → Task 1 ✓
- Storage helpers (get_message, mark_confirmed, mark_dismissed, update_content, list_tasks_for_operator, update_task_spawned_session) → Task 2 ✓
- `task-card.ts` renderer with archetype badge, three buttons, confirmed/cancelled states → Task 7 ✓
- `TeammateContent` tagged union + new API wrappers → Task 6 ✓
- `panel.ts` switches on `content.kind`; renders task_update as system line → Task 8 ✓
- Confirm flow spawns a tab and attaches session → Task 8 + Task 9 ✓
- LLM/commands/storage unit tests → Tasks 2/3/4/5 ✓
- UI tests for card rendering + confirm click → Tasks 7/8 ✓
- Manual smoke → Task 10 ✓

**Spec note on `Do` archetype spawning:** The spec said `teammate_confirm_task` would call `SessionManager::spawn`. The actual `spawn_session` Tauri command requires UI `Channel`s for xterm.js wiring, so spawning from the backend command alone isn't viable. We split the responsibility: backend creates the Task with `spawned_session=None` and transitions state; UI calls `tabsManager.createTab` and then `teammate_attach_session_to_task` to bind the session. This is a more accurate reflection of the existing tab/session ownership model and is documented in Task 5 / Task 8 / Task 9.

**Placeholder scan:** no TBDs; every code step has full code.

**Type consistency:** `TaskArchetype`, `TaskDraft`, `Task`, `MessageContent::Propose`, `ProposeTask`, `UpdateKind` referenced consistently across Rust/TS. The new `TeammateMessage.confirmed_at_unix_ms` / `dismissed_at_unix_ms` fields are added in Task 2 and surfaced in API + UI in Task 6 / Task 7.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-22-teammate-task-cards.md`.**
