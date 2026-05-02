//! Karl Terminal — Tauri shell.
//!
//! M1 wiring: each session spawns the user's zsh inside a sandboxed
//! `ZDOTDIR` so we can layer our OSC 133 snippet on top of their real
//! `~/.zshrc` without ever editing user files. Bytes from the PTY are
//! fanned out via two `tauri::ipc::Channel`s — one for raw output (xterm
//! consumer) and one for typed [`karl_blocks::BlockEvent`]s (sidebar
//! consumer). The same chunks feed both; xterm.js still receives every
//! byte verbatim, the parser is purely observational.

use std::collections::HashMap;
use std::path::Path;
use std::str::FromStr;

use karl_blocks::{BlockEvent, BlockParser};
use karl_pty::{PtySession, SpawnOptions};
use tauri::ipc::Channel;
use tauri::State;
use tempfile::TempDir;
use tokio::sync::Mutex;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use ulid::Ulid;

/// Bundled into the binary so the app is self-contained — no need to
/// know the repo layout at runtime.
const ZSH_SNIPPET: &str = include_str!("../../../shell-integration/osc133.zsh");

/// Per-session backend state. The [`TempDir`] is held for the lifetime
/// of the session so its `.zshrc` and snippet file stay readable if zsh
/// ever re-sources them (uncommon, but cheap insurance).
struct ManagedSession {
    pty: PtySession,
    _zdotdir: TempDir,
}

#[derive(Default)]
struct AppState {
    sessions: Mutex<HashMap<Ulid, ManagedSession>>,
}

fn parse_id(id: &str) -> Result<Ulid, String> {
    Ulid::from_str(id).map_err(|e| format!("invalid session id {id:?}: {e}"))
}

/// Materialize a private ZDOTDIR holding shim files that re-source the
/// user's real dotfiles before layering our OSC 133 snippet on top:
///
///   - `.zshenv`:    sources `$HOME/.zshenv` if it exists (zsh skips it
///                   when ZDOTDIR is set, so we have to chain it).
///   - `.zprofile`:  sources `$HOME/.zprofile` (login-shell env).
///   - `.zshrc`:     sources `$HOME/.zshrc`, then our snippet last so
///                   Starship/p10k precmds are already registered.
///   - `osc133.zsh`: bundled copy of the snippet.
///
/// Effect: zsh boots with the user's prompt, aliases, plugins, and
/// history config intact; karl's hooks are appended after the prompt
/// framework has done its precmd setup.
fn build_zdotdir() -> Result<TempDir, std::io::Error> {
    let dir = tempfile::Builder::new().prefix("karl-zdotdir-").tempdir()?;

    let snippet_path = dir.path().join("osc133.zsh");
    std::fs::write(&snippet_path, ZSH_SNIPPET)?;

    std::fs::write(
        dir.path().join(".zshenv"),
        "[ -f \"$HOME/.zshenv\" ] && source \"$HOME/.zshenv\"\n",
    )?;
    std::fs::write(
        dir.path().join(".zprofile"),
        "[ -f \"$HOME/.zprofile\" ] && source \"$HOME/.zprofile\"\n",
    )?;
    std::fs::write(
        dir.path().join(".zshrc"),
        format!(
            "[ -f \"$HOME/.zshrc\" ] && source \"$HOME/.zshrc\"\n\
             source {}\n",
            shell_quote(&snippet_path),
        ),
    )?;

    Ok(dir)
}

/// Single-quote a path for zsh source. Safe against spaces and most
/// special chars; escapes embedded single quotes by closing-and-reopening.
fn shell_quote(p: &Path) -> String {
    let s = p.display().to_string();
    let escaped = s.replace('\'', "'\\''");
    format!("'{escaped}'")
}

#[tauri::command]
async fn spawn_session(
    state: State<'_, AppState>,
    on_output: Channel<Vec<u8>>,
    on_block_event: Channel<BlockEvent>,
) -> Result<String, String> {
    let zdotdir = build_zdotdir().map_err(|e| format!("zdotdir setup: {e}"))?;
    let mut opts = SpawnOptions::zsh_interactive();
    opts.args.push("--no-globalrcs".to_string());
    opts.env
        .push(("ZDOTDIR".to_string(), zdotdir.path().display().to_string()));

    let (pty, mut rx) = PtySession::spawn(opts).map_err(|e| e.to_string())?;
    let id = Ulid::new();

    state
        .sessions
        .lock()
        .await
        .insert(id, ManagedSession { pty, _zdotdir: zdotdir });

    // Single pump: drains the PTY reader's mpsc, fans out to xterm.js
    // via on_output, parses for BlockEvents in parallel via on_block_event.
    tauri::async_runtime::spawn(async move {
        let mut parser = BlockParser::new();
        while let Some(chunk) = rx.recv().await {
            // 1. Raw bytes to xterm.js. If the channel's gone the
            //    frontend has unmounted; stop pumping.
            if on_output.send(chunk.to_vec()).is_err() {
                tracing::debug!("output channel closed by frontend");
                break;
            }
            // 2. Same bytes through the OSC 133 parser. Block events go
            //    on a separate channel; failures here don't kill the
            //    output stream.
            for event in parser.feed(&chunk) {
                if on_block_event.send(event).is_err() {
                    tracing::debug!("block event channel closed");
                    break;
                }
            }
        }
        tracing::debug!(session = %id, "session pump exiting");
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
    session.pty.write(&data).map_err(|e| e.to_string())
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
    session.pty.resize(cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let id = parse_id(&id)?;
    let mut sessions = state.sessions.lock().await;
    if let Some(mut s) = sessions.remove(&id) {
        let _ = s.pty.kill();
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
