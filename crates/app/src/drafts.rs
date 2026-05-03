use serde::{Deserialize, Serialize};
use std::path::Path;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DraftError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("yaml: {0}")]
    Yaml(#[from] serde_yaml::Error),
    #[error("invalid frontmatter: {0}")]
    InvalidFrontmatter(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("collision: {0}")]
    Collision(String),
    #[error("validation: {0}")]
    Validation(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct DraftFrontmatter {
    pub status: String,        // always "draft"
    pub title: String,
    pub slug: String,
    pub created_at: String,    // RFC3339
    pub updated_at: String,    // RFC3339
    #[serde(default)]
    pub llm_calls: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftDocument {
    pub frontmatter: DraftFrontmatter,
    pub body: String,
}

pub fn parse_draft(text: &str) -> Result<DraftDocument, DraftError> {
    let rest = text.strip_prefix("---\n")
        .ok_or_else(|| DraftError::InvalidFrontmatter("missing opening ---".into()))?;
    let end = rest.find("\n---\n")
        .ok_or_else(|| DraftError::InvalidFrontmatter("missing closing ---".into()))?;
    let yaml = &rest[..end];
    let body = rest[end + 5..].to_string();
    let frontmatter: DraftFrontmatter = serde_yaml::from_str(yaml)?;
    Ok(DraftDocument { frontmatter, body })
}

pub fn serialize_draft(doc: &DraftDocument) -> Result<String, DraftError> {
    let yaml = serde_yaml::to_string(&doc.frontmatter)?;
    Ok(format!("---\n{yaml}---\n{}", doc.body))
}

/// kebab-case slug from a free-text title. ASCII-only fallback for
/// non-ASCII chars (drop them). Empty input returns "untitled".
pub fn slugify(title: &str) -> String {
    let mut out = String::with_capacity(title.len());
    let mut prev_dash = true;
    for c in title.chars() {
        if c.is_ascii_alphanumeric() {
            out.push(c.to_ascii_lowercase());
            prev_dash = false;
        } else if !prev_dash {
            out.push('-');
            prev_dash = true;
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() { "untitled".into() } else { trimmed.to_string() }
}

/// Find max `<major>.<minor>` ID among `docs/specs/*.md` (excluding
/// `_template.md` and `drafts/`) and return next minor (`major.(minor+1)`).
/// If no spec exists, returns "1.0".
pub fn next_spec_id(repo_root: &Path) -> Result<String, DraftError> {
    let dir = repo_root.join("docs/specs");
    if !dir.exists() {
        return Ok("1.0".into());
    }
    let mut best: Option<(u32, u32)> = None;
    for entry in std::fs::read_dir(&dir)? {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if !name.ends_with(".md") || name.starts_with('_') {
            continue;
        }
        let stem = name.trim_end_matches(".md");
        let prefix = stem.split('-').next().unwrap_or("");
        let mut parts = prefix.split('.');
        let (Some(maj), Some(min)) = (parts.next(), parts.next()) else { continue };
        if let (Ok(maj), Ok(min)) = (maj.parse::<u32>(), min.parse::<u32>()) {
            best = Some(best.map_or((maj, min), |(m, n)| {
                if (maj, min) > (m, n) { (maj, min) } else { (m, n) }
            }));
        }
    }
    Ok(match best {
        Some((maj, min)) => format!("{maj}.{}", min + 1),
        None => "1.0".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fm() -> DraftFrontmatter {
        DraftFrontmatter {
            status: "draft".into(),
            title: "Mission Drafts".into(),
            slug: "mission-drafts".into(),
            created_at: "2026-05-03T14:55:00Z".into(),
            updated_at: "2026-05-03T15:12:00Z".into(),
            llm_calls: 0,
        }
    }

    #[test]
    fn parse_roundtrip() {
        let doc = DraftDocument {
            frontmatter: fm(),
            body: "# Draft — Mission Drafts\n\n## Goal\nx\n".into(),
        };
        let text = serialize_draft(&doc).unwrap();
        let parsed = parse_draft(&text).unwrap();
        assert_eq!(parsed, doc);
    }

    #[test]
    fn parse_missing_open() {
        let err = parse_draft("title: x\n").unwrap_err();
        assert!(matches!(err, DraftError::InvalidFrontmatter(_)));
    }

    #[test]
    fn parse_missing_close() {
        let err = parse_draft("---\ntitle: x\n").unwrap_err();
        assert!(matches!(err, DraftError::InvalidFrontmatter(_)));
    }

    #[test]
    fn slugify_basic() {
        assert_eq!(slugify("Mission Drafts"), "mission-drafts");
        assert_eq!(slugify("  Hello, World!  "), "hello-world");
        assert_eq!(slugify("---"), "untitled");
        assert_eq!(slugify("Café 99"), "caf-99");
    }

    #[test]
    fn next_spec_id_increments_max() {
        let tmp = tempfile::tempdir().unwrap();
        let specs = tmp.path().join("docs/specs");
        std::fs::create_dir_all(&specs).unwrap();
        for name in ["1.0-a.md", "3.9-foo.md", "3.2-bar.md", "_template.md"] {
            std::fs::write(specs.join(name), "x").unwrap();
        }
        assert_eq!(next_spec_id(tmp.path()).unwrap(), "3.10");
    }

    #[test]
    fn next_spec_id_empty_dir() {
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(next_spec_id(tmp.path()).unwrap(), "1.0");
    }
}
