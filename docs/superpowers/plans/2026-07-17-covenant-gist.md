# Covenant Gist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share any single file behind a secret, view-only `/g/:token` link served by forge, triggered from the file-editor header and the Files-tree right-click menu.

**Architecture:** Two repos, mirroring spec-share. Server (`covenant-server`, deployed to forge.covenant.uno) gets a flat `gists` table, a `src/gist.rs` module, and a trimmed `gist.html` view-only template. Desktop (`karlTerminal`, this repo) gets `covenant_gist.rs` (authed HTTP + local `gist_shares.json` store + 3 Tauri commands), a thin `ui/src/gist/api.ts`, a `ui/src/gist/share.ts` helper (publish → copy link → toast), and two launch points.

**Tech Stack:** Rust (axum, sqlx-Postgres, minijinja, reqwest, uuid), Tauri 2, TypeScript, Vitest.

## Global Constraints

- Token: `uuid::Uuid::new_v4().simple().to_string()` (32 hex), stored `UNIQUE`. Copy verbatim from `review.rs`.
- Revoked/unknown token → generic 404. No distinction (avoids enumeration).
- Backend base URL: `karl_score::auth::backend_url()` (`COVENANT_BACKEND_URL` or `https://forge.covenant.uno`).
- Authed HTTP goes through `auth::send_authed` (401 → refresh JWT + retry once).
- minijinja template registered under a name ending in `.html` so auto-escape fires on raw `{{ }}`.
- JSON island script-safety: `serde_json::to_string(&x)?.replace('<', "\\u003c")`.
- New UI tooltips use `attachTooltip` (`ui/src/tooltip/tooltip.ts`), never `element.title`.
- Icons: `Icons.share` from `ui/src/icons/index.ts`. Toast: `pushInfoToast` from `ui/src/notifications/toast.ts`.
- Body-limit 1 MiB on server write routes; view-only render never fetches/POSTs.
- Rendering: `md`/`markdown` → rendered markdown; everything else → `<pre>` + line-number gutter, no color.

---

## PART A — Server (repo `covenant-server`, separate checkout + deploy)

> Execute these in the `covenant-server` repo. Model everything on the existing view-only page `src/profile.rs` + `src/templates/profile.html` and the token/island/owner-gating helpers in `src/review.rs` (commit `538443a`). Copy the exact `AppState`, `AppError`, and JWT-extractor types from `review.rs` — do not invent new ones.

### Task S1: Migration + gist module + view-only template

**Files:**
- Create: `migrations/0010_gists.sql`
- Create: `src/gist.rs`
- Create: `src/templates/gist.html`
- Modify: `src/main.rs` (add `mod gist;` and route registration next to the `review` routes)

**Interfaces:**
- Produces (consumed by desktop Task D1):
  - `POST /gists` (JWT) body `{ filename: String, language: String, content: String }` → `200 { id: i64, token: String }`
  - `PUT /gists/:id` (JWT owner) body `{ filename, language, content }` → `200 {}`
  - `POST /gists/:id/revoke` (JWT owner) → `200 {}`
  - `GET /g/:token` → `text/html` (200) or generic 404.

- [ ] **Step 1: Write the migration**

`migrations/0010_gists.sql`:
```sql
CREATE TABLE gists (
    id              BIGSERIAL PRIMARY KEY,
    token           TEXT NOT NULL UNIQUE,
    filename        TEXT NOT NULL,
    language        TEXT NOT NULL,
    content         TEXT NOT NULL,
    owner_github_id BIGINT NOT NULL,
    revoked         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- [ ] **Step 2: Write `src/gist.rs` handlers**

Mirror `review.rs` types. Sketch (align extractor/error types with `review.rs`):
```rust
use axum::{extract::{Path, State}, Json};
use serde::{Deserialize, Serialize};
// reuse crate's AppState, AppError, Claims/JWT extractor, Html response — same imports as review.rs

#[derive(Deserialize)]
pub struct GistBody { pub filename: String, pub language: String, pub content: String }

#[derive(Serialize)]
pub struct GistCreated { pub id: i64, pub token: String }

async fn owned_gist(pool: &sqlx::PgPool, id: i64, owner: i64) -> Result<(), AppError> {
    let ok: Option<(i64,)> = sqlx::query_as("SELECT id FROM gists WHERE id=$1 AND owner_github_id=$2")
        .bind(id).bind(owner).fetch_optional(pool).await?;
    ok.map(|_| ()).ok_or(AppError::NotFound) // generic 404 for non-owner
}

pub async fn publish(State(st): State<AppState>, claims: Claims, Json(b): Json<GistBody>) -> Result<Json<GistCreated>, AppError> {
    let token = uuid::Uuid::new_v4().simple().to_string();
    let (id,): (i64,) = sqlx::query_as(
        "INSERT INTO gists (token, filename, language, content, owner_github_id) VALUES ($1,$2,$3,$4,$5) RETURNING id")
        .bind(&token).bind(&b.filename).bind(&b.language).bind(&b.content).bind(claims.github_id)
        .fetch_one(&st.pool).await?;
    Ok(Json(GistCreated { id, token }))
}

pub async fn update(State(st): State<AppState>, claims: Claims, Path(id): Path<i64>, Json(b): Json<GistBody>) -> Result<Json<()>, AppError> {
    owned_gist(&st.pool, id, claims.github_id).await?;
    sqlx::query("UPDATE gists SET filename=$1, language=$2, content=$3 WHERE id=$4")
        .bind(&b.filename).bind(&b.language).bind(&b.content).bind(id).execute(&st.pool).await?;
    Ok(Json(()))
}

pub async fn revoke(State(st): State<AppState>, claims: Claims, Path(id): Path<i64>) -> Result<Json<()>, AppError> {
    owned_gist(&st.pool, id, claims.github_id).await?;
    sqlx::query("UPDATE gists SET revoked=TRUE WHERE id=$1").bind(id).execute(&st.pool).await?;
    Ok(Json(()))
}

#[derive(Serialize)]
struct Island<'a> { filename: &'a str, language: &'a str, content: &'a str }

pub async fn page(State(st): State<AppState>, Path(token): Path<String>) -> Result<Html<String>, AppError> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT filename, language, content FROM gists WHERE token=$1 AND NOT revoked")
        .bind(&token).fetch_optional(&st.pool).await?;
    let (filename, language, content) = row.ok_or(AppError::NotFound)?;
    let island = Island { filename: &filename, language: &language, content: &content };
    let data_json = serde_json::to_string(&island)?.replace('<', "\\u003c");
    let mut env = minijinja::Environment::new();
    env.add_template("gist.html", include_str!("templates/gist.html"))?;
    let tpl = env.get_template("gist.html")?;
    Ok(Html(tpl.render(minijinja::context! { title => filename, data_json })?))
}
```

- [ ] **Step 3: Write `src/templates/gist.html`**

Clone `src/templates/review.html`, then delete the TOC-comments column, `#verdict-bar`, and every `fetch(...POST...)` call. Keep the JSON island + inline escape-first markdown renderer. Replace the body render with:
```html
<script type="application/json" id="gist-data">{{ data_json | safe }}</script>
<title>{{ title }}</title>
<main id="gist"></main>
<script>
  const d = JSON.parse(document.getElementById('gist-data').textContent);
  const esc = s => s.replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  const el = document.getElementById('gist');
  if (d.language === 'md' || d.language === 'markdown') {
    el.innerHTML = renderMarkdown(d.content); // reuse review.html's inline renderer fn
  } else {
    const lines = d.content.split('\n');
    const gutter = lines.map((_, i) => (i + 1)).join('\n');
    el.innerHTML =
      '<div class="code"><pre class="ln">' + esc(gutter) + '</pre><pre class="src">' + esc(d.content) + '</pre></div>';
  }
</script>
```

- [ ] **Step 4: Register routes in `src/main.rs`**

Next to the review routes:
```rust
mod gist;
// ...
.route("/gists", post(gist::publish))
.route("/gists/:id", put(gist::update))
.route("/gists/:id/revoke", post(gist::revoke))
.route("/g/:token", get(gist::page))
```
Apply the same 1 MiB body-limit layer used by `POST /specs` to `/gists` and `/gists/:id`.

- [ ] **Step 5: Tests**

`src/gist.rs` `#[cfg(test)]`:
```rust
#[test]
fn code_render_has_line_numbers() {
    // render gist.html with language="rs", content="fn a(){}\nfn b(){}"
    // assert output contains class="ln" and the digits "1" and "2"
}
#[test]
fn md_renders_markdown() {
    // language="md", content="# Hi" → output contains "<h1"
}
#[test]
fn island_is_script_safe() {
    // content = "</script><script>alert(1)" and filename = "</script>"
    // assert rendered data_json contains "\\u003c" and no literal "</script>"
}
```
If the render fns aren't unit-testable standalone, add an integration test in `tests/` that boots the router against a test DB (follow the existing review integration test), asserting `GET /g/<token>` for a code gist returns HTML with `class="ln"` and a revoked gist returns 404.

- [ ] **Step 6: Run tests**

Run: `cargo test` (in `covenant-server`)
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add migrations/0010_gists.sql src/gist.rs src/templates/gist.html src/main.rs tests
git commit -m "feat(gist): view-only file sharing via /g/:token"
```

- [ ] **Step 8: Deploy** — merge to `main`; the deploy pipeline runs `0010_gists.sql` at boot. Verify live: `GET /g/<badtoken>` → 404, `POST /gists` empty body → 422.

---

## PART B — Desktop (repo `karlTerminal`, this worktree)

### Task D1: `covenant_gist.rs` — HTTP client, store, commands

**Files:**
- Create: `crates/app/src/covenant_gist.rs`
- Modify: `crates/app/src/lib.rs` (add `mod covenant_gist;` near line 27; add commands to `generate_handler!` near line 5377)

**Interfaces:**
- Consumes: server routes from Task S1; `karl_score::auth::{backend_url, send_authed, load_jwt}`.
- Produces (consumed by Task D2): Tauri commands
  - `gist_get_share(path: String) -> Option<GistShare>`
  - `gist_publish(path: String) -> GistShare`
  - `gist_revoke(path: String) -> ()`
  - `GistShare { gistId: i64, token: String, url: String }`

- [ ] **Step 1: Write the failing tests**

`crates/app/src/covenant_gist.rs` (bottom):
```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_from_path() {
        assert_eq!(language_of("/a/b/main.rs"), "rs");
        assert_eq!(language_of("/a/b/README.md"), "md");
        assert_eq!(language_of("/a/b/Makefile"), "txt"); // no extension → txt
        assert_eq!(language_of("/a/b/archive.tar.gz"), "gz");
    }
    #[test]
    fn share_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cov-gist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("gist_shares.json");
        let mut m = load_shares(&p);
        assert!(m.is_empty());
        m.insert("/tmp/f.rs".into(), GistShare { gist_id: 7, token: "t".into(), url: "u".into() });
        save_shares(&p, &m).unwrap();
        assert_eq!(load_shares(&p).get("/tmp/f.rs").unwrap().gist_id, 7);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p covenant-app covenant_gist`
Expected: FAIL (`language_of`, `GistShare`, `load_shares` not defined)

- [ ] **Step 3: Write the module**

`crates/app/src/covenant_gist.rs` — clone the store/HTTP scaffold from `covenant_review.rs`, drop comments/activity/republish:
```rust
//! Authed HTTP client + local share-state for view-only file gists.
use karl_score::auth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GistShare {
    pub gist_id: i64,
    pub token: String,
    pub url: String,
}

/// Lowercased final path extension, or "txt" when there is none.
fn language_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "txt".to_string())
}

fn filename_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(path)
        .to_string()
}

pub fn load_shares(path: &Path) -> HashMap<String, GistShare> {
    std::fs::read_to_string(path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
}

pub fn save_shares(path: &Path, m: &HashMap<String, GistShare>) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn shares_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("gist_shares.json"))
}

fn jwt() -> Result<String, String> {
    auth::load_jwt().map_err(|e| e.to_string())?.ok_or_else(|| "not signed in to Covenant".to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder().timeout(std::time::Duration::from_secs(15)).build().unwrap_or_else(|_| reqwest::Client::new())
}

async fn send_authed(build: impl Fn(&str) -> reqwest::RequestBuilder) -> Result<reqwest::Response, String> {
    let j = jwt()?;
    auth::send_authed(&j, build).await.map_err(|e| e.to_string())?.error_for_status().map_err(|e| e.to_string())
}

async fn post_gist(filename: &str, language: &str, content: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/gists", auth::backend_url());
    let body = serde_json::json!({ "filename": filename, "language": language, "content": content });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body)).await?.json().await.map_err(|e| e.to_string())
}

async fn put_gist(id: i64, filename: &str, language: &str, content: &str) -> Result<(), String> {
    let url = format!("{}/gists/{}", auth::backend_url(), id);
    let body = serde_json::json!({ "filename": filename, "language": language, "content": content });
    send_authed(|j| client().put(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

async fn post_revoke(id: i64) -> Result<(), String> {
    let url = format!("{}/gists/{}/revoke", auth::backend_url(), id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

#[tauri::command]
pub async fn gist_get_share(app: tauri::AppHandle, path: String) -> Result<Option<GistShare>, String> {
    Ok(load_shares(&shares_path(&app)?).get(&path).cloned())
}

#[tauri::command]
pub async fn gist_publish(app: tauri::AppHandle, path: String) -> Result<GistShare, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let filename = filename_of(&path);
    let language = language_of(&path);
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    // Re-share the same file in place → keep the link.
    if let Some(existing) = shares.get(&path).cloned() {
        put_gist(existing.gist_id, &filename, &language, &content).await?;
        return Ok(existing);
    }
    let resp = post_gist(&filename, &language, &content).await?;
    let gist_id = resp["id"].as_i64().ok_or("missing id in response")?;
    let token = resp["token"].as_str().ok_or("missing token in response")?.to_string();
    let share = GistShare { gist_id, token: token.clone(), url: format!("{}/g/{}", auth::backend_url(), token) };
    shares.insert(path, share.clone());
    save_shares(&file, &shares)?;
    Ok(share)
}

#[tauri::command]
pub async fn gist_revoke(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    let share = shares.get(&path).cloned().ok_or("not shared")?;
    post_revoke(share.gist_id).await?;
    shares.remove(&path);
    save_shares(&file, &shares)
}
```

- [ ] **Step 4: Register in `lib.rs`**

Add `mod covenant_gist;` beside `mod covenant_review;` (line ~27). In `tauri::generate_handler!` (near line 5377, beside the `review_*` entries) add:
```rust
covenant_gist::gist_get_share,
covenant_gist::gist_publish,
covenant_gist::gist_revoke,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test -p covenant-app covenant_gist`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/covenant_gist.rs crates/app/src/lib.rs
git commit -m "feat(gist): desktop HTTP client + local share store + tauri commands"
```

### Task D2: TS API wrapper + share helper

**Files:**
- Create: `ui/src/gist/api.ts`
- Create: `ui/src/gist/share.ts`
- Test: `ui/src/gist/share.test.ts`

**Interfaces:**
- Consumes: Tauri commands from Task D1.
- Produces (consumed by Tasks D3, D4):
  - `gistApi.{ getShare(path), publish(path), revoke(path) }` returning `GistShare | null` / `GistShare` / `void`.
  - `shareFileAsGist(path: string): Promise<void>` — publish, copy `url` to clipboard, toast.
  - `revokeGist(path: string): Promise<void>` — revoke + toast.
  - `copyGistLink(path: string): Promise<void>` — read store, copy `url`, toast.

- [ ] **Step 1: Write the failing test**

`ui/src/gist/share.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const pushInfoToast = vi.fn();
vi.mock("../notifications/toast", () => ({ pushInfoToast }));

beforeEach(() => {
  invoke.mockReset();
  pushInfoToast.mockReset();
  Object.assign(navigator, { clipboard: { writeText: vi.fn() } });
});

it("shareFileAsGist publishes, copies link, toasts", async () => {
  invoke.mockResolvedValue({ gistId: 1, token: "abc", url: "https://forge.covenant.uno/g/abc" });
  const { shareFileAsGist } = await import("./share");
  await shareFileAsGist("/tmp/main.rs");
  expect(invoke).toHaveBeenCalledWith("gist_publish", { path: "/tmp/main.rs" });
  expect(navigator.clipboard.writeText).toHaveBeenCalledWith("https://forge.covenant.uno/g/abc");
  expect(pushInfoToast).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- gist/share`
Expected: FAIL (`./share` not found)

- [ ] **Step 3: Write `api.ts`**

`ui/src/gist/api.ts`:
```ts
import { invoke } from "@tauri-apps/api/core";

export interface GistShare {
  gistId: number;
  token: string;
  url: string;
}

export const gistApi = {
  getShare: (path: string) => invoke<GistShare | null>("gist_get_share", { path }),
  publish: (path: string) => invoke<GistShare>("gist_publish", { path }),
  revoke: (path: string) => invoke<void>("gist_revoke", { path }),
};
```

- [ ] **Step 4: Write `share.ts`**

`ui/src/gist/share.ts`:
```ts
import { gistApi } from "./api";
import { pushInfoToast } from "../notifications/toast";

export async function shareFileAsGist(path: string): Promise<void> {
  const share = await gistApi.publish(path);
  await navigator.clipboard.writeText(share.url);
  pushInfoToast({ message: "Gist link copied" });
}

export async function copyGistLink(path: string): Promise<void> {
  const share = await gistApi.getShare(path);
  if (!share) return;
  await navigator.clipboard.writeText(share.url);
  pushInfoToast({ message: "Gist link copied" });
}

export async function revokeGist(path: string): Promise<void> {
  await gistApi.revoke(path);
  pushInfoToast({ message: "Gist revoked" });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm test -- gist/share`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add ui/src/gist/api.ts ui/src/gist/share.ts ui/src/gist/share.test.ts
git commit -m "feat(gist): TS api wrapper + share/copy/revoke helper"
```

### Task D3: Files-tree right-click launch point

**Files:**
- Modify: `ui/src/structure/tree.ts` (`openContextMenu`, ~line 628–671)

**Interfaces:**
- Consumes: `shareFileAsGist`, `copyGistLink`, `revokeGist`, `gistApi.getShare` from Task D2.

- [ ] **Step 1: Add gist items to the file context menu**

In `openContextMenu`, after the "Reveal in Finder" / "Copy" block and only for files, insert a divider + gist items whose labels reflect share state. At the top of the method (files only):
```ts
import { gistApi } from "../gist/api";
import { shareFileAsGist, copyGistLink, revokeGist } from "../gist/share";
```
Then, for `node.entry.kind === "file"`, query the store before building the menu (the method is sync; do the async fetch first and reopen, OR add both label paths). Lazy approach — always show "Share as gist"; on click, `shareFileAsGist` publishes-or-updates (idempotent server-side via PUT), and add "Copy gist link" + "Revoke" that no-op if not shared:
```ts
if (node.entry.kind === "file") {
  items.push(
    { divider: true },
    { label: "Share as gist", onClick: () => void shareFileAsGist(node.entry.path).catch((e) => this.showError(`Share failed: ${e}`)) },
    { label: "Copy gist link", onClick: () => void copyGistLink(node.entry.path).catch((e) => this.showError(`Copy failed: ${e}`)) },
    { label: "Revoke gist", danger: true, onClick: () => void revokeGist(node.entry.path).catch((e) => this.showError(`Revoke failed: ${e}`)) },
  );
}
```
> ponytail: always-show three items instead of an async store lookup to pick labels. Upgrade to state-aware labels only if the flat menu confuses. Copy/Revoke silently no-op when unshared (`copyGistLink` returns early; `gist_revoke` errors "not shared" → caught into a toast).

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS (no TS errors)

- [ ] **Step 3: Commit**

```bash
git add ui/src/structure/tree.ts
git commit -m "feat(gist): share/copy/revoke in Files-tree context menu"
```

### Task D4: Editor-header share button

**Files:**
- Modify: `ui/src/structure/editor.ts` (button creation ~line 368; `open()`/`setPath` ~line 969 to reflect state)

**Interfaces:**
- Consumes: `shareFileAsGist`, `gistApi.getShare` from Task D2; `Icons.share`; `attachTooltip`.

- [ ] **Step 1: Add the share button to the header**

Beside `applySpecBtn` (~line 368):
```ts
this.shareGistBtn = document.createElement("button");
this.shareGistBtn.type = "button";
this.shareGistBtn.className = "structure-editor-share-gist-btn";
this.shareGistBtn.innerHTML = Icons.share({ size: 13 });
attachTooltip(this.shareGistBtn, "Share this file as a view-only gist");
this.shareGistBtn.addEventListener("click", () => {
  if (!this.currentPath) return;
  void shareFileAsGist(this.currentPath).catch((e) => this.setStatus(`Share failed: ${e}`));
});
this.headerEl.appendChild(this.shareGistBtn);
```
Add the field declaration `private readonly shareGistBtn: HTMLButtonElement;` beside the other button fields, and the imports:
```ts
import { shareFileAsGist } from "../gist/share";
import { attachTooltip } from "../tooltip/tooltip";
```
> Use whatever the class's existing status/error surface is (`setStatus` or the `statusEl` used by `applySpecBtn`'s neighbors) — match the sibling buttons; do not add `element.title`.

- [ ] **Step 2: Type-check**

Run: `npm run build`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add ui/src/structure/editor.ts
git commit -m "feat(gist): share button in file-editor header"
```

### Task D5: End-to-end verification

- [ ] **Step 1:** With the server deployed (Task S1 Step 8), run `npm run tauri:dev`.
- [ ] **Step 2:** Open a `.rs` file in the Structure editor → click the header share icon → confirm toast + link on clipboard.
- [ ] **Step 3:** Open the copied `/g/:token` in a browser → confirm the code renders in `<pre>` with line numbers.
- [ ] **Step 4:** Open a `.md` file, share via Files-tree right-click → confirm the browser renders markdown.
- [ ] **Step 5:** Right-click the shared file → "Revoke gist" → reload the browser tab → confirm 404.
- [ ] **Step 6:** Use the `verify` skill's DOM-dump recipe if headless confirmation of the in-app toast is needed.

---

## Self-Review

- **Spec coverage:** one-file/view-only (S1, D1); token model + 404 (Global Constraints, S1); md-vs-code rendering (S1 Step 3, D5); editor + tree launch points (D4, D3); local store keyed by path with re-share=PUT (D1); error toasts (D2–D4). ✓
- **Placeholder scan:** server handler/template code is a faithful sketch against a repo not checked out here — the two `// reuse ...` notes point at the exact precedent file (`review.rs`) to copy types from, which is the intended instruction, not a gap.
- **Type consistency:** `GistShare { gistId, token, url }` (camelCase TS ↔ `#[serde(rename_all="camelCase")]` Rust) consistent across D1/D2; command names `gist_get_share`/`gist_publish`/`gist_revoke` consistent D1↔D2; `language_of`/`filename_of` used only within D1.
