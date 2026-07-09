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
    /// Per-session event bus for PTY-backed sessions. `None` for sessions
    /// driven externally (e.g. pi RPC sessions that have no PTY).
    bus: Option<broadcast::Sender<SessionEvent>>,
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
    /// True while the main window is in macOS fullscreen. Authoritative
    /// source of truth set by the Resized hook in `lib.rs`, which re-polls
    /// `is_fullscreen()` with retries to defeat macOS's late flag flip.
    /// The bridge reads this instead of polling `is_fullscreen()` per event
    /// — otherwise a "Thinking" event arriving mid-transition (flag still
    /// reads false) re-shows the overlay on top of the fullscreen Space.
    inline_mode: AtomicBool,
    /// Feeds the `spec_keeper` achievement: every phase transition is
    /// observed here so completion can ask whether a spec was read/created
    /// before the first code edit. Owned by the hub; lib.rs `manage`s a
    /// clone of the same Arc so the completion command queries it.
    spec_edit_tracker: Arc<crate::teammate::spec_edit_tracker::SpecEditTracker>,
}

impl NotchHub {
    pub fn new() -> Arc<Self> {
        let (notch_tx, _) = broadcast::channel(64);
        Arc::new(Self {
            sessions: Mutex::new(HashMap::new()),
            labels: Mutex::new(HashMap::new()),
            notch_tx,
            enabled: AtomicBool::new(true),
            inline_mode: AtomicBool::new(false),
            spec_edit_tracker: Arc::new(crate::teammate::spec_edit_tracker::SpecEditTracker::new()),
        })
    }

    /// The per-session spec-before-edit tracker fed from [`set_phase`].
    /// lib.rs manages a clone of this Arc so the completion command can
    /// query the same instance the hub feeds.
    pub fn spec_edit_tracker(&self) -> Arc<crate::teammate::spec_edit_tracker::SpecEditTracker> {
        self.spec_edit_tracker.clone()
    }

    /// Set/clear the fullscreen flag. Called by the Resized hook once the
    /// macOS fullscreen state has settled. When entering fullscreen this
    /// guarantees the bridge keeps the overlay hidden regardless of how
    /// `is_fullscreen()` races on subsequent executor events.
    pub fn set_inline_mode(&self, on: bool) {
        self.inline_mode.store(on, Ordering::Relaxed);
    }

    pub fn inline_mode(&self) -> bool {
        self.inline_mode.load(Ordering::Relaxed)
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
                    agent: entry.agent.clone(),
                    tab_label: labels.get(sid).cloned(),
                };
                if let Some(bus) = &entry.bus {
                    let _ = bus.send(ev.clone());
                }
                let _ = self.notch_tx.send(ev);
            }
        }
    }

    pub async fn set_tab_label(&self, session: SessionId, label: String) {
        self.labels.lock().await.insert(session, label);
    }

    /// Current user-facing tab label for a session, if one was set.
    pub async fn tab_label(&self, session: SessionId) -> Option<String> {
        self.labels.lock().await.get(&session).cloned()
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
                bus: Some(bus),
                last_emit: stale,
                last_change: stale,
                agent: None,
                done_emitted: false,
                display: karl_session::ExecutorPhase::Idle,
                last_active_at: stale,
            },
        );
    }

    /// Register a session that is *not* backed by a PTY — e.g. a pi RPC
    /// session whose phase is driven entirely by [`set_phase`] from a
    /// structured event stream, not by [`ingest`]ing PTY bytes.
    pub async fn register_external(&self, session: SessionId, agent: String) {
        let stale = std::time::Instant::now() - std::time::Duration::from_secs(60);
        self.sessions.lock().await.insert(
            session,
            Entry {
                detector: ExecutorPhaseDetector::default(),
                bus: None,
                last_emit: stale,
                last_change: stale,
                agent: Some(agent),
                done_emitted: false,
                display: karl_session::ExecutorPhase::Idle,
                last_active_at: stale,
            },
        );
    }

    /// Inject a phase directly, bypassing the PTY-byte detector. Used by
    /// transports that already deliver structured phase information (pi
    /// RPC: `AgentStart`, `ToolExecutionStart`, `TurnEnd`, …). Applies the
    /// same Done-dedupe behavior as [`ingest`] so a chatty `TurnEnd` flood
    /// doesn't re-fire the chime.
    pub async fn set_phase(&self, session: SessionId, phase: karl_session::ExecutorPhase) {
        self.spec_edit_tracker.note_phase(session, &phase);
        if !self.enabled.load(Ordering::Relaxed) {
            return;
        }
        let mut map = self.sessions.lock().await;
        let Some(entry) = map.get_mut(&session) else {
            return;
        };
        if entry.agent.is_none() {
            return;
        }
        let is_done = matches!(phase, karl_session::ExecutorPhase::Done { .. });
        if !is_done {
            entry.done_emitted = false;
        } else if entry.done_emitted {
            return;
        }
        let now = std::time::Instant::now();
        let same_phase = phase == entry.display;
        let heartbeat = same_phase
            && entry.last_emit.elapsed() > std::time::Duration::from_secs(3)
            && !matches!(phase, karl_session::ExecutorPhase::Idle)
            && !is_done;
        if same_phase && !heartbeat {
            return;
        }
        if !same_phase {
            entry.display = phase.clone();
            entry.last_change = now;
        }
        entry.last_emit = now;
        if is_done {
            entry.done_emitted = true;
        }
        let tab_label = self.labels.lock().await.get(&session).cloned();
        let ev = SessionEvent::ExecutorStateChanged {
            session,
            phase,
            agent: entry.agent.clone(),
            tab_label,
        };
        if let Some(bus) = &entry.bus {
            let _ = bus.send(ev.clone());
        }
        let _ = self.notch_tx.send(ev);
    }

    /// Update the agent currently running in foreground for a session.
    /// Resets the detector when the agent transitions to/from None so
    /// stale phases don't leak across executor lifecycles.
    pub async fn set_foreground_agent(&self, session: SessionId, agent: Option<String>) {
        let mut map = self.sessions.lock().await;
        let Some(entry) = map.get_mut(&session) else {
            return;
        };
        if entry.agent != agent {
            entry.agent = agent;
            entry.detector = ExecutorPhaseDetector::default();
            let stale = std::time::Instant::now() - std::time::Duration::from_secs(60);
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
                agent: entry.agent.clone(),
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
        // Pi RPC sessions drive the notch via structured events
        // (`set_phase`). Pi can also be launched as a normal PTY CLI; those
        // entries have a per-session bus and should still use the byte
        // detector below for status-spinner notifications.
        if entry.agent.as_deref() == Some("pi") && entry.bus.is_none() {
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
        // Stale-phase clear: detector has been stuck in the same tool-work
        // phase for >8s with no transitions → CC is just redrawing an old
        // tool line. Do NOT stale-clear Thinking: long Claude turns can
        // legitimately hold a spinner for minutes, and the frontend TTL is
        // kept alive by heartbeat events below.
        let stale_active = !changed
            && entry.last_change.elapsed() > std::time::Duration::from_secs(8)
            && matches!(
                entry.detector.phase(),
                karl_session::ExecutorPhase::Running { .. }
                    | karl_session::ExecutorPhase::Reading { .. }
                    | karl_session::ExecutorPhase::Writing { .. }
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
                agent: entry.agent.clone(),
                tab_label,
            };
            if let Some(bus) = &entry.bus {
                let _ = bus.send(ev.clone());
            }
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
                agent: entry.agent.clone(),
                tab_label,
            };
            if let Some(bus) = &entry.bus {
                let _ = bus.send(ev.clone());
            }
            let _ = self.notch_tx.send(ev);
        }
    }

    pub async fn drop_session(&self, session: &SessionId) {
        self.sessions.lock().await.remove(session);
        self.labels.lock().await.remove(session);
    }

    /// Snapshot the current display phase + foreground agent for one session.
    /// The operator's decision loop reads this to gate on real executor state.
    /// `None` when the session isn't registered (no agent detected here).
    pub async fn phase_snapshot(
        &self,
        session: SessionId,
    ) -> Option<(karl_session::ExecutorPhase, Option<String>)> {
        let map = self.sessions.lock().await;
        map.get(&session)
            .map(|e| (e.display.clone(), e.agent.clone()))
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
            .filter(|(_, e)| !matches!(e.display, karl_session::ExecutorPhase::Idle))
            .map(|(sid, entry)| SessionEvent::ExecutorStateChanged {
                session: *sid,
                phase: entry.display.clone(),
                agent: entry.agent.clone(),
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
    hub: Arc<NotchHub>,
    mut rx: broadcast::Receiver<SessionEvent>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut buffer: Vec<SessionEvent> = Vec::with_capacity(16);
        // Per-session running token total at the time of the last emit.
        // Used to compute a delta on the next emit so the UI can show
        // "+N tok" alongside the row's phase + duration + count.
        let mut last_token_total: HashMap<SessionId, u64> = HashMap::new();
        loop {
            match rx.recv().await {
                Ok(ev @ SessionEvent::ExecutorStateChanged { .. }) => {
                    tracing::info!(target: "notch", "bridge: forwarding ExecutorStateChanged to webview");
                    // Suppress the floating overlay when the main UI can carry
                    // the status itself: in fullscreen the inline rack does,
                    // and when the main window is focused the user is already
                    // looking at Covenant — a corner pill hovering over the
                    // terminal is just noise. The overlay exists for peripheral
                    // awareness when Covenant is in the background, so only
                    // show it then. EXCEPTION: Dynamic-Island mode is meant to
                    // stay up like a menu-bar HUD, so focus does not suppress
                    // it (fullscreen still does — the menu bar is hidden there).
                    let corner = settings.lock().await.notch_corner;
                    let notch_mode = matches!(corner, crate::settings::NotchCorner::Notch);
                    let main_win = app.get_webview_window("main");
                    let suppress = hub.inline_mode()
                        || main_win
                            .as_ref()
                            .and_then(|w| w.is_fullscreen().ok())
                            .unwrap_or(false)
                        || (!notch_mode
                            && main_win
                                .as_ref()
                                .and_then(|w| w.is_focused().ok())
                                .unwrap_or(false));
                    if let Some(win) = app.get_webview_window("notch") {
                        let visible = win.is_visible().unwrap_or(false);
                        if !visible && !suppress {
                            show_notch(&win, corner);
                        } else if visible && suppress {
                            // Went fullscreen or regained focus while the
                            // overlay was up. The window-event hooks may have
                            // missed the transition (macOS flips is_fullscreen
                            // a beat late), so take it down here too.
                            let _ = win.hide();
                        }
                        // Emit via the AppHandle (global) instead of the
                        // webview — Tauri v2's WebviewWindow::emit targets
                        // only listeners that registered through the same
                        // window handle, which the JS-side `listen()` from
                        // `@tauri-apps/api/event` does NOT do by default.
                        for b in buffer.drain(..) {
                            emit_with_tokens(&app, &b, &mut last_token_total).await;
                        }
                        emit_with_tokens(&app, &ev, &mut last_token_total).await;
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

/// Emit an `ExecutorStateChanged` event to the notch webview with a
/// `tokens_delta` field attached, computed as `vitals.session_tokens()
/// - last_token_total[session]`. Skips the field when vitals isn't
/// managed (e.g. early-boot races) or the delta is zero.
async fn emit_with_tokens(
    app: &AppHandle,
    ev: &SessionEvent,
    last_token_total: &mut HashMap<SessionId, u64>,
) {
    let SessionEvent::ExecutorStateChanged { session, .. } = ev else {
        return;
    };
    let mut value = match serde_json::to_value(ev) {
        Ok(v) => v,
        Err(_) => {
            let _ = app.emit("notch:state", ev);
            return;
        }
    };
    if let Some(handle) = app.try_state::<crate::vitals::VitalsHandle>() {
        let current = handle.session_tokens(*session).await;
        let prev = last_token_total.insert(*session, current).unwrap_or(0);
        let delta = current.saturating_sub(prev);
        if delta > 0 {
            // SessionEvent is internally-tagged (`#[serde(tag = "kind")]`)
            // so the variant's fields live at the top level alongside
            // `kind`. Inject the new field on the same object.
            if let Some(obj) = value.as_object_mut() {
                obj.insert("tokens_delta".into(), serde_json::json!(delta));
            }
        }
    }
    let _ = app.emit("notch:state", &value);
}

/// Show the notch window in the right place with the right macOS collection
/// behavior. Safe to call from any thread — hops to the main thread.
pub fn show_notch(win: &tauri::WebviewWindow, corner: crate::settings::NotchCorner) {
    let w = win.clone();
    let _ = win.run_on_main_thread(move || {
        let _ = w.show();
        position_at_corner(&w, corner);
        apply_macos_collection_behavior(&w);
        apply_notch_window_level(&w, corner);
    });
}

/// Reposition the notch overlay without toggling visibility. Used when
/// the user changes the corner setting at runtime.
pub fn reposition_notch(win: &tauri::WebviewWindow, corner: crate::settings::NotchCorner) {
    let w = win.clone();
    let _ = win.run_on_main_thread(move || {
        position_at_corner(&w, corner);
        apply_notch_window_level(&w, corner);
    });
}

/// In Notch mode the HUD must draw over the menu bar, so raise the window
/// above `NSMainMenuWindowLevel`. Every other corner sits in normal window
/// space, so keep the default floating level (matches `alwaysOnTop`).
#[cfg(target_os = "macos")]
fn apply_notch_window_level(win: &tauri::WebviewWindow, corner: crate::settings::NotchCorner) {
    use crate::settings::NotchCorner;
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    // NSStatusWindowLevel = 25 (above the 24 menu bar), NSFloatingWindowLevel = 3.
    let level: i64 = if matches!(corner, NotchCorner::Notch) { 25 } else { 3 };
    if let Ok(ns_window) = win.ns_window() {
        unsafe {
            let obj = ns_window as *mut AnyObject;
            let _: () = msg_send![&*obj, setLevel: level];
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn apply_notch_window_level(_win: &tauri::WebviewWindow, _corner: crate::settings::NotchCorner) {}

/// Set NSWindowCollectionBehavior so the notch window appears on all Spaces
/// in windowed mode. We deliberately omit `FullScreenAuxiliary` so the
/// overlay does NOT follow the main window into a fullscreen Space —
/// fullscreen mode renders the equivalent UI inline in the sidebar instead.
#[cfg(target_os = "macos")]
fn apply_macos_collection_behavior(win: &tauri::WebviewWindow) {
    use objc2::msg_send;
    use objc2::runtime::AnyObject;
    // NSWindowCollectionBehaviorCanJoinAllSpaces = 1 << 0
    const BEHAVIOR: u64 = 1 << 0;
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
    let Ok(Some(monitor)) = win.current_monitor() else {
        return;
    };
    let size = monitor.size();
    let scale = monitor.scale_factor();
    let w = (360.0 * scale) as i32;
    let h = (440.0 * scale) as i32;
    let pad_x = (16.0 * scale) as i32;
    // Bottom corners sit just above the status bar (26px + 1px border)
    // with a small breathing gap. Too much padding leaves an awkward
    // empty band between the pill and the chrome.
    let pad_y_bottom = (32.0 * scale) as i32;
    // Top corners need extra clearance to sit well below the custom titlebar
    // (38px) and its window controls, so the pill doesn't crowd the icons.
    let pad_y_top = (72.0 * scale) as i32;
    let (x, y) = match corner {
        NotchCorner::BottomRight => (
            size.width as i32 - w - pad_x,
            size.height as i32 - h - pad_y_bottom,
        ),
        NotchCorner::BottomLeft => (pad_x, size.height as i32 - h - pad_y_bottom),
        NotchCorner::TopRight => (size.width as i32 - w - pad_x, pad_y_top),
        NotchCorner::TopLeft => (pad_x, pad_y_top),
        // Centered on the built-in display, flush with the top so the pill
        // hangs from the physical notch. The CSS centers the pill within the
        // window and pads its content below the notch height.
        NotchCorner::Notch => ((size.width as i32 - w) / 2, 0),
    };
    let _ = win.set_position(tauri::PhysicalPosition { x, y });
}

#[tauri::command]
pub async fn notch_set_passthrough(window: tauri::Window, passthrough: bool) -> Result<(), String> {
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
    let (corner, sound_on_done, theme) = {
        let s = state.settings.lock().await;
        (s.notch_corner, s.notch_sound_on_done, s.window.theme)
    };
    tracing::info!(target: "notch", n = snap.len(), "notch_ready: replaying snapshot");
    let app = window.app_handle();
    for ev in snap {
        let _ = app.emit("notch:state", &ev);
    }
    Ok(serde_json::json!({
        "corner": corner,
        "sound_on_done": sound_on_done,
        "theme": theme,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::ExecutorPhase;

    #[tokio::test]
    async fn phase_snapshot_reports_display_and_agent() {
        let (tx, _rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_foreground_agent(sid, Some("claude".into())).await;
        hub.ingest(sid, b"$ cargo test\n").await;
        let (phase, agent) = hub.phase_snapshot(sid).await.expect("snapshot");
        assert!(matches!(phase, ExecutorPhase::Running { .. }));
        assert_eq!(agent.as_deref(), Some("claude"));
    }

    #[tokio::test]
    async fn phase_snapshot_none_for_unregistered() {
        let hub = NotchHub::new();
        assert!(hub.phase_snapshot(SessionId::new()).await.is_none());
    }

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

    #[tokio::test]
    async fn pty_pi_cli_status_spinner_emits_thinking() {
        // Pi RPC tabs use structured `set_phase` events, but a user can also
        // launch `pi` inside a normal terminal tab. Those PTY-backed sessions
        // must not be skipped, otherwise the sidebar stays at "no agent".
        let (tx, mut rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_foreground_agent(sid, Some("pi".into())).await;
        while rx.try_recv().is_ok() {}

        hub.ingest(sid, "∴ Waiting for heat death of universe...\n".as_bytes())
            .await;
        match rx.recv().await.expect("thinking") {
            SessionEvent::ExecutorStateChanged { phase, .. } => {
                assert!(matches!(phase, ExecutorPhase::Thinking), "got {phase:?}");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn snapshot_uses_external_display_phase() {
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register_external(sid, "pi".into()).await;
        hub.set_phase(sid, ExecutorPhase::Thinking).await;

        let snap = hub.snapshot().await;
        assert_eq!(snap.len(), 1);
        match &snap[0] {
            SessionEvent::ExecutorStateChanged { session, phase, .. } => {
                assert_eq!(*session, sid);
                assert!(matches!(phase, ExecutorPhase::Thinking));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[tokio::test]
    async fn external_same_phase_heartbeats() {
        let hub = NotchHub::new();
        let mut rx = hub.subscribe();
        let sid = SessionId::new();
        hub.register_external(sid, "pi".into()).await;
        hub.set_phase(sid, ExecutorPhase::Thinking).await;
        let _ = rx.recv().await.expect("initial thinking");

        {
            let mut sessions = hub.sessions.lock().await;
            let entry = sessions.get_mut(&sid).expect("entry");
            entry.last_emit = std::time::Instant::now() - std::time::Duration::from_secs(4);
        }

        hub.set_phase(sid, ExecutorPhase::Thinking).await;
        match rx.recv().await.expect("heartbeat") {
            SessionEvent::ExecutorStateChanged {
                session,
                phase,
                agent,
                ..
            } => {
                assert_eq!(session, sid);
                assert_eq!(agent.as_deref(), Some("pi"));
                assert!(matches!(phase, ExecutorPhase::Thinking));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn bridge_serializes_event_payload() {
        let ev = SessionEvent::ExecutorStateChanged {
            session: SessionId::new(),
            phase: ExecutorPhase::Done { summary: None },
            agent: Some("pi".into()),
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
            SessionEvent::ExecutorStateChanged {
                phase: ExecutorPhase::Writing { .. },
                ..
            }
        ));
        // Detector flaps to Thinking immediately — hub must swallow it.
        hub.ingest(sid, "✻ Flowing… (1s)\n".as_bytes()).await;
        assert!(
            rx.try_recv().is_err(),
            "thinking flap leaked through sticky window"
        );
    }

    #[tokio::test]
    async fn long_thinking_spinner_heartbeats_instead_of_stale_clear() {
        // Claude Code can legitimately sit in the same Thinking phase for
        // minutes. Repeated spinner redraws must keep the UI alive instead
        // of tripping the stale-tool-line clear path.
        let (tx, mut rx) = broadcast::channel(16);
        let hub = NotchHub::new();
        let sid = SessionId::new();
        hub.register(sid, tx).await;
        hub.set_foreground_agent(sid, Some("claude".into())).await;
        while rx.try_recv().is_ok() {}

        hub.ingest(sid, "✻ Fiddle-faddling… (9s)\n".as_bytes())
            .await;
        match rx.recv().await.expect("thinking") {
            SessionEvent::ExecutorStateChanged { phase, .. } => {
                assert!(matches!(phase, ExecutorPhase::Thinking));
            }
            other => panic!("unexpected: {other:?}"),
        }

        {
            let mut sessions = hub.sessions.lock().await;
            let entry = sessions.get_mut(&sid).expect("entry");
            entry.last_change = std::time::Instant::now() - std::time::Duration::from_secs(9);
            entry.last_emit = std::time::Instant::now() - std::time::Duration::from_secs(4);
        }

        hub.ingest(sid, "✻ Fiddle-faddling… (10s)\n".as_bytes())
            .await;
        match rx.recv().await.expect("heartbeat") {
            SessionEvent::ExecutorStateChanged { phase, .. } => {
                assert!(matches!(phase, ExecutorPhase::Thinking), "got {phase:?}");
            }
            other => panic!("unexpected: {other:?}"),
        }
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
