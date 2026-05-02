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
    /// agent receives as the user message. Plain text by design — we do
    /// not parse markdown server-side.
    pub fn render_user_message(&self, question: &str) -> String {
        let mut out = String::with_capacity(2048);

        out.push_str("# Active session\n");
        if !self.cwd.as_os_str().is_empty() {
            out.push_str("cwd: ");
            out.push_str(&self.cwd.display().to_string());
            out.push('\n');
        }

        if self.blocks.is_empty() {
            out.push_str("\n(no commands have completed in this session yet)\n");
        } else {
            out.push_str("\n# Recent blocks (oldest first)\n");
            for (i, b) in self.blocks.iter().enumerate() {
                let exit = b
                    .exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "?".to_string());
                out.push_str(&format!(
                    "\n--- block {idx} ---\n\
                     $ {cmd}\n\
                     cwd:   {cwd}\n\
                     exit:  {exit}    duration: {dur}ms\n",
                    idx = i + 1,
                    cmd = b.command,
                    cwd = b.cwd.display(),
                    exit = exit,
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
        }

        out.push_str("\n# User question\n");
        out.push_str(question);
        out.push('\n');

        out
    }
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
    fn long_output_is_truncated() {
        let big = "x".repeat(2000);
        let mut w = SessionWorldModel::default();
        w.apply(finished("noisy", 0, &big));
        assert!(w.blocks[0].output_text.contains("truncated"));
        assert!(w.blocks[0].output_text.chars().count() < big.chars().count());
    }
}
