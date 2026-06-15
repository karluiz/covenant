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
mod browser;
mod capabilities_commands;
mod connectivity;
mod context;
pub mod convergence;
mod cost;
mod cross_session;
mod drafts;
pub mod email;
mod embedder;
mod exec_vitals;
mod executor_idle;
mod familiar_commands;
mod file_search;
mod fix_proposer;
mod git_tools;
mod history_import;
mod memory;
mod mission_pair;
mod mission_persistence;
pub mod notch;
pub mod notifications;
mod notify;
mod operator;
pub mod operator_mind;
pub mod operator_registry;
mod soul;
mod archetypes;
mod pane;
mod pi_commands;
mod project_notes;
mod prompts;
mod project_ref;
pub mod provider_resolve;
mod providers_cmd;
mod rc_agent;
mod safety;
mod score_auth_commands;
mod score_commands;
mod score_sync_commands;
mod scrollback;
pub mod settings;
mod favorites_commands;
mod spawns_commands;
mod spawns_store;
mod spec_detector;
mod split_commands;
pub mod storage;
mod structure;
mod summarizer;
mod tab_manifest;
pub mod teammate;
pub mod telegram;
mod theme;
mod vitals;
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
    /// Per-session remote-control arming flag. Default `false`. When
    /// `true`, gated remote `send_input` frames may inject into this PTY.
    armed: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

pub(crate) struct AppState {
    pub(crate) sessions: Mutex<HashMap<SessionId, ManagedSession>>,
    /// Wrapped in Arc so the per-session summarizer task can hold a
    /// long-lived reference without keeping AppState alive on its own.
    pub(crate) settings: Arc<Mutex<Settings>>,
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
    /// App data dir (same dir holding `history.db`). Scrollback logs
    /// live under `<data_dir>/scrollback/`.
    data_dir: PathBuf,
    /// Resolved Claude Code theme (e.g. `dark-daltonized`) mirroring the
    /// app's current appearance. Injected into every new shell's env as
    /// `COVENANT_CLAUDE_THEME` so the `claude` shell wrapper launches
    /// Claude matching Covenant. Updated by `set_window_theme` on every
    /// theme change (and OS appearance flip in system mode).
    claude_theme: std::sync::Mutex<String>,
    /// 3.7 status-bar — git/runtime detection cache shared across all
    /// `get_dir_context` calls. Tiny LRU, 5s TTL, no fs watcher.
    dir_context_cache: Arc<ContextCache>,
    /// 3.6 OS notifications — fires native macOS popups for
    /// ESCALATE / AOM error / AOM complete with throttle + setting
    /// gating. Cloned into the operator watcher so its tick can emit
    /// without reaching back through AppState.
    notifier: Notifier,
    /// Email fan-out channel (SendGrid). Paired with `notifier` so
    /// every OS notification also optionally fires an email.
    email_notifier: Arc<crate::email::EmailNotifier>,
    /// Telegram fan-out channel. Subscribes (via a dedicated task at
    /// app setup) to the same `escalation_bus_tx` that the operator
    /// publishes `EscalationRequested` / `MissionCompleted` /
    /// `MissionFailed` on. Held on AppState so future Tauri commands
    /// (Task 8/9) can also call into it directly.
    #[allow(dead_code)]
    telegram_notifier: Arc<crate::telegram::TelegramNotifier>,
    /// Broadcast channel the operator (and, in Task 7+, the terminal
    /// modal) publish escalation/mission events on. Subscribed by the
    /// telegram fan-out task spawned at app setup. Held on AppState so
    /// other surfaces (e.g. the resolution path) can publish too.
    #[allow(dead_code)]
    escalation_bus_tx: tokio::sync::broadcast::Sender<karl_session::SessionEvent>,
    /// Aggregator channel feeding the `TaskSupervisor` bus loop. Each
    /// session's per-session bus is fanned-in here by `spawn_session`
    /// so the supervisor sees every `BlockFinished` across all tabs.
    #[allow(dead_code)]
    supervisor_bus_tx: tokio::sync::broadcast::Sender<karl_session::SessionEvent>,
    /// 3.13 operator learning — local embedding model, lazy-loaded on
    /// first use (model download ~30 MB). Wrapped in `OnceCell` so app
    /// startup stays cheap; resolved on a blocking task by `get_embedder`.
    embedder: Arc<tokio::sync::OnceCell<Arc<embedder::Embedder>>>,
    /// 3.16 spec auto-detect — one watcher per opened repo. Inserted on
    /// `start_spec_detector`; dropping the entry stops the watcher.
    spec_detectors: Mutex<HashMap<PathBuf, spec_detector::SpecDetector>>,
    /// AOM liveness Task 4 — global online/offline state. Updated by
    /// the frontend via `set_connectivity` (mirrors `navigator.onLine`
    /// + `online`/`offline` events). The operator tick reads this on
    /// every poll and short-circuits when offline; AOM banner mirrors
    /// the state for UX. Backend heartbeat is a TODO — v0 trusts the
    /// browser as the single source of truth.
    #[allow(dead_code)]
    connectivity: connectivity::ConnectivityHandle,
    /// Telegram inbound long-poll JoinHandle, behind a mutex so
    /// `set_settings` can abort and respawn it when the bot token,
    /// chat_id, or enabled flag changes.
    #[allow(dead_code)]
    telegram_inbound_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    /// Sender side of the inbound channel — kept on AppState so respawns
    /// after settings changes feed the same drain task.
    #[allow(dead_code)]
    telegram_inbound_tx: tokio::sync::mpsc::UnboundedSender<crate::telegram::InboundEvent>,
    /// Pi RPC executor sessions. Independent of `sessions` (PTY-backed)
    /// because Pi tabs don't go through portable-pty. Lives on AppState
    /// so every `pi_*` Tauri command can address sessions by id.
    pub(crate) pi_sessions: pi_commands::PiRegistry,
    /// Notch overlay: per-session executor phase detector, bridged to each
    /// session's broadcast bus as ExecutorStateChanged events. `pub(crate)`
    /// so the operator tick loop can read the live phase via `phase_snapshot`
    /// for its engage gate (see `operator::run_tick`).
    pub(crate) notch_hub: Arc<notch::NotchHub>,
    /// Status-bar vitals aggregator handle. Spawned once at app setup;
    /// exposes CPU / memory / network snapshots to the frontend via
    /// the `get_vitals` Tauri command.
    pub(crate) vitals: vitals::VitalsHandle,
    /// Per-session Claude Code transcript tailer. Feeds executor-side
    /// usage (model + tokens + approx. latency from JSONL timestamps)
    /// into the same `VitalsHandle` so the status-bar cluster reflects
    /// what the user's actual Claude session is doing, not just Covenant's
    /// internal summariser / fix-proposer calls.
    pub(crate) exec_vitals: exec_vitals::ExecVitals,
    /// Per-session fuzzy file search cache. Populated on first `search_session_files`
    /// call for each session, refreshed on cwd change or TTL expiry.
    pub(crate) file_search_cache: crate::file_search::FileSearchCache,
    /// Global remote-tab-creation opt-in. Default `false`. When `true`,
    /// remote `open_tab` frames are honored and emit `rc://tab/open`.
    /// Not persisted (resets to off on every app launch).
    allow_remote_open: std::sync::Arc<std::sync::atomic::AtomicBool>,
}

/// Lazy-init the shared embedder cell. Called by both `get_embedder`
/// (Tauri-command path) and the operator tick loop (which doesn't have
/// `AppState` directly — it holds a clone of the same `Arc<OnceCell>`).
pub(crate) async fn get_embedder_from_cell(
    cell: &tokio::sync::OnceCell<Arc<embedder::Embedder>>,
) -> Result<Arc<embedder::Embedder>, String> {
    cell.get_or_try_init(|| async {
        tokio::task::spawn_blocking(|| embedder::Embedder::new().map(Arc::new))
            .await
            .map_err(|e| format!("embedder init join: {e}"))?
            .map_err(|e| format!("embedder init: {e}"))
    })
    .await
    .cloned()
}

#[allow(dead_code)] // wired up in 3.13 follow-up tasks
async fn get_embedder(state: &AppState) -> Result<Arc<embedder::Embedder>, String> {
    get_embedder_from_cell(&state.embedder).await
}

/// Spawn a Familiar observer task bound to a specific session's
/// `SessionEvent` bus. The observer drains the bus, filters to events
/// for `session_id`, and persists rolling summaries into the Familiar's
/// memory via Haiku.
///
/// The caller is responsible for matching the lifetime of this task to
/// the underlying session — when the bus sender drops, `obs.run`
/// returns and the spawned task ends.
pub fn spawn_familiar_observer_for(
    manager: Arc<karl_familiar::FamiliarManager>,
    bus_tx: tokio::sync::broadcast::Sender<karl_session::SessionEvent>,
    session_id: String,
    familiar_id: karl_familiar::FamiliarId,
    api_key: String,
) {
    // The Familiar observer holds a `MutexGuard<Memory>` across awaits,
    // and `Memory` wraps a rusqlite `Connection` which is `!Sync` — so
    // the observer future is not `Send` and can't run on the shared
    // multi-thread runtime. Park it on a dedicated OS thread with its
    // own current-thread runtime; the bus subscription keeps it alive
    // until the sender drops.
    std::thread::Builder::new()
        .name(format!("familiar-observer-{}", session_id))
        .spawn(move || {
            let rt = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt,
                Err(e) => {
                    tracing::warn!(error = %e, "familiar observer runtime build failed");
                    return;
                }
            };
            rt.block_on(async move {
                let mem = match manager.memory_of(familiar_id).await {
                    Ok(m) => m,
                    Err(e) => {
                        tracing::warn!(error = %e, "spawn_familiar_observer_for: memory_of failed");
                        return;
                    }
                };
                let llm = Arc::new(karl_familiar::summarizer::AnthropicLlm::haiku(api_key));
                let shutdown = manager.shutdown_signal(familiar_id).await.ok();
                let obs = karl_familiar::observer::Observer {
                    memory: mem,
                    llm,
                    session_filter: session_id,
                    flush_every: 5,
                    flush_after: Duration::from_secs(60),
                    shutdown,
                };
                if let Err(e) = obs.run(bus_tx.subscribe()).await {
                    tracing::warn!(error = %e, "familiar observer exited with error");
                }
            });
        })
        .map(|_| ())
        .unwrap_or_else(|e| {
            tracing::warn!(error = %e, "spawn familiar observer thread failed");
        });
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
        let entry = self.by_session.entry(session).or_insert((now, 0));
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
    replay_key: Option<String>,
    pane_id: Option<String>,
) -> Result<String, String> {
    tracing::debug!(?pane_id, "spawn_session: pane association");
    let zdotdir = build_zdotdir().map_err(|e| format!("zdotdir setup: {e}"))?;
    let mut opts = SpawnOptions::from_default_shell().map_err(|e| format!("shell resolve: {e}"))?;
    // zsh-only args/env. On Windows the default shell is pwsh, where
    // `--no-globalrcs` is parsed as the ambiguous `-no*` prefix and
    // dumps the full help banner into the pty (v0.5.5 launch regression).
    #[cfg(unix)]
    {
        opts.args.push("--no-globalrcs".to_string());
        opts.env
            .push(("ZDOTDIR".to_string(), zdotdir.path().display().to_string()));
    }
    // Mirror Covenant's appearance into the shell env so the `claude`
    // wrapper (shell-integration) launches Claude Code with a matching
    // theme via `--settings`. Fixed for this shell's lifetime — new tabs
    // pick up the current value; a mid-session toggle does not retroact.
    {
        let theme = state
            .claude_theme
            .lock()
            .map(|t| t.clone())
            .unwrap_or_else(|_| "dark-daltonized".to_string());
        opts.env.push(("COVENANT_CLAUDE_THEME".to_string(), theme));
    }
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

    // Snapshot the launch cwd before `opts` is moved into Session::spawn.
    // Used by the exec_vitals tailer to find the Claude Code project dir.
    let initial_launch_cwd = opts.cwd.clone();
    let (session, streams) = Session::spawn(opts).map_err(|e| e.to_string())?;
    let id = session.id;
    let id_str = id.to_string();
    let bus_tx = session.event_sender();

    let notch_hub = state.notch_hub.clone();
    {
        let hub = notch_hub.clone();
        let bus_for_notch = bus_tx.clone();
        tauri::async_runtime::spawn(async move { hub.register(id, bus_for_notch).await });
    }
    // Per-session Claude Code transcript tailer. Tracks current cwd and
    // attaches the JSONL watcher whenever the foreground executor is
    // `claude`; detaches when it leaves the foreground. Re-attaches on
    // CwdChanged so a `cd` mid-session re-resolves the project dir.
    {
        let exec_vitals = state.exec_vitals.clone();
        let mut rx = session.subscribe();
        let start_cwd = initial_launch_cwd
            .clone()
            .unwrap_or_else(|| std::path::PathBuf::new());
        tauri::async_runtime::spawn(async move {
            let mut cwd = start_cwd;
            let mut attached = false;
            while let Ok(ev) = rx.recv().await {
                match ev {
                    karl_session::SessionEvent::ForegroundChanged { session, name } => {
                        let is_claude = matches!(name.as_deref(), Some("claude"));
                        if is_claude && !cwd.as_os_str().is_empty() {
                            exec_vitals.attach(session, cwd.clone()).await;
                            attached = true;
                        } else if attached {
                            exec_vitals.detach(session).await;
                            attached = false;
                        }
                    }
                    karl_session::SessionEvent::CwdChanged {
                        session,
                        cwd: new_cwd,
                    } => {
                        cwd = new_cwd;
                        if attached {
                            // Re-resolve transcript dir from the new cwd.
                            exec_vitals.attach(session, cwd.clone()).await;
                        }
                    }
                    karl_session::SessionEvent::Closed { session } => {
                        if attached {
                            exec_vitals.detach(session).await;
                        }
                        break;
                    }
                    _ => {}
                }
            }
        });
    }
    // Drive the notch's per-session executor-agent state off ForegroundChanged.
    // The notch only surfaces pills for sessions where a known agent CLI
    // (claude/codex/copilot/…) is currently in the PTY foreground.
    {
        let hub = notch_hub.clone();
        let mut rx = session.subscribe();
        tauri::async_runtime::spawn(async move {
            while let Ok(ev) = rx.recv().await {
                if let karl_session::SessionEvent::ForegroundChanged { session, name } = ev {
                    let agent = name.and_then(|n| {
                        if karl_session::idle::KNOWN_AGENTS.contains(&n.as_str()) {
                            Some(n)
                        } else {
                            None
                        }
                    });
                    hub.set_foreground_agent(session, agent).await;
                }
            }
        });
    }

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
                    if let karl_session::SessionEvent::CwdChanged { cwd, .. } = &event {
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
        session.event_sender(),
        state.vitals.clone(),
        session.screen_handle(),
    );

    // Fix-proposer: on every non-zero BlockFinished, asks Sonnet for a
    // one-line shell fix and republishes it as SessionEvent::FixSuggested.
    fix_proposer::spawn_loop(
        id,
        state.settings.clone(),
        session.subscribe(),
        bus_tx,
        state.vitals.clone(),
    );

    // Executor-idle subscriber: on every AgentIdleWaiting, fires the
    // OS+email notification fan-out (gated by the on_executor_idle
    // setting and the per-session throttle inside `Notifier`).
    let _ = executor_idle::spawn(
        session.subscribe(),
        state.notifier.clone(),
        state.email_notifier.clone(),
        state.settings.clone(),
    );

    // Cross-session watcher: forwards this session's bus into the
    // global pump so M5 patterns across all open tabs can be detected.
    state
        .cross_session
        .attach(id, world.clone(), session.subscribe())
        .await;

    // TaskSupervisor fan-in: forward every event from this session's
    // bus into the global aggregator so the supervisor (one tokio task)
    // can observe BlockFinished across all sessions.
    {
        let mut rx = session.subscribe();
        let agg = state.supervisor_bus_tx.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        let _ = agg.send(ev);
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                }
            }
        });
    }

    let op_state = Arc::new(std::sync::Mutex::new(OperatorState::new()));

    // Hook the operator watcher BEFORE inserting into the session map
    // so the very first BlockSubmitted is visible.
    //
    // AOM-active edge case: when the user opens a NEW tab while AOM is
    // already running, the new tab is for fresh manual work — not for
    // AOM to start typing into. Default `aom_excluded = true` so the
    // tab joins AOM only if the user explicitly toggles it via the
    // tab badge, ⌘⇧E, or the context menu. Tabs spawned BEFORE AOM
    // started keep their included-by-default posture (they were swept
    // by `aom_start` → `enable_all_for_aom`, which now also respects
    // any pre-existing `aom_excluded` flag).
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

    state.sessions.lock().await.insert(
        id,
        ManagedSession {
            session,
            _zdotdir: zdotdir,
            world,
            op_state: op_state.clone(),
            armed: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
        },
    );

    // Pump 1: raw PTY bytes to xterm. Also feeds the operator's tail
    // buffer so it knows what the executor last printed when checking
    // for a stuck prompt.
    let SessionStreams { mut raw_bytes } = streams;
    let op_state_for_pump = op_state.clone();
    let mut scrollback_writer = replay_key
        .as_deref()
        .and_then(|k| scrollback::open_writer(&state.data_dir, k))
        .map(scrollback::Writer::new);
    let notch_hub_for_pump = notch_hub.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(chunk) = raw_bytes.recv().await {
            if let Ok(mut st) = op_state_for_pump.lock() {
                st.observe(&chunk);
            }
            if let Some(w) = scrollback_writer.as_mut() {
                w.append(&chunk);
            }
            notch_hub_for_pump.ingest(id, &chunk).await;
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
    // User typed into a watched PTY → invalidate any pending WAIT/loop
    // escalation. The prompt the operator might have been about to
    // answer just got answered by the human. No-op when not attached.
    state.operator.note_user_input(id).await;
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
    managed
        .session
        .resize(cols, rows)
        .map_err(|e| e.to_string())
}

/// Force-kill the foreground process group of a session's PTY.
/// Sends SIGTERM, waits up to ~500ms, then escalates to SIGKILL.
/// Designed for cases like `npm run tauri:dev` where Ctrl+C is caught
/// by the parent but not propagated to its child processes. The shell
/// itself is unaffected (it sits in its own pgrp).
#[tauri::command]
async fn kill_session_foreground(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let id = parse_id(&id)?;
    #[cfg(unix)]
    {
        let master_fd = {
            let sessions = state.sessions.lock().await;
            let managed = sessions.get(&id).ok_or("session not found")?;
            managed.session.master_fd()
        };
        let pgid = karl_pty::kill_foreground_pgrp(master_fd, libc::SIGTERM)
            .map_err(|e| format!("SIGTERM failed: {e}"))?;
        tracing::info!(session = %id, pgid, "kill_session_foreground: sent SIGTERM");
        for _ in 0..10 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if !karl_pty::pgrp_alive(pgid) {
                return Ok(());
            }
        }
        match karl_pty::kill_foreground_pgrp(master_fd, libc::SIGKILL) {
            Ok(_) => {
                tracing::warn!(session = %id, pgid, "kill_session_foreground: escalated to SIGKILL");
                Ok(())
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("SIGKILL failed: {e}")),
        }
    }
    #[cfg(not(unix))]
    {
        let _ = state;
        let _ = id;
        Err("kill_session_foreground not supported on this platform".into())
    }
}

#[tauri::command]
async fn close_session(
    state: State<'_, AppState>,
    registry: State<'_, std::sync::Arc<crate::operator_registry::OperatorRegistry>>,
    id: String,
) -> Result<(), String> {
    let id = parse_id(&id)?;
    state.operator.detach(id).await;
    state.operator.forget_tab_title(id).await;
    registry.unpin_session(id);
    let mut sessions = state.sessions.lock().await;
    if let Some(mut managed) = sessions.remove(&id) {
        let _ = managed.session.kill();
    }
    drop(sessions);
    // Spec 3.20: drop the persisted mind on confirmed close. The
    // close_session_check command + UI modal already gave the user
    // the chance to back out.
    let mind_v2_on = state.settings.lock().await.operator.mind_v2;
    if mind_v2_on {
        if let Err(e) = state.storage.mind_delete(&id.to_string()).await {
            tracing::warn!(session = %id, error = %e, "mind_delete failed");
        }
    }
    state.notch_hub.drop_session(&id).await;
    if let Err(e) = state.storage.close_session(id, now_unix_ms()).await {
        tracing::warn!(session = %id, error = %e, "close_session persist failed");
    }
    Ok(())
}

/// Return the last ~2 MiB of persisted PTY bytes for a tab, in order
/// so the frontend can replay them into xterm before live output
/// starts. Empty vec for unknown keys.
#[tauri::command]
async fn replay_scrollback(
    state: State<'_, AppState>,
    replay_key: String,
) -> Result<Vec<u8>, String> {
    Ok(scrollback::read_tail(&state.data_dir, &replay_key))
}

/// Drop the scrollback log for a closed tab. Best-effort; missing
/// files are not an error.
#[tauri::command]
async fn delete_scrollback(state: State<'_, AppState>, replay_key: String) -> Result<(), String> {
    scrollback::delete(&state.data_dir, &replay_key);
    Ok(())
}

/// Spec 3.20 phase 6: peek at the persisted mind for `id` so the UI can
/// decide whether to show the MindLossModal before destroying the tab.
/// Returns `None` when mind_v2 is off OR no mind exists OR turn_count
/// is 0 (nothing to lose).
#[tauri::command]
async fn close_session_check(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<storage::MindPreviewRow>, String> {
    let id = parse_id(&id)?;
    if !state.settings.lock().await.operator.mind_v2 {
        return Ok(None);
    }
    match state.storage.mind_preview(&id.to_string()).await {
        Ok(Some(p)) if p.turn_count > 0 => Ok(Some(p)),
        Ok(_) => Ok(None),
        Err(e) => {
            tracing::warn!(session = %id, error = %e, "mind_preview failed");
            Ok(None)
        }
    }
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
async fn rc_set_armed(state: State<'_, AppState>, session_id: String, armed: bool) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    let sessions = state.sessions.lock().await;
    let managed = sessions.get(&id).ok_or("session not found")?;
    managed.armed.store(armed, std::sync::atomic::Ordering::Relaxed);
    tracing::info!(session = %id, armed, "remote arming toggled");
    Ok(())
}

#[tauri::command]
async fn rc_set_allow_open(state: State<'_, AppState>, allow: bool) -> Result<(), String> {
    state.allow_remote_open.store(allow, std::sync::atomic::Ordering::Relaxed);
    tracing::info!(allow, "remote tab creation toggled");
    Ok(())
}

#[tauri::command]
async fn rc_get_allow_open(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.allow_remote_open.load(std::sync::atomic::Ordering::Relaxed))
}

#[tauri::command]
async fn rc_get_armed(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    let sessions = state.sessions.lock().await;
    let managed = sessions.get(&id).ok_or("session not found")?;
    Ok(managed.armed.load(std::sync::atomic::Ordering::Relaxed))
}

// Kill-switch backend. The user-facing button/shortcut lands with the RC-1b banner.
#[tauri::command]
async fn rc_disarm_all(state: State<'_, AppState>) -> Result<(), String> {
    let sessions = state.sessions.lock().await;
    for managed in sessions.values() {
        managed.armed.store(false, std::sync::atomic::Ordering::Relaxed);
    }
    tracing::info!("remote control: disarmed all tabs");
    Ok(())
}

#[tauri::command]
async fn rc_pairing_token() -> Result<Option<String>, String> {
    karl_score::auth::load_jwt().map_err(|e| e.to_string())
}

/// Write `text` to the macOS system clipboard via `pbcopy`. Done in Rust so it
/// works when triggered from a native menu item (the webview clipboard API
/// rejects with "Document is not focused" in that case). Returns true on success.
fn copy_to_clipboard(text: &str) -> bool {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let mut child = match Command::new("pbcopy").stdin(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(e) => {
            tracing::warn!(target: "rc_agent", error=%e, "pbcopy spawn failed");
            return false;
        }
    };
    if let Some(stdin) = child.stdin.as_mut() {
        if stdin.write_all(text.as_bytes()).is_err() {
            return false;
        }
    }
    matches!(child.wait(), Ok(s) if s.success())
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
async fn is_operator_live(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.is_live(id).await)
}

#[tauri::command]
async fn validate_sendgrid_key(app: tauri::AppHandle, api_key: String) -> Result<bool, String> {
    use tauri::Emitter;
    let base = "https://api.sendgrid.com";
    match crate::email::client::check_key_via(base, &api_key).await {
        Ok(true) => Ok(true),
        Ok(false) => {
            let _ = app.emit("sendgrid-key-invalid", ());
            Ok(false)
        }
        Err(e) => Err(e.to_string()),
    }
}

/// Mission spec attached to a session. The Operator reads the spec
/// content as authoritative scope: Out of scope → escalate triggers;
/// File boundaries → constraints; Open questions → auto-escalate.
#[tauri::command]
async fn set_session_mission(
    state: State<'_, AppState>,
    session_id: String,
    mref: mission_pair::MissionRef,
) -> Result<operator::MissionInfo, String> {
    let id = parse_id(&session_id)?;
    state.operator.set_mission(id, mref).await
}

/// Atomic priming for a freshly-spawned executor tab. Attaches the
/// originating chat's spec as the session mission AND queues a
/// `/rename <slug>` for the next idle. The frontend awaits this before
/// injecting the executor's first prompt so both effects land before
/// the executor's first reply. See spec
/// `docs/superpowers/specs/2026-05-26-spawned-task-and-cost-fixes-design.md`.
#[tauri::command]
async fn prime_spawned_tab(
    state: State<'_, AppState>,
    session_id: String,
    spec_path: String,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    let path = std::path::PathBuf::from(&spec_path);
    let mref = mission_pair::MissionRef::covenant(path.clone());
    // Mission attach first — surfaces real errors (file not found,
    // permission denied) before we silently queue a rename for a
    // tab whose mission failed. The rename queue is best-effort.
    state.operator.set_mission(id, mref).await?;
    let slug = operator::slug_from_mission_path(&path);
    state.operator.queue_aom_rename(id, slug).await;
    Ok(())
}

#[derive(serde::Serialize)]
struct SuperpowersMissionEntry {
    spec_path: String,
    spec_filename: String,
    plan_path: Option<String>,
    goal_preview: String,
}

/// Background poller that emits `superpowers-missions-changed` whenever
/// any markdown file under `docs/superpowers/specs/` or
/// `docs/superpowers/plans/` is added, removed, or modified. Polling
/// (2s) avoids pulling in the `notify` crate just for two directories.
fn spawn_superpowers_watcher(app: tauri::AppHandle) {
    tauri::async_runtime::spawn(async move {
        let root = match std::env::current_dir() {
            Ok(r) => r,
            Err(err) => {
                tracing::warn!(?err, "superpowers watcher could not resolve cwd; disabled");
                return;
            }
        };
        let dirs = [
            root.join("docs/superpowers/specs"),
            root.join("docs/superpowers/plans"),
        ];
        tracing::info!(
            specs = %dirs[0].display(),
            plans = %dirs[1].display(),
            "superpowers watcher started"
        );
        let snapshot = |dirs: &[std::path::PathBuf; 2]| -> std::collections::BTreeMap<std::path::PathBuf, u64> {
            let mut out = std::collections::BTreeMap::new();
            for d in dirs {
                if let Ok(rd) = std::fs::read_dir(d) {
                    for entry in rd.flatten() {
                        let p = entry.path();
                        if p.extension().and_then(|s| s.to_str()) == Some("md") {
                            if let Ok(meta) = entry.metadata() {
                                if let Ok(m) = meta.modified() {
                                    if let Ok(dur) = m.duration_since(std::time::UNIX_EPOCH) {
                                        out.insert(p, dur.as_millis() as u64);
                                    }
                                }
                            }
                        }
                    }
                }
            }
            out
        };
        let mut last = snapshot(&dirs);
        loop {
            tokio::time::sleep(std::time::Duration::from_millis(2000)).await;
            let now = snapshot(&dirs);
            if now != last {
                let _ = app.emit("superpowers-missions-changed", ());
                last = now;
            }
        }
    });
}

/// Walk up from `cwd` (and then process cwd) looking for a directory
/// that contains `docs/superpowers/specs/`. Returns the first match.
fn resolve_superpowers_root(cwd: Option<&str>) -> Option<std::path::PathBuf> {
    fn walk(start: std::path::PathBuf) -> Option<std::path::PathBuf> {
        let needle = std::path::Path::new("docs/superpowers/specs");
        let mut cur = start;
        loop {
            if cur.join(needle).exists() {
                return Some(cur);
            }
            match cur.parent() {
                Some(p) => cur = p.to_path_buf(),
                None => return None,
            }
        }
    }
    if let Some(c) = cwd {
        if let Some(found) = walk(std::path::PathBuf::from(c)) {
            return Some(found);
        }
    }
    if let Ok(p) = std::env::current_dir() {
        if let Some(found) = walk(p) {
            return Some(found);
        }
    }
    None
}

/// Discover Superpowers spec/plan pairs under a project's
/// `docs/superpowers/specs/` directory.
///
/// Resolution order for the project root:
///   1. The provided `cwd` (typically the active tab's cwd), walking
///      up parent directories until one contains `docs/superpowers/specs/`.
///   2. If `cwd` is `None` or no ancestor matches, fall back to the
///      process's `current_dir()`.
///
/// Returning `Ok(vec![])` when nothing is found is intentional — the
/// picker just shows "No Superpowers specs yet."
#[tauri::command]
async fn list_superpowers_missions(
    state: State<'_, AppState>,
    cwd: Option<String>,
) -> Result<Vec<SuperpowersMissionEntry>, String> {
    let _ = state;
    let root = resolve_superpowers_root(cwd.as_deref())
        .ok_or_else(|| "could not resolve a docs/superpowers root".to_string())?;
    let specs_dir = root.join("docs/superpowers/specs");
    let plans_dir = root.join("docs/superpowers/plans");
    tracing::debug!(?specs_dir, ?plans_dir, "list_superpowers_missions resolved");
    let mut out = Vec::new();
    if !specs_dir.exists() {
        return Ok(out);
    }
    let mut entries: Vec<_> = std::fs::read_dir(&specs_dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|s| s.to_str()) == Some("md"))
        .collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let path = entry.path();
        let body = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let plan =
            mission_pair::resolve_plan_for_spec(&path, &plans_dir).map_err(|e| e.to_string())?;
        let goal = body
            .lines()
            .find(|l| !l.starts_with('#') && !l.trim().is_empty())
            .unwrap_or("")
            .chars()
            .take(120)
            .collect::<String>();
        out.push(SuperpowersMissionEntry {
            spec_filename: path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default(),
            spec_path: path.display().to_string(),
            plan_path: plan.map(|p| p.display().to_string()),
            goal_preview: goal,
        });
    }
    Ok(out)
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

/// Full plan body for the mission overlay's plan-progress strip. Returns
/// null when the session has no mission, or the mission is Covenant
/// without a paired plan file.
#[tauri::command]
async fn get_session_plan_content(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<Option<String>, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.get_plan_content(id).await)
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

/// Flip the Nth top-level checkbox of the session's attached plan.
/// `expected_mtime_unix_ms == 0` bypasses the mtime conflict check.
#[tauri::command]
async fn operator_mark_plan_task(
    state: State<'_, AppState>,
    session_id: String,
    task_index: usize,
    done: bool,
    expected_mtime_unix_ms: u64,
) -> Result<operator::MissionPlanInfo, String> {
    let id = parse_id(&session_id)?;
    state
        .operator
        .mark_plan_task(id, task_index, done, expected_mtime_unix_ms)
        .await
}

/// Append a `> note: <text>` line under the Nth top-level plan task.
#[tauri::command]
async fn operator_append_plan_note(
    state: State<'_, AppState>,
    session_id: String,
    task_index: usize,
    note: String,
    expected_mtime_unix_ms: u64,
) -> Result<operator::MissionPlanInfo, String> {
    let id = parse_id(&session_id)?;
    state
        .operator
        .append_plan_note(id, task_index, note, expected_mtime_unix_ms)
        .await
}

/// Frontend → backend tab title push. Used by AOM startup to build the
/// `covenant-{tab-slug}-{ulid6}` Claude session-name slug. Empty title
/// clears the cached entry. Called on tab create and on rename.
#[tauri::command]
async fn set_tab_title(
    state: State<'_, AppState>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    state.operator.set_tab_title(id, title.clone()).await;
    // Also seed the notch label so it's populated even if the frontend
    // forgets to call notch_set_label. notchSetLabel overrides this
    // with the group-prefixed version.
    state.notch_hub.set_tab_label(id, title).await;
    Ok(())
}

#[tauri::command]
async fn notch_set_label(
    state: State<'_, AppState>,
    session_id: String,
    label: String,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;
    state.notch_hub.set_tab_label(id, label).await;
    Ok(())
}

/// Per-tab AOM opt-out. When AOM is on, an excluded tab keeps its
/// per-tab live setting + normal persona instead of inheriting the
/// AOM act-by-default posture. Persistent across AOM cycles — use
/// the "Include all" action in the AOM popover to reset in bulk.
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
async fn is_aom_excluded(state: State<'_, AppState>, session_id: String) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.is_aom_excluded(id).await)
}

#[tauri::command]
async fn clear_all_aom_excluded(state: State<'_, AppState>) -> Result<(), String> {
    state.operator.clear_all_aom_excluded().await;
    Ok(())
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
    let zsh_custom =
        std::env::var("ZSH_CUSTOM").unwrap_or_else(|_| format!("{home}/.oh-my-zsh/custom"));
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

/// Liveness phase for the AOM banner. Returned aggregate is "the
/// most-active phase any attached session is currently in", with a
/// unix-ms wall clock timestamp for when that phase began. The banner
/// polls this every ~1s while AOM is on so the badge never sits
/// frozen for >2s. See `OperatorPhase` for the variant priorities.
#[tauri::command]
async fn operator_phase_overview(
    state: State<'_, AppState>,
) -> Result<operator::OperatorPhaseSnapshot, String> {
    Ok(state.operator.phase_overview().await)
}

/// Idempotently open the shared autonomy budget pot. Called by both
/// `aom_start` (global) and `operator_solo_start` (single tab). When no
/// autonomy is currently active, initializes `budget_usd` from settings,
/// resets cost/decisions, stamps `started_at`, and opens an `aom_session`
/// storage row. When a pot is already live (global AOM on OR another solo
/// tab armed), it's a no-op so the cap/counter carry.
///
/// `already_active` MUST be evaluated by the caller BEFORE arming its own
/// flag, so the "first to arm" caller opens the pot.
async fn ensure_autonomy_pot(state: &State<'_, AppState>, already_active: bool) {
    if already_active {
        return;
    }
    let budget = state.settings.lock().await.aom.default_budget_usd;
    let started_at = now_unix_ms();
    let row_id = match state.storage.aom_session_start(started_at, budget).await {
        Ok(id) => Some(id),
        Err(e) => {
            tracing::warn!(error = %e, "aom_session_start: persistence failed");
            None
        }
    };
    let mut s = state.aom.write().await;
    s.started_at_unix_ms = started_at;
    s.decisions_count = 0;
    s.budget_usd = budget;
    s.accumulated_cost_usd = 0.0;
    s.cost_cap_hit_at_unix_ms = None;
    s.current_session_row_id = row_id;
    tracing::info!(budget_usd = budget, row_id = ?row_id, "autonomy pot opened");
}

#[tauri::command]
async fn aom_start(state: State<'_, AppState>) -> Result<AomStatus, String> {
    // M-OP5+: per-tab `aom_excluded` is persistent across AOM cycles.
    // The user opts tabs IN/OUT explicitly via the tab badge, ⌘⇧E, the
    // tab context menu, or the "Include all" action in the AOM popover.
    // We deliberately do NOT reset here — the previous reset surprised
    // users who marked a tab manual and lost it the next time AOM ran.
    // M-OP5 UX fix: AOM is "one button does it all". Auto-enable
    // Operator on every tab that doesn't already have it. We track
    // which tabs we touched so `aom_stop` reverts exactly them
    // (manually enabled tabs keep their user choice). The frontend
    // refreshes per-tab state after the toggle resolves.
    let _auto_enabled = state.operator.enable_all_for_aom().await;
    // Queue proactive startup actions: claude /rename, bypass-exit,
    // etc. These fire later in run_tick when conditions are met.
    state.operator.queue_aom_startup_actions().await;

    // Open the shared budget pot only if no autonomy is already active
    // (another solo tab may have opened it first). If a solo tab is
    // running, aom_start piggybacks on the existing pot — no reset.
    let already_active =
        { state.aom.read().await.enabled } || state.operator.any_solo_active().await;
    ensure_autonomy_pot(&state, already_active).await;
    {
        let mut s = state.aom.write().await;
        s.enabled = true;
    }
    let status = { AomStatus::from(&*state.aom.read().await) };
    tracing::info!("AOM started");
    Ok(status)
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

/// Builds the `SessionInput` vec from state + tab hints + operator registry.
/// `tabs` is supplied by the frontend (it owns title/color); registry
/// provides the pinned-operator assignment. Sessions with no pinned
/// operator are included with `operator_id: None` and will be dropped
/// by `build_convergence_snapshot`.
async fn build_convergence_inputs(
    state: &State<'_, AppState>,
    registry: &std::sync::Arc<crate::operator_registry::OperatorRegistry>,
    tab_hints: Vec<convergence::TabHint>,
) -> Vec<convergence::SessionInput> {
    use std::collections::HashMap;
    let by_id: HashMap<String, convergence::TabHint> = tab_hints
        .into_iter()
        .map(|t| (t.session_id.clone(), t))
        .collect();

    let sessions = state.sessions.lock().await;
    let mut out = Vec::with_capacity(sessions.len());
    for (id, ms) in sessions.iter() {
        let id_str = id.to_string();
        let pinned = registry.pinned(*id);
        let (operator_id, operator_name, operator_avatar) =
            match pinned.and_then(|oid| registry.get(oid)) {
                Some(op) => (
                    Some(op.id.to_string()),
                    Some(op.name.clone()),
                    Some(op.emoji.clone()),
                ),
                None => (None, None, None),
            };
        let (tab_title, tab_color) = by_id
            .get(&id_str)
            .map(|h| (h.title.clone(), h.color.clone()))
            .unwrap_or_else(|| (String::from("untitled"), None));
        out.push(convergence::SessionInput {
            session_id: *id,
            op_state: ms.op_state.clone(),
            tab_title,
            tab_color,
            operator_id,
            operator_name,
            operator_avatar,
        });
    }
    out
}

/// 3.8 Convergence Mode — one snapshot per UI poll (1 Hz). Read-only
/// aggregator over existing handles; no schema changes.
/// Frontend MUST supply `tabs` (title + color per session) — Task 3
/// wires the JS side; until then the array may be empty (tabs show
/// "untitled" with no color).
#[tauri::command]
async fn get_convergence_snapshot(
    state: State<'_, AppState>,
    registry: State<'_, std::sync::Arc<crate::operator_registry::OperatorRegistry>>,
    tabs: Vec<convergence::TabHint>,
) -> Result<convergence::ConvergenceSnapshot, String> {
    let inputs = build_convergence_inputs(&state, &registry, tabs).await;
    Ok(
        convergence::build_convergence_snapshot(
            inputs,
            &state.operator,
            &state.storage,
            &state.aom,
        )
        .await,
    )
}

/// 3.14 — light poll surface for the tab strip. Returns session ids
/// (as strings) whose convergence status would resolve to `Blocked`,
/// so the tab chip can render its escalation dot independent of the
/// convergence overlay's lifecycle. Reuses `build_convergence_snapshot`
/// — at 1 Hz the cost is negligible and we get the exact same logic.
/// Frontend MUST supply `tabs` — see `get_convergence_snapshot` note.
#[tauri::command]
async fn get_blocked_session_ids(
    state: State<'_, AppState>,
    registry: State<'_, std::sync::Arc<crate::operator_registry::OperatorRegistry>>,
    tabs: Vec<convergence::TabHint>,
) -> Result<Vec<String>, String> {
    let inputs = build_convergence_inputs(&state, &registry, tabs).await;
    let snap = convergence::build_convergence_snapshot(
        inputs,
        &state.operator,
        &state.storage,
        &state.aom,
    )
    .await;
    Ok(snap.escalations.into_iter().map(|e| e.session_id).collect())
}

/// 3.13 Task 3 — pure scope-resolution helper. UI sends literal
/// `"one-shot" | "mission" | "global"`; backend resolves to the
/// stored `scope` column on `operator_memories`. Returns `None` to
/// mean "skip persistence". Pulled out for unit testing.
fn resolve_scope(ui_scope: &str, mission_path: Option<&str>) -> Option<String> {
    match ui_scope {
        "one-shot" => None,
        "global" => Some("global".into()),
        "mission" => match mission_path {
            Some(p) => Some(format!("mission:{p}")),
            None => {
                tracing::warn!(
                    "convergence reply scope=mission but no mission attached; falling back to global"
                );
                Some("global".into())
            }
        },
        other => {
            tracing::warn!(scope = %other, "unknown convergence reply scope; skipping persistence");
            None
        }
    }
}

/// 3.13 Task 3 — best-effort persistence of a convergence reply as
/// an `operator_memories` row. NEVER returns an error: every failure
/// path logs and falls through. The caller's command must succeed
/// regardless so the user's reply unblocks the session.
async fn persist_convergence_memory(
    storage: &Storage,
    embedder_cell: &Arc<tokio::sync::OnceCell<Arc<embedder::Embedder>>>,
    session_id: &SessionId,
    text: &str,
    ui_scope: &str,
) {
    // Recent decisions for this session, used for both mission lookup
    // and pattern-context. Cap at 50 — convergence happens close in
    // time to the decision that triggered it.
    let session_short = {
        let s = session_id.0.to_string();
        if s.len() > 6 {
            s[s.len() - 6..].to_string()
        } else {
            s
        }
    };
    let recent = match storage.list_operator_decisions(50).await {
        Ok(r) => r,
        Err(e) => {
            tracing::warn!(error = %e, "list_operator_decisions failed; persisting without context");
            Vec::new()
        }
    };

    // Mission path: most recent decision row for this session that has
    // one attached. Reusing the column we already snapshot per row
    // avoids widening OperatorWatcher's surface.
    let mission_path: Option<String> = recent
        .iter()
        .find(|r| r.session_id_short == session_short && r.mission_path.is_some())
        .and_then(|r| r.mission_path.clone());

    let resolved_scope = match resolve_scope(ui_scope, mission_path.as_deref()) {
        Some(s) => s,
        None => return, // one-shot or unknown — nothing to persist
    };

    // Pattern: last decision for this session within 5 min →
    // rationale + in_flight_command. Else most-recent for this session
    // (rationale only). Else empty.
    let now_ms = now_unix_ms();
    let five_min_ms: u64 = 5 * 60 * 1000;
    let pattern: String = {
        let recent_for_session: Vec<&OperatorDecisionRow> = recent
            .iter()
            .filter(|r| r.session_id_short == session_short)
            .collect();
        if let Some(r) = recent_for_session
            .iter()
            .find(|r| now_ms.saturating_sub(r.timestamp_unix_ms) <= five_min_ms)
        {
            format!(
                "{} | {}",
                r.rationale.as_deref().unwrap_or(""),
                r.in_flight_command.as_deref().unwrap_or("")
            )
        } else if let Some(r) = recent_for_session.first() {
            r.rationale.clone().unwrap_or_default()
        } else {
            String::new()
        }
    };

    // Tags from combined pattern + reply text.
    let combined = format!("{pattern} {text}");
    let tags = memory::extract_tags(&combined).join(" ");

    // Embedding — runs on a blocking task because fastembed is sync.
    let embedder = match get_embedder_from_cell(embedder_cell.as_ref()).await {
        Ok(e) => e,
        Err(e) => {
            tracing::warn!(error = %e, "embedder init failed; skipping memory persist");
            return;
        }
    };
    let embed_input = format!("{pattern}\n{text}");
    let embedding = match tokio::task::spawn_blocking(move || embedder.embed(&embed_input)).await {
        Ok(Ok(v)) => v,
        Ok(Err(e)) => {
            tracing::warn!(error = %e, "embedding failed; skipping memory persist");
            return;
        }
        Err(e) => {
            tracing::warn!(error = %e, "embed join failed; skipping memory persist");
            return;
        }
    };

    match storage
        .insert_memory(
            &pattern,
            text,
            None,
            &resolved_scope,
            &tags,
            now_ms,
            &embedding,
        )
        .await
    {
        Ok(id) => {
            tracing::info!(memory_id = id, scope = %resolved_scope, "convergence memory saved")
        }
        Err(e) => tracing::warn!(error = %e, "failed to persist convergence memory; continuing"),
    }
}

/// 3.8 Convergence Mode reply pipe. Pushes a resolution onto the
/// operator's internal channel; tick_loop drains it and injects into
/// the matching session's PTY. Emits `convergence_reply_submitted`
/// with a `text_hash` (NEVER raw text) so spec 3.13 can persist the
/// learning signal without exposing user content on the bus.
#[tauri::command]
async fn submit_convergence_reply(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    session_id: String,
    text: String,
    scope: String,
) -> Result<(), String> {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let id = parse_id(&session_id)?;

    // 3.13 perf: unblock the user's session FIRST. Send resolution and
    // emit the event synchronously, then persist the learned memory in
    // a detached task. Persistence can take seconds on first reply
    // post-boot (fastembed model cold start) — the user's session must
    // not wait on it. The next operator tick (≥500ms later in practice)
    // will see the new memory once the detached task lands; if not,
    // the pattern simply won't match yet. Acceptable.
    state
        .operator
        .resolution_sender()
        .send(operator::ConvergenceResolution {
            session_id: id,
            text: text.clone(),
            scope: scope.clone(),
        })
        .map_err(|e| format!("resolution channel closed: {e}"))?;

    let mut hasher = DefaultHasher::new();
    text.hash(&mut hasher);
    let text_hash = hasher.finish();
    let _ = app.emit(
        "convergence_reply_submitted",
        serde_json::json!({
            "session_id": session_id,
            "scope": scope,
            "text_hash": text_hash,
        }),
    );

    // Detached persistence — errors logged, never fail the command.
    let storage = state.storage.clone();
    let embedder_cell = state.embedder.clone();
    let scope_owned = scope.clone();
    let text_owned = text.clone();
    tokio::spawn(async move {
        persist_convergence_memory(&storage, &embedder_cell, &id, &text_owned, &scope_owned).await;
    });

    Ok(())
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
    crate::notifications::dispatch(
        &state.notifier,
        &state.email_notifier,
        crate::notifications::DispatchCtx {
            trigger: Trigger::AomComplete,
            title: "AOM finished".into(),
            body,
            session_id: None,
        },
    )
    .await;

    tracing::info!(decisions, "AOM stopped");
    Ok(status)
}

/// Arm a single tab into full AOM posture without the global banner.
/// Ephemeral: not persisted; cleared on reload. Opens the shared budget
/// pot if this is the first autonomy to arm.
#[tauri::command]
async fn operator_solo_start(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    let already_active =
        { state.aom.read().await.enabled } || state.operator.any_solo_active().await;
    if !state.operator.is_enabled(id).await {
        state.operator.set_enabled(id, true).await;
    }
    state.operator.set_solo(id, true).await;
    ensure_autonomy_pot(&state, already_active).await;
    state.operator.queue_aom_startup_actions_for(id).await;
    tracing::info!(session = %id, "solo autonomous armed");
    Ok(true)
}

/// Disarm solo on a single tab. Leaves the shared pot alone if global AOM
/// or any other solo tab is still active.
#[tauri::command]
async fn operator_solo_stop(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    state.operator.set_solo(id, false).await;
    tracing::info!(session = %id, "solo autonomous disarmed");
    Ok(false)
}

/// Current solo state for a tab — drives the chip menu label + accent.
#[tauri::command]
async fn operator_solo_status(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<bool, String> {
    let id = parse_id(&session_id)?;
    Ok(state.operator.is_solo(id).await)
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
async fn tab_manifest_load(state: State<'_, AppState>) -> Result<Option<String>, String> {
    tab_manifest::load(&state.tab_manifest_path).map_err(|e| e.to_string())
}

#[tauri::command]
async fn tab_manifest_save(state: State<'_, AppState>, body: String) -> Result<(), String> {
    tab_manifest::save(&state.tab_manifest_path, &body).map_err(|e| e.to_string())
}

/// Write a text payload to an arbitrary user-chosen path. Used by the
/// workspace export flow after the user picks a destination via the
/// native save dialog.
#[tauri::command]
async fn write_text_file(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| e.to_string())
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
        if settings
            .lock()
            .await
            .zsh_history_imported_at_unix_ms
            .is_some()
        {
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
        let mut cut = MAX;
        while cut > 0 && !s.is_char_boundary(cut) {
            cut -= 1;
        }
        format!("{}\n[...truncated, original {} bytes]", &s[..cut], s.len())
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
async fn get_dir_context(state: State<'_, AppState>, cwd: String) -> Result<DirContext, String> {
    if cwd.trim().is_empty() {
        return Ok(DirContext {
            git: None,
            runtime: None,
        });
    }
    let cache = state.dir_context_cache.clone();
    let path = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || context::dir_context(&path, &cache))
        .await
        .map_err(|e| format!("dir_context join: {e}"))
}

#[tauri::command]
async fn git_repo_summary(cwd: String) -> Result<git_tools::GitRepoSummary, String> {
    let path = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || git_tools::repo_summary(&path))
        .await
        .map_err(|e| format!("git_repo_summary join: {e}"))?
}

#[tauri::command]
async fn git_switch_branch(
    state: State<'_, AppState>,
    cwd: String,
    branch: String,
) -> Result<git_tools::GitRepoSummary, String> {
    let cache = state.dir_context_cache.clone();
    let path = PathBuf::from(cwd);
    let invalidate_path = path.clone();
    let summary = tokio::task::spawn_blocking(move || git_tools::switch_branch(&path, &branch))
        .await
        .map_err(|e| format!("git_switch_branch join: {e}"))??;
    cache.invalidate(&invalidate_path);
    Ok(summary)
}

#[tauri::command]
async fn get_settings(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(state.settings.lock().await.clone())
}

#[tauri::command]
async fn set_settings(
    state: State<'_, AppState>,
    app: tauri::AppHandle,
    settings: Settings,
) -> Result<(), String> {
    settings::save(&state.settings_path, &settings).map_err(|e| e.to_string())?;
    let (telegram_changed, notch_corner_changed, notch_sound_changed) = {
        let cur = state.settings.lock().await;
        let tg = cur.telegram.enabled != settings.telegram.enabled
            || cur.telegram.bot_token != settings.telegram.bot_token
            || cur.telegram.chat_id != settings.telegram.chat_id;
        let corner = cur.notch_corner != settings.notch_corner;
        let sound = cur.notch_sound_on_done != settings.notch_sound_on_done;
        (tg, corner, sound)
    };
    let notch_enabled = settings.notch_enabled;
    let new_corner = settings.notch_corner;
    let new_sound = settings.notch_sound_on_done;
    *state.settings.lock().await = settings;
    state.notch_hub.set_enabled(notch_enabled).await;
    if notch_corner_changed {
        if let Some(win) = app.get_webview_window("notch") {
            notch::reposition_notch(&win, new_corner);
        }
        let _ = app.emit("notch:corner", serde_json::json!({ "corner": new_corner }));
    }
    if notch_sound_changed {
        let _ = app.emit(
            "notch:sound",
            serde_json::json!({ "sound_on_done": new_sound }),
        );
    }
    if telegram_changed {
        let mut slot = state.telegram_inbound_handle.lock().await;
        if let Some(h) = slot.take() {
            h.abort();
        }
        let new_handle = state
            .telegram_notifier
            .spawn_inbound(state.telegram_inbound_tx.clone())
            .await;
        *slot = Some(new_handle);
    }
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
Always respond by invoking the `respond` tool exactly once. \
Put prose in `explanation`. If a single shell command would directly \
help, put it in `command` with a one-sentence rationale. Prefer top-1: \
do not list alternatives in prose. Suggest up to 3 short follow-up \
questions the user might ask next. Keep everything terse.";

#[tauri::command]
async fn ask_agent(
    state: State<'_, AppState>,
    session_id: String,
    question: String,
    on_explanation: Channel<String>,
    on_response: Channel<serde_json::Value>,
) -> Result<(), String> {
    let id = parse_id(&session_id)?;

    // 1. Read settings (clone so we don't hold the lock across the http call).
    let (api_key, model_chat, max_per_min) = {
        let s = state.settings.lock().await;
        let key = s
            .anthropic_api_key
            .clone()
            .ok_or("no api key configured — open Settings (⌘,)")?;
        (
            key,
            s.agent.model_chat.clone(),
            s.agent.max_calls_per_minute,
        )
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

    // 4. Stream the response, forcing the respond tool.
    let req = karl_agent::AskRequest {
        api_key,
        model: model_chat,
        system_prompt: SYSTEM_PROMPT.to_string(),
        user_message,
        max_tokens: 1024,
        thinking_budget: None,
        force_tool: Some(karl_agent::respond_tool::tool_schema()),
    };

    let acc = std::sync::Arc::new(std::sync::Mutex::new(
        karl_agent::respond_tool::ToolInputAccumulator::default(),
    ));
    let acc_for_cb = acc.clone();

    karl_agent::ask_streaming(req, move |event| match event {
        karl_agent::AgentEvent::Delta(text) => {
            let _ = on_explanation.send(text);
        }
        karl_agent::AgentEvent::ToolInputDelta { fragment, .. } => {
            if !fragment.is_empty() {
                acc_for_cb.lock().unwrap().push(&fragment);
            }
        }
        karl_agent::AgentEvent::Usage(_)
        | karl_agent::AgentEvent::Done
        | karl_agent::AgentEvent::ThinkingDelta(_)
        | karl_agent::AgentEvent::StopReason(_)
        | karl_agent::AgentEvent::ToolInputDone { .. } => {}
    })
    .await
    .map_err(|e| e.to_string())?;

    // Drain the accumulator and ship the parsed response.
    let parsed = {
        let inner = match std::sync::Arc::try_unwrap(acc) {
            Ok(m) => m.into_inner().unwrap(),
            Err(arc) => std::mem::take(&mut *arc.lock().unwrap()),
        };
        inner
            .finish()
            .map_err(|e| format!("parse respond tool: {e}"))?
    };
    let value = serde_json::to_value(&parsed).map_err(|e| e.to_string())?;
    let _ = on_response.send(value);

    Ok(())
}

#[tauri::command]
async fn structure_list_dir(
    cwd: String,
    show_ignored: Option<bool>,
) -> Result<Vec<structure::DirEntry>, String> {
    let path = PathBuf::from(cwd);
    let show_ignored = show_ignored.unwrap_or(false);
    tokio::task::spawn_blocking(move || structure::list_dir(&path, show_ignored))
        .await
        .map_err(|e| format!("list_dir join: {e}"))?
}

/// Create an empty file or directory at `path`. The frontend
/// resolves the user-typed name into an absolute path before calling
/// us so we never have to interpret relative segments here. `kind`
/// is "file" or "dir"; anything else is rejected.
#[tauri::command]
async fn structure_create_path(path: String, kind: String) -> Result<String, String> {
    let p = PathBuf::from(path);
    match kind.as_str() {
        "file" => tokio::task::spawn_blocking(move || structure::create_file(&p))
            .await
            .map_err(|e| format!("create_file join: {e}"))?,
        "dir" => tokio::task::spawn_blocking(move || structure::create_dir(&p))
            .await
            .map_err(|e| format!("create_dir join: {e}"))?,
        other => Err(format!("unknown create kind: {other}")),
    }
}

/// Hard cap on the per-file read size to keep memory bounded. The
/// frontend can request a smaller threshold; we never honor a larger
/// one. 4 MiB is well above the 1 MiB UI default and below anything
/// that would stall the IPC bridge.
const MAX_READ_BYTES_HARD_CAP: u64 = 4 * 1024 * 1024;

/// Cheap file/dir existence probe used by the xterm link provider to
/// decide whether a path-like token in terminal output is actually a
/// real file we can open in the editor on Cmd+Click. Resolves the
/// path relative to `cwd` when not absolute. Returns the canonical
/// absolute path on hit, `None` otherwise.
#[tauri::command]
async fn resolve_existing_path(
    path: String,
    cwd: Option<String>,
) -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        let candidate = if p.is_absolute() {
            p.to_path_buf()
        } else if let Some(c) = cwd.as_deref() {
            std::path::Path::new(c).join(p)
        } else {
            return Ok(None);
        };
        match candidate.canonicalize() {
            Ok(canon) if canon.is_file() => Ok(Some(canon.to_string_lossy().into_owned())),
            _ => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("resolve_existing_path join: {e}"))?
}

#[tauri::command]
async fn structure_read_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<structure::ReadResult, String> {
    let p = PathBuf::from(path);
    let max = max_bytes
        .unwrap_or(1024 * 1024)
        .min(MAX_READ_BYTES_HARD_CAP);
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
async fn structure_write_binary_file(path: String, bytes: Vec<u8>) -> Result<(), String> {
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || structure::write_file_binary(&p, &bytes))
        .await
        .map_err(|e| format!("write_binary join: {e}"))?
}

const MAX_BINARY_READ_BYTES_HARD_CAP: u64 = 16 * 1024 * 1024;

/// Resolve a CSS font-family stack to the bytes of the first matching
/// installed font file. The frontend feeds the bytes to `font-ligatures`
/// (browser-side) so xterm can register a character joiner that picks
/// up the *full* ligature table of the user's font — not just the
/// addon's hardcoded fallback set.
#[tauri::command]
async fn read_font_bytes(family_stack: String) -> Result<Vec<u8>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<u8>, String> {
        use fontdb::{Database, Family, Query};
        let families: Vec<String> = family_stack
            .split(',')
            .map(|s| s.trim().trim_matches(|c| c == '"' || c == '\'').to_string())
            .filter(|s| {
                !s.is_empty()
                    && !matches!(
                        s.to_ascii_lowercase().as_str(),
                        "monospace"
                            | "serif"
                            | "sans-serif"
                            | "ui-monospace"
                            | "system-ui"
                            | "cursive"
                            | "fantasy"
                    )
            })
            .collect();
        if families.is_empty() {
            return Err("no concrete font family in stack".into());
        }
        let mut db = Database::new();
        db.load_system_fonts();
        let family_refs: Vec<Family<'_>> =
            families.iter().map(|n| Family::Name(n.as_str())).collect();
        let id = db
            .query(&Query {
                families: &family_refs,
                ..Default::default()
            })
            .ok_or_else(|| format!("no installed font matched {families:?}"))?;
        let (src, _) = db.face_source(id).ok_or("font source unavailable")?;
        match src {
            fontdb::Source::File(path) => {
                std::fs::read(&path).map_err(|e| format!("read {}: {e}", path.display()))
            }
            fontdb::Source::Binary(data) | fontdb::Source::SharedFile(_, data) => {
                Ok(data.as_ref().as_ref().to_vec())
            }
        }
    })
    .await
    .map_err(|e| format!("read_font_bytes join: {e}"))?
}

/// Enumerate installed monospace font families so the settings UI can
/// offer a typeahead instead of forcing the user to type the exact name.
/// Returns unique family names (English US when available) sorted
/// case-insensitively.
#[tauri::command]
async fn list_monospace_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| -> Vec<String> {
        let mut db = fontdb::Database::new();
        db.load_system_fonts();
        let mut seen: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
        for face in db.faces() {
            if !face.monospaced {
                continue;
            }
            if let Some((name, _)) = face.families.first() {
                if !name.is_empty() {
                    seen.insert(name.clone());
                }
            }
        }
        let mut out: Vec<String> = seen.into_iter().collect();
        out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        out
    })
    .await
    .map_err(|e| format!("list_monospace_fonts join: {e}"))
}

#[tauri::command]
async fn structure_read_binary_file(
    path: String,
    max_bytes: Option<u64>,
) -> Result<structure::BinaryReadResult, String> {
    let p = PathBuf::from(path);
    let max = max_bytes
        .unwrap_or(10 * 1024 * 1024)
        .min(MAX_BINARY_READ_BYTES_HARD_CAP);
    tokio::task::spawn_blocking(move || structure::read_file_binary(&p, max))
        .await
        .map_err(|e| format!("read_binary join: {e}"))?
}

#[tauri::command]
async fn structure_rename_path(from: String, to: String) -> Result<(), String> {
    let from_p = PathBuf::from(from);
    let to_p = PathBuf::from(to);
    tokio::task::spawn_blocking(move || structure::rename_path(&from_p, &to_p))
        .await
        .map_err(|e| format!("rename join: {e}"))?
}

#[tauri::command]
async fn structure_trash_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(path);
    tokio::task::spawn_blocking(move || structure::trash_path(&p))
        .await
        .map_err(|e| format!("trash join: {e}"))?
}

/// Copy OS files/folders (dragged in from Finder, etc.) into a tree
/// directory. Heavy recursive I/O runs on the blocking pool.
#[tauri::command]
async fn structure_copy_into(
    sources: Vec<String>,
    dest_dir: String,
) -> Result<Vec<String>, String> {
    let srcs: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    let dest = PathBuf::from(dest_dir);
    tokio::task::spawn_blocking(move || structure::copy_into(&srcs, &dest))
        .await
        .map_err(|e| format!("copy_into join: {e}"))?
}

/// Move tree entries into a directory (internal drag-to-move between
/// folders). Rename when possible, copy+delete across filesystems.
#[tauri::command]
async fn structure_move_into(
    sources: Vec<String>,
    dest_dir: String,
) -> Result<Vec<String>, String> {
    let srcs: Vec<PathBuf> = sources.into_iter().map(PathBuf::from).collect();
    let dest = PathBuf::from(dest_dir);
    tokio::task::spawn_blocking(move || structure::move_into(&srcs, &dest))
        .await
        .map_err(|e| format!("move_into join: {e}"))?
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

/// Fuzzy filename finder over `cwd`. Pairs with `structure_search`:
/// same ignore rules, but matches against paths instead of contents.
#[tauri::command]
async fn structure_find_files(
    cwd: String,
    query: String,
    limit: u32,
) -> Result<Vec<structure::FileHit>, String> {
    let p = PathBuf::from(cwd);
    tokio::task::spawn_blocking(move || structure::find_files(&p, &query, limit))
        .await
        .map_err(|e| format!("find_files join: {e}"))?
}

#[tauri::command]
async fn find_recent_commands(
    state: State<'_, AppState>,
    query: String,
    limit: usize,
) -> Result<Vec<storage::CommandHit>, String> {
    state
        .storage
        .recent_commands(query, limit.clamp(1, 200))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_block_excerpt(
    state: State<'_, AppState>,
    block_id: String,
) -> Result<storage::BlockExcerptDto, String> {
    state
        .storage
        .read_block_excerpt(block_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn read_session_excerpt(
    state: State<'_, AppState>,
    session_id: String,
    n: usize,
) -> Result<storage::SessionExcerptDto, String> {
    state
        .storage
        .read_session_excerpt(session_id, n)
        .await
        .map_err(|e| e.to_string())
}

// ── 3.18 Spec Author — DTOs & Tauri commands ─────────────────────────────────

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StepResultDto {
    draft_id: String,
    output: StepOutputDto,
}

#[derive(serde::Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum StepOutputDto {
    Question { phase: String, text: String },
    Final { markdown: String },
}

fn phase_to_str(phase: &karl_agent::spec_author::Phase) -> String {
    match phase {
        karl_agent::spec_author::Phase::Goal => "goal".into(),
        karl_agent::spec_author::Phase::OutOfScope => "outofscope".into(),
        karl_agent::spec_author::Phase::Acceptance => "acceptance".into(),
        karl_agent::spec_author::Phase::FileBoundaries => "fileboundaries".into(),
        karl_agent::spec_author::Phase::Complexity => "complexity".into(),
        karl_agent::spec_author::Phase::OpenQuestions => "openquestions".into(),
        karl_agent::spec_author::Phase::Emit => "emit".into(),
    }
}

#[tauri::command]
async fn spec_author_step(
    state: State<'_, AppState>,
    draft_id: Option<String>,
    user_msg: String,
    cwd: Option<String>,
) -> Result<StepResultDto, String> {
    let api_key = {
        let s = state.settings.lock().await;
        s.anthropic_api_key
            .clone()
            .ok_or("no api key configured — open Settings (⌘,)")?
    };

    let base_dir = karl_agent::spec_author::home_covenant_dir().map_err(|e| e.to_string())?;

    let mut draft = match draft_id {
        Some(ref id_str) => {
            let ulid = id_str.parse::<Ulid>().map_err(|e| e.to_string())?;
            karl_agent::spec_author::load_draft_default(ulid).map_err(|e| e.to_string())?
        }
        None => karl_agent::spec_author::SpecDraft {
            id: Ulid::new(),
            messages: vec![],
            partial_md: None,
            last_updated: chrono::Utc::now(),
            status: karl_agent::spec_author::DraftStatus::InProgress {
                phase: karl_agent::spec_author::Phase::Goal,
            },
            repo_root: None,
        },
    };

    let dispatcher = karl_agent::spec_author::AnthropicDispatcher {
        api_key,
        model: "claude-sonnet-4-6".into(),
    };

    let cwd_path = cwd.as_ref().map(std::path::PathBuf::from);
    // Stamp the draft with its project's git root on first authoring (and
    // backfill legacy drafts on resume) so the drafts tab can scope per group.
    if draft.repo_root.is_none() {
        if let Some(ref c) = cwd_path {
            draft.repo_root =
                Some(karl_agent::spec_author::resolve_repo_root(c).display().to_string());
        }
    }
    let output = karl_agent::spec_author::step_with_context(
        &dispatcher,
        &mut draft,
        user_msg,
        &base_dir,
        cwd_path.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    let output_dto = match &output {
        karl_agent::spec_author::StepOutput::Question { phase, text } => StepOutputDto::Question {
            phase: phase_to_str(phase),
            text: text.clone(),
        },
        karl_agent::spec_author::StepOutput::Final { markdown } => StepOutputDto::Final {
            markdown: markdown.clone(),
        },
    };

    Ok(StepResultDto {
        draft_id: draft.id.to_string(),
        output: output_dto,
    })
}

struct TauriSink {
    app: tauri::AppHandle,
    topic: String,
}
impl karl_agent::spec_author::stream::StreamSink for TauriSink {
    fn emit(&self, event: karl_agent::spec_author::stream::SpecStreamEvent) {
        use tauri::Emitter;
        let _ = self.app.emit(&self.topic, &event);
    }
}

#[tauri::command]
async fn spec_author_stream_step(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    draft_id: Option<String>,
    user_msg: String,
    cwd: Option<String>,
) -> Result<String, String> {
    use karl_agent::spec_author as sa;
    let base_dir = sa::home_covenant_dir().map_err(|e| e.to_string())?;

    let mut draft = match draft_id {
        Some(ref id) => {
            let ulid = id.parse::<Ulid>().map_err(|e| e.to_string())?;
            sa::load_draft_default(ulid).unwrap_or_else(|_| sa::SpecDraft {
                id: ulid, messages: vec![], partial_md: None,
                last_updated: chrono::Utc::now(),
                status: sa::DraftStatus::InProgress { phase: sa::Phase::Goal },
                repo_root: None,
            })
        }
        None => sa::SpecDraft {
            id: Ulid::new(), messages: vec![], partial_md: None,
            last_updated: chrono::Utc::now(),
            status: sa::DraftStatus::InProgress { phase: sa::Phase::Goal },
            repo_root: None,
        },
    };
    let draft_id_str = draft.id.to_string();
    let topic = format!("spec://{}/event", draft_id_str);

    // Jail tools at the enclosing git root (not the raw cwd) and restate the
    // grounding in the system prompt on every turn. When no cwd reached us,
    // the prompt says so explicitly instead of leaving the model to guess.
    let cwd_path = cwd.as_ref().map(std::path::PathBuf::from);
    // Stamp the draft with its project's git root on first authoring (and
    // backfill legacy drafts on resume) so the drafts tab can scope per group.
    if draft.repo_root.is_none() {
        if let Some(ref c) = cwd_path {
            draft.repo_root = Some(sa::resolve_repo_root(c).display().to_string());
        }
    }
    let (repo_root, system) = sa::compose_system(cwd_path.as_deref(), &base_dir);

    let sink = TauriSink { app: app.clone(), topic: topic.clone() };

    // Resolve the Spec Creator role to a provider + model from settings, and
    // build the matching streaming dispatcher (Anthropic vs OpenAI/Azure).
    let dispatcher: Box<dyn sa::stream::StreamingDispatcher> = {
        use karl_agent::provider::{azure_foundry::default_api_version, azure_foundry::AzureMode, ProviderKind};
        let s = state.settings.lock().await;
        let route = s.model_routes.get(&crate::settings::Role::SpecCreator)
            .ok_or("no Spec Creator model route configured — open Settings → Models")?;
        let entry = s.providers.get(&route.provider_id)
            .ok_or_else(|| format!("provider `{}` not configured", route.provider_id))?;
        let model = route.model.clone();
        match entry.kind {
            ProviderKind::Anthropic => {
                let api_key = entry.api_key.clone()
                    .or_else(|| s.anthropic_api_key.clone())
                    .ok_or("Anthropic api key not configured — open Settings (⌘,)")?;
                Box::new(sa::stream::AnthropicStreamingDispatcher { api_key, model })
            }
            ProviderKind::OpenAiCompat => {
                let base = entry.base_url.clone()
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| "http://localhost:11434/v1".to_string());
                let url = format!("{}/chat/completions", base.trim_end_matches('/'));
                Box::new(sa::stream::OpenAiStreamingDispatcher {
                    url, api_key: entry.api_key.clone().unwrap_or_default(),
                    auth: sa::stream::OpenAiAuth::Bearer, model: Some(model),
                })
            }
            ProviderKind::AzureFoundry => {
                let mode = entry.azure_mode.ok_or("Azure provider missing azure_mode")?;
                let endpoint = entry.base_url.clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or("Azure provider missing endpoint")?;
                let api_key = entry.api_key.clone()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or("Azure provider missing api_key")?;
                let api_version = entry.azure_api_version.clone()
                    .unwrap_or_else(|| default_api_version(mode).to_string());
                let base = endpoint.trim_end_matches('/');
                let (url, body_model) = match mode {
                    AzureMode::AzureOpenAi => {
                        let dep = entry.azure_deployment.clone()
                            .ok_or("Azure OpenAI mode requires a deployment name")?;
                        (format!("{}/openai/deployments/{}/chat/completions?api-version={}",
                            base, dep, api_version), None)
                    }
                    AzureMode::AiInference => (
                        format!("{}/models/chat/completions?api-version={}", base, api_version),
                        Some(model),
                    ),
                };
                Box::new(sa::stream::OpenAiStreamingDispatcher {
                    url, api_key, auth: sa::stream::OpenAiAuth::ApiKeyHeader, model: body_model,
                })
            }
        }
    };

    let result = sa::stream::step_streaming(
        &*dispatcher, &mut draft, user_msg, &repo_root, &system, &sink, 40).await;

    draft.last_updated = chrono::Utc::now();
    let _ = sa::save_draft(&base_dir, &draft);

    if let Err(e) = result {
        use tauri::Emitter;
        let _ = app.emit(&topic, &sa::stream::SpecStreamEvent::Error { message: e.clone() });
        return Err(e);
    }
    Ok(draft_id_str)
}

#[tauri::command]
async fn spec_author_load_draft(id: String) -> Result<karl_agent::spec_author::SpecDraft, String> {
    let ulid = id.parse::<Ulid>().map_err(|e| e.to_string())?;
    karl_agent::spec_author::load_draft_default(ulid).map_err(|e| e.to_string())
}

#[tauri::command]
async fn spec_author_list_drafts(
    repo_root: Option<String>,
) -> Result<Vec<karl_agent::spec_author::SpecDraft>, String> {
    use karl_agent::spec_author as sa;
    let all = sa::list_drafts_default().map_err(|e| e.to_string())?;
    // No group root (global entrance, or a group with no folder set) → unfiltered.
    let Some(filter) = repo_root.filter(|s| !s.is_empty()) else {
        return Ok(all);
    };
    // Match on the resolved git root; legacy/unassigned drafts (None) show everywhere.
    let resolved = sa::resolve_repo_root(std::path::Path::new(&filter))
        .display()
        .to_string();
    Ok(all
        .into_iter()
        .filter(|d| d.repo_root.is_none() || d.repo_root.as_deref() == Some(resolved.as_str()))
        .collect())
}

#[tauri::command]
async fn spec_author_mark_published(id: String) -> Result<(), String> {
    let id: ulid::Ulid = id.parse().map_err(|e: ulid::DecodeError| e.to_string())?;
    karl_agent::spec_author::mark_published_default(id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn spec_author_delete_draft(id: String) -> Result<(), String> {
    let ulid = id.parse::<Ulid>().map_err(|e| e.to_string())?;
    karl_agent::spec_author::delete_draft_default(ulid).map_err(|e| e.to_string())
}

#[tauri::command]
async fn spec_author_save_markdown(id: String, markdown: String) -> Result<(), String> {
    let ulid = id.parse::<Ulid>().map_err(|e| e.to_string())?;
    karl_agent::spec_author::save_markdown_default(ulid, &markdown).map_err(|e| e.to_string())
}

#[tauri::command]
async fn telegram_test_connection(state: State<'_, AppState>) -> Result<(), String> {
    state.telegram_notifier.test_connection().await
}

#[tauri::command]
async fn telegram_status(
    state: State<'_, AppState>,
) -> Result<crate::telegram::TelegramStatus, String> {
    Ok(state.telegram_notifier.status().await)
}

#[tauri::command]
async fn search_session_files(
    state: tauri::State<'_, AppState>,
    session_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<crate::file_search::FileMatch>, String> {
    let sid = parse_id(&session_id)?;
    let cwd = {
        let sessions = state.sessions.lock().await;
        let managed = sessions
            .get(&sid)
            .ok_or_else(|| format!("unknown session {session_id}"))?;
        let world = managed.world.lock().await;
        world.cwd.clone()
    };
    let limit = limit.unwrap_or(8).min(50);
    Ok(crate::file_search::search(
        &state.file_search_cache,
        sid,
        &cwd,
        &query,
        limit,
    ))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
/// Install a panic hook that appends panic location + message + backtrace to
/// `~/.karlTerminal/crash.log` before the default handler runs. With
/// `panic = "abort"` + `strip = true` in release the process dies without
/// leaving any panic info in the macOS .ips, so this is the only way to
/// recover the panic site post-mortem.
fn install_crash_logger() {
    let log_path = dirs::home_dir()
        .map(|h| h.join(".karlTerminal").join("crash.log"))
        .unwrap_or_else(|| std::path::PathBuf::from("crash.log"));
    if let Some(parent) = log_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let loc = info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_else(|| "<unknown>".into());
        let msg = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(|s| s.as_str()))
            .unwrap_or("<non-string panic payload>");
        let thread = std::thread::current();
        let tname = thread.name().unwrap_or("<unnamed>");
        let bt = std::backtrace::Backtrace::force_capture();
        let entry = format!(
            "\n===== PANIC {ts} =====\nthread: {tname}\nlocation: {loc}\nmessage: {msg}\nversion: {}\nbacktrace:\n{bt}\n",
            env!("CARGO_PKG_VERSION"),
        );
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
        {
            let _ = f.write_all(entry.as_bytes());
            let _ = f.flush();
        }
        eprintln!("{entry}");
        default(info);
    }));
}

/// Build the macOS application menu.
///
/// Tauri installs a default menu when none is supplied, and that default
/// binds `⌘W` to a predefined "Close Window" item which tears down the
/// focused window natively — before our JS `keydown` handler can run. The
/// result: `⌘W` quits Covenant instead of closing the active tab/pane.
///
/// We rebuild the menu here so we keep the items a terminal needs (Edit's
/// Copy/Paste/Select-All, Quit, Minimize, Fullscreen) but replace the
/// window-closing `⌘W` with a custom "Close Tab" item. Its action is routed
/// to the frontend via the `menu://close-tab` event, where the existing
/// tab/pane close logic lives (including "quit on last tab").
fn build_app_menu(app: &tauri::AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};

    let app_menu = Submenu::with_items(
        app,
        "Covenant",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // Custom Close Tab item — bound to ⌘W. The native accelerator fires this
    // menu item (routed through `on_menu_event`) instead of closing the
    // window, so the frontend owns what ⌘W actually does.
    let close_tab = MenuItem::with_id(app, "close-tab", "Close Tab", true, Some("CmdOrCtrl+W"))?;
    let new_tab = MenuItem::with_id(app, "new-tab", "New Tab", true, Some("CmdOrCtrl+T"))?;
    let copy_token = MenuItem::with_id(
        app,
        "copy-pairing-token",
        "Copy Remote Pairing Token",
        true,
        None::<&str>,
    )?;
    let file_menu = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &new_tab,
            &close_tab,
            &PredefinedMenuItem::separator(app)?,
            &copy_token,
        ],
    )?;

    let edit_menu = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;

    let window_menu = Submenu::with_items(
        app,
        "Window",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;

    Menu::with_items(app, &[&app_menu, &file_menu, &edit_menu, &window_menu])
}

pub fn run() {
    tracing_subscriber::registry()
        .with(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with(fmt::layer().with_target(false))
        .init();

    install_crash_logger();

    tracing::info!("covenant starting");

    tauri::Builder::default()
        .menu(|handle| build_app_menu(handle))
        .on_menu_event(|app, event| {
            // ⌘W / ⌘T accelerators land here (the native menu consumes the
            // keystroke). Forward to the frontend, which owns tab/pane state.
            match event.id().as_ref() {
                "close-tab" => {
                    let _ = app.emit("menu://close-tab", ());
                }
                "new-tab" => {
                    let _ = app.emit("menu://new-tab", ());
                }
                "copy-pairing-token" => {
                    // Copy from the Rust side via `pbcopy`. Doing it in the
                    // webview (`navigator.clipboard.writeText`) fails with
                    // "Document is not focused" when triggered from a native
                    // menu click, since the menubar steals focus.
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let status = match karl_score::auth::load_jwt() {
                            Ok(Some(token)) if copy_to_clipboard(&token) => "copied",
                            Ok(Some(_)) => "error",
                            _ => "signed-out",
                        };
                        let _ = app.emit("menu://pairing-token-copied", status);
                    });
                }
                _ => {}
            }
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_shortcut("CmdOrCtrl+Shift+N")
                .expect("valid shortcut string")
                .with_handler(|app, _shortcut, event| {
                    if event.state == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        if let Some(win) = app.get_webview_window("notch") {
                            let visible = win.is_visible().unwrap_or(false);
                            if visible {
                                let _ = win.hide();
                            } else {
                                let state: tauri::State<AppState> = app.state();
                                let settings = state.settings.clone();
                                let win_clone = win.clone();
                                tauri::async_runtime::spawn(async move {
                                    let corner = settings.lock().await.notch_corner;
                                    notch::show_notch(&win_clone, corner);
                                });
                                let _ = win.emit("notch:probe", ());
                            }
                        }
                    }
                })
                .build(),
        )
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

            // Boot-time: construct OperatorRegistry, seed Default from legacy
            // operator config, then manage Arc'd registry + storage clone so
            // Tauri commands (Task 6) can resolve State<Arc<OperatorRegistry>>
            // and State<Arc<Storage>>.
            let registry = tauri::async_runtime::block_on(async {
                crate::operator_registry::OperatorRegistry::load(&storage, dir.join("operators"))
                    .await
            })
            .map_err(|e| format!("load operator registry: {e}"))?;

            {
                let (legacy_op_cfg, global_model) = {
                    let s = settings_arc.blocking_lock();
                    (s.operator.clone(), s.agent.model_summary.clone())
                };
                if let Err(e) = tauri::async_runtime::block_on(async {
                    registry
                        .seed_default_from_settings(&storage, &legacy_op_cfg, &global_model)
                        .await
                }) {
                    tracing::warn!(error = %e, "operator seed failed; continuing");
                }
                if let Err(e) = tauri::async_runtime::block_on(async {
                    registry.upgrade_legacy_default_avatar(&storage).await
                }) {
                    tracing::warn!(error = %e, "upgrade_legacy_default_avatar failed; continuing");
                }
                if let Err(e) = tauri::async_runtime::block_on(async {
                    registry.migrate_personas_to_souls(&storage).await
                }) {
                    tracing::warn!(error = %e, "SOUL.md migration failed; continuing");
                }
            }

            let registry_arc = Arc::new(registry);
            app.manage(registry_arc.clone());
            let storage_arc = Arc::new(storage.clone());
            app.manage(storage_arc.clone());
            let teammate_runtime = Arc::new(teammate::TeammateRuntime::new());
            app.manage(teammate_runtime.clone());
            app.manage(project_notes::Store::new(storage.conn()));
            app.manage(prompts::PromptStore::new(storage.conn()));

            // Task supervisor: aggregates per-session SessionEvent buses
            // and translates BlockFinished into operator sentiment +
            // task-status transitions. `supervisor_bus_tx` is stored on
            // AppState so `spawn_session` can forward each new session's
            // bus into the aggregator.
            let (supervisor_bus_tx, supervisor_bus_rx) =
                tokio::sync::broadcast::channel::<karl_session::SessionEvent>(256);
            let supervisor = Arc::new(
                crate::teammate::task_supervisor::TaskSupervisor::new(
                    storage_arc.clone(),
                    teammate_runtime.clone(),
                    Arc::new(app.handle().clone())
                        as Arc<dyn crate::teammate::task_supervisor::MessageEmitter>,
                ),
            );
            supervisor.clone().spawn(supervisor_bus_rx);
            app.manage(supervisor);

            // Familiars: per-session AI companion with persistent
            // SQLite-backed memory. Storage root is under the user's
            // home; falls back to a relative dir on exotic systems
            // where home_dir() returns None.
            let familiars_root = dirs::home_dir()
                .map(|p| p.join(".karlTerminal").join("familiars"))
                .unwrap_or_else(|| PathBuf::from("./.familiars"));
            if let Err(e) = std::fs::create_dir_all(&familiars_root) {
                tracing::warn!(error = %e, "create familiars root failed; continuing");
            }
            let familiar_manager = Arc::new(
                karl_familiar::FamiliarManager::new(familiars_root),
            );
            app.manage(familiar_manager.clone());

            let aom_handle = aom::new_handle();
            let connectivity_handle = connectivity::new_handle();
            let notifier = Notifier::new(app.handle().clone(), settings_arc.clone());
            // Pre-warm macOS notification permission so the first real
            // trigger doesn't race the OS prompt. tauri-plugin-notification
            // no-ops when permission is already granted.
            request_notification_permission_async(notifier.clone());

            let sendgrid_key = {
                let s = settings_arc.blocking_lock();
                s.sendgrid_api_key.clone().unwrap_or_default()
            };
            let sg_client: std::sync::Arc<dyn crate::email::client::SendGridClient> =
                std::sync::Arc::new(crate::email::client::HttpSendGridClient::new(sendgrid_key));
            let email_notifier = std::sync::Arc::new(crate::email::EmailNotifier::new(
                sg_client.clone(),
                settings_arc.clone(),
            ));

            // Spawn the digest flush loop. Pull from/to/window from settings at spawn
            // time; if any are missing the buffer just stays empty and the loop is a no-op.
            {
                let (from, to, minutes) = {
                    let s = settings_arc.blocking_lock();
                    let from = s.notifications.email_from.clone().unwrap_or_default();
                    let to = s.notifications.email_to.clone().unwrap_or_default();
                    let minutes = s.notifications.email_digest_window_minutes.max(1);
                    (from, to, minutes)
                };
                let buf = email_notifier.buffer.clone();
                let client = sg_client.clone();
                tauri::async_runtime::spawn(crate::email::digest::spawn_flush_loop(
                    buf,
                    client,
                    from,
                    to,
                    std::time::Duration::from_secs((minutes as u64) * 60),
                ));
            }

            let vitals = vitals::spawn(app.handle().clone());
            app.manage(vitals.clone());
            let exec_vitals = exec_vitals::ExecVitals::new(vitals.clone());

            let cross = CrossSessionWatcher::spawn(app.handle().clone(), settings_arc.clone(), vitals.clone());
            let mission_store = dir.join("session_missions.json");
            let embedder_cell: Arc<tokio::sync::OnceCell<Arc<embedder::Embedder>>> =
                Arc::new(tokio::sync::OnceCell::new());

            // Telegram fan-out: construct the notifier next to its email
            // counterpart, then subscribe to the escalation bus the
            // operator publishes on. The Tauri-command path for resolving
            // an escalation from Telegram lands in Task 8.
            let tg_client: std::sync::Arc<dyn crate::telegram::client::TelegramClient> =
                std::sync::Arc::new(crate::telegram::client::ReqwestTelegramClient::new());
            let telegram_notifier = std::sync::Arc::new(
                crate::telegram::TelegramNotifier::new(
                    tg_client,
                    settings_arc.clone(),
                    registry_arc.clone(),
                ),
            );
            let (escalation_bus_tx, _) =
                tokio::sync::broadcast::channel::<karl_session::SessionEvent>(64);
            {
                let mut rx = escalation_bus_tx.subscribe();
                let tg = telegram_notifier.clone();
                tauri::async_runtime::spawn(async move {
                    use karl_session::SessionEvent;
                    loop {
                        match rx.recv().await {
                            Ok(SessionEvent::EscalationRequested {
                                session,
                                escalation_id,
                                kind,
                                summary,
                                actions,
                                operator,
                                project,
                            }) => {
                                let sid_str = session.to_string();
                                // Last 4 chars of the session id as a short
                                // human-readable handle for the message.
                                let session_short: String = {
                                    let n = sid_str.chars().count();
                                    sid_str.chars().skip(n.saturating_sub(4)).collect()
                                };
                                let args = crate::telegram::SendEscalationArgs {
                                    operator: &operator,
                                    project: &project,
                                    session_short: &session_short,
                                    kind: &kind,
                                    summary: &summary,
                                    actions: &actions,
                                    escalation_id: &escalation_id,
                                    session_id: &sid_str,
                                    tab_id: Some(sid_str.as_str()),
                                };
                                if let Err(e) = tg.send_escalation(&args).await {
                                    tracing::warn!(error = %e, "telegram send_escalation failed");
                                }
                            }
                            Ok(SessionEvent::EscalationResolved {
                                escalation_id,
                                resolution,
                                source: _,
                            }) => {
                                use crate::telegram::inbound::ActionKind;
                                use karl_session::EscalationResolution;
                                let action_kind = match resolution {
                                    EscalationResolution::Approved => ActionKind::PushPR,
                                    EscalationResolution::Rejected => ActionKind::Reply,
                                    EscalationResolution::Snoozed => ActionKind::Snooze,
                                    EscalationResolution::FreeText(_) => ActionKind::Custom,
                                };
                                if let Err(e) = tg.on_resolved(&escalation_id, action_kind).await {
                                    tracing::warn!(error = %e, "telegram on_resolved failed");
                                }
                            }
                            Ok(SessionEvent::MissionCompleted { session, summary }) => {
                                let sid_str = session.to_string();
                                let session_short: String =
                                    sid_str.chars().take(6).collect();
                                let tab_name = format!("session:{session_short}");
                                if let Err(e) = tg
                                    .send_mission_event(
                                        crate::telegram::MissionKind::Completed,
                                        &tab_name,
                                        &summary,
                                        Some(sid_str.as_str()),
                                    )
                                    .await
                                {
                                    tracing::warn!(error = %e, "telegram mission completed failed");
                                }
                            }
                            Ok(SessionEvent::MissionFailed { session, reason }) => {
                                let sid_str = session.to_string();
                                let session_short: String =
                                    sid_str.chars().take(6).collect();
                                let tab_name = format!("session:{session_short}");
                                if let Err(e) = tg
                                    .send_mission_event(
                                        crate::telegram::MissionKind::Failed,
                                        &tab_name,
                                        &reason,
                                        Some(sid_str.as_str()),
                                    )
                                    .await
                                {
                                    tracing::warn!(error = %e, "telegram mission failed failed");
                                }
                            }
                            Ok(_) => { /* not interested */ }
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                                tracing::warn!(skipped = n, "telegram subscriber lagged");
                            }
                        }
                    }
                });
            }

            // Telegram inbound: long-poll loop emits InboundEvent into a
            // channel; the drain task republishes Resolved as
            // EscalationResolved on the bus and, for FreeText, types the
            // text into the originating session's PTY (Enter appended so
            // the executor TUI receives it as a submitted message).
            let (tg_inbound_tx, mut tg_inbound_rx) =
                tokio::sync::mpsc::unbounded_channel::<crate::telegram::InboundEvent>();
            let initial_inbound_handle = tauri::async_runtime::block_on(
                telegram_notifier.spawn_inbound(tg_inbound_tx.clone()),
            );
            let tg_inbound_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>> =
                Arc::new(Mutex::new(Some(initial_inbound_handle)));

            {
                let escalation_bus_tx_for_drain = escalation_bus_tx.clone();
                let tg_for_drain = telegram_notifier.clone();
                let app_handle_for_drain = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    use karl_session::{EscalationResolution, ResolutionSource, SessionEvent};
                    while let Some(evt) = tg_inbound_rx.recv().await {
                        match evt {
                            crate::telegram::InboundEvent::Resolved {
                                escalation_id,
                                resolution,
                            } => {
                                let (res, free_text) = match resolution {
                                    crate::telegram::ResolutionFromTelegram::Approved => {
                                        (EscalationResolution::Approved, None)
                                    }
                                    crate::telegram::ResolutionFromTelegram::Rejected => {
                                        (EscalationResolution::Rejected, None)
                                    }
                                    crate::telegram::ResolutionFromTelegram::Snoozed => {
                                        (EscalationResolution::Snoozed, None)
                                    }
                                    crate::telegram::ResolutionFromTelegram::FreeText(t) => {
                                        let txt = t.clone();
                                        (EscalationResolution::FreeText(t), Some(txt))
                                    }
                                };
                                let _ = escalation_bus_tx_for_drain.send(
                                    SessionEvent::EscalationResolved {
                                        escalation_id: escalation_id.clone(),
                                        resolution: res,
                                        source: ResolutionSource::Telegram,
                                    },
                                );
                                if let Some(text) = free_text {
                                    let session_str = tg_for_drain
                                        .state
                                        .session_map
                                        .lock()
                                        .unwrap()
                                        .get(&escalation_id)
                                        .cloned();
                                    if let Some(sid_str) = session_str {
                                        match sid_str.parse::<karl_session::SessionId>() {
                                            Ok(sid) => {
                                                if let Some(state) = app_handle_for_drain
                                                    .try_state::<AppState>()
                                                {
                                                    let mut payload = text.into_bytes();
                                                    payload.push(b'\n');
                                                    let mut sessions =
                                                        state.sessions.lock().await;
                                                    if let Some(managed) =
                                                        sessions.get_mut(&sid)
                                                    {
                                                        if let Err(e) =
                                                            managed.session.write(&payload)
                                                        {
                                                            tracing::warn!(error = %e, "telegram free-text inject failed");
                                                        }
                                                    } else {
                                                        tracing::warn!(session = %sid, "telegram free-text: session not found");
                                                    }
                                                }
                                            }
                                            Err(e) => {
                                                tracing::warn!(error = %e, "telegram free-text: bad session id");
                                            }
                                        }
                                    }
                                }
                            }
                            crate::telegram::InboundEvent::Question {
                                chat_id,
                                message_id,
                                text: _,
                            } => {
                                // Deterministic English cross-tab status reply,
                                // threaded onto the question. Reads the notch
                                // hub's live per-session phases (no LLM call).
                                let snap = if let Some(state) =
                                    app_handle_for_drain.try_state::<AppState>()
                                {
                                    state.notch_hub.snapshot().await
                                } else {
                                    Vec::new()
                                };
                                let body = crate::telegram::status::format_status(&snap);
                                let s = tg_for_drain.settings.lock().await;
                                let token = s.telegram.bot_token.clone();
                                drop(s);
                                if !token.is_empty() {
                                    let _ = tg_for_drain
                                        .client
                                        .send_message(
                                            &token,
                                            crate::telegram::types::SendMessageReq {
                                                chat_id: chat_id.to_string(),
                                                text: body,
                                                reply_markup: None,
                                                parse_mode: None,
                                                reply_to_message_id: Some(message_id),
                                            },
                                        )
                                        .await;
                                }
                            }
                        }
                    }
                });
            }

            let operator_watcher = OperatorWatcher::spawn(
                app.handle().clone(),
                settings_arc.clone(),
                storage.clone(),
                aom_handle.clone(),
                mission_store,
                notifier.clone(),
                email_notifier.clone(),
                registry_arc.clone(),
                embedder_cell.clone(),
                connectivity_handle.clone(),
                escalation_bus_tx.clone(),
                vitals.clone(),
            );

            spawn_superpowers_watcher(app.handle().clone());

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
            let data_dir = dir.clone();

            // Covenant Score — open store and install global recorder so
            // the agent crate's collect_oneshot can call
            // karl_score::record_prompt() without holding a State handle.
            let score_store = Arc::new(
                karl_score::ScoreStore::open(&data_dir)
                    .expect("open score store"),
            );
            karl_score::set_recorder(score_store.clone());
            app.manage(score_commands::ScoreState(score_store.clone()));

            // Spawns store — catalog of executor agents
            let spawns_store = std::sync::Arc::new(
                spawns_store::SpawnStore::open(&data_dir)
                    .expect("open spawns store"),
            );
            app.manage(spawns_commands::SpawnsState(spawns_store));
            app.manage(browser::BrowserState::default());

            // Browser favorites store — shared bookmarks tree.
            let favorites = store::Favorites::open(&data_dir.join("favorites.db"))
                .expect("open favorites store");
            app.manage(favorites_commands::FavoritesState(std::sync::Mutex::new(
                favorites,
            )));

            // Periodic commit + spec scanner (CS-1b) — every 5 minutes scan
            // every repo the context resolver has seen (i.e. any repo a
            // session prompted from): new commits by the local git user, and
            // spec files (**/specs/**/*.md, mtime-stamped, idempotent). The
            // process cwd is registered too so `tauri dev` keeps working;
            // a Finder-launched .app has cwd `/`, which register_cwd skips.
            let scanner_store = score_store.clone();
            tauri::async_runtime::spawn(async move {
                use std::time::Duration;
                if let Ok(cwd) = std::env::current_dir() {
                    karl_score::register_cwd(&cwd);
                }
                loop {
                    tokio::time::sleep(Duration::from_secs(300)).await;
                    let email = std::process::Command::new("git")
                        .args(["config", "--global", "user.email"])
                        .output().ok()
                        .and_then(|o| String::from_utf8(o.stdout).ok())
                        .map(|s| s.trim().to_string())
                        .unwrap_or_default();
                    let store = scanner_store.clone();
                    let _ = tokio::task::spawn_blocking(move || {
                        if !email.is_empty() {
                            karl_score::commit_scanner::scan_known_repos(&store, &email);
                        }
                        karl_score::spec_scanner::scan_known_repos(&store)
                    })
                    .await;
                }
            });

            // Periodic push-sync to covenant-server.
            let sync_store = score_store.clone();
            tauri::async_runtime::spawn(async move {
                use std::time::Duration;
                loop {
                    tokio::time::sleep(Duration::from_secs(300)).await;
                    // Drain the whole backlog each cycle (batched, paced) so a
                    // large first-sync doesn't take hours at one batch per tick.
                    if let Err(e) =
                        karl_score::sync::push_drain(&sync_store, Duration::from_millis(250)).await
                    {
                        tracing::debug!(error = %e, "periodic sync skipped");
                    }
                }
            });

            // Spec watcher — watches configured roots for spec files.
            // TODO: expose roots via settings UI (M7+).
            let watch_roots: Vec<std::path::PathBuf> = std::env::var("COVENANT_SPEC_WATCH_ROOTS")
                .ok()
                .map(|s| s.split(':').filter(|s| !s.is_empty()).map(std::path::PathBuf::from).collect())
                .unwrap_or_default();
            let _spec_watcher = karl_score::spec_watcher::start(watch_roots);
            std::mem::forget(_spec_watcher);

            // External LLM-usage pollers (Claude Code JSONL, Codex, etc).
            let pollers_store = score_store.clone();
            let _pollers = karl_score::external::start(pollers_store);
            std::mem::forget(_pollers);

            let gc_storage = storage.clone();

            // Build the notch hub up front so we can both store it on
            // AppState and manage a clone of its spec-edit tracker. The hub
            // feeds the tracker from `set_phase`; the completion command
            // reads the same instance via managed state to emit spec_keeper.
            let notch_hub = notch::NotchHub::new();
            let spec_edit_tracker = notch_hub.spec_edit_tracker();
            app.manage(spec_edit_tracker.clone());

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
                data_dir,
                claude_theme: std::sync::Mutex::new("dark-daltonized".to_string()),
                dir_context_cache: Arc::new(ContextCache::new()),
                notifier,
                email_notifier,
                telegram_notifier,
                escalation_bus_tx,
                supervisor_bus_tx: supervisor_bus_tx.clone(),
                embedder: embedder_cell,
                spec_detectors: Mutex::new(HashMap::new()),
                connectivity: connectivity_handle,
                telegram_inbound_handle: tg_inbound_handle,
                telegram_inbound_tx: tg_inbound_tx,
                pi_sessions: pi_commands::PiRegistry::new(),
                notch_hub,
                vitals,
                exec_vitals,
                file_search_cache: crate::file_search::FileSearchCache::new(),
                allow_remote_open: std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false)),
            });

            rc_agent::spawn(app.handle().clone());

            // Fullscreen-aware notch: when the main Covenant window
            // enters fullscreen the floating overlay is intrusive, so
            // we hide it and ask the main UI to render an inline pill
            // rack in its own dead-space. Restore the overlay on exit.
            if let Some(main_win) = app.get_webview_window("main") {
                let handle = app.handle().clone();
                // Last fullscreen state we acted on, shared across Resized
                // events so we can detect transitions in both directions
                // (the per-event poll below can't, on its own, tell enter
                // from exit without a baseline).
                let last_fs = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                main_win.on_window_event(move |ev| {
                    if let tauri::WindowEvent::Resized(_) = ev {
                        let h = handle.clone();
                        let last_fs = last_fs.clone();
                        tauri::async_runtime::spawn(async move {
                            // macOS reports is_fullscreen() a beat late: the
                            // Resized event fires during the transition before
                            // the flag flips. Re-poll a few times so we catch
                            // the settled state and reliably hide the overlay
                            // (otherwise it lingers on top of the fullscreen
                            // Space and "won't go away").
                            use std::sync::atomic::Ordering;
                            for delay_ms in [0u64, 250, 500, 800] {
                                if delay_ms > 0 {
                                    tokio::time::sleep(
                                        std::time::Duration::from_millis(delay_ms),
                                    )
                                    .await;
                                }
                                let fs = h
                                    .get_webview_window("main")
                                    .and_then(|w| w.is_fullscreen().ok())
                                    .unwrap_or(false);
                                // Publish the settled state every poll (not just
                                // on transitions) so the bridge's authoritative
                                // flag can never drift from reality.
                                if let Some(state) = h.try_state::<AppState>() {
                                    state.notch_hub.set_inline_mode(fs);
                                }
                                if fs == last_fs.swap(fs, Ordering::Relaxed) {
                                    continue; // no transition this poll
                                }
                                if let Some(notch) = h.get_webview_window("notch") {
                                    if fs {
                                        let _ = notch.hide();
                                    }
                                    // On exit we leave the overlay hidden; the
                                    // bridge re-shows it on the next executor
                                    // event naturally.
                                }
                                let _ = h.emit(
                                    "notch:inline-mode",
                                    serde_json::json!({ "enabled": fs }),
                                );
                            }
                        });
                    }
                });
            }

            // Notch bridge: subscribe to the hub's fan-out and forward
            // every ExecutorStateChanged event to the notch webview.
            {
                let state: tauri::State<AppState> = app.state();
                let rx = state.notch_hub.subscribe();
                notch::spawn_bridge(
                    app.handle().clone(),
                    state.settings.clone(),
                    state.notch_hub.clone(),
                    rx,
                );
                // Seed the hub's enabled flag from persisted settings so
                // a user who turned the notch off on the previous run
                // doesn't see pills for one boot before the toggle is
                // re-applied through `set_settings`.
                let hub = state.notch_hub.clone();
                let settings_arc = state.settings.clone();
                tauri::async_runtime::spawn(async move {
                    let enabled = settings_arc.lock().await.notch_enabled;
                    hub.set_enabled(enabled).await;
                });
            }

            // Operator-mind orphan GC on startup. Best-effort; log only.
            tauri::async_runtime::spawn(async move {
                match gc_storage.mind_gc_orphans().await {
                    Ok(n) if n > 0 => tracing::info!(deleted = n, "operator_mind: gc orphans"),
                    Ok(_) => {}
                    Err(e) => tracing::warn!(error = %e, "operator_mind: gc failed"),
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            browser::browser_open,
            browser::browser_navigate,
            browser::browser_back,
            browser::browser_forward,
            browser::browser_reload,
            browser::browser_set_bounds,
            browser::browser_show,
            browser::browser_hide,
            browser::browser_snapshot,
            browser::browser_close,
            favorites_commands::favorites_tree,
            favorites_commands::favorites_add,
            favorites_commands::favorites_rename,
            favorites_commands::favorites_move,
            favorites_commands::favorites_delete,
            favorites_commands::favorites_set_collapsed,
            search_session_files,
            score_commands::score_summary,
            score_commands::score_heatmap,
            spawn_session,
            replay_scrollback,
            delete_scrollback,
            read_font_bytes,
            list_monospace_fonts,
            write_to_session,
            resize_session,
            close_session,
            close_session_check,
            kill_session_foreground,
            inject_command,
            get_block_output,
            get_settings,
            set_settings,
            ask_agent,
            set_operator_enabled,
            rc_set_armed,
            rc_set_allow_open,
            rc_get_allow_open,
            rc_get_armed,
            rc_disarm_all,
            rc_pairing_token,
            is_operator_enabled,
            list_operator_decisions,
            set_operator_live,
            is_operator_live,
            set_aom_excluded,
            set_tab_title,
            notch_set_label,
            is_aom_excluded,
            clear_all_aom_excluded,
            set_session_mission,
            prime_spawned_tab,
            list_superpowers_missions,
            clear_session_mission,
            get_session_mission,
            get_session_mission_content,
            get_session_plan_content,
            set_session_mission_content,
            operator_mark_plan_task,
            operator_append_plan_note,
            aom_status,
            operator_phase_overview,
            aom_start,
            aom_stop,
            aom_report,
            operator_solo_start,
            operator_solo_stop,
            operator_solo_status,
            get_convergence_snapshot,
            get_blocked_session_ids,
            submit_convergence_reply,
            recall_search,
            zsh_autosuggestions_status,
            tab_manifest_load,
            tab_manifest_save,
            write_text_file,
            recent_blocks_by_cwd,
            get_dir_context,
            git_repo_summary,
            git_switch_branch,
            resolve_existing_path,
            structure_list_dir,
            structure_create_path,
            structure_read_file,
            structure_write_file,
            structure_write_binary_file,
            structure_read_binary_file,
            structure_rename_path,
            structure_trash_path,
            structure_copy_into,
            structure_move_into,
            structure_search,
            structure_find_files,
            find_recent_commands,
            read_block_excerpt,
            read_session_excerpt,
            drafts::list_drafts,
            drafts::read_draft,
            drafts::save_draft,
            drafts::delete_draft,
            drafts::publish_draft,
            drafts::next_draft_id,
            drafts::suggest_draft_section,
            drafts::list_published_specs,
            drafts::read_spec_body,
            operator_registry::commands::operator_list,
            operator_registry::commands::operator_get,
            operator_registry::commands::operator_create,
            operator_registry::commands::operator_update,
            operator_registry::commands::operator_delete,
            operator_registry::commands::operator_set_default,
            operator_registry::commands::operator_set_github_access,
            operator_registry::commands::operator_list_archetypes,
            operator_registry::commands::operator_soul_read,
            operator_registry::commands::operator_soul_parse,
            operator_registry::commands::operator_create_from_soul,
            operator_registry::commands::operator_update_from_soul,
            operator_registry::commands::session_set_operator,
            operator_registry::commands::session_get_operator,
            teammate::commands::teammate_list_messages_for_operator,
            teammate::commands::teammate_send_text_message,
            teammate::commands::teammate_list_tasks,
            teammate::commands::teammate_confirm_task,
            teammate::commands::teammate_cancel_task_proposal,
            teammate::commands::teammate_cancel_active_task,
            teammate::commands::teammate_complete_task,
            teammate::commands::teammate_edit_task_proposal,
            teammate::commands::teammate_attach_session_to_task,
            teammate::commands::teammate_clear_for_operator,
            teammate::commands::teammate_clear_finished_tasks,
            teammate::commands::teammate_delete_task,
            teammate::commands::teammate_create_thread,
            teammate::commands::teammate_list_threads,
            teammate::commands::teammate_rename_thread,
            teammate::commands::teammate_archive_thread,
            teammate::commands::teammate_list_decisions_for_session,
            spec_detector::start_spec_detector,
            spec_detector::mark_spec_seen,
            familiar_commands::familiar_list,
            familiar_commands::familiar_spawn,
            familiar_commands::familiar_update_config,
            familiar_commands::familiar_chat,
            familiar_commands::familiar_approve_directive,
            familiar_commands::familiar_reject_directive,
            familiar_commands::familiar_snapshot,
            familiar_commands::familiar_audit,
            familiar_commands::familiar_mark_executed,
            familiar_commands::familiar_has_recent_closed_mission,
            spec_author_step,
            spec_author_stream_step,
            spec_author_load_draft,
            spec_author_list_drafts,
            spec_author_mark_published,
            spec_author_delete_draft,
            spec_author_save_markdown,
            validate_sendgrid_key,
            project_notes::project_notes_get,
            project_notes::project_command_create,
            project_notes::project_command_update,
            project_notes::project_command_delete,
            project_notes::project_command_reorder,
            project_notes::project_note_append,
            project_notes::project_note_delete,
            project_notes::project_note_list,
            project_notes::project_docs_get,
            project_notes::project_docs_save,
            prompts::prompt_list,
            prompts::prompt_create,
            prompts::prompt_update,
            prompts::prompt_delete,
            prompts::prompt_reorder,
            telegram_test_connection,
            telegram_status,
            capabilities_commands::capabilities_list,
            capabilities_commands::capabilities_list_dir,
            capabilities_commands::capabilities_read,
            capabilities_commands::capabilities_write,
            capabilities_commands::capabilities_delete,
            capabilities_commands::capabilities_scaffold,
            capabilities_commands::capabilities_detect,
            providers_cmd::list_models_anthropic,
            providers_cmd::list_models_openai_compat,
            providers_cmd::list_models_azure_foundry,
            providers_cmd::test_anthropic_key,
            pi_commands::spawn_pi_session,
            pi_commands::close_pi_session,
            pi_commands::pi_send_prompt,
            pi_commands::pi_steer,
            pi_commands::pi_follow_up,
            pi_commands::pi_abort,
            pi_commands::pi_new_session,
            pi_commands::pi_set_session_name,
            pi_commands::pi_get_state,
            pi_commands::pi_set_model,
            pi_commands::pi_get_available_models,
            pi_commands::pi_set_thinking_level,
            pi_commands::pi_compact,
            pi_commands::pi_get_session_stats,
            pi_commands::pi_extension_ui_response,
            score_auth_commands::score_signin_start,
            score_auth_commands::score_signin_poll,
            score_auth_commands::score_current_user,
            score_auth_commands::score_signout,
            score_auth_commands::score_token_scope,
            score_sync_commands::score_sync_now,
            score_sync_commands::score_sync_status,
            score_sync_commands::score_profile_get_publish,
            score_sync_commands::score_profile_set_publish,
            score_sync_commands::score_profile_preview,
            score_sync_commands::score_profile_share_url,
            score_commands::score_set_current_session,
            score_commands::score_summary_filtered,
            score_commands::score_heatmap_filtered,
            score_commands::score_breakdown_repos,
            score_commands::score_breakdown_branches,
            score_commands::score_breakdown_groups,
            score_commands::score_recent_sessions,
            score_commands::score_breakdown_agents,
            score_commands::score_breakdown_specs,
            score_commands::score_breakdown_models,
            score_commands::score_achievement_catalog,
            score_commands::score_achievement_summary,
            score_commands::score_achievement_progress,
            score_commands::score_achievement_awards,
            score_commands::score_achievement_mark_seen,
            score_commands::score_achievement_recompute,
            notch::notch_set_passthrough,
            notch::notch_ready,
            spawns_commands::spawns_list,
            spawns_commands::spawns_upsert,
            spawns_commands::spawns_delete,
            split_commands::split_pane,
            split_commands::close_pane,
            split_commands::focus_pane,
            split_commands::swap_panes,
            split_commands::set_pane_orientation,
            split_commands::set_pane_ratio,
            vitals::get_vitals,
            vitals::set_active_session_for_vitals,
            theme::set_window_theme,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::resolve_scope;

    #[test]
    fn one_shot_skips_persistence() {
        assert_eq!(resolve_scope("one-shot", None), None);
        assert_eq!(resolve_scope("one-shot", Some("/foo")), None);
    }

    #[test]
    fn global_persists_as_global() {
        assert_eq!(resolve_scope("global", None), Some("global".into()));
    }

    #[test]
    fn mission_with_path_uses_mission_scope() {
        assert_eq!(
            resolve_scope("mission", Some("/foo/bar")),
            Some("mission:/foo/bar".into())
        );
    }

    #[test]
    fn mission_without_path_falls_back_to_global() {
        assert_eq!(resolve_scope("mission", None), Some("global".into()));
    }

    #[test]
    fn unknown_scope_skips_persistence() {
        assert_eq!(resolve_scope("gibberish", None), None);
        assert_eq!(resolve_scope("", Some("/foo")), None);
    }
}
