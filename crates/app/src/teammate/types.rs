//! Data types for the teammate layer.
//!
//! IDs are newtyped Ulids per project convention. Enums derive
//! Serialize/Deserialize so they can cross the Tauri boundary and live
//! in SQLite as their kebab-case string form.

use std::path::PathBuf;

use karl_session::SessionId;
use serde::{Deserialize, Serialize};
use ulid::Ulid;

use crate::operator_registry::OperatorId;

/// Per-operator state in the teammate runtime.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OperatorState {
    Idle,
    Pinned { session: SessionId },
    OnTask { task: TaskId, session: Option<SessionId> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct TaskId(pub Ulid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct MessageId(pub Ulid);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ArtifactId(pub Ulid);

impl TaskId {
    pub fn new() -> Self { Self(Ulid::new()) }
}
impl MessageId {
    pub fn new() -> Self { Self(Ulid::new()) }
}
impl ArtifactId {
    pub fn new() -> Self { Self(Ulid::new()) }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ThreadId(pub Ulid);

impl ThreadId {
    pub fn new() -> Self { Self(Ulid::new()) }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TeammateThread {
    pub id: ThreadId,
    pub operator_id: crate::operator_registry::OperatorId,
    pub title: String,
    pub created_at_unix_ms: u64,
    pub last_message_at_unix_ms: u64,
    pub archived: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskArchetype { Watch, Do, Review }

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus { Draft, Active, Blocked, Done, Cancelled }

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WatchPredicate {
    ExitCodeNonZero { in_sessions: Vec<SessionId> },
    PathTouched     { paths: Vec<PathBuf> },
    GhCheckStatus   { repo: String, branch: String, status: String },
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskScope {
    #[serde(default)] pub paths: Vec<PathBuf>,
    #[serde(default)] pub tabs:  Vec<SessionId>,
    #[serde(default)] pub watch_predicate: Option<WatchPredicate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: TaskId,
    pub operator_id: OperatorId,
    pub archetype: TaskArchetype,
    pub title: String,
    pub body: String,
    pub deliverable: String,
    pub status: TaskStatus,
    pub scope: TaskScope,
    pub spawned_session: Option<SessionId>,
    pub created_at_unix_ms: u64,
    pub updated_at_unix_ms: u64,
    pub completed_at_unix_ms: Option<u64>,
    pub cost_usd_cents: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role { User, Operator, System }

/// Operator emotional state attached to a message at generation time.
///
/// Mirrors the 9 poses in `ui/operatorsv2/` (filename token, Spanish form).
/// Drives the v2 avatar pose + the sentiment badge in the teammate panel.
/// Optional on the message: legacy rows + non-operator turns leave it None.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sentiment {
    Neutral,
    Feliz,
    Triste,
    Enojo,
    Sorpresa,
    Duda,
    Expectacion,
    Incomodidad,
    Ver,
}

impl Sentiment {
    /// Parse the lowercase Spanish token used in storage + the LLM
    /// `SENTIMENT:` directive. Returns None on unknown input so the
    /// caller can fall back to a neutral pose.
    pub fn from_token(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "neutral"      => Some(Self::Neutral),
            "feliz"        => Some(Self::Feliz),
            "triste"       => Some(Self::Triste),
            "enojo"        => Some(Self::Enojo),
            "sorpresa"     => Some(Self::Sorpresa),
            "duda"         => Some(Self::Duda),
            "expectacion"  => Some(Self::Expectacion),
            "incomodidad"  => Some(Self::Incomodidad),
            "ver"          => Some(Self::Ver),
            _ => None,
        }
    }

    pub fn as_token(self) -> &'static str {
        match self {
            Self::Neutral     => "neutral",
            Self::Feliz       => "feliz",
            Self::Triste      => "triste",
            Self::Enojo       => "enojo",
            Self::Sorpresa    => "sorpresa",
            Self::Duda        => "duda",
            Self::Expectacion => "expectacion",
            Self::Incomodidad => "incomodidad",
            Self::Ver         => "ver",
        }
    }
}

/// What a message carries. The discriminator is `kind`; the payload is
/// JSON-serialized in SQLite (`teammate_messages.content_json`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", content = "data", rename_all = "snake_case")]
pub enum MessageContent {
    Text(String),
    TaskDraft(TaskDraft),
    TaskUpdate { task: TaskId, kind: UpdateKind },
    Propose(ProposeTask),
    Report(TaskReport),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDraft {
    pub archetype: TaskArchetype,
    pub title: String,
    pub deliverable: String,
    pub scope: TaskScope,
    /// Which executor agent should drive this task once confirmed.
    /// Required for `do` archetype; ignored for review/watch. One of:
    /// claude, codex, copilot, pi, hermes (see project_executors_naming).
    /// Optional in the wire format to keep older rows deserializable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub executor: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateKind { Started, Progress, Blocked, Resumed, Completed, Cancelled }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProposeTask {
    pub draft: TaskDraft,
    pub rationale: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskReport {
    pub summary: String,
    pub artifact_ids: Vec<ArtifactId>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskMessage {
    pub id: MessageId,
    pub operator_id: OperatorId,
    pub task_id: Option<TaskId>,
    /// The conversation thread this message belongs to. `None` only for
    /// legacy rows not yet backfilled; all new messages carry a thread.
    pub thread_id: Option<ThreadId>,
    pub role: Role,
    pub content: MessageContent,
    pub created_at_unix_ms: u64,
    #[serde(default)]
    pub confirmed_at_unix_ms: Option<u64>,
    #[serde(default)]
    pub dismissed_at_unix_ms: Option<u64>,
    /// Operator emotional state at the moment this message was generated.
    /// None for: user-authored turns, system turns, legacy rows before
    /// the sentiment column existed, and operator turns where the LLM
    /// emitted no parseable `SENTIMENT:` directive.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sentiment: Option<Sentiment>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArtifactKind { Diff, File, Link, Commit, Report }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskArtifact {
    pub id: ArtifactId,
    pub task_id: TaskId,
    pub kind: ArtifactKind,
    pub payload: Vec<u8>,
    pub created_at_unix_ms: u64,
}
