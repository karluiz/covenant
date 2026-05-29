//! Prompt Library — a global, reorderable list of reusable prompts.
//!
//! Unlike project Commands/Notes/Docs (per-group), the prompt library is
//! global: there is no `group_id`. One-click "send" writes a prompt into the
//! active terminal and submits it (see the frontend `sendToActiveTabInGroup`).
//!
//! Storage is SQLite (same DB as `storage.rs`). Identifiers are Ulids
//! serialized as strings. All sync rusqlite calls are wrapped in
//! `spawn_blocking` so the executor doesn't stall.
//!
//! See `docs/superpowers/specs/2026-05-29-prompt-library-design.md`.

use std::sync::Arc;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::Mutex;
use ulid::Ulid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prompt {
    pub id: String,
    pub title: String,
    pub body: String,
    pub sort_order: i64,
    pub created_at_unix_ms: i64,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("blocking task panicked: {0}")]
    Join(String),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Handle to the shared connection — clone the `Arc<Mutex<Connection>>`,
/// the same pattern used by `project_notes::Store`.
#[derive(Clone)]
pub struct PromptStore {
    conn: Arc<Mutex<Connection>>,
}

impl PromptStore {
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

    pub async fn list(&self) -> Result<Vec<Prompt>> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<Prompt>> {
            let conn = conn.blocking_lock();
            list_prompts(&conn)
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn create(&self, title: &str, body: &str) -> Result<Prompt> {
        let conn = self.conn.clone();
        let title = title.to_owned();
        let body = body.to_owned();
        tokio::task::spawn_blocking(move || -> Result<Prompt> {
            let conn = conn.blocking_lock();
            let now = Self::now_ms();
            let id = Ulid::new().to_string();
            let next_order: i64 = conn.query_row(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM prompts",
                [],
                |r| r.get(0),
            )?;
            conn.execute(
                "INSERT INTO prompts
                 (id, title, body, sort_order, created_at_unix_ms, updated_at_unix_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![&id, &title, &body, next_order, now],
            )?;
            Ok(Prompt {
                id,
                title,
                body,
                sort_order: next_order,
                created_at_unix_ms: now,
                updated_at_unix_ms: now,
            })
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn update(&self, id: &str, title: &str, body: &str) -> Result<Option<Prompt>> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        let title = title.to_owned();
        let body = body.to_owned();
        tokio::task::spawn_blocking(move || -> Result<Option<Prompt>> {
            let conn = conn.blocking_lock();
            let now = Self::now_ms();
            let updated = conn.execute(
                "UPDATE prompts
                    SET title = ?2, body = ?3, updated_at_unix_ms = ?4
                  WHERE id = ?1",
                params![&id, &title, &body, now],
            )?;
            if updated == 0 {
                return Ok(None);
            }
            let row = conn
                .query_row(
                    "SELECT id, title, body, sort_order,
                            created_at_unix_ms, updated_at_unix_ms
                       FROM prompts WHERE id = ?1",
                    params![&id],
                    row_to_prompt,
                )
                .optional()?;
            Ok(row)
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn delete(&self, id: &str) -> Result<()> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let conn = conn.blocking_lock();
            conn.execute("DELETE FROM prompts WHERE id = ?1", params![&id])?;
            Ok(())
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }

    pub async fn reorder(&self, ordered_ids: Vec<String>) -> Result<()> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<()> {
            let mut conn = conn.blocking_lock();
            let tx = conn.transaction()?;
            for (i, id) in ordered_ids.iter().enumerate() {
                tx.execute(
                    "UPDATE prompts SET sort_order = ?2 WHERE id = ?1",
                    params![id, i as i64],
                )?;
            }
            tx.commit()?;
            Ok(())
        })
        .await
        .map_err(|e| Error::Join(e.to_string()))?
    }
}

fn row_to_prompt(row: &rusqlite::Row<'_>) -> rusqlite::Result<Prompt> {
    Ok(Prompt {
        id: row.get(0)?,
        title: row.get(1)?,
        body: row.get(2)?,
        sort_order: row.get(3)?,
        created_at_unix_ms: row.get(4)?,
        updated_at_unix_ms: row.get(5)?,
    })
}

fn list_prompts(conn: &Connection) -> Result<Vec<Prompt>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, body, sort_order,
                created_at_unix_ms, updated_at_unix_ms
           FROM prompts
          ORDER BY sort_order ASC",
    )?;
    let rows = stmt
        .query_map([], row_to_prompt)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

// ----- Tauri command surface -----

use tauri::State;

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

#[tauri::command]
pub async fn prompt_list(
    store: State<'_, PromptStore>,
) -> std::result::Result<Vec<Prompt>, String> {
    store.list().await.map_err(map_err)
}

#[tauri::command]
pub async fn prompt_create(
    store: State<'_, PromptStore>,
    title: String,
    body: String,
) -> std::result::Result<Prompt, String> {
    store.create(&title, &body).await.map_err(map_err)
}

#[tauri::command]
pub async fn prompt_update(
    store: State<'_, PromptStore>,
    id: String,
    title: String,
    body: String,
) -> std::result::Result<Option<Prompt>, String> {
    store.update(&id, &title, &body).await.map_err(map_err)
}

#[tauri::command]
pub async fn prompt_delete(
    store: State<'_, PromptStore>,
    id: String,
) -> std::result::Result<(), String> {
    store.delete(&id).await.map_err(map_err)
}

#[tauri::command]
pub async fn prompt_reorder(
    store: State<'_, PromptStore>,
    ordered_ids: Vec<String>,
) -> std::result::Result<(), String> {
    store.reorder(ordered_ids).await.map_err(map_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_store() -> PromptStore {
        crate::storage::ensure_sqlite_vec_loaded_for_tests();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::SCHEMA).unwrap();
        PromptStore::new(Arc::new(Mutex::new(conn)))
    }

    #[tokio::test]
    async fn create_assigns_incrementing_sort_order() {
        let s = fresh_store();
        let a = s.create("Review", "review the diff").await.unwrap();
        let b = s.create("Audit", "audit deps").await.unwrap();
        assert_eq!(a.sort_order, 0);
        assert_eq!(b.sort_order, 1);
        let all = s.list().await.unwrap();
        let titles: Vec<_> = all.iter().map(|p| p.title.as_str()).collect();
        assert_eq!(titles, vec!["Review", "Audit"]);
    }

    #[tokio::test]
    async fn update_changes_fields() {
        let s = fresh_store();
        let p = s.create("t", "b").await.unwrap();
        let up = s.update(&p.id, "t2", "b2").await.unwrap().unwrap();
        assert_eq!(up.title, "t2");
        assert_eq!(up.body, "b2");
        assert!(s.update("missing", "x", "y").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn delete_removes() {
        let s = fresh_store();
        let p = s.create("t", "b").await.unwrap();
        s.delete(&p.id).await.unwrap();
        assert!(s.list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn reorder_sets_indices() {
        let s = fresh_store();
        let a = s.create("a", "a").await.unwrap();
        let b = s.create("b", "b").await.unwrap();
        let c = s.create("c", "c").await.unwrap();
        s.reorder(vec![c.id.clone(), a.id.clone(), b.id.clone()])
            .await
            .unwrap();
        let titles: Vec<_> = s
            .list()
            .await
            .unwrap()
            .iter()
            .map(|p| p.title.clone())
            .collect();
        assert_eq!(titles, vec!["c", "a", "b"]);
    }
}
