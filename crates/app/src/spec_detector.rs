//! Spec auto-detection: watches the repo for new spec files and emits
//! candidate events the UI can turn into "use as mission?" toasts.
//!
//! Classification is path-based:
//! - `docs/specs/*.md` (excluding `_template.md`, `next-features.md`,
//!   and `drafts/**`) → Covenant
//! - `docs/superpowers/specs/*-design.md` → Superpowers
//! - anything else → not a candidate (returns None)

use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecSource {
    Covenant,
    Superpowers,
}

/// Classify a path relative to `repo_root`. Returns None if the path is
/// not a recognized spec location.
pub fn classify_spec(repo_root: &Path, path: &Path) -> Option<SpecSource> {
    let rel = path.strip_prefix(repo_root).ok()?;
    let s = rel.to_string_lossy();
    let s = s.replace('\\', "/");

    if !s.ends_with(".md") {
        return None;
    }

    if let Some(rest) = s.strip_prefix("docs/specs/") {
        if rest.contains('/') {
            return None; // drafts/ or any nested path
        }
        if rest == "_template.md" || rest == "next-features.md" {
            return None;
        }
        return Some(SpecSource::Covenant);
    }

    if let Some(rest) = s.strip_prefix("docs/superpowers/specs/") {
        if rest.contains('/') {
            return None;
        }
        return Some(SpecSource::Superpowers);
    }

    None
}

/// Extract the H1 title (e.g. "3.16 — Foo") from a spec markdown body.
/// Returns the trimmed text after the first `# ` line, or None.
pub fn extract_title(md: &str) -> Option<String> {
    for line in md.lines() {
        if let Some(rest) = line.strip_prefix("# ") {
            let t = rest.trim();
            if !t.is_empty() {
                return Some(t.to_string());
            }
        }
    }
    None
}

/// Extract a flat one-paragraph snippet from the `## Goal` section,
/// truncated to `max_chars` (with a trailing "…" if truncated).
/// Returns "" if no Goal section is present.
pub fn extract_goal_snippet(md: &str, max_chars: usize) -> String {
    let mut in_goal = false;
    let mut buf = String::new();

    for line in md.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("## ") {
            if in_goal {
                break; // next section ends Goal
            }
            let heading = trimmed.trim_start_matches("## ").trim();
            if heading.eq_ignore_ascii_case("goal")
                || heading.to_ascii_lowercase().starts_with("goal ")
            {
                in_goal = true;
            }
            continue;
        }
        if !in_goal {
            continue;
        }
        if trimmed.starts_with('>') {
            continue; // skip blockquotes (template comments)
        }
        if trimmed.is_empty() {
            if !buf.is_empty() {
                buf.push(' ');
            }
            continue;
        }
        if !buf.is_empty() && !buf.ends_with(' ') {
            buf.push(' ');
        }
        buf.push_str(trimmed);
    }

    let flat = buf.trim().to_string();
    if flat.chars().count() <= max_chars {
        return flat;
    }
    let truncated: String = flat.chars().take(max_chars).collect();
    format!("{}…", truncated)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn root() -> PathBuf {
        PathBuf::from("/tmp/repo")
    }

    #[test]
    fn covenant_spec_classified() {
        let p = root().join("docs/specs/3.16-foo.md");
        assert_eq!(classify_spec(&root(), &p), Some(SpecSource::Covenant));
    }

    #[test]
    fn superpowers_spec_classified() {
        let p = root().join("docs/superpowers/specs/2026-05-04-foo-design.md");
        assert_eq!(classify_spec(&root(), &p), Some(SpecSource::Superpowers));
    }

    #[test]
    fn template_ignored() {
        let p = root().join("docs/specs/_template.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn next_features_ignored() {
        let p = root().join("docs/specs/next-features.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn drafts_subdir_ignored() {
        let p = root().join("docs/specs/drafts/wip-foo.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn non_md_ignored() {
        let p = root().join("docs/specs/3.1-foo.txt");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn outside_repo_ignored() {
        let p = PathBuf::from("/elsewhere/docs/specs/3.1-foo.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn unrelated_path_ignored() {
        let p = root().join("README.md");
        assert_eq!(classify_spec(&root(), &p), None);
    }

    #[test]
    fn extracts_goal_under_h2() {
        let md = "# 3.16 — Foo\n\n## Goal\n\nDoes the thing.\nMore detail.\n\n## Out of scope\n";
        assert_eq!(
            extract_goal_snippet(md, 200),
            "Does the thing. More detail."
        );
    }

    #[test]
    fn truncates_at_limit_with_ellipsis() {
        let md = format!("## Goal\n\n{}", "a".repeat(300));
        let out = extract_goal_snippet(&md, 50);
        assert!(out.ends_with('…'));
        // 50 ASCII chars + "…" — but len() counts bytes; check char count instead
        assert_eq!(out.chars().count(), 51);
    }

    #[test]
    fn returns_empty_when_no_goal_section() {
        let md = "# Title\n\nSome text without a goal heading.";
        assert_eq!(extract_goal_snippet(md, 200), "");
    }

    #[test]
    fn extract_title_from_h1() {
        let md = "# 3.16 — Foo Bar\n\n## Goal\n";
        assert_eq!(extract_title(md), Some("3.16 — Foo Bar".to_string()));
    }

    #[test]
    fn extract_title_returns_none_without_h1() {
        let md = "## Goal\n";
        assert_eq!(extract_title(md), None);
    }
}
