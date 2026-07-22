//! PTY Perception: auto-answer trivial, safe Claude Code permission
//! prompts inside a plain terminal tab — the PTY sibling of the ACP
//! Perception path in `acp_commands`.
//!
//! Trigger is `SessionEvent::AgentIdleWaiting` (the pump's vt100 +
//! quiescence detector). On each firing for `claude`, the tidied screen
//! snapshot is parsed by `karl_agent::pty_prompt` into the SAME
//! `PermissionRequest` shape ACP delivers, then flows through the SAME
//! pipeline: `perception_judge` → `perception_decide_async` (judge +
//! code-level safety floor + persistent-option block + streak cap). An
//! auto-answer is one digit written to the PTY — Claude Code's numbered
//! prompts select on the bare number key.
//!
//! Scraped-text caveat: unlike ACP there is no protocol handle to the
//! prompt, so before writing we re-snapshot and re-parse; any drift
//! (prompt answered by the human, repainted, replaced) aborts the write.

use std::sync::{Arc, Mutex as StdMutex};

use tauri::{Emitter, Manager};
use tokio::sync::{broadcast, Mutex as AsyncMutex};

use karl_session::{SessionEvent, SessionId};

use crate::acp_commands::{
    perception_decide_async, perception_judge, PerceptionOutcome, PERCEPTION_CAP,
};
use crate::operator_registry::OperatorRegistry;
use crate::settings::Settings;

/// Spawn the per-session PTY Perception task. Exits when the session's
/// event bus closes.
pub fn spawn(
    session_id: SessionId,
    mut rx: broadcast::Receiver<SessionEvent>,
    screen: Arc<StdMutex<String>>,
    registry: Arc<OperatorRegistry>,
    settings: Arc<AsyncMutex<Settings>>,
    app: tauri::AppHandle,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        // Auto-answer streak. ACP resets it on a human click; the PTY has
        // no such edge, so reset on foreground change (claude exited or
        // restarted) instead.
        // ponytail: no reset on human keystrokes — the bus doesn't carry
        // them. Upgrade path: reset from write_to_session if the cap ever
        // bites a legitimately long supervised run.
        let mut consecutive: u32 = 0;
        loop {
            match rx.recv().await {
                Ok(SessionEvent::ForegroundChanged { .. }) => consecutive = 0,
                Ok(SessionEvent::AgentIdleWaiting { agent, .. }) if agent == "claude" => {
                    // Live gate, re-read per prompt like the ACP path.
                    if !registry.perception_enabled_for(session_id) {
                        continue;
                    }
                    let snap = screen.lock().map(|g| g.clone()).unwrap_or_default();
                    let Some(req) = karl_agent::pty_prompt::parse_claude_prompt(&snap) else {
                        continue;
                    };
                    let settings = settings.clone();
                    let judge = |prompt: String| {
                        let settings = settings.clone();
                        async move { perception_judge(&settings, prompt).await }
                    };
                    match perception_decide_async(&req, consecutive, PERCEPTION_CAP, judge).await {
                        PerceptionOutcome::Answered { option_id, reason } => {
                            // Re-verify the prompt survived judge latency
                            // unchanged; anything else → hand back.
                            let snap2 = screen.lock().map(|g| g.clone()).unwrap_or_default();
                            let still_same = karl_agent::pty_prompt::parse_claude_prompt(&snap2)
                                .is_some_and(|r| fingerprint(&r) == fingerprint(&req));
                            if !still_same {
                                consecutive = 0;
                                continue;
                            }
                            let state = app.state::<crate::AppState>();
                            if state.write_pty(session_id, option_id.as_bytes()).await {
                                consecutive += 1;
                                tracing::info!(
                                    session = %session_id,
                                    option = %option_id,
                                    reason = %reason,
                                    "pty perception auto-answered claude prompt"
                                );
                                let _ = app.emit(
                                    "perception:pty-auto-answer",
                                    serde_json::json!({
                                        "sessionId": session_id.to_string(),
                                        "optionId": option_id,
                                        "reason": reason,
                                    }),
                                );
                            } else {
                                consecutive = 0;
                            }
                        }
                        PerceptionOutcome::Escalated => consecutive = 0,
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    })
}

/// Stable identity of a parsed prompt for the pre-write drift check.
fn fingerprint(req: &karl_agent::acp::PermissionRequest) -> String {
    serde_json::to_string(req).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fingerprint_detects_prompt_drift() {
        let a = karl_agent::pty_prompt::parse_claude_prompt(
            "│ Bash command\n│   git status\n│ Do you want to proceed?\n│ ❯ 1. Yes\n│   2. No (esc)",
        )
        .unwrap();
        let b = karl_agent::pty_prompt::parse_claude_prompt(
            "│ Bash command\n│   git push\n│ Do you want to proceed?\n│ ❯ 1. Yes\n│   2. No (esc)",
        )
        .unwrap();
        assert_eq!(fingerprint(&a), fingerprint(&a));
        assert_ne!(fingerprint(&a), fingerprint(&b));
    }
}
