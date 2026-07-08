//! Covenant Canon adapter — surfaces the per-repo context-governance artifacts
//! under `<repo>/.covenant/canon/`. Project-scoped only (there is no user scope).
//!
//! Real layout (see `crates/canon`):
//! - `canon.toml` / `canon.lock` → **Manifest**
//! - `skills/<name>/SKILL.md`  → **Skills** (installed Canon packages)

use crate::frontmatter;
use crate::model::CapabilityResult;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub name: String,
    pub description: String,
    /// `manifest` (canon.toml/lock) or `skill` (a SKILL.md package).
    pub kind: String,
    pub path: PathBuf,
}

/// Scan `<repo>/.covenant/canon`. Returns empty when the dir is absent.
pub fn scan_project(repo: &Path) -> CapabilityResult<Vec<Artifact>> {
    let root = repo.join(".covenant").join("canon");
    let mut out = Vec::new();
    if !root.is_dir() {
        return Ok(out);
    }

    for f in ["canon.toml", "canon.lock"] {
        let p = root.join(f);
        if p.is_file() {
            out.push(Artifact {
                name: f.to_string(),
                description: "Canon manifest".to_string(),
                kind: "manifest".to_string(),
                path: p,
            });
        }
    }

    let skills = root.join("skills");
    if skills.is_dir() {
        for entry in std::fs::read_dir(&skills)? {
            let dir = entry?.path();
            let skill_md = dir.join("SKILL.md");
            if !skill_md.is_file() {
                continue;
            }
            let raw = std::fs::read_to_string(&skill_md)?;
            let fm = frontmatter::parse(&raw);
            let fallback = dir
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let name = fm.name().unwrap_or(&fallback).to_string();
            let description = fm.description().unwrap_or("").to_string();
            out.push(Artifact {
                name,
                description,
                kind: "skill".to_string(),
                path: skill_md,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    #[test]
    fn missing_dir_returns_empty() {
        let tmp = TempDir::new().unwrap();
        assert!(scan_project(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn lists_manifest_and_skills() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path();
        write(&repo.join(".covenant/canon/canon.toml"), "version = 1\n");
        write(&repo.join(".covenant/canon/canon.lock"), "");
        write(
            &repo.join(".covenant/canon/skills/kyc-peru/SKILL.md"),
            "---\nname: kyc-peru\ndescription: KYC Perú\n---\nbody",
        );
        let out = scan_project(repo).unwrap();
        assert_eq!(out.len(), 3);
        let skill = out.iter().find(|a| a.kind == "skill").unwrap();
        assert_eq!(skill.name, "kyc-peru");
        assert_eq!(skill.description, "KYC Perú");
        assert_eq!(out.iter().filter(|a| a.kind == "manifest").count(), 2);
    }

    #[test]
    fn skill_dir_without_skill_md_skipped() {
        let tmp = TempDir::new().unwrap();
        let repo = tmp.path();
        fs::create_dir_all(repo.join(".covenant/canon/skills/empty")).unwrap();
        write(&repo.join(".covenant/canon/canon.toml"), "version = 1\n");
        let out = scan_project(repo).unwrap();
        assert_eq!(out.len(), 1);
    }
}
