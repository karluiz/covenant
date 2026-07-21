use serde::Serialize;
use tauri::State;

use super::{apply_envelope, build_envelope, pull, push, wipe, ApplyCtx, ApplySummary, GatherCtx};
use crate::settings::{self, CloudSyncConfig};
use crate::AppState;
use karl_score::auth;

/// Returned by `cloud_sync_status`.
#[derive(Serialize)]
pub struct CloudSyncStatus {
    pub signed_in: bool,
    pub enabled: bool,
    pub workspaces: bool,
    pub preferences: bool,
    pub last_synced_ms: Option<i64>,
    pub device: Option<String>,
}

/// Return the current cloud-sync config + sign-in state.
///
/// Calls `pull` to fetch `last_synced_ms` / `device` from the cloud.
/// Tolerates offline or not-signed-in: fields become `None` in that case.
#[tauri::command]
pub async fn cloud_sync_status(state: State<'_, AppState>) -> Result<CloudSyncStatus, String> {
    let signed_in = auth::load_jwt().ok().flatten().is_some();
    let cfg = state.settings.lock().await.cloud_sync.clone();

    // Pull is cheap (GET). Tolerate any error — user may be offline.
    let (last_synced_ms, device) = match pull().await {
        Ok(Some(env)) => (Some(env.updated_at_ms), Some(env.device)),
        _ => (None, None),
    };

    Ok(CloudSyncStatus {
        signed_in,
        enabled: cfg.enabled,
        workspaces: cfg.workspaces,
        preferences: cfg.preferences,
        last_synced_ms,
        device,
    })
}

/// Persist a new `CloudSyncConfig` to settings.
#[tauri::command]
pub async fn cloud_sync_set_config(
    state: State<'_, AppState>,
    cfg: CloudSyncConfig,
) -> Result<(), String> {
    let mut s = state.settings.lock().await;
    s.cloud_sync = cfg;
    settings::save(&state.settings_path, &s).map_err(|e| e.to_string())
}

/// Build and push the current state to the cloud.
///
/// Returns `updated_at_ms` from the server response.
/// Does NOT gate on `cloud_sync.enabled` — that gating lives in the
/// frontend auto-push trigger; manual "Back up now" always works
/// when signed in.
#[tauri::command]
pub async fn cloud_sync_push(state: State<'_, AppState>) -> Result<i64, String> {
    // Build the envelope while holding the settings lock, then drop it
    // before the network call to avoid holding the lock across `.await`.
    let env = {
        let s = state.settings.lock().await;
        let ctx = GatherCtx {
            cfg: &s.cloud_sync,
            settings: &s,
            tab_manifest_path: &state.tab_manifest_path,
        };
        build_envelope(&ctx)
    };

    push(&env).await
}

/// Pull the cloud envelope and apply it locally.
///
/// After merging preferences the new settings are persisted and the
/// in-memory `AppState.settings` is updated so the UI reflects them
/// without a restart.
#[tauri::command]
pub async fn cloud_sync_restore(state: State<'_, AppState>) -> Result<ApplySummary, String> {
    let env = pull()
        .await?
        .ok_or_else(|| "nothing in cloud yet".to_string())?;

    let mut merged: Option<crate::settings::Settings> = None;

    let summary = {
        let s = state.settings.lock().await;
        let mut ctx = ApplyCtx {
            settings: &s,
            tab_manifest_path: &state.tab_manifest_path,
            merged_settings_out: &mut merged,
        };
        apply_envelope(&env, &mut ctx)
    };

    if let Some(new_settings) = merged {
        let mut s = state.settings.lock().await;
        settings::save(&state.settings_path, &new_settings).map_err(|e| e.to_string())?;
        *s = new_settings;
    }

    Ok(summary)
}

/// Delete the cloud-stored envelope.
#[tauri::command]
pub async fn cloud_sync_wipe(_state: State<'_, AppState>) -> Result<(), String> {
    wipe().await
}
