//! Spec-draft persistence for the agentic spec-creation flow (spec 3.18).
//!
//! Drafts are stored as JSON files under `<base_dir>/spec-drafts/<ulid>.json`.
//! The default `base_dir` is `~/.covenant/`; tests must inject an explicit
//! temp directory and MUST NOT use the default helpers.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;
use ulid::Ulid;

// ── Error type ───────────────────────────────────────────────────────────────

#[derive(Debug, Error)]
pub enum SpecAuthorError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("home directory not found")]
    HomeDirNotFound,
    #[error("spec draft not found: {id}")]
    NotFound { id: Ulid },
}

pub type Result<T> = std::result::Result<T, SpecAuthorError>;

// ── Domain types ─────────────────────────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DraftMessage {
    pub role: MessageRole,
    pub content: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum Phase {
    Goal,
    OutOfScope,
    Acceptance,
    FileBoundaries,
    Complexity,
    Emit,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub enum DraftStatus {
    InProgress { phase: Phase },
    Ready,
    Published,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct SpecDraft {
    pub id: Ulid,
    pub messages: Vec<DraftMessage>,
    pub partial_md: Option<String>,
    pub last_updated: DateTime<Utc>,
    pub status: DraftStatus,
}

// ── Path helpers ─────────────────────────────────────────────────────────────

fn drafts_dir(base_dir: &Path) -> PathBuf {
    base_dir.join("spec-drafts")
}

fn draft_path(base_dir: &Path, id: Ulid) -> PathBuf {
    drafts_dir(base_dir).join(format!("{}.json", id))
}

fn home_covenant_dir() -> Result<PathBuf> {
    dirs::home_dir()
        .map(|h| h.join(".covenant"))
        .ok_or(SpecAuthorError::HomeDirNotFound)
}

// ── Core persistence — accept explicit base_dir ───────────────────────────────

/// Persist `draft` to `<base_dir>/spec-drafts/<id>.json`.
/// Creates the directory if it doesn't exist.
pub fn save_draft(base_dir: &Path, draft: &SpecDraft) -> Result<()> {
    let dir = drafts_dir(base_dir);
    std::fs::create_dir_all(&dir)?;
    let path = draft_path(base_dir, draft.id);
    let json = serde_json::to_vec_pretty(draft)?;
    std::fs::write(path, json)?;
    tracing::debug!(draft_id = %draft.id, "spec draft saved");
    Ok(())
}

/// Load a draft by id from `<base_dir>/spec-drafts/<id>.json`.
pub fn load_draft(base_dir: &Path, id: Ulid) -> Result<SpecDraft> {
    let path = draft_path(base_dir, id);
    let bytes = std::fs::read(&path).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            SpecAuthorError::NotFound { id }
        } else {
            SpecAuthorError::Io(e)
        }
    })?;
    let draft: SpecDraft = serde_json::from_slice(&bytes)?;
    Ok(draft)
}

/// List drafts under `<base_dir>/spec-drafts/`, ordered by `last_updated`
/// descending, capped at 20. Malformed or unreadable files are silently
/// skipped.
pub fn list_drafts(base_dir: &Path) -> Vec<SpecDraft> {
    let dir = drafts_dir(base_dir);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Vec::new(),
    };
    let mut drafts: Vec<SpecDraft> = entries
        .filter_map(|entry| {
            let path = entry.ok()?.path();
            if path.extension()?.to_str()? != "json" {
                return None;
            }
            let bytes = std::fs::read(&path).ok()?;
            serde_json::from_slice::<SpecDraft>(&bytes).ok()
        })
        .collect();

    drafts.sort_by(|a, b| b.last_updated.cmp(&a.last_updated));
    drafts.truncate(20);
    drafts
}

// ── Convenience wrappers that resolve ~/.covenant/ ────────────────────────────

/// Persist `draft` to the default `~/.covenant/spec-drafts/` directory.
pub fn save_draft_default(draft: &SpecDraft) -> Result<()> {
    save_draft(&home_covenant_dir()?, draft)
}

/// Load a draft by id from the default `~/.covenant/spec-drafts/` directory.
pub fn load_draft_default(id: Ulid) -> Result<SpecDraft> {
    load_draft(&home_covenant_dir()?, id)
}

/// List drafts from the default `~/.covenant/spec-drafts/` directory.
pub fn list_drafts_default() -> Result<Vec<SpecDraft>> {
    Ok(list_drafts(&home_covenant_dir()?))
}
