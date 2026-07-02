//! One-shot headless ACP task: spawn → initialize → session/new →
//! session/prompt → collect updates → shutdown → report. This is the
//! whole A1 surface — the operator's `dispatch_acp` tool is a thin
//! wrapper around [`run_task`].

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use super::policy::resolve_headless_with_log;
use super::protocol::{SessionUpdate, ToolCallFields};
use super::session::{AcpError, AcpSession, AcpSpawnOpts, PermissionResolver};

/// Appended to every headless prompt. The policy auto-denies mutating
/// shell commands, so steer the agent toward its native file tools —
/// otherwise tasks like "create a file" die on `printf > file`.
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
    let resolver: PermissionResolver =
        Arc::new(move |req| resolve_headless_with_log(req, &denied_for_resolver));

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
            while let Ok(n) = events.recv().await {
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

    let init = session
        .request(
            "initialize",
            serde_json::json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } }
            }),
        )
        .await?;
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
    collector_task.abort();

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
