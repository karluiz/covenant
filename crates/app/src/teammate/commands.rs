//! Tauri commands for the teammate UI.

use std::sync::Arc;

use tauri::State;

use crate::operator_registry::OperatorId;
use crate::storage::Storage;
use crate::teammate::types::{MessageContent, MessageId, Role, TaskMessage};

#[tauri::command]
pub async fn teammate_list_messages_for_operator(
    storage: State<'_, Arc<Storage>>,
    thread_id: crate::teammate::ThreadId,
    limit: Option<usize>,
) -> Result<Vec<TaskMessage>, String> {
    storage
        .teammate_list_messages_in_thread(thread_id, limit.unwrap_or(200))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_create_thread(
    storage: State<'_, Arc<Storage>>,
    operator_id: OperatorId,
    title: String,
) -> Result<crate::teammate::TeammateThread, String> {
    let id = storage
        .teammate_create_thread(operator_id, &title)
        .await
        .map_err(|e| e.to_string())?;
    let threads = storage
        .teammate_list_threads(operator_id)
        .await
        .map_err(|e| e.to_string())?;
    threads
        .into_iter()
        .find(|t| t.id == id)
        .ok_or_else(|| "created thread not found".to_string())
}

#[tauri::command]
pub async fn teammate_list_threads(
    storage: State<'_, Arc<Storage>>,
    operator_id: OperatorId,
) -> Result<Vec<crate::teammate::TeammateThread>, String> {
    storage
        .teammate_list_threads(operator_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_rename_thread(
    storage: State<'_, Arc<Storage>>,
    thread_id: crate::teammate::ThreadId,
    title: String,
) -> Result<(), String> {
    storage
        .teammate_rename_thread(thread_id, &title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_archive_thread(
    storage: State<'_, Arc<Storage>>,
    thread_id: crate::teammate::ThreadId,
) -> Result<(), String> {
    storage
        .teammate_archive_thread(thread_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn teammate_send_text_message(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    storage: tauri::State<'_, std::sync::Arc<crate::storage::Storage>>,
    registry: tauri::State<'_, std::sync::Arc<crate::operator_registry::OperatorRegistry>>,
    runtime: tauri::State<'_, std::sync::Arc<crate::teammate::runtime::TeammateRuntime>>,
    operator_id: crate::operator_registry::OperatorId,
    thread_id: crate::teammate::ThreadId,
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
    let user_text = text.clone();
    let user_msg = TaskMessage {
        id: MessageId::new(),
        operator_id,
        task_id: None,
        thread_id: Some(thread_id),
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

    // 2) Snapshot the open sessions' world arcs + screen handles while we
    //    hold the sessions lock, then drop it before locking worlds.
    type WorldArc = std::sync::Arc<tokio::sync::Mutex<crate::world::SessionWorldModel>>;
    type ScreenArc = std::sync::Arc<std::sync::Mutex<String>>;
    let session_data: Vec<(karl_session::SessionId, WorldArc, ScreenArc)> = {
        let g = state.sessions.lock().await;
        g.iter()
            .map(|(id, m)| (*id, m.world.clone(), m.session.screen_handle()))
            .collect()
    };

    let active_session_id_parsed: Option<karl_session::SessionId> = active_session_id
        .as_deref()
        .and_then(|s| s.parse::<karl_session::SessionId>().ok());

    // ACP chat tabs (claude/codex/copilot/pi) — cloned here because
    // `State<'_, AppState>` isn't `'static` (same reason as session_data).
    let acp_worlds = state.acp_sessions.snapshot_worlds().await;

    let storage_bg = storage.inner().clone();
    let registry_bg = registry.inner().clone();
    let runtime_bg = runtime.inner().clone();
    let settings_bg = state.settings.clone();
    let app_bg = app.clone();
    tokio::spawn(async move {
        let operator = match registry_bg.get(operator_id) {
            Some(op) => op,
            None => {
                tracing::warn!(
                    ?operator_id,
                    "teammate: dispatch skipped — operator not found"
                );
                return;
            }
        };
        let thread = match storage_bg
            .teammate_list_messages_in_thread(thread_id, 200)
            .await
        {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!(error = %e, "teammate: failed to load thread");
                return;
            }
        };

        // First user message in a still-default thread → auto-title it in a
        // separate task so titling never blocks (or breaks) the reply.
        if thread.len() == 1 {
            let storage_bg2 = storage_bg.clone();
            let app_bg2 = app_bg.clone();
            let settings_bg2 = settings_bg.clone();
            let model = operator.model.clone();
            let user_text2 = user_text.clone();
            tokio::spawn(async move {
                // Only retitle a thread the user hasn't already named.
                let still_default = match storage_bg2.teammate_list_threads(operator_id).await {
                    Ok(threads) => threads
                        .iter()
                        .find(|t| t.id == thread_id)
                        .map(|t| t.title == "New conversation")
                        .unwrap_or(false),
                    Err(_) => false,
                };
                if !still_default {
                    return;
                }
                let settings = settings_bg2.lock().await.clone();
                if let Ok(title) =
                    crate::teammate::llm::generate_thread_title(&settings, &model, &user_text2)
                        .await
                {
                    let _ = storage_bg2.teammate_rename_thread(thread_id, &title).await;
                    let _ = app_bg2.emit(
                        "teammate-thread-renamed",
                        serde_json::json!({
                            "thread_id": thread_id.0.to_string(),
                            "title": title,
                        }),
                    );
                }
            });
        }

        // Build snapshot per session under each world's own lock.
        let mut snapshots = Vec::with_capacity(session_data.len());
        for (sid, world_arc, _screen) in &session_data {
            let w = world_arc.lock().await;
            let is_active = Some(*sid) == active_session_id_parsed;
            snapshots.push(crate::teammate::world_snapshot::project(
                *sid,
                &*w,
                is_active,
                now_ms(),
            ));
        }
        let acp_snapshots: Vec<crate::teammate::world_snapshot::AcpTabSnapshot> = acp_worlds
            .into_iter()
            .map(|w| crate::teammate::world_snapshot::AcpTabSnapshot {
                id: w.id,
                is_active: Some(w.id) == active_session_id_parsed,
                executor: w.executor,
                turns: w.turns,
                in_flight: w.in_flight,
                last_prompt: w.last_prompt,
                cwd: w.cwd.display().to_string(),
            })
            .collect();
        let mut world_context_str = if snapshots.is_empty() && acp_snapshots.is_empty() {
            String::new()
        } else {
            crate::teammate::world_snapshot::render_with_acp(&snapshots, &acp_snapshots)
        };
        // Surface the operator's own in-flight tasks so it can answer "are you
        // finished?"-style questions and not propose duplicates of running work.
        let active_tasks = storage_bg
            .teammate_list_tasks_for_operator(operator_id)
            .await
            .unwrap_or_default();
        let active_tasks_md = crate::teammate::llm::render_active_tasks(&active_tasks);
        if !active_tasks_md.is_empty() {
            if !world_context_str.is_empty() {
                world_context_str.push_str("\n\n");
            }
            world_context_str.push_str(&active_tasks_md);
        }
        let world_context_opt: Option<&str> = if world_context_str.trim().is_empty() {
            None
        } else {
            Some(world_context_str.as_str())
        };

        let settings = settings_bg.lock().await.clone();

        // Find the cwd of the marked-active session, if any. The tool
        // sandbox roots into that directory. If no cwd is known (no active
        // session id, or cwd not captured yet) we fall back to the no-tool
        // dispatch so the operator can still answer.
        let active_cwd: Option<std::path::PathBuf> =
            if let Some(active_id) = active_session_id_parsed {
                snapshots
                    .iter()
                    .find(|s| s.id == active_id)
                    .map(|s| s.cwd.clone())
                    // The focused tab may be an ACP chat tab — its cwd
                    // works as a tool-sandbox root just the same.
                    .or_else(|| {
                        acp_snapshots
                            .iter()
                            .find(|s| s.id == active_id)
                            .map(|s| s.cwd.clone())
                    })
                    .and_then(|cwd| {
                        let raw = std::path::PathBuf::from(&cwd);
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
            let active_screen: Option<std::sync::Arc<std::sync::Mutex<String>>> =
                active_session_id_parsed.and_then(|aid| {
                    session_data
                        .iter()
                        .find(|(id, _, _)| *id == aid)
                        .map(|(_, _, screen)| screen.clone())
                });
            let tool_env = crate::teammate::tools::ToolEnv::new(root, 200 * 1024)
                .with_screen(active_screen)
                .with_skills(crate::teammate::handoff::skill_union(&registry_bg.list()))
                .with_acp(operator.acp_enabled);
            // GitHub access: attach the stored token only when this operator
            // is allowed to use it. Keychain reads are sync — keep them off
            // the async thread.
            let tool_env = if operator.github_access != crate::operator_registry::GithubAccess::Off
            {
                match tokio::task::spawn_blocking(karl_score::auth::load_token_from_keychain).await
                {
                    Ok(Ok(Some(token))) => {
                        tool_env.with_github(Some(crate::teammate::tools::GithubCtx {
                            token,
                            access: operator.github_access,
                            api_base: karl_score::auth::GITHUB_API_BASE.to_string(),
                        }))
                    }
                    Ok(Ok(None)) => {
                        tracing::warn!(
                            operator_id = %operator.id,
                            "operator has github access but no token in keychain; gh_* tools disabled"
                        );
                        tool_env
                    }
                    Ok(Err(e)) => {
                        tracing::warn!(error = %e, "keychain read failed; gh_* tools disabled");
                        tool_env
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "keychain task panicked; gh_* tools disabled");
                        tool_env
                    }
                }
            } else {
                tool_env
            };
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
                &operator,
                &thread,
                &settings,
                world_context_opt,
                tool_env,
                progress,
            )
            .await
            {
                Ok(o) => o,
                Err(e) => {
                    tracing::warn!(error = %e, "teammate: tool-use dispatch failed");
                    emit_system_error(&app_bg, &storage_bg, operator_id, &format!("{e}")).await;
                    return;
                }
            }
        } else {
            match crate::teammate::llm::dispatch_reply(
                &operator,
                &thread,
                &settings,
                world_context_opt,
            )
            .await
            {
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
        // Autonomous handoff: route immediately (no user confirm), then fall
        // through with a system-style text reply describing what happened.
        let outcome = match outcome {
            DispatchOutcome::Handoff(req) => {
                let routed = crate::teammate::handoff::route(
                    &storage_bg,
                    &runtime_bg,
                    &registry_bg.list(),
                    operator_id,
                    thread_id,
                    &req,
                    now_ms(),
                )
                .await;
                match routed {
                    Ok(crate::teammate::handoff::RouteResult::Accepted(acc)) => {
                        let _ = app_bg.emit(
                            "teammate-handoff-routed",
                            serde_json::json!({
                                "handoff_id":  acc.handoff.id.0.to_string(),
                                "chain_id":    acc.handoff.chain_id.0.to_string(),
                                "from_operator": operator_id,
                                "to_operator": acc.task.operator_id,
                                "task_id":     acc.task.id.0.to_string(),
                                "executor":    acc.executor,
                                "brief":       acc.handoff.brief,
                                "deliverable": acc.task.deliverable,
                            }),
                        );
                        let to_name = registry_bg
                            .get(acc.task.operator_id)
                            .map(|o| o.name)
                            .unwrap_or_else(|| "a teammate".to_string());
                        DispatchOutcome::Text {
                            text: handoff_outcome_message_accepted(&to_name, &req.brief),
                            sentiment: None,
                        }
                    }
                    Ok(crate::teammate::handoff::RouteResult::Rejected { reason, .. }) => {
                        let skills_str = req.required_skills.join(", ");
                        DispatchOutcome::Text {
                            text: handoff_outcome_message_rejected(&skills_str, &reason.message()),
                            sentiment: None,
                        }
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "handoff routing failed");
                        let skills_str = req.required_skills.join(", ");
                        DispatchOutcome::Text {
                            text: handoff_outcome_message_rejected(&skills_str, "internal error"),
                            sentiment: None,
                        }
                    }
                }
            }
            other => other,
        };
        let (reply_content, reply_sentiment) = match outcome {
            DispatchOutcome::Text { text, sentiment } => (MessageContent::Text(text), sentiment),
            DispatchOutcome::Propose(c) => (c, None),
            DispatchOutcome::Handoff(_) => unreachable!("handoff resolved above"),
        };
        let reply_msg = TaskMessage {
            id: MessageId::new(),
            operator_id,
            task_id: None,
            thread_id: Some(thread_id),
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

fn handoff_outcome_message_accepted(to: &str, brief: &str) -> String {
    format!("→ Handed off to {to}: {brief} (running; will report back).")
}
fn handoff_outcome_message_rejected(subject: &str, reason: &str) -> String {
    format!("⃠ Handoff blocked ({subject}): {reason}")
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
        thread_id: None,
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
    storage
        .teammate_list_tasks_for_operator(operator_id)
        .await
        .map_err(|e| e.to_string())
}

// ── Task-lifecycle helpers + Tauri commands ───────────────────────────────────

use crate::teammate::runtime::TeammateRuntime;
use crate::teammate::types::{ProposeTask, Task, TaskId, TaskStatus, UpdateKind};

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
    let msg = storage
        .teammate_get_message(message_id)
        .await
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
    // Claim the operator FIRST. It's the only precondition that can fail on
    // a valid proposal (AlreadyOnTask), and claiming an in-memory slot is
    // trivially reversible — persisting a task row and confirming the
    // message are not. Doing storage writes before this check used to leave
    // an orphan Active task + a confirmed-but-never-started proposal behind
    // every "operator already on task" rejection.
    runtime
        .start_task(operator_id, task.id, None)
        .map_err(|e| e.to_string())?;
    let persisted = async {
        storage
            .teammate_insert_task(&task)
            .await
            .map_err(|e| e.to_string())?;
        storage
            .teammate_mark_message_confirmed(message_id, Some(task.id), now_ms)
            .await
            .map_err(|e| e.to_string())
    }
    .await;
    if let Err(e) = persisted {
        let _ = runtime.finish_task(operator_id, task.id);
        return Err(e);
    }

    let started = TaskMessage {
        id: MessageId::new(),
        operator_id,
        task_id: Some(task.id),
        thread_id: None,
        role: Role::System,
        content: MessageContent::TaskUpdate {
            task: task.id,
            kind: UpdateKind::Started,
        },
        created_at_unix_ms: now_ms,
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
        sentiment: Some(crate::teammate::types::Sentiment::Expectacion),
    };
    storage
        .teammate_insert_message(&started)
        .await
        .map_err(|e| e.to_string())?;
    Ok(task)
}

/// Which completion-gated achievement facts a finished task should emit,
/// given the supervisor's accumulated per-task flags. Pure + testable.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum CompletionFact {
    Finisher,
    CleanRun,
    Recovered,
}

pub(crate) fn plan_completion_emits(
    flags: crate::teammate::task_supervisor::TaskFlags,
) -> Vec<CompletionFact> {
    let mut out = vec![CompletionFact::Finisher]; // verified completion always counts
    if !flags.saw_failed_block {
        out.push(CompletionFact::CleanRun);
    }
    if flags.ever_blocked {
        out.push(CompletionFact::Recovered);
    }
    out
}

pub(crate) fn build_handoff_report_body(to: &str, deliverable: &str, ok: bool) -> String {
    if ok {
        format!("✓ {to} completed the delegated task — {deliverable}. (Review and continue.)")
    } else {
        format!("✗ {to} did not complete the delegated task — {deliverable}.")
    }
}

/// If `task_id` was delegated via a handoff, persist a report into the
/// delegator's thread and mark the edge terminal (Reported on success,
/// Failed otherwise). Best-effort, pure storage I/O — the real-time emit +
/// delegator wake land in Plan 2. No-op when the task wasn't delegated.
pub(crate) async fn report_handoff_back(
    storage: &Arc<Storage>,
    task_id: TaskId,
    deliverable: &str,
    ok: bool,
    now_ms: u64,
) -> Result<(), String> {
    let Some(h) = storage
        .teammate_get_handoff_by_task(task_id)
        .await
        .map_err(|e| e.to_string())?
    else {
        return Ok(());
    };
    if h.status != crate::teammate::types::HandoffStatus::Running {
        return Ok(());
    }

    let to_name = storage
        .operator_list()
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|o| o.id == h.to_operator_id)
        .map(|o| o.name)
        .unwrap_or_else(|| "the operator".into());
    let body = build_handoff_report_body(&to_name, deliverable, ok);

    let mut report = TaskMessage {
        id: MessageId::new(),
        operator_id: h.from_operator_id,
        task_id: h.origin_task_id,
        thread_id: Some(h.origin_thread_id),
        role: Role::System,
        content: MessageContent::Text(body.clone()),
        created_at_unix_ms: now_ms,
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
        sentiment: None,
    };
    // The report-back is best-effort: if the delegator's origin thread or the
    // origin task no longer exists (FK violation on thread_id or task_id),
    // still land the report on the operator's feed unthreaded/untasked rather
    // than dropping it and stranding the edge as Running forever.
    if let Err(e) = storage.teammate_insert_message(&report).await {
        tracing::warn!(error = %e, "handoff report threaded-insert failed; retrying unthreaded");
        report.thread_id = None;
        report.task_id = None;
        storage
            .teammate_insert_message(&report)
            .await
            .map_err(|e| e.to_string())?;
    }
    storage
        .teammate_update_handoff_status(
            h.id,
            if ok {
                crate::teammate::types::HandoffStatus::Reported
            } else {
                crate::teammate::types::HandoffStatus::Failed
            },
            Some(body),
            Some(now_ms),
        )
        .await
        .map_err(|e| e.to_string())?;

    // Only credit the good_delegate achievement on a successful handoff;
    // crediting a cancelled delegation would be wrong/gameable.
    if ok {
        karl_score::record_task_delegated(
            &h.from_operator_id.0.to_string(),
            &task_id.0.to_string(),
        );
    }
    Ok(())
}

/// Pure inner: mark an active/blocked task done, release the operator, and
/// synthesize the Completed lifecycle message. The Tauri command wraps this
/// with supervisor/operator-session cleanup + event emits.
pub(crate) async fn complete_task_inner(
    storage: &Arc<Storage>,
    runtime: &Arc<TeammateRuntime>,
    task_id: TaskId,
    now_ms: u64,
) -> Result<(Task, TaskMessage), String> {
    let task = storage
        .teammate_get_task(task_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "task not found".to_string())?;
    if matches!(task.status, TaskStatus::Done) {
        return Err("task already done".into());
    }
    storage
        .teammate_mark_task_done(task_id, now_ms)
        .await
        .map_err(|e| e.to_string())?;
    // Best-effort release: after an app restart the in-memory runtime may
    // not know about this task (or may track a different one) — storage is
    // the source of truth, so a mismatch must not block completion.
    let _ = runtime.finish_task(task.operator_id, task_id);
    let msg = TaskMessage {
        id: MessageId::new(),
        operator_id: task.operator_id,
        task_id: Some(task_id),
        thread_id: None,
        role: Role::System,
        content: MessageContent::TaskUpdate {
            task: task_id,
            kind: UpdateKind::Completed,
        },
        created_at_unix_ms: now_ms,
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
        sentiment: Some(crate::teammate::types::Sentiment::Feliz),
    };
    storage
        .teammate_insert_message(&msg)
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = report_handoff_back(storage, task_id, &task.deliverable, true, now_ms).await {
        tracing::warn!(error = %e, "handoff report-back (complete) failed");
    }
    let task = Task {
        status: TaskStatus::Done,
        completed_at_unix_ms: Some(now_ms),
        updated_at_unix_ms: now_ms,
        ..task
    };
    Ok((task, msg))
}

/// Pure inner: cancel an active/blocked task, release the operator, and
/// synthesize the Cancelled lifecycle message.
pub(crate) async fn cancel_active_task_inner(
    storage: &Arc<Storage>,
    runtime: &Arc<TeammateRuntime>,
    task_id: TaskId,
    now_ms: u64,
) -> Result<(Task, TaskMessage), String> {
    let task = storage
        .teammate_get_task(task_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "task not found".to_string())?;
    storage
        .teammate_update_task_status(task_id, TaskStatus::Cancelled, now_ms)
        .await
        .map_err(|e| e.to_string())?;
    // Same best-effort semantics as complete_task_inner. Without this the
    // operator stayed OnTask forever after a Stop, and every subsequent
    // confirm died with "operator already on task" until an app restart.
    let _ = runtime.finish_task(task.operator_id, task_id);
    let msg = TaskMessage {
        id: MessageId::new(),
        operator_id: task.operator_id,
        task_id: Some(task_id),
        thread_id: None,
        role: Role::System,
        content: MessageContent::TaskUpdate {
            task: task_id,
            kind: UpdateKind::Cancelled,
        },
        created_at_unix_ms: now_ms,
        confirmed_at_unix_ms: None,
        dismissed_at_unix_ms: None,
        // Cancel is an end-state, not a mood. The operator is released here;
        // leaving it `Triste` left idle operators wearing a permanent sad
        // face. Neutral resets the pose. (The frontend also clears mood on a
        // terminal task_update — this keeps stored history honest too.)
        sentiment: Some(crate::teammate::types::Sentiment::Neutral),
    };
    storage
        .teammate_insert_message(&msg)
        .await
        .map_err(|e| e.to_string())?;
    if let Err(e) = report_handoff_back(storage, task_id, &task.deliverable, false, now_ms).await {
        tracing::warn!(error = %e, "handoff report-back (cancel) failed");
    }
    let task = Task {
        status: TaskStatus::Cancelled,
        updated_at_unix_ms: now_ms,
        ..task
    };
    Ok((task, msg))
}

pub(crate) async fn cancel_task_proposal_inner(
    storage: &Arc<Storage>,
    message_id: MessageId,
    now_ms: u64,
) -> Result<(), String> {
    let msg = storage
        .teammate_get_message(message_id)
        .await
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "message not found".to_string())?;
    if msg.confirmed_at_unix_ms.is_some() {
        return Err("proposal already confirmed".into());
    }
    if !matches!(msg.content, MessageContent::Propose(_)) {
        return Err("message is not a proposal".into());
    }
    storage
        .teammate_mark_message_dismissed(message_id, now_ms)
        .await
        .map_err(|e| e.to_string())
}

pub(crate) async fn edit_task_proposal_inner(
    storage: &Arc<Storage>,
    message_id: MessageId,
    new_draft: crate::teammate::types::TaskDraft,
) -> Result<(), String> {
    let msg = storage
        .teammate_get_message(message_id)
        .await
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
    storage
        .teammate_update_message_content(message_id, &updated)
        .await
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
    let task = confirm_task_inner(
        storage.inner(),
        runtime.inner(),
        operator_id,
        message_id,
        now,
    )
    .await?;
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
    runtime: State<'_, Arc<TeammateRuntime>>,
    supervisor: State<'_, Arc<crate::teammate::task_supervisor::TaskSupervisor>>,
    spec_tracker: State<'_, Arc<crate::teammate::spec_edit_tracker::SpecEditTracker>>,
    task_id: crate::teammate::TaskId,
) -> Result<(), String> {
    use tauri::Emitter;
    let (task, msg) =
        cancel_active_task_inner(storage.inner(), runtime.inner(), task_id, now_unix_ms()).await?;
    if let Some(s) = task.spawned_session {
        supervisor.forget_task(s);
        spec_tracker.forget(s);
        state
            .operator
            .disable_for_session(&app, s, "task_cancelled")
            .await;
    }
    let _ = app.emit("teammate-task", &task);
    let _ = app.emit("teammate-message", &msg);
    Ok(())
}

/// Mark an active/blocked task as done, releasing the operator so it can
/// pick up the next task. Used by the task-detail "Mark done" button.
#[tauri::command]
pub async fn teammate_complete_task(
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    storage: State<'_, Arc<Storage>>,
    runtime: State<'_, Arc<TeammateRuntime>>,
    supervisor: State<'_, Arc<crate::teammate::task_supervisor::TaskSupervisor>>,
    spec_tracker: State<'_, Arc<crate::teammate::spec_edit_tracker::SpecEditTracker>>,
    task_id: crate::teammate::TaskId,
) -> Result<(), String> {
    use tauri::Emitter;
    let (task, msg) =
        complete_task_inner(storage.inner(), runtime.inner(), task_id, now_unix_ms()).await?;
    if let Some(s) = task.spawned_session {
        // Achievement emits: read flags while the task is still tracked.
        let flags = supervisor.task_flags(s).unwrap_or_default();
        let operator = task.operator_id.to_string();
        let repo = karl_score::current_context().repo;
        let task_id_str = task_id.0.to_string();
        for fact in plan_completion_emits(flags) {
            match fact {
                CompletionFact::Finisher => {
                    karl_score::record_task_verified(&operator, repo.as_deref(), &task_id_str)
                }
                CompletionFact::CleanRun => {
                    karl_score::record_clean_run(&operator, repo.as_deref(), &task_id_str)
                }
                CompletionFact::Recovered => {
                    karl_score::record_task_recovered(&operator, &task_id_str)
                }
            }
        }
        // spec_keeper: spec read/created before first code edit, this task.
        if spec_tracker.satisfied(s) {
            let spec_repo = spec_tracker.satisfied_repo(s).or_else(|| repo.clone());
            if let Some(spec_repo) = spec_repo.as_deref() {
                karl_score::record_spec_kept(&operator, spec_repo, &task_id_str);
            }
        }
        spec_tracker.forget(s);
        supervisor.forget_task(s);
        state
            .operator
            .disable_for_session(&app, s, "task_completed")
            .await;
    }
    let _ = app.emit("teammate-task", &task);
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
    storage
        .teammate_clear_for_operator(operator_id)
        .await
        .map_err(|e| e.to_string())?;
    runtime.reset(operator_id);
    Ok(())
}

/// Delete finished tasks (done | cancelled) for `operator_id`, leaving active,
/// blocked, and draft tasks intact. Returns the number of tasks removed.
#[tauri::command]
pub async fn teammate_clear_finished_tasks(
    storage: State<'_, Arc<Storage>>,
    operator_id: OperatorId,
) -> Result<usize, String> {
    storage
        .teammate_clear_finished_tasks(operator_id)
        .await
        .map_err(|e| e.to_string())
}

/// Delete a single task by id, leaving every other task intact. Used by the
/// per-task trash button on a finished (done | cancelled) task row.
#[tauri::command]
pub async fn teammate_delete_task(
    storage: State<'_, Arc<Storage>>,
    task_id: crate::teammate::TaskId,
) -> Result<(), String> {
    storage
        .teammate_delete_task(task_id)
        .await
        .map_err(|e| e.to_string())?;
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
    let session = session_id
        .parse::<karl_session::SessionId>()
        .map_err(|e| format!("bad session id: {e}"))?;
    let now = now_unix_ms();
    storage
        .teammate_update_task_spawned_session(task_id, session, now)
        .await
        .map_err(|e| e.to_string())?;
    // Propagate the Task's archetype into the per-session operator state so
    // the decision loop can apply archetype-specific contracts (e.g. the
    // read-only contract for Review). Failure to load is non-fatal — the
    // operator just runs without archetype context.
    let existing = storage.teammate_get_task(task_id).await.ok().flatten();
    if let Some(task) = &existing {
        state
            .operator
            .set_task_context(
                session,
                task.archetype,
                crate::operator::TaskIdent {
                    id: task.id,
                    title: task.title.clone(),
                    deliverable: task.deliverable.clone(),
                },
            )
            .await;
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
    runtime
        .start_task(operator_id, task_id, Some(session))
        .map_err(|e| e.to_string())?;
    supervisor.register_task(session, task_id, operator_id);
    if reactivated {
        let msg = TaskMessage {
            id: MessageId::new(),
            operator_id,
            task_id: Some(task_id),
            thread_id: None,
            role: Role::System,
            content: MessageContent::TaskUpdate {
                task: task_id,
                kind: UpdateKind::Resumed,
            },
            created_at_unix_ms: now,
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
            sentiment: Some(crate::teammate::types::Sentiment::Feliz),
        };
        storage
            .teammate_insert_message(&msg)
            .await
            .map_err(|e| e.to_string())?;
        let _ = app.emit("teammate-message", &msg);
    }
    let _ = app.emit(
        "teammate-task",
        serde_json::json!({
            "task_id": task_id,
            "spawned_session": session.to_string(),
        }),
    );
    Ok(())
}

#[cfg(test)]
mod task_lifecycle_tests {
    use super::*;
    use crate::operator_registry::{Operator, OperatorId, VoiceTone};
    use crate::storage::Storage;
    use crate::teammate::types::{
        MessageContent, MessageId, ProposeTask, Role, TaskArchetype, TaskDraft, TaskMessage,
        TaskScope,
    };
    use std::sync::Arc;
    use ulid::Ulid;

    async fn seed_storage() -> (Arc<Storage>, OperatorId, MessageId) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.sqlite");
        Box::leak(Box::new(dir));
        let storage = Arc::new(Storage::open(&path).unwrap());

        let op_id = OperatorId(Ulid::new());
        storage
            .operator_insert(Operator {
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
                soul_path: None,
                soul_mtime_unix_ms: 0,
                github_access: crate::operator_registry::GithubAccess::Off,
                acp_enabled: false,
                perception_enabled: false,
                org_slug: None,
            })
            .await
            .unwrap();

        let msg_id = MessageId::new();
        let msg = TaskMessage {
            id: msg_id,
            operator_id: op_id,
            task_id: None,
            thread_id: None,
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

        assert!(matches!(
            task.status,
            crate::teammate::types::TaskStatus::Active
        ));
        assert!(matches!(
            task.archetype,
            crate::teammate::types::TaskArchetype::Do
        ));
        assert_eq!(
            task.spawned_session, None,
            "spawn happens in UI; backend leaves it None initially"
        );

        let fetched = storage.teammate_get_message(msg_id).await.unwrap().unwrap();
        assert_eq!(fetched.confirmed_at_unix_ms, Some(1_700_000_000_500));
    }

    #[tokio::test]
    async fn confirm_twice_returns_error() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());
        confirm_task_inner(&storage, &runtime, op_id, msg_id, 1)
            .await
            .unwrap();
        let err = confirm_task_inner(&storage, &runtime, op_id, msg_id, 2)
            .await
            .unwrap_err();
        assert!(err.contains("already confirmed"), "got: {err}");
    }

    #[tokio::test]
    async fn cancel_proposal_sets_dismissed() {
        let (storage, _op_id, msg_id) = seed_storage().await;
        cancel_task_proposal_inner(&storage, msg_id, 1_700_000_000_999)
            .await
            .unwrap();
        let fetched = storage.teammate_get_message(msg_id).await.unwrap().unwrap();
        assert_eq!(fetched.dismissed_at_unix_ms, Some(1_700_000_000_999));
    }

    #[tokio::test]
    async fn confirm_while_operator_busy_leaves_proposal_clean() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());
        runtime
            .start_task(op_id, crate::teammate::types::TaskId::new(), None)
            .unwrap();

        let err = confirm_task_inner(&storage, &runtime, op_id, msg_id, 1)
            .await
            .unwrap_err();
        assert!(err.contains("already on task"), "got: {err}");

        // The failed confirm must not corrupt state: proposal stays
        // unconfirmed (so it can be retried later) and no orphan task row
        // is persisted.
        let fetched = storage.teammate_get_message(msg_id).await.unwrap().unwrap();
        assert_eq!(fetched.confirmed_at_unix_ms, None);
        let tasks = storage
            .teammate_list_tasks_for_operator(op_id)
            .await
            .unwrap();
        assert!(
            tasks.is_empty(),
            "no task row should survive a failed confirm"
        );
    }

    #[tokio::test]
    async fn complete_task_marks_done_and_frees_operator() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());
        let task = confirm_task_inner(&storage, &runtime, op_id, msg_id, 1)
            .await
            .unwrap();

        let (done, _msg) = complete_task_inner(&storage, &runtime, task.id, 99)
            .await
            .unwrap();
        assert!(matches!(
            done.status,
            crate::teammate::types::TaskStatus::Done
        ));
        assert_eq!(done.completed_at_unix_ms, Some(99));

        // Operator must be free again: a fresh task can start immediately.
        runtime
            .start_task(op_id, crate::teammate::types::TaskId::new(), None)
            .expect("operator should be Idle after completing its task");
    }

    #[tokio::test]
    async fn complete_task_twice_returns_error() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());
        let task = confirm_task_inner(&storage, &runtime, op_id, msg_id, 1)
            .await
            .unwrap();
        complete_task_inner(&storage, &runtime, task.id, 2)
            .await
            .unwrap();
        let err = complete_task_inner(&storage, &runtime, task.id, 3)
            .await
            .unwrap_err();
        assert!(err.contains("already done"), "got: {err}");
    }

    #[tokio::test]
    async fn cancel_active_task_frees_operator() {
        let (storage, op_id, msg_id) = seed_storage().await;
        let runtime = Arc::new(crate::teammate::runtime::TeammateRuntime::new());
        let task = confirm_task_inner(&storage, &runtime, op_id, msg_id, 1)
            .await
            .unwrap();

        let (cancelled, _msg) = cancel_active_task_inner(&storage, &runtime, task.id, 2)
            .await
            .unwrap();
        assert!(matches!(
            cancelled.status,
            crate::teammate::types::TaskStatus::Cancelled
        ));

        runtime
            .start_task(op_id, crate::teammate::types::TaskId::new(), None)
            .expect("operator should be Idle after cancelling its task");
    }

    #[tokio::test]
    async fn complete_reports_handoff_back_to_delegator() {
        use crate::operator_registry::{Operator, OperatorId, VoiceTone};
        use crate::teammate::types::*;
        let dir = tempfile::tempdir().unwrap();
        let storage = std::sync::Arc::new(Storage::open(&dir.path().join("t.sqlite")).unwrap());
        let runtime = std::sync::Arc::new(crate::teammate::runtime::TeammateRuntime::new());

        // mirror seed_storage's Operator literal:
        let mk = |name: &str| Operator {
            id: OperatorId(ulid::Ulid::new()),
            name: name.into(),
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
            soul_path: None,
            soul_mtime_unix_ms: 0,
            github_access: crate::operator_registry::GithubAccess::Off,
            acp_enabled: false,
            perception_enabled: false,
            org_slug: None,
        };
        let zeta = mk("Zeta");
        let kiro = mk("Kiro");
        storage.operator_insert(zeta.clone()).await.unwrap();
        storage.operator_insert(kiro.clone()).await.unwrap();

        // receiver task owned by Kiro
        let task = Task {
            id: TaskId::new(),
            operator_id: kiro.id,
            archetype: TaskArchetype::Do,
            title: "t".into(),
            body: "".into(),
            deliverable: "thing done".into(),
            status: TaskStatus::Active,
            scope: TaskScope::default(),
            spawned_session: None,
            created_at_unix_ms: 1,
            updated_at_unix_ms: 1,
            completed_at_unix_ms: None,
            cost_usd_cents: 0,
        };
        storage.teammate_insert_task(&task).await.unwrap();

        // Running handoff edge Zeta -> Kiro for that task
        let thread = ThreadId::new();
        let h = Handoff {
            id: HandoffId::new(),
            chain_id: ChainId::new(),
            depth: 0,
            from_operator_id: zeta.id,
            to_operator_id: kiro.id,
            task_id: Some(task.id),
            origin_task_id: None,
            origin_thread_id: thread,
            status: HandoffStatus::Running,
            brief: "do the thing".into(),
            result_summary: None,
            created_at_unix_ms: 1,
            reported_at_unix_ms: None,
        };
        storage.teammate_insert_handoff(&h).await.unwrap();

        complete_task_inner(&storage, &runtime, task.id, 200)
            .await
            .unwrap();

        let edge = storage
            .teammate_get_handoff_by_task(task.id)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(edge.status, HandoffStatus::Reported);
        let summary = edge.result_summary.unwrap();
        assert!(summary.contains("Kiro") && summary.contains("completed"));
    }
}

#[cfg(test)]
mod tests {
    use super::{plan_completion_emits, CompletionFact};
    use crate::teammate::task_supervisor::TaskFlags;

    #[test]
    fn completion_plan_emits_finisher_always_and_gates_others() {
        // clean, never blocked -> finisher + clean_run
        let p = plan_completion_emits(TaskFlags {
            saw_failed_block: false,
            ever_blocked: false,
        });
        assert!(p.contains(&CompletionFact::Finisher));
        assert!(p.contains(&CompletionFact::CleanRun));
        assert!(!p.contains(&CompletionFact::Recovered));

        // had a failure, was blocked, recovered -> finisher + recovered, NO clean_run
        let p = plan_completion_emits(TaskFlags {
            saw_failed_block: true,
            ever_blocked: true,
        });
        assert!(p.contains(&CompletionFact::Finisher));
        assert!(!p.contains(&CompletionFact::CleanRun));
        assert!(p.contains(&CompletionFact::Recovered));
    }

    #[test]
    fn handoff_accept_message_names_receiver() {
        let m = super::handoff_outcome_message_accepted("Kiro", "migrate auth");
        assert!(m.contains("Kiro"));
        assert!(m.contains("migrate auth"));
    }

    #[test]
    fn handoff_reject_message_carries_reason() {
        let m = super::handoff_outcome_message_rejected(
            "Kiro",
            "receiver is busy on another task; retry later",
        );
        assert!(m.contains("Kiro"));
        assert!(m.contains("busy"));
    }

    #[test]
    fn handoff_report_body_summarizes() {
        let ok = super::build_handoff_report_body("Kiro", "thing done", true);
        assert!(ok.contains("Kiro") && ok.contains("thing done") && ok.contains("completed"));
        let bad = super::build_handoff_report_body("Kiro", "thing done", false);
        assert!(bad.contains("did not complete"));
    }
}
