//! SQLite persistence for karl-terminal sessions, blocks, and rolling
//! summaries.
//!
//! M7.1 lands the WRITE path only. Spawned sessions are inserted on
//! create; finished blocks are appended; per-session summaries are
//! upserted as they're regenerated. Read path (querying historical
//! blocks for the agent's world model) is M7.2.
//!
//! The DB lives at `<app_config_dir>/history.db` — same dir as
//! `config.json`. WAL mode is enabled so the writer task and any future
//! readers don't block each other. All sync rusqlite calls are wrapped
//! in `tokio::task::spawn_blocking` so they don't stall the executor.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use karl_blocks::BlockId;
use karl_session::SessionId;
use rusqlite::{params, Connection};
use thiserror::Error;
use tokio::sync::Mutex;

const SCHEMA: &str = "\
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA synchronous = NORMAL;

CREATE TABLE IF NOT EXISTS sessions (
    id                  TEXT PRIMARY KEY,
    started_at_unix_ms  INTEGER NOT NULL,
    closed_at_unix_ms   INTEGER
);

CREATE TABLE IF NOT EXISTS blocks (
    id                   TEXT PRIMARY KEY,
    session_id           TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    command              TEXT NOT NULL,
    cwd                  TEXT,
    exit_code            INTEGER,
    duration_ms          INTEGER,
    finished_at_unix_ms  INTEGER NOT NULL,
    output_text          TEXT
);

CREATE INDEX IF NOT EXISTS idx_blocks_session    ON blocks(session_id);
CREATE INDEX IF NOT EXISTS idx_blocks_finished   ON blocks(finished_at_unix_ms);
CREATE INDEX IF NOT EXISTS idx_blocks_failures   ON blocks(exit_code) WHERE exit_code IS NOT 0;

CREATE TABLE IF NOT EXISTS summaries (
    session_id          TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
    summary             TEXT NOT NULL,
    updated_at_unix_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS operator_decisions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id          TEXT NOT NULL,
    timestamp_unix_ms   INTEGER NOT NULL,
    in_flight_command   TEXT,
    output_excerpt      TEXT NOT NULL,
    action              TEXT NOT NULL,
    reply_text          TEXT,
    rationale           TEXT,
    executed            INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_op_dec_session   ON operator_decisions(session_id);
CREATE INDEX IF NOT EXISTS idx_op_dec_timestamp ON operator_decisions(timestamp_unix_ms);
";

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("blocking task panicked: {0}")]
    Join(String),
}

/// Lightweight snapshot of a persisted block, tailored for the agent's
/// historical context. `session_id_short` is the last 6 chars of the
/// Ulid, enough for the model to refer to past sessions consistently
/// without wasting tokens on the full id.
#[derive(Debug, Clone)]
pub struct HistoricalBlock {
    pub session_id_short: String,
    pub command: String,
    pub cwd: Option<String>,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub finished_at_unix_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OperatorDecisionRow {
    pub id: i64,
    pub session_id_short: String,
    pub timestamp_unix_ms: u64,
    pub in_flight_command: Option<String>,
    pub output_excerpt: String,
    pub action: String,
    pub reply_text: Option<String>,
    pub rationale: Option<String>,
    pub executed: bool,
}

fn shorten(id: &str) -> String {
    let n = id.len();
    if n > 6 {
        id[n - 6..].to_string()
    } else {
        id.to_string()
    }
}

#[derive(Clone)]
pub struct Storage {
    inner: Arc<Mutex<Connection>>,
    path: PathBuf,
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(SCHEMA)?;
        tracing::info!(path = %path.display(), "storage opened");
        Ok(Self {
            inner: Arc::new(Mutex::new(conn)),
            path: path.to_path_buf(),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Insert a new session row. Idempotent via INSERT OR IGNORE.
    pub async fn save_session(
        &self,
        id: SessionId,
        started_at_unix_ms: u64,
    ) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        let id_str = id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT OR IGNORE INTO sessions (id, started_at_unix_ms) VALUES (?1, ?2)",
                params![id_str, started_at_unix_ms as i64],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Mark a session closed. Best-effort — if the row doesn't exist
    /// (lost session_id, etc.), silently does nothing.
    pub async fn close_session(
        &self,
        id: SessionId,
        closed_at_unix_ms: u64,
    ) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        let id_str = id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE sessions SET closed_at_unix_ms = ?1 WHERE id = ?2",
                params![closed_at_unix_ms as i64, id_str],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Append a finished block. Caller controls truncation of
    /// `output_text` if the full output is too large to persist.
    #[allow(clippy::too_many_arguments)]
    pub async fn save_block(
        &self,
        id: BlockId,
        session_id: SessionId,
        command: String,
        cwd: Option<String>,
        exit_code: Option<i32>,
        duration_ms: u64,
        finished_at_unix_ms: u64,
        output_text: String,
    ) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        let id_str = id.to_string();
        let session_str = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT OR REPLACE INTO blocks
                 (id, session_id, command, cwd, exit_code, duration_ms, finished_at_unix_ms, output_text)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    id_str,
                    session_str,
                    command,
                    cwd,
                    exit_code,
                    duration_ms as i64,
                    finished_at_unix_ms as i64,
                    output_text,
                ],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Upsert the rolling summary for a session.
    pub async fn save_summary(
        &self,
        session_id: SessionId,
        summary: String,
        updated_at_unix_ms: u64,
    ) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        let session_str = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO summaries (session_id, summary, updated_at_unix_ms)
                 VALUES (?1, ?2, ?3)
                 ON CONFLICT(session_id) DO UPDATE SET
                     summary = excluded.summary,
                     updated_at_unix_ms = excluded.updated_at_unix_ms",
                params![session_str, summary, updated_at_unix_ms as i64],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Read most-recent blocks across ALL sessions (including closed
    /// ones), excluding the given session. Used to enrich the agent's
    /// ⌘K context with cross-session history.
    ///
    /// `output_text` is intentionally NOT returned — historical context
    /// needs to be terse to control token cost.
    pub async fn recent_blocks_excluding(
        &self,
        exclude: SessionId,
        limit: u32,
    ) -> Result<Vec<HistoricalBlock>, StorageError> {
        let conn = self.inner.clone();
        let exclude_str = exclude.to_string();
        tokio::task::spawn_blocking(
            move || -> Result<Vec<HistoricalBlock>, StorageError> {
                let c = conn.blocking_lock();
                let mut stmt = c.prepare(
                    "SELECT session_id, command, cwd, exit_code, duration_ms,
                            finished_at_unix_ms
                     FROM blocks
                     WHERE session_id != ?1
                     ORDER BY finished_at_unix_ms DESC
                     LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![exclude_str, limit as i64], |r| {
                    Ok(HistoricalBlock {
                        session_id_short: shorten(r.get::<_, String>(0)?.as_str()),
                        command: r.get(1)?,
                        cwd: r.get(2)?,
                        exit_code: r.get(3)?,
                        duration_ms: r.get::<_, i64>(4)? as u64,
                        finished_at_unix_ms: r.get::<_, i64>(5)? as u64,
                    })
                })?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row?);
                }
                Ok(out)
            },
        )
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Fetch the persisted `output_text` for a block. Returns `Ok(None)`
    /// when the block id doesn't exist (e.g. block from before the
    /// persistence layer landed, or never reached BlockFinished).
    pub async fn get_block_output(
        &self,
        block_id: String,
    ) -> Result<Option<String>, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<Option<String>, StorageError> {
            let c = conn.blocking_lock();
            let result: rusqlite::Result<String> = c.query_row(
                "SELECT output_text FROM blocks WHERE id = ?1",
                params![block_id],
                |r| r.get(0),
            );
            match result {
                Ok(s) => Ok(Some(s)),
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(e.into()),
            }
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Append an operator decision (M-OP2: dry-run, executed=false).
    /// Returns the autoincrement rowid so the UI can highlight new rows.
    #[allow(clippy::too_many_arguments)]
    pub async fn save_operator_decision(
        &self,
        session_id: SessionId,
        timestamp_unix_ms: u64,
        in_flight_command: Option<String>,
        output_excerpt: String,
        action: String,
        reply_text: Option<String>,
        rationale: Option<String>,
        executed: bool,
    ) -> Result<i64, StorageError> {
        let conn = self.inner.clone();
        let session_str = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<i64, StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO operator_decisions
                 (session_id, timestamp_unix_ms, in_flight_command,
                  output_excerpt, action, reply_text, rationale, executed)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    session_str,
                    timestamp_unix_ms as i64,
                    in_flight_command,
                    output_excerpt,
                    action,
                    reply_text,
                    rationale,
                    executed as i64,
                ],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    pub async fn list_operator_decisions(
        &self,
        limit: u32,
    ) -> Result<Vec<OperatorDecisionRow>, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(
            move || -> Result<Vec<OperatorDecisionRow>, StorageError> {
                let c = conn.blocking_lock();
                let mut stmt = c.prepare(
                    "SELECT id, session_id, timestamp_unix_ms, in_flight_command,
                            output_excerpt, action, reply_text, rationale, executed
                     FROM operator_decisions
                     ORDER BY id DESC
                     LIMIT ?1",
                )?;
                let rows = stmt.query_map(params![limit as i64], |r| {
                    Ok(OperatorDecisionRow {
                        id: r.get(0)?,
                        session_id_short: shorten(r.get::<_, String>(1)?.as_str()),
                        timestamp_unix_ms: r.get::<_, i64>(2)? as u64,
                        in_flight_command: r.get(3)?,
                        output_excerpt: r.get(4)?,
                        action: r.get(5)?,
                        reply_text: r.get(6)?,
                        rationale: r.get(7)?,
                        executed: r.get::<_, i64>(8)? != 0,
                    })
                })?;
                let mut out = Vec::new();
                for row in rows {
                    out.push(row?);
                }
                Ok(out)
            },
        )
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Quick stats helper for diagnostics. Returns (sessions, blocks).
    pub async fn counts(&self) -> Result<(u64, u64), StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<(u64, u64), StorageError> {
            let c = conn.blocking_lock();
            let s: i64 = c.query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))?;
            let b: i64 = c.query_row("SELECT COUNT(*) FROM blocks", [], |r| r.get(0))?;
            Ok((s as u64, b as u64))
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh() -> (Storage, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history.db");
        let s = Storage::open(&path).expect("open");
        (s, dir)
    }

    #[tokio::test]
    async fn schema_and_counts() {
        let (s, _g) = fresh();
        let (sessions, blocks) = s.counts().await.unwrap();
        assert_eq!((sessions, blocks), (0, 0));
    }

    #[tokio::test]
    async fn round_trip_session_and_block() {
        let (s, _g) = fresh();
        let session = SessionId::new();
        s.save_session(session, 1_000_000).await.unwrap();

        let block = BlockId::new();
        s.save_block(
            block,
            session,
            "echo hi".to_string(),
            Some("/tmp".to_string()),
            Some(0),
            12,
            1_000_500,
            "hi\n".to_string(),
        )
        .await
        .unwrap();

        let (sessions, blocks) = s.counts().await.unwrap();
        assert_eq!((sessions, blocks), (1, 1));
    }

    #[tokio::test]
    async fn save_block_without_session_fk_fails_cleanly() {
        let (s, _g) = fresh();
        // FK enforcement on; block referencing a non-existent session
        // should be rejected by sqlite. We propagate the error rather
        // than silently swallowing it.
        let err = s
            .save_block(
                BlockId::new(),
                SessionId::new(),
                "x".to_string(),
                None,
                Some(0),
                0,
                0,
                String::new(),
            )
            .await;
        assert!(err.is_err(), "expected FK failure, got: {err:?}");
    }

    #[tokio::test]
    async fn summary_upsert_replaces_prior() {
        let (s, _g) = fresh();
        let session = SessionId::new();
        s.save_session(session, 1_000_000).await.unwrap();
        s.save_summary(session, "first".to_string(), 1).await.unwrap();
        s.save_summary(session, "second".to_string(), 2).await.unwrap();

        let conn = s.inner.lock().await;
        let row: (String, i64) = conn
            .query_row(
                "SELECT summary, updated_at_unix_ms FROM summaries WHERE session_id = ?1",
                params![session.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, ("second".to_string(), 2));
    }

    #[tokio::test]
    async fn recent_blocks_excludes_active_session_and_orders_desc() {
        let (s, _g) = fresh();
        let active = SessionId::new();
        let other = SessionId::new();
        s.save_session(active, 1).await.unwrap();
        s.save_session(other, 2).await.unwrap();

        // 2 in active, 3 in other — recent_blocks_excluding(active)
        // should return only the other 3, newest first.
        for i in 0..2 {
            s.save_block(
                BlockId::new(),
                active,
                format!("active-{i}"),
                None,
                Some(0),
                10,
                100 + i,
                String::new(),
            )
            .await
            .unwrap();
        }
        for i in 0..3 {
            s.save_block(
                BlockId::new(),
                other,
                format!("other-{i}"),
                Some("/tmp".to_string()),
                Some(if i == 1 { 1 } else { 0 }),
                20,
                200 + i,
                String::new(),
            )
            .await
            .unwrap();
        }

        let rows = s.recent_blocks_excluding(active, 10).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].command, "other-2");
        assert_eq!(rows[1].command, "other-1");
        assert_eq!(rows[1].exit_code, Some(1));
        assert_eq!(rows[2].command, "other-0");
    }

    #[tokio::test]
    async fn recent_blocks_respects_limit() {
        let (s, _g) = fresh();
        let session = SessionId::new();
        let other = SessionId::new();
        s.save_session(session, 1).await.unwrap();
        s.save_session(other, 1).await.unwrap();
        for i in 0..5 {
            s.save_block(
                BlockId::new(),
                other,
                format!("c{i}"),
                None,
                Some(0),
                0,
                i,
                String::new(),
            )
            .await
            .unwrap();
        }
        let rows = s.recent_blocks_excluding(session, 2).await.unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn close_session_sets_closed_at() {
        let (s, _g) = fresh();
        let session = SessionId::new();
        s.save_session(session, 100).await.unwrap();
        s.close_session(session, 200).await.unwrap();

        let conn = s.inner.lock().await;
        let closed: Option<i64> = conn
            .query_row(
                "SELECT closed_at_unix_ms FROM sessions WHERE id = ?1",
                params![session.to_string()],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(closed, Some(200));
    }
}
