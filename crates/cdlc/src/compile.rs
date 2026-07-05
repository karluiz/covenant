//! Compile curated miner findings into a distributable skill package
//! (SKILL.md + skill.toml) under `.covenant/cdlc/skills/<name>/`.

use crate::install::valid_pkg_name;
use crate::manifest::cdlc_dir;
use crate::types::SkillManifest;
use crate::CdlcError;
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
) -> Result<PathBuf, CdlcError> {
    if findings.is_empty() {
        return Err(CdlcError::InvalidPackage("no accepted findings to compile".into()));
    }
    if !valid_pkg_name(name) {
        return Err(CdlcError::InvalidPackage(format!(
            "invalid skill name '{name}' (lowercase ascii/digits/dash/dot/underscore)"
        )));
    }
    let dir = cdlc_dir(repo_root).join("skills").join(name);
    if dir.exists() && !overwrite {
        return Err(CdlcError::InvalidPackage(format!("skill '{name}' already exists")));
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
        }
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
