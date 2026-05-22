//! Tauri commands for the teammate UI.

use std::sync::Arc;

use tauri::State;

use crate::operator_registry::OperatorId;
use crate::storage::Storage;
use crate::teammate::types::{MessageContent, MessageId, Role, TaskMessage};

#[tauri::command]
pub async fn teammate_list_messages_for_operator(
    storage: State<'_, Arc<Storage>>,
    operator_id: OperatorId,
    limit: Option<usize>,
) -> Result<Vec<TaskMessage>, String> {
    storage
        .teammate_list_messages(operator_id, limit.unwrap_or(200))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_send_text_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    storage: tauri::State<'_, std::sync::Arc<crate::storage::Storage>>,
    registry: tauri::State<'_, std::sync::Arc<crate::operator_registry::OperatorRegistry>>,
    operator_id: crate::operator_registry::OperatorId,
    text: String,
    active_session_id: Option<String>,
) -> Result<crate::teammate::TaskMessage, String> {
    use crate::teammate::types::{MessageContent, MessageId, Role as TmRole, TaskMessage};
    use tauri::Emitter;

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    // 1) Persist the user message immediately.
    let user_msg = TaskMessage {
        id: MessageId::new(),
        operator_id,
        task_id: None,
        role: TmRole::User,
        content: MessageContent::Text(text),
        created_at_unix_ms: now_ms(),
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
    };
    storage
        .teammate_insert_message(&user_msg)
        .await
        .map_err(|e| e.to_string())?;

    // 2) Snapshot the open sessions' world arcs while we hold the
    //    sessions lock, then drop it before locking individual worlds.
    let session_worlds: Vec<(karl_session::SessionId, std::sync::Arc<tokio::sync::Mutex<crate::world::SessionWorldModel>>)> = {
        let g = state.sessions.lock().await;
        g.iter().map(|(id, m)| (*id, m.world.clone())).collect()
    };

    let active_session_id_parsed: Option<karl_session::SessionId> = active_session_id
        .as_deref()
        .and_then(|s| s.parse::<karl_session::SessionId>().ok());

    let storage_bg = storage.inner().clone();
    let registry_bg = registry.inner().clone();
    let settings_bg = state.settings.clone();
    let app_bg = app.clone();
    tokio::spawn(async move {
        let operator = match registry_bg.get(operator_id) {
            Some(op) => op,
            None => {
                tracing::warn!(?operator_id, "teammate: dispatch skipped — operator not found");
                return;
            }
        };
        let thread = match storage_bg.teammate_list_messages(operator_id, 200).await {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, "teammate: failed to load thread");
                return;
            }
        };

        // Build snapshot per session under each world's own lock.
        let mut snapshots = Vec::with_capacity(session_worlds.len());
        for (sid, world_arc) in session_worlds {
            let w = world_arc.lock().await;
            let is_active = Some(sid) == active_session_id_parsed;
            snapshots.push(crate::teammate::world_snapshot::project(
                sid, &*w, is_active, now_ms(),
            ));
        }
        let world_context_str = crate::teammate::world_snapshot::render(&snapshots);
        let world_context_opt: Option<&str> = if snapshots.is_empty() {
            None
        } else {
            Some(world_context_str.as_str())
        };

        let settings = settings_bg.lock().await.clone();

        // Find the cwd of the marked-active session, if any. The tool
        // sandbox roots into that directory. If no cwd is known (no active
        // session id, or cwd not captured yet) we fall back to the no-tool
        // dispatch so the operator can still answer.
        let active_cwd: Option<std::path::PathBuf> = if let Some(active_id) = active_session_id_parsed {
            snapshots.iter().find(|s| s.id == active_id).and_then(|s| {
                let raw = std::path::PathBuf::from(&s.cwd);
                if raw.as_os_str().is_empty() {
                    None
                } else {
                    raw.canonicalize().ok()
                }
            })
        } else {
            None
        };

        let reply_text = if let Some(root) = active_cwd {
            let tool_env = crate::teammate::tools::ToolEnv::new(root, 200 * 1024);
            let app_for_progress = app_bg.clone();
            let op_id_for_progress = operator_id;
            let progress = move |p: crate::teammate::llm::ToolProgress| {
                let payload = serde_json::json!({
                    "operator_id": op_id_for_progress,
                    "progress": p,
                });
                let _ = app_for_progress.emit("teammate-tool-call", payload);
            };
            match crate::teammate::llm::dispatch_reply_with_tools(
                &operator, &thread, &settings, world_context_opt, tool_env, progress,
            ).await {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(error = %e, "teammate: tool-use dispatch failed");
                    emit_system_error(&app_bg, &storage_bg, operator_id, &format!("{e}")).await;
                    return;
                }
            }
        } else {
            match crate::teammate::llm::dispatch_reply(
                &operator, &thread, &settings, world_context_opt,
            ).await {
                Ok(t) => t,
                Err(e) => {
                    tracing::warn!(error = %e, "teammate: dispatch failed");
                    emit_system_error(&app_bg, &storage_bg, operator_id, &format!("{e}")).await;
                    return;
                }
            }
        };
        let reply_msg = TaskMessage {
            id: MessageId::new(),
            operator_id,
            task_id: None,
            role: TmRole::Operator,
            content: MessageContent::Text(reply_text),
            created_at_unix_ms: now_ms(),
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
        };
        if let Err(e) = storage_bg.teammate_insert_message(&reply_msg).await {
            tracing::warn!(error = %e, "teammate: failed to persist reply");
            return;
        }
        let _ = app_bg.emit("teammate-message", &reply_msg);
    });

    Ok(user_msg)
}

async fn emit_system_error(
    app: &tauri::AppHandle,
    storage: &std::sync::Arc<crate::storage::Storage>,
    operator_id: crate::operator_registry::OperatorId,
    error_text: &str,
) {
    use crate::teammate::types::{MessageContent, MessageId, Role as TmRole, TaskMessage};
    use tauri::Emitter;
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let msg = TaskMessage {
        id: MessageId::new(),
        operator_id,
        task_id: None,
        role: TmRole::System,
        content: MessageContent::Text(format!("(dispatch failed) {error_text}")),
        created_at_unix_ms: now_ms,
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
    };
    let _ = storage.teammate_insert_message(&msg).await;
    let _ = app.emit("teammate-message", &msg);
}

#[tauri::command]
pub async fn teammate_list_tasks(
    _storage: State<'_, Arc<Storage>>,
) -> Result<Vec<crate::teammate::Task>, String> {
    // Phase 1: tasks are not surfaced from the UI yet. Return empty so
    // the rail can show the "no tasks" placeholder without erroring.
    Ok(Vec::new())
}
