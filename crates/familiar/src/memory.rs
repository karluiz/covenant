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
    fn open_on_disk_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.sqlite");
        {
            let _ = Memory::open(&path).unwrap();
        }
        let _ = Memory::open(&path).unwrap();
    }
}
