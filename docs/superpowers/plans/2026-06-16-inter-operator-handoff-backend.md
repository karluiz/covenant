# Inter-Operator Handoff — Backend Core Implementation Plan (Plan 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let one operator autonomously hand a unit of work to another operator — gated by a safety check, persisted as a delegation edge, materialized as a receiver `Task`, and reported back into the delegator's thread on completion.

**Architecture:** A new `handoff_task` "structured-output" tool (mirroring `propose_task`) produces a `DispatchOutcome::Handoff`. A router module resolves the target operator, derives the delegation chain, runs a pure safety gate, persists a `Handoff` edge, and creates the receiver `Task` (claiming the receiver in the runtime, leaving `spawned_session` for the UI to attach in Plan 2). The `task_supervisor` detects the receiver task finishing and injects a report message into the delegator's thread, marking the edge `Reported` and lighting up the dormant `good_delegate` achievement. This plan is entirely backend + unit-testable; the UI auto-spawn, delegator re-engagement, and Convergence graph are **Plan 2**.

**Tech Stack:** Rust, Tokio, `rusqlite` (sync via `spawn_blocking`), `ulid`, `serde_json`, `thiserror`. Tests use `#[tokio::test]` and the existing in-memory storage/runtime test helpers.

**Spec:** `docs/superpowers/specs/2026-06-16-inter-operator-handoff-design.md`

---

## Resolved design decisions (locked for this plan)

- **No `Task.source` field.** Provenance is derived from the `teammate_handoffs` table (a task is "delegated" iff a handoff row references its `task_id`). This avoids a `tasks`-schema migration — supersedes §4's "metadata" note in the spec.
- **`Handoff.task_id` is `Option<TaskId>`.** Rejected/blocked handoffs persist an edge with `task_id = None` for audit; only accepted handoffs carry a task.
- **Report-back reuses `MessageContent::Text`.** No new `MessageContent` variant (keeps message storage untouched); the report is a formatted system Text message in the delegator's thread.
- **Receiver "busy" = `OperatorState::OnTask`.** v1 concurrency cap = 1 (matches the one-task-per-operator runtime).
- **Executor travels in the `HandoffRouted` event, not on `Task`** (the `Task` struct has no executor field today; the UI reads it from the event in Plan 2).

## File Structure

| File | Responsibility | New? |
|---|---|---|
| `crates/app/src/teammate/types.rs` | `HandoffId`, `ChainId`, `HandoffStatus`, `Handoff`, `HandoffRequest` | modify |
| `crates/app/src/storage.rs` | `teammate_handoffs` table + insert/get-by-task/update-status/list-by-chain | modify |
| `crates/app/src/teammate/handoff_safety.rs` | pure safety gate (`decide`) + tests | **create** |
| `crates/app/src/teammate/handoff.rs` | `route()` — resolve, chain, gate, persist, create task | **create** |
| `crates/app/src/teammate/tools.rs` | `handoff_task_tool_def()` | modify |
| `crates/app/src/teammate/llm.rs` | `DispatchOutcome::Handoff`, `extract_handoff_from_content`, fast-path both loops, roster, prompt | modify |
| `crates/app/src/teammate/commands.rs` | consume `DispatchOutcome::Handoff` → call router, persist msg, emit event | modify |
| `crates/app/src/teammate/task_supervisor.rs` | report-back on receiver task Done/Cancelled | modify |
| `crates/app/src/teammate/mod.rs` | `pub mod handoff; pub mod handoff_safety;` | modify |

**Out of scope (Plan 2):** `ui/src/main.ts` (HandoffRouted listener → spawn+bind+attach), delegator re-engagement wake in `operator.rs`, Convergence graph in `convergence.rs` + `ui/src/convergence/overlay.ts`, end-to-end test.

---

## Task 1: Handoff domain types

**Files:**
- Modify: `crates/app/src/teammate/types.rs`

- [ ] **Step 1: Write the failing test**

Append to the `#[cfg(test)] mod tests` block at the bottom of `crates/app/src/teammate/types.rs` (create the block if absent):

```rust
#[cfg(test)]
mod handoff_type_tests {
    use super::*;

    #[test]
    fn handoff_status_serde_is_kebab() {
        let j = serde_json::to_string(&HandoffStatus::BlockedBySafety).unwrap();
        assert_eq!(j, "\"blocked-by-safety\"");
        let back: HandoffStatus = serde_json::from_str("\"reported\"").unwrap();
        assert_eq!(back, HandoffStatus::Reported);
    }

    #[test]
    fn handoff_roundtrips_through_json() {
        let h = Handoff {
            id: HandoffId::new(),
            chain_id: ChainId::new(),
            depth: 2,
            from_operator_id: OperatorId(ulid::Ulid::new()),
            to_operator_id: OperatorId(ulid::Ulid::new()),
            task_id: Some(TaskId::new()),
            origin_task_id: None,
            origin_thread_id: ThreadId::new(),
            status: HandoffStatus::Running,
            brief: "migrate the auth module".into(),
            result_summary: None,
            created_at_unix_ms: 1,
            reported_at_unix_ms: None,
        };
        let j = serde_json::to_string(&h).unwrap();
        let back: Handoff = serde_json::from_str(&j).unwrap();
        assert_eq!(back.depth, 2);
        assert_eq!(back.brief, "migrate the auth module");
        assert_eq!(back.status, HandoffStatus::Running);
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant_lib handoff_type_tests 2>&1 | tail -20`
Expected: FAIL — `cannot find type HandoffStatus` / `Handoff` / `HandoffId` / `ChainId`.

- [ ] **Step 3: Write the types**

Add near the other ID newtypes in `types.rs` (the file already has `TaskId(pub Ulid)`, `ThreadId(pub Ulid)`, each with `pub fn new() -> Self { Self(Ulid::new()) }`). Mirror that exactly:

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct HandoffId(pub Ulid);
impl HandoffId { pub fn new() -> Self { Self(Ulid::new()) } }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChainId(pub Ulid);
impl ChainId { pub fn new() -> Self { Self(Ulid::new()) } }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HandoffStatus { Running, Reported, Failed, Rejected, BlockedBySafety }

/// One operator→operator delegation edge. The work itself is an ordinary
/// `Task` referenced by `task_id`; this row is the relationship + audit.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Handoff {
    pub id: HandoffId,
    pub chain_id: ChainId,
    pub depth: u8,
    pub from_operator_id: OperatorId,
    pub to_operator_id: OperatorId,
    /// None for rejected/blocked edges (no task was created).
    pub task_id: Option<TaskId>,
    /// The delegator's own task, if it was working one when it delegated.
    pub origin_task_id: Option<TaskId>,
    /// Thread the report-back is injected into.
    pub origin_thread_id: ThreadId,
    pub status: HandoffStatus,
    pub brief: String,
    pub result_summary: Option<String>,
    pub created_at_unix_ms: u64,
    pub reported_at_unix_ms: Option<u64>,
}

/// Parsed `handoff_task` tool input (LLM boundary), before routing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HandoffRequest {
    pub to_operator: String,
    pub brief: String,
    pub deliverable: String,
    pub executor: String,
    #[serde(default)]
    pub context: Option<String>,
}
```

Confirm `OperatorId` is in scope (the file already uses it in `Task`); it is `crate::operator_registry::OperatorId`. Ensure `Serialize, Deserialize, Ulid` imports exist (they do — `TaskId` uses them).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant_lib handoff_type_tests 2>&1 | tail -20`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/types.rs
git commit -m "feat(handoff): Handoff domain types"
```

---

## Task 2: Storage — `teammate_handoffs` table + CRUD

**Files:**
- Modify: `crates/app/src/storage.rs`

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `storage.rs`. Open storage the same way
the existing tests do — tempdir + `Storage::open` (see `storage.rs:4287`/`4344`
and `commands.rs::tests::seed_storage:830`; there is no `:memory:` helper):

```rust
#[tokio::test]
async fn handoff_roundtrip_and_chain_query() {
    let dir = tempfile::tempdir().unwrap();
    let s = std::sync::Arc::new(Storage::open(&dir.path().join("t.sqlite")).unwrap());
    let chain = crate::teammate::types::ChainId::new();
    let from = crate::operator_registry::OperatorId(ulid::Ulid::new());
    let to   = crate::operator_registry::OperatorId(ulid::Ulid::new());
    let task = crate::teammate::types::TaskId::new();
    let h = crate::teammate::types::Handoff {
        id: crate::teammate::types::HandoffId::new(),
        chain_id: chain,
        depth: 0,
        from_operator_id: from,
        to_operator_id: to,
        task_id: Some(task),
        origin_task_id: None,
        origin_thread_id: crate::teammate::types::ThreadId::new(),
        status: crate::teammate::types::HandoffStatus::Running,
        brief: "do X".into(),
        result_summary: None,
        created_at_unix_ms: 10,
        reported_at_unix_ms: None,
    };
    s.teammate_insert_handoff(&h).await.unwrap();

    let by_task = s.teammate_get_handoff_by_task(task).await.unwrap().unwrap();
    assert_eq!(by_task.id.0, h.id.0);

    s.teammate_update_handoff_status(
        h.id,
        crate::teammate::types::HandoffStatus::Reported,
        Some("done".into()),
        Some(99),
    ).await.unwrap();
    let after = s.teammate_get_handoff_by_task(task).await.unwrap().unwrap();
    assert_eq!(after.status, crate::teammate::types::HandoffStatus::Reported);
    assert_eq!(after.result_summary.as_deref(), Some("done"));

    let in_chain = s.teammate_list_handoffs_in_chain(chain).await.unwrap();
    assert_eq!(in_chain.len(), 1);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant_lib handoff_roundtrip_and_chain_query 2>&1 | tail -20`
Expected: FAIL — `no method named teammate_insert_handoff`.

- [ ] **Step 3a: Add the table to the schema**

In the `SCHEMA` string constant (the big `CREATE TABLE IF NOT EXISTS ...` batch applied at `Storage::open()`), add after the `teammate_tasks` block:

```sql
CREATE TABLE IF NOT EXISTS teammate_handoffs (
    id                   TEXT PRIMARY KEY,
    chain_id             TEXT NOT NULL,
    depth                INTEGER NOT NULL,
    from_operator_id     TEXT NOT NULL,
    to_operator_id       TEXT NOT NULL,
    task_id              TEXT,                    -- NULL for rejected/blocked edges
    origin_task_id       TEXT,
    origin_thread_id     TEXT NOT NULL,
    status               TEXT NOT NULL,           -- running|reported|failed|rejected|blocked-by-safety
    brief                TEXT NOT NULL DEFAULT '',
    result_summary       TEXT,
    created_at_unix_ms   INTEGER NOT NULL,
    reported_at_unix_ms  INTEGER
);
CREATE INDEX IF NOT EXISTS idx_handoffs_chain   ON teammate_handoffs(chain_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_task    ON teammate_handoffs(task_id);
CREATE INDEX IF NOT EXISTS idx_handoffs_to      ON teammate_handoffs(to_operator_id);
```

- [ ] **Step 3b: Add the CRUD methods**

Add to `impl Storage` (next to `teammate_insert_task` / `teammate_get_task`). Mirror their `spawn_blocking` + `params!` style exactly:

```rust
pub async fn teammate_insert_handoff(
    &self,
    h: &crate::teammate::types::Handoff,
) -> Result<(), StorageError> {
    let inner = self.inner.clone();
    let h = h.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = inner.blocking_lock();
        c.execute(
            "INSERT INTO teammate_handoffs \
             (id, chain_id, depth, from_operator_id, to_operator_id, task_id, \
              origin_task_id, origin_thread_id, status, brief, result_summary, \
              created_at_unix_ms, reported_at_unix_ms) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            rusqlite::params![
                h.id.0.to_string(),
                h.chain_id.0.to_string(),
                h.depth as i64,
                h.from_operator_id.0.to_string(),
                h.to_operator_id.0.to_string(),
                h.task_id.map(|t| t.0.to_string()),
                h.origin_task_id.map(|t| t.0.to_string()),
                h.origin_thread_id.0.to_string(),
                handoff_status_str(h.status),
                h.brief,
                h.result_summary,
                h.created_at_unix_ms as i64,
                h.reported_at_unix_ms.map(|t| t as i64),
            ],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn teammate_update_handoff_status(
    &self,
    id: crate::teammate::types::HandoffId,
    status: crate::teammate::types::HandoffStatus,
    result_summary: Option<String>,
    reported_at_unix_ms: Option<u64>,
) -> Result<(), StorageError> {
    let inner = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = inner.blocking_lock();
        c.execute(
            "UPDATE teammate_handoffs \
             SET status = ?2, result_summary = ?3, reported_at_unix_ms = ?4 \
             WHERE id = ?1",
            rusqlite::params![
                id.0.to_string(),
                handoff_status_str(status),
                result_summary,
                reported_at_unix_ms.map(|t| t as i64),
            ],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn teammate_get_handoff_by_task(
    &self,
    task_id: crate::teammate::types::TaskId,
) -> Result<Option<crate::teammate::types::Handoff>, StorageError> {
    let inner = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<Option<_>, StorageError> {
        let c = inner.blocking_lock();
        let mut stmt = c.prepare(HANDOFF_SELECT_COLS_WHERE("task_id = ?1"))?;
        let row = stmt.query_row([task_id.0.to_string()], map_handoff_row).optional()?;
        row.map(decode_handoff_row).transpose()
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn teammate_list_handoffs_in_chain(
    &self,
    chain_id: crate::teammate::types::ChainId,
) -> Result<Vec<crate::teammate::types::Handoff>, StorageError> {
    let inner = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<Vec<_>, StorageError> {
        let c = inner.blocking_lock();
        let mut stmt = c.prepare(
            HANDOFF_SELECT_COLS_WHERE("chain_id = ?1 ORDER BY created_at_unix_ms ASC"),
        )?;
        let rows = stmt.query_map([chain_id.0.to_string()], map_handoff_row)?;
        let mut out = Vec::new();
        for r in rows { out.push(decode_handoff_row(r?)?); }
        Ok(out)
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}
```

Add these free helpers in `storage.rs` (module scope, near other private helpers). `HANDOFF_SELECT_COLS_WHERE` is a small fn that returns the SELECT with a trailing clause so the column list lives in one place:

```rust
fn HANDOFF_SELECT_COLS_WHERE(tail: &str) -> String {
    format!(
        "SELECT id, chain_id, depth, from_operator_id, to_operator_id, task_id, \
                origin_task_id, origin_thread_id, status, brief, result_summary, \
                created_at_unix_ms, reported_at_unix_ms \
         FROM teammate_handoffs WHERE {tail}"
    )
}

type HandoffRowTuple = (
    String, String, i64, String, String, Option<String>,
    Option<String>, String, String, String, Option<String>, i64, Option<i64>,
);

fn map_handoff_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<HandoffRowTuple> {
    Ok((
        row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?,
        row.get(6)?, row.get(7)?, row.get(8)?, row.get(9)?, row.get(10)?, row.get(11)?, row.get(12)?,
    ))
}

fn decode_handoff_row(
    t: HandoffRowTuple,
) -> Result<crate::teammate::types::Handoff, StorageError> {
    use crate::teammate::types::*;
    let parse_ulid = |s: &str| ulid::Ulid::from_string(s).map_err(|e| StorageError::Other(e.to_string()));
    Ok(Handoff {
        id: HandoffId(parse_ulid(&t.0)?),
        chain_id: ChainId(parse_ulid(&t.1)?),
        depth: t.2 as u8,
        from_operator_id: crate::operator_registry::OperatorId(parse_ulid(&t.3)?),
        to_operator_id: crate::operator_registry::OperatorId(parse_ulid(&t.4)?),
        task_id: t.5.as_deref().map(|s| parse_ulid(s).map(TaskId)).transpose()?,
        origin_task_id: t.6.as_deref().map(|s| parse_ulid(s).map(TaskId)).transpose()?,
        origin_thread_id: ThreadId(parse_ulid(&t.7)?),
        status: handoff_status_from_str(&t.8),
        brief: t.9,
        result_summary: t.10,
        created_at_unix_ms: t.11 as u64,
        reported_at_unix_ms: t.12.map(|v| v as u64),
    })
}

fn handoff_status_str(s: crate::teammate::types::HandoffStatus) -> &'static str {
    use crate::teammate::types::HandoffStatus::*;
    match s { Running => "running", Reported => "reported", Failed => "failed",
              Rejected => "rejected", BlockedBySafety => "blocked-by-safety" }
}

fn handoff_status_from_str(s: &str) -> crate::teammate::types::HandoffStatus {
    use crate::teammate::types::HandoffStatus::*;
    match s { "reported" => Reported, "failed" => Failed, "rejected" => Rejected,
              "blocked-by-safety" => BlockedBySafety, _ => Running }
}
```

> Note: confirm `rusqlite::OptionalExtension` is imported (the file already uses `.optional()` in `teammate_get_task`, so `use rusqlite::OptionalExtension;` is present).

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant_lib handoff_roundtrip_and_chain_query 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/storage.rs
git commit -m "feat(handoff): teammate_handoffs table + CRUD"
```

---

## Task 3: Pure safety gate

**Files:**
- Create: `crates/app/src/teammate/handoff_safety.rs`
- Modify: `crates/app/src/teammate/mod.rs` (add `pub mod handoff_safety;`)

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/teammate/handoff_safety.rs` with the tests first (impl stubs follow in step 3):

```rust
//! Pure decision gate for operator→operator handoff. No I/O — the router
//! gathers chain/runtime facts and asks `decide`. Mirrors the discipline of
//! `crates/agent/src/safety.rs`: removing a check requires a justifying
//! review comment.

use crate::operator_registry::OperatorId;

pub const MAX_DEPTH: u8 = 4;
pub const MAX_CHAIN_INFLIGHT: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandoffReject {
    SelfHandoff,
    UnknownOperator,
    ReceiverBusy,
    DepthExceeded { depth: u8, max: u8 },
    Cycle { operator: OperatorId },
    ChainSaturated { inflight: usize, max: usize },
}

impl HandoffReject {
    pub fn message(&self) -> String {
        match self {
            HandoffReject::SelfHandoff => "cannot hand off to yourself".into(),
            HandoffReject::UnknownOperator => "no operator by that name".into(),
            HandoffReject::ReceiverBusy => "receiver is busy on another task; retry later".into(),
            HandoffReject::DepthExceeded { depth, max } =>
                format!("delegation chain too deep ({depth} ≥ {max})"),
            HandoffReject::Cycle { .. } => "delegation would form a cycle".into(),
            HandoffReject::ChainSaturated { inflight, max } =>
                format!("delegation chain saturated ({inflight} ≥ {max} in flight)"),
        }
    }
}

/// Facts the router supplies. `chain_from_ops` is the ordered list of
/// `from_operator_id`s already in this chain (used for cycle detection).
pub struct GateInput {
    pub from: OperatorId,
    pub to: Option<OperatorId>,      // None = name didn't resolve
    pub self_handoff: bool,
    pub receiver_busy: bool,
    pub next_depth: u8,
    pub chain_from_ops: Vec<OperatorId>,
    pub chain_inflight: usize,
}

pub fn decide(i: &GateInput) -> Result<(), HandoffReject> {
    let to = match i.to {
        None => return Err(HandoffReject::UnknownOperator),
        Some(t) => t,
    };
    if i.self_handoff || to == i.from {
        return Err(HandoffReject::SelfHandoff);
    }
    if i.next_depth >= MAX_DEPTH {
        return Err(HandoffReject::DepthExceeded { depth: i.next_depth, max: MAX_DEPTH });
    }
    if i.chain_from_ops.contains(&to) {
        return Err(HandoffReject::Cycle { operator: to });
    }
    if i.chain_inflight >= MAX_CHAIN_INFLIGHT {
        return Err(HandoffReject::ChainSaturated { inflight: i.chain_inflight, max: MAX_CHAIN_INFLIGHT });
    }
    if i.receiver_busy {
        return Err(HandoffReject::ReceiverBusy);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn op() -> OperatorId { OperatorId(ulid::Ulid::new()) }

    fn base(from: OperatorId, to: OperatorId) -> GateInput {
        GateInput { from, to: Some(to), self_handoff: false, receiver_busy: false,
                    next_depth: 0, chain_from_ops: vec![], chain_inflight: 0 }
    }

    #[test]
    fn happy_path_ok() {
        let (a, b) = (op(), op());
        assert!(decide(&base(a, b)).is_ok());
    }
    #[test]
    fn rejects_self() {
        let a = op();
        let mut i = base(a, a);
        i.to = Some(a);
        assert_eq!(decide(&i), Err(HandoffReject::SelfHandoff));
    }
    #[test]
    fn rejects_unknown_operator() {
        let a = op();
        let mut i = base(a, op());
        i.to = None;
        assert_eq!(decide(&i), Err(HandoffReject::UnknownOperator));
    }
    #[test]
    fn rejects_depth() {
        let (a, b) = (op(), op());
        let mut i = base(a, b);
        i.next_depth = MAX_DEPTH;
        assert!(matches!(decide(&i), Err(HandoffReject::DepthExceeded { .. })));
    }
    #[test]
    fn rejects_cycle() {
        let (a, b) = (op(), op());
        let mut i = base(a, b);
        i.chain_from_ops = vec![b]; // b already delegated earlier → b reappearing as target = cycle
        assert!(matches!(decide(&i), Err(HandoffReject::Cycle { .. })));
    }
    #[test]
    fn rejects_saturated_chain() {
        let (a, b) = (op(), op());
        let mut i = base(a, b);
        i.chain_inflight = MAX_CHAIN_INFLIGHT;
        assert!(matches!(decide(&i), Err(HandoffReject::ChainSaturated { .. })));
    }
    #[test]
    fn rejects_busy_receiver() {
        let (a, b) = (op(), op());
        let mut i = base(a, b);
        i.receiver_busy = true;
        assert_eq!(decide(&i), Err(HandoffReject::ReceiverBusy));
    }
}
```

Add `pub mod handoff_safety;` to `crates/app/src/teammate/mod.rs` (next to the existing `pub mod task_supervisor;`).

- [ ] **Step 2: Run test to verify it fails, then passes**

Run: `cargo test -p covenant_lib handoff_safety 2>&1 | tail -20`
Expected: the impl is already in the same file as the tests, so this compiles and PASSES (7 tests). If you wrote tests-first in a separate commit, expect FAIL `cannot find function decide` first.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/teammate/handoff_safety.rs crates/app/src/teammate/mod.rs
git commit -m "feat(handoff): pure safety gate (depth/cycle/busy/chain-cap)"
```

---

## Task 4: `handoff_task` tool def, extraction, `DispatchOutcome::Handoff`

**Files:**
- Modify: `crates/app/src/teammate/tools.rs` (add `handoff_task_tool_def`)
- Modify: `crates/app/src/teammate/llm.rs` (variant, extraction, fast-path, roster, prompt, defensive arm)

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `llm.rs`:

```rust
#[test]
fn extracts_handoff_from_tool_use() {
    let content = serde_json::json!([
        { "type": "text", "text": "ok" },
        { "type": "tool_use", "name": "handoff_task",
          "input": {
            "to_operator": "Kiro",
            "brief": "migrate the auth module to the new client",
            "deliverable": "auth module compiles against v2 client, tests green",
            "executor": "codex"
          } }
    ]);
    let req = extract_handoff_from_content(&content).expect("should parse");
    assert_eq!(req.to_operator, "Kiro");
    assert_eq!(req.executor, "codex");
    assert!(req.context.is_none());
}

#[test]
fn handoff_extraction_ignores_other_tools() {
    let content = serde_json::json!([
        { "type": "tool_use", "name": "read_file", "input": { "path": "a" } }
    ]);
    assert!(extract_handoff_from_content(&content).is_none());
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant_lib extracts_handoff_from_tool_use 2>&1 | tail -20`
Expected: FAIL — `cannot find function extract_handoff_from_content`.

- [ ] **Step 3a: Add the tool def** in `tools.rs` (mirror `propose_task_tool_def`):

```rust
/// Tool def for `handoff_task` — delegate a unit of work to ANOTHER
/// operator. Structured output, like `propose_task`: the dispatcher
/// consumes the tool_use directly (no execute handler).
pub fn handoff_task_tool_def() -> Value {
    serde_json::json!({
        "name": "handoff_task",
        "description":
            "Hand a concrete, self-contained unit of work to ANOTHER operator (teammate) \
             who will run it with their own executor and report back to you when done. \
             Use this when a peer is better placed for a sub-task than you are. You CANNOT \
             hand off to yourself. Restate the goal in plain words — never pass a raw \
             @token (the receiver has no access to your mention registry).",
        "input_schema": {
            "type": "object",
            "required": ["to_operator", "brief", "deliverable", "executor"],
            "properties": {
                "to_operator": { "type": "string", "description": "Exact name of the receiving operator (a teammate, not yourself)." },
                "brief":       { "type": "string", "description": "Self-contained description of the work. No @tokens." },
                "deliverable": { "type": "string", "description": "What 'done' looks like." },
                "executor": {
                    "type": "string",
                    "enum": ["claude", "codex", "copilot", "pi", "hermes"],
                    "description": "Which executor CLI the receiver should drive."
                },
                "context": { "type": "string", "description": "Optional already-resolved facts (file contents, paths) to inline for the receiver." }
            }
        }
    })
}
```

- [ ] **Step 3b: Register in the roster.** In `all_tool_defs` (`llm.rs`), add after `tools::propose_task_tool_def(),`:

```rust
        tools::handoff_task_tool_def(),
```

- [ ] **Step 3c: Add the `DispatchOutcome` variant.** In `llm.rs`:

```rust
pub enum DispatchOutcome {
    Text { text: String, sentiment: Option<Sentiment> },
    Propose(crate::teammate::MessageContent),
    Handoff(crate::teammate::types::HandoffRequest),   // <-- add
}
```

- [ ] **Step 3d: Add the extractor** in `llm.rs` (mirror `extract_propose_from_content`):

```rust
pub(crate) fn extract_handoff_from_content(
    content: &serde_json::Value,
) -> Option<crate::teammate::types::HandoffRequest> {
    let arr = content.as_array()?;
    for block in arr {
        if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") { continue; }
        if block.get("name").and_then(|v| v.as_str()) != Some("handoff_task") { continue; }
        let input = block.get("input")?;
        return Some(crate::teammate::types::HandoffRequest {
            to_operator: input.get("to_operator")?.as_str()?.to_string(),
            brief:       input.get("brief")?.as_str()?.to_string(),
            deliverable: input.get("deliverable")?.as_str()?.to_string(),
            executor:    input.get("executor")?.as_str()?.to_string(),
            context:     input.get("context").and_then(|v| v.as_str()).map(|s| s.to_string()),
        });
    }
    None
}
```

- [ ] **Step 3e: Fast-path both loops.** In the Anthropic loop, immediately BEFORE the existing `extract_propose_from_content` fast-path block, add:

```rust
            if let Some(req) = extract_handoff_from_content(
                &serde_json::Value::Array(resp.content.clone())
            ) {
                return Ok(DispatchOutcome::Handoff(req));
            }
```

In the OpenAI loop, add a sibling extractor `extract_handoff_from_openai_tool_calls(&tool_calls)` mirroring `extract_propose_from_openai_tool_calls` (parse the tool call named `handoff_task`'s JSON arguments into `HandoffRequest` via `serde_json::from_value`), and fast-path it before the propose fast-path:

```rust
            if let Some(req) = extract_handoff_from_openai_tool_calls(&tool_calls) {
                return Ok(DispatchOutcome::Handoff(req));
            }
```

- [ ] **Step 3f: Defensive `execute_tool` arm.** Add next to the `"propose_task"` arm:

```rust
        "handoff_task" => {
            return (
                "handoff_task already considered; respond with text now.".into(),
                false,
                Some("handoff_task in non-leading position".into()),
            )
        }
```

- [ ] **Step 3g: System-prompt blurb.** In the tool-list section (where `propose_task` is described, ~`llm.rs:217`), add one line:

```
         - `handoff_task` — delegate a self-contained sub-task to ANOTHER \
           operator (not yourself); they run it and report back. Use when a \
           peer is better placed. Never pass raw @tokens.\n\
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p covenant_lib extracts_handoff_from_tool_use handoff_extraction_ignores_other_tools 2>&1 | tail -20`
Expected: PASS (2 tests). Also `cargo build -p covenant_lib` to confirm the new `DispatchOutcome` variant compiles (you'll fix the non-exhaustive `match` in `commands.rs` in Task 6 — until then, build may warn/err on that match; that's expected and resolved next).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/tools.rs crates/app/src/teammate/llm.rs
git commit -m "feat(handoff): handoff_task tool + DispatchOutcome::Handoff extraction"
```

---

## Task 5: Router — resolve, chain, gate, persist, create task

**Files:**
- Create: `crates/app/src/teammate/handoff.rs`
- Modify: `crates/app/src/teammate/mod.rs` (add `pub mod handoff;`)

- [ ] **Step 1: Write the failing test**

Create `crates/app/src/teammate/handoff.rs`:

```rust
//! Operator→operator handoff router. Resolves the target, derives the
//! delegation chain, runs the safety gate, and (on accept) persists the
//! edge + creates the receiver Task, claiming the receiver in the runtime.
//! The UI attaches the spawned session later (Plan 2), exactly like the
//! propose_task confirm flow.

use std::sync::Arc;

use crate::operator_registry::{Operator, OperatorId};
use crate::storage::Storage;
use crate::teammate::handoff_safety::{self, GateInput, HandoffReject};
use crate::teammate::runtime::TeammateRuntime;
use crate::teammate::types::*;

/// What the caller needs to act on after routing.
pub struct RouteAccepted {
    pub handoff: Handoff,
    pub task: Task,
    pub executor: String,
}

pub enum RouteResult {
    Accepted(RouteAccepted),
    Rejected { handoff: Handoff, reason: HandoffReject },
}

/// Resolve `to_operator` name → id (case-insensitive, exact match) against
/// the current roster. Passing a slice (not the whole registry) keeps
/// `route` trivially unit-testable — the caller passes `registry.list()`.
fn resolve(roster: &[Operator], name: &str) -> Option<OperatorId> {
    roster.iter().find(|o| o.name.eq_ignore_ascii_case(name)).map(|o| o.id)
}

#[allow(clippy::too_many_arguments)]
pub async fn route(
    storage: &Arc<Storage>,
    runtime: &Arc<TeammateRuntime>,
    roster: &[Operator],
    from_operator_id: OperatorId,
    origin_thread_id: ThreadId,
    req: &HandoffRequest,
    now_ms: u64,
) -> Result<RouteResult, String> {
    // 1. Resolve target.
    let to = resolve(roster, &req.to_operator);

    // 2. Derive the delegation chain from the delegator's current task.
    let origin_task_id = match runtime.state(from_operator_id) {
        Some(OperatorState::OnTask { task, .. }) => Some(task),
        _ => None,
    };
    let parent = match origin_task_id {
        Some(t) => storage.teammate_get_handoff_by_task(t).await.map_err(|e| e.to_string())?,
        None => None,
    };
    let (chain_id, next_depth) = match &parent {
        Some(p) => (p.chain_id, p.depth.saturating_add(1)),
        None => (ChainId::new(), 0),
    };

    // 3. Gather chain facts for the gate.
    let chain = storage.teammate_list_handoffs_in_chain(chain_id).await.map_err(|e| e.to_string())?;
    let chain_from_ops: Vec<OperatorId> = chain.iter().map(|h| h.from_operator_id).collect();
    let chain_inflight = chain.iter().filter(|h| h.status == HandoffStatus::Running).count();
    let receiver_busy = matches!(
        to.and_then(|t| runtime.state(t)),
        Some(OperatorState::OnTask { .. })
    );

    let gate = GateInput {
        from: from_operator_id,
        to,
        self_handoff: to == Some(from_operator_id),
        receiver_busy,
        next_depth,
        chain_from_ops,
        chain_inflight,
    };

    // 4. Decide.
    if let Err(reason) = handoff_safety::decide(&gate) {
        let h = Handoff {
            id: HandoffId::new(), chain_id, depth: next_depth,
            from_operator_id, to_operator_id: to.unwrap_or(from_operator_id),
            task_id: None, origin_task_id, origin_thread_id,
            status: match reason {
                HandoffReject::DepthExceeded { .. } | HandoffReject::Cycle { .. }
                | HandoffReject::ChainSaturated { .. } => HandoffStatus::BlockedBySafety,
                _ => HandoffStatus::Rejected,
            },
            brief: req.brief.clone(), result_summary: Some(reason.message()),
            created_at_unix_ms: now_ms, reported_at_unix_ms: None,
        };
        storage.teammate_insert_handoff(&h).await.map_err(|e| e.to_string())?;
        return Ok(RouteResult::Rejected { handoff: h, reason });
    }

    let to = to.expect("gate guarantees Some");

    // 5. Create the receiver task (mirrors confirm_task_inner's constructor).
    let task = Task {
        id: TaskId::new(),
        operator_id: to,
        archetype: TaskArchetype::Do,
        title: req.brief.chars().take(80).collect(),
        body: req.context.clone().unwrap_or_default(),
        deliverable: req.deliverable.clone(),
        status: TaskStatus::Active,
        scope: TaskScope::default(),
        spawned_session: None,
        created_at_unix_ms: now_ms,
        updated_at_unix_ms: now_ms,
        completed_at_unix_ms: None,
        cost_usd_cents: 0,
    };
    // Claim the receiver FIRST (prevents a second concurrent handoff winning).
    runtime.start_task(to, task.id, None).map_err(|e| e.to_string())?;

    let h = Handoff {
        id: HandoffId::new(), chain_id, depth: next_depth,
        from_operator_id, to_operator_id: to,
        task_id: Some(task.id), origin_task_id, origin_thread_id,
        status: HandoffStatus::Running,
        brief: req.brief.clone(), result_summary: None,
        created_at_unix_ms: now_ms, reported_at_unix_ms: None,
    };

    // Persist task + edge; on failure release the claim.
    let persisted = async {
        storage.teammate_insert_task(&task).await.map_err(|e| e.to_string())?;
        storage.teammate_insert_handoff(&h).await.map_err(|e| e.to_string())
    }.await;
    if let Err(e) = persisted {
        let _ = runtime.finish_task(to, task.id);
        return Err(e);
    }

    Ok(RouteResult::Accepted(RouteAccepted { handoff: h, task, executor: req.executor.clone() }))
}
```

Add the tests at the bottom of the same file. The fixture mirrors
`commands.rs::tests::seed_storage` (which inserts `Operator` rows directly via
`storage.operator_insert` and uses a tempdir-backed `Storage::open`). Because
`route` takes a roster slice, no `OperatorRegistry` construction is needed:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::{Operator, VoiceTone};

    fn mk_operator(name: &str) -> Operator {
        Operator {
            id: OperatorId(ulid::Ulid::new()),
            name: name.into(),
            emoji: "🤖".into(),
            color: "#000".into(),
            tags: vec![],
            persona: "".into(),
            escalate_threshold: 0.6,
            model: "x".into(),
            hard_constraints: "".into(),
            voice: VoiceTone::Terse,
            is_default: false,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
            soul_path: None,
            soul_mtime_unix_ms: 0,
            github_access: crate::operator_registry::GithubAccess::Off,
        }
    }

    // storage + runtime + roster([Zeta, Kiro]) + their ids.
    async fn fixture() -> (Arc<Storage>, Arc<TeammateRuntime>, Vec<Operator>, OperatorId, OperatorId) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        Box::leak(Box::new(dir));
        let storage = Arc::new(Storage::open(&path).unwrap());
        let runtime = Arc::new(TeammateRuntime::new());
        let zeta = mk_operator("Zeta");
        let kiro = mk_operator("Kiro");
        storage.operator_insert(zeta.clone()).await.unwrap();
        storage.operator_insert(kiro.clone()).await.unwrap();
        let (zid, kid) = (zeta.id, kiro.id);
        (storage, runtime, vec![zeta, kiro], zid, kid)
    }

    fn req(to: &str) -> HandoffRequest {
        HandoffRequest { to_operator: to.into(), brief: "do the thing".into(),
            deliverable: "thing done".into(), executor: "codex".into(), context: None }
    }

    #[tokio::test]
    async fn happy_path_creates_task_and_edge() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req("Kiro"), 100).await.unwrap();
        let acc = match r { RouteResult::Accepted(a) => a, _ => panic!("expected accept") };
        assert_eq!(acc.executor, "codex");
        let edge = s.teammate_get_handoff_by_task(acc.task.id).await.unwrap().unwrap();
        assert_eq!(edge.status, HandoffStatus::Running);
        assert_eq!(edge.depth, 0);
        assert!(matches!(rt.state(acc.task.operator_id), Some(OperatorState::OnTask { .. })));
    }

    #[tokio::test]
    async fn rejects_unknown_operator() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req("Nobody"), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::UnknownOperator, .. }));
    }

    #[tokio::test]
    async fn rejects_self_handoff() {
        let (s, rt, roster, zeta, _kiro) = fixture().await;
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req("Zeta"), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::SelfHandoff, .. }));
    }

    #[tokio::test]
    async fn rejects_busy_receiver() {
        let (s, rt, roster, zeta, kiro) = fixture().await;
        rt.start_task(kiro, TaskId::new(), None).unwrap(); // Kiro already OnTask
        let r = route(&s, &rt, &roster, zeta, ThreadId::new(), &req("Kiro"), 100).await.unwrap();
        assert!(matches!(r, RouteResult::Rejected { reason: HandoffReject::ReceiverBusy, .. }));
    }
}
```

Add `pub mod handoff;` to `mod.rs`.

- [ ] **Step 2: Run tests to verify they fail then pass**

Run: `cargo test -p covenant_lib teammate::handoff:: 2>&1 | tail -30`
Expected: after filling `fixture()`, PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/teammate/handoff.rs crates/app/src/teammate/mod.rs
git commit -m "feat(handoff): router — resolve, chain, gate, persist, create task"
```

---

## Task 6: Wire `DispatchOutcome::Handoff` into the dispatch consumer

**Files:**
- Modify: `crates/app/src/teammate/commands.rs` (the `send_text` background task, ~lines 305-326)

- [ ] **Step 1: Write the failing test**

This path is the Tauri-emitting consumer; unit-test the pure helper it delegates to instead. Add a small free function `handoff_outcome_message` in `commands.rs` and test it:

```rust
#[test]
fn handoff_accept_message_names_receiver() {
    let m = handoff_outcome_message_accepted("Kiro", "migrate auth");
    assert!(m.contains("Kiro"));
    assert!(m.contains("migrate auth"));
}

#[test]
fn handoff_reject_message_carries_reason() {
    let m = handoff_outcome_message_rejected("Kiro", "receiver is busy on another task; retry later");
    assert!(m.contains("Kiro"));
    assert!(m.contains("busy"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant_lib handoff_accept_message_names_receiver 2>&1 | tail -10`
Expected: FAIL — function not found.

- [ ] **Step 3a: Add the message helpers** (module scope in `commands.rs`):

```rust
fn handoff_outcome_message_accepted(to: &str, brief: &str) -> String {
    format!("→ Handed off to {to}: {brief} (running; will report back).")
}
fn handoff_outcome_message_rejected(to: &str, reason: &str) -> String {
    format!("⃠ Handoff to {to} blocked: {reason}")
}
```

- [ ] **Step 3b: Handle the new outcome.** The current code does:

```rust
        let (reply_content, reply_sentiment) = match outcome {
            DispatchOutcome::Text { text, sentiment } => (MessageContent::Text(text), sentiment),
            DispatchOutcome::Propose(c) => (c, None),
        };
```

Replace with a form that routes a handoff before building the reply content. Insert BEFORE that `match`:

```rust
        // Autonomous handoff: route immediately (no user confirm), then fall
        // through with a system-style text reply describing what happened.
        let outcome = match outcome {
            DispatchOutcome::Handoff(req) => {
                let routed = crate::teammate::handoff::route(
                    &storage_bg, &runtime_bg, &registry_bg.list(),
                    operator_id, thread_id, &req, now_ms(),
                ).await;
                match routed {
                    Ok(crate::teammate::handoff::RouteResult::Accepted(acc)) => {
                        // Surface to the UI so Plan 2 can spawn + bind the receiver tab.
                        let _ = app_bg.emit("teammate-handoff-routed", serde_json::json!({
                            "handoff_id":  acc.handoff.id.0.to_string(),
                            "chain_id":    acc.handoff.chain_id.0.to_string(),
                            "from_operator": operator_id,
                            "to_operator": acc.task.operator_id,
                            "task_id":     acc.task.id.0.to_string(),
                            "executor":    acc.executor,
                            "brief":       acc.handoff.brief,
                            "deliverable": acc.task.deliverable,
                        }));
                        DispatchOutcome::Text {
                            text: handoff_outcome_message_accepted(&req.to_operator, &req.brief),
                            sentiment: None,
                        }
                    }
                    Ok(crate::teammate::handoff::RouteResult::Rejected { reason, .. }) => {
                        DispatchOutcome::Text {
                            text: handoff_outcome_message_rejected(&req.to_operator, &reason.message()),
                            sentiment: None,
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "handoff routing failed");
                        DispatchOutcome::Text {
                            text: handoff_outcome_message_rejected(&req.to_operator, "internal error"),
                            sentiment: None,
                        }
                    }
                }
            }
            other => other,
        };
        let (reply_content, reply_sentiment) = match outcome {
            DispatchOutcome::Text { text, sentiment } => (MessageContent::Text(text), sentiment),
            DispatchOutcome::Propose(c) => (c, None),
            DispatchOutcome::Handoff(_) => unreachable!("handoff resolved above"),
        };
```

> **Threading handles (verified against the current code):** the command is
> `teammate_send_text_message` (`commands.rs:78`). It ALREADY receives
> `registry: tauri::State<'_, Arc<OperatorRegistry>>` and clones
> `registry_bg = registry.inner().clone()` at line 133 — reuse that. It does
> NOT receive the runtime, so you must add a param to the command signature:
> `runtime: tauri::State<'_, std::sync::Arc<crate::teammate::runtime::TeammateRuntime>>`
> (other teammate commands already take exactly this, e.g. the confirm command
> at `commands.rs:600`), and clone `let runtime_bg = runtime.inner().clone();`
> next to `registry_bg` (line 133), BEFORE the `tokio::spawn`. `thread_id`,
> `operator_id`, and the local `now_ms()` fn are already in scope inside the
> spawned task.

- [ ] **Step 4: Run test + build**

Run: `cargo test -p covenant_lib handoff_accept_message 2>&1 | tail -10` → PASS.
Run: `cargo build -p covenant_lib 2>&1 | tail -20` → builds clean (the `match` is now exhaustive).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/commands.rs
git commit -m "feat(handoff): route autonomous handoff from dispatch + emit HandoffRouted"
```

---

## Task 7: Report-back on receiver task completion

**Files:**
- Modify: `crates/app/src/teammate/task_supervisor.rs`

- [ ] **Step 1: Write the failing test**

Add a unit test for a pure helper that builds the report message + decides the terminal handoff status. Add to `task_supervisor.rs` tests:

```rust
#[test]
fn report_message_summarizes_completion() {
    let body = super::build_handoff_report_body("Kiro", "thing done", true);
    assert!(body.contains("Kiro"));
    assert!(body.contains("thing done"));
    assert!(body.contains("completed"));
    let body_fail = super::build_handoff_report_body("Kiro", "thing done", false);
    assert!(body_fail.contains("did not complete"));
}

#[test]
fn terminal_status_maps_done_and_cancel() {
    use crate::teammate::types::{TaskStatus, HandoffStatus};
    assert_eq!(super::handoff_status_for_task(TaskStatus::Done), HandoffStatus::Reported);
    assert_eq!(super::handoff_status_for_task(TaskStatus::Cancelled), HandoffStatus::Failed);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p covenant_lib report_message_summarizes_completion terminal_status_maps_done_and_cancel 2>&1 | tail -15`
Expected: FAIL — functions not found.

- [ ] **Step 3a: Add the pure helpers** (module scope in `task_supervisor.rs`):

```rust
pub(crate) fn build_handoff_report_body(to: &str, deliverable: &str, ok: bool) -> String {
    if ok {
        format!("✓ {to} completed the delegated task — {deliverable}. (Review and continue.)")
    } else {
        format!("✗ {to} did not complete the delegated task — {deliverable}.")
    }
}

pub(crate) fn handoff_status_for_task(
    s: crate::teammate::types::TaskStatus,
) -> crate::teammate::types::HandoffStatus {
    use crate::teammate::types::{TaskStatus, HandoffStatus};
    match s {
        TaskStatus::Done => HandoffStatus::Reported,
        _ => HandoffStatus::Failed, // cancelled / abandoned
    }
}
```

- [ ] **Step 3b: Wire report-back at the completion site.** Find where the supervisor marks a task terminal (where it transitions a task to `Done`/`Cancelled` and releases the operator — search `task_supervisor.rs` for `TaskStatus::Done` / where it calls into storage to complete a task, near `apply_decision`). Right after the task is marked terminal, add:

```rust
        // If this task was delegated via a handoff, report back to the delegator.
        if let Ok(Some(h)) = self.storage.teammate_get_handoff_by_task(task_id).await {
            if h.status == crate::teammate::types::HandoffStatus::Running {
                let ok = terminal_status == crate::teammate::types::TaskStatus::Done;
                let to_name = self.registry
                    .get(h.to_operator_id)
                    .map(|o| o.name)
                    .unwrap_or_else(|| "the operator".into());
                let body = build_handoff_report_body(&to_name, &deliverable, ok);

                let report = crate::teammate::types::TaskMessage {
                    id: crate::teammate::types::MessageId::new(),
                    operator_id: h.from_operator_id,            // delegator
                    task_id: h.origin_task_id,
                    thread_id: Some(h.origin_thread_id),        // inject into delegator's thread
                    role: crate::teammate::types::Role::System,
                    content: crate::teammate::types::MessageContent::Text(body.clone()),
                    created_at_unix_ms: now_ms,
                    confirmed_at_unix_ms: None,
                    dismissed_at_unix_ms: None,
                    sentiment: None,
                };
                if let Err(e) = self.storage.teammate_insert_message(&report).await {
                    warn!(target: "teammate::supervisor", error = %e, "insert handoff report failed");
                } else {
                    self.app.emit_message(&report);
                }
                let _ = self.storage.teammate_update_handoff_status(
                    h.id, handoff_status_for_task(terminal_status), Some(body), Some(now_ms),
                ).await;

                // Light up the dormant good_delegate achievement.
                karl_score::record_task_delegated(
                    &h.from_operator_id.0.to_string(),
                    &task_id.0.to_string(),
                );

                // Plan 2 hook: wake the delegator so it re-reads its thread.
                // (Re-engagement wiring lands in Plan 2 — the report is already
                // persisted + emitted, so nothing is lost meanwhile.)
            }
        }
```

> Adapt the surrounding variable names (`task_id`, `terminal_status`, `deliverable`, `now_ms`) to whatever the completion site already has in scope. The supervisor struct must hold an `OperatorRegistry` handle (`self.registry`); if it doesn't yet, thread it in when the supervisor is constructed (search where `TaskSupervisor`/its `new`/`spawn` is built in `mod.rs` or `app` setup and pass the registry Arc, same as `self.storage`/`self.app`).
> Confirm the score crate is referenced as `karl_score` here (it is used elsewhere in `commands.rs` as `karl_score::auth`). `record_task_delegated` is `crates/score/src/lib.rs:218`.

- [ ] **Step 4: Run test + build**

Run: `cargo test -p covenant_lib report_message_summarizes_completion terminal_status_maps_done_and_cancel 2>&1 | tail -15` → PASS.
Run: `cargo build -p covenant_lib 2>&1 | tail -20` → clean.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/task_supervisor.rs
git commit -m "feat(handoff): report-back to delegator on receiver completion + good_delegate"
```

---

## Task 8: Full suite + clippy gate

- [ ] **Step 1: Run the teammate + score suites**

Run: `cargo test -p covenant_lib teammate:: 2>&1 | tail -30`
Expected: all green (new handoff tests + existing teammate tests).

Run: `cargo test -p covenant_score good_delegate 2>&1 | tail -15`
Expected: the existing `task_delegated_fact_targets_good_delegate` test still passes.

> Per `reference_covenant_test_gotchas`: telegram long-poll tests can hang under a broad `cargo test`; keep filters narrow as above. macOS has no `timeout`.

- [ ] **Step 2: Clippy**

Run: `cargo clippy -p covenant_lib 2>&1 | tail -30`
Expected: no new warnings in the handoff modules. Fix any (especially `clippy::too_many_arguments` on `route` — already `#[allow]`-ed).

- [ ] **Step 3: Commit any fixups**

```bash
git add -A && git commit -m "chore(handoff): clippy + test pass"
```

---

## Plan 2 (next plan, not this one)

After this backend core lands and is green:

1. **UI auto-spawn** — `ui/src/main.ts` listener on `teammate-handoff-routed`: spawn a tab, `bindOperatorToTab(sessionId, to_operator)` (`main.ts:715`), `teammateAttachSessionToTask(to_operator, task_id, sessionId)` so the receiver task gets its `spawned_session` and the supervisor registers it. Idempotent on duplicate events. Frontend test in the `main.ts` harness.
2. **Delegator re-engagement** — wake the delegator operator when a handoff report lands (extend the `operator.rs` engagement gate with a handoff-arrival trigger alongside `aom_idle_repoll_due`). This is the spec's flagged resume-reliability risk; design it so a missed wake still leaves the persisted report (already true after Plan 1).
3. **Convergence graph** — expose active/recent `Handoff` edges from `convergence.rs`; draw the SVG `from→to` tile connectors in `ui/src/convergence/overlay.ts` (+ `.test.ts`) with status classes; style in `styles.css`.
4. **End-to-end** — two seeded operators, real spawn, delegated task completes, report appears in the delegator thread, `good_delegate` unlocks.

## Self-review notes

- **Spec coverage:** §4 data model → T1/T2; §5 tool → T4; §6 routing → T5/T6 (UI spawn = Plan 2); §7 report-back → T7; §8 safety → T3; §10 good_delegate → T7; §9 Convergence + §7 resume = Plan 2 (explicitly deferred, spec-sanctioned increment split).
- **Type consistency:** `HandoffStatus` strings (`blocked-by-safety`) match between types serde, storage `handoff_status_str`, and the kebab test. `route` returns `RouteResult`; consumer in T6 matches `Accepted`/`Rejected`. `extract_handoff_from_content` returns `HandoffRequest`; `DispatchOutcome::Handoff` wraps the same.
- **Single adaptation point (not a placeholder):** T7's report-back snippet must be grafted at the supervisor's existing task-completion site and use whatever local names it already has in scope (`task_id`, the terminal `TaskStatus`, `deliverable`, `now_ms`) plus a `self.registry` handle threaded into the supervisor. Called out inline. T2's storage open and T5's `fixture()` are now concrete (tempdir + `Storage::open`, `Operator` literal from `seed_storage`).
- **Verified against current code:** `teammate_send_text_message` already carries `registry` (T6 reuses `registry_bg`); it needs `runtime` added. `route` takes a roster slice (`registry_bg.list()`), not the registry type, so it unit-tests without registry construction.
```
