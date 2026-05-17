use crate::types::{day_from_ms_local, DailyCell, EventKind, Summary};
use rusqlite::{params, Connection};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ScoreError {
    #[error("sqlite: {0}")]
    Sql(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, ScoreError>;

pub struct ScoreStore {
    conn: Arc<Mutex<Connection>>,
    #[allow(dead_code)]
    path: PathBuf,
}

impl ScoreStore {
    pub fn open(data_dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(data_dir)?;
        let path = data_dir.join("score.sqlite");
        let conn = Connection::open(&path)?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS score_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp_ms INTEGER NOT NULL,
                kind TEXT NOT NULL,
                executor TEXT NOT NULL,
                day TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_events_day ON score_events(day);
            CREATE INDEX IF NOT EXISTS idx_events_kind ON score_events(kind);
            CREATE TABLE IF NOT EXISTS user_session (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                github_id INTEGER NOT NULL,
                login TEXT NOT NULL,
                avatar_url TEXT NOT NULL,
                connected_at_ms INTEGER NOT NULL
            );",
        )?;
        Ok(Self { conn: Arc::new(Mutex::new(conn)), path })
    }

    pub fn connection(&self) -> Arc<Mutex<Connection>> {
        self.conn.clone()
    }

    pub fn append(&self, timestamp_ms: i64, kind: EventKind, executor: &str) -> Result<()> {
        let day = day_from_ms_local(timestamp_ms);
        let kind_s = match kind { EventKind::Prompt => "prompt", EventKind::Commit => "commit" };
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO score_events(timestamp_ms, kind, executor, day) VALUES (?1, ?2, ?3, ?4)",
            params![timestamp_ms, kind_s, executor, day],
        )?;
        Ok(())
    }

    pub fn heatmap_all(&self) -> Result<Vec<DailyCell>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(
            "SELECT day,
                    SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END) AS p,
                    SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END) AS k
             FROM score_events
             GROUP BY day
             ORDER BY day ASC",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(DailyCell {
                day: r.get(0)?,
                prompts: r.get::<_, i64>(1)? as u32,
                commits: r.get::<_, i64>(2)? as u32,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn summary(&self) -> Result<Summary> {
        let cells = self.heatmap_all()?;
        let today = chrono::Local::now().format("%Y-%m-%d").to_string();
        let mut total_p: u64 = 0;
        let mut total_c: u64 = 0;
        let mut today_p = 0u32;
        let mut today_c = 0u32;
        for cell in &cells {
            total_p += cell.prompts as u64;
            total_c += cell.commits as u64;
            if cell.day == today {
                today_p = cell.prompts;
                today_c = cell.commits;
            }
        }
        let (current_streak, longest_streak) = compute_streaks(&cells, &today);
        Ok(Summary { total_prompts: total_p, total_commits: total_c,
                     today_prompts: today_p, today_commits: today_c,
                     current_streak, longest_streak })
    }
}

fn compute_streaks(cells: &[DailyCell], today: &str) -> (u32, u32) {
    use chrono::NaiveDate;
    let parse = |s: &str| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
    let mut longest = 0u32;
    let mut run = 0u32;
    let mut prev: Option<NaiveDate> = None;
    let mut last_active: Option<NaiveDate> = None;
    for cell in cells {
        if cell.prompts == 0 { continue; }
        let d = match parse(&cell.day) { Some(d) => d, None => continue };
        match prev {
            Some(p) if (d - p).num_days() == 1 => run += 1,
            _ => run = 1,
        }
        longest = longest.max(run);
        prev = Some(d);
        last_active = Some(d);
    }
    let today_d = parse(today);
    let current = match (last_active, today_d) {
        (Some(la), Some(td)) => {
            let gap = (td - la).num_days();
            if gap <= 1 { run } else { 0 }
        }
        _ => 0,
    };
    (current, longest)
}
