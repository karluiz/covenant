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
        sentiment: None,
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

        use crate::teammate::llm::DispatchOutcome;
        let outcome: DispatchOutcome = if let Some(root) = active_cwd {
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
                Ok(o) => o,
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
                Ok(raw) => {
                    let (text, sentiment) = crate::teammate::llm::extract_sentiment(&raw);
                    DispatchOutcome::Text { text, sentiment }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "teammate: dispatch failed");
                    emit_system_error(&app_bg, &storage_bg, operator_id, &format!("{e}")).await;
                    return;
                }
            }
        };
        let (reply_content, reply_sentiment) = match outcome {
            DispatchOutcome::Text { text, sentiment } => (MessageContent::Text(text), sentiment),
            DispatchOutcome::Propose(c) => (c, None),
        };
        let reply_msg = TaskMessage {
            id: MessageId::new(),
            operator_id,
            task_id: None,
            role: TmRole::Operator,
            content: reply_content,
            created_at_unix_ms: now_ms(),
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
            sentiment: reply_sentiment,
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
        sentiment: None,
    };
    let _ = storage.teammate_insert_message(&msg).await;
    let _ = app.emit("teammate-message", &msg);
}

#[tauri::command]
pub async fn teammate_list_tasks(
    storage: State<'_, Arc<Storage>>,
    operator_id: OperatorId,
) -> Result<Vec<crate::teammate::Task>, String> {
    storage.teammate_list_tasks_for_operator(operator_id).await
        .map_err(|e| e.to_string())
}

// ── Task-lifecycle helpers + Tauri commands ───────────────────────────────────

use crate::teammate::runtime::TeammateRuntime;
use crate::teammate::types::{
    ProposeTask, Task, TaskId, TaskStatus, UpdateKind,
};

fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Pure inner: confirm a Propose message → persist a Task → transition
/// operator state. Spawning the actual session happens in the UI via
/// `teammate_attach_session_to_task`.
pub(crate) async fn confirm_task_inner(
    storage: &Arc<Storage>,
    runtime: &Arc<TeammateRuntime>,
    operator_id: OperatorId,
    message_id: MessageId,
    now_ms: u64,
) -> Result<Task, String> {
    let msg = storage.teammate_get_message(message_id).await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "message not found".to_string())?;
    if msg.confirmed_at_unix_ms.is_some() {
        return Err("proposal already confirmed".into());
    }
    if msg.dismissed_at_unix_ms.is_some() {
        return Err("proposal was cancelled".into());
    }
    let propose = match msg.content {
        MessageContent::Propose(p) => p,
        _ => return Err("message is not a proposal".into()),
    };
    if msg.operator_id != operator_id {
        return Err("operator mismatch".into());
    }

    let task = Task {
        id: TaskId::new(),
        operator_id,
        archetype: propose.draft.archetype,
        title: propose.draft.title.clone(),
        body: propose.rationale.clone(),
        deliverable: propose.draft.deliverable.clone(),
        status: TaskStatus::Active,
        scope: propose.draft.scope.clone(),
        spawned_session: None,
        created_at_unix_ms: now_ms,
        updated_at_unix_ms: now_ms,
        completed_at_unix_ms: None,
        cost_usd_cents: 0,
    };
    storage.teammate_insert_task(&task).await.map_err(|e| e.to_string())?;
    storage.teammate_mark_message_confirmed(message_id, Some(task.id), now_ms).await
        .map_err(|e| e.to_string())?;
    runtime.start_task(operator_id, task.id, None).map_err(|e| e.to_string())?;

    let started = TaskMessage {
        id: MessageId::new(),
        operator_id,
        task_id: Some(task.id),
        role: Role::System,
        content: MessageContent::TaskUpdate { task: task.id, kind: UpdateKind::Started },
        created_at_unix_ms: now_ms,
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
        sentiment: Some(crate::teammate::types::Sentiment::Expectacion),
    };
    storage.teammate_insert_message(&started).await.map_err(|e| e.to_string())?;
    Ok(task)
}

pub(crate) async fn cancel_task_proposal_inner(
    storage: &Arc<Storage>,
    message_id: MessageId,
    now_ms: u64,
) -> Result<(), String> {
    let msg = storage.teammate_get_message(message_id).await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "message not found".to_string())?;
    if msg.confirmed_at_unix_ms.is_some() {
        return Err("proposal already confirmed".into());
    }
    if !matches!(msg.content, MessageContent::Propose(_)) {
        return Err("message is not a proposal".into());
    }
    storage.teammate_mark_message_dismissed(message_id, now_ms).await
        .map_err(|e| e.to_string())
}

pub(crate) async fn edit_task_proposal_inner(
    storage: &Arc<Storage>,
    message_id: MessageId,
    new_draft: crate::teammate::types::TaskDraft,
) -> Result<(), String> {
    let msg = storage.teammate_get_message(message_id).await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "message not found".to_string())?;
    let existing = match msg.content {
        MessageContent::Propose(p) => p,
        _ => return Err("message is not a proposal".into()),
    };
    if msg.confirmed_at_unix_ms.is_some() || msg.dismissed_at_unix_ms.is_some() {
        return Err("proposal is closed".into());
    }
    let updated = MessageContent::Propose(ProposeTask {
        draft: new_draft,
        rationale: existing.rationale,
    });
    storage.teammate_update_message_content(message_id, &updated).await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_confirm_task(
    app: tauri::AppHandle,
    storage: State<'_, Arc<Storage>>,
    runtime: State<'_, Arc<TeammateRuntime>>,
    operator_id: OperatorId,
    message_id: MessageId,
) -> Result<Task, String> {
    use tauri::Emitter;
    let now = now_unix_ms();
    let task = confirm_task_inner(storage.inner(), runtime.inner(), operator_id, message_id, now).await?;
    let _ = app.emit("teammate-task", &task);
    if let Ok(thread) = storage.teammate_list_messages(operator_id, 1).await {
        if let Some(last) = thread.last() {
            let _ = app.emit("teammate-message", last);
        }
    }
    Ok(task)
}

#[tauri::command]
pub async fn teammate_cancel_task_proposal(
    storage: State<'_, Arc<Storage>>,
    message_id: MessageId,
) -> Result<(), String> {
    cancel_task_proposal_inner(storage.inner(), message_id, now_unix_ms()).await
}

#[tauri::command]
pub async fn teammate_cancel_active_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    storage: State<'_, Arc<Storage>>,
    supervisor: State<'_, Arc<crate::teammate::task_supervisor::TaskSupervisor>>,
    task_id: crate::teammate::TaskId,
) -> Result<(), String> {
    use tauri::Emitter;
    let now = now_unix_ms();
    storage
        .teammate_update_task_status(task_id, TaskStatus::Cancelled, now)
        .await
        .map_err(|e| e.to_string())?;
    let task = storage
        .teammate_get_task(task_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "task not found".to_string())?;
    if let Some(s) = task.spawned_session {
        supervisor.forget_task(s);
        state.operator.disable_for_session(&app, s, "task_cancelled").await;
    }
    let msg = TaskMessage {
        id: MessageId::new(),
        operator_id: task.operator_id,
        task_id: Some(task_id),
        role: Role::System,
        content: MessageContent::TaskUpdate { task: task_id, kind: UpdateKind::Cancelled },
        created_at_unix_ms: now,
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
        sentiment: Some(crate::teammate::types::Sentiment::Triste),
    };
    storage.teammate_insert_message(&msg).await.map_err(|e| e.to_string())?;
    let _ = app.emit("teammate-message", &msg);
    Ok(())
}

#[tauri::command]
pub async fn teammate_edit_task_proposal(
    storage: State<'_, Arc<Storage>>,
    message_id: MessageId,
    draft: crate::teammate::types::TaskDraft,
) -> Result<(), String> {
    edit_task_proposal_inner(storage.inner(), message_id, draft).await
}

/// List recent operator decisions for the session a task is attached to.
/// Powers the teammate task-details view's "Decisions" feed.
#[tauri::command]
pub async fn teammate_list_decisions_for_session(
    storage: State<'_, Arc<Storage>>,
    session_id: String,
    limit: u32,
) -> Result<Vec<crate::storage::OperatorDecisionRow>, String> {
    storage
        .list_operator_decisions_for_session(session_id, limit)
        .await
        .map_err(|e| e.to_string())
}

/// Wipe every message and task for `operator_id`, and reset the in-memory
/// runtime state back to Idle. Used by the panel's reset button for testing.
#[tauri::command]
pub async fn teammate_clear_for_operator(
    storage: State<'_, Arc<Storage>>,
    runtime: State<'_, Arc<TeammateRuntime>>,
    operator_id: OperatorId,
) -> Result<(), String> {
    storage.teammate_clear_for_operator(operator_id).await
        .map_err(|e| e.to_string())?;
    runtime.reset(operator_id);
    Ok(())
}

#[tauri::command]
pub async fn teammate_attach_session_to_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    storage: State<'_, Arc<Storage>>,
    runtime: State<'_, Arc<TeammateRuntime>>,
    supervisor: State<'_, Arc<crate::teammate::task_supervisor::TaskSupervisor>>,
    operator_id: OperatorId,
    task_id: TaskId,
    session_id: String,
) -> Result<(), String> {
    use tauri::Emitter;
    let session = session_id.parse::<karl_session::SessionId>()
        .map_err(|e| format!("bad session id: {e}"))?;
    let now = now_unix_ms();
    storage.teammate_update_task_spawned_session(task_id, session, now).await
        .map_err(|e| e.to_string())?;
    // Propagate the Task's archetype into the per-session operator state so
    // the decision loop can apply archetype-specific contracts (e.g. the
    // read-only contract for Review). Failure to load is non-fatal — the
    // operator just runs without archetype context.
    let existing = storage.teammate_get_task(task_id).await.ok().flatten();
    if let Some(task) = &existing {
        state.operator.set_task_archetype(session, task.archetype).await;
    }
    // Re-attaching a session to a task that is no longer active — the user
    // reopened a cancelled/done task from the chat pill, which respawns the
    // tab and re-injects the prompt — must flip the persisted status back to
    // Active. Otherwise the tab restarts the work but `firstWorkingTask()`
    // still sees `cancelled`, so Mibli's header never relights its working
    // indicator and the teammate looks dead.
    let reactivated = matches!(&existing, Some(t) if !matches!(t.status, TaskStatus::Active));
    if reactivated {
        storage
            .teammate_update_task_status(task_id, TaskStatus::Active, now)
            .await
            .map_err(|e| e.to_string())?;
    }
    let _ = runtime.finish_task(operator_id, task_id);
    runtime.start_task(operator_id, task_id, Some(session)).map_err(|e| e.to_string())?;
    supervisor.register_task(session, task_id, operator_id);
    if reactivated {
        let msg = TaskMessage {
            id: MessageId::new(),
            operator_id,
            task_id: Some(task_id),
            role: Role::System,
            content: MessageContent::TaskUpdate { task: task_id, kind: UpdateKind::Resumed },
            created_at_unix_ms: now,
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
            sentiment: Some(crate::teammate::types::Sentiment::Feliz),
        };
        storage.teammate_insert_message(&msg).await.map_err(|e| e.to_string())?;
        let _ = app.emit("teammate-message", &msg);
    }
    let _ = app.emit("teammate-task", serde_json::json!({
        "task_id": task_id,
        "spawned_session": session.to_string(),
    }));
    Ok(())
}

#[cfg(test)]
mod task_lifecycle_tests {
    use super::*;
    use crate::operator_registry::{Operator, OperatorId, VoiceTone};
    use crate::storage::Storage;
    use crate::teammate::types::{
        MessageContent, MessageId, ProposeTask, Role, TaskArchetype,
        TaskDraft, TaskMessage, TaskScope,
    };
    use std::sync::Arc;
    use ulid::Ulid;

    async fn seed_storage() -> (Arc<Storage>, OperatorId, MessageId) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        Box::leak(Box::new(dir));
        let storage = Arc::new(Storage::open(&path).unwrap());

        let op_id = OperatorId(Ulid::new());
        storage.operator_insert(Operator {
            id: op_id,
            name: "T".into(),
            emoji: "🤖".into(),
            color: "#000".into(),
            tags: vec![],
            persona: "".into(),
            escalate_threshold: 0.6,
            model: "x".into(),
            hard_constraints: "".into(),
            voice: VoiceTone::Terse,
            is_default: false,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
        }).await.unwrap();

        let msg_id = MessageId::new();
        let msg = TaskMessage {
            id: msg_id,
            operator_id: op_id,
            task_id: None,
            role: Role::Operator,
            content: MessageContent::Propose(ProposeTask {
                draft: TaskDraft {
                    archetype: TaskArchetype::Do,
                    title: "Revisar migración".into(),
                    deliverable: "resumen".into(),
                    scope: TaskScope::default(),
                    executor: None,
                },
                rationale: "audit".into(),
            }),
            created_at_unix_ms: 1_700_000_000_000,
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
            sentiment: None,
        };
        storage.teammate_insert_message(&msg).await.unwrap();
        (storage, op_id, msg_id)
    }

    #[tokio::test]
    async fn confirm_proposal_creates_task_and_marks_message() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());

        let task = confirm_task_inner(&storage, &runtime, op_id, msg_id, 1_700_000_000_500)
            .await
            .expect("confirm should succeed");

        assert!(matches!(task.status, crate::teammate::types::TaskStatus::Active));
        assert!(matches!(task.archetype, crate::teammate::types::TaskArchetype::Do));
        assert_eq!(task.spawned_session, None, "spawn happens in UI; backend leaves it None initially");

        let fetched = storage.teammate_get_message(msg_id).await.unwrap().unwrap();
        assert_eq!(fetched.confirmed_at_unix_ms, Some(1_700_000_000_500));
    }

    #[tokio::test]
    async fn confirm_twice_returns_error() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());
        confirm_task_inner(&storage, &runtime, op_id, msg_id, 1).await.unwrap();
        let err = confirm_task_inner(&storage, &runtime, op_id, msg_id, 2).await.unwrap_err();
        assert!(err.contains("already confirmed"), "got: {err}");
    }

    #[tokio::test]
    async fn cancel_proposal_sets_dismissed() {
        let (storage, _op_id, msg_id) = seed_storage().await;
        cancel_task_proposal_inner(&storage, msg_id, 1_700_000_000_999).await.unwrap();
        let fetched = storage.teammate_get_message(msg_id).await.unwrap().unwrap();
        assert_eq!(fetched.dismissed_at_unix_ms, Some(1_700_000_000_999));
    }
}
