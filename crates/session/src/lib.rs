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

use std::path::PathBuf;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use karl_blocks::{BlockEvent, BlockId, BlockParser};
use karl_pty::{PtySession, SpawnOptions};
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
        actions: Vec<EscalationAction>,
    },
    /// An outstanding escalation has been resolved by some surface
    /// (terminal panel, telegram reply, etc).
    EscalationResolved {
        escalation_id: String,
        resolution: EscalationResolution,
        source: ResolutionSource,
    },
    MissionCompleted {
        session: SessionId,
        summary: String,
    },
    MissionFailed {
        session: SessionId,
        reason: String,
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
        }
    }
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
}

impl Session {
    /// Spawn a new session. Caller must be inside a tokio runtime — the
    /// internal pump task is `tokio::spawn`ed.
    pub fn spawn(opts: SpawnOptions) -> Result<(Self, SessionStreams), SessionError> {
        let (pty, pty_rx) = PtySession::spawn(opts)?;
        let id = SessionId::new();
        let (events_tx, _) = broadcast::channel(EVENT_BUS_CAPACITY);
        let (raw_tx, raw_rx) = mpsc::unbounded_channel::<Bytes>();

        let pump_events_tx = events_tx.clone();
        tokio::spawn(pump(id, pty_rx, raw_tx, pump_events_tx));

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
            },
            SessionStreams { raw_bytes: raw_rx },
        ))
    }

    pub fn subscribe(&self) -> broadcast::Receiver<SessionEvent> {
        self.events_tx.subscribe()
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
        self.pty.resize(cols, rows).map_err(Into::into)
    }

    pub fn kill(&mut self) -> Result<(), SessionError> {
        self.pty.kill().map_err(Into::into)
    }
}

async fn pump(
    id: SessionId,
    mut pty_rx: mpsc::UnboundedReceiver<Bytes>,
    raw_tx: mpsc::UnboundedSender<Bytes>,
    events_tx: broadcast::Sender<SessionEvent>,
) {
    let mut parser = BlockParser::new();
    // (block_id, command, cwd_at_submit, output_buf, started_at) of the
    // currently-executing block. Command + cwd are denormalized into
    // BlockFinished so downstream consumers don't have to correlate.
    let mut current_block: Option<(BlockId, String, PathBuf, Vec<u8>, Instant)> = None;
    let mut current_cwd = PathBuf::new();

    while let Some(chunk) = pty_rx.recv().await {
        // 1. Forward raw bytes to the UI consumer. If the UI side has
        //    dropped its receiver, we keep going — the agent (broadcast)
        //    may still want events.
        let _ = raw_tx.send(chunk.clone());

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

    let _ = events_tx.send(SessionEvent::Closed { session: id });
    tracing::debug!(session = %id, "session pump exiting");
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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
        session
            .write(b"echo karl-bus\nexit\n")
            .expect("write");

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
}
