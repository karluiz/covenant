//! Per-session ExecutorPhaseDetector wired to the SessionEvent bus.

use std::collections::HashMap;
use std::sync::Arc;

use karl_blocks::executor_phase::ExecutorPhaseDetector;
use karl_session::{SessionEvent, SessionId};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{broadcast, Mutex};

struct Entry {
    detector: ExecutorPhaseDetector,
    bus: broadcast::Sender<SessionEvent>,
    last_emit: std::time::Instant,
    /// Wall-clock of the most recent phase *transition* (changed = true).
    /// Used to time out stale Running/Reading/Writing phases that keep
    /// heartbeating but never get a new tool call — common when Claude
    /// Code redraws the same status line while idle.
    last_change: std::time::Instant,
    /// Name of the executor agent currently running in foreground, if any
    /// (`claude`, `codex`, `copilot`, etc.). `None` when the user is at
    /// a plain shell prompt — we don't surface notch pills for those.
    agent: Option<String>,
}

pub struct NotchHub {
    sessions: Mutex<HashMap<SessionId, Entry>>,
    labels: Mutex<HashMap<SessionId, String>>,
    /// Hub-owned fan-out for the notch bridge. Distinct from per-session
    /// buses (which serve familiars, world model, etc.) so the notch
    /// window can subscribe to one stream covering every session.
    notch_tx: broadcast::Sender<SessionEvent>,
}

impl NotchHub {
    pub fn new() -> Arc<Self> {
        let (notch_tx, _) = broadcast::channel(64);
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            labels: Mutex::new(HashMap::new()),
            notch_tx,
        })
    }

    pub async fn set_tab_label(&self, session: SessionId, label: String) {
        self.labels.lock().await.insert(session, label);
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.notch_tx.subscribe()
    }

    pub async fn register(&self, session: SessionId, bus: broadcast::Sender<SessionEvent>) {
        let stale = std::time::Instant::now() - std::time::Duration::from_secs(60);
        self.sessions.lock().await.insert(
            session,
            Entry {
                detector: ExecutorPhaseDetector::default(),
                bus,
                last_emit: stale,
                last_change: stale,
                agent: None,
            },
        );
    }

    /// Update the agent currently running in foreground for a session.
    /// Resets the detector when the agent transitions to/from None so
    /// stale phases don't leak across executor lifecycles.
    pub async fn set_foreground_agent(&self, session: SessionId, agent: Option<String>) {
        let mut map = self.sessions.lock().await;
        let Some(entry) = map.get_mut(&session) else { return };
        if entry.agent != agent {
            entry.agent = agent;
            entry.detector = ExecutorPhaseDetector::default();
            entry.last_emit = std::time::Instant::now()
                - std::time::Duration::from_secs(60);
            // Emit an Idle event so any existing pill clears when the
            // agent quits and the user returns to a plain shell.
            let tab_label = self.labels.lock().await.get(&session).cloned();
            let ev = SessionEvent::ExecutorStateChanged {
                session,
                phase: karl_session::ExecutorPhase::Idle,
                tab_label,
            };
            let _ = self.notch_tx.send(ev);
        }
    }

    pub async fn ingest(&self, session: SessionId, bytes: &[u8]) {
        let mut map = self.sessions.lock().await;
        let Some(entry) = map.get_mut(&session) else {
            tracing::debug!(target: "notch", session = %session, bytes = bytes.len(), "ingest: no detector entry (race?)");
            return;
        };
        // Skip sessions where no executor agent is currently in foreground.
        if entry.agent.is_none() {
            return;
        }
        let changed = entry.detector.feed(bytes);
        // Suppress bare Thinking: only surface phases where the agent is
        // actually doing something (Running/Reading/Writing/Waiting/Done).
        // Thinking before any tool call has the lowest signal and was
        // making the notch look stuck on "Thinking" forever.
        let is_thinking = matches!(
            entry.detector.phase(),
            karl_session::ExecutorPhase::Thinking
        );
        // Heartbeat: re-emit current phase every 3s while bytes are still
        // flowing, so the JS-side TTL doesn't clear pills for sessions
        // that are continuously active but not transitioning phases.
        let heartbeat = !changed
            && entry.last_emit.elapsed() > std::time::Duration::from_secs(3)
            && !matches!(entry.detector.phase(), karl_session::ExecutorPhase::Idle)
            && !is_thinking;
        if (changed && !is_thinking) || heartbeat {
            let phase = entry.detector.phase().clone();
            entry.last_emit = std::time::Instant::now();
            if changed {
                tracing::info!(target: "notch", session = %session, ?phase, "phase changed");
            }
            let tab_label = self.labels.lock().await.get(&session).cloned();
            let ev = SessionEvent::ExecutorStateChanged {
                session,
                phase,
                tab_label,
            };
            let _ = entry.bus.send(ev.clone());
            let _ = self.notch_tx.send(ev);
        }
    }

    pub async fn drop_session(&self, session: &SessionId) {
        self.sessions.lock().await.remove(session);
        self.labels.lock().await.remove(session);
    }

    /// Snapshot every session's current phase + tab label. Used to seed
    /// the notch webview on boot — `win.emit` fires into the void if
    /// the JS listener isn't attached yet, so events emitted during
    /// app startup are otherwise lost.
    pub async fn snapshot(&self) -> Vec<SessionEvent> {
        let sessions = self.sessions.lock().await;
        let labels = self.labels.lock().await;
        sessions
            .iter()
            .filter(|(_, e)| !matches!(e.detector.phase(), karl_session::ExecutorPhase::Idle))
            .map(|(sid, entry)| SessionEvent::ExecutorStateChanged {
                session: *sid,
                phase: entry.detector.phase().clone(),
                tab_label: labels.get(sid).cloned(),
            })
            .collect()
    }
}

/// Spawn the long-lived task that forwards `ExecutorStateChanged`
/// to the notch webview as `notch:state` events. Buffers up to 16
/// events while the window isn't yet visible (it boots lazily on first
/// real activity).
pub fn spawn_bridge(
    app: AppHandle,
    mut rx: broadcast::Receiver<SessionEvent>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut buffer: Vec<SessionEvent> = Vec::with_capacity(16);
        loop {
            match rx.recv().await {
                Ok(ev @ SessionEvent::ExecutorStateChanged { .. }) => {
                    tracing::info!(target: "notch", "bridge: forwarding ExecutorStateChanged to webview");
                    if let Some(win) = app.get_webview_window("notch") {
                        let visible = win.is_visible().unwrap_or(false);
                        if !visible {
                            show_notch(&win);
                        }
                        // Emit via the AppHandle (global) instead of the
                        // webview — Tauri v2's WebviewWindow::emit targets
                        // only listeners that registered through the same
                        // window handle, which the JS-side `listen()` from
                        // `@tauri-apps/api/event` does NOT do by default.
                        for b in buffer.drain(..) {
                            let _ = app.emit("notch:state", &b);
                        }
                        let _ = app.emit("notch:state", &ev);
                        let _ = win;
                    } else {
                        if buffer.len() == buffer.capacity() {
                            buffer.remove(0);
                        }
                        buffer.push(ev);
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

/// Show the notch window in the right place with the right macOS collection
/// behavior. Safe to call from any thread — hops to the main thread.
pub fn show_notch(win: &tauri::WebviewWindow) {
    let w = win.clone();
    let _ = win.run_on_main_thread(move || {
        let _ = w.show();
        position_bottom_right(&w);
        apply_macos_collection_behavior(&w);
    });
}

/// Set NSWindowCollectionBehavior so the notch window appears on all Spaces
/// and in fullscreen slide-over mode.
#[cfg(target_os = "macos")]
fn apply_macos_collection_behavior(win: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    // NSWindowCollectionBehaviorCanJoinAllSpaces   = 1 << 0
    // NSWindowCollectionBehaviorFullScreenAuxiliary = 1 << 8
    const BEHAVIOR: u64 = (1 << 0) | (1 << 8);
    if let Ok(ns_window) = win.ns_window() {
        unsafe {
            let obj = ns_window as *mut AnyObject;
            let _: () = msg_send![&*obj, setCollectionBehavior: BEHAVIOR];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_macos_collection_behavior(_win: &tauri::WebviewWindow) {}

fn position_bottom_right(win: &tauri::WebviewWindow) {
    if let Ok(Some(monitor)) = win.current_monitor() {
        let size = monitor.size();
        let scale = monitor.scale_factor();
        let w = (360.0 * scale) as i32;
        let h = (440.0 * scale) as i32;
        let x = size.width as i32 - w - (16.0 * scale) as i32;
        let y = size.height as i32 - h - (40.0 * scale) as i32;
        let _ = win.set_position(tauri::PhysicalPosition { x, y });
    }
}

#[tauri::command]
pub async fn notch_set_passthrough(
    window: tauri::Window,
    passthrough: bool,
) -> Result<(), String> {
    window
        .set_ignore_cursor_events(passthrough)
        .map_err(|e| e.to_string())
}

/// Called by the notch webview once its listener is mounted. Replays
/// the current phase of every active session so pills appear even for
/// sessions that started before the WebView was ready.
#[tauri::command]
pub async fn notch_ready(
    window: tauri::Window,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let snap = state.notch_hub.snapshot().await;
    tracing::info!(target: "notch", n = snap.len(), "notch_ready: replaying snapshot");
    let app = window.app_handle();
    for ev in snap {
        let _ = app.emit("notch:state", &ev);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::ExecutorPhase;

    #[tokio::test]
    async fn ingest_emits_event_on_phase_change() {
        let (tx, mut rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_foreground_agent(sid, Some("claude".into())).await;
        // drain the Idle event emitted by the agent transition
        while rx.try_recv().is_ok() {}
        hub.ingest(sid, b"$ cargo build\n").await;
        let ev = rx.recv().await.expect("event");
        match ev {
            SessionEvent::ExecutorStateChanged { phase, .. } => {
                assert!(matches!(phase, ExecutorPhase::Running { .. }));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn ingest_suppresses_thinking() {
        let (tx, mut rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_foreground_agent(sid, Some("claude".into())).await;
        while rx.try_recv().is_ok() {}
        // Bare banner → detector reports Thinking; hub must NOT emit.
        hub.ingest(sid, b"some banner output\n").await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn hub_subscribe_receives_events() {
        let (tx, _rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let mut nrx = hub.subscribe();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_foreground_agent(sid, Some("claude".into())).await;
        while nrx.try_recv().is_ok() {}
        hub.ingest(sid, b"$ ls\n").await;
        match nrx.recv().await.unwrap() {
            SessionEvent::ExecutorStateChanged { phase, .. } => {
                assert!(matches!(phase, ExecutorPhase::Running { .. }));
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn bridge_serializes_event_payload() {
        let ev = SessionEvent::ExecutorStateChanged {
            session: SessionId::new(),
            phase: ExecutorPhase::Done { summary: None },
            tab_label: None,
        };
        let json = serde_json::to_value(&ev).expect("json");
        assert_eq!(json["phase"]["kind"], "done");
    }

    #[tokio::test]
    async fn event_includes_tab_label() {
        let (tx, _rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let mut nrx = hub.subscribe();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_tab_label(sid, "claude · tab 1".into()).await;
        hub.set_foreground_agent(sid, Some("claude".into())).await;
        while nrx.try_recv().is_ok() {}
        hub.ingest(sid, b"$ git status\n").await;
        match nrx.recv().await.unwrap() {
            SessionEvent::ExecutorStateChanged { tab_label, .. } => {
                assert_eq!(tab_label.as_deref(), Some("claude · tab 1"));
            }
            other => panic!("{other:?}"),
        }
    }
}
