//! Cursor CLI adapter — discovers skills and slash commands for Cursor's
//! `agent` CLI.
//!
//! Layout:
//!
//! - `~/.cursor/skills/<name>/SKILL.md` — user skills (Superpowers convention)
//! - `<repo>/.cursor/skills/<name>/SKILL.md` — project skills (Canon projects here)
//! - `<repo>/.cursor/commands/*.md` — project slash commands (Canon projects here)
//!
//! Memory is `AGENTS.md` (shared managed block, surfaced under codex's
//! Memory today). MCP (`.cursor/mcp.json`) is deferred.

use crate::frontmatter;
use crate::model::CapabilityResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum CursorScope {
    User,
    Project(PathBuf),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: CursorScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Command {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: CursorScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Capability {
    Skill(Skill),
    Command(Command),
}

pub fn detect(home: &Path) -> bool {
    home.join(".cursor").is_dir()
}

pub fn scan_user(home: &Path) -> CapabilityResult<Vec<Capability>> {
    let root = home.join(".cursor");
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    scan_skills(&root.join("skills"), CursorScope::User, &mut out)?;
    Ok(out)
}

pub fn scan_project(repo: &Path) -> CapabilityResult<Vec<Capability>> {
    let root = repo.join(".cursor");
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    let scope = CursorScope::Project(repo.to_path_buf());
    scan_skills(&root.join("skills"), scope.clone(), &mut out)?;
    scan_commands(&root.join("commands"), scope, &mut out)?;
    Ok(out)
}

fn scan_skills(dir: &Path, scope: CursorScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let raw = std::fs::read_to_string(&skill_md)?;
        let fm = frontmatter::parse(&raw);
        let dir_name = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm.name().map(str::to_string).unwrap_or(dir_name);
        let description = fm.description().unwrap_or("").to_string();
        out.push(Capability::Skill(Skill {
            name,
            description,
            path: skill_md,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

fn scan_commands(dir: &Path, scope: CursorScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() || path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let raw = std::fs::read_to_string(&path)?;
        let fm = frontmatter::parse(&raw);
        let stem = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = fm.name().map(str::to_string).unwrap_or(stem);
        let description = fm.description().unwrap_or("").to_string();
        out.push(Capability::Command(Command {
            name,
            description,
            path,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write(path: &Path, contents: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, contents).unwrap();
    }

    #[test]
    fn missing_cursor_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        assert!(scan_user(tmp.path()).unwrap().is_empty());
        assert!(scan_project(tmp.path()).unwrap().is_empty());
        assert!(!detect(tmp.path()));
    }

    #[test]
    fn user_skills_are_discovered_with_frontmatter() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join(".cursor/skills/deploy/SKILL.md"),
            "---\nname: deploy\ndescription: Ship it\n---\nbody\n",
        );
        let caps = scan_user(tmp.path()).unwrap();
        assert_eq!(caps.len(), 1);
        match &caps[0] {
            Capability::Skill(s) => {
                assert_eq!(s.name, "deploy");
                assert_eq!(s.description, "Ship it");
                assert_eq!(s.scope, CursorScope::User);
            }
            other => panic!("expected skill, got {other:?}"),
        }
    }

    #[test]
    fn project_scan_finds_skills_and_commands() {
        let tmp = TempDir::new().unwrap();
        write(
            &tmp.path().join(".cursor/skills/canon-style/SKILL.md"),
            "---\nname: canon-style\ndescription: House style\n---\n",
        );
        write(
            &tmp.path().join(".cursor/commands/release.md"),
            "---\ndescription: Cut a release\n---\nsteps\n",
        );
        let mut caps = scan_project(tmp.path()).unwrap();
        caps.sort_by_key(|c| match c {
            Capability::Skill(_) => 0,
            Capability::Command(_) => 1,
        });
        assert_eq!(caps.len(), 2);
        assert!(matches!(&caps[0], Capability::Skill(s) if s.name == "canon-style"));
        match &caps[1] {
            Capability::Command(c) => {
                assert_eq!(c.name, "release");
                assert_eq!(c.description, "Cut a release");
                assert!(matches!(c.scope, CursorScope::Project(_)));
            }
            other => panic!("expected command, got {other:?}"),
        }
    }

    #[test]
    fn skill_dir_without_skill_md_is_skipped() {
        let tmp = TempDir::new().unwrap();
        std::fs::create_dir_all(tmp.path().join(".cursor/skills/empty")).unwrap();
        assert!(scan_user(tmp.path()).unwrap().is_empty());
    }
}
