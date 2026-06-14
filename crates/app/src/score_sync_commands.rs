use crate::score_commands::ScoreState;
use karl_score::profile_card::PublicProfileSnapshot;
use karl_score::sync::{self, SyncStatus};
use tauri::State;

#[tauri::command]
pub async fn score_sync_now(state: State<'_, ScoreState>) -> Result<u64, String> {
    let store = state.0.clone();
    let count = sync::push_drain(&store, std::time::Duration::from_millis(250))
        .await
        .map_err(|e| e.to_string())?;
    // re-publish the profile snapshot if the user opted in
    if store.get_publish_profile().unwrap_or(false) {
        let _ = sync::publish_profile(&store).await; // best-effort; sync result is the return value
    }
    Ok(count)
}

#[tauri::command]
pub fn score_profile_get_publish(state: State<'_, ScoreState>) -> Result<bool, String> {
    state.0.get_publish_profile().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn score_profile_set_publish(
    state: State<'_, ScoreState>,
    enabled: bool,
) -> Result<Option<String>, String> {
    state.0.set_publish_profile(enabled).map_err(|e| e.to_string())?;
    if enabled {
        let url = sync::publish_profile(&state.0).await.map_err(|e| e.to_string())?;
        Ok(Some(url))
    } else {
        sync::unpublish_profile().await.map_err(|e| e.to_string())?;
        Ok(None)
    }
}

#[tauri::command]
pub fn score_profile_preview(state: State<'_, ScoreState>) -> Result<Option<PublicProfileSnapshot>, String> {
    sync::current_snapshot(&state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_profile_share_url(state: State<'_, ScoreState>) -> Result<Option<String>, String> {
    let user = karl_score::session::current(&state.0).map_err(|e| e.to_string())?;
    Ok(user.map(|u| format!("{}/u/{}", karl_score::auth::backend_url(), u.login)))
}

#[tauri::command]
pub fn score_sync_status(state: State<'_, ScoreState>) -> Result<SyncStatus, String> {
    sync::status(&state.0).map_err(|e| e.to_string())
}
