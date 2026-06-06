use std::collections::HashMap;
use std::sync::atomic::AtomicU8;
use std::sync::Mutex;
use std::time::Instant;

use karl_session::{EscalationKind, OperatorAction, OperatorRef, ProjectRef};

use super::types::{InlineKeyboardButton, InlineKeyboardMarkup};

pub const STATUS_DISABLED: u8 = 0;
pub const STATUS_OK: u8 = 1;
pub const STATUS_ERROR: u8 = 2;

/// One live (unresolved) escalation we may coalesce onto instead of posting
/// a duplicate. Keyed by (session_id, escalation-kind) in `OutboundState`.
pub struct ActivePing {
    pub message_id: i64,
    pub escalation_id: String,
    pub last_sent: Instant,
    pub count: u32,
}

#[derive(Default)]
pub struct OutboundState {
    pub map: Mutex<HashMap<i64, String>>, // message_id -> escalation_id
    pub session_map: Mutex<HashMap<String, String>>, // escalation_id -> session_id
    /// Last inbound long-poll outcome. Drives the statusbar Telegram pill.
    /// `STATUS_DISABLED` while no inbound loop is running (token/chat empty).
    pub status: AtomicU8,
    /// (session_id, kind_key) -> live ping, for coalescing repeats.
    pub active: Mutex<HashMap<(String, String), ActivePing>>,
}

/// Stable string key for an EscalationKind so we can map without Hash derive.
pub fn kind_key(kind: &EscalationKind) -> String {
    format!("{kind:?}")
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

/// A short, human-readable trigger label for the message header so the user
/// instantly sees *why* they were pinged. Maps each `EscalationKind` to one
/// of two user-facing classes: a safety `blocked` (we refused to run
/// something) vs. a generic `needs you` (the executor is stuck / out of
/// budget / waiting).
fn trigger_label(kind: &EscalationKind) -> &'static str {
    match kind {
        EscalationKind::Blocklist => "blocked",
        EscalationKind::Loop | EscalationKind::Blocked | EscalationKind::BudgetExhausted => {
            "needs you"
        }
    }
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
        "{emoji} {name} · {repo} ({branch})  —  {label}\n{trimmed}",
        emoji = display_emoji(&ctx.operator.emoji, &ctx.operator.color),
        name = ctx.operator.name,
        repo = ctx.project.repo,
        branch = ctx.project.branch,
        label = trigger_label(ctx.kind),
    )
}

/// Resolve the glyph shown before the operator name in a Telegram message.
///
/// Custom avatar packs (e.g. `pack2:junior`) are app-internal references
/// Telegram cannot render — dumping them raw shows literal text like
/// "pack2:junior". When `emoji` isn't a real emoji we fall back to the
/// colored circle nearest the operator's `#RRGGBB` color, so the header
/// still reads as a small colored marker.
fn display_emoji(emoji: &str, color: &str) -> String {
    if is_renderable_emoji(emoji) {
        return emoji.to_string();
    }
    nearest_circle(color).to_string()
}

/// True when `s` is a single real emoji we can pass through to Telegram.
/// Avatar-pack refs are ASCII (`pack2:junior`); genuine emoji are
/// non-ASCII and short. We treat any all-ASCII or empty value as "not an
/// emoji" so it gets the colored-circle fallback.
fn is_renderable_emoji(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty() && !s.is_ascii()
}

/// Map a `#RRGGBB` color to the nearest Telegram colored-circle emoji.
fn nearest_circle(color: &str) -> &'static str {
    // (emoji, r, g, b) — the standard Unicode color circles.
    const CIRCLES: &[(&str, i32, i32, i32)] = &[
        ("🔴", 220, 40, 40),
        ("🟠", 240, 150, 40),
        ("🟡", 240, 210, 60),
        ("🟢", 70, 180, 80),
        ("🔵", 60, 120, 220),
        ("🟣", 150, 90, 200),
        ("🟤", 140, 90, 60),
        ("⚫", 30, 30, 30),
        ("⚪", 235, 235, 235),
    ];
    let Some((r, g, b)) = parse_hex(color) else {
        return "🔵";
    };
    CIRCLES
        .iter()
        .min_by_key(|(_, cr, cg, cb)| {
            (cr - r).pow(2) + (cg - g).pow(2) + (cb - b).pow(2)
        })
        .map(|(e, ..)| *e)
        .unwrap_or("🔵")
}

/// Parse `#RRGGBB` (or `RRGGBB`) into `(r, g, b)` as i32s.
fn parse_hex(color: &str) -> Option<(i32, i32, i32)> {
    let h = color.trim().strip_prefix('#').unwrap_or(color.trim());
    if h.len() != 6 {
        return None;
    }
    let r = i32::from_str_radix(&h[0..2], 16).ok()?;
    let g = i32::from_str_radix(&h[2..4], 16).ok()?;
    let b = i32::from_str_radix(&h[4..6], 16).ok()?;
    Some((r, g, b))
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
    fn avatar_pack_ref_falls_back_to_colored_circle() {
        let mut op = maya();
        op.emoji = "pack2:junior".into(); // app-internal avatar ref
        op.color = "#a855f7".into(); // purple
        let pr = proj();
        let actions: Vec<OperatorAction> = vec![];
        let ctx = OutboundContext {
            operator: &op,
            project: &pr,
            session_short: "ab12",
            kind: &EscalationKind::Blocked,
            summary: "s",
            actions: &actions,
        };
        let out = format_message(&ctx);
        assert!(!out.contains("pack2:junior"), "raw pack ref leaked: {out}");
        assert!(out.contains("🟣 Maya"), "expected purple circle: {out}");
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
    fn format_message_has_trigger_header_and_body() {
        let op = maya();
        let pr = proj();
        let actions = vec![OperatorAction::PushAndPR];
        let ctx = OutboundContext {
            operator: &op,
            project: &pr,
            session_short: "abcd",
            kind: &EscalationKind::Blocklist,
            summary: "blocked: git push --force to main",
            actions: &actions,
        };
        let m = format_message(&ctx);
        assert!(m.contains("blocked: git push"), "kept the summary: {m}");
        // Trigger label present in the header for a Blocklist kind.
        assert!(m.contains("blocked"), "label present: {m}");
        // Repo/branch line preserved.
        assert!(m.contains(&pr.repo), "repo preserved: {m}");
        // Loop maps to "needs you".
        let loop_ctx = OutboundContext {
            operator: &op,
            project: &pr,
            session_short: "abcd",
            kind: &EscalationKind::Loop,
            summary: "executor not accepting input",
            actions: &actions,
        };
        let lm = format_message(&loop_ctx);
        assert!(lm.contains("needs you"), "loop label: {lm}");
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
