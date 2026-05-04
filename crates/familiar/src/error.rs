use thiserror::Error;

#[derive(Debug, Error)]
pub enum FamiliarError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("agent: {0}")]
    Agent(#[from] karl_agent::AgentError),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("familiar not found: {0}")]
    NotFound(String),
    #[error("frozen: daily cap exceeded")]
    Frozen,
    #[error("safety blocked directive: {reason}")]
    SafetyBlocked { reason: String },
    #[error("invalid directive: {0}")]
    InvalidDirective(String),
}

pub type Result<T> = std::result::Result<T, FamiliarError>;
