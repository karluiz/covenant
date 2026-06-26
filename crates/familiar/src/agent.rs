use crate::cost::CostGate;
use crate::directive::{ensure_safe, Directive, DirectiveKind, SafetyCheck};
use crate::error::Result;
use crate::identity::FamiliarConfig;
use crate::memory::{DirectiveRow, Memory, MissionRow};
use crate::prompts::{summary_prompt, system_prompt};
use crate::summarizer::Llm;
use serde::Deserialize;

/// Staleness threshold: number of events since the last rolling summary at
/// which `/summary` invokes the LLM rather than serving from cache.
const SUMMARY_STALE_THRESHOLD: usize = 50;
const SUMMARY_TODAY_WINDOW_MS: i64 = 24 * 3600 * 1000;

pub struct ChatAgent<'a, L: Llm> {
    pub memory: &'a Memory,
    pub llm: &'a L,
    pub safety: &'a dyn SafetyCheck,
    pub config: &'a FamiliarConfig,
}

#[derive(Debug, Clone)]
pub struct ChatTurn {
    pub assistant_text: String,
    pub proposed_directive: Option<Directive>,
    pub safety_block_reason: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DirectivePayload {
    kind: String,
    payload: String,
    rationale: String,
}

impl<'a, L: Llm> ChatAgent<'a, L> {
    pub async fn turn(&self, now_ms: i64, user_text: &str) -> Result<ChatTurn> {
        self.memory.append_chat(now_ms, "user", user_text)?;

        // Spec 3.19 — `/summary` short-circuits the normal directive flow.
        if let Some(scope) = parse_slash(user_text) {
            return self.summary_turn(now_ms, scope).await;
        }

        let summary = self
            .memory
            .latest_summary()?
            .map(|s| s.summary)
            .unwrap_or_default();
        let missions = self.memory.recent_missions(5)?;
        let missions_text = missions
            .iter()
            .map(|m| format!("- mission {} ({}): {}", m.mission_id, m.objective, m.digest))
            .collect::<Vec<_>>()
            .join("\n");
        let history = self.memory.chat_history(20)?;
        let history_text = history
            .iter()
            .map(|c| format!("{}: {}", c.role, c.content))
            .collect::<Vec<_>>()
            .join("\n");

        let sys = system_prompt(self.config, &summary, &missions_text);
        let user = format!(
            "CHAT HISTORY:
{history_text}

If you want to propose a directive to the operator, include exactly one block:
<<DIRECTIVE>>
{{\"kind\":\"stop|focus|avoid|resume|custom\",\"payload\":\"...\",\"rationale\":\"...\"}}
<</DIRECTIVE>>

Otherwise just reply normally."
        );

        let resp = self.llm.complete(&sys, &user).await?;
        let (visible, parsed) = extract_directive(&resp.text);
        let mut proposed: Option<Directive> = None;
        let mut blocked: Option<String> = None;
        if let Some(p) = parsed {
            let kind = match p.kind.as_str() {
                "stop" => DirectiveKind::Stop,
                "focus" => DirectiveKind::Focus,
                "avoid" => DirectiveKind::Avoid,
                "resume" => DirectiveKind::Resume,
                _ => DirectiveKind::Custom,
            };
            let d = Directive::new(kind, p.payload, p.rationale);
            match ensure_safe(&d, self.safety) {
                Ok(()) => {
                    self.memory.log_directive(
                        &d.id,
                        now_ms,
                        "proposed",
                        &format!("{:?}", d.kind),
                        &d.payload,
                        &d.rationale,
                        None,
                    )?;
                    proposed = Some(d);
                }
                Err(crate::FamiliarError::SafetyBlocked { reason }) => {
                    self.memory.log_directive(
                        &d.id,
                        now_ms,
                        "safety_blocked",
                        &format!("{:?}", d.kind),
                        &d.payload,
                        &d.rationale,
                        Some(&reason),
                    )?;
                    blocked = Some(reason);
                }
                Err(e) => return Err(e),
            }
        }
        self.memory.append_chat(now_ms + 1, "assistant", &visible)?;
        Ok(ChatTurn {
            assistant_text: visible,
            proposed_directive: proposed,
            safety_block_reason: blocked,
        })
    }
}

impl<'a, L: Llm> ChatAgent<'a, L> {
    /// Handle `/summary [scope]`. Decides cache-hit vs LLM-call based on
    /// staleness + frozen-mode. Never proposes a directive. Persists the
    /// assistant turn (the user turn was appended by `turn()` already).
    pub async fn summary_turn(&self, now_ms: i64, scope: SummaryScope) -> Result<ChatTurn> {
        let since_ms = self.resolve_since_ms(now_ms, scope)?;
        let rolling = self
            .memory
            .latest_summary()?
            .map(|s| (s.summary, s.last_event_id))
            .unwrap_or_else(|| (String::new(), 0));

        let missions = self.memory.recent_missions(10)?;
        let directives = self.memory.directives_in_window(since_ms)?;
        let costs_usd = self.memory.costs_in_window(since_ms)?;

        let frozen = CostGate::new(self.memory, self.config.daily_cap_usd).is_frozen(now_ms)?;
        let stale_event_count = self.memory.events_since(rolling.1)?.len();
        let is_stale = stale_event_count >= SUMMARY_STALE_THRESHOLD;

        let cached = format_cached_summary(scope, &rolling.0, &missions, &directives, costs_usd);
        let assistant_text = if frozen {
            format!("{cached}\n\n_(modo congelado: cost cap diario alcanzado)_")
        } else if !is_stale {
            cached
        } else {
            // Cache-miss: invoke LLM. Compose prompt with scoped data + last
            // user messages for language detection.
            let missions_text = render_missions(&missions);
            let directives_text = render_directives(&directives);
            let last_user_msgs = self.last_user_messages(3)?;
            let (sys, user) = summary_prompt(
                scope,
                &rolling.0,
                &missions_text,
                &directives_text,
                costs_usd,
                &last_user_msgs,
            );
            let resp = self.llm.complete(&sys, &user).await?;
            // `/summary` must never propose. Extract & discard any directive
            // block; keep only the visible markdown.
            let (visible, _discarded) = extract_directive(&resp.text);
            visible
        };

        self.memory
            .append_chat(now_ms + 1, "assistant", &assistant_text)?;
        Ok(ChatTurn {
            assistant_text,
            proposed_directive: None,
            safety_block_reason: None,
        })
    }

    fn resolve_since_ms(&self, now_ms: i64, scope: SummaryScope) -> Result<i64> {
        Ok(match scope {
            SummaryScope::Today => now_ms - SUMMARY_TODAY_WINDOW_MS,
            // Session: FamiliarConfig has no session_id today (escalation flag
            // in the plan). Fallback to Today window — explicit per-plan.
            SummaryScope::Session => now_ms - SUMMARY_TODAY_WINDOW_MS,
            SummaryScope::Mission => {
                // Most recent mission's started_ms; if none, fall back to Today.
                self.memory
                    .recent_missions(1)?
                    .first()
                    .map(|m| m.started_ms)
                    .unwrap_or(now_ms - SUMMARY_TODAY_WINDOW_MS)
            }
        })
    }

    fn last_user_messages(&self, n: usize) -> Result<String> {
        let hist = self.memory.chat_history(40)?;
        let users: Vec<_> = hist
            .iter()
            .filter(|c| c.role == "user")
            .rev()
            .take(n)
            .map(|c| c.content.clone())
            .collect();
        let mut ordered = users;
        ordered.reverse();
        Ok(ordered.join("\n"))
    }
}

fn render_missions(ms: &[MissionRow]) -> String {
    ms.iter()
        .map(|m| format!("- {} ({}) — {}", m.mission_id, m.objective, m.digest))
        .collect::<Vec<_>>()
        .join("\n")
}

fn render_directives(ds: &[DirectiveRow]) -> String {
    ds.iter()
        .map(|d| {
            format!(
                "- [{}] {} :: {} ({})",
                d.state, d.kind, d.payload, d.rationale
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Pure, deterministic markdown — used for cache-hit and frozen-mode replies.
pub fn format_cached_summary(
    scope: SummaryScope,
    rolling_summary: &str,
    missions: &[MissionRow],
    directives: &[DirectiveRow],
    costs_usd: f64,
) -> String {
    let scope_label = match scope {
        SummaryScope::Session => "Current session",
        SummaryScope::Mission => "Active mission",
        SummaryScope::Today => "Last 24h",
    };
    let mut out = format!("# Summary — {scope_label}\n\n");

    if !directives.is_empty() {
        out.push_str("## Autonomous decisions\n");
        for d in directives {
            out.push_str(&format!(
                "- [{}] **{}** — {} _({})_\n",
                d.state, d.kind, d.payload, d.rationale
            ));
        }
        out.push('\n');
    }

    out.push_str(&format!(
        "## Costs\n${costs_usd:.4} USD in this window.\n\n"
    ));

    if !missions.is_empty() {
        out.push_str("## Missions\n");
        for m in missions {
            let status = if m.finished_ms.is_some() {
                "closed"
            } else {
                "open"
            };
            let digest = if m.digest.is_empty() {
                "—"
            } else {
                &m.digest
            };
            out.push_str(&format!(
                "- `{}` ({}) [{}] — {}\n",
                m.mission_id, m.objective, status, digest
            ));
        }
        out.push('\n');
    }

    if !rolling_summary.is_empty() {
        out.push_str("## Recent context\n");
        out.push_str(rolling_summary);
        out.push_str("\n");
    }

    out.trim_end().to_string()
}

/// Scope for the `/summary` slash command (spec 3.19).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SummaryScope {
    /// Current session — caller resolves the actual `since_ms`.
    Session,
    /// Active mission (most recent open mission).
    Mission,
    /// Rolling 24h window.
    Today,
}

/// Parse a `/summary` (or `/resumen`) slash command. Returns `None` for any
/// other input — including unknown scopes — so the caller falls back to the
/// normal chat flow and lets the LLM nudge the user.
///
/// Accepted forms (whitespace-tolerant):
/// - `/summary` | `/resumen`              → `Session`
/// - `/summary mission` | `/resumen mission` → `Mission`
/// - `/summary today`   | `/resumen today`   → `Today`
pub fn parse_slash(input: &str) -> Option<SummaryScope> {
    let trimmed = input.trim();
    let mut parts = trimmed.split_whitespace();
    let cmd = parts.next()?;
    if cmd != "/summary" && cmd != "/resumen" {
        return None;
    }
    let scope = match parts.next() {
        None => SummaryScope::Session,
        Some("mission") => SummaryScope::Mission,
        Some("today") => SummaryScope::Today,
        Some(_) => return None,
    };
    if parts.next().is_some() {
        // Extra tokens → reject (don't silently accept `/summary today extra`).
        return None;
    }
    Some(scope)
}

const OPEN_MARKER: &str = "<<DIRECTIVE>>";
const CLOSE_MARKER: &str = "<</DIRECTIVE>>";

fn strip_residual_markers(s: &str) -> String {
    s.replace(OPEN_MARKER, "")
        .replace(CLOSE_MARKER, "")
        .trim()
        .to_string()
}

fn extract_directive(text: &str) -> (String, Option<DirectivePayload>) {
    // Find first opening marker, then first closing marker after it.
    if let Some(start) = text.find(OPEN_MARKER) {
        let after_open = start + OPEN_MARKER.len();
        if let Some(rel_end) = text[after_open..].find(CLOSE_MARKER) {
            let end = after_open + rel_end;
            let json_part = &text[after_open..end];
            let close_end = end + CLOSE_MARKER.len();
            let visible_raw = format!("{}{}", &text[..start], &text[close_end..]);
            let visible = strip_residual_markers(&visible_raw);
            if let Ok(p) = serde_json::from_str::<DirectivePayload>(json_part.trim()) {
                return (visible, Some(p));
            }
            // Malformed JSON inside an otherwise well-formed block: still
            // strip markers from the visible text; do not return raw text.
            return (visible, None);
        }
    }
    // No matched pair: strip any stray markers from visible text.
    (strip_residual_markers(text), None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::directive::DefaultSafety;
    use crate::summarizer::LlmResponse;
    use async_trait::async_trait;
    use std::sync::Mutex;

    struct CannedLlm(Mutex<Vec<String>>);
    #[async_trait]
    impl Llm for CannedLlm {
        async fn complete(&self, _: &str, _: &str) -> Result<LlmResponse> {
            let text = self.0.lock().unwrap().remove(0);
            Ok(LlmResponse {
                text,
                tokens_in: 1,
                tokens_out: 1,
                cost_usd: 0.0,
            })
        }
    }

    #[tokio::test]
    async fn plain_reply_records_history() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec!["all good".into()]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent {
            memory: &m,
            llm: &llm,
            safety: &DefaultSafety,
            config: &cfg,
        };
        let turn = agent.turn(1000, "status?").await.unwrap();
        assert_eq!(turn.assistant_text, "all good");
        assert!(turn.proposed_directive.is_none());
        assert_eq!(m.chat_history(10).unwrap().len(), 2);
    }

    #[tokio::test]
    async fn directive_extracted_and_logged() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec![
            "Sure, here's my proposal.\n<<DIRECTIVE>>{\"kind\":\"stop\",\"payload\":\"halt deploy\",\"rationale\":\"prod risk\"}<</DIRECTIVE>>".into()
        ]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent {
            memory: &m,
            llm: &llm,
            safety: &DefaultSafety,
            config: &cfg,
        };
        let turn = agent.turn(1000, "stop?").await.unwrap();
        assert!(turn.proposed_directive.is_some());
        assert!(turn.assistant_text.contains("Sure"));
        assert!(!turn.assistant_text.contains("DIRECTIVE"));
    }

    #[test]
    fn extract_two_blocks_only_first_parsed_second_stripped() {
        let text = "intro\n<<DIRECTIVE>>{\"kind\":\"stop\",\"payload\":\"a\",\"rationale\":\"b\"}<</DIRECTIVE>>\nmiddle\n<<DIRECTIVE>>not json<</DIRECTIVE>>\ntail";
        let (visible, parsed) = extract_directive(text);
        assert!(parsed.is_some(), "first block should parse");
        assert!(!visible.contains("<<DIRECTIVE>>"));
        assert!(!visible.contains("<</DIRECTIVE>>"));
        assert!(visible.contains("intro"));
        assert!(visible.contains("middle"));
        assert!(visible.contains("tail"));
    }

    #[test]
    fn extract_unmatched_open_marker_is_stripped() {
        let text = "hello <<DIRECTIVE>> oops";
        let (visible, parsed) = extract_directive(text);
        assert!(parsed.is_none());
        assert!(!visible.contains("<<DIRECTIVE>>"));
        assert!(visible.contains("hello"));
    }

    #[test]
    fn extract_unmatched_close_marker_is_stripped() {
        let text = "hello <</DIRECTIVE>> oops";
        let (visible, parsed) = extract_directive(text);
        assert!(parsed.is_none());
        assert!(!visible.contains("<</DIRECTIVE>>"));
        assert!(visible.contains("hello"));
    }

    #[test]
    fn extract_malformed_json_strips_markers_returns_none() {
        let text = "pre\n<<DIRECTIVE>>{not valid json}<</DIRECTIVE>>\npost";
        let (visible, parsed) = extract_directive(text);
        assert!(parsed.is_none());
        assert!(!visible.contains("DIRECTIVE"));
        assert!(visible.contains("pre"));
        assert!(visible.contains("post"));
    }

    // ---- /summary slash parser (spec 3.19, Task 2) ----

    #[test]
    fn parse_slash_summary_no_scope_is_session() {
        assert_eq!(parse_slash("/summary"), Some(SummaryScope::Session));
        assert_eq!(parse_slash("/resumen"), Some(SummaryScope::Session));
    }

    #[test]
    fn parse_slash_known_scopes() {
        assert_eq!(parse_slash("/summary mission"), Some(SummaryScope::Mission));
        assert_eq!(parse_slash("/summary today"), Some(SummaryScope::Today));
        assert_eq!(parse_slash("/resumen mission"), Some(SummaryScope::Mission));
        assert_eq!(parse_slash("/resumen today"), Some(SummaryScope::Today));
    }

    #[test]
    fn parse_slash_whitespace_tolerant() {
        assert_eq!(
            parse_slash("  /summary  today  "),
            Some(SummaryScope::Today)
        );
        assert_eq!(
            parse_slash("\t/summary\tmission\n"),
            Some(SummaryScope::Mission)
        );
    }

    #[test]
    fn parse_slash_unknown_scope_is_none() {
        assert_eq!(parse_slash("/summary tomorrow"), None);
        assert_eq!(parse_slash("/summary 24h"), None);
    }

    #[test]
    fn parse_slash_extra_tokens_rejected() {
        assert_eq!(parse_slash("/summary today extra"), None);
        assert_eq!(parse_slash("/summary mission please"), None);
    }

    #[test]
    fn parse_slash_not_starting_with_slash() {
        assert_eq!(parse_slash("hola /summary"), None);
        assert_eq!(parse_slash("summary"), None);
        assert_eq!(parse_slash(""), None);
    }

    #[test]
    fn parse_slash_loose_prefix_rejected() {
        assert_eq!(parse_slash("/summarize"), None);
        assert_eq!(parse_slash("/sum"), None);
        assert_eq!(parse_slash("/resumencito"), None);
    }

    #[tokio::test]
    async fn unsafe_directive_recorded_as_blocked() {
        let m = Memory::open_in_memory().unwrap();
        let llm = CannedLlm(Mutex::new(vec![
            "<<DIRECTIVE>>{\"kind\":\"custom\",\"payload\":\"rm -rf /\",\"rationale\":\"x\"}<</DIRECTIVE>>".into()
        ]));
        let cfg = FamiliarConfig::default();
        let agent = ChatAgent {
            memory: &m,
            llm: &llm,
            safety: &DefaultSafety,
            config: &cfg,
        };
        let turn = agent.turn(1000, "x").await.unwrap();
        assert!(turn.proposed_directive.is_none());
        assert!(turn.safety_block_reason.is_some());
    }
}
