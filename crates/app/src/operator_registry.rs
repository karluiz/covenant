//! Operator roster: persisted list of operator personas the user can
//! pin per tab. Replaces the singular `OperatorConfig.persona` as the
//! source of truth for AOM prompts.
//!
//! Storage lives in `Storage` (sqlite). This module owns the in-memory
//! cache + CRUD façade + first-boot seed-from-settings migration.

use serde::{Deserialize, Serialize};
use ulid::Ulid;

#[derive(Debug, Clone, Copy, Hash, Eq, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct OperatorId(pub Ulid);

impl std::fmt::Display for OperatorId {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl std::str::FromStr for OperatorId {
    type Err = ulid::DecodeError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Ulid::from_string(s).map(OperatorId)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operator {
    pub id: OperatorId,
    pub name: String,
    pub emoji: String,
    pub color: String,             // "#RRGGBB"
    pub tags: Vec<String>,
    pub persona: String,
    pub escalate_threshold: f32,   // 0.0..=1.0
    pub model: String,             // model id, e.g. "claude-sonnet-4-6"
    pub hard_constraints: String,  // free-text addition to ALWAYS-ASK-ME
    pub is_default: bool,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
}

#[derive(Debug, thiserror::Error)]
pub enum RegistryError {
    #[error("operator not found: {0}")]
    NotFound(OperatorId),
    #[error("name '{0}' is already in use")]
    DuplicateName(String),
    #[error("cannot delete the default operator")]
    DefaultProtected,
    #[error("name must be 1..=64 non-whitespace characters")]
    InvalidName,
    #[error("escalate_threshold must be in 0.0..=1.0")]
    InvalidThreshold,
    #[error("storage: {0}")]
    Storage(#[from] crate::storage::StorageError),
}
