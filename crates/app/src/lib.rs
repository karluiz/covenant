//! Karl Terminal — Tauri shell.
//!
//! M0 wiring: per-session PTY backed by [`karl_pty::PtySession`]. The
//! frontend calls `spawn_session` with a [`tauri::ipc::Channel`] that
//! receives every byte the master observes; keystrokes go back via
//! `write_to_session`. Resizes, kills, and per-session output streams are
//! all keyed by [`ulid::Ulid`].
//!
//! There is no block parser or agent in M0. M1 adds OSC 133.

use std::collections::HashMap;
use std::str::FromStr;

use karl_pty::{PtySession, SpawnOptions};
use tauri::ipc::Channel;
use tauri::State;
use tokio::sync::Mutex;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use ulid::Ulid;

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<Ulid, PtySession>>,
}

fn parse_id(id: &str) -> Result<Ulid, String> {
    Ulid::from_str(id).map_err(|e| format!("invalid session id {id:?}: {e}"))
}

#[tauri::command]
async fn spawn_session(
    state: State<'_, AppState>,
    on_output: Channel<Vec<u8>>,
) -> Result<String, String> {
    let (session, mut rx) =
        PtySession::spawn(SpawnOptions::zsh_interactive()).map_err(|e| e.to_string())?;
    let id = Ulid::new();

    state.sessions.lock().await.insert(id, session);

    // Pump bytes from the dedicated reader thread out to the frontend.
    // Channel-based delivery avoids the listen-before-id race that a
    // global event would have.
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = rx.recv().await {
            if on_output.send(chunk.to_vec()).is_err() {
                tracing::debug!("output channel closed by frontend");
                break;
            }
        }
        tracing::debug!(session = %id, "output pump exiting");
    });

    Ok(id.to_string())
}

#[tauri::command]
async fn write_to_session(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let id = parse_id(&id)?;
    let mut sessions = state.sessions.lock().await;
    let session = sessions.get_mut(&id).ok_or("session not found")?;
    session.write(&data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn resize_session(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let id = parse_id(&id)?;
    let sessions = state.sessions.lock().await;
    let session = sessions.get(&id).ok_or("session not found")?;
    session.resize(cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let id = parse_id(&id)?;
    let mut sessions = state.sessions.lock().await;
    if let Some(mut s) = sessions.remove(&id) {
        let _ = s.kill();
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer().with_target(false))
        .init();

    tracing::info!("karl-terminal starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            spawn_session,
            write_to_session,
            resize_session,
            close_session,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
