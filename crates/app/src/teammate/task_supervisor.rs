//! Background watcher that turns `SessionEvent`s into operator sentiment
//! and task-status transitions. Pure state-machine lives in
//! `Inner::observe_block_finished`; the bus loop in `run` wraps it.

#![allow(unused_imports)]
#![allow(dead_code)]

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_session::SessionId;
use parking_lot::Mutex;
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;
use tracing::warn;

use crate::operator_registry::OperatorId;
use crate::storage::Storage;
use crate::teammate::runtime::TeammateRuntime;
use crate::teammate::sentiment_resolver::SentimentResolver;
use crate::teammate::types::{
    MessageContent, MessageId, Role, Sentiment, TaskId, TaskMessage,
    TaskStatus, UpdateKind,
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
}

/// Decision returned by the pure observer. The bus loop turns this into
/// storage writes + Tauri emits.
#[derive(Debug, PartialEq, Eq)]
pub enum Decision {
    /// Update status in storage to `new_status` and emit a TaskUpdate
    /// synth message with `(kind, sentiment)`.
    Transition { new_status: TaskStatus, kind: UpdateKind, sentiment: Sentiment },
    /// Emit only a TaskUpdate with this sentiment; no status change.
    /// Used for `enojo` while already Blocked.
    Sentiment { kind: UpdateKind, sentiment: Sentiment },
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
        Self { by_session: HashMap::new(), resolver: SentimentResolver::new(min_interval) }
    }

    pub fn register(&mut self, session: SessionId, ctx: TaskCtx) {
        self.by_session.insert(session, ctx);
    }

    pub fn unregister(&mut self, session: SessionId) {
        self.by_session.remove(&session);
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
        let decision = if !nonzero {
            if matches!(ctx.status, TaskStatus::Blocked) {
                ctx.status = TaskStatus::Active;
                ctx.status_at = now;
                ctx.retry_count = 0;
                ctx.last_failed_cmd = None;
                if self.resolver.decide(ctx.operator_id, ctx.task_id, Sentiment::Feliz, true, now) {
                    Decision::Transition {
                        new_status: TaskStatus::Active,
                        kind: UpdateKind::Resumed,
                        sentiment: Sentiment::Feliz,
                    }
                } else { Decision::Nothing }
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
                ctx.status_at = now;
                if self.resolver.decide(ctx.operator_id, ctx.task_id, Sentiment::Duda, true, now) {
                    Decision::Transition {
                        new_status: TaskStatus::Blocked,
                        kind: UpdateKind::Blocked,
                        sentiment: Sentiment::Duda,
                    }
                } else { Decision::Nothing }
            } else if ctx.retry_count >= 3 {
                if self.resolver.decide(ctx.operator_id, ctx.task_id, Sentiment::Enojo, true, now) {
                    Decision::Sentiment { kind: UpdateKind::Blocked, sentiment: Sentiment::Enojo }
                } else { Decision::Nothing }
            } else {
                Decision::Nothing
            }
        };
        if matches!(decision, Decision::Nothing) { return None; }
        Some((ctx.clone(), decision))
    }

    /// Pure: scan the registered tasks and return decisions for any whose
    /// time-in-Blocked has crossed an escalation threshold.
    pub fn tick(&mut self, now: Instant) -> Vec<(TaskCtx, Decision)> {
        let mut out = Vec::new();
        for ctx in self.by_session.values_mut() {
            if !matches!(ctx.status, TaskStatus::Blocked) { continue; }
            let elapsed = now.duration_since(ctx.status_at);
            let candidate = if elapsed >= Duration::from_secs(15 * 60) || ctx.retry_count >= 3 {
                Sentiment::Triste
            } else if elapsed >= Duration::from_secs(5 * 60) {
                Sentiment::Incomodidad
            } else {
                continue;
            };
            if self.resolver.decide(ctx.operator_id, ctx.task_id, candidate, false, now) {
                out.push((ctx.clone(), Decision::Sentiment {
                    kind: UpdateKind::Blocked,
                    sentiment: candidate,
                }));
            }
        }
        out
    }
}

pub struct TaskSupervisor {
    inner: Arc<Mutex<Inner>>,
    storage: Arc<Storage>,
    runtime: Arc<TeammateRuntime>,
    app: AppHandle,
}

impl TaskSupervisor {
    pub fn new(storage: Arc<Storage>, runtime: Arc<TeammateRuntime>, app: AppHandle) -> Self {
        Self {
            inner: Arc::new(Mutex::new(Inner::new(Duration::from_secs(60)))),
            storage, runtime, app,
        }
    }

    /// Register a task once its session is attached. Idempotent.
    pub fn register_task(&self, session: SessionId, task_id: TaskId, op: OperatorId) {
        self.inner.lock().register(session, TaskCtx {
            task_id, operator_id: op,
            status: TaskStatus::Active,
            status_at: Instant::now(),
            retry_count: 0,
            last_failed_cmd: None,
        });
    }

    pub fn forget_task(&self, session: SessionId) {
        self.inner.lock().unregister(session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::SessionId;
    use ulid::Ulid;

    fn op() -> OperatorId { OperatorId(Ulid::new()) }
    fn ctx(op: OperatorId, task: TaskId) -> TaskCtx {
        TaskCtx {
            task_id: task, operator_id: op,
            status: TaskStatus::Active,
            status_at: Instant::now(),
            retry_count: 0,
            last_failed_cmd: None,
        }
    }

    #[test]
    fn unknown_session_returns_none() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let s = SessionId::new();
        assert!(inner.observe_block_finished(s, "ls", Some(0), Instant::now()).is_none());
    }

    #[test]
    fn first_failure_transitions_to_blocked_duda() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let (_c, d) = inner.observe_block_finished(s, "cargo test", Some(1), Instant::now()).unwrap();
        assert_eq!(d, Decision::Transition {
            new_status: TaskStatus::Blocked,
            kind: UpdateKind::Blocked,
            sentiment: Sentiment::Duda,
        });
    }

    #[test]
    fn three_consecutive_same_failures_emit_enojo() {
        let mut inner = Inner::new(Duration::from_secs(60));
        let (o, task) = (op(), TaskId::new());
        let s = SessionId::new();
        inner.register(s, ctx(o, task));
        let t = Instant::now();
        inner.observe_block_finished(s, "cargo test", Some(1), t);        // duda
        let _ = inner.observe_block_finished(s, "cargo test", Some(1), t);          // count=2, nothing
        let (_c, d) = inner.observe_block_finished(s, "cargo test", Some(1), t).unwrap();
        assert_eq!(d, Decision::Sentiment {
            kind: UpdateKind::Blocked, sentiment: Sentiment::Enojo,
        });
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
        let (_c, d) = inner.observe_block_finished(s, "cargo test", Some(0), t).unwrap();
        assert_eq!(d, Decision::Transition {
            new_status: TaskStatus::Active, kind: UpdateKind::Resumed, sentiment: Sentiment::Feliz,
        });
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
}
