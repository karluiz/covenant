//! Per-session world model for the super-agent.
//!
//! Subscribes (via the karl-session broadcast bus) to a single session's
//! events and accumulates a bounded snapshot: current cwd plus the last
//! N completed blocks. M3.2b ships the data structure and the
//! agent-prompt rendering; M3.3 will add LLM-generated rolling summaries
//! on top so we don't have to send raw block output every call.

use std::collections::VecDeque;
use std::path::PathBuf;

use karl_session::SessionEvent;

const MAX_BLOCKS: usize = 16;
const MAX_OUTPUT_CHARS: usize = 800;
const MAX_COMMAND_CHARS: usize = 200;

#[derive(Debug, Clone)]
pub struct BlockSnapshot {
    pub command: String,
    pub cwd: PathBuf,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub output_text: String,
}

#[derive(Debug, Default)]
pub struct SessionWorldModel {
    pub cwd: PathBuf,
    pub blocks: VecDeque<BlockSnapshot>,
    /// Rolling LLM-generated summary of session activity. Populated by
    /// the summarizer task (M3.3) after each BlockFinished, debounced.
    /// `None` means "no summary yet" — render falls back to dumping
    /// blocks raw so the agent still has context.
    pub summary: Option<String>,
}

impl SessionWorldModel {
    /// Apply a single SessionEvent. Only `CwdChanged` and `BlockFinished`
    /// mutate state today; the rest are informational.
    pub fn apply(&mut self, event: SessionEvent) {
        match event {
            SessionEvent::CwdChanged { cwd, .. } => {
                self.cwd = cwd;
            }
            SessionEvent::BlockFinished {
                command,
                cwd,
                exit_code,
                duration_ms,
                output_text,
                ..
            } => {
                self.blocks.push_back(BlockSnapshot {
                    command: truncate(&command, MAX_COMMAND_CHARS),
                    cwd,
                    exit_code,
                    duration_ms,
                    output_text: truncate(&output_text, MAX_OUTPUT_CHARS),
                });
                while self.blocks.len() > MAX_BLOCKS {
                    self.blocks.pop_front();
                }
            }
            _ => {}
        }
    }

    /// Render the model + the user's question into a single string the
    /// agent receives as the user message.
    ///
    /// When a summary exists, send it instead of the full block dump
    /// (saves a lot of tokens on chatty sessions) and append only the
    /// last few blocks raw for recency. Without a summary, fall back to
    /// the full block list so the agent always has *some* context.
    pub fn render_user_message(&self, question: &str) -> String {
        let mut out = String::with_capacity(2048);

        out.push_str("# Active session\n");
        if !self.cwd.as_os_str().is_empty() {
            out.push_str("cwd: ");
            out.push_str(&self.cwd.display().to_string());
            out.push('\n');
        }

        match (&self.summary, self.blocks.is_empty()) {
            (Some(summary), _) => {
                out.push_str("\n# Session summary (rolling, LLM-generated)\n");
                out.push_str(summary.trim());
                out.push('\n');

                let recent: Vec<&BlockSnapshot> =
                    self.blocks.iter().rev().take(4).collect();
                if !recent.is_empty() {
                    out.push_str("\n# Most recent blocks (newest last)\n");
                    for b in recent.into_iter().rev() {
                        render_block_brief(&mut out, b);
                    }
                }
            }
            (None, true) => {
                out.push_str("\n(no commands have completed in this session yet)\n");
            }
            (None, false) => {
                out.push_str("\n# Recent blocks (oldest first)\n");
                for (i, b) in self.blocks.iter().enumerate() {
                    render_block_full(&mut out, i + 1, b);
                }
            }
        }

        out.push_str("\n# User question\n");
        out.push_str(question);
        out.push('\n');

        out
    }
}

fn render_block_full(out: &mut String, idx: usize, b: &BlockSnapshot) {
    let exit = b
        .exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".to_string());
    out.push_str(&format!(
        "\n--- block {idx} ---\n\
         $ {cmd}\n\
         cwd:   {cwd}\n\
         exit:  {exit}    duration: {dur}ms\n",
        cmd = b.command,
        cwd = b.cwd.display(),
        dur = b.duration_ms,
    ));
    if !b.output_text.trim().is_empty() {
        out.push_str("output:\n");
        out.push_str(&b.output_text);
        if !b.output_text.ends_with('\n') {
            out.push('\n');
        }
    }
}

fn render_block_brief(out: &mut String, b: &BlockSnapshot) {
    let exit = b
        .exit_code
        .map(|c| c.to_string())
        .unwrap_or_else(|| "?".to_string());
    out.push_str(&format!(
        "$ {cmd}    [exit {exit}, {dur}ms]\n",
        cmd = b.command,
        dur = b.duration_ms,
    ));
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…[truncated, {orig} chars]", orig = s.chars().count())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::SessionId;

    fn finished(cmd: &str, exit: i32, output: &str) -> SessionEvent {
        SessionEvent::BlockFinished {
            session: SessionId::new(),
            block: karl_blocks::BlockId::new(),
            command: cmd.to_string(),
            cwd: PathBuf::from("/tmp"),
            exit_code: Some(exit),
            duration_ms: 12,
            output_text: output.to_string(),
        }
    }

    #[test]
    fn block_finished_appends_snapshot() {
        let mut w = SessionWorldModel::default();
        w.apply(finished("ls", 0, "a\nb\n"));
        assert_eq!(w.blocks.len(), 1);
        assert_eq!(w.blocks[0].command, "ls");
        assert_eq!(w.blocks[0].exit_code, Some(0));
    }

    #[test]
    fn block_history_caps_at_max() {
        let mut w = SessionWorldModel::default();
        for i in 0..50 {
            w.apply(finished(&format!("cmd{i}"), 0, ""));
        }
        assert_eq!(w.blocks.len(), MAX_BLOCKS);
        // Oldest dropped: first kept should be cmd34 (50-16).
        assert_eq!(w.blocks[0].command, "cmd34");
    }

    #[test]
    fn cwd_changed_updates_cwd() {
        let mut w = SessionWorldModel::default();
        w.apply(SessionEvent::CwdChanged {
            session: SessionId::new(),
            cwd: PathBuf::from("/Users/karl"),
        });
        assert_eq!(w.cwd, PathBuf::from("/Users/karl"));
    }

    #[test]
    fn render_user_message_includes_blocks_and_question() {
        let mut w = SessionWorldModel::default();
        w.apply(SessionEvent::CwdChanged {
            session: SessionId::new(),
            cwd: PathBuf::from("/tmp"),
        });
        w.apply(finished("cargo build", 1, "error: foo\n"));

        let msg = w.render_user_message("why did it fail?");
        assert!(msg.contains("cwd: /tmp"));
        assert!(msg.contains("$ cargo build"));
        assert!(msg.contains("exit:  1"));
        assert!(msg.contains("error: foo"));
        assert!(msg.contains("# User question"));
        assert!(msg.contains("why did it fail?"));
    }

    #[test]
    fn render_handles_empty_session() {
        let w = SessionWorldModel::default();
        let msg = w.render_user_message("hi");
        assert!(msg.contains("(no commands"));
        assert!(msg.contains("hi"));
    }

    #[test]
    fn render_uses_summary_when_present() {
        let mut w = SessionWorldModel::default();
        w.summary = Some("user is debugging cargo build failures".to_string());
        w.apply(finished("cargo build", 1, "error[E0432]\n"));
        w.apply(finished("cargo check", 0, ""));

        let msg = w.render_user_message("status?");
        assert!(msg.contains("# Session summary"));
        assert!(msg.contains("debugging cargo build failures"));
        // Recent blocks in brief form, no full output dump.
        assert!(msg.contains("$ cargo build"));
        assert!(!msg.contains("error[E0432]"));
        assert!(msg.contains("status?"));
    }

    #[test]
    fn long_output_is_truncated() {
        let big = "x".repeat(2000);
        let mut w = SessionWorldModel::default();
        w.apply(finished("noisy", 0, &big));
        assert!(w.blocks[0].output_text.contains("truncated"));
        assert!(w.blocks[0].output_text.chars().count() < big.chars().count());
    }
}
