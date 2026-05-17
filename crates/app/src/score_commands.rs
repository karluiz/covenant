use karl_score::{DailyCell, ScoreStore, Summary};
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
