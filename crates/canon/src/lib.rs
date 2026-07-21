//! Canon — the `.covenant/canon/` artifact, local install, and executor projection.

pub mod compile;
pub mod detect;
pub mod eval;
pub mod install;
pub mod inventory;
pub mod kind;
pub mod manifest;
pub mod mcp;
pub mod new_unit;
pub mod project;
pub mod types;

pub use detect::scan_detected;
pub use eval::{pass_rate, read_evals, read_results, write_result, Eval, EvalResult};
pub use install::{
    adopt, adopt_new_skills, content_version, install_from_dir, install_local, install_unit,
    read_skill_package, read_source, status, uninstall_skill, CanonStatus,
};
pub use inventory::{detected_rows, resolve_state, UnitState};
pub use kind::{list_context, ContextKind, ContextUnit};
pub use manifest::{canon_dir, read_manifest, write_manifest};
pub use mcp::{blank_mcp_secrets, McpServer};
pub use project::{
    project, project_with_active, projection_status, ExecutorStatus, ProjState, ProjectionStatus,
};
pub use new_unit::new_unit;
pub use types::{CanonManifest, InstalledRef, SkillManifest};

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
