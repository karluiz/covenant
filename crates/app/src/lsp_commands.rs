use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use karl_lsp::{install, registry, root, server::LspServer};

/// One server per workspace root. Both maps live behind a single mutex so
/// `lsp_start` and `lsp_stop` can never acquire them in opposite orders
/// (that used to be a two-mutex AB/BA deadlock).
#[derive(Default)]
struct LspRegistry {
    servers: HashMap<u64, LspServer>,
    /// (language, root) → server_id
    by_key: HashMap<(String, String), u64>,
}

pub struct LspState {
    data_dir: PathBuf,
    next_id: AtomicU64,
    registry: Mutex<LspRegistry>,
}

impl LspState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            next_id: AtomicU64::new(1),
            registry: Mutex::new(LspRegistry::default()),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct LspServerStatus {
    pub language: String,
    pub name: String,
    pub version: String,
    pub installed: bool,
    pub approx_size_mb: u32,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspStartResult {
    pub server_id: u64,
    pub root: String,
}

#[derive(Debug, Clone, Serialize)]
struct DownloadProgress {
    received: u64,
    total: Option<u64>,
}

#[tauri::command]
pub fn lsp_server_status(state: State<'_, LspState>, language: String) -> Result<LspServerStatus, String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;
    Ok(LspServerStatus {
        language,
        name: spec.name.clone(),
        version: spec.version.clone(),
        installed: install::is_installed(&state.data_dir, spec),
        approx_size_mb: spec.approx_size_mb,
    })
}

#[tauri::command]
pub async fn lsp_download_server(
    app: AppHandle,
    state: State<'_, LspState>,
    language: String,
) -> Result<(), String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;
    let topic = format!("lsp://download/{language}");
    install::download(spec, &state.data_dir, |received, total| {
        let _ = app.emit(&topic, DownloadProgress { received, total });
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn lsp_start(
    app: AppHandle,
    state: State<'_, LspState>,
    language: String,
    file_path: String,
) -> Result<LspStartResult, String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;
    if !install::is_installed(&state.data_dir, spec) {
        return Err(format!("{} is not installed", spec.name));
    }
    let root = root::detect_root(Path::new(&file_path), &spec.root_markers);
    let root_str = root.to_string_lossy().to_string();
    let key = (language.clone(), root_str.clone());

    // Step 1: fast path — an already-live server for this key.
    {
        let reg = state.registry.lock().await;
        if let Some(&id) = reg.by_key.get(&key) {
            if reg.servers.contains_key(&id) {
                return Ok(LspStartResult { server_id: id, root: root_str });
            }
        }
        // guard dropped here: stale/absent entries are resolved after we
        // (re)spawn below, never held across the spawn await.
    }

    // Step 2: spawn with no lock held — this can be slow (process launch,
    // handshake) and must never block lsp_send/lsp_stop for other servers.
    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let msg_topic = format!("lsp://{id}/message");
    let exit_topic = format!("lsp://{id}/exit");
    let app_msg = app.clone();
    let app_exit = app.clone();
    let mut srv = LspServer::spawn(
        &install::entry_path(&state.data_dir, spec),
        &spec.args,
        &root,
        move |msg| {
            let _ = app_msg.emit(&msg_topic, msg);
        },
        move |_code| {
            // Fires once when the server's stdout closes. Spawn a task so
            // the (non-async) exit callback can emit + self-heal the
            // registry: without this a crashed server leaves a dead id
            // forever, and lsp_start for the same (language, root) never
            // succeeds again.
            let app_exit = app_exit.clone();
            tokio::spawn(async move {
                let _ = app_exit.emit(&exit_topic, ());
                let state = app_exit.state::<LspState>();
                let mut reg = state.registry.lock().await;
                reg.servers.remove(&id);
                reg.by_key.retain(|_, v| *v != id);
                tracing::warn!(server_id = id, "lsp server exited; registry entry cleaned up");
            });
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    // Step 3: re-lock and re-check — another task may have raced us and
    // already installed a live server for this key while we were spawning.
    let mut reg = state.registry.lock().await;
    if let Some(&winner_id) = reg.by_key.get(&key) {
        if reg.servers.contains_key(&winner_id) {
            drop(reg);
            srv.kill().await;
            tracing::info!(
                server_id = winner_id,
                loser_id = id,
                language = %language,
                root = %root_str,
                "lsp_start race lost; killed duplicate spawn"
            );
            return Ok(LspStartResult { server_id: winner_id, root: root_str });
        }
    }

    tracing::info!(server_id = id, language = %language, root = %root_str, "lsp server started");
    reg.servers.insert(id, srv);
    reg.by_key.insert(key, id);
    Ok(LspStartResult { server_id: id, root: root_str })
}

#[tauri::command]
pub async fn lsp_send(state: State<'_, LspState>, server_id: u64, message: String) -> Result<(), String> {
    let reg = state.registry.lock().await;
    let srv = reg.servers.get(&server_id).ok_or("unknown lsp server")?;
    srv.send(message).await;
    Ok(())
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, LspState>, server_id: u64) -> Result<(), String> {
    // Remove from the map(s) first (under the lock), then kill outside the
    // lock so a slow process teardown never blocks other lsp_* commands.
    let srv = {
        let mut reg = state.registry.lock().await;
        reg.by_key.retain(|_, v| *v != server_id);
        reg.servers.remove(&server_id)
    };
    if let Some(mut srv) = srv {
        tracing::info!(server_id, "stopping lsp server");
        srv.kill().await;
    } else {
        tracing::warn!(server_id, "lsp_stop called for unknown/already-gone server");
    }
    Ok(())
}
