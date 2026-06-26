//! CDLC — the `.covenant/cdlc/` artifact, local install, and executor projection.

pub mod manifest;
pub mod types;
pub mod install;
pub mod project;
pub mod eval;

pub use manifest::{cdlc_dir, read_manifest, write_manifest};
pub use types::{CdlcManifest, InstalledRef, SkillManifest};
pub use install::{install_from_dir, install_local, read_skill_package, status, CdlcStatus};
pub use project::{project, project_with_active};
pub use eval::{pass_rate, read_evals, read_results, write_result, Eval, EvalResult};

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
