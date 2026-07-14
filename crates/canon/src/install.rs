use crate::project::project;
use crate::types::{CanonManifest, InstalledRef, SkillManifest};
use crate::{canon_dir, read_manifest, write_manifest, CanonError, ContextKind};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::Path;

/// Accepts only safe package names: non-empty, no leading dot, no path separators.
/// Allowed characters: lowercase ASCII letters, digits, `.`, `-`, `_`.
pub(crate) fn valid_pkg_name(name: &str) -> bool {
    !name.is_empty()
        && !name.starts_with('.')
        && name.bytes().all(|b| {
            b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'.' || b == b'-' || b == b'_'
        })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextRef {
    pub name: String,
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandRef {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpRef {
    pub name: String,
    pub description: Option<String>,
    pub transport: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpecRef {
    pub name: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRef {
    pub name: String,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanonStatus {
    pub installed: Vec<InstalledRef>,
    pub agents: Vec<AgentRef>,
    pub contexts: Vec<ContextRef>,
    pub commands: Vec<CommandRef>,
    pub mcp: Vec<McpRef>,
    pub specs: Vec<SpecRef>,
    pub memory: Vec<MemoryRef>,
}

/// Install a skill package from a local directory, recording `source_label` as provenance.
pub fn install_from_dir(
    repo_root: &Path,
    source_dir: &Path,
    source_label: &str,
) -> Result<InstalledRef, CanonError> {
    let skill_toml = source_dir.join("skill.toml");
    let skill_md = source_dir.join("SKILL.md");
    if !skill_toml.exists() || !skill_md.exists() {
        return Err(CanonError::InvalidPackage(
            "source must contain skill.toml and SKILL.md".into(),
        ));
    }
    let sm: SkillManifest = toml::from_str(&std::fs::read_to_string(&skill_toml)?)?;

    // C1: reject names that could escape the skills directory via path traversal.
    if !valid_pkg_name(&sm.name) {
        return Err(CanonError::InvalidPackage(format!(
            "invalid skill name: {:?}",
            sm.name
        )));
    }

    let payload = std::fs::read(&skill_md)?;
    let sha = format!("{:x}", Sha256::digest(&payload));

    // Copy package into .covenant/canon/skills/<name>/
    let skills_root = canon_dir(repo_root).join("skills");
    let dest = skills_root.join(&sm.name);
    // Belt-and-suspenders: ensure dest stays inside skills_root even after path resolution.
    if !dest.starts_with(&skills_root) {
        return Err(CanonError::InvalidPackage(format!(
            "skill path escapes skills dir: {:?}",
            sm.name
        )));
    }
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
        source: source_label.to_string(),
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

/// Install from a local directory, labeling provenance as `local:<canonical-path>`.
pub fn install_local(repo_root: &Path, source_dir: &Path) -> Result<InstalledRef, CanonError> {
    let label = format!(
        "local:{}",
        source_dir
            .canonicalize()
            .unwrap_or_else(|_| source_dir.to_path_buf())
            .display()
    );
    install_from_dir(repo_root, source_dir, &label)
}

/// Read an installed package's raw files + parsed manifest (for republish).
pub fn read_skill_package(
    repo_root: &Path,
    name: &str,
) -> Result<(String, String, SkillManifest), CanonError> {
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!(
            "invalid skill name: {:?}",
            name
        )));
    }
    let dir = canon_dir(repo_root).join("skills").join(name);
    let toml_s = std::fs::read_to_string(dir.join("skill.toml"))?;
    let md_s = std::fs::read_to_string(dir.join("SKILL.md"))?;
    let sm: SkillManifest = toml::from_str(&toml_s)?;
    Ok((toml_s, md_s, sm))
}

/// Raw source markdown for a single context unit. Path-traversal safe.
pub fn read_source(repo_root: &Path, kind: ContextKind, name: &str) -> Result<String, CanonError> {
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!("invalid name: {name:?}")));
    }
    let path = match kind {
        ContextKind::Spec => repo_root.join("docs/specs").join(format!("{name}.md")),
        ContextKind::Skill => canon_dir(repo_root).join(kind.dir()).join(name).join("SKILL.md"),
        ContextKind::Mcp => canon_dir(repo_root).join(kind.dir()).join(format!("{name}.json")),
        _ => canon_dir(repo_root).join(kind.dir()).join(format!("{name}.md")),
    };
    Ok(std::fs::read_to_string(path)?)
}

fn write_lock(repo_root: &Path, m: &CanonManifest) -> Result<(), CanonError> {
    let lines: Vec<String> = m
        .installed
        .iter()
        .map(|i| format!("{} {} {}", i.name, i.version, i.sha))
        .collect();
    std::fs::write(canon_dir(repo_root).join("canon.lock"), lines.join("\n"))?;
    Ok(())
}

pub fn status(repo_root: &Path) -> Result<CanonStatus, CanonError> {
    let installed = read_manifest(repo_root)?.installed;
    let units = crate::list_context(repo_root)?;
    let agents = units
        .iter()
        .filter(|u| u.kind == crate::ContextKind::Agent)
        .map(|u| AgentRef { name: u.name.clone() })
        .collect();
    let contexts = units
        .iter()
        .filter(|u| u.kind == crate::ContextKind::Context)
        .map(|u| ContextRef {
            name: u.name.clone(),
            summary: u.summary.clone(),
        })
        .collect();
    let commands = units
        .iter()
        .filter(|u| u.kind == crate::ContextKind::Command)
        .map(|u| CommandRef {
            name: u.name.clone(),
            description: u.summary.clone(),
        })
        .collect();
    let mcp = crate::mcp::read_mcp_servers(repo_root)?
        .into_iter()
        .map(|(name, s)| McpRef {
            description: s.description.clone(),
            transport: s.transport_kind(),
            name,
        })
        .collect();
    let specs = crate::kind::read_specs(repo_root)?
        .into_iter()
        .map(|(name, title)| SpecRef { name, title })
        .collect();
    let memory = units
        .iter()
        .filter(|u| u.kind == crate::ContextKind::Memory)
        .map(|u| MemoryRef {
            name: u.name.clone(),
            description: u.summary.clone(),
        })
        .collect();
    Ok(CanonStatus {
        installed,
        agents,
        contexts,
        commands,
        mcp,
        specs,
        memory,
    })
}

/// Content-addressed version for single-file (non-skill) packages: the first
/// 12 hex chars of sha256(content). Stable → republishing unchanged content
/// hits the registry's unique constraint ("already published").
pub fn content_version(content: &str) -> String {
    use sha2::{Digest, Sha256};
    let hex = format!("{:x}", Sha256::digest(content.as_bytes()));
    hex[..12].to_string()
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
        std::fs::write(
            dir.join("SKILL.md"),
            "# KYC Peru\nAlways require the doc.\n",
        )
        .unwrap();
    }

    #[test]
    fn path_traversal_is_rejected() {
        let base = std::env::temp_dir().join(format!("canon-trav-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        let src = base.join("src-evil");
        std::fs::create_dir_all(&src).unwrap();
        // Manually write a skill.toml with an attacker-controlled name.
        std::fs::write(
            src.join("skill.toml"),
            "name = \"../escape\"\nversion = \"1.0.0\"\nowner = \"github:attacker\"\n",
        )
        .unwrap();
        std::fs::write(src.join("SKILL.md"), "# Evil\nevil content\n").unwrap();
        std::fs::create_dir_all(&repo).unwrap();

        let result = install_local(&repo, &src);
        assert!(result.is_err(), "path traversal name must be rejected");

        // Nothing should have been written outside the repo.
        let escape_path = base.join("repo/.covenant/canon/skills").join("../escape");
        assert!(!escape_path.exists(), "escape path must not exist on disk");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn install_then_projection_is_idempotent() {
        let base = std::env::temp_dir().join(format!("canon-inst-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        let src = base.join("src-kyc");
        std::fs::create_dir_all(&repo).unwrap();
        write_pkg(&src, "kyc-peru");

        let r = install_local(&repo, &src).unwrap();
        assert_eq!(r.name, "kyc-peru");
        assert!(repo
            .join(".covenant/canon/skills/kyc-peru/SKILL.md")
            .exists());
        assert!(repo.join(".claude/skills/canon-kyc-peru/SKILL.md").exists());

        let agents1 = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        // Re-project: must not duplicate the managed block.
        crate::project::project(&repo).unwrap();
        let agents2 = std::fs::read_to_string(repo.join("AGENTS.md")).unwrap();
        assert_eq!(agents1, agents2, "projection must be idempotent");
        assert_eq!(agents2.matches("<!-- canon:start -->").count(), 1);

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn install_from_dir_uses_custom_source_label() {
        let base = std::env::temp_dir().join(format!("canon-srclabel-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.join("repo");
        let src = base.join("src");
        std::fs::create_dir_all(&repo).unwrap();
        write_pkg(&src, "kyc-peru");
        let r = install_from_dir(&repo, &src, "registry:mibanco/kyc-peru@1.0.0").unwrap();
        assert_eq!(r.source, "registry:mibanco/kyc-peru@1.0.0");
        // read it back
        let (toml_s, md_s, sm) = read_skill_package(&repo, "kyc-peru").unwrap();
        assert!(toml_s.contains("kyc-peru"));
        assert!(md_s.contains("KYC"));
        assert_eq!(sm.name, "kyc-peru");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn status_lists_agents_and_contexts_with_summary() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        std::fs::create_dir_all(canon.join("agents")).unwrap();
        std::fs::write(canon.join("agents/reviewer.md"), "persona\n").unwrap();
        std::fs::create_dir_all(canon.join("context")).unwrap();
        std::fs::write(
            canon.join("context/kyc.md"),
            "---\nsummary: KYC rules\n---\nbody\n",
        )
        .unwrap();

        let s = status(root).unwrap();
        assert_eq!(s.agents.len(), 1);
        assert_eq!(s.agents[0].name, "reviewer");
        assert_eq!(s.contexts.len(), 1);
        assert_eq!(s.contexts[0].name, "kyc");
        assert_eq!(s.contexts[0].summary.as_deref(), Some("KYC rules"));
        assert!(s.installed.is_empty());
    }

    #[test]
    fn status_lists_commands_with_description() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        std::fs::create_dir_all(canon.join("commands")).unwrap();
        std::fs::write(
            canon.join("commands/review.md"),
            "---\ndescription: Review the diff\n---\nbody\n",
        )
        .unwrap();

        let s = status(root).unwrap();
        assert_eq!(s.commands.len(), 1);
        assert_eq!(s.commands[0].name, "review");
        assert_eq!(s.commands[0].description.as_deref(), Some("Review the diff"));
    }

    #[test]
    fn read_source_returns_agent_and_context_bodies() {
        use crate::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        std::fs::create_dir_all(canon.join("agents")).unwrap();
        std::fs::write(canon.join("agents/reviewer.md"), "PERSONA BODY").unwrap();
        std::fs::create_dir_all(canon.join("context")).unwrap();
        std::fs::write(canon.join("context/kyc.md"), "CTX BODY").unwrap();

        assert_eq!(read_source(root, ContextKind::Agent, "reviewer").unwrap(), "PERSONA BODY");
        assert_eq!(read_source(root, ContextKind::Context, "kyc").unwrap(), "CTX BODY");
        assert!(read_source(root, ContextKind::Agent, "../etc/passwd").is_err());
    }

    #[test]
    fn read_source_reads_spec_from_docs_specs() {
        use crate::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("docs/specs")).unwrap();
        std::fs::write(root.join("docs/specs/3.1-alpha.md"), "SPEC BODY").unwrap();
        let body = read_source(root, ContextKind::Spec, "3.1-alpha").unwrap();
        assert_eq!(body, "SPEC BODY");
    }

    #[test]
    fn read_source_reads_mcp_json() {
        use crate::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/mcp");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ctx7.json"), r#"{"command":"npx"}"#).unwrap();
        let body = read_source(root, ContextKind::Mcp, "ctx7").unwrap();
        assert!(body.contains("npx"));
    }

    #[test]
    fn read_source_reads_memory_from_canon_dir() {
        use crate::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/memory");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("decision-x.md"), "MEM BODY").unwrap();
        let body = read_source(root, ContextKind::Memory, "decision-x").unwrap();
        assert_eq!(body, "MEM BODY");
    }

    #[test]
    fn status_lists_mcp_with_transport() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/mcp");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("ctx7.json"), r#"{"command":"npx","description":"C7"}"#).unwrap();
        let s = status(root).unwrap();
        assert_eq!(s.mcp.len(), 1);
        assert_eq!(s.mcp[0].name, "ctx7");
        assert_eq!(s.mcp[0].transport, "stdio");
        assert_eq!(s.mcp[0].description.as_deref(), Some("C7"));
    }

    #[test]
    fn status_lists_specs_with_title() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("docs/specs")).unwrap();
        std::fs::write(root.join("docs/specs/3.1-alpha.md"), "# 3.1 — Alpha\n").unwrap();
        let s = status(root).unwrap();
        assert_eq!(s.specs.len(), 1);
        assert_eq!(s.specs[0].name, "3.1-alpha");
        assert_eq!(s.specs[0].title, "3.1 — Alpha");
    }

    #[test]
    fn status_lists_memory_with_description() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/memory");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("pref-z.md"), "---\ndescription: User prefers Z\n---\nbody\n").unwrap();
        let s = status(root).unwrap();
        assert_eq!(s.memory.len(), 1);
        assert_eq!(s.memory[0].name, "pref-z");
        assert_eq!(s.memory[0].description.as_deref(), Some("User prefers Z"));
    }

    #[test]
    fn content_version_is_short_stable_hex() {
        let v = content_version("hello");
        assert_eq!(v.len(), 12);
        assert_eq!(v, content_version("hello"));
        assert_ne!(v, content_version("world"));
        assert!(v.bytes().all(|b| b.is_ascii_hexdigit()));
    }
}
