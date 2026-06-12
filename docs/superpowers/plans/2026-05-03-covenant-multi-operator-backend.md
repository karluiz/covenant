# Covenant Multi-Operator — Plan 1: Backend + Storage

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `OperatorConfig` charter with a roster of named `Operator` rows in SQLite, expose CRUD over Tauri, resolve the effective operator per session at AOM tick time, and migrate the existing global charter into a `Default` operator row without losing historical decisions.

**Architecture:** Operators live in a new `operators` SQLite table. A new `OperatorRegistry` owned by the app holds an in-memory cache loaded from storage. The AOM tick (`crates/app/src/operator.rs`) resolves `effective_operator(session_id)` once per candidate (session-pinned id → fallback `Default`) and uses that operator's `persona`, `escalate_threshold` (new), `model`, `hard_constraints`, and `deny_extra_patterns` for the prompt. Per-session pinning is a new `set_session_operator(session_id, operator_id)` Tauri command — the frontend tab manifest (opaque to backend, see `crates/app/src/tab_manifest.rs`) holds the per-tab pin and replays the call on restore.

**Tech Stack:** Rust, `rusqlite`, `tokio`, `ulid`, `serde`, `tauri 2`, `tracing`. Existing patterns: see `Storage::open` migration style in `crates/app/src/storage.rs:222-247`, ID newtype style in `crates/app/src/operator.rs`.

---

## Spec reference

Implements §"Domain model", §"Storage", §"Migration", §"AOM behavior", and the backend half of §"Operator-decisions panel" / §"Cost / decisions tracking" from `docs/superpowers/specs/2026-05-03-covenant-multi-operator-design.md`.

Out of scope (other plans): Settings UI, tab strip / statusbar / picker UI, AFK header chips. Those consume the commands this plan ships.

## File structure

- **Create**:
  - `crates/app/src/operator_registry.rs` — `Operator`, `OperatorId`, `OperatorRegistry` (in-memory cache + storage-backed CRUD), seed-default + migration. ≤ 450 lines.
  - `crates/app/tests/operator_registry.rs` — integration tests for CRUD + migration. ≤ 250 lines.
- **Modify**:
  - `crates/app/src/storage.rs` — add `operators` schema + `operator_id` column to `operator_decisions`, plus `save_operator_*` + `list_operators` + `set_default` methods. Append at end of `impl Storage`.
  - `crates/app/src/operator.rs` — at AOM tick, resolve per-session operator from registry instead of pulling everything from `OperatorConfig`. Persist `operator_id` and `operator_name` snapshots into decision rows.
  - `crates/app/src/lib.rs` — register new Tauri commands (`operator_list`, `operator_get`, `operator_create`, `operator_update`, `operator_delete`, `operator_set_default`, `session_set_operator`, `session_get_operator`).
  - `crates/app/src/settings.rs` — `OperatorConfig.persona` field is no longer the source of truth for AOM prompts; keep the field for migration source only and document that. (Do **not** delete it yet — UI plan will remove the surface.)
- **Do NOT touch**:
  - `crates/app/src/safety.rs` — blocklist remains global and inviolable.
  - `crates/app/src/tab_manifest.rs` — opaque JSON blob owned by the frontend; per-tab `operator_id` is added to that JSON by Plan 3.
  - `crates/app/src/aom.rs` — orchestrator outer loop is unchanged in shape.
  - `crates/agent/` — agent crate is not involved in operator routing.

---

## Task 1: Domain types + module skeleton

**Files:**
- Create: `crates/app/src/operator_registry.rs`
- Modify: `crates/app/src/lib.rs` (add `mod operator_registry;`)

- [ ] **Step 1: Create the module with bare types**

```rust
// crates/app/src/operator_registry.rs
//! Operator roster: persisted list of operator personas the user can
//! pin per tab. Replaces the singular `OperatorConfig.persona` as the
//! source of truth for AOM prompts.
//!
//! Storage lives in `Storage` (sqlite). This module owns the in-memory
//! cache + CRUD façade + first-boot seed-from-settings migration.

use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, Hash, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OperatorId(pub Ulid);

impl std::fmt::Display for OperatorId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::str::FromStr for OperatorId {
    type Err = ulid::DecodeError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ulid::from_string(s).map(OperatorId)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operator {
    pub id: OperatorId,
    pub name: String,
    pub emoji: String,
    pub color: String,             // "#RRGGBB"
    pub tags: Vec<String>,
    pub persona: String,
    pub escalate_threshold: f32,   // 0.0..=1.0
    pub model: String,             // model id, e.g. "claude-sonnet-4-6"
    pub hard_constraints: String,  // free-text addition to ALWAYS-ASK-ME
    pub is_default: bool,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("operator not found: {0}")]
    NotFound(OperatorId),
    #[error("name '{0}' is already in use")]
    DuplicateName(String),
    #[error("cannot delete the default operator")]
    DefaultProtected,
    #[error("name must be 1..=64 non-whitespace characters")]
    InvalidName,
    #[error("escalate_threshold must be in 0.0..=1.0")]
    InvalidThreshold,
    #[error("storage: {0}")]
    Storage(#[from] crate::storage::StorageError),
}
```

- [ ] **Step 2: Wire module in `lib.rs`**

Open `crates/app/src/lib.rs`. Find the existing `mod` block (alphabetical-ish list of `mod aom; mod context; mod cost; ...`). Add:

```rust
mod operator_registry;
```

- [ ] **Step 3: Verify compile**

Run: `cargo check -p covenant`
Expected: clean (warnings about unused types are fine).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/lib.rs
git commit -m "feat(operator): scaffold operator_registry module with Operator/OperatorId types"
```

---

## Task 2: Storage schema + migrations

**Files:**
- Modify: `crates/app/src/storage.rs`
- Test: `crates/app/src/storage.rs` (existing `#[cfg(test)] mod tests` block at end of file)

- [ ] **Step 1: Add `operators` table to `SCHEMA`**

In `crates/app/src/storage.rs`, locate the `const SCHEMA: &str = r#"..."#;` block (starts near line 30). Append a `CREATE TABLE` for operators **inside the same string**, after `aom_sessions`:

```sql
CREATE TABLE IF NOT EXISTS operators (
    id                   TEXT PRIMARY KEY,
    name                 TEXT NOT NULL,
    emoji                TEXT NOT NULL DEFAULT '🤖',
    color                TEXT NOT NULL DEFAULT '#6B7280',
    tags_json            TEXT NOT NULL DEFAULT '[]',
    persona              TEXT NOT NULL,
    escalate_threshold   REAL NOT NULL DEFAULT 0.6,
    model                TEXT NOT NULL,
    hard_constraints     TEXT NOT NULL DEFAULT '',
    is_default           INTEGER NOT NULL DEFAULT 0,
    created_at_unix_ms   INTEGER NOT NULL,
    updated_at_unix_ms   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS operators_default_unique
    ON operators(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS operators_name_ci
    ON operators(LOWER(name));
```

- [ ] **Step 2: Add idempotent ALTER for `operator_decisions.operator_id`**

In `Storage::open` (currently around line 222-247 of `storage.rs`), append two more `let _ = conn.execute(...)` calls following the existing pattern:

```rust
let _ = conn.execute(
    "ALTER TABLE operator_decisions ADD COLUMN operator_id TEXT",
    [],
);
let _ = conn.execute(
    "ALTER TABLE operator_decisions ADD COLUMN operator_name TEXT",
    [],
);
```

Note: nullable for now; backfill happens in Task 4.

- [ ] **Step 3: Add CRUD methods to `impl Storage`**

Append, after `list_operator_decisions` (around line 942):

```rust
/// Insert a new operator row. Returns DuplicateName if `name`
/// (case-insensitive) is already taken.
pub async fn operator_insert(
    &self,
    op: crate::operator_registry::Operator,
) -> Result<(), StorageError> {
    let conn = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = conn.blocking_lock();
        let tags_json = serde_json::to_string(&op.tags)
            .map_err(|e| StorageError::Other(e.to_string()))?;
        c.execute(
            "INSERT INTO operators (id, name, emoji, color, tags_json, persona, \
             escalate_threshold, model, hard_constraints, is_default, \
             created_at_unix_ms, updated_at_unix_ms) \
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
            params![
                op.id.to_string(),
                op.name,
                op.emoji,
                op.color,
                tags_json,
                op.persona,
                op.escalate_threshold as f64,
                op.model,
                op.hard_constraints,
                if op.is_default { 1_i64 } else { 0_i64 },
                op.created_at_unix_ms as i64,
                op.updated_at_unix_ms as i64,
            ],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn operator_update(
    &self,
    op: crate::operator_registry::Operator,
) -> Result<(), StorageError> {
    let conn = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = conn.blocking_lock();
        let tags_json = serde_json::to_string(&op.tags)
            .map_err(|e| StorageError::Other(e.to_string()))?;
        c.execute(
            "UPDATE operators SET name=?2, emoji=?3, color=?4, tags_json=?5, \
             persona=?6, escalate_threshold=?7, model=?8, hard_constraints=?9, \
             updated_at_unix_ms=?10 WHERE id=?1",
            params![
                op.id.to_string(),
                op.name,
                op.emoji,
                op.color,
                tags_json,
                op.persona,
                op.escalate_threshold as f64,
                op.model,
                op.hard_constraints,
                op.updated_at_unix_ms as i64,
            ],
        )?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn operator_delete(&self, id: String) -> Result<(), StorageError> {
    let conn = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let c = conn.blocking_lock();
        c.execute("DELETE FROM operators WHERE id=?1", params![id])?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

/// Atomically flip the default flag: clear all, set the target.
/// Errors if `id` does not exist.
pub async fn operator_set_default(&self, id: String) -> Result<(), StorageError> {
    let conn = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
        let mut c = conn.blocking_lock();
        let tx = c.transaction()?;
        tx.execute("UPDATE operators SET is_default = 0", [])?;
        let n = tx.execute(
            "UPDATE operators SET is_default = 1 WHERE id = ?1",
            params![id],
        )?;
        if n == 0 {
            return Err(StorageError::Other(format!("operator id {id} not found")));
        }
        tx.commit()?;
        Ok(())
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

pub async fn operator_list(
    &self,
) -> Result<Vec<crate::operator_registry::Operator>, StorageError> {
    let conn = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<_, StorageError> {
        let c = conn.blocking_lock();
        let mut stmt = c.prepare(
            "SELECT id, name, emoji, color, tags_json, persona, \
             escalate_threshold, model, hard_constraints, is_default, \
             created_at_unix_ms, updated_at_unix_ms FROM operators \
             ORDER BY is_default DESC, LOWER(name) ASC",
        )?;
        let rows = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let tags_json: String = row.get(4)?;
                let tags: Vec<String> =
                    serde_json::from_str(&tags_json).unwrap_or_default();
                Ok(crate::operator_registry::Operator {
                    id: id.parse().map_err(|_| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            "invalid ulid".into(),
                        )
                    })?,
                    name: row.get(1)?,
                    emoji: row.get(2)?,
                    color: row.get(3)?,
                    tags,
                    persona: row.get(5)?,
                    escalate_threshold: row.get::<_, f64>(6)? as f32,
                    model: row.get(7)?,
                    hard_constraints: row.get(8)?,
                    is_default: row.get::<_, i64>(9)? != 0,
                    created_at_unix_ms: row.get::<_, i64>(10)? as u64,
                    updated_at_unix_ms: row.get::<_, i64>(11)? as u64,
                })
            })?
            .collect::<Result<Vec<_>, _>>()?;
        Ok(rows)
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}

/// One-shot backfill of `operator_decisions.operator_id` /
/// `operator_name` to the given default. Idempotent: only updates
/// rows where `operator_id IS NULL`.
pub async fn operator_decisions_backfill(
    &self,
    default_id: String,
    default_name: String,
) -> Result<usize, StorageError> {
    let conn = self.inner.clone();
    tokio::task::spawn_blocking(move || -> Result<usize, StorageError> {
        let c = conn.blocking_lock();
        let n = c.execute(
            "UPDATE operator_decisions SET operator_id = ?1, operator_name = ?2 \
             WHERE operator_id IS NULL",
            params![default_id, default_name],
        )?;
        Ok(n)
    })
    .await
    .map_err(|e| StorageError::Join(e.to_string()))?
}
```

If `StorageError` does not have an `Other(String)` variant, add it (one line in the `#[derive(...)] pub enum StorageError {}` definition).

- [ ] **Step 4: Build**

Run: `cargo check -p covenant`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/storage.rs
git commit -m "feat(storage): operators table + operator_id columns + CRUD methods"
```

---

## Task 3: Registry CRUD façade with TDD

**Files:**
- Modify: `crates/app/src/operator_registry.rs`
- Create: `crates/app/tests/operator_registry.rs`

- [ ] **Step 1: Write failing integration test for insert + list**

Create `crates/app/tests/operator_registry.rs`:

```rust
use covenant::operator_registry::{Operator, OperatorId, OperatorRegistry};
use covenant::storage::Storage;
use ulid::Ulid;

fn tmp_storage() -> (tempfile::TempDir, Storage) {
    let dir = tempfile::tempdir().unwrap();
    let s = Storage::open(&dir.path().join("t.db")).unwrap();
    (dir, s)
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn sample(name: &str, is_default: bool) -> Operator {
    Operator {
        id: OperatorId(Ulid::new()),
        name: name.into(),
        emoji: "🤖".into(),
        color: "#6B7280".into(),
        tags: vec![],
        persona: "be helpful".into(),
        escalate_threshold: 0.6,
        model: "claude-sonnet-4-6".into(),
        hard_constraints: "".into(),
        is_default,
        created_at_unix_ms: now_ms(),
        updated_at_unix_ms: now_ms(),
    }
}

#[tokio::test]
async fn insert_then_list_returns_row() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let rows = reg.list();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "Default");
    assert!(rows[0].is_default);
}

#[tokio::test]
async fn duplicate_name_rejected_case_insensitive() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let err = reg.create(&s, sample("default", false)).await.unwrap_err();
    assert!(matches!(err,
        covenant::operator_registry::RegistryError::DuplicateName(_)));
}

#[tokio::test]
async fn cannot_delete_default() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    let def = sample("Default", true);
    let id = def.id;
    reg.create(&s, def).await.unwrap();
    let err = reg.delete(&s, id).await.unwrap_err();
    assert!(matches!(err,
        covenant::operator_registry::RegistryError::DefaultProtected));
}

#[tokio::test]
async fn set_default_flips_atomically() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    let a = sample("A", true);
    let b = sample("B", false);
    let (id_a, id_b) = (a.id, b.id);
    reg.create(&s, a).await.unwrap();
    reg.create(&s, b).await.unwrap();
    reg.set_default(&s, id_b).await.unwrap();
    let rows = reg.list();
    let map: std::collections::HashMap<_, _> =
        rows.iter().map(|o| (o.id, o.is_default)).collect();
    assert_eq!(map[&id_a], false);
    assert_eq!(map[&id_b], true);
}

#[tokio::test]
async fn effective_for_unpinned_session_returns_default() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let session_id = covenant::ids::SessionId::new();
    let op = reg.effective_for(session_id);
    assert_eq!(op.name, "Default");
}
```

(Adjust the import for `SessionId` if its real path differs — see existing tests in the crate for the pattern.)

- [ ] **Step 2: Run tests — they should fail to compile**

Run: `cargo test -p covenant --test operator_registry`
Expected: FAIL with "unresolved import" or "no method named create".

- [ ] **Step 3: Implement `OperatorRegistry`**

Append to `crates/app/src/operator_registry.rs`:

```rust
use crate::ids::SessionId;
use crate::storage::Storage;
use std::collections::HashMap;
use std::sync::RwLock;

pub struct OperatorRegistry {
    by_id: RwLock<HashMap<OperatorId, Operator>>,
    pins: RwLock<HashMap<SessionId, OperatorId>>,
}

impl OperatorRegistry {
    pub async fn load(storage: &Storage) -> Result<Self, RegistryError> {
        let rows = storage.operator_list().await?;
        let mut by_id = HashMap::new();
        for op in rows {
            by_id.insert(op.id, op);
        }
        Ok(Self {
            by_id: RwLock::new(by_id),
            pins: RwLock::new(HashMap::new()),
        })
    }

    pub fn list(&self) -> Vec<Operator> {
        let g = self.by_id.read().unwrap();
        let mut v: Vec<_> = g.values().cloned().collect();
        v.sort_by(|a, b| {
            b.is_default
                .cmp(&a.is_default)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        v
    }

    pub fn get(&self, id: OperatorId) -> Option<Operator> {
        self.by_id.read().unwrap().get(&id).cloned()
    }

    pub fn default(&self) -> Option<Operator> {
        self.by_id
            .read()
            .unwrap()
            .values()
            .find(|o| o.is_default)
            .cloned()
    }

    fn validate(op: &Operator) -> Result<(), RegistryError> {
        let n = op.name.trim();
        if n.is_empty() || n.len() > 64 {
            return Err(RegistryError::InvalidName);
        }
        if !(0.0..=1.0).contains(&op.escalate_threshold) {
            return Err(RegistryError::InvalidThreshold);
        }
        Ok(())
    }

    pub async fn create(
        &self,
        storage: &Storage,
        mut op: Operator,
    ) -> Result<Operator, RegistryError> {
        Self::validate(&op)?;
        // Case-insensitive name uniqueness
        {
            let g = self.by_id.read().unwrap();
            if g.values()
                .any(|o| o.name.eq_ignore_ascii_case(&op.name))
            {
                return Err(RegistryError::DuplicateName(op.name));
            }
            // If caller asked for default but a default already exists,
            // demote the new one — set_default is the explicit promote path.
            if op.is_default && g.values().any(|o| o.is_default) {
                op.is_default = false;
            }
            // Conversely, if no default exists yet, force this one.
            if g.values().all(|o| !o.is_default) {
                op.is_default = true;
            }
        }
        storage.operator_insert(op.clone()).await?;
        self.by_id.write().unwrap().insert(op.id, op.clone());
        Ok(op)
    }

    pub async fn update(
        &self,
        storage: &Storage,
        op: Operator,
    ) -> Result<Operator, RegistryError> {
        Self::validate(&op)?;
        {
            let g = self.by_id.read().unwrap();
            if !g.contains_key(&op.id) {
                return Err(RegistryError::NotFound(op.id));
            }
            if g.values()
                .any(|o| o.id != op.id && o.name.eq_ignore_ascii_case(&op.name))
            {
                return Err(RegistryError::DuplicateName(op.name));
            }
        }
        storage.operator_update(op.clone()).await?;
        self.by_id.write().unwrap().insert(op.id, op.clone());
        Ok(op)
    }

    pub async fn delete(
        &self,
        storage: &Storage,
        id: OperatorId,
    ) -> Result<(), RegistryError> {
        {
            let g = self.by_id.read().unwrap();
            let row = g.get(&id).ok_or(RegistryError::NotFound(id))?;
            if row.is_default {
                return Err(RegistryError::DefaultProtected);
            }
        }
        storage.operator_delete(id.to_string()).await?;
        self.by_id.write().unwrap().remove(&id);
        // Forget any session pins to this id (caller's responsibility
        // to fall back to default after the call — see effective_for).
        self.pins.write().unwrap().retain(|_, v| *v != id);
        Ok(())
    }

    pub async fn set_default(
        &self,
        storage: &Storage,
        id: OperatorId,
    ) -> Result<(), RegistryError> {
        if !self.by_id.read().unwrap().contains_key(&id) {
            return Err(RegistryError::NotFound(id));
        }
        storage.operator_set_default(id.to_string()).await?;
        let mut g = self.by_id.write().unwrap();
        for (oid, row) in g.iter_mut() {
            row.is_default = *oid == id;
        }
        Ok(())
    }

    pub fn pin_session(&self, session_id: SessionId, id: OperatorId) {
        self.pins.write().unwrap().insert(session_id, id);
    }

    pub fn unpin_session(&self, session_id: SessionId) {
        self.pins.write().unwrap().remove(&session_id);
    }

    pub fn pinned(&self, session_id: SessionId) -> Option<OperatorId> {
        self.pins.read().unwrap().get(&session_id).copied()
    }

    /// The operator that should drive AOM for this session right now.
    /// Resolution: explicit pin → default → panic (registry must always
    /// have a default after migration; absence is a programmer bug).
    pub fn effective_for(&self, session_id: SessionId) -> Operator {
        if let Some(id) = self.pinned(session_id) {
            if let Some(op) = self.get(id) {
                return op;
            }
        }
        self.default()
            .expect("operator registry has no default — migration did not run")
    }
}
```

- [ ] **Step 4: Run tests — they should pass**

Run: `cargo test -p covenant --test operator_registry`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/tests/operator_registry.rs
git commit -m "feat(operator): OperatorRegistry CRUD + per-session pin resolution"
```

---

## Task 4: First-boot migration from `OperatorConfig`

**Files:**
- Modify: `crates/app/src/operator_registry.rs` (add `seed_default_from_settings`)
- Test: `crates/app/tests/operator_registry.rs`

- [ ] **Step 1: Write failing migration test**

Append to `crates/app/tests/operator_registry.rs`:

```rust
use covenant::settings::OperatorConfig;

#[tokio::test]
async fn migration_seeds_default_from_settings_only_once() {
    let (_d, s) = tmp_storage();
    let cfg = OperatorConfig::default();
    let model = "claude-sonnet-4-6".to_string();

    let reg1 = OperatorRegistry::load(&s).await.unwrap();
    let inserted = reg1
        .seed_default_from_settings(&s, &cfg, &model)
        .await
        .unwrap();
    assert!(inserted, "first call should insert");
    assert_eq!(reg1.list().len(), 1);
    let def = reg1.default().unwrap();
    assert_eq!(def.name, "Default");
    assert_eq!(def.persona, cfg.persona);
    assert!(def.is_default);

    // Second call (e.g. next boot) is a no-op.
    let reg2 = OperatorRegistry::load(&s).await.unwrap();
    let inserted2 = reg2
        .seed_default_from_settings(&s, &cfg, &model)
        .await
        .unwrap();
    assert!(!inserted2, "second call should be a no-op");
    assert_eq!(reg2.list().len(), 1);
}

#[tokio::test]
async fn migration_backfills_decisions_to_default() {
    let (dir, s) = tmp_storage();
    drop(dir); // keep storage open against the tempdir
    // Insert a fake decision row with NULL operator_id by going under
    // the public CRUD: rely on save_operator_decision setting NULL
    // because the column was added without a default.
    //
    // (Skip if your save_operator_decision API requires operator_id —
    // in that case set it to None / "".)
    // ... implementation specific. The point: after seed_default,
    // reg.backfill_existing_decisions(&s) must update those rows.
}
```

(The second test is illustrative — keep the first one strict.)

- [ ] **Step 2: Run — it should fail to compile**

Run: `cargo test -p covenant --test operator_registry migration_seeds`
Expected: FAIL with "no method named seed_default_from_settings".

- [ ] **Step 3: Implement migration**

Append to `crates/app/src/operator_registry.rs`:

```rust
use crate::settings::OperatorConfig;

impl OperatorRegistry {
    /// First-boot migration. If the registry already contains any
    /// operator row, this is a no-op (returns Ok(false)). Otherwise
    /// inserts a single `Default` row sourced from the legacy
    /// `OperatorConfig` charter and the global summary model, and
    /// backfills `operator_decisions.operator_id` for historical
    /// rows. Returns Ok(true) when the seed actually ran.
    pub async fn seed_default_from_settings(
        &self,
        storage: &Storage,
        cfg: &OperatorConfig,
        global_model: &str,
    ) -> Result<bool, RegistryError> {
        if !self.by_id.read().unwrap().is_empty() {
            return Ok(false);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let op = Operator {
            id: OperatorId(Ulid::new()),
            name: "Default".into(),
            emoji: "🤖".into(),
            color: "#6B7280".into(),
            tags: vec![],
            persona: cfg.persona.clone(),
            escalate_threshold: 0.6, // legacy was a hardcoded heuristic
            model: global_model.to_string(),
            hard_constraints: "".into(),
            is_default: true,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
        };
        let id = op.id;
        let name = op.name.clone();
        self.create(storage, op).await?;
        // Backfill historical decisions.
        let _ = storage
            .operator_decisions_backfill(id.to_string(), name)
            .await?;
        Ok(true)
    }
}
```

- [ ] **Step 4: Run tests**

Run: `cargo test -p covenant --test operator_registry`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/tests/operator_registry.rs
git commit -m "feat(operator): seed Default from legacy OperatorConfig + backfill decisions"
```

---

## Task 5: Boot-time wiring

**Files:**
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Find the app setup that opens `Storage`**

In `crates/app/src/lib.rs`, find where `Storage::open(...)` is called during Tauri `setup` (search `Storage::open`). Note the surrounding `App` / `setup` closure. The settings handle (`Arc<Mutex<Settings>>`) is also constructed there.

- [ ] **Step 2: Construct + seed the registry, store in app state**

After `Storage::open(...)`, add:

```rust
let storage_arc = std::sync::Arc::new(storage);
let registry = covenant::operator_registry::OperatorRegistry::load(&storage_arc)
    .await
    .map_err(|e| Box::new(std::io::Error::other(e.to_string())) as Box<dyn std::error::Error>)?;

// Pull global model + legacy operator config under the same lock.
let (legacy_op_cfg, global_model) = {
    let s = settings_arc.lock().await;
    (s.operator.clone(), s.agent.model_summary.clone())
};
let _ = registry
    .seed_default_from_settings(&storage_arc, &legacy_op_cfg, &global_model)
    .await
    .map_err(|e| tracing::warn!(error = %e, "operator seed failed; continuing"));

let registry_arc = std::sync::Arc::new(registry);
app.manage(registry_arc.clone());
app.manage(storage_arc.clone());
```

(If `app.manage(storage_arc)` already happens elsewhere, do not double-manage — only add the registry.)

- [ ] **Step 3: Build**

Run: `cargo check -p covenant`
Expected: clean.

- [ ] **Step 4: Smoke test — open the app, verify a Default row appears**

Run: `cargo run -p covenant`

In another terminal:

```bash
sqlite3 ~/Library/Application\ Support/com.karluiz.covenant/storage.db \
  "SELECT name, is_default FROM operators;"
```

Expected: one row, `Default|1`. Close the app.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): boot OperatorRegistry + seed Default from legacy config"
```

---

## Task 6: Tauri commands

**Files:**
- Modify: `crates/app/src/lib.rs`
- Create: `crates/app/src/operator_registry.rs` (append a `commands` submodule)

- [ ] **Step 1: Add commands**

Append to `crates/app/src/operator_registry.rs`:

```rust
pub mod commands {
    use super::*;
    use crate::ids::SessionId;
    use std::sync::Arc;
    use tauri::State;

    #[derive(Debug, Serialize, Deserialize)]
    pub struct OperatorDraft {
        pub name: String,
        pub emoji: String,
        pub color: String,
        pub tags: Vec<String>,
        pub persona: String,
        pub escalate_threshold: f32,
        pub model: String,
        pub hard_constraints: String,
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn map_err<E: std::fmt::Display>(e: E) -> String {
        e.to_string()
    }

    #[tauri::command]
    pub async fn operator_list(
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<Vec<Operator>, String> {
        Ok(registry.list())
    }

    #[tauri::command]
    pub async fn operator_get(
        id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<Option<Operator>, String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        Ok(registry.get(id))
    }

    #[tauri::command]
    pub async fn operator_create(
        draft: OperatorDraft,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<crate::storage::Storage>>,
    ) -> Result<Operator, String> {
        let now = now_ms();
        let op = Operator {
            id: OperatorId(Ulid::new()),
            name: draft.name,
            emoji: draft.emoji,
            color: draft.color,
            tags: draft.tags,
            persona: draft.persona,
            escalate_threshold: draft.escalate_threshold,
            model: draft.model,
            hard_constraints: draft.hard_constraints,
            is_default: false,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
        };
        registry.create(&storage, op).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_update(
        id: String,
        draft: OperatorDraft,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<crate::storage::Storage>>,
    ) -> Result<Operator, String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        let existing = registry
            .get(id)
            .ok_or_else(|| format!("operator not found: {id}"))?;
        let updated = Operator {
            id,
            name: draft.name,
            emoji: draft.emoji,
            color: draft.color,
            tags: draft.tags,
            persona: draft.persona,
            escalate_threshold: draft.escalate_threshold,
            model: draft.model,
            hard_constraints: draft.hard_constraints,
            is_default: existing.is_default,
            created_at_unix_ms: existing.created_at_unix_ms,
            updated_at_unix_ms: now_ms(),
        };
        registry.update(&storage, updated).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_delete(
        id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<crate::storage::Storage>>,
    ) -> Result<(), String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.delete(&storage, id).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_set_default(
        id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<crate::storage::Storage>>,
    ) -> Result<(), String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.set_default(&storage, id).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn session_set_operator(
        session_id: String,
        operator_id: Option<String>,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<(), String> {
        let sid: SessionId = session_id.parse().map_err(map_err)?;
        match operator_id {
            Some(s) => {
                let oid: OperatorId = s.parse().map_err(map_err)?;
                registry.pin_session(sid, oid);
            }
            None => registry.unpin_session(sid),
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn session_get_operator(
        session_id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<Operator, String> {
        let sid: SessionId = session_id.parse().map_err(map_err)?;
        Ok(registry.effective_for(sid))
    }
}
```

- [ ] **Step 2: Register the commands**

In `crates/app/src/lib.rs`, find the `tauri::generate_handler![...]` block. Append to the list:

```rust
operator_registry::commands::operator_list,
operator_registry::commands::operator_get,
operator_registry::commands::operator_create,
operator_registry::commands::operator_update,
operator_registry::commands::operator_delete,
operator_registry::commands::operator_set_default,
operator_registry::commands::session_set_operator,
operator_registry::commands::session_get_operator,
```

- [ ] **Step 3: Build**

Run: `cargo check -p covenant`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/operator_registry.rs crates/app/src/lib.rs
git commit -m "feat(operator): expose registry CRUD + session pin via Tauri commands"
```

---

## Task 7: AOM tick uses per-session operator

**Files:**
- Modify: `crates/app/src/operator.rs`

- [ ] **Step 1: Take a snapshot of the current settings-pull block**

Open `crates/app/src/operator.rs`. The block at ~line 949–972 reads `persona`, `executor_patterns`, `deny_extra_str`, `idle_threshold`, `max_per_min` from `settings`. The downstream loop at ~line 981 iterates `candidates` (sessions) and uses these values.

We need to keep `executor_patterns`, `idle_threshold`, `max_per_min` as global (they aren't per-operator in v1). Move `persona` and `deny_extra` into the per-session resolution inside the loop, plus add `escalate_threshold`, `model`, `operator_id`, `operator_name`.

- [ ] **Step 2: Pass the registry into the watcher**

The watcher currently has access to `settings` and `storage`. Find `OperatorWatcher::spawn` (around line 414) and `attach` (line 439). Add a new field on the watcher:

```rust
registry: std::sync::Arc<crate::operator_registry::OperatorRegistry>,
```

Threading: change `OperatorWatcher::spawn` signature to accept the registry and store it, and update the call site in `lib.rs` (search `OperatorWatcher::spawn(`) to pass `registry_arc.clone()`.

- [ ] **Step 3: Resolve operator inside the loop**

In the tick body (search the comment `// Per-tab AOM opt-out wins`), at the top of the per-session iteration, add:

```rust
let op = self.registry.effective_for(session_id);
let persona = op.persona.clone();
let model_for_this_call = op.model.clone();
let deny_extra_for_session: Vec<String> = op
    .hard_constraints
    .lines()
    .filter(|l| !l.trim().is_empty())
    .map(|l| l.to_string())
    .chain(deny_extra_global.iter().cloned())
    .collect();
let deny_extra_regexes_for_session = compile_regexes(&deny_extra_for_session);
```

Replace the old `persona` capture so the prompt builder (`build_system_prompt(&persona, ...)` near line 1152) uses the per-session `persona`. Replace uses of `model` in the API call with `model_for_this_call`. Replace uses of `deny_extra_regexes` with `deny_extra_regexes_for_session`.

The previously-captured `persona`, `model`, `deny_extra_str`, and `deny_extra_regexes` from the outer scope become obsolete; rename the surviving outer reads. Rename the captured `deny_extra_str` to `deny_extra_global` to make the intent clear.

- [ ] **Step 4: Snapshot operator_id + name into decision rows**

Find where `save_operator_decision` is called (search the symbol). Add `operator_id` and `operator_name` to the call. If the storage method doesn't accept them yet, extend its signature now:

```rust
pub async fn save_operator_decision(
    &self,
    /* existing args */,
    operator_id: Option<String>,
    operator_name: Option<String>,
) -> Result<...> { ... }
```

…and add the columns to the INSERT statement.

- [ ] **Step 5: Build + run tests**

Run: `cargo check -p covenant && cargo test -p covenant`
Expected: clean, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/operator.rs crates/app/src/storage.rs
git commit -m "feat(aom): resolve per-session operator at tick + snapshot operator_id/name on decisions"
```

---

## Task 8: Pin lifecycle wiring

**Files:**
- Modify: `crates/app/src/operator.rs` (or wherever sessions close)
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Unpin on session close**

Find the session-close path (search `close_session` in `lib.rs` / `operator.rs`). After the existing close logic, add:

```rust
registry.unpin_session(session_id);
```

- [ ] **Step 2: Verify pin/unpin round-trip**

Append to `crates/app/tests/operator_registry.rs`:

```rust
#[tokio::test]
async fn pin_unpin_round_trip() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let sec = sample("Sec-Op", false);
    let sec_id = sec.id;
    reg.create(&s, sec).await.unwrap();

    let sid = covenant::ids::SessionId::new();
    assert_eq!(reg.effective_for(sid).name, "Default");

    reg.pin_session(sid, sec_id);
    assert_eq!(reg.effective_for(sid).name, "Sec-Op");

    reg.unpin_session(sid);
    assert_eq!(reg.effective_for(sid).name, "Default");
}

#[tokio::test]
async fn deleting_pinned_operator_falls_back_to_default() {
    let (_d, s) = tmp_storage();
    let reg = OperatorRegistry::load(&s).await.unwrap();
    reg.create(&s, sample("Default", true)).await.unwrap();
    let sec = sample("Sec-Op", false);
    let sec_id = sec.id;
    reg.create(&s, sec).await.unwrap();

    let sid = covenant::ids::SessionId::new();
    reg.pin_session(sid, sec_id);
    reg.delete(&s, sec_id).await.unwrap();
    assert_eq!(reg.effective_for(sid).name, "Default");
}
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p covenant`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/operator.rs crates/app/src/lib.rs crates/app/tests/operator_registry.rs
git commit -m "feat(operator): unpin session on close + pin/unpin round-trip test"
```

---

## Task 9: Smoke verification

- [ ] **Step 1: Full build + tests**

Run: `cargo test --workspace && cargo check --workspace`
Expected: green.

- [ ] **Step 2: Manual smoke**

```bash
cargo run -p covenant
```

In `sqlite3` against the storage DB:

```sql
SELECT name, is_default FROM operators;          -- 1 row, Default|1
SELECT COUNT(*) FROM operator_decisions
  WHERE operator_id IS NULL;                     -- 0 (post-backfill)
```

Open Tauri devtools console and run:

```js
await __TAURI__.invoke('operator_list');
// Expect: [ { name: "Default", is_default: true, ... } ]

await __TAURI__.invoke('operator_create', { draft: {
  name: 'Sec-Op', emoji: '🛡️', color: '#EF4444', tags: ['security'],
  persona: 'be paranoid about secrets', escalate_threshold: 0.4,
  model: 'claude-sonnet-4-6', hard_constraints: 'never run anything touching ~/.aws'
}});
await __TAURI__.invoke('operator_list');
// Expect: 2 rows, Default still default.
```

- [ ] **Step 3: Commit any final cleanup, push branch.**

```bash
git push -u origin <branch>
```

---

## Acceptance criteria (this plan)

- [ ] `operators` table exists, holds ≥1 row (Default) after first boot.
- [ ] `operator_decisions.operator_id` and `operator_name` columns exist; historical rows backfilled to Default.
- [ ] Tauri commands `operator_list / get / create / update / delete / set_default / session_set_operator / session_get_operator` all callable from devtools and behave per their tests.
- [ ] Creating a second operator and pinning it to a session changes the persona used by the next AOM tick on that session (verifiable by reading the prompt log line for that session vs. an unpinned session).
- [ ] `cargo test --workspace` and `cargo check --workspace` green.

## Open questions

None for this plan. (UI surfaces — Settings, picker, statusbar, AFK chip — are Plans 2 and 3.)
