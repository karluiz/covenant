//! Typed references to operators, projects, and actions.
//!
//! These types travel on [`crate::SessionEvent`] (in Task 4) and over the
//! Tauri IPC boundary. They are deliberately `String`-shaped (rather than
//! holding `OperatorId`/`Ulid`) so the session crate does not need to
//! depend on the `app` crate or grow knowledge of operator-registry
//! internals.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct OperatorRef {
    /// Stringified `OperatorId`. We use `String` here to keep the session
    /// crate free of an `ulid`-typed operator identifier (operators live
    /// in the `app` crate).
    pub id: String,
    pub name: String,
    pub emoji: String,
    pub color: String,
    pub voice: VoiceToneSnapshot,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum VoiceToneSnapshot {
    Terse,
    Warm,
    Formal,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ProjectRef {
    pub repo: String,
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type")]
pub enum OperatorAction {
    PushAndPR,
    RunCommand { cmd: String },
    Reply,
    Snooze { minutes: u32 },
    Custom { id: String, label: String },
}

impl OperatorAction {
    pub fn button_label(&self) -> String {
        match self {
            OperatorAction::PushAndPR => "✓ Approve push".into(),
            OperatorAction::RunCommand { cmd } => {
                let c: String = cmd.chars().take(20).collect();
                format!("✓ Run `{}`", c)
            }
            OperatorAction::Reply => "✗ Reject".into(),
            OperatorAction::Snooze { minutes } => format!("⏸ Snooze {}m", minutes),
            OperatorAction::Custom { label, .. } => label.clone(),
        }
    }

    pub fn callback_id(&self) -> &'static str {
        match self {
            OperatorAction::PushAndPR => "push_pr",
            OperatorAction::RunCommand { .. } => "run",
            OperatorAction::Reply => "reply",
            OperatorAction::Snooze { .. } => "snooze",
            OperatorAction::Custom { .. } => "custom",
        }
    }
}

#[cfg(test)]
mod ref_tests {
    use super::*;

    #[test]
    fn operator_action_button_labels() {
        assert!(OperatorAction::PushAndPR.button_label().contains("Approve"));
        assert_eq!(
            OperatorAction::Snooze { minutes: 10 }.button_label(),
            "⏸ Snooze 10m"
        );
        assert!(OperatorAction::RunCommand {
            cmd: "git status".into()
        }
        .button_label()
        .contains("git status"));
    }

    #[test]
    fn operator_ref_roundtrips() {
        let r = OperatorRef {
            id: "01H".into(),
            name: "Maya".into(),
            emoji: "🟣".into(),
            color: "#a855f7".into(),
            voice: VoiceToneSnapshot::Terse,
        };
        let j = serde_json::to_string(&r).unwrap();
        let back: OperatorRef = serde_json::from_str(&j).unwrap();
        assert_eq!(r.name, back.name);
    }
}
