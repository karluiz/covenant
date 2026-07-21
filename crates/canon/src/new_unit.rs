//! Author a fresh Canon unit from the cockpit: write a scaffold in the shape
//! that kind expects, install/project it, and hand back the path so the caller
//! can open it in the editor. The inverse of `detect`/`adopt` — those import
//! what already exists, this one starts from nothing.

use crate::compile::slugify;
use crate::install::{install_from_dir, install_unit};
use crate::manifest::canon_dir;
use crate::types::SkillManifest;
use crate::{project, CanonError, ContextKind};
use std::path::{Path, PathBuf};

/// Where a unit of `kind` named `slug` lives. `Spec` and `Context` are not
/// authored here (Specs go through the Spec Creator; Context through the miner).
fn unit_path(repo_root: &Path, kind: ContextKind, slug: &str) -> Result<PathBuf, CanonError> {
    let dir = canon_dir(repo_root).join(kind.dir());
    Ok(match kind {
        ContextKind::Agent | ContextKind::Command | ContextKind::Memory => {
            dir.join(format!("{slug}.md"))
        }
        ContextKind::Mcp => dir.join(format!("{slug}.json")),
        ContextKind::Skill => dir.join(slug).join("SKILL.md"),
        ContextKind::Spec | ContextKind::Context => {
            return Err(CanonError::InvalidPackage(format!(
                "kind {kind:?} is not authored from the cockpit"
            )))
        }
    })
}

/// The starting contents for a new unit — enough frontmatter that the executor
/// accepts it, and one line of prose telling the author what to replace.
fn scaffold(kind: ContextKind, slug: &str) -> String {
    match kind {
        ContextKind::Agent => format!(
            "---\nname: {slug}\ndescription: One line on when to use this subagent.\n---\n\n# {slug}\n\nDescribe the job, the tools it may use, and where it must stop.\n"
        ),
        ContextKind::Command => format!(
            "---\ndescription: One line on what this command does.\n---\n\n# {slug}\n\nThe prompt this slash command runs.\n"
        ),
        ContextKind::Memory => format!(
            "---\ndescription: One line on the fact this memory carries.\n---\n\n# {slug}\n\nThe durable fact, and why it matters.\n"
        ),
        ContextKind::Skill => format!(
            "---\nname: {slug}\ndescription: One line on when to use this skill.\nversion: 1.0.0\n---\n\n# {slug}\n\nWhat this skill does, and when to reach for it.\n"
        ),
        ContextKind::Mcp => {
            let srv = crate::mcp::McpServer {
                transport: Some("stdio".into()),
                command: Some(String::new()),
                description: Some("One line on what this server provides.".into()),
                ..Default::default()
            };
            serde_json::to_string_pretty(&srv).unwrap_or_else(|_| "{}".into())
        }
        ContextKind::Spec | ContextKind::Context => String::new(),
    }
}

/// Create a new Canon unit and return the path to edit. Errors when the name
/// slugifies to nothing, when the unit already exists, or for a kind that is
/// not authored from the cockpit.
pub fn new_unit(repo_root: &Path, kind: ContextKind, name: &str) -> Result<PathBuf, CanonError> {
    let slug = slugify(name);
    if slug.is_empty() {
        return Err(CanonError::InvalidPackage(format!(
            "cannot derive a valid name from {name:?}"
        )));
    }
    let path = unit_path(repo_root, kind, &slug)?;
    if path.exists() {
        return Err(CanonError::InvalidPackage(format!(
            "{} already exists",
            path.display()
        )));
    }
    let body = scaffold(kind, &slug);
    match kind {
        // install_unit writes the source file AND projects — the same call
        // `adopt` uses for these three kinds.
        ContextKind::Agent | ContextKind::Command | ContextKind::Mcp => {
            install_unit(repo_root, kind, &slug, &body)?;
        }
        ContextKind::Memory => {
            std::fs::create_dir_all(path.parent().expect("unit path has a parent"))?;
            std::fs::write(&path, body)?;
            project(repo_root)?;
        }
        ContextKind::Skill => {
            // install_from_dir COPIES source → `.covenant/canon/skills/<name>`
            // and registers the manifest entry the Skills list reads, so stage
            // the package in a temp dir rather than writing the destination
            // directly (a copy onto itself would truncate the file).
            let staging =
                std::env::temp_dir().join(format!("canon-new-{}-{slug}", std::process::id()));
            std::fs::create_dir_all(&staging)?;
            std::fs::write(staging.join("SKILL.md"), body)?;
            let manifest = SkillManifest {
                name: slug.clone(),
                version: "1.0.0".to_string(),
                owner: None,
                deps: Vec::new(),
            };
            std::fs::write(staging.join("skill.toml"), toml::to_string_pretty(&manifest)?)?;
            let installed = install_from_dir(repo_root, &staging, "new");
            let _ = std::fs::remove_dir_all(&staging);
            installed?;
        }
        ContextKind::Spec | ContextKind::Context => unreachable!("rejected by unit_path"),
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_a_scaffold_for_every_authorable_kind() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let cases = [
            (ContextKind::Agent, ".covenant/canon/agents/reviewer.md"),
            (ContextKind::Command, ".covenant/canon/commands/reviewer.md"),
            (ContextKind::Memory, ".covenant/canon/memory/reviewer.md"),
            (ContextKind::Mcp, ".covenant/canon/mcp/reviewer.json"),
            (ContextKind::Skill, ".covenant/canon/skills/reviewer/SKILL.md"),
        ];
        for (kind, rel) in cases {
            let path = new_unit(root, kind, "reviewer").unwrap();
            assert_eq!(path, root.join(rel), "{kind:?} landed at the wrong path");
            assert!(path.exists(), "{kind:?} scaffold was not written");
            assert!(
                !std::fs::read_to_string(&path).unwrap().is_empty(),
                "{kind:?} scaffold is empty"
            );
            std::fs::remove_file(&path).unwrap();
        }
    }

    #[test]
    fn mcp_scaffold_is_valid_server_json() {
        let tmp = tempfile::tempdir().unwrap();
        let path = new_unit(tmp.path(), ContextKind::Mcp, "ctx7").unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let srv: crate::mcp::McpServer = serde_json::from_str(&raw).unwrap();
        assert_eq!(srv.transport_kind(), "stdio");
    }

    #[test]
    fn a_new_mcp_server_is_projected_under_its_canon_prefix() {
        let tmp = tempfile::tempdir().unwrap();
        new_unit(tmp.path(), ContextKind::Mcp, "ctx7").unwrap();
        let projected = std::fs::read_to_string(tmp.path().join(".mcp.json")).unwrap();
        assert!(projected.contains("canon-ctx7"), "not projected: {projected}");
    }

    #[test]
    fn slugifies_the_given_name() {
        let tmp = tempfile::tempdir().unwrap();
        let path = new_unit(tmp.path(), ContextKind::Agent, "My Reviewer").unwrap();
        assert_eq!(path.file_name().unwrap(), "my-reviewer.md");
    }

    #[test]
    fn rejects_an_empty_slug() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(new_unit(tmp.path(), ContextKind::Agent, "  ///  ").is_err());
    }

    #[test]
    fn refuses_to_clobber_an_existing_unit() {
        let tmp = tempfile::tempdir().unwrap();
        new_unit(tmp.path(), ContextKind::Command, "deploy").unwrap();
        let err = new_unit(tmp.path(), ContextKind::Command, "deploy").unwrap_err();
        assert!(format!("{err}").contains("already exists"), "got: {err}");
    }

    #[test]
    fn rejects_kinds_that_are_not_authored_here() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(new_unit(tmp.path(), ContextKind::Spec, "3.1-thing").is_err());
        assert!(new_unit(tmp.path(), ContextKind::Context, "thing").is_err());
    }
}
