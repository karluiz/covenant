//! Owns a `copilot --acp` child: single-writer stdin task, reader task
//! that frames stdout JSONL, correlates JSON-RPC responses, answers
//! agent→client requests inline, and broadcasts `session/update`
//! notifications. Mirrors [`crate::pi_rpc::session::PiSession`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, Ordering};
use std::sync::Arc;
use std::sync::Mutex as StdMutex;
use std::time::Duration;

use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStderr, ChildStdout, Command};
use tokio::sync::{broadcast, mpsc, oneshot, Mutex};
use tokio::task::JoinHandle;

use crate::pi_rpc::framer::LineFramer;
use crate::pi_rpc::session::{augmented_path, find_program_on_path};

use super::protocol::{FrameKind, InboundFrame, PermissionRequest, SessionNotification};

/// How many notifications can buffer before slow subscribers start
/// dropping frames.
const EVENT_CHANNEL_CAPACITY: usize = 1024;

/// stdin write queue depth.
const STDIN_CHANNEL_CAPACITY: usize = 128;

/// Bytes of stderr tail kept for handshake-failure diagnostics. Bounded so
/// a chatty or looping child can't grow this unboundedly.
const STDERR_TAIL_CAP: usize = 2048;

fn default_copilot_program() -> PathBuf {
    let path = augmented_path(std::env::var_os("PATH"));
    find_program_on_path("copilot", path.as_deref()).unwrap_or_else(|| PathBuf::from("copilot"))
}

#[derive(Debug, Clone)]
pub struct AcpSpawnOpts {
    /// Working directory; also passed as `--add-dir` so copilot's file
    /// tools are allowed to touch it.
    pub cwd: PathBuf,
    pub program: Option<PathBuf>,
    pub extra_args: Vec<String>,
    /// Agent-mode launch args appended after `extra_args`. `None` = the
    /// copilot profile (`--acp --add-dir <cwd>`, the historical default).
    /// `Some(args)` replaces it verbatim — e.g. `Some(vec![])` for
    /// adapters like `pi-acp` that speak ACP with no flags at all.
    pub agent_args: Option<Vec<String>>,
    /// Extra environment for the child (e.g. `CLAUDE_CONFIG_DIR` for the
    /// claude adapter's isolated config). Applied on top of the inherited
    /// environment.
    pub env: Vec<(String, String)>,
}

impl AcpSpawnOpts {
    /// Launch profile for a named executor.
    /// - `"copilot"` — the copilot binary with `--acp --add-dir <cwd>`
    ///   (the historical default).
    /// - `"pi"` — the community `pi-acp` adapter (ACP registry id
    ///   `pi-acp`), which wraps the local `pi` binary and takes no args:
    ///   a global install on PATH if present, else `npx -y pi-acp`.
    pub fn for_executor(executor: &str, cwd: PathBuf) -> Result<Self, String> {
        match executor {
            "copilot" => Ok(Self {
                cwd,
                program: None,
                extra_args: Vec::new(),
                agent_args: None,
                env: Vec::new(),
            }),
            "pi" => {
                let path = augmented_path(std::env::var_os("PATH"));
                let (program, extra_args) = match find_program_on_path("pi-acp", path.as_deref())
                {
                    Some(p) => (p, Vec::new()),
                    // ponytail: unpinned npx fallback — first run pays the
                    // package download; pin a version if that gets flaky.
                    None => (
                        find_program_on_path("npx", path.as_deref())
                            .unwrap_or_else(|| PathBuf::from("npx")),
                        vec!["-y".to_string(), "pi-acp".to_string()],
                    ),
                };
                Ok(Self {
                    cwd,
                    program: Some(program),
                    extra_args,
                    agent_args: Some(Vec::new()),
                    env: Vec::new(),
                })
            }
            // Official Zed adapter over the Claude Agent SDK. Caller must
            // add a CLAUDE_CONFIG_DIR env entry pointing at a prepared
            // isolated config (see acp_commands::prepare_claude_acp_config)
            // — the adapter's pinned SDK chokes on newer user-settings
            // fields (`permissions.defaultMode: auto`) otherwise.
            "claude" => {
                let path = augmented_path(std::env::var_os("PATH"));
                let (program, extra_args) =
                    match find_program_on_path("claude-agent-acp", path.as_deref()) {
                        Some(p) => (p, Vec::new()),
                        None => (
                            find_program_on_path("npx", path.as_deref())
                                .unwrap_or_else(|| PathBuf::from("npx")),
                            vec![
                                "-y".to_string(),
                                "@zed-industries/claude-agent-acp".to_string(),
                            ],
                        ),
                    };
                Ok(Self {
                    cwd,
                    program: Some(program),
                    extra_args,
                    agent_args: Some(Vec::new()),
                    env: Vec::new(),
                })
            }
            other => Err(format!("unknown ACP executor: {other}")),
        }
    }
}

/// A resolver's answer to `session/request_permission`: either decide
/// immediately, or park the request and answer later via
/// [`AcpSession::respond_permission`].
#[derive(Debug, Clone)]
pub enum PermissionDecision {
    /// Reply now with this optionId.
    Select(String),
    /// Park the request; a [`AcpSessionEvent::PermissionPending`] is
    /// broadcast and the reply is deferred until `respond_permission`.
    Defer,
}

/// Answers `session/request_permission` synchronously with a decision.
pub type PermissionResolver = Arc<dyn Fn(&PermissionRequest) -> PermissionDecision + Send + Sync>;

/// Broadcast payload for [`AcpSession::events`] — widened from a bare
/// `SessionNotification` so interactive consumers can also observe parked
/// permission requests.
#[derive(Debug, Clone)]
pub enum AcpSessionEvent {
    /// A `session/update` notification, unchanged from before.
    Update(SessionNotification),
    /// A `session/request_permission` the resolver deferred. Answer it
    /// with [`AcpSession::respond_permission`], keyed by `request_key`.
    PermissionPending {
        request_key: String,
        request: PermissionRequest,
    },
    /// reader exited — child stdout gone; no further events will arrive.
    ///
    /// Explicit liveness signal: `AcpSession` itself holds a clone of the
    /// broadcast `Sender` for its whole lifetime (kept alive by whatever
    /// registry owns the `Arc<AcpSession>`), so `RecvError::Closed` — which
    /// only fires once *every* `Sender` clone is dropped — is unreachable
    /// on a real child crash; only `read_loop`'s clone would drop. Consumers
    /// that need to detect "the child died" (e.g. the Tauri forwarder in
    /// `acp_commands.rs`) must match on this variant instead of relying on
    /// `RecvError::Closed`.
    Closed,
}

#[derive(Debug, Error)]
pub enum AcpError {
    #[error("failed to spawn `{program}`: {source}")]
    Spawn {
        program: String,
        #[source]
        source: std::io::Error,
    },
    #[error("child process did not expose {stream}")]
    MissingStream { stream: &'static str },
    #[error("session is shutting down")]
    Closed,
    #[error("response channel cancelled before reply arrived")]
    ResponseCancelled,
    #[error("agent returned error: {0}")]
    Rpc(String),
    #[error("serialize: {0}")]
    Serialize(#[from] serde_json::Error),
}

pub struct AcpSession {
    events_tx: broadcast::Sender<AcpSessionEvent>,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>>,
    /// Flipped to `false` by whichever of read_loop/write_loop exits
    /// first, or by [`AcpSession::shutdown`]. `request()` consults this
    /// (under the same `pending` lock used to tear it down) so it can
    /// never insert a waiter into a map nobody will ever drain again.
    alive: Arc<AtomicBool>,
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
    /// Bounded tail of the child's stderr, kept for surfacing in handshake
    /// failure messages (see [`AcpSession::stderr_tail`]). Filled by a
    /// dedicated reader task that exits on stderr EOF; never blocks
    /// shutdown.
    stderr_buf: Arc<StdMutex<Vec<u8>>>,
    stderr_reader: Mutex<Option<JoinHandle<()>>>,
    /// Parked agent→client permission requests awaiting respond_permission.
    parked: Arc<Mutex<HashMap<String, Value>>>,
    /// request_key counter. The struct holds this clone alongside `parked`
    /// for symmetry/future use; the live counter driving `request_key`
    /// generation is the clone threaded into `read_loop`, since only that
    /// task ever mints new parked requests.
    #[allow(dead_code)]
    next_perm: Arc<AtomicU64>,
}

impl AcpSession {
    /// Spawn `copilot --acp` with the given options. The returned session
    /// is immediately ready: pending tasks are running and [`events`] is
    /// live.
    pub async fn spawn(
        opts: AcpSpawnOpts,
        resolver: PermissionResolver,
    ) -> Result<Arc<Self>, AcpError> {
        let program = opts.program.clone().unwrap_or_else(default_copilot_program);
        let mut cmd = Command::new(&program);
        if let Some(path) = augmented_path(std::env::var_os("PATH")) {
            // GUI-launched macOS apps often inherit a sparse PATH. Keep the
            // user's PATH first, then add Homebrew/system bins so both
            // `copilot` and its shebang can resolve.
            cmd.env("PATH", path);
        }
        // extra_args go first: with a `sh -c <script>` test double, anything
        // after the script lands in $0/$1... instead of being parsed as sh
        // invocation options (`sh --acp` is an invocation error). copilot
        // accepts its flags in any position.
        for (k, v) in &opts.env {
            cmd.env(k, v);
        }
        for a in &opts.extra_args {
            cmd.arg(a);
        }
        match &opts.agent_args {
            None => {
                cmd.arg("--acp").arg("--add-dir").arg(&opts.cwd);
            }
            Some(args) => {
                for a in args {
                    cmd.arg(a);
                }
            }
        }
        cmd.current_dir(&opts.cwd);
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| AcpError::Spawn {
            program: program.display().to_string(),
            source: e,
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or(AcpError::MissingStream { stream: "stdin" })?;
        let stdout = child
            .stdout
            .take()
            .ok_or(AcpError::MissingStream { stream: "stdout" })?;
        let stderr = child
            .stderr
            .take()
            .ok_or(AcpError::MissingStream { stream: "stderr" })?;

        let (events_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(STDIN_CHANNEL_CAPACITY);
        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>> =
            Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let stderr_buf: Arc<StdMutex<Vec<u8>>> = Arc::new(StdMutex::new(Vec::new()));
        let parked: Arc<Mutex<HashMap<String, Value>>> = Arc::new(Mutex::new(HashMap::new()));
        let next_perm = Arc::new(AtomicU64::new(0));

        let session = Arc::new(Self {
            events_tx: events_tx.clone(),
            stdin_tx: stdin_tx.clone(),
            pending: pending.clone(),
            alive: alive.clone(),
            next_id: AtomicI64::new(1),
            child: Mutex::new(Some(child)),
            reader: Mutex::new(None),
            writer: Mutex::new(None),
            stderr_buf: stderr_buf.clone(),
            stderr_reader: Mutex::new(None),
            parked: parked.clone(),
            next_perm: next_perm.clone(),
        });

        let writer_handle = tokio::spawn(write_loop(stdin, stdin_rx, alive.clone()));
        let reader_handle = tokio::spawn(read_loop(
            stdout,
            events_tx,
            pending,
            stdin_tx,
            resolver,
            alive,
            parked,
            next_perm,
        ));
        let stderr_handle = tokio::spawn(stderr_loop(stderr, stderr_buf));
        *session.writer.lock().await = Some(writer_handle);
        *session.reader.lock().await = Some(reader_handle);
        *session.stderr_reader.lock().await = Some(stderr_handle);

        Ok(session)
    }

    /// Lossy-UTF8 tail of the child's stderr (last [`STDERR_TAIL_CAP`]
    /// bytes), trimmed. Empty string if the child never wrote to stderr
    /// (or the reader hasn't observed anything yet).
    pub fn stderr_tail(&self) -> String {
        match self.stderr_buf.lock() {
            Ok(buf) => String::from_utf8_lossy(&buf).trim().to_string(),
            Err(_) => String::new(),
        }
    }

    /// Subscribe to the broadcast `session/update` stream. Each subscriber
    /// gets its own back-pressured queue (cap [`EVENT_CHANNEL_CAPACITY`]);
    /// slow consumers receive `RecvError::Lagged` frames and skip ahead.
    pub fn events(&self) -> broadcast::Receiver<AcpSessionEvent> {
        self.events_tx.subscribe()
    }

    /// Send a JSON-RPC request and await its correlated response.
    pub async fn request(&self, method: &str, params: Value) -> Result<Value, AcpError> {
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);

        let (tx, rx) = oneshot::channel();
        {
            let mut p = self.pending.lock().await;
            // Checked under the same lock read_loop/shutdown hold when
            // they flip `alive` and drain `pending`, so this can never
            // race: either we observe `alive == false` and bail before
            // inserting, or we insert before the teardown runs and our
            // waiter gets swept up (and resolved to `ResponseCancelled`)
            // by that same teardown. Either way, no waiter is ever left
            // orphaned in the map.
            if !self.alive.load(Ordering::Acquire) {
                return Err(AcpError::Closed);
            }
            p.insert(id, tx);
        }

        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_vec(&frame)?;
        line.push(b'\n');
        // Empty Vec is write_loop's close sentinel — JSON + '\n' can never
        // be empty, but keep the invariant explicit.
        debug_assert!(!line.is_empty());

        if self.stdin_tx.send(line).await.is_err() {
            // Best-effort cleanup so we don't leak a slot.
            self.pending.lock().await.remove(&id);
            return Err(AcpError::Closed);
        }

        match rx.await {
            Ok(result) => result,
            Err(_) => Err(AcpError::ResponseCancelled),
        }
    }

    /// Fire-and-forget notification — no id, no response expected.
    pub async fn notify(&self, method: &str, params: Value) -> Result<(), AcpError> {
        let frame = serde_json::json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        let mut line = serde_json::to_vec(&frame)?;
        line.push(b'\n');
        debug_assert!(!line.is_empty()); // empty = write_loop close sentinel
        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| AcpError::Closed)
    }

    /// Answer a permission request previously parked by
    /// [`PermissionDecision::Defer`] (surfaced via
    /// `AcpSessionEvent::PermissionPending`). An empty `option_id` sends
    /// the ACP "cancelled" outcome instead of a selected option — use this
    /// to represent a user dismissing the prompt without choosing.
    ///
    /// Errors if `request_key` is unknown (never parked, already
    /// answered, or already drained by [`AcpSession::shutdown`]).
    pub async fn respond_permission(
        &self,
        request_key: &str,
        option_id: &str,
    ) -> Result<(), AcpError> {
        let id = self.parked.lock().await.remove(request_key);
        let Some(id) = id else {
            return Err(AcpError::Rpc(format!(
                "unknown permission request: {request_key}"
            )));
        };

        let outcome = if option_id.is_empty() {
            serde_json::json!({ "outcome": "cancelled" })
        } else {
            serde_json::json!({ "outcome": "selected", "optionId": option_id })
        };
        let reply = serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": { "outcome": outcome },
        });
        let mut bytes = serde_json::to_vec(&reply)?;
        bytes.push(b'\n');
        debug_assert!(!bytes.is_empty()); // empty = write_loop close sentinel

        // Caller task, not the reader hot path — plain `.send().await` is
        // fine here (see module-level A0 review note on `try_send`).
        self.stdin_tx
            .send(bytes)
            .await
            .map_err(|_| AcpError::Closed)
    }

    /// Graceful shutdown, in order: flush parked permission requests as
    /// cancelled (bounded), close stdin via the writer's in-band close
    /// sentinel (so the cancelled replies hit the pipe first, then the
    /// child sees EOF), wait for the child up to `timeout`, SIGKILL if it
    /// hasn't exited, then join the reader tasks. There is no abort
    /// command in ACP — stdin EOF is the graceful-exit signal.
    pub async fn shutdown(&self, timeout: Duration) {
        // Flush any still-parked permission requests as cancelled before
        // tearing anything else down, so the agent isn't left waiting on
        // a dead client. Best-effort: if the writer is already gone this
        // send fails silently and the child kill below reclaims the
        // process anyway. Bounded like every other step here — a wedged
        // stdin (writer task stalled, pipe full) must not stall shutdown;
        // on timeout we warn and fall through to the child kill below,
        // which answers the agent by killing it instead.
        let flush = tokio::time::timeout(Duration::from_millis(500), async {
            let mut parked = self.parked.lock().await;
            for (_, id) in parked.drain() {
                let reply = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "outcome": { "outcome": "cancelled" } },
                });
                if let Ok(mut bytes) = serde_json::to_vec(&reply) {
                    bytes.push(b'\n');
                    let _ = self.stdin_tx.send(bytes).await;
                }
            }
        })
        .await;
        if flush.is_err() {
            tracing::warn!(
                timeout_ms = 500,
                "acp: parked-permission flush timed out during shutdown; killing child instead"
            );
        }

        // Flip dead and drain `pending` under lock, same pattern as
        // read_loop's exit. Dropping the oneshot senders resolves any
        // in-flight `request()` callers to `ResponseCancelled` instead of
        // hanging; any `request()` racing us either observes `alive ==
        // false` and bails, or slips its insert in first and gets swept
        // up by this clear.
        {
            let mut p = self.pending.lock().await;
            self.alive.store(false, Ordering::Release);
            p.clear();
        }

        // Close stdin BEFORE waiting on the child, or an EOF-exiting child
        // (real copilot's contract) never sees EOF and burns the whole
        // `timeout` below only to be SIGKILLed. But `stdin_tx.send()` only
        // enqueues — aborting the writer here would race it and could drop
        // the parked-flush replies still sitting in the queue. So instead:
        // send the in-band close sentinel (empty Vec) AFTER the flush
        // entries; write_loop processes the queue in order, so every
        // cancelled reply hits the pipe first, then the sentinel breaks the
        // loop and drops stdin → EOF to the child. Bounded, best-effort:
        // if the queue is wedged or the writer is already gone, fall
        // through — the abort fallback (and ultimately the child kill)
        // still closes stdin.
        let sentinel = tokio::time::timeout(
            Duration::from_millis(500),
            self.stdin_tx.send(Vec::new()),
        )
        .await;
        if !matches!(sentinel, Ok(Ok(()))) {
            tracing::warn!(
                timeout_ms = 500,
                "acp: stdin close sentinel not enqueued during shutdown; falling back to writer abort"
            );
        }
        if let Some(handle) = self.writer.lock().await.take() {
            let abort = handle.abort_handle();
            if tokio::time::timeout(Duration::from_secs(1), handle)
                .await
                .is_err()
            {
                tracing::warn!(
                    timeout_ms = 1000,
                    "acp: writer did not exit on close sentinel; aborting"
                );
                // Abort also closes stdin: cancelling the task drops it.
                abort.abort();
            }
        }

        let mut child_lock = self.child.lock().await;
        if let Some(mut child) = child_lock.take() {
            let wait = tokio::time::timeout(timeout, child.wait()).await;
            if wait.is_err() {
                let _ = child.start_kill();
                let _ = child.wait().await;
            }
        }
        drop(child_lock);

        // Reader will exit naturally once stdout closes.
        if let Some(handle) = self.reader.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }

        // Stderr reader will exit naturally once stderr closes (the child
        // is dead or being killed above, so this should be near-instant).
        // Bounded so a pathological stderr writer can never stall
        // shutdown; if it's still running past the bound, the child kill
        // above closes the pipe and it exits shortly after on its own.
        if let Some(handle) = self.stderr_reader.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), handle).await;
        }
    }
}

async fn write_loop(
    mut stdin: tokio::process::ChildStdin,
    mut rx: mpsc::Receiver<Vec<u8>>,
    alive: Arc<AtomicBool>,
) {
    while let Some(line) = rx.recv().await {
        // In-band close sentinel from `shutdown()`: an empty message means
        // "everything queued before me has been written — now close stdin
        // so an EOF-exiting child can terminate gracefully". Normal frames
        // are always serialized JSON + '\n' (≥ 2 bytes), so an empty Vec
        // can never occur on any other path (see debug_asserts at the
        // enqueue sites).
        if line.is_empty() {
            break;
        }
        if let Err(e) = stdin.write_all(&line).await {
            tracing::warn!(?e, "acp stdin write failed; closing writer");
            break;
        }
        if let Err(e) = stdin.flush().await {
            tracing::warn!(?e, "acp stdin flush failed; closing writer");
            break;
        }
    }
    // Best-effort signal; the authoritative teardown (flip + drain
    // `pending` atomically) happens in read_loop/shutdown. A writer that
    // dies while the reader is still alive is already handled because
    // `stdin_tx.send()` fails once this task drops `rx`.
    alive.store(false, Ordering::Release);
    // Closing stdin signals end-of-input to the agent.
    drop(stdin);
}

/// Drains the child's stderr into a bounded tail buffer, purely for
/// diagnostics (e.g. surfacing "unknown option: --acp" when the installed
/// copilot binary is too old for `--acp`). Never applies backpressure to
/// the child — a full read into a growing-then-truncated `Vec` is cheap
/// for the KB-scale output we expect here. Exits on EOF.
async fn stderr_loop(mut stderr: ChildStderr, buf: Arc<StdMutex<Vec<u8>>>) {
    let mut chunk = vec![0u8; 4 * 1024];
    loop {
        let n = match stderr.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                tracing::debug!(?e, "acp stderr read failed");
                break;
            }
        };
        if let Ok(mut b) = buf.lock() {
            b.extend_from_slice(&chunk[..n]);
            let len = b.len();
            if len > STDERR_TAIL_CAP {
                let drop_n = len - STDERR_TAIL_CAP;
                b.drain(0..drop_n);
            }
        }
    }
}

// 8 params: each one is a distinct piece of shared state threaded from
// `spawn` (channels/maps/flags), not a candidate for bundling into one
// struct without adding an abstraction that only this call site would use.
#[allow(clippy::too_many_arguments)]
async fn read_loop(
    mut stdout: ChildStdout,
    events_tx: broadcast::Sender<AcpSessionEvent>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>>,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    resolver: PermissionResolver,
    alive: Arc<AtomicBool>,
    parked: Arc<Mutex<HashMap<String, Value>>>,
    next_perm: Arc<AtomicU64>,
) {
    let mut framer = LineFramer::new();
    let mut chunk = vec![0u8; 8 * 1024];
    loop {
        let n = match stdout.read(&mut chunk).await {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) => {
                tracing::warn!(?e, "acp stdout read failed");
                break;
            }
        };
        framer.feed(&chunk[..n]);
        while let Some(line) = framer.pop_line() {
            handle_line(
                line, &events_tx, &pending, &stdin_tx, &resolver, &parked, &next_perm,
            )
            .await;
        }
    }
    // Stdout is gone — no reply can ever arrive. Flip `alive` and drop
    // outstanding waiters atomically (same lock `request()` checks under)
    // so in-flight `request()` calls resolve to `ResponseCancelled`, and
    // any `request()` that hasn't inserted yet observes `alive == false`
    // and bails with `Closed` instead of hanging forever.
    {
        let mut p = pending.lock().await;
        alive.store(false, Ordering::Release);
        p.clear();
    }
    // Same reasoning for parked permission requests: stdout is gone, so no
    // reply we send could ever be observed by the agent (it's dead or
    // dying). Drop them rather than attempting a cancelled reply — unlike
    // `shutdown`'s flush, there is no live child to answer here. Leaving
    // entries behind would let a later `respond_permission` find a stale
    // id and try to write into a stdin whose writer has already exited.
    parked.lock().await.clear();
    // Broadcast the explicit liveness signal (see `AcpSessionEvent::Closed`
    // doc) so subscribers can detect death deterministically instead of
    // relying on `RecvError::Closed`, which never fires while the struct's
    // own `events_tx` clone is alive. Best-effort: no subscribers is fine.
    let _ = events_tx.send(AcpSessionEvent::Closed);
    tracing::debug!("acp reader exiting");
}

async fn handle_line(
    line: Vec<u8>,
    events_tx: &broadcast::Sender<AcpSessionEvent>,
    pending: &Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>>,
    stdin_tx: &mpsc::Sender<Vec<u8>>,
    resolver: &PermissionResolver,
    parked: &Arc<Mutex<HashMap<String, Value>>>,
    next_perm: &Arc<AtomicU64>,
) {
    let frame: InboundFrame = match serde_json::from_slice(&line) {
        Ok(frame) => frame,
        Err(e) => {
            let preview = String::from_utf8_lossy(&line);
            tracing::warn!(?e, line = %preview, "acp: parse failure, dropping line");
            return;
        }
    };

    match frame.kind() {
        FrameKind::Response => {
            let Some(id) = frame.id.as_ref().and_then(Value::as_i64) else {
                tracing::debug!("acp: response without a numeric id, dropping");
                return;
            };
            let waiter = pending.lock().await.remove(&id);
            let Some(tx) = waiter else {
                tracing::debug!(id, "acp: response without correlated waiter");
                return;
            };
            let result = match frame.error {
                Some(err) => Err(AcpError::Rpc(err.message)),
                None => Ok(frame.result.unwrap_or(Value::Null)),
            };
            let _ = tx.send(result);
        }
        FrameKind::Request => {
            handle_agent_request(frame, stdin_tx, resolver, events_tx, parked, next_perm).await;
        }
        FrameKind::Notification => {
            if frame.method.as_deref() == Some("session/update") {
                let Some(params) = frame.params else {
                    tracing::warn!("acp: session/update without params, dropping");
                    return;
                };
                match serde_json::from_value::<SessionNotification>(params) {
                    Ok(n) => {
                        let _ = events_tx.send(AcpSessionEvent::Update(n));
                    }
                    Err(e) => {
                        tracing::warn!(?e, "acp: session/update failed to parse, dropping");
                    }
                }
            } else {
                tracing::debug!(method = ?frame.method, "acp: unhandled notification, dropping");
            }
        }
        FrameKind::Invalid => {
            tracing::warn!("acp: frame is neither response, request, nor notification");
        }
    }
}

/// Answer an agent→client request. Only `session/request_permission` is
/// implemented; everything else gets a JSON-RPC "method not found" so the
/// agent doesn't hang waiting on us.
async fn handle_agent_request(
    frame: InboundFrame,
    stdin_tx: &mpsc::Sender<Vec<u8>>,
    resolver: &PermissionResolver,
    events_tx: &broadcast::Sender<AcpSessionEvent>,
    parked: &Arc<Mutex<HashMap<String, Value>>>,
    next_perm: &Arc<AtomicU64>,
) {
    let Some(id) = frame.id else {
        return;
    };
    let method = frame.method.as_deref().unwrap_or_default();

    let reply = if method == "session/request_permission" {
        match frame
            .params
            .and_then(|p| serde_json::from_value::<PermissionRequest>(p).ok())
        {
            Some(req) => match resolver(&req) {
                PermissionDecision::Select(option_id) => Some(serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "outcome": { "outcome": "selected", "optionId": option_id } },
                })),
                PermissionDecision::Defer => {
                    let n = next_perm.fetch_add(1, Ordering::Relaxed);
                    let request_key = format!("perm-{n}");
                    parked.lock().await.insert(request_key.clone(), id.clone());
                    let _ = events_tx.send(AcpSessionEvent::PermissionPending {
                        request_key,
                        request: req,
                    });
                    None
                }
            },
            None => {
                tracing::warn!("acp: session/request_permission params failed to parse");
                Some(serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32602, "message": "invalid params" },
                }))
            }
        }
    } else {
        Some(serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "not supported by this client" },
        }))
    };

    // Deferred: no reply yet, `respond_permission` sends it later.
    let Some(reply) = reply else {
        return;
    };

    let Ok(mut bytes) = serde_json::to_vec(&reply) else {
        tracing::warn!("acp: failed to serialize reply frame");
        return;
    };
    bytes.push(b'\n');
    debug_assert!(!bytes.is_empty()); // empty = write_loop close sentinel

    // `try_send` so a saturated stdin queue can never stall the reader —
    // the reader must keep draining stdout regardless of stdin
    // backpressure, or ALL inbound frames (not just this reply) stop
    // being processed. Reply ordering across distinct agent→client
    // requests is not guaranteed by the ACP protocol, so deferring this
    // send to a detached task when the queue is full is safe.
    match stdin_tx.try_send(bytes) {
        Ok(()) => {}
        Err(mpsc::error::TrySendError::Full(bytes)) => {
            tracing::warn!(?id, method, "acp: stdin queue full, deferring reply send");
            let tx = stdin_tx.clone();
            tokio::spawn(async move {
                if tx.send(bytes).await.is_err() {
                    tracing::warn!("acp: failed to send deferred reply — stdin closed");
                }
            });
        }
        Err(mpsc::error::TrySendError::Closed(_)) => {
            tracing::warn!("acp: failed to send reply — stdin closed");
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::protocol::SessionUpdate;
    use std::sync::Mutex as StdMutex;

    fn spawn_opts(script: &str) -> AcpSpawnOpts {
        AcpSpawnOpts {
            cwd: std::env::temp_dir(),
            program: Some(PathBuf::from("sh")),
            extra_args: vec!["-c".into(), script.into()],
            agent_args: None,
            env: Vec::new(),
        }
    }

    #[test]
    fn for_executor_profiles() {
        let cwd = std::env::temp_dir();
        // copilot: default binary + default (--acp --add-dir) launch args.
        let c = AcpSpawnOpts::for_executor("copilot", cwd.clone()).unwrap();
        assert!(c.program.is_none());
        assert!(c.agent_args.is_none());
        // pi: explicit program (pi-acp or npx fallback), NO copilot flags.
        let p = AcpSpawnOpts::for_executor("pi", cwd.clone()).unwrap();
        let prog = p.program.expect("pi resolves a program");
        let name = prog.file_name().unwrap().to_string_lossy();
        assert!(name == "pi-acp" || name == "npx", "got: {name}");
        if name == "npx" {
            assert_eq!(p.extra_args, vec!["-y".to_string(), "pi-acp".to_string()]);
        }
        assert_eq!(p.agent_args, Some(Vec::new()));
        // claude: explicit program (claude-agent-acp or npx fallback),
        // no copilot flags; env stays empty (caller injects config dir).
        let c2 = AcpSpawnOpts::for_executor("claude", cwd.clone()).unwrap();
        let prog = c2.program.expect("claude resolves a program");
        let name = prog.file_name().unwrap().to_string_lossy();
        assert!(name == "claude-agent-acp" || name == "npx", "got: {name}");
        assert_eq!(c2.agent_args, Some(Vec::new()));
        assert!(c2.env.is_empty());
        // unknown: hard error, not a silent copilot fallback.
        assert!(AcpSpawnOpts::for_executor("hermes", cwd).is_err());
    }

    /// Fake agent: answers `initialize` (our id 1), emits one
    /// notification, then a permission request; expects our outcome
    /// answer; exits.
    #[tokio::test]
    async fn correlates_and_answers_permission() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}\n'
printf '{"jsonrpc":"2.0","id":77,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","kind":"execute","rawInput":{"command":"ls"}},"options":[{"optionId":"allow_once","kind":"allow_once"},{"optionId":"reject_once","kind":"reject_once"}]}}\n'
read answer
case "$answer" in *'"id":77'*'allow_once'*) printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"ok"}}}}\n';; esac
"#;
        let seen: Arc<StdMutex<Vec<String>>> = Arc::new(StdMutex::new(Vec::new()));
        let seen2 = seen.clone();
        let resolver: PermissionResolver = Arc::new(move |req| {
            seen2
                .lock()
                .expect("lock")
                .push(req.tool_call.command().unwrap_or("").to_string());
            PermissionDecision::Select("allow_once".to_string())
        });
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");
        let mut events = session.events();

        let init = session
            .request("initialize", serde_json::json!({"protocolVersion": 1}))
            .await
            .expect("initialize");
        assert_eq!(init["protocolVersion"], 1);

        // First notification, then the post-permission one — proving the
        // reader answered id 77 with our resolver's optionId.
        let first = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely")
            .expect("recv");
        let AcpSessionEvent::Update(first) = first else {
            panic!("expected Update, got {first:?}")
        };
        assert_eq!(first.session_id, "s1");
        let second = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely — permission answer never reached the agent")
            .expect("recv");
        let AcpSessionEvent::Update(second) = second else {
            panic!("expected Update, got {second:?}")
        };
        match second.update {
            SessionUpdate::AgentMessageChunk { content } => {
                assert_eq!(content.as_text(), Some("ok"));
            }
            other => panic!("wrong variant: {other:?}"),
        }
        assert_eq!(seen.lock().expect("lock").as_slice(), ["ls"]);
        session.shutdown(Duration::from_secs(2)).await;
    }

    /// Regression for the hang where `request()` issued after `read_loop`
    /// has already exited (child dead, stdout EOF observed, `pending`
    /// cleared) inserted a fresh waiter nobody would ever resolve. The
    /// fake agent exits immediately, so by the time we call `request()`
    /// the reader has long since torn down; the call must fail fast
    /// instead of hanging forever.
    #[tokio::test]
    async fn request_after_reader_exit_does_not_hang() {
        let resolver: PermissionResolver =
            Arc::new(|_| PermissionDecision::Select("reject_once".into()));
        let session = AcpSession::spawn(spawn_opts("exit 0"), resolver)
            .await
            .expect("spawn");

        // Give the reader task a beat to observe stdout EOF and tear down
        // (flip `alive`, clear `pending`) before we race it.
        tokio::time::sleep(Duration::from_millis(200)).await;

        let result = tokio::time::timeout(
            Duration::from_secs(2),
            session.request("initialize", serde_json::json!({})),
        )
        .await
        .expect("request() must not hang once the session is dead");

        assert!(
            matches!(result, Err(AcpError::Closed) | Err(AcpError::ResponseCancelled)),
            "unexpected result: {result:?}"
        );

        session.shutdown(Duration::from_secs(2)).await;
    }

    /// An RPC-level error result rejects the pending request.
    #[tokio::test]
    async fn rpc_error_surfaces() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"error":{"code":-32600,"message":"bad"}}\n'
"#;
        let resolver: PermissionResolver =
            Arc::new(|_| PermissionDecision::Select("reject_once".into()));
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");
        let err = session
            .request("initialize", serde_json::json!({}))
            .await
            .expect_err("should fail");
        assert!(matches!(err, AcpError::Rpc(_)));
        session.shutdown(Duration::from_secs(2)).await;
    }

    /// Garbage lines are logged and skipped, session survives.
    #[tokio::test]
    async fn malformed_line_does_not_kill_reader() {
        let script = r#"printf 'not json\n{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"alive"}}}}\n'"#;
        let resolver: PermissionResolver =
            Arc::new(|_| PermissionDecision::Select("reject_once".into()));
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");
        let mut events = session.events();
        let n = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely")
            .expect("recv");
        let AcpSessionEvent::Update(n) = n else {
            panic!("expected Update, got {n:?}")
        };
        assert!(matches!(n.update, SessionUpdate::AgentMessageChunk { .. }));
        session.shutdown(Duration::from_secs(2)).await;
    }

    /// Defer parks the request; respond_permission answers it with the
    /// chosen option and the agent proceeds.
    #[tokio::test]
    async fn defer_then_respond_permission() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
printf '{"jsonrpc":"2.0","id":88,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","kind":"execute","rawInput":{"command":"git push"}},"options":[{"optionId":"allow_once","kind":"allow_once"},{"optionId":"reject_once","kind":"reject_once"}]}}\n'
read answer
case "$answer" in *'"id":88'*'allow_once'*) printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"granted"}}}}\n';; esac
"#;
        let resolver: PermissionResolver = Arc::new(|_| PermissionDecision::Defer);
        let session = AcpSession::spawn(spawn_opts(script), resolver).await.expect("spawn");
        let mut events = session.events();
        let _ = session.request("initialize", serde_json::json!({})).await.expect("init");

        let pending = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await.expect("timely").expect("recv");
        let AcpSessionEvent::PermissionPending { request_key, request } = pending else {
            panic!("expected PermissionPending, got {pending:?}");
        };
        assert_eq!(request.tool_call.command(), Some("git push"));

        session.respond_permission(&request_key, "allow_once").await.expect("respond");
        let after = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await.expect("timely — answer never reached agent").expect("recv");
        match after {
            AcpSessionEvent::Update(n) => match n.update {
                SessionUpdate::AgentMessageChunk { content } => {
                    assert_eq!(content.as_text(), Some("granted"));
                }
                other => panic!("wrong update: {other:?}"),
            },
            other => panic!("expected Update, got {other:?}"),
        }
        session.shutdown(Duration::from_secs(2)).await;
    }

    /// Empty option_id replies with the ACP "cancelled" outcome shape.
    #[tokio::test]
    async fn empty_option_id_sends_cancelled_outcome() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
printf '{"jsonrpc":"2.0","id":89,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","kind":"execute","rawInput":{"command":"ls"}},"options":[{"optionId":"allow_once","kind":"allow_once"}]}}\n'
read answer
case "$answer" in *'"cancelled"'*) printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"saw-cancel"}}}}\n';; esac
"#;
        let resolver: PermissionResolver = Arc::new(|_| PermissionDecision::Defer);
        let session = AcpSession::spawn(spawn_opts(script), resolver).await.expect("spawn");
        let mut events = session.events();
        let _ = session.request("initialize", serde_json::json!({})).await.expect("init");
        let pending = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await.expect("timely").expect("recv");
        let AcpSessionEvent::PermissionPending { request_key, .. } = pending else { panic!() };
        session.respond_permission(&request_key, "").await.expect("respond");
        let after = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await.expect("timely").expect("recv");
        assert!(matches!(after, AcpSessionEvent::Update(_)));
        session.shutdown(Duration::from_secs(2)).await;
    }

    /// Unknown request_key errors; answering twice errors the second time.
    #[tokio::test]
    async fn respond_permission_unknown_key_errors() {
        let script = r#"read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
sleep 5"#;
        let resolver: PermissionResolver = Arc::new(|_| PermissionDecision::Defer);
        let session = AcpSession::spawn(spawn_opts(script), resolver).await.expect("spawn");
        let _ = session.request("initialize", serde_json::json!({})).await.expect("init");
        let err = session.respond_permission("perm-999", "allow_once").await
            .expect_err("unknown key must error");
        assert!(matches!(err, AcpError::Rpc(_)));
        session.shutdown(Duration::from_secs(2)).await;
    }

    /// Shutdown answers parked requests with cancelled so the agent isn't
    /// left waiting on a dead client.
    ///
    /// Pinned to the wire, not just the parked-map bookkeeping: the fake
    /// agent writes a marker file iff the answer it reads back off stdin
    /// contains `"cancelled"`. A prior version of this test hardcoded the
    /// request key as `"perm-1"` when the counter actually starts at 0
    /// (`"perm-0"`) — it passed even with the flush deleted, because
    /// `respond_permission` on an unknown key already errors regardless.
    /// This version captures the real key off the `PermissionPending`
    /// event, so it fails if the flush loop is ever removed (verified
    /// manually: commenting out the flush block in `shutdown` turns the
    /// marker-file assertion red).
    #[tokio::test]
    async fn shutdown_cancels_parked_permissions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("cancelled-marker");
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
printf '{"jsonrpc":"2.0","id":90,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","kind":"execute","rawInput":{"command":"ls"}},"options":[{"optionId":"allow_once","kind":"allow_once"}]}}\n'
read answer
case "$answer" in *cancelled*) : > "__MARKER__";; esac
"#
        .replace("__MARKER__", &marker.display().to_string());

        let resolver: PermissionResolver = Arc::new(|_| PermissionDecision::Defer);
        let session = AcpSession::spawn(spawn_opts(&script), resolver).await.expect("spawn");
        let mut events = session.events();
        let _ = session.request("initialize", serde_json::json!({})).await.expect("init");
        let pending = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely")
            .expect("recv");
        let AcpSessionEvent::PermissionPending { request_key, .. } = pending else {
            panic!("expected PermissionPending, got {pending:?}");
        };

        // No respond — shutdown must flush the parked request as cancelled.
        session.shutdown(Duration::from_secs(2)).await;

        assert!(
            marker.exists(),
            "shutdown must have written a cancelled reply the fake agent could observe"
        );

        // The flush also drains the map: the same key can't be answered
        // again post-shutdown.
        let err = session
            .respond_permission(&request_key, "allow_once")
            .await
            .expect_err("drained");
        assert!(matches!(err, AcpError::Rpc(_) | AcpError::Closed));
    }

    /// Graceful teardown must be fast for a well-behaved child that exits
    /// on stdin EOF (real copilot's contract): shutdown closes stdin
    /// (writer sentinel → drop) BEFORE waiting on the child, so the child
    /// sees EOF and exits immediately instead of burning the full wait
    /// timeout and getting SIGKILLed.
    #[tokio::test]
    async fn graceful_shutdown_is_fast_for_eof_exiting_child() {
        let script = "while read x; do :; done";
        let resolver: PermissionResolver =
            Arc::new(|_| PermissionDecision::Select("reject_once".into()));
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");

        let start = std::time::Instant::now();
        session.shutdown(Duration::from_secs(5)).await;
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(2),
            "graceful shutdown of an EOF-exiting child took {elapsed:?}; \
             stdin was not closed before child.wait()"
        );
    }

    /// If the agent dies (stdout closes) without ever answering a parked
    /// permission request — no `shutdown()` involved — `read_loop`'s exit
    /// path must drop the parked entry rather than leaving it for a later
    /// `respond_permission` to find and try to write into a dead pipe.
    #[tokio::test]
    async fn parked_permission_dropped_on_reader_exit() {
        // No trailing `read answer`: the script exits right after emitting
        // the permission request, closing stdout before anyone answers —
        // simulating a crash mid-permission-prompt.
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
printf '{"jsonrpc":"2.0","id":91,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","kind":"execute","rawInput":{"command":"ls"}},"options":[{"optionId":"allow_once","kind":"allow_once"}]}}\n'
"#;
        let resolver: PermissionResolver = Arc::new(|_| PermissionDecision::Defer);
        let session = AcpSession::spawn(spawn_opts(script), resolver).await.expect("spawn");
        let mut events = session.events();
        let _ = session.request("initialize", serde_json::json!({})).await.expect("init");
        let pending = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely")
            .expect("recv");
        let AcpSessionEvent::PermissionPending { request_key, .. } = pending else {
            panic!("expected PermissionPending, got {pending:?}");
        };

        // Poll for the reader tearing down (same technique as
        // `request_after_reader_exit_does_not_hang`): once `alive` flips,
        // `request()` fails fast instead of hanging.
        let mut dead = false;
        for _ in 0..50 {
            if session
                .request("ping", serde_json::json!({}))
                .await
                .is_err()
            {
                dead = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert!(dead, "reader never tore down after agent exit");

        let err = session
            .respond_permission(&request_key, "allow_once")
            .await
            .expect_err("parked entry must be dropped on reader exit, not left answerable");
        assert!(matches!(err, AcpError::Rpc(_) | AcpError::Closed));

        session.shutdown(Duration::from_secs(2)).await;
    }

    /// Regression for the unreachable-`SessionDead` finding: `AcpSession`
    /// retains its own `events_tx` clone for its whole lifetime, so
    /// `RecvError::Closed` never fires on a real child crash — a consumer
    /// waiting on it (like the Tauri forwarder) would block forever. The
    /// reader's exit path must instead broadcast an explicit
    /// `AcpSessionEvent::Closed` that every live subscriber actually
    /// receives, in-order, after any updates the child managed to emit.
    #[tokio::test]
    async fn reader_exit_broadcasts_closed() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"bye"}}}}\n'
"#;
        let resolver: PermissionResolver =
            Arc::new(|_| PermissionDecision::Select("reject_once".into()));
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");
        let mut events = session.events();
        let _ = session
            .request("initialize", serde_json::json!({}))
            .await
            .expect("init");

        let first = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely")
            .expect("recv");
        let AcpSessionEvent::Update(first) = first else {
            panic!("expected Update, got {first:?}")
        };
        assert_eq!(first.session_id, "s1");

        // The fake agent exits right after emitting the one update
        // (no trailing `read`), closing stdout — simulating a crash.
        // `read_loop`'s exit path must broadcast `Closed` next.
        let closed = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely — reader exit never broadcast Closed")
            .expect("recv");
        assert!(
            matches!(closed, AcpSessionEvent::Closed),
            "expected Closed, got {closed:?}"
        );

        session.shutdown(Duration::from_secs(2)).await;
    }
}
