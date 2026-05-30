//! SOUL.md: an operator's identity as a real document. YAML frontmatter
//! (machine config) + Origin-Letter markdown body (the soul). The file is
//! the source of truth; `Operator` fields are hydrated from it on load and
//! hot-reload.

use serde::{Deserialize, Serialize};

/// Parsed frontmatter. Every field except `name` is optional; missing fields
/// fall back to documented defaults when projected onto an `Operator`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct SoulFrontmatter {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// "terse" | "warm" | "formal" (case-insensitive); defaults to terse.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub escalate_threshold: Option<f32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    /// Structured deny lines — each non-empty line compiles to a per-operator
    /// deny regex. NOT prose. Optional.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hard_constraints: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Soul {
    pub frontmatter: SoulFrontmatter,
    pub body: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SoulError {
    #[error("missing or malformed frontmatter (need a leading `---` block)")]
    NoFrontmatter,
    #[error("frontmatter is not valid YAML: {0}")]
    Yaml(String),
    #[error("name must be 1..=64 non-whitespace characters")]
    InvalidName,
    #[error("escalate_threshold must be in 0.0..=1.0")]
    InvalidThreshold,
}

/// Split a SOUL.md into (frontmatter, body). Accepts an optional leading BOM
/// and `\r\n` line endings.
pub fn parse(raw: &str) -> Result<Soul, SoulError> {
    let text = raw.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n").ok_or(SoulError::NoFrontmatter)?;
    let end = rest.find("\n---").ok_or(SoulError::NoFrontmatter)?;
    let yaml = &rest[..end];
    let after = &rest[end + 4..]; // skip "\n---"
    let body = after.trim_start_matches('\n').trim_end().to_string();
    let frontmatter: SoulFrontmatter =
        serde_yaml::from_str(yaml).map_err(|e| SoulError::Yaml(e.to_string()))?;
    Ok(Soul { frontmatter, body })
}

/// Emit canonical SOUL.md text. Field order follows `SoulFrontmatter`.
pub fn serialize(soul: &Soul) -> String {
    let yaml = serde_yaml::to_string(&soul.frontmatter).unwrap_or_default();
    format!("---\n{}---\n\n{}\n", yaml, soul.body.trim_end())
}

pub fn validate(soul: &Soul) -> Result<(), SoulError> {
    let n = soul.frontmatter.name.trim();
    if n.is_empty() || n.len() > 64 {
        return Err(SoulError::InvalidName);
    }
    if let Some(t) = soul.frontmatter.escalate_threshold {
        if !(0.0..=1.0).contains(&t) {
            return Err(SoulError::InvalidThreshold);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "---\nname: Atlas\ncolor: \"#c4a7ff\"\nvoice: warm\nescalate_threshold: 0.55\ntags:\n- deploys\n---\n\n# Atlas\n\nI was made to wait.\n";

    #[test]
    fn parses_frontmatter_and_body() {
        let s = parse(SAMPLE).expect("parse");
        assert_eq!(s.frontmatter.name, "Atlas");
        assert_eq!(s.frontmatter.color.as_deref(), Some("#c4a7ff"));
        assert_eq!(s.frontmatter.voice.as_deref(), Some("warm"));
        assert_eq!(s.frontmatter.escalate_threshold, Some(0.55));
        assert_eq!(s.frontmatter.tags, vec!["deploys".to_string()]);
        assert_eq!(s.body, "# Atlas\n\nI was made to wait.");
    }

    #[test]
    fn round_trips() {
        let s = parse(SAMPLE).expect("parse");
        let out = serialize(&s);
        let s2 = parse(&out).expect("reparse");
        assert_eq!(s, s2);
    }

    #[test]
    fn rejects_missing_frontmatter() {
        assert!(matches!(parse("# just a body\n"), Err(SoulError::NoFrontmatter)));
    }

    #[test]
    fn validate_rejects_empty_name_and_bad_threshold() {
        let mut s = parse(SAMPLE).unwrap();
        s.frontmatter.name = "   ".into();
        assert!(matches!(validate(&s), Err(SoulError::InvalidName)));
        let mut s2 = parse(SAMPLE).unwrap();
        s2.frontmatter.escalate_threshold = Some(1.5);
        assert!(matches!(validate(&s2), Err(SoulError::InvalidThreshold)));
    }
}
