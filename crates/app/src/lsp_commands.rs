use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use karl_lsp::{install, registry, root, server::LspServer};

pub struct LspState {
    data_dir: PathBuf,
    next_id: AtomicU64,
    servers: Mutex<HashMap<u64, LspServer>>,
    /// (language, root) → server_id: one server per workspace root.
    by_key: Mutex<HashMap<(String, String), u64>>,
}

impl LspState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            next_id: AtomicU64::new(1),
            servers: Mutex::new(HashMap::new()),
            by_key: Mutex::new(HashMap::new()),
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

    let mut by_key = state.by_key.lock().await;
    if let Some(&id) = by_key.get(&key) {
        if state.servers.lock().await.contains_key(&id) {
            return Ok(LspStartResult { server_id: id, root: root_str });
        }
        by_key.remove(&key); // stale entry — server exited
    }

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let msg_topic = format!("lsp://{id}/message");
    let exit_topic = format!("lsp://{id}/exit");
    let app_msg = app.clone();
    let app_exit = app.clone();
    let srv = LspServer::spawn(
        &install::entry_path(&state.data_dir, spec),
        &spec.args,
        &root,
        move |msg| {
            let _ = app_msg.emit(&msg_topic, msg);
        },
        move |_code| {
            let _ = app_exit.emit(&exit_topic, ());
        },
    )
    .await
    .map_err(|e| e.to_string())?;

    tracing::info!(server_id = id, language = %language, root = %root_str, "lsp server started");
    state.servers.lock().await.insert(id, srv);
    by_key.insert(key, id);
    Ok(LspStartResult { server_id: id, root: root_str })
}

#[tauri::command]
pub async fn lsp_send(state: State<'_, LspState>, server_id: u64, message: String) -> Result<(), String> {
    let servers = state.servers.lock().await;
    let srv = servers.get(&server_id).ok_or("unknown lsp server")?;
    srv.send(message).await;
    Ok(())
}

#[tauri::command]
pub async fn lsp_stop(state: State<'_, LspState>, server_id: u64) -> Result<(), String> {
    let mut servers = state.servers.lock().await;
    if let Some(mut srv) = servers.remove(&server_id) {
        srv.kill().await;
    }
    state.by_key.lock().await.retain(|_, v| *v != server_id);
    Ok(())
}
