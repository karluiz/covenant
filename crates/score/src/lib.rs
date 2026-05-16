//! Covenant Score — local prompt/commit tracking. Append-only SQLite
//! store backs a tiny aggregation layer used by the status-bar chip
//! and Score modal.

pub mod commit_scanner;
pub mod store;
pub mod types;

pub use store::ScoreStore;
pub use types::{DailyCell, EventKind, ScoreEvent, Summary};
