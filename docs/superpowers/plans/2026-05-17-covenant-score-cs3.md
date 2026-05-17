# Covenant Score CS-3 Implementation Plan — Azure Backend + Sync

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Ship the Covenant Score backend on Azure plus the client-side sync engine. After CS-3, signed-in users see their score backed up to the server, browsable at `covenant.uno/u/{login}`, and synced across devices.

**Architecture:**
- New **private** GitHub repo `karluiz/covenant-server` — Rust + axum + sqlx + Postgres. Independent of the Covenant client repo.
- Server-issued JWT: client POSTs its GitHub access token to `/auth/exchange`; server calls GitHub `/user`, mints a 30-day HS256 JWT keyed on `github_id`. Client uses JWT for all `/sync/*` calls.
- Sync is push-only from client (events are immutable + dedupe-safe). Server is the system of record once written.
- Public profile is SSR HTML — read-only, no auth.
- Azure: App Service (Linux B1) + Database for PostgreSQL Flexible Server (Burstable B1ms). Custom domain `covenant.uno` on the App Service, TLS via App Service managed cert.

**Tech Stack:** Rust (axum 0.7, sqlx 0.8, jsonwebtoken, reqwest, tower-http), Postgres 16, Azure (az CLI provisioning), Bicep optional.

---

## Prerequisites (manual, user does these once)

These are not coding steps — they unlock the rest of the plan.

1. **Create the private repo:**
   ```
   gh repo create karluiz/covenant-server --private --clone --add-readme --license MIT
   cd ~/Sources/covenant-server
   ```
2. **Install Azure CLI** if not installed: `brew install azure-cli`.
3. **Sign in:** `az login`. Note the subscription id.
4. **Point covenant.uno DNS** to wherever Azure App Service will live (Azure will give a CNAME target during Task 7). Pre-step: in your registrar, add an `A` record for `@` and a `CNAME` for `www` placeholder. Real values come in Task 7.

---

## File Structure (new repo: `covenant-server`)

```
covenant-server/
├── Cargo.toml
├── README.md
├── .env.example
├── .gitignore
├── migrations/
│   └── 0001_init.sql
├── src/
│   ├── main.rs            -- axum server bootstrap
│   ├── config.rs          -- env-based config
│   ├── db.rs              -- sqlx pool + migrations runner
│   ├── jwt.rs             -- mint + verify
│   ├── error.rs           -- AppError -> HTTP
│   ├── auth.rs            -- POST /auth/exchange
│   ├── sync.rs            -- POST /sync/events, GET /sync/cursor
│   ├── profile.rs         -- GET /u/{login}, GET /u/{login}.json
│   └── templates/
│       └── profile.html   -- minijinja template
├── infra/
│   ├── provision.sh       -- one-shot az CLI script
│   └── main.bicep         -- (optional) infra as code
└── .github/
    └── workflows/
        └── deploy.yml     -- build + az webapp deploy
```

---

## Task 1: Bootstrap repo + skeleton

**Files:**
- Create: `Cargo.toml`, `src/main.rs`, `.env.example`, `.gitignore`, `README.md`

Work from: `~/Sources/covenant-server` (after running the prerequisite `gh repo create` step).

- [ ] Step 1: Initialize Cargo:

```
cargo init --name covenant-server
```

- [ ] Step 2: Replace `Cargo.toml`:

```toml
[package]
name = "covenant-server"
version = "0.1.0"
edition = "2021"

[dependencies]
axum = { version = "0.7", features = ["macros"] }
tokio = { version = "1", features = ["full"] }
tower-http = { version = "0.5", features = ["trace", "cors"] }
tracing = "0.1"
tracing-subscriber = { version = "0.3", features = ["env-filter"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.8", features = ["runtime-tokio-rustls", "postgres", "chrono", "macros", "migrate"] }
chrono = { version = "0.4", features = ["serde"] }
jsonwebtoken = "9"
reqwest = { version = "0.12", features = ["json", "rustls-tls"], default-features = false }
thiserror = "2"
anyhow = "1"
minijinja = "2"
dotenvy = "0.15"
uuid = { version = "1", features = ["v4", "serde"] }
```

- [ ] Step 3: Create `.env.example`:

```
DATABASE_URL=postgres://user:pass@localhost:5432/covenant
JWT_SECRET=replace-me-with-32-byte-random-hex
GITHUB_API_BASE=https://api.github.com
RUST_LOG=info,covenant_server=debug
PORT=8080
```

- [ ] Step 4: Create `.gitignore`:

```
/target
.env
*.swp
.DS_Store
```

- [ ] Step 5: Create `src/main.rs` (boots a healthcheck only — endpoints come later):

```rust
use axum::{routing::get, Router};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let app = Router::new().route("/healthz", get(|| async { "ok" }));

    let port: u16 = std::env::var("PORT").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
```

- [ ] Step 6: Verify build:

```
cargo run
curl http://localhost:8080/healthz   # → "ok"
```

- [ ] Step 7: Commit:

```
git add .
git commit -m "feat: bootstrap covenant-server skeleton with healthcheck"
git push origin main
```

---

## Task 2: DB schema + migrations + pool

**Files:**
- Create: `migrations/0001_init.sql`
- Create: `src/db.rs`
- Modify: `src/main.rs`

- [ ] Step 1: Create `migrations/0001_init.sql`:

```sql
CREATE TABLE users (
    github_id    BIGINT PRIMARY KEY,
    login        TEXT NOT NULL UNIQUE,
    avatar_url   TEXT NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE score_events (
    id            BIGSERIAL PRIMARY KEY,
    github_id     BIGINT NOT NULL REFERENCES users(github_id) ON DELETE CASCADE,
    client_ts_ms  BIGINT NOT NULL,
    server_ts_ms  BIGINT NOT NULL,
    day           TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('prompt','commit')),
    executor      TEXT NOT NULL,
    dedupe_key    TEXT NOT NULL,
    UNIQUE (github_id, dedupe_key)
);

CREATE INDEX idx_events_user_day ON score_events(github_id, day);
CREATE INDEX idx_events_server_ts ON score_events(server_ts_ms);
```

The `dedupe_key` is `client_ts_ms || ':' || kind || ':' || executor` — produced by the client. Idempotent upserts.

- [ ] Step 2: Create `src/db.rs`:

```rust
use sqlx::postgres::{PgPool, PgPoolOptions};

pub async fn connect(url: &str) -> anyhow::Result<PgPool> {
    let pool = PgPoolOptions::new()
        .max_connections(8)
        .connect(url).await?;
    sqlx::migrate!("./migrations").run(&pool).await?;
    Ok(pool)
}
```

- [ ] Step 3: Modify `src/main.rs` to connect and stash the pool in axum state:

```rust
use axum::{routing::get, Router, extract::State};
use sqlx::postgres::PgPool;

mod db;

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let db_url = std::env::var("DATABASE_URL")?;
    let pool = db::connect(&db_url).await?;
    let state = AppState { pool };

    let app = Router::new()
        .route("/healthz", get(|| async { "ok" }))
        .with_state(state);

    let port: u16 = std::env::var("PORT").ok()
        .and_then(|s| s.parse().ok()).unwrap_or(8080);
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    tracing::info!("listening on {}", listener.local_addr()?);
    axum::serve(listener, app).await?;
    Ok(())
}
```

- [ ] Step 4: Run a local Postgres for development (one option):

```
docker run -d --name pg -e POSTGRES_PASSWORD=pass -p 5432:5432 postgres:16
createdb -h localhost -U postgres covenant  # or via psql
```

Set `DATABASE_URL=postgres://postgres:pass@localhost:5432/covenant` in `.env`.

- [ ] Step 5: `cargo run` — migrations apply, healthcheck still works.

- [ ] Step 6: Commit:

```
git add migrations src/db.rs src/main.rs Cargo.toml
git commit -m "feat: postgres schema for users + score_events"
git push
```

---

## Task 3: JWT helpers

**Files:**
- Create: `src/jwt.rs`
- Create: `src/error.rs`
- Modify: `src/main.rs`

- [ ] Step 1: Create `src/error.rs`:

```rust
use axum::{http::StatusCode, response::{IntoResponse, Response}, Json};
use serde_json::json;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("unauthorized")]
    Unauthorized,
    #[error("not found")]
    NotFound,
    #[error("bad request: {0}")]
    BadRequest(String),
    #[error("upstream: {0}")]
    Upstream(String),
    #[error("internal: {0:#}")]
    Internal(#[from] anyhow::Error),
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let (status, msg) = match &self {
            AppError::Unauthorized => (StatusCode::UNAUTHORIZED, "unauthorized".to_string()),
            AppError::NotFound => (StatusCode::NOT_FOUND, "not found".to_string()),
            AppError::BadRequest(m) => (StatusCode::BAD_REQUEST, m.clone()),
            AppError::Upstream(m) => (StatusCode::BAD_GATEWAY, m.clone()),
            AppError::Internal(e) => {
                tracing::error!(error = %e, "internal error");
                (StatusCode::INTERNAL_SERVER_ERROR, "internal".to_string())
            }
        };
        (status, Json(json!({"error": msg}))).into_response()
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
```

- [ ] Step 2: Create `src/jwt.rs`:

```rust
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation, Algorithm};
use serde::{Deserialize, Serialize};
use crate::error::AppError;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Claims {
    pub sub: i64,         // github_id
    pub login: String,
    pub iat: i64,
    pub exp: i64,
}

pub fn mint(secret: &str, github_id: i64, login: &str) -> anyhow::Result<String> {
    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        sub: github_id,
        login: login.to_string(),
        iat: now,
        exp: now + 60 * 60 * 24 * 30,
    };
    let token = encode(
        &Header::new(Algorithm::HS256),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )?;
    Ok(token)
}

pub fn verify(secret: &str, token: &str) -> Result<Claims, AppError> {
    let v = Validation::new(Algorithm::HS256);
    decode::<Claims>(token, &DecodingKey::from_secret(secret.as_bytes()), &v)
        .map(|d| d.claims)
        .map_err(|_| AppError::Unauthorized)
}
```

- [ ] Step 3: Wire modules in `main.rs`: add `mod jwt;`, `mod error;`. Add `jwt_secret: String` to `AppState`, load from env at boot.

- [ ] Step 4: `cargo build` — clean.

- [ ] Step 5: Commit:

```
git add src/jwt.rs src/error.rs src/main.rs
git commit -m "feat: HS256 JWT mint/verify with 30-day TTL"
git push
```

---

## Task 4: POST /auth/exchange

**Files:**
- Create: `src/auth.rs`
- Modify: `src/main.rs` — mount route

- [ ] Step 1: Create `src/auth.rs`:

```rust
use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use crate::{error::{AppError, Result}, jwt, AppState};

#[derive(Debug, Deserialize)]
pub struct ExchangeReq {
    pub github_access_token: String,
}

#[derive(Debug, Serialize)]
pub struct ExchangeResp {
    pub jwt: String,
    pub login: String,
    pub avatar_url: String,
    pub github_id: i64,
}

#[derive(Debug, Deserialize)]
struct GhUser {
    id: i64,
    login: String,
    avatar_url: String,
}

pub async fn exchange(
    State(state): State<AppState>,
    Json(req): Json<ExchangeReq>,
) -> Result<Json<ExchangeResp>> {
    let api_base = std::env::var("GITHUB_API_BASE")
        .unwrap_or_else(|_| "https://api.github.com".into());
    let resp = reqwest::Client::new()
        .get(format!("{api_base}/user"))
        .header("User-Agent", "covenant-server")
        .header("Accept", "application/vnd.github+json")
        .bearer_auth(&req.github_access_token)
        .send().await
        .map_err(|e| AppError::Upstream(e.to_string()))?;
    if !resp.status().is_success() {
        return Err(AppError::Unauthorized);
    }
    let u: GhUser = resp.json().await
        .map_err(|e| AppError::Upstream(e.to_string()))?;

    sqlx::query(
        "INSERT INTO users(github_id, login, avatar_url)
         VALUES ($1, $2, $3)
         ON CONFLICT (github_id) DO UPDATE SET
            login = EXCLUDED.login,
            avatar_url = EXCLUDED.avatar_url,
            last_seen_at = NOW()"
    )
    .bind(u.id).bind(&u.login).bind(&u.avatar_url)
    .execute(&state.pool).await
    .map_err(|e| AppError::Internal(e.into()))?;

    let token = jwt::mint(&state.jwt_secret, u.id, &u.login)
        .map_err(AppError::Internal)?;
    Ok(Json(ExchangeResp {
        jwt: token,
        login: u.login,
        avatar_url: u.avatar_url,
        github_id: u.id,
    }))
}
```

- [ ] Step 2: In `main.rs`, mount the route:

```rust
.route("/auth/exchange", axum::routing::post(auth::exchange))
```

(plus `mod auth;`).

- [ ] Step 3: Manual test:

```
curl -s -X POST http://localhost:8080/auth/exchange \
  -H 'content-type: application/json' \
  -d '{"github_access_token":"ghu_REAL_TOKEN_FROM_CS2"}'
```

Should return `{"jwt":"…","login":"karluiz",…}`.

- [ ] Step 4: Commit:

```
git add src/auth.rs src/main.rs
git commit -m "feat: POST /auth/exchange — GitHub token → covenant JWT"
git push
```

---

## Task 5: Sync endpoints

**Files:**
- Create: `src/sync.rs`
- Modify: `src/main.rs`

- [ ] Step 1: Create `src/sync.rs`:

```rust
use axum::{extract::State, Json, http::HeaderMap};
use serde::{Deserialize, Serialize};
use crate::{error::{AppError, Result}, jwt, AppState};

fn bearer(headers: &HeaderMap) -> Result<&str> {
    headers.get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .ok_or(AppError::Unauthorized)
}

#[derive(Debug, Deserialize)]
pub struct PushEvent {
    pub client_ts_ms: i64,
    pub kind: String,        // "prompt" | "commit"
    pub executor: String,
    pub day: String,         // "YYYY-MM-DD" — client computes per local tz
}

#[derive(Debug, Deserialize)]
pub struct PushReq {
    pub events: Vec<PushEvent>,
}

#[derive(Debug, Serialize)]
pub struct PushResp {
    pub inserted: u64,
    pub server_cursor_ms: i64,
}

pub async fn push_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<PushReq>,
) -> Result<Json<PushResp>> {
    let token = bearer(&headers)?;
    let claims = jwt::verify(&state.jwt_secret, token)?;
    if req.events.len() > 2000 {
        return Err(AppError::BadRequest("max 2000 events per request".into()));
    }
    let now_ms = chrono::Utc::now().timestamp_millis();
    let mut inserted = 0u64;
    let mut tx = state.pool.begin().await
        .map_err(|e| AppError::Internal(e.into()))?;
    for e in &req.events {
        if e.kind != "prompt" && e.kind != "commit" {
            return Err(AppError::BadRequest(format!("bad kind: {}", e.kind)));
        }
        let dedupe = format!("{}:{}:{}", e.client_ts_ms, e.kind, e.executor);
        let r = sqlx::query(
            "INSERT INTO score_events(
                github_id, client_ts_ms, server_ts_ms, day, kind, executor, dedupe_key)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (github_id, dedupe_key) DO NOTHING"
        )
        .bind(claims.sub).bind(e.client_ts_ms).bind(now_ms)
        .bind(&e.day).bind(&e.kind).bind(&e.executor).bind(&dedupe)
        .execute(&mut *tx).await
        .map_err(|e| AppError::Internal(e.into()))?;
        inserted += r.rows_affected();
    }
    tx.commit().await.map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(PushResp { inserted, server_cursor_ms: now_ms }))
}

#[derive(Debug, Serialize)]
pub struct CursorResp {
    pub server_cursor_ms: i64,
    pub total_events: i64,
}

pub async fn cursor(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<CursorResp>> {
    let token = bearer(&headers)?;
    let claims = jwt::verify(&state.jwt_secret, token)?;
    let row: (Option<i64>, i64) = sqlx::query_as(
        "SELECT COALESCE(MAX(server_ts_ms), 0), COUNT(*)
         FROM score_events WHERE github_id = $1"
    ).bind(claims.sub).fetch_one(&state.pool).await
     .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(CursorResp {
        server_cursor_ms: row.0.unwrap_or(0),
        total_events: row.1,
    }))
}
```

- [ ] Step 2: Mount in `main.rs`:

```rust
.route("/sync/events", axum::routing::post(sync::push_events))
.route("/sync/cursor", axum::routing::get(sync::cursor))
```

Add `mod sync;`.

- [ ] Step 3: Manual test with a JWT from Task 4:

```
JWT="<paste>"
curl -s -X POST http://localhost:8080/sync/events \
  -H "authorization: Bearer $JWT" \
  -H "content-type: application/json" \
  -d '{"events":[{"client_ts_ms":1700000000000,"kind":"prompt","executor":"anthropic","day":"2024-11-14"}]}'
```

Expect `{"inserted":1,"server_cursor_ms":...}`. Re-run → `inserted: 0` (idempotent).

- [ ] Step 4: Commit:

```
git add src/sync.rs src/main.rs
git commit -m "feat: POST /sync/events + GET /sync/cursor — idempotent push sync"
git push
```

---

## Task 6: Public profile SSR

**Files:**
- Create: `src/profile.rs`
- Create: `src/templates/profile.html`
- Modify: `src/main.rs`

- [ ] Step 1: Create `src/templates/profile.html`:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>{{ login }} — Covenant Score</title>
<style>
  body { background:#050709;color:#c8d4dc;font-family:ui-monospace,SF Mono,monospace;
         margin:0;padding:40px 16px;font-size:13px; }
  .wrap { max-width:780px;margin:0 auto;background:#0a0d11;
          border:1px solid #1a2128;border-radius:10px;padding:28px; }
  h1 { color:#e8f1f5;font-size:18px;margin:0 0 6px; }
  .sub { color:#5a6873;font-size:11px;margin-bottom:20px; }
  .avatar { width:44px;height:44px;border-radius:50%;
            border:1px solid #2a5a64;vertical-align:middle;margin-right:12px; }
  .stats { display:flex;gap:14px;margin:20px 0; }
  .s { flex:1;padding:12px;background:rgba(95,179,196,0.04);
       border:1px solid #1a2a30;border-radius:6px; }
  .s .v { font-size:22px;color:#7dd3e0;font-weight:500; }
  .s .l { font-size:9px;letter-spacing:0.12em;color:#4a5860;
          text-transform:uppercase;margin-top:4px; }
  .grid { display:grid;grid-template-columns:repeat(53,10px);gap:3px;padding:4px 0; }
  .c { width:10px;height:10px;border-radius:2px;background:#0f1419;
       border:1px solid #1a2128; }
  .c.l1 { background:rgba(95,179,196,0.2);border-color:rgba(95,179,196,0.3); }
  .c.l2 { background:rgba(95,179,196,0.4);border-color:rgba(95,179,196,0.5); }
  .c.l3 { background:rgba(95,179,196,0.65);border-color:rgba(95,179,196,0.75);
          box-shadow:0 0 4px rgba(95,179,196,0.4); }
  .c.l4 { background:#5fe8d6;border-color:#5fe8d6;
          box-shadow:0 0 8px rgba(95,232,214,0.7); }
</style>
</head>
<body>
<div class="wrap">
  <h1><img class="avatar" src="{{ avatar_url }}" alt="">{{ login }}</h1>
  <div class="sub">Covenant Operator</div>
  <div class="stats">
    <div class="s"><div class="v">{{ total_prompts }}</div><div class="l">Total prompts</div></div>
    <div class="s"><div class="v">{{ total_commits }}</div><div class="l">Total commits</div></div>
    <div class="s"><div class="v">{{ today_prompts }}</div><div class="l">Today</div></div>
    <div class="s"><div class="v">{{ current_streak }}d</div><div class="l">Streak</div></div>
  </div>
  <div class="grid">
    {% for c in cells %}<div class="c {{ c.cls }}" title="{{ c.day }} — {{ c.prompts }} prompts"></div>{% endfor %}
  </div>
</div>
</body>
</html>
```

- [ ] Step 2: Create `src/profile.rs`:

```rust
use axum::{extract::{Path, State}, response::Html, Json};
use serde::Serialize;
use crate::{error::{AppError, Result}, AppState};
use minijinja::{Environment, context};

const TPL: &str = include_str!("templates/profile.html");

#[derive(Serialize)]
struct Cell { day: String, prompts: i64, cls: &'static str }

fn cls(p: i64) -> &'static str {
    match p {
        0 => "",
        1..=5 => "l1",
        6..=15 => "l2",
        16..=40 => "l3",
        _ => "l4",
    }
}

#[derive(Serialize)]
pub struct ProfileJson {
    pub login: String,
    pub avatar_url: String,
    pub total_prompts: i64,
    pub total_commits: i64,
    pub today_prompts: i64,
    pub current_streak: i64,
    pub cells: Vec<CellOut>,
}

#[derive(Serialize)]
pub struct CellOut { pub day: String, pub prompts: i64, pub commits: i64 }

async fn load(state: &AppState, login: &str)
    -> Result<(i64, String, String, Vec<CellOut>)>
{
    let user: (i64, String, String) = sqlx::query_as(
        "SELECT github_id, login, avatar_url FROM users WHERE login = $1"
    ).bind(login).fetch_optional(&state.pool).await
     .map_err(|e| AppError::Internal(e.into()))?
     .ok_or(AppError::NotFound)?;
    let rows: Vec<(String, i64, i64)> = sqlx::query_as(
        "SELECT day,
            COUNT(*) FILTER (WHERE kind='prompt')::BIGINT,
            COUNT(*) FILTER (WHERE kind='commit')::BIGINT
         FROM score_events WHERE github_id = $1
         GROUP BY day ORDER BY day ASC"
    ).bind(user.0).fetch_all(&state.pool).await
     .map_err(|e| AppError::Internal(e.into()))?;
    let cells = rows.into_iter()
        .map(|(d,p,c)| CellOut { day: d, prompts: p, commits: c })
        .collect();
    Ok((user.0, user.1, user.2, cells))
}

pub async fn profile_html(
    State(state): State<AppState>,
    Path(login): Path<String>,
) -> Result<Html<String>> {
    let (_id, login, avatar_url, cells_full) = load(&state, &login).await?;
    let total_prompts: i64 = cells_full.iter().map(|c| c.prompts).sum();
    let total_commits: i64 = cells_full.iter().map(|c| c.commits).sum();
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_prompts = cells_full.iter()
        .find(|c| c.day == today).map(|c| c.prompts).unwrap_or(0);

    // Build 53*7 cells ending today, sparse-fill from cells_full.
    use std::collections::HashMap;
    let by_day: HashMap<&str, i64> = cells_full.iter()
        .map(|c| (c.day.as_str(), c.prompts)).collect();
    let today_d = chrono::Utc::now().date_naive();
    let start = today_d - chrono::Duration::days(52*7 + today_d.weekday().num_days_from_sunday() as i64);
    let mut cells = Vec::with_capacity(53*7);
    for i in 0..53*7 {
        let d = start + chrono::Duration::days(i);
        let key = d.format("%Y-%m-%d").to_string();
        let p = by_day.get(key.as_str()).copied().unwrap_or(0);
        cells.push(Cell { day: key, prompts: p, cls: cls(p) });
    }

    let mut env = Environment::new();
    env.add_template("profile", TPL)
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    let tpl = env.get_template("profile")
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    let out = tpl.render(context! {
        login, avatar_url, total_prompts, total_commits, today_prompts,
        current_streak => streak(&cells_full),
        cells,
    }).map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    Ok(Html(out))
}

fn streak(cells: &[CellOut]) -> i64 {
    let mut run = 0i64;
    let mut prev: Option<chrono::NaiveDate> = None;
    let mut last_active: Option<chrono::NaiveDate> = None;
    for c in cells {
        if c.prompts == 0 { continue; }
        let d = match chrono::NaiveDate::parse_from_str(&c.day, "%Y-%m-%d") {
            Ok(d) => d, Err(_) => continue,
        };
        match prev {
            Some(p) if (d - p).num_days() == 1 => run += 1,
            _ => run = 1,
        }
        prev = Some(d);
        last_active = Some(d);
    }
    let today = chrono::Utc::now().date_naive();
    match last_active {
        Some(la) if (today - la).num_days() <= 1 => run,
        _ => 0,
    }
}

pub async fn profile_json(
    State(state): State<AppState>,
    Path(login): Path<String>,
) -> Result<Json<ProfileJson>> {
    let (_id, login, avatar_url, cells) = load(&state, &login).await?;
    let total_prompts = cells.iter().map(|c| c.prompts).sum();
    let total_commits = cells.iter().map(|c| c.commits).sum();
    let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let today_prompts = cells.iter()
        .find(|c| c.day == today).map(|c| c.prompts).unwrap_or(0);
    let current_streak = streak(&cells);
    Ok(Json(ProfileJson {
        login, avatar_url, total_prompts, total_commits,
        today_prompts, current_streak, cells,
    }))
}
```

- [ ] Step 3: Mount in `main.rs`:

```rust
.route("/u/:login", axum::routing::get(profile::profile_html))
.route("/u/:login.json", axum::routing::get(profile::profile_json))
```

Add `mod profile;`.

- [ ] Step 4: Manual test: `curl http://localhost:8080/u/karluiz` after a successful sync.

- [ ] Step 5: Commit:

```
git add src/profile.rs src/templates src/main.rs
git commit -m "feat: SSR public profile at /u/{login} (+ .json)"
git push
```

---

## Task 7: Azure provisioning

**Files:**
- Create: `infra/provision.sh`

- [ ] Step 1: Create `infra/provision.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Edit these once before running.
RG="covenant-score-rg"
LOCATION="centralus"
APP="covenant-score"
DB_SERVER="covenant-pg-$(uuidgen | tr 'A-Z' 'a-z' | cut -c1-6)"
DB_ADMIN="covenantadmin"
DB_PASS="$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-24)"
DB_NAME="covenant"
JWT_SECRET="$(openssl rand -hex 32)"

az group create -n "$RG" -l "$LOCATION"

# Postgres Flexible Server, Burstable B1ms
az postgres flexible-server create \
  -g "$RG" -n "$DB_SERVER" -l "$LOCATION" \
  --admin-user "$DB_ADMIN" --admin-password "$DB_PASS" \
  --tier Burstable --sku-name Standard_B1ms \
  --storage-size 32 --version 16 \
  --public-access 0.0.0.0 --yes

az postgres flexible-server db create \
  -g "$RG" --server-name "$DB_SERVER" --database-name "$DB_NAME"

# App Service plan + Web App (Linux, B1)
az appservice plan create -g "$RG" -n "${APP}-plan" --is-linux --sku B1
az webapp create -g "$RG" -p "${APP}-plan" -n "$APP" \
  --runtime "DOTNETCORE:8.0"  # placeholder — we'll deploy a custom container

# Configure app settings
DB_URL="postgres://${DB_ADMIN}:${DB_PASS}@${DB_SERVER}.postgres.database.azure.com:5432/${DB_NAME}?sslmode=require"
az webapp config appsettings set -g "$RG" -n "$APP" --settings \
  DATABASE_URL="$DB_URL" \
  JWT_SECRET="$JWT_SECRET" \
  RUST_LOG="info,covenant_server=info" \
  PORT=8080

# Custom domain + managed TLS
az webapp config hostname add -g "$RG" --webapp-name "$APP" \
  --hostname covenant.uno
az webapp config ssl create -g "$RG" --name "$APP" \
  --hostname covenant.uno
# Follow the printed verification steps (TXT + CNAME) at your registrar,
# then re-run the ssl create command once verified.

echo "DONE."
echo "DATABASE_URL=$DB_URL"
echo "JWT_SECRET=$JWT_SECRET"
echo "DNS target for covenant.uno: ${APP}.azurewebsites.net (CNAME) +"
echo "asuid TXT record per az output above."
```

- [ ] Step 2: Run:

```
chmod +x infra/provision.sh
./infra/provision.sh
```

Estimated time: 5–10 min. Cost: ~$28/mo (App Service B1 ~$13 + Postgres B1ms ~$15).

- [ ] Step 3: Update covenant.uno DNS at registrar with the CNAME + TXT records az prints. Wait for propagation (5–30 min), re-run the `az webapp config ssl create` step until it succeeds.

- [ ] Step 4: Commit:

```
git add infra
git commit -m "infra: az CLI provisioning script for App Service + Postgres"
git push
```

---

## Task 8: Deploy workflow

**Files:**
- Create: `.github/workflows/deploy.yml`

- [ ] Step 1: Create the workflow. Strategy: build a static-musl binary in CI, publish a tiny Docker image to GHCR, and `az webapp config container set` against it.

```yaml
name: deploy
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  build:
    runs-on: ubuntu-latest
    permissions: { contents: read, packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
      - run: cargo build --release --locked
      - name: docker
        run: |
          cat > Dockerfile <<'EOF'
          FROM debian:bookworm-slim
          RUN apt-get update && apt-get install -y ca-certificates && rm -rf /var/lib/apt/lists/*
          COPY target/release/covenant-server /usr/local/bin/covenant-server
          COPY migrations /migrations
          ENV PORT=8080
          EXPOSE 8080
          CMD ["/usr/local/bin/covenant-server"]
          EOF
          echo "${{ secrets.GITHUB_TOKEN }}" | docker login ghcr.io -u ${{ github.actor }} --password-stdin
          IMG=ghcr.io/${{ github.repository_owner }}/covenant-server:${{ github.sha }}
          docker build -t "$IMG" .
          docker push "$IMG"
          echo "image=$IMG" >> $GITHUB_OUTPUT
        id: img
      - uses: azure/login@v2
        with:
          creds: ${{ secrets.AZURE_CREDENTIALS }}
      - run: |
          az webapp config container set \
            -g covenant-score-rg -n covenant-score \
            --container-image-name "${{ steps.img.outputs.image }}" \
            --container-registry-url https://ghcr.io \
            --container-registry-user "${{ github.actor }}" \
            --container-registry-password "${{ secrets.GHCR_TOKEN }}"
          az webapp restart -g covenant-score-rg -n covenant-score
```

- [ ] Step 2: Manual secret setup:
  - `gh secret set AZURE_CREDENTIALS` — paste the JSON output from `az ad sp create-for-rbac --sdk-auth --role contributor --scopes /subscriptions/<SUB_ID>/resourceGroups/covenant-score-rg`.
  - `gh secret set GHCR_TOKEN` — a classic PAT with `read:packages, write:packages`.

- [ ] Step 3: Commit + push. Watch the workflow run. After it succeeds, hit `https://covenant.uno/healthz` (once DNS propagated).

- [ ] Step 4: Commit:

```
git add .github
git commit -m "ci: build + push image to GHCR + deploy to Azure Web App"
git push
```

---

## Task 9: Client-side sync engine (back in covenant repo)

Work from: `~/Sources/karlTerminal` (the Covenant client repo) — in a new worktree.

**Files:**
- Modify: `crates/score/src/auth.rs` — add `exchange_with_backend` that posts to `/auth/exchange`
- Create: `crates/score/src/sync.rs` — push loop + cursor
- Modify: `crates/score/src/store.rs` — add `unsynced_events(after_ms)` query + `mark_synced(server_cursor_ms)`
- Modify: `crates/score/src/lib.rs`
- Modify: `crates/app/src/lib.rs` — spawn sync task; expose `score_sync_now` + `score_backend_status` Tauri commands
- Modify: `ui/src/score/modal.ts` — show "Synced 2m ago" / "Sync now" footer when signed in

Note: this task uses the JWT returned by `/auth/exchange`. Store the JWT in Keychain alongside the GitHub token (separate `username`).

(Subtasks identical in shape to CS-1/CS-2 — TDD with mocked HTTP, then the integration into the app crate. Bodies omitted here for brevity; the controller dispatching this plan should write each subtask spec inline before dispatching to a subagent.)

Acceptance:
- Successful sign-in → JWT issued by server → cached in Keychain.
- Periodic sync (every 5 min while online + on app startup) pushes new events to server.
- Modal footer shows "Synced Xm ago" + a manual "Sync now" link.
- `https://covenant.uno/u/karluiz` displays the user's heatmap matching the local one within ~1 minute.

- [ ] Final commit on client:

```
git add crates/score crates/app ui/src/score
git -c commit.gpgsign=false commit -m "feat(score): client sync engine + backend status in modal

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Self-review notes

- Spec coverage (CS-3 section of design doc): server compute ✓ (App Service B1), DB ✓ (Postgres B1ms), auth (token exchange + JWT) ✓, sync push ✓, cursor ✓, public profile SSR ✓, JSON variant ✓. Estimated cost matches spec (~$28/mo).
- Out of scope for CS-3: pull-sync (multi-device merge needed only if user installs on a second device with pre-existing local history — corner case; add in CS-4 if/when needed), leaderboards, embed widgets, per-executor breakdown UI.
- Privacy preserved: server stores `executor` label (`anthropic` / `openai_compat` / `repo:sha7`) and timestamps only — never prompt text, file paths, or repo full names beyond the basename of the cwd.
- The server repo is **private**. The client repo CLAUDE.md should not gain any pointer to server internals beyond what's already in the design spec.

## Open questions for review

- **GitHub OAuth client_id rotation:** if you ever rotate it, the constant in client `auth.rs` needs a rebuild + release. Worth feeding via Azure → client config in CS-4.
- **JWT rotation strategy:** today the secret is fixed per Azure deploy; rotating it invalidates all sessions. Acceptable for v1.
- **Backups:** Azure Flexible Server has automated daily backups (7-day retention default). Consider bumping retention or adding a pg_dump cron once data > a few weeks.
