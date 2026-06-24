//! CDLC — the `.covenant/cdlc/` artifact, local install, and executor projection.

pub mod manifest;
pub mod types;

pub use manifest::{cdlc_dir, read_manifest, write_manifest};
pub use types::{CdlcManifest, InstalledRef, SkillManifest};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CdlcError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml parse: {0}")]
    TomlDe(#[from] toml::de::Error),
    #[error("toml write: {0}")]
    TomlSer(#[from] toml::ser::Error),
    #[error("invalid skill package: {0}")]
    InvalidPackage(String),
}
