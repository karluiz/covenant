pub mod achievements;
pub mod agent_label;
pub mod auth;
pub mod commit_scanner;
pub mod context;
pub mod external;
pub mod filter;
pub mod session;
pub mod spec_scanner;
pub mod spec_watcher;
pub mod store;
pub mod sync;
pub mod types;

pub use sync::SyncStatus;

pub use store::{ScoreError, ScoreStore};
pub use types::{
    AgentCell, BranchCell, Context, DailyCell, EventKind, GroupCell, LlmUsage, ModelCell,
    ModelSource, RepoCell, ScoreEvent, ScoreFilter, SessionRow, SpecBreakdown, SpecRow, Summary,
    TimeRange, User,
};

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
    pub workspace: Option<String>,
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

fn repo_paths_slot() -> &'static Mutex<std::collections::HashSet<std::path::PathBuf>> {
    static PATHS: OnceCell<Mutex<std::collections::HashSet<std::path::PathBuf>>> = OnceCell::new();
    PATHS.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

pub(crate) fn register_toplevel(toplevel: &std::path::Path) {
    let p = toplevel
        .canonicalize()
        .unwrap_or_else(|_| toplevel.to_path_buf());
    let newly = match repo_paths_slot().lock() {
        Ok(mut g) => g.insert(p.clone()),
        Err(_) => false,
    };
    // Persist so the registry survives relaunches; the commit scanner unions
    // this with the store's repo_paths table.
    if newly {
        if let Ok(g) = slot().lock() {
            if let Some(store) = g.as_ref() {
                let now = chrono::Utc::now().timestamp_millis();
                if let Err(e) = store.upsert_repo_path(&p, now) {
                    tracing::warn!(target: "score", error = %e, "upsert_repo_path failed");
                }
            }
        }
    }
}

/// Register the git repo containing `cwd` (if any) for periodic commit
/// scanning. No-op outside a git repo.
pub fn register_cwd(cwd: &std::path::Path) {
    if let Some(t) = context::toplevel_for_cwd(cwd) {
        register_toplevel(&t);
    }
}

/// Canonical toplevel paths of every git repo seen so far this run.
pub fn known_repo_paths() -> Vec<std::path::PathBuf> {
    repo_paths_slot()
        .lock()
        .map(|g| g.iter().cloned().collect())
        .unwrap_or_default()
}

/// Resolve the Context (repo/branch/group) of the current session, the same
/// way prompt events get theirs. Default when no session is current.
pub fn current_context() -> Context {
    let cur = current_slot().lock().ok().and_then(|g| g.clone());
    match cur {
        Some(c) => resolver().resolve(&c.session_id, &c.cwd, c.group_name, c.workspace),
        None => Context::default(),
    }
}

pub fn record_prompt_with_agent(executor: &str, agent: Option<&str>) {
    let now = chrono::Utc::now().timestamp_millis();
    let ctx = current_context();
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append_with_context(now, EventKind::Prompt, executor, agent, &ctx)
            {
                tracing::warn!(target: "score", error = %e, "record_prompt_with_agent failed");
            }
        }
    }
}

pub fn record_prompt_with_context(executor: &str) {
    record_prompt_with_agent(executor, None)
}

pub fn record_prompt(executor: &str) {
    record_prompt_with_agent(executor, None)
}

pub fn record_commit_with_context(repo: &str, sha7: &str, branch: Option<String>) {
    let now = chrono::Utc::now().timestamp_millis();
    let exec = format!("{repo}:{sha7}");
    let ctx = Context {
        repo: Some(repo.to_string()),
        branch,
        group_name: None,
        workspace: None,
    };
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            let _ = store.append_with_context(now, EventKind::Commit, &exec, None, &ctx);
        }
    }
}

pub fn record_commit(repo: &str, sha7: &str) {
    record_commit_with_context(repo, sha7, None)
}

pub fn record_llm_call(
    source: ModelSource,
    agent: Option<&str>,
    provider: &str,
    model: &str,
    usage: LlmUsage,
    ctx: &Context,
) {
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            if let Err(e) = store.append_llm_call(now, source, agent, provider, model, usage, ctx) {
                tracing::warn!(target: "score", error = %e, "record_llm_call failed");
            }
        }
    }
}

/// Record an achievement fact. Updates progress and inserts new awards atomically.
/// Returns the awards that were newly earned (may be empty).
pub fn record_achievement_fact(
    fact: achievements::AchievementFact,
) -> Vec<achievements::AchievementAward> {
    let now = chrono::Utc::now().timestamp_millis();
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            match store.record_achievement_fact(now, &fact) {
                Ok(awards) => return awards,
                Err(e) => {
                    tracing::warn!(target: "score", error = %e, "record_achievement_fact failed");
                }
            }
        }
    }
    Vec::new()
}

pub fn record_spec(path: &str, ctx: &Context) {
    let now = chrono::Utc::now().timestamp_millis();
    let mut newly_created = false;
    if let Ok(g) = slot().lock() {
        if let Some(store) = g.as_ref() {
            match store.append_spec(now, path, ctx) {
                Ok(created) => newly_created = created,
                Err(e) => tracing::warn!(target: "score", error = %e, "record_spec failed"),
            }
        }
    }

    // A newly recorded spec/note advances the Cartographer (project memory)
    // achievement. Emit only on first insert — re-scans return false above, and
    // the dedupe_key guards against any double counting. We emit AFTER dropping
    // the slot() lock: record_achievement_fact re-acquires it, so emitting
    // inside the block above would deadlock.
    if newly_created {
        if let Some(repo) = ctx.repo.clone() {
            let dedupe = format!("project_note_created:{repo}:{path}");
            let _ = record_achievement_fact(achievements::AchievementFact {
                kind: "project_note_created".to_string(),
                subject_type: achievements::SubjectKind::Project,
                subject_id: Some(repo.clone()),
                repo: Some(repo),
                branch: ctx.branch.clone(),
                group_name: ctx.group_name.clone(),
                session_id: None,
                task_id: None,
                verification: None,
                dedupe_key: Some(dedupe),
            });
        }
    }
}
