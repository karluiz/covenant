use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::Mutex;

use karl_lsp::registry::InstallKind;
use karl_lsp::{install, registry, root, runtime, server::LspServer, LspError};

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

/// Populated on `LspServerStatus` when an npm-method server needs a runtime
/// (e.g. node) that isn't present, or is present but too old. `found` is
/// `None` when the runtime binary wasn't found at all, `Some(version)` when
/// it was found but failed the minimum-version check.
#[derive(Debug, Clone, Serialize)]
pub struct RuntimeMissingInfo {
    pub name: String,
    pub min: String,
    pub found: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspServerStatus {
    pub language: String,
    pub name: String,
    pub version: String,
    pub installed: bool,
    pub approx_size_mb: u32,
    /// `Some` only for npm-method servers whose runtime dependency (node)
    /// is missing or too old. Binary servers (rust-analyzer) always report
    /// `None` here.
    pub runtime_missing: Option<RuntimeMissingInfo>,
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

/// Progress payload for the npm-install path (no byte-stream progress —
/// `npm_install` fires this periodically with a human-readable status
/// instead). Emitted on the same `lsp://download/{language}` topic as
/// `DownloadProgress`; consumers distinguish by install kind.
#[derive(Debug, Clone, Serialize)]
struct NpmInstallProgress {
    message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct LspInstalledServer {
    pub language: String,
    pub name: String,
    pub version: String,
    pub size_bytes: u64,
    pub installed: bool,
}

#[tauri::command]
pub fn lsp_server_status(
    state: State<'_, LspState>,
    language: String,
) -> Result<LspServerStatus, String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;

    let mut installed = install::is_installed(&state.data_dir, spec);
    let mut runtime_missing = None;

    if spec.install_kind() == InstallKind::Npm {
        if let Some(rt) = &spec.runtime {
            if let Err(e) = runtime::detect(&rt.as_runtime_req()) {
                match e {
                    LspError::RuntimeMissing { name, min, found } => {
                        runtime_missing = Some(RuntimeMissingInfo { name, min, found });
                        installed = false;
                    }
                    other => return Err(other.to_string()),
                }
            }
        }
    }

    Ok(LspServerStatus {
        language,
        name: spec.name.clone(),
        version: spec.version.clone(),
        installed,
        approx_size_mb: spec.approx_size_mb,
        runtime_missing,
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
    match spec.install_kind() {
        InstallKind::Binary => {
            install::download(spec, &state.data_dir, |received, total| {
                let _ = app.emit(&topic, DownloadProgress { received, total });
            })
            .await
            .map_err(|e| e.to_string())?;
        }
        InstallKind::Npm => {
            let rt = spec
                .runtime
                .as_ref()
                .ok_or_else(|| format!("{} is an npm server but has no runtime spec", spec.name))?;
            let node = runtime::detect(&rt.as_runtime_req()).map_err(|e| e.to_string())?;
            // Node's PARENT DIR (not the binary itself) so npm_install's
            // resolve_npm_path fast path finds `npm` next to it instead of
            // falling back to a login-shell lookup.
            let node_dir = node.path.parent().ok_or_else(|| {
                format!("cannot resolve parent directory of {}", node.path.display())
            })?;
            install::npm_install(spec, &state.data_dir, node_dir, |message| {
                let _ = app.emit(
                    &topic,
                    NpmInstallProgress {
                        message: message.to_string(),
                    },
                );
            })
            .await
            .map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn lsp_list_installed(state: State<'_, LspState>) -> Result<Vec<LspInstalledServer>, String> {
    let servers = registry::all_specs()
        .iter()
        .map(|spec| LspInstalledServer {
            language: spec.language.clone(),
            name: spec.name.clone(),
            version: spec.version.clone(),
            size_bytes: install::installed_size(&state.data_dir, spec),
            installed: install::is_installed(&state.data_dir, spec),
        })
        .collect();
    Ok(servers)
}

#[tauri::command]
pub fn lsp_delete_server(state: State<'_, LspState>, language: String) -> Result<(), String> {
    let spec = registry::spec_for_language(&language).map_err(|e| e.to_string())?;
    install::remove(&state.data_dir, spec).map_err(|e| e.to_string())?;
    tracing::info!(language = %language, "lsp server deleted");
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
                return Ok(LspStartResult {
                    server_id: id,
                    root: root_str,
                });
            }
        }
        // guard dropped here: stale/absent entries are resolved after we
        // (re)spawn below, never held across the spawn await.
    }

    // Step 2: spawn with no lock held — this can be slow (process launch,
    // handshake) and must never block lsp_send/lsp_stop for other servers.
    // Binary servers (rust-analyzer) spawn `entry_path` directly — the
    // downloaded binary IS the command. Npm servers spawn the resolved
    // `node` binary with the JS entry point as its first argument, since
    // the "binary" here is a `.mjs`/`.js` file that can't execute itself.
    let (bin, spawn_args): (PathBuf, Vec<String>) = match spec.install_kind() {
        InstallKind::Binary => (
            install::entry_path(&state.data_dir, spec),
            spec.args.clone(),
        ),
        InstallKind::Npm => {
            let rt = spec
                .runtime
                .as_ref()
                .ok_or_else(|| format!("{} is an npm server but has no runtime spec", spec.name))?;
            let node = runtime::detect(&rt.as_runtime_req()).map_err(|e| e.to_string())?;
            let entry = install::entry_path(&state.data_dir, spec);
            let mut args = vec![entry.to_string_lossy().to_string()];
            args.extend(spec.args.iter().cloned());
            (node.path, args)
        }
    };

    let id = state.next_id.fetch_add(1, Ordering::Relaxed);
    let msg_topic = format!("lsp://{id}/message");
    let exit_topic = format!("lsp://{id}/exit");
    let app_msg = app.clone();
    let app_exit = app.clone();
    let mut srv = LspServer::spawn(
        &bin,
        &spawn_args,
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
                tracing::warn!(
                    server_id = id,
                    "lsp server exited; registry entry cleaned up"
                );
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
            return Ok(LspStartResult {
                server_id: winner_id,
                root: root_str,
            });
        }
    }

    tracing::info!(server_id = id, language = %language, root = %root_str, "lsp server started");
    reg.servers.insert(id, srv);
    reg.by_key.insert(key, id);
    Ok(LspStartResult {
        server_id: id,
        root: root_str,
    })
}

#[tauri::command]
pub async fn lsp_send(
    state: State<'_, LspState>,
    server_id: u64,
    message: String,
) -> Result<(), String> {
    // Grab a cloned sender under the lock, then drop the guard before the
    // (potentially slow) send — a stalled child stdin must never wedge the
    // single global registry mutex for every other lsp_start/lsp_stop/lsp_send.
    let sender = {
        let reg = state.registry.lock().await;
        reg.servers
            .get(&server_id)
            .ok_or("unknown lsp server")?
            .sender()
    }; // guard dropped here
    if sender.send(message).await.is_err() {
        tracing::warn!(server_id, "lsp send dropped: server channel closed");
    }
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
