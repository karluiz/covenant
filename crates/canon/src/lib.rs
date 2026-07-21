//! Canon — the `.covenant/canon/` artifact, local install, and executor projection.

pub mod compile;
pub mod detect;
pub mod inventory;
pub mod install;
pub mod manifest;
pub mod project;
pub mod types;
pub mod eval;
pub mod kind;
pub mod mcp;
pub mod new_unit;

pub use install::{install_from_dir, install_local, install_unit, uninstall_skill, read_skill_package, read_source, status, CanonStatus, content_version, adopt, adopt_new_skills};
pub use manifest::{canon_dir, read_manifest, write_manifest};
pub use project::{
    project, project_with_active, projection_status, ExecutorStatus, ProjState, ProjectionStatus,
};
pub use types::{CanonManifest, InstalledRef, SkillManifest};
pub use eval::{pass_rate, read_evals, read_results, write_result, Eval, EvalResult};
pub use kind::{list_context, ContextKind, ContextUnit};
pub use detect::scan_detected;
pub use inventory::{detected_rows, resolve_state, UnitState};
pub use mcp::{McpServer, blank_mcp_secrets};
pub use new_unit::new_unit;

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
