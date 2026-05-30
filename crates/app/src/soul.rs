//! SOUL.md: an operator's identity as a real document. YAML frontmatter
//! (machine config) + Origin-Letter markdown body (the soul). The file is
//! the source of truth; `Operator` fields are hydrated from it on load and
//! hot-reload.

use serde::{Deserialize, Serialize};

use crate::operator_registry::{Operator, VoiceTone};

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

pub fn voice_from_frontmatter(v: Option<&str>) -> VoiceTone {
    match v.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("warm") => VoiceTone::Warm,
        Some("formal") => VoiceTone::Formal,
        _ => VoiceTone::Terse,
    }
}

pub fn voice_to_frontmatter(v: VoiceTone) -> String {
    match v {
        VoiceTone::Terse => "terse",
        VoiceTone::Warm => "warm",
        VoiceTone::Formal => "formal",
    }
    .to_string()
}

/// Build the canonical `Soul` for an operator's current identity (for writing
/// the file on create/update/migration).
pub fn soul_from_operator(op: &Operator) -> Soul {
    Soul {
        frontmatter: SoulFrontmatter {
            name: op.name.clone(),
            avatar: (!op.emoji.is_empty()).then(|| op.emoji.clone()),
            color: (!op.color.is_empty()).then(|| op.color.clone()),
            model: (!op.model.is_empty()).then(|| op.model.clone()),
            voice: Some(voice_to_frontmatter(op.voice)),
            escalate_threshold: Some(op.escalate_threshold),
            tags: op.tags.clone(),
            hard_constraints: (!op.hard_constraints.trim().is_empty())
                .then(|| op.hard_constraints.clone()),
        },
        body: op.persona.clone(),
    }
}

/// Overlay a parsed `Soul`'s identity onto an existing `Operator` (hydration on
/// load / hot-reload). Runtime fields (id, xp, is_default, timestamps,
/// soul_path) are preserved; identity fields are taken from the soul, falling
/// back to the operator's current value when the frontmatter omits them.
pub fn hydrate_operator(op: &mut Operator, soul: &Soul) {
    let fm = &soul.frontmatter;
    op.name = fm.name.clone();
    if let Some(a) = &fm.avatar {
        op.emoji = a.clone();
    }
    if let Some(c) = &fm.color {
        op.color = c.clone();
    }
    if let Some(m) = &fm.model {
        op.model = m.clone();
    }
    op.voice = voice_from_frontmatter(fm.voice.as_deref());
    if let Some(t) = fm.escalate_threshold {
        op.escalate_threshold = t;
    }
    op.tags = fm.tags.clone();
    op.hard_constraints = fm.hard_constraints.clone().unwrap_or_default();
    op.persona = soul.body.clone();
}

pub fn mtime_of(path: &std::path::Path) -> Option<u64> {
    use std::time::UNIX_EPOCH;
    let m = std::fs::metadata(path).ok()?;
    m.modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()
        .map(|d| d.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::VoiceTone;

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

    #[test]
    fn voice_parses_case_insensitively() {
        assert!(matches!(voice_from_frontmatter(Some("Warm")), VoiceTone::Warm));
        assert!(matches!(voice_from_frontmatter(Some("formal")), VoiceTone::Formal));
        assert!(matches!(voice_from_frontmatter(None), VoiceTone::Terse));
        assert!(matches!(voice_from_frontmatter(Some("nonsense")), VoiceTone::Terse));
    }

    #[test]
    fn soul_from_operator_round_trips_identity() {
        let op = crate::operator_registry::Operator {
            id: crate::operator_registry::OperatorId(ulid::Ulid::new()),
            name: "Atlas".into(),
            emoji: "pack2:guardian".into(),
            color: "#c4a7ff".into(),
            tags: vec!["deploys".into()],
            persona: "I was made to wait.".into(),
            escalate_threshold: 0.55,
            model: "claude-sonnet-4-6".into(),
            hard_constraints: "^git push --force".into(),
            is_default: false,
            created_at_unix_ms: 0,
            updated_at_unix_ms: 0,
            xp: 0,
            voice: VoiceTone::Warm,
            soul_path: None,
            soul_mtime_unix_ms: 0,
        };
        let soul = soul_from_operator(&op);
        assert_eq!(soul.frontmatter.name, "Atlas");
        assert_eq!(soul.frontmatter.avatar.as_deref(), Some("pack2:guardian"));
        assert_eq!(soul.frontmatter.voice.as_deref(), Some("warm"));
        assert_eq!(soul.body, "I was made to wait.");
        assert_eq!(soul.frontmatter.hard_constraints.as_deref(), Some("^git push --force"));
    }
}
