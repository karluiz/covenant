use crate::agent::SummaryScope;
use crate::identity::{FamiliarConfig, Style};

pub fn system_prompt(cfg: &FamiliarConfig, rolling_summary: &str,
                     recent_missions: &str) -> String {
    let style_clause = match cfg.style {
        Style::Concise =>
            "Speak in short, direct sentences. No filler. Pack information densely.",
        Style::Formal =>
            "Speak with professional, measured prose. Avoid contractions.",
        Style::Conversational =>
            "Speak naturally, like a colleague chatting. Friendly but focused.",
        Style::Sarcastic =>
            "Speak with dry wit. Stay useful — sarcasm garnishes, never replaces, signal.",
    };

    format!(
"You are {name}, a Familiar — an AI companion bound to one operator in this user's terminal.
You observe everything that operator does and remember across sessions.

Your role:
- Discuss what the operator is doing with the coordinator (the user).
- Form opinions. You may disagree with the operator's choices.
- When the coordinator agrees on a course of action, propose a structured directive
  with the propose_directive tool — the coordinator approves it before it reaches the operator.

Style: {style_clause}

You have three layers of memory:
1. Rolling summary (recent operator activity, kept fresh).
2. Mission digests (past missions you can reference by date and objective).
3. Raw event log (only consulted when explicitly needed).

Current rolling summary:
---
{rolling_summary}
---

Recent missions (most recent first):
---
{recent_missions}
---

Rules:
- Never propose a directive that violates the safety blocklist (sudo, rm -rf, etc.).
  The system enforces this; if you try, the directive is auto-rejected and logged.
- When unsure what the operator is doing, say so — do not invent.
- When you cite past events, reference the mission or timestamp explicitly.
",
        name = cfg.name,
        style_clause = style_clause,
        rolling_summary = if rolling_summary.is_empty() { "(empty — operator has not run yet)" } else { rolling_summary },
        recent_missions = if recent_missions.is_empty() { "(none)" } else { recent_missions },
    )
}

/// Build the (system, user) prompt pair for the `/summary` slash command
/// (spec 3.19). The system prompt enforces: language follows the operator's
/// last messages, fixed section structure, plain markdown, never propose
/// directives. The user payload carries the scoped data.
pub fn summary_prompt(
    scope: SummaryScope,
    rolling_summary: &str,
    missions_text: &str,
    directives_text: &str,
    costs_usd: f64,
    last_user_msgs: &str,
) -> (String, String) {
    let scope_label = match scope {
        SummaryScope::Session => "current session",
        SummaryScope::Mission => "active mission",
        SummaryScope::Today   => "rolling 24h",
    };
    let system = format!(
"You are producing an executive summary of what the operator did, focused on \
autonomous decisions taken on behalf of the coordinator while they were AFK.

Language: detect the language of the coordinator's most recent messages and \
respond in that same language. Do not switch.

Output: plain GitHub-flavored markdown. No collapsible blocks, no HTML, no \
code fences around the whole reply. Use these section headers, in this exact \
order, omitting any section that has no data:

## Decisiones autónomas
## Costos
## Bloqueos resueltos
## Misiones
## Open items pendientes

Rules:
- Be specific. Cite mission ids and timestamps when available.
- Do NOT propose directives. This command never emits `<<DIRECTIVE>>` blocks.
- If you have to invent to fill a section, omit the section instead.
- Scope of this summary: {scope_label}.
");
    let user = format!(
"COORDINATOR'S RECENT MESSAGES (for language detection — do not summarize them):
---
{last_user_msgs}
---

ROLLING SUMMARY:
---
{rolling}
---

MISSIONS (recent, most-recent-first):
---
{missions}
---

DIRECTIVES IN WINDOW (chronological):
---
{directives}
---

COSTS IN WINDOW: ${costs:.4} USD
",
        rolling = if rolling_summary.is_empty() { "(empty)" } else { rolling_summary },
        missions = if missions_text.is_empty() { "(none)" } else { missions_text },
        directives = if directives_text.is_empty() { "(none)" } else { directives_text },
        costs = costs_usd,
    );
    (system, user)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn includes_name_and_style_hint() {
        let cfg = FamiliarConfig { name: "Marcus".into(),
                                    style: Style::Sarcastic, daily_cap_usd: 5.0 };
        let p = system_prompt(&cfg, "running tests", "");
        assert!(p.contains("Marcus"));
        assert!(p.contains("dry wit"));
        assert!(p.contains("running tests"));
    }

    #[test]
    fn empty_summary_has_placeholder() {
        let cfg = FamiliarConfig::default();
        let p = system_prompt(&cfg, "", "");
        assert!(p.contains("(empty"));
    }
}
