pub mod framing;
pub mod install;
pub mod registry;
pub mod root;
pub mod server;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum LspError {
    #[error("unknown language: {0}")]
    UnknownLanguage(String),
    #[error("no artifact for platform {0}")]
    NoArtifact(String),
    #[error("sha256 mismatch: expected {expected}, got {actual}")]
    ShaMismatch { expected: String, actual: String },
    #[error("download failed: {0}")]
    Download(String),
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("server spawn failed: {0}")]
    Spawn(String),
}
