//! SQLite persistence for Covenant sessions, blocks, and rolling
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

use crate::history_import::ZshHistoryEntry;

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

CREATE TABLE IF NOT EXISTS aom_sessions (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at_unix_ms       INTEGER NOT NULL,
    ended_at_unix_ms         INTEGER,
    budget_usd               REAL NOT NULL,
    accumulated_cost_usd     REAL NOT NULL DEFAULT 0,
    decisions_count          INTEGER NOT NULL DEFAULT 0,
    cost_cap_hit_at_unix_ms  INTEGER
);

CREATE INDEX IF NOT EXISTS idx_aom_sessions_started ON aom_sessions(started_at_unix_ms);

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
";

#[derive(Debug, Error)]
pub enum StorageError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("blocking task panicked: {0}")]
    Join(String),
    #[error("{0}")]
    Other(String),
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

/// One Recall result: a command we've seen before, with the stats the
/// ranker uses and the ranker's final score. Aggregated by exact command
/// string (so `git status` from 50 sessions collapses to one row).
///
/// `last_used_unix_ms` lets the UI render relative time ("2h ago").
/// `cwd_match_count` powers the "ran here X times" hint. `success_count`
/// is for the "100% success" or "1/3 failed" badge.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct RecallMatch {
    pub command: String,
    pub count: u64,
    pub success_count: u64,
    pub cwd_match_count: u64,
    pub last_used_unix_ms: u64,
    pub score: f64,
}

/// Aggregated digest of one AOM session — what the user reads when
/// they wake up. Combines the AOM session metadata with everything
/// the Operator did during its time window (decisions grouped by
/// session, escalations highlighted, action breakdown, totals).
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct AomReport {
    pub session_row_id: i64,
    pub started_at_unix_ms: u64,
    /// `None` while the session is still running (rare — the user
    /// would normally wake up and stop AOM before opening the
    /// report). Backed by `aom_sessions.ended_at_unix_ms`.
    pub ended_at_unix_ms: Option<u64>,
    pub budget_usd: f64,
    pub accumulated_cost_usd: f64,
    pub decisions_count: u64,
    pub cost_cap_hit_at_unix_ms: Option<u64>,

    pub action_breakdown: ActionBreakdown,
    /// Most-recent escalations across all tabs — these are the items
    /// the user should look at first on wake. Capped at ~20.
    pub escalations: Vec<EscalationDigest>,
    /// One row per shell session (= per tab) that had any AOM-driven
    /// activity. Ordered by `last_activity_unix_ms` DESC so freshest
    /// activity surfaces first.
    pub per_tab: Vec<PerTabDigest>,
}

#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct ActionBreakdown {
    pub reply_count: u64,
    pub executed_count: u64,
    pub escalate_count: u64,
    pub wait_count: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct EscalationDigest {
    pub timestamp_unix_ms: u64,
    pub session_id_short: String,
    pub in_flight_command: Option<String>,
    /// The escalation message stored in `reply_text` (Phase B kept it
    /// here for audit) — actually it's in `rationale` in our schema.
    /// We pull both and let the UI display whichever is non-empty.
    pub rationale: Option<String>,
    pub reply_text: Option<String>,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PerTabDigest {
    pub session_id_short: String,
    pub decisions_count: u64,
    pub last_activity_unix_ms: u64,
    pub cost_usd: f64,
    /// Up to 5 most-recent distinct in_flight_commands seen on this
    /// session during the AOM window. Gives the user a quick "what
    /// has this tab been doing" snapshot.
    pub recent_commands: Vec<String>,
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
    /// Mission spec path attached to the session at the moment the
    /// decision fired. NULL for pre-Phase-B rows + sessions that had
    /// no mission attached.
    pub mission_path: Option<String>,
    /// Detected executor agent (claude / copilot / aider / …) parsed
    /// from `in_flight_command` at decision time. NULL when no known
    /// executor matched the command head.
    pub executor_name: Option<String>,
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
        // Idempotent migration: add cost_usd to operator_decisions
        // for older DBs created before M-OP5 Phase B. Errors mean the
        // column already exists — squelch silently.
        let _ = conn.execute(
            "ALTER TABLE operator_decisions ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0",
            [],
        );
        // Per-decision context snapshot (insight panel, Phase B): the
        // mission spec attached and executor agent detected at the
        // moment the decision fired. NULL for older rows + decisions
        // where neither was determinable.
        let _ = conn.execute(
            "ALTER TABLE operator_decisions ADD COLUMN mission_path TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE operator_decisions ADD COLUMN executor_name TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE operator_decisions ADD COLUMN operator_id TEXT",
            [],
        );
        let _ = conn.execute(
            "ALTER TABLE operator_decisions ADD COLUMN operator_name TEXT",
            [],
        );
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

    /// Read most-recent blocks that ran in the given `cwd` (across
    /// sessions). Used by the BlockManager sidebar to surface
    /// historical commands when reopening a tab in the same dir —
    /// the user sees "what was I doing here" before they run anything
    /// new in the fresh session.
    ///
    /// `output_text` intentionally omitted — sidebar renders only
    /// commands + exit codes, full output stays in the DB.
    pub async fn recent_blocks_by_cwd(
        &self,
        cwd: String,
        limit: u32,
    ) -> Result<Vec<HistoricalBlock>, StorageError> {
        if cwd.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(
            move || -> Result<Vec<HistoricalBlock>, StorageError> {
                let c = conn.blocking_lock();
                let mut stmt = c.prepare(
                    "SELECT session_id, command, cwd, exit_code, duration_ms,
                            finished_at_unix_ms
                     FROM blocks
                     WHERE cwd = ?1
                     ORDER BY finished_at_unix_ms DESC
                     LIMIT ?2",
                )?;
                let rows = stmt.query_map(params![cwd, limit as i64], |r| {
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

    /// Search the block history for commands matching `query`, ranked
    /// by a frequency × recency score with cwd / success bonuses.
    ///
    /// Empty `query` returns the most-frequent recent commands (useful
    /// for the ⌘P palette opening into a "blank" Recall view). Anything
    /// non-empty matches as a case-insensitive substring.
    ///
    /// Aggregation is by exact command string — running `ls` 100 times
    /// collapses to one match. `current_cwd` is optional; when provided,
    /// commands previously run there get a score boost.
    ///
    /// SQL does the cheap aggregation; the final score (which needs
    /// `now()` and an `exp()`) is computed in Rust over the candidate
    /// set, then truncated to `limit`.
    pub async fn recall_search(
        &self,
        query: String,
        current_cwd: Option<String>,
        limit: u32,
    ) -> Result<Vec<RecallMatch>, StorageError> {
        let conn = self.inner.clone();
        let now_ms = {
            use std::time::{SystemTime, UNIX_EPOCH};
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0)
        };

        tokio::task::spawn_blocking(
            move || -> Result<Vec<RecallMatch>, StorageError> {
                let c = conn.blocking_lock();

                // Pull a generous candidate pool — Rust ranking does the
                // tie-break, so we want enough rows that the SQL ORDER BY
                // doesn't accidentally drop the eventual winner.
                const POOL: usize = 400;

                let q_trim = query.trim();
                let cwd_for_match: String = current_cwd.clone().unwrap_or_default();

                let mut stmt = c.prepare(
                    "SELECT command,
                            COUNT(*) AS cnt,
                            SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) AS ok,
                            SUM(CASE WHEN cwd = ?1 THEN 1 ELSE 0 END) AS in_cwd,
                            MAX(finished_at_unix_ms) AS last_used
                     FROM blocks
                     WHERE command != ''
                       AND (?2 = '' OR command LIKE '%' || ?2 || '%' COLLATE NOCASE)
                     GROUP BY command
                     ORDER BY last_used DESC
                     LIMIT ?3",
                )?;

                let rows = stmt.query_map(
                    params![cwd_for_match, q_trim, POOL as i64],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, i64>(1)? as u64,
                            r.get::<_, Option<i64>>(2)?.unwrap_or(0) as u64,
                            r.get::<_, Option<i64>>(3)?.unwrap_or(0) as u64,
                            r.get::<_, i64>(4)? as u64,
                        ))
                    },
                )?;

                let mut matches: Vec<RecallMatch> = Vec::new();
                for row in rows {
                    let (command, count, success, in_cwd, last_used) = row?;
                    let score =
                        score_match(&command, q_trim, count, success, in_cwd, last_used, now_ms);
                    matches.push(RecallMatch {
                        command,
                        count,
                        success_count: success,
                        cwd_match_count: in_cwd,
                        last_used_unix_ms: last_used,
                        score,
                    });
                }

                matches.sort_by(|a, b| {
                    b.score
                        .partial_cmp(&a.score)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
                matches.truncate(limit as usize);
                Ok(matches)
            },
        )
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Bulk import parsed `~/.zsh_history` entries as block rows under
    /// a fresh synthetic session. Single transaction — either the
    /// whole import lands or none of it does.
    ///
    /// Returns the number of block rows inserted (entries are skipped
    /// silently when `command` is empty after trimming, but the parser
    /// already filters those, so this is mostly defensive).
    ///
    /// Exit code is set to 0 because zsh doesn't record exit codes;
    /// pretending success keeps the Recall success-ratio stat sensible
    /// (otherwise every imported command would render as "0 succeeded").
    pub async fn import_zsh_history(
        &self,
        entries: Vec<ZshHistoryEntry>,
    ) -> Result<usize, StorageError> {
        if entries.is_empty() {
            return Ok(0);
        }
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<usize, StorageError> {
            let mut c = conn.blocking_lock();
            let session = SessionId::new();
            let import_started_ms = entries
                .iter()
                .map(|e| e.finished_at_unix_ms)
                .min()
                .unwrap_or(0);

            let tx = c.transaction()?;

            tx.execute(
                "INSERT OR IGNORE INTO sessions (id, started_at_unix_ms, closed_at_unix_ms)
                 VALUES (?1, ?2, ?2)",
                params![session.to_string(), import_started_ms as i64],
            )?;

            let mut count = 0usize;
            {
                let mut stmt = tx.prepare(
                    "INSERT OR REPLACE INTO blocks
                     (id, session_id, command, cwd, exit_code, duration_ms,
                      finished_at_unix_ms, output_text)
                     VALUES (?1, ?2, ?3, NULL, 0, ?4, ?5, '')",
                )?;
                for e in &entries {
                    let cmd = e.command.trim();
                    if cmd.is_empty() {
                        continue;
                    }
                    stmt.execute(params![
                        BlockId::new().to_string(),
                        session.to_string(),
                        cmd,
                        e.duration_ms as i64,
                        e.finished_at_unix_ms as i64,
                    ])?;
                    count += 1;
                }
            }

            tx.commit()?;
            Ok(count)
        })
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
    /// `cost_usd` is the estimated USD cost of the model call that
    /// produced this decision; powers the AOM morning-report sums.
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
        cost_usd: f64,
        mission_path: Option<String>,
        executor_name: Option<String>,
    ) -> Result<i64, StorageError> {
        let conn = self.inner.clone();
        let session_str = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<i64, StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO operator_decisions
                 (session_id, timestamp_unix_ms, in_flight_command,
                  output_excerpt, action, reply_text, rationale, executed,
                  cost_usd, mission_path, executor_name)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    session_str,
                    timestamp_unix_ms as i64,
                    in_flight_command,
                    output_excerpt,
                    action,
                    reply_text,
                    rationale,
                    executed as i64,
                    cost_usd,
                    mission_path,
                    executor_name,
                ],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Persist a fresh AOM session row. Returns the autoincrement rowid
    /// — the caller stashes it in `AomState.current_session_row_id`
    /// and passes it back to `aom_session_finish` on stop / cap-hit.
    pub async fn aom_session_start(
        &self,
        started_at_unix_ms: u64,
        budget_usd: f64,
    ) -> Result<i64, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<i64, StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO aom_sessions
                 (started_at_unix_ms, budget_usd)
                 VALUES (?1, ?2)",
                params![started_at_unix_ms as i64, budget_usd],
            )?;
            Ok(c.last_insert_rowid())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Finalize an AOM session row with end timestamp + final stats.
    /// Best-effort — if the row id is gone (storage rebuilt mid-AOM),
    /// silently no-ops via the WHERE clause matching nothing.
    pub async fn aom_session_finish(
        &self,
        id: i64,
        ended_at_unix_ms: u64,
        accumulated_cost_usd: f64,
        decisions_count: u64,
        cost_cap_hit_at_unix_ms: Option<u64>,
    ) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE aom_sessions
                 SET ended_at_unix_ms = ?1,
                     accumulated_cost_usd = ?2,
                     decisions_count = ?3,
                     cost_cap_hit_at_unix_ms = ?4
                 WHERE id = ?5",
                params![
                    ended_at_unix_ms as i64,
                    accumulated_cost_usd,
                    decisions_count as i64,
                    cost_cap_hit_at_unix_ms.map(|t| t as i64),
                    id,
                ],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Build the morning report for the most-recent AOM session.
    /// `Ok(None)` when AOM has never been started on this DB.
    ///
    /// Heavy aggregation done in SQLite — five queries inside one
    /// blocking task: header row, action breakdown, escalations top-N,
    /// per-tab counts, per-tab recent commands. The whole report is
    /// roughly free at typical AOM sizes (≤500 decisions).
    pub async fn aom_session_latest_report(
        &self,
    ) -> Result<Option<AomReport>, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<Option<AomReport>, StorageError> {
            let c = conn.blocking_lock();

            // 1. Latest AOM session row.
            let header: Option<(i64, i64, Option<i64>, f64, f64, i64, Option<i64>)> = c
                .query_row(
                    "SELECT id, started_at_unix_ms, ended_at_unix_ms,
                            budget_usd, accumulated_cost_usd,
                            decisions_count, cost_cap_hit_at_unix_ms
                     FROM aom_sessions
                     ORDER BY id DESC
                     LIMIT 1",
                    [],
                    |r| {
                        Ok((
                            r.get(0)?,
                            r.get(1)?,
                            r.get(2)?,
                            r.get(3)?,
                            r.get(4)?,
                            r.get(5)?,
                            r.get(6)?,
                        ))
                    },
                )
                .ok();

            let Some((row_id, started_ms, ended_ms, budget, accum, decisions, cap_hit)) =
                header
            else {
                return Ok(None);
            };

            // Time window for the operator_decisions filter. If the
            // session is still running (ended_at_unix_ms IS NULL),
            // use "now" so we report partial state.
            let window_end_ms = ended_ms.unwrap_or_else(|| {
                use std::time::{SystemTime, UNIX_EPOCH};
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(started_ms)
            });

            // 2. Action breakdown.
            let mut action = ActionBreakdown::default();
            let mut stmt = c.prepare(
                "SELECT action, SUM(executed) AS executed_n, COUNT(*) AS total_n
                 FROM operator_decisions
                 WHERE timestamp_unix_ms BETWEEN ?1 AND ?2
                 GROUP BY action",
            )?;
            let rows = stmt.query_map(params![started_ms, window_end_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?.unwrap_or(0) as u64,
                    r.get::<_, i64>(2)? as u64,
                ))
            })?;
            for row in rows {
                let (kind, executed_n, total_n) = row?;
                match kind.as_str() {
                    "reply" => {
                        action.reply_count = total_n;
                        action.executed_count = executed_n;
                    }
                    "escalate" => action.escalate_count = total_n,
                    "wait" => action.wait_count = total_n,
                    _ => {}
                }
            }
            drop(stmt);

            // 3. Top recent escalations (newest first, capped).
            let mut stmt = c.prepare(
                "SELECT timestamp_unix_ms, session_id, in_flight_command,
                        rationale, reply_text
                 FROM operator_decisions
                 WHERE timestamp_unix_ms BETWEEN ?1 AND ?2
                   AND action = 'escalate'
                 ORDER BY timestamp_unix_ms DESC
                 LIMIT 20",
            )?;
            let rows = stmt.query_map(params![started_ms, window_end_ms], |r| {
                Ok(EscalationDigest {
                    timestamp_unix_ms: r.get::<_, i64>(0)? as u64,
                    session_id_short: shorten(r.get::<_, String>(1)?.as_str()),
                    in_flight_command: r.get(2)?,
                    rationale: r.get(3)?,
                    reply_text: r.get(4)?,
                })
            })?;
            let mut escalations = Vec::new();
            for row in rows {
                escalations.push(row?);
            }
            drop(stmt);

            // 4. Per-tab aggregate (counts, last activity, summed cost).
            let mut stmt = c.prepare(
                "SELECT session_id,
                        COUNT(*)              AS n_decisions,
                        MAX(timestamp_unix_ms) AS last_ts,
                        COALESCE(SUM(cost_usd), 0) AS total_cost
                 FROM operator_decisions
                 WHERE timestamp_unix_ms BETWEEN ?1 AND ?2
                 GROUP BY session_id
                 ORDER BY last_ts DESC",
            )?;
            let rows = stmt.query_map(params![started_ms, window_end_ms], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, i64>(2)? as u64,
                    r.get::<_, f64>(3)?,
                ))
            })?;
            let mut per_tab: Vec<(String, PerTabDigest)> = Vec::new();
            for row in rows {
                let (sid, n, last_ts, cost) = row?;
                per_tab.push((
                    sid.clone(),
                    PerTabDigest {
                        session_id_short: shorten(&sid),
                        decisions_count: n,
                        last_activity_unix_ms: last_ts,
                        cost_usd: cost,
                        recent_commands: Vec::new(),
                    },
                ));
            }
            drop(stmt);

            // 5. For each per-tab row, fetch up to 5 distinct recent
            //    in_flight_commands. Done in a loop so the WHERE clause
            //    can carry the session id.
            let mut stmt = c.prepare(
                "SELECT DISTINCT in_flight_command
                 FROM operator_decisions
                 WHERE timestamp_unix_ms BETWEEN ?1 AND ?2
                   AND session_id = ?3
                   AND in_flight_command IS NOT NULL
                   AND in_flight_command != ''
                 ORDER BY timestamp_unix_ms DESC
                 LIMIT 5",
            )?;
            for (sid, digest) in per_tab.iter_mut() {
                let rows = stmt.query_map(
                    params![started_ms, window_end_ms, sid.as_str()],
                    |r| r.get::<_, Option<String>>(0),
                )?;
                let mut cmds = Vec::new();
                for row in rows {
                    if let Some(cmd) = row? {
                        cmds.push(cmd);
                    }
                }
                digest.recent_commands = cmds;
            }
            drop(stmt);

            Ok(Some(AomReport {
                session_row_id: row_id,
                started_at_unix_ms: started_ms as u64,
                ended_at_unix_ms: ended_ms.map(|t| t as u64),
                budget_usd: budget,
                accumulated_cost_usd: accum,
                decisions_count: decisions as u64,
                cost_cap_hit_at_unix_ms: cap_hit.map(|t| t as u64),
                action_breakdown: action,
                escalations,
                per_tab: per_tab.into_iter().map(|(_, d)| d).collect(),
            }))
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
                            output_excerpt, action, reply_text, rationale, executed,
                            mission_path, executor_name
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
                        mission_path: r.get(9)?,
                        executor_name: r.get(10)?,
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

/// Recall ranker. Tuned so the obvious-good answer wins:
///
///   - frequency: log-scaled so a 1000× command doesn't drown a 5×
///     one that's much more relevant by other signals.
///   - recency: exponential decay with ~14d half-life. Yesterday >
///     last month > last year, but old-but-frequent still surfaces.
///   - cwd bonus: any prior run in `current_cwd` adds a flat lift,
///     scaled by how often. Strong signal — directory-local commands
///     (build scripts, custom aliases) should win in their own dir.
///   - exit-zero bonus: success ratio nudges good commands above the
///     ones that always fail. Small weight; we don't want to hide
///     "git status" because the user once typo'd `git statu`.
///   - position bonus: command starts with the query → big lift;
///     contains query → small lift. Mirrors how shell history search
///     usually feels (prefix matches first).
fn score_match(
    command: &str,
    query: &str,
    count: u64,
    success: u64,
    in_cwd: u64,
    last_used_unix_ms: u64,
    now_unix_ms: u64,
) -> f64 {
    let freq = ((1 + count) as f64).ln();

    let age_ms = now_unix_ms.saturating_sub(last_used_unix_ms) as f64;
    let age_days = age_ms / (1000.0 * 60.0 * 60.0 * 24.0);
    // half-life of 14 days: decay = 0.5^(age/14) = exp(-ln2 * age/14)
    let recency = (-std::f64::consts::LN_2 * age_days / 14.0).exp();

    // Combine count and recency multiplicatively so a high-count
    // command still loses to a more recent one — but not by much.
    let base = freq * (0.4 + 0.6 * recency);

    let cwd_lift = if in_cwd > 0 {
        1.5 + 0.3 * ((1 + in_cwd) as f64).ln()
    } else {
        0.0
    };

    let success_ratio = if count > 0 {
        success as f64 / count as f64
    } else {
        0.0
    };
    let success_lift = 0.4 * success_ratio;

    let position_lift = if query.is_empty() {
        0.0
    } else {
        let cmd_lc = command.to_ascii_lowercase();
        let q_lc = query.to_ascii_lowercase();
        if cmd_lc.starts_with(&q_lc) {
            1.0
        } else if cmd_lc.contains(&q_lc) {
            0.3
        } else {
            0.0
        }
    };

    base + cwd_lift + success_lift + position_lift
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

    /// Helper: insert a block with explicit timestamp & cwd. Recall
    /// tests need fine control over `finished_at_unix_ms` and `cwd` so
    /// they can drive each ranking signal independently.
    async fn insert(
        s: &Storage,
        session: SessionId,
        command: &str,
        cwd: Option<&str>,
        exit: Option<i32>,
        finished_at_ms: u64,
    ) {
        s.save_block(
            BlockId::new(),
            session,
            command.to_string(),
            cwd.map(|c| c.to_string()),
            exit,
            5,
            finished_at_ms,
            String::new(),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn recall_empty_query_returns_recent_first() {
        let (s, _g) = fresh();
        let sess = SessionId::new();
        s.save_session(sess, 0).await.unwrap();

        // Three distinct commands at increasing timestamps. Empty
        // query should still surface them all ranked sensibly — the
        // most recent should win the tie-break.
        insert(&s, sess, "ls", None, Some(0), 1_000).await;
        insert(&s, sess, "cd ..", None, Some(0), 2_000).await;
        insert(&s, sess, "git status", None, Some(0), 3_000).await;

        let rows = s.recall_search(String::new(), None, 10).await.unwrap();
        assert_eq!(rows.len(), 3, "expected all 3 distinct commands");
        // git status is most recent → should rank first.
        assert_eq!(rows[0].command, "git status");
    }

    #[tokio::test]
    async fn recall_substring_match_case_insensitive() {
        let (s, _g) = fresh();
        let sess = SessionId::new();
        s.save_session(sess, 0).await.unwrap();

        insert(&s, sess, "ls", None, Some(0), 1_000).await;
        insert(&s, sess, "git status", None, Some(0), 2_000).await;
        insert(&s, sess, "GIT log", None, Some(0), 3_000).await;
        insert(&s, sess, "cargo build", None, Some(0), 4_000).await;

        let rows = s
            .recall_search("git".to_string(), None, 10)
            .await
            .unwrap();
        let cmds: Vec<&str> = rows.iter().map(|r| r.command.as_str()).collect();
        assert!(cmds.contains(&"git status"));
        assert!(cmds.contains(&"GIT log"));
        assert!(!cmds.contains(&"cargo build"));
        assert!(!cmds.contains(&"ls"));
    }

    #[tokio::test]
    async fn recall_dedupes_identical_commands() {
        let (s, _g) = fresh();
        let sess = SessionId::new();
        s.save_session(sess, 0).await.unwrap();

        // Same command, 5 times.
        for i in 0..5 {
            insert(&s, sess, "ls -la", None, Some(0), 1_000 + i).await;
        }
        // Plus one other.
        insert(&s, sess, "pwd", None, Some(0), 2_000).await;

        let rows = s.recall_search(String::new(), None, 10).await.unwrap();
        assert_eq!(rows.len(), 2, "expected dedupe to collapse to 2 rows");
        let ls = rows.iter().find(|r| r.command == "ls -la").unwrap();
        assert_eq!(ls.count, 5);
    }

    #[tokio::test]
    async fn recall_cwd_bonus_promotes_local_command() {
        let (s, _g) = fresh();
        let sess = SessionId::new();
        s.save_session(sess, 0).await.unwrap();

        // Both commands run once at the same time. One was run in
        // /home/me, the other elsewhere. With current_cwd=/home/me
        // the local one must win.
        insert(&s, sess, "make test", Some("/home/me"), Some(0), 1_000).await;
        insert(&s, sess, "make build", Some("/elsewhere"), Some(0), 1_000).await;

        let rows = s
            .recall_search(
                "make".to_string(),
                Some("/home/me".to_string()),
                10,
            )
            .await
            .unwrap();
        assert_eq!(rows[0].command, "make test");
        assert!(rows[0].cwd_match_count >= 1);
    }

    #[tokio::test]
    async fn recall_prefix_beats_infix_at_same_recency() {
        let (s, _g) = fresh();
        let sess = SessionId::new();
        s.save_session(sess, 0).await.unwrap();

        // "git status" starts with "git"; "log git" only contains it.
        // Same timestamp, same count → prefix should rank higher.
        insert(&s, sess, "git status", None, Some(0), 1_000).await;
        insert(&s, sess, "log git", None, Some(0), 1_000).await;

        let rows = s.recall_search("git".to_string(), None, 10).await.unwrap();
        assert_eq!(rows[0].command, "git status");
    }

    #[tokio::test]
    async fn recall_excludes_empty_commands() {
        let (s, _g) = fresh();
        let sess = SessionId::new();
        s.save_session(sess, 0).await.unwrap();

        // Empty / whitespace-only commands shouldn't pollute Recall —
        // they're an artifact of someone hitting Enter on a blank
        // prompt and carry zero recall value.
        insert(&s, sess, "", None, Some(0), 1_000).await;
        insert(&s, sess, "ls", None, Some(0), 2_000).await;

        let rows = s.recall_search(String::new(), None, 10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].command, "ls");
    }

    #[tokio::test]
    async fn recall_respects_limit() {
        let (s, _g) = fresh();
        let sess = SessionId::new();
        s.save_session(sess, 0).await.unwrap();

        for i in 0..10 {
            insert(&s, sess, &format!("cmd-{i}"), None, Some(0), 1_000 + i).await;
        }

        let rows = s.recall_search(String::new(), None, 3).await.unwrap();
        assert_eq!(rows.len(), 3);
    }

    #[tokio::test]
    async fn import_zsh_history_inserts_under_synthetic_session() {
        let (s, _g) = fresh();
        let entries = vec![
            ZshHistoryEntry {
                command: "ls -la".to_string(),
                finished_at_unix_ms: 1_700_000_000_000,
                duration_ms: 0,
            },
            ZshHistoryEntry {
                command: "git status".to_string(),
                finished_at_unix_ms: 1_700_000_005_000,
                duration_ms: 50,
            },
            ZshHistoryEntry {
                command: "ls -la".to_string(),
                finished_at_unix_ms: 1_700_000_010_000,
                duration_ms: 0,
            },
            // Trimmed-to-empty: should be skipped.
            ZshHistoryEntry {
                command: "   ".to_string(),
                finished_at_unix_ms: 1_700_000_020_000,
                duration_ms: 0,
            },
        ];

        let inserted = s.import_zsh_history(entries).await.unwrap();
        assert_eq!(inserted, 3);

        let (sessions, blocks) = s.counts().await.unwrap();
        assert_eq!(sessions, 1, "one synthetic session");
        assert_eq!(blocks, 3);

        // Recall must immediately see the imported entries.
        let rows = s.recall_search("ls".to_string(), None, 10).await.unwrap();
        assert_eq!(rows.len(), 1, "ls -la dedupes to one row");
        let ls = &rows[0];
        assert_eq!(ls.command, "ls -la");
        assert_eq!(ls.count, 2);
        assert_eq!(ls.success_count, 2, "imports default to exit_code=0");
    }

    #[tokio::test]
    async fn import_zsh_history_empty_input_is_noop() {
        let (s, _g) = fresh();
        let inserted = s.import_zsh_history(vec![]).await.unwrap();
        assert_eq!(inserted, 0);
        let (sessions, blocks) = s.counts().await.unwrap();
        assert_eq!((sessions, blocks), (0, 0));
    }

    #[tokio::test]
    async fn recent_blocks_by_cwd_filters_and_orders() {
        let (s, _g) = fresh();
        let session = SessionId::new();
        s.save_session(session, 1).await.unwrap();

        // 3 blocks in /home/me, 2 elsewhere, 1 with NULL cwd.
        for (i, cwd) in [
            ("/home/me", "ls"),
            ("/elsewhere", "pwd"),
            ("/home/me", "cargo build"),
            ("/elsewhere", "echo"),
            ("/home/me", "git status"),
        ]
        .iter()
        .enumerate()
        {
            s.save_block(
                BlockId::new(),
                session,
                cwd.1.to_string(),
                Some(cwd.0.to_string()),
                Some(0),
                10,
                100 + i as u64,
                String::new(),
            )
            .await
            .unwrap();
        }

        let rows = s
            .recent_blocks_by_cwd("/home/me".to_string(), 10)
            .await
            .unwrap();
        assert_eq!(rows.len(), 3);
        // Newest first.
        assert_eq!(rows[0].command, "git status");
        assert_eq!(rows[1].command, "cargo build");
        assert_eq!(rows[2].command, "ls");

        // Empty cwd → empty result, not all blocks.
        let empty = s.recent_blocks_by_cwd(String::new(), 10).await.unwrap();
        assert!(empty.is_empty());

        // Limit respected.
        let limited = s
            .recent_blocks_by_cwd("/home/me".to_string(), 2)
            .await
            .unwrap();
        assert_eq!(limited.len(), 2);
    }

    #[tokio::test]
    async fn aom_session_lifecycle_and_report() {
        let (s, _g) = fresh();

        // Two shell sessions, both touched by the AOM session.
        let active = SessionId::new();
        let other = SessionId::new();
        s.save_session(active, 1).await.unwrap();
        s.save_session(other, 2).await.unwrap();

        // Start AOM at t=10000.
        let aom_id = s.aom_session_start(10_000, 5.0).await.unwrap();
        assert!(aom_id > 0);

        // Three operator decisions inside the AOM window; one before
        // (should be excluded from the report) and one after-end
        // (also excluded once we finish the session).
        s.save_operator_decision(
            active,
            5_000, // BEFORE AOM started
            Some("aider".to_string()),
            "old".to_string(),
            "reply".to_string(),
            Some("y\n".to_string()),
            Some("noise".to_string()),
            true,
            0.001,
            None,
            None,
        )
        .await
        .unwrap();

        s.save_operator_decision(
            active,
            11_000,
            Some("aider --auto".to_string()),
            "exec".to_string(),
            "reply".to_string(),
            Some("y\n".to_string()),
            Some("ALWAYS-YES tests".to_string()),
            true,
            0.012,
            None,
            None,
        )
        .await
        .unwrap();

        s.save_operator_decision(
            active,
            12_000,
            Some("aider --auto".to_string()),
            "blocked attempt".to_string(),
            "escalate".to_string(),
            None,
            Some("blocked: rm -rf in proposed reply".to_string()),
            false,
            0.008,
            None,
            None,
        )
        .await
        .unwrap();

        s.save_operator_decision(
            other,
            13_000,
            Some("claude".to_string()),
            "exec".to_string(),
            "reply".to_string(),
            Some("1\n".to_string()),
            Some("ALWAYS-YES commit".to_string()),
            true,
            0.015,
            None,
            None,
        )
        .await
        .unwrap();

        // Finish the session at t=20000, $0.035 spent, 3 decisions.
        s.aom_session_finish(aom_id, 20_000, 0.035, 3, None)
            .await
            .unwrap();

        // After-end decision — should be excluded by the BETWEEN filter.
        s.save_operator_decision(
            other,
            25_000,
            Some("claude".to_string()),
            "after AOM ended".to_string(),
            "reply".to_string(),
            Some("y\n".to_string()),
            Some("post-aom".to_string()),
            true,
            0.005,
            None,
            None,
        )
        .await
        .unwrap();

        let report = s.aom_session_latest_report().await.unwrap().unwrap();
        assert_eq!(report.session_row_id, aom_id);
        assert_eq!(report.started_at_unix_ms, 10_000);
        assert_eq!(report.ended_at_unix_ms, Some(20_000));
        assert_eq!(report.budget_usd, 5.0);
        assert!((report.accumulated_cost_usd - 0.035).abs() < 1e-9);
        assert_eq!(report.decisions_count, 3);
        assert!(report.cost_cap_hit_at_unix_ms.is_none());

        assert_eq!(report.action_breakdown.reply_count, 2);
        assert_eq!(report.action_breakdown.executed_count, 2);
        assert_eq!(report.action_breakdown.escalate_count, 1);
        assert_eq!(report.action_breakdown.wait_count, 0);

        assert_eq!(report.escalations.len(), 1);
        assert!(report.escalations[0]
            .rationale
            .as_deref()
            .unwrap()
            .contains("rm -rf"));

        assert_eq!(report.per_tab.len(), 2);
        // Newest activity first → `other` session ranks first.
        assert_eq!(report.per_tab[0].decisions_count, 1);
        assert_eq!(report.per_tab[1].decisions_count, 2);
    }

    #[tokio::test]
    async fn aom_report_returns_none_when_no_sessions() {
        let (s, _g) = fresh();
        let report = s.aom_session_latest_report().await.unwrap();
        assert!(report.is_none());
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
