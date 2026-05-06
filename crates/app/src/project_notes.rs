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
        crate::storage::ensure_sqlite_vec_loaded_for_tests();
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
