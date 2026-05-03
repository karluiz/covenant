//! Covenant — AI-coordinated terminal.
//!
//! Each session spawns the user's zsh inside a sandboxed `ZDOTDIR` so
//! we can layer our OSC 133 snippet on top of their real `~/.zshrc`
//! without ever editing user files. Bytes from the PTY are fanned out
//! via Tauri Channels — raw output to xterm, typed
//! `karl_session::SessionUiEvent`s to the sidebar — while the same
//! stream feeds the world model, summarizer, fix-proposer, cross-session
//! watcher, and (M-OP) the Operator that answers executor agents on
//! the user's behalf.

mod aom;
mod context;
mod drafts;
pub mod convergence;
mod cost;
mod cross_session;
mod fix_proposer;
mod history_import;
mod mission_persistence;
mod notify;
mod operator;
mod safety;
mod settings;
mod storage;
mod structure;
mod summarizer;
mod tab_manifest;
mod world;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_pty::SpawnOptions;
use karl_session::{Session, SessionId, SessionStreams, SessionUiEvent};
use tauri::ipc::Channel;
use tauri::{Emitter, Manager, State};
use tempfile::TempDir;
use tokio::sync::Mutex;
use tracing_subscriber::{fmt, prelude::*, EnvFilter};
use ulid::Ulid;

use aom::{AomHandle, AomStatus};
use context::{ContextCache, DirContext};
use cross_session::CrossSessionWatcher;
use notify::{Notifier, Trigger};
use operator::{OperatorState, OperatorWatcher};
use settings::Settings;
use storage::{AomReport, HistoricalBlock, OperatorDecisionRow, RecallMatch, Storage};
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
    op_state: Arc<std::sync::Mutex<OperatorState>>,
}

pub(crate) struct AppState {
    pub(crate) sessions: Mutex<HashMap<SessionId, ManagedSession>>,
    /// Wrapped in Arc so the per-session summarizer task can hold a
    /// long-lived reference without keeping AppState alive on its own.
    settings: Arc<Mutex<Settings>>,
    settings_path: PathBuf,
    rate: Mutex<RateLimiter>,
    cross_session: CrossSessionWatcher,
    operator: OperatorWatcher,
    storage: Storage,
    /// Autonomous Operator Mode global toggle. Read by the operator
    /// tick on every poll; flipped by `aom_start` / `aom_stop`.
    aom: AomHandle,
    /// Path to the tab manifest JSON. Read once at boot, written
    /// (debounced) every time the user reorders/renames/colors/etc.
    tab_manifest_path: PathBuf,
    /// 3.7 status-bar — git/runtime detection cache shared across all
    /// `get_dir_context` calls. Tiny LRU, 5s TTL, no fs watcher.
    dir_context_cache: Arc<ContextCache>,
    /// 3.6 OS notifications — fires native macOS popups for
    /// ESCALATE / AOM error / AOM complete with throttle + setting
    /// gating. Cloned into the operator watcher so its tick can emit
    /// without reaching back through AppState.
    notifier: Notifier,
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
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    on_output: Channel<Vec<u8>>,
    on_session_event: Channel<SessionUiEvent>,
    initial_cwd: Option<String>,
) -> Result<String, String> {
    let zdotdir = build_zdotdir().map_err(|e| format!("zdotdir setup: {e}"))?;
    let mut opts = SpawnOptions::zsh_interactive();
    opts.args.push("--no-globalrcs".to_string());
    opts.env
        .push(("ZDOTDIR".to_string(), zdotdir.path().display().to_string()));
    // Persistence-restored cwd is set HERE (before spawn) instead of
    // injected as `cd <path>\r` after the first prompt. portable-pty
    // launches the shell directly in this directory — no visible
    // typed line, no bogus block in the sidebar. We validate the
    // path exists; if it's gone (cleaned-up dir) fall back to $HOME.
    if let Some(cwd) = initial_cwd {
        let p = std::path::PathBuf::from(&cwd);
        if p.is_dir() {
            opts.cwd = Some(p);
        } else {
            tracing::warn!(cwd, "restored cwd no longer exists, falling back to $HOME");
        }
    }

    let (session, streams) = Session::spawn(opts).map_err(|e| e.to_string())?;
    let id = session.id;
    let id_str = id.to_string();
    let bus_tx = session.event_sender();

    // Persist the session row immediately so block FK references resolve.
    let started_unix_ms = now_unix_ms();
    if let Err(e) = state.storage.save_session(id, started_unix_ms).await {
        tracing::warn!(session = %id, error = %e, "failed to persist session row");
    }

    // World model: subscribed to the session bus before insertion so
    // we don't miss BlockSubmitted/BlockFinished events for the very
    // first command. Also persists every BlockFinished to SQLite so
    // closing the app doesn't lose history.
    let world = Arc::new(Mutex::new(SessionWorldModel::default()));
    let world_for_task = world.clone();
    let storage_for_world = state.storage.clone();
    let operator_for_world = state.operator.clone();
    let app_for_world = app.clone();
    let mut world_bus = session.subscribe();
    tauri::async_runtime::spawn(async move {
        loop {
            match world_bus.recv().await {
                Ok(event) => {
                    // Persist BEFORE applying — keeps the in-memory and
                    // on-disk views consistent if a panic happens mid-apply.
                    if let karl_session::SessionEvent::BlockFinished {
                        block,
                        command,
                        cwd,
                        exit_code,
                        duration_ms,
                        output_text,
                        ..
                    } = &event
                    {
                        let cwd_str = if cwd.as_os_str().is_empty() {
                            None
                        } else {
                            Some(cwd.display().to_string())
                        };
                        if let Err(e) = storage_for_world
                            .save_block(
                                *block,
                                id,
                                command.clone(),
                                cwd_str,
                                *exit_code,
                                *duration_ms,
                                now_unix_ms(),
                                truncate_for_persist(output_text),
                            )
                            .await
                        {
                            tracing::warn!(error = %e, "save_block failed");
                        }
                    }
                    // Mission auto-restore hook: when this session
                    // walks into a directory we've seen with a saved
                    // mission before, the operator picks it up.
                    if let karl_session::SessionEvent::CwdChanged { cwd, .. } = &event
                    {
                        let cwd_str = cwd.display().to_string();
                        operator_for_world
                            .notify_cwd_changed(id, &cwd_str, &app_for_world)
                            .await;
                    }
                    world_for_task.lock().await.apply(event);
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, "world model lagged on bus");
                }
            }
        }
    });

    // Summarizer: independently subscribed to the same bus, debounces
    // BlockFinished events and calls Sonnet to refresh world.summary.
    // Also persists each new summary to disk via the shared Storage.
    summarizer::spawn_loop(
        id,
        world.clone(),
        state.settings.clone(),
        state.storage.clone(),
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

    let op_state = Arc::new(std::sync::Mutex::new(OperatorState::new()));

    // Hook the operator watcher BEFORE inserting into the session map
    // so the very first BlockSubmitted is visible.
    //
    // AOM-active edge case: when the user opens a NEW tab while AOM is
    // already running, the new tab is for fresh manual work — not for
    // AOM to start typing into. Default `aom_excluded = true` so the
    // tab joins AOM only if the user explicitly toggles it via the
    // context menu. Tabs spawned BEFORE AOM started keep their
    // included-by-default posture (they were swept by `aom_start` →
    // `enable_all_for_aom` and `clear_all_aom_excluded`).
    let aom_active_now = state.aom.read().await.enabled;
    state
        .operator
        .attach(
            id,
            op_state.clone(),
            world.clone(),
            state.settings.lock().await.operator.enabled_default,
            aom_active_now,
        )
        .await;

    state
        .sessions
        .lock()
        .await
        .insert(id, ManagedSession {
            session,
            _zdotdir: zdotdir,
            world,
            op_state: op_state.clone(),
        });

    // Pump 1: raw PTY bytes to xterm. Also feeds the operator's tail
    // buffer so it knows what the executor last printed when checking
    // for a stuck prompt.
    let SessionStreams { mut raw_bytes } = streams;
    let op_state_for_pump = op_state.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = raw_bytes.recv().await {
            if let Ok(mut st) = op_state_for_pump.lock() {
                st.observe(&chunk);
            }
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
    state.operator.detach(id).await;
    let mut sessions = state.sessions.lock().await;
    if let Some(mut managed) = sessions.remove(&id) {
        let _ = managed.session.kill();
    }
    if let Err(e) = state.storage.close_session(id, now_unix_ms()).await {
        tracing::warn!(session = %id, error = %e, "close_session persist failed");
    }
    Ok(())
}

#[tauri::command]
async fn set_operator_enabled(
    state: State<'_, AppState>,
    session_id: String,
    enabled: bool,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    state.operator.set_enabled(id, enabled).await;
    tracing::info!(session = %id, enabled, "operator toggled");
    Ok(())
}

#[tauri::command]
async fn is_operator_enabled(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.is_enabled(id).await)
}

/// Per-session live-mode toggle (M-OP3). Live = the Operator actually
/// types replies into the PTY (after passing the safety blocklist),
/// instead of just logging proposed decisions. Requires `enabled=true`
/// to take effect — both must be on for any byte to be injected.
#[tauri::command]
async fn set_operator_live(
    state: State<'_, AppState>,
    session_id: String,
    live: bool,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    state.operator.set_live(id, live).await;
    Ok(())
}

#[tauri::command]
async fn is_operator_live(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.is_live(id).await)
}

/// Mission spec attached to a session. The Operator reads the spec
/// content as authoritative scope: Out of scope → escalate triggers;
/// File boundaries → constraints; Open questions → auto-escalate.
#[tauri::command]
async fn set_session_mission(
    state: State<'_, AppState>,
    session_id: String,
    spec_path: String,
) -> Result<operator::MissionInfo, String> {
    let id = parse_id(&session_id)?;
    let path = PathBuf::from(spec_path);
    state.operator.set_mission(id, path).await
}

#[tauri::command]
async fn clear_session_mission(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    state.operator.clear_mission(id).await;
    Ok(())
}

#[tauri::command]
async fn get_session_mission(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<operator::MissionInfo>, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.get_mission(id).await)
}

/// Full mission spec content for the viewer modal. Returns null when
/// no mission is set on the session.
#[tauri::command]
async fn get_session_mission_content(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.get_mission_content(id).await)
}

/// Persist a new mission spec body from the viewer modal. Refuses
/// while AOM is active (the Operator is reading the spec on every
/// tick — editing it mid-run would surface inconsistent behavior
/// silently). On a successful save we re-emit `mission-changed` so
/// every other tab sharing the file refreshes its tooltip / preview.
#[tauri::command]
async fn set_session_mission_content(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    session_id: String,
    content: String,
    expected_mtime_unix_ms: u64,
) -> Result<operator::MissionSaveResult, String> {
    if state.aom.read().await.enabled {
        return Err("aom_active".to_string());
    }
    let id = parse_id(&session_id)?;
    let result = state
        .operator
        .set_mission_content(id, content, expected_mtime_unix_ms)
        .await?;
    if let operator::MissionSaveResult::Saved { ref info } = result {
        let _ = app.emit(
            "mission-changed",
            serde_json::json!({
                "session_id": session_id,
                "path": info.path,
            }),
        );
    }
    Ok(result)
}

/// Per-tab AOM opt-out. When AOM is on, an excluded tab keeps its
/// per-tab live setting + normal persona instead of inheriting the
/// AOM act-by-default posture. Reset to false on every aom_start.
#[tauri::command]
async fn set_aom_excluded(
    state: State<'_, AppState>,
    session_id: String,
    excluded: bool,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    state.operator.set_aom_excluded(id, excluded).await;
    Ok(())
}

#[tauri::command]
async fn is_aom_excluded(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.is_aom_excluded(id).await)
}

#[derive(Debug, serde::Serialize)]
struct AutosuggestStatus {
    /// True when the plugin is present at one of the well-known
    /// locations our shell snippet probes. False is a reliable
    /// "missing" — the user can still have it loaded via some other
    /// path, but we'd then have shown the hint unnecessarily, which
    /// is the safer failure mode.
    found: bool,
    /// First matching path, for diagnostics / UI affordance.
    path: Option<String>,
}

/// Mirror of the path list in `shell-integration/osc133.zsh`. Kept in
/// lockstep so the UI's "installed?" status matches what zsh actually
/// sources. If you add a path here, add it there (and vice versa).
fn known_autosuggest_paths() -> Vec<PathBuf> {
    let home = std::env::var("HOME").unwrap_or_default();
    let zsh = std::env::var("ZSH").unwrap_or_else(|_| format!("{home}/.oh-my-zsh"));
    let zsh_custom = std::env::var("ZSH_CUSTOM")
        .unwrap_or_else(|_| format!("{home}/.oh-my-zsh/custom"));
    vec![
        PathBuf::from("/opt/homebrew/share/zsh-autosuggestions/zsh-autosuggestions.zsh"),
        PathBuf::from("/usr/local/share/zsh-autosuggestions/zsh-autosuggestions.zsh"),
        PathBuf::from(format!(
            "{zsh_custom}/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
        )),
        PathBuf::from(format!(
            "{zsh}/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
        )),
        PathBuf::from(format!(
            "{home}/.zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"
        )),
        PathBuf::from(format!(
            "{home}/.local/share/zsh-autosuggestions/zsh-autosuggestions.zsh"
        )),
        PathBuf::from("/usr/share/zsh-autosuggestions/zsh-autosuggestions.zsh"),
        PathBuf::from("/usr/share/zsh/plugins/zsh-autosuggestions/zsh-autosuggestions.zsh"),
    ]
}

#[tauri::command]
fn zsh_autosuggestions_status() -> AutosuggestStatus {
    for p in known_autosuggest_paths() {
        if p.exists() {
            return AutosuggestStatus {
                found: true,
                path: Some(p.display().to_string()),
            };
        }
    }
    AutosuggestStatus {
        found: false,
        path: None,
    }
}

/// AOM (Autonomous Operator Mode) — global toggle.
///
/// `aom_status` returns the current state. `aom_start` flips it on,
/// resets the per-session decision counter, and stamps the start
/// time. `aom_stop` flips it off; the started_at timestamp is left
/// untouched so the UI can show "ran for 3h 14m" even after stop.
///
/// All three return the resulting AomStatus so the caller can update
/// its banner in one round trip.
#[tauri::command]
async fn aom_status(state: State<'_, AppState>) -> Result<AomStatus, String> {
    Ok(AomStatus::from(&*state.aom.read().await))
}

#[tauri::command]
async fn aom_start(state: State<'_, AppState>) -> Result<AomStatus, String> {
    // Read budget from settings ONCE at start time so a mid-session
    // settings change doesn't shift the cap underneath the user.
    let budget = state.settings.lock().await.aom.default_budget_usd;
    // Fresh AOM session = fresh per-tab exclusions. Saves the user
    // from the "I don't remember which tabs I excluded last time"
    // foot-gun on a new sleep period.
    state.operator.clear_all_aom_excluded().await;
    // M-OP5 UX fix: AOM is "one button does it all". Auto-enable
    // Operator on every tab that doesn't already have it. We track
    // which tabs we touched so `aom_stop` reverts exactly them
    // (manually enabled tabs keep their user choice). The frontend
    // refreshes per-tab state after the toggle resolves.
    let _auto_enabled = state.operator.enable_all_for_aom().await;
    // Queue proactive startup actions: claude /rename, bypass-exit,
    // etc. These fire later in run_tick when conditions are met.
    state.operator.queue_aom_startup_actions().await;
    let started_at = now_unix_ms();

    // Persist the AOM session row so the morning report has a window
    // boundary to filter operator_decisions against. Failure here
    // doesn't block AOM — it just means no report row for this run.
    let row_id = match state.storage.aom_session_start(started_at, budget).await {
        Ok(id) => Some(id),
        Err(e) => {
            tracing::warn!(error = %e, "aom_session_start: persistence failed");
            None
        }
    };

    let mut s = state.aom.write().await;
    s.enabled = true;
    s.started_at_unix_ms = started_at;
    s.decisions_count = 0;
    s.budget_usd = budget;
    s.accumulated_cost_usd = 0.0;
    s.cost_cap_hit_at_unix_ms = None;
    s.current_session_row_id = row_id;
    tracing::info!(budget_usd = budget, row_id = ?row_id, "AOM started");
    Ok(AomStatus::from(&*s))
}

/// Morning report — aggregate digest of the most recent AOM session.
/// `Ok(None)` if AOM has never been started on this DB.
#[tauri::command]
async fn aom_report(state: State<'_, AppState>) -> Result<Option<AomReport>, String> {
    state
        .storage
        .aom_session_latest_report()
        .await
        .map_err(|e| e.to_string())
}

/// 3.8 Convergence Mode — one snapshot per UI poll (1 Hz). Read-only
/// aggregator over existing handles; no schema changes.
#[tauri::command]
async fn get_convergence_snapshot(
    state: State<'_, AppState>,
) -> Result<convergence::ConvergenceSnapshot, String> {
    let inputs: Vec<convergence::SessionInput> = {
        let sessions = state.sessions.lock().await;
        sessions
            .iter()
            .map(|(id, ms)| convergence::SessionInput {
                session_id: *id,
                op_state: ms.op_state.clone(),
            })
            .collect()
    };
    Ok(convergence::build_convergence_snapshot(
        inputs,
        &state.operator,
        &state.storage,
        &state.aom,
    )
    .await)
}

#[tauri::command]
async fn aom_stop(state: State<'_, AppState>) -> Result<AomStatus, String> {
    // Snapshot the row id + final stats under the write lock, then
    // release it before doing any storage I/O.
    let (row_id, accum, decisions, cap_hit, status) = {
        let mut s = state.aom.write().await;
        s.enabled = false;
        let row_id = s.current_session_row_id;
        let accum = s.accumulated_cost_usd;
        let decisions = s.decisions_count;
        let cap_hit = s.cost_cap_hit_at_unix_ms;
        s.current_session_row_id = None;
        (row_id, accum, decisions, cap_hit, AomStatus::from(&*s))
    };

    if let Some(id) = row_id {
        if let Err(e) = state
            .storage
            .aom_session_finish(id, now_unix_ms(), accum, decisions, cap_hit)
            .await
        {
            tracing::warn!(error = %e, "aom_session_finish failed");
        }
    }

    // Revert the auto-enables done at aom_start. Tabs the user
    // enabled manually (or that already had Operator on) stay on.
    let _reverted = state.operator.disable_aom_auto_enabled().await;

    // 3.6: surface a "you can come back now" notification after a
    // user-initiated stop. Budget-hit stops fire the AomError trigger
    // from the operator tick instead — those are the same physical
    // event but the user-facing meaning is different.
    let body = format!(
        "Spent ${accum:.2} over {decisions} decisions.",
        accum = accum,
        decisions = decisions,
    );
    state
        .notifier
        .emit(Trigger::AomComplete, "AOM finished", body, None)
        .await;

    tracing::info!(decisions, "AOM stopped");
    Ok(status)
}

/// Recent blocks that ran in `cwd` across sessions. Used by the
/// BlockManager sidebar to surface "what was I doing here" when a
/// restored tab lands in the same directory.
#[derive(serde::Serialize)]
struct HistoricalBlockRow {
    session_id_short: String,
    command: String,
    exit_code: Option<i32>,
    duration_ms: u64,
    finished_at_unix_ms: u64,
}

#[tauri::command]
async fn recent_blocks_by_cwd(
    state: State<'_, AppState>,
    cwd: String,
    limit: u32,
) -> Result<Vec<HistoricalBlockRow>, String> {
    let rows = state
        .storage
        .recent_blocks_by_cwd(cwd, limit.clamp(1, 200))
        .await
        .map_err(|e| e.to_string())?;
    Ok(rows
        .into_iter()
        .map(|b| HistoricalBlockRow {
            session_id_short: b.session_id_short,
            command: b.command,
            exit_code: b.exit_code,
            duration_ms: b.duration_ms,
            finished_at_unix_ms: b.finished_at_unix_ms,
        })
        .collect())
}

/// Tab persistence — frontend's TabManager owns the schema; backend
/// just stores the raw JSON blob. `Ok(None)` means first run / cleared.
#[tauri::command]
async fn tab_manifest_load(
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    tab_manifest::load(&state.tab_manifest_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn tab_manifest_save(
    state: State<'_, AppState>,
    body: String,
) -> Result<(), String> {
    tab_manifest::save(&state.tab_manifest_path, &body).map_err(|e| e.to_string())
}

/// Recall: search the persisted block history for commands matching
/// `query`, ranked by frequency × recency with cwd / success bonuses.
/// Empty query → most-recent distinct commands. `cwd` is optional;
/// when provided, commands previously run there get a score boost.
#[tauri::command]
async fn recall_search(
    state: State<'_, AppState>,
    query: String,
    cwd: Option<String>,
    limit: u32,
) -> Result<Vec<RecallMatch>, String> {
    state
        .storage
        .recall_search(query, cwd, limit.clamp(1, 100))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_operator_decisions(
    state: State<'_, AppState>,
    limit: u32,
) -> Result<Vec<OperatorDecisionRow>, String> {
    state
        .storage
        .list_operator_decisions(limit.clamp(1, 500))
        .await
        .map_err(|e| e.to_string())
}

/// One-shot Recall seeding from `~/.zsh_history`.
///
/// Skipped when `settings.zsh_history_imported_at_unix_ms` is already
/// set — Recall is meant to grow from the user's actual usage; we
/// only seed the empty case. Runs in a detached task so startup
/// stays snappy regardless of history file size.
fn maybe_import_zsh_history(
    storage: Storage,
    settings: Arc<Mutex<Settings>>,
    settings_path: PathBuf,
) {
    // Tauri's `setup` callback runs before tokio's runtime is bound to
    // the current thread, so `tokio::spawn` panics with "no reactor
    // running". `tauri::async_runtime::spawn` resolves to the right
    // executor regardless of context.
    tauri::async_runtime::spawn(async move {
        // Cheap pre-check: if the user already imported, skip without
        // touching disk.
        if settings.lock().await.zsh_history_imported_at_unix_ms.is_some() {
            return;
        }

        let Ok(home) = std::env::var("HOME") else {
            tracing::warn!("$HOME unset — skipping zsh history import");
            return;
        };
        let path = PathBuf::from(home).join(".zsh_history");
        if !path.exists() {
            tracing::info!("no ~/.zsh_history — skipping import");
            // Still mark as done so we don't re-check every launch.
            mark_imported(&settings, &settings_path).await;
            return;
        }

        let now = now_unix_ms();
        let entries = match tokio::task::spawn_blocking(move || {
            history_import::read_and_parse(&path, now, 5_000)
        })
        .await
        {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => {
                tracing::warn!(error = %e, "failed to read ~/.zsh_history");
                return;
            }
            Err(e) => {
                tracing::warn!(error = %e, "history import join failed");
                return;
            }
        };

        let count = entries.len();
        match storage.import_zsh_history(entries).await {
            Ok(inserted) => {
                tracing::info!(
                    parsed = count,
                    inserted,
                    "imported ~/.zsh_history into Recall"
                );
                mark_imported(&settings, &settings_path).await;
            }
            Err(e) => {
                tracing::warn!(error = %e, "zsh history import failed");
            }
        }
    });
}

/// Best-effort permission pre-warm. Tauri's notification plugin will
/// also request lazily on first `show()`, but doing it once at boot
/// surfaces the OS prompt at a calm moment instead of mid-escalation.
fn request_notification_permission_async(notifier: Notifier) {
    use tauri::plugin::PermissionState;
    use tauri_plugin_notification::NotificationExt;
    tauri::async_runtime::spawn(async move {
        let app = notifier.app_handle();
        match app.notification().permission_state() {
            Ok(PermissionState::Prompt) | Ok(PermissionState::PromptWithRationale) => {
                if let Err(e) = app.notification().request_permission() {
                    tracing::warn!(error = %e, "request_notification_permission failed");
                }
            }
            Ok(_) => {}
            Err(e) => tracing::warn!(error = %e, "permission_state read failed"),
        }
    });
}

async fn mark_imported(settings: &Arc<Mutex<Settings>>, path: &Path) {
    let mut s = settings.lock().await;
    s.zsh_history_imported_at_unix_ms = Some(now_unix_ms());
    if let Err(e) = settings::save(path, &s) {
        tracing::warn!(error = %e, "failed to persist zsh-history-imported flag");
    }
}

fn now_unix_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Cap persisted output_text so a runaway `cat /dev/urandom | head -c 1G`
/// can't bloat the DB. The agent gets the truncated version too.
fn truncate_for_persist(s: &str) -> String {
    const MAX: usize = 64 * 1024;
    if s.len() <= MAX {
        s.to_string()
    } else {
        format!(
            "{}\n[...truncated, original {} bytes]",
            &s[..MAX],
            s.len()
        )
    }
}

/// Render historical cross-session blocks as a compact prompt section.
/// Newest first, with a relative-time label so the model can reason
/// about recency ("3h ago", "2d ago"). No output_text — keeps tokens
/// bounded; the agent can ask follow-ups if it wants more detail.
fn render_history_section(blocks: &[HistoricalBlock]) -> String {
    let mut out = String::with_capacity(2048);
    out.push_str("\n# Historical activity (other sessions, newest first)\n");
    let now_ms = now_unix_ms();
    for b in blocks {
        let age = humanize_age(now_ms.saturating_sub(b.finished_at_unix_ms));
        let exit = b
            .exit_code
            .map(|c| c.to_string())
            .unwrap_or_else(|| "?".to_string());
        let cwd = b
            .cwd
            .as_deref()
            .map(|c| format!(" cwd={}", short_cwd(c)))
            .unwrap_or_default();
        out.push_str(&format!(
            "$ {cmd}    [tab …{sid}, exit {exit}, {dur}ms, {age}{cwd}]\n",
            cmd = b.command,
            sid = b.session_id_short,
            dur = b.duration_ms,
        ));
    }
    out
}

fn humanize_age(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        format!("{s}s ago")
    } else if s < 3600 {
        format!("{}m ago", s / 60)
    } else if s < 86_400 {
        format!("{}h ago", s / 3600)
    } else {
        format!("{}d ago", s / 86_400)
    }
}

fn short_cwd(p: &str) -> String {
    // Crude HOME compaction; we don't have HOME at hand here so try the
    // common /Users/<x>/ shape macOS gives us.
    if let Some(rest) = p.strip_prefix("/Users/") {
        if let Some(slash) = rest.find('/') {
            return format!("~{}", &rest[slash..]);
        }
        return "~".to_string();
    }
    p.to_string()
}

#[tauri::command]
async fn get_block_output(
    state: State<'_, AppState>,
    block_id: String,
) -> Result<Option<String>, String> {
    state
        .storage
        .get_block_output(block_id)
        .await
        .map_err(|e| e.to_string())
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

/// 3.7 — directory-context probe for the status bar. Pushed off the UI
/// thread via `spawn_blocking` because the git probe shells out and the
/// file probes touch disk. Empty / non-existent cwd returns the empty
/// `DirContext` (both fields None) — the bar then renders no segments.
#[tauri::command]
async fn get_dir_context(
    state: State<'_, AppState>,
    cwd: String,
) -> Result<DirContext, String> {
    if cwd.trim().is_empty() {
        return Ok(DirContext { git: None, runtime: None });
    }
    let cache = state.dir_context_cache.clone();
    let path = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || context::dir_context(&path, &cache))
        .await
        .map_err(|e| format!("dir_context join: {e}"))
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
You are the super-agent for Covenant, a macOS terminal that coordinates \
between the user and executor agents (Claude Code, Copilot CLI, opencode, \
aider…) running inside its PTYs. \
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

    // 3. Snapshot the world model for this session.
    let session_message = {
        let sessions = state.sessions.lock().await;
        let managed = sessions.get(&id).ok_or("session not found")?;
        let world = managed.world.lock().await;
        world.render_user_message(&question)
    };

    // 4. Pull recent cross-session history (other sessions, including
    //    closed ones from prior app runs) so the agent can answer
    //    "what did I do earlier" / "have I seen this before" questions.
    //    Failure here degrades silently — the agent just won't see it.
    let history_section = match state.storage.recent_blocks_excluding(id, 30).await {
        Ok(blocks) if !blocks.is_empty() => render_history_section(&blocks),
        Ok(_) => String::new(),
        Err(e) => {
            tracing::warn!(error = %e, "history fetch failed; agent will go without");
            String::new()
        }
    };

    // Slot history BEFORE the user question marker. world::render_user_message
    // already ends with "# User question\n<question>\n"; we splice in.
    let user_message = if history_section.is_empty() {
        session_message
    } else {
        match session_message.rsplit_once("# User question") {
            Some((head, tail)) => format!("{head}{history_section}\n# User question{tail}"),
            None => format!("{session_message}\n{history_section}"),
        }
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
        karl_agent::AgentEvent::Usage(_) => {
            // ⌘K doesn't track cost yet — AOM does that downstream.
        }
        karl_agent::AgentEvent::Done => {
            // Promise resolution on the JS side signals end-of-stream.
        }
    })
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
async fn structure_list_dir(cwd: String) -> Result<Vec<structure::DirEntry>, String> {
    let path = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || structure::list_dir(&path))
        .await
        .map_err(|e| format!("list_dir join: {e}"))?
}

/// Hard cap on the per-file read size to keep memory bounded. The
/// frontend can request a smaller threshold; we never honor a larger
/// one. 4 MiB is well above the 1 MiB UI default and below anything
/// that would stall the IPC bridge.
const MAX_READ_BYTES_HARD_CAP: u64 = 4 * 1024 * 1024;

#[tauri::command]
async fn structure_read_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<structure::ReadResult, String> {
    let p = PathBuf::from(path);
    let max = max_bytes.unwrap_or(1024 * 1024).min(MAX_READ_BYTES_HARD_CAP);
    tokio::task::spawn_blocking(move || structure::read_file_text(&p, max))
        .await
        .map_err(|e| format!("read_file join: {e}"))?
}

#[tauri::command]
async fn structure_write_file(path: String, content: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || structure::write_file_text(&p, &content))
        .await
        .map_err(|e| format!("write_file join: {e}"))?
}

#[tauri::command]
async fn structure_write_binary_file(
    path: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || structure::write_file_binary(&p, &bytes))
        .await
        .map_err(|e| format!("write_binary join: {e}"))?
}

/// Project-wide substring search across the cwd, honoring .gitignore.
/// Heavy filesystem work runs on the blocking pool so the IPC thread
/// stays responsive while the user is still typing the next char.
#[tauri::command]
async fn structure_search(
    cwd: String,
    query: String,
    limit: u32,
) -> Result<Vec<structure::SearchHit>, String> {
    let p = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || structure::search(&p, &query, limit))
        .await
        .map_err(|e| format!("search join: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer().with_target(false))
        .init();

    tracing::info!("covenant starting");

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // app_config_dir on macOS resolves to
            //   ~/Library/Application Support/<bundle identifier>/
            // Tauri creates the directory lazily — settings::save handles
            // the mkdir on first save.
            let dir = app
                .path()
                .app_config_dir()
                .map_err(|e| format!("resolve app_config_dir: {e}"))?;

            // One-time migration from the previous bundle identifier
            // (com.karluiz.karl-terminal → com.karluiz.covenant).
            // Handles three cases:
            //   1. new dir doesn't exist + old does → straight rename
            //   2. new dir exists but is empty (Tauri pre-created it
            //      before our setup ran) + old has data → move files
            //      one-by-one into new
            //   3. both have data → leave alone (no overwrite, log warn)
            if let Some(parent) = dir.parent() {
                let old_dir = parent.join("com.karluiz.karl-terminal");
                if old_dir.exists() {
                    let new_has_data = dir.exists()
                        && (dir.join("config.json").exists()
                            || dir.join("history.db").exists());

                    if !dir.exists() {
                        // Case 1: simple rename.
                        match std::fs::rename(&old_dir, &dir) {
                            Ok(_) => tracing::info!(
                                from = %old_dir.display(),
                                to = %dir.display(),
                                "migrated config dir from previous identifier"
                            ),
                            Err(e) => tracing::warn!(
                                from = %old_dir.display(),
                                to = %dir.display(),
                                error = %e,
                                "config dir migration failed; old data preserved"
                            ),
                        }
                    } else if !new_has_data {
                        // Case 2: new dir is empty stub; move old's
                        // contents in one entry at a time.
                        let result = (|| -> std::io::Result<()> {
                            for entry in std::fs::read_dir(&old_dir)? {
                                let entry = entry?;
                                let dest = dir.join(entry.file_name());
                                std::fs::rename(entry.path(), dest)?;
                            }
                            std::fs::remove_dir(&old_dir).ok();
                            Ok(())
                        })();
                        match result {
                            Ok(_) => tracing::info!(
                                from = %old_dir.display(),
                                to = %dir.display(),
                                "migrated config dir contents (new dir was empty stub)"
                            ),
                            Err(e) => tracing::warn!(
                                error = %e,
                                "partial migration; check both dirs manually"
                            ),
                        }
                    } else {
                        tracing::warn!(
                            old = %old_dir.display(),
                            new = %dir.display(),
                            "both old and new config dirs have data — \
                             refusing to overwrite. Delete one manually."
                        );
                    }
                }
            }

            let path = dir.join("config.json");
            let loaded = settings::load(&path);
            tracing::info!(path = %path.display(), "settings loaded");

            let storage = Storage::open(&dir.join("history.db"))
                .map_err(|e| format!("open storage: {e}"))?;

            let settings_arc = Arc::new(Mutex::new(loaded));
            let aom_handle = aom::new_handle();
            let notifier = Notifier::new(app.handle().clone(), settings_arc.clone());
            // Pre-warm macOS notification permission so the first real
            // trigger doesn't race the OS prompt. tauri-plugin-notification
            // no-ops when permission is already granted.
            request_notification_permission_async(notifier.clone());
            let cross = CrossSessionWatcher::spawn(app.handle().clone(), settings_arc.clone());
            let mission_store = dir.join("session_missions.json");
            let operator_watcher = OperatorWatcher::spawn(
                app.handle().clone(),
                settings_arc.clone(),
                storage.clone(),
                aom_handle.clone(),
                mission_store,
                notifier.clone(),
            );

            // One-shot Recall seeding: on first launch, import the
            // user's existing ~/.zsh_history so Recall isn't empty.
            // Runs in the background — startup must not block on
            // disk I/O for potentially-megabyte-sized history files.
            maybe_import_zsh_history(
                storage.clone(),
                settings_arc.clone(),
                path.clone(),
            );

            let tab_manifest_path = dir.join("tab_manifest.json");
            app.manage(AppState {
                sessions: Mutex::new(HashMap::new()),
                settings: settings_arc,
                settings_path: path,
                rate: Mutex::new(RateLimiter::default()),
                cross_session: cross,
                operator: operator_watcher,
                storage,
                aom: aom_handle,
                tab_manifest_path,
                dir_context_cache: Arc::new(ContextCache::new()),
                notifier,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_session,
            write_to_session,
            resize_session,
            close_session,
            inject_command,
            get_block_output,
            get_settings,
            set_settings,
            ask_agent,
            set_operator_enabled,
            is_operator_enabled,
            list_operator_decisions,
            set_operator_live,
            is_operator_live,
            set_aom_excluded,
            is_aom_excluded,
            set_session_mission,
            clear_session_mission,
            get_session_mission,
            get_session_mission_content,
            set_session_mission_content,
            aom_status,
            aom_start,
            aom_stop,
            aom_report,
            get_convergence_snapshot,
            recall_search,
            zsh_autosuggestions_status,
            tab_manifest_load,
            tab_manifest_save,
            recent_blocks_by_cwd,
            get_dir_context,
            structure_list_dir,
            structure_read_file,
            structure_write_file,
            structure_write_binary_file,
            structure_search,
            drafts::list_drafts,
            drafts::read_draft,
            drafts::save_draft,
            drafts::delete_draft,
            drafts::publish_draft,
            drafts::next_draft_id,
            drafts::suggest_draft_section,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
