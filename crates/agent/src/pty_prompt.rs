//! Parse a Claude Code permission prompt off a rendered vt100 screen into
//! the same [`PermissionRequest`] shape ACP delivers natively, so PTY
//! Perception reuses the ACP decision core (`acp::perception::decide`)
//! unchanged — same judge, same code-level safety floor, same
//! never-answer-persistent-options rule.
//!
//! CLOSED SET by design: only the exact prompt shapes Claude Code renders
//! today parse; anything else returns `None` and the prompt stays with the
//! human. This is scraped text, not protocol — the floor here can never be
//! protocol-grade, so every ambiguity resolves to "don't parse".
//!
//! For "Bash command" prompts the command block is joined verbatim
//! (including Claude's dimmed description line — the grid can't tell them
//! apart) and the WHOLE block goes through `safety::classify`, whose
//! patterns match anywhere in a multiline string. A description that
//! mentions `kill` over-escalates; a dangerous second line never slips.

use once_cell::sync::Lazy;
use regex::Regex;

use crate::acp::protocol::{PermissionOption, PermissionRequest, PermissionToolCall};

static OPTION_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[❯>]?\s*(\d+)\.\s+(.*)$").expect("option regex compiles"));

/// Strip TUI chrome from one grid line: box borders, the `●` bullet,
/// surrounding whitespace. Border-only lines collapse to "".
fn clean(line: &str) -> &str {
    let t = line.trim();
    let t = t.strip_prefix('│').unwrap_or(t);
    let t = t.strip_suffix('│').unwrap_or(t);
    let t = t.trim();
    let t = t.strip_prefix('●').map(str::trim_start).unwrap_or(t);
    if t.chars().all(|c| "─╭╮╰╯┌┐└┘".contains(c)) {
        ""
    } else {
        t
    }
}

/// Which permission question this line is, if any.
fn question_kind(line: &str) -> Option<&'static str> {
    if line.contains("Do you want to proceed?") {
        Some("proceed")
    } else if line.contains("Do you want to make this edit to")
        || line.contains("Do you want to create")
    {
        Some("edit")
    } else if line.contains("Do you want to read") {
        Some("read")
    } else {
        None
    }
}

fn option_kind(label: &str) -> String {
    let l = label.to_ascii_lowercase();
    if l.contains("don't ask again")
        || l.contains("always")
        || l.contains("allow all")
        || l.contains("this session")
    {
        "allow_always".to_string()
    } else if l.starts_with("yes") {
        "allow_once".to_string()
    } else {
        "reject_once".to_string()
    }
}

/// Parse a Claude Code permission prompt from a tidied vt100 screen dump.
/// Returns `None` on anything that isn't unambiguously one known prompt.
pub fn parse_claude_prompt(screen: &str) -> Option<PermissionRequest> {
    let lines: Vec<&str> = screen.lines().map(clean).collect();

    // Exactly one question line — two would mean stale scrollback above a
    // live prompt, and we can't tell which one the executor is parked on.
    let mut question = None;
    for (i, l) in lines.iter().enumerate() {
        if let Some(k) = question_kind(l) {
            if question.is_some() {
                return None;
            }
            question = Some((i, k));
        }
    }
    // No boxed permission question → try the free-form "(recommended)"
    // choice fallback before giving up.
    let (qi, qkind) = match question {
        Some(q) => q,
        None => return parse_choice_prompt(&lines),
    };

    let (kind, command) = match qkind {
        "proceed" => {
            // "proceed" alone says nothing about the tool; require the
            // "Bash command" header and take everything between it and the
            // question as the command block.
            let hi = lines[..qi].iter().rposition(|l| *l == "Bash command")?;
            let cmd = lines[hi + 1..qi]
                .iter()
                .filter(|l| !l.is_empty())
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
            if cmd.is_empty() {
                return None;
            }
            ("execute", Some(cmd))
        }
        "edit" => ("edit", None),
        "read" => ("read", None),
        _ => return None,
    };

    // Numbered options below the question; a non-matching non-empty line
    // is a wrapped continuation of the previous option's label.
    let mut options: Vec<PermissionOption> = Vec::new();
    for l in &lines[qi + 1..] {
        if let Some(c) = OPTION_RE.captures(l) {
            options.push(PermissionOption {
                option_id: c[1].to_string(),
                kind: String::new(),
                name: Some(c[2].trim().to_string()),
            });
        } else if l.is_empty() {
            if !options.is_empty() {
                break;
            }
        } else if let Some(last) = options.last_mut() {
            if let Some(name) = last.name.as_mut() {
                name.push(' ');
                name.push_str(l);
            }
        }
    }
    if options.len() < 2 || !options.iter().any(|o| o.option_id == "1") {
        return None;
    }
    for o in &mut options {
        o.kind = option_kind(o.name.as_deref().unwrap_or(""));
    }

    Some(PermissionRequest {
        session_id: String::new(),
        tool_call: PermissionToolCall {
            tool_call_id: "pty".to_string(),
            title: None,
            kind: Some(kind.to_string()),
            raw_input: command.map(|c| serde_json::json!({ "command": c })),
        },
        options,
    })
}

/// Fallback for the agent's own free-form question: a numbered list where
/// exactly ONE item is tagged `(recommended)` / `(default)`. That deliberate
/// tag is the whole safety signal — there is no command to classify — so the
/// answer is just that option's number and the judge is the triviality
/// backstop. Strict: exactly one tagged item, ≥2 numbered lines total, and a
/// `?` somewhere (the agent is actually asking).
///
/// ponytail: anchored on the unique tag, not on real list-boundary parsing —
/// the on-screen scrollback often holds several numbered lists (a task list
/// above the options), and only the tag disambiguates. Ceiling: two lists
/// that each carry a tag → we bail (return None) rather than guess. Upgrade
/// path: isolate the options block adjacent to the question if the tag
/// convention ever proves too loose.
fn parse_choice_prompt(lines: &[&str]) -> Option<PermissionRequest> {
    let mut answer: Option<(String, String)> = None; // (number, label)
    let mut option_count = 0usize;
    let mut tagged = 0usize;
    for l in lines {
        if let Some(c) = OPTION_RE.captures(l) {
            option_count += 1;
            let label = c[2].trim().to_string();
            let low = label.to_ascii_lowercase();
            if low.contains("(recommended)") || low.contains("(default)") {
                tagged += 1;
                answer = Some((c[1].to_string(), label));
            }
        }
    }
    let (num, label) = answer?;
    if tagged != 1 || option_count < 2 || !lines.iter().any(|l| l.ends_with('?')) {
        return None;
    }
    let title = lines
        .iter()
        .rev()
        .find(|l| l.ends_with('?'))
        .map(|s| s.to_string());

    Some(PermissionRequest {
        session_id: String::new(),
        tool_call: PermissionToolCall {
            tool_call_id: "pty".to_string(),
            title,
            kind: Some("choice".to_string()),
            raw_input: None,
        },
        // Only the recommended option is offered — the judge can pick nothing
        // else, so the "chosen == recommended" constraint is enforced by
        // construction.
        options: vec![PermissionOption {
            option_id: num,
            kind: "recommended".to_string(),
            name: Some(label),
        }],
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::perception::{decide, JudgeVerdict, PerceptionDecision};

    const BASH_PROMPT: &str = "\
╭──────────────────────────────────────────────╮
│ Bash command                                 │
│                                              │
│   git status                                 │
│                                              │
│ Do you want to proceed?                      │
│ ❯ 1. Yes                                     │
│   2. Yes, and don't ask again for git status │
│      commands in /Users/x/repo               │
│   3. No, and tell Claude what to do          │
│      differently (esc)                       │
╰──────────────────────────────────────────────╯";

    #[test]
    fn parses_bash_prompt() {
        let req = parse_claude_prompt(BASH_PROMPT).expect("should parse");
        assert_eq!(req.tool_call.kind.as_deref(), Some("execute"));
        assert_eq!(req.tool_call.command(), Some("git status"));
        assert_eq!(req.options.len(), 3);
        assert_eq!(req.options[0].option_id, "1");
        assert_eq!(req.options[0].kind, "allow_once");
        // "don't ask again" (with wrapped continuation) → persistent.
        assert_eq!(req.options[1].kind, "allow_always");
        assert_eq!(req.options[2].kind, "reject_once");
    }

    #[test]
    fn parses_edit_prompt() {
        let screen = "\
Do you want to make this edit to src/main.rs?
❯ 1. Yes
  2. Yes, allow all edits during this session (shift+tab)
  3. No, and tell Claude what to do differently (esc)";
        let req = parse_claude_prompt(screen).expect("should parse");
        assert_eq!(req.tool_call.kind.as_deref(), Some("edit"));
        assert!(req.tool_call.command().is_none());
        assert_eq!(req.options[1].kind, "allow_always");
    }

    #[test]
    fn bash_prompt_flows_through_acp_decide() {
        // End-to-end with the untouched ACP core: safe command + trivial
        // judge → auto-answer option 1.
        let req = parse_claude_prompt(BASH_PROMPT).unwrap();
        let d = decide(
            &req,
            &JudgeVerdict::Trivial {
                option_id: "1".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::AutoAnswer { option_id, .. } if option_id == "1"));
    }

    #[test]
    fn persistent_option_never_auto_answers() {
        let req = parse_claude_prompt(BASH_PROMPT).unwrap();
        let d = decide(
            &req,
            &JudgeVerdict::Trivial {
                option_id: "2".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn dangerous_second_line_escalates() {
        // A multiline command block classifies as a whole — a dangerous
        // fragment on any line trips the floor.
        let screen = "\
│ Bash command
│   echo hi
│   sudo rm -rf /
│ Do you want to proceed?
│ ❯ 1. Yes
│   2. No, and tell Claude what to do differently (esc)";
        let req = parse_claude_prompt(screen).expect("should parse");
        let d = decide(
            &req,
            &JudgeVerdict::Trivial {
                option_id: "1".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::Escalate));
    }

    #[test]
    fn no_question_returns_none() {
        assert!(parse_claude_prompt("just some output\n> ").is_none());
    }

    #[test]
    fn two_questions_return_none() {
        let screen = "\
Do you want to proceed?
1. Yes
2. No
Do you want to proceed?
1. Yes
2. No";
        assert!(parse_claude_prompt(screen).is_none());
    }

    #[test]
    fn proceed_without_bash_header_returns_none() {
        // Unknown tool behind a generic "proceed" → not in the closed set.
        let screen = "\
Some fancy new tool
Do you want to proceed?
❯ 1. Yes
  2. No";
        assert!(parse_claude_prompt(screen).is_none());
    }

    #[test]
    fn single_option_returns_none() {
        let screen = "\
Do you want to make this edit to a.rs?
❯ 1. Yes";
        assert!(parse_claude_prompt(screen).is_none());
    }

    // ---- free-form "(recommended)" choice prompts ------------------------

    #[test]
    fn parses_recommended_choice() {
        let screen = "\
Two execution options:
1. Subagent-Driven (recommended) — I dispatch a fresh subagent per task.
2. Inline Execution — I execute the tasks in this session.

Which approach?";
        let req = parse_claude_prompt(screen).expect("should parse");
        assert_eq!(req.tool_call.kind.as_deref(), Some("choice"));
        assert_eq!(req.options.len(), 1);
        assert_eq!(req.options[0].option_id, "1");
        assert_eq!(req.options[0].kind, "recommended");
        assert_eq!(req.tool_call.title.as_deref(), Some("Which approach?"));
    }

    #[test]
    fn choice_ignores_earlier_numbered_lists() {
        // The real screen carries an unrelated task list (1..8) above the
        // options list. Only the (recommended) tag anchors the answer, so the
        // task list is inert.
        let screen = "\
8 tasks:
1. worktree_detail command — 2 tests
2. worktree_clean_target — 2 tests
3. disk size helper — vitest

Two execution options:
1. Subagent-Driven (recommended) — fresh subagent per task.
2. Inline Execution — in this session.

Which approach?";
        let req = parse_claude_prompt(screen).expect("should parse");
        assert_eq!(req.tool_call.kind.as_deref(), Some("choice"));
        assert_eq!(req.options[0].option_id, "1");
    }

    #[test]
    fn recommended_on_second_option() {
        let screen = "\
1. Fast but risky.
2. Safe and boring (recommended).

Pick one?";
        let req = parse_claude_prompt(screen).expect("should parse");
        assert_eq!(req.options[0].option_id, "2");
    }

    #[test]
    fn choice_without_recommended_returns_none() {
        let screen = "\
1. Option A.
2. Option B.

Which one?";
        assert!(parse_claude_prompt(screen).is_none());
    }

    #[test]
    fn choice_with_two_recommended_returns_none() {
        let screen = "\
1. Option A (recommended).
2. Option B (recommended).

Which one?";
        assert!(parse_claude_prompt(screen).is_none());
    }

    #[test]
    fn choice_single_option_returns_none() {
        // A lone recommended item isn't a menu.
        let screen = "\
1. Just do it (recommended).

Proceed?";
        assert!(parse_claude_prompt(screen).is_none());
    }

    #[test]
    fn choice_without_question_returns_none() {
        // No "?" → the agent isn't asking, it's narrating.
        let screen = "\
1. Subagent-Driven (recommended).
2. Inline Execution.";
        assert!(parse_claude_prompt(screen).is_none());
    }

    #[test]
    fn recommended_choice_flows_through_acp_decide() {
        let screen = "\
1. Subagent-Driven (recommended) — fresh subagent per task.
2. Inline Execution — in this session.

Which approach?";
        let req = parse_claude_prompt(screen).unwrap();
        let d = decide(
            &req,
            &JudgeVerdict::Trivial {
                option_id: "1".into(),
            },
            0,
            5,
        );
        assert!(matches!(d, PerceptionDecision::AutoAnswer { option_id, .. } if option_id == "1"));
    }
}
