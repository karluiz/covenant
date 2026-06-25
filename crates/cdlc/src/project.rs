use crate::{cdlc_dir, read_manifest, CdlcError};
use std::path::Path;

const START: &str = "<!-- cdlc:start -->";
const END: &str = "<!-- cdlc:end -->";

/// Remove the top-level `covenant:` mapping from a doc's leading `---`…`---`
/// frontmatter. The key line and every following indented (or blank) line up to
/// the next top-level key (or the closing fence) is dropped. Body is untouched.
/// ponytail: line-based, not a real YAML parse — handles single-level nesting,
/// which is all the `covenant:` block uses. Swap to serde_yaml if it grows.
fn strip_covenant_block(md: &str) -> String {
    let lines: Vec<&str> = md.lines().collect();
    let open = match lines.iter().position(|l| l.trim() == "---") {
        Some(i) => i,
        None => return md.to_string(),
    };
    let close = match lines.iter().skip(open + 1).position(|l| l.trim() == "---") {
        Some(i) => open + 1 + i,
        None => return md.to_string(),
    };
    let mut out: Vec<&str> = Vec::with_capacity(lines.len());
    let mut i = 0;
    while i < lines.len() {
        let line = lines[i];
        let in_fm = i > open && i < close;
        // top-level key (no indent) named exactly `covenant:`
        if in_fm && line == line.trim_start() && line.trim_start().starts_with("covenant:") {
            i += 1;
            while i < close {
                let child = lines[i];
                if child.trim().is_empty() || child.starts_with(' ') || child.starts_with('\t') {
                    i += 1;
                } else {
                    break;
                }
            }
            continue;
        }
        out.push(line);
        i += 1;
    }
    let mut s = out.join("\n");
    if md.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// `(file_stem, contents)` for every `*.md` directly under `dir`, sorted by stem.
/// Returns an empty Vec when `dir` does not exist.
fn read_dir_md(dir: &Path) -> Result<Vec<(String, String)>, CdlcError> {
    let mut out: Vec<(String, String)> = Vec::new();
    if !dir.exists() {
        return Ok(out);
    }
    for entry in std::fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|s| s.to_str()) != Some("md") {
            continue;
        }
        let stem = match path.file_stem().and_then(|s| s.to_str()) {
            Some(s) => s.to_string(),
            None => continue,
        };
        out.push((stem, std::fs::read_to_string(&path)?));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Project operator personas into Claude's native multi-agent dir.
fn project_agents(repo_root: &Path, agents: &[(String, String)]) -> Result<(), CdlcError> {
    if agents.is_empty() {
        return Ok(());
    }
    let dir = repo_root.join(".claude/agents");
    std::fs::create_dir_all(&dir)?;
    for (stem, raw) in agents {
        std::fs::write(dir.join(format!("{stem}.md")), strip_covenant_block(raw))?;
    }
    Ok(())
}

/// First top-level `summary:` value inside the leading frontmatter, trimmed and
/// dequoted. `None` if there is no frontmatter or no non-empty summary.
/// ponytail: single-line summaries only; add block-scalar support if needed.
fn parse_summary(md: &str) -> Option<String> {
    let lines: Vec<&str> = md.lines().collect();
    let open = lines.iter().position(|l| l.trim() == "---")?;
    let close = open + 1 + lines.iter().skip(open + 1).position(|l| l.trim() == "---")?;
    for l in &lines[open + 1..close] {
        if let Some(rest) = l.strip_prefix("summary:") {
            let v = rest.trim().trim_matches('"').trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Markdown body after the closing `---` of a leading frontmatter block.
/// Returns the input unchanged when there is no frontmatter.
fn body_after_frontmatter(md: &str) -> &str {
    let s = md.trim_start_matches('\n');
    if let Some(rest) = s.strip_prefix("---") {
        if let Some(idx) = rest.find("\n---") {
            // skip past the closing fence line
            let after = &rest[idx + 1..]; // at the "---" line
            if let Some(nl) = after.find('\n') {
                return after[nl + 1..].trim_start_matches('\n');
            }
        }
    }
    md
}

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
    fn strip_covenant_removes_block_keeps_standard_keys() {
        let md = "---\nname: kyc-reviewer\nmodel: claude-sonnet-4-6\ncovenant:\n  escalate_threshold: 0.7\n  voice: formal\ntools: [Read]\n---\nbody text\n";
        let out = strip_covenant_block(md);
        assert!(out.contains("name: kyc-reviewer"));
        assert!(out.contains("model: claude-sonnet-4-6"));
        assert!(out.contains("tools: [Read]"), "key after covenant block must survive");
        assert!(!out.contains("covenant:"), "covenant key removed");
        assert!(!out.contains("escalate_threshold"), "covenant children removed");
        assert!(out.contains("body text"), "body untouched");
    }

    #[test]
    fn strip_covenant_noop_without_block() {
        let md = "---\nname: x\n---\nbody\n";
        assert_eq!(strip_covenant_block(md), md);
    }

    #[test]
    fn body_after_frontmatter_returns_body() {
        let md = "---\nsummary: short\n---\nfull body here\n";
        assert_eq!(body_after_frontmatter(md), "full body here\n");
    }

    #[test]
    fn body_after_frontmatter_noop_when_no_frontmatter() {
        let md = "no frontmatter here\n";
        assert_eq!(body_after_frontmatter(md), md);
    }

    #[test]
    fn parse_summary_reads_frontmatter_line() {
        let md = "---\nsummary: \"Mask all PII; cite SBS article.\"\n---\nfull text\n";
        assert_eq!(parse_summary(md).as_deref(), Some("Mask all PII; cite SBS article."));
    }

    #[test]
    fn parse_summary_none_when_absent() {
        let md = "---\nname: x\n---\nbody\n";
        assert_eq!(parse_summary(md), None);
    }

    #[test]
    fn project_agents_writes_stripped_claude_files() {
        let base = std::env::temp_dir().join(format!("cdlc-agents-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let repo = base.clone();
        let src = crate::cdlc_dir(&repo).join("agents");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(
            src.join("kyc-reviewer.md"),
            "---\nname: kyc-reviewer\nmodel: claude-sonnet-4-6\ncovenant:\n  voice: formal\n---\nReview KYC.\n",
        )
        .unwrap();

        let agents = read_dir_md(&src).unwrap();
        assert_eq!(agents.len(), 1);
        project_agents(&repo, &agents).unwrap();

        let out = repo.join(".claude/agents/kyc-reviewer.md");
        assert!(out.exists());
        let content = std::fs::read_to_string(&out).unwrap();
        assert!(content.contains("name: kyc-reviewer"));
        assert!(!content.contains("covenant:"), "covenant block must be stripped");
        assert!(content.contains("Review KYC."));

        let _ = std::fs::remove_dir_all(&base);
    }

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
