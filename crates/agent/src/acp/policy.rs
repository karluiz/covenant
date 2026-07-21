//! Headless permission policy for autonomous ACP sessions. Deny-biased:
//! edits/reads inside the sandboxed cwd are fine (copilot enforces
//! --add-dir), execute only when `safety::classify` says Safe, and we
//! never persist a grant (`allow_always`) — a background task must not
//! widen future sessions.

use std::sync::Mutex;

use crate::safety::{classify, Risk};

use super::protocol::PermissionRequest;

/// Per-session trust level for interactive ACP tabs. `Ask` defers every
/// permission request to the user; `Balanced` is the historical hybrid
/// (edits/reads/safe commands auto-allowed); `Yolo` auto-allows
/// everything — the native equivalent of --dangerously-skip-permissions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcpTrust {
    Ask,
    #[default]
    Balanced,
    Yolo,
}

/// YOLO: allow everything. Shares `pick_option`'s floor — never selects
/// an "always" option (no grant outlives the session), degrades to ""
/// (caller defers to the user) when only alien/persistent options exist.
pub fn resolve_yolo(req: &PermissionRequest) -> String {
    pick_option(req, true)
}

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
    if let Some(o) = req
        .options
        .iter()
        .find(|o| o.kind.eq_ignore_ascii_case(wanted))
    {
        return o.option_id.clone();
    }
    // Deny-biased floor: neither branch may fall through to
    // `options.first()` unconditionally, because an arbitrary first
    // option can be allow-ish (deny path) or persistent (allow path).
    // All kind comparisons are case-insensitive so casing variants
    // ("AllowOnce", "allowAlways") cannot defeat the floor.
    // Both branches degrade to an empty optionId as the last resort —
    // the session layer replies with an optionId the agent won't
    // recognize, which is the conservative failure mode (an
    // unrecognized reply blocks progress rather than silently
    // approving or persisting a grant).
    if allow {
        // Allow path: a reject-ish option is a *safe* fallback here (it
        // just declines), but an "always" option is never safe — it
        // persists a grant beyond this headless session.
        req.options
            .iter()
            .find(|o| !o.kind.to_ascii_lowercase().contains("always"))
            .map(|o| o.option_id.clone())
            .unwrap_or_default()
    } else {
        // Deny path: prefer anything reject-ish, but never return an
        // option whose kind contains "allow" — an alien reject-shaped
        // kind that isn't literally "reject_once" is still safer than
        // guessing, so widen slightly to "reject"-ish before giving up.
        req.options
            .iter()
            .find(|o| o.kind.to_ascii_lowercase().contains("reject"))
            .or_else(|| {
                req.options
                    .iter()
                    .find(|o| !o.kind.to_ascii_lowercase().contains("allow"))
            })
            .map(|o| o.option_id.clone())
            .unwrap_or_default()
    }
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
            assert_eq!(
                resolve_headless(&req("execute", Some(cmd))),
                "allow_once",
                "{cmd}"
            );
        }
    }

    #[test]
    fn mutating_and_destructive_commands_denied() {
        for cmd in [
            "git push origin main",
            "rm -rf /tmp/x",
            "sudo ls",
            "npm install left-pad",
        ] {
            assert_eq!(
                resolve_headless(&req("execute", Some(cmd))),
                "reject_once",
                "{cmd}"
            );
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

    #[test]
    fn deny_never_degrades_to_allow() {
        // No reject-ish option present at all — the deny path must not
        // fall through to `first()`, which here is an allow option.
        let mut r = req("execute", Some("sudo rm -rf /"));
        r.options = serde_json::from_value(serde_json::json!([
            { "optionId": "a1", "kind": "allow_once", "name": "Allow once" },
            { "optionId": "a2", "kind": "allow_always", "name": "Always allow" }
        ]))
        .expect("fixture parses");
        let picked = resolve_headless(&r);
        assert_ne!(picked, "a1");
        assert_ne!(picked, "a2");
        assert_eq!(picked, "");
    }

    #[test]
    fn allow_never_persists() {
        // Only an `allow_always` option is offered — the allow path must
        // not persist a grant even as a last resort.
        let mut r = req("edit", None);
        r.options = serde_json::from_value(serde_json::json!([
            { "optionId": "aa", "kind": "allow_always", "name": "Always allow" }
        ]))
        .expect("fixture parses");
        let picked = resolve_headless(&r);
        assert_ne!(picked, "aa");
    }

    #[test]
    fn casing_variants_do_not_defeat_the_floor() {
        // Kind matching must be case-insensitive: "AllowOnce" must not
        // slip past the deny path's `!contains("allow")` filter, and
        // "allowAlways" must not slip past the allow path's
        // `!contains("always")` filter.
        let mut deny = req("execute", Some("sudo ls"));
        deny.options = serde_json::from_value(serde_json::json!([
            { "optionId": "x1", "kind": "AllowOnce", "name": "Allow once" }
        ]))
        .expect("fixture parses");
        assert_eq!(resolve_headless(&deny), "");

        let mut allow = req("edit", None);
        allow.options = serde_json::from_value(serde_json::json!([
            { "optionId": "x2", "kind": "allowAlways", "name": "Always allow" }
        ]))
        .expect("fixture parses");
        assert_eq!(resolve_headless(&allow), "");
    }

    #[test]
    fn allow_path_may_fall_back_to_reject() {
        // On the allow path, a reject-ish option is a safe fallback: it
        // just declines rather than persisting a grant.
        let mut r = req("edit", None);
        r.options = serde_json::from_value(serde_json::json!([
            { "optionId": "r1", "kind": "reject_once", "name": "Deny" }
        ]))
        .expect("fixture parses");
        assert_eq!(resolve_headless(&r), "r1");
    }

    #[test]
    fn yolo_allows_dangerous_execute_without_persisting() {
        // YOLO allows what Balanced denies…
        let r = req("execute", Some("sudo rm -rf /tmp/x"));
        assert_eq!(resolve_yolo(&r), "allow_once");
        // …but still never picks a persistent grant.
        let mut only_always = req("edit", None);
        only_always.options = serde_json::from_value(serde_json::json!([
            { "optionId": "aa", "kind": "allow_always", "name": "Always allow" }
        ]))
        .expect("fixture parses");
        assert_eq!(resolve_yolo(&only_always), "");
    }

    #[test]
    fn trust_default_is_balanced() {
        assert_eq!(AcpTrust::default(), AcpTrust::Balanced);
        // Wire format is snake_case lowercase words.
        assert_eq!(
            serde_json::to_string(&AcpTrust::Yolo).expect("ser"),
            "\"yolo\""
        );
        let t: AcpTrust = serde_json::from_str("\"ask\"").expect("de");
        assert_eq!(t, AcpTrust::Ask);
    }
}
