//! Per-session ExecutorPhaseDetector wired to the SessionEvent bus.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
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
    /// True after we've emitted a Done for the current turn. Reset when
    /// the phase transitions back out of Done (i.e. a new turn begins).
    /// Prevents the Done chime from re-firing on subsequent OSC 133;D
    /// markers within the same agent response.
    done_emitted: bool,
    /// Phase last surfaced to the UI. May lag behind `detector.phase()`
    /// while the sticky window is holding an active-work phase against
    /// a rapid flap back to Thinking.
    display: karl_session::ExecutorPhase,
    /// Wall-clock of the most recent transition into an *active-work*
    /// display phase (Writing/Reading/Running). While this is within
    /// `STICKY_ACTIVE`, Thinking transitions from the detector are
    /// swallowed — Claude Code routinely flashes `⏺ Update(foo.rs)`
    /// for a single frame and the spinner is back ~50ms later.
    last_active_at: std::time::Instant,
}

/// How long to hold a Writing/Reading/Running display phase before letting
/// the detector flap us back to Thinking. The tool-call line is the
/// meaningful event; the spinner that follows is noise.
const STICKY_ACTIVE: std::time::Duration = std::time::Duration::from_millis(2000);

pub struct NotchHub {
    sessions: Mutex<HashMap<SessionId, Entry>>,
    labels: Mutex<HashMap<SessionId, String>>,
    /// Hub-owned fan-out for the notch bridge. Distinct from per-session
    /// buses (which serve familiars, world model, etc.) so the notch
    /// window can subscribe to one stream covering every session.
    notch_tx: broadcast::Sender<SessionEvent>,
    /// Settings toggle — when false, `ingest` returns immediately without
    /// touching the detector, and `set_enabled(false)` clears any pills
    /// already on screen. Mirrors `settings.notch_enabled`.
    enabled: AtomicBool,
}

impl NotchHub {
    pub fn new() -> Arc<Self> {
        let (notch_tx, _) = broadcast::channel(64);
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            labels: Mutex::new(HashMap::new()),
            notch_tx,
            enabled: AtomicBool::new(true),
        })
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Relaxed)
    }

    /// Toggle the feature at runtime. When transitioning from on→off,
    /// emits Idle for every registered session so existing pills clear
    /// without waiting for the PTY to produce more bytes.
    pub async fn set_enabled(&self, enabled: bool) {
        let prev = self.enabled.swap(enabled, Ordering::Relaxed);
        if prev && !enabled {
            // Clear screen: synthesize Idle for every session that
            // currently has an agent in foreground.
            let labels = self.labels.lock().await;
            let sessions = self.sessions.lock().await;
            for (sid, entry) in sessions.iter() {
                if entry.agent.is_none() {
                    continue;
                }
                let ev = SessionEvent::ExecutorStateChanged {
                    session: *sid,
                    phase: karl_session::ExecutorPhase::Idle,
                    tab_label: labels.get(sid).cloned(),
                };
                let _ = entry.bus.send(ev.clone());
                let _ = self.notch_tx.send(ev);
            }
        }
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
                done_emitted: false,
                display: karl_session::ExecutorPhase::Idle,
                last_active_at: stale,
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
            let stale = std::time::Instant::now()
                - std::time::Duration::from_secs(60);
            entry.last_emit = stale;
            entry.last_change = stale;
            entry.display = karl_session::ExecutorPhase::Idle;
            entry.last_active_at = stale;
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
        // Feature disabled in settings → bail before touching state.
        // Zero overhead beyond the atomic load.
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
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
        if changed {
            entry.last_change = std::time::Instant::now();
        }
        let detected = entry.detector.phase().clone();
        let now = std::time::Instant::now();
        let display_is_active = matches!(
            entry.display,
            karl_session::ExecutorPhase::Running { .. }
                | karl_session::ExecutorPhase::Reading { .. }
                | karl_session::ExecutorPhase::Writing { .. }
        );
        let detected_is_active = matches!(
            detected,
            karl_session::ExecutorPhase::Running { .. }
                | karl_session::ExecutorPhase::Reading { .. }
                | karl_session::ExecutorPhase::Writing { .. }
        );
        // Sticky window: if the UI is currently showing an active-work
        // phase and the detector just flapped to Thinking within the
        // sticky window, swallow it. The tool-call was the real signal;
        // the spinner that follows for 50ms is noise.
        let suppress_thinking_flap = matches!(detected, karl_session::ExecutorPhase::Thinking)
            && display_is_active
            && entry.last_active_at.elapsed() < STICKY_ACTIVE;
        let next_display = if suppress_thinking_flap {
            entry.display.clone()
        } else {
            detected.clone()
        };
        if detected_is_active {
            entry.last_active_at = now;
        }
        // Stale-phase clear: detector has been stuck in the same active
        // phase for >8s with no transitions → CC is just redrawing.
        let stale_active = !changed
            && entry.last_change.elapsed() > std::time::Duration::from_secs(8)
            && matches!(
                entry.detector.phase(),
                karl_session::ExecutorPhase::Running { .. }
                    | karl_session::ExecutorPhase::Reading { .. }
                    | karl_session::ExecutorPhase::Writing { .. }
                    | karl_session::ExecutorPhase::Thinking
            );
        if stale_active {
            entry.detector = ExecutorPhaseDetector::default();
            entry.last_change = now;
            entry.last_emit = now;
            entry.display = karl_session::ExecutorPhase::Idle;
            let tab_label = self.labels.lock().await.get(&session).cloned();
            let ev = SessionEvent::ExecutorStateChanged {
                session,
                phase: karl_session::ExecutorPhase::Idle,
                tab_label,
            };
            let _ = entry.bus.send(ev.clone());
            let _ = self.notch_tx.send(ev);
            return;
        }
        let display_changed = next_display != entry.display;
        // Heartbeat: re-emit current display every 3s while non-Idle so
        // the JS-side TTL doesn't clear pills on continuously-active
        // sessions that aren't transitioning.
        let heartbeat = !display_changed
            && entry.last_emit.elapsed() > std::time::Duration::from_secs(3)
            && !matches!(next_display, karl_session::ExecutorPhase::Idle);
        if display_changed || heartbeat {
            entry.display = next_display.clone();
            let phase = next_display;
            let is_done = matches!(phase, karl_session::ExecutorPhase::Done { .. });
            // Done dedupe: skip if we've already emitted Done for this turn.
            // Clear the flag when leaving Done (= a new turn started).
            if !is_done {
                entry.done_emitted = false;
            }
            if is_done && entry.done_emitted {
                return;
            }
            entry.last_emit = std::time::Instant::now();
            if is_done {
                entry.done_emitted = true;
            }
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
    settings: std::sync::Arc<tokio::sync::Mutex<crate::settings::Settings>>,
    mut rx: broadcast::Receiver<SessionEvent>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut buffer: Vec<SessionEvent> = Vec::with_capacity(16);
        loop {
            match rx.recv().await {
                Ok(ev @ SessionEvent::ExecutorStateChanged { .. }) => {
                    tracing::info!(target: "notch", "bridge: forwarding ExecutorStateChanged to webview");
                    // When Covenant is in fullscreen the main UI renders
                    // inline pills — keep the overlay hidden but still
                    // fan the event out so the inline rack updates.
                    let main_fullscreen = app
                        .get_webview_window("main")
                        .and_then(|w| w.is_fullscreen().ok())
                        .unwrap_or(false);
                    if let Some(win) = app.get_webview_window("notch") {
                        let visible = win.is_visible().unwrap_or(false);
                        if !visible && !main_fullscreen {
                            let corner = settings.lock().await.notch_corner;
                            show_notch(&win, corner);
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
pub fn show_notch(win: &tauri::WebviewWindow, corner: crate::settings::NotchCorner) {
    let w = win.clone();
    let _ = win.run_on_main_thread(move || {
        let _ = w.show();
        position_at_corner(&w, corner);
        apply_macos_collection_behavior(&w);
    });
}

/// Reposition the notch overlay without toggling visibility. Used when
/// the user changes the corner setting at runtime.
pub fn reposition_notch(win: &tauri::WebviewWindow, corner: crate::settings::NotchCorner) {
    let w = win.clone();
    let _ = win.run_on_main_thread(move || position_at_corner(&w, corner));
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

fn position_at_corner(win: &tauri::WebviewWindow, corner: crate::settings::NotchCorner) {
    use crate::settings::NotchCorner;
    let Ok(Some(monitor)) = win.current_monitor() else { return };
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let w = (360.0 * scale) as i32;
    let h = (440.0 * scale) as i32;
    let pad_x = (16.0 * scale) as i32;
    let pad_y_bottom = (40.0 * scale) as i32;
    // Top corners need extra clearance to sit well below the custom titlebar
    // (38px) and its window controls, so the pill doesn't crowd the icons.
    let pad_y_top = (72.0 * scale) as i32;
    let (x, y) = match corner {
        NotchCorner::BottomRight => (size.width as i32 - w - pad_x, size.height as i32 - h - pad_y_bottom),
        NotchCorner::BottomLeft => (pad_x, size.height as i32 - h - pad_y_bottom),
        NotchCorner::TopRight => (size.width as i32 - w - pad_x, pad_y_top),
        NotchCorner::TopLeft => (pad_x, pad_y_top),
    };
    let _ = win.set_position(tauri::PhysicalPosition { x, y });
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
) -> Result<serde_json::Value, String> {
    let snap = state.notch_hub.snapshot().await;
    let (corner, sound_on_done) = {
        let s = state.settings.lock().await;
        (s.notch_corner, s.notch_sound_on_done)
    };
    tracing::info!(target: "notch", n = snap.len(), "notch_ready: replaying snapshot");
    let app = window.app_handle();
    for ev in snap {
        let _ = app.emit("notch:state", &ev);
    }
    Ok(serde_json::json!({
        "corner": corner,
        "sound_on_done": sound_on_done,
    }))
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
    async fn sticky_active_swallows_thinking_flap() {
        // Writing → Thinking within the sticky window should NOT emit
        // a Thinking event: the tool-call line is the meaningful signal,
        // the spinner that follows is noise.
        let (tx, mut rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_foreground_agent(sid, Some("claude".into())).await;
        while rx.try_recv().is_ok() {}
        hub.ingest(sid, "⏺ Update(foo.rs)\n".as_bytes()).await;
        let ev = rx.recv().await.expect("writing");
        assert!(matches!(
            ev,
            SessionEvent::ExecutorStateChanged { phase: ExecutorPhase::Writing { .. }, .. }
        ));
        // Detector flaps to Thinking immediately — hub must swallow it.
        hub.ingest(sid, "✻ Flowing… (1s)\n".as_bytes()).await;
        assert!(rx.try_recv().is_err(), "thinking flap leaked through sticky window");
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
