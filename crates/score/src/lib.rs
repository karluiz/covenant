pub mod auth;
pub mod context;
pub mod commit_scanner;
pub mod filter;
pub mod session;
pub mod store;
pub mod sync;
pub mod types;

pub use sync::SyncStatus;

pub use store::{ScoreError, ScoreStore};
pub use types::{BranchCell, Context, DailyCell, EventKind, GroupCell, RepoCell, ScoreEvent, ScoreFilter, SessionRow, Summary, TimeRange, User};

use crate::context::ContextResolver;
use once_cell::sync::OnceCell;
use std::sync::{Arc, Mutex};

static RECORDER: OnceCell<Mutex<Option<Arc<ScoreStore>>>> = OnceCell::new();

static RESOLVER: OnceCell<ContextResolver> = OnceCell::new();
fn resolver() -> &'static ContextResolver {
    RESOLVER.get_or_init(ContextResolver::new)
}

#[derive(Clone)]
pub struct CurrentSession {
    pub session_id: String,
    pub cwd: std::path::PathBuf,
    pub group_name: Option<String>,
}

fn current_slot() -> &'static Mutex<Option<CurrentSession>> {
    static CURRENT: OnceCell<Mutex<Option<CurrentSession>>> = OnceCell::new();
    CURRENT.get_or_init(|| Mutex::new(None))
}

pub fn set_current_session(s: Option<CurrentSession>) {
    if let Ok(mut g) = current_slot().lock() {
        *g = s;
    }
}

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

pub fn record_prompt_with_context(executor: &str) {
    let now = chrono::Utc::now().timestamp_millis();
    let cur = current_slot().lock().ok().and_then(|g| g.clone());
    let ctx = match cur {
        Some(c) => resolver().resolve(&c.session_id, &c.cwd, c.group_name),
        None => Context::default(),
    };
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append_with_context(now, EventKind::Prompt, executor, &ctx) {
                tracing::warn!(target: "score", error = %e, "record_prompt_with_context failed");
            }
        }
    }
}

pub fn record_prompt(executor: &str) {
    record_prompt_with_context(executor)
}

pub fn record_commit_with_context(repo: &str, sha7: &str, branch: Option<String>) {
    let now = chrono::Utc::now().timestamp_millis();
    let exec = format!("{repo}:{sha7}");
    let ctx = Context { repo: Some(repo.to_string()), branch, group_name: None };
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            let _ = store.append_with_context(now, EventKind::Commit, &exec, &ctx);
        }
    }
}

pub fn record_commit(repo: &str, sha7: &str) {
    record_commit_with_context(repo, sha7, None)
}
