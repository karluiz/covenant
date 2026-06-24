# Operator Marketplace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in Covenant users publish their operators to a curated marketplace and search/install operators published by others, from inside the desktop app.

**Architecture:** A new `marketplace_operators` table + ~6 routes in covenant-server (Rust/Axum/Postgres) reusing the existing JWT auth. The shared unit is the operator's `soul_md` text (which excludes per-user/security state). The desktop adds a thin HTTP client + Tauri commands + a "Marketplace" tab in the existing Operators settings pane. Curation: submissions are `pending` until login `karluiz` approves them on a token-gated forge admin page.

**Tech Stack:** Rust, Axum 0.7, sqlx (Postgres), reqwest 0.12, minijinja; TypeScript, Tauri, xterm-era vanilla TS UI, vitest.

## Global Constraints

- **Two repos.** Server tasks (1–2) live in `/Users/carlosgallardoarenas/Sources/covenant-server` (separate git repo). Desktop tasks (3–6) live in `/Users/carlosgallardoarenas/Sources/karlTerminal`.
- **soul_md is the only operator payload that travels.** Never serialize/transmit `github_access`, `xp`, `is_default`, ids, or timestamps. Imported operators MUST default to `github_access: Off` — this happens for free because `operator_create_from_soul` does not read those fields from SOUL.md. Do not add them. *(security)*
- **All marketplace routes require a valid JWT** via the existing `bearer(&headers)?` + `jwt::verify(&state.jwt_secret, token)?` pattern. The admin/approve/reject routes additionally require `claims.login == "karluiz"`.
- **No new dependencies** in either repo. Server already has `uuid` (v4), `reqwest`, `minijinja`. Desktop reuses `reqwest` + `karl_score::auth`.
- **Desktop tests run from repo root:** `npm test` (vitest), `cargo test -p covenant_lib`. Server tests: `cargo test` in covenant-server.
- **English-only UI copy.** Route tooltips through `attachTooltip`, never `element.title`.
- Conventional Commits, one feature per commit.

---

## File Structure

**covenant-server:**
- Create: `migrations/0005_marketplace.sql` — table + index.
- Create: `src/marketplace.rs` — all 6 handlers + curator gate + admin HTML.
- Modify: `src/main.rs` — `mod marketplace;` + route registration.

**karlTerminal (desktop):**
- Create: `crates/app/src/marketplace.rs` — HTTP client, `MarketplaceListing`, `derive_tagline`, Tauri commands.
- Modify: `crates/app/src/lib.rs` — `mod marketplace;` + register commands in `invoke_handler`.
- Modify: `ui/src/api.ts` — `MarketplaceListing` type + 4 command wrappers.
- Create: `ui/src/settings/marketplace_install.ts` — `suffixSoulName` pure helper.
- Create: `ui/src/settings/marketplace_install.test.ts` — vitest for the helper.
- Create: `ui/src/settings/operator_marketplace.ts` — search box + card grid + install/publish/review-queue.
- Modify: `ui/src/settings/operators.ts` — Local/Marketplace tab toggle in `OperatorsPane`; publish action.
- Modify: `ui/src/settings/operators.css` (or the pane's existing stylesheet) — tab + marketplace card styles.

---

## Task 1: Server — table, submit/search/install routes

**Files:**
- Create: `/Users/carlosgallardoarenas/Sources/covenant-server/migrations/0005_marketplace.sql`
- Create: `/Users/carlosgallardoarenas/Sources/covenant-server/src/marketplace.rs`
- Modify: `/Users/carlosgallardoarenas/Sources/covenant-server/src/main.rs`

**Interfaces:**
- Consumes: `crate::sync::bearer`, `crate::jwt::{verify, Claims}` (`Claims.sub: i64`, `Claims.login: String`), `crate::error::{AppError, Result}`, `AppState { pool, jwt_secret, .. }`.
- Produces: routes `POST /marketplace/operators`, `GET /marketplace/operators`, `POST /marketplace/operators/:id/install`; pub `Listing` struct; pub `fn require_curator(&str) -> Result<()>`.

- [ ] **Step 1: Write the migration**

Create `migrations/0005_marketplace.sql`:

```sql
CREATE TABLE marketplace_operators (
  id                TEXT PRIMARY KEY,
  author_github_id  BIGINT NOT NULL,
  author_login      TEXT NOT NULL,
  name              TEXT NOT NULL,
  emoji             TEXT NOT NULL DEFAULT '🤖',
  color             TEXT NOT NULL DEFAULT '#6B7280',
  tags              JSONB NOT NULL DEFAULT '[]',
  tagline           TEXT NOT NULL DEFAULT '',
  soul_md           TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  installs          INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX marketplace_operators_status ON marketplace_operators(status);
```

- [ ] **Step 2: Write the curator-gate unit test**

In `src/marketplace.rs`, add at the bottom:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn curator_gate_allows_only_karluiz() {
        assert!(require_curator("karluiz").is_ok());
        assert!(require_curator("someone").is_err());
        assert!(require_curator("Karluiz").is_err()); // exact match, case-sensitive
    }
}
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd /Users/carlosgallardoarenas/Sources/covenant-server && cargo test marketplace`
Expected: FAIL — `marketplace` module / `require_curator` not found.

- [ ] **Step 4: Implement the module (submit/search/install + gate)**

Create `src/marketplace.rs`:

```rust
use axum::{extract::{Path, Query, State}, http::HeaderMap, Json};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{error::{AppError, Result}, jwt, sync::bearer, AppState};

const CURATOR: &str = "karluiz";

pub fn require_curator(login: &str) -> Result<()> {
    if login == CURATOR { Ok(()) } else { Err(AppError::Unauthorized) }
}

#[derive(Deserialize)]
pub struct SubmitReq {
    pub name: String,
    pub emoji: String,
    pub color: String,
    pub tags: Vec<String>,
    pub tagline: String,
    pub soul_md: String,
}

#[derive(Serialize, sqlx::FromRow)]
pub struct Listing {
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub color: String,
    pub tags: Value,
    pub tagline: String,
    pub author_login: String,
    pub installs: i32,
    pub soul_md: String,
}

pub async fn submit(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(req): Json<SubmitReq>,
) -> Result<Json<Value>> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    if req.name.trim().is_empty() || req.soul_md.trim().is_empty() {
        return Err(AppError::BadRequest("name and soul_md required".into()));
    }
    if req.soul_md.len() > 64 * 1024 {
        return Err(AppError::BadRequest("soul_md too large".into()));
    }
    let id = Uuid::new_v4().to_string();
    sqlx::query(
        "INSERT INTO marketplace_operators
           (id, author_github_id, author_login, name, emoji, color, tags, tagline, soul_md)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    )
    .bind(&id)
    .bind(claims.sub)
    .bind(&claims.login)
    .bind(req.name.trim())
    .bind(&req.emoji)
    .bind(&req.color)
    .bind(json!(req.tags))
    .bind(req.tagline.trim())
    .bind(&req.soul_md)
    .execute(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!({ "id": id, "status": "pending" })))
}

#[derive(Deserialize)]
pub struct SearchQ {
    pub q: Option<String>,
    pub tag: Option<String>,
}

pub async fn search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(sq): Query<SearchQ>,
) -> Result<Json<Vec<Listing>>> {
    jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    let pattern = sq.q
        .filter(|s| !s.trim().is_empty())
        .map(|s| format!("%{}%", s.trim().to_lowercase()));
    let rows = sqlx::query_as::<_, Listing>(
        "SELECT id, name, emoji, color, tags, tagline, author_login, installs, soul_md
           FROM marketplace_operators
          WHERE status = 'approved'
            AND ($1::text IS NULL
                 OR lower(name) LIKE $1
                 OR lower(tagline) LIKE $1
                 OR lower(tags::text) LIKE $1)
            AND ($2::text IS NULL
                 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(tags) t WHERE t = $2))
          ORDER BY installs DESC, created_at DESC
          LIMIT 200",
    )
    .bind(pattern)
    .bind(sq.tag.filter(|s| !s.trim().is_empty()))
    .fetch_all(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(rows))
}

pub async fn install(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
) -> Result<Json<Value>> {
    jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    sqlx::query(
        "UPDATE marketplace_operators SET installs = installs + 1
          WHERE id = $1 AND status = 'approved'",
    )
    .bind(&id)
    .execute(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    Ok(Json(json!({ "ok": true })))
}
```

- [ ] **Step 5: Wire routes in main.rs**

In `src/main.rs`, add `mod marketplace;` with the other `mod` lines, then add to the router (before `.with_state(state)`):

```rust
        .route("/marketplace/operators",
            axum::routing::post(marketplace::submit)
                .get(marketplace::search)
                .layer(axum::extract::DefaultBodyLimit::max(256 * 1024)))
        .route("/marketplace/operators/:id/install",
            axum::routing::post(marketplace::install))
```

- [ ] **Step 6: Run tests + build**

Run: `cd /Users/carlosgallardoarenas/Sources/covenant-server && cargo test marketplace && cargo build`
Expected: curator-gate test PASSES; build succeeds.

- [ ] **Step 7: Commit**

```bash
cd /Users/carlosgallardoarenas/Sources/covenant-server
git add migrations/0005_marketplace.sql src/marketplace.rs src/main.rs
git commit -m "feat(marketplace): operators table + submit/search/install routes"
```

---

## Task 2: Server — curated admin page (approve/reject)

**Files:**
- Modify: `/Users/carlosgallardoarenas/Sources/covenant-server/src/marketplace.rs`
- Modify: `/Users/carlosgallardoarenas/Sources/covenant-server/src/main.rs`

**Interfaces:**
- Consumes: `require_curator`, `Listing`, `jwt::verify` from Task 1.
- Produces: routes `GET /marketplace/admin?token=<jwt>`, `POST /marketplace/operators/:id/approve?token=<jwt>`, `POST /marketplace/operators/:id/reject?token=<jwt>`.
- **Browser-auth note:** the admin page is opened in a browser, which has no bearer header, so it authenticates via a `?token=<jwt>` query param. The desktop opens this URL with the token appended (Task 6). `ponytail: token-in-URL for a single-curator review page; move to a cookie session only if more curators are added.`

- [ ] **Step 1: Add admin/approve/reject handlers**

Append to `src/marketplace.rs`:

```rust
use axum::response::{Html, Redirect};

#[derive(Deserialize)]
pub struct TokenQ { pub token: String }

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

pub async fn admin(
    State(state): State<AppState>,
    Query(tq): Query<TokenQ>,
) -> Result<Html<String>> {
    let claims = jwt::verify(&state.jwt_secret, &tq.token)?;
    require_curator(&claims.login)?;
    let rows = sqlx::query_as::<_, Listing>(
        "SELECT id, name, emoji, color, tags, tagline, author_login, installs, soul_md
           FROM marketplace_operators WHERE status = 'pending'
          ORDER BY created_at ASC LIMIT 200",
    )
    .fetch_all(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;

    let t = esc(&tq.token);
    let mut items = String::new();
    for r in &rows {
        items.push_str(&format!(
            r#"<div class="card">
  <h2>{emoji} {name} <small>@{author}</small></h2>
  <p class="tagline">{tagline}</p>
  <pre>{soul}</pre>
  <form method="post" action="/marketplace/operators/{id}/approve?token={t}" style="display:inline">
    <button class="ok">Approve</button></form>
  <form method="post" action="/marketplace/operators/{id}/reject?token={t}" style="display:inline">
    <button class="no">Reject</button></form>
</div>"#,
            emoji = esc(&r.emoji), name = esc(&r.name), author = esc(&r.author_login),
            tagline = esc(&r.tagline), soul = esc(&r.soul_md), id = esc(&r.id), t = t,
        ));
    }
    if rows.is_empty() { items = "<p>No pending submissions.</p>".into(); }

    let page = format!(
        r#"<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Covenant · marketplace review</title>
<style>
 body{{font-family:ui-monospace,Menlo,monospace;background:#070b07;color:#bdeccb;max-width:820px;margin:0 auto;padding:32px 18px}}
 h1{{color:#7dffa0}} small{{color:#3f8a55}}
 .card{{border:1px solid #173d23;border-radius:8px;padding:14px 16px;margin:16px 0;background:rgba(20,40,26,.25)}}
 .tagline{{color:#9fd6b1}}
 pre{{white-space:pre-wrap;background:#050805;border:1px solid #143420;border-radius:6px;padding:10px;max-height:240px;overflow:auto}}
 button{{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid;cursor:pointer;margin-right:8px}}
 .ok{{background:#11351f;color:#7dffa0;border-color:#2a7d49}}
 .no{{background:#3a1010;color:#ffb3b3;border-color:#5e2a2a}}
</style></head><body>
<h1>marketplace · pending review</h1>
{items}
</body></html>"#,
        items = items,
    );
    Ok(Html(page))
}

pub async fn approve(
    State(state): State<AppState>,
    Query(tq): Query<TokenQ>,
    Path(id): Path<String>,
) -> Result<Redirect> {
    set_status(&state, &tq.token, &id, "approved").await?;
    Ok(Redirect::to(&format!("/marketplace/admin?token={}", tq.token)))
}

pub async fn reject(
    State(state): State<AppState>,
    Query(tq): Query<TokenQ>,
    Path(id): Path<String>,
) -> Result<Redirect> {
    set_status(&state, &tq.token, &id, "rejected").await?;
    Ok(Redirect::to(&format!("/marketplace/admin?token={}", tq.token)))
}

async fn set_status(state: &AppState, token: &str, id: &str, status: &str) -> Result<()> {
    let claims = jwt::verify(&state.jwt_secret, token)?;
    require_curator(&claims.login)?;
    sqlx::query("UPDATE marketplace_operators SET status = $1, updated_at = now() WHERE id = $2")
        .bind(status).bind(id)
        .execute(&state.pool).await
        .map_err(|e| AppError::Internal(e.into()))?;
    Ok(())
}
```

- [ ] **Step 2: Wire admin routes in main.rs**

Add to the router:

```rust
        .route("/marketplace/admin", axum::routing::get(marketplace::admin))
        .route("/marketplace/operators/:id/approve", axum::routing::post(marketplace::approve))
        .route("/marketplace/operators/:id/reject", axum::routing::post(marketplace::reject))
```

- [ ] **Step 3: Build**

Run: `cd /Users/carlosgallardoarenas/Sources/covenant-server && cargo build && cargo test marketplace`
Expected: build succeeds, curator test still PASSES.

- [ ] **Step 4: Commit**

```bash
cd /Users/carlosgallardoarenas/Sources/covenant-server
git add src/marketplace.rs src/main.rs
git commit -m "feat(marketplace): curator-gated review page with approve/reject"
```

---

## Task 3: Desktop Rust — HTTP client + Tauri commands

**Files:**
- Create: `/Users/carlosgallardoarenas/Sources/karlTerminal/crates/app/src/marketplace.rs`
- Modify: `/Users/carlosgallardoarenas/Sources/karlTerminal/crates/app/src/lib.rs`

**Interfaces:**
- Consumes: `karl_score::auth::{backend_url, load_jwt}`, `crate::soul::parse`, `crate::operator_registry::{OperatorRegistry, OperatorId}`.
- Produces: Tauri commands `marketplace_search(q, tag) -> Vec<MarketplaceListing>`, `marketplace_publish(id)`, `marketplace_install_count(id)`, `marketplace_admin_url() -> String`; pub `fn derive_tagline(&str) -> String`; pub struct `MarketplaceListing`.

- [ ] **Step 1: Write the tagline-derivation test**

Create `crates/app/src/marketplace.rs` with just the test + a stub:

```rust
pub fn derive_tagline(_soul_md: &str) -> String { String::new() }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tagline_skips_frontmatter_and_headings() {
        let soul = "---\nname: X\ntags: [a]\n---\n\n# The Guardian\n\nI move so nothing you'd regret gets through.\n";
        assert_eq!(derive_tagline(soul), "I move so nothing you'd regret gets through.");
    }
    #[test]
    fn tagline_empty_when_no_body() {
        assert_eq!(derive_tagline("---\nname: X\n---\n"), "");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal && cargo test -p covenant_lib derive_tagline`
Expected: FAIL — returns `""` not the tagline.

- [ ] **Step 3: Implement the module**

Replace the contents of `crates/app/src/marketplace.rs`:

```rust
use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::State;

use karl_score::auth;
use crate::operator_registry::{OperatorId, OperatorRegistry};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MarketplaceListing {
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub color: String,
    pub tags: Vec<String>,
    pub tagline: String,
    pub author_login: String,
    pub installs: i64,
    pub soul_md: String,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default()
}

/// First non-empty, non-heading line of the SOUL.md body (after frontmatter),
/// capped at 120 chars.
pub fn derive_tagline(soul_md: &str) -> String {
    // Strip leading YAML frontmatter if present: ---\n ... \n---\n
    let body = match soul_md.strip_prefix("---") {
        Some(rest) => rest.splitn(2, "\n---").nth(1).unwrap_or(rest),
        None => soul_md,
    };
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') { continue; }
        return t.chars().take(120).collect();
    }
    String::new()
}

async fn jwt() -> Result<String, String> {
    auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in to Covenant Cloud".to_string())
}

pub async fn publish_soul(soul_md: &str) -> Result<(), String> {
    let token = jwt().await?;
    let soul = crate::soul::parse(soul_md).map_err(|e| e.to_string())?;
    let body = json!({
        "name": soul.frontmatter.name,
        "emoji": soul.frontmatter.avatar.unwrap_or_default(),
        "color": soul.frontmatter.color,
        "tags": soul.frontmatter.tags,
        "tagline": derive_tagline(soul_md),
        "soul_md": soul_md,
    });
    client()
        .post(format!("{}/marketplace/operators", auth::backend_url()))
        .bearer_auth(&token)
        .json(&body)
        .send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn marketplace_search(
    q: Option<String>,
    tag: Option<String>,
) -> Result<Vec<MarketplaceListing>, String> {
    let token = jwt().await?;
    let mut req = client()
        .get(format!("{}/marketplace/operators", auth::backend_url()))
        .bearer_auth(&token);
    if let Some(q) = q.filter(|s| !s.is_empty()) { req = req.query(&[("q", q)]); }
    if let Some(tag) = tag.filter(|s| !s.is_empty()) { req = req.query(&[("tag", tag)]); }
    let rows = req.send().await.map_err(|e| e.to_string())?
        .error_for_status().map_err(|e| e.to_string())?
        .json::<Vec<MarketplaceListing>>().await.map_err(|e| e.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub async fn marketplace_publish(
    id: String,
    registry: State<'_, Arc<OperatorRegistry>>,
) -> Result<(), String> {
    let oid: OperatorId = id.parse().map_err(|_| "bad operator id".to_string())?;
    let soul = registry.read_soul(oid).ok_or_else(|| "operator not found".to_string())?;
    publish_soul(&soul).await
}

#[tauri::command]
pub async fn marketplace_install_count(id: String) -> Result<(), String> {
    let token = jwt().await?;
    client()
        .post(format!("{}/marketplace/operators/{}/install", auth::backend_url(), id))
        .bearer_auth(&token)
        .send().await.map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn marketplace_admin_url() -> Result<String, String> {
    let token = jwt().await?;
    Ok(format!("{}/marketplace/admin?token={}", auth::backend_url(), token))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn tagline_skips_frontmatter_and_headings() {
        let soul = "---\nname: X\ntags: [a]\n---\n\n# The Guardian\n\nI move so nothing you'd regret gets through.\n";
        assert_eq!(derive_tagline(soul), "I move so nothing you'd regret gets through.");
    }
    #[test]
    fn tagline_empty_when_no_body() {
        assert_eq!(derive_tagline("---\nname: X\n---\n"), "");
    }
}
```

Note: confirm `crate::soul::parse(...).frontmatter` field names match `operator_soul_parse` (`name`, `avatar: Option<String>`, `color`, `tags: Vec<String>`). They do per `src/operator_registry.rs:773-787`.

- [ ] **Step 4: Register module + commands in lib.rs**

In `crates/app/src/lib.rs`: add `mod marketplace;` near the other `mod` declarations. Then in the `invoke_handler![...]` list (alongside `operator_registry::commands::operator_create_from_soul` at ~line 4116) add:

```rust
            marketplace::marketplace_search,
            marketplace::marketplace_publish,
            marketplace::marketplace_install_count,
            marketplace::marketplace_admin_url,
```

- [ ] **Step 5: Run tests + build**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal && cargo test -p covenant_lib derive_tagline && cargo build -p covenant_lib`
Expected: both tagline tests PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal
git add crates/app/src/marketplace.rs crates/app/src/lib.rs
git commit -m "feat(marketplace): desktop http client + tauri commands"
```

---

## Task 4: Desktop TS — api wrappers + collision helper

**Files:**
- Modify: `/Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/api.ts`
- Create: `/Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/settings/marketplace_install.ts`
- Create: `/Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/settings/marketplace_install.test.ts`

**Interfaces:**
- Consumes: Tauri commands from Task 3; `invoke` from api.ts.
- Produces: `MarketplaceListing` (TS), `marketplaceSearch`, `marketplacePublish`, `marketplaceInstallCount`, `marketplaceAdminUrl`; `suffixSoulName(soulMd, existingLowerNames) -> string`.

- [ ] **Step 1: Write the collision-helper test**

Create `ui/src/settings/marketplace_install.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { suffixSoulName } from "./marketplace_install";

const soul = (name: string) => `---\nname: ${name}\ncolor: "#fff"\n---\n\nbody`;

describe("suffixSoulName", () => {
  it("leaves the soul untouched when no name collision", () => {
    expect(suffixSoulName(soul("Scout"), new Set(["guardian"]))).toContain("name: Scout");
  });
  it("appends (community) on collision (case-insensitive)", () => {
    const out = suffixSoulName(soul("Scout"), new Set(["scout"]));
    expect(out).toContain("name: Scout (community)");
  });
  it("bumps a counter when the suffixed name also collides", () => {
    const out = suffixSoulName(soul("Scout"), new Set(["scout", "scout (community)"]));
    expect(out).toContain("name: Scout (community 2)");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal && npm test -- marketplace_install`
Expected: FAIL — module `./marketplace_install` not found.

- [ ] **Step 3: Implement the helper**

Create `ui/src/settings/marketplace_install.ts`:

```ts
/// If the SOUL.md's `name:` collides with an existing local operator name
/// (case-insensitive — the local DB has a LOWER(name) unique index), rewrite
/// the frontmatter name with a " (community)" suffix so import never clobbers
/// an existing operator. Returns the (possibly) rewritten SOUL.md text.
export function suffixSoulName(soulMd: string, existingLower: Set<string>): string {
  const m = soulMd.match(/^name:\s*(.+)$/m);
  if (!m) return soulMd;
  const base = m[1].trim().replace(/^["']|["']$/g, "");
  if (!existingLower.has(base.toLowerCase())) return soulMd;
  let candidate = `${base} (community)`;
  let n = 2;
  while (existingLower.has(candidate.toLowerCase())) {
    candidate = `${base} (community ${n++})`;
  }
  return soulMd.replace(/^name:\s*.+$/m, `name: ${candidate}`);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal && npm test -- marketplace_install`
Expected: 3 tests PASS.

- [ ] **Step 5: Add api.ts wrappers**

In `ui/src/api.ts`, after the operator soul wrappers (~line 412), add:

```ts
export interface MarketplaceListing {
  id: string;
  name: string;
  emoji: string;
  color: string;
  tags: string[];
  tagline: string;
  author_login: string;
  installs: number;
  soul_md: string;
}

export async function marketplaceSearch(q?: string, tag?: string): Promise<MarketplaceListing[]> {
  return invoke<MarketplaceListing[]>("marketplace_search", { q: q ?? null, tag: tag ?? null });
}

export async function marketplacePublish(id: string): Promise<void> {
  return invoke<void>("marketplace_publish", { id });
}

export async function marketplaceInstallCount(id: string): Promise<void> {
  return invoke<void>("marketplace_install_count", { id });
}

export async function marketplaceAdminUrl(): Promise<string> {
  return invoke<string>("marketplace_admin_url");
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal && npm run -s build 2>&1 | tail -5` (or the project's `tsc` check)
Expected: no type errors.

```bash
git add ui/src/api.ts ui/src/settings/marketplace_install.ts ui/src/settings/marketplace_install.test.ts
git commit -m "feat(marketplace): ts api wrappers + name-collision helper"
```

---

## Task 5: Desktop UI — Marketplace tab + browse/install

**Files:**
- Create: `/Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/settings/operator_marketplace.ts`
- Modify: `/Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/settings/operators.ts`
- Modify: the Operators pane stylesheet (find via `grep -rn "operators-pane-v2" ui/src/**/*.css`)

**Interfaces:**
- Consumes: `marketplaceSearch`, `marketplaceInstallCount`, `marketplaceAdminUrl`, `operatorCreateFromSoul`, `operatorList` from api.ts; `suffixSoulName` from Task 4; `renderAvatarHtml` from `../operator/avatars`; `attachTooltip` from `../tooltip/tooltip`.
- Produces: `class MarketplacePanel { constructor(mount: HTMLElement); open(): Promise<void> }`.

- [ ] **Step 1: Implement the marketplace panel**

Create `ui/src/settings/operator_marketplace.ts`:

```ts
import {
  marketplaceSearch, marketplaceInstallCount, marketplaceAdminUrl,
  operatorCreateFromSoul, operatorList, type MarketplaceListing,
} from "../api";
import { renderAvatarHtml } from "../operator/avatars";
import { suffixSoulName } from "./marketplace_install";

/// Browse + install community operators. Lives as the "Marketplace" tab of the
/// Operators settings pane. Install reuses operator_create_from_soul; on a
/// local name collision the SOUL name is suffixed (see suffixSoulName).
export class MarketplacePanel {
  private grid: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;

  constructor(private mount: HTMLElement) {
    this.mount.innerHTML = `
      <div class="mkt">
        <div class="mkt__bar">
          <input class="mkt__search" type="search" placeholder="Search operators…" />
          <button class="mkt__review" data-role="review" type="button">Review queue</button>
        </div>
        <div class="mkt__grid" data-role="grid"></div>
      </div>`;
    this.grid = this.mount.querySelector('[data-role="grid"]');
    this.input = this.mount.querySelector(".mkt__search");
    let timer: number | undefined;
    this.input?.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void this.search(), 250);
    });
    this.mount.querySelector('[data-role="review"]')?.addEventListener("click", () => {
      void marketplaceAdminUrl().then((url) => window.open(url, "_blank"));
    });
  }

  async open(): Promise<void> { await this.search(); }

  private async search(): Promise<void> {
    if (!this.grid) return;
    const q = this.input?.value.trim() || undefined;
    this.grid.innerHTML = `<p class="mkt__empty">Loading…</p>`;
    let rows: MarketplaceListing[];
    try {
      rows = await marketplaceSearch(q);
    } catch (e) {
      this.grid.innerHTML = `<p class="mkt__empty">Sign in to Covenant Cloud to browse the marketplace.</p>`;
      return;
    }
    if (rows.length === 0) {
      this.grid.innerHTML = `<p class="mkt__empty">No operators found.</p>`;
      return;
    }
    this.grid.innerHTML = "";
    for (const r of rows) this.grid.appendChild(this.card(r));
  }

  private card(r: MarketplaceListing): HTMLElement {
    const el = document.createElement("div");
    el.className = "mkt__card";
    const tags = r.tags.slice(0, 4).map((t) => `<span class="mkt__tag">${t}</span>`).join("");
    el.innerHTML = `
      <div class="mkt__top">
        <span class="mkt__avatar" style="background:${r.color}">${renderAvatarHtml(r.emoji, 22)}</span>
        <div class="mkt__id"><strong>${r.name}</strong><small>@${r.author_login} · ${r.installs} installs</small></div>
      </div>
      <p class="mkt__tagline">${r.tagline}</p>
      <div class="mkt__tags">${tags}</div>
      <button class="mkt__install" type="button">Install</button>`;
    const btn = el.querySelector<HTMLButtonElement>(".mkt__install")!;
    btn.addEventListener("click", () => void this.install(r, btn));
    return el;
  }

  private async install(r: MarketplaceListing, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true;
    btn.textContent = "Installing…";
    try {
      const existing = new Set((await operatorList()).map((o) => o.name.toLowerCase()));
      const raw = suffixSoulName(r.soul_md, existing);
      await operatorCreateFromSoul(raw);
      marketplaceInstallCount(r.id).catch(() => {});
      btn.textContent = "Installed ✓";
      window.dispatchEvent(new CustomEvent("operators-changed"));
    } catch (e) {
      btn.disabled = false;
      btn.textContent = "Install";
    }
  }
}
```

Note: confirm the post-create refresh event name. `operators.ts:261` mentions "Notify the rest of the app — tabs/manager.ts drops the cache"; grep `grep -rn "dispatchEvent\|addEventListener" ui/src/settings/operators.ts` and reuse that exact event name instead of `"operators-changed"` if it differs.

- [ ] **Step 2: Add the Local/Marketplace toggle to OperatorsPane**

In `ui/src/settings/operators.ts`, modify the `OperatorsPane` constructor markup to add a tab strip above the grid, and lazily mount `MarketplacePanel`. Replace the constructor's `innerHTML` template and add a `showTab` method:

```ts
import { MarketplacePanel } from "./operator_marketplace";
// ...
constructor(private mount: HTMLElement) {
  this.mount.innerHTML = `
    <div class="operators-pane-v2">
      <div class="operators-pane-v2__tabs">
        <button class="op-tab is-active" data-tab="local" type="button">My operators</button>
        <button class="op-tab" data-tab="market" type="button">Marketplace</button>
      </div>
      <header class="operators-pane-v2__head" data-role="local-head">
        <button type="button" class="operators-pane-v2__new" data-role="new">${Icons.plus({ size: 15 })}<span>New operator</span></button>
      </header>
      <div class="operators-pane-v2__grid" data-role="grid"></div>
      <div class="operators-pane-v2__market" data-role="market" hidden></div>
    </div>`;
  this.grid = this.mount.querySelector('[data-role="grid"]');
  this.mount.querySelector<HTMLButtonElement>('[data-role="new"]')
    ?.addEventListener("click", () => this.startCreate());
  this.mount.querySelectorAll<HTMLButtonElement>(".op-tab").forEach((b) =>
    b.addEventListener("click", () => this.showTab(b.dataset.tab as "local" | "market")));
}

private market: MarketplacePanel | null = null;

private showTab(tab: "local" | "market"): void {
  const isLocal = tab === "local";
  this.mount.querySelectorAll<HTMLButtonElement>(".op-tab").forEach((b) =>
    b.classList.toggle("is-active", b.dataset.tab === tab));
  this.mount.querySelector<HTMLElement>('[data-role="grid"]')!.hidden = !isLocal;
  this.mount.querySelector<HTMLElement>('[data-role="local-head"]')!.hidden = !isLocal;
  const marketEl = this.mount.querySelector<HTMLElement>('[data-role="market"]')!;
  marketEl.hidden = isLocal;
  if (!isLocal && !this.market) {
    this.market = new MarketplacePanel(marketEl);
  }
  if (!isLocal) void this.market!.open();
}
```

- [ ] **Step 3: Add styles**

In the Operators pane stylesheet, add (match existing color tokens / dark theme):

```css
.operators-pane-v2__tabs { display:flex; gap:4px; margin-bottom:12px; }
.op-tab { font:inherit; padding:6px 14px; border-radius:6px; border:1px solid var(--border, #2a2a2a);
  background:transparent; color:var(--text-secondary,#9a9a9a); cursor:pointer; }
.op-tab.is-active { color:var(--text-primary,#eee); border-color:var(--accent,#6b7280); }
.mkt__bar { display:flex; gap:8px; margin-bottom:12px; }
.mkt__search { flex:1; font:inherit; padding:7px 10px; border-radius:6px;
  border:1px solid var(--border,#2a2a2a); background:var(--surface,#111); color:var(--text-primary,#eee); }
.mkt__review { font:inherit; padding:7px 12px; border-radius:6px; border:1px solid var(--border,#2a2a2a);
  background:transparent; color:var(--text-secondary,#9a9a9a); cursor:pointer; }
.mkt__grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:12px; }
.mkt__card { border:1px solid var(--border,#2a2a2a); border-radius:10px; padding:14px; background:var(--surface,#111); }
.mkt__top { display:flex; gap:10px; align-items:center; }
.mkt__avatar { width:34px; height:34px; border-radius:8px; display:grid; place-items:center; }
.mkt__id strong { display:block; } .mkt__id small { color:var(--text-secondary,#9a9a9a); }
.mkt__tagline { color:var(--text-secondary,#9a9a9a); font-size:13px; margin:10px 0; }
.mkt__tags { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px; }
.mkt__tag { font-size:11px; padding:2px 7px; border-radius:999px; border:1px solid var(--border,#2a2a2a); }
.mkt__install { width:100%; font:inherit; padding:7px; border-radius:6px; cursor:pointer;
  border:1px solid var(--accent,#6b7280); background:transparent; color:var(--text-primary,#eee); }
.mkt__empty { color:var(--text-secondary,#9a9a9a); padding:24px; text-align:center; }
```

- [ ] **Step 4: Typecheck + manual smoke**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal && npm run -s build 2>&1 | tail -5`
Expected: no type errors. (Behavior is verified in-app at the end.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/operator_marketplace.ts ui/src/settings/operators.ts ui/src/settings/*.css
git commit -m "feat(marketplace): browse/install tab in operators pane"
```

---

## Task 6: Desktop UI — Publish action on local operators

**Files:**
- Modify: `/Users/carlosgallardoarenas/Sources/karlTerminal/ui/src/settings/operators.ts`
- Possibly modify: the operator-card renderer (find via `grep -rn "renderOperatorList" ui/src/settings`)

**Interfaces:**
- Consumes: `marketplacePublish` from api.ts; existing `renderOperatorList` callbacks (`onEdit`, `onDelete`, `onDuplicate`).
- Produces: an `onPublish(op)` action wired into the local operator cards.

- [ ] **Step 1: Add an onPublish callback to the card list**

Locate `renderOperatorList` (in `operators.ts` or a sibling like `operator_card.ts` — grep first). Add an optional `onPublish?: (op: Operator) => void` to its options type and render a "Publish" button/menu item next to Edit/Duplicate/Delete:

```ts
// in the card actions row:
`<button class="op-card__action" data-role="publish">Publish</button>`
// wiring:
card.querySelector('[data-role="publish"]')
  ?.addEventListener("click", () => opts.onPublish?.(op));
```

- [ ] **Step 2: Wire it in OperatorsPane.refresh**

In `OperatorsPane.refresh()`, pass the new callback:

```ts
const list = renderOperatorList(this.operators, {
  onEdit: (op) => this.startEdit(op),
  onDelete: (op) => void this.deleteOperator(op),
  onDuplicate: (op) => this.startDuplicate(op),
  onPublish: (op) => void this.publishOperator(op),
});
```

- [ ] **Step 3: Implement publishOperator**

Add to `OperatorsPane`:

```ts
private async publishOperator(op: Operator): Promise<void> {
  try {
    await marketplacePublish(op.id);
    // reuse the app's toast/notice mechanism (grep for existing toast helper)
    this.notice(`"${op.name}" submitted — pending review.`);
  } catch (e) {
    this.notice(`Publish failed: ${e}`, true);
  }
}
```

Use the existing toast/notice utility (grep `grep -rn "toast\|showNotice\|notify(" ui/src/settings ui/src/ui` and reuse it; if none, a minimal `alert`-free inline status line). Add the `marketplacePublish` import from `../api`.

- [ ] **Step 4: Typecheck + commit**

Run: `cd /Users/carlosgallardoarenas/Sources/karlTerminal && npm run -s build 2>&1 | tail -5`
Expected: no type errors.

```bash
git add ui/src/settings/operators.ts ui/src/settings/operator_card.ts
git commit -m "feat(marketplace): publish action on local operators"
```

---

## Final verification (manual, in-app + server)

- [ ] Run the server migration against the dev DB (server boot auto-runs `sqlx::migrate!`).
- [ ] In-app: sign in to Covenant Cloud → Settings → Operators → **Publish** an operator → toast says "pending review".
- [ ] Open **Review queue** (curator only) → the submission appears → **Approve**.
- [ ] Back in-app → **Marketplace** tab → search → the operator appears → **Install** → it shows up under *My operators* with `github_access: Off`.
- [ ] Install an operator whose name collides with a local one → installs as `<name> (community)`.
- [ ] Verify a non-curator hitting `/marketplace/admin?token=<their-jwt>` gets 401.

---

## Self-Review Notes

- **Spec coverage:** trust model (curated/pending→approved) → Tasks 1–2,6; discovery in Operators pane → Task 5; curator approval on forge gated to `karluiz` → Task 2; auth on all routes → every server handler; soul_md-only interchange + `github_access: Off` → Tasks 3,5 + Global Constraints; install counter → Tasks 1,3,5; name-collision handling → Task 4.
- **No DB integration test:** covenant-server has no test-DB harness (only pure/template tests exist). Per YAGNI we don't build one; the DB lifecycle is covered by the Final Verification checklist. Pure logic (curator gate, tagline, name suffixing) is unit-tested.
- **Type consistency:** `MarketplaceListing` fields match between server `Listing`, desktop Rust struct, and TS interface (installs is i32 server / i64 Rust / number TS — JSON-compatible).
