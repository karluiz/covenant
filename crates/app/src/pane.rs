//! Rust mirror of the TS Pane/Layout types. Used for the tab manifest
//! schema only — the live state lives in the UI; Rust just persists
//! the manifest blob.
#![allow(dead_code)] // TODO: remove once tab_manifest persistence wires these in (Phase E).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaneKind {
    Terminal,
    Pi,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SerializedPane {
    pub id: String,
    pub kind: PaneKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub mission_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub operator_id: Option<String>,
    pub replay_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LayoutKind {
    Single,
    Split,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Horizontal,
    Vertical,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SerializedLayout {
    pub kind: LayoutKind,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub orientation: Option<Orientation>,
    /// Index of the focused pane: `0` = left/top, `1` = right/bottom.
    pub active: u8,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub ratio: Option<f32>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_roundtrip_terminal() {
        let p = SerializedPane {
            id: "01H1".into(),
            kind: PaneKind::Terminal,
            session_id: Some("01H2".into()),
            cwd: Some("/repo".into()),
            mission_path: None,
            operator_id: Some("claude".into()),
            replay_key: "rk1".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(!s.contains("mission_path"));
        let p2: SerializedPane = serde_json::from_str(&s).unwrap();
        assert_eq!(p, p2);
    }

    #[test]
    fn layout_single_serializes_without_orientation() {
        let l = SerializedLayout {
            kind: LayoutKind::Single,
            orientation: None,
            active: 0,
            ratio: None,
        };
        let s = serde_json::to_string(&l).unwrap();
        assert!(!s.contains("orientation"));
        assert!(!s.contains("ratio"));
    }

    #[test]
    fn layout_split_requires_orientation_on_deserialize() {
        // permissive — Rust enum doesn't enforce conditional fields;
        // invariant lives at the construction site.
        let s = r#"{"kind":"split","active":1,"ratio":0.6,"orientation":"horizontal"}"#;
        let l: SerializedLayout = serde_json::from_str(s).unwrap();
        assert_eq!(l.kind, LayoutKind::Split);
        assert_eq!(l.orientation, Some(Orientation::Horizontal));
    }
}
