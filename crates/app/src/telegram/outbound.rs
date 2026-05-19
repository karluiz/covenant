use std::collections::HashMap;
use std::sync::atomic::AtomicU8;
use std::sync::Mutex;

use karl_session::{EscalationKind, OperatorAction, OperatorRef, ProjectRef};

use super::types::{InlineKeyboardButton, InlineKeyboardMarkup};

pub const STATUS_DISABLED: u8 = 0;
pub const STATUS_OK: u8 = 1;
pub const STATUS_ERROR: u8 = 2;

#[derive(Default)]
pub struct OutboundState {
    pub map: Mutex<HashMap<i64, String>>, // message_id -> escalation_id
    pub session_map: Mutex<HashMap<String, String>>, // escalation_id -> session_id
    /// Last inbound long-poll outcome. Drives the statusbar Telegram pill.
    /// `STATUS_DISABLED` while no inbound loop is running (token/chat empty).
    pub status: AtomicU8,
}

/// Inputs to render an outbound escalation message + keyboard. Built once
/// per escalation; cheap to construct.
pub struct OutboundContext<'a> {
    pub operator: &'a OperatorRef,
    pub project: &'a ProjectRef,
    pub session_short: &'a str,
    pub kind: &'a EscalationKind,
    pub summary: &'a str,
    pub actions: &'a [OperatorAction],
}

pub fn format_message(ctx: &OutboundContext) -> String {
    let trimmed = if ctx.summary.chars().count() > 500 {
        let mut s: String = ctx.summary.chars().take(499).collect();
        s.push('…');
        s
    } else {
        ctx.summary.to_string()
    };
    format!(
        "{emoji} {name} · {repo} ({branch})\n{trimmed}",
        emoji = ctx.operator.emoji,
        name = ctx.operator.name,
        repo = ctx.project.repo,
        branch = ctx.project.branch,
    )
}

pub fn keyboard_for(ctx: &OutboundContext, escalation_id: &str) -> InlineKeyboardMarkup {
    let buttons: Vec<InlineKeyboardButton> = ctx
        .actions
        .iter()
        .map(|a| InlineKeyboardButton {
            text: a.button_label(),
            callback_data: format!("esc:{escalation_id}:{}", a.callback_id()),
        })
        .collect();
    InlineKeyboardMarkup {
        inline_keyboard: vec![buttons],
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use karl_session::VoiceToneSnapshot;

    fn maya() -> OperatorRef {
        OperatorRef {
            id: "01H".into(),
            name: "Maya".into(),
            emoji: "🟣".into(),
            color: "#a855f7".into(),
            voice: VoiceToneSnapshot::Terse,
        }
    }

    fn proj() -> ProjectRef {
        ProjectRef {
            repo: "karlTerminal".into(),
            branch: "main".into(),
        }
    }

    #[test]
    fn message_has_emoji_name_repo_branch_and_summary() {
        let op = maya();
        let pr = proj();
        let actions: Vec<OperatorAction> = vec![];
        let ctx = OutboundContext {
            operator: &op,
            project: &pr,
            session_short: "ab12",
            kind: &EscalationKind::Blocked,
            summary: "tests failing",
            actions: &actions,
        };
        let out = format_message(&ctx);
        assert!(out.contains("🟣 Maya"), "got: {out}");
        assert!(out.contains("karlTerminal (main)"), "got: {out}");
        assert!(out.contains("tests failing"), "got: {out}");
        assert!(
            !out.contains("[tab: session:"),
            "legacy prefix leaked: {out}"
        );
    }

    #[test]
    fn keyboard_uses_action_labels_and_callback_ids() {
        let op = maya();
        let pr = proj();
        let actions = vec![
            OperatorAction::PushAndPR,
            OperatorAction::Snooze { minutes: 10 },
        ];
        let ctx = OutboundContext {
            operator: &op,
            project: &pr,
            session_short: "ab12",
            kind: &EscalationKind::Blocked,
            summary: "s",
            actions: &actions,
        };
        let kb = keyboard_for(&ctx, "esc-1");
        let row = &kb.inline_keyboard[0];
        assert!(row[0].text.contains("Approve push"), "got: {}", row[0].text);
        assert!(row[1].text.contains("Snooze 10m"), "got: {}", row[1].text);
        assert_eq!(row[0].callback_data, "esc:esc-1:push_pr");
        assert_eq!(row[1].callback_data, "esc:esc-1:snooze");
    }

    #[test]
    fn long_summary_is_truncated() {
        let op = maya();
        let pr = proj();
        let actions: Vec<OperatorAction> = vec![];
        let long = "x".repeat(800);
        let ctx = OutboundContext {
            operator: &op,
            project: &pr,
            session_short: "ab12",
            kind: &EscalationKind::Blocked,
            summary: &long,
            actions: &actions,
        };
        let out = format_message(&ctx);
        assert!(out.contains("…"));
        assert!(out.chars().count() <= 600);
    }
}
