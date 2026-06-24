use crate::project::project;
use crate::types::{CdlcManifest, InstalledRef, SkillManifest};
use crate::{cdlc_dir, read_manifest, write_manifest, CdlcError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CdlcStatus {
    pub installed: Vec<InstalledRef>,
    pub context_files: Vec<String>,
}

/// Install a skill package from a local directory containing `skill.toml` + `SKILL.md`.
pub fn install_local(repo_root: &Path, source_dir: &Path) -> Result<InstalledRef, CdlcError> {
    let skill_toml = source_dir.join("skill.toml");
    let skill_md = source_dir.join("SKILL.md");
    if !skill_toml.exists() || !skill_md.exists() {
        return Err(CdlcError::InvalidPackage(
            "source must contain skill.toml and SKILL.md".into(),
        ));
    }
    let sm: SkillManifest = toml::from_str(&std::fs::read_to_string(&skill_toml)?)?;
    let payload = std::fs::read(&skill_md)?;
    let sha = format!("{:x}", Sha256::digest(&payload));

    // Copy package into .covenant/cdlc/skills/<name>/
    let dest = cdlc_dir(repo_root).join("skills").join(&sm.name);
    std::fs::create_dir_all(&dest)?;
    std::fs::copy(&skill_toml, dest.join("skill.toml"))?;
    std::fs::write(dest.join("SKILL.md"), &payload)?;

    // Upsert manifest entry by name.
    let mut manifest = read_manifest(repo_root)?;
    if manifest.version == 0 {
        manifest.version = 1;
    }
    let r = InstalledRef {
        name: sm.name.clone(),
        version: sm.version.clone(),
        source: format!("local:{}", source_dir.display()),
        sha,
        signer: sm.owner.clone(),
        installed_at: chrono::Utc::now().to_rfc3339(),
    };
    manifest.installed.retain(|i| i.name != sm.name);
    manifest.installed.push(r.clone());
    write_manifest(repo_root, &manifest)?;
    write_lock(repo_root, &manifest)?;

    project(repo_root)?;
    Ok(r)
}

fn write_lock(repo_root: &Path, m: &CdlcManifest) -> Result<(), CdlcError> {
    let lines: Vec<String> = m
        .installed
        .iter()
        .map(|i| format!("{} {} {}", i.name, i.version, i.sha))
        .collect();
    std::fs::write(cdlc_dir(repo_root).join("cdlc.lock"), lines.join("\n"))?;
    Ok(())
}

pub fn status(repo_root: &Path) -> Result<CdlcStatus, CdlcError> {
    let installed = read_manifest(repo_root)?.installed;
    let ctx_dir = cdlc_dir(repo_root).join("context");
    let mut context_files = Vec::new();
    if ctx_dir.exists() {
        for entry in std::fs::read_dir(&ctx_dir)? {
            let entry = entry?;
            if entry.path().extension().and_then(|s| s.to_str()) == Some("md") {
                if let Some(name) = entry.file_name().to_str() {
                    context_files.push(name.to_string());
                }
            }
        }
    }
    context_files.sort();
    Ok(CdlcStatus { installed, context_files })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_pkg(dir: &Path, name: &str) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(
            dir.join("skill.toml"),
            format!("name = \"{name}\"\nversion = \"1.0.0\"\nowner = \"github:mibanco\"\n"),
        )
        .unwrap();
        std::fs::write(dir.join("SKILL.md"), "# KYC Peru\nAlways require the doc.\n").unwrap();
    }

    #[test]
    fn install_then_projection_is_idempotent() {
        let base = std::env::temp_dir().join(format!("cdlc-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        let src = base.join("src-kyc");
        std::fs::create_dir_all(&repo).unwrap();
        write_pkg(&src, "kyc-peru");

        let r = install_local(&repo, &src).unwrap();
        assert_eq!(r.name, "kyc-peru");
        assert!(repo.join(".covenant/cdlc/skills/kyc-peru/SKILL.md").exists());
        assert!(repo.join(".claude/skills/cdlc-kyc-peru/SKILL.md").exists());

        let agents1 = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        // Re-project: must not duplicate the managed block.
        crate::project::project(&repo).unwrap();
        let agents2 = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        assert_eq!(agents1, agents2, "projection must be idempotent");
        assert_eq!(agents2.matches("<!-- cdlc:start -->").count(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }
}
