//! 3.6 — OS notifications. Native macOS popups for Operator ESCALATE,
//! AOM errors, and AOM completion. All work goes through [`Notifier`]
//! so the throttle, settings gating, and focus-suppression live in one
//! place; call sites pass a [`Trigger`] + title + body and (optionally)
//! the originating session id for click routing.
//!
//! Click routing on macOS in `tauri-plugin-notification` v2 is limited:
//! the OS brings the app to foreground but the plugin does not surface
//! a body-click callback without custom Swift. We emit a frontend
//! `notification-clicked` event with the session id at fire time so
//! the UI can pre-select the originating tab the next time the window
//! gains focus — best effort, no Swift required.
//!
//! All paths log via `tracing` regardless of whether the popup actually
//! fired, so audit history stays complete even when the user has
//! toggled suppression on.
//!
//! Throttle: at most one popup per trigger every 30s, across all tabs.
//! Throttled events still log; only the popup is suppressed.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_session::SessionId;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::Mutex as AsyncMutex;

use crate::settings::Settings;

const THROTTLE_WINDOW: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Trigger {
    /// Operator emitted an `ESCALATE` action — blocked, awaiting user.
    OperatorEscalate,
    /// AOM session hit an unrecoverable error (today: budget blown).
    AomError,
    /// AOM session completed normally (user-stopped or mission done).
    AomComplete,
    /// An executor (Claude Code, aider, …) in a session has gone idle
    /// waiting for the user. Throttled per-session.
    ExecutorIdle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Escalation,
    Info,
}

impl Trigger {
    pub fn severity(self) -> Severity {
        match self {
            Trigger::OperatorEscalate | Trigger::AomError => Severity::Escalation,
            Trigger::AomComplete | Trigger::ExecutorIdle => Severity::Info,
        }
    }

    fn label(self) -> &'static str {
        match self {
            Trigger::OperatorEscalate => "operator_escalate",
            Trigger::AomError => "aom_error",
            Trigger::AomComplete => "aom_complete",
            Trigger::ExecutorIdle => "executor_idle",
        }
    }

    fn is_enabled(self, cfg: &crate::settings::NotificationConfig) -> bool {
        match self {
            Trigger::OperatorEscalate => cfg.on_operator_escalate,
            Trigger::AomError => cfg.on_aom_error,
            Trigger::AomComplete => cfg.on_aom_complete,
            Trigger::ExecutorIdle => cfg.on_executor_idle,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EmitOutcome {
    Sent,
    SuppressedByToggle,
    SuppressedByFocus,
    SuppressedByThrottle,
}

#[derive(Default)]
struct ThrottleState {
    last_fire: HashMap<Trigger, Instant>,
    last_fire_per_session: HashMap<(Trigger, SessionId), Instant>,
}

impl ThrottleState {
    fn allow(&mut self, trigger: Trigger, now: Instant) -> bool {
        match self.last_fire.get(&trigger).copied() {
            Some(prev) if now.duration_since(prev) < THROTTLE_WINDOW => false,
            _ => {
                self.last_fire.insert(trigger, now);
                true
            }
        }
    }

    fn allow_per_session(
        &mut self,
        trigger: Trigger,
        session: SessionId,
        now: Instant,
    ) -> bool {
        let key = (trigger, session);
        match self.last_fire_per_session.get(&key).copied() {
            Some(prev) if now.duration_since(prev) < THROTTLE_WINDOW => false,
            _ => {
                self.last_fire_per_session.insert(key, now);
                true
            }
        }
    }
}

#[derive(Clone)]
pub struct Notifier {
    app: AppHandle,
    settings: Arc<AsyncMutex<Settings>>,
    throttle: Arc<std::sync::Mutex<ThrottleState>>,
}

impl Notifier {
    pub fn new(app: AppHandle, settings: Arc<AsyncMutex<Settings>>) -> Self {
        Self {
            app,
            settings,
            throttle: Arc::new(std::sync::Mutex::new(ThrottleState::default())),
        }
    }

    /// Convenience for callers that need to talk to other Tauri APIs
    /// (e.g. `notification().request_permission()`) without keeping a
    /// separate AppHandle around.
    pub fn app_handle(&self) -> &AppHandle {
        &self.app
    }

    /// Fire an OS notification for `trigger`. Side-effects:
    ///   - `tracing::info!` always (so the audit trail is complete)
    ///   - `notification-clicked`-prep: if `session_id` is provided we
    ///     emit a `notification-fired` Tauri event before the popup so
    ///     the frontend can surface click-routing once the user
    ///     interacts (clicking activates the app on macOS for free).
    ///   - calls `app.notification().builder().show()` when all gates pass.
    pub async fn emit(
        &self,
        trigger: Trigger,
        title: impl Into<String>,
        body: impl Into<String>,
        session_id: Option<SessionId>,
    ) -> EmitOutcome {
        let title = title.into();
        let body = body.into();
        let cfg = self.settings.lock().await.notifications.clone();
        let outcome = self.decide(trigger, &cfg, session_id);

        tracing::info!(
            trigger = trigger.label(),
            outcome = ?outcome,
            session = ?session_id.map(|s| s.to_string()),
            title = %title,
            body = %truncate_for_log(&body),
            "notify"
        );

        if outcome != EmitOutcome::Sent {
            return outcome;
        }

        // Best-effort frontend hint so the UI can pre-load context for
        // when the user clicks the OS popup. The plugin doesn't deliver
        // a click callback on macOS, but this lets the active webview
        // know which tab to focus next.
        if let Some(id) = session_id {
            let _ = self.app.emit(
                "notification-fired",
                serde_json::json!({
                    "trigger": trigger.label(),
                    "session_id": id.to_string(),
                }),
            );
        }

        if let Err(e) = self
            .app
            .notification()
            .builder()
            .title(title)
            .body(body)
            .show()
        {
            tracing::warn!(error = %e, "notification show failed");
        }
        EmitOutcome::Sent
    }

    fn decide(
        &self,
        trigger: Trigger,
        cfg: &crate::settings::NotificationConfig,
        session_id: Option<SessionId>,
    ) -> EmitOutcome {
        if !trigger.is_enabled(cfg) {
            return EmitOutcome::SuppressedByToggle;
        }
        if cfg.suppress_when_focused && self.window_is_focused() {
            return EmitOutcome::SuppressedByFocus;
        }
        if !self.allow_now(trigger, session_id) {
            return EmitOutcome::SuppressedByThrottle;
        }
        EmitOutcome::Sent
    }

    fn allow_now(&self, trigger: Trigger, session_id: Option<SessionId>) -> bool {
        let mut t = match self.throttle.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        let now = Instant::now();
        match (trigger, session_id) {
            (Trigger::ExecutorIdle, Some(sid)) => t.allow_per_session(trigger, sid, now),
            _ => t.allow(trigger, now),
        }
    }

    fn window_is_focused(&self) -> bool {
        // Tauri 2: webview window keyed by label "main" (matches
        // capabilities/default.json's `windows: ["main"]`). If the call
        // fails (window gone during shutdown, etc.) treat as
        // not-focused so the notification still fires.
        match self.app.get_webview_window("main") {
            Some(w) => w.is_focused().unwrap_or(false),
            None => false,
        }
    }
}

fn truncate_for_log(s: &str) -> String {
    if s.len() <= 200 {
        s.to_string()
    } else {
        let mut out = s[..200].to_string();
        out.push_str("…");
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn throttle_blocks_second_fire_within_window() {
        let mut t = ThrottleState::default();
        let t0 = Instant::now();
        assert!(t.allow(Trigger::OperatorEscalate, t0));
        assert!(!t.allow(Trigger::OperatorEscalate, t0 + Duration::from_secs(5)));
        assert!(!t.allow(
            Trigger::OperatorEscalate,
            t0 + Duration::from_secs(29)
        ));
    }

    #[test]
    fn throttle_releases_after_window() {
        let mut t = ThrottleState::default();
        let t0 = Instant::now();
        assert!(t.allow(Trigger::AomError, t0));
        assert!(t.allow(Trigger::AomError, t0 + Duration::from_secs(31)));
    }

    #[test]
    fn throttle_is_per_trigger() {
        let mut t = ThrottleState::default();
        let t0 = Instant::now();
        assert!(t.allow(Trigger::OperatorEscalate, t0));
        // Different trigger — not throttled.
        assert!(t.allow(Trigger::AomError, t0));
        assert!(t.allow(Trigger::AomComplete, t0));
        // Same trigger again — throttled.
        assert!(!t.allow(Trigger::OperatorEscalate, t0 + Duration::from_secs(1)));
    }

    #[test]
    fn trigger_severity_routes_correctly() {
        assert_eq!(Trigger::OperatorEscalate.severity(), Severity::Escalation);
        assert_eq!(Trigger::AomError.severity(), Severity::Escalation);
        assert_eq!(Trigger::AomComplete.severity(), Severity::Info);
    }

    #[test]
    fn trigger_gating_respects_toggles() {
        let mut cfg = crate::settings::NotificationConfig::default();
        // All defaults true.
        assert!(Trigger::OperatorEscalate.is_enabled(&cfg));
        assert!(Trigger::AomError.is_enabled(&cfg));
        assert!(Trigger::AomComplete.is_enabled(&cfg));

        cfg.on_operator_escalate = false;
        assert!(!Trigger::OperatorEscalate.is_enabled(&cfg));
        // Other triggers stay on.
        assert!(Trigger::AomError.is_enabled(&cfg));
        assert!(Trigger::AomComplete.is_enabled(&cfg));
    }

    #[test]
    fn executor_idle_throttle_is_per_session() {
        use karl_session::SessionId;
        let mut state = ThrottleState::default();
        let s1 = SessionId::new();
        let s2 = SessionId::new();
        let t0 = Instant::now();
        assert!(state.allow_per_session(Trigger::ExecutorIdle, s1, t0));
        assert!(!state.allow_per_session(Trigger::ExecutorIdle, s1, t0 + Duration::from_secs(5)));
        assert!(state.allow_per_session(Trigger::ExecutorIdle, s2, t0 + Duration::from_secs(5)));
        assert!(state.allow_per_session(Trigger::ExecutorIdle, s1, t0 + Duration::from_secs(31)));
    }

    #[test]
    fn executor_idle_is_enabled_respects_toggle() {
        let mut cfg = crate::settings::NotificationConfig::default();
        cfg.on_executor_idle = true;
        assert!(Trigger::ExecutorIdle.is_enabled(&cfg));
        cfg.on_executor_idle = false;
        assert!(!Trigger::ExecutorIdle.is_enabled(&cfg));
    }
}
