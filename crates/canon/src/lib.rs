//! Canon — the `.covenant/canon/` artifact, local install, and executor projection.

pub mod compile;
pub mod install;
pub mod manifest;
pub mod project;
pub mod types;
pub mod eval;
pub mod kind;

pub use install::{install_from_dir, install_local, read_skill_package, status, CanonStatus};
pub use manifest::{canon_dir, read_manifest, write_manifest};
pub use project::{
    project, project_with_active, projection_status, ExecutorStatus, ProjState, ProjectionStatus,
};
pub use types::{CanonManifest, InstalledRef, SkillManifest};
pub use eval::{pass_rate, read_evals, read_results, write_result, Eval, EvalResult};
pub use kind::{list_context, ContextKind, ContextUnit};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum CanonError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("toml parse: {0}")]
    TomlDe(#[from] toml::de::Error),
    #[error("toml write: {0}")]
    TomlSer(#[from] toml::ser::Error),
    #[error("invalid skill package: {0}")]
    InvalidPackage(String),
}
