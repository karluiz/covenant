use crate::score_commands::ScoreState;
use karl_score::auth::{
    self, DeviceCodeResponse, DeviceTokenResponse, GITHUB_API_BASE, GITHUB_OAUTH_BASE,
};
use karl_score::User;
use tauri::State;

#[tauri::command]
pub async fn score_signin_start() -> Result<DeviceCodeResponse, String> {
    auth::start_device_flow(GITHUB_OAUTH_BASE)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn score_signin_poll(
    state: State<'_, ScoreState>,
    device_code: String,
) -> Result<Option<User>, String> {
    let store = state.0.clone();
    match auth::poll_token(GITHUB_OAUTH_BASE, &device_code)
        .await
        .map_err(|e| e.to_string())?
    {
        DeviceTokenResponse::Pending { .. } => Ok(None),
        DeviceTokenResponse::Success { access_token, .. } => {
            let user =
                auth::finalize_signin(GITHUB_API_BASE, &auth::backend_url(), &access_token, &store)
                    .await
                    .map_err(|e| e.to_string())?;
            Ok(Some(user))
        }
    }
}

#[tauri::command]
pub fn score_current_user(state: State<'_, ScoreState>) -> Result<Option<User>, String> {
    karl_score::session::current(&state.0).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn score_signout(state: State<'_, ScoreState>) -> Result<(), String> {
    auth::signout(&state.0).map_err(|e| e.to_string())
}
