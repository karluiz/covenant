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
use std::sync::{Arc, Once};

use karl_blocks::BlockId;
use karl_session::SessionId;
use rusqlite::{params, Connection, OptionalExtension as _};

/// Register sqlite-vec as a SQLite auto-extension exactly once per process.
/// After registration, every subsequent `Connection::open` automatically
/// loads `vec0` so `vec_version()` and `vec0` virtual tables are usable
/// without per-connection setup.
#[allow(dead_code)]
pub(crate) fn ensure_sqlite_vec_loaded_for_tests() {
    ensure_sqlite_vec_loaded();
}

fn ensure_sqlite_vec_loaded() {
    static INIT: Once = Once::new();
    INIT.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}
use thiserror::Error;
use tokio::sync::Mutex;

use crate::history_import::ZshHistoryEntry;

pub(crate) const SCHEMA: &str = "\
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
    updated_at_unix_ms   INTEGER NOT NULL,
    voice                TEXT NOT NULL DEFAULT 'Terse'
);
CREATE UNIQUE INDEX IF NOT EXISTS operators_default_unique
    ON operators(is_default) WHERE is_default = 1;
CREATE UNIQUE INDEX IF NOT EXISTS operators_name_ci
    ON operators(LOWER(name));

CREATE TABLE IF NOT EXISTS operator_memories (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern              TEXT NOT NULL,
    decision             TEXT NOT NULL,
    rationale            TEXT,
    scope                TEXT NOT NULL,
    tags                 TEXT NOT NULL DEFAULT '',
    created_at_unix_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_memories_scope
    ON operator_memories(scope);
CREATE INDEX IF NOT EXISTS idx_operator_memories_created
    ON operator_memories(created_at_unix_ms DESC);

-- Vector index (sqlite-vec). Mirrors operator_memories.id as rowid.
CREATE VIRTUAL TABLE IF NOT EXISTS operator_memory_vec USING vec0(
    embedding float[384]
);

CREATE TABLE IF NOT EXISTS seen_specs (
    repo_root          TEXT NOT NULL,
    path               TEXT NOT NULL,
    first_seen_at      INTEGER NOT NULL,
    PRIMARY KEY (repo_root, path)
);

CREATE INDEX IF NOT EXISTS idx_seen_specs_repo
    ON seen_specs(repo_root);

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

CREATE TABLE IF NOT EXISTS operator_mind (
    session_id  TEXT PRIMARY KEY,
    json        TEXT NOT NULL,
    turn_count  INTEGER NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_operator_mind_updated_at
    ON operator_mind(updated_at);

CREATE TABLE IF NOT EXISTS teammate_tasks (
    id                  TEXT PRIMARY KEY,
    operator_id         TEXT NOT NULL REFERENCES operators(id) ON DELETE CASCADE,
    archetype           TEXT NOT NULL,           -- 'watch' | 'do' | 'review'
    title               TEXT NOT NULL,
    body                TEXT NOT NULL DEFAULT '',
    deliverable         TEXT NOT NULL DEFAULT '',
    status              TEXT NOT NULL,           -- 'draft'|'active'|'blocked'|'done'|'cancelled'
    scope_json          TEXT NOT NULL DEFAULT '{}',
    spawned_session     TEXT,                    -- session id, NULL unless archetype='do'
    created_at_unix_ms  INTEGER NOT NULL,
    updated_at_unix_ms  INTEGER NOT NULL,
    completed_at_unix_ms INTEGER,
    cost_usd_cents      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tasks_operator ON teammate_tasks(operator_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON teammate_tasks(status);

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
CREATE INDEX IF NOT EXISTS idx_messages_operator ON teammate_messages(operator_id, created_at_unix_ms);
CREATE INDEX IF NOT EXISTS idx_messages_task     ON teammate_messages(task_id) WHERE task_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS teammate_artifacts (
    id                  TEXT PRIMARY KEY,
    task_id             TEXT NOT NULL REFERENCES teammate_tasks(id) ON DELETE CASCADE,
    kind                TEXT NOT NULL,           -- 'diff' | 'file' | 'link' | 'commit' | 'report'
    payload             BLOB NOT NULL,
    created_at_unix_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_task ON teammate_artifacts(task_id);
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

/// Cheap header fields from an operator_mind row — used by MindLossModal
/// to show a preview without deserialising the full JSON blob.
#[derive(Debug, Clone, serde::Serialize)]
pub struct MindPreviewRow {
    pub turn_count: u64,
    pub updated_at_rfc3339: String,
    pub goal: String,
    pub belief: String,
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

/// Per-block hit for the @mention picker. Unlike `RecallMatch`, rows
/// are NOT aggregated by command string — the picker needs the
/// individual block (with its cwd, exit_code, finished_at) so it can
/// be quoted into a prompt with full provenance.
#[derive(Debug, Clone, serde::Serialize)]
pub struct CommandHit {
    pub block_id: String,
    pub session_id: String,
    pub command: String,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub finished_at_unix_ms: u64,
    /// CHAR offsets in `command` where the fuzzy subsequence landed.
    /// Empty when the query is empty.
    pub match_indices: Vec<u32>,
}

/// Excerpt for a single mentioned block — fed back into the composer
/// when expanding a `@cmd:<block_id>` chip. `plain_output` is the full
/// stored output (frontend caps total bundle size).
#[derive(Debug, Clone, serde::Serialize)]
pub struct BlockExcerptDto {
    pub command: String,
    pub exit_code: Option<i32>,
    pub cwd: String,
    pub plain_output: String,
}

/// Tail of one recent block within a session excerpt — last ~4 KB of
/// the block's output, with `command` + `exit_code` for context.
#[derive(Debug, Clone, serde::Serialize)]
pub struct RecentBlockDto {
    pub command: String,
    pub exit_code: Option<i32>,
    pub tail: String,
}

/// Excerpt for a mentioned session. `shell` and `tab_index` are not
/// tracked in the sessions table — the frontend fills them from the
/// in-memory TabManager and overwrites these defaults.
#[derive(Debug, Clone, serde::Serialize)]
pub struct SessionExcerptDto {
    pub cwd: String,
    pub shell: String,
    pub tab_index: u32,
    pub recent: Vec<RecentBlockDto>,
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
    /// Operator that fired this decision. NULL for rows predating the
    /// multi-operator feature or sessions with no operator attached.
    pub operator_id: Option<String>,
    /// Display name of the operator at decision time (snapshot so the
    /// chip still shows the right name even if the operator is renamed).
    pub operator_name: Option<String>,
    /// Estimated cost in USD for this decision (M-OP5 Phase B). 0.0 for
    /// rows predating the column or when no cost was computed.
    pub cost_usd: f64,
    /// 3.13: Memory row that informed this decision (NULL when no
    /// memory was retrieved or applied).
    pub applied_memory_id: Option<i64>,
}

/// 3.13 Operator Learning: a persisted operator memory.
///
/// `pattern` is the natural-language situation description. `decision`
/// is the action template the operator should take when matched.
/// `scope` is `global` or `mission:<path>` (free-form). `tags` is a
/// CSV string for cheap filtering — embeddings handle real similarity.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OperatorMemoryRow {
    pub id: i64,
    pub pattern: String,
    pub decision: String,
    pub rationale: Option<String>,
    pub scope: String,
    pub tags: String,
    pub created_at_unix_ms: u64,
}

/// Serialize a VoiceTone to its DB string representation.
fn voice_to_str(v: crate::operator_registry::VoiceTone) -> &'static str {
    match v {
        crate::operator_registry::VoiceTone::Terse => "Terse",
        crate::operator_registry::VoiceTone::Warm => "Warm",
        crate::operator_registry::VoiceTone::Formal => "Formal",
    }
}

/// Parse a VoiceTone from its DB string. Unknown values fall back
/// to the default (`Terse`) so a corrupted column never crashes the
/// row mapper.
fn voice_from_str(s: &str) -> crate::operator_registry::VoiceTone {
    match s {
        "Warm" => crate::operator_registry::VoiceTone::Warm,
        "Formal" => crate::operator_registry::VoiceTone::Formal,
        _ => crate::operator_registry::VoiceTone::Terse,
    }
}

/// Return the last ~4 KB of `s`, snapped to a UTF-8 char boundary so
/// truncation never produces invalid UTF-8. Empty input returns empty.
fn tail_4kb(s: &str) -> String {
    const MAX: usize = 4096;
    if s.len() <= MAX {
        return s.to_string();
    }
    let mut start = s.len() - MAX;
    while start < s.len() && !s.is_char_boundary(start) {
        start += 1;
    }
    s[start..].to_string()
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
        ensure_sqlite_vec_loaded();
        let conn = Connection::open(path)?;
        // Smoke-check the extension is live; this surfaces wiring breakage
        // immediately rather than letting later vec0 queries fail mysteriously.
        let _vec_version: String = conn.query_row("SELECT vec_version()", [], |r| r.get(0))?;
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
        // 3.12: gamification — accumulated XP per operator. Linear,
        // 100 XP per level. Computed on the UI.
        let _ = conn.execute(
            "ALTER TABLE operators ADD COLUMN xp INTEGER NOT NULL DEFAULT 0",
            [],
        );
        // 3.13 Operator Learning: link a decision back to the memory
        // that informed it (NULL when no memory was applied).
        let _ = conn.execute(
            "ALTER TABLE operator_decisions ADD COLUMN applied_memory_id INTEGER",
            [],
        );
        // Operator identity: voice tone for outbound messages.
        // Existing rows get 'Terse' (the VoiceTone default).
        let _ = conn.execute(
            "ALTER TABLE operators ADD COLUMN voice TEXT NOT NULL DEFAULT 'Terse'",
            [],
        );
        // Teammate phase 1: rolling summary per operator for prompt
        // caching when DMing. Empty for existing rows.
        let _ = conn.execute(
            "ALTER TABLE operators ADD COLUMN rolling_summary TEXT NOT NULL DEFAULT ''",
            [],
        );
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
        // 5.x Operator sentiment: lowercase Spanish token (matches the
        // `Sentiment` enum + `ui/operatorsv2/<char>_<token>.png` filenames).
        // NULL for legacy rows, user turns, and operator turns where the
        // LLM emitted no parseable `SENTIMENT:` directive.
        let _ = conn.execute(
            "ALTER TABLE teammate_messages ADD COLUMN sentiment TEXT",
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

    /// Expose the underlying connection arc so other modules (e.g.
    /// `project_notes`) can share the same SQLite connection without
    /// opening a second DB file.
    pub fn conn(&self) -> Arc<Mutex<Connection>> {
        self.inner.clone()
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
        tokio::task::spawn_blocking(move || -> Result<Vec<HistoricalBlock>, StorageError> {
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
        tokio::task::spawn_blocking(move || -> Result<Vec<HistoricalBlock>, StorageError> {
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
        })
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

        tokio::task::spawn_blocking(move || -> Result<Vec<RecallMatch>, StorageError> {
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

            let rows = stmt.query_map(params![cwd_for_match, q_trim, POOL as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)? as u64,
                    r.get::<_, Option<i64>>(2)?.unwrap_or(0) as u64,
                    r.get::<_, Option<i64>>(3)?.unwrap_or(0) as u64,
                    r.get::<_, i64>(4)? as u64,
                ))
            })?;

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
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Per-block fuzzy command search for the `@` mention picker.
    ///
    /// Returns up to `limit` recent finished blocks whose `command`
    /// matches `query` as a case-insensitive subsequence. Ranked by
    /// fuzzy score desc, then `finished_at_unix_ms` desc. Empty query
    /// returns the newest finished blocks (score 0, no match_indices).
    pub async fn recent_commands(
        &self,
        query: String,
        limit: usize,
    ) -> Result<Vec<CommandHit>, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<CommandHit>, StorageError> {
            let c = conn.blocking_lock();

            // Generous pool so fuzzy ranking can re-order before the
            // final `limit` truncation; SQL only does recency-window.
            const POOL: i64 = 1000;

            let mut stmt = c.prepare(
                "SELECT id, session_id, command, exit_code, cwd, finished_at_unix_ms
                 FROM blocks
                 WHERE command != ''
                 ORDER BY finished_at_unix_ms DESC
                 LIMIT ?1",
            )?;

            let rows = stmt.query_map(params![POOL], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<i64>>(3)?.map(|v| v as i32),
                    r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    r.get::<_, i64>(5)? as u64,
                ))
            })?;

            let q_trim = query.trim();
            let needle: Vec<char> = q_trim.to_lowercase().chars().collect();
            let empty_query = needle.is_empty();

            let mut scored: Vec<(i32, CommandHit)> = Vec::new();
            for row in rows {
                let (block_id, session_id, command, exit_code, cwd, finished_at_unix_ms) = row?;
                let (score, indices) = if empty_query {
                    (0, Vec::new())
                } else {
                    match crate::structure::fuzzy_score(&command, &needle) {
                        Some(v) => v,
                        None => continue,
                    }
                };
                scored.push((
                    score,
                    CommandHit {
                        block_id,
                        session_id,
                        command,
                        exit_code,
                        cwd,
                        finished_at_unix_ms,
                        match_indices: indices.into_iter().map(|c| c as u32).collect(),
                    },
                ));
            }

            scored.sort_by(|a, b| {
                b.0.cmp(&a.0)
                    .then_with(|| b.1.finished_at_unix_ms.cmp(&a.1.finished_at_unix_ms))
            });
            scored.truncate(limit);
            Ok(scored.into_iter().map(|(_, h)| h).collect())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Fetch a single block's command + exit + cwd + full stored output
    /// for `@cmd:<block_id>` chip expansion. Errors `Other("not found")`
    /// when the block id isn't in the table.
    pub async fn read_block_excerpt(
        &self,
        block_id: String,
    ) -> Result<BlockExcerptDto, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<BlockExcerptDto, StorageError> {
            let c = conn.blocking_lock();
            let result: rusqlite::Result<(String, Option<i64>, Option<String>, Option<String>)> =
                c.query_row(
                    "SELECT command, exit_code, cwd, output_text FROM blocks WHERE id = ?1",
                    params![block_id],
                    |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
                );
            match result {
                Ok((command, exit_code, cwd, output_text)) => Ok(BlockExcerptDto {
                    command,
                    exit_code: exit_code.map(|v| v as i32),
                    cwd: cwd.unwrap_or_default(),
                    plain_output: output_text.unwrap_or_default(),
                }),
                Err(rusqlite::Error::QueryReturnedNoRows) => {
                    Err(StorageError::Other(format!("block {block_id} not found")))
                }
                Err(e) => Err(StorageError::Sqlite(e)),
            }
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Fetch the last-known cwd + the `n` most-recent finished blocks
    /// for `session_id`, each truncated to a ~4 KB tail. Used for
    /// `@session:<short>` chip expansion. `shell` + `tab_index` are
    /// left as defaults — caller (UI) fills them from TabManager.
    pub async fn read_session_excerpt(
        &self,
        session_id: String,
        n: usize,
    ) -> Result<SessionExcerptDto, StorageError> {
        let conn = self.inner.clone();
        let n = n.clamp(1, 50);
        tokio::task::spawn_blocking(move || -> Result<SessionExcerptDto, StorageError> {
            let c = conn.blocking_lock();

            // Confirm the session exists.
            let session_exists: i64 = c
                .query_row(
                    "SELECT COUNT(*) FROM sessions WHERE id = ?1",
                    params![session_id],
                    |r| r.get(0),
                )
                .map_err(StorageError::Sqlite)?;
            if session_exists == 0 {
                return Err(StorageError::Other(format!("session {session_id} not found")));
            }

            // Latest cwd: take the most-recent block's cwd (sessions has none).
            let latest_cwd: Option<String> = c
                .query_row(
                    "SELECT cwd FROM blocks
                     WHERE session_id = ?1 AND cwd IS NOT NULL
                     ORDER BY finished_at_unix_ms DESC LIMIT 1",
                    params![session_id],
                    |r| r.get(0),
                )
                .ok();

            let mut stmt = c.prepare(
                "SELECT command, exit_code, output_text
                 FROM blocks
                 WHERE session_id = ?1
                 ORDER BY finished_at_unix_ms DESC
                 LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![session_id, n as i64], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, Option<i64>>(1)?.map(|v| v as i32),
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                ))
            })?;
            let mut recent = Vec::new();
            for row in rows {
                let (command, exit_code, output_text) = row?;
                recent.push(RecentBlockDto { command, exit_code, tail: tail_4kb(&output_text) });
            }
            // Surface oldest-first so the reader sees chronological order.
            recent.reverse();

            Ok(SessionExcerptDto {
                cwd: latest_cwd.unwrap_or_default(),
                shell: String::new(),
                tab_index: 0,
                recent,
            })
        })
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
    pub async fn get_block_output(&self, block_id: String) -> Result<Option<String>, StorageError> {
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
        operator_id: Option<String>,
        operator_name: Option<String>,
        applied_memory_id: Option<i64>,
    ) -> Result<i64, StorageError> {
        let conn = self.inner.clone();
        let session_str = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<i64, StorageError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO operator_decisions
                 (session_id, timestamp_unix_ms, in_flight_command,
                  output_excerpt, action, reply_text, rationale, executed,
                  cost_usd, mission_path, executor_name, operator_id, operator_name,
                  applied_memory_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)",
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
                    operator_id,
                    operator_name,
                    applied_memory_id,
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
    pub async fn aom_session_latest_report(&self) -> Result<Option<AomReport>, StorageError> {
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

            let Some((row_id, started_ms, ended_ms, budget, accum, decisions, cap_hit)) = header
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
                let rows = stmt
                    .query_map(params![started_ms, window_end_ms, sid.as_str()], |r| {
                        r.get::<_, Option<String>>(0)
                    })?;
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
        tokio::task::spawn_blocking(move || -> Result<Vec<OperatorDecisionRow>, StorageError> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, session_id, timestamp_unix_ms, in_flight_command,
                            output_excerpt, action, reply_text, rationale, executed,
                            mission_path, executor_name, operator_id, operator_name,
                            cost_usd, applied_memory_id
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
                    operator_id: r.get(11)?,
                    operator_name: r.get(12)?,
                    cost_usd: r.get::<_, f64>(13)?,
                    applied_memory_id: r.get::<_, Option<i64>>(14)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// List the most recent operator decisions for a single session. Used
    /// by the teammate panel's task-details view (decisions feed). Newest
    /// first, limited.
    pub async fn list_operator_decisions_for_session(
        &self,
        session_id: String,
        limit: u32,
    ) -> Result<Vec<OperatorDecisionRow>, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<OperatorDecisionRow>, StorageError> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, session_id, timestamp_unix_ms, in_flight_command,
                            output_excerpt, action, reply_text, rationale, executed,
                            mission_path, executor_name, operator_id, operator_name,
                            cost_usd, applied_memory_id
                     FROM operator_decisions
                     WHERE session_id = ?1
                     ORDER BY id DESC
                     LIMIT ?2",
            )?;
            let rows = stmt.query_map(params![session_id, limit as i64], |r| {
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
                    operator_id: r.get(11)?,
                    operator_name: r.get(12)?,
                    cost_usd: r.get::<_, f64>(13)?,
                    applied_memory_id: r.get::<_, Option<i64>>(14)?,
                })
            })?;
            let mut out = Vec::new();
            for row in rows { out.push(row?); }
            Ok(out)
        })
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
            let tags_json =
                serde_json::to_string(&op.tags).map_err(|e| StorageError::Other(e.to_string()))?;
            c.execute(
                "INSERT INTO operators (id, name, emoji, color, tags_json, persona, \
                 escalate_threshold, model, hard_constraints, is_default, \
                 created_at_unix_ms, updated_at_unix_ms, xp, voice) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14)",
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
                    op.xp as i64,
                    voice_to_str(op.voice),
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
            let tags_json =
                serde_json::to_string(&op.tags).map_err(|e| StorageError::Other(e.to_string()))?;
            c.execute(
                "UPDATE operators SET name=?2, emoji=?3, color=?4, tags_json=?5, \
                 persona=?6, escalate_threshold=?7, model=?8, hard_constraints=?9, \
                 updated_at_unix_ms=?10, voice=?11 WHERE id=?1",
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
                    voice_to_str(op.voice),
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
                 created_at_unix_ms, updated_at_unix_ms, xp, voice FROM operators \
                 ORDER BY is_default DESC, LOWER(name) ASC",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    let id: String = row.get(0)?;
                    let tags_json: String = row.get(4)?;
                    let tags: Vec<String> = serde_json::from_str(&tags_json).unwrap_or_default();
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
                        xp: row.get::<_, i64>(12).unwrap_or(0).max(0) as u64,
                        voice: row
                            .get::<_, String>(13)
                            .map(|s| voice_from_str(&s))
                            .unwrap_or_default(),
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// 3.12: atomically increment an operator's XP by `amount` and
    /// return the new total. Returns 0 if the row no longer exists
    /// (operator was deleted) without erroring — caller treats this as
    /// a benign no-op.
    pub async fn operator_award_xp(&self, id: String, amount: u64) -> Result<u64, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<u64, StorageError> {
            let mut c = conn.blocking_lock();
            let tx = c.transaction()?;
            let n = tx.execute(
                "UPDATE operators SET xp = xp + ?1 WHERE id = ?2",
                params![amount as i64, id],
            )?;
            if n == 0 {
                tx.commit()?;
                return Ok(0);
            }
            let total: i64 =
                tx.query_row("SELECT xp FROM operators WHERE id = ?1", params![id], |r| {
                    r.get(0)
                })?;
            tx.commit()?;
            Ok(total.max(0) as u64)
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

    /// 3.13 Operator Learning: insert one memory + its embedding into
    /// `operator_memories` and `operator_memory_vec` (rowids kept in
    /// sync). Wrapped in a transaction so a vec0 failure rolls back the
    /// row insert. Embedding length must be exactly 384.
    #[allow(clippy::too_many_arguments)]
    pub async fn insert_memory(
        &self,
        pattern: &str,
        decision: &str,
        rationale: Option<&str>,
        scope: &str,
        tags: &str,
        created_at_unix_ms: u64,
        embedding: &[f32],
    ) -> Result<i64, StorageError> {
        if embedding.len() != 384 {
            return Err(StorageError::Other(format!(
                "embedding length must be 384, got {}",
                embedding.len()
            )));
        }
        let conn = self.inner.clone();
        let pattern = pattern.to_string();
        let decision = decision.to_string();
        let rationale = rationale.map(|s| s.to_string());
        let scope = scope.to_string();
        let tags = tags.to_string();
        // sqlite-vec accepts the raw little-endian f32 byte representation
        // of the vector as a BLOB. Build it once here so the blocking
        // closure doesn't borrow the &[f32].
        let mut bytes: Vec<u8> = Vec::with_capacity(embedding.len() * 4);
        for f in embedding {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
        tokio::task::spawn_blocking(move || -> Result<i64, StorageError> {
            let mut c = conn.blocking_lock();
            let tx = c.transaction()?;
            tx.execute(
                "INSERT INTO operator_memories
                 (pattern, decision, rationale, scope, tags, created_at_unix_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    pattern,
                    decision,
                    rationale,
                    scope,
                    tags,
                    created_at_unix_ms as i64,
                ],
            )?;
            let id = tx.last_insert_rowid();
            tx.execute(
                "INSERT INTO operator_memory_vec (rowid, embedding) VALUES (?1, ?2)",
                params![id, bytes],
            )?;
            tx.commit()?;
            Ok(id)
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// 3.13: list memories whose `scope` is in `scopes`, newest first.
    /// Empty `scopes` returns an empty Vec (no SQL issued).
    pub async fn list_memories(
        &self,
        scopes: &[&str],
        limit: usize,
    ) -> Result<Vec<OperatorMemoryRow>, StorageError> {
        if scopes.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.inner.clone();
        let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        tokio::task::spawn_blocking(move || -> Result<Vec<OperatorMemoryRow>, StorageError> {
            let c = conn.blocking_lock();
            let placeholders = (1..=scopes.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "SELECT id, pattern, decision, rationale, scope, tags, created_at_unix_ms
                     FROM operator_memories
                     WHERE scope IN ({placeholders})
                     ORDER BY created_at_unix_ms DESC
                     LIMIT ?{limit_idx}",
                limit_idx = scopes.len() + 1,
            );
            let mut stmt = c.prepare(&sql)?;
            let mut params_dyn: Vec<&dyn rusqlite::ToSql> =
                scopes.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            let limit_i64 = limit as i64;
            params_dyn.push(&limit_i64);
            let rows = stmt.query_map(rusqlite::params_from_iter(params_dyn), |r| {
                Ok(OperatorMemoryRow {
                    id: r.get(0)?,
                    pattern: r.get(1)?,
                    decision: r.get(2)?,
                    rationale: r.get(3)?,
                    scope: r.get(4)?,
                    tags: r.get(5)?,
                    created_at_unix_ms: r.get::<_, i64>(6)? as u64,
                })
            })?;
            let mut out = Vec::new();
            for row in rows {
                out.push(row?);
            }
            Ok(out)
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// 3.13 perf: cheap COUNT(*) over `operator_memories` filtered by
    /// `scopes`. Used as a short-circuit guard before doing an embed +
    /// vector search on every operator tick. Indexed by
    /// `idx_operator_memories_scope`, so this runs in microseconds.
    pub async fn count_memories(&self, scopes: &[&str]) -> Result<u64, StorageError> {
        if scopes.is_empty() {
            return Ok(0);
        }
        let conn = self.inner.clone();
        let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        tokio::task::spawn_blocking(move || -> Result<u64, StorageError> {
            let c = conn.blocking_lock();
            let placeholders = (1..=scopes.len())
                .map(|i| format!("?{i}"))
                .collect::<Vec<_>>()
                .join(",");
            let sql =
                format!("SELECT COUNT(*) FROM operator_memories WHERE scope IN ({placeholders})",);
            let mut stmt = c.prepare(&sql)?;
            let params_dyn: Vec<&dyn rusqlite::ToSql> =
                scopes.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
            let n: i64 = stmt.query_row(rusqlite::params_from_iter(params_dyn), |r| r.get(0))?;
            Ok(n.max(0) as u64)
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// 3.13: top-k vector search over `operator_memory_vec`, filtered to
    /// `scopes`. Returns (row, distance) pairs ordered by ascending
    /// distance. Embedding length must be exactly 384.
    pub async fn vector_search_memories(
        &self,
        scopes: &[&str],
        query_embedding: &[f32],
        k: usize,
    ) -> Result<Vec<(OperatorMemoryRow, f32)>, StorageError> {
        if query_embedding.len() != 384 {
            return Err(StorageError::Other(format!(
                "embedding length must be 384, got {}",
                query_embedding.len()
            )));
        }
        if scopes.is_empty() || k == 0 {
            return Ok(Vec::new());
        }
        let conn = self.inner.clone();
        let scopes: Vec<String> = scopes.iter().map(|s| s.to_string()).collect();
        let mut bytes: Vec<u8> = Vec::with_capacity(query_embedding.len() * 4);
        for f in query_embedding {
            bytes.extend_from_slice(&f.to_le_bytes());
        }
        tokio::task::spawn_blocking(
            move || -> Result<Vec<(OperatorMemoryRow, f32)>, StorageError> {
                let c = conn.blocking_lock();
                // sqlite-vec MATCH + KNN. The `k = ?` constraint is how
                // sqlite-vec receives the desired neighbor count. We
                // post-filter by scope on the join because vec0's WHERE
                // can only reference the embedding column / k / rowid.
                let placeholders = (3..3 + scopes.len())
                    .map(|i| format!("?{i}"))
                    .collect::<Vec<_>>()
                    .join(",");
                let sql = format!(
                    "SELECT m.id, m.pattern, m.decision, m.rationale, m.scope, m.tags,
                            m.created_at_unix_ms, v.distance
                     FROM operator_memory_vec v
                     JOIN operator_memories m ON m.id = v.rowid
                     WHERE v.embedding MATCH ?1 AND k = ?2
                       AND m.scope IN ({placeholders})
                     ORDER BY v.distance",
                );
                let mut stmt = c.prepare(&sql)?;
                let k_i64 = k as i64;
                let mut params_dyn: Vec<&dyn rusqlite::ToSql> = vec![
                    &bytes as &dyn rusqlite::ToSql,
                    &k_i64 as &dyn rusqlite::ToSql,
                ];
                for s in &scopes {
                    params_dyn.push(s as &dyn rusqlite::ToSql);
                }
                let rows = stmt.query_map(rusqlite::params_from_iter(params_dyn), |r| {
                    let row = OperatorMemoryRow {
                        id: r.get(0)?,
                        pattern: r.get(1)?,
                        decision: r.get(2)?,
                        rationale: r.get(3)?,
                        scope: r.get(4)?,
                        tags: r.get(5)?,
                        created_at_unix_ms: r.get::<_, i64>(6)? as u64,
                    };
                    let dist: f64 = r.get(7)?;
                    Ok((row, dist as f32))
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

    /// 3.13: delete a memory + its vector index entry. Idempotent — a
    /// missing id is not an error.
    pub async fn delete_memory(&self, id: i64) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let mut c = conn.blocking_lock();
            let tx = c.transaction()?;
            tx.execute("DELETE FROM operator_memories WHERE id = ?1", params![id])?;
            tx.execute(
                "DELETE FROM operator_memory_vec WHERE rowid = ?1",
                params![id],
            )?;
            tx.commit()?;
            Ok(())
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

    /// Load the persisted OperatorMind for a session, if any.
    /// Corrupt JSON triggers automatic delete + returns None so the next
    /// turn rebuilds default.
    pub async fn mind_load(
        &self,
        session_id: &str,
    ) -> Result<Option<crate::operator_mind::OperatorMind>, StorageError> {
        let conn = self.inner.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(
            move || -> Result<Option<crate::operator_mind::OperatorMind>, StorageError> {
                let conn = conn.blocking_lock();
                let result: Result<String, rusqlite::Error> = conn.query_row(
                    "SELECT json FROM operator_mind WHERE session_id = ?1",
                    params![session_id],
                    |row| row.get(0),
                );
                match result {
                    Ok(json) => {
                        match serde_json::from_str::<crate::operator_mind::OperatorMind>(&json) {
                            Ok(m) => Ok(Some(m)),
                            Err(e) => {
                                tracing::warn!(
                                    session_id = %session_id,
                                    error = %e,
                                    "operator_mind: corrupt JSON, deleting and starting fresh"
                                );
                                let _ = conn.execute(
                                    "DELETE FROM operator_mind WHERE session_id = ?1",
                                    params![session_id],
                                );
                                Ok(None)
                            }
                        }
                    }
                    Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                    Err(e) => Err(StorageError::Sqlite(e)),
                }
            },
        )
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Persist (upsert) the OperatorMind for a session.
    pub async fn mind_save(
        &self,
        session_id: &str,
        mind: &crate::operator_mind::OperatorMind,
    ) -> Result<(), StorageError> {
        let json = serde_json::to_string(mind)
            .map_err(|e| StorageError::Other(format!("operator_mind serialize: {e}")))?;
        let session_id = session_id.to_string();
        let turn_count = mind.turn_count as i64;
        let updated_at = mind.updated_at.to_rfc3339();
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let conn = conn.blocking_lock();
            conn.execute(
                "INSERT INTO operator_mind (session_id, json, turn_count, updated_at)
                 VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(session_id) DO UPDATE SET
                   json = excluded.json,
                   turn_count = excluded.turn_count,
                   updated_at = excluded.updated_at",
                params![session_id, json, turn_count, updated_at],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Delete the OperatorMind for a session.
    pub async fn mind_delete(&self, session_id: &str) -> Result<(), StorageError> {
        let conn = self.inner.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let conn = conn.blocking_lock();
            conn.execute(
                "DELETE FROM operator_mind WHERE session_id = ?1",
                params![session_id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// GC: drop minds whose session_id no longer exists in `sessions`.
    /// Returns count of rows deleted. Run on app startup.
    pub async fn mind_gc_orphans(&self) -> Result<usize, StorageError> {
        let conn = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<usize, StorageError> {
            let conn = conn.blocking_lock();
            let n = conn.execute(
                "DELETE FROM operator_mind
                 WHERE session_id NOT IN (SELECT id FROM sessions)",
                [],
            )?;
            Ok(n)
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Cheap header read for the MindLossModal preview path.
    /// Returns None if the row is absent.
    pub async fn mind_preview(
        &self,
        session_id: &str,
    ) -> Result<Option<MindPreviewRow>, StorageError> {
        let conn = self.inner.clone();
        let session_id = session_id.to_string();
        tokio::task::spawn_blocking(move || -> Result<Option<MindPreviewRow>, StorageError> {
            let conn = conn.blocking_lock();
            let result: Result<(String, i64, String), rusqlite::Error> = conn.query_row(
                "SELECT json, turn_count, updated_at FROM operator_mind WHERE session_id = ?1",
                params![session_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            );
            match result {
                Ok((json, turn_count, updated_at)) => {
                    let mind: crate::operator_mind::OperatorMind = serde_json::from_str(&json)
                        .map_err(|e| StorageError::Other(format!("mind_preview JSON: {e}")))?;
                    Ok(Some(MindPreviewRow {
                        turn_count: turn_count as u64,
                        updated_at_rfc3339: updated_at,
                        goal: mind.goal,
                        belief: mind.belief,
                    }))
                }
                Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
                Err(e) => Err(StorageError::Sqlite(e)),
            }
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Insert a TaskMessage. `content_json` is the serde repr of `MessageContent`
    /// (tagged with `kind`/`data` per the type's derive attributes).
    pub async fn teammate_insert_message(
        &self,
        msg: &crate::teammate::TaskMessage,
    ) -> Result<(), StorageError> {
        let inner = self.inner.clone();
        let msg = msg.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = inner.blocking_lock();
            let role = serde_json::to_string(&msg.role)
                .map_err(|e| StorageError::Other(e.to_string()))?;
            let role = role.trim_matches('"').to_string();
            let content_json = serde_json::to_string(&msg.content)
                .map_err(|e| StorageError::Other(e.to_string()))?;
            let content_kind = match &msg.content {
                crate::teammate::MessageContent::Text(_)         => "text",
                crate::teammate::MessageContent::TaskDraft(_)    => "task_draft",
                crate::teammate::MessageContent::TaskUpdate {..} => "task_update",
                crate::teammate::MessageContent::Propose(_)      => "propose",
                crate::teammate::MessageContent::Report(_)       => "report",
            };
            c.execute(
                "INSERT INTO teammate_messages \
                 (id, operator_id, task_id, role, content_kind, content_json, created_at_unix_ms, sentiment) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    msg.id.0.to_string(),
                    msg.operator_id.0.to_string(),
                    msg.task_id.map(|t| t.0.to_string()),
                    role,
                    content_kind,
                    content_json,
                    msg.created_at_unix_ms as i64,
                    msg.sentiment.map(|s| s.as_token()),
                ],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// List the most recent `limit` messages for an operator, returned oldest first.
    pub async fn teammate_list_messages(
        &self,
        operator_id: crate::operator_registry::OperatorId,
        limit: usize,
    ) -> Result<Vec<crate::teammate::TaskMessage>, StorageError> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<crate::teammate::TaskMessage>, StorageError> {
            let c = inner.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, operator_id, task_id, role, content_kind, content_json, \
                        created_at_unix_ms, confirmed_at_unix_ms, dismissed_at_unix_ms, sentiment \
                 FROM teammate_messages WHERE operator_id = ?1 \
                 ORDER BY created_at_unix_ms ASC LIMIT ?2",
            )?;
            let rows = stmt.query_map(
                params![operator_id.0.to_string(), limit as i64],
                |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, Option<String>>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                        r.get::<_, i64>(6)?,
                        r.get::<_, Option<i64>>(7)?,
                        r.get::<_, Option<i64>>(8)?,
                        r.get::<_, Option<String>>(9)?,
                    ))
                },
            )?;
            let mut out = Vec::new();
            for row in rows {
                let (id, op_id, task_id, role, _kind, content_json, ts, confirmed, dismissed, sentiment_s) = row?;
                let id = ulid::Ulid::from_string(&id)
                    .map_err(|e| StorageError::Other(e.to_string()))?;
                let op_id = ulid::Ulid::from_string(&op_id)
                    .map_err(|e| StorageError::Other(e.to_string()))?;
                let task_id = task_id
                    .as_deref()
                    .map(ulid::Ulid::from_string)
                    .transpose()
                    .map_err(|e| StorageError::Other(e.to_string()))?;
                let role: crate::teammate::Role =
                    serde_json::from_str(&format!("\"{}\"", role))
                        .map_err(|e| StorageError::Other(e.to_string()))?;
                let content: crate::teammate::MessageContent =
                    serde_json::from_str(&content_json)
                        .map_err(|e| StorageError::Other(e.to_string()))?;
                let sentiment = sentiment_s
                    .as_deref()
                    .and_then(crate::teammate::Sentiment::from_token);
                out.push(crate::teammate::TaskMessage {
                    id: crate::teammate::MessageId(id),
                    operator_id: crate::operator_registry::OperatorId(op_id),
                    task_id: task_id.map(crate::teammate::TaskId),
                    role,
                    content,
                    created_at_unix_ms: ts as u64,
                    confirmed_at_unix_ms: confirmed.map(|v| v as u64),
                    dismissed_at_unix_ms: dismissed.map(|v| v as u64),
                    sentiment,
                });
            }
            Ok(out)
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    /// Insert a Task. Phase 1: callers limited to internal seeds + tests.
    pub async fn teammate_insert_task(
        &self,
        task: &crate::teammate::Task,
    ) -> Result<(), StorageError> {
        let inner = self.inner.clone();
        let task = task.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = inner.blocking_lock();
            let archetype = match task.archetype {
                crate::teammate::TaskArchetype::Watch  => "watch",
                crate::teammate::TaskArchetype::Do     => "do",
                crate::teammate::TaskArchetype::Review => "review",
            };
            let status = match task.status {
                crate::teammate::TaskStatus::Draft     => "draft",
                crate::teammate::TaskStatus::Active    => "active",
                crate::teammate::TaskStatus::Blocked   => "blocked",
                crate::teammate::TaskStatus::Done      => "done",
                crate::teammate::TaskStatus::Cancelled => "cancelled",
            };
            let scope_json = serde_json::to_string(&task.scope)
                .map_err(|e| StorageError::Other(e.to_string()))?;
            c.execute(
                "INSERT INTO teammate_tasks \
                 (id, operator_id, archetype, title, body, deliverable, status, \
                  scope_json, spawned_session, created_at_unix_ms, updated_at_unix_ms, \
                  completed_at_unix_ms, cost_usd_cents) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
                params![
                    task.id.0.to_string(),
                    task.operator_id.0.to_string(),
                    archetype,
                    task.title,
                    task.body,
                    task.deliverable,
                    status,
                    scope_json,
                    task.spawned_session.map(|s| s.to_string()),
                    task.created_at_unix_ms as i64,
                    task.updated_at_unix_ms as i64,
                    task.completed_at_unix_ms.map(|t| t as i64),
                    task.cost_usd_cents as i64,
                ],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StorageError::Join(e.to_string()))?
    }

    pub async fn teammate_get_message(
        &self,
        id: crate::teammate::MessageId,
    ) -> Result<Option<crate::teammate::TaskMessage>, StorageError> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<Option<crate::teammate::TaskMessage>, StorageError> {
            let c = inner.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, operator_id, task_id, role, content_kind, content_json, \
                        created_at_unix_ms, confirmed_at_unix_ms, dismissed_at_unix_ms, sentiment \
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
                let sentiment_s: Option<String> = row.get(9)?;
                Ok((id_s, op_s, task_s, role_s, content_s, created, confirmed, dismissed, sentiment_s))
            }).optional()?;
            let Some((id_s, op_s, task_s, role_s, content_s, created, confirmed, dismissed, sentiment_s)) = row else {
                return Ok(None);
            };
            let id = ulid::Ulid::from_string(&id_s).map_err(|e| StorageError::Other(e.to_string()))?;
            let op = ulid::Ulid::from_string(&op_s).map_err(|e| StorageError::Other(e.to_string()))?;
            let task = task_s.as_deref().map(ulid::Ulid::from_string).transpose()
                .map_err(|e| StorageError::Other(e.to_string()))?;
            let role: crate::teammate::Role = serde_json::from_str(&format!("\"{}\"", role_s))
                .map_err(|e| StorageError::Other(e.to_string()))?;
            let content: crate::teammate::MessageContent = serde_json::from_str(&content_s)
                .map_err(|e| StorageError::Other(e.to_string()))?;
            let sentiment = sentiment_s
                .as_deref()
                .and_then(crate::teammate::Sentiment::from_token);
            Ok(Some(crate::teammate::TaskMessage {
                id: crate::teammate::MessageId(id),
                operator_id: crate::operator_registry::OperatorId(op),
                task_id: task.map(crate::teammate::TaskId),
                role,
                content,
                created_at_unix_ms: created as u64,
                confirmed_at_unix_ms: confirmed.map(|v| v as u64),
                dismissed_at_unix_ms: dismissed.map(|v| v as u64),
                sentiment,
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

    /// Wipe every message and task belonging to an operator. Artifacts cascade
     /// via the FK on teammate_artifacts.task_id. Used by the panel's "reset
     /// chats & tasks" affordance for testing.
    pub async fn teammate_clear_for_operator(
        &self,
        op: crate::operator_registry::OperatorId,
    ) -> Result<(), StorageError> {
        let inner = self.inner.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = inner.blocking_lock();
            let op_s = op.0.to_string();
            c.execute("DELETE FROM teammate_messages WHERE operator_id = ?1", params![op_s])?;
            c.execute("DELETE FROM teammate_tasks    WHERE operator_id = ?1", params![op_s])?;
            Ok(())
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

    pub async fn teammate_update_task_status(
        &self,
        id: crate::teammate::TaskId,
        status: crate::teammate::TaskStatus,
        now_unix_ms: u64,
    ) -> Result<(), StorageError> {
        let inner = self.inner.clone();
        let status_str = match status {
            crate::teammate::TaskStatus::Draft     => "draft",
            crate::teammate::TaskStatus::Active    => "active",
            crate::teammate::TaskStatus::Blocked   => "blocked",
            crate::teammate::TaskStatus::Done      => "done",
            crate::teammate::TaskStatus::Cancelled => "cancelled",
        };
        tokio::task::spawn_blocking(move || -> Result<(), StorageError> {
            let c = inner.blocking_lock();
            c.execute(
                "UPDATE teammate_tasks SET status = ?1, updated_at_unix_ms = ?2 WHERE id = ?3",
                params![status_str, now_unix_ms as i64, id.0.to_string()],
            )?;
            Ok(())
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

    async fn insert_finished_block(s: &Storage, session: SessionId, cmd: &str, finished: u64) {
        s.save_block(
            BlockId::new(),
            session,
            cmd.to_string(),
            Some("/tmp".to_string()),
            Some(0),
            10,
            finished,
            String::new(),
        )
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn recent_commands_ranks_fuzzy_then_recency() {
        let (s, _g) = fresh();
        let session = SessionId::new();
        s.save_session(session, 1).await.unwrap();
        insert_finished_block(&s, session, "cargo build", 100).await;
        insert_finished_block(&s, session, "cargo test", 200).await;
        insert_finished_block(&s, session, "git status", 150).await;
        insert_finished_block(&s, session, "cargo bench", 50).await;

        let hits = s.recent_commands("cargo".to_string(), 10).await.unwrap();
        let cmds: Vec<&str> = hits.iter().map(|h| h.command.as_str()).collect();
        assert!(cmds.contains(&"cargo test"));
        assert!(!cmds.contains(&"git status"));
        let pos = |c: &str| cmds.iter().position(|x| *x == c).unwrap();
        assert!(pos("cargo test") < pos("cargo build"));
        assert!(pos("cargo build") < pos("cargo bench"));
    }

    #[tokio::test]
    async fn recent_commands_empty_query_returns_newest_first() {
        let (s, _g) = fresh();
        let session = SessionId::new();
        s.save_session(session, 1).await.unwrap();
        insert_finished_block(&s, session, "a", 1).await;
        insert_finished_block(&s, session, "b", 2).await;
        let hits = s.recent_commands("".to_string(), 10).await.unwrap();
        assert_eq!(hits[0].command, "b");
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
        s.save_summary(session, "first".to_string(), 1)
            .await
            .unwrap();
        s.save_summary(session, "second".to_string(), 2)
            .await
            .unwrap();

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

        let rows = s.recall_search("git".to_string(), None, 10).await.unwrap();
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
            .recall_search("make".to_string(), Some("/home/me".to_string()), 10)
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
            None,
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
            None,
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
            None,
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
            None,
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
            None,
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

    // ---- 3.13 Operator Learning: memory CRUD + applied_memory_id ----

    fn dummy_embedding(seed: f32) -> Vec<f32> {
        // 384-dim, all the same value. Querying with the same vector
        // exercises the round-trip plumbing — exact semantic similarity
        // is not the property under test.
        vec![seed; 384]
    }

    #[tokio::test]
    async fn memory_insert_and_list_orders_desc() {
        let (s, _g) = fresh();
        let e = dummy_embedding(0.1);
        let id_a = s
            .insert_memory("a", "do a", None, "global", "", 1_000, &e)
            .await
            .unwrap();
        let id_b = s
            .insert_memory("b", "do b", None, "global", "", 2_000, &e)
            .await
            .unwrap();
        let id_c = s
            .insert_memory("c", "do c", None, "global", "", 3_000, &e)
            .await
            .unwrap();
        assert!(id_a < id_b && id_b < id_c);

        let rows = s.list_memories(&["global"], 10).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].pattern, "c");
        assert_eq!(rows[1].pattern, "b");
        assert_eq!(rows[2].pattern, "a");
    }

    #[tokio::test]
    async fn memory_list_filters_by_scope() {
        let (s, _g) = fresh();
        let e = dummy_embedding(0.1);
        s.insert_memory("g1", "x", None, "global", "", 100, &e)
            .await
            .unwrap();
        s.insert_memory("m1", "x", None, "mission:foo", "", 200, &e)
            .await
            .unwrap();
        s.insert_memory("m2", "x", None, "mission:foo", "", 300, &e)
            .await
            .unwrap();

        let rows = s.list_memories(&["mission:foo"], 10).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.scope == "mission:foo"));

        // Empty scopes → empty Vec, no SQL.
        let none: &[&str] = &[];
        let empty = s.list_memories(none, 10).await.unwrap();
        assert!(empty.is_empty());
    }

    #[tokio::test]
    async fn count_memories_returns_zero_for_empty_scope_list() {
        let (s, _g) = fresh();
        let e = dummy_embedding(0.1);
        s.insert_memory("g1", "x", None, "global", "", 100, &e)
            .await
            .unwrap();
        let none: &[&str] = &[];
        assert_eq!(s.count_memories(none).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn count_memories_returns_count_filtered_by_scope() {
        let (s, _g) = fresh();
        let e = dummy_embedding(0.1);
        s.insert_memory("g1", "x", None, "global", "", 100, &e)
            .await
            .unwrap();
        s.insert_memory("g2", "x", None, "global", "", 110, &e)
            .await
            .unwrap();
        s.insert_memory("m1", "x", None, "mission:foo", "", 200, &e)
            .await
            .unwrap();

        assert_eq!(s.count_memories(&["global"]).await.unwrap(), 2);
        assert_eq!(s.count_memories(&["mission:foo"]).await.unwrap(), 1);
        assert_eq!(
            s.count_memories(&["global", "mission:foo"]).await.unwrap(),
            3
        );
        assert_eq!(s.count_memories(&["mission:nope"]).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn memory_vector_search_returns_self_with_low_distance() {
        let (s, _g) = fresh();
        let e = dummy_embedding(0.1);
        let id = s
            .insert_memory("p", "d", None, "global", "", 100, &e)
            .await
            .unwrap();

        let hits = s.vector_search_memories(&["global"], &e, 5).await.unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0.id, id);
        assert!(
            hits[0].1.abs() < 1e-3,
            "distance should be ~0, got {}",
            hits[0].1
        );
    }

    #[tokio::test]
    async fn memory_delete_removes_from_both_tables() {
        let (s, _g) = fresh();
        let e = dummy_embedding(0.1);
        let id = s
            .insert_memory("p", "d", None, "global", "", 100, &e)
            .await
            .unwrap();

        s.delete_memory(id).await.unwrap();

        let rows = s.list_memories(&["global"], 10).await.unwrap();
        assert!(rows.is_empty());
        let hits = s.vector_search_memories(&["global"], &e, 5).await.unwrap();
        assert!(hits.is_empty());
    }

    #[tokio::test]
    async fn decision_row_round_trips_applied_memory_id() {
        let (s, _g) = fresh();
        let session = SessionId::new();
        s.save_session(session, 1).await.unwrap();

        // With Some(memory_id).
        let _row_id = s
            .save_operator_decision(
                session,
                10,
                Some("cmd".to_string()),
                "out".to_string(),
                "reply".to_string(),
                Some("y\n".to_string()),
                Some("because".to_string()),
                true,
                0.001,
                None,
                None,
                None,
                None,
                Some(42),
            )
            .await
            .unwrap();

        // And with None.
        s.save_operator_decision(
            session,
            20,
            Some("cmd2".to_string()),
            "out2".to_string(),
            "reply".to_string(),
            None,
            None,
            false,
            0.0,
            None,
            None,
            None,
            None,
            None,
        )
        .await
        .unwrap();

        let rows = s.list_operator_decisions(10).await.unwrap();
        assert_eq!(rows.len(), 2);
        // ORDER BY id DESC — newest first.
        assert_eq!(rows[0].applied_memory_id, None);
        assert_eq!(rows[1].applied_memory_id, Some(42));
    }

    #[test]
    fn seen_specs_table_exists_and_supports_upsert() {
        use rusqlite::Connection;
        ensure_sqlite_vec_loaded();
        let conn = Connection::open_in_memory().expect("open");
        conn.execute_batch(super::SCHEMA).expect("apply schema");

        conn.execute(
            "INSERT INTO seen_specs (repo_root, path, first_seen_at) VALUES (?1, ?2, ?3)",
            rusqlite::params!["/tmp/repo", "docs/specs/3.1-foo.md", 1234_i64],
        )
        .expect("insert");

        let inserted: usize = conn
            .execute(
                "INSERT OR IGNORE INTO seen_specs (repo_root, path, first_seen_at) VALUES (?1, ?2, ?3)",
                rusqlite::params!["/tmp/repo", "docs/specs/3.1-foo.md", 9999_i64],
            )
            .expect("upsert");
        assert_eq!(inserted, 0, "should ignore duplicate");

        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM seen_specs", [], |r| r.get(0))
            .expect("count");
        assert_eq!(count, 1);
    }

    use crate::operator_mind::{OperatorMind, TurnAction, TurnRecord};

    #[tokio::test]
    async fn mind_save_load_roundtrip() {
        let (s, _g) = fresh();
        let mut m = OperatorMind::default();
        m.goal = "ship 3.20".into();
        m.belief = "executor mid task".into();
        m.record_turn(TurnRecord {
            turn: 3,
            at: chrono::Utc::now(),
            saw: "tail".into(),
            thought: "thinking".into(),
            action: TurnAction::Reply { text: "yes".into() },
            executed: true,
        });
        s.mind_save("sess-1", &m).await.unwrap();
        let loaded = s.mind_load("sess-1").await.unwrap().unwrap();
        assert_eq!(loaded.goal, "ship 3.20");
        assert_eq!(loaded.belief, "executor mid task");
        assert_eq!(loaded.recent.len(), 1);
        assert_eq!(loaded.turn_count, 3);
    }

    #[tokio::test]
    async fn mind_load_returns_none_for_missing_session() {
        let (s, _g) = fresh();
        let loaded = s.mind_load("nope").await.unwrap();
        assert!(loaded.is_none());
    }

    #[tokio::test]
    async fn mind_load_corrupt_json_deletes_and_returns_none() {
        let (s, _g) = fresh();
        // Direct insert of garbage JSON via the inner connection.
        {
            let conn = s.inner.lock().await;
            conn.execute(
                "INSERT INTO operator_mind (session_id, json, turn_count, updated_at)
                 VALUES ('corrupt', 'not json', 0, '2026-05-06T00:00:00Z')",
                [],
            )
            .unwrap();
        }
        let loaded = s.mind_load("corrupt").await.unwrap();
        assert!(loaded.is_none());
        // Verify the row was deleted (preview returns None).
        let preview = s.mind_preview("corrupt").await.unwrap();
        assert!(preview.is_none());
    }

    #[tokio::test]
    async fn mind_save_overwrites() {
        let (s, _g) = fresh();
        let mut m = OperatorMind::default();
        m.goal = "first".into();
        s.mind_save("sess-2", &m).await.unwrap();
        m.goal = "second".into();
        s.mind_save("sess-2", &m).await.unwrap();
        assert_eq!(s.mind_load("sess-2").await.unwrap().unwrap().goal, "second");
    }

    #[tokio::test]
    async fn mind_delete_removes_row() {
        let (s, _g) = fresh();
        let m = OperatorMind::default();
        s.mind_save("sess-3", &m).await.unwrap();
        s.mind_delete("sess-3").await.unwrap();
        assert!(s.mind_load("sess-3").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mind_gc_drops_orphans() {
        let (s, _g) = fresh();
        // Insert mind without a corresponding session row.
        let m = OperatorMind::default();
        s.mind_save("orphan-1", &m).await.unwrap();
        let n = s.mind_gc_orphans().await.unwrap();
        assert_eq!(n, 1);
        assert!(s.mind_load("orphan-1").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn mind_preview_returns_header_fields() {
        let (s, _g) = fresh();
        let mut m = OperatorMind::default();
        m.goal = "g".into();
        m.belief = "b".into();
        m.turn_count = 7;
        s.mind_save("sess-4", &m).await.unwrap();
        let p = s.mind_preview("sess-4").await.unwrap().unwrap();
        assert_eq!(p.turn_count, 7);
        assert_eq!(p.goal, "g");
        assert_eq!(p.belief, "b");
    }

    #[tokio::test]
    async fn operator_voice_round_trips_and_defaults_to_terse() {
        use crate::operator_registry::{Operator, OperatorId, VoiceTone};
        use ulid::Ulid;

        let (s, _g) = fresh();

        // Insert a Warm op explicitly.
        let warm = Operator {
            id: OperatorId(Ulid::new()),
            name: "warm-op".into(),
            emoji: "🤖".into(),
            color: "#6B7280".into(),
            tags: vec![],
            persona: "p".into(),
            escalate_threshold: 0.6,
            model: "m".into(),
            hard_constraints: String::new(),
            is_default: false,
            created_at_unix_ms: 1,
            updated_at_unix_ms: 1,
            xp: 0,
            voice: VoiceTone::Warm,
        };
        let warm_id = warm.id;
        s.operator_insert(warm).await.unwrap();

        // Insert a default-voice op (Terse).
        let terse = Operator {
            id: OperatorId(Ulid::new()),
            name: "terse-op".into(),
            emoji: "🤖".into(),
            color: "#6B7280".into(),
            tags: vec![],
            persona: "p".into(),
            escalate_threshold: 0.6,
            model: "m".into(),
            hard_constraints: String::new(),
            is_default: false,
            created_at_unix_ms: 2,
            updated_at_unix_ms: 2,
            xp: 0,
            voice: VoiceTone::Terse,
        };
        let terse_id = terse.id;
        s.operator_insert(terse).await.unwrap();

        // Round-trip via list.
        let list = s.operator_list().await.unwrap();
        let got_warm = list.iter().find(|o| o.id == warm_id).unwrap();
        let got_terse = list.iter().find(|o| o.id == terse_id).unwrap();
        assert!(matches!(got_warm.voice, VoiceTone::Warm));
        assert!(matches!(got_terse.voice, VoiceTone::Terse));

        // Update to Formal and verify persisted.
        let mut updated = got_warm.clone();
        updated.voice = VoiceTone::Formal;
        s.operator_update(updated).await.unwrap();
        let list2 = s.operator_list().await.unwrap();
        let after = list2.iter().find(|o| o.id == warm_id).unwrap();
        assert!(matches!(after.voice, VoiceTone::Formal));

        // Raw-insert without voice column to simulate a pre-migration
        // row, then verify the mapper falls back to Terse.
        {
            let c = s.inner.lock().await;
            c.execute(
                "INSERT INTO operators (id, name, emoji, color, tags_json, persona, \
                 escalate_threshold, model, hard_constraints, is_default, \
                 created_at_unix_ms, updated_at_unix_ms) \
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    Ulid::new().to_string(),
                    "legacy-op",
                    "🤖",
                    "#000",
                    "[]",
                    "p",
                    0.6_f64,
                    "m",
                    "",
                    0_i64,
                    3_i64,
                    3_i64,
                ],
            )
            .unwrap();
        }
        let list3 = s.operator_list().await.unwrap();
        let legacy = list3.iter().find(|o| o.name == "legacy-op").unwrap();
        assert!(matches!(legacy.voice, VoiceTone::Terse));
    }
}

#[cfg(test)]
mod task_card_storage_tests {
    use super::*;
    use crate::operator_registry::OperatorId;
    use crate::teammate::{MessageContent, MessageId, Role, TaskArchetype, TaskMessage, TaskScope};
    use crate::teammate::types::{ProposeTask, TaskDraft};
    use rusqlite::OptionalExtension as _;
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
                    executor: None,
                },
                rationale: "user asked for an audit".into(),
            }),
            created_at_unix_ms: 1_700_000_000_000,
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
            sentiment: None,
        }
    }

    #[tokio::test]
    async fn mark_message_confirmed_sets_timestamp_and_returns_msg() {
        let s = tmp_storage();
        let op = sample_op_id();
        // operators FK: insert a minimal operator row so the FK passes.
        s.operator_insert(crate::operator_registry::Operator {
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
