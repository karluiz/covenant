pub mod auth;
pub mod commit_scanner;
pub mod session;
pub mod store;
pub mod types;

pub use store::{ScoreError, ScoreStore};
pub use types::{DailyCell, EventKind, ScoreEvent, Summary, User};

use once_cell::sync::OnceCell;
use std::sync::{Arc, Mutex};

static RECORDER: OnceCell<Mutex<Option<Arc<ScoreStore>>>> = OnceCell::new();

fn slot() -> &'static Mutex<Option<Arc<ScoreStore>>> {
    RECORDER.get_or_init(|| Mutex::new(None))
}

pub fn set_recorder(store: Arc<ScoreStore>) {
    if let Ok(mut g) = slot().lock() {
        *g = Some(store);
    }
}

#[doc(hidden)]
pub fn clear_recorder_for_test() {
    if let Ok(mut g) = slot().lock() {
        *g = None;
    }
}

pub fn record_prompt(executor: &str) {
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append(now, EventKind::Prompt, executor) {
                tracing::warn!(target: "score", error = %e, "record_prompt failed");
            }
        }
    }
}

pub fn record_commit(repo: &str, sha7: &str) {
    let now = chrono::Utc::now().timestamp_millis();
    let exec = format!("{repo}:{sha7}");
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            let _ = store.append(now, EventKind::Commit, &exec);
        }
    }
}
