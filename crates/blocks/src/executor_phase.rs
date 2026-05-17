//! Heuristic detector: maps raw PTY byte chunks from an executor agent
//! to an `ExecutorPhase`. Subsequent commits add Running/Writing/Reading/
//! Waiting/Done; this commit only ships Idle → Thinking.

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

pub struct ExecutorPhaseDetector {
    phase: ExecutorPhase,
}

impl ExecutorPhaseDetector {
    pub fn new() -> Self {
        Self { phase: ExecutorPhase::Idle }
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

    fn detect(&self, _bytes: &[u8]) -> ExecutorPhase {
        if matches!(self.phase, ExecutorPhase::Idle) {
            ExecutorPhase::Thinking
        } else {
            self.phase.clone()
        }
    }
}

impl Default for ExecutorPhaseDetector {
    fn default() -> Self { Self::new() }
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
    fn transitions_to_thinking_on_first_chunk() {
        let mut d = ExecutorPhaseDetector::new();
        let changed = d.feed(b"some agent banner\n");
        assert_eq!(d.phase(), &ExecutorPhase::Thinking);
        assert!(changed);
    }

    #[test]
    fn feed_returns_false_when_phase_unchanged() {
        let mut d = ExecutorPhaseDetector::new();
        d.feed(b"banner\n");
        let changed = d.feed(b"more thinking output\n");
        assert!(!changed);
    }
}
