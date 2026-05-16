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
use std::time::Duration;

use karl_agent::pi_rpc::{
    parse_session_stats, parse_state, PiCommand, PiSession, PiSessionStats, PiSpawnOpts, PiState,
    StreamingBehavior, ThinkingLevel,
};
use karl_session::SessionId;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::Mutex;
use ulid::Ulid;

use crate::AppState;

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
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(tagged) => {
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
pub async fn pi_abort(
    state: State<'_, AppState>,
    session_id: SessionId,
) -> Result<(), String> {
    let sess = require(&state, &session_id).await?;
    sess.send(&PiCommand::Abort).await.map_err(|e| e.to_string())
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
