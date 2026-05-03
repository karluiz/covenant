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

use crate::storage::Storage;
use karl_session::SessionId;
use std::collections::HashMap;
use std::sync::RwLock;

pub struct OperatorRegistry {
    by_id: RwLock<HashMap<OperatorId, Operator>>,
    pins: RwLock<HashMap<SessionId, OperatorId>>,
}

impl OperatorRegistry {
    pub async fn load(storage: &Storage) -> Result<Self, RegistryError> {
        let rows = storage.operator_list().await?;
        let mut by_id = HashMap::new();
        for op in rows {
            by_id.insert(op.id, op);
        }
        Ok(Self {
            by_id: RwLock::new(by_id),
            pins: RwLock::new(HashMap::new()),
        })
    }

    pub fn list(&self) -> Vec<Operator> {
        let g = self.by_id.read().unwrap();
        let mut v: Vec<_> = g.values().cloned().collect();
        v.sort_by(|a, b| {
            b.is_default
                .cmp(&a.is_default)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        v
    }

    pub fn get(&self, id: OperatorId) -> Option<Operator> {
        self.by_id.read().unwrap().get(&id).cloned()
    }

    pub fn default(&self) -> Option<Operator> {
        self.by_id
            .read()
            .unwrap()
            .values()
            .find(|o| o.is_default)
            .cloned()
    }

    fn validate(op: &Operator) -> Result<(), RegistryError> {
        let n = op.name.trim();
        if n.is_empty() || n.len() > 64 {
            return Err(RegistryError::InvalidName);
        }
        if !(0.0..=1.0).contains(&op.escalate_threshold) {
            return Err(RegistryError::InvalidThreshold);
        }
        Ok(())
    }

    pub async fn create(
        &self,
        storage: &Storage,
        mut op: Operator,
    ) -> Result<Operator, RegistryError> {
        Self::validate(&op)?;
        // Case-insensitive name uniqueness
        {
            let g = self.by_id.read().unwrap();
            if g.values()
                .any(|o| o.name.eq_ignore_ascii_case(&op.name))
            {
                return Err(RegistryError::DuplicateName(op.name));
            }
            // If caller asked for default but a default already exists,
            // demote the new one — set_default is the explicit promote path.
            if op.is_default && g.values().any(|o| o.is_default) {
                op.is_default = false;
            }
            // Conversely, if no default exists yet, force this one.
            if g.values().all(|o| !o.is_default) {
                op.is_default = true;
            }
        }
        storage.operator_insert(op.clone()).await?;
        self.by_id.write().unwrap().insert(op.id, op.clone());
        Ok(op)
    }

    pub async fn update(
        &self,
        storage: &Storage,
        op: Operator,
    ) -> Result<Operator, RegistryError> {
        Self::validate(&op)?;
        {
            let g = self.by_id.read().unwrap();
            if !g.contains_key(&op.id) {
                return Err(RegistryError::NotFound(op.id));
            }
            if g.values()
                .any(|o| o.id != op.id && o.name.eq_ignore_ascii_case(&op.name))
            {
                return Err(RegistryError::DuplicateName(op.name));
            }
        }
        storage.operator_update(op.clone()).await?;
        self.by_id.write().unwrap().insert(op.id, op.clone());
        Ok(op)
    }

    pub async fn delete(
        &self,
        storage: &Storage,
        id: OperatorId,
    ) -> Result<(), RegistryError> {
        {
            let g = self.by_id.read().unwrap();
            let row = g.get(&id).ok_or(RegistryError::NotFound(id))?;
            if row.is_default {
                return Err(RegistryError::DefaultProtected);
            }
        }
        storage.operator_delete(id.to_string()).await?;
        self.by_id.write().unwrap().remove(&id);
        // Forget any session pins to this id (caller's responsibility
        // to fall back to default after the call — see effective_for).
        self.pins.write().unwrap().retain(|_, v| *v != id);
        Ok(())
    }

    pub async fn set_default(
        &self,
        storage: &Storage,
        id: OperatorId,
    ) -> Result<(), RegistryError> {
        if !self.by_id.read().unwrap().contains_key(&id) {
            return Err(RegistryError::NotFound(id));
        }
        storage.operator_set_default(id.to_string()).await?;
        let mut g = self.by_id.write().unwrap();
        for (oid, row) in g.iter_mut() {
            row.is_default = *oid == id;
        }
        Ok(())
    }

    pub fn pin_session(&self, session_id: SessionId, id: OperatorId) {
        self.pins.write().unwrap().insert(session_id, id);
    }

    pub fn unpin_session(&self, session_id: SessionId) {
        self.pins.write().unwrap().remove(&session_id);
    }

    pub fn pinned(&self, session_id: SessionId) -> Option<OperatorId> {
        self.pins.read().unwrap().get(&session_id).copied()
    }

    /// The operator that should drive AOM for this session right now.
    /// Resolution: explicit pin → default → panic (registry must always
    /// have a default after migration; absence is a programmer bug).
    pub fn effective_for(&self, session_id: SessionId) -> Operator {
        if let Some(id) = self.pinned(session_id) {
            if let Some(op) = self.get(id) {
                return op;
            }
        }
        self.default()
            .expect("operator registry has no default — migration did not run")
    }
}
