//! Idle-waiting detector: combines PTY quiescence, foreground process
//! name, and vt100 alternate-screen state to decide whether a CLI agent
//! in this session is waiting for user input.
//!
//! Pure logic — no I/O, no tasks. The pump task in `lib.rs` ticks
//! `IdleDetector::evaluate` once per second.

use std::time::{Duration, Instant};

use regex::Regex;

pub const KNOWN_AGENTS: &[&str] = &[
    "claude",
    "codex",
    "opencode",
    "copilot",
    "gh-copilot",
    "aider",
    "gemini",
    "pi",
    "hermes",
];

/// Agents that render inline (no alternate screen). For these we skip the
/// alt-screen gate but require a prompt-text regex match to avoid firing
/// while the agent is mid-thought.
pub const INLINE_AGENTS: &[&str] = &["claude", "codex", "pi", "hermes"];

const QUIET_THRESHOLD: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, PartialEq)]
pub enum Decision {
    Idle {
        agent: String,
        prompt_text: Option<String>,
        quiet_ms: u64,
    },
    Resumed,
    NoChange,
}

pub struct IdleDetector {
    last_output_at: Instant,
    notified: bool,
    prompt_regexes: Vec<Regex>,
}

impl IdleDetector {
    pub fn new() -> Self {
        let patterns = [
            r"(?i)do you want to",
            r"\(y/n\)|\[y/N\]|\[Y/n\]",
            r"(?i)press \w+ to (continue|confirm|proceed)",
            r"^❯\s+\d+\.",
            r"(?i)waiting for|awaiting your",
            r"(?i)choose an option",
            // Claude Code inline prompt: "> " at start of an otherwise empty
            // input line, or its footer hints.
            r"^\s*[›>]\s*$",
            r"commands\s*·\s*\?\s*help",
            r"(?i)bypass permissions on",
            r"(?i)for agents",
            r"(?i)shift\+tab to cycle",
        ];
        Self {
            last_output_at: Instant::now(),
            notified: false,
            prompt_regexes: patterns
                .iter()
                .map(|p| Regex::new(p).expect("invalid hardcoded regex pattern"))
                .collect(),
        }
    }

    /// Call on every output chunk. Resets quiescence timer; if previously
    /// notified, returns `Decision::Resumed` exactly once.
    pub fn on_output(&mut self, now: Instant) -> Decision {
        self.last_output_at = now;
        if self.notified {
            self.notified = false;
            Decision::Resumed
        } else {
            Decision::NoChange
        }
    }

    /// Tick once per second. Returns `Decision::Idle` exactly once when
    /// all signals align; subsequent ticks return `NoChange` until output
    /// resumes.
    pub fn evaluate(
        &mut self,
        now: Instant,
        fg_proc: Option<&str>,
        in_alt_screen: bool,
        screen_text: &str,
    ) -> Decision {
        if self.notified {
            return Decision::NoChange;
        }
        let quiet = now.saturating_duration_since(self.last_output_at);
        if quiet < QUIET_THRESHOLD {
            return Decision::NoChange;
        }
        let Some(name) = fg_proc else {
            return Decision::NoChange;
        };
        if !KNOWN_AGENTS.contains(&name) {
            return Decision::NoChange;
        }
        let inline = INLINE_AGENTS.contains(&name);
        if !in_alt_screen && !inline {
            return Decision::NoChange;
        }

        let prompt_text = self.match_prompt(screen_text);
        // Inline agents have no alt-screen boundary; require a prompt
        // match to avoid firing while the agent is still composing output.
        if inline && !in_alt_screen && prompt_text.is_none() {
            return Decision::NoChange;
        }
        self.notified = true;
        Decision::Idle {
            agent: name.to_string(),
            prompt_text,
            quiet_ms: quiet.as_millis() as u64,
        }
    }

    fn match_prompt(&self, screen_text: &str) -> Option<String> {
        // Scan the whole visible screen — inline agents (Claude Code) put
        // their prompt + status hints anywhere on the grid, not just at
        // the bottom.
        for line in screen_text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            for re in &self.prompt_regexes {
                if re.is_match(line) {
                    return Some(trimmed.to_string());
                }
            }
        }
        None
    }
}

impl Default for IdleDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t0() -> Instant {
        Instant::now()
    }

    #[test]
    fn no_signal_when_quiet_under_threshold() {
        let mut d = IdleDetector::new();
        let now = t0() + Duration::from_secs(1);
        assert_eq!(
            d.evaluate(now, Some("claude"), true, ""),
            Decision::NoChange
        );
    }

    #[test]
    fn fires_once_when_all_signals_align() {
        let mut d = IdleDetector::new();
        let now = t0() + Duration::from_secs(5);
        let dec = d.evaluate(now, Some("claude"), true, "Do you want to proceed? (y/N)");
        match dec {
            Decision::Idle {
                agent,
                prompt_text,
                quiet_ms,
            } => {
                assert_eq!(agent, "claude");
                assert!(prompt_text.unwrap().contains("Do you want"));
                assert!(quiet_ms >= 3000);
            }
            other => panic!("expected Idle, got {other:?}"),
        }
        let now2 = now + Duration::from_secs(1);
        assert_eq!(
            d.evaluate(now2, Some("claude"), true, ""),
            Decision::NoChange
        );
    }

    #[test]
    fn skips_unknown_agents() {
        let mut d = IdleDetector::new();
        let now = t0() + Duration::from_secs(5);
        assert_eq!(
            d.evaluate(now, Some("zsh"), true, "(y/N)"),
            Decision::NoChange
        );
    }

    #[test]
    fn skips_when_not_in_alt_screen() {
        let mut d = IdleDetector::new();
        let now = t0() + Duration::from_secs(5);
        assert_eq!(
            d.evaluate(now, Some("claude"), false, "(y/N)"),
            Decision::NoChange
        );
    }

    #[test]
    fn resumes_on_output_after_idle() {
        let mut d = IdleDetector::new();
        let t = t0();
        let _ = d.evaluate(t + Duration::from_secs(5), Some("claude"), true, "(y/N)");
        let dec = d.on_output(t + Duration::from_secs(6));
        assert_eq!(dec, Decision::Resumed);
        let dec2 = d.on_output(t + Duration::from_secs(7));
        assert_eq!(dec2, Decision::NoChange);
    }

    #[test]
    fn idle_fires_without_prompt_text_when_no_regex_matches() {
        let mut d = IdleDetector::new();
        let now = t0() + Duration::from_secs(5);
        let dec = d.evaluate(now, Some("claude"), true, "some unrelated screen content");
        match dec {
            Decision::Idle { prompt_text, .. } => assert!(prompt_text.is_none()),
            other => panic!("expected Idle, got {other:?}"),
        }
    }
}
