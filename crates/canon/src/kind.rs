//! The context-kind contract: the enumerable classes Canon carries into an
//! executor's context — Agent, Context, Memory, Command, Mcp, Spec, Skill (the
//! full CDLC roadmap). Skill, Agent, Command, Context and Mcp are packageable;
//! Spec is surface-only (repo-root `docs/specs`, not projected) and Memory is
//! repo-local.

use crate::manifest::{canon_dir, read_manifest};
use crate::project::{parse_frontmatter_str, parse_summary, read_dir_md};
use crate::CanonError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ContextKind {
    Agent,
    Context,
    Memory,
    Command,
    Mcp,
    Spec,
    Skill,
}

impl ContextKind {
    /// Source subdirectory under `.covenant/canon/` — EXCEPT `Spec`, whose
    /// `"docs/specs"` is repo-root-relative (read_source special-cases it).
    pub fn dir(&self) -> &'static str {
        match self {
            Self::Agent => "agents",
            Self::Context => "context",
            Self::Memory => "memory",
            Self::Command => "commands",
            Self::Mcp => "mcp",
            Self::Spec => "docs/specs",
            Self::Skill => "skills",
        }
    }

    /// Human label for UI section headers.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Agent => "Subagent",
            Self::Context => "Context",
            Self::Memory => "Memory",
            Self::Command => "Command",
            Self::Mcp => "Mcp",
            Self::Spec => "Spec",
            Self::Skill => "Skill",
        }
    }
}

/// Enumerate published specs under `<repo_root>/docs/specs/*.md` as (stem, title).
/// Spec is the one kind whose source is the repo root, not `.covenant/canon/`.
/// Skips subdirs (drafts/, assets/) via the extension check and `_`-prefixed
/// files (e.g. `_template.md`). Title = first Markdown heading, else the stem.
pub(crate) fn read_specs(repo_root: &Path) -> Result<Vec<(String, String)>, CanonError> {
    let dir = repo_root.join("docs/specs");
    let mut out: Vec<(String, String)> = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        if stem.starts_with('_') {
            continue;
        }
        let raw = std::fs::read_to_string(&path)?;
        let title = spec_title(&raw).unwrap_or_else(|| stem.clone());
        out.push((stem, title));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// First Markdown heading line, hashes + whitespace stripped. `None` if none.
fn spec_title(md: &str) -> Option<String> {
    md.lines()
        .map(|l| l.trim())
        .find(|l| l.starts_with('#'))
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .filter(|s| !s.is_empty())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextUnit {
    pub kind: ContextKind,
    pub name: String,
    pub summary: Option<String>,
    pub projectable: bool,
    pub packageable: bool,
    /// None = Canon-managed (has a `.covenant/canon` source).
    /// Some(dir) = detected/foreign, found in this executor dir.
    pub detected_in: Option<String>,
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
            packageable: true,
            detected_in: None,
        });
    }
    for (name, raw) in read_dir_md(&base.join("context"))? {
        out.push(ContextUnit {
            kind: ContextKind::Context,
            summary: parse_summary(&raw),
            name,
            projectable: true,
            packageable: true,
            detected_in: None,
        });
    }
    for (name, raw) in read_dir_md(&base.join("memory"))? {
        out.push(ContextUnit {
            kind: ContextKind::Memory,
            summary: parse_frontmatter_str(&raw, "description").or_else(|| parse_summary(&raw)),
            name,
            projectable: true,
            packageable: false,
            detected_in: None,
        });
    }
    for (name, raw) in read_dir_md(&base.join("commands"))? {
        out.push(ContextUnit {
            kind: ContextKind::Command,
            summary: parse_frontmatter_str(&raw, "description").or_else(|| parse_summary(&raw)),
            name,
            projectable: true,
            packageable: true,
            detected_in: None,
        });
    }
    for (name, srv) in crate::mcp::read_mcp_servers(repo_root)? {
        out.push(ContextUnit {
            kind: ContextKind::Mcp,
            summary: srv.description.clone(),
            name,
            projectable: true,
            packageable: true,
            detected_in: None,
        });
    }
    for (name, title) in read_specs(repo_root)? {
        out.push(ContextUnit {
            kind: ContextKind::Spec,
            summary: Some(title),
            name,
            projectable: false,
            packageable: false,
            detected_in: None,
        });
    }
    for i in read_manifest(repo_root)?.installed {
        out.push(ContextUnit {
            kind: ContextKind::Skill,
            name: i.name,
            summary: None,
            projectable: true,
            packageable: true,
            detected_in: None,
        });
    }

    // Fold in items that live in executor dirs but have no Canon source.
    let managed: std::collections::HashSet<(ContextKind, String)> =
        out.iter().map(|u| (u.kind, u.name.clone())).collect();
    for u in crate::detect::scan_detected(repo_root)? {
        if !managed.contains(&(u.kind, u.name.clone())) {
            out.push(u);
        }
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
        std::fs::write(
            pkg.join("skill.toml"),
            "name = \"testing\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();
        std::fs::write(pkg.join("SKILL.md"), "---\nname: testing\n---\nx\n").unwrap();
        install_local(root, &pkg).unwrap();

        let mut units = list_context(root).unwrap();
        units.sort_by(|a, b| (a.kind as u8, &a.name).cmp(&(b.kind as u8, &b.name)));

        assert_eq!(units.len(), 3);
        let agent = units.iter().find(|u| u.kind == ContextKind::Agent).unwrap();
        assert_eq!(agent.name, "reviewer");
        assert!(agent.packageable);
        let ctx = units
            .iter()
            .find(|u| u.kind == ContextKind::Context)
            .unwrap();
        assert_eq!(ctx.name, "kyc");
        assert_eq!(ctx.summary.as_deref(), Some("KYC rules for Peru"));
        assert!(ctx.packageable);
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
        let cmd = units
            .iter()
            .find(|u| u.kind == ContextKind::Command)
            .unwrap();
        assert_eq!(cmd.name, "deploy");
        assert_eq!(cmd.summary.as_deref(), Some("Ship the current branch"));
        assert!(cmd.packageable);
        assert!(cmd.projectable);
    }

    #[test]
    fn list_context_includes_spec_not_projectable() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        std::fs::create_dir_all(root.join("docs/specs")).unwrap();
        std::fs::write(root.join("docs/specs/3.1-alpha.md"), "# 3.1 — Alpha\n").unwrap();
        let units = list_context(root).unwrap();
        let spec = units.iter().find(|u| u.kind == ContextKind::Spec).unwrap();
        assert_eq!(spec.name, "3.1-alpha");
        assert_eq!(spec.summary.as_deref(), Some("3.1 — Alpha"));
        assert!(!spec.projectable);
        assert!(!spec.packageable);
    }

    #[test]
    fn read_specs_lists_published_excluding_template_and_subdirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join("docs/specs");
        std::fs::create_dir_all(dir.join("drafts")).unwrap();
        std::fs::write(dir.join("3.1-alpha.md"), "# 3.1 — Alpha\n\nbody").unwrap();
        std::fs::write(dir.join("3.2-beta.md"), "no heading here").unwrap();
        std::fs::write(dir.join("_template.md"), "# Template\n").unwrap();
        std::fs::write(dir.join("drafts/wip.md"), "# WIP\n").unwrap();

        let specs = read_specs(root).unwrap();
        // _template excluded, drafts/ excluded → 2 specs, sorted.
        assert_eq!(specs.len(), 2);
        assert_eq!(specs[0].0, "3.1-alpha");
        assert_eq!(specs[0].1, "3.1 — Alpha"); // first heading, hashes stripped
        assert_eq!(specs[1].0, "3.2-beta");
        assert_eq!(specs[1].1, "3.2-beta"); // no heading → stem fallback
    }

    #[test]
    fn list_context_includes_memory_with_description() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/memory");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("decision-x.md"),
            "---\ndescription: We chose X on 2026-07-10\n---\nlonger body\n",
        )
        .unwrap();

        let units = list_context(root).unwrap();
        let mem = units
            .iter()
            .find(|u| u.kind == ContextKind::Memory)
            .unwrap();
        assert_eq!(mem.name, "decision-x");
        assert_eq!(mem.summary.as_deref(), Some("We chose X on 2026-07-10"));
        assert!(mem.projectable);
        assert!(!mem.packageable);
    }

    #[test]
    fn list_context_includes_mcp_with_description() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/mcp");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("ctx7.json"),
            r#"{"command":"npx","description":"C7"}"#,
        )
        .unwrap();
        let units = list_context(root).unwrap();
        let mcp = units.iter().find(|u| u.kind == ContextKind::Mcp).unwrap();
        assert_eq!(mcp.name, "ctx7");
        assert_eq!(mcp.summary.as_deref(), Some("C7"));
        assert!(mcp.packageable);
    }
}
