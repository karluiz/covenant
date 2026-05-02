//! Karl Terminal — Tauri shell.
//!
//! M1 wiring: each session spawns the user's zsh inside a sandboxed
//! `ZDOTDIR` so we can layer our OSC 133 snippet on top of their real
//! `~/.zshrc` without ever editing user files. Bytes from the PTY are
//! fanned out via two `tauri::ipc::Channel`s — one for raw output (xterm
//! consumer) and one for typed [`karl_blocks::BlockEvent`]s (sidebar
//! consumer). The same chunks feed both; xterm.js still receives every
//! byte verbatim, the parser is purely observational.

mod cross_session;
mod fix_proposer;
mod settings;
mod summarizer;
mod world;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_pty::SpawnOptions;
use karl_session::{Session, SessionId, SessionStreams, SessionUiEvent};
use tauri::ipc::Channel;
use tauri::{Manager, State};
use tempfile::TempDir;
use tokio::sync::Mutex;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use ulid::Ulid;

use cross_session::CrossSessionWatcher;
use settings::Settings;
use world::SessionWorldModel;

/// Bundled into the binary so the app is self-contained — no need to
/// know the repo layout at runtime.
const ZSH_SNIPPET: &str = include_str!("../../../shell-integration/osc133.zsh");

/// Per-session backend state. The [`TempDir`] is held for the lifetime
/// of the session so its `.zshrc` and snippet file stay readable if zsh
/// ever re-sources them (uncommon, but cheap insurance).
struct ManagedSession {
    session: Session,
    _zdotdir: TempDir,
    world: Arc<Mutex<SessionWorldModel>>,
}

struct AppState {
    sessions: Mutex<HashMap<SessionId, ManagedSession>>,
    /// Wrapped in Arc so the per-session summarizer task can hold a
    /// long-lived reference without keeping AppState alive on its own.
    settings: Arc<Mutex<Settings>>,
    settings_path: PathBuf,
    rate: Mutex<RateLimiter>,
    cross_session: CrossSessionWatcher,
}

/// Per-session sliding-window call counter. Resets every 60s.
#[derive(Default)]
struct RateLimiter {
    by_session: HashMap<SessionId, (Instant, u32)>,
}

impl RateLimiter {
    fn check_and_increment(
        &mut self,
        session: SessionId,
        max_per_minute: u32,
    ) -> Result<(), String> {
        let now = Instant::now();
        let entry = self
            .by_session
            .entry(session)
            .or_insert((now, 0));
        if now.duration_since(entry.0) > Duration::from_secs(60) {
            entry.0 = now;
            entry.1 = 0;
        }
        if entry.1 >= max_per_minute {
            return Err(format!(
                "rate limit: max {max_per_minute} agent calls/minute per session"
            ));
        }
        entry.1 += 1;
        Ok(())
    }
}

fn parse_id(id: &str) -> Result<SessionId, String> {
    Ulid::from_str(id)
        .map(SessionId)
        .map_err(|e| format!("invalid session id {id:?}: {e}"))
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
    on_session_event: Channel<SessionUiEvent>,
) -> Result<String, String> {
    let zdotdir = build_zdotdir().map_err(|e| format!("zdotdir setup: {e}"))?;
    let mut opts = SpawnOptions::zsh_interactive();
    opts.args.push("--no-globalrcs".to_string());
    opts.env
        .push(("ZDOTDIR".to_string(), zdotdir.path().display().to_string()));

    let (session, streams) = Session::spawn(opts).map_err(|e| e.to_string())?;
    let id = session.id;
    let id_str = id.to_string();
    let bus_tx = session.event_sender();

    // World model: subscribed to the session bus before insertion so
    // we don't miss BlockSubmitted/BlockFinished events for the very
    // first command.
    let world = Arc::new(Mutex::new(SessionWorldModel::default()));
    let world_for_task = world.clone();
    let mut world_bus = session.subscribe();
    tokio::spawn(async move {
        loop {
            match world_bus.recv().await {
                Ok(event) => world_for_task.lock().await.apply(event),
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, "world model lagged on bus");
                }
            }
        }
    });

    // Summarizer: independently subscribed to the same bus, debounces
    // BlockFinished events and calls Sonnet to refresh world.summary.
    summarizer::spawn_loop(
        id,
        world.clone(),
        state.settings.clone(),
        session.subscribe(),
    );

    // Fix-proposer: on every non-zero BlockFinished, asks Sonnet for a
    // one-line shell fix and republishes it as SessionEvent::FixSuggested.
    fix_proposer::spawn_loop(
        id,
        state.settings.clone(),
        session.subscribe(),
        bus_tx,
    );

    // Cross-session watcher: forwards this session's bus into the
    // global pump so M5 patterns across all open tabs can be detected.
    state
        .cross_session
        .attach(id, world.clone(), session.subscribe())
        .await;

    state
        .sessions
        .lock()
        .await
        .insert(id, ManagedSession {
            session,
            _zdotdir: zdotdir,
            world,
        });

    // Pump 1: raw PTY bytes to xterm.
    let SessionStreams { mut raw_bytes } = streams;
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = raw_bytes.recv().await {
            if on_output.send(chunk.to_vec()).is_err() {
                tracing::debug!("output channel closed by frontend");
                break;
            }
        }
    });

    // Pump 2: bus → UI relay. Drops Opened/Closed and the heavy
    // BlockFinished.output_text via SessionEvent::to_ui().
    let mut ui_bus = state
        .sessions
        .lock()
        .await
        .get(&id)
        .ok_or("session vanished before relay setup")?
        .session
        .subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match ui_bus.recv().await {
                Ok(event) => {
                    if let Some(ui) = event.to_ui() {
                        if on_session_event.send(ui).is_err() {
                            tracing::debug!("session-event channel closed");
                            return;
                        }
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, "ui relay lagged");
                }
            }
        }
    });

    Ok(id_str)
}

#[tauri::command]
async fn write_to_session(
    state: State<'_, AppState>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let id = parse_id(&id)?;
    let mut sessions = state.sessions.lock().await;
    let managed = sessions.get_mut(&id).ok_or("session not found")?;
    managed.session.write(&data).map_err(|e| e.to_string())
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
    let managed = sessions.get(&id).ok_or("session not found")?;
    managed.session.resize(cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
async fn close_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let id = parse_id(&id)?;
    let mut sessions = state.sessions.lock().await;
    if let Some(mut managed) = sessions.remove(&id) {
        let _ = managed.session.kill();
    }
    Ok(())
}

/// Type a command into the PTY *without* a trailing newline. The user
/// reviews and presses Enter to execute. Used by the M4 fix-suggestion
/// click path — SuggestOnly policy means we never auto-submit.
#[tauri::command]
async fn inject_command(
    state: State<'_, AppState>,
    id: String,
    command: String,
) -> Result<(), String> {
    let id = parse_id(&id)?;
    let mut sessions = state.sessions.lock().await;
    let managed = sessions.get_mut(&id).ok_or("session not found")?;
    managed
        .session
        .write(command.as_bytes())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().await.clone())
}

#[tauri::command]
async fn set_settings(
    state: State<'_, AppState>,
    settings: Settings,
) -> Result<(), String> {
    settings::save(&state.settings_path, &settings).map_err(|e| e.to_string())?;
    *state.settings.lock().await = settings;
    Ok(())
}

const SYSTEM_PROMPT: &str = "\
You are the super-agent for Karl Terminal, a macOS terminal emulator. \
The user is operating one or more shell sessions; you observe their \
activity through a world model and answer questions about what they're \
doing.

Be terse and technical. Reference specific commands, exit codes, and \
files when relevant. Don't restate what's obvious from the world model. \
When uncertain, say so briefly. No filler — go straight to the answer. \
Plain text only (no markdown, no code fences).";

#[tauri::command]
async fn ask_agent(
    state: State<'_, AppState>,
    session_id: String,
    question: String,
    on_token: Channel<String>,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;

    // 1. Read settings (clone so we don't hold the lock across the http call).
    let (api_key, model_chat, max_per_min) = {
        let s = state.settings.lock().await;
        let key = s
            .anthropic_api_key
            .clone()
            .ok_or("no api key configured — open Settings (⌘,)")?;
        (key, s.agent.model_chat.clone(), s.agent.max_calls_per_minute)
    };

    // 2. Rate limit (per session).
    state
        .rate
        .lock()
        .await
        .check_and_increment(id, max_per_min)?;

    // 3. Snapshot the world model for this session and render to a
    //    user-message string.
    let user_message = {
        let sessions = state.sessions.lock().await;
        let managed = sessions.get(&id).ok_or("session not found")?;
        let world = managed.world.lock().await;
        world.render_user_message(&question)
    };

    // 4. Stream the response. Forward each delta through the Channel;
    //    return when the stream ends.
    let req = karl_agent::AskRequest {
        api_key,
        model: model_chat,
        system_prompt: SYSTEM_PROMPT.to_string(),
        user_message,
        max_tokens: 1024,
    };

    karl_agent::ask_streaming(req, move |event| match event {
        karl_agent::AgentEvent::Delta(text) => {
            let _ = on_token.send(text);
        }
        karl_agent::AgentEvent::Done => {
            // Promise resolution on the JS side signals end-of-stream.
        }
    })
    .await
    .map_err(|e| e.to_string())?;

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
        .setup(|app| {
            // app_config_dir on macOS resolves to
            //   ~/Library/Application Support/<bundle identifier>/
            // Tauri creates the directory lazily — settings::save handles
            // the mkdir on first save.
            let dir = app
                .path()
                .app_config_dir()
                .map_err(|e| format!("resolve app_config_dir: {e}"))?;
            let path = dir.join("config.json");
            let loaded = settings::load(&path);
            tracing::info!(path = %path.display(), "settings loaded");

            let settings_arc = Arc::new(Mutex::new(loaded));
            let cross = CrossSessionWatcher::spawn(app.handle().clone(), settings_arc.clone());

            app.manage(AppState {
                sessions: Mutex::new(HashMap::new()),
                settings: settings_arc,
                settings_path: path,
                rate: Mutex::new(RateLimiter::default()),
                cross_session: cross,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_session,
            write_to_session,
            resize_session,
            close_session,
            inject_command,
            get_settings,
            set_settings,
            ask_agent,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
