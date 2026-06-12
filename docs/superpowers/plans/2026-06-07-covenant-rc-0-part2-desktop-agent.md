# Covenant RC-0 · Part 2: Desktop `rc-agent` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A long-lived background module in the desktop app that connects (outbound) to the relay's `/rc/desktop` endpoint with the user's JWT, and answers a `list_tabs` request by enumerating the user's terminal sessions with metadata (`tabs` frame). Read-only — no control yet.

**Architecture:** A new `crates/app/src/rc_agent.rs` module spawned at startup. It runs a reconnecting WebSocket client (`tokio-tungstenite`) to `wss://forge.covenant.uno/rc/desktop?token=<jwt>`. On each inbound `{"t":"list_tabs"}` text frame, it reads `AppState.sessions` via the `AppHandle`, builds a `tabs` frame (session_id, title, cwd, executor, phase, armed=false), and sends it. Pure helpers (URL building, phase→string, backoff, frame serde, tab-info construction) are unit-tested; the connect/enumerate glue is verified by running the app against the live relay.

**Tech Stack:** Rust, `tokio-tungstenite` (rustls), `serde`, existing `karl_score::auth` (JWT from Keychain), `NotchHub::phase_snapshot`, `SessionWorldModel`.

**Repo:** `~/Sources/karlTerminal`. Do the work in a git worktree of `karlTerminal` (create at execution time via `superpowers:using-git-worktrees`).

**Depends on:** RC-0 Part 1 (relay) — DONE and verified live at `forge.covenant.uno`.

---

## Context the implementer needs

Verified hooks (file:line in `karlTerminal`):

- `AppState` (`crates/app/src/lib.rs:107`): `pub(crate) struct AppState { pub(crate) sessions: Mutex<HashMap<SessionId, ManagedSession>>, ... pub(crate) notch_hub: Arc<notch::NotchHub>, tab_manifest_path: PathBuf, ... }`. It is `app.manage(...)`-d, so a background task holding an `AppHandle` reads it via `app.try_state::<AppState>()`.
- `ManagedSession` (`lib.rs:100`): `{ session: Session, _zdotdir, world: Arc<Mutex<SessionWorldModel>>, op_state }`.
- `SessionWorldModel` (`crates/app/src/world.rs:28`): `pub struct SessionWorldModel { pub cwd: PathBuf, ..., pub title: Option<String>, ... }`.
- `NotchHub::phase_snapshot` (`crates/app/src/notch.rs:385`): `pub async fn phase_snapshot(&self, session: SessionId) -> Option<(ExecutorPhase, Option<String>)>` → (phase, agent name).
- `NotchHub::labels` (`crates/app/src/notch.rs:51`): `Mutex<HashMap<SessionId, String>>` — cached tab label per session.
- `ExecutorPhase` (`crates/blocks/src/executor_phase.rs:8`): `enum { Idle, Thinking, Running{cmd}, Writing{file}, Reading{file}, Waiting{reason}, Done{summary} }`.
- JWT: `karl_score::auth::load_jwt() -> Result<Option<String>, AuthError>` (`crates/score/src/auth.rs:45`); Keychain `covenant.uno`/`covenant-jwt`.
- Backend URL: `karl_score::auth::backend_url() -> String` (`auth.rs:12`) defaults to `https://covenant.uno`. **NOTE: this default is stale — the live backend is `forge.covenant.uno`.** This plan defaults the relay host to `forge.covenant.uno` independently (see Task 3); fixing `backend_url()` itself is out of scope here (separate concern affecting sync).
- Startup spawn pattern (`lib.rs:~3617`): `tauri::async_runtime::spawn(async move { loop { ... } })`. Add the rc-agent spawn alongside the periodic sync loop.
- No WS crate exists yet; workspace `reqwest` has no `ws` feature.
- No persistent device id exists; create one.

---

## File Structure

- **Create** `crates/app/src/rc_agent.rs` — the whole module: frame types, pure helpers (unit-tested), device-id persistence, tab enumeration, and the reconnecting connect loop + a `spawn(app: AppHandle)` entry point. One responsibility: the desktop end of the RC channel.
- **Modify** `crates/app/src/lib.rs` — `mod rc_agent;` and one `rc_agent::spawn(app.handle().clone());` call at startup.
- **Modify** `crates/app/Cargo.toml` — add `tokio-tungstenite` (rustls), `futures-util` if not present, `uuid` if not present.

---

## Task 1: Add the WebSocket client dependency

**Files:**
- Modify: `crates/app/Cargo.toml`

- [ ] **Step 1: Add deps**

In `crates/app/Cargo.toml` `[dependencies]`, add (check first — `uuid`/`futures-util` may already be present; if so, don't duplicate):

```toml
tokio-tungstenite = { version = "0.24", features = ["rustls-tls-webpki-roots", "connect"] }
futures-util = "0.3"
uuid = { version = "1", features = ["v4"] }
```

- [ ] **Step 2: Verify it resolves**

Run: `cargo build -p covenant-app` (or the app crate's actual package name — check `crates/app/Cargo.toml` `[package].name`).
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/Cargo.toml Cargo.lock
git commit -m "chore(rc-agent): add tokio-tungstenite ws client dep"
```

---

## Task 2: Frame types + pure helpers (unit-tested)

**Files:**
- Create: `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Write the failing tests**

Create `crates/app/src/rc_agent.rs` with ONLY this content first:

```rust
//! Desktop end of the Covenant remote-control channel (RC-0, read-only).
//! Connects outbound to the relay's /rc/desktop and answers list_tabs.

use serde::{Deserialize, Serialize};
use std::time::Duration;
use karl_blocks::executor_phase::ExecutorPhase;

/// Inbound control frames the desktop understands. Unknown frames are ignored.
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum InFrame {
    ListTabs,
    #[serde(other)]
    Unknown,
}

/// One tab's read-only snapshot.
#[derive(Debug, Clone, Serialize, PartialEq)]
struct TabInfo {
    session_id: String,
    title: String,
    cwd: String,
    executor: Option<String>,
    phase: String,
    armed: bool,
}

/// Outbound frames the desktop emits.
#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum OutFrame {
    Tabs { device_id: String, tabs: Vec<TabInfo> },
}

/// Map an executor phase to a stable short string for the wire.
fn phase_str(p: &ExecutorPhase) -> &'static str {
    match p {
        ExecutorPhase::Idle => "idle",
        ExecutorPhase::Thinking => "thinking",
        ExecutorPhase::Running { .. } => "running",
        ExecutorPhase::Writing { .. } => "writing",
        ExecutorPhase::Reading { .. } => "reading",
        ExecutorPhase::Waiting { .. } => "waiting",
        ExecutorPhase::Done { .. } => "done",
    }
}

/// Build the relay WS URL. Accepts an http(s) or ws(s) base; forces ws(s) scheme,
/// appends the desktop path and token. Falls back to the live forge host.
fn ws_url(base: &str, token: &str) -> String {
    let b = base.trim_end_matches('/');
    let b = b
        .strip_prefix("https://").map(|r| format!("wss://{r}"))
        .or_else(|| b.strip_prefix("http://").map(|r| format!("ws://{r}")))
        .unwrap_or_else(|| b.to_string()); // already ws(s):// or bare host
    format!("{b}/rc/desktop?token={token}")
}

/// Exponential backoff: double, capped at 30s.
fn backoff_next(current: Duration) -> Duration {
    let next = current.saturating_mul(2);
    next.min(Duration::from_secs(30))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_tabs_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"list_tabs"}"#).unwrap();
        assert!(matches!(f, InFrame::ListTabs));
    }

    #[test]
    fn unknown_frame_is_ignored_not_error() {
        let f: InFrame = serde_json::from_str(r#"{"t":"send_input","data":"x"}"#).unwrap();
        assert!(matches!(f, InFrame::Unknown));
    }

    #[test]
    fn tabs_frame_serializes_with_tag() {
        let out = OutFrame::Tabs {
            device_id: "dev1".into(),
            tabs: vec![TabInfo {
                session_id: "s1".into(),
                title: "build".into(),
                cwd: "/proj".into(),
                executor: Some("claude".into()),
                phase: "running".into(),
                armed: false,
            }],
        };
        let s = serde_json::to_string(&out).unwrap();
        assert!(s.contains(r#""t":"tabs""#));
        assert!(s.contains(r#""session_id":"s1""#));
        assert!(s.contains(r#""armed":false"#));
    }

    #[test]
    fn phase_strings_are_stable() {
        assert_eq!(phase_str(&ExecutorPhase::Idle), "idle");
        assert_eq!(phase_str(&ExecutorPhase::Running { cmd: "x".into() }), "running");
        assert_eq!(phase_str(&ExecutorPhase::Waiting { reason: "y".into() }), "waiting");
    }

    #[test]
    fn ws_url_swaps_scheme_and_appends_path() {
        assert_eq!(ws_url("https://forge.covenant.uno", "T"),
                   "wss://forge.covenant.uno/rc/desktop?token=T");
        assert_eq!(ws_url("http://localhost:8080/", "T"),
                   "ws://localhost:8080/rc/desktop?token=T");
        assert_eq!(ws_url("wss://forge.covenant.uno", "T"),
                   "wss://forge.covenant.uno/rc/desktop?token=T");
    }

    #[test]
    fn backoff_doubles_and_caps_at_30s() {
        assert_eq!(backoff_next(Duration::from_secs(1)), Duration::from_secs(2));
        assert_eq!(backoff_next(Duration::from_secs(16)), Duration::from_secs(30));
        assert_eq!(backoff_next(Duration::from_secs(30)), Duration::from_secs(30));
    }
}
```

> Confirm the crate names: `karl_blocks` and `karl_score` are the likely workspace crate names for `crates/blocks` and `crates/score`. Verify against `crates/app/Cargo.toml` dependency aliases and adjust the `use` paths if they differ (e.g. `crate::` re-exports).

- [ ] **Step 2: Run tests to verify they pass (helpers are self-contained)**

Run: `cargo test -p covenant-app rc_agent::tests`
Expected: PASS (6 tests). If `karl_blocks::executor_phase::ExecutorPhase` path is wrong, fix the import until it compiles, then PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-agent): frame types + pure helpers (phase/url/backoff), unit tested"
```

---

## Task 3: Device id persistence

**Files:**
- Modify: `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Add a stable device-id loader**

Add to `rc_agent.rs` (above the tests):

```rust
use std::path::PathBuf;

/// Load or create a stable per-device id, persisted at `<config_dir>/rc_device_id`.
/// Format: `<hostname>-<uuid8>`. Best-effort; on any IO error returns an ephemeral id.
fn load_or_create_device_id(config_dir: &PathBuf) -> String {
    let path = config_dir.join("rc_device_id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }
    let host = std::env::var("HOSTNAME")
        .ok()
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "mac".to_string());
    let id = format!("{host}-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let _ = std::fs::create_dir_all(config_dir);
    let _ = std::fs::write(&path, &id);
    id
}
```

- [ ] **Step 2: Add a test (round-trips in a temp dir)**

Add to the `tests` module:

```rust
    #[test]
    fn device_id_persists_across_calls() {
        let dir = std::env::temp_dir().join(format!("rc_test_{}", uuid::Uuid::new_v4()));
        let a = load_or_create_device_id(&dir);
        let b = load_or_create_device_id(&dir);
        assert_eq!(a, b, "device id must be stable once created");
        assert!(a.contains('-'));
        let _ = std::fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 3: Run tests**

Run: `cargo test -p covenant-app rc_agent::tests`
Expected: PASS (7 tests).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-agent): stable persisted device id"
```

---

## Task 4: Tab enumeration from AppState

**Files:**
- Modify: `crates/app/src/rc_agent.rs`

This is the glue that reads live sessions. It is async and uses the `AppHandle`. It is not unit-tested (needs a populated `AppState`); it is verified by the manual run in Task 7.

- [ ] **Step 1: Implement `collect_tabs`**

Add to `rc_agent.rs`:

```rust
use tauri::{AppHandle, Manager};
use crate::AppState;

/// Snapshot all live sessions into wire `TabInfo`s. Read-only.
async fn collect_tabs(app: &AppHandle) -> Vec<TabInfo> {
    let Some(state) = app.try_state::<AppState>() else { return Vec::new() };
    let sessions = state.sessions.lock().await;
    let notch = state.notch_hub.clone();

    let mut out = Vec::with_capacity(sessions.len());
    for (sid, managed) in sessions.iter() {
        let session_id = sid.to_string();

        // cwd + AI title from the world model
        let (cwd, world_title) = {
            let w = managed.world.lock().await;
            (w.cwd.display().to_string(), w.title.clone())
        };

        // phase + executor from the notch hub
        let (phase, executor) = match notch.phase_snapshot(*sid).await {
            Some((p, agent)) => (phase_str(&p).to_string(), agent),
            None => ("idle".to_string(), None),
        };

        // title: prefer the cached notch label, then the AI title, then cwd basename
        let label = {
            let labels = notch.labels.lock().await;
            labels.get(sid).cloned()
        };
        let title = label
            .or(world_title)
            .unwrap_or_else(|| {
                std::path::Path::new(&cwd)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or_else(|| "shell".to_string())
            });

        out.push(TabInfo {
            session_id,
            title,
            cwd,
            executor,
            phase,
            armed: false, // arming arrives in RC-1
        });
    }
    out
}
```

> Verify field/method names against the live code while implementing: `state.sessions` is `tokio::sync::Mutex` (use `.lock().await`); `managed.world` is `Arc<Mutex<SessionWorldModel>>`; `SessionWorldModel { cwd: PathBuf, title: Option<String> }`; `NotchHub { labels: Mutex<HashMap<SessionId, String>>, phase_snapshot(...) }`. If `sessions` is a `std::sync::Mutex`, drop the `.await` and scope the guard so it isn't held across the subsequent `.await`s (collect raw refs first, then await). Report as DONE_WITH_CONCERNS if the mutex kinds force a restructure.

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p covenant-app`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-agent): collect_tabs — snapshot live sessions to wire TabInfo"
```

---

## Task 5: The reconnecting connect loop

**Files:**
- Modify: `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Implement the connection handler + loop + `spawn`**

Add to `rc_agent.rs`:

```rust
use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;

/// One connection lifetime: connect, then serve frames until the socket dies.
/// Returns Ok(()) on clean close, Err on connect/transport failure.
async fn run_once(app: &AppHandle, url: &str, device_id: &str) -> anyhow::Result<()> {
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await?;
    let (mut sink, mut stream) = ws.split();
    tracing::info!(target: "rc_agent", "relay connected");

    while let Some(msg) = stream.next().await {
        match msg? {
            Message::Text(text) => {
                match serde_json::from_str::<InFrame>(&text) {
                    Ok(InFrame::ListTabs) => {
                        let tabs = collect_tabs(app).await;
                        let frame = OutFrame::Tabs { device_id: device_id.to_string(), tabs };
                        let json = serde_json::to_string(&frame)?;
                        sink.send(Message::Text(json)).await?;
                    }
                    Ok(InFrame::Unknown) => { /* ignore unknown control frames */ }
                    Err(e) => tracing::debug!(target: "rc_agent", error=%e, "bad frame"),
                }
            }
            Message::Close(_) => break,
            // tokio-tungstenite auto-responds to Ping; nothing to do here.
            _ => {}
        }
    }
    Ok(())
}

/// Long-lived loop: resolve token+url, connect, reconnect with backoff.
/// No-ops (retries slowly) while the user is signed out.
async fn agent_loop(app: AppHandle, device_id: String) {
    let mut backoff = Duration::from_secs(1);
    loop {
        // Resolve a fresh token each attempt (it may change after sign-in).
        let token = match karl_score::auth::load_jwt() {
            Ok(Some(t)) => t,
            Ok(None) => {
                // signed out: wait a while, don't hammer
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
            Err(e) => {
                tracing::debug!(target: "rc_agent", error=%e, "jwt load failed");
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
        };

        // Relay host: env override, else the live forge backend.
        let base = std::env::var("COVENANT_BACKEND_URL")
            .unwrap_or_else(|_| "https://forge.covenant.uno".to_string());
        let url = ws_url(&base, &token);

        match run_once(&app, &url, &device_id).await {
            Ok(()) => {
                tracing::info!(target: "rc_agent", "relay disconnected; reconnecting");
                backoff = Duration::from_secs(1); // clean close: reset backoff
            }
            Err(e) => {
                tracing::debug!(target: "rc_agent", error=%e, "relay connect failed");
                tokio::time::sleep(backoff).await;
                backoff = backoff_next(backoff);
            }
        }
    }
}

/// Spawn the rc-agent. Call once at startup.
pub fn spawn(app: AppHandle) {
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let device_id = load_or_create_device_id(&config_dir);
    tracing::info!(target: "rc_agent", %device_id, "starting rc-agent");
    tauri::async_runtime::spawn(agent_loop(app, device_id));
}
```

> Verify: `app.path().app_config_dir()` is the Tauri v2 API (`tauri::Manager` + `PathResolver`). If the app already resolves a config/data dir elsewhere (it does around `lib.rs:3094`), reuse that resolution for consistency and note it.

- [ ] **Step 2: Verify it compiles**

Run: `cargo build -p covenant-app`
Expected: PASS.

- [ ] **Step 3: Run the unit tests (still green)**

Run: `cargo test -p covenant-app rc_agent::tests`
Expected: PASS (7 tests).

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-agent): reconnecting connect loop + spawn entry point"
```

---

## Task 6: Wire `spawn` into startup

**Files:**
- Modify: `crates/app/src/lib.rs`

- [ ] **Step 1: Declare the module**

Near the other `mod` declarations in `crates/app/src/lib.rs`, add:

```rust
mod rc_agent;
```

- [ ] **Step 2: Spawn at startup**

In the Tauri `setup`/run path where the periodic sync loop is spawned (around `lib.rs:3617`), add ONE line after the app state is managed (so `try_state::<AppState>()` works):

```rust
rc_agent::spawn(app.handle().clone());
```

> Place this AFTER `app.manage(AppState { ... })`. If the spawn must happen where only `app: &App` / `app.handle()` is available, use `app.handle().clone()`.

- [ ] **Step 3: Verify it compiles**

Run: `cargo build -p covenant-app`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/lib.rs
git commit -m "feat(rc-agent): spawn at startup"
```

---

## Task 7: Manual end-to-end verification

**Files:** none (verification only)

The relay is live at `forge.covenant.uno` and verified. This step confirms a real desktop answers `list_tabs`.

- [ ] **Step 1: Build & run the app signed in**

Ensure the app is signed in (a valid JWT in Keychain `covenant.uno`/`covenant-jwt`, minted by the live forge backend). Run the app (`npm run tauri:dev` or the project's run skill). Open a couple of terminal tabs.

- [ ] **Step 2: Drive a web-side client with the same `github_id`**

Using the same JWT (the agent uses the Keychain one; mint a matching test token with the server `JWT_SECRET` and the SAME `sub`/github_id if you want a separate web client), connect a web socket and request tabs:

```bash
# minimal node web client (Node 18+ has global WebSocket)
JWT="<same-github_id jwt>" node -e '
const w=new WebSocket("wss://forge.covenant.uno/rc/web?token="+process.env.JWT);
w.onopen=()=>w.send(JSON.stringify({t:"list_tabs"}));
w.onmessage=e=>{ console.log("RECEIVED:", e.data); process.exit(0); };
setTimeout(()=>{console.log("timeout"); process.exit(1);}, 8000);
'
```

Expected: a `{"t":"tabs","device_id":"...","tabs":[{session_id,title,cwd,executor,phase,armed:false},...]}` frame listing the open tabs.

- [ ] **Step 3: Confirm presence**

With the app running, the web client should also receive `{"t":"presence","desktop_online":true}` on connect (relay-synthesized). Closing the app should yield `desktop_online:false`.

- [ ] **Step 4: Record result**

Note in the commit/PR whether tabs enumerated correctly (this is the read-only milestone). Mark UNVERIFIED items honestly if the app couldn't be run.

---

## Self-Review

**Spec coverage (design doc RC-0 Part 2 = desktop rc-agent, read-only):**
- ✅ Outbound WS to `/rc/desktop?token=<keychain jwt>` — Task 5.
- ✅ Reconnect/backoff (1s→30s) — Tasks 2 (helper) + 5 (loop).
- ✅ Answer `list_tabs` by enumerating sessions, push `tabs` — Tasks 4 + 5.
- ✅ Tab metadata: session_id, title, cwd, executor, phase, `armed:false` — Task 2/4.
- ✅ Device id — Task 3.
- ✅ Signed-out no-op (slow retry) — Task 5.
- ⏸ `target_device_id` routing — not needed (relay broadcasts to all same-gid desktops in RC-0); device_id is included in the payload for the future.

**Placeholder scan:** No TODOs. Every code step has complete code. Task 4/7 are intentionally glue/manual (need a live AppState / running app) — called out explicitly, not hidden.

**Type consistency:** `InFrame`, `OutFrame::Tabs{device_id,tabs}`, `TabInfo{session_id,title,cwd,executor,phase,armed}`, `phase_str`, `ws_url`, `backoff_next`, `load_or_create_device_id`, `collect_tabs`, `run_once`, `agent_loop`, `spawn` are consistent across tasks. Crate-name/mutex-kind verifications are flagged inline where the planner is one step removed from the live code.

**Known risk to verify during implementation:** whether `AppState.sessions` is a `tokio::sync::Mutex` (assumed) vs `std::sync::Mutex`; and the exact `karl_blocks`/`karl_score` crate import paths. Both are called out in Task 2/4 notes.

---

## Follow-on

- **RC-0 Part 3 — web dashboard** (`covenant.uno`): authed page, connect `/rc/web`, send `list_tabs`, render `tabs` + presence. After this, RC-0 is end-to-end usable read-only.
