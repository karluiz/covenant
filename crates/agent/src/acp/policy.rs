//! Headless permission policy for autonomous ACP sessions. Deny-biased:
//! edits/reads inside the sandboxed cwd are fine (copilot enforces
//! --add-dir), execute only when `safety::classify` says Safe, and we
//! never persist a grant (`allow_always`) — a background task must not
//! widen future sessions.

use std::sync::Mutex;

use crate::safety::{classify, Risk};

use super::protocol::PermissionRequest;

/// Pick an optionId for a permission request with nobody watching.
pub fn resolve_headless(req: &PermissionRequest) -> String {
    static NO_LOG: Mutex<Vec<String>> = Mutex::new(Vec::new());
    resolve_headless_with_log(req, &NO_LOG)
}

/// Same, but records denied execute commands into `denied` so callers
/// can report them (the operator tells the LLM what was blocked).
pub fn resolve_headless_with_log(req: &PermissionRequest, denied: &Mutex<Vec<String>>) -> String {
    let allow = match req.tool_call.kind.as_deref() {
        Some("edit") | Some("read") => true,
        Some("execute") => match req.tool_call.command() {
            Some(cmd) if classify(cmd) == Risk::Safe => true,
            Some(cmd) => {
                if let Ok(mut d) = denied.lock() {
                    d.push(cmd.to_string());
                }
                false
            }
            None => false,
        },
        _ => false,
    };
    pick_option(req, allow)
}

fn pick_option(req: &PermissionRequest, allow: bool) -> String {
    let wanted = if allow { "allow_once" } else { "reject_once" };
    if let Some(o) = req.options.iter().find(|o| o.kind == wanted) {
        return o.option_id.clone();
    }
    // Alien option kinds: for deny, prefer anything reject-ish; for
    // allow, prefer non-persistent; last resort first option.
    let fallback = if allow {
        req.options.iter().find(|o| !o.kind.contains("always"))
    } else {
        req.options.iter().find(|o| o.kind.contains("reject"))
    };
    fallback
        .or_else(|| req.options.first())
        .map(|o| o.option_id.clone())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::protocol::PermissionRequest;

    fn req(kind: &str, command: Option<&str>) -> PermissionRequest {
        let raw_input = command
            .map(|c| serde_json::json!({ "command": c }))
            .unwrap_or(serde_json::json!({}));
        serde_json::from_value(serde_json::json!({
            "sessionId": "s1",
            "toolCall": { "toolCallId": "t1", "kind": kind, "rawInput": raw_input },
            "options": [
                { "optionId": "allow_once", "kind": "allow_once", "name": "Allow once" },
                { "optionId": "allow_always", "kind": "allow_always", "name": "Always allow" },
                { "optionId": "reject_once", "kind": "reject_once", "name": "Deny" }
            ]
        }))
        .expect("fixture parses")
    }

    #[test]
    fn edits_and_reads_allowed() {
        assert_eq!(resolve_headless(&req("edit", None)), "allow_once");
        assert_eq!(resolve_headless(&req("read", None)), "allow_once");
    }

    #[test]
    fn safe_commands_allowed() {
        for cmd in ["ls", "git status", "python3 fib.py", "cargo check"] {
            assert_eq!(resolve_headless(&req("execute", Some(cmd))), "allow_once", "{cmd}");
        }
    }

    #[test]
    fn mutating_and_destructive_commands_denied() {
        for cmd in ["git push origin main", "rm -rf /tmp/x", "sudo ls", "npm install left-pad"] {
            assert_eq!(resolve_headless(&req("execute", Some(cmd))), "reject_once", "{cmd}");
        }
    }

    #[test]
    fn execute_without_command_string_denied() {
        assert_eq!(resolve_headless(&req("execute", None)), "reject_once");
    }

    #[test]
    fn unknown_kind_denied() {
        assert_eq!(resolve_headless(&req("mystery", None)), "reject_once");
    }

    #[test]
    fn never_picks_allow_always() {
        // Even for the friendliest input, a headless session must not
        // persist grants beyond itself.
        assert_ne!(resolve_headless(&req("edit", None)), "allow_always");
    }

    #[test]
    fn falls_back_to_first_option_when_kinds_are_alien() {
        let mut r = req("edit", None);
        for o in &mut r.options {
            o.kind = "weird".into();
            o.option_id = format!("w_{}", o.option_id);
        }
        assert_eq!(resolve_headless(&r), "w_allow_once");
    }

    #[test]
    fn denied_commands_are_logged() {
        let log = std::sync::Mutex::new(Vec::new());
        resolve_headless_with_log(&req("execute", Some("sudo make me a sandwich")), &log);
        let denied = log.lock().expect("lock");
        assert_eq!(denied.as_slice(), ["sudo make me a sandwich"]);
    }
}
