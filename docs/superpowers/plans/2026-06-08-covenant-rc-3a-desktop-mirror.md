# Covenant RC-3a · Desktop: Live Mirror Streaming — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Stream a desktop tab's raw terminal output to a remote web client on demand, so the dashboard can render a live byte-for-byte mirror. Gated on the tab being **armed**. `mirror_start` → an initial screen snapshot + a live raw-byte stream (base64 text frames); `mirror_stop` → the stream ends.

**Architecture:** Add a `broadcast` tee of raw PTY bytes to `Session` (the existing raw path is single-consumer mpsc → UI). The rc-agent, on `mirror_start{session_id}`, gates on armed, sends an initial `mirror_screen` frame (from `Session::screen_snapshot()`), then spawns a per-mirror task that forwards raw bytes as base64 `mirror_data` frames. `run_once` is restructured to drain an outbound mpsc into the WS sink (so the read loop AND mirror tasks can both send). `mirror_stop` aborts the task.

**Tech Stack:** Rust (`crates/session` broadcast, `crates/app` rc-agent, `base64` already a dep, `tokio::sync::broadcast`).

**Repo:** `~/Sources/karlTerminal` (app crate `covenant`). One git worktree.

**Depends on:** RC-2a (`lifecycle_gate`, armed gating, `OutFrame::Rejected`). The relay routes only TEXT frames, so mirror bytes go base64-in-JSON. The web half (xterm in the dashboard) is RC-3b, a separate plan.

---

## Context (verified hooks, file:line)

- `crates/session/src/lib.rs`: `Session` struct (416); `Session::spawn(opts) -> Result<(Self, SessionStreams)>` (433) creates `let (raw_tx, raw_rx) = mpsc::unbounded_channel::<Bytes>();` (437) and returns `SessionStreams { raw_bytes: raw_rx }` (476). The pump sends each chunk via `let _ = raw_tx.send(chunk.clone());` (561) — this is where to tee. `Session::screen_snapshot() -> String` (508) returns the current rendered screen (tidied plain text). `subscribe()` (480) / `event_sender()` (487) show the broadcast pattern. There's an integration test (~732) that spawns a session, writes `echo ...`, and reads the bus.
- rc-agent `crates/app/src/rc_agent.rs`: `run_once(app: &AppHandle, url, device_id) -> anyhow::Result<()>` does `let (mut sink, mut stream) = ws.split();` then a read loop with `sink.send(...).await?` inside the handlers. `InFrame` (serde tag `t`), `OutFrame::Rejected`, `lifecycle_gate(app, session_id) -> Result<SessionId, OutFrame>` (RC-2a), `collect_tabs`, `handle_send_input`, `handle_open_tab`. `karl_session::SessionId(Ulid)`. `AppState.sessions: tokio::sync::Mutex<HashMap<SessionId, ManagedSession>>`, `ManagedSession.session: Session`.
- `base64 = "0.22"` in `crates/app/Cargo.toml`. Use `base64::engine::general_purpose::STANDARD.encode(bytes)`.

---

## File Structure

- **Modify** `crates/session/src/lib.rs` — `raw_bytes_tx: broadcast::Sender<Bytes>` on `Session`; create it in `spawn`; tee in the pump; `subscribe_raw_bytes()` method.
- **Modify** `crates/app/src/rc_agent.rs` — MirrorStart/Stop in `InFrame`; MirrorScreen/MirrorData in `OutFrame`; restructure `run_once` (outbound mpsc + write task); `start_mirror`/`stop_mirror`; mirror registry. (+ frame parse tests.)

---

## Task 1: Session raw-bytes broadcast

**Files:** Modify `crates/session/src/lib.rs`

- [ ] **Step 1: Add the broadcast sender field + constructor**

In the `Session` struct (416), add:
```rust
    raw_bytes_tx: tokio::sync::broadcast::Sender<bytes::Bytes>,
```
In `Session::spawn` (433), near the `raw_tx`/`raw_rx` creation (437), add:
```rust
        let (raw_bytes_tx, _) = tokio::sync::broadcast::channel::<bytes::Bytes>(1024);
```
Store it in the returned `Session { ... }` (find the struct construction in `spawn`). Clone it into the pump task (the same task that has `raw_tx`).

- [ ] **Step 2: Tee bytes in the pump**

Right after `let _ = raw_tx.send(chunk.clone());` (561), add:
```rust
                let _ = raw_bytes_tx.send(chunk.clone());
```
(The pump must `move` a clone of `raw_bytes_tx`; add `let raw_bytes_tx = raw_bytes_tx.clone();` before the pump `spawn`/loop if needed so the field on `Session` is retained.)

- [ ] **Step 3: Add the subscribe method**

Near `subscribe()` (480):
```rust
    /// Fresh subscription to the raw PTY byte stream (for mirroring). Lagging
    /// receivers drop oldest chunks (acceptable: the live stream resumes).
    pub fn subscribe_raw_bytes(&self) -> tokio::sync::broadcast::Receiver<bytes::Bytes> {
        self.raw_bytes_tx.subscribe()
    }
```
> Confirm `bytes::Bytes` is the chunk type used by `raw_tx` (it is — `mpsc::unbounded_channel::<Bytes>`); import path may be `crate::Bytes` or `bytes::Bytes` — match the existing `raw_tx` type.

- [ ] **Step 4: Add a test** (mirror the existing session integration test ~732)

```rust
    #[tokio::test]
    async fn subscribe_raw_bytes_receives_output() {
        let (session, _streams) = Session::spawn(test_spawn_opts()).expect("spawn"); // reuse the existing test's spawn helper/opts
        let mut raw = session.subscribe_raw_bytes();
        session.write(b"echo karl-mirror\n").expect("write");
        // read raw chunks until we see the echoed text or time out
        let mut got = String::new();
        for _ in 0..50 {
            match tokio::time::timeout(std::time::Duration::from_millis(200), raw.recv()).await {
                Ok(Ok(b)) => { got.push_str(&String::from_utf8_lossy(&b)); if got.contains("karl-mirror") { break; } }
                _ => break,
            }
        }
        assert!(got.contains("karl-mirror"), "raw mirror stream should carry PTY output; got {got:?}");
    }
```
> Match the EXACT way the existing test (~732) constructs `SpawnOptions` (shell, cwd, env). If that test uses a helper, reuse it.

- [ ] **Step 5: Build + test**

Run: `cargo test -p karl-session subscribe_raw_bytes && cargo build -p covenant`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/session/src/lib.rs
git commit -m "feat(rc-3a): broadcast tee of raw PTY bytes + Session::subscribe_raw_bytes"
```

---

## Task 2: rc-agent — mirror frames + run_once restructure + forwarding

**Files:** Modify `crates/app/src/rc_agent.rs`

- [ ] **Step 1: Add frame parse tests**

```rust
    #[test]
    fn mirror_frames_parse() {
        assert!(matches!(serde_json::from_str::<InFrame>(r#"{"t":"mirror_start","session_id":"s1"}"#).unwrap(), InFrame::MirrorStart { .. }));
        assert!(matches!(serde_json::from_str::<InFrame>(r#"{"t":"mirror_stop","session_id":"s1"}"#).unwrap(), InFrame::MirrorStop { .. }));
    }
```

- [ ] **Step 2: Add the frame variants**

`InFrame` (before `Unknown`):
```rust
    MirrorStart { session_id: String },
    MirrorStop { session_id: String },
```
`OutFrame`:
```rust
    MirrorScreen { session_id: String, screen: String },
    MirrorData { session_id: String, b64: String },
```

- [ ] **Step 3: Restructure `run_once` to use an outbound mpsc + write task**

Replace the body of `run_once` with this shape (keep ALL existing frame handlers, but route their replies through `out_tx` instead of `sink.send(...).await?`):
```rust
async fn run_once(app: &AppHandle, url: &str, device_id: &str) -> anyhow::Result<()> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await?;
    let (mut sink, mut stream) = ws.split();
    tracing::info!(target: "rc_agent", "relay connected");

    // Outbound funnel: read loop + per-mirror tasks all send here.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let write = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if sink.send(m).await.is_err() { break; }
        }
    });

    let mut mirrors: std::collections::HashMap<karl_session::SessionId, tokio::task::JoinHandle<()>> = std::collections::HashMap::new();

    while let Some(msg) = stream.next().await {
        match msg? {
            Message::Text(text) => match serde_json::from_str::<InFrame>(&text) {
                Ok(InFrame::ListTabs) => {
                    let tabs = collect_tabs(app).await;
                    let json = serde_json::to_string(&OutFrame::Tabs { device_id: device_id.to_string(), tabs })?;
                    let _ = out_tx.send(Message::Text(json));
                }
                Ok(InFrame::SendInput { session_id, data }) => {
                    if let Some(rej) = handle_send_input(app, &session_id, &data).await {
                        let _ = out_tx.send(Message::Text(serde_json::to_string(&rej)?));
                    }
                }
                Ok(InFrame::CloseTab { session_id }) => match lifecycle_gate(app, &session_id).await {
                    Ok(id) => { use tauri::Emitter; let _ = app.emit("rc://tab/close", id.to_string()); }
                    Err(rej) => { let _ = out_tx.send(Message::Text(serde_json::to_string(&rej)?)); }
                },
                Ok(InFrame::FocusTab { session_id }) => match lifecycle_gate(app, &session_id).await {
                    Ok(id) => { use tauri::Emitter; let _ = app.emit("rc://tab/focus", id.to_string()); }
                    Err(rej) => { let _ = out_tx.send(Message::Text(serde_json::to_string(&rej)?)); }
                },
                Ok(InFrame::OpenTab { cwd }) => {
                    if let Some(rej) = handle_open_tab(app, cwd).await {
                        let _ = out_tx.send(Message::Text(serde_json::to_string(&rej)?));
                    }
                }
                Ok(InFrame::MirrorStart { session_id }) => {
                    start_mirror(app, &session_id, &out_tx, &mut mirrors).await;
                }
                Ok(InFrame::MirrorStop { session_id }) => {
                    stop_mirror(&session_id, &mut mirrors);
                }
                Ok(InFrame::WebPresence { .. }) | Ok(InFrame::Unknown) => {}
                Err(e) => tracing::debug!(target: "rc_agent", error=%e, "bad frame"),
            },
            Message::Close(_) => break,
            _ => {}
        }
    }

    for (_, h) in mirrors.drain() { h.abort(); }
    write.abort();
    Ok(())
}
```
> This preserves every existing handler verbatim except the reply channel (`out_tx.send` instead of `sink.send(...).await?`). The `WebPresence`/`Unknown` arms stay no-ops. Adjust the exact handler bodies to match what's currently in the file (e.g. if `handle_send_input` etc. differ slightly).

- [ ] **Step 4: Implement `start_mirror` / `stop_mirror`**

```rust
fn mirror_frame_json(frame: &OutFrame) -> Option<String> { serde_json::to_string(frame).ok() }

async fn start_mirror(
    app: &AppHandle,
    session_id: &str,
    out_tx: &tokio::sync::mpsc::UnboundedSender<tokio_tungstenite::tungstenite::Message>,
    mirrors: &mut std::collections::HashMap<karl_session::SessionId, tokio::task::JoinHandle<()>>,
) {
    use tokio_tungstenite::tungstenite::Message;
    // Gate on armed (reuse lifecycle_gate — returns the id or a Rejected frame).
    let id = match lifecycle_gate(app, session_id).await {
        Ok(id) => id,
        Err(rej) => { if let Some(j) = mirror_frame_json(&rej) { let _ = out_tx.send(Message::Text(j)); } return; }
    };
    if mirrors.contains_key(&id) { return; } // already mirroring

    let Some(state) = app.try_state::<crate::AppState>() else { return };
    let (mut rx, snapshot) = {
        let sessions = state.sessions.lock().await;
        let Some(m) = sessions.get(&id) else { return };
        (m.session.subscribe_raw_bytes(), m.session.screen_snapshot())
    }; // guard dropped

    // Initial paint.
    if let Some(j) = mirror_frame_json(&OutFrame::MirrorScreen { session_id: session_id.to_string(), screen: snapshot }) {
        let _ = out_tx.send(Message::Text(j));
    }

    // Forwarding task: raw bytes → base64 mirror_data frames.
    let sid = session_id.to_string();
    let tx = out_tx.clone();
    let handle = tokio::spawn(async move {
        use base64::Engine;
        loop {
            match rx.recv().await {
                Ok(bytes) => {
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    let frame = OutFrame::MirrorData { session_id: sid.clone(), b64 };
                    if let Ok(j) = serde_json::to_string(&frame) {
                        if tx.send(Message::Text(j)).is_err() { break; }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue, // skip dropped chunks
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    });
    mirrors.insert(id, handle);
}

fn stop_mirror(
    session_id: &str,
    mirrors: &mut std::collections::HashMap<karl_session::SessionId, tokio::task::JoinHandle<()>>,
) {
    use std::str::FromStr;
    if let Ok(u) = ulid::Ulid::from_str(session_id) {
        if let Some(h) = mirrors.remove(&karl_session::SessionId(u)) { h.abort(); }
    }
}
```

- [ ] **Step 5: Test + build**

Run: `cargo test -p covenant --lib rc_agent::tests && cargo build -p covenant`
Expected: PASS (existing + mirror parse test).

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/rc_agent.rs
git commit -m "feat(rc-3a): mirror_start/stop → armed-gated raw-byte streaming (mirror_screen + mirror_data)"
```

---

## Task 3: Manual smoke (frames only; full mirror verified in RC-3b)

**Files:** none.

- [ ] After RC-3b (or with a raw node WS client), arm a tab, send `{"t":"mirror_start","session_id":"<armed id>"}`. Expect a `mirror_screen` frame (current screen text) then a stream of `mirror_data` frames (base64) as the tab produces output. `mirror_stop` ends the stream. Unarmed → `rejected{tab_not_armed}`.
- [ ] Record honestly.

---

## Self-Review

**Spec coverage (RC-3a desktop):**
- ✅ Raw-byte tee so a second consumer (rc-agent) can mirror without disturbing the UI path — Task 1.
- ✅ `mirror_start` gated on armed (reuses `lifecycle_gate`) — Task 2.
- ✅ Initial screen paint via `screen_snapshot()` — Task 2.
- ✅ Live raw bytes as base64 `mirror_data` text frames (relay routes text only) — Task 2.
- ✅ `mirror_stop` aborts the per-mirror task; all mirrors aborted on disconnect — Task 2.
- ✅ `run_once` restructured so read loop + mirror tasks share the sink via an outbound mpsc — Task 2.

**Risks called out:** broadcast lag drops chunks (garbles xterm briefly) — `Lagged` is skipped; a resync-on-lag (re-send snapshot) is a possible RC-3 follow-up. base64-over-JSON bandwidth is acceptable for v1 (spec notes binary frames as a later optimization, but the relay only routes text today).

**Placeholder scan:** Task 1 step 4 and Task 2 step 3 carry explicit "match the existing test's SpawnOptions / current handler bodies" notes (the planner is one step removed from exact local code) — not placeholders. Task 3 is manual.

**Type consistency:** `raw_bytes_tx: broadcast::Sender<Bytes>` / `subscribe_raw_bytes`; `InFrame::{MirrorStart,MirrorStop}{session_id}`; `OutFrame::{MirrorScreen{session_id,screen}, MirrorData{session_id,b64}}`; reuses `lifecycle_gate`; mirrors keyed by `SessionId`. Frame tags `mirror_start`/`mirror_stop`/`mirror_screen`/`mirror_data` match what RC-3b will send/parse.

---

## Follow-on

- **RC-3b web**: add `@xterm/xterm` + fit addon to `landing`; a Mirror button per armed tab that sends `mirror_start`, mounts an xterm, writes the `mirror_screen` text then decodes `mirror_data` base64 into `term.write`, and `mirror_stop` on close.
- Resync-on-lag (optional), binary WS frames (needs relay change), pairing-token affordance, `backend_url()` fix.
