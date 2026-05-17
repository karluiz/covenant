use crate::score_commands::ScoreState;
use karl_score::sync::{self, SyncStatus};
use tauri::State;

#[tauri::command]
pub async fn score_sync_now(state: State<'_, ScoreState>) -> Result<u64, String> {
    let store = state.0.clone();
    sync::push_once(&store).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_sync_status(state: State<'_, ScoreState>) -> Result<SyncStatus, String> {
    sync::status(&state.0).map_err(|e| e.to_string())
}
