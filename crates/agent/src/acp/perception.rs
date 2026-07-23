//! Pure decision core for operator "Perception": auto-answer trivial,
//! safe interactive ACP permission prompts. No async, no model, no I/O —
//! the async Haiku judge is computed by the caller and passed in as a
//! `JudgeVerdict`, keeping this unit-testable and deterministic.

use crate::safety::{classify, Risk};

use super::protocol::PermissionRequest;

/// The Haiku judge's verdict on a single permission prompt.
#[derive(Debug, Clone)]
pub enum JudgeVerdict {
    /// Trivial with an obviously-correct answer: pick this option.
    Trivial { option_id: String },
    /// Not trivial, or the judge wasn't confident — hand to the human.
    Uncertain,
}

/// What Perception does with a parked permission request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PerceptionDecision {
    AutoAnswer { option_id: String, reason: String },
    Escalate,
}

/// Combine the hard safety floor, the judge verdict, and the
/// consecutive-auto-answer count into a decision. Escalates on ANY doubt.
pub fn decide(
    req: &PermissionRequest,
    judge: &JudgeVerdict,
    consecutive: u32,
    cap: u32,
) -> PerceptionDecision {
    // Handback: too many auto-answers in a row without the human → stop.
    if consecutive >= cap {
        return PerceptionDecision::Escalate;
    }

    // Hard safety floor FIRST — a CLOSED SET of kinds, mirroring the
    // deny-biased posture of `policy::resolve_headless_with_log`. The floor
    // must NEVER be more permissive than `classify`: any kind we don't
    // explicitly whitelist (an alien kind, or a missing `kind`) escalates
    // before the judge is even consulted.
    match req.tool_call.kind.as_deref() {
        Some("read") | Some("edit") => {}
        Some("execute") => match req.tool_call.command() {
            Some(cmd) if classify(cmd) == Risk::Safe => {}
            // Missing command or a Mutates/Destructive command → hand back.
            _ => return PerceptionDecision::Escalate,
        },
        // A free-form choice prompt: no command to classify, so the safety is
        // the parser's unique-`(recommended)` guarantee — exactly one option,
        // marked "recommended". The judge (below) still gates triviality.
        Some("choice") => {
            let rec = req.options.iter().filter(|o| o.kind == "recommended").count();
            if rec != 1 {
                return PerceptionDecision::Escalate;
            }
        }
        // Unknown kind or None → hand back.
        _ => return PerceptionDecision::Escalate,
    }

    // Only now consult the judge.
    let JudgeVerdict::Trivial { option_id } = judge else {
        return PerceptionDecision::Escalate;
    };

    // The named option must exist AND be non-persistent (never "always").
    let ok = req
        .options
        .iter()
        .any(|o| &o.option_id == option_id && !o.kind.to_ascii_lowercase().contains("always"));
    if !ok {
        return PerceptionDecision::Escalate;
    }

    PerceptionDecision::AutoAnswer {
        option_id: option_id.clone(),
        reason: format!(
            "trivial + safe ({})",
            req.tool_call.kind.as_deref().unwrap_or("?")
        ),
    }
}

/// Build the judge prompt. Deliberately narrow: the model only decides
/// "is this trivial with one obviously-correct choice", never safety —
/// safety is the code-level floor in `decide`.
pub fn build_judge_prompt(req: &PermissionRequest) -> String {
    let kind = req.tool_call.kind.as_deref().unwrap_or("unknown");
    let cmd = req.tool_call.command().unwrap_or("");
    let question = req.tool_call.title.as_deref().unwrap_or("");
    let opts = req
        .options
        .iter()
        .map(|o| match o.name.as_deref() {
            Some(n) => format!("- {} (kind: {}): {n}", o.option_id, o.kind),
            None => format!("- {} (kind: {})", o.option_id, o.kind),
        })
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "You gate an executor's permission prompt for a supervising operator.\n\
         Decide ONLY whether this is a trivial decision with one obviously-correct answer\n\
         that any reasonable engineer would pick without thinking (e.g. reading a file,\n\
         a recommended workflow default). A choice that commits consequential work\n\
         (deploying, deleting, spending real resources) is NOT trivial even if one option\n\
         is labelled recommended. If there is ANY doubt, say it is not trivial.\n\
         Do NOT reason about danger — that is handled separately.\n\n\
         question: {question}\ntool kind: {kind}\ncommand: {cmd}\noptions:\n{opts}\n\n\
         Reply with ONLY JSON: {{\"trivial\": <bool>, \"option_id\": \"<one of the option ids, or omit>\"}}"
    )
}

/// Parse the judge reply. Anything malformed, non-trivial, or naming an
/// option not present in `req` collapses to `Uncertain` (→ escalate).
pub fn parse_judge_reply(raw: &str, req: &PermissionRequest) -> JudgeVerdict {
    // Extract the first {...} span so prose around the JSON is tolerated.
    let json = match (raw.find('{'), raw.rfind('}')) {
        (Some(a), Some(b)) if b > a => &raw[a..=b],
        _ => return JudgeVerdict::Uncertain,
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(json) else {
        return JudgeVerdict::Uncertain;
    };
    if v.get("trivial").and_then(|t| t.as_bool()) != Some(true) {
        return JudgeVerdict::Uncertain;
    }
    let Some(id) = v.get("option_id").and_then(|s| s.as_str()) else {
        return JudgeVerdict::Uncertain;
    };
    if req.options.iter().any(|o| o.option_id == id) {
        JudgeVerdict::Trivial {
            option_id: id.to_string(),
        }
    } else {
        JudgeVerdict::Uncertain
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::protocol::{PermissionOption, PermissionRequest, PermissionToolCall};

    // Minimal builders mirroring the real protocol shapes.
    fn opt(id: &str, kind: &str) -> PermissionOption {
        PermissionOption {
            option_id: id.into(),
            kind: kind.into(),
            name: None,
        }
    }
    fn req(kind: &str, cmd: Option<&str>, opts: Vec<PermissionOption>) -> PermissionRequest {
        PermissionRequest {
            session_id: "s1".into(),
            tool_call: PermissionToolCall::for_test(kind, cmd),
            options: opts,
        }
    }

    #[test]
    fn trivial_safe_read_auto_answers() {
        let r = req(
            "read",
            None,
            vec![
                opt("allow_once", "allow_once"),
                opt("reject_once", "reject_once"),
            ],
        );
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_once".into(),
            },
            0,
            5,
        );
        assert!(
            matches!(d, PerceptionDecision::AutoAnswer { option_id, .. } if option_id == "allow_once")
        );
    }

    #[test]
    fn risky_execute_escalates_even_when_judge_says_trivial() {
        // Floor must win over the judge.
        let r = req(
            "execute",
            Some("sudo reboot"),
            vec![
                opt("allow_once", "allow_once"),
                opt("reject_once", "reject_once"),
            ],
        );
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_once".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn judge_uncertain_escalates() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let d = decide(&r, &JudgeVerdict::Uncertain, 0, 5);
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn judge_names_persistent_option_escalates() {
        // "always" options are never auto-selectable.
        let r = req(
            "read",
            None,
            vec![
                opt("allow_always", "allow_always"),
                opt("allow_once", "allow_once"),
            ],
        );
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_always".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn judge_names_absent_option_escalates() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "nope".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn cap_reached_escalates() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_once".into(),
            },
            5,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn safe_execute_auto_answers() {
        let r = req(
            "execute",
            Some("ls -la"),
            vec![
                opt("allow_once", "allow_once"),
                opt("reject_once", "reject_once"),
            ],
        );
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_once".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::AutoAnswer { .. }));
    }

    #[test]
    fn safe_edit_auto_answers() {
        // policy.rs allows edits; the closed-set floor must keep them.
        let r = req(
            "edit",
            None,
            vec![
                opt("allow_once", "allow_once"),
                opt("reject_once", "reject_once"),
            ],
        );
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_once".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::AutoAnswer { .. }));
    }

    #[test]
    fn unknown_kind_escalates_even_when_judge_says_trivial() {
        // Closed-set floor: a kind outside {read, edit, execute} is never
        // auto-answerable, no matter how the judge votes.
        let r = req(
            "other",
            None,
            vec![
                opt("allow_once", "allow_once"),
                opt("reject_once", "reject_once"),
            ],
        );
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_once".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn missing_kind_escalates() {
        // No `kind` on the wire → default-deny.
        let r = PermissionRequest {
            session_id: "s1".into(),
            tool_call: PermissionToolCall {
                tool_call_id: "call_test".into(),
                title: None,
                kind: None,
                raw_input: None,
            },
            options: vec![opt("allow_once", "allow_once")],
        };
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_once".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn mutating_execute_escalates() {
        // Middle tri-state: classify() == Mutates (not Safe, not Destructive)
        // must still escalate — the floor is never more permissive than
        // classify.
        let r = req(
            "execute",
            Some("git checkout main"),
            vec![
                opt("allow_once", "allow_once"),
                opt("reject_once", "reject_once"),
            ],
        );
        let d = decide(
            &r,
            &JudgeVerdict::Trivial {
                option_id: "allow_once".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn choice_with_one_recommended_auto_answers() {
        let r = req("choice", None, vec![opt("1", "recommended")]);
        let d = decide(&r, &JudgeVerdict::Trivial { option_id: "1".into() }, 0, 5);
        assert!(matches!(d, PerceptionDecision::AutoAnswer { option_id, .. } if option_id == "1"));
    }

    #[test]
    fn choice_without_recommended_escalates() {
        // Floor guards even if the judge is fooled: no recommended option.
        let r = req("choice", None, vec![opt("1", ""), opt("2", "")]);
        let d = decide(&r, &JudgeVerdict::Trivial { option_id: "1".into() }, 0, 5);
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn parse_valid_trivial_reply() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let v = parse_judge_reply(r#"{"trivial":true,"option_id":"allow_once"}"#, &r);
        assert!(matches!(v, JudgeVerdict::Trivial { option_id } if option_id == "allow_once"));
    }

    #[test]
    fn parse_reply_with_prose_around_json() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let v = parse_judge_reply(
            "Sure!\n{\"trivial\":true,\"option_id\":\"allow_once\"}\ndone",
            &r,
        );
        assert!(matches!(v, JudgeVerdict::Trivial { .. }));
    }

    #[test]
    fn parse_not_trivial_is_uncertain() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let v = parse_judge_reply(r#"{"trivial":false}"#, &r);
        assert!(matches!(v, JudgeVerdict::Uncertain));
    }

    #[test]
    fn parse_trivial_true_without_option_id_is_uncertain() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let v = parse_judge_reply(r#"{"trivial":true}"#, &r);
        assert!(matches!(v, JudgeVerdict::Uncertain));
    }

    #[test]
    fn parse_garbage_is_uncertain() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        assert!(matches!(
            parse_judge_reply("not json at all", &r),
            JudgeVerdict::Uncertain
        ));
    }

    #[test]
    fn parse_unknown_option_is_uncertain() {
        let r = req("read", None, vec![opt("allow_once", "allow_once")]);
        let v = parse_judge_reply(r#"{"trivial":true,"option_id":"ghost"}"#, &r);
        assert!(matches!(v, JudgeVerdict::Uncertain));
    }

    #[test]
    fn prompt_lists_the_options() {
        let r = req(
            "execute",
            Some("ls"),
            vec![
                opt("allow_once", "allow_once"),
                opt("reject_once", "reject_once"),
            ],
        );
        let p = build_judge_prompt(&r);
        assert!(p.contains("allow_once") && p.contains("reject_once") && p.contains("ls"));
    }
}
