//! Deterministic English cross-tab status reply for inbound Telegram
//! questions ("what's going on?"). Reads the notch hub's current phase per
//! session — no LLM call.

use karl_session::{ExecutorPhase, SessionEvent};

fn phase_phrase(p: &ExecutorPhase) -> String {
    match p {
        ExecutorPhase::Idle => "idle".into(),
        ExecutorPhase::Thinking => "working (thinking)".into(),
        ExecutorPhase::Running { cmd } => format!("working — running `{cmd}`"),
        ExecutorPhase::Reading { file } => format!("working — reading {file}"),
        ExecutorPhase::Writing { file } => format!("working — writing {file}"),
        ExecutorPhase::Waiting { reason } => format!("waiting on you ({reason})"),
        ExecutorPhase::Done { .. } => "finished — at rest".into(),
    }
}

/// Render a one-line-per-tab status report from notch snapshots.
pub fn format_status(events: &[SessionEvent]) -> String {
    let mut lines: Vec<String> = Vec::new();
    for ev in events {
        if let SessionEvent::ExecutorStateChanged {
            phase,
            agent,
            tab_label,
            session,
        } = ev
        {
            if agent.is_none() {
                continue;
            }
            let sid = session.to_string();
            let tab = tab_label
                .clone()
                .unwrap_or_else(|| format!("session:{}", &sid[..6.min(sid.len())]));
            lines.push(format!("• {tab} — {}", phase_phrase(phase)));
        }
    }
    if lines.is_empty() {
        return "Nothing active right now — no executor agents are running.".into();
    }
    format!("Here's what's going on:\n{}", lines.join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::{ExecutorPhase, SessionEvent, SessionId};

    #[test]
    fn formats_cross_tab_status_in_english() {
        let evs = vec![
            SessionEvent::ExecutorStateChanged {
                session: SessionId::new(),
                phase: ExecutorPhase::Running {
                    cmd: "cargo test".into(),
                },
                agent: Some("claude".into()),
                tab_label: Some("main".into()),
            },
            SessionEvent::ExecutorStateChanged {
                session: SessionId::new(),
                phase: ExecutorPhase::Waiting {
                    reason: "[y/N]".into(),
                },
                agent: Some("claude".into()),
                tab_label: Some("api".into()),
            },
        ];
        let out = format_status(&evs);
        assert!(out.contains("main"));
        assert!(out.contains("working") || out.contains("cargo test"));
        assert!(out.contains("api"));
        assert!(out.contains("waiting"));
        assert!(!out.contains("escalación")); // no Spanish
    }

    #[test]
    fn empty_status_is_friendly_english() {
        assert!(format_status(&[]).to_lowercase().contains("nothing"));
    }

    #[test]
    fn agentless_sessions_are_skipped() {
        let evs = vec![SessionEvent::ExecutorStateChanged {
            session: SessionId::new(),
            phase: ExecutorPhase::Running {
                cmd: "make".into(),
            },
            agent: None,
            tab_label: Some("build".into()),
        }];
        // No foreground agent → not our concern → falls back to the empty line.
        assert!(format_status(&evs).to_lowercase().contains("nothing"));
    }
}
