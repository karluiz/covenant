//! One-shot headless ACP task: spawn → initialize → session/new →
//! session/prompt → collect updates → shutdown → report. This is the
//! whole A1 surface — the operator's `dispatch_acp` tool is a thin
//! wrapper around [`run_task`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;
use tokio::sync::broadcast;

use super::policy::resolve_headless_with_log;
use super::protocol::{SessionUpdate, ToolCallFields};
use super::session::{
    AcpError, AcpSession, AcpSessionEvent, AcpSpawnOpts, PermissionDecision, PermissionResolver,
};

/// Appended to every headless prompt. The policy auto-denies mutating
/// shell commands, so steer the agent toward its native file tools —
/// otherwise tasks like "create a file" die on `printf > file`.
///
/// This is appended inside [`run_task`] itself, so every caller inherits
/// it implicitly — including the operator's `dispatch_acp` tool, which
/// never sees or controls this string directly.
const HEADLESS_PROMPT_NOTE: &str = "\n\n(Headless session note: shell commands that modify files or state are auto-denied by policy. Use your native file creation/editing tools for any file changes; shell is available for read-only commands only.)";

#[derive(Debug, Clone)]
pub struct AcpRunOpts {
    pub cwd: PathBuf,
    pub prompt: String,
    pub timeout: Duration,
    /// Binary override; None → find `copilot` on PATH.
    pub program: Option<PathBuf>,
    /// Extra args for the child. Only tests use this (to run `sh -c`);
    /// production callers leave it empty.
    pub extra_args_for_tests: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct AcpRunReport {
    /// "end_turn", "timeout", or whatever the agent reported.
    pub stop_reason: String,
    /// Concatenated agent_message_chunk text.
    pub agent_text: String,
    /// One line per finished tool call: `execute `ls` — completed (exit 0)`.
    pub tool_events: Vec<String>,
    /// Execute commands the policy refused.
    pub denied: Vec<String>,
}

#[derive(Default)]
struct Collector {
    text: String,
    /// toolCallId → latest known fields (updates are partial; merge).
    tools: HashMap<String, ToolCallFields>,
    order: Vec<String>,
}

pub async fn run_task(opts: AcpRunOpts) -> Result<AcpRunReport, AcpError> {
    let denied: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let denied_for_resolver = denied.clone();
    let resolver: PermissionResolver = Arc::new(move |req| {
        PermissionDecision::Select(resolve_headless_with_log(req, &denied_for_resolver))
    });

    let session = AcpSession::spawn(
        AcpSpawnOpts {
            cwd: opts.cwd.clone(),
            program: opts.program.clone(),
            extra_args: opts.extra_args_for_tests.clone(),
        },
        resolver,
    )
    .await?;

    let collector: Arc<Mutex<Collector>> = Arc::new(Mutex::new(Collector::default()));
    let collector_task = {
        let collector = collector.clone();
        let mut events = session.events();
        tokio::spawn(async move {
            loop {
                let n = match events.recv().await {
                    Ok(n) => n,
                    // A chatty agent can overflow the 1024-slot broadcast
                    // buffer for this slow-ish consumer. `Lagged` only
                    // means we skipped some frames — the stream is still
                    // live, so keep collecting instead of treating it as
                    // EOF (which used to silently stop all further
                    // collection for the rest of the run).
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        tracing::warn!(skipped, "acp collector lagged; continuing");
                        continue;
                    }
                    // All senders (the session struct's clone and the
                    // reader task's clone) are gone — nothing left to
                    // drain. Exit for real.
                    Err(broadcast::error::RecvError::Closed) => break,
                };
                let n = match n {
                    AcpSessionEvent::Update(n) => n,
                    // Headless never defers (its resolver always answers
                    // synchronously with `PermissionDecision::Select`), so
                    // this is unreachable in practice — ignore it rather
                    // than special-case something that can't happen here.
                    AcpSessionEvent::PermissionPending { .. } => continue,
                    // Reader exited — mirrors the `RecvError::Closed` arm
                    // above (nothing left to drain), but reachable in
                    // practice: `AcpSession` retains its own `events_tx`
                    // clone for the run's lifetime, so `RecvError::Closed`
                    // itself never fires here before `drop(session)` at the
                    // bottom of `run_task`.
                    AcpSessionEvent::Closed => break,
                };
                let mut c = match collector.lock() {
                    Ok(c) => c,
                    Err(_) => break,
                };
                match n.update {
                    SessionUpdate::AgentMessageChunk { content } => {
                        if let Some(t) = content.as_text() {
                            c.text.push_str(t);
                        }
                    }
                    SessionUpdate::ToolCall(f) | SessionUpdate::ToolCallUpdate(f) => {
                        if !c.tools.contains_key(&f.tool_call_id) {
                            c.order.push(f.tool_call_id.clone());
                        }
                        merge_tool(&mut c.tools, f);
                    }
                    _ => {}
                }
            }
        })
    };

    let init = match session
        .request(
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } }
            }),
        )
        .await
    {
        Ok(v) => v,
        // `Closed`/`ResponseCancelled` here mean the child died (or its
        // stdout closed) before ever answering our first request — almost
        // always an old copilot binary that doesn't understand `--acp` and
        // exited after printing an error to stderr. Any later request
        // failing this way means the handshake itself succeeded, so only
        // wrap the very first one.
        Err(e @ (AcpError::Closed | AcpError::ResponseCancelled)) => {
            session.shutdown(Duration::from_secs(3)).await;
            collector_task.abort();
            let tail = session.stderr_tail();
            let tail = if tail.is_empty() {
                "(empty)".to_string()
            } else {
                tail
            };
            return Err(AcpError::Rpc(format!(
                "copilot ACP handshake failed ({e}). stderr: {tail}. Hint: requires GitHub Copilot CLI >= 1.0.68 with ACP support (`copilot --acp`)."
            )));
        }
        // Any other failure (e.g. an `Rpc` error result from the agent)
        // means the process is alive and talking JSON-RPC — nothing to
        // add, propagate as before and let `Drop` (kill_on_drop) clean up
        // the child.
        Err(e) => return Err(e),
    };
    tracing::debug!(agent = ?init.get("agentInfo"), "acp initialize ok");

    let new_sess = session
        .request(
            "session/new",
            serde_json::json!({ "cwd": opts.cwd.to_string_lossy(), "mcpServers": [] }),
        )
        .await?;
    let session_id = new_sess
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();

    let prompt_fut = session.request(
        "session/prompt",
        serde_json::json!({
            "sessionId": session_id,
            "prompt": [{ "type": "text", "text": format!("{}{}", opts.prompt, HEADLESS_PROMPT_NOTE) }]
        }),
    );

    let stop_reason = match tokio::time::timeout(opts.timeout, prompt_fut).await {
        Ok(Ok(result)) => result
            .get("stopReason")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_string(),
        Ok(Err(e)) => {
            // We're discarding the report on this path (returning an
            // Err), so an abrupt abort — vs. the deterministic drain used
            // below — can't lose anything the caller will ever see.
            session.shutdown(Duration::from_secs(3)).await;
            collector_task.abort();
            return Err(e);
        }
        Err(_elapsed) => {
            // Best-effort cancel, then tear down. Partial report is
            // still useful to the operator.
            let _ = session
                .notify(
                    "session/cancel",
                    serde_json::json!({ "sessionId": session_id }),
                )
                .await;
            "timeout".to_string()
        }
    };

    session.shutdown(Duration::from_secs(3)).await;
    // `AcpSession::shutdown` bounds its own wait on the reader task at 1s.
    // In the normal case the reader has already exited by the time we get
    // here, which drops its clone of `events_tx`; the struct's own clone
    // (held in `session`) is the last one standing. Dropping `session`
    // drops that clone too, closing the broadcast channel — the collector
    // then drains anything still buffered (including a final chunk that
    // arrived in the same stdout read as the stopReason response) and
    // exits on its own via `RecvError::Closed`. This is deterministic, not
    // a race: no event queued before this point is ever discarded by an
    // abort mid-drain.
    //
    // If the reader somehow outlives `shutdown`'s 1s bound (child refused
    // to die, or a pathological hang) it still holds an `events_tx` clone,
    // so the channel won't close on `drop(session)` alone. The bounded
    // timeout below is the backstop for that case: it lets the collector
    // finish if the reader closes out shortly after, and otherwise
    // abandons the (still-running, harmless) task rather than hanging
    // `run_task` forever.
    drop(session);
    if tokio::time::timeout(Duration::from_secs(2), collector_task)
        .await
        .is_err()
    {
        tracing::warn!("acp collector task outlived shutdown+drain window; abandoning it");
    }

    let c = collector.lock().map_err(|_| AcpError::Closed)?;
    let denied = denied.lock().map_err(|_| AcpError::Closed)?.clone();
    Ok(AcpRunReport {
        stop_reason,
        agent_text: c.text.clone(),
        tool_events: c.order.iter().filter_map(|id| c.tools.get(id)).map(tool_line).collect(),
        denied,
    })
}

/// Later frames win field-by-field; earlier non-empty values survive
/// partial updates (tool_call_update often omits title/kind).
fn merge_tool(tools: &mut HashMap<String, ToolCallFields>, f: ToolCallFields) {
    match tools.get_mut(&f.tool_call_id) {
        None => {
            tools.insert(f.tool_call_id.clone(), f);
        }
        Some(existing) => {
            if f.title.is_some() {
                existing.title = f.title;
            }
            if f.kind.is_some() {
                existing.kind = f.kind;
            }
            if f.status.is_some() {
                existing.status = f.status;
            }
            if f.raw_input.is_some() {
                existing.raw_input = f.raw_input;
            }
            if f.raw_output.is_some() {
                existing.raw_output = f.raw_output;
            }
            if !f.content.is_empty() {
                existing.content = f.content;
            }
        }
    }
}

fn tool_line(f: &ToolCallFields) -> String {
    let kind = f.kind.as_deref().unwrap_or("tool");
    let what = f
        .command()
        .map(|c| format!("`{c}`"))
        .or_else(|| f.title.clone())
        .unwrap_or_else(|| f.tool_call_id.clone());
    let status = f.status.as_deref().unwrap_or("unknown");
    match f.exit_code() {
        Some(code) => format!("{kind} {what} — {status} (exit {code})"),
        None => format!("{kind} {what} — {status}"),
    }
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;
    use std::time::Duration;

    /// Full happy path against a scripted fake agent. Our request ids
    /// are deterministic (1=initialize, 2=session/new, 3=session/prompt).
    #[tokio::test]
    async fn collects_report_from_fake_agent() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}\n'
read line
case "$line" in
*"Headless session note"*) ;;
*) printf '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"missing_note"}}\n'; exit 0 ;;
esac
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"working on it. "}}}}\n'
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call","toolCallId":"t1","title":"Run ls","kind":"execute","status":"pending","rawInput":{"command":"ls"}}}}\n'
printf '{"jsonrpc":"2.0","id":50,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t1","kind":"execute","rawInput":{"command":"ls"}},"options":[{"optionId":"allow_once","kind":"allow_once"},{"optionId":"reject_once","kind":"reject_once"}]}}\n'
read answer
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"tool_call_update","toolCallId":"t1","status":"completed","rawOutput":{"contents":[{"type":"shell_exit","shellId":"0","exitCode":0}]}}}}\n'
printf '{"jsonrpc":"2.0","id":51,"method":"session/request_permission","params":{"sessionId":"s1","toolCall":{"toolCallId":"t2","kind":"execute","rawInput":{"command":"sudo reboot"}},"options":[{"optionId":"allow_once","kind":"allow_once"},{"optionId":"reject_once","kind":"reject_once"}]}}\n'
read answer2
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"done."}}}}\n'
printf '{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}\n'
"#;
        let report = super::run_task(super::AcpRunOpts {
            cwd: std::env::temp_dir(),
            prompt: "list files".into(),
            timeout: Duration::from_secs(10),
            program: Some(PathBuf::from("sh")),
            extra_args_for_tests: vec!["-c".into(), script.into()],
        })
        .await
        .expect("run ok");

        assert_eq!(report.stop_reason, "end_turn");
        assert_eq!(report.agent_text, "working on it. done.");
        assert_eq!(report.tool_events.len(), 1);
        assert!(report.tool_events[0].contains("execute"));
        assert!(report.tool_events[0].contains("completed"));
        assert!(report.tool_events[0].contains("exit 0"));
        assert_eq!(report.denied, vec!["sudo reboot".to_string()]);
    }

    /// Regression: `run_task` used to tear down the collector with
    /// `collector_task.abort()` right after `session.shutdown()`. Events
    /// that were already sitting in the broadcast channel but not yet
    /// *processed* by the collector task (because the tokio scheduler
    /// hadn't polled it again) could be discarded by that abort — most
    /// visibly the agent's final text chunk when it arrives in the same
    /// stdout read as the stopReason response, with no sleep in between
    /// to let the collector catch up. The fake agent below reproduces
    /// exactly that: a SINGLE `printf` emits three chunks (including one
    /// ~2KB) and the stopReason response back-to-back, then the script
    /// exits immediately — no delay anywhere. The fix (deterministic
    /// drain via `drop(session)` + bounded join) must collect all of it,
    /// every time.
    #[tokio::test]
    async fn final_burst_before_stop_is_not_lost() {
        let big = "x".repeat(2000);
        let script = format!(
            r#"
read line
printf '{{"jsonrpc":"2.0","id":1,"result":{{"protocolVersion":1}}}}\n'
read line
printf '{{"jsonrpc":"2.0","id":2,"result":{{"sessionId":"s1"}}}}\n'
read line
case "$line" in
*"Headless session note"*) ;;
*) printf '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"missing_note"}}}}\n'; exit 0 ;;
esac
printf '%s\n%s\n%s\n%s\n' \
  '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"chunk1 "}}}}}}}}' \
  '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"chunk2 "}}}}}}}}' \
  '{{"jsonrpc":"2.0","method":"session/update","params":{{"sessionId":"s1","update":{{"sessionUpdate":"agent_message_chunk","content":{{"type":"text","text":"{big}"}}}}}}}}' \
  '{{"jsonrpc":"2.0","id":3,"result":{{"stopReason":"end_turn"}}}}'
"#
        );

        let report = super::run_task(super::AcpRunOpts {
            cwd: std::env::temp_dir(),
            prompt: "burst".into(),
            timeout: Duration::from_secs(10),
            program: Some(PathBuf::from("sh")),
            extra_args_for_tests: vec!["-c".into(), script],
        })
        .await
        .expect("run ok");

        assert_eq!(report.stop_reason, "end_turn");
        let expected = format!("chunk1 chunk2 {big}");
        assert_eq!(
            report.agent_text.len(),
            expected.len(),
            "final burst chunk lost or truncated"
        );
        assert_eq!(report.agent_text, expected);
    }

    /// A hung agent hits the timeout and still yields a partial report.
    #[tokio::test]
    async fn timeout_yields_partial_report() {
        let script = r#"
read line
printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n'
read line
printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1"}}\n'
read line
printf '{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"stalling"}}}}\n'
sleep 30
"#;
        let report = super::run_task(super::AcpRunOpts {
            cwd: std::env::temp_dir(),
            prompt: "hang".into(),
            timeout: Duration::from_millis(1500),
            program: Some(PathBuf::from("sh")),
            extra_args_for_tests: vec!["-c".into(), script.into()],
        })
        .await
        .expect("timeout is not an Err");
        assert_eq!(report.stop_reason, "timeout");
        assert_eq!(report.agent_text, "stalling");
    }

    /// A copilot binary too old to understand `--acp` prints its usage
    /// error to stderr and exits before ever answering `initialize`. The
    /// bare `Closed`/`ResponseCancelled` error from that used to be the
    /// only thing surfaced — useless to whoever is staring at it. The
    /// wrapped error must carry the actual stderr text plus a version
    /// hint.
    #[tokio::test]
    async fn handshake_failure_surfaces_stderr() {
        let script = r#"printf "unknown option: --acp\n" >&2; exit 2"#;
        let err = super::run_task(super::AcpRunOpts {
            cwd: std::env::temp_dir(),
            prompt: "hello".into(),
            timeout: Duration::from_secs(10),
            program: Some(PathBuf::from("sh")),
            extra_args_for_tests: vec!["-c".into(), script.into()],
        })
        .await
        .expect_err("an old copilot binary must not silently succeed");

        let msg = err.to_string();
        assert!(
            msg.contains("unknown option: --acp"),
            "error must surface the child's actual stderr, got: {msg}"
        );
        assert!(
            msg.contains("1.0.68"),
            "error must hint the minimum supported copilot version, got: {msg}"
        );
    }

    /// Real copilot end-to-end. Ignored by default: needs an installed,
    /// authenticated copilot >= 1.0.68 on PATH.
    /// Run: cargo test -p karl-agent acp::run::tests::smoke_real_copilot -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "requires installed+authenticated copilot CLI"]
    async fn smoke_real_copilot() {
        let dir = tempfile::tempdir().expect("tempdir");
        let report = super::run_task(super::AcpRunOpts {
            cwd: dir.path().to_path_buf(),
            prompt: "Create a file hello.txt containing exactly the word: covenant".into(),
            timeout: Duration::from_secs(120),
            program: None,
            extra_args_for_tests: vec![],
        })
        .await
        .expect("run ok");
        eprintln!("report: {report:?}");
        assert_eq!(report.stop_reason, "end_turn");
        let content = std::fs::read_to_string(dir.path().join("hello.txt")).expect("file exists");
        assert!(content.contains("covenant"));
    }
}
