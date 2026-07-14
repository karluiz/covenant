# Spec Share & Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish a spec to the covenant server behind a secret link; a reviewer comments per section and gives a verdict in the browser; the owner sees activity in the app and republishes versions.

**Architecture:** Two repos. Server side (`~/Sources/covenant-server`, Rust/axum/sqlx/Postgres): one migration, one `src/review.rs` module, routes in the single `main.rs` chain, reviewer page as a self-contained minijinja template with client-side markdown rendering (no new Rust deps). Desktop side (`~/Sources/karlTerminal`): `crates/app/src/covenant_review.rs` HTTP client mirroring `canon_registry.rs`, share-state JSON in the app config dir, Tauri commands, `ui/src/review/` UI wired into the mission viewer modal (`ui/src/status/bar.ts`).

**Tech Stack:** axum 0.7, sqlx 0.8 (Postgres), minijinja 2, jsonwebtoken (existing `jwt::verify`), Tauri 2, TypeScript strict, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-14-spec-share-review-design.md`

## Global Constraints

- Server repo deploys from `main` only; migrations run at boot — a bad `0009_*.sql` crashes the container. Migrations are additive-only; never edit existing numbered files.
- Server builds with `cargo build --locked` in CI — if a dependency is added, commit the updated `Cargo.lock`. (This plan adds none.)
- Anchor contract (both repos, must match byte-for-byte): a heading is a line matching `^#{1,6}\s+` **outside fenced code blocks** (``` fences); `anchor_heading` = the text after the hashes, trimmed. No hashes stored.
- Limits: markdown ≤ 1 MiB, title ≤ 200 chars, comment body ≤ 16 KiB, author_name ≤ 80 chars, verdict note ≤ 4 KiB, ≤ 500 comments per spec. Verdict values: `approved` | `changes_requested`.
- Token = `uuid::Uuid::new_v4().simple().to_string()` (32 hex chars, 122 random bits — the spec's "128 bits" intent). Server returns only the token; the desktop composes the URL as `{backend_url}/r/{token}`.
- Desktop UI rules: border-radius 0 on new panels, inline SVG icons (`Icons.*`) never emoji, `attachTooltip` never `element.title`, all copy English, `npm test` runs from repo root.
- All auth-failing server responses for reviewer routes are generic 404 (revoked, unknown token).
- Work happens in git worktrees (one per repo). Conventional commits.

## Repos & branches

- Server: worktree off `origin/main` of `/Users/carlosgallardoarenas/Sources/covenant-server`, branch `feat/spec-review`. (The main checkout sits on `feat/canon-personal-org` — do not touch it.)
- Desktop: worktree off `main` of `/Users/carlosgallardoarenas/Sources/karlTerminal`, branch `feat/spec-share-review`.

---

### Task 1: Server — migration + data layer + publish endpoint

**Files:**
- Create: `migrations/0009_spec_reviews.sql`
- Create: `src/review.rs`
- Modify: `src/main.rs` (add `mod review;` and routes)
- Tests: inline `#[cfg(test)]` in `src/review.rs`

**Interfaces:**
- Produces: `POST /specs` (JWT) body `{title, markdown}` → `201 {id: i64, token: String, version: i32}`. Table shapes below are relied on by Tasks 2–3.
- Consumes: `crate::sync::bearer`, `crate::jwt::verify`, `AppState { pool, jwt_secret, .. }`, `AppError` (imitate `src/cdlc.rs`).

- [ ] **Step 1: Write the migration**

`migrations/0009_spec_reviews.sql`:

```sql
CREATE TABLE shared_specs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  owner_github_id BIGINT NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE spec_versions (
  spec_id BIGINT NOT NULL REFERENCES shared_specs(id) ON DELETE CASCADE,
  version INT NOT NULL,
  markdown TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (spec_id, version)
);

CREATE TABLE spec_comments (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  spec_id BIGINT NOT NULL REFERENCES shared_specs(id) ON DELETE CASCADE,
  version INT NOT NULL,
  anchor_heading TEXT,
  parent_id BIGINT REFERENCES spec_comments(id) ON DELETE CASCADE,
  author_name TEXT NOT NULL DEFAULT 'anonymous',
  body TEXT NOT NULL,
  resolved BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_spec_comments_spec ON spec_comments(spec_id);

CREATE TABLE spec_verdicts (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  spec_id BIGINT NOT NULL REFERENCES shared_specs(id) ON DELETE CASCADE,
  version INT NOT NULL,
  author_name TEXT NOT NULL DEFAULT 'anonymous',
  verdict TEXT NOT NULL CHECK (verdict IN ('approved','changes_requested')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_spec_verdicts_spec ON spec_verdicts(spec_id);
```

- [ ] **Step 2: Write the failing test (publish inserts spec + v1)**

In `src/review.rs` bottom (mirror `orgs.rs:292` style):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[sqlx::test(migrations = "./migrations")]
    async fn publish_creates_spec_and_v1(pool: sqlx::PgPool) {
        let out = create_spec(&pool, 42, "My Spec", "# My Spec\n\n## Goal\nhi")
            .await
            .unwrap();
        assert_eq!(out.version, 1);
        assert_eq!(out.token.len(), 32);
        let (title, revoked): (String, bool) =
            sqlx::query_as("SELECT title, revoked FROM shared_specs WHERE id = $1")
                .bind(out.id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(title, "My Spec");
        assert!(!revoked);
    }
}
```

- [ ] **Step 3: Run test to verify it fails**

Run (needs local Postgres per README: `docker run` postgres:16 + `DATABASE_URL` in `.env`): `cargo test publish_creates_spec_and_v1`
Expected: FAIL — `create_spec` not defined.

- [ ] **Step 4: Implement the data layer + handler**

`src/review.rs` (top part). Imitate `src/cdlc.rs` for imports/error style:

```rust
//! Spec share & review: publish a markdown spec behind a secret token,
//! collect per-section comments and a verdict from a reviewer page.
use crate::jwt;
use crate::sync::bearer;
use crate::{AppError, AppState};
use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::Json;
use serde::{Deserialize, Serialize};

const MAX_MARKDOWN: usize = 1024 * 1024;
const MAX_TITLE: usize = 200;
const MAX_BODY: usize = 16 * 1024;
const MAX_NAME: usize = 80;
const MAX_NOTE: usize = 4 * 1024;
const MAX_COMMENTS_PER_SPEC: i64 = 500;

#[derive(Debug, Serialize)]
pub struct PublishOut {
    pub id: i64,
    pub token: String,
    pub version: i32,
}

pub async fn create_spec(
    pool: &sqlx::PgPool,
    owner: i64,
    title: &str,
    markdown: &str,
) -> Result<PublishOut, AppError> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let mut tx = pool.begin().await?;
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO shared_specs (token, title, owner_github_id) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&token)
    .bind(title)
    .bind(owner)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO spec_versions (spec_id, version, markdown) VALUES ($1, 1, $2)")
        .bind(id)
        .bind(markdown)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(PublishOut { id, token, version: 1 })
}

#[derive(Debug, Deserialize)]
pub struct PublishIn {
    pub title: String,
    pub markdown: String,
}

pub async fn publish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PublishIn>,
) -> Result<(axum::http::StatusCode, Json<PublishOut>), AppError> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    let title = body.title.trim();
    if title.is_empty() || title.len() > MAX_TITLE || body.markdown.len() > MAX_MARKDOWN {
        return Err(AppError::BadRequest("title or markdown out of bounds".into()));
    }
    let out = create_spec(&state.pool, claims.sub, title, &body.markdown).await?;
    Ok((axum::http::StatusCode::CREATED, Json(out)))
}
```

If `AppError::BadRequest` doesn't exist, use whatever 400 variant `AppError` has (check `src/` error enum; `cdlc.rs` shows the available variants). Adjust, don't add new variants unless none fits.

- [ ] **Step 5: Register module + route**

In `src/main.rs`: add `mod review;` next to the other mods (line ~4-18), and in the router chain:

```rust
.route("/specs", axum::routing::post(review::publish))
    .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
```

Note: `.layer` on a route chain applies to routes added *before* it — follow the exact pattern used for `/sync/state` at `main.rs:63` (limit attached to the specific `.route(...)` entry).

- [ ] **Step 6: Run tests + build**

Run: `cargo test publish_creates_spec_and_v1 && cargo build`
Expected: PASS, clean build.

- [ ] **Step 7: Commit**

```bash
git add migrations/0009_spec_reviews.sql src/review.rs src/main.rs
git commit -m "feat(review): spec share tables + publish endpoint"
```

---

### Task 2: Server — owner endpoints (republish, revoke, activity, resolve)

**Files:**
- Modify: `src/review.rs`, `src/main.rs`

**Interfaces:**
- Consumes: Task 1 tables + `create_spec`.
- Produces (all JWT-authed, owner-gated — non-owner/missing → 404):
  - `POST /specs/:id/versions` body `{markdown}` → `{version: i32}`
  - `POST /specs/:id/revoke` → `204`
  - `GET /specs/:id/activity` → `ActivityOut { latest_version: i32, comments: Vec<CommentRow>, verdicts: Vec<VerdictRow> }`
  - `POST /specs/:id/comments/:cid/resolve` → `204`
  - `CommentRow { id: i64, version: i32, anchor_heading: Option<String>, parent_id: Option<i64>, author_name: String, body: String, resolved: bool, created_at: chrono::DateTime<chrono::Utc> }`
  - `VerdictRow { version: i32, author_name: String, verdict: String, note: Option<String>, created_at: chrono::DateTime<chrono::Utc> }`

- [ ] **Step 1: Write failing tests**

```rust
#[sqlx::test(migrations = "./migrations")]
async fn republish_bumps_version_and_revoke_flags(pool: sqlx::PgPool) {
    let s = create_spec(&pool, 42, "S", "# S").await.unwrap();
    let v = add_version(&pool, s.id, 42, "# S v2").await.unwrap();
    assert_eq!(v, 2);
    // wrong owner → not found
    assert!(add_version(&pool, s.id, 99, "x").await.is_err());
    revoke_spec(&pool, s.id, 42).await.unwrap();
    let (revoked,): (bool,) = sqlx::query_as("SELECT revoked FROM shared_specs WHERE id=$1")
        .bind(s.id).fetch_one(&pool).await.unwrap();
    assert!(revoked);
}

#[sqlx::test(migrations = "./migrations")]
async fn activity_returns_comments_and_latest(pool: sqlx::PgPool) {
    let s = create_spec(&pool, 42, "S", "# S").await.unwrap();
    add_comment(&pool, s.id, 1, Some("Goal"), None, "ana", "looks thin").await.unwrap();
    add_verdict(&pool, s.id, 1, "ana", "changes_requested", Some("see comment")).await.unwrap();
    let act = fetch_activity(&pool, s.id, 42).await.unwrap();
    assert_eq!(act.latest_version, 1);
    assert_eq!(act.comments.len(), 1);
    assert_eq!(act.verdicts[0].verdict, "changes_requested");
    resolve_comment(&pool, s.id, 42, act.comments[0].id).await.unwrap();
    let act = fetch_activity(&pool, s.id, 42).await.unwrap();
    assert!(act.comments[0].resolved);
}
```

- [ ] **Step 2: Run to verify failure** — `cargo test review::` → FAIL (functions undefined).

- [ ] **Step 3: Implement**

Helper functions (each owner-gated where noted) + `#[derive(sqlx::FromRow, Serialize)]` row structs:

```rust
async fn owned_spec(pool: &sqlx::PgPool, id: i64, owner: i64) -> Result<(), AppError> {
    let n: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM shared_specs WHERE id = $1 AND owner_github_id = $2",
    )
    .bind(id).bind(owner).fetch_optional(pool).await?;
    n.map(|_| ()).ok_or(AppError::NotFound)
}

pub async fn add_version(pool: &sqlx::PgPool, id: i64, owner: i64, markdown: &str) -> Result<i32, AppError> {
    owned_spec(pool, id, owner).await?;
    let (v,): (i32,) = sqlx::query_as(
        "INSERT INTO spec_versions (spec_id, version, markdown)
         SELECT $1, COALESCE(MAX(version),0)+1, $2 FROM spec_versions WHERE spec_id = $1
         RETURNING version",
    )
    .bind(id).bind(markdown).fetch_one(pool).await?;
    Ok(v)
}

pub async fn revoke_spec(pool: &sqlx::PgPool, id: i64, owner: i64) -> Result<(), AppError> {
    owned_spec(pool, id, owner).await?;
    sqlx::query("UPDATE shared_specs SET revoked = TRUE WHERE id = $1")
        .bind(id).execute(pool).await?;
    Ok(())
}

pub async fn resolve_comment(pool: &sqlx::PgPool, id: i64, owner: i64, cid: i64) -> Result<(), AppError> {
    owned_spec(pool, id, owner).await?;
    sqlx::query("UPDATE spec_comments SET resolved = TRUE WHERE id = $1 AND spec_id = $2")
        .bind(cid).bind(id).execute(pool).await?;
    Ok(())
}
```

`fetch_activity` selects latest version (`SELECT COALESCE(MAX(version),0) FROM spec_versions WHERE spec_id=$1`), all comments ordered by `created_at`, all verdicts ordered by `created_at DESC`. `add_comment`/`add_verdict` are plain INSERTs (reviewer-facing wrappers come in Task 3; define the raw helpers here since tests use them). Axum handlers wrap these: extract JWT claims exactly like Task 1, `Path<i64>` / `Path<(i64, i64)>` for ids, return `StatusCode::NO_CONTENT` for revoke/resolve.

If `AppError::NotFound` doesn't exist, reuse the existing 404-mapping variant.

- [ ] **Step 4: Run** — `cargo test review::` → PASS.

- [ ] **Step 5: Register routes** in `main.rs`:

```rust
.route("/specs/:id/versions", axum::routing::post(review::republish))
.route("/specs/:id/revoke", axum::routing::post(review::revoke))
.route("/specs/:id/activity", axum::routing::get(review::activity))
.route("/specs/:id/comments/:cid/resolve", axum::routing::post(review::resolve))
```

(`/specs/:id/versions` shares the 2 MiB body-limit layer with `POST /specs`.)

- [ ] **Step 6: Build + full test** — `cargo test && cargo build` → PASS.

- [ ] **Step 7: Commit** — `git add -u && git commit -m "feat(review): owner endpoints — republish, revoke, activity, resolve"`

---

### Task 3: Server — reviewer page + comment/verdict endpoints

**Files:**
- Create: `src/templates/review.html`
- Modify: `src/review.rs`, `src/main.rs`

**Interfaces:**
- Consumes: Task 1–2 tables/helpers.
- Produces (token-authed; revoked/unknown → 404):
  - `GET /r/:token` and `GET /r/:token/v/:n` → HTML
  - `POST /r/:token/comments` body `{anchor_heading?, parent_id?, author_name?, body}` → `201 {id: i64}`
  - `POST /r/:token/verdict` body `{author_name?, verdict, note?}` → `201`

- [ ] **Step 1: Failing tests**

```rust
#[sqlx::test(migrations = "./migrations")]
async fn reviewer_page_renders_and_404s_when_revoked(pool: sqlx::PgPool) {
    let s = create_spec(&pool, 42, "My Spec", "# My Spec\n\n## Goal\nship it").await.unwrap();
    let html = render_review_page(&pool, &s.token, None).await.unwrap();
    assert!(html.contains("review-data"));
    assert!(html.contains("My Spec"));
    revoke_spec(&pool, s.id, 42).await.unwrap();
    assert!(render_review_page(&pool, &s.token, None).await.is_err());
}

#[sqlx::test(migrations = "./migrations")]
async fn reviewer_comment_and_verdict_by_token(pool: sqlx::PgPool) {
    let s = create_spec(&pool, 42, "S", "# S\n\n## Goal\nhi").await.unwrap();
    let cid = comment_by_token(&pool, &s.token, Some("Goal"), None, Some("ana"), "too vague").await.unwrap();
    assert!(cid > 0);
    verdict_by_token(&pool, &s.token, Some("ana"), "changes_requested", None).await.unwrap();
    assert!(comment_by_token(&pool, "nope", None, None, None, "x").await.is_err());
}
```

- [ ] **Step 2: Run** — `cargo test review::` → FAIL (functions undefined).

- [ ] **Step 3: Implement token-side data helpers**

```rust
async fn spec_by_token(pool: &sqlx::PgPool, token: &str) -> Result<(i64, String), AppError> {
    // returns (id, title); revoked or unknown → NotFound (generic 404 by design)
    sqlx::query_as("SELECT id, title FROM shared_specs WHERE token = $1 AND NOT revoked")
        .bind(token).fetch_optional(pool).await?.ok_or(AppError::NotFound)
}

pub async fn comment_by_token(
    pool: &sqlx::PgPool, token: &str, anchor: Option<&str>, parent: Option<i64>,
    author: Option<&str>, body: &str,
) -> Result<i64, AppError> {
    let (id, _) = spec_by_token(pool, token).await?;
    let body = body.trim();
    let author = author.map(str::trim).filter(|a| !a.is_empty()).unwrap_or("anonymous");
    if body.is_empty() || body.len() > MAX_BODY || author.len() > MAX_NAME {
        return Err(AppError::BadRequest("comment out of bounds".into()));
    }
    let (n,): (i64,) = sqlx::query_as("SELECT COUNT(*) FROM spec_comments WHERE spec_id = $1")
        .bind(id).fetch_one(pool).await?;
    if n >= MAX_COMMENTS_PER_SPEC {
        return Err(AppError::BadRequest("comment limit reached".into()));
    }
    let (latest,): (i32,) = sqlx::query_as(
        "SELECT COALESCE(MAX(version),1) FROM spec_versions WHERE spec_id = $1",
    ).bind(id).fetch_one(pool).await?;
    let (cid,): (i64,) = sqlx::query_as(
        "INSERT INTO spec_comments (spec_id, version, anchor_heading, parent_id, author_name, body)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(id).bind(latest).bind(anchor).bind(parent).bind(author).bind(body)
    .fetch_one(pool).await?;
    Ok(cid)
}
```

`verdict_by_token` mirrors it: validate `verdict` ∈ {`approved`,`changes_requested`}, note ≤ MAX_NOTE, insert. `// ponytail: comment-count cap is the rate limit; per-IP metering only if abuse shows up.`

- [ ] **Step 4: The page — `render_review_page(pool, token, version: Option<i32>)`**

Mirror `src/profile.rs:83-129` (minijinja, `include_str!`). Build a JSON island:

```rust
#[derive(Serialize)]
struct Island {
    token: String,
    title: String,
    version: i32,          // version being shown
    latest_version: i32,
    versions: Vec<i32>,
    markdown: String,
    comments: Vec<CommentRow>,
    verdict: Option<VerdictRow>, // latest
}
// serialize then make it </script>-safe:
let data_json = serde_json::to_string(&island)?.replace('<', "\\u003c");
```

Render with `context! { title => island.title, data_json => data_json }`. In the template the island goes in `<script type="application/json" id="review-data">{{ data_json | safe }}</script>` — check how `profile.rs`/`profile.html` embed their `hud-data` island and copy that exact mechanism if it differs.

Handlers: `GET /r/:token` → latest; `GET /r/:token/v/:n` → that version or 404. Return `axum::response::Html<String>`.

- [ ] **Step 5: Write `src/templates/review.html`**

Self-contained: inline CSS + inline JS, Google Fonts link allowed (same as profile.html). Structure:

```html
<!doctype html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{{ title }} — Covenant spec review</title>
<style>
  /* dark, sharp (border-radius 0), mono accents; ~150 lines.
     Layout: fixed left TOC (240px), content column (max 760px),
     fixed footer bar with verdict buttons. */
</style>
</head><body>
<script type="application/json" id="review-data">{{ data_json | safe }}</script>
<nav id="toc"></nav>
<main id="doc"></main>
<footer id="verdict-bar">
  <span id="verdict-state"></span>
  <input id="rev-name" placeholder="Your name" maxlength="80">
  <input id="verdict-note" placeholder="Note (optional)" maxlength="4096">
  <button data-verdict="approved">Approve</button>
  <button data-verdict="changes_requested">Request changes</button>
</footer>
<script>
  // 1. const data = JSON.parse(document.getElementById('review-data').textContent)
  // 2. escape-first markdown renderer (below)
  // 3. render TOC from headings; each heading gets a "Comment" button that
  //    opens a drawer (name input persisted to localStorage 'covenant-review-name',
  //    textarea, submit → POST /r/{token}/comments then location.reload())
  // 4. render comment threads (group by anchor_heading; parent_id one-level
  //    replies; unanchored bucket first; resolved threads collapsed)
  // 5. version banner: if data.version < data.latest_version show
  //    "viewing v{n} — latest is v{latest}" link; localStorage
  //    'covenant-review-seen-{token}' for the "updated" badge
  // 6. read-only mode when data.version < data.latest_version: hide forms
  // 7. verdict buttons POST /r/{token}/verdict then reload
</script>
</body></html>
```

The markdown renderer (inline JS, escape-first — everything is HTML-escaped before any tag is emitted, so user markdown can never inject markup):

```js
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function inline(s){ // on ESCAPED text
  return s
    .replace(/`([^`]+)`/g,'<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g,'<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g,'<a href="$2" rel="noopener noreferrer" target="_blank">$1</a>');
}
function renderMd(src){
  const out=[]; let inCode=false, codeBuf=[], listOpen=false, para=[];
  const flushPara=()=>{if(para.length){out.push('<p>'+inline(esc(para.join(' ')))+'</p>');para=[]}};
  const closeList=()=>{if(listOpen){out.push('</ul>');listOpen=false}};
  for(const line of src.split('\n')){
    if(/^```/.test(line)){ flushPara(); closeList();
      if(inCode){out.push('<pre><code>'+esc(codeBuf.join('\n'))+'</code></pre>');codeBuf=[]}
      inCode=!inCode; continue }
    if(inCode){codeBuf.push(line); continue}
    const h=line.match(/^(#{1,6})\s+(.*)$/);
    if(h){ flushPara(); closeList();
      const text=h[2].trim();
      out.push('<h'+h[1].length+' data-anchor="'+esc(text)+'">'+inline(esc(text))+'</h'+h[1].length+'>');
      continue }
    const li=line.match(/^\s*[-*]\s+(.*)$/);
    if(li){ flushPara(); if(!listOpen){out.push('<ul>');listOpen=true}
      out.push('<li>'+inline(esc(li[1]))+'</li>'); continue }
    if(/^\s*$/.test(line)){ flushPara(); closeList(); continue }
    if(/^---+\s*$/.test(line)){ flushPara(); closeList(); out.push('<hr>'); continue }
    para.push(line.trim());
  }
  flushPara(); closeList();
  if(inCode) out.push('<pre><code>'+esc(codeBuf.join('\n'))+'</code></pre>');
  return out.join('\n');
}
```

`// ponytail:` no GFM tables on the reviewer page — they degrade to paragraphs; add if a real spec needs them. Headings-outside-fences logic here IS the anchor contract — heading anchors come from `data-anchor` attributes.

- [ ] **Step 6: Register routes** in `main.rs`:

```rust
.route("/r/:token", axum::routing::get(review::page))
.route("/r/:token/v/:n", axum::routing::get(review::page_version))
.route("/r/:token/comments", axum::routing::post(review::post_comment))
.route("/r/:token/verdict", axum::routing::post(review::post_verdict))
```

- [ ] **Step 7: Run everything** — `cargo test && cargo build` → PASS. Manual smoke: `cargo run`, curl `POST /specs` with a dev JWT (mint via existing auth flow or `jwt::mint` in a test), open `http://localhost:8080/r/<token>` in a browser, leave a comment, check it lands in `GET /specs/:id/activity`.

- [ ] **Step 8: Commit** — `git add -A src/templates src/review.rs src/main.rs && git commit -m "feat(review): reviewer page + token comment/verdict endpoints"`

---

### Task 4: Desktop — HTTP client, share store, Tauri commands

**Files:**
- Create: `crates/app/src/covenant_review.rs`
- Modify: `crates/app/src/lib.rs` (mod decl + `generate_handler!` list)
- Test: inline `#[cfg(test)]` in `covenant_review.rs`

**Interfaces:**
- Consumes: `karl_score::auth` (`backend_url`, `load_jwt`, `send_authed`) — copy the helper trio (`jwt()`, `client()`, `send_authed()`) verbatim from `crates/app/src/canon_registry.rs:59-84`. Server API from Tasks 1–3.
- Produces Tauri commands (registered in `lib.rs` `generate_handler!` at ~:4839):
  - `review_get_share(path: String) -> Option<ShareState>`
  - `review_publish_spec(path: String, title: String) -> ShareState`
  - `review_republish_spec(path: String) -> ShareState`
  - `review_revoke_spec(path: String) -> ()`
  - `review_activity(path: String) -> Activity`
  - `review_resolve_comment(path: String, comment_id: i64) -> ()`
  - `ShareState { spec_id: i64, token: String, url: String, version: i32, title: String }` (serde camelCase to TS)
  - `Activity { latest_version: i32, comments: Vec<ReviewComment>, verdicts: Vec<ReviewVerdict> }` with `ReviewComment { id, version, anchor_heading: Option<String>, parent_id: Option<i64>, author_name, body, resolved, created_at: String }`, `ReviewVerdict { version, author_name, verdict, note: Option<String>, created_at: String }`

- [ ] **Step 1: Failing test — share store round-trip**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cov-review-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("spec_shares.json");
        let mut m = load_shares(&p);
        assert!(m.is_empty());
        m.insert("/tmp/spec.md".into(), ShareState {
            spec_id: 1, token: "t".into(), url: "u".into(), version: 1, title: "S".into(),
        });
        save_shares(&p, &m).unwrap();
        let m2 = load_shares(&p);
        assert_eq!(m2.get("/tmp/spec.md").unwrap().version, 1);
    }
}
```

- [ ] **Step 2: Run** — `cargo test -p karl-app share_store_roundtrip` (check the app crate's package name in `crates/app/Cargo.toml` and adjust `-p`) → FAIL.

- [ ] **Step 3: Implement**

```rust
//! Authed HTTP client + local share-state for spec share & review.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareState {
    pub spec_id: i64,
    pub token: String,
    pub url: String,
    pub version: i32,
    pub title: String,
}

pub fn load_shares(path: &Path) -> HashMap<String, ShareState> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_shares(path: &Path, m: &HashMap<String, ShareState>) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn shares_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("spec_shares.json"))
}
```

HTTP calls (jwt/client/send_authed copied from `canon_registry.rs`):

```rust
async fn post_spec(title: &str, markdown: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/specs", auth::backend_url());
    let body = serde_json::json!({ "title": title, "markdown": markdown });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?.json().await.map_err(|e| e.to_string())
}
```

Commands (`#[tauri::command] pub async fn ...` in this file, like `score_sync_commands.rs`):
- `review_publish_spec(app: tauri::AppHandle, path: String, title: String)`: `std::fs::read_to_string(&path)` → `post_spec` → build `ShareState { url: format!("{}/r/{}", auth::backend_url(), token), .. }` → insert into shares map keyed by `path` → `save_shares` → return it.
- `review_republish_spec`: look up share by path (err "not shared" if absent), read file, `POST /specs/{id}/versions`, bump `version` in map, save, return.
- `review_revoke_spec`: `POST /specs/{id}/revoke`, remove from map, save.
- `review_get_share`: map lookup.
- `review_activity`: `GET /specs/{id}/activity` → `Activity` (define with `#[serde(rename_all = "camelCase")]`; server sends snake_case, so add `#[serde(alias = "latest_version")]`-style aliases or use a plain snake_case deserialize struct then convert — simplest: derive with `rename_all = "camelCase"` on Serialize only and `alias` attrs for the snake_case inputs).
- `review_resolve_comment`: `POST /specs/{id}/comments/{cid}/resolve`.

- [ ] **Step 4: Register** — in `lib.rs`: `mod covenant_review;` + add all six commands to `generate_handler![...]`.

- [ ] **Step 5: Run** — `cargo test -p <app-crate> covenant_review && cargo build -p <app-crate>` → PASS.

- [ ] **Step 6: Commit** — `git add crates/app/src/covenant_review.rs crates/app/src/lib.rs && git commit -m "feat(review): covenant-server client + share store + tauri commands"`

---

### Task 5: Desktop — reviewApi + share actions in the viewer

**Files:**
- Create: `ui/src/review/api.ts`, `ui/src/review/anchors.ts`
- Test: `ui/src/review/anchors.test.ts`
- Modify: `ui/src/status/bar.ts` (`MissionViewerModal.renderHeader()` ~:1964, `openMissionContextMenu()` ~:1150)

**Interfaces:**
- Consumes: Task 4 commands; `renderMarkdown` conventions; `pushInfoToast` from `ui/src/notifications/toast.ts:45`; `MissionInfo.path` via existing `get_session_mission`.
- Produces: `reviewApi` (shape below), `parseHeadings(md: string): string[]` used by Task 6.

- [ ] **Step 1: Failing test for the anchor parser**

`ui/src/review/anchors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseHeadings } from "./anchors";

describe("parseHeadings", () => {
  it("extracts heading text without hashes, skipping code fences", () => {
    const md = "# Title\n\n## Goal\ntext\n```\n# not a heading\n```\n### Deep One\n";
    expect(parseHeadings(md)).toEqual(["Title", "Goal", "Deep One"]);
  });
});
```

- [ ] **Step 2: Run** — from repo root: `npm test -- anchors` → FAIL.

- [ ] **Step 3: Implement `ui/src/review/anchors.ts`**

```ts
/** Anchor contract shared with the server reviewer page: headings are
 *  `#{1,6} ` lines outside ``` fences; anchor = text after hashes, trimmed. */
export function parseHeadings(md: string): string[] {
  const out: string[] = [];
  let inCode = false;
  for (const line of md.split("\n")) {
    if (/^```/.test(line)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
```

- [ ] **Step 4: Run** — `npm test -- anchors` → PASS.

- [ ] **Step 5: `ui/src/review/api.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export interface ShareState { specId: number; token: string; url: string; version: number; title: string }
export interface ReviewComment {
  id: number; version: number; anchorHeading: string | null; parentId: number | null;
  authorName: string; body: string; resolved: boolean; createdAt: string;
}
export interface ReviewVerdict { version: number; authorName: string; verdict: string; note: string | null; createdAt: string }
export interface ReviewActivity { latestVersion: number; comments: ReviewComment[]; verdicts: ReviewVerdict[] }

export const reviewApi = {
  getShare: (path: string) => invoke<ShareState | null>("review_get_share", { path }),
  publish: (path: string, title: string) => invoke<ShareState>("review_publish_spec", { path, title }),
  republish: (path: string) => invoke<ShareState>("review_republish_spec", { path }),
  revoke: (path: string) => invoke<void>("review_revoke_spec", { path }),
  activity: (path: string) => invoke<ReviewActivity>("review_activity", { path }),
  resolveComment: (path: string, commentId: number) => invoke<void>("review_resolve_comment", { path, commentId }),
};
```

- [ ] **Step 6: Viewer header actions** (`MissionViewerModal.renderHeader()`)

The modal already knows its session; fetch `getSessionMission(sessionId)` for `path` (it already does this to open — reuse the stored mission info field if one exists). Add to `.mission-viewer-actions`, before Edit:

- No share yet → button `Share for review` (SVG icon via `Icons.*`, tooltip via `attachTooltip`). Click: derive title from the first `# ` heading (fallback: filename), `reviewApi.publish(path, title)`, copy `share.url` to clipboard (`navigator.clipboard.writeText`), `pushInfoToast({ message: "Review link copied — shared as v1" })`, re-render header.
- Shared → chip `Shared · v{n}` (mirror `.status-segment` chip look; give it class `review-share-chip`). Click opens a `ContextMenu` (`ui/src/menu/context-menu.ts`) with items: **Copy link** (clipboard + toast), **Republish** (`reviewApi.republish` → toast "Republished as v{n}" → re-render), **Revoke** (danger item; `reviewApi.revoke` → toast → re-render).
- On modal open, call `reviewApi.getShare(path)` once and cache on the instance (`this.share: ShareState | null`).

- [ ] **Step 7: Mission context menu** (`openMissionContextMenu`, bar.ts:1150)

Add one item after "Change spec…": when unshared, `Share for review` (same handler as the header button); when shared, `Copy review link`. Keep it to those two — the full menu lives on the chip.

- [ ] **Step 8: Type-check + test** — `npm run build && npm test` from repo root → PASS.

- [ ] **Step 9: Commit** — `git add ui/src/review ui/src/status/bar.ts && git commit -m "feat(review): share actions in spec viewer"` (**never `git add -A`** — worktree node_modules symlink gotcha.)

---

### Task 6: Desktop — comments panel + poll + toasts

**Files:**
- Create: `ui/src/review/panel.ts`, `ui/src/review/styles.css`
- Modify: `ui/src/status/bar.ts` (mount inside `MissionViewerModal`), `ui/src/styles.css` or main CSS import point (import `review/styles.css` the same way `project-notes/styles.css` is imported)

**Interfaces:**
- Consumes: `reviewApi`, `parseHeadings`, `attachTooltip`, `pushInfoToast`, `.rail-*` row conventions (`ui/src/project-notes/commands-tab.ts:60`), interval-cleanup pattern (`ui/src/teammate/activity-view.ts:373-386`).
- Produces: `class ReviewPanel { constructor(path: string, markdown: () => string); el: HTMLElement; start(): void; stop(): void }`

- [ ] **Step 1: Implement `ReviewPanel`**

```ts
import { reviewApi, type ReviewActivity, type ReviewComment } from "./api";
import { parseHeadings } from "./anchors";
import { pushInfoToast } from "../notifications/toast";

export class ReviewPanel {
  readonly el = document.createElement("aside");
  private pollTimer: number | null = null;
  private seenIds = new Set<number>();
  private firstPoll = true;

  constructor(private path: string, private markdown: () => string) {
    this.el.className = "review-panel";
  }

  start(): void {
    void this.poll();
    this.pollTimer = window.setInterval(() => void this.poll(), 15_000);
  }
  stop(): void {
    if (this.pollTimer !== null) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  private async poll(): Promise<void> {
    let act: ReviewActivity;
    try { act = await reviewApi.activity(this.path); } catch { return; }
    const fresh = act.comments.filter((c) => !this.seenIds.has(c.id));
    for (const c of act.comments) this.seenIds.add(c.id);
    if (!this.firstPoll && fresh.length > 0) {
      pushInfoToast({ message: `${fresh.length} new review comment${fresh.length > 1 ? "s" : ""}` });
    }
    this.firstPoll = false;
    this.render(act);
  }

  private render(act: ReviewActivity): void { /* below */ }
}
```

`render(act)`:
- Verdict strip pinned on top: latest verdict → `Approved by {name}` / `Changes requested by {name}` (+note), or `No verdict yet`.
- Group unresolved-first threads by `anchorHeading`, ordered by the heading order from `parseHeadings(this.markdown())`; unanchored bucket ("General") first; replies (`parentId`) nested one level.
- Each thread: `.rail-row` with `.rail-row-line` > `.rail-name` (author + relative time), body text, `.rail-row-actions` > resolve button (SVG check icon, `attachTooltip(btn, "Mark resolved")`) → `reviewApi.resolveComment(this.path, c.id)` then re-poll.
- Resolved threads collapsed under a "Resolved (n)" fold.

- [ ] **Step 2: CSS `ui/src/review/styles.css`**

`.review-panel`: right-hand flex column inside the viewer modal, `width: 320px; border-left: 1px solid var(--border, rgba(255,255,255,.08)); overflow-y: auto; border-radius: 0;`. Verdict strip: mono uppercase label, accent color for approved / warning for changes_requested using existing tokens (`--accent`, `--fg`). All rows sharp corners; reuse `.rail-row` styles where the classes match, add `.review-*` specifics only where needed. Light theme: inputs need `appearance: none` + scoped override (light-theme input reset gotcha).

- [ ] **Step 3: Mount in the viewer modal**

In `MissionViewerModal`: when `this.share` is non-null, wrap content in a flex row and append `panel.el` beside `.mission-viewer-content`; `panel.start()` on open / after publishing, `panel.stop()` in the modal's close/teardown path (find where the modal removes its root element and unhooks listeners — put `stop()` there). Publishing from the header (Task 5) should also mount+start the panel.

- [ ] **Step 4: Verify** — `npm run build && npm test` → PASS. Manual: `npm run tauri:dev`, set a spec on a session, open viewer, Share for review, open the copied link in a browser, comment + verdict, watch them arrive in the panel within 15s and resolve one.

- [ ] **Step 5: Commit** — `git add ui/src/review ui/src/status/bar.ts ui/src/styles.css && git commit -m "feat(review): comments panel with 15s activity poll"`

---

### Task 7: Integration + finish

- [ ] Server worktree: `cargo fmt --all && cargo clippy --all-targets` clean; full `cargo test`.
- [ ] Desktop worktree: `cargo fmt --all && cargo clippy --workspace --all-targets`; `npm run build && npm test`; `cargo test --workspace` (skip known-hanging telegram tests if they block — run per-crate).
- [ ] End-to-end against local server: run covenant-server locally (`cargo run`, Postgres up), point the app at it with `COVENANT_BACKEND_URL=http://localhost:8080 npm run tauri:dev`, walk the full loop: publish → browser comment → panel shows it → resolve → republish v2 → browser badge shows update → verdict → panel pins it → revoke → link 404s.
- [ ] Merge desktop branch to `main` (fast-forward or merge commit per repo habit). Server branch: PR/merge to `main` — **merging deploys it and runs migration 0009 on prod at boot**; call that out in the PR body.
