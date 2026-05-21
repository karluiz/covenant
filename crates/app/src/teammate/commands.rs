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
    storage: State<'_, Arc<Storage>>,
    operator_id: OperatorId,
    text: String,
) -> Result<TaskMessage, String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis() as u64;
    let msg = TaskMessage {
        id: MessageId::new(),
        operator_id,
        task_id: None,
        role: Role::User,
        content: MessageContent::Text(text),
        created_at_unix_ms: now,
    };
    storage
        .teammate_insert_message(&msg)
        .await
        .map_err(|e| e.to_string())?;
    Ok(msg)
}

#[tauri::command]
pub async fn teammate_list_tasks(
    _storage: State<'_, Arc<Storage>>,
) -> Result<Vec<crate::teammate::Task>, String> {
    // Phase 1: tasks are not surfaced from the UI yet. Return empty so
    // the rail can show the "no tasks" placeholder without erroring.
    Ok(Vec::new())
}
