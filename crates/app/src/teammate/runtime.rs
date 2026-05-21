//! Per-operator state machine for the teammate runtime. Lands in Task 5.

use crate::operator_registry::OperatorId;
use std::collections::HashMap;
use std::sync::Arc;
use parking_lot::Mutex;

use crate::teammate::types::OperatorState;

/// Placeholder so `mod.rs` re-exports compile. Real implementation lands in Task 5.
#[derive(Clone, Default)]
pub struct TeammateRuntime {
    _inner: Arc<Mutex<HashMap<OperatorId, OperatorState>>>,
}

impl TeammateRuntime {
    pub fn new() -> Self { Self::default() }
}
