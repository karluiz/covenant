use karl_score::{
    BranchCell, DailyCell, GroupCell, RepoCell, ScoreFilter, ScoreStore, SessionRow, Summary,
};
use std::sync::Arc;
use tauri::State;

pub struct ScoreState(pub Arc<ScoreStore>);

#[tauri::command]
pub fn score_summary(state: State<'_, ScoreState>) -> Result<Summary, String> {
    state.0.summary().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_heatmap(state: State<'_, ScoreState>) -> Result<Vec<DailyCell>, String> {
    state.0.heatmap_all().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_set_current_session(
    session_id: Option<String>,
    cwd: Option<String>,
    group_name: Option<String>,
) {
    match (session_id, cwd) {
        (Some(sid), Some(c)) => {
            karl_score::set_current_session(Some(karl_score::CurrentSession {
                session_id: sid,
                cwd: std::path::PathBuf::from(c),
                group_name,
            }));
        }
        _ => karl_score::set_current_session(None),
    }
}

#[tauri::command]
pub fn score_summary_filtered(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Summary, String> {
    state.0.summary_filtered(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_heatmap_filtered(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<DailyCell>, String> {
    state.0.heatmap_filtered(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_breakdown_repos(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<RepoCell>, String> {
    state.0.breakdown_repos(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_breakdown_branches(
    state: State<'_, ScoreState>,
    repo: String,
    filter: ScoreFilter,
) -> Result<Vec<BranchCell>, String> {
    state
        .0
        .breakdown_branches(&repo, &filter)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_breakdown_groups(
    state: State<'_, ScoreState>,
    filter: ScoreFilter,
) -> Result<Vec<GroupCell>, String> {
    state.0.breakdown_groups(&filter).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_recent_sessions(
    state: State<'_, ScoreState>,
    limit: u32,
) -> Result<Vec<SessionRow>, String> {
    state.0.recent_sessions(limit).map_err(|e| e.to_string())
}
