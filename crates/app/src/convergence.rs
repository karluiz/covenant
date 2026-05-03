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

/// ANSI-strips the byte slice and returns the last non-empty line,
/// truncated to `max_chars` (chars, not bytes — emoji-safe).
pub fn last_non_empty_line(bytes: &[u8], max_chars: usize) -> Option<String> {
    let stripped = strip_ansi_escapes::strip(bytes);
    let s = String::from_utf8_lossy(&stripped);
    let line = s
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())?
        .to_string();
    Some(line.chars().take(max_chars).collect())
}

use crate::aom::AomHandle;
use crate::operator::{OperatorState, OperatorWatcher};
use crate::storage::{OperatorDecisionRow, Storage};
use karl_session::SessionId;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

/// Per-session inputs the aggregator needs. The frontend supplies
/// title/color (it owns tab metadata); the backend supplies status +
/// activity. `op_state` is shared with the byte pump — we lock it
/// only briefly to snapshot the tail.
pub struct SessionInput {
    pub session_id: SessionId,
    pub op_state: Arc<StdMutex<OperatorState>>,
}

/// Builds a snapshot for the given sessions. The frontend will merge
/// its own tab title/color in (we do not duplicate that state here).
pub async fn build_convergence_snapshot(
    sessions: Vec<SessionInput>,
    operator: &OperatorWatcher,
    storage: &Storage,
    aom: &AomHandle,
) -> ConvergenceSnapshot {
    let recent = storage
        .list_operator_decisions(200)
        .await
        .unwrap_or_default();
    let by_short = index_decisions_by_short_id(&recent);

    let aom_state = aom.read().await;
    let aom_enabled = aom_state.enabled;
    let aom_budget = aom_state.budget_usd;
    drop(aom_state);

    let now = Instant::now();
    let mut tiles = Vec::with_capacity(sessions.len());
    for s in sessions {
        let id_str = s.session_id.to_string();
        let short = shorten6(&id_str);

        let (last_byte_at, bytes_total, last_decision_at_bytes_total, tail_bytes) = {
            let st = s.op_state.lock().expect("op_state poisoned");
            (
                st.last_byte_at,
                st.bytes_total,
                st.last_decision_at_bytes_total,
                st.snapshot_tail(8 * 1024),
            )
        };

        let last = by_short.get(short.as_str()).copied();
        let last_action = last.map(|d| d.action.as_str());

        let status = classify_status(&StatusInputs {
            last_byte_at,
            bytes_total,
            last_decision_at_bytes_total,
            last_decision_action: last_action,
            now,
        });

        let op_enabled = operator.is_enabled(s.session_id).await;
        let aom_excluded = operator.is_aom_excluded(s.session_id).await;
        let enrolled = aom_enabled && op_enabled && !aom_excluded;

        let cost_usd = if enrolled { Some(0.0) } else { None };

        tiles.push(ConvergenceTileState {
            session_id: id_str,
            title: String::new(),
            color: None,
            status,
            last_decision_action: last.map(|d| d.action.clone()),
            last_decision_rationale: last.and_then(|d| d.rationale.clone()),
            last_command: last.and_then(|d| d.in_flight_command.clone()),
            last_output_line: last_non_empty_line(&tail_bytes, 160),
            cost_usd,
            budget_usd: if enrolled { Some(aom_budget) } else { None },
        });
    }

    ConvergenceSnapshot { tiles }
}

fn shorten6(id: &str) -> String {
    let n = id.len();
    if n > 6 { id[n - 6..].to_string() } else { id.to_string() }
}

fn index_decisions_by_short_id(rows: &[OperatorDecisionRow]) -> HashMap<&str, &OperatorDecisionRow> {
    let mut out = HashMap::new();
    for r in rows {
        out.entry(r.session_id_short.as_str()).or_insert(r);
    }
    out
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

    #[test]
    fn last_non_empty_line_strips_ansi_and_skips_blanks() {
        let raw = b"foo\n\x1b[31mbar\x1b[0m\n   \n";
        let got = last_non_empty_line(raw, 200);
        assert_eq!(got.as_deref(), Some("bar"));
    }

    #[test]
    fn last_non_empty_line_truncates() {
        let raw = b"hello world this is a long tail line";
        let got = last_non_empty_line(raw, 10);
        assert_eq!(got.as_deref(), Some("hello worl"));
    }

    #[test]
    fn last_non_empty_line_returns_none_when_all_blank() {
        let raw = b"\n   \n\t\n";
        assert!(last_non_empty_line(raw, 200).is_none());
    }
}
