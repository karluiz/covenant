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
        self.sessions.lock().await.insert(
            session,
            Entry { detector: ExecutorPhaseDetector::default(), bus },
        );
    }

    pub async fn ingest(&self, session: SessionId, bytes: &[u8]) {
        let mut map = self.sessions.lock().await;
        let Some(entry) = map.get_mut(&session) else { return };
        if entry.detector.feed(bytes) {
            let tab_label = self.labels.lock().await.get(&session).cloned();
            let ev = SessionEvent::ExecutorStateChanged {
                session,
                phase: entry.detector.phase().clone(),
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
}

/// Spawn the long-lived task that forwards `ExecutorStateChanged`
/// to the notch webview as `notch://state` events. Buffers up to 16
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
                    if let Some(win) = app.get_webview_window("notch") {
                        let visible = win.is_visible().unwrap_or(false);
                        if !visible {
                            let _ = win.show();
                            position_bottom_right(&win);
                            apply_macos_collection_behavior(&win);
                        }
                        for b in buffer.drain(..) {
                            let _ = win.emit("notch://state", &b);
                        }
                        let _ = win.emit("notch://state", &ev);
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
        hub.ingest(sid, b"thinking...\n").await;
        let ev = rx.recv().await.expect("event");
        match ev {
            SessionEvent::ExecutorStateChanged { phase, .. } => {
                assert_eq!(phase, ExecutorPhase::Thinking);
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn ingest_silent_when_phase_same() {
        let (tx, mut rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.ingest(sid, b"thinking...\n").await;
        let _ = rx.recv().await;
        hub.ingest(sid, b"more thinking\n").await;
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn hub_subscribe_receives_events() {
        let (tx, _rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let mut nrx = hub.subscribe();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.ingest(sid, b"thinking\n").await;
        match nrx.recv().await.unwrap() {
            SessionEvent::ExecutorStateChanged { phase, .. } => {
                assert_eq!(phase, ExecutorPhase::Thinking);
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
        hub.ingest(sid, b"thinking\n").await;
        match nrx.recv().await.unwrap() {
            SessionEvent::ExecutorStateChanged { tab_label, .. } => {
                assert_eq!(tab_label.as_deref(), Some("claude · tab 1"));
            }
            other => panic!("{other:?}"),
        }
    }
}
