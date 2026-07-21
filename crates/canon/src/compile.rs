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
    ("workflow", "Workflows"),
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
                let refs: Vec<String> = f.evidence.iter().map(|e| format!("`{e}`")).collect();
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
        return Err(CanonError::InvalidPackage(
            "no accepted findings to compile".into(),
        ));
    }
    if !valid_pkg_name(name) {
        return Err(CanonError::InvalidPackage(format!(
            "invalid skill name '{name}' (lowercase ascii/digits/dash/dot/underscore)"
        )));
    }
    let dir = canon_dir(repo_root).join("skills").join(name);
    if dir.exists() && !overwrite {
        return Err(CanonError::InvalidPackage(format!(
            "skill '{name}' already exists"
        )));
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

/// The exact bytes an md-backed entry (memory / command / subagent) is
/// written as. Public so state resolution can compare a candidate against
/// what is already on disk without rewriting it.
pub fn render_md_entry(f: &CompiledFinding) -> String {
    let mut md = format!(
        "---\ndescription: {}\n---\n\n# {}\n\n{}\n",
        f.title,
        f.title,
        f.body_md.trim()
    );
    if !f.evidence.is_empty() {
        let refs: Vec<String> = f.evidence.iter().map(|e| format!("`{e}`")).collect();
        md.push_str(&format!("\nEvidence: {}\n", refs.join(", ")));
    }
    md
}

/// Write a single md-backed entry at `<dir>/<slug>.md`, keyed on the
/// caller-supplied slug — the same slug `canon_inventory_states` resolves
/// state against, so a write always lands exactly where state resolution
/// looked. Always overwrites: the unit was resolved against Canon before the
/// caller decided to write, so a write at this slug is an intentional
/// create-or-update, never an accidental collision.
///
/// An empty slug is rejected rather than renamed. The old `entry` fallback made
/// this the one writer whose path did not match `inventory::unit_path`, which
/// checks `memory/.md` and has no fallback of its own — "path checked ≠ path
/// written" is exactly the class of bug that was Critical earlier in this
/// branch. Inventing a name for a unit nobody named is not worth reopening it,
/// and the guard belongs in the layer that does the writing: `run_miner`
/// rejects empty-slug names, but `canon_compile_units` is a Tauri command in
/// another crate with no name validation of its own.
fn write_md_entry(dir: &Path, slug: &str, f: &CompiledFinding) -> Result<PathBuf, CanonError> {
    if slug.is_empty() {
        return Err(CanonError::InvalidPackage(
            "empty slug: the unit name must contain at least one letter or digit".into(),
        ));
    }
    std::fs::create_dir_all(dir)?;
    let path = dir.join(format!("{slug}.md"));
    std::fs::write(&path, render_md_entry(f))?;
    Ok(path)
}

pub fn write_memory_entry(
    repo_root: &Path,
    slug: &str,
    f: &CompiledFinding,
) -> Result<PathBuf, CanonError> {
    write_md_entry(&canon_dir(repo_root).join("memory"), slug, f)
}
pub fn write_command_entry(
    repo_root: &Path,
    slug: &str,
    f: &CompiledFinding,
) -> Result<PathBuf, CanonError> {
    write_md_entry(&canon_dir(repo_root).join("commands"), slug, f)
}
pub fn write_subagent_entry(
    repo_root: &Path,
    slug: &str,
    f: &CompiledFinding,
) -> Result<PathBuf, CanonError> {
    write_md_entry(&canon_dir(repo_root).join("agents"), slug, f)
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
            category: cat.into(),
            title: title.into(),
            body_md: format!("Always do {title}."),
            evidence: vec!["src/lib.rs:12".into()],
            confidence: "high".into(),
            kind: kind.into(),
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
        let p1 = write_memory_entry(
            root,
            "pep-check",
            &finding_k("domain_rule", "PEP check", "memory"),
        )
        .unwrap();
        let p2 = write_memory_entry(
            root,
            "kyc-term",
            &finding_k("glossary", "KYC term", "memory"),
        )
        .unwrap();
        assert!(p1.ends_with("pep-check.md"));
        assert!(p2.ends_with("kyc-term.md"));
        let pep =
            std::fs::read_to_string(root.join(".covenant/canon/memory/pep-check.md")).unwrap();
        assert!(pep.contains("description: PEP check"), "frontmatter: {pep}");
        assert!(pep.contains("Always do PEP check."));
        assert!(root.join(".covenant/canon/memory/kyc-term.md").exists());
    }

    #[test]
    fn command_and_subagent_write_to_their_dirs() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        write_command_entry(
            root,
            "run-tests",
            &finding_k("workflow", "Run tests", "command"),
        )
        .unwrap();
        write_subagent_entry(
            root,
            "reviewer",
            &finding_k("convention", "Reviewer", "subagent"),
        )
        .unwrap();
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
    fn render_includes_workflow_category() {
        let md = render_skill_md("s", &[finding_k("workflow", "run the suite", "skill")]);
        assert!(
            md.contains("## Workflows"),
            "workflow heading present: {md}"
        );
        assert!(md.contains("### run the suite"));
    }

    #[test]
    fn write_creates_package_and_refuses_collision() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = write_skill_package(
            root,
            "kyc-mined",
            Some("karluiz"),
            &[finding("domain_rule", "PEP check")],
            false,
        )
        .unwrap();
        assert!(dir.join("SKILL.md").exists());
        let manifest: SkillManifest =
            toml::from_str(&std::fs::read_to_string(dir.join("skill.toml")).unwrap()).unwrap();
        assert_eq!(manifest.name, "kyc-mined");
        assert_eq!(manifest.version, "1.0.0");
        assert_eq!(manifest.owner.as_deref(), Some("karluiz"));
        // Second write without overwrite errors; with overwrite succeeds.
        assert!(
            write_skill_package(root, "kyc-mined", None, &[finding("pattern", "x")], false)
                .is_err()
        );
        assert!(
            write_skill_package(root, "kyc-mined", None, &[finding("pattern", "x")], true).is_ok()
        );
    }

    #[test]
    fn write_rejects_empty_findings_and_bad_names() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(write_skill_package(tmp.path(), "ok-name", None, &[], false).is_err());
        assert!(write_skill_package(
            tmp.path(),
            "Bad Name!",
            None,
            &[finding("pattern", "x")],
            false
        )
        .is_err());
    }

    #[test]
    fn overwrite_rewrites_the_same_file() {
        let tmp = std::env::temp_dir().join(format!("canon-ow-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let f = finding("convention", "Use tabs");
        for _ in 0..3 {
            write_memory_entry(&tmp, "use-tabs", &f).unwrap();
        }
        let dir = tmp.join(".covenant/canon/memory");
        let n = std::fs::read_dir(&dir).unwrap().count();
        assert_eq!(
            n, 1,
            "writing the same slug repeatedly must not accumulate -2/-3"
        );
        assert!(dir.join("use-tabs.md").exists());
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn render_md_entry_is_what_gets_written() {
        let tmp = std::env::temp_dir().join(format!("canon-rd-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let f = finding("convention", "Use tabs");
        let path = write_memory_entry(&tmp, "use-tabs", &f).unwrap();
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert_eq!(on_disk, render_md_entry(&f));
        let _ = std::fs::remove_dir_all(&tmp);
    }

    /// `inventory::unit_path` checks `memory/.md` for an empty slug and has no
    /// fallback, so a writer that renamed it to `entry.md` wrote somewhere
    /// state resolution never looked. Reject instead of inventing a name.
    #[test]
    fn empty_slug_is_rejected_not_renamed() {
        let tmp = tempfile::tempdir().unwrap();
        let f = finding("convention", "Use tabs");
        for w in [
            write_memory_entry,
            write_command_entry,
            write_subagent_entry,
        ] {
            assert!(w(tmp.path(), "", &f).is_err(), "empty slug must not write");
        }
        // Nothing was created on the way to the error.
        assert!(!tmp.path().join(".covenant/canon/memory/entry.md").exists());
        assert!(!tmp.path().join(".covenant/canon/memory/.md").exists());
    }

    /// The skill writer's equivalent hole: `valid_pkg_name` already rejects an
    /// empty name, so `write_skill_package` never creates `skills//SKILL.md`.
    /// Pinned so a future relaxation of `valid_pkg_name` fails here.
    #[test]
    fn empty_skill_name_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(
            write_skill_package(tmp.path(), "", None, &[finding("pattern", "x")], true).is_err()
        );
    }
}
