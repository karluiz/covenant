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
                            // Signature fields for the UI: WHO answered (the
                            // effective operator — pin, else Default), the
                            // human-readable option, and what it was about.
                            let (op_id, op_name) = registry
                                .pinned(session_id)
                                .and_then(|oid| registry.get(oid))
                                .or_else(|| registry.default())
                                .map(|o| (o.id.0.to_string(), o.name))
                                .unwrap_or_default();
                            let (option_label, subject) = toast_fields(&req, &option_id);
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
                                        "operatorId": op_id,
                                        "operatorName": op_name,
                                        "optionLabel": option_label,
                                        "subject": subject,
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

/// Toast copy: ("1. Yes", "git status"). The subject is the command's
/// first line (the parsed block may carry Claude's description line
/// below it) or the tool kind for edit/read prompts.
fn toast_fields(req: &karl_agent::acp::PermissionRequest, option_id: &str) -> (String, String) {
    let label = req
        .options
        .iter()
        .find(|o| o.option_id == option_id)
        .and_then(|o| o.name.clone())
        .map(|n| format!("{option_id}. {n}"))
        .unwrap_or_else(|| option_id.to_string());
    let subject = req
        .tool_call
        .command()
        .and_then(|c| c.lines().next())
        .map(str::to_string)
        .or_else(|| req.tool_call.kind.clone())
        .unwrap_or_default();
    (label, subject)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toast_fields_label_and_first_command_line() {
        let req = karl_agent::pty_prompt::parse_claude_prompt(
            "│ Bash command\n│   git status\n│   Show tree status\n│ Do you want to proceed?\n│ ❯ 1. Yes\n│   2. No (esc)",
        )
        .unwrap();
        let (label, subject) = toast_fields(&req, "1");
        assert_eq!(label, "1. Yes");
        assert_eq!(subject, "git status");
    }

    #[test]
    fn toast_fields_fall_back_to_kind() {
        let req = karl_agent::pty_prompt::parse_claude_prompt(
            "Do you want to make this edit to a.rs?\n❯ 1. Yes\n  2. No (esc)",
        )
        .unwrap();
        let (_label, subject) = toast_fields(&req, "1");
        assert_eq!(subject, "edit");
    }

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
