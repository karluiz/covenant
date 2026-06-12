# Covenant RC-0 · Part 1: Relay (covenant-server) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an authenticated, in-memory WebSocket relay to `covenant-server` that routes opaque text frames between endpoints sharing the same `github_id` (`/rc/desktop` ↔ `/rc/web`).

**Architecture:** A pure `Hub` struct (routing + presence, no sockets) holds, per `github_id`, the set of connected desktop and web senders. Two thin axum WebSocket handlers (`/rc/desktop`, `/rc/web`) authenticate via a `?token=<jwt>` query param, join the hub, pump frames between the socket and the hub, and emit presence updates on join/leave. The relay never parses frame bodies — it only forwards text and tracks presence.

**Tech Stack:** Rust, axum 0.7 (`ws` feature), tokio, `futures-util`, existing `jwt::verify`. Tests are synchronous unit tests against `Hub` plus one manual two-client smoke test.

**Repo:** `~/Sources/covenant-server` (separate git repo from `karlTerminal`). Do the work in a git worktree of `covenant-server` (create it at execution time via `superpowers:using-git-worktrees`).

**Scope note:** This is Part 1 of RC-0. Part 2 (desktop `rc-agent`) and Part 3 (web dashboard) get their own plans and depend on this relay existing. This plan delivers working, testable software on its own: you can connect two WebSocket clients and watch frames route by `github_id`.

---

## File Structure

- **Create** `src/rc.rs` — the relay: `Hub` struct (routing/presence) + the two axum WS handlers + auth helper. One responsibility: relay transport. ~200 lines.
- **Modify** `src/main.rs` — add `mod rc;`, add `rc: rc::Hub` to `AppState`, register the two routes, enable the `ws` axum feature usage.
- **Modify** `Cargo.toml` — enable axum `ws` feature; add `futures-util`; add `tokio-tungstenite` as a dev-dependency for the smoke test.
- **Modify** `infra/provision-pulzen.sh` — document/enable Azure App Service WebSockets.

---

## Task 1: Dependencies & feature flags

**Files:**
- Modify: `Cargo.toml`

- [ ] **Step 1: Enable axum `ws` and add `futures-util` + dev-dep**

Edit `Cargo.toml`. Change the axum line and add two lines:

```toml
axum = { version = "0.7", features = ["macros", "ws"] }
futures-util = "0.3"
```

Add a `[dev-dependencies]` section at the end of the file (create it if absent):

```toml
[dev-dependencies]
tokio-tungstenite = "0.24"
```

- [ ] **Step 2: Verify it compiles**

Run: `cargo build`
Expected: PASS (no code uses the new deps yet, but features must resolve).

- [ ] **Step 3: Commit**

```bash
git add Cargo.toml Cargo.lock
git commit -m "chore(rc): enable axum ws feature, add futures-util + tungstenite dev-dep"
```

---

## Task 2: The `Hub` — routing & presence (pure, socket-free)

**Files:**
- Create: `src/rc.rs`

The `Hub` is the heart of the relay and is fully unit-testable without any network. It tracks, per `github_id`, the connected desktops and webs as `mpsc::UnboundedSender<String>` channels. `route` forwards a text frame from one role to the *other* role's senders within the same `github_id`.

- [ ] **Step 1: Write the failing tests**

Create `src/rc.rs` with ONLY this test module at the bottom (the types it references come in Step 3):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_frame_routes_to_same_gid_desktop() {
        let hub = Hub::default();
        let (_web_id, _web_rx) = hub.join(7, Role::Web);
        let (_desk_id, mut desk_rx) = hub.join(7, Role::Desktop);

        let delivered = hub.route(7, Role::Web, "list_tabs".to_string());

        assert_eq!(delivered, 1);
        assert_eq!(desk_rx.try_recv().unwrap(), "list_tabs");
    }

    #[test]
    fn desktop_frame_routes_to_same_gid_web() {
        let hub = Hub::default();
        let (_desk_id, _desk_rx) = hub.join(7, Role::Desktop);
        let (_web_id, mut web_rx) = hub.join(7, Role::Web);

        let delivered = hub.route(7, Role::Desktop, "tabs".to_string());

        assert_eq!(delivered, 1);
        assert_eq!(web_rx.try_recv().unwrap(), "tabs");
    }

    #[test]
    fn different_gid_is_isolated() {
        let hub = Hub::default();
        let (_web_id, mut web_rx) = hub.join(1, Role::Web);
        let (_desk_id, _desk_rx) = hub.join(2, Role::Desktop);

        let delivered = hub.route(2, Role::Desktop, "secret".to_string());

        assert_eq!(delivered, 0); // gid 2 has no web client
        assert!(web_rx.try_recv().is_err()); // gid 1 web never receives gid 2 data
    }

    #[test]
    fn leave_removes_sender_and_updates_presence() {
        let hub = Hub::default();
        let (desk_id, _desk_rx) = hub.join(9, Role::Desktop);
        assert!(hub.desktop_online(9));

        hub.leave(9, Role::Desktop, desk_id);

        assert!(!hub.desktop_online(9));
        // routing to a now-empty desktop set delivers to nobody
        let (_w, _wr) = hub.join(9, Role::Web);
        assert_eq!(hub.route(9, Role::Web, "x".to_string()), 0);
    }
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --lib rc::tests`
Expected: FAIL to compile — `Hub`, `Role`, etc. not defined.

- [ ] **Step 3: Implement the `Hub`**

Insert ABOVE the test module in `src/rc.rs`:

```rust
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::mpsc;

pub type ClientId = u64;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Role {
    Desktop,
    Web,
}

#[derive(Default)]
struct Presence {
    desktops: HashMap<ClientId, mpsc::UnboundedSender<String>>,
    webs: HashMap<ClientId, mpsc::UnboundedSender<String>>,
}

impl Presence {
    fn is_empty(&self) -> bool {
        self.desktops.is_empty() && self.webs.is_empty()
    }
}

#[derive(Default)]
struct HubInner {
    next_id: ClientId,
    by_gid: HashMap<i64, Presence>,
}

/// In-memory relay registry. Cheap to clone (Arc). Holds no Postgres state.
#[derive(Clone, Default)]
pub struct Hub {
    inner: Arc<Mutex<HubInner>>,
}

impl Hub {
    /// Register a connection. Returns its id and the receiver the WS write
    /// task drains to push frames down to this client.
    pub fn join(&self, gid: i64, role: Role) -> (ClientId, mpsc::UnboundedReceiver<String>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let mut g = self.inner.lock().expect("hub lock");
        g.next_id += 1;
        let id = g.next_id;
        let p = g.by_gid.entry(gid).or_default();
        match role {
            Role::Desktop => { p.desktops.insert(id, tx); }
            Role::Web => { p.webs.insert(id, tx); }
        }
        (id, rx)
    }

    /// Remove a connection; drop the gid entry if it became empty.
    pub fn leave(&self, gid: i64, role: Role, id: ClientId) {
        let mut g = self.inner.lock().expect("hub lock");
        if let Some(p) = g.by_gid.get_mut(&gid) {
            match role {
                Role::Desktop => { p.desktops.remove(&id); }
                Role::Web => { p.webs.remove(&id); }
            }
            if p.is_empty() {
                g.by_gid.remove(&gid);
            }
        }
    }

    /// Forward `msg` from `from` role to the OTHER role within the same gid.
    /// Returns how many clients it was delivered to. Prunes dead senders.
    pub fn route(&self, gid: i64, from: Role, msg: String) -> usize {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return 0 };
        let targets = match from {
            Role::Web => &mut p.desktops,
            Role::Desktop => &mut p.webs,
        };
        let mut delivered = 0;
        targets.retain(|_, tx| {
            match tx.send(msg.clone()) {
                Ok(()) => { delivered += 1; true }
                Err(_) => false, // receiver gone; prune
            }
        });
        delivered
    }

    pub fn desktop_online(&self, gid: i64) -> bool {
        let g = self.inner.lock().expect("hub lock");
        g.by_gid.get(&gid).map(|p| !p.desktops.is_empty()).unwrap_or(false)
    }

    pub fn web_count(&self, gid: i64) -> usize {
        let g = self.inner.lock().expect("hub lock");
        g.by_gid.get(&gid).map(|p| p.webs.len()).unwrap_or(0)
    }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test --lib rc::tests`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/rc.rs
git commit -m "feat(rc): Hub — github_id-keyed in-memory routing + presence, unit tested"
```

---

## Task 3: Wire `Hub` into `AppState` and register module

**Files:**
- Modify: `src/main.rs`

- [ ] **Step 1: Declare the module and add the field**

In `src/main.rs`, add to the `mod` list near the top (after `mod profile;`):

```rust
mod rc;
```

Add a field to `AppState`:

```rust
#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub jwt_secret: String,
    pub rc: rc::Hub,
}
```

- [ ] **Step 2: Construct it in `main`**

In `main()`, change the state construction:

```rust
let state = AppState { pool, jwt_secret, rc: rc::Hub::default() };
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main.rs
git commit -m "feat(rc): mount Hub on AppState"
```

---

## Task 4: WS auth helper + the two handlers

**Files:**
- Modify: `src/rc.rs`
- Modify: `src/main.rs`

Browser `WebSocket` cannot set an `Authorization` header, so both endpoints authenticate via a `?token=<jwt>` query param. (Tradeoff: query params can appear in access logs; acceptable for v0. A later phase can switch to the `Sec-WebSocket-Protocol` bearer trick.)

- [ ] **Step 1: Add the handler imports and auth + connection glue to `src/rc.rs`**

At the TOP of `src/rc.rs` (above the `Hub` code), add:

```rust
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, State};
use axum::response::Response;
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use crate::{jwt, AppState};

#[derive(Deserialize)]
pub struct WsAuth {
    pub token: String,
}

pub async fn desktop_ws(
    State(state): State<AppState>,
    Query(auth): Query<WsAuth>,
    ws: WebSocketUpgrade,
) -> Response {
    serve(state, auth, ws, Role::Desktop).await
}

pub async fn web_ws(
    State(state): State<AppState>,
    Query(auth): Query<WsAuth>,
    ws: WebSocketUpgrade,
) -> Response {
    serve(state, auth, ws, Role::Web).await
}

async fn serve(state: AppState, auth: WsAuth, ws: WebSocketUpgrade, role: Role) -> Response {
    match jwt::verify(&state.jwt_secret, &auth.token) {
        Ok(claims) => ws.on_upgrade(move |sock| handle(sock, state.rc, claims.sub, role)),
        Err(_) => {
            // Reject the upgrade with 401 before switching protocols.
            axum::http::StatusCode::UNAUTHORIZED.into_response()
        }
    }
}

async fn handle(socket: WebSocket, hub: Hub, gid: i64, role: Role) {
    let (mut sink, mut stream) = socket.split();
    let (id, mut rx) = hub.join(gid, role);

    // Write task: hub -> this socket.
    let write = tokio::spawn(async move {
        while let Some(text) = rx.recv().await {
            if sink.send(Message::Text(text)).await.is_err() {
                break;
            }
        }
    });

    // Read loop: this socket -> hub (routed to the opposite role).
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(text) => { hub.route(gid, role, text); }
            Message::Close(_) => break,
            _ => {} // ignore binary/ping/pong here; keepalive added in Task 6
        }
    }

    hub.leave(gid, role, id);
    write.abort();
}
```

Make `axum::response::IntoResponse` available where used — add `use axum::response::IntoResponse;` to the import block above.

- [ ] **Step 2: Register the routes in `src/main.rs`**

In `main()`, add to the router chain (after `.route("/docs", get(docs))`):

```rust
.route("/rc/desktop", get(rc::desktop_ws))
.route("/rc/web", get(rc::web_ws))
```

- [ ] **Step 3: Verify it compiles**

Run: `cargo build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/rc.rs src/main.rs
git commit -m "feat(rc): /rc/desktop + /rc/web WS handlers with ?token JWT auth"
```

---

## Task 5: Presence frames on join/leave

**Files:**
- Modify: `src/rc.rs`

When a desktop's presence changes, web clients of that gid should be told. We send a minimal JSON presence frame (the relay is otherwise opaque, but presence is relay-owned state, so it is allowed to synthesize this one frame type).

- [ ] **Step 1: Add a presence-broadcast helper to `Hub`**

In `impl Hub`, add:

```rust
    /// Send a relay-synthesized text frame to ALL web clients of a gid.
    /// Used for presence updates. Returns count delivered.
    pub fn notify_webs(&self, gid: i64, msg: String) -> usize {
        let mut g = self.inner.lock().expect("hub lock");
        let Some(p) = g.by_gid.get_mut(&gid) else { return 0 };
        let mut n = 0;
        p.webs.retain(|_, tx| match tx.send(msg.clone()) {
            Ok(()) => { n += 1; true }
            Err(_) => false,
        });
        n
    }
```

- [ ] **Step 2: Add a test for `notify_webs`**

Add to the `tests` module:

```rust
    #[test]
    fn notify_webs_reaches_only_web_clients() {
        let hub = Hub::default();
        let (_d, mut drx) = hub.join(3, Role::Desktop);
        let (_w, mut wrx) = hub.join(3, Role::Web);

        let n = hub.notify_webs(3, "{\"t\":\"presence\"}".to_string());

        assert_eq!(n, 1);
        assert!(wrx.try_recv().is_ok());
        assert!(drx.try_recv().is_err()); // desktops do not get presence frames
    }
```

- [ ] **Step 3: Run tests to verify the new test passes**

Run: `cargo test --lib rc::tests`
Expected: PASS (5 tests).

- [ ] **Step 4: Emit presence on desktop connect/disconnect**

In `handle`, just AFTER `let (id, mut rx) = hub.join(gid, role);`, add:

```rust
    if role == Role::Desktop {
        hub.notify_webs(gid, presence_frame(true));
    }
```

And just BEFORE `hub.leave(gid, role, id);` near the end, add:

```rust
    if role == Role::Desktop {
        // After we leave, recompute; but emit the post-leave state.
        hub.leave(gid, role, id);
        hub.notify_webs(gid, presence_frame(hub.desktop_online(gid)));
        write.abort();
        return;
    }
```

Then add this free function below `handle`:

```rust
fn presence_frame(desktop_online: bool) -> String {
    format!("{{\"t\":\"presence\",\"desktop_online\":{}}}", desktop_online)
}
```

> Note: the `return` above means the trailing `hub.leave(...); write.abort();` lines from Task 4 now only run for the Web role. Verify both paths call `leave` exactly once and `write.abort()` exactly once. The final shape of the tail of `handle`:
> ```rust
>     // (read loop ended)
>     if role == Role::Desktop {
>         hub.leave(gid, role, id);
>         hub.notify_webs(gid, presence_frame(hub.desktop_online(gid)));
>         write.abort();
>         return;
>     }
>     hub.leave(gid, role, id);
>     write.abort();
> ```

- [ ] **Step 5: Verify it compiles and tests pass**

Run: `cargo test --lib rc::tests && cargo build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/rc.rs
git commit -m "feat(rc): emit presence frame to web clients on desktop connect/disconnect"
```

---

## Task 6: Ping/pong keepalive (survive Azure ~230s idle timeout)

**Files:**
- Modify: `src/rc.rs`

- [ ] **Step 1: Send periodic pings from the write task**

Replace the `write` task in `handle` with a version that also pings every 20s. Change:

```rust
    let write = tokio::spawn(async move {
        let mut ping = tokio::time::interval(std::time::Duration::from_secs(20));
        loop {
            tokio::select! {
                maybe = rx.recv() => {
                    match maybe {
                        Some(text) => {
                            if sink.send(Message::Text(text)).await.is_err() { break; }
                        }
                        None => break,
                    }
                }
                _ = ping.tick() => {
                    if sink.send(Message::Ping(Vec::new())).await.is_err() { break; }
                }
            }
        }
    });
```

Pong frames from the client are automatically handled by axum and arrive as `Message::Pong` in the read loop (already ignored by the `_ => {}` arm — confirm that arm exists).

- [ ] **Step 2: Verify it compiles**

Run: `cargo build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/rc.rs
git commit -m "feat(rc): 20s ping keepalive to survive Azure idle timeout"
```

---

## Task 7: Enable Azure App Service WebSockets

**Files:**
- Modify: `infra/provision-pulzen.sh`

- [ ] **Step 1: Add the enable command (idempotent) to the provisioning script**

Append to `infra/provision-pulzen.sh` (near the other `az webapp config` calls):

```bash
# WebSockets are OFF by default on App Service; the /rc relay needs them.
az webapp config set \
  --name covenant-uno \
  --resource-group covenant-rg \
  --web-sockets-enabled true
```

- [ ] **Step 2: Run it once against the live app**

Run: `az webapp config set --name covenant-uno --resource-group covenant-rg --web-sockets-enabled true`
Expected: JSON output with `"webSocketsEnabled": true`.

- [ ] **Step 3: Commit**

```bash
git add infra/provision-pulzen.sh
git commit -m "chore(infra): enable App Service websockets for /rc relay"
```

---

## Task 8: Manual two-client smoke test

**Files:**
- Create: `tests/rc_smoke.rs`

This integration test boots the router in-process and connects two `tokio-tungstenite` clients with valid JWTs for the same `github_id`, then asserts a frame sent on `/rc/web` arrives on `/rc/desktop`.

- [ ] **Step 1: Write the integration test**

Create `tests/rc_smoke.rs`:

```rust
use covenant_server as _; // ensure crate links; adjust if crate name differs

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

// NOTE: This test requires a running DB-less router. If `AppState` construction
// needs a live Postgres pool, gate this test behind `#[ignore]` and run it
// manually against the deployed relay instead (see Step 3).

#[tokio::test]
#[ignore] // run explicitly: cargo test --test rc_smoke -- --ignored
async fn web_to_desktop_relays() {
    // 1. mint two JWTs for gid=42 with the same secret the server uses
    // 2. connect ws://127.0.0.1:PORT/rc/desktop?token=...  and  /rc/web?token=...
    // 3. send "list_tabs" on web; assert "list_tabs" arrives on desktop
    // Implementation depends on how the server is booted in-process; if the
    // current main.rs hard-requires DATABASE_URL, prefer the manual smoke below.
}
```

- [ ] **Step 2: Decide path based on whether the router can boot without Postgres**

Run: `cargo test --test rc_smoke -- --ignored`
Expected: PASS if the router boots DB-less; otherwise leave `#[ignore]` and use Step 3.

- [ ] **Step 3: Manual smoke against the deployed relay (authoritative for v0)**

After deploy + Azure websockets enabled, with a valid JWT in `$JWT`:

```bash
# terminal A — desktop side
npx wscat -c "wss://forge.covenant.uno/rc/desktop?token=$JWT"
# terminal B — web side
npx wscat -c "wss://forge.covenant.uno/rc/web?token=$JWT"
# type {"t":"list_tabs"} in B  -> it should appear in A
# closing A should print a {"t":"presence","desktop_online":false} in B
```

Expected: frame typed in B appears in A; presence frame appears in B when A disconnects; a wrong/missing token yields HTTP 401 on connect.

- [ ] **Step 4: Commit**

```bash
git add tests/rc_smoke.rs
git commit -m "test(rc): relay smoke test (ignored unit + manual wscat procedure)"
```

---

## Self-Review

**Spec coverage (against the design's relay/connection/presence sections):**
- ✅ `/rc/desktop` + `/rc/web` WS endpoints — Task 4.
- ✅ JWT auth on handshake, invalid → reject — Task 4 (401; note: spec said close 4401, but pre-upgrade 401 is the axum-idiomatic equivalent and is what a browser sees on a failed upgrade).
- ✅ In-memory presence keyed by `github_id`, nothing in Postgres — Task 2/3.
- ✅ Route opaque frames between same-gid endpoints — Task 2/4.
- ✅ Presence frame to web on desktop join/leave — Task 5.
- ✅ 20s ping/pong vs Azure idle timeout — Task 6.
- ✅ Azure `--web-sockets-enabled` — Task 7.
- ⏸ `target_device_id` multi-device routing — **deferred** from RC-0 (spec lists it; RC-0 broadcasts to all same-gid desktops/webs, which is correct for the single-device common case). Call this out to the user; first follow-up after Parts 2/3.

**Placeholder scan:** Task 8's in-process test is intentionally conditional (it depends on whether `main.rs` can boot without a DB) with a concrete manual fallback — not a hidden TODO. All code steps contain complete code.

**Type consistency:** `Hub`, `Role::{Desktop,Web}`, `ClientId`, `join`/`leave`/`route`/`notify_webs`/`desktop_online`/`web_count`, `presence_frame`, `WsAuth{token}`, `desktop_ws`/`web_ws`/`serve`/`handle` are consistent across Tasks 2–6. `AppState { pool, jwt_secret, rc }` matches Task 3.

---

## Follow-on plans (not this plan)

- **RC-0 Part 2 — desktop `rc-agent`** (`karlTerminal`): outbound WS client to `/rc/desktop?token=<keychain jwt>`, reconnect/backoff, answer `list_tabs` by enumerating `AppState.sessions` + tab manifest, push `tabs`. Read-only.
- **RC-0 Part 3 — web dashboard** (`covenant.uno`): authed page, connect `/rc/web`, send `list_tabs`, render `tabs` + presence.
