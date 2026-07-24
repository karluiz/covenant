//! Desktop end of the Covenant remote-control channel (RC-0, read-only).
//! Connects outbound to the relay's /rc/desktop and answers list_tabs.

use futures_util::{SinkExt, StreamExt};
use karl_blocks::executor_phase::ExecutorPhase;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::str::FromStr;
use std::time::Duration;
use tauri::{AppHandle, Manager};
use tokio_tungstenite::tungstenite::Message;

use crate::AppState;

#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum InFrame {
    ListTabs,
    SendInput {
        session_id: String,
        data: String,
    },
    /// Literal keystrokes — Esc, ^C, an arrow, a bare `y`. What a stopped
    /// agent actually asks for is a key, not a command, and `SendInput`
    /// can't express one: it always normalizes to a submit.
    SendKeys {
        session_id: String,
        data: String,
    },
    WebPresence {
        web_count: u32,
    },
    CloseTab {
        session_id: String,
    },
    FocusTab {
        session_id: String,
    },
    OpenTab {
        #[serde(default)]
        cwd: Option<String>,
    },
    MirrorStart {
        session_id: String,
    },
    MirrorStop {
        session_id: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
struct TabInfo {
    session_id: String,
    title: String,
    cwd: String,
    executor: Option<String>,
    phase: String,
    armed: bool,
}

#[derive(Debug, Serialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum OutFrame {
    Tabs {
        device_id: String,
        tabs: Vec<TabInfo>,
    },
    Rejected {
        session_id: String,
        reason: &'static str,
        message: String,
    },
    MirrorScreen {
        session_id: String,
        screen: String,
        /// Source PTY grid. The web viewer resizes to match — without it
        /// the mirror re-wraps at the browser's width and every line the
        /// desktop already wrapped breaks again in the wrong place.
        cols: u16,
        rows: u16,
    },
    MirrorData {
        session_id: String,
        b64: String,
    },
}

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

fn ws_url(base: &str, token: &str) -> String {
    let b = base.trim_end_matches('/');
    let b = b
        .strip_prefix("https://")
        .map(|r| format!("wss://{r}"))
        .or_else(|| b.strip_prefix("http://").map(|r| format!("ws://{r}")))
        .unwrap_or_else(|| b.to_string());
    format!("{b}/rc/desktop?token={token}")
}

fn backoff_next(current: Duration) -> Duration {
    current.saturating_mul(2).min(Duration::from_secs(30))
}

/// Collapse a leading home-dir prefix to `~` for privacy on the wire.
fn tilde(path: &str) -> String {
    match std::env::var("HOME") {
        Ok(home) if !home.is_empty() && path.starts_with(&home) => {
            format!("~{}", &path[home.len()..])
        }
        _ => path.to_string(),
    }
}

fn load_or_create_device_id(config_dir: &Path) -> String {
    let path = config_dir.join("rc_device_id");
    if let Ok(existing) = std::fs::read_to_string(&path) {
        let t = existing.trim();
        if !t.is_empty() {
            return t.to_string();
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

async fn collect_tabs(app: &AppHandle) -> Vec<TabInfo> {
    let Some(state) = app.try_state::<AppState>() else {
        return Vec::new();
    };
    let notch = state.notch_hub.clone();

    // Snapshot (id, world-handle) pairs under the lock, then drop the guard.
    // The guard's iterator is not `Send`, so we must not hold it across the
    // per-session `.await`s below (this future runs on a spawned task).
    let snapshot: Vec<_> = {
        let sessions = state.sessions.lock().await;
        sessions
            .iter()
            .map(|(sid, managed)| {
                let armed = managed.armed.load(std::sync::atomic::Ordering::Relaxed);
                (*sid, managed.world.clone(), armed)
            })
            .collect()
    };

    let mut out = Vec::with_capacity(snapshot.len());
    for (sid, world, armed) in snapshot {
        let session_id = sid.to_string();
        let (cwd, world_title) = {
            let w = world.lock().await;
            (w.cwd.display().to_string(), w.title.clone())
        };
        let (phase, executor) = match notch.phase_snapshot(sid).await {
            Some((p, agent)) => (phase_str(&p).to_string(), agent),
            None => ("idle".to_string(), None),
        };
        let label = notch.tab_label(sid).await;
        let title = label.or(world_title).unwrap_or_else(|| {
            std::path::Path::new(&cwd)
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "shell".to_string())
        });
        out.push(TabInfo {
            session_id,
            title,
            cwd: tilde(&cwd),
            executor,
            phase,
            armed,
        });
    }
    out
}

async fn run_once(app: &AppHandle, url: &str, device_id: &str) -> anyhow::Result<()> {
    let (ws, _resp) = tokio_tungstenite::connect_async(url).await?;
    let (mut sink, mut stream) = ws.split();
    tracing::info!(target: "rc_agent", "relay connected");

    // Outbound fan-in: all handlers (and per-mirror tasks) push frames here;
    // a single write task owns the sink so concurrent senders don't race.
    let (out_tx, mut out_rx) = tokio::sync::mpsc::unbounded_channel::<Message>();
    let write = tokio::spawn(async move {
        while let Some(m) = out_rx.recv().await {
            if sink.send(m).await.is_err() {
                break;
            }
        }
    });
    let mut mirrors: std::collections::HashMap<
        karl_session::SessionId,
        tokio::task::JoinHandle<()>,
    > = std::collections::HashMap::new();

    while let Some(msg) = stream.next().await {
        match msg? {
            Message::Text(text) => match serde_json::from_str::<InFrame>(&text) {
                Ok(InFrame::ListTabs) => {
                    let tabs = collect_tabs(app).await;
                    let json = serde_json::to_string(&OutFrame::Tabs {
                        device_id: device_id.to_string(),
                        tabs,
                    })?;
                    let _ = out_tx.send(Message::Text(json));
                }
                Ok(InFrame::SendInput { session_id, data }) => {
                    if let Some(rej) = handle_send_input(app, &session_id, &data).await {
                        let _ = out_tx.send(Message::Text(serde_json::to_string(&rej)?));
                    }
                }
                Ok(InFrame::SendKeys { session_id, data }) => {
                    if let Some(rej) = handle_send_keys(app, &session_id, &data).await {
                        let _ = out_tx.send(Message::Text(serde_json::to_string(&rej)?));
                    }
                }
                Ok(InFrame::WebPresence { web_count }) => {
                    use tauri::Emitter;
                    if let Err(e) = app.emit("rc://web-presence", web_count) {
                        tracing::debug!(target: "rc_agent", error=%e, "emit web-presence failed");
                    }
                }
                Ok(InFrame::CloseTab { session_id }) => {
                    match lifecycle_gate(app, &session_id).await {
                        Ok(id) => {
                            use tauri::Emitter;
                            let _ = app.emit("rc://tab/close", id.to_string());
                        }
                        Err(rej) => {
                            let _ = out_tx.send(Message::Text(serde_json::to_string(&rej)?));
                        }
                    }
                }
                Ok(InFrame::FocusTab { session_id }) => {
                    match lifecycle_gate(app, &session_id).await {
                        Ok(id) => {
                            use tauri::Emitter;
                            let _ = app.emit("rc://tab/focus", id.to_string());
                        }
                        Err(rej) => {
                            let _ = out_tx.send(Message::Text(serde_json::to_string(&rej)?));
                        }
                    }
                }
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
                Ok(InFrame::Unknown) => {}
                Err(e) => tracing::debug!(target: "rc_agent", error=%e, "bad frame"),
            },
            Message::Close(_) => break,
            _ => {}
        }
    }
    for (_, h) in mirrors.drain() {
        h.abort();
    }
    write.abort();
    Ok(())
}

/// Mirror is read-only, so it only needs the session to exist — unlike
/// input injection, which stays behind the `armed` consent (`lifecycle_gate`).
/// Arming consents to remote CONTROL; visibility is consented at its own
/// surface (the owner shares a tab, or their own authed web dashboard asks).
async fn mirror_gate(
    app: &AppHandle,
    session_id: &str,
) -> Result<karl_session::SessionId, OutFrame> {
    use std::str::FromStr;
    let id = match ulid::Ulid::from_str(session_id) {
        Ok(u) => karl_session::SessionId(u),
        Err(_) => {
            return Err(OutFrame::Rejected {
                session_id: session_id.to_string(),
                reason: "no_such_tab",
                message: "invalid session id".into(),
            })
        }
    };
    let exists = match app.try_state::<crate::AppState>() {
        Some(state) => state.sessions.lock().await.contains_key(&id),
        None => false,
    };
    if exists {
        Ok(id)
    } else {
        Err(OutFrame::Rejected {
            session_id: session_id.to_string(),
            reason: "no_such_tab",
            message: "no such session".into(),
        })
    }
}

async fn start_mirror(
    app: &AppHandle,
    session_id: &str,
    out_tx: &tokio::sync::mpsc::UnboundedSender<Message>,
    mirrors: &mut std::collections::HashMap<karl_session::SessionId, tokio::task::JoinHandle<()>>,
) {
    let id = match mirror_gate(app, session_id).await {
        Ok(id) => id,
        Err(rej) => {
            if let Ok(j) = serde_json::to_string(&rej) {
                let _ = out_tx.send(Message::Text(j));
            }
            return;
        }
    };
    let already_mirroring = mirrors.contains_key(&id);
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };
    let (mut rx, screen, dims) = {
        let sessions = state.sessions.lock().await;
        let Some(m) = sessions.get(&id) else {
            return;
        };
        (
            m.session.subscribe_raw_bytes(),
            m.session.screen_handle(),
            m.session.dims_handle(),
        )
    };
    let sid = session_id.to_string();
    // The viewer's grid must match the source's or every wrapped line and
    // every absolute cursor move lands in the wrong column. Ship the
    // dimensions with the snapshot, and again whenever they change.
    let sid_frame = sid.clone();
    let screen_frame = move |cols: u16, rows: u16| {
        serde_json::to_string(&OutFrame::MirrorScreen {
            session_id: sid_frame.clone(),
            screen: screen.lock().map(|g| g.clone()).unwrap_or_default(),
            cols,
            rows,
        })
        .ok()
    };
    let (mut last_cols, mut last_rows) =
        karl_session::unpack_dims(dims.load(std::sync::atomic::Ordering::Relaxed));
    if let Some(j) = screen_frame(last_cols, last_rows) {
        let _ = out_tx.send(Message::Text(j));
    }
    // A viewer joining an already-mirrored session (a second guest on a
    // share link) still needs the snapshot above — the grid dimensions ride
    // on it, and without them the viewer wraps at its 80×24 default. Only
    // the streaming task must not be duplicated.
    if already_mirroring {
        return;
    }
    let tx = out_tx.clone();
    let handle = tokio::spawn(async move {
        use base64::Engine;
        loop {
            match rx.recv().await {
                Ok(bytes) => {
                    // A desktop-side resize emits no bytes of its own, so
                    // check before forwarding: a stale width garbles
                    // everything after it.
                    let (cols, rows) =
                        karl_session::unpack_dims(dims.load(std::sync::atomic::Ordering::Relaxed));
                    if (cols, rows) != (last_cols, last_rows) {
                        last_cols = cols;
                        last_rows = rows;
                        if let Some(j) = screen_frame(cols, rows) {
                            if tx.send(Message::Text(j)).is_err() {
                                break;
                            }
                        }
                    }
                    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
                    if let Ok(j) = serde_json::to_string(&OutFrame::MirrorData {
                        session_id: sid.clone(),
                        b64,
                    }) {
                        if tx.send(Message::Text(j)).is_err() {
                            break;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
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
        if let Some(h) = mirrors.remove(&karl_session::SessionId(u)) {
            h.abort();
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum RejectReason {
    NoSuchTab,
    NotArmed,
    Blocklisted,
}

impl RejectReason {
    fn code(self) -> &'static str {
        match self {
            RejectReason::NoSuchTab => "no_such_tab",
            RejectReason::NotArmed => "tab_not_armed",
            RejectReason::Blocklisted => "blocklisted",
        }
    }
}

#[derive(Debug, PartialEq)]
enum Gate {
    Inject,
    Reject(RejectReason),
}

fn gate(armed: Option<bool>, danger: bool) -> Gate {
    match armed {
        None => Gate::Reject(RejectReason::NoSuchTab),
        Some(false) => Gate::Reject(RejectReason::NotArmed),
        Some(true) => {
            if danger {
                Gate::Reject(RejectReason::Blocklisted)
            } else {
                Gate::Inject
            }
        }
    }
}

/// Arming-only gate for lifecycle ops (close/focus) — no blocklist (no command text).
fn lifecycle_decision(armed: Option<bool>) -> Gate {
    match armed {
        None => Gate::Reject(RejectReason::NoSuchTab),
        Some(false) => Gate::Reject(RejectReason::NotArmed),
        Some(true) => Gate::Inject,
    }
}

async fn lifecycle_gate(
    app: &AppHandle,
    session_id: &str,
) -> Result<karl_session::SessionId, OutFrame> {
    use std::str::FromStr;
    let make_reject = |reason: &'static str, message: String| OutFrame::Rejected {
        session_id: session_id.to_string(),
        reason,
        message,
    };
    let id = match ulid::Ulid::from_str(session_id) {
        Ok(u) => karl_session::SessionId(u),
        Err(_) => return Err(make_reject("no_such_tab", "invalid session id".into())),
    };
    let Some(state) = app.try_state::<crate::AppState>() else {
        return Err(make_reject("no_such_tab", "no app state".into()));
    };
    let armed: Option<bool> = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&id)
            .map(|m| m.armed.load(std::sync::atomic::Ordering::Relaxed))
    };
    match lifecycle_decision(armed) {
        Gate::Inject => Ok(id),
        Gate::Reject(reason) => {
            let (code, message) = reject_payload(reason, None);
            Err(make_reject(code, message))
        }
    }
}

/// Pure: build the (code, message) for a rejected send_input. The blocklist's
/// own message is used when present; otherwise a humanized code.
fn reject_payload(
    reason: RejectReason,
    blocklist_message: Option<String>,
) -> (&'static str, String) {
    match reason {
        RejectReason::Blocklisted => (
            "blocklisted",
            blocklist_message.unwrap_or_else(|| "blocked".into()),
        ),
        other => (other.code(), other.code().replace('_', " ")),
    }
}

async fn handle_open_tab(app: &AppHandle, cwd: Option<String>) -> Option<OutFrame> {
    let state = app.try_state::<crate::AppState>()?;
    if !state
        .allow_remote_open
        .load(std::sync::atomic::Ordering::Relaxed)
    {
        return Some(OutFrame::Rejected {
            session_id: String::new(),
            reason: "open_not_allowed",
            message: "remote tab creation is disabled on the desktop".into(),
        });
    }
    use tauri::Emitter;
    let _ = app.emit("rc://tab/open", cwd);
    tracing::info!(target: "rc_agent", "remote open_tab");
    None
}

/// Pure: replace the trailing CR/LF run with a single `\r`. The web
/// dashboard appends `\n`, but TUI executors (Claude Code's ink input)
/// treat `\n` (ctrl+J) as "insert newline" — only `\r` is Enter. The
/// actual submit-as-discrete-keystroke split happens downstream in
/// `inject_operator_reply`.
fn normalize_submit(data: &str) -> Vec<u8> {
    let body = data.trim_end_matches(['\r', '\n']);
    let mut out = Vec::with_capacity(body.len() + 1);
    out.extend_from_slice(body.as_bytes());
    out.push(b'\r');
    out
}

async fn handle_send_input(app: &AppHandle, session_id: &str, data: &str) -> Option<OutFrame> {
    let make_reject = |reason: &'static str, message: String| {
        Some(OutFrame::Rejected {
            session_id: session_id.to_string(),
            reason,
            message,
        })
    };

    let id = match ulid::Ulid::from_str(session_id) {
        Ok(u) => karl_session::SessionId(u),
        Err(_) => return make_reject("no_such_tab", "invalid session id".into()),
    };
    let state = app.try_state::<crate::AppState>()?;
    let armed: Option<bool> = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&id)
            .map(|m| m.armed.load(std::sync::atomic::Ordering::Relaxed))
    }; // guard dropped here
    let danger = crate::safety::is_dangerous(data, &[]);
    match gate(armed, danger.is_some()) {
        Gate::Reject(reason) => {
            if matches!(reason, RejectReason::Blocklisted) {
                karl_score::record_risky_action(karl_score::RiskyOutcome::Blocked);
            }
            let (code, message) = reject_payload(reason, danger.map(|d| d.message));
            make_reject(code, message)
        }
        Gate::Inject => {
            // NOTE: the gate is per-command, not transactional — a concurrent
            // rc_disarm_all between the armed-read and this inject can still let
            // one already-authorized, blocklist-passed command land. Acceptable.
            let payload = normalize_submit(data);
            if let Err(e) = crate::operator::inject_operator_reply(app, id, &payload).await {
                tracing::warn!(target: "rc_agent", error=%e, "inject failed");
                return make_reject("inject_failed", e);
            }
            tracing::info!(target: "rc_agent", session=%id, "remote input injected");
            None
        }
    }
}

/// The keys the quick-key row may send, mapped to the bytes a PTY expects.
/// A closed whitelist, not a passthrough: a remote client can press Esc or
/// ^C, never inject an arbitrary control sequence. Everything the desktop
/// terminal reads as one keystroke lives here.
fn key_bytes(token: &str) -> Option<&'static [u8]> {
    Some(match token {
        "enter" => b"\r",
        "esc" => b"\x1b",
        "ctrl-c" => b"\x03",
        "tab" => b"\t",
        "shift-tab" => b"\x1b[Z",
        "up" => b"\x1b[A",
        "down" => b"\x1b[B",
        "left" => b"\x1b[D",
        "right" => b"\x1b[C",
        "space" => b" ",
        "backspace" => b"\x7f",
        "y" => b"y",
        "n" => b"n",
        "1" => b"1",
        "2" => b"2",
        "3" => b"3",
        _ => return None,
    })
}

/// Send a single whitelisted keystroke. Same arming gate as `send_input`,
/// but the payload is a fixed byte string from [`key_bytes`] — never
/// caller-supplied bytes — and it is written raw, not normalized into a
/// submit. Blocklist doesn't apply: a lone key can't be a dangerous command.
async fn handle_send_keys(app: &AppHandle, session_id: &str, token: &str) -> Option<OutFrame> {
    let make_reject = |reason: &'static str, message: String| {
        Some(OutFrame::Rejected {
            session_id: session_id.to_string(),
            reason,
            message,
        })
    };
    let Some(bytes) = key_bytes(token) else {
        return make_reject("unknown_key", format!("unknown key '{token}'"));
    };
    let id = match ulid::Ulid::from_str(session_id) {
        Ok(u) => karl_session::SessionId(u),
        Err(_) => return make_reject("no_such_tab", "invalid session id".into()),
    };
    let state = app.try_state::<crate::AppState>()?;
    let armed: Option<bool> = {
        let sessions = state.sessions.lock().await;
        sessions
            .get(&id)
            .map(|m| m.armed.load(std::sync::atomic::Ordering::Relaxed))
    };
    // A key is never dangerous on its own, so gate on arming only (danger=false).
    match gate(armed, false) {
        Gate::Reject(reason) => {
            let (code, message) = reject_payload(reason, None);
            make_reject(code, message)
        }
        Gate::Inject => {
            if let Err(e) = crate::operator::inject_to_session(app, id, bytes).await {
                tracing::warn!(target: "rc_agent", error=%e, "key inject failed");
                return make_reject("inject_failed", e);
            }
            tracing::info!(target: "rc_agent", session=%id, key=%token, "remote key injected");
            None
        }
    }
}

async fn agent_loop(app: AppHandle, device_id: String) {
    let mut backoff = Duration::from_secs(1);
    loop {
        let token = match karl_score::auth::load_jwt() {
            Ok(Some(t)) => t,
            Ok(None) => {
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
            Err(e) => {
                tracing::debug!(target: "rc_agent", error=%e, "jwt load failed");
                tokio::time::sleep(Duration::from_secs(30)).await;
                continue;
            }
        };
        let base = std::env::var("COVENANT_BACKEND_URL")
            .unwrap_or_else(|_| "https://forge.covenant.uno".to_string());
        let url = ws_url(&base, &token);
        match run_once(&app, &url, &device_id).await {
            Ok(()) => {
                tracing::info!(target: "rc_agent", "relay disconnected; reconnecting");
                backoff = Duration::from_secs(1);
            }
            Err(e) => {
                tracing::debug!(target: "rc_agent", error=%e, "relay connect failed");
                tokio::time::sleep(backoff).await;
                backoff = backoff_next(backoff);
            }
        }
    }
}

pub fn spawn(app: AppHandle) {
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    let device_id = load_or_create_device_id(&config_dir);
    tracing::info!(target: "rc_agent", %device_id, "starting rc-agent");
    tauri::async_runtime::spawn(agent_loop(app, device_id));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gate_rejects_unknown_tab() {
        assert_eq!(gate(None, false), Gate::Reject(RejectReason::NoSuchTab));
    }
    #[test]
    fn gate_rejects_unarmed_tab() {
        assert_eq!(
            gate(Some(false), false),
            Gate::Reject(RejectReason::NotArmed)
        );
    }
    #[test]
    fn gate_rejects_blocklisted_even_when_armed() {
        assert_eq!(
            gate(Some(true), true),
            Gate::Reject(RejectReason::Blocklisted)
        );
    }
    #[test]
    fn gate_injects_when_armed_and_clean() {
        assert_eq!(gate(Some(true), false), Gate::Inject);
    }
    #[test]
    fn key_bytes_maps_control_keys() {
        assert_eq!(key_bytes("esc"), Some(&b"\x1b"[..]));
        assert_eq!(key_bytes("ctrl-c"), Some(&b"\x03"[..]));
        assert_eq!(key_bytes("shift-tab"), Some(&b"\x1b[Z"[..]));
        assert_eq!(key_bytes("enter"), Some(&b"\r"[..]));
        assert_eq!(key_bytes("y"), Some(&b"y"[..]));
    }
    #[test]
    fn key_bytes_rejects_anything_not_whitelisted() {
        // The whole point: a remote client can't smuggle arbitrary bytes
        // through the key path.
        assert_eq!(key_bytes("rm -rf /"), None);
        assert_eq!(key_bytes("\x1b]0;title\x07"), None);
        assert_eq!(key_bytes("Y"), None);
        assert_eq!(key_bytes(""), None);
    }
    #[test]
    fn send_keys_frame_parses() {
        let f: InFrame =
            serde_json::from_str(r#"{"t":"send_keys","session_id":"s1","data":"esc"}"#).unwrap();
        assert!(matches!(f, InFrame::SendKeys { .. }));
    }
    #[test]
    fn normalize_submit_turns_trailing_lf_into_cr() {
        assert_eq!(normalize_submit("ls\n"), b"ls\r");
    }
    #[test]
    fn normalize_submit_collapses_crlf_run() {
        assert_eq!(normalize_submit("ls\r\n\n"), b"ls\r");
    }
    #[test]
    fn normalize_submit_appends_cr_when_missing() {
        assert_eq!(normalize_submit("ls"), b"ls\r");
    }
    #[test]
    fn normalize_submit_keeps_interior_newlines() {
        assert_eq!(normalize_submit("a\nb\n"), b"a\nb\r");
    }
    #[test]
    fn reject_payload_blocklist_uses_real_message() {
        assert_eq!(
            reject_payload(RejectReason::Blocklisted, Some("rm -rf blocked".into())),
            ("blocklisted", "rm -rf blocked".to_string())
        );
    }
    #[test]
    fn reject_payload_blocklist_without_message_falls_back() {
        assert_eq!(
            reject_payload(RejectReason::Blocklisted, None),
            ("blocklisted", "blocked".to_string())
        );
    }
    #[test]
    fn reject_payload_humanizes_other_reasons() {
        assert_eq!(
            reject_payload(RejectReason::NotArmed, None),
            ("tab_not_armed", "tab not armed".to_string())
        );
    }
    #[test]
    fn tilde_collapses_home() {
        // Uses real $HOME; construct a path under it.
        if let Ok(home) = std::env::var("HOME") {
            let p = format!("{home}/proj/x");
            assert_eq!(tilde(&p), "~/proj/x");
        }
        assert_eq!(tilde("/etc/hosts"), "/etc/hosts");
    }
    #[test]
    fn list_tabs_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"list_tabs"}"#).unwrap();
        assert!(matches!(f, InFrame::ListTabs));
    }
    #[test]
    fn web_presence_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"web_presence","web_count":2}"#).unwrap();
        assert!(matches!(f, InFrame::WebPresence { web_count: 2 }));
    }
    #[test]
    fn close_tab_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"close_tab","session_id":"s1"}"#).unwrap();
        assert!(matches!(f, InFrame::CloseTab { .. }));
    }
    #[test]
    fn focus_tab_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"focus_tab","session_id":"s1"}"#).unwrap();
        assert!(matches!(f, InFrame::FocusTab { .. }));
    }
    #[test]
    fn open_tab_frame_parses() {
        let f: InFrame = serde_json::from_str(r#"{"t":"open_tab","cwd":"~/p"}"#).unwrap();
        assert!(matches!(f, InFrame::OpenTab { .. }));
        let f2: InFrame = serde_json::from_str(r#"{"t":"open_tab"}"#).unwrap();
        assert!(matches!(f2, InFrame::OpenTab { cwd: None }));
    }
    #[test]
    fn mirror_frames_parse() {
        assert!(matches!(
            serde_json::from_str::<InFrame>(r#"{"t":"mirror_start","session_id":"s1"}"#).unwrap(),
            InFrame::MirrorStart { .. }
        ));
        assert!(matches!(
            serde_json::from_str::<InFrame>(r#"{"t":"mirror_stop","session_id":"s1"}"#).unwrap(),
            InFrame::MirrorStop { .. }
        ));
    }
    #[test]
    fn lifecycle_decision_matches_armed() {
        assert_eq!(
            lifecycle_decision(None),
            Gate::Reject(RejectReason::NoSuchTab)
        );
        assert_eq!(
            lifecycle_decision(Some(false)),
            Gate::Reject(RejectReason::NotArmed)
        );
        assert_eq!(lifecycle_decision(Some(true)), Gate::Inject);
    }
    #[test]
    fn unknown_frame_is_ignored_not_error() {
        let f: InFrame = serde_json::from_str(r#"{"t":"totally_bogus","data":"x"}"#).unwrap();
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
        assert_eq!(
            phase_str(&ExecutorPhase::Running { cmd: "x".into() }),
            "running"
        );
        assert_eq!(
            phase_str(&ExecutorPhase::Waiting { reason: "y".into() }),
            "waiting"
        );
    }
    #[test]
    fn ws_url_swaps_scheme_and_appends_path() {
        assert_eq!(
            ws_url("https://forge.covenant.uno", "T"),
            "wss://forge.covenant.uno/rc/desktop?token=T"
        );
        assert_eq!(
            ws_url("http://localhost:8080/", "T"),
            "ws://localhost:8080/rc/desktop?token=T"
        );
        assert_eq!(
            ws_url("wss://forge.covenant.uno", "T"),
            "wss://forge.covenant.uno/rc/desktop?token=T"
        );
    }
    #[test]
    fn backoff_doubles_and_caps_at_30s() {
        assert_eq!(backoff_next(Duration::from_secs(1)), Duration::from_secs(2));
        assert_eq!(
            backoff_next(Duration::from_secs(16)),
            Duration::from_secs(30)
        );
        assert_eq!(
            backoff_next(Duration::from_secs(30)),
            Duration::from_secs(30)
        );
    }
    #[test]
    fn device_id_persists_across_calls() {
        let dir = std::env::temp_dir().join(format!("rc_test_{}", uuid::Uuid::new_v4()));
        let a = load_or_create_device_id(&dir);
        let b = load_or_create_device_id(&dir);
        assert_eq!(a, b);
        assert!(a.contains('-'));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
