//! Convergence Mode (spec 3.8) — read-only aggregator that builds one
//! tile per open session for the ⌘⇧O overlay. NO schema changes; pulls
//! from existing AppState handles only.

use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TileStatus {
    Idle,
    Working,
    AwaitingInput,
    Blocked,
    OperatorThinking,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvergenceTileState {
    pub session_id: String,
    pub title: String,
    pub color: Option<String>,
    pub status: TileStatus,
    pub last_decision_action: Option<String>,
    pub last_decision_rationale: Option<String>,
    pub last_command: Option<String>,
    pub last_output_line: Option<String>,
    /// Hidden in the UI when `None`. Spec rule: only present when the
    /// tab is enrolled in AOM (operator-enabled, AOM on, not excluded).
    pub cost_usd: Option<f64>,
    pub budget_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvergenceSnapshot {
    pub tiles: Vec<ConvergenceTileState>,
}

/// Inputs the classifier needs. Kept separate from `OperatorState` so
/// we can unit-test without spinning up the watcher.
pub struct StatusInputs<'a> {
    pub last_byte_at: Instant,
    pub bytes_total: u64,
    pub last_decision_at_bytes_total: u64,
    pub last_decision_action: Option<&'a str>,
    pub now: Instant,
}

/// Pure status classifier. Rules (v1):
/// - `Working`     → bytes arrived within the last 750 ms
/// - `Blocked`     → last decision was `escalate` AND no new bytes
///                   since that decision
/// - `AwaitingInput` → bytes have arrived since the last decision AND
///                     the stream has been idle > 1500 ms
/// - `Idle`        → default
/// `OperatorThinking` is reserved for v2 (would require new surface
/// on OperatorWatcher). Always returns one of the four above in v1.
pub fn classify_status(inp: &StatusInputs) -> TileStatus {
    let idle = inp.now.duration_since(inp.last_byte_at);
    if idle < Duration::from_millis(750) {
        return TileStatus::Working;
    }
    let bytes_since_last_decision =
        inp.bytes_total.saturating_sub(inp.last_decision_at_bytes_total);
    if inp.last_decision_action == Some("escalate") && bytes_since_last_decision == 0 {
        return TileStatus::Blocked;
    }
    if bytes_since_last_decision > 0 && idle > Duration::from_millis(1500) {
        return TileStatus::AwaitingInput;
    }
    TileStatus::Idle
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(now: Instant, ms_ago: u64) -> Instant {
        now - Duration::from_millis(ms_ago)
    }

    #[test]
    fn working_when_bytes_recent() {
        let now = Instant::now();
        let s = classify_status(&StatusInputs {
            last_byte_at: at(now, 200),
            bytes_total: 100,
            last_decision_at_bytes_total: 50,
            last_decision_action: Some("reply"),
            now,
        });
        assert_eq!(s, TileStatus::Working);
    }

    #[test]
    fn blocked_when_last_decision_escalate_and_no_new_bytes() {
        let now = Instant::now();
        let s = classify_status(&StatusInputs {
            last_byte_at: at(now, 5_000),
            bytes_total: 200,
            last_decision_at_bytes_total: 200,
            last_decision_action: Some("escalate"),
            now,
        });
        assert_eq!(s, TileStatus::Blocked);
    }

    #[test]
    fn awaiting_input_when_idle_with_new_bytes_since_decision() {
        let now = Instant::now();
        let s = classify_status(&StatusInputs {
            last_byte_at: at(now, 3_000),
            bytes_total: 500,
            last_decision_at_bytes_total: 200,
            last_decision_action: Some("reply"),
            now,
        });
        assert_eq!(s, TileStatus::AwaitingInput);
    }

    #[test]
    fn idle_default() {
        let now = Instant::now();
        let s = classify_status(&StatusInputs {
            last_byte_at: at(now, 10_000),
            bytes_total: 100,
            last_decision_at_bytes_total: 100,
            last_decision_action: None,
            now,
        });
        assert_eq!(s, TileStatus::Idle);
    }
}
