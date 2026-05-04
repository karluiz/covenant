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
    fn open_on_disk_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("f.sqlite");
        {
            let _ = Memory::open(&path).unwrap();
        }
        let _ = Memory::open(&path).unwrap();
    }
}
