use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct OutboundState {
    pub map: Mutex<HashMap<i64, String>>, // message_id -> escalation_id
    pub session_map: Mutex<HashMap<String, String>>, // escalation_id -> session_id
}

pub fn format_escalation(tab_name: &str, kind: &str, summary: &str) -> String {
    let trimmed = if summary.chars().count() > 500 {
        let mut s: String = summary.chars().take(499).collect();
        s.push('…');
        s
    } else {
        summary.to_string()
    };
    format!("[tab: {tab_name}] {kind}\n{trimmed}")
}

pub fn keyboard_for(actions: &[String], escalation_id: &str) -> super::types::InlineKeyboardMarkup {
    use super::types::{InlineKeyboardButton, InlineKeyboardMarkup};
    let buttons: Vec<InlineKeyboardButton> = actions.iter().map(|a| {
        let label = match a.as_str() {
            "Approve" => "✓ Approve",
            "Reject" => "✗ Reject",
            "Snooze10m" => "⏸ Snooze 10m",
            other => other,
        }.to_string();
        InlineKeyboardButton {
            text: label,
            callback_data: format!("esc:{escalation_id}:{a}"),
        }
    }).collect();
    InlineKeyboardMarkup { inline_keyboard: vec![buttons] }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncates_long_summary() {
        let long = "x".repeat(800);
        let out = format_escalation("dep", "BLOCKED", &long);
        assert!(out.contains("…"));
        assert!(out.chars().count() <= 600);
    }

    #[test]
    fn short_summary_passes_through() {
        let out = format_escalation("dep", "BLOCKED", "hi");
        assert_eq!(out, "[tab: dep] BLOCKED\nhi");
    }

    #[test]
    fn keyboard_encodes_action_in_callback() {
        let kb = keyboard_for(&["Approve".into(), "Reject".into()], "01J123");
        assert_eq!(kb.inline_keyboard[0][0].callback_data, "esc:01J123:Approve");
        assert_eq!(kb.inline_keyboard[0][1].callback_data, "esc:01J123:Reject");
    }
}
