use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Tool {
    Claude,
    Copilot,
    Opencode,
    Codex,
    Shared,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Kind {
    Skill,
    SlashCommand,
    Hook,
    McpServer,
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
