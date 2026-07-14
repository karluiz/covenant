# Somnus v2 — Full Client (Collections + Environments) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Somnus fase 1 of the v2 spec — collections tree (SQLite), environments + `{{var}}` resolution, the four composer tabs (Params/Auth/Headers/Body), request tabs in expanded mode, Postman v2.1 import, and the 3-pane expanded redesign.

**Architecture:** Two new SQLite tables (`somnus_tree`, `somnus_environments`) with store methods + Tauri commands appended to the existing `crates/app/src/somnus.rs` (request payloads are opaque JSON strings to Rust — the frontend owns the draft shape). Frontend splits `panel.ts` into focused modules: pure logic (`vars.ts`, `auth.ts`, `postman.ts`) + components (`composer.ts`, `tree.ts`, `envs.ts`, `tabs.ts`), orchestrated by a slimmer `SomnusPanel`. Variable resolution and auth compilation happen frontend-side just before `somnusSend`, so `somnus_send` and the operator-tool seam stay untouched.

**Tech Stack:** Rust (rusqlite, ulid, serde_json; mockito NOT needed — no new HTTP), TypeScript strict (vitest), shared `.rail-*` / `.ui-select__*` CSS systems.

**Spec:** `docs/superpowers/specs/2026-07-14-somnus-v2-postman-design.md`

## Global Constraints

- All work happens in this worktree (`.claude/worktrees/somnus-v2`, branch `worktree-somnus-v2`). Never edit the main checkout.
- **Never `git add -A`** — the worktree's `node_modules` is a symlink to main's; stage explicit paths only.
- Run vitest and `npm run build` from the **worktree root**, never from `ui/`.
- **NEVER run `cargo test --workspace`** (telegram long-poll tests hang; macOS has no `timeout`). Use targeted: `cargo test -p covenant somnus`.
- Pre-existing vitest baseline on this branch (measured 2026-07-14): **6 failing tests across 8 files, 1228 pass**. Zero NEW failures allowed; the 6 old ones are not yours to fix.
- TypeScript `strict: true`; no `as any` without a justifying comment.
- Tooltips via `attachTooltip` (`ui/src/tooltip/tooltip.ts`), never `element.title`. Icons from `Icons.*` (`ui/src/icons`), never emoji. All UI copy English. `border-radius: 0` on everything new; `appearance: none` on every native input (light-theme reset gotcha).
- Every dropdown is `CustomSelect` (`ui/src/ui/select.ts`); bespoke poppers (context menu, save popover) reuse `.ui-select__popover` / `.ui-select__option` classes (DESIGN.md rule 14).
- Semantic colors only from tokens: `--ok` / `--fail` / `--running` / `--danger` / `--accent` / `--text-tertiary` (DESIGN.md rule 9). Method chip mapping: GET→`--ok`, POST→`--accent`, PUT/PATCH→`--running`, DELETE→`--danger`, HEAD/OPTIONS→`--text-tertiary`.
- No native dialogs (`confirm()`/`alert()`) for in-flow confirms — inline confirm rows (DESIGN.md rule 1).
- Ink alphas with slash syntax only: `rgb(var(--ink-rgb) / 0.08)` (rule 13).
- Rust: no `unwrap()` outside `#[cfg(test)]`; commands return `Result<T, String>`.
- No new dependencies, Rust or npm.
- Commits: Conventional Commits, **one commit per task** (user preference), ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **Spec deviations locked in by this plan** (flag in PR, all simplifications, no behavior loss): (1) `SomnusDraft` has no separate `params` field — the Params tab is a pure projection of the URL's query string; (2) form-urlencoded rows are likewise a projection of `draft.body`; (3) the env editor also renders in rail mode (same component, no expanded-only gate); (4) unresolved-vars marking is a warn notice under the composer line + `--fail` border on the URL input, not per-field borders; (5) JSON body mode auto-sets `Content-Type: application/json` when absent (spec only named form mode).

---

### Task 1: Backend — `somnus_tree` + `somnus_environments` tables, store methods, commands

**Files:**
- Modify: `crates/app/src/storage.rs` (SCHEMA — add two tables + index right after `idx_somnus_history_created`, ~line 285)
- Modify: `crates/app/src/somnus.rs` (append a "Collections tree + environments" section after the history `impl Store` block, ~line 329, and the new `#[tauri::command]`s after `somnus_history_clear`, ~line 369; tests into the existing `mod tests`)
- Modify: `crates/app/src/lib.rs` (register 11 new commands after `somnus::somnus_history_clear,` at ~line 4862)

**Interfaces:**
- Consumes: existing `Store` (shared `Arc<Mutex<Connection>>`), `StoreError`, `ulid`.
- Produces (exact — Task 2 mirrors these in api.ts):
  - `SomnusTreeNode { id: String, parent_id: Option<String>, kind: String, name: String, sort: i64, request: Option<String>, updated_at: i64 }` (Serialize)
  - `SomnusImportNode { kind: String, name: String, request: Option<String>, children: Vec<SomnusImportNode> }` (Deserialize, `children` defaults)
  - `SomnusEnvironment { id: String, name: String, vars: String, is_active: bool }` (Serialize)
  - Commands: `somnus_tree_list() -> Vec<SomnusTreeNode>`, `somnus_tree_create(parent_id: Option<String>, kind: String, name: String, request: Option<String>) -> String`, `somnus_tree_update(id: String, name: Option<String>, request: Option<String>) -> ()`, `somnus_tree_delete(id: String) -> ()`, `somnus_tree_duplicate(id: String) -> String`, `somnus_tree_import(name: String, nodes: Vec<SomnusImportNode>) -> u32`, `somnus_env_list() -> Vec<SomnusEnvironment>`, `somnus_env_create(name: String) -> String`, `somnus_env_update(id: String, name: String, vars: String) -> ()`, `somnus_env_delete(id: String) -> ()`, `somnus_env_activate(id: Option<String>) -> ()`.

- [ ] **Step 1: Add the tables to storage.rs SCHEMA**

In `crates/app/src/storage.rs`, directly after the `idx_somnus_history_created` index line (~285), append inside the same SCHEMA string:

```sql
CREATE TABLE IF NOT EXISTS somnus_tree (
  id         TEXT PRIMARY KEY,
  parent_id  TEXT,
  kind       TEXT NOT NULL,
  name       TEXT NOT NULL,
  sort       INTEGER NOT NULL DEFAULT 0,
  request    TEXT,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_somnus_tree_parent ON somnus_tree(parent_id);

CREATE TABLE IF NOT EXISTS somnus_environments (
  id        TEXT PRIMARY KEY,
  name      TEXT NOT NULL,
  vars      TEXT NOT NULL DEFAULT '[]',
  is_active INTEGER NOT NULL DEFAULT 0
);
```

`request` and `vars` are opaque JSON strings — the frontend owns their shape; SQL never queries inside them.

- [ ] **Step 2: Write the failing tests**

Append to `mod tests` in `crates/app/src/somnus.rs` (reuses the existing `mem_store()` helper — SCHEMA changes from Step 1 flow in automatically):

```rust
    // ── v2: collections tree ──

    async fn mk_collection(store: &Store, name: &str) -> String {
        store.tree_create(None, "collection".into(), name.into(), None).await.unwrap()
    }

    #[tokio::test]
    async fn tree_create_and_list_roundtrip() {
        let store = mem_store();
        let col = mk_collection(&store, "My API").await;
        let folder = store
            .tree_create(Some(col.clone()), "folder".into(), "Auth".into(), None)
            .await
            .unwrap();
        let req_json = r#"{"method":"GET","url":"https://{{base_url}}/users","headers":[],"body":"","body_mode":"none","auth":{"type":"none"}}"#;
        let req_id = store
            .tree_create(Some(folder.clone()), "request".into(), "List users".into(), Some(req_json.into()))
            .await
            .unwrap();
        let rows = store.tree_list().await.unwrap();
        assert_eq!(rows.len(), 3);
        let req_row = rows.iter().find(|r| r.id == req_id).unwrap();
        assert_eq!(req_row.parent_id.as_deref(), Some(folder.as_str()));
        assert_eq!(req_row.kind, "request");
        assert_eq!(req_row.request.as_deref(), Some(req_json));
    }

    #[tokio::test]
    async fn tree_sort_increments_per_sibling_group() {
        let store = mem_store();
        let col = mk_collection(&store, "A").await;
        let r1 = store.tree_create(Some(col.clone()), "request".into(), "one".into(), None).await.unwrap();
        let r2 = store.tree_create(Some(col.clone()), "request".into(), "two".into(), None).await.unwrap();
        let rows = store.tree_list().await.unwrap();
        let s = |id: &str| rows.iter().find(|r| r.id == id).unwrap().sort;
        assert!(s(&r1) < s(&r2));
    }

    #[tokio::test]
    async fn tree_create_rejects_bad_kind() {
        let store = mem_store();
        let e = store.tree_create(None, "blob".into(), "x".into(), None).await.unwrap_err();
        assert!(e.to_string().contains("kind"), "{e}");
    }

    #[tokio::test]
    async fn tree_update_renames_and_saves_request() {
        let store = mem_store();
        let col = mk_collection(&store, "A").await;
        let id = store.tree_create(Some(col), "request".into(), "old".into(), None).await.unwrap();
        store.tree_update(&id, Some("new".into()), Some(r#"{"method":"POST"}"#.into())).await.unwrap();
        let rows = store.tree_list().await.unwrap();
        let row = rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(row.name, "new");
        assert_eq!(row.request.as_deref(), Some(r#"{"method":"POST"}"#));
        // Partial update: rename only must not clobber the stored request.
        store.tree_update(&id, Some("newer".into()), None).await.unwrap();
        let rows = store.tree_list().await.unwrap();
        let row = rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(row.name, "newer");
        assert_eq!(row.request.as_deref(), Some(r#"{"method":"POST"}"#));
    }

    #[tokio::test]
    async fn tree_delete_is_recursive() {
        let store = mem_store();
        let col = mk_collection(&store, "A").await;
        let folder = store.tree_create(Some(col.clone()), "folder".into(), "f".into(), None).await.unwrap();
        store.tree_create(Some(folder.clone()), "request".into(), "leaf".into(), None).await.unwrap();
        store.tree_delete(&col).await.unwrap();
        assert!(store.tree_list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn tree_duplicate_copies_subtree_with_new_ids() {
        let store = mem_store();
        let col = mk_collection(&store, "A").await;
        let folder = store.tree_create(Some(col.clone()), "folder".into(), "f".into(), None).await.unwrap();
        store
            .tree_create(Some(folder.clone()), "request".into(), "leaf".into(), Some("{}".into()))
            .await
            .unwrap();
        let copy_id = store.tree_duplicate(&folder).await.unwrap();
        let rows = store.tree_list().await.unwrap();
        assert_eq!(rows.len(), 5); // col + f + leaf + "f copy" + copied leaf
        let copy = rows.iter().find(|r| r.id == copy_id).unwrap();
        assert_eq!(copy.name, "f copy");
        assert_eq!(copy.parent_id.as_deref(), Some(col.as_str()));
        let copied_leaf = rows.iter().find(|r| r.parent_id.as_deref() == Some(copy_id.as_str())).unwrap();
        assert_eq!(copied_leaf.name, "leaf");
        assert_eq!(copied_leaf.request.as_deref(), Some("{}"));
    }

    #[tokio::test]
    async fn tree_import_builds_structure_and_counts_requests() {
        let store = mem_store();
        let nodes = vec![
            SomnusImportNode {
                kind: "folder".into(),
                name: "Users".into(),
                request: None,
                children: vec![SomnusImportNode {
                    kind: "request".into(),
                    name: "List".into(),
                    request: Some("{}".into()),
                    children: vec![],
                }],
            },
            SomnusImportNode { kind: "request".into(), name: "Ping".into(), request: Some("{}".into()), children: vec![] },
        ];
        let count = store.tree_import("Imported".into(), nodes).await.unwrap();
        assert_eq!(count, 2);
        let rows = store.tree_list().await.unwrap();
        assert_eq!(rows.len(), 4); // collection + folder + 2 requests
        let root = rows.iter().find(|r| r.kind == "collection").unwrap();
        assert_eq!(root.name, "Imported");
        assert!(root.parent_id.is_none());
    }

    // ── v2: environments ──

    #[tokio::test]
    async fn env_crud_roundtrip() {
        let store = mem_store();
        let id = store.env_create("Staging".into()).await.unwrap();
        store
            .env_update(&id, "Staging".into(), r#"[{"key":"base_url","value":"https://stg.test","secret":false}]"#.into())
            .await
            .unwrap();
        let envs = store.env_list().await.unwrap();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].name, "Staging");
        assert!(envs[0].vars.contains("base_url"));
        assert!(!envs[0].is_active);
        store.env_delete(&id).await.unwrap();
        assert!(store.env_list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn env_activate_is_exclusive_and_clearable() {
        let store = mem_store();
        let a = store.env_create("A".into()).await.unwrap();
        let b = store.env_create("B".into()).await.unwrap();
        store.env_activate(Some(a.clone())).await.unwrap();
        store.env_activate(Some(b.clone())).await.unwrap();
        let envs = store.env_list().await.unwrap();
        assert!(!envs.iter().find(|e| e.id == a).unwrap().is_active);
        assert!(envs.iter().find(|e| e.id == b).unwrap().is_active);
        store.env_activate(None).await.unwrap();
        assert!(store.env_list().await.unwrap().iter().all(|e| !e.is_active));
    }
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p covenant somnus`
Expected: compile errors — `tree_create`, `SomnusImportNode`, etc. not defined.

- [ ] **Step 4: Implement the store section**

Append to `crates/app/src/somnus.rs`, after the history `impl Store` block (before `// ── Tauri commands ──`):

```rust
// ── Collections tree + environments (v2) ────────────────────────────
//
// `request` (tree) and `vars` (environments) are opaque JSON strings —
// the frontend owns their shape (SomnusDraft / SomnusEnvVar[] in api.ts).
// Rust stores and returns them verbatim.

pub const TREE_KINDS: [&str; 3] = ["collection", "folder", "request"];

#[derive(Debug, Clone, Serialize)]
pub struct SomnusTreeNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub sort: i64,
    pub request: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SomnusImportNode {
    pub kind: String,
    pub name: String,
    pub request: Option<String>,
    #[serde(default)]
    pub children: Vec<SomnusImportNode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SomnusEnvironment {
    pub id: String,
    pub name: String,
    pub vars: String,
    pub is_active: bool,
}

impl Store {
    pub async fn tree_list(&self) -> Result<Vec<SomnusTreeNode>, StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<SomnusTreeNode>, StoreError> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, parent_id, kind, name, sort, request, updated_at
                 FROM somnus_tree ORDER BY sort ASC, rowid ASC",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(SomnusTreeNode {
                        id: row.get(0)?,
                        parent_id: row.get(1)?,
                        kind: row.get(2)?,
                        name: row.get(3)?,
                        sort: row.get(4)?,
                        request: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn tree_create(
        &self,
        parent_id: Option<String>,
        kind: String,
        name: String,
        request: Option<String>,
    ) -> Result<String, StoreError> {
        if !TREE_KINDS.contains(&kind.as_str()) {
            return Err(StoreError::Invalid(format!("bad tree kind {kind}")));
        }
        let conn = self.conn.clone();
        let id = ulid::Ulid::new().to_string();
        let id_out = id.clone();
        let now = Self::now_ms();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO somnus_tree (id, parent_id, kind, name, sort, request, updated_at)
                 VALUES (?1, ?2, ?3, ?4,
                   1 + COALESCE((SELECT MAX(sort) FROM somnus_tree WHERE parent_id IS ?2), 0),
                   ?5, ?6)",
                params![id, parent_id, kind, name, request, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))??;
        Ok(id_out)
    }

    /// Partial update: `None` fields keep their stored value.
    pub async fn tree_update(
        &self,
        id: &str,
        name: Option<String>,
        request: Option<String>,
    ) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        let now = Self::now_ms();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE somnus_tree
                 SET name = COALESCE(?2, name), request = COALESCE(?3, request), updated_at = ?4
                 WHERE id = ?1",
                params![id, name, request, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    /// Recursive delete: the node and all descendants, one statement.
    pub async fn tree_delete(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "DELETE FROM somnus_tree WHERE id IN (
                   WITH RECURSIVE d(id) AS (
                     SELECT ?1
                     UNION ALL
                     SELECT t.id FROM somnus_tree t JOIN d ON t.parent_id = d.id
                   ) SELECT id FROM d)",
                params![id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    /// Deep copy of a subtree next to the original; root gets " copy".
    pub async fn tree_duplicate(&self, id: &str) -> Result<String, StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        let now = Self::now_ms();
        tokio::task::spawn_blocking(move || -> Result<String, StoreError> {
            let mut c = conn.blocking_lock();
            let tx = c.transaction()?;
            // BFS order guarantees parents precede children.
            let rows: Vec<(String, Option<String>, String, String, Option<String>)> = {
                let mut stmt = tx.prepare(
                    "WITH RECURSIVE d(id) AS (
                       SELECT ?1
                       UNION ALL
                       SELECT t.id FROM somnus_tree t JOIN d ON t.parent_id = d.id
                     )
                     SELECT s.id, s.parent_id, s.kind, s.name, s.request
                     FROM somnus_tree s JOIN d ON s.id = d.id",
                )?;
                stmt.query_map(params![id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?
                .collect::<Result<Vec<_>, _>>()?
            };
            if rows.is_empty() {
                return Err(StoreError::Invalid(format!("no tree node {id}")));
            }
            let mut remap: std::collections::HashMap<String, String> = std::collections::HashMap::new();
            for (old_id, _, _, _, _) in &rows {
                remap.insert(old_id.clone(), ulid::Ulid::new().to_string());
            }
            let mut new_root = String::new();
            for (old_id, parent, kind, name, request) in &rows {
                let is_root = *old_id == id;
                let new_id = remap[old_id].clone();
                if is_root {
                    new_root = new_id.clone();
                }
                // Root keeps its original parent; descendants remap to their copied parent.
                let new_parent = if is_root {
                    parent.clone()
                } else {
                    parent.as_ref().map(|p| remap.get(p).cloned().unwrap_or_else(|| p.clone()))
                };
                let new_name = if is_root { format!("{name} copy") } else { name.clone() };
                tx.execute(
                    "INSERT INTO somnus_tree (id, parent_id, kind, name, sort, request, updated_at)
                     VALUES (?1, ?2, ?3, ?4,
                       1 + COALESCE((SELECT MAX(sort) FROM somnus_tree WHERE parent_id IS ?2), 0),
                       ?5, ?6)",
                    params![new_id, new_parent, kind, new_name, request, now],
                )?;
            }
            tx.commit()?;
            Ok(new_root)
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    /// Import a whole collection atomically. Creates the root collection
    /// named `name`, inserts `nodes` beneath it, returns the request count.
    pub async fn tree_import(
        &self,
        name: String,
        nodes: Vec<SomnusImportNode>,
    ) -> Result<u32, StoreError> {
        for n in &nodes {
            validate_import_kinds(n)?;
        }
        let conn = self.conn.clone();
        let now = Self::now_ms();
        tokio::task::spawn_blocking(move || -> Result<u32, StoreError> {
            let mut c = conn.blocking_lock();
            let tx = c.transaction()?;
            let root = ulid::Ulid::new().to_string();
            tx.execute(
                "INSERT INTO somnus_tree (id, parent_id, kind, name, sort, request, updated_at)
                 VALUES (?1, NULL, 'collection', ?2,
                   1 + COALESCE((SELECT MAX(sort) FROM somnus_tree WHERE parent_id IS NULL), 0),
                   NULL, ?3)",
                params![root, name, now],
            )?;
            fn insert_nodes(
                tx: &rusqlite::Transaction<'_>,
                parent: &str,
                nodes: &[SomnusImportNode],
                now: i64,
                count: &mut u32,
            ) -> Result<(), rusqlite::Error> {
                for (i, n) in nodes.iter().enumerate() {
                    let id = ulid::Ulid::new().to_string();
                    tx.execute(
                        "INSERT INTO somnus_tree (id, parent_id, kind, name, sort, request, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![id, parent, n.kind, n.name, (i + 1) as i64, n.request, now],
                    )?;
                    if n.kind == "request" {
                        *count += 1;
                    }
                    insert_nodes(tx, &id, &n.children, now, count)?;
                }
                Ok(())
            }
            let mut count = 0u32;
            insert_nodes(&tx, &root, &nodes, now, &mut count)?;
            tx.commit()?;
            Ok(count)
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn env_list(&self) -> Result<Vec<SomnusEnvironment>, StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<SomnusEnvironment>, StoreError> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, name, vars, is_active FROM somnus_environments ORDER BY rowid ASC",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(SomnusEnvironment {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        vars: row.get(2)?,
                        is_active: row.get::<_, i64>(3)? != 0,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn env_create(&self, name: String) -> Result<String, StoreError> {
        let conn = self.conn.clone();
        let id = ulid::Ulid::new().to_string();
        let id_out = id.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO somnus_environments (id, name, vars, is_active) VALUES (?1, ?2, '[]', 0)",
                params![id, name],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))??;
        Ok(id_out)
    }

    pub async fn env_update(&self, id: &str, name: String, vars: String) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE somnus_environments SET name = ?2, vars = ?3 WHERE id = ?1",
                params![id, name, vars],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn env_delete(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM somnus_environments WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    /// At most one active environment; `None` deactivates all.
    pub async fn env_activate(&self, id: Option<String>) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE somnus_environments
                 SET is_active = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
                params![id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }
}

fn validate_import_kinds(n: &SomnusImportNode) -> Result<(), StoreError> {
    if n.kind != "folder" && n.kind != "request" {
        return Err(StoreError::Invalid(format!("bad import kind {}", n.kind)));
    }
    for c in &n.children {
        validate_import_kinds(c)?;
    }
    Ok(())
}
```

Add the `Invalid` variant to `StoreError` (same enum, ~line 144):

```rust
    #[error("somnus: {0}")]
    Invalid(String),
```

Note `parent_id IS ?2` (not `=`) in the sibling-sort subqueries — `IS` matches NULL parents; `=` would silently never match root siblings.

- [ ] **Step 5: Add the Tauri commands + register**

After `somnus_history_clear` in `somnus.rs`:

```rust
#[tauri::command]
pub async fn somnus_tree_list(store: State<'_, Store>) -> Result<Vec<SomnusTreeNode>, String> {
    store.tree_list().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_create(
    store: State<'_, Store>,
    parent_id: Option<String>,
    kind: String,
    name: String,
    request: Option<String>,
) -> Result<String, String> {
    store.tree_create(parent_id, kind, name, request).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_update(
    store: State<'_, Store>,
    id: String,
    name: Option<String>,
    request: Option<String>,
) -> Result<(), String> {
    store.tree_update(&id, name, request).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.tree_delete(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_duplicate(store: State<'_, Store>, id: String) -> Result<String, String> {
    store.tree_duplicate(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_import(
    store: State<'_, Store>,
    name: String,
    nodes: Vec<SomnusImportNode>,
) -> Result<u32, String> {
    store.tree_import(name, nodes).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_list(store: State<'_, Store>) -> Result<Vec<SomnusEnvironment>, String> {
    store.env_list().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_create(store: State<'_, Store>, name: String) -> Result<String, String> {
    store.env_create(name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_update(
    store: State<'_, Store>,
    id: String,
    name: String,
    vars: String,
) -> Result<(), String> {
    store.env_update(&id, name, vars).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.env_delete(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_activate(store: State<'_, Store>, id: Option<String>) -> Result<(), String> {
    store.env_activate(id).await.map_err(|e| e.to_string())
}
```

In `crates/app/src/lib.rs`, after `somnus::somnus_history_clear,` (~line 4862) add:

```rust
            somnus::somnus_tree_list,
            somnus::somnus_tree_create,
            somnus::somnus_tree_update,
            somnus::somnus_tree_delete,
            somnus::somnus_tree_duplicate,
            somnus::somnus_tree_import,
            somnus::somnus_env_list,
            somnus::somnus_env_create,
            somnus::somnus_env_update,
            somnus::somnus_env_delete,
            somnus::somnus_env_activate,
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cargo test -p covenant somnus`
Expected: all somnus tests pass (v1's plus the 9 new ones). Then `cargo check -p covenant` clean.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/somnus.rs crates/app/src/storage.rs crates/app/src/lib.rs
git commit -m "feat(somnus): collections tree + environments storage and commands

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: api.ts — v2 types + typed wrappers

**Files:**
- Modify: `ui/src/api.ts` (extend the "Somnus" section, after `somnusHistoryClear`, ~line 1510)

**Interfaces:**
- Consumes: Task 1 command names/signatures (exact).
- Produces (every later task imports from here):
  - `SomnusBodyMode = "none" | "json" | "text" | "form"`
  - `SomnusAuth` (discriminated union on `type`)
  - `SomnusDraft { method, url, headers: [string,string][], body: string, body_mode: SomnusBodyMode, auth: SomnusAuth }`
  - `SomnusTreeKind`, `SomnusTreeNode`, `SomnusImportNode`, `SomnusEnvVar`, `SomnusEnvironment`
  - Wrappers: `somnusTreeList`, `somnusTreeCreate`, `somnusTreeUpdate`, `somnusTreeDelete`, `somnusTreeDuplicate`, `somnusTreeImport`, `somnusEnvList`, `somnusEnvCreate`, `somnusEnvUpdate`, `somnusEnvDelete`, `somnusEnvActivate`

- [ ] **Step 1: Add types and wrappers**

Append to the Somnus section of `ui/src/api.ts`:

```ts
// Somnus v2 — collections tree + environments ---------------------------

export type SomnusBodyMode = "none" | "json" | "text" | "form";

export type SomnusAuth =
  | { type: "none" }
  | { type: "bearer"; token: string }
  | { type: "basic"; username: string; password: string }
  | { type: "apikey"; key: string; value: string; placement: "header" | "query" };

/// The composer's persistable state. Stored JSON-encoded in somnus_tree.request
/// (opaque to Rust). Params and form rows are projections of `url` / `body`,
/// not separate fields.
export type SomnusDraft = {
  method: string;
  url: string;
  headers: [string, string][];
  body: string;
  body_mode: SomnusBodyMode;
  auth: SomnusAuth;
};

export type SomnusTreeKind = "collection" | "folder" | "request";

export type SomnusTreeNode = {
  id: string;
  parent_id: string | null;
  kind: SomnusTreeKind;
  name: string;
  sort: number;
  request: string | null; // JSON-encoded SomnusDraft
  updated_at: number;
};

export type SomnusImportNode = {
  kind: "folder" | "request";
  name: string;
  request: string | null; // JSON-encoded SomnusDraft
  children: SomnusImportNode[];
};

export type SomnusEnvVar = { key: string; value: string; secret: boolean };

export type SomnusEnvironment = {
  id: string;
  name: string;
  vars: string; // JSON-encoded SomnusEnvVar[]
  is_active: boolean;
};

export async function somnusTreeList(): Promise<SomnusTreeNode[]> {
  return invoke<SomnusTreeNode[]>("somnus_tree_list", {});
}

export async function somnusTreeCreate(
  parentId: string | null,
  kind: SomnusTreeKind,
  name: string,
  request: string | null,
): Promise<string> {
  return invoke<string>("somnus_tree_create", { parentId, kind, name, request });
}

export async function somnusTreeUpdate(
  id: string,
  name: string | null,
  request: string | null,
): Promise<void> {
  return invoke<void>("somnus_tree_update", { id, name, request });
}

export async function somnusTreeDelete(id: string): Promise<void> {
  return invoke<void>("somnus_tree_delete", { id });
}

export async function somnusTreeDuplicate(id: string): Promise<string> {
  return invoke<string>("somnus_tree_duplicate", { id });
}

export async function somnusTreeImport(name: string, nodes: SomnusImportNode[]): Promise<number> {
  return invoke<number>("somnus_tree_import", { name, nodes });
}

export async function somnusEnvList(): Promise<SomnusEnvironment[]> {
  return invoke<SomnusEnvironment[]>("somnus_env_list", {});
}

export async function somnusEnvCreate(name: string): Promise<string> {
  return invoke<string>("somnus_env_create", { name });
}

export async function somnusEnvUpdate(id: string, name: string, vars: string): Promise<void> {
  return invoke<void>("somnus_env_update", { id, name, vars });
}

export async function somnusEnvDelete(id: string): Promise<void> {
  return invoke<void>("somnus_env_delete", { id });
}

export async function somnusEnvActivate(id: string | null): Promise<void> {
  return invoke<void>("somnus_env_activate", { id });
}
```

Tauri's IPC maps camelCase JS keys to snake_case Rust params automatically (`parentId` → `parent_id`) — same as every other wrapper in this file.

- [ ] **Step 2: Type-check and commit**

Run: `npm run build` (from worktree root)
Expected: clean.

```bash
git add ui/src/api.ts
git commit -m "feat(somnus): api.ts types + wrappers for tree and environments

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: `vars.ts` — variable resolution (pure)

**Files:**
- Create: `ui/src/somnus/vars.ts`
- Test: `ui/src/somnus/vars.test.ts`

**Interfaces:**
- Consumes: `SomnusEnvVar` from `../api`.
- Produces: `resolveVars(text: string, vars: ReadonlyMap<string, string>): string`, `findUnresolved(text: string, vars: ReadonlyMap<string, string>): string[]`, `envVarsToMap(json: string): Map<string, string>`.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/somnus/vars.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { envVarsToMap, findUnresolved, resolveVars } from "./vars";

const vars = new Map([
  ["base_url", "https://api.test"],
  ["token", "s3cr3t"],
  ["other", "{{token}}"],
]);

describe("resolveVars", () => {
  it("substitutes known variables", () => {
    expect(resolveVars("{{base_url}}/users", vars)).toBe("https://api.test/users");
  });
  it("allows whitespace inside braces", () => {
    expect(resolveVars("{{ base_url }}/x", vars)).toBe("https://api.test/x");
  });
  it("leaves unknown variables literal", () => {
    expect(resolveVars("{{base_url}}/{{nope}}", vars)).toBe("https://api.test/{{nope}}");
  });
  it("is single-pass: values containing {{refs}} stay literal", () => {
    expect(resolveVars("{{other}}", vars)).toBe("{{token}}");
  });
  it("passes through text without variables", () => {
    expect(resolveVars("plain", vars)).toBe("plain");
  });
});

describe("findUnresolved", () => {
  it("lists missing keys once", () => {
    expect(findUnresolved("{{a}} {{b}} {{a}} {{base_url}}", vars)).toEqual(["a", "b"]);
  });
  it("returns empty when everything resolves", () => {
    expect(findUnresolved("{{base_url}}", vars)).toEqual([]);
  });
});

describe("envVarsToMap", () => {
  it("parses the stored JSON and skips blank keys", () => {
    const json = JSON.stringify([
      { key: "a", value: "1", secret: false },
      { key: "", value: "x", secret: false },
      { key: "b", value: "2", secret: true },
    ]);
    const m = envVarsToMap(json);
    expect(m.get("a")).toBe("1");
    expect(m.get("b")).toBe("2");
    expect(m.size).toBe(2);
  });
  it("returns an empty map on garbage", () => {
    expect(envVarsToMap("not json").size).toBe(0);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/somnus/vars.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `ui/src/somnus/vars.ts`:

```ts
import type { SomnusEnvVar } from "../api";

/// {{var_name}} — letters/digits/underscore start, then . and - allowed.
/// Postman-compatible enough for real collections.
const VAR_RE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_.-]*)\s*\}\}/g;

/// Single-pass substitution. A value that itself contains {{refs}} is NOT
/// re-resolved. ponytail: no recursion — add a bounded loop if nested
/// variables ever matter.
export function resolveVars(text: string, vars: ReadonlyMap<string, string>): string {
  return text.replace(VAR_RE, (whole, name: string) => vars.get(name) ?? whole);
}

/// Unique missing variable names, in first-appearance order.
export function findUnresolved(text: string, vars: ReadonlyMap<string, string>): string[] {
  const missing: string[] = [];
  for (const m of text.matchAll(VAR_RE)) {
    const name = m[1];
    if (!vars.has(name) && !missing.includes(name)) missing.push(name);
  }
  return missing;
}

/// Parse a SomnusEnvironment.vars JSON blob into a lookup map.
export function envVarsToMap(json: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed)) return out;
    for (const v of parsed as SomnusEnvVar[]) {
      if (typeof v?.key === "string" && v.key.trim() && typeof v.value === "string") {
        out.set(v.key.trim(), v.value);
      }
    }
  } catch {
    // garbage in the DB → behave as "no variables"
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npx vitest run ui/src/somnus/vars.test.ts` → PASS.

```bash
git add ui/src/somnus/vars.ts ui/src/somnus/vars.test.ts
git commit -m "feat(somnus): {{var}} resolution helpers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: `auth.ts` — auth compilation (pure)

**Files:**
- Create: `ui/src/somnus/auth.ts`
- Test: `ui/src/somnus/auth.test.ts`

**Interfaces:**
- Consumes: `SomnusAuth` from `../api`.
- Produces: `type CompiledAuth = { headers: [string, string][]; query: [string, string][] }`, `compileAuth(auth: SomnusAuth, existingHeaders: [string, string][]): CompiledAuth`.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/somnus/auth.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { compileAuth } from "./auth";

describe("compileAuth", () => {
  it("none produces nothing", () => {
    expect(compileAuth({ type: "none" }, [])).toEqual({ headers: [], query: [] });
  });

  it("bearer produces an Authorization header", () => {
    expect(compileAuth({ type: "bearer", token: "abc" }, []).headers).toEqual([
      ["Authorization", "Bearer abc"],
    ]);
  });

  it("basic produces base64 credentials", () => {
    const { headers } = compileAuth({ type: "basic", username: "u", password: "p" }, []);
    expect(headers).toEqual([["Authorization", `Basic ${btoa("u:p")}`]]);
  });

  it("an explicit Authorization header wins over the auth tab", () => {
    const existing: [string, string][] = [["authorization", "custom"]];
    expect(compileAuth({ type: "bearer", token: "abc" }, existing).headers).toEqual([]);
    expect(compileAuth({ type: "basic", username: "u", password: "p" }, existing).headers).toEqual([]);
  });

  it("apikey in header placement produces a header, guarded by existing", () => {
    expect(
      compileAuth({ type: "apikey", key: "X-Api-Key", value: "k", placement: "header" }, []).headers,
    ).toEqual([["X-Api-Key", "k"]]);
    expect(
      compileAuth(
        { type: "apikey", key: "X-Api-Key", value: "k", placement: "header" },
        [["x-api-key", "mine"]],
      ).headers,
    ).toEqual([]);
  });

  it("apikey in query placement produces a query pair", () => {
    expect(
      compileAuth({ type: "apikey", key: "api_key", value: "k", placement: "query" }, []),
    ).toEqual({ headers: [], query: [["api_key", "k"]] });
  });

  it("empty credentials produce nothing", () => {
    expect(compileAuth({ type: "bearer", token: "" }, []).headers).toEqual([]);
    expect(
      compileAuth({ type: "apikey", key: "", value: "x", placement: "header" }, []).headers,
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/somnus/auth.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `ui/src/somnus/auth.ts`:

```ts
import type { SomnusAuth } from "../api";

export type CompiledAuth = { headers: [string, string][]; query: [string, string][] };

function hasHeader(headers: [string, string][], name: string): boolean {
  const n = name.toLowerCase();
  return headers.some(([k]) => k.trim().toLowerCase() === n);
}

/// Compile the Auth tab into concrete headers / query params.
/// An explicit header typed in the Headers tab always wins (spec §3).
export function compileAuth(auth: SomnusAuth, existingHeaders: [string, string][]): CompiledAuth {
  const out: CompiledAuth = { headers: [], query: [] };
  switch (auth.type) {
    case "none":
      break;
    case "bearer":
      if (auth.token && !hasHeader(existingHeaders, "Authorization")) {
        out.headers.push(["Authorization", `Bearer ${auth.token}`]);
      }
      break;
    case "basic":
      if ((auth.username || auth.password) && !hasHeader(existingHeaders, "Authorization")) {
        out.headers.push(["Authorization", `Basic ${btoa(`${auth.username}:${auth.password}`)}`]);
      }
      break;
    case "apikey":
      if (!auth.key) break;
      if (auth.placement === "header") {
        if (!hasHeader(existingHeaders, auth.key)) out.headers.push([auth.key, auth.value]);
      } else {
        out.query.push([auth.key, auth.value]);
      }
      break;
  }
  return out;
}
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npx vitest run ui/src/somnus/auth.test.ts` → PASS.

```bash
git add ui/src/somnus/auth.ts ui/src/somnus/auth.test.ts
git commit -m "feat(somnus): auth-tab compilation to headers/query

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: `draft.ts` — draft shape, params↔URL sync, send pipeline (pure)

**Files:**
- Create: `ui/src/somnus/draft.ts`
- Test: `ui/src/somnus/draft.test.ts`

**Interfaces:**
- Consumes: `SomnusDraft`, `SomnusRequest`, `SomnusHistoryEntry`, `SomnusBodyMode` from `../api`; `compileAuth` (Task 4); `resolveVars`, `findUnresolved` (Task 3).
- Produces (composer + panel consume all of these):
  - `emptyDraft(): SomnusDraft`
  - `parseDraft(json: string | null): SomnusDraft` — lenient, fills defaults
  - `draftKey(d: SomnusDraft): string` — canonical JSON for dirty comparison
  - `queryRows(url: string): [string, string][]`
  - `withQueryRows(url: string, rows: [string, string][]): string`
  - `serializeForm(rows: [string, string][]): string` / `parseForm(body: string): [string, string][]`
  - `buildRequest(draft: SomnusDraft, vars: ReadonlyMap<string, string>): SomnusRequest`
  - `findUnresolvedDraft(draft: SomnusDraft, vars: ReadonlyMap<string, string>): string[]`
  - `draftFromEntry(e: SomnusHistoryEntry): SomnusDraft`

**CRITICAL gotcha:** URLs containing `{{vars}}` in the host (`https://{{base_url}}/x`) do NOT parse with `new URL()`. All query manipulation is string-based: split on the first `?`, run `URLSearchParams` on the query side only, never parse the prefix.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/somnus/draft.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SomnusDraft, SomnusHistoryEntry } from "../api";
import {
  buildRequest,
  draftFromEntry,
  draftKey,
  emptyDraft,
  findUnresolvedDraft,
  parseDraft,
  parseForm,
  queryRows,
  serializeForm,
  withQueryRows,
} from "./draft";

const vars = new Map([["base_url", "https://api.test"], ["tok", "T"]]);

function draft(over: Partial<SomnusDraft>): SomnusDraft {
  return { ...emptyDraft(), ...over };
}

describe("query rows", () => {
  it("parses rows from the query string, tolerating {{vars}} in the host", () => {
    expect(queryRows("https://{{base_url}}/u?a=1&b=two%20words")).toEqual([
      ["a", "1"],
      ["b", "two words"],
    ]);
    expect(queryRows("https://x.test/plain")).toEqual([]);
  });
  it("writes rows back, dropping blank keys and the dangling ?", () => {
    expect(withQueryRows("https://{{base_url}}/u?old=1", [["a", "1"], ["", "x"]])).toBe(
      "https://{{base_url}}/u?a=1",
    );
    expect(withQueryRows("https://x.test/u?a=1", [])).toBe("https://x.test/u");
  });
});

describe("form body", () => {
  it("round-trips rows through the urlencoded string", () => {
    const rows: [string, string][] = [["a", "1"], ["b", "two words"]];
    expect(parseForm(serializeForm(rows))).toEqual(rows);
  });
});

describe("parseDraft", () => {
  it("fills defaults for missing fields and garbage", () => {
    expect(parseDraft(null)).toEqual(emptyDraft());
    expect(parseDraft("garbage")).toEqual(emptyDraft());
    const d = parseDraft(JSON.stringify({ method: "POST", url: "https://x.test" }));
    expect(d.method).toBe("POST");
    expect(d.body_mode).toBe("none");
    expect(d.auth).toEqual({ type: "none" });
  });
});

describe("buildRequest", () => {
  it("resolves vars in url, headers, and body", () => {
    const req = buildRequest(
      draft({
        method: "POST",
        url: "{{base_url}}/u",
        headers: [["X-T", "{{tok}}"]],
        body: '{"t":"{{tok}}"}',
        body_mode: "json",
      }),
      vars,
    );
    expect(req.url).toBe("https://api.test/u");
    expect(req.headers).toContainEqual(["X-T", "T"]);
    expect(req.body).toBe('{"t":"T"}');
  });

  it("merges compiled auth headers and query", () => {
    const req = buildRequest(
      draft({
        url: "https://x.test/u",
        auth: { type: "apikey", key: "k", value: "{{tok}}", placement: "query" },
      }),
      vars,
    );
    expect(req.url).toBe("https://x.test/u?k=T");
    const req2 = buildRequest(
      draft({ url: "https://x.test/u", auth: { type: "bearer", token: "abc" } }),
      vars,
    );
    expect(req2.headers).toContainEqual(["Authorization", "Bearer abc"]);
  });

  it("auto-sets Content-Type for json and form modes unless present", () => {
    const j = buildRequest(draft({ url: "https://x.test", body: "{}", body_mode: "json" }), vars);
    expect(j.headers).toContainEqual(["Content-Type", "application/json"]);
    const f = buildRequest(draft({ url: "https://x.test", body: "a=1", body_mode: "form" }), vars);
    expect(f.headers).toContainEqual(["Content-Type", "application/x-www-form-urlencoded"]);
    const explicit = buildRequest(
      draft({
        url: "https://x.test",
        body: "{}",
        body_mode: "json",
        headers: [["content-type", "application/vnd.custom+json"]],
      }),
      vars,
    );
    expect(explicit.headers.filter(([k]) => k.toLowerCase() === "content-type")).toHaveLength(1);
  });

  it("none mode sends no body; empty body sends null", () => {
    expect(buildRequest(draft({ url: "https://x.test", body: "x", body_mode: "none" }), vars).body).toBeNull();
    expect(buildRequest(draft({ url: "https://x.test", body: "", body_mode: "json" }), vars).body).toBeNull();
  });

  it("skips blank header rows", () => {
    const req = buildRequest(
      draft({ url: "https://x.test", headers: [["", "x"], ["A", "1"]] }),
      vars,
    );
    expect(req.headers).toEqual([["A", "1"]]);
  });
});

describe("findUnresolvedDraft", () => {
  it("unions missing keys across url, headers, body, and auth", () => {
    const missing = findUnresolvedDraft(
      draft({
        url: "{{host}}/u",
        headers: [["X", "{{h}}"]],
        body: "{{b}}",
        body_mode: "text",
        auth: { type: "bearer", token: "{{t}}" },
      }),
      vars,
    );
    expect(missing).toEqual(["host", "h", "b", "t"]);
  });
});

describe("draftKey / draftFromEntry", () => {
  it("draftKey is stable for equal drafts", () => {
    expect(draftKey(draft({ url: "https://x.test" }))).toBe(draftKey(draft({ url: "https://x.test" })));
    expect(draftKey(draft({ url: "https://x.test" }))).not.toBe(draftKey(draft({ url: "https://y.test" })));
  });
  it("draftFromEntry maps a history row into a draft", () => {
    const entry = {
      id: "1",
      method: "POST",
      url: "https://x.test/u",
      req_headers: [["content-type", "application/json"]],
      req_body: "{}",
      status: 200,
      resp_headers: [],
      resp_body: null,
      error: null,
      duration_ms: 1,
      size_bytes: 1,
      created_at_unix_ms: 0,
    } as SomnusHistoryEntry;
    const d = draftFromEntry(entry);
    expect(d.method).toBe("POST");
    expect(d.body).toBe("{}");
    expect(d.body_mode).toBe("json"); // inferred from content-type
    expect(d.auth).toEqual({ type: "none" });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/somnus/draft.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `ui/src/somnus/draft.ts`:

```ts
import type { SomnusAuth, SomnusBodyMode, SomnusDraft, SomnusHistoryEntry, SomnusRequest } from "../api";
import { compileAuth } from "./auth";
import { findUnresolved, resolveVars } from "./vars";

const BODY_MODES: SomnusBodyMode[] = ["none", "json", "text", "form"];

export function emptyDraft(): SomnusDraft {
  return { method: "GET", url: "", headers: [], body: "", body_mode: "none", auth: { type: "none" } };
}

/// Lenient parse of a stored draft blob — unknown/missing fields fall back
/// to defaults so old rows keep loading as the shape evolves.
export function parseDraft(json: string | null): SomnusDraft {
  const d = emptyDraft();
  if (!json) return d;
  try {
    const raw: unknown = JSON.parse(json);
    if (typeof raw !== "object" || raw === null) return d;
    const r = raw as Record<string, unknown>;
    if (typeof r.method === "string" && r.method) d.method = r.method;
    if (typeof r.url === "string") d.url = r.url;
    if (Array.isArray(r.headers)) {
      d.headers = (r.headers as unknown[])
        .filter((h): h is [string, string] => Array.isArray(h) && typeof h[0] === "string" && typeof h[1] === "string")
        .map((h) => [h[0], h[1]]);
    }
    if (typeof r.body === "string") d.body = r.body;
    if (BODY_MODES.includes(r.body_mode as SomnusBodyMode)) d.body_mode = r.body_mode as SomnusBodyMode;
    const a = r.auth as SomnusAuth | undefined;
    if (a && typeof a === "object" && ["none", "bearer", "basic", "apikey"].includes(a.type)) d.auth = a;
  } catch {
    // garbage → defaults
  }
  return d;
}

/// Canonical string for dirty comparison (field order fixed by emptyDraft).
export function draftKey(d: SomnusDraft): string {
  return JSON.stringify({
    method: d.method,
    url: d.url,
    headers: d.headers,
    body: d.body,
    body_mode: d.body_mode,
    auth: d.auth,
  });
}

// URLs may hold {{vars}} in the host, which new URL() rejects — all query
// manipulation is string-based on the part after the first "?".
function splitUrl(url: string): { base: string; query: string } {
  const i = url.indexOf("?");
  return i === -1 ? { base: url, query: "" } : { base: url.slice(0, i), query: url.slice(i + 1) };
}

export function queryRows(url: string): [string, string][] {
  const { query } = splitUrl(url);
  if (!query) return [];
  return [...new URLSearchParams(query).entries()];
}

export function withQueryRows(url: string, rows: [string, string][]): string {
  const { base } = splitUrl(url);
  const sp = new URLSearchParams();
  for (const [k, v] of rows) if (k.trim()) sp.append(k, v);
  const q = sp.toString();
  return q ? `${base}?${q}` : base;
}

export function serializeForm(rows: [string, string][]): string {
  const sp = new URLSearchParams();
  for (const [k, v] of rows) if (k.trim()) sp.append(k, v);
  return sp.toString();
}

export function parseForm(body: string): [string, string][] {
  if (!body) return [];
  return [...new URLSearchParams(body).entries()];
}

function hasHeader(headers: [string, string][], name: string): boolean {
  const n = name.toLowerCase();
  return headers.some(([k]) => k.trim().toLowerCase() === n);
}

const AUTO_CONTENT_TYPE: Partial<Record<SomnusBodyMode, string>> = {
  json: "application/json",
  form: "application/x-www-form-urlencoded",
};

/// The send pipeline (spec §Send pipeline):
/// draft → compileAuth → merge params/headers → resolveVars → SomnusRequest.
export function buildRequest(draft: SomnusDraft, vars: ReadonlyMap<string, string>): SomnusRequest {
  const headers = draft.headers.filter(([k]) => k.trim() !== "");
  const auth = compileAuth(draft.auth, headers);
  const merged = [...headers, ...auth.headers];
  let url = draft.url.trim();
  if (auth.query.length) url = withQueryRows(url, [...queryRows(url), ...auth.query]);
  const auto = AUTO_CONTENT_TYPE[draft.body_mode];
  const body = draft.body_mode !== "none" && draft.body ? draft.body : null;
  if (body && auto && !hasHeader(merged, "Content-Type")) merged.push(["Content-Type", auto]);
  return {
    method: draft.method,
    url: resolveVars(url, vars),
    headers: merged.map(([k, v]) => [resolveVars(k, vars), resolveVars(v, vars)]),
    body: body === null ? null : resolveVars(body, vars),
  };
}

/// Missing {{keys}} across every field the pipeline resolves.
export function findUnresolvedDraft(draft: SomnusDraft, vars: ReadonlyMap<string, string>): string[] {
  const texts: string[] = [draft.url];
  for (const [k, v] of draft.headers) texts.push(k, v);
  if (draft.body_mode !== "none") texts.push(draft.body);
  const a = draft.auth;
  if (a.type === "bearer") texts.push(a.token);
  else if (a.type === "basic") texts.push(a.username, a.password);
  else if (a.type === "apikey") texts.push(a.key, a.value);
  const missing: string[] = [];
  for (const t of texts) {
    for (const k of findUnresolved(t, vars)) if (!missing.includes(k)) missing.push(k);
  }
  return missing;
}

/// History rows predate drafts — infer body_mode from the content-type.
export function draftFromEntry(e: SomnusHistoryEntry): SomnusDraft {
  const ct = e.req_headers.find(([k]) => k.toLowerCase() === "content-type")?.[1] ?? "";
  let body_mode: SomnusBodyMode = "none";
  if (e.req_body) {
    if (ct.includes("json")) body_mode = "json";
    else if (ct.includes("x-www-form-urlencoded")) body_mode = "form";
    else body_mode = "text";
  }
  return {
    method: e.method,
    url: e.url,
    headers: e.req_headers.map(([k, v]) => [k, v]),
    body: e.req_body ?? "",
    body_mode,
    auth: { type: "none" },
  };
}
```

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npx vitest run ui/src/somnus/draft.test.ts` → PASS. Also `npx vitest run ui/src/somnus` — v1 suites still green.

```bash
git add ui/src/somnus/draft.ts ui/src/somnus/draft.test.ts
git commit -m "feat(somnus): draft model, params/url sync, send pipeline

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: `postman.ts` — Postman v2.1 / environment import parser (pure)

**Files:**
- Create: `ui/src/somnus/postman.ts`
- Test: `ui/src/somnus/postman.test.ts`

**Interfaces:**
- Consumes: `SomnusDraft`, `SomnusImportNode`, `SomnusEnvVar` from `../api`; `serializeForm` from `./draft`.
- Produces:
  - `type PostmanResult = { kind: "collection"; name: string; nodes: SomnusImportNode[]; requests: number; skipped: string[] } | { kind: "environment"; name: string; vars: SomnusEnvVar[] } | null`
  - `parsePostman(json: string): PostmanResult`

Postman `{{var}}` syntax is identical to ours — variables pass through untouched. Unsupported features (scripts/events, formdata/file/graphql bodies, disabled entries, unknown auth types) are **dropped with a note** pushed into `skipped` — never silently (spec §5).

- [ ] **Step 1: Write the failing tests**

Create `ui/src/somnus/postman.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePostman } from "./postman";
import { parseDraft } from "./draft";

const collection = {
  info: { name: "My API", schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json" },
  item: [
    {
      name: "Users",
      item: [
        {
          name: "List users",
          event: [{ listen: "test", script: { exec: ["pm.test()"] } }],
          request: {
            method: "GET",
            url: { raw: "{{base_url}}/users?page=1" },
            header: [
              { key: "Accept", value: "application/json" },
              { key: "X-Off", value: "x", disabled: true },
            ],
            auth: { type: "bearer", bearer: [{ key: "token", value: "{{tok}}", type: "string" }] },
          },
        },
      ],
    },
    {
      name: "Login",
      request: {
        method: "POST",
        url: "https://x.test/login",
        body: { mode: "urlencoded", urlencoded: [{ key: "u", value: "a" }, { key: "p", value: "b" }] },
      },
    },
    {
      name: "Upload",
      request: {
        method: "POST",
        url: "https://x.test/up",
        body: { mode: "formdata", formdata: [{ key: "f", type: "file" }] },
      },
    },
  ],
};

const environment = {
  name: "Staging",
  values: [
    { key: "base_url", value: "https://stg.test", enabled: true, type: "default" },
    { key: "tok", value: "s3cret", enabled: true, type: "secret" },
    { key: "off", value: "x", enabled: false },
  ],
};

describe("parsePostman collection", () => {
  const r = parsePostman(JSON.stringify(collection));
  it("detects a v2.1 collection and counts requests", () => {
    expect(r?.kind).toBe("collection");
    if (r?.kind !== "collection") return;
    expect(r.name).toBe("My API");
    expect(r.requests).toBe(3);
    expect(r.nodes).toHaveLength(3);
  });
  it("maps folders recursively and requests into drafts", () => {
    if (r?.kind !== "collection") return;
    const folder = r.nodes[0];
    expect(folder.kind).toBe("folder");
    expect(folder.children).toHaveLength(1);
    const draft = parseDraft(folder.children[0].request);
    expect(draft.method).toBe("GET");
    expect(draft.url).toBe("{{base_url}}/users?page=1");
    expect(draft.headers).toEqual([["Accept", "application/json"]]);
    expect(draft.auth).toEqual({ type: "bearer", token: "{{tok}}" });
  });
  it("maps urlencoded bodies to form mode", () => {
    if (r?.kind !== "collection") return;
    const draft = parseDraft(r.nodes[1].request);
    expect(draft.body_mode).toBe("form");
    expect(draft.body).toBe("u=a&p=b");
  });
  it("notes skipped features instead of dropping silently", () => {
    if (r?.kind !== "collection") return;
    expect(r.skipped.some((s) => s.includes("script"))).toBe(true);
    expect(r.skipped.some((s) => s.includes("formdata"))).toBe(true);
    expect(r.skipped.some((s) => s.includes("disabled"))).toBe(true);
  });
});

describe("parsePostman environment", () => {
  it("maps values incl. secret typing, skipping disabled", () => {
    const r = parsePostman(JSON.stringify(environment));
    expect(r?.kind).toBe("environment");
    if (r?.kind !== "environment") return;
    expect(r.name).toBe("Staging");
    expect(r.vars).toEqual([
      { key: "base_url", value: "https://stg.test", secret: false },
      { key: "tok", value: "s3cret", secret: true },
    ]);
  });
});

describe("parsePostman rejects", () => {
  it("garbage and unknown schemas return null", () => {
    expect(parsePostman("not json")).toBeNull();
    expect(parsePostman(JSON.stringify({ hello: 1 }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/somnus/postman.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `ui/src/somnus/postman.ts`:

```ts
import type { SomnusAuth, SomnusDraft, SomnusEnvVar, SomnusImportNode } from "../api";
import { serializeForm } from "./draft";

export type PostmanResult =
  | { kind: "collection"; name: string; nodes: SomnusImportNode[]; requests: number; skipped: string[] }
  | { kind: "environment"; name: string; vars: SomnusEnvVar[] }
  | null;

type Obj = Record<string, unknown>;

const asObj = (v: unknown): Obj | null => (typeof v === "object" && v !== null ? (v as Obj) : null);
const asStr = (v: unknown): string => (typeof v === "string" ? v : "");

/// Postman v2.1 auth params are arrays of {key,value}; fetch one by key.
function pv(list: unknown, key: string): string {
  if (!Array.isArray(list)) return "";
  const hit = list.map(asObj).find((o) => o && asStr(o.key) === key);
  return hit ? asStr(hit.value) : "";
}

function mapAuth(raw: unknown, skipped: string[], at: string): SomnusAuth {
  const a = asObj(raw);
  if (!a) return { type: "none" };
  const t = asStr(a.type);
  if (t === "bearer") return { type: "bearer", token: pv(a.bearer, "token") };
  if (t === "basic") {
    return { type: "basic", username: pv(a.basic, "username"), password: pv(a.basic, "password") };
  }
  if (t === "apikey") {
    const placement = pv(a.apikey, "in") === "query" ? "query" : "header";
    return { type: "apikey", key: pv(a.apikey, "key"), value: pv(a.apikey, "value"), placement };
  }
  if (t && t !== "noauth") skipped.push(`${at}: auth type "${t}" not supported`);
  return { type: "none" };
}

function mapRequest(name: string, raw: Obj, skipped: string[]): SomnusImportNode {
  const draft: SomnusDraft = {
    method: asStr(raw.method) || "GET",
    url: asStr(raw.url) || asStr(asObj(raw.url)?.raw),
    headers: [],
    body: "",
    body_mode: "none",
    auth: mapAuth(raw.auth, skipped, name),
  };
  if (Array.isArray(raw.header)) {
    for (const h of raw.header.map(asObj)) {
      if (!h) continue;
      if (h.disabled === true) {
        skipped.push(`${name}: disabled header "${asStr(h.key)}"`);
        continue;
      }
      draft.headers.push([asStr(h.key), asStr(h.value)]);
    }
  }
  const body = asObj(raw.body);
  if (body) {
    const mode = asStr(body.mode);
    if (mode === "raw") {
      draft.body = asStr(body.raw);
      const lang = asStr(asObj(asObj(body.options)?.raw)?.language);
      draft.body_mode = lang === "json" || draft.body.trim().startsWith("{") ? "json" : "text";
    } else if (mode === "urlencoded" && Array.isArray(body.urlencoded)) {
      const rows: [string, string][] = [];
      for (const p of body.urlencoded.map(asObj)) {
        if (!p || p.disabled === true) continue;
        rows.push([asStr(p.key), asStr(p.value)]);
      }
      draft.body = serializeForm(rows);
      draft.body_mode = "form";
    } else if (mode) {
      skipped.push(`${name}: ${mode} body not supported`);
    }
  }
  if (Array.isArray(raw.event) && raw.event.length) {
    skipped.push(`${name}: scripts/tests not supported`);
  }
  return { kind: "request", name, request: JSON.stringify(draft), children: [] };
}

function mapItems(items: unknown[], skipped: string[], count: { n: number }): SomnusImportNode[] {
  const out: SomnusImportNode[] = [];
  for (const it of items.map(asObj)) {
    if (!it) continue;
    const name = asStr(it.name) || "Untitled";
    if (Array.isArray(it.item)) {
      if (Array.isArray(it.event) && it.event.length) skipped.push(`${name}: folder scripts not supported`);
      out.push({ kind: "folder", name, request: null, children: mapItems(it.item, skipped, count) });
    } else {
      const req = asObj(it.request);
      if (!req) continue;
      if (Array.isArray(it.event) && it.event.length) skipped.push(`${name}: scripts/tests not supported`);
      const node = mapRequest(name, req, skipped);
      count.n += 1;
      out.push(node);
    }
  }
  return out;
}

/// Detects and parses a Postman Collection v2.1 or Environment export.
/// Returns null when the JSON is neither.
export function parsePostman(json: string): PostmanResult {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const root = asObj(raw);
  if (!root) return null;

  const info = asObj(root.info);
  if (info && Array.isArray(root.item)) {
    const skipped: string[] = [];
    const count = { n: 0 };
    const nodes = mapItems(root.item, skipped, count);
    return { kind: "collection", name: asStr(info.name) || "Imported", nodes, requests: count.n, skipped };
  }

  if (Array.isArray(root.values) && typeof root.name === "string") {
    const vars: SomnusEnvVar[] = [];
    for (const v of root.values.map(asObj)) {
      if (!v || v.enabled === false) continue;
      const key = asStr(v.key).trim();
      if (!key) continue;
      vars.push({ key, value: asStr(v.value), secret: asStr(v.type) === "secret" });
    }
    return { kind: "environment", name: root.name, vars };
  }

  return null;
}
```

Note the double count in `mapItems` vs `mapRequest`: `count.n` increments in `mapItems` only (single source). The test expects `requests: 3`.

- [ ] **Step 4: Run to verify pass, then commit**

Run: `npx vitest run ui/src/somnus/postman.test.ts` → PASS.

```bash
git add ui/src/somnus/postman.ts ui/src/somnus/postman.test.ts
git commit -m "feat(somnus): postman v2.1 collection + environment import parser

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: `composer.ts` — the four-tab request composer component

**Files:**
- Create: `ui/src/somnus/composer.ts`
- Test: `ui/src/somnus/composer.test.ts` (jsdom roundtrip — vitest env is jsdom)

**Interfaces:**
- Consumes: `CustomSelect`, `Icons`, `attachTooltip`, `parseCurl`, and from `./draft`: `emptyDraft`, `parseForm`, `queryRows`, `serializeForm`, `withQueryRows`.
- Produces:
  - `export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]` (moves here from panel.ts)
  - `class RequestComposer` with: `readonly element: HTMLElement`, `getDraft(): SomnusDraft`, `setDraft(d: SomnusDraft): void`, `setEnvs(envs: SomnusEnvironment[], activeId: string | null): void`, `markUnresolved(missing: string[], urlAffected: boolean): void`, `setSending(b: boolean): void`, `focusUrl(): void`
  - Constructor opts: `{ onSend: () => void; onSave: () => void; onDirty: () => void; onEnvChange: (id: string | null) => void }`

Behavior requirements (from spec §3):
- Tab strip **Params · Auth · Headers · Body** (`.rail-tab` buttons), each with a trailing `.somnus-badge` span: params/headers show counts when > 0; auth/body show `●` when non-default. Active pane toggled by a root class `somnus-tab-<name>` (CSS does the show/hide, same as v1's headers/body flip).
- **Params ↔ URL sync**: editing the URL re-renders param rows (`queryRows`); editing a param row rewrites the URL (`withQueryRows`). A `syncing` boolean guards re-entrancy. Rebuild-rows only happens on URL edits (focus is in the URL input, so no focus loss).
- **Body**: the textarea is ALWAYS the canonical body string. Form mode hides the textarea and shows key/value rows projected via `parseForm`; editing form rows writes `serializeForm(rows)` back into the textarea. Switching modes never mutates the body. JSON mode gets a "Format" action (local `JSON.parse`/`stringify` — do NOT import `prettyBody` from panel.ts, that would be a cycle). None mode shows a `.rail-notice` hint ("This request sends no body."). **No method gating** — v1's `BODY_METHODS` logic is deleted.
- **Auth**: `CustomSelect` (None/Bearer/Basic/API Key) + per-type fields rebuilt on change: bearer → token input; basic → username + password (`type="password"`); apikey → key, value, placement `CustomSelect` (Header/Query).
- **Env select**: its own compact row under the method/URL line (`.somnus-envline`) — works in both rail and expanded. Options: "No environment" (`value: ""`) + one per env; `onChange` → `opts.onEnvChange(v || null)`.
- **Send enablement**: URL non-empty (trimmed) → enabled. v1's `new URL()` validation is deleted — `{{vars}}` in the host don't parse; the backend validates post-resolution.
- **curl paste** on the URL input: unchanged from v1 (parse → `setDraft` with curl fields merged over `emptyDraft()` → `onDirty`).
- Every input: `spellcheck = false`, class `rail-search` (kv rows, url) so the v1 sharp-corner reset applies. Enter in URL → `onSend` if enabled.
- Unresolved warning: `.somnus-var-warn` line under the env row; `markUnresolved(["a","b"], true)` sets its text to `Unresolved: a, b`, unhides it, and toggles `.is-unresolved` on the URL input per `urlAffected`. Empty list hides it.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/somnus/composer.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SomnusDraft } from "../api";
import { RequestComposer } from "./composer";

function mk() {
  const opts = {
    onSend: vi.fn(),
    onSave: vi.fn(),
    onDirty: vi.fn(),
    onEnvChange: vi.fn(),
  };
  const c = new RequestComposer(opts);
  document.body.append(c.element);
  return { c, opts };
}

const full: SomnusDraft = {
  method: "POST",
  url: "https://{{base_url}}/u?page=2",
  headers: [["Accept", "application/json"]],
  body: '{"a":1}',
  body_mode: "json",
  auth: { type: "bearer", token: "{{tok}}" },
};

describe("RequestComposer", () => {
  it("round-trips a full draft through setDraft/getDraft", () => {
    const { c } = mk();
    c.setDraft(full);
    expect(c.getDraft()).toEqual(full);
  });

  it("projects URL query into param rows and back", () => {
    const { c } = mk();
    c.setDraft({ ...full, url: "https://x.test/u?a=1&b=2" });
    const keys = [...c.element.querySelectorAll(".somnus-pane-params input")].map(
      (i) => (i as HTMLInputElement).value,
    );
    expect(keys).toContain("a");
    expect(keys).toContain("b");
  });

  it("form mode round-trips rows through the body string", () => {
    const { c } = mk();
    c.setDraft({ ...full, body: "u=a&p=b", body_mode: "form", auth: { type: "none" } });
    const d = c.getDraft();
    expect(d.body).toBe("u=a&p=b");
    expect(d.body_mode).toBe("form");
  });

  it("shows the unresolved warning", () => {
    const { c } = mk();
    c.markUnresolved(["base_url"], true);
    const warn = c.element.querySelector(".somnus-var-warn") as HTMLElement;
    expect(warn.textContent).toContain("base_url");
    expect(warn.classList.contains("hidden")).toBe(false);
    c.markUnresolved([], false);
    expect(warn.classList.contains("hidden")).toBe(true);
  });

  it("send disabled only when URL is blank", () => {
    const { c } = mk();
    const send = c.element.querySelector(".somnus-send") as HTMLButtonElement;
    c.setDraft({ ...full, url: "" });
    expect(send.disabled).toBe(true);
    c.setDraft({ ...full, url: "{{base_url}}/x" });
    expect(send.disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/somnus/composer.test.ts` → FAIL (module not found).

- [ ] **Step 3: Implement**

Create `ui/src/somnus/composer.ts`. Full skeleton (the kv-row builder is the workhorse — one implementation for params/headers/form):

```ts
import type { SomnusAuth, SomnusBodyMode, SomnusDraft, SomnusEnvironment } from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { CustomSelect } from "../ui/select";
import { parseCurl } from "./curl";
import { emptyDraft, parseForm, queryRows, serializeForm, withQueryRows } from "./draft";

export const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export type ComposerTab = "params" | "auth" | "headers" | "body";
const TABS: [ComposerTab, string][] = [
  ["params", "Params"],
  ["auth", "Auth"],
  ["headers", "Headers"],
  ["body", "Body"],
];

interface KvRow {
  row: HTMLElement;
  key: HTMLInputElement;
  val: HTMLInputElement;
}

export interface ComposerOpts {
  onSend: () => void;
  onSave: () => void;
  onDirty: () => void;
  onEnvChange: (id: string | null) => void;
}

export class RequestComposer {
  readonly element: HTMLElement;
  private methodSel: CustomSelect;
  private urlInput: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private envSel: CustomSelect;
  private warnEl: HTMLElement;
  private tabBtns = new Map<ComposerTab, { btn: HTMLButtonElement; badge: HTMLElement }>();
  private paramsHost!: HTMLElement;
  private headersHost!: HTMLElement;
  private formHost!: HTMLElement;
  private paramRows: KvRow[] = [];
  private headerRows: KvRow[] = [];
  private formRows: KvRow[] = [];
  private bodyArea: HTMLTextAreaElement;
  private bodyModeSel: CustomSelect;
  private authTypeSel: CustomSelect;
  private authFields: HTMLElement;
  private auth: SomnusAuth = { type: "none" };
  private activeTab: ComposerTab = "params";
  private syncing = false;
  private sending = false;

  constructor(private opts: ComposerOpts) {
    this.element = document.createElement("div");
    this.element.className = "somnus-composer";

    // ── method / url / send ──
    const line = document.createElement("div");
    line.className = "somnus-line";
    this.methodSel = new CustomSelect({
      className: "somnus-method",
      ariaLabel: "HTTP method",
      value: "GET",
      options: METHODS.map((m) => ({ value: m, label: m })),
      onChange: () => this.opts.onDirty(),
    });
    this.urlInput = document.createElement("input");
    this.urlInput.className = "rail-search somnus-url";
    this.urlInput.type = "text";
    this.urlInput.placeholder = "https://{{base_url}}/…  (or paste a curl command)";
    this.urlInput.spellcheck = false;
    this.urlInput.addEventListener("input", () => {
      this.syncSendEnabled();
      if (!this.syncing) {
        this.syncing = true;
        this.renderParamRows(queryRows(this.urlInput.value));
        this.syncing = false;
      }
      this.updateBadges();
      this.opts.onDirty();
    });
    this.urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.sendBtn.disabled) this.opts.onSend();
    });
    this.urlInput.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const parsed = parseCurl(text);
      if (!parsed) return;
      e.preventDefault();
      this.setDraft({
        ...emptyDraft(),
        method: METHODS.includes(parsed.method) ? parsed.method : "GET",
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body ?? "",
        body_mode: parsed.body ? "text" : "none",
      });
      this.opts.onDirty();
    });
    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "somnus-send";
    this.sendBtn.type = "button";
    this.sendBtn.textContent = "Send";
    this.sendBtn.disabled = true;
    this.sendBtn.addEventListener("click", () => this.opts.onSend());
    const saveBtn = document.createElement("button");
    saveBtn.className = "rail-btn somnus-save";
    saveBtn.type = "button";
    saveBtn.setAttribute("aria-label", "Save to collection (⌘S)");
    saveBtn.innerHTML = Icons.save({ size: 15 });
    attachTooltip(saveBtn, "Save to collection (⌘S)");
    saveBtn.addEventListener("click", () => this.opts.onSave());
    line.append(this.methodSel.element, this.urlInput, this.sendBtn, saveBtn);

    // ── environment row ──
    const envLine = document.createElement("div");
    envLine.className = "somnus-envline";
    this.envSel = new CustomSelect({
      className: "somnus-envsel",
      ariaLabel: "Active environment",
      value: "",
      options: [{ value: "", label: "No environment" }],
      onChange: (v) => this.opts.onEnvChange(v || null),
    });
    envLine.append(this.envSel.element);

    this.warnEl = document.createElement("div");
    this.warnEl.className = "somnus-var-warn hidden";

    // ── tabs ──
    const controls = document.createElement("div");
    controls.className = "rail-controls";
    const tabs = document.createElement("div");
    tabs.className = "rail-tabs somnus-tabs";
    for (const [id, label] of TABS) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "rail-tab";
      btn.dataset.tab = id;
      const text = document.createElement("span");
      text.textContent = label;
      const badge = document.createElement("span");
      badge.className = "somnus-badge";
      btn.append(text, badge);
      btn.addEventListener("click", () => this.setTab(id));
      tabs.append(btn);
      this.tabBtns.set(id, { btn, badge });
    }
    controls.append(tabs);

    // ── panes ──
    const paramsPane = document.createElement("div");
    paramsPane.className = "somnus-pane somnus-pane-params";
    this.paramsHost = document.createElement("div");
    this.paramsHost.className = "somnus-kv";
    paramsPane.append(this.paramsHost, this.addRowButton("+ param", () => {
      this.addKvRow(this.paramRows, this.paramsHost, "", "", () => this.paramsChanged());
    }));

    const authPane = document.createElement("div");
    authPane.className = "somnus-pane somnus-pane-auth";
    this.authTypeSel = new CustomSelect({
      className: "somnus-authsel",
      ariaLabel: "Auth type",
      value: "none",
      options: [
        { value: "none", label: "None" },
        { value: "bearer", label: "Bearer token" },
        { value: "basic", label: "Basic auth" },
        { value: "apikey", label: "API key" },
      ],
      onChange: (v) => {
        this.auth = this.defaultAuth(v);
        this.renderAuthFields();
        this.updateBadges();
        this.opts.onDirty();
      },
    });
    this.authFields = document.createElement("div");
    this.authFields.className = "somnus-auth-fields";
    authPane.append(this.authTypeSel.element, this.authFields);

    const headersPane = document.createElement("div");
    headersPane.className = "somnus-pane somnus-pane-headers";
    this.headersHost = document.createElement("div");
    this.headersHost.className = "somnus-kv";
    headersPane.append(this.headersHost, this.addRowButton("+ header", () => {
      this.addKvRow(this.headerRows, this.headersHost, "", "", () => {
        this.updateBadges();
        this.opts.onDirty();
      });
    }));

    const bodyPane = document.createElement("div");
    bodyPane.className = "somnus-pane somnus-pane-body";
    const bodyBar = document.createElement("div");
    bodyBar.className = "somnus-bodybar";
    this.bodyModeSel = new CustomSelect({
      className: "somnus-bodymode",
      ariaLabel: "Body mode",
      value: "none",
      options: [
        { value: "none", label: "None" },
        { value: "json", label: "JSON" },
        { value: "text", label: "Text" },
        { value: "form", label: "Form URL-encoded" },
      ],
      onChange: () => {
        this.renderBodyMode();
        this.updateBadges();
        this.opts.onDirty();
      },
    });
    const formatBtn = document.createElement("button");
    formatBtn.type = "button";
    formatBtn.className = "rail-btn somnus-format";
    formatBtn.textContent = "Format";
    formatBtn.addEventListener("click", () => {
      try {
        this.bodyArea.value = JSON.stringify(JSON.parse(this.bodyArea.value), null, 2);
        this.opts.onDirty();
      } catch {
        // not JSON — leave as-is
      }
    });
    bodyBar.append(this.bodyModeSel.element, formatBtn);
    this.bodyArea = document.createElement("textarea");
    this.bodyArea.className = "somnus-bodybox";
    this.bodyArea.placeholder = "Request body";
    this.bodyArea.spellcheck = false;
    this.bodyArea.addEventListener("input", () => {
      this.updateBadges();
      this.opts.onDirty();
    });
    this.formHost = document.createElement("div");
    this.formHost.className = "somnus-kv somnus-form";
    const bodyHint = document.createElement("div");
    bodyHint.className = "rail-notice somnus-body-hint";
    bodyHint.textContent = "This request sends no body.";
    bodyPane.append(
      bodyBar,
      this.bodyArea,
      this.formHost,
      this.addRowButton("+ field", () => {
        this.addKvRow(this.formRows, this.formHost, "", "", () => this.formChanged());
      }),
      bodyHint,
    );

    this.element.append(line, envLine, this.warnEl, controls, paramsPane, authPane, headersPane, bodyPane);
    this.setTab("params");
    this.renderBodyMode();
    this.renderAuthFields();
    this.updateBadges();
  }

  // ── public API ──

  getDraft(): SomnusDraft {
    return {
      method: this.methodSel.value,
      url: this.urlInput.value.trim(),
      headers: this.rowsValues(this.headerRows),
      body: this.bodyArea.value,
      body_mode: this.bodyModeSel.value as SomnusBodyMode,
      auth: this.readAuth(),
    };
  }

  setDraft(d: SomnusDraft): void {
    this.syncing = true;
    this.methodSel.value = METHODS.includes(d.method) ? d.method : "GET";
    this.urlInput.value = d.url;
    this.renderKvRows(this.headerRows, this.headersHost, d.headers, () => {
      this.updateBadges();
      this.opts.onDirty();
    });
    this.bodyArea.value = d.body;
    this.bodyModeSel.value = d.body_mode;
    this.auth = d.auth;
    this.authTypeSel.value = d.auth.type;
    this.renderAuthFields();
    this.renderParamRows(queryRows(d.url));
    this.renderBodyMode();
    this.syncing = false;
    this.syncSendEnabled();
    this.updateBadges();
  }

  setEnvs(envs: SomnusEnvironment[], activeId: string | null): void {
    this.envSel.setOptions(
      [{ value: "", label: "No environment" }, ...envs.map((e) => ({ value: e.id, label: e.name }))],
      activeId ?? "",
    );
  }

  markUnresolved(missing: string[], urlAffected: boolean): void {
    this.warnEl.classList.toggle("hidden", missing.length === 0);
    this.warnEl.textContent = missing.length ? `Unresolved: ${missing.join(", ")}` : "";
    this.urlInput.classList.toggle("is-unresolved", urlAffected && missing.length > 0);
  }

  setSending(b: boolean): void {
    this.sending = b;
    this.sendBtn.textContent = b ? "…" : "Send";
    this.syncSendEnabled();
  }

  focusUrl(): void {
    this.urlInput.focus();
  }

  // ── internals ──

  private syncSendEnabled(): void {
    this.sendBtn.disabled = this.sending || this.urlInput.value.trim() === "";
  }

  private setTab(tab: ComposerTab): void {
    this.activeTab = tab;
    for (const [id, { btn }] of this.tabBtns) {
      btn.classList.toggle("is-active", id === tab);
      this.element.classList.toggle(`somnus-tab-${id}`, id === tab);
    }
  }

  private addRowButton(label: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "somnus-add-row";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  private addKvRow(
    rows: KvRow[],
    host: HTMLElement,
    k: string,
    v: string,
    onEdit: () => void,
  ): void {
    const row = document.createElement("div");
    row.className = "somnus-kv-row";
    const key = document.createElement("input");
    key.className = "rail-search";
    key.type = "text";
    key.placeholder = "Key";
    key.spellcheck = false;
    key.value = k;
    const val = document.createElement("input");
    val.className = "rail-search";
    val.type = "text";
    val.placeholder = "Value";
    val.spellcheck = false;
    val.value = v;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rail-btn";
    rm.setAttribute("aria-label", "Remove");
    rm.innerHTML = Icons.x({ size: 13 });
    rm.addEventListener("click", () => {
      row.remove();
      const i = rows.findIndex((r) => r.row === row);
      if (i !== -1) rows.splice(i, 1);
      onEdit();
    });
    key.addEventListener("input", onEdit);
    val.addEventListener("input", onEdit);
    row.append(key, val, rm);
    host.append(row);
    rows.push({ row, key, val });
  }

  private renderKvRows(
    rows: KvRow[],
    host: HTMLElement,
    values: [string, string][],
    onEdit: () => void,
  ): void {
    host.replaceChildren();
    rows.length = 0;
    for (const [k, v] of values) this.addKvRow(rows, host, k, v, onEdit);
    if (rows.length === 0) this.addKvRow(rows, host, "", "", onEdit);
  }

  private rowsValues(rows: KvRow[]): [string, string][] {
    const out: [string, string][] = [];
    for (const r of rows) {
      if (r.key.value.trim()) out.push([r.key.value.trim(), r.val.value]);
    }
    return out;
  }

  private renderParamRows(values: [string, string][]): void {
    this.renderKvRows(this.paramRows, this.paramsHost, values, () => this.paramsChanged());
  }

  private paramsChanged(): void {
    if (this.syncing) return;
    this.syncing = true;
    this.urlInput.value = withQueryRows(this.urlInput.value, this.rowsValues(this.paramRows));
    this.syncing = false;
    this.syncSendEnabled();
    this.updateBadges();
    this.opts.onDirty();
  }

  private formChanged(): void {
    if (this.syncing) return;
    this.bodyArea.value = serializeForm(this.rowsValues(this.formRows));
    this.updateBadges();
    this.opts.onDirty();
  }

  private renderBodyMode(): void {
    const mode = this.bodyModeSel.value as SomnusBodyMode;
    this.element.classList.toggle("somnus-body-none", mode === "none");
    this.element.classList.toggle("somnus-body-form", mode === "form");
    this.element.classList.toggle("somnus-body-json", mode === "json");
    this.element.classList.toggle("somnus-body-text", mode === "text");
    if (mode === "form") {
      this.syncing = true;
      this.renderKvRows(this.formRows, this.formHost, parseForm(this.bodyArea.value), () =>
        this.formChanged(),
      );
      this.syncing = false;
    }
  }

  private defaultAuth(type: string): SomnusAuth {
    switch (type) {
      case "bearer":
        return { type: "bearer", token: "" };
      case "basic":
        return { type: "basic", username: "", password: "" };
      case "apikey":
        return { type: "apikey", key: "", value: "", placement: "header" };
      default:
        return { type: "none" };
    }
  }

  private authInput(placeholder: string, value: string, password: boolean, onEdit: (v: string) => void): HTMLInputElement {
    const i = document.createElement("input");
    i.className = "rail-search";
    i.type = password ? "password" : "text";
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.value = value;
    i.addEventListener("input", () => {
      onEdit(i.value);
      this.updateBadges();
      this.opts.onDirty();
    });
    return i;
  }

  private renderAuthFields(): void {
    this.authFields.replaceChildren();
    const a = this.auth;
    if (a.type === "bearer") {
      this.authFields.append(this.authInput("Token", a.token, false, (v) => (a.token = v)));
    } else if (a.type === "basic") {
      this.authFields.append(
        this.authInput("Username", a.username, false, (v) => (a.username = v)),
        this.authInput("Password", a.password, true, (v) => (a.password = v)),
      );
    } else if (a.type === "apikey") {
      const placementSel = new CustomSelect({
        className: "somnus-apikey-placement",
        ariaLabel: "API key placement",
        value: a.placement,
        options: [
          { value: "header", label: "Header" },
          { value: "query", label: "Query param" },
        ],
        onChange: (v) => {
          a.placement = v === "query" ? "query" : "header";
          this.opts.onDirty();
        },
      });
      this.authFields.append(
        this.authInput("Key", a.key, false, (v) => (a.key = v)),
        this.authInput("Value", a.value, false, (v) => (a.value = v)),
        placementSel.element,
      );
    }
  }

  private readAuth(): SomnusAuth {
    // `this.auth` is mutated in place by the field listeners.
    return this.auth;
  }

  private updateBadges(): void {
    const set = (tab: ComposerTab, text: string) => {
      const t = this.tabBtns.get(tab);
      if (t) t.badge.textContent = text;
    };
    const params = queryRows(this.urlInput.value).length;
    set("params", params > 0 ? String(params) : "");
    const headers = this.rowsValues(this.headerRows).length;
    set("headers", headers > 0 ? String(headers) : "");
    set("auth", this.auth.type !== "none" ? "●" : "");
    const mode = this.bodyModeSel.value;
    set("body", mode !== "none" && this.bodyArea.value ? "●" : "");
  }
}
```

If `Icons.save` doesn't exist in `ui/src/icons`, add the Lucide `save` glyph there following the existing icon pattern (inline SVG, `currentColor`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run ui/src/somnus/composer.test.ts` → PASS. Fix roundtrip drift if `getDraft()` normalizes (e.g. header key trimming) — the test's fixture uses already-trimmed values, so equality must hold exactly.

- [ ] **Step 5: Commit**

```bash
git add ui/src/somnus/composer.ts ui/src/somnus/composer.test.ts ui/src/icons
git commit -m "feat(somnus): four-tab request composer component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: `menu.ts` + `tree.ts` — shared popper + collections sidebar

**Files:**
- Create: `ui/src/somnus/menu.ts` (shared context menu + confirm popover, `.ui-select__*` chrome)
- Create: `ui/src/somnus/tree.ts`
- Test: `ui/src/somnus/tree.test.ts` (pure `flattenTree` + DOM render with injected data)

**Interfaces:**
- Consumes: api wrappers (`somnusTreeList/Create/Update/Delete/Duplicate/Import`, `somnusEnvCreate/Update`), `parsePostman`, `emptyDraft`, `parseDraft`, `Icons`, `attachTooltip`.
- Produces:
  - `menu.ts`: `showMenu(x: number, y: number, items: MenuItem[]): void` with `type MenuItem = { label: string; danger?: boolean; onPick: () => void }`; `confirmPopover(anchor: HTMLElement, label: string, actionLabel: string, onYes: () => void): void`
  - `tree.ts`: `flattenTree(nodes: SomnusTreeNode[], open: ReadonlySet<string>): { node: SomnusTreeNode; depth: number; hasChildren: boolean }[]` (pure — children sorted by `sort` then insertion; roots = `parent_id === null`, kind `collection` first); `class CollectionsTree` with `readonly element`, `refresh(): Promise<void>`, `render(nodes: SomnusTreeNode[]): void`, `getNodes(): SomnusTreeNode[]`
  - Tree opts: `{ onOpen: (node: SomnusTreeNode) => void; onEnvImported: () => void; notify: (msg: string, isError?: boolean) => void }`

Behavior (spec §1, §5):
- `menu.ts` — `showMenu` builds `div.ui-select__popover.somnus-menu` body-portaled at (x,y) clamped to the viewport; each item a `button.ui-select__option` (`.is-danger` adds `color: var(--danger)`); closes on pick, outside `pointerdown`, or Escape (with `stopPropagation` so the panel's Esc handling doesn't fire). `confirmPopover` is the same surface with a label + danger action button + Cancel — used for delete confirms and dirty-tab closes. **Never `confirm()`** (DESIGN rule 1).
- Toolbar row on top of the tree: "New collection" (`Icons.plus`) and "Import" (`Icons.download` or nearest existing) + hidden `<input type="file" accept=".json">`.
- Rows are `.rail-row` with `style.paddingLeft = `${8 + depth * 12}px``. Collections/folders: chevron glyph (`Icons.chevronRight`, rotated via `.is-open`) + name; click toggles the `open` set and re-renders. Requests: `span.somnus-chip[data-method="GET"]` + name; click → `opts.onOpen(node)`.
- Hover action per row (`.rail-row-action`, `Icons.moreHorizontal`) and `contextmenu` both open `showMenu` with:
  - collection/folder: New folder, New request, Rename, Duplicate, Delete (danger)
  - request: Open, Rename, Duplicate, Delete (danger)
- Rename: the name span swaps to an `input.rail-search`; Enter/blur commits `somnusTreeUpdate(id, newName, null)` + refresh; Esc cancels.
- Delete: `confirmPopover(rowEl, `Delete "${name}" and everything inside?`, "Delete", …)` → `somnusTreeDelete` + refresh.
- New request: `somnusTreeCreate(parentId, "request", "New request", JSON.stringify(emptyDraft()))` → refresh → find the created node in the refreshed list → `onOpen`.
- Import: read the file, `parsePostman`; collection → `somnusTreeImport(name, nodes)` then `notify(`${r.requests} requests imported${r.skipped.length ? `, ${r.skipped.length} items skipped` : ""}`)`; environment → `somnusEnvCreate(name)` + `somnusEnvUpdate(id, name, JSON.stringify(vars))` + `opts.onEnvImported()` + notify; `null` → `notify("Not a Postman v2.1 collection or environment", true)`.
- Empty state: shared `.rail-empty` ("No collections yet — save a request with ⌘S or import from Postman.").

- [ ] **Step 1: Write the failing tests**

Create `ui/src/somnus/tree.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SomnusTreeNode } from "../api";
import { CollectionsTree, flattenTree } from "./tree";

function n(id: string, parent: string | null, kind: SomnusTreeNode["kind"], name: string, sort = 0): SomnusTreeNode {
  return { id, parent_id: parent, kind, name, sort, request: kind === "request" ? "{}" : null, updated_at: 0 };
}

const nodes = [
  n("c1", null, "collection", "API", 1),
  n("f1", "c1", "folder", "Users", 1),
  n("r1", "f1", "request", "List", 1),
  n("r2", "c1", "request", "Ping", 2),
];

describe("flattenTree", () => {
  it("returns only visible rows given the open set", () => {
    const closed = flattenTree(nodes, new Set());
    expect(closed.map((r) => r.node.id)).toEqual(["c1"]);
    const open = flattenTree(nodes, new Set(["c1", "f1"]));
    expect(open.map((r) => r.node.id)).toEqual(["c1", "f1", "r1", "r2"]);
    expect(open.find((r) => r.node.id === "r1")?.depth).toBe(2);
  });
  it("orders siblings by sort", () => {
    const shuffled = [n("c1", null, "collection", "A", 1), n("x", "c1", "request", "b", 2), n("y", "c1", "request", "a", 1)];
    const rows = flattenTree(shuffled, new Set(["c1"]));
    expect(rows.map((r) => r.node.id)).toEqual(["c1", "y", "x"]);
  });
});

describe("CollectionsTree render", () => {
  it("renders rows with method chips for requests", () => {
    const tree = new CollectionsTree({ onOpen: vi.fn(), onEnvImported: vi.fn(), notify: vi.fn() });
    document.body.append(tree.element);
    tree.render(nodes);
    // collections start open by default so content is discoverable
    expect(tree.element.querySelectorAll(".rail-row").length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run to verify failure, then implement**

Run: `npx vitest run ui/src/somnus/tree.test.ts` → FAIL. Implement `menu.ts` first:

```ts
export type MenuItem = { label: string; danger?: boolean; onPick: () => void };

function popover(className: string): HTMLDivElement {
  const pop = document.createElement("div");
  pop.className = `ui-select__popover ${className}`;
  return pop;
}

function place(pop: HTMLElement, x: number, y: number): void {
  pop.style.position = "fixed";
  document.body.append(pop);
  const r = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  pop.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

function dismissable(pop: HTMLElement): () => void {
  const close = (): void => {
    pop.remove();
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const onDown = (e: PointerEvent): void => {
    if (!pop.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  return close;
}

/// Context menu on .ui-select__* chrome (DESIGN rule 14).
export function showMenu(x: number, y: number, items: MenuItem[]): void {
  const pop = popover("somnus-menu");
  const close = dismissable(pop);
  for (const item of items) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `ui-select__option${item.danger ? " is-danger" : ""}`;
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      close();
      item.onPick();
    });
    pop.append(btn);
  }
  place(pop, x, y);
}

/// Inline destructive confirm (never window.confirm — DESIGN rule 1).
export function confirmPopover(
  anchor: HTMLElement,
  label: string,
  actionLabel: string,
  onYes: () => void,
): void {
  const pop = popover("somnus-confirm");
  const close = dismissable(pop);
  const text = document.createElement("div");
  text.className = "somnus-confirm-label";
  text.textContent = label;
  const row = document.createElement("div");
  row.className = "somnus-confirm-actions";
  const yes = document.createElement("button");
  yes.type = "button";
  yes.className = "ui-select__option is-danger";
  yes.textContent = actionLabel;
  yes.addEventListener("click", () => {
    close();
    onYes();
  });
  const no = document.createElement("button");
  no.type = "button";
  no.className = "ui-select__option";
  no.textContent = "Cancel";
  no.addEventListener("click", close);
  row.append(yes, no);
  pop.append(text, row);
  const r = anchor.getBoundingClientRect();
  place(pop, r.left, r.bottom + 4);
}
```

Then `tree.ts`:

```ts
import {
  somnusEnvCreate,
  somnusEnvUpdate,
  somnusTreeCreate,
  somnusTreeDelete,
  somnusTreeDuplicate,
  somnusTreeImport,
  somnusTreeList,
  somnusTreeUpdate,
  type SomnusTreeNode,
} from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { emptyDraft, parseDraft } from "./draft";
import { confirmPopover, showMenu, type MenuItem } from "./menu";
import { parsePostman } from "./postman";

export interface TreeRow {
  node: SomnusTreeNode;
  depth: number;
  hasChildren: boolean;
}

/// Visible rows for the current open set — pure, tested.
export function flattenTree(nodes: SomnusTreeNode[], open: ReadonlySet<string>): TreeRow[] {
  const byParent = new Map<string | null, SomnusTreeNode[]>();
  for (const node of nodes) {
    const list = byParent.get(node.parent_id) ?? [];
    list.push(node);
    byParent.set(node.parent_id, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.sort - b.sort);
  const out: TreeRow[] = [];
  const walk = (parent: string | null, depth: number): void => {
    for (const node of byParent.get(parent) ?? []) {
      const kids = byParent.get(node.id) ?? [];
      out.push({ node, depth, hasChildren: kids.length > 0 });
      if (node.kind !== "request" && open.has(node.id)) walk(node.id, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

export interface TreeOpts {
  onOpen: (node: SomnusTreeNode) => void;
  onEnvImported: () => void;
  notify: (msg: string, isError?: boolean) => void;
}

export class CollectionsTree {
  readonly element: HTMLElement;
  private listHost: HTMLElement;
  private fileInput: HTMLInputElement;
  private nodes: SomnusTreeNode[] = [];
  private open = new Set<string>();
  private openInitialized = false;

  constructor(private opts: TreeOpts) {
    this.element = document.createElement("div");
    this.element.className = "somnus-tree";

    const toolbar = document.createElement("div");
    toolbar.className = "somnus-tree-toolbar";
    const newBtn = document.createElement("button");
    newBtn.type = "button";
    newBtn.className = "rail-btn";
    newBtn.setAttribute("aria-label", "New collection");
    newBtn.innerHTML = Icons.plus({ size: 14 });
    attachTooltip(newBtn, "New collection");
    newBtn.addEventListener("click", () => {
      void somnusTreeCreate(null, "collection", "New collection", null)
        .then(() => this.refresh())
        .catch((e) => this.opts.notify(String(e), true));
    });
    const importBtn = document.createElement("button");
    importBtn.type = "button";
    importBtn.className = "rail-btn";
    importBtn.setAttribute("aria-label", "Import Postman JSON");
    importBtn.innerHTML = Icons.download({ size: 14 });
    attachTooltip(importBtn, "Import Postman collection / environment");
    this.fileInput = document.createElement("input");
    this.fileInput.type = "file";
    this.fileInput.accept = ".json,application/json";
    this.fileInput.className = "hidden";
    this.fileInput.addEventListener("change", () => void this.importFile());
    importBtn.addEventListener("click", () => this.fileInput.click());
    toolbar.append(newBtn, importBtn, this.fileInput);

    this.listHost = document.createElement("div");
    this.listHost.className = "somnus-tree-list";
    this.element.append(toolbar, this.listHost);
  }

  getNodes(): SomnusTreeNode[] {
    return this.nodes;
  }

  async refresh(): Promise<void> {
    try {
      this.render(await somnusTreeList());
    } catch (e) {
      this.opts.notify(String(e), true);
    }
  }

  render(nodes: SomnusTreeNode[]): void {
    this.nodes = nodes;
    if (!this.openInitialized) {
      // Collections start open so content is discoverable on first load.
      for (const node of nodes) if (node.kind === "collection") this.open.add(node.id);
      this.openInitialized = true;
    }
    this.listHost.replaceChildren();
    if (nodes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      empty.innerHTML = `<div class="rail-empty-title">No collections yet</div><div class="rail-empty-hint">Save a request with ⌘S or import from Postman.</div>`;
      this.listHost.append(empty);
      return;
    }
    for (const row of flattenTree(nodes, this.open)) this.listHost.append(this.buildRow(row));
  }

  private buildRow({ node, depth }: TreeRow): HTMLElement {
    const row = document.createElement("div");
    row.className = "rail-row somnus-tree-row";
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");

    if (node.kind === "request") {
      const chip = document.createElement("span");
      chip.className = "somnus-chip";
      const method = parseDraft(node.request).method;
      chip.dataset.method = method;
      chip.textContent = method;
      row.append(chip);
    } else {
      const chev = document.createElement("span");
      chev.className = "somnus-chevron";
      chev.classList.toggle("is-open", this.open.has(node.id));
      chev.innerHTML = Icons.chevronRight({ size: 12 });
      row.append(chev);
    }

    const name = document.createElement("span");
    name.className = "rail-name";
    name.textContent = node.name;
    row.append(name);

    const more = document.createElement("button");
    more.type = "button";
    more.className = "rail-row-action";
    more.setAttribute("aria-label", "Actions");
    more.innerHTML = Icons.moreHorizontal({ size: 13 });
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      const r = more.getBoundingClientRect();
      this.openMenu(node, row, r.left, r.bottom + 2);
    });
    row.append(more);

    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openMenu(node, row, e.clientX, e.clientY);
    });
    row.addEventListener("click", () => {
      if (node.kind === "request") this.opts.onOpen(node);
      else {
        if (this.open.has(node.id)) this.open.delete(node.id);
        else this.open.add(node.id);
        this.render(this.nodes);
      }
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") row.click();
    });
    return row;
  }

  private openMenu(node: SomnusTreeNode, row: HTMLElement, x: number, y: number): void {
    const container = node.kind !== "request";
    const items: MenuItem[] = [];
    if (!container) items.push({ label: "Open", onPick: () => this.opts.onOpen(node) });
    if (container) {
      items.push(
        { label: "New folder", onPick: () => this.createChild(node.id, "folder", "New folder") },
        { label: "New request", onPick: () => this.createChild(node.id, "request", "New request") },
      );
    }
    items.push(
      { label: "Rename", onPick: () => this.renameInline(node, row) },
      {
        label: "Duplicate",
        onPick: () =>
          void somnusTreeDuplicate(node.id)
            .then(() => this.refresh())
            .catch((e) => this.opts.notify(String(e), true)),
      },
      {
        label: "Delete",
        danger: true,
        onPick: () =>
          confirmPopover(row, `Delete "${node.name}" and everything inside?`, "Delete", () => {
            void somnusTreeDelete(node.id)
              .then(() => this.refresh())
              .catch((e) => this.opts.notify(String(e), true));
          }),
      },
    );
    showMenu(x, y, items);
  }

  private createChild(parentId: string, kind: "folder" | "request", name: string): void {
    const request = kind === "request" ? JSON.stringify(emptyDraft()) : null;
    void somnusTreeCreate(parentId, kind, name, request)
      .then(async (id) => {
        this.open.add(parentId);
        await this.refresh();
        const created = this.nodes.find((n) => n.id === id);
        if (created && kind === "request") this.opts.onOpen(created);
      })
      .catch((e) => this.opts.notify(String(e), true));
  }

  private renameInline(node: SomnusTreeNode, row: HTMLElement): void {
    const name = row.querySelector(".rail-name");
    if (!name) return;
    const input = document.createElement("input");
    input.className = "rail-search somnus-rename";
    input.type = "text";
    input.value = node.name;
    input.spellcheck = false;
    name.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const commit = (): void => {
      if (done) return;
      done = true;
      const next = input.value.trim();
      if (next && next !== node.name) {
        void somnusTreeUpdate(node.id, next, null)
          .then(() => this.refresh())
          .catch((e) => this.opts.notify(String(e), true));
      } else {
        this.render(this.nodes);
      }
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter") commit();
      if (e.key === "Escape") {
        done = true;
        this.render(this.nodes);
      }
    });
    input.addEventListener("blur", commit);
  }

  private async importFile(): Promise<void> {
    const file = this.fileInput.files?.[0];
    this.fileInput.value = "";
    if (!file) return;
    const text = await file.text();
    const parsed = parsePostman(text);
    if (!parsed) {
      this.opts.notify("Not a Postman v2.1 collection or environment", true);
      return;
    }
    try {
      if (parsed.kind === "collection") {
        const count = await somnusTreeImport(parsed.name, parsed.nodes);
        await this.refresh();
        const skipped = parsed.skipped.length ? `, ${parsed.skipped.length} items skipped` : "";
        this.opts.notify(`${count} requests imported${skipped}`);
      } else {
        const id = await somnusEnvCreate(parsed.name);
        await somnusEnvUpdate(id, parsed.name, JSON.stringify(parsed.vars));
        this.opts.onEnvImported();
        this.opts.notify(`Environment "${parsed.name}" imported (${parsed.vars.length} variables)`);
      }
    } catch (e) {
      this.opts.notify(String(e), true);
    }
  }
}
```

If `Icons.download` / `Icons.moreHorizontal` / `Icons.plus` / `Icons.chevronRight` are missing from `ui/src/icons`, add the Lucide glyphs following the existing pattern.

- [ ] **Step 3: Run to verify pass, then commit**

Run: `npx vitest run ui/src/somnus/tree.test.ts` → PASS.

```bash
git add ui/src/somnus/menu.ts ui/src/somnus/tree.ts ui/src/somnus/tree.test.ts ui/src/icons
git commit -m "feat(somnus): collections tree sidebar + shared menu/confirm poppers

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: `envs.ts` — environment editor

**Files:**
- Create: `ui/src/somnus/envs.ts`
- Test: `ui/src/somnus/envs.test.ts` (DOM render with injected data)

**Interfaces:**
- Consumes: `somnusEnvList/Create/Update/Delete/Activate`, `SomnusEnvironment`, `SomnusEnvVar`, `Icons`, `attachTooltip`, `confirmPopover` from `./menu`.
- Produces: `class EnvEditor` with `readonly element`, `refresh(): Promise<void>`, `render(envs: SomnusEnvironment[]): void`; opts `{ onChanged: () => void }` (fires after any create/update/delete/activate so the panel can refresh the composer's env select).

Behavior (spec §2):
- Toolbar: "New environment" (`Icons.plus`) → `somnusEnvCreate("New environment")` → refresh + `onChanged`, new env auto-expanded.
- One `.rail-row` per environment: active dot (`.rail-dot.is-ok` when `is_active`, `.is-idle` otherwise), name, hover actions: **Activate/Deactivate** (`Icons.power` or existing equivalent — toggles `somnusEnvActivate(id)` / `somnusEnvActivate(null)`), **Delete** (`confirmPopover`). Click row → toggle expanded var table (in-memory `open` set).
- Var table under an expanded env: one row per var — key input, value input (`type="password"` when `secret`), secret toggle (`Icons.eye`/`Icons.eyeOff`), remove button; plus "+ variable". Name edit: the env name itself is an input at the top of the expanded block.
- Persistence: every edit **debounces 400 ms** then `somnusEnvUpdate(id, name, JSON.stringify(vars))` → `onChanged()`. One timer per editor instance is enough (edits target the expanded env).
- Secret values: when collapsed/re-rendered they render masked (`type="password"`); the toggle reveals per-input, state not persisted.
- Empty state: `.rail-empty` ("No environments — create one to use {{variables}}.").

- [ ] **Step 1: Write failing tests, then implement**

Create `ui/src/somnus/envs.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import type { SomnusEnvironment } from "../api";
import { EnvEditor } from "./envs";

const envs: SomnusEnvironment[] = [
  {
    id: "e1",
    name: "Staging",
    vars: JSON.stringify([
      { key: "base_url", value: "https://stg.test", secret: false },
      { key: "tok", value: "s3", secret: true },
    ]),
    is_active: true,
  },
  { id: "e2", name: "Prod", vars: "[]", is_active: false },
];

describe("EnvEditor render", () => {
  it("renders one row per environment with the active dot", () => {
    const ed = new EnvEditor({ onChanged: vi.fn() });
    document.body.append(ed.element);
    ed.render(envs);
    const rows = ed.element.querySelectorAll(".somnus-env-row");
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector(".rail-dot")?.classList.contains("is-ok")).toBe(true);
    expect(rows[1].querySelector(".rail-dot")?.classList.contains("is-ok")).toBe(false);
  });

  it("secret vars render as password inputs when expanded", () => {
    const ed = new EnvEditor({ onChanged: vi.fn() });
    document.body.append(ed.element);
    ed.render(envs);
    (ed.element.querySelector(".somnus-env-row") as HTMLElement).click();
    const values = [...ed.element.querySelectorAll(".somnus-env-vars input.somnus-env-val")];
    expect((values[0] as HTMLInputElement).type).toBe("text");
    expect((values[1] as HTMLInputElement).type).toBe("password");
  });
});
```

Run to FAIL, then create `ui/src/somnus/envs.ts`:

```ts
import {
  somnusEnvActivate,
  somnusEnvCreate,
  somnusEnvDelete,
  somnusEnvList,
  somnusEnvUpdate,
  type SomnusEnvironment,
  type SomnusEnvVar,
} from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { confirmPopover } from "./menu";

function parseVars(json: string): SomnusEnvVar[] {
  try {
    const raw: unknown = JSON.parse(json);
    if (!Array.isArray(raw)) return [];
    return (raw as SomnusEnvVar[]).filter((v) => typeof v?.key === "string");
  } catch {
    return [];
  }
}

export class EnvEditor {
  readonly element: HTMLElement;
  private listHost: HTMLElement;
  private envs: SomnusEnvironment[] = [];
  private open = new Set<string>();
  private saveTimer: number | null = null;

  constructor(private opts: { onChanged: () => void }) {
    this.element = document.createElement("div");
    this.element.className = "somnus-envs";
    const toolbar = document.createElement("div");
    toolbar.className = "somnus-tree-toolbar";
    const add = document.createElement("button");
    add.type = "button";
    add.className = "rail-btn";
    add.setAttribute("aria-label", "New environment");
    add.innerHTML = Icons.plus({ size: 14 });
    attachTooltip(add, "New environment");
    add.addEventListener("click", () => {
      void somnusEnvCreate("New environment")
        .then((id) => {
          this.open.add(id);
          this.opts.onChanged();
          return this.refresh();
        })
        .catch((e) => console.error("somnus env create failed", e));
    });
    toolbar.append(add);
    this.listHost = document.createElement("div");
    this.listHost.className = "somnus-env-list";
    this.element.append(toolbar, this.listHost);
  }

  async refresh(): Promise<void> {
    try {
      this.render(await somnusEnvList());
    } catch (e) {
      console.error("somnus env list failed", e);
    }
  }

  render(envs: SomnusEnvironment[]): void {
    this.envs = envs;
    this.listHost.replaceChildren();
    if (envs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-empty";
      empty.innerHTML = `<div class="rail-empty-title">No environments</div><div class="rail-empty-hint">Create one to use {{variables}}.</div>`;
      this.listHost.append(empty);
      return;
    }
    for (const env of envs) {
      this.listHost.append(this.buildRow(env));
      if (this.open.has(env.id)) this.listHost.append(this.buildVarsTable(env));
    }
  }

  private buildRow(env: SomnusEnvironment): HTMLElement {
    const row = document.createElement("div");
    row.className = "rail-row somnus-env-row";
    row.setAttribute("role", "button");
    row.setAttribute("tabindex", "0");
    const dot = document.createElement("span");
    dot.className = `rail-dot ${env.is_active ? "is-ok" : "is-idle"}`;
    const name = document.createElement("span");
    name.className = "rail-name";
    name.textContent = env.name;
    row.append(dot, name);

    const act = document.createElement("button");
    act.type = "button";
    act.className = "rail-row-action";
    act.setAttribute("aria-label", env.is_active ? "Deactivate" : "Set active");
    act.innerHTML = Icons.power({ size: 13 });
    attachTooltip(act, env.is_active ? "Deactivate" : "Set active");
    act.addEventListener("click", (e) => {
      e.stopPropagation();
      void somnusEnvActivate(env.is_active ? null : env.id)
        .then(() => {
          this.opts.onChanged();
          return this.refresh();
        })
        .catch((err) => console.error("somnus env activate failed", err));
    });
    const del = document.createElement("button");
    del.type = "button";
    del.className = "rail-row-action";
    del.setAttribute("aria-label", "Delete environment");
    del.innerHTML = Icons.trash({ size: 13 });
    attachTooltip(del, "Delete environment");
    del.addEventListener("click", (e) => {
      e.stopPropagation();
      confirmPopover(row, `Delete environment "${env.name}"?`, "Delete", () => {
        void somnusEnvDelete(env.id)
          .then(() => {
            this.opts.onChanged();
            return this.refresh();
          })
          .catch((err) => console.error("somnus env delete failed", err));
      });
    });
    row.append(act, del);
    row.addEventListener("click", () => {
      if (this.open.has(env.id)) this.open.delete(env.id);
      else this.open.add(env.id);
      this.render(this.envs);
    });
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") row.click();
    });
    return row;
  }

  private buildVarsTable(env: SomnusEnvironment): HTMLElement {
    const vars = parseVars(env.vars);
    const host = document.createElement("div");
    host.className = "somnus-env-vars";

    const nameInput = document.createElement("input");
    nameInput.className = "rail-search somnus-env-name";
    nameInput.type = "text";
    nameInput.value = env.name;
    nameInput.spellcheck = false;
    nameInput.addEventListener("input", () => this.scheduleSave(env.id, nameInput, host));
    host.append(nameInput);

    const addVarRow = (v: SomnusEnvVar): void => {
      const row = document.createElement("div");
      row.className = "somnus-kv-row somnus-env-var";
      const key = document.createElement("input");
      key.className = "rail-search somnus-env-key";
      key.type = "text";
      key.placeholder = "Key";
      key.spellcheck = false;
      key.value = v.key;
      const val = document.createElement("input");
      val.className = "rail-search somnus-env-val";
      val.type = v.secret ? "password" : "text";
      val.placeholder = "Value";
      val.spellcheck = false;
      val.value = v.value;
      const eye = document.createElement("button");
      eye.type = "button";
      eye.className = "rail-btn";
      eye.setAttribute("aria-label", "Secret");
      eye.classList.toggle("is-active", v.secret);
      eye.innerHTML = v.secret ? Icons.eyeOff({ size: 13 }) : Icons.eye({ size: 13 });
      attachTooltip(eye, "Mark as secret");
      eye.addEventListener("click", () => {
        row.dataset.secret = row.dataset.secret === "1" ? "0" : "1";
        const secret = row.dataset.secret === "1";
        val.type = secret ? "password" : "text";
        eye.innerHTML = secret ? Icons.eyeOff({ size: 13 }) : Icons.eye({ size: 13 });
        this.scheduleSave(env.id, nameInput, host);
      });
      row.dataset.secret = v.secret ? "1" : "0";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "rail-btn";
      rm.setAttribute("aria-label", "Remove variable");
      rm.innerHTML = Icons.x({ size: 13 });
      rm.addEventListener("click", () => {
        row.remove();
        this.scheduleSave(env.id, nameInput, host);
      });
      key.addEventListener("input", () => this.scheduleSave(env.id, nameInput, host));
      val.addEventListener("input", () => this.scheduleSave(env.id, nameInput, host));
      row.append(key, val, eye, rm);
      host.append(row);
    };
    for (const v of vars) addVarRow(v);

    const add = document.createElement("button");
    add.type = "button";
    add.className = "somnus-add-row";
    add.textContent = "+ variable";
    add.addEventListener("click", () => {
      addVarRow({ key: "", value: "", secret: false });
      host.append(add); // keep the button last
    });
    host.append(add);
    return host;
  }

  private collectVars(host: HTMLElement): SomnusEnvVar[] {
    const out: SomnusEnvVar[] = [];
    for (const row of host.querySelectorAll(".somnus-env-var")) {
      const key = (row.querySelector(".somnus-env-key") as HTMLInputElement).value.trim();
      const value = (row.querySelector(".somnus-env-val") as HTMLInputElement).value;
      if (key) out.push({ key, value, secret: (row as HTMLElement).dataset.secret === "1" });
    }
    return out;
  }

  private scheduleSave(id: string, nameInput: HTMLInputElement, host: HTMLElement): void {
    if (this.saveTimer !== null) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      const name = nameInput.value.trim() || "Untitled";
      void somnusEnvUpdate(id, name, JSON.stringify(this.collectVars(host)))
        .then(() => {
          const env = this.envs.find((e) => e.id === id);
          if (env) {
            env.name = name;
            env.vars = JSON.stringify(this.collectVars(host));
          }
          this.opts.onChanged();
        })
        .catch((e) => console.error("somnus env save failed", e));
    }, 400);
  }
}
```

If `Icons.power` / `Icons.eye` / `Icons.eyeOff` are missing, add the Lucide glyphs.

- [ ] **Step 2: Run to verify pass, then commit**

Run: `npx vitest run ui/src/somnus/envs.test.ts` → PASS.

```bash
git add ui/src/somnus/envs.ts ui/src/somnus/envs.test.ts ui/src/icons
git commit -m "feat(somnus): environment editor with secret vars and activation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: `tabs.ts` — request tab strip (expanded mode)

**Files:**
- Create: `ui/src/somnus/tabs.ts`
- Test: `ui/src/somnus/tabs.test.ts`

**Interfaces:**
- Consumes: `Icons`.
- Produces: `type TabView = { title: string; method: string; dirty: boolean }`, `class RequestTabs` with `readonly element: HTMLElement`, `render(tabs: TabView[], active: number): void`; opts `{ onSelect: (i: number) => void; onClose: (i: number) => void; onNew: () => void }`.

The panel owns all tab state — this component is a dumb renderer. A close × on a tab is allowed (rule 10 bans × only on whole surfaces). Dirty dot: `span.somnus-tab-dot` shown when `dirty`.

- [ ] **Step 1: Write failing tests, then implement**

Create `ui/src/somnus/tabs.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { RequestTabs } from "./tabs";

describe("RequestTabs", () => {
  it("renders tabs with method chips, dirty dots, active state", () => {
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const tabs = new RequestTabs({ onSelect, onClose, onNew: vi.fn() });
    document.body.append(tabs.element);
    tabs.render(
      [
        { title: "List users", method: "GET", dirty: false },
        { title: "Login", method: "POST", dirty: true },
      ],
      1,
    );
    const els = tabs.element.querySelectorAll(".somnus-reqtab");
    expect(els.length).toBe(2);
    expect(els[1].classList.contains("is-active")).toBe(true);
    expect(els[1].querySelector(".somnus-tab-dot")).not.toBeNull();
    expect(els[0].querySelector(".somnus-tab-dot")).toBeNull();
    (els[0] as HTMLElement).click();
    expect(onSelect).toHaveBeenCalledWith(0);
    (els[1].querySelector(".somnus-reqtab-close") as HTMLElement).click();
    expect(onClose).toHaveBeenCalledWith(1);
  });
});
```

Run to FAIL, then create `ui/src/somnus/tabs.ts`:

```ts
import { Icons } from "../icons";

export type TabView = { title: string; method: string; dirty: boolean };

export interface TabsOpts {
  onSelect: (i: number) => void;
  onClose: (i: number) => void;
  onNew: () => void;
}

/// Dumb renderer for the expanded-mode request tab strip. Panel owns state.
export class RequestTabs {
  readonly element: HTMLElement;

  constructor(private opts: TabsOpts) {
    this.element = document.createElement("div");
    this.element.className = "somnus-tabsbar";
  }

  render(tabs: TabView[], active: number): void {
    this.element.replaceChildren();
    tabs.forEach((tab, i) => {
      const el = document.createElement("div");
      el.className = "somnus-reqtab";
      el.classList.toggle("is-active", i === active);
      el.setAttribute("role", "button");
      el.setAttribute("tabindex", "0");
      const chip = document.createElement("span");
      chip.className = "somnus-chip";
      chip.dataset.method = tab.method;
      chip.textContent = tab.method;
      const title = document.createElement("span");
      title.className = "somnus-reqtab-title";
      title.textContent = tab.title || "Untitled";
      el.append(chip, title);
      if (tab.dirty) {
        const dot = document.createElement("span");
        dot.className = "somnus-tab-dot";
        el.append(dot);
      }
      const close = document.createElement("button");
      close.type = "button";
      close.className = "somnus-reqtab-close";
      close.setAttribute("aria-label", "Close tab");
      close.innerHTML = Icons.x({ size: 12 });
      close.addEventListener("click", (e) => {
        e.stopPropagation();
        this.opts.onClose(i);
      });
      el.append(close);
      el.addEventListener("click", () => this.opts.onSelect(i));
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") this.opts.onSelect(i);
      });
      this.element.append(el);
    });
    const add = document.createElement("button");
    add.type = "button";
    add.className = "somnus-reqtab-new";
    add.setAttribute("aria-label", "New request tab");
    add.innerHTML = Icons.plus({ size: 13 });
    add.addEventListener("click", () => this.opts.onNew());
    this.element.append(add);
  }
}
```

- [ ] **Step 2: Run to verify pass, then commit**

Run: `npx vitest run ui/src/somnus/tabs.test.ts` → PASS.

```bash
git add ui/src/somnus/tabs.ts ui/src/somnus/tabs.test.ts
git commit -m "feat(somnus): request tab strip component

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: `panel.ts` — orchestration rewire

**Files:**
- Modify: `ui/src/somnus/panel.ts` (constructor DOM, new state + methods; composer code moves out)
- Test: `ui/src/somnus/panel.test.ts` (existing pure-helper tests must keep passing unchanged)

**Interfaces:**
- Consumes: everything from Tasks 2–10. Exact imports: `RequestComposer` (+ `METHODS` no longer lives here), `CollectionsTree`, `EnvEditor`, `RequestTabs`, `TabView`, `confirmPopover`, and from `./draft`: `buildRequest`, `draftFromEntry`, `draftKey`, `emptyDraft`, `findUnresolvedDraft`, `parseDraft`; from `./vars`: `envVarsToMap`, `findUnresolved`; api: `somnusEnvList`, `somnusEnvActivate`, `somnusTreeCreate`, `somnusTreeUpdate`, `SomnusEnvironment`, `SomnusTreeNode`, `SomnusDraft`.
- Produces: `SomnusPanel` public surface unchanged (`constructor(host, { onClose })`, `render()`, `close()`) — **`ui/src/main.ts` and `ui/index.html` need zero changes.** Pure helpers `statusSpine`, `fmtSize`, `fmtDuration`, `prettyBody`, `relTimeMs` stay exported (panel.test.ts depends on them).

**What is DELETED from panel.ts:** `METHODS`/`BODY_METHODS` consts, `CustomSelect`/`parseCurl` imports, the composer-building block in the constructor, `setTab`, `syncBodyEnabled`, `syncSendEnabled`, `addHeaderRow`, `currentRequest`, `loadRequest`, the `headerRows`/`activeTab`/`methodSel`/`urlInput`/`sendBtn`/`tabHeadersBtn`/`tabBodyBtn`/`headersHost`/`bodyArea` fields, `isSendableUrl`.

**What STAYS unchanged:** the exported pure helpers, `renderResponse`, `renderError`, the internals of `refreshHistory`/`renderHistory` (plus one added row action, below), the fullscreen `setExpanded` mechanics (with the Esc behavior change below), the header build (with the esc-pill addition below).

- [ ] **Step 1: Rebuild the constructor DOM**

New structure (replaces the v1 composer/body assembly):

```ts
// ── fields ──
interface OpenTab {
  treeId: string | null;
  name: string;
  draft: SomnusDraft;
  savedKey: string; // draftKey at last load/save — dirty = savedKey !== draftKey(draft)
}

private composer: RequestComposer;
private tree: CollectionsTree;
private envEditor: EnvEditor;
private reqTabs: RequestTabs;
private tabs: OpenTab[] = [];
private active = 0;
private envs: SomnusEnvironment[] = [];
private sideTab: "collections" | "envs" | "history" = "collections";
private sideBtns = new Map<"collections" | "envs" | "history", HTMLButtonElement>();
```

Constructor body after the (kept) header build:

```ts
this.reqTabs = new RequestTabs({
  onSelect: (i) => this.selectTab(i),
  onClose: (i) => this.closeTab(i),
  onNew: () => this.newTab(),
});

this.composer = new RequestComposer({
  onSend: () => void this.send(),
  onSave: () => void this.saveActive(),
  onDirty: () => this.composerDirty(),
  onEnvChange: (id) => void this.setActiveEnv(id),
});

const body = document.createElement("div");
body.className = "rail-body";
this.responseHost = document.createElement("div");
this.responseHost.className = "somnus-response";

const side = document.createElement("div");
side.className = "somnus-side";
const sideTabs = document.createElement("div");
sideTabs.className = "rail-tabs somnus-side-tabs";
const sideDefs: ["collections" | "envs" | "history", string][] = [
  ["collections", "Collections"],
  ["envs", "Env"],
  ["history", "History"],
];
for (const [id, label] of sideDefs) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "rail-tab";
  btn.textContent = label;
  btn.addEventListener("click", () => this.setSideTab(id));
  sideTabs.append(btn);
  this.sideBtns.set(id, btn);
}
this.tree = new CollectionsTree({
  onOpen: (node) => this.openNode(node),
  onEnvImported: () => void this.refreshEnvs(),
  notify: (msg, isError) => this.notify(msg, isError),
});
this.envEditor = new EnvEditor({ onChanged: () => void this.refreshEnvs() });
this.historyHost = document.createElement("div");
this.historyHost.className = "somnus-history";
side.append(sideTabs, this.tree.element, this.envEditor.element, this.historyHost);

body.append(this.responseHost, side);
this.root.append(header, this.reqTabs.element, this.composer.element, body);
host.replaceChildren(this.root);

this.tabs = [this.freshTab()];
this.selectTab(0);
this.setSideTab("collections");
this.reqTabs.render(this.tabViews(), this.active);
```

Header additions (inside the kept header build): after `this.expandBtn`, insert the esc pill, hidden in rail mode via CSS:

```ts
const escBtn = document.createElement("button");
escBtn.className = "somnus-close";
escBtn.setAttribute("aria-label", "Close (Esc)");
escBtn.innerHTML = `<kbd class="settings-esc">esc</kbd>`;
escBtn.addEventListener("click", () => this.closeSurface());
actions.prepend(escBtn);
```

Replace the `clearBtn` handler's `confirm(...)` with `confirmPopover(clearBtn, "Clear all Somnus history?", "Clear", () => { ... })` — same body (rule 1: no native dialogs).

- [ ] **Step 2: Implement the state methods**

```ts
private freshTab(): OpenTab {
  const draft = emptyDraft();
  return { treeId: null, name: "", draft, savedKey: draftKey(draft) };
}

private tabViews(): TabView[] {
  return this.tabs.map((t) => ({
    title: t.name || t.draft.url.replace(/^https?:\/\//, "") || "Untitled",
    method: t.draft.method,
    dirty: draftKey(t.draft) !== t.savedKey,
  }));
}

private renderTabsBar(): void {
  this.reqTabs.render(this.tabViews(), this.active);
}

private composerDirty(): void {
  const tab = this.tabs[this.active];
  if (!tab) return;
  tab.draft = this.composer.getDraft();
  this.renderTabsBar();
}

private selectTab(i: number): void {
  this.active = Math.max(0, Math.min(i, this.tabs.length - 1));
  this.composer.setDraft(this.tabs[this.active].draft);
  this.composer.markUnresolved([], false);
  this.renderTabsBar();
}

private newTab(): void {
  this.tabs.push(this.freshTab());
  this.selectTab(this.tabs.length - 1);
}

private closeTab(i: number): void {
  const tab = this.tabs[i];
  if (!tab) return;
  const doClose = (): void => {
    this.tabs.splice(i, 1);
    if (this.tabs.length === 0) this.tabs.push(this.freshTab());
    this.selectTab(this.active >= i && this.active > 0 ? this.active - 1 : this.active);
  };
  if (draftKey(tab.draft) !== tab.savedKey) {
    confirmPopover(this.reqTabs.element, "Discard unsaved changes?", "Discard", doClose);
  } else {
    doClose();
  }
}

/// From the collections tree. Expanded: open-in-tab (dedupe by treeId).
/// Rail: replace the single active composer.
private openNode(node: SomnusTreeNode): void {
  const draft = parseDraft(node.request);
  const tab: OpenTab = { treeId: node.id, name: node.name, draft, savedKey: draftKey(draft) };
  if (this.expanded) {
    const existing = this.tabs.findIndex((t) => t.treeId === node.id);
    if (existing !== -1) {
      this.selectTab(existing);
      return;
    }
    this.tabs.push(tab);
    this.selectTab(this.tabs.length - 1);
  } else {
    this.tabs[this.active] = tab;
    this.selectTab(this.active);
  }
}

private setSideTab(tab: "collections" | "envs" | "history"): void {
  this.sideTab = tab;
  for (const [id, btn] of this.sideBtns) btn.classList.toggle("is-active", id === tab);
  this.root.classList.toggle("somnus-side-collections", tab === "collections");
  this.root.classList.toggle("somnus-side-envs", tab === "envs");
  this.root.classList.toggle("somnus-side-history", tab === "history");
}
```

Environments + send pipeline:

```ts
private async refreshEnvs(): Promise<void> {
  try {
    this.envs = await somnusEnvList();
  } catch (e) {
    console.error("somnus env list failed", e);
    return;
  }
  const active = this.envs.find((e) => e.is_active);
  this.composer.setEnvs(this.envs, active?.id ?? null);
  void this.envEditor.refresh();
}

private async setActiveEnv(id: string | null): Promise<void> {
  try {
    await somnusEnvActivate(id);
  } catch (e) {
    console.error("somnus env activate failed", e);
  }
  await this.refreshEnvs();
}

private activeVars(): Map<string, string> {
  const active = this.envs.find((e) => e.is_active);
  return active ? envVarsToMap(active.vars) : new Map();
}

private async send(): Promise<void> {
  if (this.sending) return;
  const draft = this.composer.getDraft();
  const vars = this.activeVars();
  const missing = findUnresolvedDraft(draft, vars);
  this.composer.markUnresolved(missing, findUnresolved(draft.url, vars).length > 0);
  this.sending = true;
  this.composer.setSending(true);
  try {
    const resp = await somnusSend(buildRequest(draft, vars));
    this.renderResponse(resp);
  } catch (e) {
    this.renderError(String(e));
  } finally {
    this.sending = false;
    this.composer.setSending(false);
    void this.refreshHistory();
  }
}
```

Save (⌘S + composer save button + history row action):

```ts
private async saveActive(): Promise<void> {
  const tab = this.tabs[this.active];
  if (!tab) return;
  tab.draft = this.composer.getDraft();
  if (tab.treeId) {
    try {
      await somnusTreeUpdate(tab.treeId, null, JSON.stringify(tab.draft));
      tab.savedKey = draftKey(tab.draft);
      this.renderTabsBar();
      this.notify("Saved");
      void this.tree.refresh();
    } catch (e) {
      this.notify(String(e), true);
    }
    return;
  }
  this.savePopover(tab.draft, (id, name) => {
    tab.treeId = id;
    tab.name = name;
    tab.savedKey = draftKey(tab.draft);
    this.renderTabsBar();
  });
}

/// Name + destination picker on .ui-select__popover chrome, anchored to the
/// composer. Destinations: every collection/folder from the tree.
private savePopover(draft: SomnusDraft, onSaved: (id: string, name: string) => void): void {
  const containers = this.tree.getNodes().filter((n) => n.kind !== "request");
  if (containers.length === 0) {
    // No collection yet — create one implicitly so ⌘S always works.
    void somnusTreeCreate(null, "collection", "My requests", null).then(() => {
      void this.tree.refresh().then(() => this.savePopover(draft, onSaved));
    });
    return;
  }
  const pop = document.createElement("div");
  pop.className = "ui-select__popover somnus-savepop";
  const nameInput = document.createElement("input");
  nameInput.className = "rail-search";
  nameInput.type = "text";
  nameInput.placeholder = "Request name";
  nameInput.spellcheck = false;
  nameInput.value = draft.url.split("?")[0].split("/").filter(Boolean).slice(-1)[0] ?? "";
  const destSel = new CustomSelect({
    className: "somnus-savedest",
    ariaLabel: "Save into",
    value: containers[0].id,
    options: containers.map((c) => ({ value: c.id, label: c.name })),
  });
  const row = document.createElement("div");
  row.className = "somnus-confirm-actions";
  const save = document.createElement("button");
  save.type = "button";
  save.className = "ui-select__option";
  save.textContent = "Save";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ui-select__option";
  cancel.textContent = "Cancel";
  row.append(save, cancel);
  pop.append(nameInput, destSel.element, row);
  document.body.append(pop);
  const anchor = this.composer.element.getBoundingClientRect();
  pop.style.position = "fixed";
  pop.style.left = `${Math.max(8, anchor.right - 280)}px`;
  pop.style.top = `${anchor.top + 34}px`;
  const close = (): void => pop.remove();
  cancel.addEventListener("click", close);
  save.addEventListener("click", () => {
    const name = nameInput.value.trim() || "Untitled";
    void somnusTreeCreate(destSel.value, "request", name, JSON.stringify(draft))
      .then((id) => {
        close();
        onSaved(id, name);
        this.notify("Saved");
        void this.tree.refresh();
      })
      .catch((e) => this.notify(String(e), true));
  });
  nameInput.focus();
  nameInput.select();
}
```

(This is the one place panel.ts still needs `CustomSelect` — re-import it.)

⌘S, Esc-closes-surface, notify, render:

```ts
// in the constructor:
this.root.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
    e.preventDefault();
    void this.saveActive();
  }
});

/// DESIGN rule 10: Esc closes the WHOLE surface back to the terminal —
/// expanded closes the rail too. The collapse button still returns to rail.
private closeSurface(): void {
  this.setExpanded(false);
  this.opts.onClose();
}
// onEsc handler body changes from `this.setExpanded(false)` to `this.closeSurface()`.

private notify(msg: string, isError = false): void {
  const el = document.createElement("div");
  el.className = `somnus-toast${isError ? " is-error" : ""}`;
  el.textContent = msg;
  this.root.append(el);
  window.setTimeout(() => el.remove(), 4000);
}

/// render() — called when the panel opens.
render(): void {
  if (!this.loadedHistory) void this.refreshHistory();
  void this.tree.refresh();
  void this.refreshEnvs();
}
```

History additions inside the (kept) `renderHistory` row loop, next to the existing delete action:

```ts
const saveAct = document.createElement("button");
saveAct.type = "button";
saveAct.className = "rail-row-action";
saveAct.setAttribute("aria-label", "Save to collection");
saveAct.innerHTML = Icons.save({ size: 13 });
attachTooltip(saveAct, "Save to collection");
saveAct.addEventListener("click", (e) => {
  e.stopPropagation();
  this.savePopover(draftFromEntry(entry), () => undefined);
});
row.append(saveAct);
```

And `loadEntry` becomes a tab replace (response replay part unchanged):

```ts
private loadEntry(entry: SomnusHistoryEntry): void {
  const draft = draftFromEntry(entry);
  this.tabs[this.active] = { treeId: null, name: "", draft, savedKey: draftKey(emptyDraft()) };
  this.selectTab(this.active);
  // …existing replay of renderError / renderResponse stays as-is…
}
```

- [ ] **Step 3: Verify**

Run: `npm run build` → clean. `npx vitest run ui/src/somnus` → all somnus suites pass (panel.test.ts untouched and green). Full `npm test` → no NEW failures vs the 6-test baseline.

- [ ] **Step 4: Commit**

```bash
git add ui/src/somnus/panel.ts
git commit -m "feat(somnus): panel orchestration — tabs, tree, envs, save flow, esc surface close

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: `somnus.css` — design pass (3-pane expanded, chips, poppers)

**Files:**
- Modify: `ui/src/somnus/somnus.css`

No new tokens, no new fonts, radius 0 everywhere, semantic colors from tokens only. Light mode comes free via tokens — but note poppers are body-portaled, so the light-theme input reset gotcha applies: inputs inside `.somnus-savepop` already carry `appearance: none` via their own rules below.

- [ ] **Step 1: Replace the v1 composer/tab rules and add the v2 blocks**

DELETE these v1 rules (superseded): `.rail-panel.somnus-tab-headers .somnus-bodybox`, `.rail-panel.somnus-tab-body .somnus-headers`, `.somnus-header-row` block, `.somnus-add-header` block, and in the fullscreen section every `.somnus-history` grid rule.

ADD (one pass — the full v2 block):

```css
/* ── v2: kv rows (params / headers / form / env vars) ── */
.somnus-kv-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
.somnus-kv-row .rail-search {
  flex: 1 1 50%;
  min-width: 0;
}
.somnus-add-row {
  align-self: flex-start;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: var(--fs-micro);
  cursor: pointer;
  padding: 0;
}

/* ── v2: composer tabs / panes ── */
.somnus-pane {
  display: none;
  flex-direction: column;
  gap: 4px;
}
.somnus-composer.somnus-tab-params .somnus-pane-params,
.somnus-composer.somnus-tab-auth .somnus-pane-auth,
.somnus-composer.somnus-tab-headers .somnus-pane-headers,
.somnus-composer.somnus-tab-body .somnus-pane-body {
  display: flex;
}
.somnus-badge {
  margin-left: 4px;
  font-size: 9px;
  color: var(--text-tertiary);
}
.rail-tab.is-active .somnus-badge {
  color: var(--accent);
}
.somnus-envline {
  display: flex;
  min-width: 0;
}
.somnus-envsel {
  flex: 1 1 auto;
  min-width: 0;
}
.somnus-var-warn {
  font-size: var(--fs-micro);
  color: var(--fail);
}
.somnus-var-warn.hidden {
  display: none;
}
.somnus-url.is-unresolved {
  border-color: var(--fail);
}
.somnus-auth-fields {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.somnus-bodybar {
  display: flex;
  gap: 6px;
  align-items: center;
}
.somnus-format {
  font-size: var(--fs-micro);
}
/* body-mode projections: textarea is canonical; form rows replace it */
.somnus-composer .somnus-form,
.somnus-composer .somnus-body-hint,
.somnus-composer .somnus-format {
  display: none;
}
.somnus-composer.somnus-body-json .somnus-format {
  display: inline-block;
}
.somnus-composer.somnus-body-form .somnus-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.somnus-composer.somnus-body-form .somnus-bodybox,
.somnus-composer.somnus-body-none .somnus-bodybox {
  display: none;
}
.somnus-composer.somnus-body-none .somnus-body-hint {
  display: block;
}

/* ── v2: method chip — tokens only (DESIGN rule 9) ── */
.somnus-chip {
  flex: 0 0 auto;
  font-family: var(--mono-font, ui-monospace, monospace);
  font-size: 9px;
  letter-spacing: 0.04em;
  color: var(--text-tertiary);
}
.somnus-chip[data-method="GET"] { color: var(--ok); }
.somnus-chip[data-method="POST"] { color: var(--accent); }
.somnus-chip[data-method="PUT"],
.somnus-chip[data-method="PATCH"] { color: var(--running); }
.somnus-chip[data-method="DELETE"] { color: var(--danger); }

/* ── v2: side (collections / env / history) ── */
.somnus-side {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.somnus-side-tabs {
  padding: 0 var(--rail-pad-x);
}
.somnus-tree,
.somnus-envs,
.somnus-history {
  display: none;
  min-height: 0;
}
.rail-panel.somnus-side-collections .somnus-tree,
.rail-panel.somnus-side-envs .somnus-envs,
.rail-panel.somnus-side-history .somnus-history {
  display: block;
}
.somnus-tree-toolbar {
  display: flex;
  gap: 4px;
  padding: 4px var(--rail-pad-x);
}
.somnus-tree-toolbar input[type="file"].hidden {
  display: none;
}
.somnus-tree-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.somnus-chevron {
  display: inline-flex;
  color: var(--text-tertiary);
  transition: transform 120ms ease;
}
.somnus-chevron.is-open {
  transform: rotate(90deg);
}
.somnus-env-vars {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px var(--rail-pad-x) 8px;
  border-left: var(--rail-spine) solid var(--border);
  margin-left: var(--rail-pad-x);
}
/* password inputs keep the sharp-corner reset (light-theme gotcha) */
#somnus-panel input[type="password"] {
  -webkit-appearance: none;
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--bg-elevated);
  padding: 6px 8px;
  outline: 0;
  font-family: var(--ui-font);
  font-size: var(--fs-body);
}

/* ── v2: request tab strip (expanded only) ── */
.somnus-tabsbar {
  display: none;
  align-items: stretch;
  overflow-x: auto;
  border-bottom: 1px solid var(--border);
  background: var(--sidebar-bg);
}
.somnus-reqtab {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 5px 10px;
  border-right: 1px solid var(--border);
  font-size: var(--fs-meta);
  color: var(--text-secondary);
  cursor: pointer;
  white-space: nowrap;
}
.somnus-reqtab.is-active {
  background: var(--bg-elevated);
  color: var(--text-primary, #e6e8ee);
}
.somnus-tab-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--running);
}
.somnus-reqtab-close {
  border: none;
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
  padding: 0;
  display: inline-flex;
  opacity: 0;
}
.somnus-reqtab:hover .somnus-reqtab-close,
.somnus-reqtab.is-active .somnus-reqtab-close {
  opacity: 1;
}
.somnus-reqtab-new {
  border: none;
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0 10px;
}

/* ── v2: menu / confirm / save poppers (ui-select chrome carries the surface) ── */
.somnus-menu,
.somnus-confirm,
.somnus-savepop {
  z-index: 1000;
  min-width: 180px;
  padding: 4px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.ui-select__option.is-danger {
  color: var(--danger);
}
.somnus-confirm-label {
  font-size: var(--fs-meta);
  color: var(--text-secondary);
  padding: 4px 6px;
}
.somnus-confirm-actions {
  display: flex;
  gap: 2px;
}
.somnus-savepop {
  width: 280px;
}
.somnus-savepop .rail-search {
  -webkit-appearance: none;
  appearance: none;
  border: 1px solid var(--border);
  border-radius: 0;
  background: var(--bg-elevated);
  padding: 6px 8px;
  outline: 0;
  font-size: var(--fs-body);
}

/* ── v2: toast + esc pill ── */
.somnus-toast {
  position: absolute;
  bottom: 8px;
  left: 8px;
  right: 8px;
  z-index: 5;
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg-overlay);
  font-size: var(--fs-micro);
  color: var(--text-secondary);
}
.somnus-toast.is-error {
  border-color: var(--fail);
}
.somnus-close {
  display: none;
  border: none;
  background: none;
  padding: 0;
  cursor: pointer;
}
body.somnus-expanded #somnus-panel .somnus-close {
  display: inline-flex;
}
```

- [ ] **Step 2: Rework the fullscreen grid**

Replace the v1 expanded layout rules (keep the `body.somnus-expanded #layout > #somnus-panel` span rule — it IS the yellow-glow fix) with:

```css
body.somnus-expanded #somnus-panel .rail-panel {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  grid-template-rows: auto auto auto minmax(0, 1fr);
}
body.somnus-expanded #somnus-panel .rail-header {
  grid-column: 1 / -1;
  grid-row: 1;
  border-bottom: 1px solid var(--border);
}
body.somnus-expanded #somnus-panel .rail-body {
  display: contents;
}
body.somnus-expanded #somnus-panel .somnus-side {
  grid-column: 1;
  grid-row: 2 / 5;
  min-height: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}
body.somnus-expanded #somnus-panel .somnus-tabsbar {
  display: flex;
  grid-column: 2;
  grid-row: 2;
}
body.somnus-expanded #somnus-panel .somnus-composer {
  grid-column: 2;
  grid-row: 3;
  padding: 12px 16px;
  border-bottom: none;
}
body.somnus-expanded #somnus-panel .somnus-bodybox {
  min-height: 140px;
}
body.somnus-expanded #somnus-panel .somnus-response {
  grid-column: 2;
  grid-row: 4;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 16px;
}
```

Keep the existing `.somnus-response:empty` fullscreen hint rules and the `max-height: none` overrides verbatim. Note the DOM order in Task 11 is `header, tabsbar, composer, .rail-body(response, side)` — tabsbar/composer are direct children of `.rail-panel`, and `.rail-body` dissolves via `display: contents`, so all five land as grid items.

- [ ] **Step 3: Verify + commit**

Run: `npm run build` → clean. Launch `npm run tauri:dev` (or use the `respawn` skill) and eyeball: rail mode intact, expanded 3-pane, all three themes if quick.

```bash
git add ui/src/somnus/somnus.css
git commit -m "feat(somnus): v2 design pass — 3-pane expanded, method chips, poppers, side tabs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: Full sweep + verification

**Files:** none new — verification only.

- [ ] **Step 1: Full test + lint sweep**

```bash
npm run build          # clean
npm test               # no NEW failures vs baseline (6 failed / 1228 passed)
cargo test -p covenant somnus   # all pass
cargo fmt --all
cargo clippy -p covenant --all-targets   # no new warnings
```

- [ ] **Step 2: In-app verify (dev app, `respawn` skill if HMR is stale; `verify` skill for the DOM-dump recipe)**

Checklist (spec §Testing):
- [ ] Rail: composer with 4 tabs, env row, side tabs Collections/Env/History switch.
- [ ] New collection → new request → edit → ⌘S saves in place; fresh draft ⌘S opens the save popover.
- [ ] Env: create "Staging" with `base_url`, activate, URL `{{base_url}}/get` against httpbin.org resolves and sends; deactivate → unresolved warning shows, send still fires with literal text.
- [ ] Secret var renders masked; eye toggle reveals.
- [ ] Params tab: add `a=1` → URL gains `?a=1`; edit URL query → rows update.
- [ ] Auth: bearer token appears as Authorization header in history detail; explicit Authorization header wins.
- [ ] Body: form mode rows serialize; JSON Format button pretty-prints; auto Content-Type.
- [ ] Import a real Postman v2.1 export → collection appears, summary toast counts skipped items; import an environment JSON → appears in Env.
- [ ] Expanded: 3-pane, request tabs (open two, dirty dot, close w/ discard confirm), Esc closes the WHOLE surface (rail too), collapse button returns to rail.
- [ ] History row → "Save to collection…" action works; replay still renders.
- [ ] Light theme + True Dark pass on the new surfaces (no white input chrome, no accent-tinted lifts).

- [ ] **Step 3: Commit any fixes, then hand off**

Use `superpowers:finishing-a-development-branch` — merge target `main`, one feature branch, delete worktree after merge. PR/merge notes must list the five spec deviations from Global Constraints and call out that request headers (incl. compiled Authorization) are stored raw locally (same trust profile as v1 — masking stays at the future LLM boundary).
