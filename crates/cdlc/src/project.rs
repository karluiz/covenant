use crate::{cdlc_dir, read_manifest, CdlcError};
use std::path::Path;

const START: &str = "<!-- cdlc:start -->";
const END: &str = "<!-- cdlc:end -->";

/// Generate every executor's native instruction file from the installed skills.
pub fn project(repo_root: &Path) -> Result<(), CdlcError> {
    let manifest = read_manifest(repo_root)?;
    let skills_dir = cdlc_dir(repo_root).join("skills");

    // Collect each installed skill's payload once.
    let mut blocks: Vec<(String, String, String)> = Vec::new(); // (name, version, body)
    for i in &manifest.installed {
        let md = skills_dir.join(&i.name).join("SKILL.md");
        let body = std::fs::read_to_string(&md).unwrap_or_default();
        blocks.push((i.name.clone(), i.version.clone(), body));
    }

    // claude: one dir per skill, 1:1 copy (native skill format).
    for (name, _v, body) in &blocks {
        let dir = repo_root.join(".claude/skills").join(format!("cdlc-{name}"));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), body)?;
    }

    // Managed-block executors: one concatenated block.
    let combined = blocks
        .iter()
        .map(|(n, v, b)| format!("## {n} v{v}\n\n{}", b.trim()))
        .collect::<Vec<_>>()
        .join("\n\n");
    let body = format!("# CDLC context (auto-generated — do not edit inside this block)\n\n{combined}");

    for rel in ["AGENTS.md", ".github/copilot-instructions.md"] {
        upsert_file(repo_root, rel, &body)?;
    }
    Ok(())
}

fn upsert_file(repo_root: &Path, rel: &str, body: &str) -> Result<(), CdlcError> {
    let path = repo_root.join(rel);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    std::fs::write(&path, upsert_block(&existing, body))?;
    Ok(())
}

fn upsert_block(existing: &str, body: &str) -> String {
    let block = format!("{START}\n{body}\n{END}");
    if let (Some(s), Some(e)) = (existing.find(START), existing.find(END)) {
        let end = e + END.len();
        format!("{}{}{}", &existing[..s], block, &existing[end..])
    } else if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::upsert_block;

    #[test]
    fn upsert_is_idempotent_and_single_block() {
        let once = upsert_block("", "BODY-A");
        let twice = upsert_block(&once, "BODY-A");
        assert_eq!(once, twice);
        assert_eq!(twice.matches("<!-- cdlc:start -->").count(), 1);
        // Replaces body, preserves surrounding text.
        let with_prefix = upsert_block("hand-written top\n", "BODY-B");
        assert!(with_prefix.starts_with("hand-written top"));
        let replaced = upsert_block(&with_prefix, "BODY-C");
        assert!(replaced.contains("BODY-C"));
        assert!(!replaced.contains("BODY-B"));
    }
}
