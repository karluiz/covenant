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
        DeviceTokenResponse::Success { access_token, scope, .. } => {
            let user =
                auth::finalize_signin(GITHUB_API_BASE, &auth::backend_url(), &access_token, &store)
                    .await
                    .map_err(|e| e.to_string())?;
            // Best-effort: scope is advisory metadata; signin must not fail on it.
            if let Err(e) = auth::store_scope_in_keychain(&scope) {
                tracing::warn!(error = %e, "failed to persist github token scope");
            }
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

/// Granted OAuth scopes of the stored GitHub token (comma-separated, as
/// reported by GitHub at sign-in). `None` when signed out or pre-scope token.
#[tauri::command]
pub async fn score_token_scope() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(auth::load_scope_from_keychain)
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}
