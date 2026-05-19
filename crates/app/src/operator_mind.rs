//! Per-tab persistent agent state for the Operator (spec 3.20).
//!
//! This module is pure: types, merge logic, prompt-block rendering,
//! response parsing. No I/O, no PTY, no HTTP, no DB. The integration
//! lives in `operator.rs`; persistence lives in `storage.rs`.

use std::collections::VecDeque;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub const MAX_OPEN_QUESTIONS: usize = 5;
pub const MAX_TRIED_FAILED: usize = 5;
pub const MAX_RECENT_TURNS: usize = 5;
pub const SAW_TRUNCATE_CHARS: usize = 400;
pub const THOUGHT_TRUNCATE_CHARS: usize = 200;
pub const STALE_HOURS: i64 = 24;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OperatorMind {
    pub goal: String,
    pub belief: String,
    pub open_questions: Vec<String>,
    pub tried_failed: VecDeque<String>,
    pub next_intent: String,
    pub recent: VecDeque<TurnRecord>,
    pub turn_count: u64,
    pub updated_at: DateTime<Utc>,
}

impl Default for OperatorMind {
    fn default() -> Self {
        Self {
            goal: String::new(),
            belief: String::new(),
            open_questions: vec![],
            tried_failed: VecDeque::new(),
            next_intent: String::new(),
            recent: VecDeque::new(),
            turn_count: 0,
            updated_at: Utc::now(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnRecord {
    pub turn: u64,
    pub at: DateTime<Utc>,
    pub saw: String,
    pub thought: String,
    pub action: TurnAction,
    pub executed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind")]
pub enum TurnAction {
    Reply {
        text: String,
    },
    Execute {
        command: String,
    },
    Escalate {
        notification: String,
    },
    // Model frequently emits `Wait` (matches the internal
    // `OperatorAction::Wait` name it sees in logs/code) or lowercased
    // forms instead of `Ignore`. Accept the aliases so a cosmetic
    // mismatch doesn't take the operator down with a parse error.
    #[serde(
        alias = "Wait",
        alias = "wait",
        alias = "ignore",
        alias = "noop",
        alias = "NoOp"
    )]
    Ignore,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct MindUpdate {
    #[serde(default)]
    pub goal: Option<String>,
    #[serde(default)]
    pub belief: Option<String>,
    #[serde(default)]
    pub open_questions_set: Option<Vec<String>>,
    #[serde(default)]
    pub tried_failed_append: Option<Vec<String>>,
    #[serde(default)]
    pub next_intent: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ModelResponse {
    #[serde(default)]
    pub mind_update: MindUpdate,
    pub action: TurnAction,
}

#[derive(Debug, thiserror::Error)]
pub enum MindParseError {
    #[error("no JSON object found in model output")]
    NoJsonObject,
    #[error("JSON parse failed: {0}")]
    Json(#[from] serde_json::Error),
}

impl OperatorMind {
    /// Merge a `MindUpdate` into self, enforcing caps. FIFO when capped.
    pub fn apply(&mut self, update: MindUpdate, now: DateTime<Utc>) {
        if let Some(g) = update.goal {
            self.goal = g;
        }
        if let Some(b) = update.belief {
            self.belief = b;
        }
        if let Some(qs) = update.open_questions_set {
            self.open_questions = qs.into_iter().take(MAX_OPEN_QUESTIONS).collect();
        }
        if let Some(tf) = update.tried_failed_append {
            for entry in tf {
                self.tried_failed.push_back(entry);
                while self.tried_failed.len() > MAX_TRIED_FAILED {
                    self.tried_failed.pop_front();
                }
            }
        }
        if let Some(ni) = update.next_intent {
            self.next_intent = ni;
        }
        self.updated_at = now;
    }

    /// Push a turn record onto the tape, FIFO-capped, bumps `turn_count`.
    pub fn record_turn(&mut self, mut rec: TurnRecord) {
        rec.saw = truncate(rec.saw, SAW_TRUNCATE_CHARS);
        rec.thought = truncate(rec.thought, THOUGHT_TRUNCATE_CHARS);
        self.turn_count = self.turn_count.max(rec.turn);
        self.recent.push_back(rec);
        while self.recent.len() > MAX_RECENT_TURNS {
            self.recent.pop_front();
        }
    }

    /// Whether the mind is "stale" (last update older than STALE_HOURS).
    pub fn is_stale(&self, now: DateTime<Utc>) -> bool {
        (now - self.updated_at).num_hours() > STALE_HOURS
    }
}

fn truncate(s: String, max: usize) -> String {
    if s.chars().count() <= max {
        return s;
    }
    s.chars().take(max).collect()
}

/// Render the `<mind>` XML block for the user message.
pub fn render_mind_block(mind: &OperatorMind, now: DateTime<Utc>) -> String {
    let stale_attr = if mind.is_stale(now) {
        format!(" stale-hours=\"{}\"", (now - mind.updated_at).num_hours())
    } else {
        String::new()
    };
    let mut s = format!(
        "<mind turn=\"{}\" updated=\"{}\"{}>\n",
        mind.turn_count,
        mind.updated_at.to_rfc3339(),
        stale_attr,
    );
    if !mind.goal.is_empty() {
        s.push_str(&format!("  <goal>{}</goal>\n", xml_escape(&mind.goal)));
    }
    if !mind.belief.is_empty() {
        s.push_str(&format!(
            "  <belief>{}</belief>\n",
            xml_escape(&mind.belief)
        ));
    }
    if !mind.open_questions.is_empty() {
        s.push_str("  <open-questions>\n");
        for q in &mind.open_questions {
            s.push_str(&format!("    {}\n", xml_escape(q)));
        }
        s.push_str("  </open-questions>\n");
    }
    if !mind.tried_failed.is_empty() {
        s.push_str("  <tried-failed>\n");
        for tf in &mind.tried_failed {
            s.push_str(&format!("    {}\n", xml_escape(tf)));
        }
        s.push_str("  </tried-failed>\n");
    }
    if !mind.next_intent.is_empty() {
        s.push_str(&format!(
            "  <next-intent>{}</next-intent>\n",
            xml_escape(&mind.next_intent)
        ));
    }
    s.push_str("</mind>\n");
    s
}

/// Render the `<recent-decisions>` block.
pub fn render_recent_block(mind: &OperatorMind) -> String {
    if mind.recent.is_empty() {
        return String::new();
    }
    let mut s = String::from("<recent-decisions>\n");
    for rec in &mind.recent {
        s.push_str(&format!(
            "  <turn n=\"{}\" at=\"{}\">\n    saw: {}\n    thought: {}\n    action: {} {}\n    {}\n  </turn>\n",
            rec.turn,
            rec.at.to_rfc3339(),
            xml_escape(&rec.saw),
            xml_escape(&rec.thought),
            action_kind(&rec.action),
            xml_escape(&action_summary(&rec.action)),
            if rec.executed { "executed" } else { "blocked" },
        ));
    }
    s.push_str("</recent-decisions>\n");
    s
}

fn action_kind(a: &TurnAction) -> &'static str {
    match a {
        TurnAction::Reply { .. } => "Reply",
        TurnAction::Execute { .. } => "Execute",
        TurnAction::Escalate { .. } => "Escalate",
        TurnAction::Ignore => "Ignore",
    }
}

fn action_summary(a: &TurnAction) -> String {
    match a {
        TurnAction::Reply { text } => truncate(text.clone(), 120),
        TurnAction::Execute { command } => truncate(command.clone(), 120),
        TurnAction::Escalate { notification } => truncate(notification.clone(), 120),
        TurnAction::Ignore => String::new(),
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Compute a normalized signature for repeat-failure detection.
pub fn action_signature(a: &TurnAction) -> String {
    match a {
        TurnAction::Reply { text } => text.trim().to_lowercase(),
        TurnAction::Execute { command } => command
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_lowercase(),
        TurnAction::Escalate { .. } | TurnAction::Ignore => String::new(),
    }
}

/// Returns true if the action's signature appears (case-insensitive
/// substring match) in any entry of `tried_failed`. Empty signatures
/// (Escalate, Ignore) never match.
pub fn is_repeat_of_known_failure(action: &TurnAction, tried_failed: &VecDeque<String>) -> bool {
    let sig = action_signature(action);
    if sig.is_empty() {
        return false;
    }
    let sig_lc = sig.to_lowercase();
    tried_failed
        .iter()
        .any(|tf| tf.to_lowercase().contains(&sig_lc))
}

/// Apply a masking function across all model-authored text in the
/// mind. Used before persistence to keep secrets out of SQLite.
pub fn mask_in_place<F: Fn(&str) -> String>(mind: &mut OperatorMind, mask: F) {
    mind.goal = mask(&mind.goal);
    mind.belief = mask(&mind.belief);
    mind.next_intent = mask(&mind.next_intent);
    for q in mind.open_questions.iter_mut() {
        *q = mask(q);
    }
    for tf in mind.tried_failed.iter_mut() {
        *tf = mask(tf);
    }
    for rec in mind.recent.iter_mut() {
        rec.saw = mask(&rec.saw);
        rec.thought = mask(&rec.thought);
        match &mut rec.action {
            TurnAction::Reply { text } => *text = mask(text),
            TurnAction::Execute { command } => *command = mask(command),
            TurnAction::Escalate { notification } => *notification = mask(notification),
            TurnAction::Ignore => {}
        }
    }
}

/// Find the JSON object inside a possibly-noisy text block and parse.
pub fn parse_model_response(text: &str) -> Result<ModelResponse, MindParseError> {
    let candidate = find_first_json_object(text).ok_or(MindParseError::NoJsonObject)?;
    Ok(serde_json::from_str(candidate)?)
}

/// Find the first balanced top-level JSON object in `text`. Skips over
/// braces inside string literals (handling escaped quotes). Returns
/// the slice including both braces, or None if no balanced object found.
fn find_first_json_object(text: &str) -> Option<&str> {
    let bytes = text.as_bytes();
    let start = bytes.iter().position(|&b| b == b'{')?;
    let mut depth: usize = 0;
    let mut in_string = false;
    let mut escape = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        if in_string {
            if escape {
                escape = false;
            } else if b == b'\\' {
                escape = true;
            } else if b == b'"' {
                in_string = false;
            }
            continue;
        }
        match b {
            b'"' => in_string = true,
            b'{' => depth += 1,
            b'}' => {
                depth = depth.saturating_sub(1);
                if depth == 0 {
                    return Some(&text[start..=i]);
                }
            }
            _ => {}
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-05-06T12:00:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn apply_sets_goal_and_belief() {
        let mut m = OperatorMind::default();
        m.apply(
            MindUpdate {
                goal: Some("ship 3.20".into()),
                belief: Some("executor mid-task 4".into()),
                ..Default::default()
            },
            t0(),
        );
        assert_eq!(m.goal, "ship 3.20");
        assert_eq!(m.belief, "executor mid-task 4");
    }

    #[test]
    fn apply_omitted_fields_leave_existing_unchanged() {
        let mut m = OperatorMind {
            goal: "old goal".into(),
            belief: "old belief".into(),
            ..Default::default()
        };
        m.apply(
            MindUpdate {
                belief: Some("new belief".into()),
                ..Default::default()
            },
            t0(),
        );
        assert_eq!(m.goal, "old goal");
        assert_eq!(m.belief, "new belief");
    }

    #[test]
    fn open_questions_set_replaces_and_caps_at_5() {
        let mut m = OperatorMind::default();
        m.apply(
            MindUpdate {
                open_questions_set: Some(vec![
                    "q1".into(),
                    "q2".into(),
                    "q3".into(),
                    "q4".into(),
                    "q5".into(),
                    "q6".into(),
                    "q7".into(),
                ]),
                ..Default::default()
            },
            t0(),
        );
        assert_eq!(m.open_questions.len(), 5);
        assert_eq!(m.open_questions[0], "q1");
        assert_eq!(m.open_questions[4], "q5");
    }

    #[test]
    fn open_questions_set_empty_clears_the_list() {
        let mut m = OperatorMind {
            open_questions: vec!["q1".into(), "q2".into()],
            ..Default::default()
        };
        m.apply(
            MindUpdate {
                open_questions_set: Some(vec![]),
                ..Default::default()
            },
            t0(),
        );
        assert!(m.open_questions.is_empty());
    }

    #[test]
    fn tried_failed_append_caps_fifo() {
        let mut m = OperatorMind::default();
        for i in 0..7 {
            m.apply(
                MindUpdate {
                    tried_failed_append: Some(vec![format!("attempt-{i}")]),
                    ..Default::default()
                },
                t0(),
            );
        }
        assert_eq!(m.tried_failed.len(), 5);
        assert_eq!(m.tried_failed[0], "attempt-2");
        assert_eq!(m.tried_failed[4], "attempt-6");
    }

    #[test]
    fn record_turn_caps_recent_at_5_fifo() {
        let mut m = OperatorMind::default();
        for i in 1..=7 {
            m.record_turn(TurnRecord {
                turn: i,
                at: t0(),
                saw: "saw".into(),
                thought: "thought".into(),
                action: TurnAction::Ignore,
                executed: false,
            });
        }
        assert_eq!(m.recent.len(), 5);
        assert_eq!(m.recent.front().unwrap().turn, 3);
        assert_eq!(m.recent.back().unwrap().turn, 7);
        assert_eq!(m.turn_count, 7);
    }

    #[test]
    fn record_turn_truncates_saw_and_thought() {
        let mut m = OperatorMind::default();
        let long = "x".repeat(2_000);
        m.record_turn(TurnRecord {
            turn: 1,
            at: t0(),
            saw: long.clone(),
            thought: long.clone(),
            action: TurnAction::Ignore,
            executed: false,
        });
        let r = m.recent.front().unwrap();
        assert_eq!(r.saw.chars().count(), SAW_TRUNCATE_CHARS);
        assert_eq!(r.thought.chars().count(), THOUGHT_TRUNCATE_CHARS);
    }

    #[test]
    fn render_mind_block_empty_omits_optional_subblocks() {
        let m = OperatorMind::default();
        let out = render_mind_block(&m, t0());
        assert!(out.contains("<mind turn=\"0\""));
        assert!(!out.contains("<goal>"));
        assert!(!out.contains("<belief>"));
        assert!(!out.contains("<open-questions>"));
        assert!(!out.contains("<tried-failed>"));
        assert!(!out.contains("<next-intent>"));
    }

    #[test]
    fn render_mind_block_populated_includes_all_sections() {
        let m = OperatorMind {
            goal: "g".into(),
            belief: "b".into(),
            open_questions: vec!["q1".into()],
            tried_failed: VecDeque::from(vec!["tf1".into()]),
            next_intent: "ni".into(),
            ..Default::default()
        };
        let out = render_mind_block(&m, t0());
        assert!(out.contains("<goal>g</goal>"));
        assert!(out.contains("<belief>b</belief>"));
        assert!(out.contains("<open-questions>"));
        assert!(out.contains("    q1"));
        assert!(out.contains("<tried-failed>"));
        assert!(out.contains("    tf1"));
        assert!(out.contains("<next-intent>ni</next-intent>"));
    }

    #[test]
    fn render_mind_block_emits_stale_attribute_after_24h() {
        let mut m = OperatorMind::default();
        m.updated_at = t0();
        let now = t0() + chrono::Duration::hours(36);
        let out = render_mind_block(&m, now);
        assert!(out.contains("stale-hours=\"36\""));
    }

    #[test]
    fn render_mind_block_xml_escapes_user_text() {
        let m = OperatorMind {
            belief: "<script>&".into(),
            ..Default::default()
        };
        let out = render_mind_block(&m, t0());
        assert!(out.contains("&lt;script&gt;&amp;"));
    }

    #[test]
    fn render_recent_block_empty_returns_empty_string() {
        let m = OperatorMind::default();
        assert_eq!(render_recent_block(&m), "");
    }

    #[test]
    fn render_recent_block_includes_turns() {
        let mut m = OperatorMind::default();
        m.record_turn(TurnRecord {
            turn: 3,
            at: t0(),
            saw: "tail".into(),
            thought: "thinking".into(),
            action: TurnAction::Reply { text: "yes".into() },
            executed: true,
        });
        let out = render_recent_block(&m);
        assert!(out.contains("<recent-decisions>"));
        assert!(out.contains("turn n=\"3\""));
        assert!(out.contains("action: Reply yes"));
        assert!(out.contains("executed"));
    }

    #[test]
    fn action_signature_reply_lowercases_and_trims() {
        let sig = action_signature(&TurnAction::Reply {
            text: "  YES  ".into(),
        });
        assert_eq!(sig, "yes");
    }

    #[test]
    fn action_signature_execute_takes_first_token() {
        let sig = action_signature(&TurnAction::Execute {
            command: "GIT status --short".into(),
        });
        assert_eq!(sig, "git");
    }

    #[test]
    fn action_signature_escalate_and_ignore_are_empty() {
        assert_eq!(
            action_signature(&TurnAction::Escalate {
                notification: "x".into()
            }),
            ""
        );
        assert_eq!(action_signature(&TurnAction::Ignore), "");
    }

    #[test]
    fn parse_model_response_well_formed() {
        let text = r#"
        Here is my response:
        {
          "mind_update": {
            "belief": "executor finished task 4"
          },
          "action": {
            "kind": "Reply",
            "text": "yes"
          }
        }
        Trailing noise.
        "#;
        let r = parse_model_response(text).unwrap();
        assert_eq!(
            r.mind_update.belief,
            Some("executor finished task 4".into())
        );
        assert_eq!(r.action, TurnAction::Reply { text: "yes".into() });
    }

    #[test]
    fn parse_model_response_accepts_wait_as_ignore_alias() {
        // Real-world failure mode: model emits `Wait` (matches the
        // internal OperatorAction::Wait it sees in code/logs) instead
        // of `Ignore`. Must parse cleanly, not blow up the operator.
        for kind in ["Wait", "wait", "ignore", "noop", "NoOp", "Ignore"] {
            let text = format!(r#"{{ "mind_update": {{}}, "action": {{ "kind": "{kind}" }} }}"#);
            let r = parse_model_response(&text)
                .unwrap_or_else(|e| panic!("alias `{kind}` failed: {e}"));
            assert_eq!(
                r.action,
                TurnAction::Ignore,
                "alias `{kind}` should map to Ignore"
            );
        }
    }

    #[test]
    fn parse_model_response_missing_action_errors() {
        let text = r#"{"mind_update": {}}"#;
        assert!(parse_model_response(text).is_err());
    }

    #[test]
    fn parse_model_response_invalid_json_errors() {
        assert!(parse_model_response("no braces here").is_err());
        assert!(parse_model_response("{ bad json }").is_err());
    }

    #[test]
    fn parse_model_response_extra_fields_ignored() {
        let text = r#"{
            "mind_update": { "belief": "b", "unknown_field": 42 },
            "action": { "kind": "Ignore" },
            "extra_top_level": "ok"
        }"#;
        let r = parse_model_response(text).unwrap();
        assert_eq!(r.action, TurnAction::Ignore);
    }

    #[test]
    fn parse_model_response_ignores_trailing_prose_with_braces() {
        let text = r#"
        Here is my decision:
        {"mind_update": {"belief": "ok"}, "action": {"kind": "Ignore"}}
        Note: option A} or B} would also work.
        "#;
        let r = parse_model_response(text).unwrap();
        assert_eq!(r.action, TurnAction::Ignore);
    }

    #[test]
    fn parse_model_response_handles_braces_inside_strings() {
        let text = r#"{"mind_update": {"belief": "use {x} for placeholders"}, "action": {"kind": "Ignore"}}"#;
        let r = parse_model_response(text).unwrap();
        assert_eq!(
            r.mind_update.belief.as_deref(),
            Some("use {x} for placeholders")
        );
    }

    #[test]
    fn is_repeat_of_known_failure_substring_matches() {
        let mut tf = VecDeque::new();
        tf.push_back("attempted REPLY 'yes' — blocked by safety".to_string());
        let act = TurnAction::Reply { text: "yes".into() };
        assert!(is_repeat_of_known_failure(&act, &tf));
    }

    #[test]
    fn is_repeat_of_known_failure_no_overlap() {
        let mut tf = VecDeque::new();
        tf.push_back("attempted git push — failed".to_string());
        let act = TurnAction::Reply { text: "yes".into() };
        assert!(!is_repeat_of_known_failure(&act, &tf));
    }

    #[test]
    fn is_repeat_of_known_failure_empty_signature_never_matches() {
        let mut tf = VecDeque::new();
        tf.push_back("anything".to_string());
        assert!(!is_repeat_of_known_failure(
            &TurnAction::Escalate {
                notification: "n".into()
            },
            &tf
        ));
        assert!(!is_repeat_of_known_failure(&TurnAction::Ignore, &tf));
    }

    #[test]
    fn is_repeat_of_known_failure_execute_matches_by_first_token() {
        let mut tf = VecDeque::new();
        tf.push_back("blocked: rm bypassed safety".to_string());
        let act = TurnAction::Execute {
            command: "rm -rf /tmp/x".into(),
        };
        assert!(is_repeat_of_known_failure(&act, &tf));
    }

    #[test]
    fn mask_in_place_redacts_secret_pattern_across_all_fields() {
        let mut m = OperatorMind {
            goal: "get sk-abc123".into(),
            belief: "uses sk-abc123 for auth".into(),
            next_intent: "store sk-abc123".into(),
            open_questions: vec!["why sk-abc123?".into()],
            ..Default::default()
        };
        m.tried_failed.push_back("replied with sk-abc123".into());
        m.record_turn(TurnRecord {
            turn: 1,
            at: chrono::Utc::now(),
            saw: "tail with sk-abc123".into(),
            thought: "thinking sk-abc123".into(),
            action: TurnAction::Reply {
                text: "echo sk-abc123".into(),
            },
            executed: false,
        });
        mask_in_place(&mut m, |s| s.replace("sk-abc123", "***"));
        assert!(!m.goal.contains("sk-abc123"));
        assert!(!m.belief.contains("sk-abc123"));
        assert!(!m.next_intent.contains("sk-abc123"));
        assert!(!m.open_questions[0].contains("sk-abc123"));
        assert!(!m.tried_failed[0].contains("sk-abc123"));
        let r = m.recent.front().unwrap();
        assert!(!r.saw.contains("sk-abc123"));
        assert!(!r.thought.contains("sk-abc123"));
        if let TurnAction::Reply { text } = &r.action {
            assert!(!text.contains("sk-abc123"));
        } else {
            panic!("expected Reply variant");
        }
    }

    #[test]
    fn parse_model_response_handles_escaped_quotes_in_strings() {
        let text =
            r#"{"mind_update": {"belief": "say \"yes\" to user"}, "action": {"kind": "Ignore"}}"#;
        let r = parse_model_response(text).unwrap();
        assert_eq!(r.mind_update.belief.as_deref(), Some("say \"yes\" to user"));
    }
}
