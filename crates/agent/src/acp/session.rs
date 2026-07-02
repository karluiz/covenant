//! Owns a `copilot --acp` child: single-writer stdin task, reader task
//! that frames stdout JSONL, correlates JSON-RPC responses, answers
//! agent→client requests inline, and broadcasts `session/update`
//! notifications. Mirrors [`crate::pi_rpc::session::PiSession`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
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
}

/// Answers `session/request_permission` synchronously with an optionId.
pub type PermissionResolver = Arc<dyn Fn(&PermissionRequest) -> String + Send + Sync>;

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
    events_tx: broadcast::Sender<SessionNotification>,
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
        for a in &opts.extra_args {
            cmd.arg(a);
        }
        cmd.arg("--acp").arg("--add-dir").arg(&opts.cwd);
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
        });

        let writer_handle = tokio::spawn(write_loop(stdin, stdin_rx, alive.clone()));
        let reader_handle = tokio::spawn(read_loop(
            stdout,
            events_tx,
            pending,
            stdin_tx,
            resolver,
            alive,
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
    pub fn events(&self) -> broadcast::Receiver<SessionNotification> {
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
        self.stdin_tx
            .send(line)
            .await
            .map_err(|_| AcpError::Closed)
    }

    /// Graceful shutdown: close stdin, wait for the child up to `timeout`,
    /// then SIGKILL if it hasn't exited. There is no abort command in ACP.
    pub async fn shutdown(&self, timeout: Duration) {
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

async fn read_loop(
    mut stdout: ChildStdout,
    events_tx: broadcast::Sender<SessionNotification>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>>,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    resolver: PermissionResolver,
    alive: Arc<AtomicBool>,
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
            handle_line(line, &events_tx, &pending, &stdin_tx, &resolver).await;
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
    tracing::debug!("acp reader exiting");
}

async fn handle_line(
    line: Vec<u8>,
    events_tx: &broadcast::Sender<SessionNotification>,
    pending: &Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>>,
    stdin_tx: &mpsc::Sender<Vec<u8>>,
    resolver: &PermissionResolver,
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
            handle_agent_request(frame, stdin_tx, resolver).await;
        }
        FrameKind::Notification => {
            if frame.method.as_deref() == Some("session/update") {
                let Some(params) = frame.params else {
                    tracing::warn!("acp: session/update without params, dropping");
                    return;
                };
                match serde_json::from_value::<SessionNotification>(params) {
                    Ok(n) => {
                        let _ = events_tx.send(n);
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
            Some(req) => {
                let option_id = resolver(&req);
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "result": { "outcome": { "outcome": "selected", "optionId": option_id } },
                })
            }
            None => {
                tracing::warn!("acp: session/request_permission params failed to parse");
                serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": id,
                    "error": { "code": -32602, "message": "invalid params" },
                })
            }
        }
    } else {
        serde_json::json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": { "code": -32601, "message": "not supported by this client" },
        })
    };

    let Ok(mut bytes) = serde_json::to_vec(&reply) else {
        tracing::warn!("acp: failed to serialize reply frame");
        return;
    };
    bytes.push(b'\n');

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
        }
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
            "allow_once".to_string()
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
        assert_eq!(first.session_id, "s1");
        let second = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely — permission answer never reached the agent")
            .expect("recv");
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
        let resolver: PermissionResolver = Arc::new(|_| "reject_once".into());
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
        let resolver: PermissionResolver = Arc::new(|_| "reject_once".into());
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
        let resolver: PermissionResolver = Arc::new(|_| "reject_once".into());
        let session = AcpSession::spawn(spawn_opts(script), resolver)
            .await
            .expect("spawn");
        let mut events = session.events();
        let n = tokio::time::timeout(Duration::from_secs(3), events.recv())
            .await
            .expect("timely")
            .expect("recv");
        assert!(matches!(n.update, SessionUpdate::AgentMessageChunk { .. }));
        session.shutdown(Duration::from_secs(2)).await;
    }
}
