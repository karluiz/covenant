//! Owns a `copilot --acp` child: single-writer stdin task, reader task
//! that frames stdout JSONL, correlates JSON-RPC responses, answers
//! agent→client requests inline, and broadcasts `session/update`
//! notifications. Mirrors [`crate::pi_rpc::session::PiSession`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde_json::Value;
use thiserror::Error;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::{Child, ChildStdout, Command};
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
    next_id: AtomicI64,
    child: Mutex<Option<Child>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    writer: Mutex<Option<JoinHandle<()>>>,
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
            .stderr(Stdio::null())
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

        let (events_tx, _) = broadcast::channel(EVENT_CHANNEL_CAPACITY);
        let (stdin_tx, stdin_rx) = mpsc::channel::<Vec<u8>>(STDIN_CHANNEL_CAPACITY);
        let pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>> =
            Arc::new(Mutex::new(HashMap::new()));

        let session = Arc::new(Self {
            events_tx: events_tx.clone(),
            stdin_tx: stdin_tx.clone(),
            pending: pending.clone(),
            next_id: AtomicI64::new(1),
            child: Mutex::new(Some(child)),
            reader: Mutex::new(None),
            writer: Mutex::new(None),
        });

        let writer_handle = tokio::spawn(write_loop(stdin, stdin_rx));
        let reader_handle = tokio::spawn(read_loop(
            stdout,
            events_tx,
            pending,
            stdin_tx,
            resolver,
        ));
        *session.writer.lock().await = Some(writer_handle);
        *session.reader.lock().await = Some(reader_handle);

        Ok(session)
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
    }
}

async fn write_loop(mut stdin: tokio::process::ChildStdin, mut rx: mpsc::Receiver<Vec<u8>>) {
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
    // Closing stdin signals end-of-input to the agent.
    drop(stdin);
}

async fn read_loop(
    mut stdout: ChildStdout,
    events_tx: broadcast::Sender<SessionNotification>,
    pending: Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, AcpError>>>>>,
    stdin_tx: mpsc::Sender<Vec<u8>>,
    resolver: PermissionResolver,
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
    // Stdout is gone — no reply can ever arrive. Drop outstanding waiters
    // so in-flight `request()` calls resolve to `ResponseCancelled`
    // instead of hanging forever.
    pending.lock().await.clear();
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
    if stdin_tx.send(bytes).await.is_err() {
        tracing::warn!("acp: failed to send reply — stdin closed");
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
