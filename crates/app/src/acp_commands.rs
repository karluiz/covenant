//! Tauri command surface for interactive ACP (Agent Client Protocol,
//! `copilot --acp`) sessions.
//!
//! Bridge: each [`AcpSession`] runs its own broadcast bus internally. When
//! a session is spawned we start a forwarder task that subscribes to that
//! bus and re-emits every event on the Tauri channel
//! `session://{id}/acp`, using the same [`SessionId`] the rest of the app
//! already uses. Mirrors [`crate::pi_commands`].
//!
//! Lifecycle:
//!   1. `spawn_acp_session` returns a string-encoded [`SessionId`].
//!   2. Frontend subscribes to `session://{id}/acp`.
//!   3. Subsequent commands take the same session id (as a string) to
//!      address the session.
//!   4. `close_acp_session` shuts down the child + forwarder task and
//!      removes the registry entry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use karl_agent::acp::{
    policy::resolve_headless,
    protocol::{
        ContentBlock, PermissionRequest, SessionNotification, SessionUpdate, ToolCallFields,
    },
    AcpError, AcpSession, AcpSessionEvent, AcpSpawnOpts, PermissionDecision, PermissionResolver,
};
use karl_session::{ExecutorPhase, SessionId};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;

use crate::AppState;

// ---------------------------------------------------------------------------
// Phase mapping
// ---------------------------------------------------------------------------

/// Map an ACP session event onto the notch's `ExecutorPhase` taxonomy.
/// Returns `None` for events that don't change the user-visible phase
/// (e.g. an unrecognized `session/update` kind) so the forwarder can skip
/// the hub call entirely.
pub(crate) fn acp_event_to_phase(ev: &AcpSessionEvent) -> Option<ExecutorPhase> {
    match ev {
        AcpSessionEvent::Update(n) => match &n.update {
            SessionUpdate::ToolCall(f) | SessionUpdate::ToolCallUpdate(f) => {
                Some(tool_call_phase(f))
            }
            SessionUpdate::AgentMessageChunk { .. } | SessionUpdate::AgentThoughtChunk { .. } => {
                Some(ExecutorPhase::Thinking)
            }
            SessionUpdate::Unknown => None,
        },
        AcpSessionEvent::PermissionPending { .. } => Some(ExecutorPhase::Waiting {
            reason: "permission".to_string(),
        }),
        // Terminal — the forwarder handles this before it ever reaches
        // `acp_event_to_phase` (see the loop in `spawn_acp_session`), but
        // stay exhaustive rather than wildcard so a future variant can't
        // silently fall through un-mapped.
        AcpSessionEvent::Closed => None,
    }
}

/// Bucket a tool call into Writing / Running / Reading by its `kind`.
/// Any other (or missing) kind is treated as a heartbeat, not a distinct
/// phase — same rationale as pi's tool-update heartbeats.
fn tool_call_phase(f: &ToolCallFields) -> ExecutorPhase {
    match f.kind.as_deref() {
        Some("edit") => ExecutorPhase::Writing {
            file: tool_call_target(f),
        },
        Some("execute") => ExecutorPhase::Running {
            cmd: f.command().unwrap_or("command").to_string(),
        },
        Some("read") => ExecutorPhase::Reading {
            file: tool_call_target(f),
        },
        _ => ExecutorPhase::Thinking,
    }
}

/// Best-effort file target for an edit/read tool call: the diff path from
/// streamed content, else `rawInput.fileName`, else a placeholder.
fn tool_call_target(f: &ToolCallFields) -> String {
    f.content
        .iter()
        .find_map(|c| match c {
            ContentBlock::Diff { path, .. } => Some(path.clone()),
            _ => None,
        })
        .or_else(|| {
            f.raw_input
                .as_ref()
                .and_then(|v| v.get("fileName"))
                .and_then(Value::as_str)
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "file".to_string())
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/// A live interactive ACP session plus the bits the command layer needs
/// beyond what `AcpSession` itself tracks.
struct AcpTabSession {
    session: Arc<AcpSession>,
    /// The wire-level `sessionId` returned by `session/new` — distinct
    /// from our own [`SessionId`] registry key.
    acp_session_id: String,
    /// Guards against overlapping `session/prompt` calls on the same
    /// session (ACP has no queueing of its own).
    in_flight: AtomicBool,
}

/// Shared registry of live interactive ACP sessions. Held on [`AppState`].
///
/// `inner` is `Arc`-wrapped (unlike a bare `Mutex<HashMap<..>>>`) so a
/// cheap [`Clone`] of the whole registry can be moved into the forwarder
/// task spawned by [`spawn_acp_session`] — the same shape as
/// `state.notch_hub: Arc<NotchHub>` — letting that task remove its own
/// entry on session death without borrowing from a short-lived
/// `State<'_, AppState>`.
#[derive(Default, Clone)]
pub struct AcpRegistry {
    inner: Arc<Mutex<HashMap<SessionId, Arc<AcpTabSession>>>>,
}

impl AcpRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    async fn insert(&self, id: SessionId, sess: Arc<AcpTabSession>) {
        self.inner.lock().await.insert(id, sess);
    }

    async fn get(&self, id: &SessionId) -> Option<Arc<AcpTabSession>> {
        self.inner.lock().await.get(id).cloned()
    }

    async fn remove(&self, id: &SessionId) -> Option<Arc<AcpTabSession>> {
        self.inner.lock().await.remove(id)
    }
}

// ---------------------------------------------------------------------------
// Frontend event payload
// ---------------------------------------------------------------------------

/// Payload emitted on `session://{id}/acp`. Tagged so the frontend can
/// dispatch on `type`; field names are camelCase to match the rest of the
/// Tauri event surface.
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AcpTabEvent {
    /// Raw `session/update` notification, typed end-to-end (see the
    /// `Serialize` derives added to `protocol.rs`).
    Update { update: SessionNotification },
    #[serde(rename_all = "camelCase")]
    PermissionPending {
        request_key: String,
        request: PermissionRequest,
    },
    #[serde(rename_all = "camelCase")]
    PromptDone { stop_reason: String },
    SessionDead,
}

// ---------------------------------------------------------------------------
// Spawn / close
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAcpOpts {
    pub cwd: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnAcpResult {
    pub session_id: String,
    /// Current model id reported by `session/new` (`models.currentModelId`),
    /// e.g. "claude-sonnet-4.6". Best-effort — None if the wire omits it.
    pub model: Option<String>,
}

/// Hybrid resolver: policy-approved requests are silently granted;
/// everything else is deferred to the user via `PermissionPending`.
fn hybrid_resolver() -> PermissionResolver {
    Arc::new(|req| {
        let choice = resolve_headless(req);
        let allows = req
            .options
            .iter()
            .any(|o| o.option_id == choice && o.kind.to_ascii_lowercase().contains("allow"));
        if allows {
            PermissionDecision::Select(choice)
        } else {
            PermissionDecision::Defer
        }
    })
}

#[tauri::command]
pub async fn spawn_acp_session(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: SpawnAcpOpts,
) -> Result<SpawnAcpResult, String> {
    let session_id = SessionId::new();

    let cwd = opts
        .cwd
        .map(PathBuf::from)
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."));

    let session = AcpSession::spawn(
        AcpSpawnOpts {
            cwd: cwd.clone(),
            program: None,
            extra_args: Vec::new(),
        },
        hybrid_resolver(),
    )
    .await
    .map_err(|e| e.to_string())?;

    match session
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": { "fs": { "readTextFile": false, "writeTextFile": false } }
            }),
        )
        .await
    {
        Ok(_) => {}
        // Closed/ResponseCancelled here mean the child died (or its
        // stdout closed) before ever answering our first request —
        // almost always an old copilot binary that doesn't understand
        // `--acp`. Surface the stderr tail so the user sees why.
        Err(e @ (AcpError::Closed | AcpError::ResponseCancelled)) => {
            session.shutdown(Duration::from_secs(3)).await;
            let tail = session.stderr_tail();
            let tail = if tail.is_empty() {
                "(empty)".to_string()
            } else {
                tail
            };
            return Err(format!(
                "copilot ACP handshake failed ({e}). stderr: {tail}. Hint: requires GitHub Copilot CLI >= 1.0.68 with ACP support (`copilot --acp`)."
            ));
        }
        Err(e) => {
            session.shutdown(Duration::from_secs(3)).await;
            return Err(e.to_string());
        }
    }

    let new_sess = match session
        .request(
            "session/new",
            json!({ "cwd": cwd.to_string_lossy(), "mcpServers": [] }),
        )
        .await
    {
        Ok(v) => v,
        Err(e) => {
            session.shutdown(Duration::from_secs(3)).await;
            return Err(e.to_string());
        }
    };
    let acp_session_id = new_sess
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    if acp_session_id.is_empty() {
        session.shutdown(Duration::from_secs(3)).await;
        return Err("acp: session/new did not return a sessionId".to_string());
    }
    let model = new_sess
        .get("models")
        .and_then(|m| m.get("currentModelId"))
        .and_then(Value::as_str)
        .map(str::to_string);

    let tab_session = Arc::new(AcpTabSession {
        session: session.clone(),
        acp_session_id,
        in_flight: AtomicBool::new(false),
    });

    // Registration must happen before the forwarder starts, or the first
    // events racing the forwarder's spawn can arrive at a hub with no
    // entry for this session and be silently dropped (see notch.rs
    // `register_external`/`set_phase`).
    let notch_hub = state.notch_hub.clone();
    notch_hub
        .register_external(session_id, "copilot".to_string())
        .await;

    let mut rx = session.events();
    let app_for_task = app.clone();
    let notch_hub_task = notch_hub.clone();
    let registry_task = state.acp_sessions.clone();
    let topic = format!("session://{session_id}/acp");
    let topic_for_task = topic.clone();
    tokio::spawn(async move {
        // Shared teardown for both liveness signals below: the explicit
        // `AcpSessionEvent::Closed` broadcast by `read_loop` on a real
        // child exit (the reachable path — see the doc on that variant),
        // and `RecvError::Closed` (only reachable once this task's `Arc<
        // AcpSession>` clone — held indirectly via the registry entry —
        // is also dropped, e.g. by a `close_acp_session` race). Either
        // way: tell the frontend, drop the notch entry, and remove
        // ourselves from the registry so a later `close_acp_session` on
        // this id is a no-op instead of double-shutting-down a dead
        // session.
        async fn on_dead(
            app: &AppHandle,
            topic: &str,
            notch_hub: &Arc<crate::notch::NotchHub>,
            registry: &AcpRegistry,
            session_id: SessionId,
        ) {
            if let Err(e) = app.emit(topic, &AcpTabEvent::SessionDead) {
                tracing::warn!(?e, topic, "acp session-dead emit failed");
            }
            notch_hub.drop_session(&session_id).await;
            registry.remove(&session_id).await;
        }

        loop {
            let ev = match rx.recv().await {
                Ok(ev) => ev,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, topic = %topic_for_task, "acp event lag");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    on_dead(
                        &app_for_task,
                        &topic_for_task,
                        &notch_hub_task,
                        &registry_task,
                        session_id,
                    )
                    .await;
                    break;
                }
            };
            if let Some(phase) = acp_event_to_phase(&ev) {
                notch_hub_task.set_phase(session_id, phase).await;
            }
            let payload = match ev {
                AcpSessionEvent::Update(n) => AcpTabEvent::Update { update: n },
                AcpSessionEvent::PermissionPending {
                    request_key,
                    request,
                } => AcpTabEvent::PermissionPending {
                    request_key,
                    request,
                },
                AcpSessionEvent::Closed => {
                    on_dead(
                        &app_for_task,
                        &topic_for_task,
                        &notch_hub_task,
                        &registry_task,
                        session_id,
                    )
                    .await;
                    break;
                }
            };
            if let Err(e) = app_for_task.emit(&topic_for_task, &payload) {
                tracing::warn!(?e, topic = %topic_for_task, "acp event emit failed");
            }
        }
    });

    state.acp_sessions.insert(session_id, tab_session).await;
    Ok(SpawnAcpResult {
        session_id: session_id.to_string(),
        model,
    })
}

/// Idempotent by construction: `remove` on an id the forwarder task
/// already reaped (child died → `AcpSessionEvent::Closed` →
/// `on_dead`'s `registry.remove`, see `spawn_acp_session`) returns `None`
/// and we just skip the shutdown — no error. This matters for
/// `AcpChatView.restart()` on the frontend: by the time the user sees the
/// "Restart session" control the old session is already dead (that's why
/// the notice showed up), so the forwarder has typically already removed
/// it from the registry before `restart()` ever gets a chance to call
/// `close_acp_session` on the old id — and even if it raced ahead of the
/// forwarder, this being a silent no-op keeps that race harmless.
#[tauri::command]
pub async fn close_acp_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    let id = parse_session_id(&session_id)?;
    if let Some(tab) = state.acp_sessions.remove(&id).await {
        tab.session.shutdown(Duration::from_secs(2)).await;
    }
    state.notch_hub.drop_session(&id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn acp_send_prompt(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: String,
) -> Result<(), String> {
    let (id, tab) = require(&state, &session_id).await?;

    if tab.in_flight.swap(true, Ordering::AcqRel) {
        return Err("acp: prompt already in flight".to_string());
    }

    let topic = format!("session://{id}/acp");
    let notch_hub = state.notch_hub.clone();
    let acp_session_id = tab.acp_session_id.clone();
    let session = tab.session.clone();
    let tab_for_flag = tab.clone();
    tokio::spawn(async move {
        let result = session
            .request(
                "session/prompt",
                json!({
                    "sessionId": acp_session_id,
                    "prompt": [{ "type": "text", "text": text }]
                }),
            )
            .await;
        let stop_reason = match result {
            Ok(v) => v
                .get("stopReason")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
            Err(e) => e.to_string(),
        };
        tab_for_flag.in_flight.store(false, Ordering::Release);
        notch_hub
            .set_phase(
                id,
                ExecutorPhase::Done {
                    summary: Some(stop_reason.clone()),
                },
            )
            .await;
        if let Err(e) = app.emit(&topic, &AcpTabEvent::PromptDone { stop_reason }) {
            tracing::warn!(?e, topic = %topic, "acp prompt-done emit failed");
        }
    });

    Ok(())
}

#[tauri::command]
pub async fn acp_respond_permission(
    state: State<'_, AppState>,
    session_id: String,
    request_key: String,
    option_id: String,
) -> Result<(), String> {
    let (_, tab) = require(&state, &session_id).await?;
    tab.session
        .respond_permission(&request_key, &option_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn acp_cancel(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    let (_, tab) = require(&state, &session_id).await?;
    tab.session
        .notify(
            "session/cancel",
            json!({ "sessionId": tab.acp_session_id }),
        )
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_session_id(session_id: &str) -> Result<SessionId, String> {
    session_id
        .parse::<SessionId>()
        .map_err(|e| format!("invalid acp session id {session_id:?}: {e}"))
}

async fn require(
    state: &State<'_, AppState>,
    session_id: &str,
) -> Result<(SessionId, Arc<AcpTabSession>), String> {
    let id = parse_session_id(session_id)?;
    let tab = state
        .acp_sessions
        .get(&id)
        .await
        .ok_or_else(|| format!("no acp session: {session_id}"))?;
    Ok((id, tab))
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_agent::acp::protocol::{PermissionRequest, ToolCallFields};

    fn notification(update_json: &str) -> SessionNotification {
        let raw = format!(r#"{{"sessionId":"s1","update":{update_json}}}"#);
        serde_json::from_str(&raw).expect("notification fixture parses")
    }

    #[test]
    fn edit_tool_call_maps_to_writing_with_diff_path() {
        let n = notification(
            r#"{"sessionUpdate":"tool_call","toolCallId":"t1","kind":"edit","content":[{"type":"diff","path":"/w/fib.py","newText":"x"}]}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Writing { file }) if file == "/w/fib.py"
        ));
    }

    #[test]
    fn edit_tool_call_falls_back_to_raw_input_file_name() {
        let n = notification(
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t1","kind":"edit","rawInput":{"fileName":"src/main.rs"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Writing { file }) if file == "src/main.rs"
        ));
    }

    #[test]
    fn execute_tool_call_maps_to_running_with_command() {
        let n = notification(
            r#"{"sessionUpdate":"tool_call","toolCallId":"t1","kind":"execute","rawInput":{"command":"cargo test"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Running { cmd }) if cmd == "cargo test"
        ));
    }

    #[test]
    fn read_tool_call_maps_to_reading() {
        let n = notification(
            r#"{"sessionUpdate":"tool_call_update","toolCallId":"t1","kind":"read","rawInput":{"fileName":"README.md"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Reading { file }) if file == "README.md"
        ));
    }

    #[test]
    fn message_chunk_maps_to_thinking() {
        let n = notification(
            r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Thinking)
        ));
    }

    #[test]
    fn thought_chunk_maps_to_thinking() {
        let n = notification(
            r#"{"sessionUpdate":"agent_thought_chunk","content":{"type":"text","text":"hmm"}}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Thinking)
        ));
    }

    #[test]
    fn unknown_update_kind_maps_to_none() {
        let n = notification(
            r#"{"sessionUpdate":"available_commands_update","availableCommands":[]}"#,
        );
        let ev = AcpSessionEvent::Update(n);
        assert_eq!(acp_event_to_phase(&ev), None);
    }

    #[test]
    fn permission_pending_maps_to_waiting() {
        let req: PermissionRequest = serde_json::from_value(json!({
            "sessionId": "s1",
            "toolCall": { "toolCallId": "t1", "kind": "execute", "rawInput": { "command": "ls" } },
            "options": [{ "optionId": "allow_once", "kind": "allow_once" }]
        }))
        .expect("permission fixture parses");
        let ev = AcpSessionEvent::PermissionPending {
            request_key: "perm-0".into(),
            request: req,
        };
        assert!(matches!(
            acp_event_to_phase(&ev),
            Some(ExecutorPhase::Waiting { reason }) if reason == "permission"
        ));
    }

    /// Pins the frontend contract (`ui/src/api.ts` `AcpTabEvent`): exact
    /// JSON shape for every variant — snake_case `type` tag, camelCase
    /// field names. If this test needs to change, `ui/src/api.ts` needs a
    /// matching change.
    #[test]
    fn acp_tab_event_wire_shape() {
        let prompt_done = AcpTabEvent::PromptDone {
            stop_reason: "end_turn".to_string(),
        };
        assert_eq!(
            serde_json::to_value(&prompt_done).expect("serialize"),
            json!({ "type": "prompt_done", "stopReason": "end_turn" })
        );

        let session_dead = AcpTabEvent::SessionDead;
        assert_eq!(
            serde_json::to_value(&session_dead).expect("serialize"),
            json!({ "type": "session_dead" })
        );

        let update = AcpTabEvent::Update {
            update: notification(
                r#"{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}"#,
            ),
        };
        let update_value = serde_json::to_value(&update).expect("serialize");
        assert_eq!(update_value["type"], "update");
        assert_eq!(update_value["update"]["sessionId"], "s1");
        assert_eq!(
            update_value["update"]["update"]["sessionUpdate"],
            "agent_message_chunk"
        );

        let permission_pending = AcpTabEvent::PermissionPending {
            request_key: "perm-0".to_string(),
            request: serde_json::from_value(json!({
                "sessionId": "s1",
                "toolCall": { "toolCallId": "t1", "kind": "execute", "rawInput": { "command": "ls" } },
                "options": [{ "optionId": "allow_once", "kind": "allow_once" }]
            }))
            .expect("permission fixture parses"),
        };
        let permission_value = serde_json::to_value(&permission_pending).expect("serialize");
        assert_eq!(permission_value["type"], "permission_pending");
        assert_eq!(permission_value["requestKey"], "perm-0");
        assert_eq!(permission_value["request"]["sessionId"], "s1");
    }

    /// `SessionUpdate` must survive Serialize → Deserialize with its
    /// internal tag intact, proving the `Serialize` derives added
    /// alongside the existing `Deserialize` ones in `protocol.rs` don't
    /// disturb the wire shape (`#[serde(other)] Unknown` in particular).
    #[test]
    fn session_update_serde_round_trip_preserves_tag() {
        let original = SessionUpdate::ToolCall(ToolCallFields {
            tool_call_id: "t1".into(),
            title: Some("Run fib.py".into()),
            kind: Some("execute".into()),
            status: Some("pending".into()),
            raw_input: Some(json!({ "command": "ls" })),
            raw_output: None,
            content: vec![],
        });

        let value = serde_json::to_value(&original).expect("serialize");
        assert_eq!(value["sessionUpdate"], "tool_call");
        assert_eq!(value["toolCallId"], "t1");

        let round_tripped: SessionUpdate = serde_json::from_value(value).expect("deserialize");
        match round_tripped {
            SessionUpdate::ToolCall(f) => {
                assert_eq!(f.tool_call_id, "t1");
                assert_eq!(f.kind.as_deref(), Some("execute"));
                assert_eq!(f.command(), Some("ls"));
            }
            other => panic!("wrong variant after round-trip: {other:?}"),
        }
    }
}
