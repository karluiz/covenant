use crate::error::Result;
use rusqlite::Connection;
use std::path::Path;

const MIGRATION: &str = include_str!("../migrations/001_init.sql");

pub struct Memory {
    conn: Connection,
}

impl Memory {
    pub fn open<P: AsRef<Path>>(path: P) -> Result<Self> {
        if let Some(parent) = path.as_ref().parent() {
            std::fs::create_dir_all(parent).ok();
        }
        let conn = Connection::open(path)?;
        conn.execute_batch(MIGRATION)?;
        Ok(Self { conn })
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory()?;
        conn.execute_batch(MIGRATION)?;
        Ok(Self { conn })
    }
}

#[derive(Debug, Clone)]
pub struct EventRow {
    pub id: i64,
    pub ts_ms: i64,
    pub kind: String,
    pub session_id: String,
    pub payload_json: String,
}

impl Memory {
    pub fn append_event(&self, ts_ms: i64, kind: &str, session_id: &str,
                        payload_json: &str) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO familiar_events(ts_ms, kind, session_id, payload_json)
             VALUES (?1,?2,?3,?4)",
            (ts_ms, kind, session_id, payload_json),
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn events_since(&self, after_id: i64) -> Result<Vec<EventRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ts_ms, kind, session_id, payload_json
             FROM familiar_events WHERE id > ?1 ORDER BY id ASC")?;
        let rows = stmt.query_map([after_id], |r| Ok(EventRow {
            id: r.get(0)?, ts_ms: r.get(1)?, kind: r.get(2)?,
            session_id: r.get(3)?, payload_json: r.get(4)?,
        }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }

    pub fn last_event_id(&self) -> Result<i64> {
        let id: i64 = self.conn
            .query_row("SELECT COALESCE(MAX(id),0) FROM familiar_events", [], |r| r.get(0))?;
        Ok(id)
    }
}

#[derive(Debug, Clone)]
pub struct SummaryRow {
    pub id: i64,
    pub ts_ms: i64,
    pub summary: String,
    pub last_event_id: i64,
}

impl Memory {
    pub fn write_summary(&self, ts_ms: i64, summary: &str, last_event_id: i64,
                         tokens_in: i64, tokens_out: i64) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO familiar_summaries(ts_ms, summary, last_event_id, tokens_in, tokens_out)
             VALUES (?1,?2,?3,?4,?5)",
            (ts_ms, summary, last_event_id, tokens_in, tokens_out),
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn latest_summary(&self) -> Result<Option<SummaryRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, ts_ms, summary, last_event_id
             FROM familiar_summaries ORDER BY id DESC LIMIT 1")?;
        let mut rows = stmt.query_map([], |r| Ok(SummaryRow {
            id: r.get(0)?, ts_ms: r.get(1)?, summary: r.get(2)?, last_event_id: r.get(3)?,
        }))?;
        Ok(rows.next().transpose()?)
    }
}

#[derive(Debug, Clone)]
pub struct MissionRow {
    pub mission_id: String,
    pub started_ms: i64,
    pub finished_ms: Option<i64>,
    pub objective: String,
    pub digest: String,
}

impl Memory {
    pub fn start_mission(&self, mission_id: &str, started_ms: i64,
                         objective: &str) -> Result<i64> {
        self.conn.execute(
            "INSERT INTO familiar_missions(mission_id, started_ms, objective)
             VALUES (?1,?2,?3)",
            (mission_id, started_ms, objective),
        )?;
        Ok(self.conn.last_insert_rowid())
    }

    pub fn finish_mission(&self, mission_id: &str, finished_ms: i64,
                          digest: &str) -> Result<()> {
        self.conn.execute(
            "UPDATE familiar_missions SET finished_ms=?1, digest=?2 WHERE mission_id=?3",
            (finished_ms, digest, mission_id),
        )?;
        Ok(())
    }

    pub fn mission(&self, mission_id: &str) -> Result<Option<MissionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT mission_id, started_ms, finished_ms, objective, digest
             FROM familiar_missions WHERE mission_id=?1")?;
        let mut rows = stmt.query_map([mission_id], |r| Ok(MissionRow {
            mission_id: r.get(0)?, started_ms: r.get(1)?,
            finished_ms: r.get(2)?, objective: r.get(3)?, digest: r.get(4)?,
        }))?;
        Ok(rows.next().transpose()?)
    }

    pub fn recent_missions(&self, limit: i64) -> Result<Vec<MissionRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT mission_id, started_ms, finished_ms, objective, digest
             FROM familiar_missions ORDER BY started_ms DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| Ok(MissionRow {
            mission_id: r.get(0)?, started_ms: r.get(1)?,
            finished_ms: r.get(2)?, objective: r.get(3)?, digest: r.get(4)?,
        }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[derive(Debug, Clone)]
pub struct ChatRow {
    pub ts_ms: i64,
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone)]
pub struct DirectiveRow {
    pub id: String,
    pub proposed_ms: i64,
    pub decided_ms: Option<i64>,
    pub state: String,
    pub kind: String,
    pub payload: String,
    pub rationale: String,
    pub block_reason: Option<String>,
}

impl Memory {
    pub fn append_chat(&self, ts_ms: i64, role: &str, content: &str) -> Result<()> {
        self.conn.execute(
            "INSERT INTO familiar_chat(ts_ms, role, content) VALUES (?1,?2,?3)",
            (ts_ms, role, content),
        )?;
        Ok(())
    }

    pub fn chat_history(&self, limit: i64) -> Result<Vec<ChatRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT ts_ms, role, content FROM familiar_chat ORDER BY id DESC LIMIT ?1")?;
        let rows = stmt.query_map([limit], |r| Ok(ChatRow {
            ts_ms: r.get(0)?, role: r.get(1)?, content: r.get(2)?,
        }))?;
        let mut v: Vec<_> = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        v.reverse();
        Ok(v)
    }

    pub fn log_directive(&self, id: &str, proposed_ms: i64, state: &str,
                         kind: &str, payload: &str, rationale: &str,
                         block_reason: Option<&str>) -> Result<()> {
        self.conn.execute(
            "INSERT INTO familiar_directives(id, proposed_ms, state, kind, payload, rationale, block_reason)
             VALUES (?1,?2,?3,?4,?5,?6,?7)",
            (id, proposed_ms, state, kind, payload, rationale, block_reason),
        )?;
        Ok(())
    }

    pub fn update_directive_state(&self, id: &str, decided_ms: i64,
                                   state: &str, block_reason: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE familiar_directives SET decided_ms=?1, state=?2, block_reason=?3 WHERE id=?4",
            (decided_ms, state, block_reason, id),
        )?;
        Ok(())
    }

    pub fn directive(&self, id: &str) -> Result<Option<DirectiveRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, proposed_ms, decided_ms, state, kind, payload, rationale, block_reason
             FROM familiar_directives WHERE id=?1")?;
        let mut rows = stmt.query_map([id], |r| Ok(DirectiveRow {
            id: r.get(0)?, proposed_ms: r.get(1)?, decided_ms: r.get(2)?,
            state: r.get(3)?, kind: r.get(4)?, payload: r.get(5)?,
            rationale: r.get(6)?, block_reason: r.get(7)?,
        }))?;
        Ok(rows.next().transpose()?)
    }

    pub fn directives_since(&self, since_ms: i64) -> Result<Vec<DirectiveRow>> {
        let mut stmt = self.conn.prepare(
            "SELECT id, proposed_ms, decided_ms, state, kind, payload, rationale, block_reason
             FROM familiar_directives WHERE proposed_ms >= ?1 ORDER BY proposed_ms DESC")?;
        let rows = stmt.query_map([since_ms], |r| Ok(DirectiveRow {
            id: r.get(0)?, proposed_ms: r.get(1)?, decided_ms: r.get(2)?,
            state: r.get(3)?, kind: r.get(4)?, payload: r.get(5)?,
            rationale: r.get(6)?, block_reason: r.get(7)?,
        }))?;
        Ok(rows.collect::<rusqlite::Result<Vec<_>>>()?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_in_memory_creates_all_tables() {
        let m = Memory::open_in_memory().unwrap();
        let names: Vec<String> = m.conn
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .unwrap()
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        for expected in ["familiar_chat","familiar_costs","familiar_directives",
                         "familiar_events","familiar_meta","familiar_missions",
                         "familiar_summaries"] {
            assert!(names.contains(&expected.to_string()), "missing {expected}");
        }
    }

    #[test]
    fn append_and_read_events() {
        let m = Memory::open_in_memory().unwrap();
        m.append_event(1_700_000_000_000, "BlockFinished", "sess-A",
                       r#"{"exit":0}"#).unwrap();
        m.append_event(1_700_000_001_000, "CwdChanged", "sess-A",
                       r#"{"cwd":"/tmp"}"#).unwrap();
        let events = m.events_since(0).unwrap();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].kind, "BlockFinished");
        assert_eq!(events[1].session_id, "sess-A");
    }

    #[test]
    fn events_since_filters_by_id() {
        let m = Memory::open_in_memory().unwrap();
        for i in 0..5 {
            m.append_event(1000 + i, "X", "S", "{}").unwrap();
        }
        let from_3 = m.events_since(3).unwrap();
        assert_eq!(from_3.len(), 2);
    }

    #[test]
    fn chat_round_trip() {
        let m = Memory::open_in_memory().unwrap();
        m.append_chat(100, "user", "hi").unwrap();
        m.append_chat(101, "assistant", "hello").unwrap();
        let hist = m.chat_history(10).unwrap();
        assert_eq!(hist.len(), 2);
        assert_eq!(hist[0].role, "user");
        assert_eq!(hist[1].content, "hello");
    }

    #[test]
    fn directive_log_round_trip() {
        let m = Memory::open_in_memory().unwrap();
        m.log_directive("01H...", 100, "proposed", "Stop", "stop X", "rationale", None).unwrap();
        m.update_directive_state("01H...", 200, "approved", None).unwrap();
        let row = m.directive("01H...").unwrap().unwrap();
        assert_eq!(row.state, "approved");
        assert_eq!(row.decided_ms, Some(200));
    }

    #[test]
    fn mission_lifecycle() {
        let m = Memory::open_in_memory().unwrap();
        let id = m.start_mission("mission-1", 1000, "ship feature X").unwrap();
        assert!(id > 0);
        m.finish_mission("mission-1", 2000, "shipped: X merged in PR 42").unwrap();
        let row = m.mission("mission-1").unwrap().unwrap();
        assert_eq!(row.objective, "ship feature X");
        assert!(row.digest.starts_with("shipped"));
        assert_eq!(row.finished_ms, Some(2000));
    }

    #[test]
    fn write_and_read_latest_summary() {
        let m = Memory::open_in_memory().unwrap();
        assert!(m.latest_summary().unwrap().is_none());
        m.write_summary(1_700_000_000_000, "running tests", 42, 100, 50).unwrap();
        m.write_summary(1_700_000_500_000, "tests green", 99, 110, 55).unwrap();
        let s = m.latest_summary().unwrap().unwrap();
        assert_eq!(s.summary, "tests green");
        assert_eq!(s.last_event_id, 99);
    }

    #[test]
    fn open_on_disk_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.sqlite");
        {
            let _ = Memory::open(&path).unwrap();
        }
        let _ = Memory::open(&path).unwrap();
    }
}
