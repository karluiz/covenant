//! Tauri command surface for Pi RPC executor sessions.
//!
//! Bridge: each [`PiSession`] runs its own broadcast bus internally. When
//! a session is spawned we start a forwarder task that subscribes to that
//! bus and re-emits every event on the Tauri channel `session://{id}/pi`,
//! using the same `SessionId` the rest of the app already uses.
//!
//! Lifecycle:
//!   1. `spawn_pi_session` returns a `SessionId`.
//!   2. Frontend subscribes to `session://{id}/pi`.
//!   3. Subsequent commands take the same `SessionId` to address the
//!      session.
//!   4. `close_pi_session` shuts down the child + forwarder task and
//!      removes the registry entry.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_agent::{
    pi_rpc::{
        parse_session_stats, parse_state, AgentMessage, DeltaEvent, PiCommand, PiEvent, PiSession,
        PiSessionStats, PiSpawnOpts, PiState, StreamingBehavior, ThinkingLevel,
    },
    TokenUsage,
};
use karl_session::{ExecutorPhase, SessionId};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use ulid::Ulid;

use crate::AppState;

/// Map a Pi RPC event onto the notch's `ExecutorPhase` taxonomy. Returns
/// `None` for events that don't change the user-visible phase (e.g. raw
/// text deltas, message boundaries) so the forwarder can skip the hub
/// call entirely.
fn pi_event_to_phase(ev: &PiEvent) -> Option<ExecutorPhase> {
    match ev {
        PiEvent::AgentStart | PiEvent::TurnStart => Some(ExecutorPhase::Thinking),
        PiEvent::ToolExecutionStart {
            tool_name, args, ..
        }
        | PiEvent::ToolExecutionUpdate {
            tool_name, args, ..
        } => Some(tool_to_phase(tool_name, args)),
        PiEvent::ToolExecutionEnd { .. } => Some(ExecutorPhase::Thinking),
        PiEvent::MessageUpdate {
            assistant_message_event,
            ..
        } => match assistant_message_event {
            // Text/thinking deltas do not change the label, but they are
            // important heartbeats for long Pi turns. `NotchHub::set_phase`
            // throttles same-phase emissions, so forwarding them here keeps
            // the sidebar/floating pill alive without turning token streams
            // into a metronome.
            DeltaEvent::TextStart { .. }
            | DeltaEvent::TextDelta { .. }
            | DeltaEvent::ThinkingStart { .. }
            | DeltaEvent::ThinkingDelta { .. } => Some(ExecutorPhase::Thinking),
            _ => None,
        },
        PiEvent::CompactionStart { .. } => Some(ExecutorPhase::Thinking),
        PiEvent::AutoRetryStart { .. } => Some(ExecutorPhase::Waiting {
            reason: "retrying".to_string(),
        }),
        PiEvent::TurnEnd { .. } | PiEvent::AgentEnd { .. } => {
            Some(ExecutorPhase::Done { summary: None })
        }
        PiEvent::ProcessExited { .. } => Some(ExecutorPhase::Idle),
        _ => None,
    }
}

/// Bucket a pi tool name into Reading / Writing / Running. Pi's tool
/// namespace isn't fixed (extensions add tools), so we match on common
/// substrings rather than an exhaustive enum.
fn tool_to_phase(tool_name: &str, args: &Value) -> ExecutorPhase {
    let lname = tool_name.to_ascii_lowercase();
    let target = args
        .get("path")
        .or_else(|| args.get("file"))
        .or_else(|| args.get("filepath"))
        .or_else(|| args.get("file_path"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let is_write = ["write", "edit", "update", "create", "patch", "apply"]
        .iter()
        .any(|k| lname.contains(k));
    let is_read = [
        "read", "grep", "glob", "ls", "list", "search", "find", "view",
    ]
    .iter()
    .any(|k| lname.contains(k));
    if is_write {
        ExecutorPhase::Writing {
            file: target.unwrap_or_else(|| tool_name.to_string()),
        }
    } else if is_read {
        ExecutorPhase::Reading {
            file: target.unwrap_or_else(|| tool_name.to_string()),
        }
    } else {
        let cmd = args
            .get("command")
            .or_else(|| args.get("cmd"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| tool_name.to_string());
        ExecutorPhase::Running { cmd }
    }
}

fn pi_usage_from_value(raw: &Value) -> Option<TokenUsage> {
    let v = raw.get("usage").unwrap_or(raw);
    let get = |keys: &[&str]| -> u32 {
        keys.iter()
            .find_map(|key| v.get(*key).and_then(|n| n.as_u64()))
            .map(|n| n.min(u32::MAX as u64) as u32)
            .unwrap_or(0)
    };
    let usage = TokenUsage {
        input_tokens: get(&[
            "inputTokens",
            "input_tokens",
            "promptTokens",
            "prompt_tokens",
        ]),
        output_tokens: get(&[
            "outputTokens",
            "output_tokens",
            "completionTokens",
            "completion_tokens",
        ]),
        cache_read_input_tokens: get(&[
            "cacheReadInputTokens",
            "cache_read_input_tokens",
            "cacheReadTokens",
            "cachedInputTokens",
        ]),
        cache_creation_input_tokens: get(&[
            "cacheCreationInputTokens",
            "cache_creation_input_tokens",
            "cacheCreationTokens",
        ]),
    };
    if usage.input_tokens == 0
        && usage.output_tokens == 0
        && usage.cache_read_input_tokens == 0
        && usage.cache_creation_input_tokens == 0
    {
        None
    } else {
        Some(usage)
    }
}

fn pi_usage_from_agent_end(messages: &[AgentMessage]) -> Option<(String, TokenUsage)> {
    messages.iter().rev().find_map(|msg| match msg {
        AgentMessage::Assistant(a) => a
            .usage
            .as_ref()
            .and_then(pi_usage_from_value)
            .map(|usage| (a.model.clone().unwrap_or_else(|| "pi".to_string()), usage)),
        _ => None,
    })
}

/// Shared registry of live Pi sessions. Held on [`AppState`].
#[derive(Default)]
pub struct PiRegistry {
    inner: Mutex<HashMap<SessionId, Arc<PiSession>>>,
}

impl PiRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    async fn insert(&self, id: SessionId, sess: Arc<PiSession>) {
        self.inner.lock().await.insert(id, sess);
    }

    async fn get(&self, id: &SessionId) -> Option<Arc<PiSession>> {
        self.inner.lock().await.get(id).cloned()
    }

    async fn remove(&self, id: &SessionId) -> Option<Arc<PiSession>> {
        self.inner.lock().await.remove(id)
    }
}

// ---------------------------------------------------------------------------
// Spawn / close
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPiOpts {
    pub cwd: Option<String>,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub session_dir: Option<String>,
    #[serde(default)]
    pub no_session: bool,
    #[serde(default)]
    pub extra_args: Vec<String>,
    /// Optional binary override — primarily for tests/development setups
    /// where `pi` is not on PATH. Production callers leave this null.
    pub program: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnPiResult {
    pub session_id: SessionId,
}

#[tauri::command]
pub async fn spawn_pi_session(
    app: AppHandle,
    state: State<'_, AppState>,
    opts: SpawnPiOpts,
) -> Result<SpawnPiResult, String> {
    let session_id = SessionId(Ulid::new());

    let spawn_opts = PiSpawnOpts {
        cwd: opts.cwd.map(PathBuf::from),
        provider: opts.provider,
        model: opts.model,
        session_dir: opts.session_dir.map(PathBuf::from),
        no_session: opts.no_session,
        extra_args: opts.extra_args,
        program: opts.program.map(PathBuf::from),
    };

    let sess = PiSession::spawn(session_id.0.to_string(), spawn_opts)
        .await
        .map_err(|e| e.to_string())?;

    // Bridge the per-session broadcast bus to Tauri events. Each forwarder
    // task lives until the broadcast bus closes (which happens when every
    // PiSession Arc holding the Sender is dropped — i.e. when we drop the
    // registry entry on shutdown).
    let mut rx = sess.events();
    let app_for_task = app.clone();
    let topic = format!("session://{}/pi", session_id.0);
    let notch_hub = state.notch_hub.clone();
    let vitals = state.vitals.clone();
    notch_hub
        .register_external(session_id, "pi".to_string())
        .await;
    tokio::spawn(async move {
        let mut vitals_call: Option<crate::vitals::CallHandle> = None;
        let mut vitals_started: Option<Instant> = None;
        loop {
            match rx.recv().await {
                Ok(tagged) => {
                    match &tagged.envelope {
                        PiEvent::AgentStart | PiEvent::TurnStart => {
                            if vitals_call.is_none() {
                                vitals_call =
                                    Some(vitals.record_executor_started(session_id, "pi".to_string()));
                                vitals_started = Some(Instant::now());
                            }
                        }
                        PiEvent::TurnEnd { message, .. } => {
                            if let Some(usage) =
                                message.usage.as_ref().and_then(pi_usage_from_value)
                            {
                                let model =
                                    message.model.clone().unwrap_or_else(|| "pi".to_string());
                                let latency_ms = vitals_started
                                    .take()
                                    .map(|t| t.elapsed().as_millis().min(u32::MAX as u128) as u32)
                                    .unwrap_or(50);
                                // Executor context on its dedicated channel
                                // (kept off the mixed throughput path).
                                let ctx = usage
                                    .input_tokens
                                    .saturating_add(usage.cache_creation_input_tokens)
                                    .saturating_add(usage.cache_read_input_tokens);
                                vitals.record_executor_context(session_id, model.clone(), ctx);
                                if let Some(call) = vitals_call.take() {
                                    call.complete_with_model(model, usage, latency_ms);
                                } else {
                                    vitals.record_executor_complete(session_id, model, usage, latency_ms);
                                }
                            }
                        }
                        PiEvent::AgentEnd { messages } => {
                            if let Some(call) = vitals_call.take() {
                                if let Some((model, usage)) = pi_usage_from_agent_end(messages) {
                                    let latency_ms = vitals_started
                                        .take()
                                        .map(|t| {
                                            t.elapsed().as_millis().min(u32::MAX as u128) as u32
                                        })
                                        .unwrap_or(50);
                                    let ctx = usage
                                        .input_tokens
                                        .saturating_add(usage.cache_creation_input_tokens)
                                        .saturating_add(usage.cache_read_input_tokens);
                                    vitals.record_executor_context(
                                        session_id,
                                        model.clone(),
                                        ctx,
                                    );
                                    call.complete_with_model(model, usage, latency_ms);
                                } else {
                                    vitals_started = None;
                                    call.abandon();
                                }
                            }
                        }
                        PiEvent::ProcessExited { .. } => {
                            vitals_started = None;
                            if let Some(call) = vitals_call.take() {
                                call.abandon();
                            }
                        }
                        _ => {}
                    }
                    if let Some(phase) = pi_event_to_phase(&tagged.envelope) {
                        notch_hub.set_phase(session_id, phase).await;
                    }
                    if let Err(e) = app_for_task.emit(&topic, &tagged.envelope) {
                        tracing::warn!(?e, topic = %topic, "pi event emit failed");
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(skipped = n, topic = %topic, "pi event lag");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
        if let Some(call) = vitals_call.take() {
            call.abandon();
        }
        notch_hub.drop_session(&session_id).await;
    });

    state.pi_sessions.insert(session_id, sess).await;
    Ok(SpawnPiResult { session_id })
}

#[tauri::command]
pub async fn close_pi_session(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<(), String> {
    if let Some(sess) = state.pi_sessions.remove(&session_id).await {
        sess.shutdown(Duration::from_secs(2)).await;
    }
    state.notch_hub.drop_session(&session_id).await;
    Ok(())
}

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pi_send_prompt(
    state: State<'_, AppState>,
    session_id: SessionId,
    text: String,
    streaming_behavior: Option<StreamingBehavior>,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::Prompt {
        id: None,
        message: text,
        streaming_behavior,
        images: None,
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_steer(
    state: State<'_, AppState>,
    session_id: SessionId,
    text: String,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::Steer { message: text })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_follow_up(
    state: State<'_, AppState>,
    session_id: SessionId,
    text: String,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::FollowUp { message: text })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_abort(state: State<'_, AppState>, session_id: SessionId) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::Abort)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_new_session(
    state: State<'_, AppState>,
    session_id: SessionId,
    parent_session: Option<String>,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::NewSession { parent_session })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_set_session_name(
    state: State<'_, AppState>,
    session_id: SessionId,
    name: String,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::SetSessionName { name })
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// State / model
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pi_get_state(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<PiState, String> {
    let sess = require(&state, &session_id).await?;
    let resp = sess
        .send_with_response(PiCommand::GetState { id: None })
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_state(&resp).unwrap_or_default())
}

#[tauri::command]
pub async fn pi_set_model(
    state: State<'_, AppState>,
    session_id: SessionId,
    provider: String,
    model_id: String,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send_with_response(PiCommand::SetModel {
        id: None,
        provider,
        model_id,
    })
    .await
    .map(|_| ())
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_get_available_models(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<Value, String> {
    let sess = require(&state, &session_id).await?;
    let resp = sess
        .send_with_response(PiCommand::GetAvailableModels { id: None })
        .await
        .map_err(|e| e.to_string())?;
    Ok(resp.data.unwrap_or(Value::Null))
}

#[tauri::command]
pub async fn pi_set_thinking_level(
    state: State<'_, AppState>,
    session_id: SessionId,
    level: ThinkingLevel,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::SetThinkingLevel { level })
        .await
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Compaction / session stats
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pi_compact(
    state: State<'_, AppState>,
    session_id: SessionId,
    custom_instructions: Option<String>,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::Compact {
        custom_instructions,
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn pi_get_session_stats(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<PiSessionStats, String> {
    let sess = require(&state, &session_id).await?;
    let resp = sess
        .send_with_response(PiCommand::GetSessionStats { id: None })
        .await
        .map_err(|e| e.to_string())?;
    Ok(parse_session_stats(&resp).unwrap_or_default())
}

// ---------------------------------------------------------------------------
// Extension UI response (PI-7 — wired now so the frontend can answer
// `extension_ui_request` events end-to-end without a follow-up shim).
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn pi_extension_ui_response(
    state: State<'_, AppState>,
    session_id: SessionId,
    request_id: String,
    value: Option<String>,
    confirmed: Option<bool>,
    cancelled: Option<bool>,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::ExtensionUiResponse {
        id: request_id,
        value,
        confirmed,
        cancelled,
    })
    .await
    .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async fn require(state: &State<'_, AppState>, id: &SessionId) -> Result<Arc<PiSession>, String> {
    state
        .pi_sessions
        .get(id)
        .await
        .ok_or_else(|| format!("no pi session: {id:?}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn pi_usage_parser_accepts_camel_case() {
        let usage = pi_usage_from_value(&json!({
            "inputTokens": 10,
            "outputTokens": 4,
            "cacheReadInputTokens": 3,
            "cacheCreationInputTokens": 2
        }))
        .expect("usage");
        assert_eq!(usage.input_tokens, 10);
        assert_eq!(usage.output_tokens, 4);
        assert_eq!(usage.cache_read_input_tokens, 3);
        assert_eq!(usage.cache_creation_input_tokens, 2);
    }

    #[test]
    fn pi_usage_parser_accepts_openai_shape() {
        let usage = pi_usage_from_value(&json!({
            "usage": {
                "prompt_tokens": 20,
                "completion_tokens": 5
            }
        }))
        .expect("usage");
        assert_eq!(usage.input_tokens, 20);
        assert_eq!(usage.output_tokens, 5);
    }

    #[test]
    fn pi_text_delta_keeps_notch_alive_as_thinking() {
        let ev = PiEvent::MessageUpdate {
            message: AgentMessage::Assistant(karl_agent::pi_rpc::AssistantMessage {
                content: vec![],
                model: None,
                stop_reason: None,
                usage: None,
                timestamp: None,
            }),
            assistant_message_event: DeltaEvent::TextDelta {
                content_index: 0,
                delta: "hello".into(),
                partial: None,
            },
        };
        assert!(matches!(
            pi_event_to_phase(&ev),
            Some(ExecutorPhase::Thinking)
        ));
    }

    #[test]
    fn pi_tool_update_repeats_tool_phase_for_heartbeat() {
        let ev = PiEvent::ToolExecutionUpdate {
            tool_call_id: "call_1".into(),
            tool_name: "bash".into(),
            args: json!({ "command": "cargo test" }),
            partial_result: json!({ "content": [] }),
        };
        assert!(matches!(
            pi_event_to_phase(&ev),
            Some(ExecutorPhase::Running { cmd }) if cmd == "cargo test"
        ));
    }
}
