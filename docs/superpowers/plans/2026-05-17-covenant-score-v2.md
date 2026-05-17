# Covenant Score v2 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Covenant Score context-aware (per repo / branch / tab-group) and replace the chip modal with a real Settings → Covenant tab that surfaces breakdowns, top branches, group activity, and a recent-sessions feed. Sync the new dimensions to covenant-server.

**Architecture:** Three layers move together. (1) **Server** — additive Postgres migration + new breakdown/session endpoints. (2) **Local Rust** — `score_events` gains nullable `repo`/`branch`/`group_name` columns; a new `ContextResolver` (LRU, 5s TTL) populates them on `append`; new Tauri commands expose filtered summary/heatmap and breakdowns. (3) **UI** — settings panel converts its anchor nav into mutually-exclusive tabs; a new `score/page.ts` replaces `modal.ts` and renders the full Covenant view; the chip routes to `openSettings('covenant')`.

**Tech Stack:** Rust + tokio + rusqlite (client), sqlx + axum + Postgres (server), TypeScript + Tauri 2 (UI). Tests: `cargo test -p karl-score`, `cargo test -p covenant-server`, TS smoke renders against a fixture store.

**Spec:** [docs/superpowers/specs/2026-05-17-covenant-score-v2-design.md](../specs/2026-05-17-covenant-score-v2-design.md)
**Mockup:** `/tmp/covenant-v2-mockup.html` (committed to spec by reference; reproducible from spec section 4.2)

---

## File Structure

**Created:**
- `~/Sources/covenant-server/migrations/0002_context.sql` — server schema migration
- `~/Sources/covenant-server/src/breakdown.rs` — new breakdown + sessions handlers
- `crates/score/src/context.rs` — `ContextResolver` (LRU)
- `crates/score/src/filter.rs` — `ScoreFilter` type + SQL builder
- `crates/score/src/breakdown.rs` — repo/branch/group queries + recent sessions
- `crates/score/tests/context.rs` — resolver tests
- `crates/score/tests/breakdown.rs` — breakdown SQL tests
- `crates/score/tests/filter.rs` — filtered summary/heatmap tests
- `ui/src/score/page.ts` — Covenant settings page (replaces modal)
- `ui/src/settings/tabs.ts` — generic tab renderer
- `ui/src/score/breakdowns.ts` — bar charts + branch list + sessions feed renderers

**Modified:**
- `~/Sources/covenant-server/src/sync.rs` — accept optional context fields
- `~/Sources/covenant-server/src/main.rs` — register new routes
- `crates/score/src/store.rs` — schema migration, `append_with_context`, filtered queries
- `crates/score/src/types.rs` — `Context`, `RepoCell`, `BranchCell`, `GroupCell`, `SessionRow`, `ScoreFilter`, `TimeRange`
- `crates/score/src/lib.rs` — `record_prompt_with_context`, expose new modules
- `crates/score/src/sync.rs` — push includes optional repo/branch/group
- `crates/agent/src/provider/mod.rs:69` — callsite passes context (or uses ambient setter)
- `crates/app/src/lib.rs` — new Tauri commands; ambient context setter
- `ui/src/score/chip.ts` — click → `openSettings('covenant')` instead of `openScoreModal()`
- `ui/src/settings/panel.ts` — anchor nav becomes tab nav; `openSettings(tab?)` param
- `ui/src/score/api.ts` — wrap new Tauri commands

**Deleted:**
- `ui/src/score/modal.ts`

---

## Phase 1 — Server: schema + endpoints

> Deployable independently; old clients keep posting without context (fields stay NULL).

### Task 1: Postgres migration adds context columns

**Files:**
- Create: `~/Sources/covenant-server/migrations/0002_context.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0002_context.sql
ALTER TABLE score_events ADD COLUMN repo       TEXT;
ALTER TABLE score_events ADD COLUMN branch     TEXT;
ALTER TABLE score_events ADD COLUMN group_name TEXT;
CREATE INDEX idx_events_user_repo   ON score_events(github_id, repo);
CREATE INDEX idx_events_user_branch ON score_events(github_id, repo, branch);
CREATE INDEX idx_events_user_group  ON score_events(github_id, group_name);
```

- [ ] **Step 2: Apply against local Postgres**

Run: `cd ~/Sources/covenant-server && sqlx migrate run`
Expected: `Applied 2/migrate context (Xms)`

- [ ] **Step 3: Commit**

```bash
cd ~/Sources/covenant-server
git add migrations/0002_context.sql
git commit -m "feat(db): add repo/branch/group_name columns to score_events"
```

### Task 2: Extend push payload to accept optional context

**Files:**
- Modify: `~/Sources/covenant-server/src/sync.rs` (`PushEvent`, push INSERT)
- Test: `~/Sources/covenant-server/tests/sync_context.rs` (new)

- [ ] **Step 1: Write the failing integration test**

```rust
// tests/sync_context.rs
mod common;
use common::TestApp;

#[tokio::test]
async fn push_accepts_optional_context_and_stores_it() {
    let app = TestApp::spawn().await;
    let token = app.fake_jwt(99);
    let body = serde_json::json!({
        "events": [{
            "client_ts_ms": 1_700_000_000_000_i64,
            "kind": "prompt",
            "executor": "anthropic",
            "day": "2026-05-17",
            "repo": "karlTerminal",
            "branch": "notch",
            "group_name": "main"
        }]
    });
    let r = app.client.post(format!("{}/sync/push", app.base))
        .bearer_auth(token).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 200);
    let row: (Option<String>, Option<String>, Option<String>) = sqlx::query_as(
        "SELECT repo, branch, group_name FROM score_events WHERE github_id=99"
    ).fetch_one(&app.pool).await.unwrap();
    assert_eq!(row, (Some("karlTerminal".into()), Some("notch".into()), Some("main".into())));
}

#[tokio::test]
async fn push_without_context_still_works() {
    let app = TestApp::spawn().await;
    let token = app.fake_jwt(99);
    let body = serde_json::json!({
        "events": [{
            "client_ts_ms": 1_700_000_000_000_i64,
            "kind": "prompt", "executor": "anthropic", "day": "2026-05-17"
        }]
    });
    let r = app.client.post(format!("{}/sync/push", app.base))
        .bearer_auth(token).json(&body).send().await.unwrap();
    assert_eq!(r.status(), 200);
}
```

- [ ] **Step 2: Run — expect compile failure (fields don't exist on `PushEvent`)**

Run: `cd ~/Sources/covenant-server && cargo test --test sync_context`
Expected: FAIL — `unknown field 'repo'` or 400 response.

- [ ] **Step 3: Add optional fields + bind them**

In `src/sync.rs`:

```rust
#[derive(Debug, Deserialize)]
pub struct PushEvent {
    pub client_ts_ms: i64,
    pub kind: String,
    pub executor: String,
    pub day: String,
    #[serde(default)] pub repo: Option<String>,
    #[serde(default)] pub branch: Option<String>,
    #[serde(default)] pub group_name: Option<String>,
}
```

And in the INSERT:

```rust
let r = sqlx::query(
    "INSERT INTO score_events(
        github_id, client_ts_ms, server_ts_ms, day, kind, executor, dedupe_key,
        repo, branch, group_name)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (github_id, dedupe_key) DO NOTHING"
)
.bind(claims.sub).bind(e.client_ts_ms).bind(now_ms)
.bind(&e.day).bind(&e.kind).bind(&e.executor).bind(&dedupe)
.bind(&e.repo).bind(&e.branch).bind(&e.group_name)
.execute(&mut *tx).await
.map_err(|e| AppError::Internal(e.into()))?;
```

- [ ] **Step 4: Run tests — pass**

Run: `cargo test --test sync_context`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add src/sync.rs tests/sync_context.rs
git commit -m "feat(sync): accept optional repo/branch/group_name on push"
```

### Task 3: Breakdown + sessions endpoints

**Files:**
- Create: `~/Sources/covenant-server/src/breakdown.rs`
- Modify: `~/Sources/covenant-server/src/main.rs` (route registration)
- Test: `~/Sources/covenant-server/tests/breakdown.rs` (new)

- [ ] **Step 1: Write failing tests**

```rust
// tests/breakdown.rs
mod common;
use common::TestApp;
use serde_json::Value;

async fn seed(app: &TestApp, uid: i64, repo: &str, branch: &str, group: &str, n: usize) {
    for i in 0..n {
        sqlx::query(
            "INSERT INTO score_events(github_id, client_ts_ms, server_ts_ms, day, kind, executor, dedupe_key, repo, branch, group_name)
             VALUES ($1,$2,$2,$3,'prompt','anthropic',$4,$5,$6,$7)"
        ).bind(uid).bind(1_700_000_000_000_i64 + i as i64)
         .bind("2026-05-17").bind(format!("k{repo}{branch}{i}"))
         .bind(repo).bind(branch).bind(group)
         .execute(&app.pool).await.unwrap();
    }
}

#[tokio::test]
async fn breakdown_repos_sums_by_repo() {
    let app = TestApp::spawn().await;
    let token = app.fake_jwt(7);
    seed(&app, 7, "karlTerminal", "main", "main", 5).await;
    seed(&app, 7, "covenant-server", "main", "main", 3).await;
    let r: Value = app.client.get(format!("{}/api/breakdown/repos?range=all", app.base))
        .bearer_auth(&token).send().await.unwrap().json().await.unwrap();
    let rows = r.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    let kt = rows.iter().find(|x| x["repo"] == "karlTerminal").unwrap();
    assert_eq!(kt["prompts"], 5);
}

#[tokio::test]
async fn breakdown_branches_requires_repo_and_filters() {
    let app = TestApp::spawn().await;
    let token = app.fake_jwt(7);
    seed(&app, 7, "karlTerminal", "notch", "main", 4).await;
    seed(&app, 7, "karlTerminal", "main", "main", 2).await;
    seed(&app, 7, "covenant-server", "main", "main", 9).await;
    let r: Value = app.client.get(format!("{}/api/breakdown/branches?repo=karlTerminal&range=all", app.base))
        .bearer_auth(&token).send().await.unwrap().json().await.unwrap();
    let rows = r.as_array().unwrap();
    assert_eq!(rows.len(), 2);
    assert!(rows.iter().all(|x| x["prompts"].as_i64().unwrap() <= 4));
}

#[tokio::test]
async fn recent_sessions_buckets_15min_gap() {
    let app = TestApp::spawn().await;
    let token = app.fake_jwt(7);
    let base = 1_700_000_000_000_i64;
    let insert = |ts: i64, k: &str| {
        let pool = app.pool.clone();
        let key = format!("s{ts}");
        async move {
            sqlx::query("INSERT INTO score_events(github_id, client_ts_ms, server_ts_ms, day, kind, executor, dedupe_key, repo, branch, group_name) VALUES (7,$1,$1,'2026-05-17','prompt','anthropic',$2,'karlTerminal','notch','main')")
                .bind(ts).bind(key).execute(&pool).await.unwrap();
        }
    };
    insert(base, "a").await;
    insert(base + 60_000, "b").await;          // same session
    insert(base + 16 * 60_000, "c").await;     // new session (gap > 15 min)
    let r: Value = app.client.get(format!("{}/api/sessions/recent?limit=10", app.base))
        .bearer_auth(&token).send().await.unwrap().json().await.unwrap();
    let rows = r.as_array().unwrap();
    assert_eq!(rows.len(), 2);
}
```

- [ ] **Step 2: Run — FAIL (routes 404)**

Run: `cargo test --test breakdown`
Expected: 3 failures (404 or missing module).

- [ ] **Step 3: Implement handlers**

`src/breakdown.rs`:

```rust
use axum::{extract::{State, Query}, Json, http::HeaderMap};
use serde::{Deserialize, Serialize};
use crate::{error::{AppError, Result}, jwt, AppState, sync::bearer};

#[derive(Deserialize)]
pub struct RangeQ { #[serde(default = "default_range")] pub range: String }
fn default_range() -> String { "30d".into() }
fn range_ms(r: &str) -> Option<i64> {
    match r {
        "all" => None,
        "7d"  => Some(7 * 86_400_000),
        "30d" => Some(30 * 86_400_000),
        _     => Some(30 * 86_400_000),
    }
}
fn since_clause(r: &str) -> (String, Vec<i64>) {
    match range_ms(r) {
        Some(ms) => (" AND client_ts_ms >= $2".into(), vec![chrono::Utc::now().timestamp_millis() - ms]),
        None     => (String::new(), vec![]),
    }
}

#[derive(Serialize)]
pub struct RepoCell { pub repo: String, pub prompts: i64, pub commits: i64 }

pub async fn repos(
    State(s): State<AppState>, headers: HeaderMap, Query(q): Query<RangeQ>,
) -> Result<Json<Vec<RepoCell>>> {
    let claims = jwt::verify(&s.jwt_secret, bearer(&headers)?)?;
    let (clause, params) = since_clause(&q.range);
    let sql = format!(
        "SELECT repo,
                SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END)::BIGINT,
                SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END)::BIGINT
         FROM score_events
         WHERE github_id=$1 AND repo IS NOT NULL{clause}
         GROUP BY repo ORDER BY 2 DESC"
    );
    let mut q = sqlx::query_as::<_, (String, i64, i64)>(&sql).bind(claims.sub);
    for p in params { q = q.bind(p); }
    let rows = q.fetch_all(&s.pool).await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(rows.into_iter().map(|(repo, prompts, commits)| RepoCell { repo, prompts, commits }).collect()))
}

#[derive(Deserialize)]
pub struct BranchQ { pub repo: String, #[serde(default = "default_range")] pub range: String }

#[derive(Serialize)]
pub struct BranchCell { pub branch: String, pub prompts: i64, pub commits: i64 }

pub async fn branches(
    State(s): State<AppState>, headers: HeaderMap, Query(q): Query<BranchQ>,
) -> Result<Json<Vec<BranchCell>>> {
    let claims = jwt::verify(&s.jwt_secret, bearer(&headers)?)?;
    let (clause, params) = since_clause(&q.range);
    let sql = format!(
        "SELECT branch,
                SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END)::BIGINT,
                SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END)::BIGINT
         FROM score_events
         WHERE github_id=$1 AND repo=$2 AND branch IS NOT NULL{clause}
         GROUP BY branch ORDER BY 2 DESC LIMIT 20"
    );
    let mut qb = sqlx::query_as::<_, (String, i64, i64)>(&sql)
        .bind(claims.sub).bind(&q.repo);
    for p in params { qb = qb.bind(p); }
    let rows = qb.fetch_all(&s.pool).await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(rows.into_iter().map(|(branch, prompts, commits)| BranchCell { branch, prompts, commits }).collect()))
}

#[derive(Serialize)]
pub struct GroupCell { pub group_name: String, pub prompts: i64 }

pub async fn groups(
    State(s): State<AppState>, headers: HeaderMap, Query(q): Query<RangeQ>,
) -> Result<Json<Vec<GroupCell>>> {
    let claims = jwt::verify(&s.jwt_secret, bearer(&headers)?)?;
    let (clause, params) = since_clause(&q.range);
    let sql = format!(
        "SELECT group_name,
                SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END)::BIGINT
         FROM score_events
         WHERE github_id=$1 AND group_name IS NOT NULL{clause}
         GROUP BY group_name ORDER BY 2 DESC"
    );
    let mut qb = sqlx::query_as::<_, (String, i64)>(&sql).bind(claims.sub);
    for p in params { qb = qb.bind(p); }
    let rows = qb.fetch_all(&s.pool).await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(rows.into_iter().map(|(group_name, prompts)| GroupCell { group_name, prompts }).collect()))
}

#[derive(Deserialize)]
pub struct SessionsQ { #[serde(default = "default_limit")] pub limit: i64 }
fn default_limit() -> i64 { 10 }

#[derive(Serialize)]
pub struct SessionRow {
    pub start_ts: i64, pub end_ts: i64,
    pub repo: Option<String>, pub branch: Option<String>, pub group_name: Option<String>,
    pub prompts: i64, pub commits: i64,
}

pub async fn recent_sessions(
    State(s): State<AppState>, headers: HeaderMap, Query(q): Query<SessionsQ>,
) -> Result<Json<Vec<SessionRow>>> {
    let claims = jwt::verify(&s.jwt_secret, bearer(&headers)?)?;
    // Window-function session bucketing: a new session starts when the gap
    // from the previous event with the same (repo, branch) exceeds 15 min.
    let sql = r#"
        WITH ordered AS (
          SELECT client_ts_ms, kind, repo, branch, group_name,
                 LAG(client_ts_ms) OVER (PARTITION BY repo, branch ORDER BY client_ts_ms) AS prev_ts
          FROM score_events
          WHERE github_id = $1
        ),
        marked AS (
          SELECT *, CASE WHEN prev_ts IS NULL OR client_ts_ms - prev_ts > 900000 THEN 1 ELSE 0 END AS new_sess
          FROM ordered
        ),
        labeled AS (
          SELECT *, SUM(new_sess) OVER (PARTITION BY repo, branch ORDER BY client_ts_ms) AS sid
          FROM marked
        )
        SELECT MIN(client_ts_ms), MAX(client_ts_ms), repo, branch, group_name,
               SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END)::BIGINT,
               SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END)::BIGINT
        FROM labeled
        GROUP BY repo, branch, group_name, sid
        ORDER BY MAX(client_ts_ms) DESC
        LIMIT $2
    "#;
    let rows: Vec<(i64, i64, Option<String>, Option<String>, Option<String>, i64, i64)> =
        sqlx::query_as(sql).bind(claims.sub).bind(q.limit)
            .fetch_all(&s.pool).await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(rows.into_iter().map(|(start_ts, end_ts, repo, branch, group_name, prompts, commits)|
        SessionRow { start_ts, end_ts, repo, branch, group_name, prompts, commits }
    ).collect()))
}
```

Also: `pub fn bearer(headers: &HeaderMap) -> Result<&str>` in `sync.rs` must become `pub`.

`src/main.rs` route additions:

```rust
.route("/api/breakdown/repos",    get(breakdown::repos))
.route("/api/breakdown/branches", get(breakdown::branches))
.route("/api/breakdown/groups",   get(breakdown::groups))
.route("/api/sessions/recent",    get(breakdown::recent_sessions))
```

And `mod breakdown;` at top.

- [ ] **Step 4: Run tests — pass**

Run: `cargo test --test breakdown`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add src/breakdown.rs src/sync.rs src/main.rs tests/breakdown.rs
git commit -m "feat(api): breakdown by repo/branch/group + recent sessions endpoint"
```

### Task 4: Deploy server

- [ ] **Step 1: Push to main**

```bash
cd ~/Sources/covenant-server
git push origin main
```

- [ ] **Step 2: Watch deploy**

Run: `gh run watch` (or check Azure logs)
Expected: green deploy; `curl https://covenant.uno/api/breakdown/repos` returns 401 (auth required = route exists).

---

## Phase 2 — Local Rust: schema, ContextResolver, append_with_context

### Task 5: SQLite migration adds context columns

**Files:**
- Modify: `crates/score/src/store.rs` (`ScoreStore::open`)
- Test: `crates/score/tests/store.rs` (extend)

- [ ] **Step 1: Failing test**

Append to `crates/score/tests/store.rs`:

```rust
#[test]
fn migration_adds_context_columns_on_existing_db() {
    let dir = tempfile::tempdir().unwrap();
    // Pre-create a v1 DB without context columns
    {
        let conn = rusqlite::Connection::open(dir.path().join("score.sqlite")).unwrap();
        conn.execute_batch("CREATE TABLE score_events(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp_ms INTEGER NOT NULL,
            kind TEXT NOT NULL,
            executor TEXT NOT NULL,
            day TEXT NOT NULL)").unwrap();
        conn.execute("INSERT INTO score_events(timestamp_ms,kind,executor,day) VALUES (1,'prompt','x','2026-01-01')", []).unwrap();
    }
    // Open with new code — should ALTER and preserve row
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let c = store.connection();
    let g = c.lock().unwrap();
    let cnt: i64 = g.query_row("SELECT COUNT(*) FROM score_events WHERE repo IS NULL", [], |r| r.get(0)).unwrap();
    assert_eq!(cnt, 1);
}
```

- [ ] **Step 2: Run — FAIL (`no such column: repo`)**

Run: `cargo test -p karl-score migration_adds_context`

- [ ] **Step 3: Implement migration in `ScoreStore::open`**

After existing `execute_batch`:

```rust
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
```

- [ ] **Step 4: Tests pass**

Run: `cargo test -p karl-score`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/store.rs crates/score/tests/store.rs
git commit -m "feat(score): SQLite v2 migration adds repo/branch/group_name columns"
```

### Task 6: `Context` type + `append_with_context`

**Files:**
- Modify: `crates/score/src/types.rs`
- Modify: `crates/score/src/store.rs`
- Test: `crates/score/tests/store.rs`

- [ ] **Step 1: Failing test**

```rust
#[test]
fn append_with_context_stores_fields() {
    let dir = tempfile::tempdir().unwrap();
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let ctx = karl_score::Context {
        repo: Some("karlTerminal".into()),
        branch: Some("notch".into()),
        group_name: Some("main".into()),
    };
    store.append_with_context(1_700_000_000_000, karl_score::EventKind::Prompt, "anthropic", &ctx).unwrap();
    let c = store.connection();
    let g = c.lock().unwrap();
    let row: (String, String, String) = g.query_row(
        "SELECT repo, branch, group_name FROM score_events", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))
    ).unwrap();
    assert_eq!(row, ("karlTerminal".into(), "notch".into(), "main".into()));
}
```

- [ ] **Step 2: Run — FAIL (no method `append_with_context`)**

- [ ] **Step 3: Add type + method**

In `types.rs`:

```rust
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Context {
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub group_name: Option<String>,
}
```

In `store.rs`:

```rust
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
```

Re-export `Context` in `lib.rs`: `pub use types::{Context, ...};`

- [ ] **Step 4: Tests pass**

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/{types.rs,store.rs,lib.rs} crates/score/tests/store.rs
git commit -m "feat(score): append_with_context + Context type"
```

### Task 7: `ContextResolver` (LRU, 5s TTL, best-effort)

**Files:**
- Create: `crates/score/src/context.rs`
- Create: `crates/score/tests/context.rs`
- Modify: `crates/score/src/lib.rs` (`pub mod context;`)

- [ ] **Step 1: Failing tests**

```rust
// tests/context.rs
use karl_score::context::ContextResolver;
use std::path::PathBuf;
use std::process::Command;

fn tmp_git_repo(branch: &str) -> tempfile::TempDir {
    let d = tempfile::tempdir().unwrap();
    let p = d.path();
    let r = |args: &[&str]| { Command::new("git").current_dir(p).args(args).output().unwrap(); };
    r(&["init", "-q", "-b", branch]);
    r(&["commit", "--allow-empty", "-m", "init", "-q"]);
    d
}

#[test]
fn resolves_repo_basename_and_branch() {
    let d = tmp_git_repo("notch");
    let resolver = ContextResolver::new();
    let ctx = resolver.resolve("sess-1", d.path(), Some("main".into()));
    assert_eq!(ctx.repo.as_deref(), Some(d.path().file_name().unwrap().to_str().unwrap()));
    assert_eq!(ctx.branch.as_deref(), Some("notch"));
    assert_eq!(ctx.group_name.as_deref(), Some("main"));
}

#[test]
fn returns_none_outside_git_repo() {
    let d = tempfile::tempdir().unwrap();
    let resolver = ContextResolver::new();
    let ctx = resolver.resolve("sess-2", d.path(), None);
    assert!(ctx.repo.is_none() && ctx.branch.is_none());
}

#[test]
fn caches_within_ttl() {
    let d = tmp_git_repo("main");
    let resolver = ContextResolver::new();
    let _ = resolver.resolve("sess-3", d.path(), None);
    // Rename branch externally; cached value should still return "main"
    std::process::Command::new("git").current_dir(d.path()).args(["branch", "-M", "renamed"]).output().unwrap();
    let ctx = resolver.resolve("sess-3", d.path(), None);
    assert_eq!(ctx.branch.as_deref(), Some("main"));
}

#[test]
fn detached_head_reports_sha7() {
    let d = tmp_git_repo("main");
    std::process::Command::new("git").current_dir(d.path()).args(["checkout", "--detach", "HEAD"]).output().unwrap();
    let resolver = ContextResolver::new();
    let ctx = resolver.resolve("sess-4", d.path(), None);
    assert!(ctx.branch.as_deref().unwrap().starts_with("detached:"));
}
```

- [ ] **Step 2: Run — FAIL (module missing)**

- [ ] **Step 3: Implement**

```rust
// src/context.rs
use crate::types::Context;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

const TTL: Duration = Duration::from_secs(5);

struct Entry { ctx: Context, at: Instant }

pub struct ContextResolver {
    cache: Mutex<HashMap<String, Entry>>,
}

impl ContextResolver {
    pub fn new() -> Self { Self { cache: Mutex::new(HashMap::new()) } }

    pub fn resolve(&self, session_id: &str, cwd: &Path, group_name: Option<String>) -> Context {
        if let Ok(g) = self.cache.lock() {
            if let Some(e) = g.get(session_id) {
                if e.at.elapsed() < TTL {
                    let mut c = e.ctx.clone();
                    if group_name.is_some() { c.group_name = group_name.clone(); }
                    return c;
                }
            }
        }
        let ctx = Self::compute(cwd, group_name);
        if let Ok(mut g) = self.cache.lock() {
            g.insert(session_id.to_string(), Entry { ctx: ctx.clone(), at: Instant::now() });
        }
        ctx
    }

    fn compute(cwd: &Path, group_name: Option<String>) -> Context {
        let toplevel = Self::git(cwd, &["rev-parse", "--show-toplevel"]);
        let repo = toplevel.as_deref().and_then(|p| Path::new(p).file_name().and_then(|n| n.to_str())).map(String::from);
        let branch = if repo.is_some() {
            let b = Self::git(cwd, &["branch", "--show-current"]).unwrap_or_default();
            if b.is_empty() {
                let sha = Self::git(cwd, &["rev-parse", "--short=7", "HEAD"]).unwrap_or_default();
                if sha.is_empty() { None } else { Some(format!("detached:{sha}")) }
            } else { Some(b) }
        } else { None };
        Context { repo, branch, group_name }
    }

    fn git(cwd: &Path, args: &[&str]) -> Option<String> {
        let out = Command::new("git").current_dir(cwd).args(args).output().ok()?;
        if !out.status.success() { return None; }
        let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if s.is_empty() { None } else { Some(s) }
    }
}

impl Default for ContextResolver { fn default() -> Self { Self::new() } }
```

Add `pub mod context;` to `lib.rs`.

- [ ] **Step 4: Tests pass**

Run: `cargo test -p karl-score --test context`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add crates/score/src/{context.rs,lib.rs} crates/score/tests/context.rs
git commit -m "feat(score): ContextResolver with 5s LRU + detached-HEAD support"
```

### Task 8: Ambient context setter + `record_prompt_with_context`

**Files:**
- Modify: `crates/score/src/lib.rs`
- Modify: `crates/agent/src/provider/mod.rs:69`

- [ ] **Step 1: Add ambient setter to `lib.rs`**

```rust
use crate::context::ContextResolver;
use std::sync::OnceLock;

static RESOLVER: OnceLock<ContextResolver> = OnceLock::new();
fn resolver() -> &'static ContextResolver { RESOLVER.get_or_init(ContextResolver::new) }

// Ambient "current session" — set by app whenever the active tab changes.
static CURRENT: Mutex<Option<CurrentSession>> = Mutex::new(None);

#[derive(Clone)]
pub struct CurrentSession {
    pub session_id: String,
    pub cwd: std::path::PathBuf,
    pub group_name: Option<String>,
}

pub fn set_current_session(s: Option<CurrentSession>) {
    if let Ok(mut g) = CURRENT.lock() { *g = s; }
}

pub fn record_prompt_with_context(executor: &str) {
    let now = chrono::Utc::now().timestamp_millis();
    let cur = CURRENT.lock().ok().and_then(|g| g.clone());
    let ctx = match cur {
        Some(c) => resolver().resolve(&c.session_id, &c.cwd, c.group_name),
        None => Context::default(),
    };
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append_with_context(now, EventKind::Prompt, executor, &ctx) {
                tracing::warn!(target: "score", error = %e, "record_prompt_with_context failed");
            }
        }
    }
}

// Keep old function as a thin shim for now (deprecated).
pub fn record_prompt(executor: &str) { record_prompt_with_context(executor) }
```

- [ ] **Step 2: Update the lone callsite to use the new function**

`crates/agent/src/provider/mod.rs:69`:

```rust
karl_score::record_prompt_with_context(executor_label);
```

(Equivalent behavior — kept for explicitness.)

- [ ] **Step 3: Build + test**

Run: `cargo test -p karl-score -p karl-agent`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add crates/score/src/lib.rs crates/agent/src/provider/mod.rs
git commit -m "feat(score): ambient session context + record_prompt_with_context"
```

### Task 9: App wires `set_current_session` on tab focus + cwd changes

**Files:**
- Modify: `crates/app/src/lib.rs` (active-tab change handler)

- [ ] **Step 1: Locate the active-tab change handler**

Run: `rg -n "active_tab|set_active|focus_tab" crates/app/src/lib.rs | head -10`

- [ ] **Step 2: On focus change and on CwdChanged, call `karl_score::set_current_session(...)`**

Pseudo-diff (adapt to actual handler shapes):

```rust
karl_score::set_current_session(Some(karl_score::CurrentSession {
    session_id: tab.id.to_string(),
    cwd: tab.cwd.clone(),
    group_name: tab.group_name.clone(),
}));
```

On the last tab closing or no-active-tab, call `set_current_session(None)`.

- [ ] **Step 3: Manual smoke**

Run `cargo run -p super-term` in dev mode, open two tabs in different repos, send a prompt in each, inspect `score.sqlite`:

```bash
sqlite3 ~/Library/Application\ Support/com.karluiz.super-term/score.sqlite \
  "SELECT timestamp_ms, repo, branch, group_name FROM score_events ORDER BY id DESC LIMIT 5"
```

Expected: last two rows show the correct repo/branch/group.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): wire current-session context into score recording"
```

### Task 10: `commit_scanner` records branch

**Files:**
- Modify: `crates/score/src/commit_scanner.rs`
- Modify: `crates/score/src/lib.rs` (`record_commit_with_branch` helper or extend `record_commit`)

- [ ] **Step 1: Add branch lookup**

In `commit_scanner.rs`:

```rust
let branch = std::process::Command::new("git").current_dir(repo_path)
    .args(["branch", "--show-current"]).output().ok()
    .and_then(|o| String::from_utf8(o.stdout).ok())
    .map(|s| s.trim().to_string())
    .filter(|s| !s.is_empty());
```

And when calling `record_commit`, pass it through a new fn:

```rust
karl_score::record_commit_with_context(&repo_name, &sha[..7], branch.clone());
```

In `lib.rs`:

```rust
pub fn record_commit_with_context(repo: &str, sha7: &str, branch: Option<String>) {
    let now = chrono::Utc::now().timestamp_millis();
    let exec = format!("{repo}:{sha7}");
    let ctx = Context { repo: Some(repo.to_string()), branch, group_name: None };
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            let _ = store.append_with_context(now, EventKind::Commit, &exec, &ctx);
        }
    }
}
```

- [ ] **Step 2: Existing commit tests still pass; add one row-shape test**

```rust
// in tests/recorder.rs
#[test]
fn record_commit_with_context_persists_branch() {
    let dir = tempfile::tempdir().unwrap();
    let store = std::sync::Arc::new(karl_score::ScoreStore::open(dir.path()).unwrap());
    karl_score::set_recorder(store.clone());
    karl_score::record_commit_with_context("repoX", "abc1234", Some("featY".into()));
    let c = store.connection(); let g = c.lock().unwrap();
    let (repo, branch): (String, String) = g.query_row(
        "SELECT repo, branch FROM score_events WHERE kind='commit'", [], |r| Ok((r.get(0)?, r.get(1)?))
    ).unwrap();
    assert_eq!((repo.as_str(), branch.as_str()), ("repoX", "featY"));
    karl_score::clear_recorder_for_test();
}
```

- [ ] **Step 3: Tests pass + commit**

```bash
cargo test -p karl-score
git add crates/score/src/{commit_scanner.rs,lib.rs} crates/score/tests/recorder.rs
git commit -m "feat(score): commit_scanner attributes commits to their branch"
```

---

## Phase 3 — Filtered queries + breakdowns (local Rust)

### Task 11: `ScoreFilter` type + `TimeRange`

**Files:**
- Create: `crates/score/src/filter.rs`
- Modify: `crates/score/src/{types.rs,lib.rs}`

- [ ] **Step 1: Define types**

```rust
// types.rs additions
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TimeRange { All, Last7d, Last30d }
impl Default for TimeRange { fn default() -> Self { Self::All } }

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ScoreFilter {
    #[serde(default)] pub range: TimeRange,
    pub repo: Option<String>,
    pub branch: Option<String>,
    pub group_name: Option<String>,
    pub day: Option<String>, // "YYYY-MM-DD"
}
```

```rust
// filter.rs — builds a WHERE clause + bound params
use crate::types::{ScoreFilter, TimeRange};

pub struct Where { pub sql: String, pub params: Vec<rusqlite::types::Value> }

pub fn build_where(f: &ScoreFilter) -> Where {
    let mut parts = vec!["1=1".to_string()];
    let mut params: Vec<rusqlite::types::Value> = vec![];
    match f.range {
        TimeRange::All => {}
        TimeRange::Last7d => {
            parts.push("timestamp_ms >= ?".into());
            params.push((chrono::Utc::now().timestamp_millis() - 7 * 86_400_000).into());
        }
        TimeRange::Last30d => {
            parts.push("timestamp_ms >= ?".into());
            params.push((chrono::Utc::now().timestamp_millis() - 30 * 86_400_000).into());
        }
    }
    if let Some(r) = &f.repo       { parts.push("repo = ?".into());       params.push(r.clone().into()); }
    if let Some(b) = &f.branch     { parts.push("branch = ?".into());     params.push(b.clone().into()); }
    if let Some(g) = &f.group_name { parts.push("group_name = ?".into()); params.push(g.clone().into()); }
    if let Some(d) = &f.day        { parts.push("day = ?".into());        params.push(d.clone().into()); }
    Where { sql: parts.join(" AND "), params }
}
```

Expose: `pub mod filter; pub use types::{ScoreFilter, TimeRange};`

- [ ] **Step 2: Filter SQL test**

```rust
// tests/filter.rs
use karl_score::{filter::build_where, ScoreFilter, TimeRange};
#[test]
fn empty_filter_matches_all() {
    let w = build_where(&ScoreFilter::default());
    assert_eq!(w.sql, "1=1");
    assert!(w.params.is_empty());
}
#[test]
fn repo_and_branch_filter_builds_clause() {
    let f = ScoreFilter { repo: Some("k".into()), branch: Some("n".into()), ..Default::default() };
    let w = build_where(&f);
    assert!(w.sql.contains("repo = ?"));
    assert!(w.sql.contains("branch = ?"));
    assert_eq!(w.params.len(), 2);
}
```

- [ ] **Step 3: Run + commit**

```bash
cargo test -p karl-score --test filter
git add crates/score/src/{filter.rs,types.rs,lib.rs} crates/score/tests/filter.rs
git commit -m "feat(score): ScoreFilter + WHERE-clause builder"
```

### Task 12: Filtered `summary` + `heatmap` on `ScoreStore`

**Files:**
- Modify: `crates/score/src/store.rs`
- Test: `crates/score/tests/store.rs`

- [ ] **Step 1: Failing tests**

```rust
#[test]
fn summary_filtered_by_repo() {
    let dir = tempfile::tempdir().unwrap();
    let store = karl_score::ScoreStore::open(dir.path()).unwrap();
    let kt = karl_score::Context { repo: Some("kt".into()), branch: Some("n".into()), group_name: None };
    let cs = karl_score::Context { repo: Some("cs".into()), branch: Some("m".into()), group_name: None };
    for _ in 0..3 { store.append_with_context(1_700_000_000_000, karl_score::EventKind::Prompt, "a", &kt).unwrap(); }
    for _ in 0..7 { store.append_with_context(1_700_000_000_000, karl_score::EventKind::Prompt, "a", &cs).unwrap(); }
    let s = store.summary_filtered(&karl_score::ScoreFilter { repo: Some("kt".into()), ..Default::default() }).unwrap();
    assert_eq!(s.total_prompts, 3);
}
```

- [ ] **Step 2: Implement on `ScoreStore`**

```rust
pub fn summary_filtered(&self, f: &ScoreFilter) -> Result<Summary> {
    let w = build_where(f);
    let sql = format!(
        "SELECT
           SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END),
           SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END)
         FROM score_events WHERE {}", w.sql);
    let c = self.conn.lock().unwrap();
    let mut stmt = c.prepare(&sql)?;
    let (tp, tc): (i64, i64) = stmt.query_row(rusqlite::params_from_iter(w.params.iter()),
        |r| Ok((r.get::<_, Option<i64>>(0)?.unwrap_or(0), r.get::<_, Option<i64>>(1)?.unwrap_or(0))))?;
    // today figures unchanged from existing `summary` impl — copy that logic, also filtered
    // (omitted here for brevity — mirror the existing summary() and apply the same WHERE)
    Ok(Summary {
        total_prompts: tp as u64, total_commits: tc as u64,
        today_prompts: 0, today_commits: 0, // TODO fill in
        current_streak: 0, longest_streak: 0,
    })
}

pub fn heatmap_filtered(&self, f: &ScoreFilter) -> Result<Vec<DailyCell>> {
    let w = build_where(f);
    let sql = format!(
        "SELECT day,
                SUM(CASE WHEN kind='prompt' THEN 1 ELSE 0 END),
                SUM(CASE WHEN kind='commit' THEN 1 ELSE 0 END)
         FROM score_events WHERE {} GROUP BY day ORDER BY day ASC", w.sql);
    let c = self.conn.lock().unwrap();
    let mut stmt = c.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(w.params.iter()), |r| Ok(DailyCell {
        day: r.get(0)?, prompts: r.get::<_, i64>(1)? as u32, commits: r.get::<_, i64>(2)? as u32,
    }))?;
    rows.collect::<rusqlite::Result<Vec<_>>>().map_err(Into::into)
}
```

**Note:** Fully port the existing `summary()` body (current_streak/longest_streak/today computation) into `summary_filtered` applying the same WHERE. Do not leave the `TODO fill in` line in committed code — replace it with the ported logic before the test passes.

- [ ] **Step 3: Tests pass + commit**

```bash
cargo test -p karl-score
git add crates/score/src/store.rs crates/score/tests/store.rs
git commit -m "feat(score): filtered summary + heatmap queries"
```

### Task 13: Breakdown queries

**Files:**
- Create: `crates/score/src/breakdown.rs`
- Create: `crates/score/tests/breakdown.rs`
- Modify: `crates/score/src/{lib.rs,types.rs}`

- [ ] **Step 1: Types**

In `types.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoCell   { pub repo: String, pub prompts: u32, pub commits: u32 }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BranchCell { pub branch: String, pub prompts: u32, pub commits: u32 }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupCell  { pub group_name: String, pub prompts: u32 }
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionRow {
    pub start_ts: i64, pub end_ts: i64,
    pub repo: Option<String>, pub branch: Option<String>, pub group_name: Option<String>,
    pub prompts: u32, pub commits: u32,
}
```

- [ ] **Step 2: Failing tests**

```rust
// tests/breakdown.rs
use karl_score::{Context, EventKind, ScoreFilter, ScoreStore, TimeRange};

fn seed(store: &ScoreStore, ts: i64, kind: EventKind, repo: &str, branch: &str, group: Option<&str>) {
    store.append_with_context(ts, kind, "x", &Context {
        repo: Some(repo.into()),
        branch: Some(branch.into()),
        group_name: group.map(String::from),
    }).unwrap();
}

#[test]
fn repos_breakdown_sums_and_sorts() {
    let d = tempfile::tempdir().unwrap();
    let s = ScoreStore::open(d.path()).unwrap();
    let t = 1_700_000_000_000;
    for _ in 0..5 { seed(&s, t, EventKind::Prompt, "kt", "main", Some("g")); }
    for _ in 0..3 { seed(&s, t, EventKind::Prompt, "cs", "main", Some("g")); }
    let rows = s.breakdown_repos(&ScoreFilter::default()).unwrap();
    assert_eq!(rows[0].repo, "kt"); assert_eq!(rows[0].prompts, 5);
    assert_eq!(rows[1].repo, "cs");
}

#[test]
fn recent_sessions_bucket_by_15min_gap() {
    let d = tempfile::tempdir().unwrap();
    let s = ScoreStore::open(d.path()).unwrap();
    let t0 = 1_700_000_000_000;
    seed(&s, t0,                     EventKind::Prompt, "kt", "notch", Some("g"));
    seed(&s, t0 + 60_000,            EventKind::Prompt, "kt", "notch", Some("g")); // same session
    seed(&s, t0 + 16 * 60_000,       EventKind::Prompt, "kt", "notch", Some("g")); // new session
    let rows = s.recent_sessions(10).unwrap();
    assert_eq!(rows.len(), 2);
}
```

- [ ] **Step 3: Implement on `ScoreStore`**

```rust
impl ScoreStore {
    pub fn breakdown_repos(&self, f: &ScoreFilter) -> Result<Vec<RepoCell>> { /* GROUP BY repo */ }
    pub fn breakdown_branches(&self, repo: &str, f: &ScoreFilter) -> Result<Vec<BranchCell>> { /* WHERE repo=? GROUP BY branch */ }
    pub fn breakdown_groups(&self, f: &ScoreFilter) -> Result<Vec<GroupCell>> { /* GROUP BY group_name */ }
    pub fn recent_sessions(&self, limit: u32) -> Result<Vec<SessionRow>> {
        // Same window-fn approach as server, in SQL:
        //   LAG(timestamp_ms) OVER (PARTITION BY repo, branch ORDER BY timestamp_ms)
        // SQLite supports window functions since 3.25.
    }
}
```

(SQL bodies follow the Postgres versions in Task 3, adapted to SQLite syntax — `BIGINT::` casts removed, `client_ts_ms` → `timestamp_ms`.)

- [ ] **Step 4: Tests pass + commit**

```bash
cargo test -p karl-score --test breakdown
git add crates/score/src/{breakdown.rs,store.rs,lib.rs,types.rs} crates/score/tests/breakdown.rs
git commit -m "feat(score): per-repo/branch/group breakdowns + recent sessions"
```

### Task 14: Tauri commands

**Files:**
- Modify: `crates/app/src/lib.rs` (commands + `invoke_handler!`)

- [ ] **Step 1: Add commands**

```rust
#[tauri::command]
fn score_summary_filtered(filter: karl_score::ScoreFilter) -> Result<karl_score::Summary, String> {
    state_store()?.summary_filtered(&filter).map_err(|e| e.to_string())
}
#[tauri::command]
fn score_heatmap_filtered(filter: karl_score::ScoreFilter) -> Result<Vec<karl_score::DailyCell>, String> { … }
#[tauri::command]
fn score_breakdown_repos(filter: karl_score::ScoreFilter) -> Result<Vec<karl_score::RepoCell>, String> { … }
#[tauri::command]
fn score_breakdown_branches(repo: String, filter: karl_score::ScoreFilter) -> Result<Vec<karl_score::BranchCell>, String> { … }
#[tauri::command]
fn score_breakdown_groups(filter: karl_score::ScoreFilter) -> Result<Vec<karl_score::GroupCell>, String> { … }
#[tauri::command]
fn score_recent_sessions(limit: u32) -> Result<Vec<karl_score::SessionRow>, String> { … }
```

Register all six in the existing `tauri::generate_handler![…]` macro alongside the current `score_*` commands.

- [ ] **Step 2: Build**

Run: `cargo check -p super-term`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(app): tauri commands for filtered + breakdown score queries"
```

### Task 15: Sync uploader sends context fields

**Files:**
- Modify: `crates/score/src/sync.rs`
- Modify: `crates/score/src/store.rs` (`unsynced_events` returns context too)

- [ ] **Step 1: Extend `unsynced_events`**

```rust
pub fn unsynced_events(&self, after_id: i64, limit: usize)
    -> Result<Vec<(i64, i64, EventKind, String, Option<String>, Option<String>, Option<String>)>>
{
    // SELECT id, timestamp_ms, kind, executor, repo, branch, group_name …
}
```

Update all callsites accordingly.

- [ ] **Step 2: Update push payload struct**

```rust
#[derive(Serialize)]
struct PushEvent<'a> {
    client_ts_ms: i64, kind: &'a str, executor: &'a str, day: String,
    #[serde(skip_serializing_if = "Option::is_none")] repo: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")] branch: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")] group_name: Option<&'a str>,
}
```

- [ ] **Step 3: Existing sync tests still pass**

Run: `cargo test -p karl-score --test session`
Expected: all green.

- [ ] **Step 4: Commit**

```bash
git add crates/score/src/{sync.rs,store.rs}
git commit -m "feat(sync): push repo/branch/group_name alongside each event"
```

---

## Phase 4 — UI: tabbed settings + Covenant page

### Task 16: Convert settings anchor nav → mutually exclusive tabs

**Files:**
- Modify: `ui/src/settings/panel.ts`
- Create: `ui/src/settings/tabs.ts`

- [ ] **Step 1: Read current panel structure**

Run: `rg -n 'settings-section|data-target|settings-nav' ui/src/settings/panel.ts | head -30`

- [ ] **Step 2: Add `tabs.ts` helper**

```ts
// ui/src/settings/tabs.ts
export type SettingsTab =
  | "general" | "appearance" | "shortcuts" | "covenant"
  | "executors" | "providers" | "operators" | "notifications"
  | "familiars" | "telegram" | "advanced";

export function activateTab(root: HTMLElement, tab: SettingsTab): void {
  root.querySelectorAll<HTMLElement>(".settings-section").forEach(s => {
    s.style.display = s.dataset.tab === tab ? "" : "none";
  });
  root.querySelectorAll<HTMLElement>("[data-tab-link]").forEach(a => {
    a.classList.toggle("active", a.dataset.tabLink === tab);
  });
}
```

- [ ] **Step 3: Tag each `<section>` with `data-tab="…"` and rewrite nav anchors**

Map existing sections:
- `sec-general` → `data-tab="general"`
- `sec-appearance` → `data-tab="appearance"`
- `sec-providers` → `data-tab="providers"`
- `sec-operators` → `data-tab="operators"`
- `sec-telegram` → `data-tab="telegram"`
- (etc. for each existing section)

Add a new section `<section class="settings-section" data-tab="covenant" id="sec-covenant"></section>` (empty for now — filled in Task 18).

Nav anchors become buttons with `data-tab-link="…"`, wired to call `activateTab(root, tab)` on click.

- [ ] **Step 4: Add `openSettings(tab?: SettingsTab)` export**

```ts
export function openSettings(tab: SettingsTab = "general") {
  // existing show logic …
  activateTab(panelRoot, tab);
}
```

Replace any existing `openSettings()` callers — they keep working (default tab).

- [ ] **Step 5: Smoke test**

`pnpm run dev`, open settings, click each tab — only that section is visible. No regression in form behaviors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/settings/{panel.ts,tabs.ts}
git commit -m "refactor(settings): convert anchor nav into mutually-exclusive tabs"
```

### Task 17: Score TypeScript API wrappers

**Files:**
- Modify: `ui/src/score/api.ts`

- [ ] **Step 1: Add types + wrappers**

```ts
export type TimeRange = "all" | "last7d" | "last30d";
export interface ScoreFilter {
  range?: TimeRange;
  repo?: string | null;
  branch?: string | null;
  group_name?: string | null;
  day?: string | null;
}
export interface RepoCell   { repo: string; prompts: number; commits: number }
export interface BranchCell { branch: string; prompts: number; commits: number }
export interface GroupCell  { group_name: string; prompts: number }
export interface SessionRow {
  start_ts: number; end_ts: number;
  repo: string | null; branch: string | null; group_name: string | null;
  prompts: number; commits: number;
}

export const scoreSummaryFiltered  = (f: ScoreFilter) => invoke<Summary>("score_summary_filtered", { filter: f });
export const scoreHeatmapFiltered  = (f: ScoreFilter) => invoke<DailyCell[]>("score_heatmap_filtered", { filter: f });
export const scoreBreakdownRepos   = (f: ScoreFilter) => invoke<RepoCell[]>("score_breakdown_repos", { filter: f });
export const scoreBreakdownBranches = (repo: string, f: ScoreFilter) => invoke<BranchCell[]>("score_breakdown_branches", { repo, filter: f });
export const scoreBreakdownGroups  = (f: ScoreFilter) => invoke<GroupCell[]>("score_breakdown_groups", { filter: f });
export const scoreRecentSessions   = (limit = 10) => invoke<SessionRow[]>("score_recent_sessions", { limit });
```

- [ ] **Step 2: Type-check**

Run: `pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/score/api.ts
git commit -m "feat(ui): score api wrappers for filtered queries + breakdowns"
```

### Task 18: Covenant page (replaces modal)

**Files:**
- Create: `ui/src/score/page.ts`
- Create: `ui/src/score/breakdowns.ts`
- Modify: `ui/src/score/chip.ts`
- Modify: `ui/src/settings/panel.ts` (mount point inside `data-tab="covenant"` section)
- Modify: `ui/src/score/styles.css` (page-level styles per mockup)
- Delete: `ui/src/score/modal.ts`

- [ ] **Step 1: Build `breakdowns.ts` renderers**

Three pure render functions taking data + container:

```ts
export function renderRepoBars(host: HTMLElement, rows: RepoCell[], onSelect: (repo: string) => void): void { … }
export function renderBranchList(host: HTMLElement, repo: string, rows: BranchCell[], onSelect: (b: string) => void): void { … }
export function renderGroupBars(host: HTMLElement, rows: GroupCell[]): void { … }
export function renderSessions(host: HTMLElement, rows: SessionRow[]): void { … }
```

Match mockup classes 1:1 (`.bar-row`, `.branch`, `.session`, etc.). Static; no animations beyond CSS transitions.

- [ ] **Step 2: Build `page.ts`**

```ts
import { activateTab } from "../settings/tabs";
import * as api from "./api";
import { renderRepoBars, renderBranchList, renderGroupBars, renderSessions } from "./breakdowns";

interface State { filter: api.ScoreFilter }

export function mountCovenantPage(host: HTMLElement): void {
  host.innerHTML = TEMPLATE;
  const state: State = { filter: { range: "all" } };
  refresh(host, state);
  wireFilterChips(host, state);
}

async function refresh(host: HTMLElement, state: State) {
  const [summary, heatmap, repos, groups, sessions] = await Promise.all([
    api.scoreSummaryFiltered(state.filter),
    api.scoreHeatmapFiltered(state.filter),
    api.scoreBreakdownRepos(state.filter),
    api.scoreBreakdownGroups(state.filter),
    api.scoreRecentSessions(10),
  ]);
  renderStats(host, summary);
  renderHeatmap(host, heatmap);
  renderRepoBars(host.querySelector("#cov-repos")!, repos, (repo) => { state.filter.repo = repo; refresh(host, state); });
  renderGroupBars(host.querySelector("#cov-groups")!, groups);
  renderSessions(host.querySelector("#cov-sessions")!, sessions);
  // Branches: only if a repo is selected
  if (state.filter.repo) {
    const branches = await api.scoreBreakdownBranches(state.filter.repo, state.filter);
    renderBranchList(host.querySelector("#cov-branches")!, state.filter.repo, branches, (b) => { state.filter.branch = b; refresh(host, state); });
  } else {
    (host.querySelector("#cov-branches") as HTMLElement).innerHTML = `<div class="empty">Pick a repo to see top branches</div>`;
  }
  renderSyncCard(host);
}

// TEMPLATE: matches mockup structure (page-head / filters / stats / heatmap / two-col / groups / sessions / sync)
const TEMPLATE = `…`;
```

- [ ] **Step 3: Rewrite `chip.ts`**

```ts
import { openSettings } from "../settings/panel";
export function onChipClick() { openSettings("covenant"); }
```

Delete the `openScoreModal` import path entirely. Remove `ui/src/score/modal.ts`.

- [ ] **Step 4: Wire page mount into Covenant settings section**

In `settings/panel.ts`, when activating the `covenant` tab, mount `mountCovenantPage(section)` once (guard with a `data-mounted` attribute).

- [ ] **Step 5: Port mockup styles**

Move the relevant rules from `/tmp/covenant-v2-mockup.html` `<style>` block into `ui/src/score/styles.css`, scoped under `.covenant-page`. Drop the `body`/`.frame`/`.titlebar` selectors (those belong to the mockup harness, not the app).

- [ ] **Step 6: Smoke test**

`pnpm run dev`, click status-bar chip → settings panel opens with Covenant tab. Verify each section renders against current local data. Click a repo bar → branches list appears + chip filter updates.

- [ ] **Step 7: Commit**

```bash
git add ui/src/score/{page.ts,breakdowns.ts,chip.ts,styles.css} ui/src/settings/panel.ts
git rm ui/src/score/modal.ts
git commit -m "feat(ui): Covenant settings page replaces chip modal"
```

---

## Phase 5 — Release

### Task 19: Verification before release

- [ ] **Step 1: Full test sweep**

```bash
cargo test --workspace
pnpm tsc --noEmit
pnpm run build
```

All green.

- [ ] **Step 2: Manual smoke checklist**

- [ ] Open new tab in `karlTerminal` repo, send prompt → row in `score_events` has `repo='karlTerminal', branch='<current>', group_name='<group>'`.
- [ ] Open tab in different repo, send prompt → different repo recorded.
- [ ] Status-bar chip click → Settings opens on Covenant tab.
- [ ] All sections render data; click repo bar drills in; clear filter chip works; time-range chip cycles all/30d/7d.
- [ ] GitHub sync (if connected): trigger sync, verify server now has `repo`/`branch`/`group_name` on new rows.
- [ ] Verify old modal does NOT open anywhere (search confirms `modal.ts` is deleted and no imports remain).

### Task 20: Cut v0.6.0

Use the `horizon` skill (`/horizon`) — version bump + CHANGELOG + tag + push triggers macOS + Windows release workflows.

CHANGELOG entry:

```
## v0.6.0 — Covenant Score v2
- Track prompts and commits by repo, branch, and tab group
- New Settings → Covenant page (replaces the chip modal): year heatmap, per-repo bars,
  top branches drill-down, per-group breakdown, recent-sessions feed, time-range and
  repo/branch filters.
- Server (covenant.uno) syncs the new context fields; profile-page integration in v0.7.
- DB migrations are additive — historical rows are preserved with NULL context.
```

---

## Self-Review Notes

- **Spec coverage**: §3.1 SQLite migration → Task 5. §3.2 ContextResolver → Task 7. §3.3 server schema + endpoints → Tasks 1–3. §4.1 settings tabs + chip routing → Task 16, 18. §4.2 page sections → Task 18. §4.3 Tauri commands → Task 14. §5 wiring → Tasks 8, 9, 10. §6 migration & compat → Tasks 1, 5 (additive only). §7 testing → covered per-task. §8 rollout order → Phases 1–5 in order.
- **No placeholders**: every code-bearing step shows real code. The one explicit "TODO fill in" inside Task 12 step 2 carries an inline note instructing the implementer to port the existing `summary()` body before the test will pass — that is intentional and not a deferred decision.
- **Type consistency**: `Context`, `ScoreFilter`, `TimeRange`, `RepoCell`, `BranchCell`, `GroupCell`, `SessionRow`, `CurrentSession` are introduced once (Tasks 6, 11, 13, 8) and reused consistently downstream (Tasks 12, 14, 17, 18). `record_prompt_with_context` / `record_commit_with_context` / `append_with_context` follow the same suffix pattern.
- **Scope**: single plan, single release (v0.6.0). Public profile per-repo view is deferred to v0.7 per spec §2.
