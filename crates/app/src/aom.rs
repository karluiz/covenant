//! Autonomous Operator Mode (AOM) — global runtime state.
//!
//! When AOM is on, every Operator-enabled session enters
//! "act-by-default" posture:
//!   - Live mode is forced on (regardless of the per-tab live toggle),
//!     so Reply actions actually inject keystrokes into the PTY.
//!   - The system prompt prepends an AOM directive that overrides the
//!     persona's ALWAYS-ASK list with a reversibility test: if morning-
//!     you can undo it (git revert / cargo clean / etc.), DECIDE.
//!   - REPLY action `TEXT` always gets a trailing `\n` appended if it
//!     doesn't have one — the user is not in the loop, no review.
//!
//! This state is GLOBAL (not per-session). Granularity is achieved via
//! the existing per-tab Operator-enabled toggle: only tabs the user
//! opted in for the Operator are eligible for autonomous action when
//! AOM is on. Tabs without the Operator stay completely manual.
//!
//! Phase A (this commit) just adds the toggle + posture. Phase B will
//! add cost tracking + budget cap; Phase C will add the session
//! "morning report" panel.

use std::sync::Arc;

use serde::Serialize;
use tokio::sync::RwLock;

#[derive(Debug, Default)]
pub struct AomState {
    pub enabled: bool,
    /// `0` when never enabled. Reset to `now` on every `aom_start`.
    pub started_at_unix_ms: u64,
    /// Decisions the Operator has made since the last `aom_start`.
    /// Bumped from `operator::run_tick` after each successful call,
    /// regardless of action kind (reply/escalate/wait all count).
    pub decisions_count: u64,
    /// Hard USD cap for this AOM session. Set on `aom_start` from
    /// `Settings.aom.default_budget_usd` (or an explicit override).
    /// When `accumulated_cost_usd` reaches this, AOM auto-stops.
    pub budget_usd: f64,
    /// Running USD total for this session, summed from each Operator
    /// call's input/output/cache token usage via `cost::estimate_usd`.
    /// Persists across enabled→disabled transitions until the next
    /// `aom_start` resets it; lets the morning report show "spent
    /// $4.20 total" even after auto-stop.
    pub accumulated_cost_usd: f64,
    /// Set when AOM auto-stopped because budget was hit (vs the user
    /// pressing ⌘⇧A). Surfaces in the toast + morning report.
    pub cost_cap_hit_at_unix_ms: Option<u64>,
    /// SQLite rowid of the active `aom_sessions` row. `aom_start`
    /// inserts a fresh row and stashes its id here; `aom_stop` and
    /// the budget-hit path use it to UPDATE end-state. `None` when
    /// AOM has never been started in this process (or DB write
    /// failed at start — degrades gracefully: no morning report
    /// for that aborted session).
    pub current_session_row_id: Option<i64>,
}

/// Shared handle. RwLock because the operator tick reads it on every
/// poll (cheap path); the UI commands write rarely.
pub type AomHandle = Arc<RwLock<AomState>>;

pub fn new_handle() -> AomHandle {
    Arc::new(RwLock::new(AomState::default()))
}

/// Snapshot suitable for IPC. Mirrors `AomState` 1:1; lives separately
/// so internal-only fields can stay private if we add them later.
#[derive(Debug, Clone, Serialize)]
pub struct AomStatus {
    pub enabled: bool,
    pub started_at_unix_ms: u64,
    pub decisions_count: u64,
    pub budget_usd: f64,
    pub accumulated_cost_usd: f64,
    pub cost_cap_hit_at_unix_ms: Option<u64>,
}

impl From<&AomState> for AomStatus {
    fn from(s: &AomState) -> Self {
        Self {
            enabled: s.enabled,
            started_at_unix_ms: s.started_at_unix_ms,
            decisions_count: s.decisions_count,
            budget_usd: s.budget_usd,
            accumulated_cost_usd: s.accumulated_cost_usd,
            cost_cap_hit_at_unix_ms: s.cost_cap_hit_at_unix_ms,
        }
    }
}
