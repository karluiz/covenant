# Terminal Share (read-only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Share one live terminal session read-only via a secret `/t/:token` link, revocable, dying with the session.

**Architecture:** A **Guest** lane on the existing RC relay hub (`covenant-server/src/rc.rs`). Guests join the owner's gid via a share token, receive only `mirror_screen`/`mirror_data` frames for the shared session, and can send nothing. The relay owns mirror lifetime via per-session viewer interest refcounting. The desktop app adds share commands (gist pattern) + tab context-menu UI. **Zero changes to the desktop streaming code** (`rc_agent.rs`).

**Tech Stack:** axum + sqlx (Postgres) + minijinja on the server; Tauri commands + vanilla TS on the app; xterm.js from CDN on the viewer page.

**Spec:** `docs/superpowers/specs/2026-07-23-terminal-share-design.md`

## Global Constraints

- Two repos. Tasks 1–4: `~/Sources/covenant-server`, in a NEW worktree off `origin/main` at `.covenant/worktrees/term-share` (main local checkout sits on an old feature branch — do not use it). Tasks 5–6: the covenant app repo (current worktree).
- Revoked or unknown token → generic 404 / socket close. Never distinguish which (link-enumeration rule from `gist.rs`).
- Guests NEVER receive `tabs` frames and have NO input path. Enforced in the hub, not the desktop.
- Token: `uuid::Uuid::new_v4().simple().to_string()` (matches gists).
- No `unwrap()` outside tests. Conventional Commits. UI copy in English. No `element.title` — use `attachTooltip` (`ui/src/tooltip/tooltip.ts:212`).
- Rust: `cargo fmt --all && cargo clippy --workspace --all-targets` must be clean before each commit.

---

### Task 1: covenant-server — migration + owner routes (create / revoke)

**Files:**
- Create: `migrations/0013_term_shares.sql`
- Create: `src/term_share.rs`
- Modify: `src/main.rs` (mod decl + routes, near the `/gists` routes)

**Interfaces:**
- Produces: `POST /term-shares` (Bearer JWT) body `{"session_id": "…"}` → `{"id": i64, "token": String}`; `POST /term-shares/:id/revoke` (Bearer JWT) → `{}`.
- Produces (for Task 3): `term_share::revoke` will call `state.rc.kick_guests(gid, &token)` — leave a `// wired in guest-lane task` TODO-free stub point by fetching the token during revoke (code below already does).
- Consumes: `AppState { pool, jwt_secret, rc }`, `crate::sync::bearer`, `crate::jwt`, `crate::error::{AppError, Result}` — same imports as `gist.rs`.

- [ ] **Step 1: Create the server worktree**

```bash
cd ~/Sources/covenant-server
git fetch origin main
git worktree add .covenant/worktrees/term-share -b feat/term-share origin/main
cd .covenant/worktrees/term-share
```

- [ ] **Step 2: Write the migration**

`migrations/0013_term_shares.sql`:

```sql
CREATE TABLE term_shares (
    id              BIGSERIAL PRIMARY KEY,
    token           TEXT NOT NULL UNIQUE,
    session_id      TEXT NOT NULL,
    owner_github_id BIGINT NOT NULL,
    revoked         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- UNIQUE so two concurrent creates can't mint two live tokens for one
-- session ("the link stays stable"); create() inserts with ON CONFLICT.
CREATE UNIQUE INDEX term_shares_owner_session
    ON term_shares (owner_github_id, session_id) WHERE NOT revoked;
```

- [ ] **Step 3: Write `src/term_share.rs`** (owner surface only; viewer page and kick come in Tasks 3–4)

```rust
//! Read-only terminal share: a live session mirrored behind a secret
//! token link (`GET /t/:token`). Owner-gated create/revoke, mirrored on
//! `gist.rs`'s token/owner-gating pattern. The stream itself rides the
//! RC hub's guest lane (`rc.rs`).
use axum::{
    extract::{Path, State},
    http::HeaderMap,
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::{
    error::{AppError, Result},
    jwt,
    sync::bearer,
    AppState,
};

const MAX_SESSION_ID: usize = 64;

#[derive(Debug, Deserialize)]
pub struct ShareBody {
    pub session_id: String,
}

#[derive(Debug, Serialize)]
pub struct ShareCreated {
    pub id: i64,
    pub token: String,
}

pub async fn create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<ShareBody>,
) -> Result<Json<ShareCreated>> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    let sid = body.session_id.trim();
    if sid.is_empty() || sid.len() > MAX_SESSION_ID {
        return Err(AppError::BadRequest("session_id out of bounds".into()));
    }
    // Re-share of the same live session returns the existing token so the
    // link stays stable (same contract as gist re-publish).
    let existing: Option<(i64, String)> = sqlx::query_as(
        "SELECT id, token FROM term_shares
         WHERE owner_github_id = $1 AND session_id = $2 AND NOT revoked
         ORDER BY id DESC LIMIT 1",
    )
    .bind(claims.sub)
    .bind(sid)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    if let Some((id, token)) = existing {
        return Ok(Json(ShareCreated { id, token }));
    }
    let token = uuid::Uuid::new_v4().simple().to_string();
    // Race-safe against the partial UNIQUE index: a concurrent create for
    // the same live session loses the conflict and returns the winner's row.
    let inserted: Option<(i64,)> = sqlx::query_as(
        "INSERT INTO term_shares (token, session_id, owner_github_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (owner_github_id, session_id) WHERE NOT revoked DO NOTHING
         RETURNING id",
    )
    .bind(&token)
    .bind(sid)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    if let Some((id,)) = inserted {
        return Ok(Json(ShareCreated { id, token }));
    }
    let (id, token): (i64, String) = sqlx::query_as(
        "SELECT id, token FROM term_shares
         WHERE owner_github_id = $1 AND session_id = $2 AND NOT revoked
         ORDER BY id DESC LIMIT 1",
    )
    .bind(claims.sub)
    .bind(sid)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?
    .ok_or_else(|| AppError::Internal(anyhow::anyhow!("term_share upsert race with no winner")))?;
    Ok(Json(ShareCreated { id, token }))
}

pub async fn revoke(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>> {
    let claims = jwt::verify(&state.jwt_secret, bearer(&headers)?)?;
    let row: Option<(String,)> = sqlx::query_as(
        "SELECT token FROM term_shares WHERE id = $1 AND owner_github_id = $2",
    )
    .bind(id)
    .bind(claims.sub)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    let (token,) = row.ok_or(AppError::NotFound)?;
    sqlx::query("UPDATE term_shares SET revoked = TRUE WHERE id = $1")
        .bind(id)
        .execute(&state.pool)
        .await
        .map_err(|e| AppError::Internal(e.into()))?;
    // Kill live viewers immediately — revoke must not wait for a reconnect.
    state.rc.kick_guests(claims.sub, &token);
    Ok(Json(json!({})))
}
```

Note: `state.rc.kick_guests` does not exist yet — Task 2 adds it. If executing tasks strictly in order, comment that single line out here and un-comment it in Task 3's wiring step; if executing 1–3 in one session, leave it and build after Task 2.

- [ ] **Step 4: Wire module + routes in `src/main.rs`**

Add `mod term_share;` next to `mod gist;`. Next to the `/gists` routes add:

```rust
        .route("/term-shares", axum::routing::post(term_share::create))
        .route("/term-shares/:id/revoke", axum::routing::post(term_share::revoke))
```

- [ ] **Step 5: Build**

Run: `cargo build 2>&1 | tail -5`
Expected: compiles (with the kick line commented if Task 2 isn't in yet).

- [ ] **Step 6: Commit**

```bash
git add migrations/0013_term_shares.sql src/term_share.rs src/main.rs
git commit -m "feat(term-share): term_shares table + owner create/revoke routes"
```

---

### Task 2: covenant-server — hub guest lane (TDD)

**Files:**
- Modify: `src/rc.rs`

**Interfaces:**
- Produces: `Hub::join_guest(gid, session_id, token) -> (ClientId, UnboundedReceiver<String>)`, `Hub::leave_guest(gid, id)`, `Hub::kick_guests(gid, token) -> usize`, `Hub::resume_guest_mirrors(gid)`.
- **Signature change:** `Hub::route(gid, from, id: ClientId, msg)` grows a `ClientId` param (interest tracking needs the sender). Update the two call sites (`handle()` and existing tests).
- Behavior contract (what Tasks 3–4 and the desktop rely on):
  - Guests receive only `mirror_screen`/`mirror_data` frames whose `session_id` matches theirs, plus `presence` frames. Never `tabs`.
  - `join_guest` sends the guest current desktop presence and forwards a relay-synthesized `mirror_start` to desktops (desktop-side `start_mirror` is idempotent).
  - The relay refcounts viewer interest per session (guests + owner-web `mirror_start`/`mirror_stop` peeked in `route`). A `mirror_stop` reaches the desktop only when the last viewer of that session is gone; otherwise it is swallowed.
  - `kick_guests` sends `{"t":"share_revoked"}` then drops the guest sender (its socket write loop ends → Task 3's handler closes the socket).
  - `notify_webs` now also reaches guests (it only ever carries presence frames).

- [ ] **Step 1: Write the failing tests** (append to the existing `mod tests` in `src/rc.rs`)

```rust
    fn mirror_data_frame(sid: &str) -> String {
        format!("{{\"t\":\"mirror_data\",\"session_id\":\"{sid}\",\"b64\":\"aGk=\"}}")
    }
    fn mirror_stop_f(sid: &str) -> String {
        format!("{{\"t\":\"mirror_stop\",\"session_id\":\"{sid}\"}}")
    }
    fn mirror_start_f(sid: &str) -> String {
        format!("{{\"t\":\"mirror_start\",\"session_id\":\"{sid}\"}}")
    }

    #[test]
    fn guest_receives_only_matching_mirror_frames() {
        let hub = Hub::default();
        let (desk_id, _drx) = hub.join(7, Role::Desktop);
        let (_g, mut grx) = hub.join_guest(7, "s1", "tok1");
        while grx.try_recv().is_ok() {} // drain join-time presence
        hub.route(7, Role::Desktop, desk_id, mirror_data_frame("s1"));
        hub.route(7, Role::Desktop, desk_id, mirror_data_frame("s2"));
        hub.route(7, Role::Desktop, desk_id, "{\"t\":\"tabs\",\"tabs\":[]}".to_string());
        assert_eq!(grx.try_recv().unwrap(), mirror_data_frame("s1"));
        assert!(grx.try_recv().is_err(), "guest must not see other sessions or tabs");
    }

    #[test]
    fn guest_join_forwards_mirror_start_to_desktop() {
        let hub = Hub::default();
        let (_d, mut drx) = hub.join(7, Role::Desktop);
        let (_g, _grx) = hub.join_guest(7, "s1", "tok1");
        assert_eq!(drx.try_recv().unwrap(), mirror_start_f("s1"));
    }

    #[test]
    fn guest_join_learns_desktop_presence() {
        let hub = Hub::default();
        let (_d, _drx) = hub.join(7, Role::Desktop);
        let (_g, mut grx) = hub.join_guest(7, "s1", "tok1");
        assert_eq!(grx.try_recv().unwrap(), presence_frame(true));
    }

    #[test]
    fn web_mirror_stop_swallowed_while_guest_watches() {
        let hub = Hub::default();
        let (desk_id, mut drx) = hub.join(7, Role::Desktop);
        let (web_id, _wrx) = hub.join(7, Role::Web);
        let (_g, _grx) = hub.join_guest(7, "s1", "tok1");
        while drx.try_recv().is_ok() {} // drain guest-join mirror_start
        hub.route(7, Role::Web, web_id, mirror_start_f("s1"));
        while drx.try_recv().is_ok() {}
        let delivered = hub.route(7, Role::Web, web_id, mirror_stop_f("s1"));
        assert_eq!(delivered, 0, "stop must be swallowed — a guest still watches");
        assert!(drx.try_recv().is_err());
        let _ = desk_id;
    }

    #[test]
    fn last_guest_leaving_synthesizes_mirror_stop() {
        let hub = Hub::default();
        let (_d, mut drx) = hub.join(7, Role::Desktop);
        let (g_id, _grx) = hub.join_guest(7, "s1", "tok1");
        while drx.try_recv().is_ok() {}
        hub.leave_guest(7, g_id);
        assert_eq!(drx.try_recv().unwrap(), mirror_stop_f("s1"));
    }

    #[test]
    fn guest_leaving_does_not_stop_web_viewer() {
        let hub = Hub::default();
        let (_d, mut drx) = hub.join(7, Role::Desktop);
        let (web_id, _wrx) = hub.join(7, Role::Web);
        hub.route(7, Role::Web, web_id, mirror_start_f("s1"));
        let (g_id, _grx) = hub.join_guest(7, "s1", "tok1");
        while drx.try_recv().is_ok() {}
        hub.leave_guest(7, g_id);
        assert!(drx.try_recv().is_err(), "web still watches — no stop");
    }

    #[test]
    fn kick_guests_sends_revoked_and_drops_only_that_token() {
        let hub = Hub::default();
        let (_d, _drx) = hub.join(7, Role::Desktop);
        let (_g1, mut grx1) = hub.join_guest(7, "s1", "tok1");
        let (_g2, mut grx2) = hub.join_guest(7, "s1", "tok2");
        while grx1.try_recv().is_ok() {}
        while grx2.try_recv().is_ok() {}
        let n = hub.kick_guests(7, "tok1");
        assert_eq!(n, 1);
        assert_eq!(grx1.try_recv().unwrap(), "{\"t\":\"share_revoked\"}");
        // Dropped sender → channel reports disconnect for g1's receiver.
        assert!(matches!(
            grx1.try_recv(),
            Err(mpsc::error::TryRecvError::Disconnected)
        ));
        assert!(matches!(
            grx2.try_recv(),
            Err(mpsc::error::TryRecvError::Empty)
        ));
    }

    #[test]
    fn desktop_join_resumes_guest_mirrors() {
        let hub = Hub::default();
        let (_g, mut grx) = hub.join_guest(7, "s1", "tok1");
        while grx.try_recv().is_ok() {}
        let (_d, mut drx) = hub.join(7, Role::Desktop);
        hub.resume_guest_mirrors(7);
        assert_eq!(drx.try_recv().unwrap(), mirror_start_f("s1"));
        assert_eq!(grx.try_recv().unwrap(), presence_frame(true));
    }

    #[test]
    fn guest_gid_isolation_holds() {
        let hub = Hub::default();
        let (desk_id, _drx) = hub.join(2, Role::Desktop);
        let (_g, mut grx) = hub.join_guest(1, "s1", "tok1");
        while grx.try_recv().is_ok() {}
        hub.route(2, Role::Desktop, desk_id, mirror_data_frame("s1"));
        assert!(grx.try_recv().is_err());
    }
```

Existing tests: update every `hub.route(gid, role, msg)` call to pass the joining client's id, e.g. `hub.route(7, Role::Web, web_id, "list_tabs".to_string())` (bind the id from `join` instead of discarding it).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib rc 2>&1 | tail -5`
Expected: FAIL — `join_guest`/`kick_guests` etc. not found.

- [ ] **Step 3: Implement the hub changes**

In `src/rc.rs`:

```rust
struct GuestInfo {
    tx: mpsc::UnboundedSender<String>,
    session_id: String,
    token: String,
}

#[derive(Default)]
struct Presence {
    desktops: HashMap<ClientId, mpsc::UnboundedSender<String>>,
    webs: HashMap<ClientId, mpsc::UnboundedSender<String>>,
    guests: HashMap<ClientId, GuestInfo>,
    /// Sessions each owner web has asked to mirror, peeked from its
    /// mirror_start / mirror_stop frames. The relay owns mirror lifetime
    /// because several viewers (owner webs + guests) can watch one session:
    /// a stop only reaches the desktop when the LAST viewer is gone.
    web_interest: HashMap<ClientId, std::collections::HashSet<String>>,
}
impl Presence {
    fn is_empty(&self) -> bool {
        self.desktops.is_empty() && self.webs.is_empty() && self.guests.is_empty()
    }
    fn interest_count(&self, sid: &str) -> usize {
        self.guests.values().filter(|g| g.session_id == sid).count()
            + self.web_interest.values().filter(|s| s.contains(sid)).count()
    }
    /// For each session that just lost a viewer, synthesize a mirror_stop
    /// to desktops once nobody is left watching it.
    fn stop_if_unwatched(&mut self, stopped: Vec<String>) {
        for sid in stopped {
            if self.interest_count(&sid) == 0 {
                let stop = mirror_frame("mirror_stop", &sid);
                self.desktops.retain(|_, tx| tx.send(stop.clone()).is_ok());
            }
        }
    }
}

/// Minimal frame peek — only what routing decisions need.
#[derive(Deserialize)]
struct Peek {
    t: String,
    #[serde(default)]
    session_id: Option<String>,
}

fn peek(msg: &str) -> Option<Peek> {
    serde_json::from_str(msg).ok()
}

fn mirror_frame(t: &str, sid: &str) -> String {
    serde_json::json!({ "t": t, "session_id": sid }).to_string()
}
```

Replace `route`, extend `leave`, and add the guest methods on `impl Hub`:

```rust
    pub fn route(&self, gid: i64, from: Role, id: ClientId, msg: String) -> usize {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return 0 };
        let mut delivered = 0;
        match from {
            Role::Web => {
                if let Some(pk) = peek(&msg) {
                    if let Some(sid) = pk.session_id.as_deref() {
                        if pk.t == "mirror_start" {
                            p.web_interest.entry(id).or_default().insert(sid.to_string());
                        } else if pk.t == "mirror_stop" {
                            if let Some(set) = p.web_interest.get_mut(&id) {
                                set.remove(sid);
                            }
                            if p.interest_count(sid) > 0 {
                                return 0; // someone still watching — swallow
                            }
                        }
                    }
                }
                p.desktops.retain(|_, tx| match tx.send(msg.clone()) {
                    Ok(()) => { delivered += 1; true }
                    Err(_) => false,
                });
            }
            Role::Desktop => {
                p.webs.retain(|_, tx| match tx.send(msg.clone()) {
                    Ok(()) => { delivered += 1; true }
                    Err(_) => false,
                });
                // Guests get only the mirror stream of their own session.
                let pk = peek(&msg);
                let sid = pk.as_ref().and_then(|p| p.session_id.as_deref());
                let is_mirror = matches!(
                    pk.as_ref().map(|p| p.t.as_str()),
                    Some("mirror_screen" | "mirror_data")
                );
                if is_mirror {
                    if let Some(sid) = sid {
                        p.guests.retain(|_, gi| {
                            if gi.session_id != sid { return true; }
                            match gi.tx.send(msg.clone()) {
                                Ok(()) => { delivered += 1; true }
                                Err(_) => false,
                            }
                        });
                    }
                }
            }
        }
        delivered
    }

    pub fn leave(&self, gid: i64, role: Role, id: ClientId) {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return };
        let mut stopped: Vec<String> = Vec::new();
        match role {
            Role::Desktop => { p.desktops.remove(&id); }
            Role::Web => {
                p.webs.remove(&id);
                if let Some(set) = p.web_interest.remove(&id) {
                    stopped.extend(set);
                }
            }
        }
        p.stop_if_unwatched(stopped);
        if p.is_empty() { g.by_gid.remove(&gid); }
    }

    /// A guest is a read-only viewer of exactly one session, admitted by
    /// share token instead of JWT. Registers it, tells it the current
    /// desktop presence, and asks the desktop to mirror (idempotent there).
    pub fn join_guest(
        &self,
        gid: i64,
        session_id: &str,
        token: &str,
    ) -> (ClientId, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut g = self.inner.lock().expect("hub lock");
        g.next_id += 1;
        let id = g.next_id;
        let p = g.by_gid.entry(gid).or_default();
        let _ = tx.send(presence_frame(!p.desktops.is_empty()));
        let start = mirror_frame("mirror_start", session_id);
        p.desktops.retain(|_, dtx| dtx.send(start.clone()).is_ok());
        p.guests.insert(id, GuestInfo {
            tx,
            session_id: session_id.to_string(),
            token: token.to_string(),
        });
        (id, rx)
    }

    pub fn leave_guest(&self, gid: i64, id: ClientId) {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return };
        let stopped = p.guests.remove(&id)
            .map(|gi| vec![gi.session_id])
            .unwrap_or_default();
        p.stop_if_unwatched(stopped);
        if p.is_empty() { g.by_gid.remove(&gid); }
    }

    /// Revoke: terminal frame + dropped sender closes every guest socket
    /// on this token (their write loops end on channel disconnect).
    pub fn kick_guests(&self, gid: i64, token: &str) -> usize {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return 0 };
        let mut stopped = Vec::new();
        let mut n = 0;
        p.guests.retain(|_, gi| {
            if gi.token != token { return true; }
            let _ = gi.tx.send("{\"t\":\"share_revoked\"}".to_string());
            stopped.push(gi.session_id.clone());
            n += 1;
            false
        });
        p.stop_if_unwatched(stopped);
        if p.is_empty() { g.by_gid.remove(&gid); }
        n
    }

    /// On desktop (re)join: re-request mirrors for every guest-watched
    /// session (guests are passive and cannot re-send mirror_start
    /// themselves), and tell guests the desktop is back.
    pub fn resume_guest_mirrors(&self, gid: i64) {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return };
        let sids: std::collections::HashSet<String> =
            p.guests.values().map(|gi| gi.session_id.clone()).collect();
        for sid in sids {
            let start = mirror_frame("mirror_start", &sid);
            p.desktops.retain(|_, tx| tx.send(start.clone()).is_ok());
        }
        p.guests.retain(|_, gi| gi.tx.send(presence_frame(true)).is_ok());
    }
```

`notify_webs` additionally fans out to guests (it only ever carries presence):

```rust
    pub fn notify_webs(&self, gid: i64, msg: String) -> usize {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return 0 };
        let mut n = 0;
        p.webs.retain(|_, tx| match tx.send(msg.clone()) {
            Ok(()) => { n += 1; true }
            Err(_) => false,
        });
        p.guests.retain(|_, gi| match gi.tx.send(msg.clone()) {
            Ok(()) => { n += 1; true }
            Err(_) => false,
        });
        n
    }
```

In `announce_join`, the `Role::Desktop` arm also resumes guest mirrors:

```rust
        Role::Desktop => {
            hub.notify_webs(gid, presence_frame(true));
            hub.resume_guest_mirrors(gid);
        }
```

Update `handle()`'s route call: `hub.route(gid, role, id, text);`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib rc 2>&1 | tail -5`
Expected: PASS, including all pre-existing hub tests.

- [ ] **Step 5: Commit**

```bash
git add src/rc.rs
git commit -m "feat(rc): guest lane — token viewers, mirror filtering, viewer-interest refcount"
```

---

### Task 3: covenant-server — guest WS endpoint + revoke kick wiring

**Files:**
- Modify: `src/rc.rs` (guest WS handler)
- Modify: `src/main.rs` (route)
- Modify: `src/term_share.rs` (un-comment `kick_guests` if commented in Task 1)

**Interfaces:**
- Produces: `GET /rc/guest?token=<share token>` → WS. Invalid/revoked token → 404 before upgrade.
- Consumes: `Hub::join_guest` / `leave_guest` (Task 2); `term_shares` table (Task 1).

- [ ] **Step 1: Add the guest endpoint to `src/rc.rs`**

```rust
#[derive(Deserialize)]
pub struct GuestAuth { pub token: String }

/// Guest viewers authenticate with a share token, not a JWT. Unknown and
/// revoked tokens both 404 (never distinguish — link-enumeration rule).
pub async fn guest_ws(
    State(state): State<AppState>,
    Query(auth): Query<GuestAuth>,
    ws: WebSocketUpgrade,
) -> Response {
    let row: Result<Option<(i64, String)>, _> = sqlx::query_as(
        "SELECT owner_github_id, session_id FROM term_shares
         WHERE token = $1 AND NOT revoked",
    )
    .bind(&auth.token)
    .fetch_optional(&state.pool)
    .await;
    match row {
        Ok(Some((gid, session_id))) => {
            let hub = state.rc.clone();
            let token = auth.token.clone();
            ws.on_upgrade(move |sock| handle_guest(sock, hub, gid, session_id, token))
        }
        _ => axum::http::StatusCode::NOT_FOUND.into_response(),
    }
}

async fn handle_guest(
    socket: WebSocket,
    hub: Hub,
    gid: i64,
    session_id: String,
    token: String,
) {
    let (mut sink, mut stream) = socket.split();
    let (id, mut rx) = hub.join_guest(gid, &session_id, &token);
    let mut write = tokio::spawn(async move {
        let mut ping = tokio::time::interval(std::time::Duration::from_secs(20));
        loop {
            tokio::select! {
                maybe = rx.recv() => {
                    match maybe {
                        Some(text) => {
                            if sink.send(Message::Text(text)).await.is_err() { break; }
                        }
                        // Sender dropped = kicked (revoke). Ending the write
                        // task closes the socket via the select below.
                        None => break,
                    }
                }
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Vec::new())).await.is_err() { break; }
                }
            }
        }
    });
    // Guests are passive: every inbound frame is dropped unread.
    loop {
        tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
            _ = &mut write => break,
        }
    }
    hub.leave_guest(gid, id);
    write.abort();
}
```

Note `sqlx` is not currently imported in `rc.rs` — the endpoint uses `state.pool`, which exists on `AppState` (see `gist.rs`); add whatever `use` lines the compiler asks for.

- [ ] **Step 2: Wire the route in `src/main.rs`**

```rust
        .route("/rc/guest", get(rc::guest_ws))
```

- [ ] **Step 3: Re-enable the kick in `src/term_share.rs`** if it was commented out in Task 1 (`state.rc.kick_guests(claims.sub, &token);`).

- [ ] **Step 4: Build + full test**

Run: `cargo build 2>&1 | tail -3 && cargo test 2>&1 | tail -5`
Expected: clean build, all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/rc.rs src/main.rs src/term_share.rs
git commit -m "feat(rc): /rc/guest token-authed viewer socket + revoke kick"
```

---

### Task 4: covenant-server — viewer page `GET /t/:token`

**Files:**
- Create: `src/templates/term.html`
- Modify: `src/term_share.rs` (page handler)
- Modify: `src/main.rs` (route)

**Interfaces:**
- Produces: `GET /t/:token` → HTML viewer (xterm.js from jsdelivr CDN — the page is only useful online, so the CDN dependency is fine). Unknown/revoked → 404.
- Consumes: `/rc/guest?token=` (Task 3). Frames: `mirror_screen{screen,cols,rows}`, `mirror_data{b64}`, `presence{desktop_online}`, `share_revoked`.

- [ ] **Step 1: Write `src/templates/term.html`**

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Shared terminal — Covenant</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css">
<style>
  html, body { margin: 0; height: 100%; background: #0b0d10; color: #c9d1d9;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  #wrap { display: flex; flex-direction: column; height: 100%; }
  #bar { display: flex; align-items: center; gap: 10px; padding: 8px 14px;
    font-size: 12px; border-bottom: 1px solid #1c2128; }
  #bar .brand { font-weight: 600; letter-spacing: 0.04em; }
  #bar .ro { border: 1px solid #2d333b; padding: 1px 7px; opacity: 0.75; }
  #status { margin-left: auto; opacity: 0.75; }
  #term-host { flex: 1; overflow: auto; padding: 12px; }
</style>
</head>
<body>
<div id="wrap">
  <div id="bar">
    <span class="brand">COVENANT</span>
    <span class="ro">READ-ONLY</span>
    <span id="status">Connecting…</span>
  </div>
  <div id="term-host"><div id="term"></div></div>
</div>
<script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
<script>
  var TOKEN = {{ token_json | safe }};
  var statusEl = document.getElementById("status");
  var term = new Terminal({
    disableStdin: true,
    cursorBlink: false,
    fontSize: 13,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    theme: { background: "#0b0d10" },
    scrollback: 0
  });
  term.open(document.getElementById("term"));
  var revoked = false;
  var delay = 1000;
  function setStatus(t) { statusEl.textContent = t; }
  function b64bytes(b64) {
    var bin = atob(b64), out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function connect() {
    var proto = location.protocol === "https:" ? "wss" : "ws";
    var ws = new WebSocket(proto + "://" + location.host + "/rc/guest?token=" + TOKEN);
    ws.onopen = function () { delay = 1000; setStatus(""); };
    ws.onmessage = function (ev) {
      var f;
      try { f = JSON.parse(ev.data); } catch (e) { return; }
      if (f.t === "mirror_screen") {
        term.resize(f.cols, f.rows);
        term.reset();
        term.write(f.screen);
        setStatus("");
      } else if (f.t === "mirror_data") {
        term.write(b64bytes(f.b64));
      } else if (f.t === "presence") {
        setStatus(f.desktop_online ? "" : "Desktop offline — waiting…");
      } else if (f.t === "share_revoked") {
        revoked = true;
        setStatus("This share link is no longer active.");
      }
    };
    ws.onclose = function () {
      if (revoked) return;
      setStatus("Reconnecting…");
      setTimeout(connect, delay);
      delay = Math.min(delay * 2, 15000);
    };
  }
  connect();
</script>
</body>
</html>
```

- [ ] **Step 2: Add the page handler to `src/term_share.rs`**

```rust
use axum::response::Html;
use minijinja::{context, Environment};

const TERM_TPL: &str = include_str!("templates/term.html");

/// Public token-authed surface. 404 for unknown AND revoked alike.
pub async fn page(
    State(state): State<AppState>,
    Path(token): Path<String>,
) -> Result<Html<String>> {
    let live: Option<(i64,)> = sqlx::query_as(
        "SELECT id FROM term_shares WHERE token = $1 AND NOT revoked",
    )
    .bind(&token)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| AppError::Internal(e.into()))?;
    live.ok_or(AppError::NotFound)?;
    // </script>-safe token injection, same contract as gist.rs's island.
    let token_json = serde_json::to_string(&token)
        .map_err(|e| AppError::Internal(e.into()))?
        .replace('<', "\\u003c");
    let mut env = Environment::new();
    env.add_template("term.html", TERM_TPL)
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    let html = env
        .get_template("term.html")
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?
        .render(context! { token_json => token_json })
        .map_err(|e| AppError::Internal(anyhow::anyhow!(e)))?;
    Ok(Html(html))
}
```

Note: minijinja auto-escape fires on `.html` names; `token_json` is already JSON-encoded and `<`-escaped, so the template uses `{{ token_json | safe }}` — the exact contract `gist.html` uses for `data_json` (see `src/templates/gist.html:94`).

- [ ] **Step 3: Wire the route in `src/main.rs`**

```rust
        .route("/t/:token", axum::routing::get(term_share::page))
```

- [ ] **Step 4: Build + test + fmt/clippy**

Run: `cargo build && cargo test 2>&1 | tail -3 && cargo fmt --all && cargo clippy --all-targets 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 5: Commit + PR**

```bash
git add src/templates/term.html src/term_share.rs src/main.rs
git commit -m "feat(term-share): /t/:token xterm viewer page"
git push -u origin feat/term-share
gh pr create --repo karluiz/covenant-server --title "Terminal share (read-only): guest lane + /t/:token viewer" --body "..."
```

(If `gh` 403s: `gh auth switch --user karluiz`.)

---

### Task 5: app — `term_share.rs` commands + startup revoke

**Files:**
- Create: `crates/app/src/term_share.rs`
- Modify: `crates/app/src/lib.rs` (mod decl; register commands next to `covenant_gist::*` at ~`lib.rs:5990`; call `term_share::spawn_startup_revoke` in setup next to where `rc_agent`'s spawn is invoked)

**Interfaces:**
- Produces (Tauri commands, camelCase JSON):
  - `term_share_get(session_id: String) -> Option<TermShare>` — `TermShare { share_id: i64, token: String, url: String }`
  - `term_share_list() -> Vec<String>` (shared session_ids)
  - `term_share_create(session_id: String) -> TermShare`
  - `term_share_revoke(session_id: String) -> ()`
- Produces: `spawn_startup_revoke(app: &tauri::AppHandle)` — sessions never survive a restart, so every share in the state file is stale at boot; revoke them all (fire-and-forget) and clear the file. This also covers crash + quit in one place.
- Consumes: `karl_score::auth::{backend_url, load_jwt, send_authed}` — exact usage pattern in `crates/app/src/covenant_gist.rs`.

- [ ] **Step 1: Write the failing test** (inside the new file's `#[cfg(test)] mod tests`)

```rust
    #[test]
    fn share_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cov-tshare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("term_shares.json");
        let mut m = load_shares(&p);
        assert!(m.is_empty());
        m.insert(
            "01SESSION".into(),
            TermShare { share_id: 7, token: "t".into(), url: "u".into() },
        );
        save_shares(&p, &m).unwrap();
        assert_eq!(load_shares(&p).get("01SESSION").unwrap().share_id, 7);
    }
```

- [ ] **Step 2: Run it** — `cargo test -p karl-app term_share 2>&1 | tail -3` (check the crate name in `crates/app/Cargo.toml` first). Expected: FAIL (module doesn't exist / doesn't compile).

- [ ] **Step 3: Write `crates/app/src/term_share.rs`**

```rust
//! Authed HTTP client + local share-state for read-only terminal shares.
//! Mirrors `covenant_gist.rs`: same store shape, same send_authed flow.
use karl_score::auth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermShare {
    pub share_id: i64,
    pub token: String,
    pub url: String,
}

pub fn load_shares(path: &Path) -> HashMap<String, TermShare> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_shares(path: &Path, m: &HashMap<String, TermShare>) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn shares_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("term_shares.json"))
}

fn jwt() -> Result<String, String> {
    auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in to Covenant".to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

async fn send_authed(
    build: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let j = jwt()?;
    auth::send_authed(&j, build)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())
}

async fn post_share(session_id: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/term-shares", auth::backend_url());
    let body = serde_json::json!({ "session_id": session_id });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn post_revoke(id: i64) -> Result<(), String> {
    let url = format!("{}/term-shares/{}/revoke", auth::backend_url(), id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

#[tauri::command]
pub async fn term_share_get(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Option<TermShare>, String> {
    Ok(load_shares(&shares_path(&app)?).get(&session_id).cloned())
}

/// All locally-known shared sessions — lets the UI badge tabs
/// without a per-tab round-trip.
#[tauri::command]
pub async fn term_share_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(load_shares(&shares_path(&app)?).into_keys().collect())
}

#[tauri::command]
pub async fn term_share_create(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<TermShare, String> {
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    // Re-share of a live session keeps the same link (server does too).
    if let Some(existing) = shares.get(&session_id).cloned() {
        return Ok(existing);
    }
    let resp = post_share(&session_id).await?;
    let share_id = resp["id"].as_i64().ok_or("missing id in response")?;
    let token = resp["token"]
        .as_str()
        .ok_or("missing token in response")?
        .to_string();
    let share = TermShare {
        share_id,
        token: token.clone(),
        url: format!("{}/t/{}", auth::backend_url(), token),
    };
    shares.insert(session_id, share.clone());
    save_shares(&file, &shares)?;
    Ok(share)
}

#[tauri::command]
pub async fn term_share_revoke(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<(), String> {
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    let share = shares.get(&session_id).cloned().ok_or("not shared")?;
    post_revoke(share.share_id).await?;
    shares.remove(&session_id);
    save_shares(&file, &shares)
}

/// Sessions never survive an app restart, so every share on disk is stale
/// at boot — revoke them all (covers quit AND crash) and clear the file.
/// Fire-and-forget: failures leave links pointing at an offline desktop,
/// which the viewer surfaces as "Desktop offline".
pub fn spawn_startup_revoke(app: &tauri::AppHandle) {
    let Ok(file) = shares_path(app) else { return };
    tauri::async_runtime::spawn(async move {
        let shares = load_shares(&file);
        if shares.is_empty() {
            return;
        }
        for share in shares.values() {
            let _ = post_revoke(share.share_id).await;
        }
        let _ = save_shares(&file, &HashMap::new());
    });
}
```

(Test from Step 1 goes at the bottom of this file.)

- [ ] **Step 4: Wire into `lib.rs`** — `mod term_share;` next to `mod covenant_gist;`; add the four commands to `invoke_handler` next to the `covenant_gist::` entries (~line 5990); call `term_share::spawn_startup_revoke(&app_handle);` in setup near the `rc_agent` spawn call (grep `rc_agent::` in `lib.rs` for the exact spot; use whatever handle variable is in scope there).

- [ ] **Step 5: Run tests** — `cargo test -p <app crate> term_share 2>&1 | tail -3`. Expected: PASS. Then `cargo clippy --workspace --all-targets 2>&1 | tail -3` clean.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/term_share.rs crates/app/src/lib.rs
git commit -m "feat(term-share): app commands + startup stale-share revoke"
```

---

### Task 6: app UI — context menu, tab badge, auto-revoke on close

**Files:**
- Create: `ui/src/ui/share-link.ts` (extracted copy-or-toast helper)
- Create: `ui/src/term-share/api.ts`
- Create: `ui/src/term-share/share.ts`
- Create: `ui/src/term-share/share.test.ts`
- Modify: `ui/src/gist/share.ts` (swap its private `copyOrOffer` for the shared helper)
- Modify: `ui/src/tabs/manager.ts` (context menu ~`openTabContextMenu` line 7872; pill render `renderTabPill` line 7576; `finalizeCloseTab` line 6323; constructor listener)
- Modify: `ui/src/styles.css` (next to `.tab-live-dot` at 14289)

**Interfaces:**
- Consumes: Task 5 commands.
- Produces: `isTermShared(sessionId): boolean`, `ensureTermSharesLoaded(): void`, `shareSession(sessionId): Promise<void>`, `copyTermShareLink(sessionId): Promise<void>`, `stopSharing(sessionId): Promise<void>`, `revokeIfShared(sessionId): void` (fire-and-forget for close paths), `TERM_SHARE_EVENT` (window CustomEvent name `"covenant:term-shares-changed"`).

- [ ] **Step 1a: Extract the copy-or-toast helper** — `ui/src/ui/share-link.ts` (moved verbatim from `ui/src/gist/share.ts`'s private `copyOrOffer`, parametrized messages):

```ts
import { pushInfoToast } from "../notifications/toast";
import { copyText } from "./clipboard";

/// Copy, and if the webview refuses (transient activation is gone after a
/// network round-trip), fall back to a toast the user clicks — that click
/// IS a fresh user gesture, so the retry succeeds. Publishing already
/// happened; a clipboard hiccup must never read as "share failed".
export async function copyLinkOrOffer(
  url: string,
  copiedMsg: string,
  offerMsg: string,
): Promise<void> {
  try {
    await copyText(url);
    pushInfoToast({ message: copiedMsg });
  } catch {
    pushInfoToast({
      message: `${offerMsg}: ${url}`,
      onClick: () => {
        void copyText(url);
      },
    });
  }
}
```

Refactor `ui/src/gist/share.ts`: delete its private `copyOrOffer`, import `copyLinkOrOffer` from `../ui/share-link`, and replace the two call sites with `copyLinkOrOffer(url, "Gist link copied", "Gist published — click to copy")`. Behavior identical; `ui/src/gist/share.test.ts` must still pass unchanged.

- [ ] **Step 1: `ui/src/term-share/api.ts`**

```ts
import { invoke } from "@tauri-apps/api/core";

export interface TermShare {
  shareId: number;
  token: string;
  url: string;
}

export const termShareApi = {
  getShare: (sessionId: string) =>
    invoke<TermShare | null>("term_share_get", { sessionId }),
  listShares: () => invoke<string[]>("term_share_list"),
  create: (sessionId: string) =>
    invoke<TermShare>("term_share_create", { sessionId }),
  revoke: (sessionId: string) =>
    invoke<void>("term_share_revoke", { sessionId }),
};
```

- [ ] **Step 2: Write the failing test** `ui/src/term-share/share.test.ts`

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../notifications/toast", () => ({ pushInfoToast: vi.fn() }));
vi.mock("../ui/clipboard", () => ({ copyText: vi.fn(async () => {}) }));

import { invoke } from "@tauri-apps/api/core";
import { isTermShared, shareSession, stopSharing, _resetForTest } from "./share";

const mockInvoke = vi.mocked(invoke);

describe("term-share local state", () => {
  beforeEach(() => {
    _resetForTest();
    mockInvoke.mockReset();
  });

  it("marks a session shared after shareSession", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "t", url: "u" });
    expect(isTermShared("S1")).toBe(false);
    await shareSession("S1");
    expect(isTermShared("S1")).toBe(true);
  });

  it("clears the flag after stopSharing", async () => {
    mockInvoke.mockResolvedValue({ shareId: 1, token: "t", url: "u" });
    await shareSession("S1");
    mockInvoke.mockResolvedValue(undefined);
    await stopSharing("S1");
    expect(isTermShared("S1")).toBe(false);
  });
});
```

- [ ] **Step 3: Run it** — from repo ROOT: `npm test -- term-share 2>&1 | tail -5`. Expected: FAIL (`./share` missing).

- [ ] **Step 4: `ui/src/term-share/share.ts`**

```ts
import { termShareApi } from "./api";
import { pushInfoToast } from "../notifications/toast";
import { copyLinkOrOffer } from "../ui/share-link";

/// Locally-known shared sessions, mirrored from the backend store so the
/// tab strip can badge synchronously. Same shape as gist/share.ts.
export const TERM_SHARE_EVENT = "covenant:term-shares-changed";
const sharedSessions = new Set<string>();
let sharesLoaded = false;

function notifyChanged(): void {
  window.dispatchEvent(new CustomEvent(TERM_SHARE_EVENT));
}

export function isTermShared(sessionId: string): boolean {
  return sharedSessions.has(sessionId);
}

/// Idempotent — first caller triggers the fetch, later calls no-op.
export function ensureTermSharesLoaded(): void {
  if (sharesLoaded) return;
  sharesLoaded = true;
  void termShareApi
    .listShares()
    .then((ids) => {
      for (const id of ids) sharedSessions.add(id);
      if (ids.length > 0) notifyChanged();
    })
    .catch(() => {
      sharesLoaded = false; // transient failure — retry on next call
    });
}

function copyOrOffer(url: string): Promise<void> {
  return copyLinkOrOffer(
    url,
    "Share link copied — read-only",
    "Session shared — click to copy",
  );
}

export async function shareSession(sessionId: string): Promise<void> {
  const share = await termShareApi.create(sessionId);
  sharedSessions.add(sessionId);
  notifyChanged();
  await copyOrOffer(share.url);
}

export async function copyTermShareLink(sessionId: string): Promise<void> {
  const share = await termShareApi.getShare(sessionId);
  if (share) await copyOrOffer(share.url);
}

export async function stopSharing(sessionId: string): Promise<void> {
  await termShareApi.revoke(sessionId);
  sharedSessions.delete(sessionId);
  notifyChanged();
  pushInfoToast({ message: "Stopped sharing" });
}

/// Fire-and-forget close-path hook: a failed revoke must never block a
/// tab close (startup cleanup in Rust catches leftovers next boot).
export function revokeIfShared(sessionId: string): void {
  if (!sharedSessions.has(sessionId)) return;
  sharedSessions.delete(sessionId);
  notifyChanged();
  void termShareApi.revoke(sessionId).catch(() => {});
}

/// Test-only.
export function _resetForTest(): void {
  sharedSessions.clear();
  sharesLoaded = false;
}
```

- [ ] **Step 5: Run tests** — `npm test -- term-share 2>&1 | tail -5`. Expected: PASS.

- [ ] **Step 6: Wire `ui/src/tabs/manager.ts`**

Imports:

```ts
import {
  TERM_SHARE_EVENT,
  ensureTermSharesLoaded,
  isTermShared,
  shareSession,
  copyTermShareLink,
  stopSharing,
  revokeIfShared,
} from "../term-share/share";
```

(a) Constructor (near other window listeners): re-render the strip when shares change, and prime the cache:

```ts
    ensureTermSharesLoaded();
    window.addEventListener(TERM_SHARE_EVENT, () => this.renderTabbar());
```

(b) In `openTabContextMenu`, inside the existing `if (tab.kind !== "browser")` block (terminal-only — browser tabs have no session), after the operator items:

```ts
    if (ctxSessionId) {
      items.push({ divider: true });
      if (isTermShared(ctxSessionId)) {
        items.push({
          label: "Copy share link",
          icon: Icons.share(),
          onClick: () => void copyTermShareLink(ctxSessionId),
        });
        items.push({
          label: "Stop sharing",
          icon: Icons.x(),
          onClick: () => void stopSharing(ctxSessionId),
        });
      } else {
        items.push({
          label: "Share read-only…",
          icon: Icons.share(),
          onClick: () => void shareSession(ctxSessionId),
        });
      }
    }
```

(c) In `renderTabPill` (line 7576), where the pill element is assembled (same place the other leading dots mount — follow `renderTabLiveDot`'s insertBefore pattern but inline, since the pill is being built):

```ts
    const shareSid = activePane(tab).sessionId;
    if (shareSid && isTermShared(shareSid)) {
      const dot = document.createElement("span");
      dot.className = "tab-share-dot";
      attachTooltip(dot, "Sharing read-only");
      pill.insertBefore(dot, pill.firstChild);
    }
```

(`attachTooltip` from `../tooltip/tooltip` — never `element.title`.) If `renderTabPill` builds children in a fixed order, append the dot at the same point the busy/live dots land.

(d) In `finalizeCloseTab` (line 6323), right after `const tab = this.tabs[idx];`:

```ts
    for (const p of tab.panes) {
      if (p.sessionId) revokeIfShared(p.sessionId);
    }
```

- [ ] **Step 7: CSS** — in `ui/src/styles.css` next to `.tab-live-dot` (14289):

```css
.tab-share-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin-right: 6px;
  border-radius: 50%;
  background: #f97316;
  box-shadow: 0 0 5px rgba(249, 115, 22, 0.5);
  vertical-align: middle;
  flex-shrink: 0;
}
```

(Solid dot — filled = "broadcasting", vs the live dot's hollow ring. `border-radius: 50%` is the allowed exception to the sharp-corners rule.)

- [ ] **Step 8: Verify** — from repo ROOT:

Run: `npm test 2>&1 | tail -5 && npm run build 2>&1 | tail -3`
Expected: vitest green, `tsc` + Vite build clean.

- [ ] **Step 9: Commit**

```bash
git add ui/src/term-share ui/src/ui/share-link.ts ui/src/gist/share.ts ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(term-share): tab context-menu share, share dot, auto-revoke on close"
```

---

### Task 7: End-to-end smoke (manual, after server deploy)

**Files:** none.

- [ ] **Step 1:** Merge + deploy the covenant-server PR to forge (existing deploy flow for that repo — see `project_covenant_server_pulzen_redeploy` memory: covenant-rg / forge.covenant.uno). Migration 0013 runs automatically via `sqlx::migrate!` on boot.
- [ ] **Step 2:** In a dev app build (`npm run tauri:dev` — dev config needs the copied `config.json`, see CLAUDE.md), right-click a terminal tab → "Share read-only…" → link lands on the clipboard; orange dot appears on the tab.
- [ ] **Step 3:** Open the link in a plain browser window (not signed in): live terminal appears; type in the desktop and watch it stream; resize the desktop terminal and confirm the viewer follows the grid.
- [ ] **Step 4:** With the guest open, open `covenant.uno`'s RC dashboard, mirror the same tab, then switch away (dashboard sends `mirror_stop`) — the guest stream must keep flowing (relay swallowed the stop).
- [ ] **Step 5:** "Stop sharing" from the tab menu → viewer shows "This share link is no longer active." within a second; reloading the link 404s.
- [ ] **Step 6:** Share again, close the tab → link goes dead (auto-revoke). Share again, quit and relaunch the app → link dead after startup cleanup runs.

---

## Deferred (spec-consistent, do not build now)

- Scrollback for viewers, viewer identity, timed expiry, scale-to-fit rendering polish on the viewer page, and surfacing "N guests watching" to the owner (guests are invisible to the desktop today beyond bandwidth).
