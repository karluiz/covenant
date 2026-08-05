//! Deterministic static lint over a single Canon context unit — no LLM, no
//! network. Runs the same shape of check an eval would flag as "obviously
//! wrong" (missing description, empty body, a frontmatter `name` that lies
//! about which folder it lives in) so those don't need a model call at all.

use crate::project::parse_frontmatter_str;
use crate::{read_source, ContextKind};
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LintSeverity {
    Error,
    Warn,
}

#[derive(Debug, Clone, Serialize)]
pub struct LintFinding {
    pub severity: LintSeverity,
    pub message: String,
    pub hint: String,
}

fn finding(
    severity: LintSeverity,
    message: impl Into<String>,
    hint: impl Into<String>,
) -> LintFinding {
    LintFinding {
        severity,
        message: message.into(),
        hint: hint.into(),
    }
}

/// Markdown body after the closing `---` of a leading frontmatter block.
/// Returns the input unchanged when there is no frontmatter block at all.
fn body_after_frontmatter(md: &str) -> &str {
    let s = md.trim_start_matches('\n');
    let Some(rest) = s.strip_prefix("---") else {
        return md;
    };
    let Some(idx) = rest.find("\n---") else {
        return md;
    };
    let after = &rest[idx + 1..]; // at the closing "---" line
    match after.find('\n') {
        Some(nl) => after[nl + 1..].trim_start_matches('\n'),
        None => "",
    }
}

/// Run every deterministic check for one context unit and return its
/// findings. Never errors on a bad/missing unit — that is itself a finding
/// (a single `Error` with an unreadable-source message); the `Result` is
/// reserved for inputs the lint cannot even attempt to reason about.
///
/// ponytail: flat check list; a rules table when kinds diverge for real.
pub fn lint_unit(
    repo_root: &Path,
    kind: ContextKind,
    name: &str,
) -> Result<Vec<LintFinding>, String> {
    let mut findings = Vec::new();

    let src = match read_source(repo_root, kind, name) {
        Ok(s) => s,
        Err(e) => {
            findings.push(finding(
                LintSeverity::Error,
                format!("source not readable: {e}"),
                "check that the unit's source file exists under .covenant/canon/",
            ));
            return Ok(findings);
        }
    };

    match parse_frontmatter_str(&src, "description") {
        None => findings.push(finding(
            LintSeverity::Error,
            "frontmatter is missing a description",
            "add a description: line to the frontmatter",
        )),
        Some(desc) => {
            if !(20..=500).contains(&desc.chars().count()) {
                findings.push(finding(
                    LintSeverity::Warn,
                    format!(
                        "description is {} chars (expected 20-500)",
                        desc.chars().count()
                    ),
                    "tighten or expand the description to land between 20 and 500 characters",
                ));
            }
            if matches!(
                kind,
                ContextKind::Skill | ContextKind::Command | ContextKind::Agent
            ) && !desc.to_lowercase().contains("use when")
            {
                findings.push(finding(
                    LintSeverity::Warn,
                    "description has no 'use when' trigger clause",
                    "start the trigger clause with 'Use when …' so agents know when to load it",
                ));
            }
        }
    }

    if let Some(fm_name) = parse_frontmatter_str(&src, "name") {
        if fm_name != name {
            findings.push(finding(
                LintSeverity::Error,
                format!("frontmatter name {fm_name:?} does not match folder name {name:?}"),
                "rename the frontmatter name: to match the folder, or vice versa",
            ));
        }
    }

    if body_after_frontmatter(&src).trim().is_empty() {
        findings.push(finding(
            LintSeverity::Error,
            "body is empty after the frontmatter block",
            "add body content — an empty unit has nothing for an agent to load",
        ));
    }

    Ok(findings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::canon_dir;

    fn write_unit(root: &Path, kind: ContextKind, name: &str, content: &str) {
        let path = match kind {
            ContextKind::Skill => canon_dir(root).join(kind.dir()).join(name).join("SKILL.md"),
            ContextKind::Mcp => canon_dir(root)
                .join(kind.dir())
                .join(format!("{name}.json")),
            ContextKind::Spec => root.join("docs/specs").join(format!("{name}.md")),
            _ => canon_dir(root).join(kind.dir()).join(format!("{name}.md")),
        };
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }

    #[test]
    fn lint_flags_missing_description_and_use_when() {
        let dir = tempfile::tempdir().unwrap();
        write_unit(
            dir.path(),
            ContextKind::Skill,
            "demo",
            "---\nname: demo\n---\n\nBody here.\n",
        );
        let f = lint_unit(dir.path(), ContextKind::Skill, "demo").unwrap();
        assert!(f.iter().any(|x| x.message.contains("description")));
    }

    #[test]
    fn lint_passes_a_well_formed_skill() {
        let dir = tempfile::tempdir().unwrap();
        write_unit(
            dir.path(), ContextKind::Skill, "demo",
            "---\nname: demo\ndescription: Cut a release end-to-end. Use when the user asks to cut a release.\n---\n\nSteps...\n",
        );
        assert!(lint_unit(dir.path(), ContextKind::Skill, "demo")
            .unwrap()
            .is_empty());
    }

    #[test]
    fn lint_flags_name_folder_mismatch() {
        let dir = tempfile::tempdir().unwrap();
        write_unit(
            dir.path(),
            ContextKind::Skill,
            "demo",
            "---\nname: other\ndescription: X. Use when Y.\n---\n\nB.\n",
        );
        let f = lint_unit(dir.path(), ContextKind::Skill, "demo").unwrap();
        assert!(f.iter().any(|x| x.message.contains("name")));
    }

    #[test]
    fn lint_flags_unreadable_source_as_single_error() {
        let dir = tempfile::tempdir().unwrap();
        let f = lint_unit(dir.path(), ContextKind::Skill, "missing").unwrap();
        assert_eq!(f.len(), 1);
        assert_eq!(f[0].severity, LintSeverity::Error);
        assert!(f[0].message.contains("not readable"));
    }

    #[test]
    fn lint_flags_empty_body() {
        let dir = tempfile::tempdir().unwrap();
        write_unit(
            dir.path(),
            ContextKind::Skill,
            "demo",
            "---\nname: demo\ndescription: X. Use when Y is present in the input.\n---\n\n",
        );
        let f = lint_unit(dir.path(), ContextKind::Skill, "demo").unwrap();
        assert!(f.iter().any(|x| x.message.contains("body")));
    }

    #[test]
    fn lint_flags_short_description_as_warn() {
        let dir = tempfile::tempdir().unwrap();
        write_unit(
            dir.path(),
            ContextKind::Skill,
            "demo",
            "---\nname: demo\ndescription: too short\n---\n\nB.\n",
        );
        let f = lint_unit(dir.path(), ContextKind::Skill, "demo").unwrap();
        let d = f
            .iter()
            .find(|x| x.message.contains("chars"))
            .expect("length finding");
        assert_eq!(d.severity, LintSeverity::Warn);
    }
}
