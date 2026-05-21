//! Per-operator state machine for the teammate layer.
//!
//! Phase 1: in-memory map of `OperatorId → OperatorState` with safe
//! transitions. The event loop is a stub — Phase 2 plugs LLM dispatch
//! and DM threads into it.
//!
//! Concurrency: a single `parking_lot::Mutex` guarding a `HashMap`.
//! Reads are infrequent and short. If contention becomes visible
//! later we shard or move to a sharded DashMap.

use std::collections::HashMap;
use std::sync::Arc;

use karl_session::SessionId;
use parking_lot::Mutex;
use thiserror::Error;

use crate::operator_registry::OperatorId;
use crate::teammate::types::{OperatorState, TaskId};

#[derive(Error, Debug)]
pub enum TransitionError {
    #[error("operator already on task")]
    AlreadyOnTask,
    #[error("operator not on task {0:?}")]
    NotOnExpectedTask(TaskId),
}

#[derive(Clone)]
pub struct TeammateRuntime {
    inner: Arc<Mutex<HashMap<OperatorId, OperatorState>>>,
}

impl TeammateRuntime {
    pub fn new() -> Self {
        Self { inner: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn state(&self, op: OperatorId) -> Option<OperatorState> {
        self.inner.lock().get(&op).cloned()
    }

    /// Idle | Pinned(_)  → Pinned(session). OnTask is rejected.
    pub fn pin(&self, op: OperatorId, session: SessionId) -> Result<(), TransitionError> {
        let mut guard = self.inner.lock();
        if matches!(guard.get(&op), Some(OperatorState::OnTask { .. })) {
            return Err(TransitionError::AlreadyOnTask);
        }
        guard.insert(op, OperatorState::Pinned { session });
        Ok(())
    }

    pub fn unpin(&self, op: OperatorId) {
        let mut guard = self.inner.lock();
        if matches!(guard.get(&op), Some(OperatorState::Pinned { .. })) {
            guard.insert(op, OperatorState::Idle);
        }
    }

    /// Any non-OnTask state → OnTask(task, session). Pinned auto-unpins
    /// silently (the UI is responsible for the user-visible warning).
    pub fn start_task(
        &self,
        op: OperatorId,
        task: TaskId,
        session: Option<SessionId>,
    ) -> Result<(), TransitionError> {
        let mut guard = self.inner.lock();
        if matches!(guard.get(&op), Some(OperatorState::OnTask { .. })) {
            return Err(TransitionError::AlreadyOnTask);
        }
        guard.insert(op, OperatorState::OnTask { task, session });
        Ok(())
    }

    /// OnTask(task, _) → Idle. Mismatched task id is an error.
    pub fn finish_task(&self, op: OperatorId, task: TaskId) -> Result<(), TransitionError> {
        let mut guard = self.inner.lock();
        match guard.get(&op) {
            Some(OperatorState::OnTask { task: t, .. }) if *t == task => {
                guard.insert(op, OperatorState::Idle);
                Ok(())
            }
            _ => Err(TransitionError::NotOnExpectedTask(task)),
        }
    }
}

impl Default for TeammateRuntime {
    fn default() -> Self { Self::new() }
}
