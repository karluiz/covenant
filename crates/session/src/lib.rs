//! Session lifecycle and event bus for Covenant.
//!
//! Wraps a [`karl_pty::PtySession`] with:
//!   - a `tokio::broadcast` event bus carrying high-level [`SessionEvent`]s
//!     for any number of subscribers (the super-agent in M3.2 is the
//!     primary one);
//!   - two `mpsc::UnboundedReceiver` streams the `covenant` Tauri layer
//!     hands off to per-session frontend channels (raw bytes for xterm,
//!     parsed [`karl_blocks::BlockEvent`]s for the sidebar);
//!   - per-block output accumulation so `BlockFinished` carries the
//!     ANSI-stripped command output text the agent will summarize.
//!
//! Everything downstream of the PTY's blocking reader thread is async.
//! The pump task that owns the fan-out is spawned with `tokio::spawn`,
//! so callers must be inside a tokio runtime (Tauri provides one).

pub mod idle;
pub mod operator_ref;

pub use operator_ref::{OperatorAction, OperatorRef, ProjectRef, VoiceToneSnapshot};

use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use karl_blocks::{BlockEvent, BlockId, BlockParser};
#[cfg(unix)]
use karl_pty::foreground_process_name;
use karl_pty::{PtySession, SpawnOptions};

use crate::idle::{Decision, IdleDetector};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc};
use ulid::Ulid;

const EVENT_BUS_CAPACITY: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SessionId(pub Ulid);

impl SessionId {
    pub fn new() -> Self {
        Self(Ulid::new())
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Display for SessionId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::str::FromStr for SessionId {
    type Err = ulid::DecodeError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ulid::from_string(s).map(SessionId)
    }
}

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("pty: {0}")]
    Pty(#[from] karl_pty::PtyError),
}

pub use karl_blocks::executor_phase::ExecutorPhase;

/// High-level events broadcast on a session's bus. Designed for the
/// agent's world model — every variant is small enough to log/serialize
/// freely. `BlockFinished::output_text` is the one heavy field; agents
/// that don't need full output should subscribe and discard it.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionEvent {
    Opened {
        session: SessionId,
        started_at_unix_ms: u64,
    },
    Closed {
        session: SessionId,
    },
    PromptStart {
        session: SessionId,
    },
    BlockSubmitted {
        session: SessionId,
        block: BlockId,
        command: String,
        cwd: PathBuf,
        started_at_unix_ms: u64,
    },
    BlockFinished {
        session: SessionId,
        block: BlockId,
        /// Denormalized from the matching `BlockSubmitted` so subscribers
        /// (world model, agent) don't have to track in-flight blocks.
        command: String,
        cwd: PathBuf,
        exit_code: Option<i32>,
        duration_ms: u64,
        /// Output text (ANSI stripped, lossy UTF-8) that appeared
        /// between the matching `BlockSubmitted` and now.
        output_text: String,
    },
    CwdChanged {
        session: SessionId,
        cwd: PathBuf,
    },
    /// Emitted by the M4 fix-proposer task on the same bus the session
    /// pump publishes to. The shape mirrors `BlockFinished` enough that
    /// any subscriber can correlate by `block` id.
    FixSuggested {
        session: SessionId,
        block: BlockId,
        /// The single shell command the agent suggests typing in.
        /// SuggestOnly: never auto-executed.
        command: String,
        /// Short justification surfaced to the user inline.
        rationale: String,
    },
    /// Operator requests human-in-the-loop intervention. Subscribers
    /// (terminal UI, telegram notifier) surface this to the user.
    EscalationRequested {
        session: SessionId,
        /// Ulid as string for serialization simplicity.
        escalation_id: String,
        #[serde(rename = "escalation_kind")]
        kind: EscalationKind,
        summary: String,
        /// Typed actions surfaced to the operator (Telegram, UI). Replaces
        /// the legacy `Vec<EscalationAction>` so downstream consumers can
        /// match on intent (push, snooze, custom) rather than label.
        actions: Vec<OperatorAction>,
        /// Who is paused — projected from the per-session registry.
        operator: OperatorRef,
        /// Where the work lives — repo basename + branch, derived from
        /// the session cwd at emit time.
        project: ProjectRef,
    },
    /// An outstanding escalation has been resolved by some surface
    /// (terminal panel, telegram reply, etc).
    EscalationResolved {
        escalation_id: String,
        resolution: EscalationResolution,
        source: ResolutionSource,
    },
    AgentIdleWaiting {
        session: SessionId,
        /// Foreground process name (e.g. "claude", "codex", "copilot").
        agent: String,
        /// Best-effort regex extract of the prompt. `None` if no regex matched
        /// but other signals fired.
        prompt_text: Option<String>,
        /// How long the PTY has been quiet, in milliseconds.
        quiet_ms: u64,
    },
    AgentResumed {
        session: SessionId,
    },
    MissionCompleted {
        session: SessionId,
        summary: String,
    },
    MissionFailed {
        session: SessionId,
        reason: String,
    },
    /// Foreground process changed: the binary in front of the PTY is
    /// no longer the same as last tick. `name = None` means we're back
    /// at the shell prompt (or no foreground could be determined).
    /// Emitted only on transitions, not every tick.
    ForegroundChanged {
        session: SessionId,
        name: Option<String>,
    },
    /// A fresh AI-generated tab title for the session, produced by the
    /// summarizer. Emitted only when the title changed from the last one.
    TitleSuggested {
        session: SessionId,
        title: String,
    },
    ExecutorStateChanged {
        session: SessionId,
        phase: ExecutorPhase,
        /// Foreground executor agent driving the phase, when known
        /// (e.g. "claude", "codex", "pi").
        #[serde(default)]
        agent: Option<String>,
        tab_label: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EscalationKind {
    Blocked,
    Blocklist,
    BudgetExhausted,
    Loop,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EscalationAction {
    Approve,
    Reject,
    Snooze10m,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum EscalationResolution {
    Approved,
    Rejected,
    Snoozed,
    FreeText(String),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ResolutionSource {
    Terminal,
    Telegram,
}

/// Lightweight UI-facing projection of [`SessionEvent`]. Strips fields
/// the frontend doesn't render (notably `BlockFinished.output_text`,
/// which can be many KB and lives in xterm anyway).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum SessionUiEvent {
    PromptStart {
        session: SessionId,
    },
    BlockStarted {
        session: SessionId,
        block: BlockId,
        command: String,
        cwd: PathBuf,
        started_at_unix_ms: u64,
    },
    BlockFinished {
        session: SessionId,
        block: BlockId,
        exit_code: Option<i32>,
        duration_ms: u64,
    },
    CwdChanged {
        session: SessionId,
        cwd: PathBuf,
    },
    FixSuggested {
        session: SessionId,
        block: BlockId,
        command: String,
        rationale: String,
    },
    AgentIdleWaiting {
        session: SessionId,
        agent: String,
        prompt_text: Option<String>,
        quiet_ms: u64,
    },
    AgentResumed {
        session: SessionId,
    },
    /// Foreground process changed. `busy = true` when a non-shell
    /// binary occupies the PTY's foreground pgrp. Drives the
    /// palpitating dot in the tab list.
    ForegroundChanged {
        session: SessionId,
        name: Option<String>,
        busy: bool,
    },
    TitleSuggested {
        session: SessionId,
        title: String,
    },
}

impl SessionEvent {
    /// Map a bus event to its UI-facing projection. Returns `None` for
    /// events the UI does not need (Opened/Closed today).
    pub fn to_ui(&self) -> Option<SessionUiEvent> {
        match self {
            SessionEvent::Opened { .. }
            | SessionEvent::Closed { .. }
            // TODO(telegram): handled in Task 5/6
            | SessionEvent::EscalationRequested { .. }
            | SessionEvent::EscalationResolved { .. }
            | SessionEvent::MissionCompleted { .. }
            | SessionEvent::MissionFailed { .. } => None,
            SessionEvent::AgentIdleWaiting {
                session,
                agent,
                prompt_text,
                quiet_ms,
            } => Some(SessionUiEvent::AgentIdleWaiting {
                session: *session,
                agent: agent.clone(),
                prompt_text: prompt_text.clone(),
                quiet_ms: *quiet_ms,
            }),
            SessionEvent::AgentResumed { session } => {
                Some(SessionUiEvent::AgentResumed { session: *session })
            }
            SessionEvent::PromptStart { session } => {
                Some(SessionUiEvent::PromptStart { session: *session })
            }
            SessionEvent::BlockSubmitted {
                session,
                block,
                command,
                cwd,
                started_at_unix_ms,
            } => Some(SessionUiEvent::BlockStarted {
                session: *session,
                block: *block,
                command: command.clone(),
                cwd: cwd.clone(),
                started_at_unix_ms: *started_at_unix_ms,
            }),
            SessionEvent::BlockFinished {
                session,
                block,
                exit_code,
                duration_ms,
                ..
            } => Some(SessionUiEvent::BlockFinished {
                session: *session,
                block: *block,
                exit_code: *exit_code,
                duration_ms: *duration_ms,
            }),
            SessionEvent::CwdChanged { session, cwd } => {
                Some(SessionUiEvent::CwdChanged {
                    session: *session,
                    cwd: cwd.clone(),
                })
            }
            SessionEvent::FixSuggested {
                session,
                block,
                command,
                rationale,
            } => Some(SessionUiEvent::FixSuggested {
                session: *session,
                block: *block,
                command: command.clone(),
                rationale: rationale.clone(),
            }),
            SessionEvent::ExecutorStateChanged { .. } => None,
            SessionEvent::TitleSuggested { session, title } => {
                Some(SessionUiEvent::TitleSuggested {
                    session: *session,
                    title: title.clone(),
                })
            }
            SessionEvent::ForegroundChanged { session, name } => {
                Some(SessionUiEvent::ForegroundChanged {
                    session: *session,
                    name: name.clone(),
                    busy: name.as_deref().is_some_and(is_busy_proc),
                })
            }
        }
    }
}

/// True when `name` looks like a long-running dev server or build/runtime
/// process worth surfacing in the tab list. Allowlist — interactive CLIs
/// like `claude`, `copilot`, `opencode`, editors, pagers, git, etc. are
/// intentionally excluded so the pulse dot only fires on actual work.
pub fn is_busy_proc(name: &str) -> bool {
    matches!(
        name,
        // Node / JS
        "node" | "npm" | "pnpm" | "yarn" | "bun" | "deno"
        | "vite" | "next" | "nuxt" | "webpack" | "rollup" | "esbuild" | "tsc"
        // Python
        | "python" | "python3" | "uvicorn" | "gunicorn" | "hypercorn"
        | "flask" | "django" | "django-admin" | "manage.py" | "pytest"
        // Go
        | "go" | "air" | "gofmt"
        // Rust
        | "cargo" | "rustc" | "trunk" | "wasm-pack"
        // Misc dev servers / build tools
        | "make" | "cmake" | "ninja" | "bazel" | "gradle" | "mvn"
        | "docker" | "docker-compose" | "kubectl"
    )
}

/// Streams the Tauri layer drains to feed per-session frontend channels.
/// xterm needs every byte in order, so the raw stream is its own mpsc
/// (no `Lagged` semantics). Sidebar / agent UI events come from the
/// broadcast bus directly — Tauri's relay task in covenant converts
/// `SessionEvent` → `SessionUiEvent` before forwarding.
pub struct SessionStreams {
    pub raw_bytes: mpsc::UnboundedReceiver<Bytes>,
}

/// Owned session handle. `write` / `resize` / `kill` are mirrors over
/// the underlying [`PtySession`]. `subscribe` hands out a fresh receiver
/// on the broadcast bus.
pub struct Session {
    pub id: SessionId,
    pub started_at: Instant,
    pty: PtySession,
    events_tx: broadcast::Sender<SessionEvent>,
    /// Latest tidied headless screen render, refreshed by the pump once
    /// per tick. Read on demand by the teammate `read_terminal_screen`
    /// tool so an operator can see inside an interactive-agent tab.
    screen: Arc<StdMutex<String>>,
    /// Live PTY dimensions (cols<<16|rows), written by `resize`, read by
    /// the pump so the headless vt100 grid matches the real terminal.
    dims: Arc<AtomicU32>,
    /// Broadcast tee of every raw PTY chunk, for remote live-mirroring.
    raw_bytes_tx: tokio::sync::broadcast::Sender<bytes::Bytes>,
}

impl Session {
    /// Spawn a new session. Caller must be inside a tokio runtime — the
    /// internal pump task is `tokio::spawn`ed.
    pub fn spawn(opts: SpawnOptions) -> Result<(Self, SessionStreams), SessionError> {
        let (pty, pty_rx) = PtySession::spawn(opts)?;
        let id = SessionId::new();
        let (events_tx, _) = broadcast::channel(EVENT_BUS_CAPACITY);
        let (raw_tx, raw_rx) = mpsc::unbounded_channel::<Bytes>();
        let (raw_bytes_tx, _) = tokio::sync::broadcast::channel::<bytes::Bytes>(1024);

        let pump_events_tx = events_tx.clone();
        #[cfg(unix)]
        let master_fd = pty.master_fd();
        #[cfg(not(unix))]
        let master_fd: () = ();

        let screen = Arc::new(StdMutex::new(String::new()));
        let dims = Arc::new(AtomicU32::new(pack_dims(80, 24)));
        let pump_screen = screen.clone();
        let pump_dims = dims.clone();
        let pump_raw_bytes_tx = raw_bytes_tx.clone();

        tokio::spawn(pump(
            id,
            pty_rx,
            raw_tx,
            pump_raw_bytes_tx,
            pump_events_tx,
            master_fd,
            pump_screen,
            pump_dims,
        ));

        // Best-effort opened announcement. Subscribers attached after
        // spawn won't see this — that's the broadcast contract.
        let _ = events_tx.send(SessionEvent::Opened {
            session: id,
            started_at_unix_ms: now_ms(),
        });

        Ok((
            Self {
                id,
                started_at: Instant::now(),
                pty,
                events_tx,
                screen,
                dims,
                raw_bytes_tx,
            },
            SessionStreams { raw_bytes: raw_rx },
        ))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events_tx.subscribe()
    }

    /// Fresh subscription to the raw PTY byte stream (for mirroring). Lagging
    /// receivers drop oldest chunks; the live stream then resumes.
    pub fn subscribe_raw_bytes(&self) -> tokio::sync::broadcast::Receiver<bytes::Bytes> {
        self.raw_bytes_tx.subscribe()
    }

    /// Clone of the bus sender. Tasks that synthesize new events back
    /// into the same session (e.g. the M4 fix-proposer publishing
    /// `FixSuggested`) hold one of these.
    pub fn event_sender(&self) -> broadcast::Sender<SessionEvent> {
        self.events_tx.clone()
    }

    pub fn write(&mut self, data: &[u8]) -> Result<(), SessionError> {
        self.pty.write(data).map_err(Into::into)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        self.dims.store(pack_dims(cols, rows), Ordering::Relaxed);
        self.pty.resize(cols, rows).map_err(Into::into)
    }

    /// Shared handle to the latest tidied headless screen render. The
    /// app layer clones this into the teammate tool sandbox.
    pub fn screen_handle(&self) -> Arc<StdMutex<String>> {
        self.screen.clone()
    }

    /// Snapshot of the current rendered screen (for tests / callers that
    /// want the value, not the handle).
    pub fn screen_snapshot(&self) -> String {
        self.screen.lock().map(|g| g.clone()).unwrap_or_default()
    }

    pub fn kill(&mut self) -> Result<(), SessionError> {
        self.pty.kill().map_err(Into::into)
    }

    #[cfg(unix)]
    pub fn master_fd(&self) -> std::os::fd::RawFd {
        self.pty.master_fd()
    }

    /// The OS process id of the underlying shell child, if available.
    pub fn pid(&self) -> Option<u32> {
        self.pty.child_pid()
    }
}

async fn pump(
    id: SessionId,
    mut pty_rx: mpsc::UnboundedReceiver<Bytes>,
    raw_tx: mpsc::UnboundedSender<Bytes>,
    raw_bytes_tx: tokio::sync::broadcast::Sender<bytes::Bytes>,
    events_tx: broadcast::Sender<SessionEvent>,
    #[cfg(unix)] master_fd: std::os::fd::RawFd,
    #[cfg(not(unix))] _master_fd: (),
    screen: Arc<StdMutex<String>>,
    dims: Arc<AtomicU32>,
) {
    let mut parser = BlockParser::new();
    // (block_id, command, cwd_at_submit, output_buf, started_at) of the
    // currently-executing block. Command + cwd are denormalized into
    // BlockFinished so downstream consumers don't have to correlate.
    let mut current_block: Option<(BlockId, String, PathBuf, Vec<u8>, Instant)> = None;
    let mut current_cwd = PathBuf::new();

    let mut vt = vt100::Parser::new(24, 80, 0);
    let mut detector = IdleDetector::new();
    let mut tick = tokio::time::interval(Duration::from_secs(1));
    // Track foreground proc across ticks so we only emit on transitions.
    let mut last_fg: Option<String> = None;
    // First tick fires immediately; skip it to avoid evaluating before any output.
    tick.tick().await;

    loop {
        tokio::select! {
            maybe_chunk = pty_rx.recv() => {
                let Some(chunk) = maybe_chunk else { break };

                // Feed vt100 first (cheap; needed by next tick).
                vt.process(&chunk);
                if matches!(detector.on_output(Instant::now()), Decision::Resumed) {
                    let _ = events_tx.send(SessionEvent::AgentResumed { session: id });
                }

                // 1. Forward raw bytes to the UI consumer. If the UI side has
                //    dropped its receiver, we keep going — the agent (broadcast)
                //    may still want events.
                let _ = raw_tx.send(chunk.clone());
                let _ = raw_bytes_tx.send(chunk.clone());

                // 2. Accumulate output bytes against the in-flight block, if any.
                if let Some((_, _, _, ref mut buf, _)) = current_block {
                    buf.extend_from_slice(&chunk);
                }

                // 3. Parse for block events; lift to SessionEvents on the bus.
                for event in parser.feed(&chunk) {
                    match event {
                        BlockEvent::PromptStart => {
                            let _ = events_tx.send(SessionEvent::PromptStart { session: id });
                        }
                        BlockEvent::CwdChanged { path } => {
                            current_cwd = path.clone();
                            let _ = events_tx.send(SessionEvent::CwdChanged {
                                session: id,
                                cwd: path,
                            });
                        }
                        BlockEvent::CommandSubmitted { command } => {
                            let block = BlockId::new();
                            current_block = Some((
                                block,
                                command.clone(),
                                current_cwd.clone(),
                                Vec::new(),
                                Instant::now(),
                            ));
                            let _ = events_tx.send(SessionEvent::BlockSubmitted {
                                session: id,
                                block,
                                command,
                                cwd: current_cwd.clone(),
                                started_at_unix_ms: now_ms(),
                            });
                        }
                        BlockEvent::CommandFinished { exit_code } => {
                            if let Some((block, command, cwd, buf, started)) =
                                current_block.take()
                            {
                                let stripped = strip_ansi_escapes::strip(&buf);
                                let output_text =
                                    String::from_utf8_lossy(&stripped).into_owned();
                                let _ = events_tx.send(SessionEvent::BlockFinished {
                                    session: id,
                                    block,
                                    command,
                                    cwd,
                                    exit_code,
                                    duration_ms: started.elapsed().as_millis() as u64,
                                    output_text,
                                });
                            }
                        }
                    }
                }
            }
            _ = tick.tick() => {
                // Keep the headless vt100 grid the same size as the real
                // PTY so the captured screen isn't clipped to 24×80.
                let (cols, rows) = unpack_dims(dims.load(Ordering::Relaxed));
                if vt.screen().size() != (rows, cols) {
                    vt.set_size(rows, cols);
                }
                // Capture the rendered screen for on-demand teammate reads.
                let tick_screen = vt.screen().contents();
                if let Ok(mut g) = screen.lock() {
                    *g = tidy_screen(&tick_screen);
                }
                #[cfg(unix)]
                {
                    let fg = foreground_process_name(master_fd);
                    if fg != last_fg {
                        let _ = events_tx.send(SessionEvent::ForegroundChanged {
                            session: id,
                            name: fg.clone(),
                        });
                        last_fg = fg.clone();
                    }
                    let alt = vt.screen().alternate_screen();
                    // Reuse the screen we already rendered this tick (above)
                    // rather than calling the expensive contents() twice.
                    if let Some(name) = fg.as_deref() {
                        let is_known = crate::idle::KNOWN_AGENTS.contains(&name);
                        let is_inline = crate::idle::INLINE_AGENTS.contains(&name);
                        if is_known && (alt || is_inline) {
                            if let Decision::Idle { agent, prompt_text, quiet_ms } =
                                detector.evaluate(Instant::now(), Some(name), alt, &tick_screen)
                            {
                                let _ = events_tx.send(SessionEvent::AgentIdleWaiting {
                                    session: id, agent, prompt_text, quiet_ms,
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    let _ = events_tx.send(SessionEvent::Closed { session: id });
    tracing::debug!(session = %id, "session pump exiting");
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pack (cols, rows) into a single u32 for lock-free sharing with the
/// pump task. cols in the high 16 bits, rows in the low 16.
fn pack_dims(cols: u16, rows: u16) -> u32 {
    ((cols as u32) << 16) | (rows as u32)
}

/// Inverse of [`pack_dims`]; returns (cols, rows).
fn unpack_dims(packed: u32) -> (u16, u16) {
    (((packed >> 16) & 0xffff) as u16, (packed & 0xffff) as u16)
}

/// Tidy a raw vt100 `screen().contents()` dump for LLM consumption:
/// strip trailing whitespace on each line, then drop leading/trailing
/// blank lines. The rendered grid is already plain text (no escapes),
/// so no ANSI stripping is needed here.
fn tidy_screen(raw: &str) -> String {
    let lines: Vec<&str> = raw.lines().map(|l| l.trim_end()).collect();
    let start = lines.iter().position(|l| !l.is_empty());
    let end = lines.iter().rposition(|l| !l.is_empty());
    match (start, end) {
        (Some(s), Some(e)) => lines[s..=e].join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn snippet_path() -> std::path::PathBuf {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../shell-integration/osc133.zsh")
            .canonicalize()
            .expect("locate osc133.zsh")
    }

    /// End-to-end: real zsh with our snippet, run a command, assert the
    /// bus emitted BlockSubmitted + BlockFinished with matching block id
    /// and the captured output text.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn session_bus_emits_block_lifecycle() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".zshrc"),
            format!("PROMPT='$ '\nsource {}\n", snippet_path().display()),
        )
        .expect("write .zshrc");

        let mut opts = SpawnOptions::zsh_interactive();
        opts.args.push("--no-globalrcs".to_string());
        opts.env
            .push(("ZDOTDIR".to_string(), dir.path().display().to_string()));

        let (mut session, _streams) = Session::spawn(opts).expect("spawn");
        let mut bus = session.subscribe();

        tokio::time::sleep(Duration::from_millis(200)).await;
        session.write(b"echo karl-bus\nexit\n").expect("write");

        let mut submitted: Option<BlockId> = None;
        let mut finished: Option<(BlockId, String, Option<i32>)> = None;

        let recv_loop = async {
            while let Ok(event) = bus.recv().await {
                match event {
                    SessionEvent::BlockSubmitted { block, command, .. }
                        if command.contains("echo karl-bus") =>
                    {
                        submitted = Some(block);
                    }
                    SessionEvent::BlockFinished {
                        block,
                        exit_code,
                        output_text,
                        ..
                    } if Some(block) == submitted => {
                        finished = Some((block, output_text, exit_code));
                        return;
                    }
                    _ => {}
                }
            }
        };

        tokio::time::timeout(Duration::from_secs(10), recv_loop)
            .await
            .expect("bus drain timed out");

        let (fin_block, output, exit) = finished.expect("no BlockFinished");
        assert_eq!(Some(fin_block), submitted);
        assert_eq!(exit, Some(0));
        assert!(
            output.contains("karl-bus"),
            "expected 'karl-bus' in output_text, got: {output:?}"
        );
    }

    /// Raw-byte broadcast tee should carry live PTY output to a fresh
    /// subscriber (the mirroring path).
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn subscribe_raw_bytes_receives_output() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(
            dir.path().join(".zshrc"),
            format!("PROMPT='$ '\nsource {}\n", snippet_path().display()),
        )
        .expect("write .zshrc");

        let mut opts = SpawnOptions::zsh_interactive();
        opts.args.push("--no-globalrcs".to_string());
        opts.env
            .push(("ZDOTDIR".to_string(), dir.path().display().to_string()));

        let (mut session, _streams) = Session::spawn(opts).expect("spawn");
        let mut raw = session.subscribe_raw_bytes();
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        session.write(b"echo karl-mirror\n").expect("write");
        let mut got = String::new();
        for _ in 0..50 {
            match tokio::time::timeout(std::time::Duration::from_millis(200), raw.recv()).await {
                Ok(Ok(b)) => {
                    got.push_str(&String::from_utf8_lossy(&b));
                    if got.contains("karl-mirror") {
                        break;
                    }
                }
                _ => continue,
            }
        }
        assert!(
            got.contains("karl-mirror"),
            "raw mirror stream should carry PTY output; got {got:?}"
        );
    }

    /// The pump should render the live PTY screen into the shared cell so
    /// an operator can read inside a tab on demand.
    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pump_captures_rendered_screen() {
        let mut opts = SpawnOptions::zsh_interactive();
        opts.args.push("--no-globalrcs".to_string());
        let (mut session, _streams) = Session::spawn(opts).expect("spawn session");
        session.resize(100, 30).expect("resize");
        session
            .write(b"printf 'CAPTURE_MARKER_42\\n'\n")
            .expect("write");
        tokio::time::sleep(Duration::from_millis(1400)).await;
        let screen = session.screen_snapshot();
        assert!(
            screen.contains("CAPTURE_MARKER_42"),
            "screen snapshot did not contain marker; got:\n{screen}"
        );
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawned_session_exposes_a_pid() {
        let mut opts = SpawnOptions::zsh_interactive();
        opts.args.push("--no-globalrcs".to_string());
        let (session, _streams) = Session::spawn(opts).expect("spawn");
        assert!(
            session.pid().is_some(),
            "child pid should be available after spawn"
        );
    }
}

#[cfg(test)]
mod event_serde_tests {
    use super::*;

    #[test]
    fn agent_idle_waiting_serializes_with_kind_tag() {
        let ev = SessionEvent::AgentIdleWaiting {
            session: SessionId::new(),
            agent: "claude".to_string(),
            prompt_text: Some("Do you want to proceed? (y/N)".to_string()),
            quiet_ms: 3200,
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""kind":"agent_idle_waiting""#), "{json}");
        assert!(json.contains(r#""agent":"claude""#));
    }

    #[test]
    fn agent_resumed_serializes() {
        let ev = SessionEvent::AgentResumed {
            session: SessionId::new(),
        };
        let json = serde_json::to_string(&ev).unwrap();
        assert!(json.contains(r#""kind":"agent_resumed""#));
    }

    #[test]
    fn agent_idle_waiting_maps_to_ui() {
        let id = SessionId::new();
        let ev = SessionEvent::AgentIdleWaiting {
            session: id,
            agent: "claude".into(),
            prompt_text: Some("(y/N)".into()),
            quiet_ms: 4200,
        };
        let ui = ev.to_ui().expect("should produce SessionUiEvent");
        match ui {
            SessionUiEvent::AgentIdleWaiting {
                session,
                agent,
                prompt_text,
                quiet_ms,
            } => {
                assert_eq!(session, id);
                assert_eq!(agent, "claude");
                assert_eq!(prompt_text.as_deref(), Some("(y/N)"));
                assert_eq!(quiet_ms, 4200);
            }
            other => panic!("expected AgentIdleWaiting, got {other:?}"),
        }
    }

    #[test]
    fn executor_state_changed_serializes() {
        use crate::{ExecutorPhase, SessionEvent, SessionId};
        let ev = SessionEvent::ExecutorStateChanged {
            session: SessionId::new(),
            phase: ExecutorPhase::Writing {
                file: "profile.rs".into(),
            },
            agent: Some("pi".into()),
            tab_label: None,
        };
        let json = serde_json::to_string(&ev).expect("serialize");
        assert!(json.contains("executor_state_changed"));
        assert!(json.contains("profile.rs"));
        assert!(json.contains("pi"));
    }

    #[test]
    fn agent_resumed_maps_to_ui() {
        let id = SessionId::new();
        let ev = SessionEvent::AgentResumed { session: id };
        let ui = ev.to_ui().expect("should produce SessionUiEvent");
        assert!(matches!(ui, SessionUiEvent::AgentResumed { session } if session == id));
    }

    #[test]
    fn title_suggested_maps_to_ui() {
        let sid = SessionId::new();
        let ev = SessionEvent::TitleSuggested {
            session: sid,
            title: "release prep".to_string(),
        };
        match ev.to_ui() {
            Some(SessionUiEvent::TitleSuggested { session, title }) => {
                assert_eq!(session, sid);
                assert_eq!(title, "release prep");
            }
            other => panic!("expected TitleSuggested ui event, got {other:?}"),
        }
    }
}

#[cfg(test)]
mod vt100_state_tests {
    use vt100::Parser;

    #[test]
    fn detects_alternate_screen_toggle() {
        let mut p = Parser::new(24, 80, 0);
        assert!(!p.screen().alternate_screen());
        p.process(b"\x1b[?1049h");
        assert!(p.screen().alternate_screen());
        p.process(b"\x1b[?1049l");
        assert!(!p.screen().alternate_screen());
    }

    #[test]
    fn dims_roundtrip() {
        let packed = super::pack_dims(120, 40);
        assert_eq!(super::unpack_dims(packed), (120, 40));
        let packed2 = super::pack_dims(80, 24);
        assert_eq!(super::unpack_dims(packed2), (80, 24));
    }

    #[test]
    fn tidy_screen_trims_trailing_blank_lines_and_padding() {
        let raw = "hello   \nworld\n\n\n   \n";
        assert_eq!(super::tidy_screen(raw), "hello\nworld");
    }

    #[test]
    fn tidy_screen_empty_when_all_blank() {
        assert_eq!(super::tidy_screen("   \n\n  \n"), "");
    }
}
