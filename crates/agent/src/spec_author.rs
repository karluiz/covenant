//! Spec-draft persistence for the agentic spec-creation flow (spec 3.18).
//!
//! Drafts are stored as JSON files under `<base_dir>/spec-drafts/<ulid>.json`.
//! The default `base_dir` is `~/.covenant/`; tests must inject an explicit
//! temp directory and MUST NOT use the default helpers.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;
use ulid::Ulid;

const SYSTEM_PROMPT: &str = include_str!("spec_author/prompt.md");

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
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("anthropic api {status}: {body}")]
    Api { status: u16, body: String },
    #[error("invalid spec — missing sections: {missing:?}")]
    InvalidSpec { missing: Vec<String> },
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
    OpenQuestions,
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

pub fn home_covenant_dir() -> Result<PathBuf> {
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

// ── Step output ───────────────────────────────────────────────────────────────

/// Returned by `step()` after each coordinator message.
#[derive(Debug)]
pub enum StepOutput {
    /// The agent is still gathering information; `text` is its next question.
    Question { phase: Phase, text: String },
    /// The agent emitted a complete, valid spec. `markdown` is the inner content.
    Final { markdown: String },
}

// ── Dispatcher trait ──────────────────────────────────────────────────────────

/// Abstraction over the Anthropic Messages API (multi-turn).
/// Defined locally so tests can inject a mock without touching `lib.rs`.
#[async_trait]
pub trait Dispatcher: Send + Sync {
    async fn dispatch(
        &self,
        system: &str,
        messages: &[DraftMessage],
    ) -> Result<String>;
}

// ── Real Anthropic dispatcher ─────────────────────────────────────────────────

/// Calls the Anthropic Messages API with the full conversation history.
/// Constructed with an API key and model so the caller controls both.
pub struct AnthropicDispatcher {
    pub api_key: String,
    pub model: String,
}

#[async_trait]
impl Dispatcher for AnthropicDispatcher {
    async fn dispatch(&self, system: &str, messages: &[DraftMessage]) -> Result<String> {
        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(180))
            .build()?;

        let api_messages: Vec<serde_json::Value> = messages
            .iter()
            .map(|m| {
                let role = match m.role {
                    MessageRole::User => "user",
                    MessageRole::Assistant => "assistant",
                };
                serde_json::json!({ "role": role, "content": m.content })
            })
            .collect();

        let body = serde_json::json!({
            "model": self.model,
            "max_tokens": 4096,
            "system": [
                {
                    "type": "text",
                    "text": system,
                    "cache_control": { "type": "ephemeral" }
                }
            ],
            "messages": api_messages,
        });

        tracing::debug!(
            model = %self.model,
            msg_count = messages.len(),
            "dispatching spec_author conversation to Anthropic"
        );

        let response = client
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await?;

        let status = response.status();
        if !status.is_success() {
            let body_text = response.text().await.unwrap_or_default();
            return Err(SpecAuthorError::Api {
                status: status.as_u16(),
                body: body_text,
            });
        }

        let json: serde_json::Value = response.json().await?;
        let text = json["content"][0]["text"]
            .as_str()
            .unwrap_or("")
            .to_string();
        Ok(text)
    }
}

// ── Markdown validation ───────────────────────────────────────────────────────

/// Required section headings in the emitted spec (case-sensitive, as in _template.md).
const REQUIRED_SECTIONS: &[&str] = &[
    "## Goal",
    "## Out of scope",
    "## Acceptance criteria",
    "## File boundaries",
    "## Complexity",
    "## Open questions",
];

/// Validates that all six required section headings are present in `md`.
pub fn validate_spec_markdown(md: &str) -> Result<()> {
    let missing: Vec<String> = REQUIRED_SECTIONS
        .iter()
        .filter(|&&heading| !md.contains(heading))
        .map(|&heading| heading.to_string())
        .collect();

    if missing.is_empty() {
        Ok(())
    } else {
        Err(SpecAuthorError::InvalidSpec { missing })
    }
}

// ── Phase detection ───────────────────────────────────────────────────────────

/// Heuristically derive the current phase from the assistant's response text.
/// We keep an explicit Phase cursor in DraftStatus; this function is a fallback
/// for when we need to label a Question response. The approach: we maintain
/// the phase in `draft.status` and advance it after each successful turn.
fn next_phase(current: &Phase) -> Phase {
    match current {
        Phase::Goal => Phase::OutOfScope,
        Phase::OutOfScope => Phase::Acceptance,
        Phase::Acceptance => Phase::FileBoundaries,
        Phase::FileBoundaries => Phase::Complexity,
        Phase::Complexity => Phase::OpenQuestions,
        Phase::OpenQuestions => Phase::Emit,
        Phase::Emit => Phase::Emit,
    }
}

// ── Step function ─────────────────────────────────────────────────────────────

/// Advance the spec-author conversation by one turn.
///
/// Design note on phase tracking: we store the current phase explicitly in
/// `draft.status` (as `DraftStatus::InProgress { phase }`). This is simpler
/// than parsing the phase from the assistant's prose and avoids false positives.
/// The phase advances after each successful non-Final turn.
pub async fn step<D: Dispatcher>(
    dispatcher: &D,
    draft: &mut SpecDraft,
    user_msg: String,
    base_dir: &std::path::Path,
) -> Result<StepOutput> {
    // 1. Append user message.
    draft.messages.push(DraftMessage {
        role: MessageRole::User,
        content: user_msg,
    });

    // 2. Dispatch — pass full conversation history.
    let response = dispatcher.dispatch(SYSTEM_PROMPT, &draft.messages).await?;

    // 3. Append assistant response.
    draft.messages.push(DraftMessage {
        role: MessageRole::Assistant,
        content: response.clone(),
    });

    // 4. Check for <spec>...</spec> emission.
    if let Some(markdown) = extract_spec(&response) {
        // Validate before transitioning.
        validate_spec_markdown(&markdown)?;

        draft.partial_md = Some(markdown.clone());
        draft.status = DraftStatus::Ready;
        draft.last_updated = Utc::now();
        save_draft(base_dir, draft)?;

        return Ok(StepOutput::Final { markdown });
    }

    // 5. Advance phase cursor and save.
    let current_phase = match &draft.status {
        DraftStatus::InProgress { phase } => phase.clone(),
        // If somehow already Ready/Published and we're called again, stay in Emit.
        _ => Phase::Emit,
    };
    let advanced_phase = next_phase(&current_phase);
    draft.status = DraftStatus::InProgress { phase: advanced_phase.clone() };
    draft.last_updated = Utc::now();
    save_draft(base_dir, draft)?;

    Ok(StepOutput::Question {
        phase: advanced_phase,
        text: response,
    })
}

/// Mark a draft as published. Loads, mutates status, saves.
pub fn mark_published(id: Ulid, base_dir: &Path) -> Result<()> {
    let mut draft = load_draft(base_dir, id)?;
    draft.status = DraftStatus::Published;
    draft.last_updated = chrono::Utc::now();
    save_draft(base_dir, &draft)
}

/// Convenience wrapper — resolves `~/.covenant/` via `dirs::home_dir()`.
pub fn mark_published_default(id: Ulid) -> Result<()> {
    let base = home_covenant_dir()?;
    mark_published(id, &base)
}

/// Extract the markdown between `<spec>` and `</spec>` tags.
fn extract_spec(text: &str) -> Option<String> {
    let start_tag = "<spec>";
    let end_tag = "</spec>";
    let start = text.find(start_tag)? + start_tag.len();
    let end = text.find(end_tag)?;
    if start > end {
        return None;
    }
    Some(text[start..end].trim().to_string())
}
