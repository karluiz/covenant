use crate::{cdlc_dir, read_manifest, CdlcError};
use std::path::Path;

const START: &str = "<!-- cdlc:start -->";
const END: &str = "<!-- cdlc:end -->";

/// Ensure a SKILL.md body has YAML frontmatter required by Claude Code.
/// If the body already starts with `---`, it is returned unchanged (idempotent).
/// Otherwise, a minimal frontmatter block is prepended, deriving the description
/// from the first Markdown heading or falling back to a default.
fn ensure_frontmatter(pkg: &str, body: &str) -> String {
    if body.trim_start().starts_with("---") {
        return body.to_string();
    }
    let desc = body
        .lines()
        .find(|l| l.trim_start().starts_with('#'))
        .map(|l| l.trim_start_matches('#').trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| format!("CDLC context: {pkg}"));
    format!("---\nname: cdlc-{pkg}\ndescription: {desc}\n---\n\n{body}")
}

/// Remove the `<!-- cdlc:start -->...<!-- cdlc:end -->` managed block (and trim
/// surrounding blank lines). Returns the input unchanged if no block is present.
fn strip_block(existing: &str) -> String {
    if let (Some(s), Some(e)) = (existing.find(START), existing.find(END)) {
        if s < e {
            let end = e + END.len();
            // Drop the span and clean up any surrounding whitespace/blank lines.
            let before = existing[..s].trim_end();
            let after = existing[end..].trim_start_matches('\n');
            if before.is_empty() {
                // block was at the very top
                after.to_string()
            } else if after.is_empty() {
                format!("{before}\n")
            } else {
                format!("{before}\n\n{after}")
            }
        } else {
            existing.to_string()
        }
    } else {
        existing.to_string()
    }
}

/// Generate every executor's native instruction file from the installed skills.
pub fn project(repo_root: &Path) -> Result<(), CdlcError> {
    let manifest = read_manifest(repo_root)?;
    let skills_dir = cdlc_dir(repo_root).join("skills");

    // Collect each installed skill's payload once.
    let mut blocks: Vec<(String, String, String)> = Vec::new(); // (name, version, body)
    for i in &manifest.installed {
        let md = skills_dir.join(&i.name).join("SKILL.md");
        let body = std::fs::read_to_string(&md)?;
        blocks.push((i.name.clone(), i.version.clone(), body));
    }

    if blocks.is_empty() {
        // I2: strip the managed block from managed-block files if present; don't create new files.
        for rel in ["AGENTS.md", ".github/copilot-instructions.md"] {
            let path = repo_root.join(rel);
            if path.exists() {
                let existing = std::fs::read_to_string(&path)?;
                let stripped = strip_block(&existing);
                std::fs::write(&path, stripped)?;
            }
        }
        return Ok(());
    }

    // I3: claude executor — one dir per skill with guaranteed YAML frontmatter.
    for (name, _v, body) in &blocks {
        let dir = repo_root.join(".claude/skills").join(format!("cdlc-{name}"));
        std::fs::create_dir_all(&dir)?;
        std::fs::write(dir.join("SKILL.md"), ensure_frontmatter(name, body))?;
    }

    // Managed-block executors: one concatenated block (raw body, no frontmatter).
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
        if s < e {
            let end = e + END.len();
            return format!("{}{}{}", &existing[..s], block, &existing[end..]);
        }
        // malformed (END before START): fall through to append a fresh block
    }
    if existing.trim().is_empty() {
        format!("{block}\n")
    } else {
        format!("{}\n\n{block}\n", existing.trim_end())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{write_manifest, CdlcManifest, InstalledRef};

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

    // I3: ensure_frontmatter adds YAML frontmatter for Claude Code.
    #[test]
    fn ensure_frontmatter_adds_header_from_heading() {
        let body = "# KYC Peru\nrules";
        let out = ensure_frontmatter("kyc-peru", body);
        assert!(out.starts_with("---\nname: cdlc-"), "must start with frontmatter");
        assert!(out.contains("description: KYC Peru"), "must derive description from heading");
        // Idempotent: a body already starting with --- is returned unchanged.
        let out2 = ensure_frontmatter("kyc-peru", &out);
        assert_eq!(out, out2, "must not add double frontmatter");
    }

    #[test]
    fn ensure_frontmatter_falls_back_to_default_when_no_heading() {
        let body = "Just some prose without a heading.";
        let out = ensure_frontmatter("my-pkg", body);
        assert!(out.contains("description: CDLC context: my-pkg"));
    }

    // I3: project() writes SKILL.md with frontmatter for the claude executor.
    #[test]
    fn project_writes_claude_skill_with_frontmatter() {
        let base = std::env::temp_dir().join(format!("cdlc-proj-fm-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();

        // Set up a minimal installed skill in .covenant/cdlc/skills/kyc-peru/SKILL.md
        let skills_dir = crate::cdlc_dir(&repo).join("skills/kyc-peru");
        std::fs::create_dir_all(&skills_dir).unwrap();
        std::fs::write(skills_dir.join("SKILL.md"), "# KYC Peru\nrules\n").unwrap();

        // Write a manifest referencing that skill.
        let manifest = CdlcManifest {
            version: 1,
            installed: vec![InstalledRef {
                name: "kyc-peru".into(),
                version: "1.0.0".into(),
                source: "local:test".into(),
                sha: "abc".into(),
                signer: Some("github:mibanco".into()),
                installed_at: "2024-01-01T00:00:00Z".into(),
            }],
        };
        write_manifest(&repo, &manifest).unwrap();

        project(&repo).unwrap();

        let skill_md = repo.join(".claude/skills/cdlc-kyc-peru/SKILL.md");
        assert!(skill_md.exists());
        let content = std::fs::read_to_string(&skill_md).unwrap();
        assert!(content.starts_with("---\nname: cdlc-"), "must have frontmatter");
        assert!(content.contains("description: KYC Peru"), "must have description");

        let _ = std::fs::remove_dir_all(&base);
    }

    // I2: project() strips the managed block from AGENTS.md when manifest is empty.
    #[test]
    fn project_strips_managed_block_when_empty_manifest() {
        let base = std::env::temp_dir().join(format!("cdlc-proj-strip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        std::fs::create_dir_all(&repo).unwrap();

        // Write AGENTS.md with a managed block already present.
        let agents_path = repo.join("AGENTS.md");
        std::fs::write(
            &agents_path,
            "hand-written\n\n<!-- cdlc:start -->\n# CDLC context\n<!-- cdlc:end -->\n",
        )
        .unwrap();

        // Write an empty manifest.
        let manifest = CdlcManifest { version: 1, installed: vec![] };
        write_manifest(&repo, &manifest).unwrap();

        project(&repo).unwrap();

        let content = std::fs::read_to_string(&agents_path).unwrap();
        assert!(
            !content.contains("<!-- cdlc:start -->"),
            "managed block must be stripped when manifest is empty"
        );
        assert!(content.contains("hand-written"), "surrounding content must be preserved");

        let _ = std::fs::remove_dir_all(&base);
    }

    // strip_block unit tests.
    #[test]
    fn strip_block_removes_managed_span() {
        let input = "top\n\n<!-- cdlc:start -->\ninner\n<!-- cdlc:end -->\nbottom\n";
        let out = strip_block(input);
        assert!(!out.contains("<!-- cdlc:start -->"));
        assert!(out.contains("top"));
        assert!(out.contains("bottom"));
    }

    #[test]
    fn strip_block_noop_when_no_block() {
        let input = "just some text\n";
        assert_eq!(strip_block(input), input);
    }
}
