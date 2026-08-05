use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Tool {
    Claude,
    Copilot,
    Opencode,
    Codex,
    Kimi,
    Shared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Kind {
    Skill,
    SlashCommand,
    Hook,
    McpServer,
    /// A standalone agent profile in its own dir (Kimi's `agents/*.md`). Not
    /// the same as a skill: opencode's "agent" files ARE its skills and keep
    /// using `Skill`.
    Agent,
}

#[derive(Debug, Error)]
pub enum CapabilityError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("malformed frontmatter at {path}: {reason}")]
    Frontmatter { path: String, reason: String },
    #[error("invalid json at {0}: {1}")]
    Json(String, #[source] serde_json::Error),
}

pub type CapabilityResult<T> = Result<T, CapabilityError>;
