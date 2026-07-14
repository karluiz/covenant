//! In-memory world model for an ACP chat tab (claude/codex/copilot/pi).
//!
//! ACP tabs emit no OSC-133 blocks, so the PTY `SessionWorldModel` is
//! blind to them. This model accumulates the conversation mechanically
//! (no LLM): user prompts, streamed agent chunks flushed into whole
//! turns, and one-line tool-call records. A `session/load` replay flows
//! through the same feed points, so the model repopulates after an app
//! restart for free.
//!
//! ponytail: no rolling LLM summary — ACP turns are already prose; plug
//! the summarizer in later if the raw ring proves insufficient.

use std::collections::VecDeque;

const MAX_TURNS: usize = 12;
const MAX_TURN_CHARS: usize = 500;
const HEAD_CHARS: usize = 350;
const TAIL_CHARS: usize = 150;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AcpRole {
    User,
    Agent,
    Tool,
}

impl AcpRole {
    pub fn label(&self) -> &'static str {
        match self {
            AcpRole::User => "user",
            AcpRole::Agent => "agent",
            AcpRole::Tool => "tool",
        }
    }
}

#[derive(Debug)]
pub struct AcpWorldModel {
    pub executor: String,
    turns: VecDeque<(AcpRole, String)>,
    /// Agent chunks accumulated since the last flush (streaming turn).
    agent_buffer: String,
}

impl AcpWorldModel {
    pub fn new(executor: String) -> Self {
        Self {
            executor,
            turns: VecDeque::new(),
            agent_buffer: String::new(),
        }
    }

    /// Record a user prompt. Flushes any pending agent buffer first (a
    /// replay never sees PromptDone, so a user turn IS the boundary).
    /// Consecutive identical user turns dedupe — the live path records
    /// from `acp_send_prompt` and some agents echo the prompt back as a
    /// `UserMessageChunk`.
    pub fn record_user(&mut self, text: &str) {
        self.flush_agent_turn();
        if let Some((AcpRole::User, last)) = self.turns.back() {
            if last == &truncate(text) {
                return;
            }
        }
        self.push(AcpRole::User, text);
    }

    /// Accumulate one streamed agent chunk.
    pub fn on_agent_chunk(&mut self, text: &str) {
        self.agent_buffer.push_str(text);
    }

    /// Record a tool call as a one-liner. Flushes the agent buffer first
    /// so ordering (agent said X, then ran tool Y) is preserved.
    pub fn on_tool_call(&mut self, title: &str) {
        self.flush_agent_turn();
        self.push(AcpRole::Tool, title);
    }

    /// Fold the accumulated agent chunks into a single Agent turn.
    /// No-op when nothing is buffered.
    pub fn flush_agent_turn(&mut self) {
        if self.agent_buffer.is_empty() {
            return;
        }
        let text = std::mem::take(&mut self.agent_buffer);
        self.push(AcpRole::Agent, &text);
    }

    pub fn turns(&self) -> Vec<(AcpRole, String)> {
        self.turns.iter().cloned().collect()
    }

    /// Agent text currently streaming (not yet flushed), truncated.
    /// The operator uses this to answer "what is it doing right now?".
    pub fn in_flight_text(&self) -> Option<String> {
        if self.agent_buffer.trim().is_empty() {
            None
        } else {
            Some(truncate(&self.agent_buffer))
        }
    }

    /// Most recent user prompt, for the inactive-tab one-liner.
    pub fn last_user_prompt(&self) -> Option<String> {
        self.turns
            .iter()
            .rev()
            .find(|(r, _)| *r == AcpRole::User)
            .map(|(_, t)| t.clone())
    }

    fn push(&mut self, role: AcpRole, text: &str) {
        let text = truncate(text);
        if text.is_empty() {
            return;
        }
        self.turns.push_back((role, text));
        while self.turns.len() > MAX_TURNS {
            self.turns.pop_front();
        }
    }
}

/// Head+tail elision: long agent turns usually bury the conclusion at
/// the end, so keep both ends.
fn truncate(s: &str) -> String {
    let s = s.trim();
    let count = s.chars().count();
    if count <= MAX_TURN_CHARS {
        return s.to_string();
    }
    let head: String = s.chars().take(HEAD_CHARS).collect();
    let tail: String = s
        .chars()
        .skip(count - TAIL_CHARS)
        .collect();
    format!("{head}…[{count} chars]…{tail}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunks_flush_to_one_agent_turn() {
        let mut w = AcpWorldModel::new("claude".into());
        w.record_user("fix the bug");
        w.on_agent_chunk("Looking at ");
        w.on_agent_chunk("the code now.");
        w.flush_agent_turn();
        let turns = w.turns();
        assert_eq!(turns.len(), 2);
        assert_eq!(turns[1], (AcpRole::Agent, "Looking at the code now.".to_string()));
        // Flush with empty buffer is a no-op.
        w.flush_agent_turn();
        assert_eq!(w.turns().len(), 2);
    }

    #[test]
    fn user_turn_flushes_pending_agent_buffer() {
        // Replay path: no PromptDone between replayed turns.
        let mut w = AcpWorldModel::new("copilot".into());
        w.record_user("first");
        w.on_agent_chunk("answer one");
        w.record_user("second");
        let turns = w.turns();
        assert_eq!(
            turns.iter().map(|(r, _)| r.label()).collect::<Vec<_>>(),
            vec!["user", "agent", "user"]
        );
        assert_eq!(turns[1].1, "answer one");
    }

    #[test]
    fn consecutive_duplicate_user_turns_dedupe() {
        let mut w = AcpWorldModel::new("claude".into());
        w.record_user("hello");
        w.record_user("hello"); // live echo via UserMessageChunk
        assert_eq!(w.turns().len(), 1);
        w.record_user("different");
        assert_eq!(w.turns().len(), 2);
    }

    #[test]
    fn tool_call_flushes_and_records() {
        let mut w = AcpWorldModel::new("pi".into());
        w.on_agent_chunk("Let me check.");
        w.on_tool_call("Read src/main.rs");
        let turns = w.turns();
        assert_eq!(
            turns.iter().map(|(r, _)| r.label()).collect::<Vec<_>>(),
            vec!["agent", "tool"]
        );
        assert_eq!(turns[1].1, "Read src/main.rs");
    }

    #[test]
    fn ring_caps_at_max_turns() {
        let mut w = AcpWorldModel::new("claude".into());
        for i in 0..30 {
            w.record_user(&format!("prompt {i}"));
        }
        assert_eq!(w.turns().len(), MAX_TURNS);
        assert_eq!(w.turns()[0].1, format!("prompt {}", 30 - MAX_TURNS));
    }

    #[test]
    fn long_turns_truncate_head_and_tail() {
        let mut w = AcpWorldModel::new("claude".into());
        let long = format!("START{}END", "x".repeat(2000));
        w.record_user(&long);
        let text = &w.turns()[0].1;
        assert!(text.starts_with("START"));
        assert!(text.ends_with("END"));
        assert!(text.contains("chars]"));
        assert!(text.chars().count() < 600);
    }

    #[test]
    fn last_user_prompt_skips_agent_turns() {
        let mut w = AcpWorldModel::new("claude".into());
        w.record_user("the question");
        w.on_agent_chunk("the answer");
        w.flush_agent_turn();
        assert_eq!(w.last_user_prompt().as_deref(), Some("the question"));
        assert!(AcpWorldModel::new("x".into()).last_user_prompt().is_none());
    }
}
