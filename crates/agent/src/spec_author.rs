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

/// Public re-export of the base system prompt for the app layer.
pub const SYSTEM_PROMPT_PUB: &str = SYSTEM_PROMPT;

pub mod stream;
pub mod tools;

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
    #[error("{provider} api {status}: {body}")]
    Api {
        provider: &'static str,
        status: u16,
        body: String,
    },
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

/// A user-attached image stored on disk under the draft's asset directory.
/// Bytes are loaded lazily when building an API request — the draft JSON only
/// carries the path.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ImageRef {
    pub path: String,
    pub media_type: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct DraftMessage {
    pub role: MessageRole,
    pub content: String,
    /// Images attached to this (user) message. Empty for legacy drafts.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub images: Vec<ImageRef>,
}

impl DraftMessage {
    pub fn user(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::User,
            content: content.into(),
            images: Vec::new(),
        }
    }
    pub fn assistant(content: impl Into<String>) -> Self {
        Self {
            role: MessageRole::Assistant,
            content: content.into(),
            images: Vec::new(),
        }
    }
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
    /// Resolved git root of the project this draft was authored in, used to
    /// scope the drafts tab per group. `None` for legacy drafts (predate this
    /// field) or drafts created without a cwd — those surface in every group.
    #[serde(default)]
    pub repo_root: Option<String>,
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
    async fn dispatch(&self, system: &str, messages: &[DraftMessage]) -> Result<String>;
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

        let api_messages = stream::anthropic_messages_json(messages);

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
                provider: "anthropic",
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
    draft.messages.push(DraftMessage::user(user_msg));

    // 2. Dispatch — pass full conversation history.
    let response = dispatcher.dispatch(SYSTEM_PROMPT, &draft.messages).await?;

    // 3. Append assistant response.
    draft
        .messages
        .push(DraftMessage::assistant(response.clone()));

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
    draft.status = DraftStatus::InProgress {
        phase: advanced_phase.clone(),
    };
    draft.last_updated = Utc::now();
    save_draft(base_dir, draft)?;

    Ok(StepOutput::Question {
        phase: advanced_phase,
        text: response,
    })
}

/// Resolve the enclosing git repository root for `cwd` by walking up to the
/// first directory containing a `.git` entry (a dir, or a file in linked
/// worktrees). Falls back to the canonicalized `cwd` when no repo is found.
pub fn resolve_repo_root(cwd: &Path) -> PathBuf {
    let canon = std::fs::canonicalize(cwd).unwrap_or_else(|_| cwd.to_path_buf());
    let mut cur: &Path = &canon;
    loop {
        if cur.join(".git").exists() {
            return cur.to_path_buf();
        }
        match cur.parent() {
            Some(p) => cur = p,
            None => return canon.clone(),
        }
    }
}

/// Resolve `cwd` to the **main** repository root, collapsing linked worktrees
/// onto the checkout they share. Uses `git --git-common-dir` (which returns the
/// main `.git` even from inside a worktree); its parent is the main worktree
/// root. Falls back to [`resolve_repo_root`] outside git or on old git.
///
/// This is the identity drafts are scoped by, so a spec authored in an
/// (ephemeral) worktree still surfaces from the main checkout.
pub fn resolve_main_repo_root(cwd: &Path) -> PathBuf {
    if let Some(root) = git_common_root(cwd) {
        return root;
    }
    resolve_repo_root(cwd)
}

fn git_common_root(cwd: &Path) -> Option<PathBuf> {
    let out = std::process::Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(["rev-parse", "--path-format=absolute", "--git-common-dir"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8(out.stdout).ok()?;
    let common = Path::new(text.trim());
    // `<main>/.git` → main worktree root is its parent.
    let root = if common.file_name().map(|n| n == ".git").unwrap_or(false) {
        common.parent()?.to_path_buf()
    } else {
        common.to_path_buf()
    };
    Some(std::fs::canonicalize(&root).unwrap_or(root))
}

/// Honest fallback context for when no usable cwd reached the backend.
/// Without this the model invents a stack out of thin air (it once claimed a
/// Java repo was "a Python data-consolidation project").
pub fn no_repo_context() -> String {
    "\n\n---\n\n## Repository context\n\n\
     No repository is attached to this session — the active tab had not \
     reported a working directory. Do NOT assume any technology stack, \
     language, or project layout. Your file tools are not pointed at the \
     coordinator's project. Tell the coordinator you have no repository \
     context and ask which project this spec concerns before exploring.\n"
        .to_string()
}

/// Resolve the tool jail root and the full system prompt for one turn.
/// The context block is attached on EVERY turn — it is deterministic for a
/// given root, so the system prompt stays stable and prompt-cacheable.
pub fn compose_system(cwd: Option<&Path>, fallback_root: &Path) -> (PathBuf, String) {
    if let Some(p) = cwd {
        if p.is_dir() {
            let root = resolve_repo_root(p);
            if let Some(ctx) = build_repo_context(&root) {
                return (root, format!("{SYSTEM_PROMPT}{ctx}"));
            }
        }
    }
    (
        fallback_root.to_path_buf(),
        format!("{SYSTEM_PROMPT}{}", no_repo_context()),
    )
}

/// Build a short repository context block (root, key files, top-level listing)
/// to give the agent enough grounding to skip generic discovery questions.
pub fn build_repo_context(cwd: &Path) -> Option<String> {
    if !cwd.is_dir() {
        return None;
    }
    let mut out = String::new();
    out.push_str("\n\n---\n\n## Repository context (auto-attached)\n\n");
    out.push_str(&format!("Repository root: `{}`\n\n", cwd.display()));
    out.push_str(
        "All tool paths (`grep` dirs, `read_file`, `list_dir`) are resolved relative \
         to this root. Absolute paths and `..` escapes are rejected — use `.` to list \
         the root itself.\n\n",
    );

    // Top-level entries (1 level deep, max 40 items).
    if let Ok(rd) = std::fs::read_dir(cwd) {
        let mut entries: Vec<(String, bool)> = rd
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                let name = e.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') && name != ".github" {
                    return None;
                }
                let is_dir = e.file_type().ok().map(|t| t.is_dir()).unwrap_or(false);
                Some((name, is_dir))
            })
            .collect();
        entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
        entries.truncate(40);
        if !entries.is_empty() {
            out.push_str("### Top-level entries\n\n");
            for (name, is_dir) in &entries {
                out.push_str(&format!("- {}{}\n", name, if *is_dir { "/" } else { "" }));
            }
            out.push('\n');
        }
    }

    // First-200-line snippets of key docs.
    for fname in ["CLAUDE.md", "AGENTS.md", "README.md"] {
        let p = cwd.join(fname);
        if let Ok(text) = std::fs::read_to_string(&p) {
            let snippet: String = text.lines().take(200).collect::<Vec<_>>().join("\n");
            out.push_str(&format!(
                "### `{}` (first 200 lines)\n\n```\n{}\n```\n\n",
                fname, snippet
            ));
        }
    }

    out.push_str(
        "Use this context to avoid asking questions whose answers are obvious from the layout \
         (file structure, settings module names, technology stack). When file boundaries come up, \
         propose specific paths drawn from the listing above and let the coordinator correct you.\n",
    );
    Some(out)
}

/// Same as [`step`] but augments the system prompt with a repo-context block
/// (or an explicit no-repo notice) via [`compose_system`]. The block is
/// attached on every turn: it is deterministic for a given root, so the
/// system prompt stays identical across turns and prompt-cacheable.
pub async fn step_with_context<D: Dispatcher>(
    dispatcher: &D,
    draft: &mut SpecDraft,
    user_msg: String,
    base_dir: &std::path::Path,
    cwd: Option<&std::path::Path>,
) -> Result<StepOutput> {
    let (_root, system) = compose_system(cwd, base_dir);

    draft.messages.push(DraftMessage::user(user_msg));
    let response = dispatcher.dispatch(&system, &draft.messages).await?;
    draft
        .messages
        .push(DraftMessage::assistant(response.clone()));

    if let Some(markdown) = extract_spec(&response) {
        validate_spec_markdown(&markdown)?;
        draft.partial_md = Some(markdown.clone());
        draft.status = DraftStatus::Ready;
        draft.last_updated = Utc::now();
        save_draft(base_dir, draft)?;
        return Ok(StepOutput::Final { markdown });
    }

    let current_phase = match &draft.status {
        DraftStatus::InProgress { phase } => phase.clone(),
        _ => Phase::Emit,
    };
    let advanced_phase = next_phase(&current_phase);
    draft.status = DraftStatus::InProgress {
        phase: advanced_phase.clone(),
    };
    draft.last_updated = Utc::now();
    save_draft(base_dir, draft)?;

    Ok(StepOutput::Question {
        phase: advanced_phase,
        text: response,
    })
}

// ── Image attachments ─────────────────────────────────────────────────────────

/// Asset directory for a draft's attached images: `<base_dir>/spec-drafts/<id>/`.
pub fn draft_assets_dir(base_dir: &Path, id: Ulid) -> PathBuf {
    drafts_dir(base_dir).join(id.to_string())
}

pub fn ext_for_media_type(media_type: &str) -> &'static str {
    match media_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

/// Persist decoded image bytes under the draft's asset dir. Returns, per image,
/// the stored [`ImageRef`] and the canonical repo-relative path it will get on
/// publish (`docs/specs/assets/<id>/img-N.<ext>`) — announced to the model so
/// spec references are correct at draft time.
pub fn save_attached_images(
    base_dir: &Path,
    id: Ulid,
    images: &[(Vec<u8>, String)],
) -> Result<Vec<(ImageRef, String)>> {
    let dir = draft_assets_dir(base_dir, id);
    std::fs::create_dir_all(&dir)?;
    let existing = std::fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().starts_with("img-"))
        .count();
    let mut out = Vec::new();
    for (i, (bytes, media_type)) in images.iter().enumerate() {
        let fname = format!(
            "img-{}.{}",
            existing + i + 1,
            ext_for_media_type(media_type)
        );
        let path = dir.join(&fname);
        std::fs::write(&path, bytes)?;
        out.push((
            ImageRef {
                path: path.display().to_string(),
                media_type: media_type.clone(),
            },
            format!("docs/specs/assets/{}/{}", id, fname),
        ));
    }
    Ok(out)
}

/// Copy every image attached to `id`'s draft into
/// `<repo_root>/docs/specs/assets/<id>/`, returning repo-relative paths.
/// No-op (empty vec) when the draft has no images.
pub fn materialize_assets(base_dir: &Path, id: Ulid, repo_root: &Path) -> Result<Vec<String>> {
    let draft = load_draft(base_dir, id)?;
    let dest = repo_root
        .join("docs")
        .join("specs")
        .join("assets")
        .join(id.to_string());
    let mut out = Vec::new();
    for m in &draft.messages {
        for img in &m.images {
            let src = Path::new(&img.path);
            let Some(fname) = src.file_name() else {
                continue;
            };
            if !src.exists() {
                continue;
            }
            std::fs::create_dir_all(&dest)?;
            std::fs::copy(src, dest.join(fname))?;
            out.push(format!(
                "docs/specs/assets/{}/{}",
                id,
                fname.to_string_lossy()
            ));
        }
    }
    Ok(out)
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

/// Overwrite a draft's spec body (user edit from the section editor) and persist.
pub fn save_markdown(id: Ulid, markdown: &str, base_dir: &Path) -> Result<()> {
    let mut draft = load_draft(base_dir, id)?;
    draft.partial_md = Some(markdown.to_string());
    draft.last_updated = chrono::Utc::now();
    save_draft(base_dir, &draft)
}

/// Convenience wrapper — resolves `~/.covenant/` via `dirs::home_dir()`.
pub fn save_markdown_default(id: Ulid, markdown: &str) -> Result<()> {
    let base = home_covenant_dir()?;
    save_markdown(id, markdown, &base)
}

/// Delete a draft file by id from `<base_dir>/spec-drafts/<id>.json`.
pub fn delete_draft(base_dir: &Path, id: Ulid) -> Result<()> {
    let path = draft_path(base_dir, id);
    if path.exists() {
        std::fs::remove_file(&path)?;
        tracing::debug!(draft_id = %id, "spec draft deleted");
        Ok(())
    } else {
        Err(SpecAuthorError::NotFound { id })
    }
}

/// Convenience wrapper — resolves `~/.covenant/` via `dirs::home_dir()`.
pub fn delete_draft_default(id: Ulid) -> Result<()> {
    let base = home_covenant_dir()?;
    delete_draft(&base, id)
}

/// Public re-export of the `<spec>` extractor for the streaming module.
pub fn extract_spec_pub(text: &str) -> Option<String> {
    extract_spec(text)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn draft_message_images_serde_roundtrip_and_legacy() {
        // Legacy JSON without `images` still loads.
        let legacy = r#"{"role":"User","content":"hola"}"#;
        let m: DraftMessage = serde_json::from_str(legacy).unwrap();
        assert!(m.images.is_empty());
        // Text-only messages serialize WITHOUT an images key (draft JSON stable).
        let plain = serde_json::to_string(&DraftMessage::user("x")).unwrap();
        assert!(!plain.contains("images"));
        // With images: round-trip preserves refs.
        let mut with = DraftMessage::user("mira el wireframe");
        with.images.push(ImageRef {
            path: "/tmp/img-1.png".into(),
            media_type: "image/png".into(),
        });
        let json = serde_json::to_string(&with).unwrap();
        let back: DraftMessage = serde_json::from_str(&json).unwrap();
        assert_eq!(back, with);
    }

    #[test]
    fn save_attached_images_numbers_sequentially() {
        let tmp = tempfile::tempdir().unwrap();
        let id = Ulid::new();
        let first =
            save_attached_images(tmp.path(), id, &[(vec![1, 2, 3], "image/png".into())]).unwrap();
        assert_eq!(first.len(), 1);
        assert!(first[0].0.path.ends_with("img-1.png"));
        assert_eq!(first[0].1, format!("docs/specs/assets/{}/img-1.png", id));
        // Second batch continues numbering.
        let second =
            save_attached_images(tmp.path(), id, &[(vec![4], "image/jpeg".into())]).unwrap();
        assert!(second[0].0.path.ends_with("img-2.jpg"));
        assert!(Path::new(&second[0].0.path).exists());
    }

    #[test]
    fn materialize_assets_copies_into_repo() {
        let tmp = tempfile::tempdir().unwrap();
        let repo = tempfile::tempdir().unwrap();
        let id = Ulid::new();
        let saved =
            save_attached_images(tmp.path(), id, &[(vec![9, 9], "image/png".into())]).unwrap();
        let mut msg = DraftMessage::user("wireframe");
        msg.images.push(saved[0].0.clone());
        let draft = SpecDraft {
            id,
            messages: vec![msg],
            partial_md: None,
            last_updated: chrono::Utc::now(),
            status: DraftStatus::InProgress { phase: Phase::Goal },
            repo_root: None,
        };
        save_draft(tmp.path(), &draft).unwrap();

        let rels = materialize_assets(tmp.path(), id, repo.path()).unwrap();
        assert_eq!(rels, vec![format!("docs/specs/assets/{}/img-1.png", id)]);
        assert!(repo.path().join(&rels[0]).exists());

        // Draft without images → no-op.
        let empty = SpecDraft {
            id: Ulid::new(),
            messages: vec![DraftMessage::user("sin fotos")],
            partial_md: None,
            last_updated: chrono::Utc::now(),
            status: DraftStatus::InProgress { phase: Phase::Goal },
            repo_root: None,
        };
        save_draft(tmp.path(), &empty).unwrap();
        assert!(materialize_assets(tmp.path(), empty.id, repo.path())
            .unwrap()
            .is_empty());
    }

    #[test]
    fn anthropic_body_includes_image_blocks() {
        let tmp = tempfile::tempdir().unwrap();
        let img_path = tmp.path().join("w.png");
        std::fs::write(&img_path, [137, 80, 78, 71]).unwrap();
        let mut msg = DraftMessage::user("el wireframe");
        msg.images.push(ImageRef {
            path: img_path.display().to_string(),
            media_type: "image/png".into(),
        });
        let body = stream::anthropic_messages_json(&[DraftMessage::user("hola"), msg]);
        // Text-only stays a plain string (cache-friendly).
        assert!(body[0]["content"].is_string());
        // Image message becomes blocks: image first, then text.
        let blocks = body[1]["content"].as_array().unwrap();
        assert_eq!(blocks[0]["type"], "image");
        assert_eq!(blocks[0]["source"]["media_type"], "image/png");
        assert_eq!(blocks[1]["type"], "text");

        let oai = stream::openai_messages_json("sys", std::slice::from_ref(&body_msg(&img_path)));
        let parts = oai[1]["content"].as_array().unwrap();
        assert_eq!(parts[0]["type"], "image_url");
        assert!(parts[0]["image_url"]["url"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,"));
    }

    fn body_msg(img_path: &Path) -> DraftMessage {
        let mut m = DraftMessage::user("mira");
        m.images.push(ImageRef {
            path: img_path.display().to_string(),
            media_type: "image/png".into(),
        });
        m
    }

    #[test]
    fn save_markdown_overwrites_partial_md() {
        let tmp = tempfile::tempdir().unwrap();
        let base = tmp.path();
        let draft = SpecDraft {
            id: Ulid::new(),
            messages: vec![],
            partial_md: Some("## Goal\n\nold".into()),
            last_updated: chrono::Utc::now(),
            status: DraftStatus::InProgress { phase: Phase::Goal },
            repo_root: None,
        };
        save_draft(base, &draft).unwrap();
        save_markdown(draft.id, "## Goal\n\nedited", base).unwrap();
        let reloaded = load_draft(base, draft.id).unwrap();
        assert_eq!(reloaded.partial_md.as_deref(), Some("## Goal\n\nedited"));
    }
}
