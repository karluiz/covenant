//! Subscriber that turns `SessionEvent::AgentIdleWaiting` into a user-
//! facing notification. This module hosts the pure formatter today and
//! will gain the bus-subscriber task in Task 4.

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
