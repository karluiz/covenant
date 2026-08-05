# Collaborative Terminal Share (read-write) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the read-only terminal share (`/t/:token`) with a `collab` mode: a GitHub-authenticated guest can request control, the owner grants it via a toast, and the guest types raw into the PTY as the single remote driver until revoked.

**Architecture:** The relay (covenant-server) gains a guest→desktop lane for collab shares only, stamping every inbound guest frame with server-verified GitHub identity. The desktop holds all write authority: a per-session `driver` slot in `AppState`, granted only by an explicit owner click, revoked by owner typing/click/disconnect. Guest bytes pass a best-effort line-assembly blocklist scan before reaching `inject_to_session`.

**Tech Stack:** Rust (axum + sqlx on server; Tauri 2 + tokio on desktop), TypeScript (ui/), xterm.js guest page (minijinja template), Postgres.

**Spec:** `docs/superpowers/specs/2026-08-05-collab-terminal-share-design.md`

## Global Constraints

- **Two repos.** Tasks 1–4 live in `covenant-server`; Tasks 5–8 in this repo (karlTerminal). Do not mix commits.
- **Server worktree:** the `~/Sources/covenant-server` main checkout is dirty on `feat/canon-personal-org`. Create an isolated worktree first:
  `git -C ~/Sources/covenant-server worktree add .covenant/worktrees/collab-term-share -b feat/collab-term-share origin/main`
  All server task paths are relative to that worktree root. Run server commands as `(cd <server-worktree> && ...)` subshells.
- **Server tests** use `#[sqlx::test(migrations = "./migrations")]` and need `DATABASE_URL` exported (a local Postgres). If unavailable, run non-DB unit tests with `cargo test --lib rc::` and note the skip in the commit body.
- **Desktop Rust:** no `unwrap()` outside `#[cfg(test)]`; `tracing` with structured fields; `cargo fmt --all` before each commit.
- **Desktop tests:** `npm test` from repo ROOT (not `ui/`); `cargo test -p covenant` for the app crate.
- **UI copy is English.** DESIGN.md hard rules: sharp corners (`border-radius: 0`), inline SVG via `Icons.*` (never emoji), `attachTooltip` (never `element.title`).
- **Wire protocol** is `{"t": "...", ...}` snake_case tagged JSON, matching the existing RC frames.
- **The existing read-only path must not change behavior**: `mode='ro'` guests keep today's exact semantics (all inbound frames dropped).
- Conventional Commits, one milestone-relevant change per commit.

## Protocol reference (used by Tasks 3, 4, 6, 7)

New frames, all JSON with tag `t`:

| Frame | Direction | Payload |
|---|---|---|
| `guest_welcome` | relay → one authed collab guest, on join | `{conn_id: u64}` |
| `request_control` | guest page → relay | `{}` |
| `input` | guest page → relay | `{b64: string}` |
| `release` | guest page → relay | `{}` |
| `guest_request_control` | relay → desktop (enriched) | `{session_id, conn_id, login, avatar}` |
| `guest_input` | relay → desktop (enriched) | `{session_id, conn_id, b64}` |
| `guest_release` | relay → desktop (enriched) | `{session_id, conn_id}` |
| `guest_roster` | relay → desktop, on authed collab guest join/leave/kick | `{session_id, guests: [{conn_id, login, avatar}]}` |
| `control_granted` | desktop → relay → guests of that session + webs | `{session_id, conn_id, login}` |
| `control_revoked` | desktop → relay → guests of that session + webs | `{session_id}` |
| `input_blocked` | desktop → relay → guests of that session | `{session_id, message}` |

The relay constructs every "enriched" frame itself from hub state — a guest can never supply `conn_id`, `login`, `avatar`, or `session_id`.

---

## Task 1: Server — `mode` column + collab-aware create (covenant-server)

**Files:**
- Create: `migrations/0017_term_share_mode.sql`
- Modify: `src/term_share.rs`
- Test: `src/term_share.rs` (inline `#[sqlx::test]` mod)

**Interfaces:**
- Produces: `create_share(pool, owner, sid, mode: &str)`; `POST /term-shares` body `{session_id, mode?}` (`mode` defaults `"ro"`); rows now carry `mode TEXT` (`'ro' | 'collab'`).
- Consumed by: Task 2 (page render), Task 3 (`guest_ws` mode lookup), Task 5 (desktop client).

- [ ] **Step 1: Write the migration**

```sql
-- migrations/0017_term_share_mode.sql
ALTER TABLE term_shares ADD COLUMN mode TEXT NOT NULL DEFAULT 'ro';
-- One live link per (owner, session, mode): a read-only link and a collab
-- link may coexist on the same session.
DROP INDEX term_shares_owner_session;
CREATE UNIQUE INDEX term_shares_owner_session_mode
    ON term_shares (owner_github_id, session_id, mode) WHERE NOT revoked;
```

- [ ] **Step 2: Write failing tests** (add to the existing `tests` mod in `src/term_share.rs`)

```rust
#[sqlx::test(migrations = "./migrations")]
async fn ro_and_collab_shares_coexist_on_one_session(pool: sqlx::PgPool) {
    let ro = create_share(&pool, 42, "sess-1", "ro").await.unwrap();
    let rw = create_share(&pool, 42, "sess-1", "collab").await.unwrap();
    assert_ne!(ro.token, rw.token);
    let (n,): (i64,) = sqlx::query_as(
        "SELECT COUNT(*) FROM term_shares WHERE session_id = 'sess-1' AND NOT revoked")
        .fetch_one(&pool).await.unwrap();
    assert_eq!(n, 2);
}

#[sqlx::test(migrations = "./migrations")]
async fn reshare_same_mode_returns_same_token(pool: sqlx::PgPool) {
    let a = create_share(&pool, 42, "sess-1", "collab").await.unwrap();
    let b = create_share(&pool, 42, "sess-1", "collab").await.unwrap();
    assert_eq!(a.token, b.token);
}

#[sqlx::test(migrations = "./migrations")]
async fn create_rejects_unknown_mode(pool: sqlx::PgPool) {
    assert!(create_share(&pool, 42, "sess-1", "yolo").await.is_err());
}
```

Also mechanically update the five existing tests: `create_share(&pool, 42, "sess-1")` → `create_share(&pool, 42, "sess-1", "ro")`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `(cd <server-worktree> && cargo test term_share)` — expect compile errors (arity), which is the failure mode here.

- [ ] **Step 4: Implement**

In `src/term_share.rs`:
- `ShareBody` gains `#[serde(default = "default_mode")] pub mode: String` with `fn default_mode() -> String { "ro".into() }`.
- `create()` handler validates `matches!(body.mode.as_str(), "ro" | "collab")`, else `AppError::BadRequest("mode must be ro or collab".into())`, and passes `&body.mode` down.
- `create_share(pool, owner, sid, mode: &str)`: add `AND mode = $3` to both SELECTs, add `mode` to the INSERT column list, and change the conflict target to
  `ON CONFLICT (owner_github_id, session_id, mode) WHERE NOT revoked DO NOTHING`.
- Guard at the top of `create_share`: `if !matches!(mode, "ro" | "collab") { return Err(AppError::BadRequest(...)); }` (so the fn is safe regardless of caller).

- [ ] **Step 5: Run tests to verify they pass**

Run: `(cd <server-worktree> && cargo test term_share)` — all green.

- [ ] **Step 6: Commit**

```bash
git add migrations/0017_term_share_mode.sql src/term_share.rs
git commit -m "feat(term-share): mode column — ro and collab links coexist per session"
```

---

## Task 2: Server — GitHub OAuth web flow for guests (covenant-server)

**Files:**
- Modify: `src/auth.rs` (extract reusable login core + add two handlers)
- Modify: `src/main.rs` (two routes)
- Test: `src/auth.rs` inline mod (pure helpers only; the GitHub round-trip is manual-verified)

**Interfaces:**
- Consumes: `jwt::mint(secret, github_id, login)`, existing user-upsert SQL from `exchange`.
- Produces: `GET /auth/github/start?token=<share token>` → 302 to GitHub; `GET /auth/github/callback?code&state` → 302 to `/t/<share token>#auth=<jwt>`. Env: `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`. Task 4's page consumes the `#auth=` fragment.

- [ ] **Step 1: Extract the login core from `exchange`**

In `src/auth.rs`, pull the body of `exchange` (GitHub `/user` fetch → upsert → mint) into:

```rust
pub async fn login_github_user(state: &AppState, access_token: &str) -> Result<ExchangeResp> {
    // identical body to today's exchange() after the Json unwrap
}
```

`exchange` becomes a thin wrapper: `login_github_user(&state, &req.github_access_token).await.map(Json)`.

- [ ] **Step 2: Write the state-cookie helpers + failing tests**

```rust
/// CSRF state = "<nonce>.<share token>"; nonce round-trips via cookie.
pub fn oauth_state(nonce: &str, share_token: &str) -> String {
    format!("{nonce}.{share_token}")
}
/// Returns the share token iff the nonce matches the cookie value.
pub fn parse_oauth_state<'a>(state: &'a str, cookie_nonce: &str) -> Option<&'a str> {
    let (nonce, token) = state.split_once('.')?;
    (nonce == cookie_nonce && !token.is_empty()).then_some(token)
}

#[cfg(test)]
mod oauth_tests {
    use super::*;
    #[test]
    fn state_round_trips() {
        let s = oauth_state("n0nce", "abc123");
        assert_eq!(parse_oauth_state(&s, "n0nce"), Some("abc123"));
    }
    #[test]
    fn state_rejects_wrong_nonce() {
        let s = oauth_state("n0nce", "abc123");
        assert_eq!(parse_oauth_state(&s, "evil"), None);
    }
    #[test]
    fn state_rejects_missing_token() {
        assert_eq!(parse_oauth_state("n0nce.", "n0nce"), None);
        assert_eq!(parse_oauth_state("garbage", "n0nce"), None);
    }
}
```

- [ ] **Step 3: Run** `cargo test oauth_` — FAIL (fns not defined) → implement helpers → PASS.

- [ ] **Step 4: Implement the two handlers**

```rust
use axum::extract::Query;
use axum::response::Redirect;

#[derive(Deserialize)]
pub struct StartQ { pub token: String }

pub async fn github_start(Query(q): Query<StartQ>) -> Result<axum::response::Response> {
    let client_id = std::env::var("GITHUB_OAUTH_CLIENT_ID")
        .map_err(|_| AppError::BadRequest("oauth not configured".into()))?;
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    let state = oauth_state(&nonce, &q.token);
    let url = format!(
        "https://github.com/login/oauth/authorize?client_id={client_id}&state={}",
        urlencoding::encode(&state)
    );
    let mut resp = Redirect::to(&url).into_response();
    resp.headers_mut().insert(
        axum::http::header::SET_COOKIE,
        format!("gh_oauth_nonce={nonce}; Path=/auth; Max-Age=600; HttpOnly; Secure; SameSite=Lax")
            .parse().map_err(|e: axum::http::header::InvalidHeaderValue| AppError::Internal(e.into()))?,
    );
    Ok(resp)
}

#[derive(Deserialize)]
pub struct CallbackQ { pub code: String, pub state: String }

pub async fn github_callback(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(q): Query<CallbackQ>,
) -> Result<Redirect> {
    let cookie_nonce = headers.get(axum::http::header::COOKIE)
        .and_then(|c| c.to_str().ok())
        .and_then(|c| c.split(';').find_map(|kv| kv.trim().strip_prefix("gh_oauth_nonce=")))
        .ok_or(AppError::Unauthorized)?;
    let share_token = parse_oauth_state(&q.state, cookie_nonce)
        .ok_or(AppError::Unauthorized)?.to_string();
    let client_id = std::env::var("GITHUB_OAUTH_CLIENT_ID")
        .map_err(|_| AppError::BadRequest("oauth not configured".into()))?;
    let secret = std::env::var("GITHUB_OAUTH_CLIENT_SECRET")
        .map_err(|_| AppError::BadRequest("oauth not configured".into()))?;
    #[derive(Deserialize)]
    struct TokResp { access_token: Option<String> }
    let tok: TokResp = reqwest::Client::new()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.as_str()), ("client_secret", secret.as_str()), ("code", q.code.as_str())])
        .send().await.map_err(|e| AppError::Upstream(e.to_string()))?
        .json().await.map_err(|e| AppError::Upstream(e.to_string()))?;
    let access = tok.access_token.ok_or(AppError::Unauthorized)?;
    let out = login_github_user(&state, &access).await?;
    Ok(Redirect::to(&format!("/t/{share_token}#auth={}", out.jwt)))
}
```

Add `urlencoding` to `Cargo.toml` only if not already a dependency — otherwise inline a tiny percent-encode of the two reserved chars (`.` and alphanumerics need none; the state is hex + `.`, so `format!` without encoding is fine — in that case drop the `urlencoding::encode` call).

- [ ] **Step 5: Wire routes** in `src/main.rs` next to `/auth/exchange`:

```rust
.route("/auth/github/start", get(auth::github_start))
.route("/auth/github/callback", get(auth::github_callback))
```

- [ ] **Step 6: Build + test** `cargo build && cargo test oauth_` — green.

- [ ] **Step 7: Commit**

```bash
git add src/auth.rs src/main.rs Cargo.toml Cargo.lock
git commit -m "feat(auth): GitHub OAuth web flow for terminal-share guests"
```

Manual follow-up (not code): register a GitHub OAuth App with callback `https://forge.covenant.uno/auth/github/callback`, set the two env vars on the App Service.

---

## Task 3: Server — collab guest lane in the RC hub (covenant-server)

**Files:**
- Modify: `src/rc.rs`
- Test: `src/rc.rs` inline `tests` mod

**Interfaces:**
- Consumes: `term_shares.mode` (Task 1), `jwt::verify`, `users.avatar_url`.
- Produces: `guest_ws` accepts `&auth=<jwt>`; `Hub::join_guest(gid, session_id, token, identity: Option<GuestIdentity>)`; `Hub::guest_route(gid, id, msg)`; enriched frames per the Protocol reference. Desktop (Task 7) consumes `guest_request_control` / `guest_input` / `guest_release` / `guest_roster`; guest page (Task 4) consumes `guest_welcome`, `control_granted`, `control_revoked`, `input_blocked`.

- [ ] **Step 1: Extend `guest_ws` auth + lookup**

```rust
#[derive(Deserialize)]
pub struct GuestAuth {
    pub token: String,
    #[serde(default)]
    pub auth: Option<String>,
}

#[derive(Clone, Debug)]
pub struct GuestIdentity { pub login: String, pub avatar: String }
```

In `guest_ws`: SELECT gains `mode` — `SELECT owner_github_id, session_id, mode FROM term_shares WHERE token = $1 AND NOT revoked`. When `mode == "collab"` and `auth.auth` is present and `jwt::verify` succeeds, fetch the avatar (`SELECT avatar_url FROM users WHERE github_id = $1`, default `""`) and build `Some(GuestIdentity { login: claims.login, avatar })`; every other combination yields `None`. Pass `identity` into `handle_guest`.

- [ ] **Step 2: Hub — identity-aware guests + failing tests**

Extend `GuestInfo` with `identity: Option<GuestIdentity>`. New/changed Hub methods:

```rust
pub fn join_guest(&self, gid: i64, session_id: &str, token: &str,
                  identity: Option<GuestIdentity>) -> (ClientId, mpsc::UnboundedReceiver<String>)
```
- unchanged behavior, plus: when `identity.is_some()`, send the guest `{"t":"guest_welcome","conn_id":<id>}` right after the presence frame, then `broadcast_roster(gid-locked-state, session_id)`.

```rust
/// Inbound frame from an AUTHED collab guest: whitelist {request_control,
/// input, release}, enrich with hub-held identity, forward to desktops.
/// Anonymous/ro guests never reach this (handle_guest drops their frames).
pub fn guest_route(&self, gid: i64, id: ClientId, msg: &str) -> usize
```
- peek `t`; build the enriched desktop frame with `serde_json::json!` (desktop parses by field name, byte order does not matter here — only the literal `mirror_*` frames need ordered fields);
- for `input`: copy `b64` through, cap `msg.len() <= 16_384` (drop oversized silently);
- unknown `t` → 0 (dropped).

```rust
fn roster_frame(session_id: &str, guests: &[(ClientId, &GuestIdentity)]) -> String
fn broadcast_roster(p: &mut Presence, session_id: &str)  // free fn over locked state
```
- roster = all authed guests of that session; sent to all desktops on authed join, authed leave, and kick.

Desktop→guest routing in `route()` (Role::Desktop arm): extend the forwarded-to-guests set from `mirror_screen|mirror_data` to also include `control_granted|control_revoked|input_blocked` (still filtered by matching `session_id`).

Tests (add to `tests` mod; follow the existing style — `join_guest` callers gain `, None` or an identity):

```rust
fn ident(login: &str) -> Option<GuestIdentity> {
    Some(GuestIdentity { login: login.into(), avatar: format!("https://a/{login}") })
}

#[test]
fn authed_guest_gets_welcome_with_conn_id() {
    let hub = Hub::default();
    let (id, mut grx) = hub.join_guest(7, "s1", "tok1", ident("nico"));
    let _ = grx.try_recv(); // presence
    let w = grx.try_recv().unwrap();
    assert!(w.contains("\"t\":\"guest_welcome\""));
    assert!(w.contains(&format!("\"conn_id\":{id}")));
}

#[test]
fn anon_guest_gets_no_welcome() {
    let hub = Hub::default();
    let (_id, mut grx) = hub.join_guest(7, "s1", "tok1", None);
    let _ = grx.try_recv(); // presence
    assert!(grx.try_recv().is_err());
}

#[test]
fn guest_route_enriches_request_control_with_hub_identity() {
    let hub = Hub::default();
    let (_d, mut drx) = hub.join(7, Role::Desktop);
    let (gid_c, mut grx) = hub.join_guest(7, "s1", "tok1", ident("nico"));
    while grx.try_recv().is_ok() {}
    while drx.try_recv().is_ok() {} // drain mirror_start + roster
    let n = hub.guest_route(7, gid_c, r#"{"t":"request_control","login":"spoofed"}"#);
    assert_eq!(n, 1);
    let f = drx.try_recv().unwrap();
    assert!(f.contains("\"t\":\"guest_request_control\""));
    assert!(f.contains("\"login\":\"nico\""), "identity comes from the hub, never the frame: {f}");
    assert!(f.contains("\"session_id\":\"s1\""));
}

#[test]
fn guest_route_drops_unknown_frame_types() {
    let hub = Hub::default();
    let (_d, mut drx) = hub.join(7, Role::Desktop);
    let (gid_c, _grx) = hub.join_guest(7, "s1", "tok1", ident("nico"));
    while drx.try_recv().is_ok() {}
    assert_eq!(hub.guest_route(7, gid_c, r#"{"t":"close_tab","session_id":"s1"}"#), 0);
    assert!(drx.try_recv().is_err());
}

#[test]
fn authed_join_and_leave_broadcast_roster_to_desktops() {
    let hub = Hub::default();
    let (_d, mut drx) = hub.join(7, Role::Desktop);
    let (gc, _grx) = hub.join_guest(7, "s1", "tok1", ident("nico"));
    let joined = (0..3).filter_map(|_| drx.try_recv().ok())
        .find(|f| f.contains("guest_roster")).unwrap();
    assert!(joined.contains("\"login\":\"nico\""));
    hub.leave_guest(7, gc);
    let left = (0..3).filter_map(|_| drx.try_recv().ok())
        .find(|f| f.contains("guest_roster")).unwrap();
    assert!(left.contains("\"guests\":[]"));
}

#[test]
fn control_frames_reach_only_matching_session_guests() {
    let hub = Hub::default();
    let (desk, _drx) = hub.join(7, Role::Desktop);
    let (_g1, mut grx1) = hub.join_guest(7, "s1", "tok1", ident("nico"));
    let (_g2, mut grx2) = hub.join_guest(7, "s2", "tok2", None);
    while grx1.try_recv().is_ok() {}
    while grx2.try_recv().is_ok() {}
    hub.route(7, Role::Desktop, desk,
        r#"{"t":"control_granted","session_id":"s1","conn_id":9,"login":"nico"}"#.into());
    assert!(grx1.try_recv().unwrap().contains("control_granted"));
    assert!(grx2.try_recv().is_err());
}
```

- [ ] **Step 3: Run** `cargo test rc::` — FAIL → implement Step 2 → PASS. Existing `join_guest` call sites in tests get `, None`.

- [ ] **Step 4: `handle_guest` inbound loop**

Replace the drop-everything arm: when the guest has an identity (pass a `bool authed` or the identity into `handle_guest`), `Some(Ok(Message::Text(text)))` calls `hub.guest_route(gid, id, &text)`; anonymous guests keep the current drop behavior verbatim.

- [ ] **Step 5: Full server test run** `cargo test` (or `cargo test --lib` if no DATABASE_URL) — green.

- [ ] **Step 6: Commit**

```bash
git add src/rc.rs
git commit -m "feat(rc): collab guest lane — verified identity, enriched frames, roster"
```

---

## Task 4: Server — collab guest page (covenant-server)

**Files:**
- Modify: `src/templates/term.html`, `src/term_share.rs` (pass `mode` to the template)

**Interfaces:**
- Consumes: `#auth=` fragment (Task 2), `guest_welcome` / `control_granted` / `control_revoked` / `input_blocked` frames (Task 3).
- Produces: guest page that can request/release control and send `input` frames.

- [ ] **Step 1: Template context gains `can_write`**

In `render_term_page`, SELECT gains `ts.mode`; render context gains `can_write => mode == "collab"`. Update the two render-affecting tests' expectations if any assert on exact HTML (the token-island test keeps passing — it greps a substring).

- [ ] **Step 2: Template head changes** (inside `{% if can_write %}` minijinja blocks)

- Chip block replaces the hardwired `READ-ONLY` chip:
  ```html
  {% if can_write %}
  <span class="chip" id="ctl-chip">VIEWING</span>
  <button class="chip" id="ctl-btn" type="button">REQUEST CONTROL</button>
  {% else %}
  <span class="chip">READ-ONLY</span>
  {% endif %}
  ```
- CSS: `#ctl-btn { cursor: pointer; background: transparent; appearance: none; }` and a driving state `#ctl-chip[data-driving="true"] { border-color: var(--ok); color: var(--ok); }`. Keep sharp corners (no border-radius anywhere new).

- [ ] **Step 3: Template JS** (append inside the existing script, guarded by `var CAN_WRITE = {{ "true" if can_write else "false" }};`)

```js
// --- collab (write) lane -------------------------------------------------
var CAN_WRITE = {{ "true" if can_write else "false" }};
var myConn = 0, driving = false, jwt = null, wsRef = null;
if (CAN_WRITE) {
  // OAuth callback hands the JWT back in the fragment; stash + scrub URL.
  if (location.hash.indexOf("#auth=") === 0) {
    localStorage.setItem("covenant_guest_jwt", location.hash.slice(6));
    history.replaceState(null, "", location.pathname);
  }
  jwt = localStorage.getItem("covenant_guest_jwt");
  var chip = document.getElementById("ctl-chip");
  var btn = document.getElementById("ctl-btn");
  function setDriving(on, byWho) {
    driving = on;
    term.options.disableStdin = !on;
    chip.dataset.driving = on ? "true" : "false";
    chip.textContent = on ? "YOU ARE DRIVING" : (byWho ? "DRIVING: " + byWho : "VIEWING");
    btn.textContent = on ? "RELEASE" : "REQUEST CONTROL";
  }
  btn.onclick = function () {
    if (driving) { wsRef && wsRef.send(JSON.stringify({ t: "release" })); setDriving(false); return; }
    if (!jwt) { location.href = "/auth/github/start?token=" + encodeURIComponent(TOKEN); return; }
    wsRef && wsRef.send(JSON.stringify({ t: "request_control" }));
    btn.textContent = "REQUESTED…";
  };
  var enc = new TextEncoder();
  term.onData(function (d) {
    if (!driving || !wsRef) return;
    var bytes = enc.encode(d), bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    wsRef.send(JSON.stringify({ t: "input", b64: btoa(bin) }));
  });
}
```

In `connect()`: append `&auth=` when present —
```js
var qs = "?token=" + encodeURIComponent(TOKEN);
if (CAN_WRITE && jwt) qs += "&auth=" + encodeURIComponent(jwt);
var ws = new WebSocket(proto + "://" + location.host + "/rc/guest" + qs);
wsRef = ws;
```
And in `ws.onmessage`, new branches before the final `else`:
```js
} else if (f.t === "guest_welcome") {
  myConn = f.conn_id;
} else if (f.t === "control_granted") {
  if (CAN_WRITE) setDriving(f.conn_id === myConn, f.login);
} else if (f.t === "control_revoked") {
  if (CAN_WRITE) setDriving(false);
} else if (f.t === "input_blocked") {
  if (CAN_WRITE && driving) {
    document.getElementById("foot-text").textContent = "Blocked: " + f.message;
  }
}
```
On `ws.onclose`, `setDriving(false)` when `CAN_WRITE` (a reconnected socket starts as viewer; the desktop revoked the driver on disconnect anyway).

- [ ] **Step 4: Verify render** — `cargo test term_share` (island test still green) + `cargo run` locally, open `/t/<token>` for a hand-inserted collab row, check the chip/button renders and the RO page is unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/templates/term.html src/term_share.rs
git commit -m "feat(term-share): collab guest page — request/release control, driver stdin"
```

---

## Task 5: Desktop — mode-aware share client + menu (karlTerminal)

**Files:**
- Modify: `crates/app/src/term_share.rs`, `ui/src/term-share/api.ts`, `ui/src/term-share/share.ts`, `ui/src/tabs/manager.ts` (share menu block, ~line 9539)
- Test: `crates/app/src/term_share.rs` inline; `ui/src/term-share/share.test.ts` if it exists (extend), else skip UI unit and rely on typecheck

**Interfaces:**
- Consumes: `POST /term-shares {session_id, mode}` (Task 1).
- Produces: Rust commands `term_share_create(session_id, mode)`, `term_share_get(session_id, mode)`, `term_share_revoke(session_id, mode)`, `term_share_list() -> Vec<TermShareEntry>`; TS `shareSession(sessionId, mode)`, `isTermShared(sessionId)` (any mode), `isCollabShared(sessionId)`, `stopSharing(sessionId, mode)`, `revokeIfShared(sessionId)` (all modes). Task 8 consumes the TS surface.

- [ ] **Step 1: Rust — store keyed by session+mode, failing test first**

```rust
#[test]
fn store_keeps_ro_and_collab_separately() {
    let dir = std::env::temp_dir().join(format!("cov-tshare2-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let p = dir.join("term_shares.json");
    let mut m = load_shares(&p);
    m.insert(store_key("S1", "ro"), TermShare { share_id: 1, token: "a".into(), url: "u1".into(), mode: "ro".into() });
    m.insert(store_key("S1", "collab"), TermShare { share_id: 2, token: "b".into(), url: "u2".into(), mode: "collab".into() });
    save_shares(&p, &m).unwrap();
    let back = load_shares(&p);
    assert_eq!(back.get(&store_key("S1", "ro")).unwrap().share_id, 1);
    assert_eq!(back.get(&store_key("S1", "collab")).unwrap().share_id, 2);
}
```

- [ ] **Step 2: Implement Rust side**

- `TermShare` gains `pub mode: String` (camelCase serde already applies).
- `pub(crate) fn store_key(session_id: &str, mode: &str) -> String { format!("{session_id}|{mode}") }` — `|` cannot appear in a ULID or mode.
- `post_share` body: `json!({ "session_id": session_id, "mode": mode })`.
- Commands: `term_share_get(app, session_id, mode)`, `term_share_create(app, session_id, mode)` (validate `ro|collab`), `term_share_revoke(app, session_id, mode)` — all swap `&session_id` keys for `store_key(...)`.
- `term_share_list` returns entries instead of keys:
  ```rust
  #[derive(Serialize)]
  #[serde(rename_all = "camelCase")]
  pub struct TermShareEntry { pub session_id: String, pub mode: String }
  // list: keys split on '|'
  ```
- `spawn_startup_revoke` unchanged (iterates values).
- Migration shim: old stores have keys without `|` — `load_shares` callers treat a key without `|` as `(key, "ro")` in `term_share_list`; create/revoke always write new-style keys. One line in the split: `let (sid, mode) = k.split_once('|').unwrap_or((k.as_str(), "ro"));`

Run: `cargo test -p covenant term_share` — PASS. Update the frontend api signature mismatches next (the app won't compile UI-independently; Rust compiles now).

- [ ] **Step 3: TS api + share state**

`ui/src/term-share/api.ts`:
```ts
export type ShareMode = "ro" | "collab";
export interface TermShare { shareId: number; token: string; url: string; mode: ShareMode; }
export interface TermShareEntry { sessionId: string; mode: ShareMode; }
export const termShareApi = {
  getShare: (sessionId: string, mode: ShareMode) =>
    invoke<TermShare | null>("term_share_get", { sessionId, mode }),
  listShares: () => invoke<TermShareEntry[]>("term_share_list"),
  create: (sessionId: string, mode: ShareMode) =>
    invoke<TermShare>("term_share_create", { sessionId, mode }),
  revoke: (sessionId: string, mode: ShareMode) =>
    invoke<void>("term_share_revoke", { sessionId, mode }),
};
```

`ui/src/term-share/share.ts`: replace the single `Set` with two:
```ts
const roShares = new Set<string>();
const collabShares = new Set<string>();
export function isTermShared(id: string): boolean { return roShares.has(id) || collabShares.has(id); }
export function isRoShared(id: string): boolean { return roShares.has(id); }
export function isCollabShared(id: string): boolean { return collabShares.has(id); }
```
`ensureTermSharesLoaded` fills both from `listShares()` entries. `shareSession(sessionId, mode)` adds to the right set; collab copy toast: `"Share link copied — collaborative (guest can request control)"`. `copyTermShareLink(sessionId, mode)`, `stopSharing(sessionId, mode)`. `revokeIfShared(sessionId)` revokes both modes fire-and-forget.

- [ ] **Step 4: Menu block** in `manager.ts` (replace the current Terminal Share block):

```ts
// Terminal Share: read-only broadcast and/or collaborative (driver) link.
if (ctxSessionId) {
  items.push({ divider: true });
  if (isRoShared(ctxSessionId)) {
    items.push({ label: "Copy share link (read-only)", icon: Icons.share(),
      onClick: () => void copyTermShareLink(ctxSessionId, "ro") });
    items.push({ label: "Stop read-only share", icon: Icons.x(),
      onClick: () => void stopSharing(ctxSessionId, "ro") });
  } else {
    items.push({ label: "Share read-only…", icon: Icons.share(),
      onClick: () => void shareSession(ctxSessionId, "ro") });
  }
  if (isCollabShared(ctxSessionId)) {
    items.push({ label: "Copy collab link", icon: Icons.share(),
      onClick: () => void copyTermShareLink(ctxSessionId, "collab") });
    items.push({ label: "Stop collab share", icon: Icons.x(),
      onClick: () => void stopSharing(ctxSessionId, "collab") });
  } else {
    items.push({ label: "Share collaborative…", icon: Icons.share(), danger: true,
      onClick: () => void shareSession(ctxSessionId, "collab") });
  }
}
```
(`danger: true` on the collab entry — it hands write access to a link.)

- [ ] **Step 5: Verify** — `npx tsc --noEmit -p tsconfig.json`, `npm test` (fix `share.test.ts` call sites), `cargo test -p covenant`.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/term_share.rs ui/src/term-share/ ui/src/tabs/manager.ts
git commit -m "feat(term-share): collab mode — dual-mode store, api, and tab menu"
```

---

## Task 6: Desktop — driver state + line-assembly blocklist gate (karlTerminal)

**Files:**
- Create: `crates/app/src/rc_guest.rs`
- Modify: `crates/app/src/lib.rs` (AppState field + module + 2 commands + `write_to_session` hook + registration)
- Test: `crates/app/src/rc_guest.rs` inline

**Interfaces:**
- Consumes: `crate::safety::is_dangerous(text, &[]) -> Option<Danger { message }>`.
- Produces (used by Task 7 and the UI):
  ```rust
  pub struct RcGuestState {
      pub drivers: HashMap<karl_session::SessionId, GuestDriver>,
      /// rc_agent's live out-channel; None while disconnected.
      pub out: Option<tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>>,
  }
  pub struct GuestDriver { pub conn_id: u64, pub login: String, pub line: String }
  pub fn gate_guest_bytes(line: &mut String, bytes: &[u8]) -> (Vec<u8>, Option<String>);
  pub fn send_frame(st: &RcGuestState, json: String);                  // no-op if disconnected
  pub fn revoke_driver(app: &AppHandle, id: SessionId) -> Option<GuestDriver>; // removes, sends control_revoked, emits rc://guest/driver
  ```
  AppState field: `rc_guest: std::sync::Arc<std::sync::Mutex<RcGuestState>>` (std Mutex — never held across await).
  Tauri commands: `rc_grant_driver(session_id, conn_id, login)`, `rc_revoke_driver(session_id)`.
  Tauri events: `rc://guest/driver` payload `{ sessionId: string, login: string | null }`.

- [ ] **Step 1: Write failing tests for the byte gate**

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_typing_forwards_and_accumulates() {
        let mut line = String::new();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"ls -la");
        assert_eq!(fwd, b"ls -la");
        assert_eq!(blocked, None);
        assert_eq!(line, "ls -la");
    }

    #[test]
    fn clean_enter_forwards_terminator_and_clears_line() {
        let mut line = "git status".to_string();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"\r");
        assert_eq!(fwd, b"\r");
        assert_eq!(blocked, None);
        assert!(line.is_empty());
    }

    #[test]
    fn dangerous_enter_is_suppressed() {
        let mut line = String::new();
        let (_f, _b) = gate_guest_bytes(&mut line, b"rm -rf /");
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"\r");
        assert!(fwd.is_empty(), "the terminator must not reach the PTY");
        assert!(blocked.is_some());
        assert!(line.is_empty(), "buffer resets so the guest can correct");
    }

    #[test]
    fn newline_is_gated_like_cr() {
        let mut line = "sudo reboot".to_string();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"\n");
        assert!(fwd.is_empty());
        assert!(blocked.is_some());
    }

    #[test]
    fn backspace_edits_the_buffer() {
        let mut line = String::new();
        gate_guest_bytes(&mut line, b"lsx");
        gate_guest_bytes(&mut line, &[0x7f]);
        assert_eq!(line, "ls");
    }

    #[test]
    fn ctrl_c_and_esc_reset_the_buffer_but_forward() {
        let mut line = "half-typed".to_string();
        let (fwd, _) = gate_guest_bytes(&mut line, &[0x03]);
        assert_eq!(fwd, &[0x03]);
        assert!(line.is_empty());
        line.push_str("x");
        let (fwd2, _) = gate_guest_bytes(&mut line, &[0x1b]);
        assert_eq!(fwd2, &[0x1b]);
        assert!(line.is_empty());
    }

    #[test]
    fn dangerous_mid_chunk_forwards_prefix_only() {
        // paste "rm -rf /\rls\r": nothing from the terminator on may pass
        let mut line = String::new();
        let (fwd, blocked) = gate_guest_bytes(&mut line, b"rm -rf /\rls\r");
        assert_eq!(fwd, b"rm -rf /", "typed chars echo, the submit never lands");
        assert!(blocked.is_some());
    }
}
```

- [ ] **Step 2: Run** `cargo test -p covenant rc_guest` — FAIL (module missing).

- [ ] **Step 3: Implement `crates/app/src/rc_guest.rs`**

```rust
//! Guest-driver state for collaborative terminal shares. The desktop is
//! the sole write authority: a session has at most one driver, granted
//! only by an explicit owner click and revoked on owner typing, owner
//! click, guest disconnect, or share revoke.
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

pub struct GuestDriver {
    pub conn_id: u64,
    pub login: String,
    /// Best-effort line assembly for the blocklist scan. TUIs/editors and
    /// escape sequences evade it by design — the real trust boundary is
    /// the explicit grant to a known identity.
    pub line: String,
}

#[derive(Default)]
pub struct RcGuestState {
    pub drivers: HashMap<karl_session::SessionId, GuestDriver>,
    pub out: Option<tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>>,
}

pub fn send_frame(st: &RcGuestState, json: String) {
    if let Some(tx) = &st.out {
        let _ = tx.send(tokio_tungstenite::tungstenite::Message::Text(json));
    }
}

/// Forward guest bytes, suppressing any line terminator whose assembled
/// line matches the blocklist. Returns (bytes to write, blocked message).
pub fn gate_guest_bytes(line: &mut String, bytes: &[u8]) -> (Vec<u8>, Option<String>) {
    let mut fwd = Vec::with_capacity(bytes.len());
    for &b in bytes {
        match b {
            b'\r' | b'\n' => {
                if let Some(d) = crate::safety::is_dangerous(line, &[]) {
                    line.clear();
                    return (fwd, Some(d.message));
                }
                line.clear();
                fwd.push(b);
            }
            0x7f | 0x08 => { line.pop(); fwd.push(b); }
            // ^C aborts the line; ESC starts a sequence we can't track —
            // reset the buffer either way (documented best-effort gap).
            0x03 | 0x1b => { line.clear(); fwd.push(b); }
            _ => {
                if b >= 0x20 { line.push(b as char); } // ASCII-only scan; blocklist patterns are ASCII
                fwd.push(b);
            }
        }
    }
    (fwd, None)
}

/// Remove the driver (if any), announce control_revoked to guests, and
/// tell the UI. Callable from sync contexts (std Mutex, no awaits).
pub fn revoke_driver(app: &AppHandle, id: karl_session::SessionId) -> Option<GuestDriver> {
    let state = app.try_state::<crate::AppState>()?;
    let mut st = state.rc_guest.lock().ok()?;
    let gone = st.drivers.remove(&id)?;
    send_frame(&st, format!("{{\"t\":\"control_revoked\",\"session_id\":\"{id}\"}}"));
    drop(st);
    let _ = app.emit("rc://guest/driver", serde_json::json!({ "sessionId": id.to_string(), "login": null }));
    tracing::info!(target: "rc_guest", session = %id, login = %gone.login, "guest driver revoked");
    Some(gone)
}
```

- [ ] **Step 4: Wire into `lib.rs`**

- `mod rc_guest;` next to `mod rc_agent;`.
- AppState field `rc_guest: std::sync::Arc<std::sync::Mutex<rc_guest::RcGuestState>>`, initialized `Default::default()` where AppState is built.
- Commands (register in the `generate_handler!` list next to `rc_set_armed`):

```rust
#[tauri::command]
async fn rc_grant_driver(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    conn_id: u64,
    login: String,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    {
        let mut st = state.rc_guest.lock().map_err(|e| e.to_string())?;
        st.drivers.insert(id, rc_guest::GuestDriver { conn_id, login: login.clone(), line: String::new() });
        rc_guest::send_frame(&st, format!(
            "{{\"t\":\"control_granted\",\"session_id\":\"{id}\",\"conn_id\":{conn_id},\"login\":{}}}",
            serde_json::to_string(&login).map_err(|e| e.to_string())?
        ));
    }
    use tauri::Emitter;
    let _ = app.emit("rc://guest/driver", serde_json::json!({ "sessionId": session_id, "login": login }));
    tracing::info!(session = %id, %conn_id, "guest driver granted");
    Ok(())
}

#[tauri::command]
async fn rc_revoke_driver(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    rc_guest::revoke_driver(&app, id);
    Ok(())
}
```

- `rc_disarm_all` (the existing kill switch, `lib.rs:1290`) also revokes every driver: collect the keys of `state.rc_guest.lock()...drivers` and call `rc_guest::revoke_driver(&app, id)` for each (the command gains an `app: tauri::AppHandle` param if it lacks one).
- `write_to_session` hook — owner always wins. After `parse_id`, before the sessions lock:

```rust
    // Owner typed locally: an active remote driver loses control instantly.
    {
        let has_driver = state.rc_guest.lock().ok().map(|st| st.drivers.contains_key(&id)).unwrap_or(false);
        if has_driver {
            rc_guest::revoke_driver(&app, id);
        }
    }
```
(`write_to_session` gains an `app: tauri::AppHandle` parameter — Tauri injects it; no TS change needed since it's not a named arg.)

- [ ] **Step 5: Run** `cargo test -p covenant` + `cargo clippy -p covenant --all-targets` — green.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/rc_guest.rs crates/app/src/lib.rs
git commit -m "feat(rc): guest driver state — grant/revoke commands, owner-wins hook, blocklist line gate"
```

---

## Task 7: Desktop — rc_agent frame wiring (karlTerminal)

**Files:**
- Modify: `crates/app/src/rc_agent.rs`
- Test: inline `tests` mod

**Interfaces:**
- Consumes: `rc_guest::{RcGuestState, gate_guest_bytes, revoke_driver, send_frame}` (Task 6); relay frames (Task 3).
- Produces: Tauri events `rc://guest/request` `{sessionId, connId, login, avatar}` and `rc://guest/roster` `{sessionId, guests: [{connId, login, avatar}]}` (Task 8 consumes); `guest_input` handling → PTY.

- [ ] **Step 1: Failing parse tests**

```rust
#[test]
fn guest_frames_parse() {
    assert!(matches!(
        serde_json::from_str::<InFrame>(
            r#"{"t":"guest_request_control","session_id":"s1","conn_id":4,"login":"nico","avatar":"a"}"#
        ).unwrap(),
        InFrame::GuestRequestControl { conn_id: 4, .. }
    ));
    assert!(matches!(
        serde_json::from_str::<InFrame>(
            r#"{"t":"guest_input","session_id":"s1","conn_id":4,"b64":"bHM="}"#
        ).unwrap(),
        InFrame::GuestInput { .. }
    ));
    assert!(matches!(
        serde_json::from_str::<InFrame>(
            r#"{"t":"guest_release","session_id":"s1","conn_id":4}"#
        ).unwrap(),
        InFrame::GuestRelease { .. }
    ));
    assert!(matches!(
        serde_json::from_str::<InFrame>(
            r#"{"t":"guest_roster","session_id":"s1","guests":[{"conn_id":4,"login":"nico","avatar":"a"}]}"#
        ).unwrap(),
        InFrame::GuestRoster { .. }
    ));
}
```

- [ ] **Step 2: Run** `cargo test -p covenant rc_agent` — FAIL → add variants:

```rust
    GuestRequestControl { session_id: String, conn_id: u64, login: String, avatar: String },
    GuestInput { session_id: String, conn_id: u64, b64: String },
    GuestRelease { session_id: String, conn_id: u64 },
    GuestRoster { session_id: String, guests: Vec<GuestRosterEntry> },
// plus:
#[derive(Debug, Deserialize)]
struct GuestRosterEntry { conn_id: u64, login: String, avatar: String }
```

→ PASS.

- [ ] **Step 3: Handlers in `run_once`'s match**

```rust
Ok(InFrame::GuestRequestControl { session_id, conn_id, login, avatar }) => {
    use tauri::Emitter;
    let _ = app.emit("rc://guest/request", serde_json::json!({
        "sessionId": session_id, "connId": conn_id, "login": login, "avatar": avatar,
    }));
}
Ok(InFrame::GuestRelease { session_id, conn_id }) => {
    handle_guest_release(app, &session_id, conn_id).await;
}
Ok(InFrame::GuestInput { session_id, conn_id, b64 }) => {
    handle_guest_input(app, &session_id, conn_id, &b64).await;
}
Ok(InFrame::GuestRoster { session_id, guests }) => {
    use tauri::Emitter;
    let _ = app.emit("rc://guest/roster", serde_json::json!({
        "sessionId": session_id,
        "guests": guests.iter().map(|g| serde_json::json!({
            "connId": g.conn_id, "login": g.login, "avatar": g.avatar,
        })).collect::<Vec<_>>(),
    }));
    // A driver that vanished from the roster disconnected — revoke.
    if let Ok(u) = ulid::Ulid::from_str(&session_id) {
        let id = karl_session::SessionId(u);
        let stale = app.try_state::<crate::AppState>().and_then(|s| {
            s.rc_guest.lock().ok().map(|st| st.drivers.get(&id)
                .map(|d| !guests.iter().any(|g| g.conn_id == d.conn_id))
                .unwrap_or(false))
        }).unwrap_or(false);
        if stale { crate::rc_guest::revoke_driver(app, id); }
    }
}
```

```rust
async fn handle_guest_release(app: &AppHandle, session_id: &str, conn_id: u64) {
    let Ok(u) = ulid::Ulid::from_str(session_id) else { return };
    let id = karl_session::SessionId(u);
    let matches_driver = app.try_state::<crate::AppState>().and_then(|s| {
        s.rc_guest.lock().ok()
            .map(|st| st.drivers.get(&id).map(|d| d.conn_id == conn_id).unwrap_or(false))
    }).unwrap_or(false);
    if matches_driver { crate::rc_guest::revoke_driver(app, id); }
}

/// Driver-gated raw input. Non-driver frames are dropped silently (same
/// posture as the armed gate). Dangerous line submits are suppressed and
/// reported to the guest via input_blocked.
async fn handle_guest_input(app: &AppHandle, session_id: &str, conn_id: u64, b64: &str) {
    use base64::Engine;
    let Ok(u) = ulid::Ulid::from_str(session_id) else { return };
    let id = karl_session::SessionId(u);
    let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) else { return };
    if bytes.is_empty() || bytes.len() > 4096 { return; }
    let Some(state) = app.try_state::<crate::AppState>() else { return };
    // Gate + line-assembly under the lock; never hold it across the write await.
    let verdict = {
        let Ok(mut st) = state.rc_guest.lock() else { return };
        let Some(driver) = st.drivers.get_mut(&id) else { return };
        if driver.conn_id != conn_id { return; }
        let (fwd, blocked) = crate::rc_guest::gate_guest_bytes(&mut driver.line, &bytes);
        if let Some(msg) = &blocked {
            crate::rc_guest::send_frame(&st, serde_json::to_string(&serde_json::json!({
                "t": "input_blocked", "session_id": session_id, "message": msg,
            })).unwrap_or_default());
            karl_score::record_risky_action(karl_score::RiskyOutcome::Blocked);
        }
        (fwd, blocked)
    };
    let (fwd, _blocked) = verdict;
    if fwd.is_empty() { return; }
    if let Err(e) = crate::operator::inject_to_session(app, id, &fwd).await {
        tracing::warn!(target: "rc_agent", error = %e, "guest input inject failed");
    }
}
```

- [ ] **Step 4: Register/clear the out-channel in `run_once`**

Right after `let (out_tx, mut out_rx) = ...`:
```rust
    if let Some(state) = app.try_state::<crate::AppState>() {
        if let Ok(mut st) = state.rc_guest.lock() {
            st.out = Some(out_tx.clone());
        }
    }
```
And in the teardown after the loop (next to `mirrors.drain()`): clear `st.out = None` and `st.drivers.clear()` — a relay drop disconnects every guest, so no driver survives it. Emit `rc://guest/driver` with `login: null` for each cleared session and `rc://guest/roster` with empty guests so the UI resets.

- [ ] **Step 5: Run** `cargo test -p covenant && cargo clippy -p covenant --all-targets` — green. The existing `key_bytes_rejects_anything_not_whitelisted` regression test must still pass untouched.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc): guest collab frames — request/input/release/roster handling"
```

---

## Task 8: Desktop UI — grant toast, driver chip, roster badge (karlTerminal)

**Files:**
- Create: `ui/src/term-share/collab.ts`
- Modify: `ui/src/main.ts` (mount listener), `ui/src/tabs/manager.ts` (pane chip + badge hook), `ui/src/styles.css` or the tabs stylesheet (chip styles)
- Test: `ui/src/term-share/collab.test.ts`

**Interfaces:**
- Consumes: Tauri events `rc://guest/request`, `rc://guest/driver`, `rc://guest/roster` (Task 7); `pushConfirmToast` / `pushInfoToast` (`ui/src/notifications/toast.ts`); `invoke("rc_grant_driver"/"rc_revoke_driver")`.
- Produces: `initCollabShare(manager)` called once from `main.ts`; `getDriver(sessionId): string | null` and `getGuestCount(sessionId): number` for the tab strip.

- [ ] **Step 1: Failing test for the pure state store**

```ts
// ui/src/term-share/collab.test.ts
import { describe, expect, it } from "vitest";
import { _collabState, getDriver, getGuestCount } from "./collab";

describe("collab share state", () => {
  it("tracks driver per session", () => {
    _collabState.onDriver({ sessionId: "S1", login: "nico" });
    expect(getDriver("S1")).toBe("nico");
    _collabState.onDriver({ sessionId: "S1", login: null });
    expect(getDriver("S1")).toBeNull();
  });
  it("tracks roster count per session", () => {
    _collabState.onRoster({ sessionId: "S1", guests: [{ connId: 1, login: "a", avatar: "" }] });
    expect(getGuestCount("S1")).toBe(1);
    _collabState.onRoster({ sessionId: "S1", guests: [] });
    expect(getGuestCount("S1")).toBe(0);
  });
});
```

- [ ] **Step 2: Run** `npm test -- collab` — FAIL → implement:

```ts
// ui/src/term-share/collab.ts
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { pushConfirmToast, pushInfoToast } from "../notifications/toast";

export interface RosterGuest { connId: number; login: string; avatar: string; }
interface DriverEvt { sessionId: string; login: string | null; }
interface RosterEvt { sessionId: string; guests: RosterGuest[]; }
interface RequestEvt { sessionId: string; connId: number; login: string; avatar: string; }

const drivers = new Map<string, string>();
const rosters = new Map<string, RosterGuest[]>();
export const COLLAB_EVENT = "covenant:collab-changed";

function notify(): void { window.dispatchEvent(new CustomEvent(COLLAB_EVENT)); }

export function getDriver(sessionId: string): string | null {
  return drivers.get(sessionId) ?? null;
}
export function getGuestCount(sessionId: string): number {
  return rosters.get(sessionId)?.length ?? 0;
}

/// Exported for tests; listeners feed these in production.
export const _collabState = {
  onDriver(e: DriverEvt): void {
    if (e.login === null) drivers.delete(e.sessionId);
    else drivers.set(e.sessionId, e.login);
    notify();
  },
  onRoster(e: RosterEvt): void {
    rosters.set(e.sessionId, e.guests);
    notify();
  },
};

export function revokeDriver(sessionId: string): void {
  void invoke("rc_revoke_driver", { sessionId }).catch((e) =>
    console.error("revoke driver failed", e),
  );
}

/// One-time mount: Tauri event bridge + grant toast.
export function initCollabShare(tabTitle: (sessionId: string) => string): void {
  void listen<RequestEvt>("rc://guest/request", ({ payload }) => {
    pushConfirmToast({
      message: `${payload.login} wants control of ${tabTitle(payload.sessionId)}`,
      confirmLabel: "Grant control",
      cancelLabel: "Decline",
      onConfirm: () => {
        void invoke("rc_grant_driver", {
          sessionId: payload.sessionId,
          connId: payload.connId,
          login: payload.login,
        }).catch((e) => console.error("grant failed", e));
      },
    });
  });
  void listen<DriverEvt>("rc://guest/driver", ({ payload }) => {
    const had = drivers.get(payload.sessionId);
    _collabState.onDriver(payload);
    if (payload.login === null && had) pushInfoToast({ message: `${had} no longer has control` });
  });
  void listen<RosterEvt>("rc://guest/roster", ({ payload }) => _collabState.onRoster(payload));
}
```

→ `npm test -- collab` PASS.

- [ ] **Step 3: Mount + pane chip + badge**

- `main.ts`: after the manager and toast host exist — `initCollabShare((sid) => manager.tabTitleForSession(sid) ?? "a terminal")` (add that small lookup helper to the manager if absent; it can reuse the same title logic the RC `collect_tabs` mirrors).
- `manager.ts` pane chip: where panes render status chips, when `getDriver(sessionId)` is non-null render
  ```ts
  const chip = document.createElement("button");
  chip.className = "remote-driver-chip";
  chip.append(Icons.link2(), document.createTextNode(`REMOTE DRIVER: ${login}`));
  attachTooltip(chip, "Click to take back control");
  chip.onclick = () => revokeDriver(sessionId);
  ```
  Subscribe to `COLLAB_EVENT` (like `TERM_SHARE_EVENT` is handled today) to re-render.
- Tab badge: where the share badge renders (keyed off `isTermShared`), append guest count when `getGuestCount(sessionId) > 0`: a small `·N` suffix, tooltip via `attachTooltip` listing logins.
- CSS (sharp corners, accent on the pane while driven):
  ```css
  .remote-driver-chip {
    border: 1px solid var(--accent, #f97316); color: var(--accent, #f97316);
    background: transparent; border-radius: 0; font-size: 10px;
    letter-spacing: 0.1em; padding: 2px 8px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 5px;
  }
  ```
  (match the file's existing token names — grep for how other pane chips are styled and reuse those variables).

- [ ] **Step 4: Verify** — `npx tsc --noEmit -p tsconfig.json`, `npm test`, then a `design-rules-auditor` pass over the diff (new chip + menu items are UI).

- [ ] **Step 5: Commit**

```bash
git add ui/src/term-share/collab.ts ui/src/term-share/collab.test.ts ui/src/main.ts ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(ui): collab share — grant toast, remote-driver chip, guest roster badge"
```

---

## Task 9: End-to-end smoke (manual, both repos)

**Files:** none (verification only). Requires the server branch deployed to a staging URL or run locally with `COVENANT_BACKEND_URL` pointed at it, plus the GitHub OAuth App env vars.

- [ ] **Step 1:** Desktop: open a tab → context menu → **Share collaborative…** → link copied; tab badge shows shared.
- [ ] **Step 2:** Browser A (incognito): open link → mirror renders read-only; chip `VIEWING`, button `REQUEST CONTROL`.
- [ ] **Step 3:** Click **REQUEST CONTROL** → GitHub OAuth → back on the page with chip still `VIEWING` → click again → desktop toast shows `<login> wants control of <tab>` → **Grant control**.
- [ ] **Step 4:** Guest types `echo hola` + Enter → executes; desktop pane shows `REMOTE DRIVER: <login>` chip; roster badge `·1`.
- [ ] **Step 5:** Guest types `rm -rf /` + Enter → command visible at prompt but never executes; guest footer shows `Blocked: ...`.
- [ ] **Step 6:** Owner types locally → guest chip flips to `VIEWING` instantly (owner wins); re-grant works.
- [ ] **Step 7:** Owner clicks the pane chip → revoked. Guest reloads → still viewer.
- [ ] **Step 8:** **Stop collab share** → guest page flips to `THIS LINK IS NO LONGER ACTIVE`; read-only link (if also active) keeps streaming.
- [ ] **Step 9:** Quit + relaunch desktop → both shares revoked (startup revoke), roster/driver UI clean.
- [ ] **Step 10:** Record results in the PR body; screenshots of toast + driver chip (UI change → screenshots required per repo PR rules).
