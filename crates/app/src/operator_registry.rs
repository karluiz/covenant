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
    pub color: String, // "#RRGGBB"
    pub tags: Vec<String>,
    pub persona: String,
    pub escalate_threshold: f32,  // 0.0..=1.0
    pub model: String,            // model id, e.g. "claude-sonnet-4-6"
    pub hard_constraints: String, // free-text addition to ALWAYS-ASK-ME
    pub is_default: bool,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    /// Accumulated experience points (3.12). Awarded per operator
    /// decision: reply=10, escalate=25, wait=1. Level is computed on
    /// the UI as `floor(xp / 100) + 1`.
    #[serde(default)]
    pub xp: u64,
    /// Tone applied to outbound messages (Telegram summaries, banner text).
    #[serde(default)]
    pub voice: VoiceTone,
    /// Path to this operator's SOUL.md (source of truth for identity).
    /// `None` only transiently before migration backfills it.
    #[serde(default)]
    pub soul_path: Option<std::path::PathBuf>,
    /// Last-seen mtime of `soul_path`, for hot-reload change detection.
    /// Not persisted; recomputed on load.
    #[serde(default, skip)]
    pub soul_mtime_unix_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum VoiceTone {
    #[default]
    Terse,
    Warm,
    Formal,
}

/// System-prompt directive describing how the operator should speak,
/// derived from its configured `VoiceTone`. Appended to the per-operator
/// system prompt so the LLM's outbound replies match the operator's voice.
pub fn voice_directive(tone: VoiceTone) -> &'static str {
    match tone {
        VoiceTone::Terse => "Voice: terse. Strip pleasantries. Max ~12 words per outbound line.",
        VoiceTone::Warm => "Voice: warm. Conversational, first person allowed. Stay concise.",
        VoiceTone::Formal => "Voice: formal. No contractions. Full sentences. Direct and precise.",
    }
}

impl Operator {
    /// Project this `Operator` to the lightweight `karl_session::OperatorRef`
    /// used by session events and IPC. Keeps `ulid` / app-only types out of
    /// the session crate.
    pub fn to_session_ref(&self) -> karl_session::OperatorRef {
        karl_session::OperatorRef {
            id: self.id.to_string(),
            name: self.name.clone(),
            emoji: self.emoji.clone(),
            color: self.color.clone(),
            voice: match self.voice {
                VoiceTone::Terse => karl_session::VoiceToneSnapshot::Terse,
                VoiceTone::Warm => karl_session::VoiceToneSnapshot::Warm,
                VoiceTone::Formal => karl_session::VoiceToneSnapshot::Formal,
            },
        }
    }
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
    souls_dir: std::path::PathBuf,
}

impl OperatorRegistry {
    pub async fn load(
        storage: &Storage,
        souls_dir: std::path::PathBuf,
    ) -> Result<Self, RegistryError> {
        let rows = storage.operator_list().await?;
        let mut by_id = HashMap::new();
        for mut op in rows {
            if let Some(path) = op.soul_path.clone() {
                match std::fs::read_to_string(&path) {
                    Ok(raw) => match crate::soul::parse(&raw) {
                        Ok(soul) => {
                            crate::soul::hydrate_operator(&mut op, &soul);
                            op.soul_mtime_unix_ms = crate::soul::mtime_of(&path).unwrap_or(0);
                        }
                        Err(e) => tracing::warn!(path = %path.display(), error = %e,
                            "SOUL.md parse failed; using DB cache"),
                    },
                    Err(e) => tracing::warn!(path = %path.display(), error = %e,
                        "SOUL.md unreadable; using DB cache"),
                }
            }
            by_id.insert(op.id, op);
        }
        Ok(Self {
            by_id: RwLock::new(by_id),
            pins: RwLock::new(HashMap::new()),
            souls_dir,
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

    /// Re-stat every operator's SOUL.md; for any whose mtime changed, re-parse
    /// and re-hydrate the in-memory operator. Returns the number reloaded.
    /// Disk I/O only — does not touch the DB (the file is the source of truth).
    pub fn refresh_changed_souls(&self) -> usize {
        let candidates: Vec<(OperatorId, std::path::PathBuf, u64)> = {
            let g = self.by_id.read().unwrap();
            g.values()
                .filter_map(|o| o.soul_path.clone().map(|p| (o.id, p, o.soul_mtime_unix_ms)))
                .collect()
        };
        let mut n = 0;
        for (id, path, prev) in candidates {
            let Some(mt) = crate::soul::mtime_of(&path) else { continue };
            if mt == prev { continue; }
            match std::fs::read_to_string(&path).ok().and_then(|r| crate::soul::parse(&r).ok()) {
                Some(soul) => {
                    if let Some(op) = self.by_id.write().unwrap().get_mut(&id) {
                        crate::soul::hydrate_operator(op, &soul);
                        op.soul_mtime_unix_ms = mt;
                        n += 1;
                    }
                }
                None => tracing::warn!(path = %path.display(), "SOUL.md reload parse failed; keeping last-good"),
            }
        }
        n
    }

    /// Test helper: build an in-memory registry pre-populated with a
    /// single default operator. Avoids spinning up sqlite from tests.
    #[cfg(test)]
    pub(crate) fn for_tests(default_name: &str) -> std::sync::Arc<Self> {
        let mut by_id = HashMap::new();
        let op = Operator {
            id: OperatorId(Ulid::new()),
            name: default_name.to_string(),
            emoji: "🟣".into(),
            color: "#a855f7".into(),
            tags: vec![],
            persona: String::new(),
            escalate_threshold: 0.5,
            model: "claude-sonnet-4-6".into(),
            hard_constraints: String::new(),
            is_default: true,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
            voice: VoiceTone::default(),
            soul_path: None,
            soul_mtime_unix_ms: 0,
        };
        by_id.insert(op.id, op);
        std::sync::Arc::new(Self {
            by_id: RwLock::new(by_id),
            pins: RwLock::new(HashMap::new()),
            souls_dir: std::env::temp_dir().join("covenant-test-souls"),
        })
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

    /// kebab-case ascii slug for a directory name.
    fn slugify(name: &str) -> String {
        let mut out = String::new();
        let mut prev_dash = false;
        for ch in name.trim().chars() {
            if ch.is_ascii_alphanumeric() {
                out.push(ch.to_ascii_lowercase());
                prev_dash = false;
            } else if !prev_dash {
                out.push('-');
                prev_dash = true;
            }
        }
        let s = out.trim_matches('-').to_string();
        if s.is_empty() {
            "operator".into()
        } else {
            s
        }
    }

    /// Resolve a unique SOUL.md path for a new operator, avoiding collisions.
    fn soul_path_for(&self, name: &str, id: OperatorId) -> std::path::PathBuf {
        let base = Self::slugify(name);
        let dir = self.souls_dir.join(&base);
        if dir.exists() {
            let suffix = id.to_string().to_lowercase();
            let short = &suffix[suffix.len().saturating_sub(6)..];
            self.souls_dir
                .join(format!("{base}-{short}"))
                .join("SOUL.md")
        } else {
            dir.join("SOUL.md")
        }
    }

    /// Write an operator's identity to its SOUL.md (creating parent dirs).
    /// Returns the file's new mtime.
    fn write_soul(op: &Operator) -> Result<u64, RegistryError> {
        let path = op.soul_path.as_ref().ok_or_else(|| {
            RegistryError::Storage(crate::storage::StorageError::Other(
                "operator has no soul_path".into(),
            ))
        })?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                RegistryError::Storage(crate::storage::StorageError::Other(e.to_string()))
            })?;
        }
        let text = crate::soul::serialize(&crate::soul::soul_from_operator(op));
        std::fs::write(path, text).map_err(|e| {
            RegistryError::Storage(crate::storage::StorageError::Other(e.to_string()))
        })?;
        Ok(crate::soul::mtime_of(path).unwrap_or(0))
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
            if g.values().any(|o| o.name.eq_ignore_ascii_case(&op.name)) {
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
        if op.soul_path.is_none() {
            op.soul_path = Some(self.soul_path_for(&op.name, op.id));
        }
        op.soul_mtime_unix_ms = Self::write_soul(&op)?;
        storage.operator_insert(op.clone()).await?;
        self.by_id.write().unwrap().insert(op.id, op.clone());
        Ok(op)
    }

    pub async fn update(
        &self,
        storage: &Storage,
        mut op: Operator,
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
        if op.soul_path.is_none() {
            op.soul_path = self
                .by_id
                .read()
                .unwrap()
                .get(&op.id)
                .and_then(|o| o.soul_path.clone());
            if op.soul_path.is_none() {
                op.soul_path = Some(self.soul_path_for(&op.name, op.id));
            }
        }
        op.soul_mtime_unix_ms = Self::write_soul(&op)?;
        storage.operator_update(op.clone()).await?;
        self.by_id.write().unwrap().insert(op.id, op.clone());
        Ok(op)
    }

    pub async fn create_from_soul(
        &self,
        storage: &Storage,
        raw: &str,
    ) -> Result<Operator, RegistryError> {
        let soul = crate::soul::parse(raw).map_err(|e| {
            RegistryError::Storage(crate::storage::StorageError::Other(e.to_string()))
        })?;
        crate::soul::validate(&soul).map_err(|e| {
            RegistryError::Storage(crate::storage::StorageError::Other(e.to_string()))
        })?;
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let mut op = Operator {
            id: OperatorId(Ulid::new()), name: String::new(), emoji: String::new(),
            color: String::new(), tags: vec![], persona: String::new(),
            escalate_threshold: 0.6, model: String::new(), hard_constraints: String::new(),
            is_default: false, created_at_unix_ms: now, updated_at_unix_ms: now, xp: 0,
            voice: VoiceTone::Terse, soul_path: None, soul_mtime_unix_ms: 0,
        };
        crate::soul::hydrate_operator(&mut op, &soul);
        self.create(storage, op).await
    }

    pub async fn update_from_soul(
        &self,
        storage: &Storage,
        id: OperatorId,
        raw: &str,
    ) -> Result<Operator, RegistryError> {
        let soul = crate::soul::parse(raw).map_err(|e| {
            RegistryError::Storage(crate::storage::StorageError::Other(e.to_string()))
        })?;
        crate::soul::validate(&soul).map_err(|e| {
            RegistryError::Storage(crate::storage::StorageError::Other(e.to_string()))
        })?;
        let mut op = self.get(id).ok_or(RegistryError::NotFound(id))?;
        crate::soul::hydrate_operator(&mut op, &soul);
        op.updated_at_unix_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        self.update(storage, op).await
    }

    /// Read the current SOUL.md text for an operator (file content if present,
    /// else freshly serialized from the cached identity).
    pub fn read_soul(&self, id: OperatorId) -> Option<String> {
        let op = self.get(id)?;
        if let Some(p) = &op.soul_path {
            if let Ok(raw) = std::fs::read_to_string(p) {
                return Some(raw);
            }
        }
        Some(crate::soul::serialize(&crate::soul::soul_from_operator(&op)))
    }

    pub async fn delete(&self, storage: &Storage, id: OperatorId) -> Result<(), RegistryError> {
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

    /// 3.12: bump an operator's XP by `amount`. Returns the new total.
    /// Persists to SQLite and updates the in-memory cache atomically.
    /// No-op (returns current xp, or 0 if unknown) on missing operator.
    pub async fn award_xp(
        &self,
        storage: &Storage,
        id: OperatorId,
        amount: u64,
    ) -> Result<u64, RegistryError> {
        let new_total = storage.operator_award_xp(id.to_string(), amount).await?;
        if let Some(op) = self.by_id.write().unwrap().get_mut(&id) {
            op.xp = new_total;
        }
        Ok(new_total)
    }

    /// First-boot migration. If the registry already contains any
    /// operator row, this is a no-op (returns Ok(false)). Otherwise
    /// inserts a single `Default` row sourced from the legacy
    /// `OperatorConfig` charter and the global summary model, and
    /// backfills `operator_decisions.operator_id` for historical
    /// rows. Returns Ok(true) when the seed actually ran.
    pub async fn seed_default_from_settings(
        &self,
        storage: &Storage,
        cfg: &crate::settings::OperatorConfig,
        global_model: &str,
    ) -> Result<bool, RegistryError> {
        if !self.by_id.read().unwrap().is_empty() {
            return Ok(false);
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        let op = Operator {
            id: OperatorId(Ulid::new()),
            name: "Default".into(),
            emoji: "pack:oldbusinessman1".into(),
            color: "#6B7280".into(),
            tags: vec![],
            persona: cfg.persona.clone(),
            escalate_threshold: 0.6,
            model: global_model.to_string(),
            hard_constraints: "".into(),
            is_default: true,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
            xp: 0,
            voice: VoiceTone::default(),
            soul_path: None,
            soul_mtime_unix_ms: 0,
        };
        let id = op.id;
        let name = op.name.clone();
        self.create(storage, op).await?;
        // Backfill historical decisions.
        let _ = storage
            .operator_decisions_backfill(id.to_string(), name)
            .await?;
        Ok(true)
    }

    /// Backfill: any operator lacking a `soul_path` gets a SOUL.md written from
    /// its current DB fields (persona → body; hard_constraints → frontmatter).
    /// Idempotent — operators that already have a soul_path are skipped.
    pub async fn migrate_personas_to_souls(
        &self,
        storage: &Storage,
    ) -> Result<usize, RegistryError> {
        let to_migrate: Vec<Operator> = {
            let g = self.by_id.read().unwrap();
            g.values()
                .filter(|o| o.soul_path.is_none())
                .cloned()
                .collect()
        };
        let mut n = 0;
        for mut op in to_migrate {
            op.soul_path = Some(self.soul_path_for(&op.name, op.id));
            op.soul_mtime_unix_ms = Self::write_soul(&op)?;
            let path = op.soul_path.clone().unwrap();
            storage
                .operator_set_soul_path(op.id.to_string(), path.to_string_lossy().into_owned())
                .await?;
            self.by_id.write().unwrap().insert(op.id, op);
            n += 1;
        }
        Ok(n)
    }

    /// One-shot: bump the legacy `🤖` default-emoji to the new
    /// pack avatar. Idempotent — only runs against operators where
    /// emoji is exactly the legacy value, so user-customized emojis
    /// are preserved.
    pub async fn upgrade_legacy_default_avatar(
        &self,
        storage: &Storage,
    ) -> Result<usize, RegistryError> {
        let to_upgrade: Vec<OperatorId> = {
            let g = self.by_id.read().unwrap();
            g.values()
                .filter(|o| o.emoji == "🤖")
                .map(|o| o.id)
                .collect()
        };
        let n = to_upgrade.len();
        for id in to_upgrade {
            if let Some(mut op) = self.get(id) {
                op.emoji = "pack:oldbusinessman1".to_string();
                op.updated_at_unix_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                storage.operator_update(op.clone()).await?;
                self.by_id.write().unwrap().insert(id, op);
            }
        }
        Ok(n)
    }
}

pub mod commands {
    use super::*;
    use crate::storage::Storage;
    use karl_session::SessionId;
    use serde::{Deserialize, Serialize};
    use std::sync::Arc;
    use tauri::State;

    #[derive(Debug, Serialize, Deserialize)]
    pub struct OperatorDraft {
        pub name: String,
        pub emoji: String,
        pub color: String,
        pub tags: Vec<String>,
        pub persona: String,
        pub escalate_threshold: f32,
        pub model: String,
        pub hard_constraints: String,
        #[serde(default)]
        pub voice: VoiceTone,
    }

    fn now_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    fn map_err<E: std::fmt::Display>(e: E) -> String {
        e.to_string()
    }

    #[derive(Debug, Serialize, Deserialize)]
    pub struct SoulView {
        pub name: String,
        pub avatar: Option<String>,
        pub color: Option<String>,
        pub model: Option<String>,
        pub voice: Option<String>,
        pub escalate_threshold: Option<f32>,
        pub tags: Vec<String>,
        pub hard_constraints: Option<String>,
        pub body: String,
        pub validation_error: Option<String>,
    }

    #[tauri::command]
    pub async fn operator_list_archetypes() -> Result<Vec<crate::archetypes::ArchetypeView>, String> {
        Ok(crate::archetypes::list())
    }

    #[tauri::command]
    pub async fn operator_soul_read(
        id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<String, String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.read_soul(id).ok_or_else(|| format!("operator not found: {id}"))
    }

    /// Parse + validate raw SOUL.md text without persisting. Returns the parsed
    /// frontmatter view for the editor's synced form controls + live preview.
    #[tauri::command]
    pub async fn operator_soul_parse(raw: String) -> Result<SoulView, String> {
        let soul = crate::soul::parse(&raw).map_err(map_err)?;
        let err = crate::soul::validate(&soul).err().map(|e| e.to_string());
        Ok(SoulView {
            name: soul.frontmatter.name,
            avatar: soul.frontmatter.avatar,
            color: soul.frontmatter.color,
            model: soul.frontmatter.model,
            voice: soul.frontmatter.voice,
            escalate_threshold: soul.frontmatter.escalate_threshold,
            tags: soul.frontmatter.tags,
            hard_constraints: soul.frontmatter.hard_constraints,
            body: soul.body,
            validation_error: err,
        })
    }

    #[tauri::command]
    pub async fn operator_create_from_soul(
        raw: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<Operator, String> {
        registry.create_from_soul(&storage, &raw).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_update_from_soul(
        id: String,
        raw: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<Operator, String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.update_from_soul(&storage, id, &raw).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_list(
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<Vec<Operator>, String> {
        Ok(registry.list())
    }

    #[tauri::command]
    pub async fn operator_get(
        id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<Option<Operator>, String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        Ok(registry.get(id))
    }

    #[tauri::command]
    pub async fn operator_create(
        draft: OperatorDraft,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<Operator, String> {
        let now = now_ms();
        let op = Operator {
            id: OperatorId(Ulid::new()),
            name: draft.name,
            emoji: draft.emoji,
            color: draft.color,
            tags: draft.tags,
            persona: draft.persona,
            escalate_threshold: draft.escalate_threshold,
            model: draft.model,
            hard_constraints: draft.hard_constraints,
            is_default: false,
            created_at_unix_ms: now,
            updated_at_unix_ms: now,
            xp: 0,
            voice: draft.voice,
            soul_path: None,
            soul_mtime_unix_ms: 0,
        };
        registry.create(&storage, op).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_update(
        id: String,
        draft: OperatorDraft,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<Operator, String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        let existing = registry
            .get(id)
            .ok_or_else(|| format!("operator not found: {id}"))?;
        let updated = Operator {
            id,
            name: draft.name,
            emoji: draft.emoji,
            color: draft.color,
            tags: draft.tags,
            persona: draft.persona,
            escalate_threshold: draft.escalate_threshold,
            model: draft.model,
            hard_constraints: draft.hard_constraints,
            is_default: existing.is_default,
            created_at_unix_ms: existing.created_at_unix_ms,
            updated_at_unix_ms: now_ms(),
            xp: existing.xp,
            voice: draft.voice,
            soul_path: existing.soul_path.clone(),
            soul_mtime_unix_ms: existing.soul_mtime_unix_ms,
        };
        registry.update(&storage, updated).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_delete(
        id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<(), String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.delete(&storage, id).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn operator_set_default(
        id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
        storage: State<'_, Arc<Storage>>,
    ) -> Result<(), String> {
        let id: OperatorId = id.parse().map_err(map_err)?;
        registry.set_default(&storage, id).await.map_err(map_err)
    }

    #[tauri::command]
    pub async fn session_set_operator(
        session_id: String,
        operator_id: Option<String>,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<(), String> {
        let sid: SessionId = session_id.parse().map_err(map_err)?;
        match operator_id {
            Some(s) => {
                let oid: OperatorId = s.parse().map_err(map_err)?;
                registry.pin_session(sid, oid);
            }
            None => registry.unpin_session(sid),
        }
        Ok(())
    }

    #[tauri::command]
    pub async fn session_get_operator(
        session_id: String,
        registry: State<'_, Arc<OperatorRegistry>>,
    ) -> Result<Operator, String> {
        let sid: SessionId = session_id.parse().map_err(map_err)?;
        Ok(registry.effective_for(sid))
    }
}

#[cfg(test)]
mod voice_tests {
    use super::*;

    #[test]
    fn operator_has_voice_with_default_terse() {
        let op = Operator {
            id: OperatorId(ulid::Ulid::new()),
            name: "x".into(),
            emoji: "🟣".into(),
            color: "#a855f7".into(),
            tags: vec![],
            persona: "p".into(),
            escalate_threshold: 0.5,
            model: "m".into(),
            hard_constraints: "".into(),
            is_default: false,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
            voice: VoiceTone::default(),
            soul_path: None,
            soul_mtime_unix_ms: 0,
        };
        assert!(matches!(op.voice, VoiceTone::Terse));
    }

    #[test]
    fn voice_serializes_as_terse_when_missing() {
        let json = serde_json::json!({
            "id": "01H7ZZZZZZZZZZZZZZZZZZZZZZ",
            "name": "x", "emoji": "🟣", "color": "#a855f7",
            "tags": [], "persona": "", "escalate_threshold": 0.5,
            "model": "m", "hard_constraints": "", "is_default": false,
            "created_at_unix_ms": 0, "updated_at_unix_ms": 0
        });
        let op: Operator = serde_json::from_value(json).unwrap();
        assert!(matches!(op.voice, VoiceTone::Terse));
    }

    #[test]
    fn voice_directive_differs_per_tone() {
        let t = voice_directive(VoiceTone::Terse);
        let w = voice_directive(VoiceTone::Warm);
        let f = voice_directive(VoiceTone::Formal);
        assert!(t.to_lowercase().contains("terse") || t.contains("12 words"));
        assert!(w.to_lowercase().contains("warm") || w.to_lowercase().contains("conversational"));
        assert!(
            f.to_lowercase().contains("formal") || f.to_lowercase().contains("no contractions")
        );
        assert_ne!(t, w);
        assert_ne!(w, f);
    }
}

#[cfg(test)]
mod soul_io_tests {
    use super::*;

    async fn temp_storage(dir: &std::path::Path) -> std::sync::Arc<Storage> {
        std::sync::Arc::new(Storage::open(&dir.join("history.db")).expect("open"))
    }

    #[tokio::test]
    async fn create_writes_soul_file_and_load_hydrates_from_it() {
        let tmp = std::env::temp_dir().join(format!("covenant-soul-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let souls = tmp.join("operators");
        let storage = temp_storage(&tmp).await;
        let reg = OperatorRegistry::load(&storage, souls.clone()).await.unwrap();

        let op = Operator {
            id: OperatorId(ulid::Ulid::new()),
            name: "Atlas".into(),
            emoji: "pack2:guardian".into(),
            color: "#c4a7ff".into(),
            tags: vec!["deploys".into()],
            persona: "I was made to wait.".into(),
            escalate_threshold: 0.55,
            model: "claude-sonnet-4-6".into(),
            hard_constraints: "^git push --force".into(),
            is_default: false,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
            voice: VoiceTone::Warm,
            soul_path: None,
            soul_mtime_unix_ms: 0,
        };
        let created = reg.create(&storage, op).await.unwrap();
        let path = created.soul_path.clone().expect("soul_path set");
        assert!(path.exists(), "SOUL.md written to disk");
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("name: Atlas"));
        assert!(raw.contains("I was made to wait."));

        let mutated = raw.replace("I was made to wait.", "I keep the night watch.");
        std::fs::write(&path, mutated).unwrap();
        let reg2 = OperatorRegistry::load(&storage, souls).await.unwrap();
        let hydrated = reg2.get(created.id).unwrap();
        assert_eq!(hydrated.persona, "I keep the night watch.");

        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn migration_backfills_soul_for_legacy_row() {
        let tmp = std::env::temp_dir().join(format!("covenant-mig-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let souls = tmp.join("operators");
        let storage = temp_storage(&tmp).await;

        let op = Operator {
            id: OperatorId(ulid::Ulid::new()),
            name: "Legacy".into(),
            emoji: "🟣".into(),
            color: "#a855f7".into(),
            tags: vec![],
            persona: "old persona text".into(),
            escalate_threshold: 0.6,
            model: "m".into(),
            hard_constraints: "^sudo".into(),
            is_default: true,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
            voice: VoiceTone::Terse,
            soul_path: None,
            soul_mtime_unix_ms: 0,
        };
        storage.operator_insert(op.clone()).await.unwrap();

        let reg = OperatorRegistry::load(&storage, souls.clone()).await.unwrap();
        let migrated = reg.migrate_personas_to_souls(&storage).await.unwrap();
        assert_eq!(migrated, 1);

        let reg2 = OperatorRegistry::load(&storage, souls).await.unwrap();
        let got = reg2.get(op.id).unwrap();
        assert!(got.soul_path.is_some());
        assert_eq!(got.persona, "old persona text");
        assert_eq!(got.hard_constraints, "^sudo");
        std::fs::remove_dir_all(&tmp).ok();
    }

    #[tokio::test]
    async fn refresh_changed_souls_picks_up_external_edit() {
        let tmp = std::env::temp_dir().join(format!("covenant-hot-{}", ulid::Ulid::new()));
        std::fs::create_dir_all(&tmp).unwrap();
        let souls = tmp.join("operators");
        let storage = temp_storage(&tmp).await;
        let reg = OperatorRegistry::load(&storage, souls).await.unwrap();
        let op = Operator {
            id: OperatorId(ulid::Ulid::new()), name: "Hot".into(), emoji: "🟣".into(),
            color: "#a855f7".into(), tags: vec![], persona: "before".into(),
            escalate_threshold: 0.5, model: "m".into(), hard_constraints: "".into(),
            is_default: false, created_at_unix_ms: 0, updated_at_unix_ms: 0, xp: 0,
            voice: VoiceTone::Terse, soul_path: None, soul_mtime_unix_ms: 0,
        };
        let created = reg.create(&storage, op).await.unwrap();
        let path = created.soul_path.unwrap();
        // Force the cached mtime to differ from the file so the reload triggers
        // regardless of filesystem mtime granularity.
        let raw = std::fs::read_to_string(&path).unwrap().replace("before", "after");
        let mut op2 = reg.get(created.id).unwrap();
        op2.soul_mtime_unix_ms = 0;
        reg.by_id.write().unwrap().insert(created.id, op2);
        std::fs::write(&path, raw).unwrap();
        let n = reg.refresh_changed_souls();
        assert_eq!(n, 1);
        assert_eq!(reg.get(created.id).unwrap().persona, "after");
        std::fs::remove_dir_all(&tmp).ok();
    }
}
