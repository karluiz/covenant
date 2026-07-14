//! Compile curated miner findings into a distributable skill package
//! (SKILL.md + skill.toml) under `.covenant/canon/skills/<name>/`.

use crate::install::valid_pkg_name;
use crate::manifest::canon_dir;
use crate::types::SkillManifest;
use crate::CanonError;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompiledFinding {
    pub category: String,
    pub title: String,
    pub body_md: String,
    pub evidence: Vec<String>,
    pub confidence: String,
    #[serde(default)]
    pub kind: String,
}

const CATEGORY_ORDER: &[(&str, &str)] = &[
    ("convention", "Conventions"),
    ("pattern", "Patterns"),
    ("gotcha", "Gotchas"),
    ("domain_rule", "Domain rules"),
    ("glossary", "Glossary"),
];

pub fn render_skill_md(name: &str, findings: &[CompiledFinding]) -> String {
    let mut out = format!(
        "---\nname: {name}\ndescription: Mined context for {name}\nversion: 1.0.0\n---\n\n# {name}\n\nContext mined from the repository. Each entry cites the evidence it was\nderived from.\n"
    );
    for (key, heading) in CATEGORY_ORDER {
        let in_cat: Vec<&CompiledFinding> =
            findings.iter().filter(|f| f.category == *key).collect();
        if in_cat.is_empty() {
            continue;
        }
        out.push_str(&format!("\n## {heading}\n"));
        for f in in_cat {
            out.push_str(&format!("\n### {}\n\n{}\n", f.title, f.body_md.trim()));
            if !f.evidence.is_empty() {
                out.push_str("\nEvidence: ");
                let refs: Vec<String> =
                    f.evidence.iter().map(|e| format!("`{e}`")).collect();
                out.push_str(&refs.join(", "));
                out.push('\n');
            }
        }
    }
    out
}

pub fn write_skill_package(
    repo_root: &Path,
    name: &str,
    owner: Option<&str>,
    findings: &[CompiledFinding],
    overwrite: bool,
) -> Result<PathBuf, CanonError> {
    if findings.is_empty() {
        return Err(CanonError::InvalidPackage("no accepted findings to compile".into()));
    }
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!(
            "invalid skill name '{name}' (lowercase ascii/digits/dash/dot/underscore)"
        )));
    }
    let dir = canon_dir(repo_root).join("skills").join(name);
    if dir.exists() && !overwrite {
        return Err(CanonError::InvalidPackage(format!("skill '{name}' already exists")));
    }
    std::fs::create_dir_all(&dir)?;
    std::fs::write(dir.join("SKILL.md"), render_skill_md(name, findings))?;
    let manifest = SkillManifest {
        name: name.to_string(),
        version: "1.0.0".to_string(),
        owner: owner.map(str::to_string),
        deps: Vec::new(),
    };
    let toml_text = toml::to_string_pretty(&manifest)?;
    std::fs::write(dir.join("skill.toml"), toml_text)?;
    Ok(dir)
}

/// Kebab-case a finding title into a filename slug.
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut prev_dash = false;
    for ch in title.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash && !out.is_empty() {
            out.push('-');
            prev_dash = true;
        }
    }
    out.trim_matches('-').to_string()
}

/// Slug not already used on disk or in `taken`; suffixes -2, -3, … on collision.
fn unique_slug(dir: &Path, base: &str, taken: &mut std::collections::HashSet<String>) -> String {
    let base = if base.is_empty() { "entry".to_string() } else { base.to_string() };
    let mut candidate = base.clone();
    let mut n = 1;
    while taken.contains(&candidate) || dir.join(format!("{candidate}.md")).exists() {
        n += 1;
        candidate = format!("{base}-{n}");
    }
    taken.insert(candidate.clone());
    candidate
}

fn write_md_entries(dir: &Path, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError> {
    std::fs::create_dir_all(dir)?;
    let mut taken = std::collections::HashSet::new();
    let mut out = Vec::new();
    for f in findings {
        let slug = unique_slug(dir, &slugify(&f.title), &mut taken);
        let mut md = format!("---\ndescription: {}\n---\n\n# {}\n\n{}\n", f.title, f.title, f.body_md.trim());
        if !f.evidence.is_empty() {
            let refs: Vec<String> = f.evidence.iter().map(|e| format!("`{e}`")).collect();
            md.push_str(&format!("\nEvidence: {}\n", refs.join(", ")));
        }
        let path = dir.join(format!("{slug}.md"));
        std::fs::write(&path, md)?;
        out.push(path);
    }
    Ok(out)
}

pub fn write_memory_entry(repo_root: &Path, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("memory"), findings)
}
pub fn write_command_entry(repo_root: &Path, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("commands"), findings)
}
pub fn write_subagent_entry(repo_root: &Path, findings: &[CompiledFinding]) -> Result<Vec<PathBuf>, CanonError> {
    write_md_entries(&canon_dir(repo_root).join("agents"), findings)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn finding(cat: &str, title: &str) -> CompiledFinding {
        CompiledFinding {
            category: cat.into(),
            title: title.into(),
            body_md: format!("Always do {title}."),
            evidence: vec!["src/lib.rs:12".into()],
            confidence: "high".into(),
            kind: "skill".into(),
        }
    }

    fn finding_k(cat: &str, title: &str, kind: &str) -> CompiledFinding {
        CompiledFinding {
            category: cat.into(), title: title.into(),
            body_md: format!("Always do {title}."),
            evidence: vec!["src/lib.rs:12".into()],
            confidence: "high".into(), kind: kind.into(),
        }
    }

    #[test]
    fn slugify_kebabs_and_trims() {
        assert_eq!(slugify("PEP screening required!"), "pep-screening-required");
        assert_eq!(slugify("  Multiple   spaces  "), "multiple-spaces");
    }

    #[test]
    fn memory_writes_one_file_per_finding_with_description() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let paths = write_memory_entry(root, &[
            finding_k("domain_rule", "PEP check", "memory"),
            finding_k("glossary", "KYC term", "memory"),
        ]).unwrap();
        assert_eq!(paths.len(), 2);
        let pep = std::fs::read_to_string(root.join(".covenant/canon/memory/pep-check.md")).unwrap();
        assert!(pep.contains("description: PEP check"), "frontmatter: {pep}");
        assert!(pep.contains("Always do PEP check."));
        assert!(root.join(".covenant/canon/memory/kyc-term.md").exists());
    }

    #[test]
    fn memory_dedupes_colliding_slugs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let paths = write_memory_entry(root, &[
            finding_k("domain_rule", "Same Title", "memory"),
            finding_k("glossary", "Same Title", "memory"),
        ]).unwrap();
        assert!(paths[0].ends_with("same-title.md"));
        assert!(paths[1].ends_with("same-title-2.md"));
    }

    #[test]
    fn command_and_subagent_write_to_their_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_command_entry(root, &[finding_k("workflow", "Run tests", "command")]).unwrap();
        write_subagent_entry(root, &[finding_k("convention", "Reviewer", "subagent")]).unwrap();
        assert!(root.join(".covenant/canon/commands/run-tests.md").exists());
        assert!(root.join(".covenant/canon/agents/reviewer.md").exists());
    }

    #[test]
    fn render_groups_by_category_in_fixed_order() {
        let md = render_skill_md(
            "test-skill",
            &[
                finding("gotcha", "watch the lock"),
                finding("convention", "snake_case files"),
            ],
        );
        // Frontmatter + name
        assert!(md.starts_with("---\n"), "frontmatter first: {md}");
        assert!(md.contains("name: test-skill"));
        // Category order is fixed: convention before gotcha regardless of input order.
        let conv = md.find("## Conventions").expect("conventions section");
        let gotcha = md.find("## Gotchas").expect("gotchas section");
        assert!(conv < gotcha);
        // Finding body + evidence rendered.
        assert!(md.contains("### snake_case files"));
        assert!(md.contains("`src/lib.rs:12`"));
    }

    #[test]
    fn write_creates_package_and_refuses_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir =
            write_skill_package(root, "kyc-mined", Some("karluiz"), &[finding("domain_rule", "PEP check")], false)
                .unwrap();
        assert!(dir.join("SKILL.md").exists());
        let manifest: SkillManifest =
            toml::from_str(&std::fs::read_to_string(dir.join("skill.toml")).unwrap()).unwrap();
        assert_eq!(manifest.name, "kyc-mined");
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(manifest.owner.as_deref(), Some("karluiz"));
        // Second write without overwrite errors; with overwrite succeeds.
        assert!(write_skill_package(root, "kyc-mined", None, &[finding("pattern", "x")], false).is_err());
        assert!(write_skill_package(root, "kyc-mined", None, &[finding("pattern", "x")], true).is_ok());
    }

    #[test]
    fn write_rejects_empty_findings_and_bad_names() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_skill_package(tmp.path(), "ok-name", None, &[], false).is_err());
        assert!(write_skill_package(tmp.path(), "Bad Name!", None, &[finding("pattern", "x")], false).is_err());
    }
}
