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
    pub operators: bool,
    pub specs: bool,
    pub preferences: bool,
    pub last_synced_ms: Option<i64>,
    pub device: Option<String>,
}

/// Return the current cloud-sync config + sign-in state.
///
/// Calls `pull` to fetch `last_synced_ms` / `device` from the cloud.
/// Tolerates offline or not-signed-in: fields become `None` in that case.
#[tauri::command]
pub async fn cloud_sync_status(
    state: State<'_, AppState>,
    registry: State<'_, std::sync::Arc<crate::operator_registry::OperatorRegistry>>,
) -> Result<CloudSyncStatus, String> {
    // Registry is consumed by GatherCtx but not needed for status; accept it
    // to keep the command signature consistent with the others so callers
    // don't need special-case handling.
    let _ = registry;

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
        operators: cfg.operators,
        specs: cfg.specs,
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
/// frontend auto-push trigger (Task 8); manual "Back up now" always works
/// when signed in.
#[tauri::command]
pub async fn cloud_sync_push(
    state: State<'_, AppState>,
    registry: State<'_, std::sync::Arc<crate::operator_registry::OperatorRegistry>>,
) -> Result<i64, String> {
    let specs_base_dir =
        karl_agent::spec_author::home_covenant_dir().map_err(|e| e.to_string())?;

    // Build the envelope while holding the settings lock, then drop it
    // before the network call to avoid holding the lock across `.await`.
    let env = {
        let s = state.settings.lock().await;
        let ctx = GatherCtx {
            cfg: &s.cloud_sync,
            settings: &s,
            // Arc<OperatorRegistry> derefs to &OperatorRegistry.
            registry: &registry,
            tab_manifest_path: &state.tab_manifest_path,
            specs_base_dir,
        };
        build_envelope(&ctx) // sync fn — no `.await`
    };

    push(&env).await
}

/// Pull the cloud envelope and apply it locally.
///
/// After merging preferences the new settings are persisted and the
/// in-memory `AppState.settings` is updated so the UI reflects them
/// without a restart.  We replicate what `set_settings` does: save to
/// disk then overwrite the Arc-Mutex value.  There is no separate
/// "settings updated" broadcast in the existing codebase, so we match
/// the same pattern.
#[tauri::command]
pub async fn cloud_sync_restore(
    state: State<'_, AppState>,
    registry: State<'_, std::sync::Arc<crate::operator_registry::OperatorRegistry>>,
) -> Result<ApplySummary, String> {
    let env = pull().await?.ok_or_else(|| "nothing in cloud yet".to_string())?;

    let specs_base_dir =
        karl_agent::spec_author::home_covenant_dir().map_err(|e| e.to_string())?;

    let mut merged: Option<crate::settings::Settings> = None;

    let summary = {
        let s = state.settings.lock().await;
        let mut ctx = ApplyCtx {
            settings: &s,
            registry: &registry,
            storage: &state.storage,
            tab_manifest_path: &state.tab_manifest_path,
            specs_base_dir,
            merged_settings_out: &mut merged,
        };
        apply_envelope(&env, &mut ctx).await
    };
    // Lock released here — safe to take it again.

    if let Some(new_settings) = merged {
        let mut s = state.settings.lock().await;
        settings::save(&state.settings_path, &new_settings).map_err(|e| e.to_string())?;
        *s = new_settings;
    }

    Ok(summary)
}

/// Delete the cloud-stored envelope.
#[tauri::command]
pub async fn cloud_sync_wipe(
    _state: State<'_, AppState>,
) -> Result<(), String> {
    wipe().await
}
