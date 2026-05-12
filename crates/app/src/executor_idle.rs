//! Subscriber that turns `SessionEvent::AgentIdleWaiting` into a user-
//! facing notification via [`crate::notifications::dispatch`].

use std::sync::Arc;

use tokio::sync::{broadcast, Mutex as AsyncMutex};
use tracing::{debug, warn};

use karl_session::SessionEvent;

use crate::email::EmailNotifier;
use crate::notifications::{dispatch, DispatchCtx};
use crate::notify::{Notifier, Trigger};
use crate::settings::Settings;

/// Spawn the long-lived task that listens for `AgentIdleWaiting` on the
/// given session event bus and fans out via [`dispatch`]. Returns the
/// `JoinHandle` so the caller can keep it alive / abort on shutdown.
///
/// The task exits cleanly when the broadcast sender is dropped (i.e.
/// the underlying session goes away). `Lagged` is logged and ignored;
/// all non-`AgentIdleWaiting` variants are skipped.
pub fn spawn(
    mut rx: broadcast::Receiver<SessionEvent>,
    notifier: Notifier,
    email: Arc<EmailNotifier>,
    settings: Arc<AsyncMutex<Settings>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(SessionEvent::AgentIdleWaiting {
                    session,
                    agent,
                    prompt_text,
                    quiet_ms,
                }) => {
                    if !settings.lock().await.notifications.on_executor_idle {
                        debug!(target: "executor_idle", "skipped: toggle off");
                        continue;
                    }
                    let (title, body) = format_notification(
                        &agent,
                        prompt_text.as_deref(),
                        quiet_ms,
                    );
                    let _ = dispatch(
                        &notifier,
                        &email,
                        DispatchCtx {
                            trigger: Trigger::ExecutorIdle,
                            title,
                            body,
                            session_id: Some(session),
                        },
                    )
                    .await;
                }
                Ok(_) => continue,
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(target: "executor_idle", lagged = n, "bus lagged");
                    continue;
                }
                Err(broadcast::error::RecvError::Closed) => {
                    debug!(target: "executor_idle", "bus closed, exiting");
                    break;
                }
            }
        }
    })
}

/// Pure formatter: turn an `AgentIdleWaiting` payload into (title, body).
/// Title is short for the OS popup; body shows the matched prompt line
/// when available, otherwise a generic "waiting for input" string.
pub fn format_notification(
    agent: &str,
    prompt_text: Option<&str>,
    quiet_ms: u64,
) -> (String, String) {
    let secs = quiet_ms / 1000;
    let title = format!("{agent} is waiting");
    let body = match prompt_text {
        Some(p) if !p.is_empty() => p.to_string(),
        _ => format!("Idle for {secs}s — needs your input"),
    };
    (title, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_uses_prompt_text_when_present() {
        let (title, body) = format_notification("claude", Some("Do you want to proceed? (y/N)"), 5000);
        assert_eq!(title, "claude is waiting");
        assert_eq!(body, "Do you want to proceed? (y/N)");
    }

    #[test]
    fn format_falls_back_when_no_prompt_text() {
        let (title, body) = format_notification("copilot", None, 7000);
        assert_eq!(title, "copilot is waiting");
        assert!(body.contains("7s"));
    }

    #[test]
    fn format_handles_empty_prompt_text_as_missing() {
        let (_t, body) = format_notification("opencode", Some(""), 3000);
        assert!(body.contains("3s"));
    }
}
