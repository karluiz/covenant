//! OpenCode transcript vitals — the per-tab analogue of `exec_vitals`,
//! but for OpenCode. Unlike Claude Code (per-cwd JSONL files), OpenCode
//! stores everything in a single SQLite DB at
//! `~/.local/share/opencode/opencode.db`. We map a tab to its session by
//! `session.directory == cwd`, then poll the latest assistant message's
//! token usage and feed the same `VitalsHandle` the rest of Covenant uses
//! (so the status-bar context-fill pill / token vitals reflect OpenCode).
//!
//! Scope (v1):
//!   * Picks the newest session (`time_updated`) whose `directory` matches
//!     the tab's cwd. Concurrent OpenCode sessions in the same dir collide
//!     on "newest" — same caveat exec_vitals has for Claude.
//!   * Seeds the watermark to the latest existing message on attach (NO
//!     replay — matches exec_vitals tailing from EOF), then feeds only
//!     assistant messages created after attach. Context fill therefore
//!     appears on the next turn, not retroactively.
//!   * Latency isn't recoverable from a single row, so it's reported as a
//!     nominal floor — the context-fill + token signals are the point here.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use karl_agent::TokenUsage;
use karl_session::SessionId;
use rusqlite::{Connection, OpenFlags};
use serde::Deserialize;
use tokio::sync::Mutex;
use tokio::task::JoinHandle;

use crate::vitals::VitalsHandle;

const POLL_INTERVAL: Duration = Duration::from_millis(1500);
/// Nominal latency floor reported for OpenCode turns (we can't derive a
/// real user→assistant delta from one row).
const NOMINAL_LATENCY_MS: u32 = 50;

/// Shape of the JSON in OpenCode's `message.data` column. Mirrors
/// `crates/score/src/external/opencode.rs::Msg` — kept local to avoid a
/// score→app dependency for two small structs.
#[derive(Deserialize)]
struct Msg {
    role: String,
    #[serde(rename = "modelID")]
    model_id: Option<String>,
    tokens: Option<Tokens>,
}
#[derive(Deserialize)]
struct Tokens {
    #[serde(default)]
    input: u64,
    #[serde(default)]
    output: u64,
    #[serde(default)]
    cache: Cache,
}
#[derive(Deserialize, Default)]
struct Cache {
    #[serde(default)]
    read: u64,
    #[serde(default)]
    write: u64,
}

#[derive(Clone)]
pub struct OpenCodeVitals {
    inner: Arc<Inner>,
}

struct Inner {
    vitals: VitalsHandle,
    tasks: Mutex<HashMap<SessionId, JoinHandle<()>>>,
}

impl OpenCodeVitals {
    pub fn new(vitals: VitalsHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                vitals,
                tasks: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Begin polling OpenCode's DB for `session`'s tab (identified by
    /// `cwd`). Replaces any existing poller for this session — covers a
    /// mid-session `cd`.
    pub async fn attach(&self, session: SessionId, cwd: PathBuf) {
        let Some(db) = opencode_db_path() else {
            return;
        };
        let vitals = self.inner.vitals.clone();
        let handle = tokio::spawn(async move {
            poll_loop(session, db, cwd, vitals).await;
        });
        if let Some(prev) = self.inner.tasks.lock().await.insert(session, handle) {
            prev.abort();
        }
    }

    pub async fn detach(&self, session: SessionId) {
        if let Some(prev) = self.inner.tasks.lock().await.remove(&session) {
            prev.abort();
        }
    }
}

/// `~/.local/share/opencode/opencode.db` (honours `XDG_DATA_HOME`).
fn opencode_db_path() -> Option<PathBuf> {
    let base = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".local").join("share")))?;
    let db = base.join("opencode").join("opencode.db");
    db.exists().then_some(db)
}

async fn poll_loop(session: SessionId, db: PathBuf, cwd: PathBuf, vitals: VitalsHandle) {
    let cwd_s = cwd.to_string_lossy().to_string();
    // Seed the watermark to the latest existing message so we don't replay
    // history into the throughput sparkline. `None` until we've taken the
    // first reading (the session may not exist yet).
    let mut watermark: Option<i64> = None;
    let mut seeded = false;

    let mut interval = tokio::time::interval(POLL_INTERVAL);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        interval.tick().await;
        let cwd_s = cwd_s.clone();
        // SQLite work is blocking — keep it off the async worker.
        let db = db.clone();
        let res = tokio::task::spawn_blocking(move || read_new(&db, &cwd_s, watermark))
            .await;
        let rows = match res {
            Ok(Ok(rows)) => rows,
            _ => continue,
        };
        for row in rows {
            watermark = Some(watermark.map_or(row.time_created, |w| w.max(row.time_created)));
            // First reading after attach establishes the baseline without
            // feeding (no retroactive turns into the sparkline).
            if !seeded {
                continue;
            }
            let ctx = row
                .usage
                .input_tokens
                .saturating_add(row.usage.cache_creation_input_tokens)
                .saturating_add(row.usage.cache_read_input_tokens);
            vitals.record_executor_context(session, row.model.clone(), ctx);
            vitals.record_complete(session, row.model, row.usage, NOMINAL_LATENCY_MS);
        }
        seeded = true;
    }
}

struct Reading {
    time_created: i64,
    model: String,
    usage: TokenUsage,
}

/// Read assistant messages for the cwd's newest session created after
/// `watermark`. When `watermark` is `None` (first poll) we still read the
/// most recent message so the caller can seed the baseline.
fn read_new(
    db: &PathBuf,
    cwd: &str,
    watermark: Option<i64>,
) -> Result<Vec<Reading>, rusqlite::Error> {
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;

    // Newest session for this directory. Fall back to its `model` column
    // when a message doesn't carry its own modelID.
    let session_row = conn
        .query_row(
            "SELECT id, COALESCE(model, '') FROM session
             WHERE directory = ?1 ORDER BY time_updated DESC LIMIT 1",
            [cwd],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .ok();
    let Some((session_id, session_model)) = session_row else {
        return Ok(vec![]);
    };

    // On the seeding poll we only need the single latest message; after
    // that, every message newer than the watermark.
    let (sql, since) = match watermark {
        None => (
            "SELECT time_created, data FROM message
             WHERE session_id = ?1 AND time_created > ?2
             ORDER BY time_created DESC LIMIT 1"
                .to_string(),
            i64::MIN,
        ),
        Some(w) => (
            "SELECT time_created, data FROM message
             WHERE session_id = ?1 AND time_created > ?2
             ORDER BY time_created ASC"
                .to_string(),
            w,
        ),
    };

    let mut stmt = conn.prepare(&sql)?;
    let mapped = stmt.query_map(rusqlite::params![session_id, since], |r| {
        Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
    })?;

    let mut out = Vec::new();
    for row in mapped {
        let (time_created, data) = row?;
        let Ok(msg) = serde_json::from_str::<Msg>(&data) else {
            continue;
        };
        if msg.role != "assistant" {
            continue;
        }
        let Some(tokens) = msg.tokens else { continue };
        let usage = TokenUsage {
            input_tokens: tokens.input.min(u32::MAX as u64) as u32,
            output_tokens: tokens.output.min(u32::MAX as u64) as u32,
            cache_creation_input_tokens: tokens.cache.write.min(u32::MAX as u64) as u32,
            cache_read_input_tokens: tokens.cache.read.min(u32::MAX as u64) as u32,
        };
        if usage.input_tokens == 0
            && usage.output_tokens == 0
            && usage.cache_creation_input_tokens == 0
            && usage.cache_read_input_tokens == 0
        {
            continue;
        }
        let model = msg
            .model_id
            .filter(|m| !m.is_empty())
            .or_else(|| (!session_model.is_empty()).then(|| session_model.clone()))
            .unwrap_or_else(|| "opencode".to_string());
        out.push(Reading {
            time_created,
            model,
            usage,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn seed_db() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let db = dir.path().join("opencode.db");
        let conn = Connection::open(&db).unwrap();
        conn.execute_batch(
            "CREATE TABLE session (id TEXT, directory TEXT, model TEXT, time_updated INTEGER);
             CREATE TABLE message (session_id TEXT, time_created INTEGER, data TEXT);
             INSERT INTO session VALUES ('s1', '/Users/k/proj', 'claude-opus-4-8', 100);
             INSERT INTO message VALUES ('s1', 10, '{\"role\":\"assistant\",\"tokens\":{\"input\":100,\"output\":20,\"cache\":{\"read\":5000,\"write\":0}}}');",
        )
        .unwrap();
        (dir, db)
    }

    #[test]
    fn reads_latest_for_matching_cwd() {
        let (_dir, db) = seed_db();
        // Seeding read (watermark None) returns the latest message.
        let rows = read_new(&db, "/Users/k/proj", None).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].usage.input_tokens, 100);
        assert_eq!(rows[0].usage.cache_read_input_tokens, 5000);
        assert_eq!(rows[0].model, "claude-opus-4-8");
    }

    #[test]
    fn unknown_cwd_returns_empty() {
        let (_dir, db) = seed_db();
        assert!(read_new(&db, "/nope", None).unwrap().is_empty());
    }

    #[test]
    fn watermark_filters_already_seen() {
        let (_dir, db) = seed_db();
        // Watermark past the only message → nothing new.
        assert!(read_new(&db, "/Users/k/proj", Some(10)).unwrap().is_empty());
        // Watermark before it → returns it.
        assert_eq!(read_new(&db, "/Users/k/proj", Some(5)).unwrap().len(), 1);
    }

    #[test]
    fn message_model_overrides_session_model() {
        let (_dir, db) = seed_db();
        let conn = Connection::open(&db).unwrap();
        conn.execute(
            "INSERT INTO message VALUES ('s1', 20, '{\"role\":\"assistant\",\"modelID\":\"gpt-5.5\",\"tokens\":{\"input\":7,\"output\":1,\"cache\":{\"read\":0,\"write\":0}}}')",
            [],
        )
        .unwrap();
        let rows = read_new(&db, "/Users/k/proj", Some(15)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].model, "gpt-5.5");
    }
}
