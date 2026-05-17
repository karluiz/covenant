use crate::types::{day_from_ms_local, Context, DailyCell, EventKind, Summary};
use rusqlite::{params, Connection, OptionalExtension};
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
            );
            CREATE TABLE IF NOT EXISTS sync_cursor (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                last_pushed_event_id INTEGER NOT NULL DEFAULT 0,
                last_server_cursor_ms INTEGER NOT NULL DEFAULT 0,
                last_synced_at_ms INTEGER NOT NULL DEFAULT 0
            );",
        )?;
        // v2: context columns (idempotent via PRAGMA user_version)
        let v: i64 = conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap_or(0);
        if v < 2 {
            conn.execute_batch(
                "ALTER TABLE score_events ADD COLUMN repo TEXT;
                 ALTER TABLE score_events ADD COLUMN branch TEXT;
                 ALTER TABLE score_events ADD COLUMN group_name TEXT;
                 CREATE INDEX IF NOT EXISTS idx_events_repo   ON score_events(repo);
                 CREATE INDEX IF NOT EXISTS idx_events_branch ON score_events(repo, branch);
                 CREATE INDEX IF NOT EXISTS idx_events_group  ON score_events(group_name);
                 PRAGMA user_version = 2;"
            )?;
        }
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

    pub fn append_with_context(
        &self, timestamp_ms: i64, kind: EventKind, executor: &str, ctx: &Context,
    ) -> Result<()> {
        let day = day_from_ms_local(timestamp_ms);
        let kind_s = match kind { EventKind::Prompt => "prompt", EventKind::Commit => "commit" };
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO score_events(timestamp_ms, kind, executor, day, repo, branch, group_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![timestamp_ms, kind_s, executor, day, ctx.repo, ctx.branch, ctx.group_name],
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

    pub fn unsynced_events(
        &self, after_id: i64, limit: usize,
    ) -> Result<Vec<(i64, i64, EventKind, String, Option<String>, Option<String>, Option<String>)>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(
            "SELECT id, timestamp_ms, kind, executor, repo, branch, group_name FROM score_events
             WHERE id > ?1 ORDER BY id ASC LIMIT ?2"
        )?;
        let rows = stmt.query_map(params![after_id, limit as i64], |r| {
            let kind: String = r.get(2)?;
            let kind = if kind == "prompt" { EventKind::Prompt } else { EventKind::Commit };
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                kind,
                r.get::<_, String>(3)?,
                r.get::<_, Option<String>>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    /// Returns `(last_pushed_event_id, last_server_cursor_ms, last_synced_at_ms)`.
    pub fn get_sync_cursor(&self) -> Result<(i64, i64, i64)> {
        let c = self.conn.lock().unwrap();
        let row = c.query_row(
            "SELECT last_pushed_event_id, last_server_cursor_ms, last_synced_at_ms FROM sync_cursor WHERE id = 1",
            [],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?))
        ).optional()?;
        Ok(row.unwrap_or((0, 0, 0)))
    }

    pub fn set_sync_cursor(&self, last_pushed_event_id: i64, server_cursor_ms: i64, synced_at_ms: i64) -> Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO sync_cursor(id, last_pushed_event_id, last_server_cursor_ms, last_synced_at_ms)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                last_pushed_event_id = excluded.last_pushed_event_id,
                last_server_cursor_ms = excluded.last_server_cursor_ms,
                last_synced_at_ms = excluded.last_synced_at_ms",
            params![last_pushed_event_id, server_cursor_ms, synced_at_ms],
        )?;
        Ok(())
    }

    pub fn heatmap_filtered(&self, f: &crate::ScoreFilter) -> Result<Vec<DailyCell>> {
        let w = crate::filter::build_where(f);
        let sql = format!(
            "SELECT day,
                    SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END) AS p,
                    SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END) AS k
             FROM score_events
             WHERE {}
             GROUP BY day
             ORDER BY day ASC",
            w.sql
        );
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| Ok(DailyCell {
            day: r.get(0)?,
            prompts: r.get::<_, i64>(1)? as u32,
            commits: r.get::<_, i64>(2)? as u32,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn summary_filtered(&self, f: &crate::ScoreFilter) -> Result<Summary> {
        let cells = self.heatmap_filtered(f)?;
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
        Ok(Summary {
            total_prompts: total_p,
            total_commits: total_c,
            today_prompts: today_p,
            today_commits: today_c,
            current_streak,
            longest_streak,
        })
    }

    pub fn breakdown_repos(&self, f: &crate::ScoreFilter) -> Result<Vec<crate::RepoCell>> {
        let w = crate::filter::build_where(f);
        let sql = format!(
            "SELECT repo,
                    SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END)
             FROM score_events
             WHERE repo IS NOT NULL AND {}
             GROUP BY repo
             ORDER BY 2 DESC",
            w.sql
        );
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| Ok(crate::RepoCell {
            repo: r.get(0)?,
            prompts: r.get::<_, i64>(1)? as u32,
            commits: r.get::<_, i64>(2)? as u32,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn breakdown_branches(&self, repo: &str, f: &crate::ScoreFilter) -> Result<Vec<crate::BranchCell>> {
        let w = crate::filter::build_where(f);
        let sql = format!(
            "SELECT branch,
                    SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END)
             FROM score_events
             WHERE repo = ? AND branch IS NOT NULL AND {}
             GROUP BY branch
             ORDER BY 2 DESC
             LIMIT 20",
            w.sql
        );
        let mut params: Vec<rusqlite::types::Value> = vec![repo.to_string().into()];
        params.extend(w.params.iter().cloned());
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| Ok(crate::BranchCell {
            branch: r.get(0)?,
            prompts: r.get::<_, i64>(1)? as u32,
            commits: r.get::<_, i64>(2)? as u32,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn breakdown_groups(&self, f: &crate::ScoreFilter) -> Result<Vec<crate::GroupCell>> {
        let w = crate::filter::build_where(f);
        let sql = format!(
            "SELECT group_name,
                    SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END)
             FROM score_events
             WHERE group_name IS NOT NULL AND {}
             GROUP BY group_name
             ORDER BY 2 DESC",
            w.sql
        );
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| Ok(crate::GroupCell {
            group_name: r.get(0)?,
            prompts: r.get::<_, i64>(1)? as u32,
        }))?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
    }

    pub fn recent_sessions(&self, limit: u32) -> Result<Vec<crate::SessionRow>> {
        let sql = r#"
            WITH ordered AS (
              SELECT timestamp_ms, kind, repo, branch, group_name,
                     LAG(timestamp_ms) OVER (PARTITION BY repo, branch ORDER BY timestamp_ms) AS prev_ts
              FROM score_events
            ),
            marked AS (
              SELECT *, CASE WHEN prev_ts IS NULL OR timestamp_ms - prev_ts > 900000 THEN 1 ELSE 0 END AS new_sess
              FROM ordered
            ),
            labeled AS (
              SELECT *, SUM(new_sess) OVER (PARTITION BY repo, branch ORDER BY timestamp_ms) AS sid
              FROM marked
            )
            SELECT MIN(timestamp_ms), MAX(timestamp_ms), repo, branch, group_name,
                   SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END),
                   SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END)
            FROM labeled
            GROUP BY repo, branch, group_name, sid
            ORDER BY MAX(timestamp_ms) DESC
            LIMIT ?1
        "#;
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(sql)?;
        let rows = stmt.query_map(params![limit as i64], |r| Ok(crate::SessionRow {
            start_ts: r.get(0)?,
            end_ts: r.get(1)?,
            repo: r.get(2)?,
            branch: r.get(3)?,
            group_name: r.get(4)?,
            prompts: r.get::<_, i64>(5)? as u32,
            commits: r.get::<_, i64>(6)? as u32,
        }))?;
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
