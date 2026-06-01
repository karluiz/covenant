use crate::achievements::{
    self, AchievementAward, AchievementCategory, AchievementFact, AchievementProgress,
    CategoryRollup, AchievementSummary,
};
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
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if v < 2 {
            conn.execute_batch(
                "ALTER TABLE score_events ADD COLUMN repo TEXT;
                 ALTER TABLE score_events ADD COLUMN branch TEXT;
                 ALTER TABLE score_events ADD COLUMN group_name TEXT;
                 CREATE INDEX IF NOT EXISTS idx_events_repo   ON score_events(repo);
                 CREATE INDEX IF NOT EXISTS idx_events_branch ON score_events(repo, branch);
                 CREATE INDEX IF NOT EXISTS idx_events_group  ON score_events(group_name);
                 PRAGMA user_version = 2;",
            )?;
        }
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if v < 3 {
            conn.execute_batch(
                "ALTER TABLE score_events ADD COLUMN agent TEXT;
                 CREATE INDEX IF NOT EXISTS idx_events_agent ON score_events(agent);

                 CREATE TABLE IF NOT EXISTS specs (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts_ms       INTEGER NOT NULL,
                    day         TEXT    NOT NULL,
                    path        TEXT    NOT NULL UNIQUE,
                    repo        TEXT,
                    branch      TEXT,
                    group_name  TEXT
                 );
                 CREATE INDEX IF NOT EXISTS idx_specs_ts   ON specs(ts_ms);
                 CREATE INDEX IF NOT EXISTS idx_specs_day  ON specs(day);
                 CREATE INDEX IF NOT EXISTS idx_specs_repo ON specs(repo);

                 CREATE TABLE IF NOT EXISTS llm_calls (
                    id              INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts_ms           INTEGER NOT NULL,
                    day             TEXT    NOT NULL,
                    source          TEXT    NOT NULL CHECK (source IN ('internal','external')),
                    agent           TEXT,
                    provider        TEXT    NOT NULL,
                    model           TEXT    NOT NULL,
                    input_tokens    INTEGER NOT NULL DEFAULT 0,
                    output_tokens   INTEGER NOT NULL DEFAULT 0,
                    cache_read      INTEGER NOT NULL DEFAULT 0,
                    cache_creation  INTEGER NOT NULL DEFAULT 0,
                    repo            TEXT,
                    branch          TEXT,
                    group_name      TEXT
                 );
                 CREATE INDEX IF NOT EXISTS idx_llm_ts          ON llm_calls(ts_ms);
                 CREATE INDEX IF NOT EXISTS idx_llm_day         ON llm_calls(day);
                 CREATE INDEX IF NOT EXISTS idx_llm_source_mod  ON llm_calls(source, model);
                 CREATE INDEX IF NOT EXISTS idx_llm_agent       ON llm_calls(agent);

                 CREATE TABLE IF NOT EXISTS external_watermarks (
                    source      TEXT NOT NULL,
                    path        TEXT NOT NULL,
                    byte_offset INTEGER NOT NULL DEFAULT 0,
                    PRIMARY KEY (source, path)
                 );

                 PRAGMA user_version = 3;",
            )?;
        }
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if v < 4 {
            conn.execute_batch(
                "CREATE TABLE IF NOT EXISTS achievement_facts (
                    id            INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts_ms         INTEGER NOT NULL,
                    day           TEXT NOT NULL,
                    kind          TEXT NOT NULL,
                    subject_type  TEXT NOT NULL,
                    subject_id    TEXT,
                    repo          TEXT,
                    branch        TEXT,
                    group_name    TEXT,
                    session_id    TEXT,
                    task_id       TEXT,
                    verification  TEXT,
                    dedupe_key    TEXT UNIQUE,
                    metadata_json TEXT NOT NULL DEFAULT '{}'
                 );
                 CREATE INDEX IF NOT EXISTS idx_ach_facts_kind
                    ON achievement_facts(kind, ts_ms);
                 CREATE INDEX IF NOT EXISTS idx_ach_facts_subject
                    ON achievement_facts(subject_type, subject_id, ts_ms);
                 CREATE INDEX IF NOT EXISTS idx_ach_facts_repo
                    ON achievement_facts(repo, ts_ms);

                 CREATE TABLE IF NOT EXISTS achievement_progress (
                    achievement_id TEXT NOT NULL,
                    subject_type   TEXT NOT NULL,
                    subject_id     TEXT,
                    subject_key    TEXT NOT NULL DEFAULT '',
                    scope_type     TEXT NOT NULL,
                    scope_id       TEXT,
                    scope_key      TEXT NOT NULL DEFAULT '',
                    tier           INTEGER NOT NULL DEFAULT 0,
                    progress       INTEGER NOT NULL DEFAULT 0,
                    target         INTEGER NOT NULL DEFAULT 0,
                    updated_at_ms  INTEGER NOT NULL,
                    PRIMARY KEY (achievement_id, subject_type, subject_key, scope_type, scope_key)
                 );

                 CREATE TABLE IF NOT EXISTS achievement_awards (
                    id             INTEGER PRIMARY KEY AUTOINCREMENT,
                    achievement_id TEXT NOT NULL,
                    tier           INTEGER NOT NULL,
                    title          TEXT NOT NULL,
                    subject_type   TEXT NOT NULL,
                    subject_id     TEXT,
                    subject_key    TEXT NOT NULL DEFAULT '',
                    scope_type     TEXT NOT NULL,
                    scope_id       TEXT,
                    scope_key      TEXT NOT NULL DEFAULT '',
                    repo           TEXT,
                    branch         TEXT,
                    earned_at_ms   INTEGER NOT NULL,
                    seen_at_ms     INTEGER,
                    details_json   TEXT NOT NULL DEFAULT '{}',
                    UNIQUE (achievement_id, tier, subject_type, subject_key, scope_type, scope_key)
                 );
                 CREATE INDEX IF NOT EXISTS idx_ach_awards_earned
                    ON achievement_awards(earned_at_ms);
                 CREATE INDEX IF NOT EXISTS idx_ach_awards_unseen
                    ON achievement_awards(seen_at_ms);

                 PRAGMA user_version = 4;",
            )?;
        }
        // v5: workspace attribution on events. Disambiguates same-named tab
        // groups across workspaces. Historical rows keep NULL workspace.
        let v: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap_or(0);
        if v < 5 {
            conn.execute_batch(
                "ALTER TABLE score_events ADD COLUMN workspace TEXT;
                 CREATE INDEX IF NOT EXISTS idx_events_workspace ON score_events(workspace, group_name);
                 PRAGMA user_version = 5;",
            )?;
        }
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            path,
        })
    }

    pub fn connection(&self) -> Arc<Mutex<Connection>> {
        self.conn.clone()
    }

    pub fn append(&self, timestamp_ms: i64, kind: EventKind, executor: &str) -> Result<()> {
        let day = day_from_ms_local(timestamp_ms);
        let kind_s = match kind {
            EventKind::Prompt => "prompt",
            EventKind::Commit => "commit",
        };
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO score_events(timestamp_ms, kind, executor, day) VALUES (?1, ?2, ?3, ?4)",
            params![timestamp_ms, kind_s, executor, day],
        )?;
        Ok(())
    }

    pub fn append_with_context(
        &self,
        timestamp_ms: i64,
        kind: EventKind,
        executor: &str,
        agent: Option<&str>,
        ctx: &Context,
    ) -> Result<()> {
        let day = day_from_ms_local(timestamp_ms);
        let kind_s = match kind {
            EventKind::Prompt => "prompt",
            EventKind::Commit => "commit",
        };
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO score_events(timestamp_ms, kind, executor, day, repo, branch, group_name, agent, workspace)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                timestamp_ms,
                kind_s,
                executor,
                day,
                ctx.repo,
                ctx.branch,
                ctx.group_name,
                agent,
                ctx.workspace
            ],
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
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn unsynced_events(
        &self,
        after_id: i64,
        limit: usize,
    ) -> Result<
        Vec<(
            i64,
            i64,
            EventKind,
            String,
            Option<String>,
            Option<String>,
            Option<String>,
        )>,
    > {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(
            "SELECT id, timestamp_ms, kind, executor, repo, branch, group_name FROM score_events
             WHERE id > ?1 ORDER BY id ASC LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![after_id, limit as i64], |r| {
            let kind: String = r.get(2)?;
            let kind = if kind == "prompt" {
                EventKind::Prompt
            } else {
                EventKind::Commit
            };
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
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
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

    pub fn set_sync_cursor(
        &self,
        last_pushed_event_id: i64,
        server_cursor_ms: i64,
        synced_at_ms: i64,
    ) -> Result<()> {
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
        let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| {
            Ok(DailyCell {
                day: r.get(0)?,
                prompts: r.get::<_, i64>(1)? as u32,
                commits: r.get::<_, i64>(2)? as u32,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
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
        let mut fcopy = f.clone();
        fcopy.agent = None;
        let w_st = crate::filter::build_where(&fcopy);
        let tokens_sql = format!(
            "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM llm_calls WHERE {}",
            w_st.sql
        );
        let specs_sql = format!("SELECT COUNT(*) FROM specs WHERE {}", w_st.sql);
        let (total_tokens, total_specs) = {
            let c = self.conn.lock().unwrap();
            let tok: i64 = c.query_row(
                &tokens_sql,
                rusqlite::params_from_iter(w_st.params.iter()),
                |r| r.get(0),
            )?;
            let sp: i64 = c.query_row(
                &specs_sql,
                rusqlite::params_from_iter(w_st.params.iter()),
                |r| r.get(0),
            )?;
            (tok as u64, sp as u32)
        };
        Ok(Summary {
            total_prompts: total_p,
            total_commits: total_c,
            today_prompts: today_p,
            today_commits: today_c,
            current_streak,
            longest_streak,
            total_tokens,
            total_specs,
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
        let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| {
            Ok(crate::RepoCell {
                repo: r.get(0)?,
                prompts: r.get::<_, i64>(1)? as u32,
                commits: r.get::<_, i64>(2)? as u32,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn breakdown_branches(
        &self,
        repo: &str,
        f: &crate::ScoreFilter,
    ) -> Result<Vec<crate::BranchCell>> {
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
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok(crate::BranchCell {
                branch: r.get(0)?,
                prompts: r.get::<_, i64>(1)? as u32,
                commits: r.get::<_, i64>(2)? as u32,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn breakdown_groups(&self, f: &crate::ScoreFilter) -> Result<Vec<crate::GroupCell>> {
        let w = crate::filter::build_where(f);
        // Key by case-insensitive group_name only: one row per logical group,
        // summing prompts across workspaces. This folds legacy null-workspace
        // events into the named group (so "Covenant" isn't split into a bare
        // null row + a badged row) and collapses casing typos (COVENANT /
        // COVEnant). MIN(group_name) picks a stable representative casing.
        //
        // The workspace badge is only meaningful when the group lives in
        // exactly one named workspace: COUNT(DISTINCT workspace) ignores NULLs,
        // so it's 1 iff there's a single named workspace (regardless of how
        // many null-workspace events also exist); MAX(workspace) then surfaces
        // it. 0 named (all legacy) or 2+ named (ambiguous) → no badge.
        let sql = format!(
            "SELECT MIN(group_name),
                    CASE WHEN COUNT(DISTINCT workspace) = 1 THEN MAX(workspace) END,
                    SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END)
             FROM score_events
             WHERE group_name IS NOT NULL AND {}
             GROUP BY group_name COLLATE NOCASE
             ORDER BY 3 DESC",
            w.sql
        );
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| {
            Ok(crate::GroupCell {
                group_name: r.get(0)?,
                workspace: r.get(1)?,
                prompts: r.get::<_, i64>(2)? as u32,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
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
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(crate::SessionRow {
                start_ts: r.get(0)?,
                end_ts: r.get(1)?,
                repo: r.get(2)?,
                branch: r.get(3)?,
                group_name: r.get(4)?,
                prompts: r.get::<_, i64>(5)? as u32,
                commits: r.get::<_, i64>(6)? as u32,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
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
        let (total_tokens, total_specs) = {
            let c = self.conn.lock().unwrap();
            let tok: i64 = c.query_row(
                "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) FROM llm_calls",
                [],
                |r| r.get(0),
            )?;
            let sp: i64 = c.query_row("SELECT COUNT(*) FROM specs", [], |r| r.get(0))?;
            (tok as u64, sp as u32)
        };
        Ok(Summary {
            total_prompts: total_p,
            total_commits: total_c,
            today_prompts: today_p,
            today_commits: today_c,
            current_streak,
            longest_streak,
            total_tokens,
            total_specs,
        })
    }

    pub fn append_spec(&self, timestamp_ms: i64, path: &str, ctx: &Context) -> Result<bool> {
        let day = day_from_ms_local(timestamp_ms);
        let c = self.conn.lock().unwrap();
        let rows = c.execute(
            "INSERT OR IGNORE INTO specs(ts_ms, day, path, repo, branch, group_name)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
            params![
                timestamp_ms,
                day,
                path,
                ctx.repo,
                ctx.branch,
                ctx.group_name
            ],
        )?;
        Ok(rows > 0)
    }

    pub fn append_llm_call(
        &self,
        timestamp_ms: i64,
        source: crate::ModelSource,
        agent: Option<&str>,
        provider: &str,
        model: &str,
        u: crate::LlmUsage,
        ctx: &Context,
    ) -> Result<()> {
        let day = day_from_ms_local(timestamp_ms);
        let src = match source {
            crate::ModelSource::Internal => "internal",
            crate::ModelSource::External => "external",
        };
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO llm_calls(ts_ms, day, source, agent, provider, model,
                                   input_tokens, output_tokens, cache_read, cache_creation,
                                   repo, branch, group_name)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
            params![
                timestamp_ms,
                day,
                src,
                agent,
                provider,
                model,
                u.input as i64,
                u.output as i64,
                u.cache_read as i64,
                u.cache_creation as i64,
                ctx.repo,
                ctx.branch,
                ctx.group_name
            ],
        )?;
        Ok(())
    }

    pub fn breakdown_models(
        &self,
        f: &crate::ScoreFilter,
        source: crate::ModelSource,
    ) -> Result<Vec<crate::ModelCell>> {
        let w = crate::filter::build_where(f);
        let src = match source {
            crate::ModelSource::Internal => "internal",
            crate::ModelSource::External => "external",
        };
        let sql = format!(
            "SELECT agent, provider, model,
                    COUNT(*),
                    COALESCE(SUM(input_tokens),0),
                    COALESCE(SUM(output_tokens),0),
                    COALESCE(SUM(cache_read),0)
             FROM llm_calls
             WHERE source = ? AND {}
             GROUP BY agent, provider, model
             ORDER BY 4 DESC
             LIMIT 50",
            w.sql
        );
        let mut params: Vec<rusqlite::types::Value> = vec![src.to_string().into()];
        params.extend(w.params.iter().cloned());

        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok(crate::ModelCell {
                source,
                agent: r.get::<_, Option<String>>(0)?,
                provider: r.get(1)?,
                model: r.get(2)?,
                calls: r.get::<_, i64>(3)? as u32,
                input_tokens: r.get::<_, i64>(4)? as u64,
                output_tokens: r.get::<_, i64>(5)? as u64,
                cache_read: r.get::<_, i64>(6)? as u64,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn breakdown_agents(&self, f: &crate::ScoreFilter) -> Result<Vec<crate::AgentCell>> {
        let w = crate::filter::build_where(f);
        let sql = format!(
            "SELECT COALESCE(agent, 'shell') AS a, COUNT(*)
             FROM score_events
             WHERE kind = 'prompt' AND {}
             GROUP BY a
             ORDER BY 2 DESC, CASE WHEN agent IS NULL THEN 1 ELSE 0 END ASC, a ASC",
            w.sql
        );
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(&sql)?;
        let raw: Vec<(String, u32)> = stmt
            .query_map(rusqlite::params_from_iter(w.params.iter()), |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u32))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let total: u32 = raw.iter().map(|(_, n)| *n).sum();
        Ok(raw
            .into_iter()
            .map(|(agent, prompts)| crate::AgentCell {
                agent,
                prompts,
                share: if total == 0 {
                    0.0
                } else {
                    prompts as f32 / total as f32
                },
            })
            .collect())
    }

    pub fn get_watermark(&self, source: &str, path: &str) -> Result<u64> {
        let c = self.conn.lock().unwrap();
        let off: Option<i64> = c
            .query_row(
                "SELECT byte_offset FROM external_watermarks WHERE source = ?1 AND path = ?2",
                params![source, path],
                |r| r.get(0),
            )
            .optional()?;
        Ok(off.unwrap_or(0) as u64)
    }

    pub fn set_watermark(&self, source: &str, path: &str, byte_offset: u64) -> Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "INSERT INTO external_watermarks(source, path, byte_offset) VALUES (?1, ?2, ?3)
             ON CONFLICT(source, path) DO UPDATE SET byte_offset = excluded.byte_offset",
            params![source, path, byte_offset as i64],
        )?;
        Ok(())
    }

    pub fn breakdown_specs(&self, f: &crate::ScoreFilter) -> Result<crate::SpecBreakdown> {
        let mut fcopy = f.clone();
        fcopy.agent = None;
        let w = crate::filter::build_where(&fcopy);

        let count_sql = format!("SELECT COUNT(*) FROM specs WHERE {}", w.sql);
        let recent_sql = format!(
            "SELECT ts_ms, path, repo FROM specs WHERE {} ORDER BY ts_ms DESC LIMIT 5",
            w.sql
        );

        let c = self.conn.lock().unwrap();
        let total: i64 = c.query_row(
            &count_sql,
            rusqlite::params_from_iter(w.params.iter()),
            |r| r.get(0),
        )?;
        let mut stmt = c.prepare(&recent_sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| {
            Ok(crate::SpecRow {
                ts_ms: r.get(0)?,
                path: r.get(1)?,
                repo: r.get(2)?,
            })
        })?;
        Ok(crate::SpecBreakdown {
            total: total as u32,
            recent: rows.collect::<rusqlite::Result<Vec<_>>>()?,
        })
    }

    /// Test/diagnostic helper: does a table exist in the schema?
    pub fn table_exists(&self, name: &str) -> Result<bool> {
        let c = self.conn.lock().unwrap();
        let count: i64 = c.query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?1",
            params![name],
            |r| r.get(0),
        )?;
        Ok(count > 0)
    }

    // ─── Achievements ─────────────────────────────────────────────────────

    /// Record a fact and update achievement progress/awards in a single txn.
    /// Returns the awards newly inserted (may be empty).
    pub fn record_achievement_fact(
        &self,
        timestamp_ms: i64,
        fact: &AchievementFact,
    ) -> Result<Vec<AchievementAward>> {
        let day = day_from_ms_local(timestamp_ms);
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;

        // 1. Insert fact (idempotent via dedupe_key UNIQUE).
        let inserted = tx.execute(
            "INSERT OR IGNORE INTO achievement_facts
              (ts_ms, day, kind, subject_type, subject_id, repo, branch,
               group_name, session_id, task_id, verification, dedupe_key, metadata_json)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,'{}')",
            params![
                timestamp_ms,
                day,
                fact.kind,
                fact.subject_type.as_str(),
                fact.subject_id,
                fact.repo,
                fact.branch,
                fact.group_name,
                fact.session_id,
                fact.task_id,
                fact.verification.map(|v| v.as_str()),
                fact.dedupe_key,
            ],
        )?;
        if inserted == 0 {
            // Duplicate: do not touch progress.
            tx.commit()?;
            return Ok(Vec::new());
        }

        // 2. Evaluate every definition triggered by this fact kind.
        let mut new_awards = Vec::new();
        for def in achievements::definitions_for_kind(&fact.kind) {
            let subject_id = fact.subject_id.clone();
            let subject_key = subject_id.clone().unwrap_or_default();

            let (scope_id, scope_key) = match def.scope {
                achievements::ScopeKind::Global => (None, String::new()),
                achievements::ScopeKind::Repo => match fact.repo.clone() {
                    Some(r) => (Some(r.clone()), r),
                    None => continue,
                },
                achievements::ScopeKind::Operator
                | achievements::ScopeKind::Orchestrator => match subject_id.clone() {
                    Some(id) => (Some(id.clone()), id),
                    None => continue,
                },
            };

            // Load current progress row.
            let current: Option<(u32, u32)> = tx
                .query_row(
                    "SELECT tier, progress FROM achievement_progress
                     WHERE achievement_id = ?1 AND subject_type = ?2 AND subject_key = ?3
                       AND scope_type = ?4 AND scope_key = ?5",
                    params![
                        def.id,
                        def.subject.as_str(),
                        subject_key,
                        def.scope.as_str(),
                        scope_key
                    ],
                    |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, i64>(1)? as u32)),
                )
                .optional()?;

            let (old_tier, old_progress) = current.unwrap_or((0, 0));
            let new_progress = old_progress + 1;
            let new_tier = achievements::tier_at(new_progress, def.tiers);
            let target = achievements::next_tier(new_progress, def.tiers)
                .map(|(_, t)| t)
                .unwrap_or_else(|| {
                    def.tiers.last().map(|t| t.target).unwrap_or(0)
                });

            tx.execute(
                "INSERT INTO achievement_progress
                   (achievement_id, subject_type, subject_id, subject_key,
                    scope_type, scope_id, scope_key, tier, progress, target, updated_at_ms)
                 VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                 ON CONFLICT(achievement_id, subject_type, subject_key, scope_type, scope_key)
                 DO UPDATE SET
                   tier = excluded.tier,
                   progress = excluded.progress,
                   target = excluded.target,
                   updated_at_ms = excluded.updated_at_ms",
                params![
                    def.id,
                    def.subject.as_str(),
                    subject_id,
                    subject_key,
                    def.scope.as_str(),
                    scope_id,
                    scope_key,
                    new_tier as i64,
                    new_progress as i64,
                    target as i64,
                    timestamp_ms,
                ],
            )?;

            // Insert award rows for every tier strictly above old_tier.
            for tier in (old_tier + 1)..=new_tier {
                let inserted = tx.execute(
                    "INSERT OR IGNORE INTO achievement_awards
                       (achievement_id, tier, title, subject_type, subject_id, subject_key,
                        scope_type, scope_id, scope_key, repo, branch, earned_at_ms)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                    params![
                        def.id,
                        tier as i64,
                        def.title,
                        def.subject.as_str(),
                        subject_id,
                        subject_key,
                        def.scope.as_str(),
                        scope_id,
                        scope_key,
                        fact.repo,
                        fact.branch,
                        timestamp_ms,
                    ],
                )?;
                if inserted > 0 {
                    let id: i64 = tx.query_row(
                        "SELECT last_insert_rowid()",
                        [],
                        |r| r.get(0),
                    )?;
                    new_awards.push(AchievementAward {
                        id,
                        achievement_id: def.id.to_string(),
                        tier,
                        title: def.title.to_string(),
                        subject_type: def.subject.as_str().to_string(),
                        subject_id: subject_id.clone(),
                        scope_type: def.scope.as_str().to_string(),
                        scope_id: scope_id.clone(),
                        repo: fact.repo.clone(),
                        branch: fact.branch.clone(),
                        earned_at_ms: timestamp_ms,
                        seen_at_ms: None,
                    });
                }
            }
        }

        tx.commit()?;
        Ok(new_awards)
    }

    pub fn achievement_progress_all(&self) -> Result<Vec<AchievementProgress>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(
            "SELECT achievement_id, subject_type, subject_id, scope_type, scope_id,
                    tier, progress, target, updated_at_ms
             FROM achievement_progress",
        )?;
        let rows = stmt.query_map([], |r| {
            let aid: String = r.get(0)?;
            let tier: i64 = r.get(5)?;
            let progress: i64 = r.get(6)?;
            let next = achievements::find_definition(&aid)
                .and_then(|d| achievements::next_tier(progress as u32, d.tiers))
                .map(|(t, _)| t);
            Ok(AchievementProgress {
                achievement_id: aid,
                subject_type: r.get(1)?,
                subject_id: r.get(2)?,
                scope_type: r.get(3)?,
                scope_id: r.get(4)?,
                tier: tier as u32,
                progress: progress as u32,
                target: r.get::<_, i64>(7)? as u32,
                next_tier: next,
                earned_at_ms: Some(r.get::<_, i64>(8)?),
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn achievement_awards_recent(&self, limit: u32) -> Result<Vec<AchievementAward>> {
        let c = self.conn.lock().unwrap();
        let mut stmt = c.prepare(
            "SELECT id, achievement_id, tier, title, subject_type, subject_id,
                    scope_type, scope_id, repo, branch, earned_at_ms, seen_at_ms
             FROM achievement_awards
             ORDER BY earned_at_ms DESC
             LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit as i64], |r| {
            Ok(AchievementAward {
                id: r.get(0)?,
                achievement_id: r.get(1)?,
                tier: r.get::<_, i64>(2)? as u32,
                title: r.get(3)?,
                subject_type: r.get(4)?,
                subject_id: r.get(5)?,
                scope_type: r.get(6)?,
                scope_id: r.get(7)?,
                repo: r.get(8)?,
                branch: r.get(9)?,
                earned_at_ms: r.get(10)?,
                seen_at_ms: r.get(11)?,
            })
        })?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
            .map_err(Into::into)
    }

    pub fn achievement_mark_seen(&self, award_id: i64, ts_ms: i64) -> Result<()> {
        let c = self.conn.lock().unwrap();
        c.execute(
            "UPDATE achievement_awards SET seen_at_ms = ?1
             WHERE id = ?2 AND seen_at_ms IS NULL",
            params![ts_ms, award_id],
        )?;
        Ok(())
    }

    pub fn achievement_summary(&self) -> Result<AchievementSummary> {
        let awards = self.achievement_awards_recent(8)?;
        let total_awards: u32 = {
            let c = self.conn.lock().unwrap();
            let n: i64 = c.query_row(
                "SELECT COUNT(*) FROM achievement_awards",
                [],
                |r| r.get(0),
            )?;
            n as u32
        };

        // Rollup by category from all earned awards.
        let mut points: std::collections::HashMap<AchievementCategory, u32> =
            std::collections::HashMap::new();
        {
            let c = self.conn.lock().unwrap();
            let mut stmt = c.prepare(
                "SELECT achievement_id, tier FROM achievement_awards",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)? as u8))
            })?;
            for row in rows {
                let (id, tier) = row?;
                if let Some(def) = achievements::find_definition(&id) {
                    let base = achievements::tier_points(tier);
                    if def.reputation.is_empty() {
                        *points.entry(def.category).or_insert(0) += base;
                    } else {
                        for w in def.reputation {
                            let p = base * w.weight as u32 / 100;
                            *points.entry(w.dimension).or_insert(0) += p;
                        }
                    }
                }
            }
        }
        let mut by_category: Vec<CategoryRollup> = points
            .into_iter()
            .map(|(category, points)| CategoryRollup { category, points })
            .collect();
        by_category.sort_by(|a, b| b.points.cmp(&a.points));

        let mut in_progress = self.achievement_progress_all()?;
        // Sort: near-complete first; drop maxed-out.
        in_progress.retain(|p| p.next_tier.is_some());
        in_progress.sort_by(|a, b| {
            let pa = (a.progress as f32) / (a.target.max(1) as f32);
            let pb = (b.progress as f32) / (b.target.max(1) as f32);
            pb.partial_cmp(&pa).unwrap_or(std::cmp::Ordering::Equal)
        });
        in_progress.truncate(6);

        Ok(AchievementSummary {
            total_awards,
            by_category,
            recent_awards: awards,
            in_progress,
        })
    }

    /// Recompute progress/awards from facts. Awards earned_at_ms is preserved when
    /// a row already exists. Useful for development/repair.
    pub fn achievement_recompute(&self) -> Result<u32> {
        let mut c = self.conn.lock().unwrap();
        let tx = c.transaction()?;
        tx.execute("DELETE FROM achievement_progress", [])?;
        // Pull all facts in order.
        let facts: Vec<(
            i64,
            String,
            String,
            Option<String>,
            Option<String>,
        )> = {
            let mut stmt = tx.prepare(
                "SELECT ts_ms, kind, subject_type, subject_id, repo
                 FROM achievement_facts ORDER BY id ASC",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, Option<String>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })?;
            rows.collect::<rusqlite::Result<Vec<_>>>()?
        };

        let mut count = 0u32;
        for (ts_ms, kind, _stype, sid, repo) in facts {
            for def in achievements::definitions_for_kind(&kind) {
                let subject_key = sid.clone().unwrap_or_default();
                let (scope_id, scope_key) = match def.scope {
                    achievements::ScopeKind::Global => (None, String::new()),
                    achievements::ScopeKind::Repo => match repo.clone() {
                        Some(r) => (Some(r.clone()), r),
                        None => continue,
                    },
                    achievements::ScopeKind::Operator
                    | achievements::ScopeKind::Orchestrator => match sid.clone() {
                        Some(id) => (Some(id.clone()), id),
                        None => continue,
                    },
                };
                let cur: (u32, u32) = tx
                    .query_row(
                        "SELECT tier, progress FROM achievement_progress
                         WHERE achievement_id = ?1 AND subject_type = ?2 AND subject_key = ?3
                           AND scope_type = ?4 AND scope_key = ?5",
                        params![
                            def.id,
                            def.subject.as_str(),
                            subject_key,
                            def.scope.as_str(),
                            scope_key
                        ],
                        |r| Ok((r.get::<_, i64>(0)? as u32, r.get::<_, i64>(1)? as u32)),
                    )
                    .optional()?
                    .unwrap_or((0, 0));
                let new_progress = cur.1 + 1;
                let new_tier = achievements::tier_at(new_progress, def.tiers);
                let target = achievements::next_tier(new_progress, def.tiers)
                    .map(|(_, t)| t)
                    .unwrap_or_else(|| def.tiers.last().map(|t| t.target).unwrap_or(0));
                tx.execute(
                    "INSERT INTO achievement_progress
                       (achievement_id, subject_type, subject_id, subject_key,
                        scope_type, scope_id, scope_key, tier, progress, target, updated_at_ms)
                     VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
                     ON CONFLICT(achievement_id, subject_type, subject_key, scope_type, scope_key)
                     DO UPDATE SET tier=excluded.tier, progress=excluded.progress,
                                   target=excluded.target, updated_at_ms=excluded.updated_at_ms",
                    params![
                        def.id,
                        def.subject.as_str(),
                        sid,
                        subject_key,
                        def.scope.as_str(),
                        scope_id,
                        scope_key,
                        new_tier as i64,
                        new_progress as i64,
                        target as i64,
                        ts_ms,
                    ],
                )?;
                // Backfill awards (preserve earliest earned_at_ms via OR IGNORE).
                for tier in (cur.0 + 1)..=new_tier {
                    let inserted = tx.execute(
                        "INSERT OR IGNORE INTO achievement_awards
                           (achievement_id, tier, title, subject_type, subject_id, subject_key,
                            scope_type, scope_id, scope_key, repo, branch, earned_at_ms)
                         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,NULL,?11)",
                        params![
                            def.id,
                            tier as i64,
                            def.title,
                            def.subject.as_str(),
                            sid,
                            subject_key,
                            def.scope.as_str(),
                            scope_id,
                            scope_key,
                            repo,
                            ts_ms,
                        ],
                    )?;
                    count += inserted as u32;
                }
            }
        }
        tx.commit()?;
        Ok(count)
    }
}

#[cfg(test)]
mod ach_tests {
    use super::*;
    use crate::achievements::{AchievementFact, SubjectKind, VerificationLevel};

    fn tmp_store() -> (ScoreStore, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = ScoreStore::open(dir.path()).unwrap();
        (store, dir)
    }

    #[test]
    fn fact_increments_progress_and_emits_award() {
        let (s, _d) = tmp_store();
        let fact = AchievementFact::new("task_verified", SubjectKind::Operator)
            .with_subject("athena")
            .with_verification(VerificationLevel::CommandPassed)
            .with_dedupe("task_verified:1:athena");

        let awards = s.record_achievement_fact(1_000, &fact).unwrap();
        assert_eq!(awards.len(), 1, "tier I awarded on first verified task");
        assert_eq!(awards[0].achievement_id, "finisher");
        assert_eq!(awards[0].tier, 1);

        // Dedupe blocks a second insert and yields no new awards.
        let again = s.record_achievement_fact(1_001, &fact).unwrap();
        assert!(again.is_empty());

        let progress = s.achievement_progress_all().unwrap();
        let p = progress.iter().find(|p| p.achievement_id == "finisher").unwrap();
        assert_eq!(p.progress, 1);
        assert_eq!(p.tier, 1);
        assert_eq!(p.next_tier, Some(2));
    }

    #[test]
    fn crossing_multiple_tiers_emits_each_award_once() {
        let (s, _d) = tmp_store();
        // good_delegate uses HARD_TIERS: 1,3,10,25,100 → 3 facts should award tiers I + II.
        for i in 0..3 {
            let fact = AchievementFact::new("orchestrator_task_delegated", SubjectKind::Orchestrator)
                .with_subject("teammate")
                .with_dedupe(format!("orchestrator_task_delegated:t{i}"));
            s.record_achievement_fact(2_000 + i, &fact).unwrap();
        }
        let awards = s.achievement_awards_recent(10).unwrap();
        let counts: Vec<u32> = awards
            .iter()
            .filter(|a| a.achievement_id == "good_delegate")
            .map(|a| a.tier)
            .collect();
        assert!(counts.contains(&1));
        assert!(counts.contains(&2));
        assert_eq!(counts.len(), 2, "exactly one award per tier");
    }

    #[test]
    fn repo_scoped_fact_skipped_without_repo() {
        let (s, _d) = tmp_store();
        // spec_keeper is repo-scoped; without repo the fact must not award.
        let fact = AchievementFact::new("spec_kept", SubjectKind::Operator)
            .with_subject("athena")
            .with_dedupe("spec_kept:1");
        let awards = s.record_achievement_fact(3_000, &fact).unwrap();
        assert!(awards.is_empty());
    }

    #[test]
    fn recompute_rebuilds_progress() {
        let (s, _d) = tmp_store();
        for i in 0..5 {
            let fact = AchievementFact::new("task_verified", SubjectKind::Operator)
                .with_subject("athena")
                .with_dedupe(format!("task_verified:{i}"));
            s.record_achievement_fact(4_000 + i, &fact).unwrap();
        }
        let recomputed = s.achievement_recompute().unwrap();
        // Awards already existed; recompute uses OR IGNORE so count is 0 here.
        let _ = recomputed;
        let progress = s.achievement_progress_all().unwrap();
        let p = progress.iter().find(|p| p.achievement_id == "finisher").unwrap();
        assert_eq!(p.progress, 5);
    }
}

#[cfg(test)]
mod group_breakdown_tests {
    use super::*;
    use crate::types::Context;
    use crate::{EventKind, ScoreFilter};

    fn ctx(group: &str, workspace: Option<&str>) -> Context {
        Context {
            repo: None,
            branch: None,
            group_name: Some(group.to_string()),
            workspace: workspace.map(str::to_string),
        }
    }

    fn prompt(s: &ScoreStore, ts: i64, group: &str, workspace: Option<&str>) {
        s.append_with_context(ts, EventKind::Prompt, "claude", None, &ctx(group, workspace))
            .unwrap();
    }

    #[test]
    fn folds_null_workspace_into_named_group_and_collapses_casing() {
        let dir = tempfile::tempdir().unwrap();
        let s = ScoreStore::open(dir.path()).unwrap();

        // Legacy events with no workspace + a named-workspace event, same group
        // under different casing → one merged row, one named badge.
        prompt(&s, 1_000, "Covenant", None);
        prompt(&s, 1_001, "covenant", None);
        prompt(&s, 1_002, "Covenant", Some("PANDORAS"));
        // A second group lives in two named workspaces → ambiguous, no badge.
        prompt(&s, 1_003, "Fluxa", Some("PANDORAS"));
        prompt(&s, 1_004, "Fluxa", Some("ATLAS"));

        let rows = s.breakdown_groups(&ScoreFilter::default()).unwrap();

        let cov = rows
            .iter()
            .find(|r| r.group_name.eq_ignore_ascii_case("covenant"))
            .expect("covenant row");
        assert_eq!(cov.prompts, 3, "null-workspace prompts fold into the group");
        assert_eq!(
            cov.workspace.as_deref(),
            Some("PANDORAS"),
            "single named workspace surfaces as the badge"
        );

        let fluxa = rows.iter().find(|r| r.group_name == "Fluxa").expect("fluxa row");
        assert_eq!(fluxa.prompts, 2);
        assert_eq!(fluxa.workspace, None, "multiple named workspaces → no badge");

        assert_eq!(rows.len(), 2, "no duplicate same-name rows");
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
        if cell.prompts == 0 {
            continue;
        }
        let d = match parse(&cell.day) {
            Some(d) => d,
            None => continue,
        };
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
            if gap <= 1 {
                run
            } else {
                0
            }
        }
        _ => 0,
    };
    (current, longest)
}
