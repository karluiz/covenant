use std::sync::OnceLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ExecutorPhase {
    Idle,
    Thinking,
    Running { cmd: String },
    Writing { file: String },
    Reading { file: String },
    Waiting { reason: String },
    Done { summary: Option<String> },
}

static RE_CLAUDE_WRITE: OnceLock<Regex> = OnceLock::new();
static RE_CODEX_WRITE: OnceLock<Regex> = OnceLock::new();
static RE_READ_TOOL: OnceLock<Regex> = OnceLock::new();
static RE_READ_HEADER: OnceLock<Regex> = OnceLock::new();
static RE_RUNNING_TOOL: OnceLock<Regex> = OnceLock::new();
static RE_RUNNING_HEADER: OnceLock<Regex> = OnceLock::new();
static RE_THINKING: OnceLock<Regex> = OnceLock::new();
static RE_PI_THINKING_STATUS: OnceLock<Regex> = OnceLock::new();
static RE_WAITING: OnceLock<Regex> = OnceLock::new();

/// Cap on target string length so a missing newline (Claude Code v2.1
/// redraws with cursor positioning, no `\n`) can't smear an entire screen
/// of status text into a single Reading/Writing/Running target.
const TARGET_MAX: usize = 60;

fn clamp_target(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= TARGET_MAX {
        t.to_string()
    } else {
        let cut: String = t.chars().take(TARGET_MAX).collect();
        format!("{cut}…")
    }
}

fn re_claude_write() -> &'static Regex {
    RE_CLAUDE_WRITE.get_or_init(|| {
        Regex::new(r"⏺\s*(?:Update|Write|Create|Edit|MultiEdit|NotebookEdit)\(([^)]+)\)").unwrap()
    })
}
fn re_codex_write() -> &'static Regex {
    RE_CODEX_WRITE.get_or_init(|| Regex::new(r"^(?:Editing|Writing|Creating)\s+(\S+)").unwrap())
}
/// Tool-call form: `⏺ Read(path)` etc — argument is a real file.
fn re_read_tool() -> &'static Regex {
    RE_READ_TOOL.get_or_init(|| Regex::new(r"⏺\s*(?:Read|Grep|Glob|LS)\(([^)]+)\)").unwrap())
}
/// Status-summary form: `Reading file`, `Listed 2 directories`, `Searching`,
/// `Read 1 file`. No useful file to capture — we just signal the phase.
fn re_read_header() -> &'static Regex {
    RE_READ_HEADER.get_or_init(|| {
        Regex::new(
            r"^(?:Reading|Listing\s+\d+\s+director|Listed\s+\d+\s+director|Read\s+\d+\s+file|Searching)",
        )
        .unwrap()
    })
}
fn re_running_tool() -> &'static Regex {
    RE_RUNNING_TOOL.get_or_init(|| {
        Regex::new(r"⏺\s*(?:Bash|Task|Agent|Explore|WebFetch|WebSearch)\(([^)]+)\)").unwrap()
    })
}
fn re_running_header() -> &'static Regex {
    RE_RUNNING_HEADER.get_or_init(|| Regex::new(r"^Running(?:\.{2,}|\s+\d+\s+commands?)").unwrap())
}
/// Claude Code's processing-status spinner (ACTIVE form only).
///
/// Present-participle gerund + ellipsis is the live indicator:
///
///   `Hyperspacing…`              — just-started
///   `Imagining… (3s · ↓ 73 tokens · thinking with low effort)`
///   `Drizzling… (42s · ↓ 1.8k tokens · thinking some more)`
///
/// Past-tense recap (`Cooked for 7s` / `Worked for 10s`) means CC is
/// done with the turn — that's matched by `re_done` and routed to Done,
/// not Thinking.
fn re_thinking() -> &'static Regex {
    // Claude Code v2.1 status verbs can be hyphenated, e.g.
    // `Fiddle-faddling… (1m 42s · ↑ 1.8k tokens · thought for 1s)`.
    // Some CLIs use ASCII `...` instead of the single ellipsis glyph.
    RE_THINKING.get_or_init(|| Regex::new(r"\b[A-Z][A-Za-z-]+ing(?:…|\.{3})").unwrap())
}
fn re_pi_thinking_status() -> &'static Regex {
    RE_PI_THINKING_STATUS.get_or_init(|| {
        // Pi's TUI renders live status lines like:
        //   `∶ Transcoding reality...`
        //   `∴ Waiting for heat death of universe...`
        // It is not structured JSON when Pi is run as a normal PTY CLI, so
        // treat this spinner as the Thinking phase. Keep the colon/spinner
        // prefix requirement to avoid matching arbitrary assistant prose.
        Regex::new(r"(?:^|[\r\n])\s*[:∶：∴]\s*[A-Z][A-Za-z-]+ing\b[^\r\n]{0,80}(?:…|\.{3})")
            .unwrap()
    })
}
static RE_DONE: OnceLock<Regex> = OnceLock::new();
/// Claude Code's "turn finished" recap: a past-tense verb + `for Ns`.
/// Examples: `* Worked for 10s`, `* Cooked for 7s`, `* Crunched for 13s`.
fn re_done() -> &'static Regex {
    RE_DONE.get_or_init(|| Regex::new(r"\b[A-Z][a-zA-Z]+ed\s+for\s+\d+s\b").unwrap())
}
fn re_waiting() -> &'static Regex {
    RE_WAITING.get_or_init(|| {
        Regex::new(
            r"(?i)(continue\?\s*\[y/n\]|approve this edit\?|\(y/N\)|press enter to continue)",
        )
        .unwrap()
    })
}

fn strip_ansi(s: &str) -> String {
    String::from_utf8_lossy(&strip_ansi_escapes::strip(s.as_bytes())).into_owned()
}

pub struct ExecutorPhaseDetector {
    phase: ExecutorPhase,
}

impl ExecutorPhaseDetector {
    pub fn new() -> Self {
        Self {
            phase: ExecutorPhase::Idle,
        }
    }

    pub fn phase(&self) -> &ExecutorPhase {
        &self.phase
    }

    /// Feed a PTY byte chunk. Returns true if the phase changed.
    pub fn feed(&mut self, bytes: &[u8]) -> bool {
        if bytes.is_empty() {
            return false;
        }
        let next = self.detect(bytes);
        if next != self.phase {
            self.phase = next;
            true
        } else {
            false
        }
    }

    fn detect(&self, bytes: &[u8]) -> ExecutorPhase {
        if bytes.windows(7).any(|w| w == b"\x1b]133;D") {
            return ExecutorPhase::Done { summary: None };
        }

        let text = String::from_utf8_lossy(bytes);
        for line in text.lines() {
            let stripped = strip_ansi(line);
            let trimmed = stripped.trim();

            if let Some(caps) = re_claude_write()
                .captures(trimmed)
                .or_else(|| re_codex_write().captures(trimmed))
            {
                let file = clamp_target(caps.get(1).unwrap().as_str());
                return ExecutorPhase::Writing { file };
            }
            if let Some(caps) = re_read_tool().captures(trimmed) {
                let file = clamp_target(caps.get(1).unwrap().as_str());
                return ExecutorPhase::Reading { file };
            }
            if let Some(m) = re_read_header().find(trimmed) {
                // Header form ("Read N file", "Listed N…", "Searching"): show
                // just the matched header text — never capture trailing
                // status redraws past the natural label boundary.
                let label = clamp_target(m.as_str());
                return ExecutorPhase::Reading { file: label };
            }
            if let Some(caps) = re_running_tool().captures(trimmed) {
                let cmd = clamp_target(caps.get(1).unwrap().as_str());
                return ExecutorPhase::Running { cmd };
            }
            if re_running_header().is_match(trimmed) {
                return ExecutorPhase::Running {
                    cmd: "commands".to_string(),
                };
            }
            if re_waiting().is_match(trimmed) {
                return ExecutorPhase::Waiting {
                    reason: clamp_target(trimmed),
                };
            }
            if re_pi_thinking_status().is_match(trimmed) {
                return ExecutorPhase::Thinking;
            }
            if let Some(cmd) = trimmed.strip_prefix("$ ") {
                let cmd = cmd.trim();
                if !cmd.is_empty() {
                    return ExecutorPhase::Running {
                        cmd: clamp_target(cmd),
                    };
                }
            }
        }

        // Whitelist-format scan over the raw (post-ANSI) chunk. CC redraws
        // with cursor positioning so a chunk often has no newlines — scan
        // the entire text, not per line. Done wins over Thinking when both
        // appear in the same chunk (final recap supersedes spinner).
        let raw = strip_ansi(&text);
        if re_done().is_match(&raw) {
            return ExecutorPhase::Done { summary: None };
        }
        if re_thinking().is_match(&raw) || re_pi_thinking_status().is_match(&raw) {
            return ExecutorPhase::Thinking;
        }

        // No tool-call, no processing indicator → keep current phase.
        // (Don't fall back to Thinking on plain output any more — that
        // was the source of the "stuck on Thinking forever" bug.)
        self.phase.clone()
    }
}

impl Default for ExecutorPhaseDetector {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_until_first_byte() {
        let d = ExecutorPhaseDetector::new();
        assert_eq!(d.phase(), &ExecutorPhase::Idle);
    }

    #[test]
    fn stays_idle_on_plain_output() {
        // Whitelist-only Thinking: bare banner output must NOT promote
        // the detector to Thinking — only an explicit Claude Code status
        // line (e.g. "Hyperspacing… (3s)") does.
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed(b"some agent banner\n");
        assert_eq!(d.phase(), &ExecutorPhase::Idle);
        assert!(!changed);
    }

    #[test]
    fn detects_thinking_from_claude_code_spinner() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed("✻ Hyperspacing… (3s · ↓ 73 tokens)\n".as_bytes());
        assert!(changed);
        assert_eq!(d.phase(), &ExecutorPhase::Thinking);
    }

    #[test]
    fn detects_hyphenated_claude_code_spinner() {
        let mut d = ExecutorPhaseDetector::new();
        let changed =
            d.feed("* Fiddle-faddling… (1m 42s · ↑ 1.8k tokens · thought for 1s)\n".as_bytes());
        assert!(changed);
        assert_eq!(d.phase(), &ExecutorPhase::Thinking);
    }

    #[test]
    fn detects_pi_cli_thinking_spinner() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed("∶ Transcoding reality...\n".as_bytes());
        assert!(changed);
        assert_eq!(d.phase(), &ExecutorPhase::Thinking);
    }

    #[test]
    fn detects_pi_cli_thinking_spinner_with_therefore_glyph() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed("∴ Waiting for heat death of universe...\n".as_bytes());
        assert!(changed);
        assert_eq!(d.phase(), &ExecutorPhase::Thinking);
    }

    #[test]
    fn detects_done_from_cooked_for_n_seconds() {
        // Past-tense `<Verb>ed for Ns` is CC's "turn finished" recap.
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed(b"* Cooked for 7s\n");
        assert!(changed);
        assert!(matches!(d.phase(), ExecutorPhase::Done { .. }));
    }

    #[test]
    fn detects_done_from_brewed_for_n_seconds() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed(b"* Brewed for 3s\n");
        assert!(changed);
        assert!(matches!(d.phase(), ExecutorPhase::Done { .. }));
    }

    #[test]
    fn done_supersedes_thinking_in_same_chunk() {
        // If a chunk happens to contain both an active spinner and a
        // past-tense recap, Done wins (the recap is later in the stream).
        let mut d = ExecutorPhaseDetector::new();
        d.feed("✻ Imagining… (3s)\n* Worked for 10s\n".as_bytes());
        assert!(matches!(d.phase(), ExecutorPhase::Done { .. }));
    }

    #[test]
    fn feed_returns_false_when_phase_unchanged() {
        let mut d = ExecutorPhaseDetector::new();
        d.feed(b"banner\n");
        let changed = d.feed(b"more output\n");
        assert!(!changed);
    }

    #[test]
    fn detects_running_from_shell_prompt() {
        let mut d = ExecutorPhaseDetector::new();
        d.feed(b"thinking...\n");
        let changed = d.feed(b"$ cargo build --release\n");
        assert!(changed);
        match d.phase() {
            ExecutorPhase::Running { cmd } => assert_eq!(cmd, "cargo build --release"),
            other => panic!("expected Running, got {other:?}"),
        }
    }

    #[test]
    fn detects_writing_claude_pattern() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed("⏺ Update(profile.rs)\n".as_bytes());
        assert!(changed);
        assert_eq!(
            d.phase(),
            &ExecutorPhase::Writing {
                file: "profile.rs".into()
            }
        );
    }

    #[test]
    fn detects_writing_codex_pattern() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed(b"Editing src/main.rs\n");
        assert!(changed);
        assert_eq!(
            d.phase(),
            &ExecutorPhase::Writing {
                file: "src/main.rs".into()
            }
        );
    }

    #[test]
    fn detects_reading() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed("⏺ Read(session.rs)\n".as_bytes());
        assert!(changed);
        assert_eq!(
            d.phase(),
            &ExecutorPhase::Reading {
                file: "session.rs".into()
            }
        );
    }

    #[test]
    fn detects_waiting_on_confirmation_prompt() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed(b"Continue? [y/N] ");
        assert!(changed);
        assert!(matches!(d.phase(), ExecutorPhase::Waiting { .. }));
    }

    #[test]
    fn done_via_osc133_marker() {
        let mut d = ExecutorPhaseDetector::new();
        d.feed(b"$ ls\n");
        let changed = d.feed(b"\x1b]133;D;0\x07");
        assert!(changed);
        assert!(matches!(d.phase(), ExecutorPhase::Done { .. }));
    }
}
