//! Bundled starter souls for the create-operator archetype gallery. Embedded at
//! compile time so they ship in the binary without resource-path resolution.

use serde::Serialize;

pub struct Archetype {
    pub key: &'static str,
    pub raw: &'static str,
}

pub const ARCHETYPES: &[Archetype] = &[
    Archetype {
        key: "guardian",
        raw: include_str!("../../../operator-souls/guardian.md"),
    },
    Archetype {
        key: "scout",
        raw: include_str!("../../../operator-souls/scout.md"),
    },
    Archetype {
        key: "surgeon",
        raw: include_str!("../../../operator-souls/surgeon.md"),
    },
    Archetype {
        key: "diplomat",
        raw: include_str!("../../../operator-souls/diplomat.md"),
    },
    Archetype {
        key: "archivist",
        raw: include_str!("../../../operator-souls/archivist.md"),
    },
];

/// View sent to the UI: key + raw soul text + parsed display fields.
#[derive(Debug, Serialize)]
pub struct ArchetypeView {
    pub key: String,
    pub raw: String,
    pub name: String,
    pub avatar: Option<String>,
    pub color: Option<String>,
    /// First non-heading, non-empty line of the body, for the gallery card.
    pub tagline: String,
    pub voice: Option<String>,
    pub escalate_threshold: Option<f32>,
    /// First tag, surfaced as a micro-chip in the spotlight.
    pub tag: Option<String>,
}

pub fn list() -> Vec<ArchetypeView> {
    ARCHETYPES
        .iter()
        .filter_map(|a| {
            let soul = crate::soul::parse(a.raw).ok()?;
            let tagline = soul
                .body
                .lines()
                .find(|l| !l.trim_start().starts_with('#') && !l.trim().is_empty())
                .unwrap_or("")
                .trim()
                .to_string();
            Some(ArchetypeView {
                key: a.key.to_string(),
                raw: a.raw.to_string(),
                name: soul.frontmatter.name,
                avatar: soul.frontmatter.avatar,
                color: soul.frontmatter.color,
                tagline,
                voice: soul.frontmatter.voice,
                escalate_threshold: soul.frontmatter.escalate_threshold,
                tag: soul.frontmatter.tags.into_iter().next(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    #[test]
    fn all_archetypes_parse() {
        let v = super::list();
        assert_eq!(v.len(), 5);
        assert!(v.iter().any(|a| a.name == "The Guardian"));
        assert!(v.iter().all(|a| !a.tagline.is_empty()));
    }
}
