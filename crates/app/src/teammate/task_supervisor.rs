//! Background watcher that turns `SessionEvent`s into operator sentiment
//! and task-status transitions. Pure state-machine lives in
//! `Inner::observe_block_finished`; the bus loop in `run` wraps it.

#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_session::SessionId;
use parking_lot::Mutex;
use tokio::sync::broadcast;
use tracing::warn;

use crate::operator_registry::OperatorId;
use crate::storage::Storage;
use crate::teammate::runtime::TeammateRuntime;
use crate::teammate::sentiment_resolver::SentimentResolver;
use crate::teammate::types::{
    MessageContent, MessageId, Role, Sentiment, TaskId, TaskMessage, TaskStatus, UpdateKind,
};

/// What the supervisor remembers per active task.
#[derive(Clone, Debug)]
pub struct TaskCtx {
    pub task_id: TaskId,
    pub operator_id: OperatorId,
    /// Status known by the supervisor (mirrors storage).
    pub status: TaskStatus,
    /// Wall-clock at which `status` was last set.
    pub status_at: Instant,
    /// Consecutive failed `BlockFinished` events since the last success
    /// or status reset. Used for `enojo` (≥3) and `triste` (≥3 with time).
    pub retry_count: u32,
    /// The command of the most recent nonzero-exit block; used so we only
    /// count "same command failed again" as a retry.
    pub last_failed_cmd: Option<String>,
    /// True once any block in this task exited non-zero. Sticky for the
    /// task lifetime. Drives `clean_run`.
    pub saw_failed_block: bool,
    /// True once this task entered Blocked at least once. Sticky. Drives
    /// `recovery_artist` (recovered-then-completed).
    pub ever_blocked: bool,
}

/// Decision returned by the pure observer. The bus loop turns this into
/// storage writes + Tauri emits.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Update status in storage to `new_status` and emit a TaskUpdate
    /// synth message with `(kind, sentiment)`.
    Transition {
        new_status: TaskStatus,
        kind: UpdateKind,
        sentiment: Sentiment,
    },
    /// Emit only a TaskUpdate with this sentiment; no status change.
    /// Used for `enojo` while already Blocked.
    Sentiment {
        kind: UpdateKind,
        sentiment: Sentiment,
    },
    /// No emit.
    Nothing,
}

pub struct Inner {
    /// Active tasks keyed by the session they spawned. One session ↔ one task.
    by_session: HashMap<SessionId, TaskCtx>,
    pub resolver: SentimentResolver,
}

impl Inner {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            by_session: HashMap::new(),
            resolver: SentimentResolver::new(min_interval),
        }
    }

    pub fn register(&mut self, session: SessionId, ctx: TaskCtx) {
        self.by_session.insert(session, ctx);
    }

    pub fn unregister(&mut self, session: SessionId) {
        if let Some(ctx) = self.by_session.remove(&session) {
            // Drop the resolver's last-sentiment state so the map doesn't
            // leak one entry per cancelled/closed task for the session's life.
            self.resolver.clear(ctx.operator_id, ctx.task_id);
        }
    }

    /// Pure: feed a `BlockFinished` event for `session`. Returns the
    /// `(TaskCtx, Decision)` the bus loop should act on, or None when
    /// no task is attached to `session` or the decision is suppressed.
    pub fn observe_block_finished(
        &mut self,
        session: SessionId,
        command: &str,
        exit_code: Option<i32>,
        now: Instant,
    ) -> Option<(TaskCtx, Decision)> {
        let ctx = self.by_session.get_mut(&session)?;
        let nonzero = matches!(exit_code, Some(c) if c != 0);
        if nonzero {
            ctx.saw_failed_block = true;
        }
        let decision = if !nonzero {
            if matches!(ctx.status, TaskStatus::Blocked) {
                ctx.status = TaskStatus::Active;
                ctx.status_at = now;
                ctx.retry_count = 0;
                ctx.last_failed_cmd = None;
                if self
                    .resolver
                    .decide(ctx.operator_id, ctx.task_id, Sentiment::Feliz, true, now)
                {
                    Decision::Transition {
                        new_status: TaskStatus::Active,
                        kind: UpdateKind::Resumed,
                        sentiment: Sentiment::Feliz,
                    }
                } else {
                    Decision::Nothing
                }
            } else {
                ctx.retry_count = 0;
                ctx.last_failed_cmd = None;
                Decision::Nothing
            }
        } else {
            if ctx.last_failed_cmd.as_deref() == Some(command) {
                ctx.retry_count = ctx.retry_count.saturating_add(1);
            } else {
                ctx.retry_count = 1;
                ctx.last_failed_cmd = Some(command.to_string());
            }
            if !matches!(ctx.status, TaskStatus::Blocked) {
                ctx.status = TaskStatus::Blocked;
                ctx.ever_blocked = true;
                ctx.status_at = now;
                if self
                    .resolver
                    .decide(ctx.operator_id, ctx.task_id, Sentiment::Duda, true, now)
                {
                    Decision::Transition {
                        new_status: TaskStatus::Blocked,
                        kind: UpdateKind::Blocked,
                        sentiment: Sentiment::Duda,
                    }
                } else {
                    Decision::Nothing
                }
            } else if ctx.retry_count >= 3 {
                if self
                    .resolver
                    .decide(ctx.operator_id, ctx.task_id, Sentiment::Enojo, true, now)
                {
                    Decision::Sentiment {
                        kind: UpdateKind::Blocked,
                        sentiment: Sentiment::Enojo,
                    }
                } else {
                    Decision::Nothing
                }
            } else {
                Decision::Nothing
            }
        };
        if matches!(decision, Decision::Nothing) {
            return None;
        }
        Some((ctx.clone(), decision))
    }

    /// Pure: scan the registered tasks and return decisions for any whose
    /// time-in-Blocked has crossed an escalation threshold.
    pub fn tick(&mut self, now: Instant) -> Vec<(TaskCtx, Decision)> {
        let mut out = Vec::new();
        for ctx in self.by_session.values_mut() {
            if !matches!(ctx.status, TaskStatus::Blocked) {
                continue;
            }
            let elapsed = now.duration_since(ctx.status_at);
            let candidate = if elapsed >= Duration::from_secs(15 * 60) || ctx.retry_count >= 3 {
                Sentiment::Triste
            } else if elapsed >= Duration::from_secs(5 * 60) {
                Sentiment::Incomodidad
            } else {
                continue;
            };
            if self
                .resolver
                .decide(ctx.operator_id, ctx.task_id, candidate, false, now)
            {
                out.push((
                    ctx.clone(),
                    Decision::Sentiment {
                        kind: UpdateKind::Blocked,
                        sentiment: candidate,
                    },
                ));
            }
        }
        out
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TaskFlags {
    pub saw_failed_block: bool,
    pub ever_blocked: bool,
}

impl Inner {
    pub fn flags(&self, session: SessionId) -> Option<TaskFlags> {
        self.by_session.get(&session).map(|c| TaskFlags {
            saw_failed_block: c.saw_failed_block,
            ever_blocked: c.ever_blocked,
        })
    }

    pub fn operator_for(&self, session: SessionId) -> Option<OperatorId> {
        self.by_session.get(&session).map(|c| c.operator_id)
    }
}

impl TaskSupervisor {
    /// Read the accumulated per-task flags for `session`, if still tracked.
    /// Call before `forget_task`.
    pub fn task_flags(&self, session: SessionId) -> Option<TaskFlags> {
        self.inner.lock().flags(session)
    }
}

/// Sink for synth `TaskMessage`s the supervisor produces. Production
/// uses `tauri::AppHandle` (emits to the webview); tests use an
/// in-memory capturing impl so the supervisor can be exercised
/// without a real Tauri runtime.
pub trait MessageEmitter: Send + Sync {
    fn emit_message(&self, msg: &TaskMessage);
}

impl MessageEmitter for tauri::AppHandle {
    fn emit_message(&self, msg: &TaskMessage) {
        use tauri::Emitter;
        let _ = self.emit("teammate-message", msg);
    }
}

pub struct TaskSupervisor {
    inner: Arc<Mutex<Inner>>,
    storage: Arc<Storage>,
    runtime: Arc<TeammateRuntime>,
    app: Arc<dyn MessageEmitter>,
}

impl TaskSupervisor {
    pub fn new(
        storage: Arc<Storage>,
        runtime: Arc<TeammateRuntime>,
        app: Arc<dyn MessageEmitter>,
    ) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::new(Duration::from_secs(60)))),
            storage,
            runtime,
            app,
        }
    }

    /// Register a task once its session is attached. Idempotent.
    pub fn register_task(&self, session: SessionId, task_id: TaskId, op: OperatorId) {
        self.inner.lock().register(
            session,
            TaskCtx {
                task_id,
                operator_id: op,
                status: TaskStatus::Active,
                status_at: Instant::now(),
                retry_count: 0,
                last_failed_cmd: None,
                saw_failed_block: false,
                ever_blocked: false,
            },
        );
    }

    pub fn forget_task(&self, session: SessionId) {
        self.inner.lock().unregister(session);
    }
}

impl TaskSupervisor {
    /// Subscribe to the bus and run forever. Spawned at app boot.
    /// Owns two tokio tasks: the event drain + the 30s tick.
    pub fn spawn(self: Arc<Self>, bus_rx: broadcast::Receiver<karl_session::SessionEvent>) {
        // Called from Tauri's `setup` callback, which runs before tokio's
        // runtime is bound to the current thread; `tokio::spawn` panics
        // with "no reactor running" there. `tauri::async_runtime::spawn`
        // resolves to the right executor regardless of context.
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            me.run_bus(bus_rx).await;
        });
        let me = self.clone();
        tauri::async_runtime::spawn(async move {
            me.run_tick().await;
        });
    }

    async fn run_bus(self: Arc<Self>, mut rx: broadcast::Receiver<karl_session::SessionEvent>) {
        loop {
            match rx.recv().await {
                Ok(karl_session::SessionEvent::BlockFinished {
                    session,
                    command,
                    exit_code,
                    cwd,
                    ..
                }) => {
                    let decision = {
                        let mut g = self.inner.lock();
                        g.observe_block_finished(session, &command, exit_code, Instant::now())
                    };
                    // build_steward: a passing build/test/lint attributable to
                    // the task's operator. Resolve operator from the tracked
                    // TaskCtx; skip if the session isn't a tracked task.
                    if matches!(exit_code, Some(0)) {
                        if let Some(kind) =
                            crate::teammate::build_classify::classify_command(&command)
                        {
                            let op = { self.inner.lock().operator_for(session) };
                            if let Some(op) = op {
                                if let Some(repo) = karl_score::context::repo_name_for_cwd(&cwd) {
                                    karl_score::record_build_pass(
                                        kind,
                                        &op.to_string(),
                                        &repo,
                                        &command,
                                    );
                                }
                            }
                        }
                    }
                    if let Some((ctx, d)) = decision {
                        self.apply_decision(ctx, d).await;
                    }
                }
                Ok(karl_session::SessionEvent::Closed { session }) => {
                    self.inner.lock().unregister(session);
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    warn!(target: "teammate::supervisor", "bus lagged {n} events");
                }
                Err(broadcast::error::RecvError::Closed) => break,
            }
        }
    }

    async fn run_tick(self: Arc<Self>) {
        let mut iv = tokio::time::interval(Duration::from_secs(30));
        // first tick fires immediately — skip it so we don't spam on boot
        iv.tick().await;
        loop {
            iv.tick().await;
            let pending = {
                let mut g = self.inner.lock();
                g.tick(Instant::now())
            };
            for (ctx, d) in pending {
                self.apply_decision(ctx, d).await;
            }
        }
    }

    async fn apply_decision(&self, ctx: TaskCtx, d: Decision) {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let (kind, sentiment) = match d {
            Decision::Transition {
                new_status,
                kind,
                sentiment,
            } => {
                if let Err(e) = self
                    .storage
                    .teammate_update_task_status(ctx.task_id, new_status, now_ms)
                    .await
                {
                    warn!(target: "teammate::supervisor",
                        task_id = ?ctx.task_id, ?new_status, error = %e, "status update failed");
                    return;
                }
                (kind, sentiment)
            }
            Decision::Sentiment { kind, sentiment } => (kind, sentiment),
            Decision::Nothing => return,
        };
        let msg = TaskMessage {
            id: MessageId::new(),
            operator_id: ctx.operator_id,
            task_id: Some(ctx.task_id),
            thread_id: None,
            role: Role::System,
            content: MessageContent::TaskUpdate {
                task: ctx.task_id,
                kind,
            },
            created_at_unix_ms: now_ms,
            confirmed_at_unix_ms: None,
            dismissed_at_unix_ms: None,
            sentiment: Some(sentiment),
        };
        if let Err(e) = self.storage.teammate_insert_message(&msg).await {
            warn!(target: "teammate::supervisor",
                error = %e, "insert synth TaskUpdate failed");
            return;
        }
        self.app.emit_message(&msg);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::SessionId;
    use ulid::Ulid;

    fn op() -> OperatorId {
        OperatorId(Ulid::new())
    }
    fn ctx(op: OperatorId, task: TaskId) -> TaskCtx {
        TaskCtx {
            task_id: task,
            operator_id: op,
            status: TaskStatus::Active,
            status_at: Instant::now(),
            retry_count: 0,
            last_failed_cmd: None,
            saw_failed_block: false,
            ever_blocked: false,
        }
    }

    #[test]
    fn unknown_session_returns_none() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let s = SessionId::new();
        assert!(inner
            .observe_block_finished(s, "ls", Some(0), Instant::now())
            .is_none());
    }

    #[test]
    fn first_failure_transitions_to_blocked_duda() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let (_c, d) = inner
            .observe_block_finished(s, "cargo test", Some(1), Instant::now())
            .unwrap();
        assert_eq!(
            d,
            Decision::Transition {
                new_status: TaskStatus::Blocked,
                kind: UpdateKind::Blocked,
                sentiment: Sentiment::Duda,
            }
        );
    }

    #[test]
    fn three_consecutive_same_failures_emit_enojo() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let t = Instant::now();
        inner.observe_block_finished(s, "cargo test", Some(1), t); // duda
        let _ = inner.observe_block_finished(s, "cargo test", Some(1), t); // count=2, nothing
        let (_c, d) = inner
            .observe_block_finished(s, "cargo test", Some(1), t)
            .unwrap();
        assert_eq!(
            d,
            Decision::Sentiment {
                kind: UpdateKind::Blocked,
                sentiment: Sentiment::Enojo,
            }
        );
    }

    #[test]
    fn different_command_resets_retry_count() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let t = Instant::now();
        inner.observe_block_finished(s, "cargo test", Some(1), t);
        inner.observe_block_finished(s, "cargo test", Some(1), t);
        let r = inner.observe_block_finished(s, "cargo build", Some(1), t);
        assert!(r.is_none());
    }

    #[test]
    fn success_after_block_resumes_with_feliz() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let t = Instant::now();
        inner.observe_block_finished(s, "cargo test", Some(1), t);
        let (_c, d) = inner
            .observe_block_finished(s, "cargo test", Some(0), t)
            .unwrap();
        assert_eq!(
            d,
            Decision::Transition {
                new_status: TaskStatus::Active,
                kind: UpdateKind::Resumed,
                sentiment: Sentiment::Feliz,
            }
        );
    }

    #[test]
    fn tick_promotes_to_incomodidad_after_5min() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let t = Instant::now();
        inner.observe_block_finished(s, "cargo test", Some(1), t); // duda
        let out = inner.tick(t + Duration::from_secs(5 * 60 + 1));
        assert_eq!(out.len(), 1);
        match &out[0].1 {
            Decision::Sentiment { sentiment, .. } => assert_eq!(*sentiment, Sentiment::Incomodidad),
            _ => panic!("expected Sentiment decision"),
        }
    }

    #[test]
    fn tick_promotes_to_triste_after_15min() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let t = Instant::now();
        inner.observe_block_finished(s, "cargo test", Some(1), t);
        let out = inner.tick(t + Duration::from_secs(15 * 60 + 1));
        match &out[0].1 {
            Decision::Sentiment { sentiment, .. } => assert_eq!(*sentiment, Sentiment::Triste),
            _ => panic!("expected Sentiment decision"),
        }
    }

    #[test]
    fn tick_idempotent_when_already_emitted() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let t = Instant::now();
        inner.observe_block_finished(s, "cargo test", Some(1), t);
        let _ = inner.tick(t + Duration::from_secs(5 * 60 + 1));
        let again = inner.tick(t + Duration::from_secs(5 * 60 + 30));
        assert!(again.is_empty());
    }

    #[test]
    fn flags_track_failure_and_recovery() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let t = Instant::now();

        // clean so far
        let f0 = inner.flags(s).unwrap();
        assert!(!f0.saw_failed_block);
        assert!(!f0.ever_blocked);

        inner.observe_block_finished(s, "cargo test", Some(1), t); // fail -> blocked
        let f1 = inner.flags(s).unwrap();
        assert!(f1.saw_failed_block);
        assert!(f1.ever_blocked);

        inner.observe_block_finished(s, "cargo test", Some(0), t); // recover
        let f2 = inner.flags(s).unwrap();
        assert!(
            f2.saw_failed_block,
            "failure flag is sticky for the task lifetime"
        );
        assert!(f2.ever_blocked, "ever_blocked is sticky");
    }

    #[test]
    fn flags_clean_when_no_failures() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        inner.observe_block_finished(s, "ls", Some(0), Instant::now());
        let f = inner.flags(s).unwrap();
        assert!(!f.saw_failed_block);
        assert!(!f.ever_blocked);
    }

    #[test]
    fn flags_none_for_unknown_session() {
        let inner = Inner::new(Duration::from_secs(60));
        assert!(inner.flags(SessionId::new()).is_none());
    }
}
