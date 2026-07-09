//! The context-kind contract: the enumerable classes Canon carries into an
//! executor's context. Skill is the only packageable kind today; Command / Mcp
//! / Spec / Memory join in later sub-projects.

use crate::manifest::{canon_dir, read_manifest};
use crate::project::{parse_frontmatter_str, parse_summary, read_dir_md};
use crate::CanonError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextKind {
    Agent,
    Context,
    Command,
    Skill,
}

impl ContextKind {
    /// Source subdirectory under `.covenant/canon/`.
    pub fn dir(&self) -> &'static str {
        match self {
            Self::Agent => "agents",
            Self::Context => "context",
            Self::Command => "commands",
            Self::Skill => "skills",
        }
    }

    /// Human label for UI section headers.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Agent => "Agent",
            Self::Context => "Context",
            Self::Command => "Command",
            Self::Skill => "Skill",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUnit {
    pub kind: ContextKind,
    pub name: String,
    pub summary: Option<String>,
    pub projectable: bool,
    pub packageable: bool,
}

/// Enumerate every authored/installed context unit across the three kinds,
/// reading the same source dirs `project_with_active` projects from.
pub fn list_context(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError> {
    let base = canon_dir(repo_root);
    let mut out: Vec<ContextUnit> = Vec::new();

    for (name, _raw) in read_dir_md(&base.join("agents"))? {
        out.push(ContextUnit {
            kind: ContextKind::Agent,
            name,
            summary: None,
            projectable: true,
            packageable: false,
        });
    }
    for (name, raw) in read_dir_md(&base.join("context"))? {
        out.push(ContextUnit {
            kind: ContextKind::Context,
            summary: parse_summary(&raw),
            name,
            projectable: true,
            packageable: false,
        });
    }
    for (name, raw) in read_dir_md(&base.join("commands"))? {
        out.push(ContextUnit {
            kind: ContextKind::Command,
            summary: parse_frontmatter_str(&raw, "description").or_else(|| parse_summary(&raw)),
            name,
            projectable: true,
            packageable: false,
        });
    }
    for i in read_manifest(repo_root)?.installed {
        out.push(ContextUnit {
            kind: ContextKind::Skill,
            name: i.name,
            summary: None,
            projectable: true,
            packageable: true,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::install_local;

    #[test]
    fn list_context_enumerates_all_three_kinds() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");

        // One agent, one context doc (with a summary), one installed skill.
        std::fs::create_dir_all(canon.join("agents")).unwrap();
        std::fs::write(canon.join("agents/reviewer.md"), "# Reviewer persona\n").unwrap();
        std::fs::create_dir_all(canon.join("context")).unwrap();
        std::fs::write(
            canon.join("context/kyc.md"),
            "---\nsummary: KYC rules for Peru\n---\nbody\n",
        )
        .unwrap();

        let pkg = tmp.path().join("pkg");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("skill.toml"), "name = \"testing\"\nversion = \"1.0.0\"\n").unwrap();
        std::fs::write(pkg.join("SKILL.md"), "---\nname: testing\n---\nx\n").unwrap();
        install_local(root, &pkg).unwrap();

        let mut units = list_context(root).unwrap();
        units.sort_by(|a, b| (a.kind as u8, &a.name).cmp(&(b.kind as u8, &b.name)));

        assert_eq!(units.len(), 3);
        let agent = units.iter().find(|u| u.kind == ContextKind::Agent).unwrap();
        assert_eq!(agent.name, "reviewer");
        assert!(!agent.packageable);
        let ctx = units.iter().find(|u| u.kind == ContextKind::Context).unwrap();
        assert_eq!(ctx.name, "kyc");
        assert_eq!(ctx.summary.as_deref(), Some("KYC rules for Peru"));
        let skill = units.iter().find(|u| u.kind == ContextKind::Skill).unwrap();
        assert_eq!(skill.name, "testing");
        assert!(skill.packageable);
    }

    #[test]
    fn list_context_includes_commands_with_description_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        std::fs::create_dir_all(canon.join("commands")).unwrap();
        std::fs::write(
            canon.join("commands/deploy.md"),
            "---\ndescription: Ship the current branch\n---\nRun the deploy.\n",
        )
        .unwrap();

        let units = list_context(root).unwrap();
        let cmd = units.iter().find(|u| u.kind == ContextKind::Command).unwrap();
        assert_eq!(cmd.name, "deploy");
        assert_eq!(cmd.summary.as_deref(), Some("Ship the current branch"));
        assert!(!cmd.packageable);
        assert!(cmd.projectable);
    }
}
