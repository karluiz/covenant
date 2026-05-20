//! Owns a `pi --mode rpc` child process: stdin writer, stdout reader, and
//! request/response correlation.
//!
//! Lifecycle:
//!   1. [`PiSession::spawn`] forks `pi`, hands stdin off to a single-writer
//!      task, and spawns a reader task that frames stdout JSONL through
//!      [`super::framer::LineFramer`] and broadcasts envelopes on
//!      [`PiSession::events`].
//!   2. [`PiSession::send`] enqueues a command (fire-and-forget).
//!   3. [`PiSession::send_with_response`] does the same but injects a
//!      correlation id and awaits the matching response.
//!   4. [`PiSession::shutdown`] aborts in flight work, closes stdin, and
//!      waits up to a timeout before killing the child.
//!
//! Threading: writes and reads each get their own dedicated task. The
//! public API is `Send + Sync` because everything mutable hides behind
//! tokio primitives (`Mutex`, `mpsc`, `broadcast`).

use std::collections::HashMap;
use std::env;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use super::framer::LineFramer;
use super::protocol::{PiCommand, PiEnvelope, PiEvent, PiResponse};

/// How many envelopes can buffer before slow subscribers start dropping
/// frames. Picked generously — Pi streams text deltas one token at a time.
const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// stdin write queue depth. Commands are tiny; this just bounds the
/// pathological case of a runaway caller.
const STDIN_CHANNEL_CAPACITY: usize = 128;

#[cfg(unix)]
const GUI_APP_PATH_DIRS: &[&str] = &[
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
];

#[cfg(not(unix))]
const GUI_APP_PATH_DIRS: &[&str] = &[];

fn default_pi_program() -> PathBuf {
    let path = augmented_path(env::var_os("PATH"));
    find_program_on_path("pi", path.as_deref()).unwrap_or_else(|| PathBuf::from("pi"))
}

fn augmented_path(existing: Option<OsString>) -> Option<OsString> {
    let mut paths: Vec<PathBuf> = existing
        .as_deref()
        .map(env::split_paths)
        .map(|paths| paths.collect())
        .unwrap_or_default();

    for dir in GUI_APP_PATH_DIRS {
        let candidate = PathBuf::from(dir);
        if !paths.iter().any(|p| p == &candidate) {
            paths.push(candidate);
        }
    }

    env::join_paths(paths).ok()
}

fn find_program_on_path(program: &str, path: Option<&OsStr>) -> Option<PathBuf> {
    let program_path = Path::new(program);
    if program_path.components().count() > 1 {
        return program_path.is_file().then(|| program_path.to_path_buf());
    }

    let path = path?;
    for dir in env::split_paths(path) {
        let candidate = dir.join(program);
        if candidate.is_file() {
            return Some(candidate);
        }

        #[cfg(windows)]
        {
            let candidate = dir.join(format!("{program}.cmd"));
            if candidate.is_file() {
                return Some(candidate);
            }
            let candidate = dir.join(format!("{program}.exe"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

#[derive(Debug, Clone, Default)]
pub struct PiSpawnOpts {
    /// Working directory for the `pi` process.
    pub cwd: Option<PathBuf>,
    /// `--provider <name>` (anthropic, openai, google, …).
    pub provider: Option<String>,
    /// `--model <pattern>`.
    pub model: Option<String>,
    /// `--session-dir <path>` — Pi persists conversation JSONL here.
    pub session_dir: Option<PathBuf>,
    /// If true, pass `--no-session` so Pi does not persist.
    pub no_session: bool,
    /// Extra args appended verbatim. Reserved for power users / tests.
    pub extra_args: Vec<String>,
    /// Override the binary name/path. Defaults to `pi`.
    pub program: Option<PathBuf>,
}

#[derive(Debug, Error)]
pub enum PiSpawnError {
    #[error("failed to spawn `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("child process did not expose {stream}")]
    MissingStream { stream: &'static str },
}

#[derive(Debug, Error)]
pub enum PiSendError {
    #[error("session is shutting down")]
    Closed,
    #[error("response channel cancelled before reply arrived")]
    ResponseCancelled,
    #[error("pi reported error: {0}")]
    PiError(String),
    #[error("serialize command: {0}")]
    Serialize(#[from] serde_json::Error),
}

/// Inbound envelope tagged with the originating session id (for fan-out
/// onto a global bus). Local consumers can drop the wrapper and read
/// [`Tagged::envelope`] directly.
#[derive(Debug, Clone)]
pub struct Tagged<T> {
    pub session_id: String,
    pub envelope: T,
}

pub struct PiSession {
    /// Opaque id assigned by the caller. Echoed onto every broadcast frame
    /// so a shared global bus can disambiguate sessions without storing
    /// `PiSession` pointers.
    pub session_id: String,
    events_tx: broadcast::Sender<Tagged<PiEvent>>,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<PiResponse>>>>,
    /// Atomic counter for generating correlation ids. Wraps via Ulid.
    next_id: std::sync::atomic::AtomicU64,
    /// The child handle lives behind a mutex so `shutdown` can take it
    /// without breaking `Clone`-style accessors elsewhere.
    child: Mutex<Option<Child>>,
    /// Reader/writer task handles, retained so we can `await` them on
    /// shutdown. Dropping the session also drops these handles, which
    /// implicitly aborts the tasks.
    reader: Mutex<Option<JoinHandle<()>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
}

impl PiSession {
    /// Spawn `pi --mode rpc` with the given options. The returned session
    /// is immediately ready: pending tasks are running and [`events`] is
    /// live. The `session_id` is yours — pass any string that uniquely
    /// identifies this session in your app.
    pub async fn spawn(session_id: String, opts: PiSpawnOpts) -> Result<Arc<Self>, PiSpawnError> {
        let program = opts.program.clone().unwrap_or_else(default_pi_program);
        let mut cmd = Command::new(&program);
        if let Some(path) = augmented_path(env::var_os("PATH")) {
            // GUI-launched macOS apps often inherit a sparse PATH. Keep the
            // user's PATH first, then add Homebrew/system bins so both `pi`
            // and its `#!/usr/bin/env node` shebang can resolve.
            cmd.env("PATH", path);
        }
        cmd.arg("--mode").arg("rpc");
        if let Some(p) = &opts.provider {
            cmd.arg("--provider").arg(p);
        }
        if let Some(m) = &opts.model {
            cmd.arg("--model").arg(m);
        }
        if let Some(d) = &opts.session_dir {
            cmd.arg("--session-dir").arg(d);
        }
        if opts.no_session {
            cmd.arg("--no-session");
        }
        for a in &opts.extra_args {
            cmd.arg(a);
        }
        if let Some(cwd) = &opts.cwd {
            cmd.current_dir(cwd);
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| PiSpawnError::Spawn {
            program: program.display().to_string(),
            source: e,
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or(PiSpawnError::MissingStream { stream: "stdin" })?;
        let stdout = child
            .stdout
            .take()
            .ok_or(PiSpawnError::MissingStream { stream: "stdout" })?;

        let (events_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(STDIN_CHANNEL_CAPACITY);
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<PiResponse>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let session = Arc::new(Self {
            session_id: session_id.clone(),
            events_tx: events_tx.clone(),
            stdin_tx,
            pending: pending.clone(),
            next_id: std::sync::atomic::AtomicU64::new(1),
            child: Mutex::new(Some(child)),
            reader: Mutex::new(None),
            writer: Mutex::new(None),
        });

        let writer_handle = tokio::spawn(write_loop(stdin, stdin_rx));
        let reader_handle = tokio::spawn(read_loop(stdout, events_tx, pending, session_id.clone()));
        *session.writer.lock().await = Some(writer_handle);
        *session.reader.lock().await = Some(reader_handle);

        Ok(session)
    }

    /// Subscribe to the broadcast event stream. Each subscriber gets its
    /// own back-pressured queue (cap [`EVENT_CHANNEL_CAPACITY`]); slow
    /// consumers receive `RecvError::Lagged` frames and skip ahead.
    pub fn events(&self) -> broadcast::Receiver<Tagged<PiEvent>> {
        self.events_tx.subscribe()
    }

    /// Fire-and-forget command. Any error is on the serialization step;
    /// the actual delivery confirmation comes (if you want it) as an
    /// event on the broadcast stream.
    pub async fn send(&self, cmd: &PiCommand) -> Result<(), PiSendError> {
        let line = serde_json::to_vec(cmd)?;
        let mut framed = line;
        framed.push(b'\n');
        self.stdin_tx
            .send(framed)
            .await
            .map_err(|_| PiSendError::Closed)
    }

    /// Send a command and await its `response` line. The command's `id`
    /// field is overwritten with a generated correlation id so callers
    /// don't have to invent unique strings themselves.
    pub async fn send_with_response(&self, mut cmd: PiCommand) -> Result<PiResponse, PiSendError> {
        let id = self.alloc_id();
        set_command_id(&mut cmd, id.clone());

        let (tx, rx) = oneshot::channel();
        {
            let mut p = self.pending.lock().await;
            p.insert(id.clone(), tx);
        }

        if let Err(e) = self.send(&cmd).await {
            // Best-effort cleanup so we don't leak a slot.
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        match rx.await {
            Ok(resp) => {
                if !resp.success {
                    let msg = resp.error.clone().unwrap_or_else(|| "unknown error".into());
                    return Err(PiSendError::PiError(msg));
                }
                Ok(resp)
            }
            Err(_) => Err(PiSendError::ResponseCancelled),
        }
    }

    fn alloc_id(&self) -> String {
        let n = self
            .next_id
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("k{n:08x}")
    }

    /// Graceful shutdown: send `abort`, close stdin, wait for the child
    /// up to `timeout`, then SIGKILL if it hasn't exited.
    pub async fn shutdown(&self, timeout: Duration) {
        // Best-effort abort. Ignore errors — we're tearing down anyway.
        let _ = self.send(&PiCommand::Abort).await;
        // Dropping the sender closes the writer side, which closes pi's
        // stdin once the writer task drains.
        // We can't drop self.stdin_tx because it's owned by the session;
        // instead, send a sentinel by closing the writer task explicitly
        // via take().
        if let Some(handle) = self.writer.lock().await.take() {
            handle.abort();
            let _ = handle.await;
        }

        let mut child_lock = self.child.lock().await;
        if let Some(mut child) = child_lock.take() {
            let wait = tokio::time::timeout(timeout, child.wait()).await;
            if wait.is_err() {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }

        // Reader will exit naturally once stdout closes.
        if let Some(handle) = self.reader.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }

        // Notify subscribers — synthetic event matching the protocol's
        // ProcessExited variant.
        let _ = self.events_tx.send(Tagged {
            session_id: self.session_id.clone(),
            envelope: PiEvent::ProcessExited { code: None },
        });
    }
}

/// Inject the provided correlation id into commands that carry one.
/// Commands without an `id` field (e.g. [`PiCommand::Abort`]) are
/// untouched — Pi treats them as fire-and-forget anyway.
fn set_command_id(cmd: &mut PiCommand, new_id: String) {
    match cmd {
        PiCommand::Prompt { id, .. }
        | PiCommand::GetState { id }
        | PiCommand::GetMessages { id }
        | PiCommand::SetModel { id, .. }
        | PiCommand::GetAvailableModels { id }
        | PiCommand::Bash { id, .. }
        | PiCommand::GetSessionStats { id }
        | PiCommand::GetForkMessages { id }
        | PiCommand::GetLastAssistantText { id }
        | PiCommand::GetCommands { id } => *id = Some(new_id),
        _ => {}
    }
}

async fn write_loop(mut stdin: ChildStdin, mut rx: mpsc::Receiver<Vec<u8>>) {
    while let Some(line) = rx.recv().await {
        if let Err(e) = stdin.write_all(&line).await {
            tracing::warn!(?e, "pi rpc stdin write failed; closing writer");
            break;
        }
        if let Err(e) = stdin.flush().await {
            tracing::warn!(?e, "pi rpc stdin flush failed; closing writer");
            break;
        }
    }
    // Closing stdin signals end-of-input to pi; the child should exit.
    drop(stdin);
}

async fn read_loop(
    mut stdout: ChildStdout,
    events_tx: broadcast::Sender<Tagged<PiEvent>>,
    pending: Arc<Mutex<HashMap<String, oneshot::Sender<PiResponse>>>>,
    session_id: String,
) {
    let mut framer = LineFramer::new();
    let mut chunk = vec![0u8; 8 * 1024];
    loop {
        let n = match stdout.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(?e, "pi rpc stdout read failed");
                break;
            }
        };
        framer.feed(&chunk[..n]);
        while let Some(line) = framer.pop_line() {
            handle_line(line, &events_tx, &pending, &session_id).await;
        }
    }
    // EOF — drain whatever partial buffer is left if it happens to be a
    // complete line missing its trailing `\n` (some buggy producers).
    // We don't synthesize the trailing newline because feeding it now
    // could double-emit a previously-emitted line; instead just exit.
    tracing::debug!(session_id = %session_id, "pi rpc reader exiting");
}

async fn handle_line(
    line: Vec<u8>,
    events_tx: &broadcast::Sender<Tagged<PiEvent>>,
    pending: &Arc<Mutex<HashMap<String, oneshot::Sender<PiResponse>>>>,
    session_id: &str,
) {
    let env: PiEnvelope = match serde_json::from_slice(&line) {
        Ok(env) => env,
        Err(e) => {
            // Pi guarantees JSONL — a parse failure is a protocol bug or
            // a partial UTF-8 decode (the framer hands us bytes only).
            // Log verbatim; don't crash the session.
            let preview = String::from_utf8_lossy(&line);
            tracing::warn!(?e, line = %preview, "pi rpc: parse failure, dropping line");
            return;
        }
    };
    match env {
        PiEnvelope::Response(r) => {
            if let Some(id) = &r.id {
                let waiter = pending.lock().await.remove(id);
                if let Some(tx) = waiter {
                    let _ = tx.send(r);
                    return;
                }
            }
            // Response with no id, or no waiter — surface as event so the
            // operator panel can still observe it.
            tracing::debug!(
                command = %r.command,
                success = r.success,
                "pi rpc: response without correlated waiter",
            );
            // We don't emit untagged responses on the event bus; they're
            // not events. Surface to consumers via a separate channel
            // would be future work.
            let _ = pending; // suppress unused warning paths
            let _ = events_tx; // suppress unused warning paths
        }
        PiEnvelope::Event(e) => {
            let _ = events_tx.send(Tagged {
                session_id: session_id.to_string(),
                envelope: e,
            });
        }
    }
}

/// Extract a [`super::protocol::PiState`] from a response. Convenience for
/// callers that want the typed snapshot instead of poking at `data`.
pub fn parse_state(resp: &PiResponse) -> Option<super::protocol::PiState> {
    resp.data
        .clone()
        .and_then(|d| serde_json::from_value(d).ok())
}

/// Same convenience for `get_session_stats`.
pub fn parse_session_stats(resp: &PiResponse) -> Option<super::protocol::PiSessionStats> {
    resp.data
        .clone()
        .and_then(|d| serde_json::from_value(d).ok())
}

#[allow(dead_code)]
fn _typecheck_value(_v: Value) {} // ensures Value is used at module scope

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pi_rpc::protocol::{PiEvent, ThinkingLevel};

    /// Spawn a fake `pi` using `sh -c` that echoes a canned event stream
    /// and exits. Verifies the reader frames JSONL correctly, dispatches
    /// events to subscribers, and shuts down without leaking processes.
    #[tokio::test]
    async fn reads_fake_pi_event_stream() {
        // The script writes three JSONL lines then exits. We use printf
        // (POSIX) so this works on any unix-like CI.
        let script = r#"printf '{"type":"agent_start"}\n{"type":"message_update","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"hi"}}\n{"type":"agent_end","messages":[]}\n'"#;

        let _opts = PiSpawnOpts {
            program: Some(PathBuf::from("sh")),
            extra_args: vec!["-c".into(), script.into()],
            no_session: false, // irrelevant; --mode rpc isn't even passed
            ..Default::default()
        };

        // Build the command manually because PiSession::spawn always
        // injects `--mode rpc`, which `sh -c` would interpret as a
        // script positional. We bypass the helper here.
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn sh");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let (events_tx, mut events_rx) = broadcast::channel(64);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let (stdin_tx, stdin_rx) = mpsc::channel(8);
        let _writer = tokio::spawn(write_loop(stdin, stdin_rx));
        let reader = tokio::spawn(read_loop(stdout, events_tx, pending, "test".into()));

        let mut received = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while received.len() < 3 && tokio::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(200), events_rx.recv()).await {
                Ok(Ok(t)) => received.push(t.envelope),
                _ => continue,
            }
        }

        assert!(matches!(received.first(), Some(PiEvent::AgentStart)));
        assert!(matches!(
            received.get(1),
            Some(PiEvent::MessageUpdate { .. })
        ));
        assert!(matches!(received.get(2), Some(PiEvent::AgentEnd { .. })));

        drop(stdin_tx);
        let _ = child.wait().await;
        let _ = reader.await;
    }

    /// Same setup, but issues a fake `response` so we exercise the
    /// id-correlation path. The script reads a request line, parses the
    /// id with a tiny sed, and echoes a matching response.
    #[tokio::test]
    async fn correlates_request_id_to_response() {
        let script = r#"read line; id=$(printf '%s' "$line" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p'); printf '{"type":"response","command":"get_state","success":true,"id":"%s","data":{"isStreaming":false}}\n' "$id""#;

        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn sh");
        let stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let (events_tx, _events_rx) = broadcast::channel(16);
        let pending: Arc<Mutex<HashMap<String, oneshot::Sender<PiResponse>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let (stdin_tx, stdin_rx) = mpsc::channel(8);
        let _writer = tokio::spawn(write_loop(stdin, stdin_rx));
        let reader = tokio::spawn(read_loop(stdout, events_tx, pending.clone(), "test".into()));

        // Register a pending waiter.
        let (tx, rx) = oneshot::channel();
        pending.lock().await.insert("k00000001".into(), tx);

        // Send a get_state request with that id.
        let cmd = PiCommand::GetState {
            id: Some("k00000001".into()),
        };
        let mut line = serde_json::to_vec(&cmd).unwrap();
        line.push(b'\n');
        stdin_tx.send(line).await.expect("send");

        let resp = tokio::time::timeout(Duration::from_secs(2), rx)
            .await
            .expect("response timed out")
            .expect("waiter dropped");
        assert!(resp.success);
        assert_eq!(resp.id.as_deref(), Some("k00000001"));

        let state = parse_state(&resp).expect("data parses");
        assert!(!state.is_streaming);

        drop(stdin_tx);
        let _ = child.wait().await;
        let _ = reader.await;
    }

    #[tokio::test]
    async fn malformed_line_does_not_kill_reader() {
        // First line is garbage, second is a valid event. The reader must
        // log + skip the bad one and still deliver the good one.
        let script = r#"printf 'not json\n{"type":"agent_start"}\n'"#;
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(script)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        let mut child = cmd.spawn().expect("spawn sh");
        let _stdin = child.stdin.take().unwrap();
        let stdout = child.stdout.take().unwrap();

        let (events_tx, mut events_rx) = broadcast::channel(16);
        let pending = Arc::new(Mutex::new(HashMap::new()));
        let reader = tokio::spawn(read_loop(stdout, events_tx, pending, "test".into()));

        let event = tokio::time::timeout(Duration::from_secs(2), events_rx.recv())
            .await
            .expect("timed out")
            .expect("recv");
        assert!(matches!(event.envelope, PiEvent::AgentStart));

        let _ = child.wait().await;
        let _ = reader.await;
    }

    /// Confirms `set_command_id` rewrites the id of commands that carry
    /// one and leaves the rest alone.
    #[test]
    fn id_injection_targets_correct_variants() {
        let mut a = PiCommand::GetState { id: None };
        set_command_id(&mut a, "x".into());
        match a {
            PiCommand::GetState { id } => assert_eq!(id.as_deref(), Some("x")),
            _ => panic!(),
        }
        let mut b = PiCommand::SetThinkingLevel {
            level: ThinkingLevel::High,
        };
        set_command_id(&mut b, "x".into());
        // No `id` field — just verify no panic and discriminant unchanged.
        assert!(matches!(b, PiCommand::SetThinkingLevel { .. }));
    }
}
