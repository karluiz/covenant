//! Pi adapter — discovers extensions, skills, and prompts configured
//! for the `pi` coding agent (https://pi.dev).
//!
//! Layout (user scope, best-guess from Pi's docs and the npm CLI's
//! `--session-dir`/`--config` conventions — revisit once we have a
//! Pi install handy):
//!
//! - `~/.pi/extensions/*.ts` — user-authored Pi extensions
//! - `~/.pi/skills/<name>/SKILL.md` — skills (Superpowers convention)
//! - `~/.pi/prompts/*.md` — prompt presets (frontmatter optional)
//! - `~/.pi/config.json` — agent config (surfaced as a single capability)
//!
//! Project scope is reserved (`.pi/` inside a repo) but not scanned yet
//! — Pi's project-level conventions aren't documented as of writing.

use crate::frontmatter;
use crate::model::CapabilityResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum PiScope {
    User,
    Project(PathBuf),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Extension {
    pub name: String,
    pub path: PathBuf,
    pub scope: PiScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: PiScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Prompt {
    pub name: String,
    pub description: String,
    pub path: PathBuf,
    pub scope: PiScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub path: PathBuf,
    pub scope: PiScope,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Capability {
    Extension(Extension),
    Skill(Skill),
    Prompt(Prompt),
    Config(Config),
}

pub fn detect(home: &Path) -> bool {
    home.join(".pi").is_dir()
}

pub fn scan_user(home: &Path) -> CapabilityResult<Vec<Capability>> {
    let root = home.join(".pi");
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }
    scan_extensions(&root.join("extensions"), PiScope::User, &mut out)?;
    scan_skills(&root.join("skills"), PiScope::User, &mut out)?;
    scan_prompts(&root.join("prompts"), PiScope::User, &mut out)?;
    scan_config(&root.join("config.json"), PiScope::User, &mut out);
    Ok(out)
}

/// Project-level scan — placeholder for when Pi's project conventions
/// are documented. Currently returns an empty vec so the rest of the
/// capabilities pipeline (which calls this for every opened repo) is
/// a no-op for Pi tabs.
pub fn scan_project(_repo: &Path) -> CapabilityResult<Vec<Capability>> {
    Ok(Vec::new())
}

fn scan_extensions(
    dir: &Path,
    scope: PiScope,
    out: &mut Vec<Capability>,
) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        // Accept .ts / .js / .mjs — Pi's extension model is TS-first
        // per docs, but transpiled output is plausible too.
        let ok_ext = path
            .extension()
            .and_then(|s| s.to_str())
            .map(|e| matches!(e, "ts" | "js" | "mjs"))
            .unwrap_or(false);
        if !ok_ext {
            continue;
        }
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        out.push(Capability::Extension(Extension {
            name,
            path,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

fn scan_skills(dir: &Path, scope: PiScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
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

fn scan_prompts(dir: &Path, scope: PiScope, out: &mut Vec<Capability>) -> CapabilityResult<()> {
    if !dir.is_dir() {
        return Ok(());
    }
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
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
        out.push(Capability::Prompt(Prompt {
            name,
            description,
            path,
            scope: scope.clone(),
        }));
    }
    Ok(())
}

fn scan_config(path: &Path, scope: PiScope, out: &mut Vec<Capability>) {
    if path.is_file() {
        out.push(Capability::Config(Config {
            path: path.to_path_buf(),
            scope,
        }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, body: &str) {
        if let Some(p) = path.parent() {
            fs::create_dir_all(p).unwrap();
        }
        fs::write(path, body).unwrap();
    }

    #[test]
    fn detect_false_without_pi_dir() {
        let tmp = TempDir::new().unwrap();
        assert!(!detect(tmp.path()));
    }

    #[test]
    fn detect_true_with_pi_dir() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join(".pi")).unwrap();
        assert!(detect(tmp.path()));
    }

    #[test]
    fn scan_user_no_pi_dir_is_empty() {
        let tmp = TempDir::new().unwrap();
        let caps = scan_user(tmp.path()).unwrap();
        assert!(caps.is_empty());
    }

    #[test]
    fn scan_user_finds_typescript_extensions() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".pi/extensions/foo.ts"), "export default {}");
        write(&home.join(".pi/extensions/bar.js"), "module.exports = {}");
        // Non-script files are ignored.
        write(&home.join(".pi/extensions/README.md"), "ignore me");

        let caps = scan_user(home).unwrap();
        let exts: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::Extension(e) => Some(e),
                _ => None,
            })
            .collect();
        assert_eq!(exts.len(), 2);
        let names: Vec<_> = exts.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"foo"));
        assert!(names.contains(&"bar"));
    }

    #[test]
    fn scan_user_finds_skill_md_inside_skill_dirs() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".pi/skills/refactoring/SKILL.md"),
            "---\nname: refactoring\ndescription: do the refactor\n---\nbody",
        );
        // A dir without SKILL.md is skipped.
        fs::create_dir_all(home.join(".pi/skills/empty")).unwrap();

        let caps = scan_user(home).unwrap();
        let skills: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::Skill(s) => Some(s),
                _ => None,
            })
            .collect();
        assert_eq!(skills.len(), 1);
        assert_eq!(skills[0].name, "refactoring");
        assert_eq!(skills[0].description, "do the refactor");
    }

    #[test]
    fn scan_user_uses_dir_name_when_skill_md_lacks_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".pi/skills/quick/SKILL.md"), "no frontmatter here");
        let caps = scan_user(home).unwrap();
        let skill = caps.iter().find_map(|c| match c {
            Capability::Skill(s) => Some(s),
            _ => None,
        });
        assert_eq!(skill.unwrap().name, "quick");
    }

    #[test]
    fn scan_user_parses_prompts() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(
            &home.join(".pi/prompts/review.md"),
            "---\nname: review\ndescription: do a review\n---\nbody",
        );
        let caps = scan_user(home).unwrap();
        let prompts: Vec<_> = caps
            .iter()
            .filter_map(|c| match c {
                Capability::Prompt(p) => Some(p),
                _ => None,
            })
            .collect();
        assert_eq!(prompts.len(), 1);
        assert_eq!(prompts[0].name, "review");
    }

    #[test]
    fn scan_user_surfaces_config_json_when_present() {
        let tmp = TempDir::new().unwrap();
        let home = tmp.path();
        write(&home.join(".pi/config.json"), "{}");
        let caps = scan_user(home).unwrap();
        let configs: Vec<_> = caps
            .iter()
            .filter(|c| matches!(c, Capability::Config(_)))
            .collect();
        assert_eq!(configs.len(), 1);
    }

    #[test]
    fn scan_project_is_empty_placeholder() {
        let tmp = TempDir::new().unwrap();
        let caps = scan_project(tmp.path()).unwrap();
        assert!(caps.is_empty());
    }
}
