//! Build a compact world-model snapshot to feed the teammate operator.
//!
//! Phase 3a (v0.8.3): the operator gets a section before the conversation
//! that describes the user's open terminal sessions. The active session
//! gets the full render (cwd + rolling summary + last few blocks +
//! in-flight command). Other sessions get a one-liner each so the
//! operator is aware they exist without paying the full cost.
//!
//! Snapshots are built per call and NOT cached. The system prompt
//! describes the *shape* of this section (cached); the contents vary.

use karl_session::SessionId;

use crate::world::{InFlightBlock, SessionWorldModel};

#[derive(Debug, Clone)]
pub struct SessionSnapshot {
    pub id: SessionId,
    pub is_active: bool,
    pub cwd: String,
    pub summary: Option<String>,
    pub last_blocks: Vec<BlockBrief>,
    pub in_flight: Option<InFlightBrief>,
}

#[derive(Debug, Clone)]
pub struct BlockBrief {
    pub command: String,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct InFlightBrief {
    pub command: String,
    pub elapsed_ms: u64,
}

/// Project a `SessionWorldModel` into a snapshot. Caller takes care of
/// the lock; this function is pure.
pub fn project(
    id: SessionId,
    world: &SessionWorldModel,
    is_active: bool,
    now_unix_ms: u64,
) -> SessionSnapshot {
    let last_blocks: Vec<BlockBrief> = world
        .blocks
        .iter()
        .rev()
        .take(if is_active { 4 } else { 1 })
        .map(|b| BlockBrief {
            command: b.command.clone(),
            exit_code: b.exit_code,
            duration_ms: b.duration_ms,
        })
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    let in_flight = world.in_flight.as_ref().map(|f: &InFlightBlock| {
        let elapsed = now_unix_ms.saturating_sub(f.started_at_unix_ms);
        InFlightBrief {
            command: f.command.clone(),
            elapsed_ms: elapsed,
        }
    });
    SessionSnapshot {
        id,
        is_active,
        cwd: world.cwd.display().to_string(),
        summary: world.summary.clone(),
        last_blocks,
        in_flight,
    }
}

/// Render a slice of snapshots into the markdown-ish section that goes
/// at the top of the user message.
pub fn render(snapshots: &[SessionSnapshot]) -> String {
    let mut out = String::with_capacity(1024);
    out.push_str("# Terminal context\n\n");
    out.push_str(
        "When you refer to a session in your reply, describe it by what it's \
         doing — the running command, the cwd, or the rolling summary. \
         NEVER show the internal id (e.g. `MWA8BF`) to the user; it is a \
         machine handle, not a human label.\n\n",
    );
    if snapshots.is_empty() {
        out.push_str("(no open terminal sessions)\n");
        return out;
    }
    let active = snapshots.iter().find(|s| s.is_active);
    let others: Vec<&SessionSnapshot> = snapshots.iter().filter(|s| !s.is_active).collect();

    if let Some(a) = active {
        out.push_str("## Active session\n");
        render_session_full(&mut out, a);
    } else {
        out.push_str("(no session is marked active)\n\n");
    }

    if !others.is_empty() {
        out.push_str("\n## Other open sessions\n");
        for s in others {
            render_session_brief(&mut out, s);
        }
    }
    out
}

fn render_session_full(out: &mut String, s: &SessionSnapshot) {
    let short = short_id(&s.id);
    out.push_str(&format!(
        "- internal id: `{short}` (machine-only, never show to user)\n"
    ));
    if !s.cwd.is_empty() {
        out.push_str(&format!("- cwd: `{}`\n", s.cwd));
    }
    if let Some(ref summary) = s.summary {
        let trimmed = summary.trim();
        if !trimmed.is_empty() {
            out.push_str("- rolling summary:\n  ");
            out.push_str(&indent_lines(trimmed, "  "));
            out.push('\n');
        }
    }
    if let Some(ref f) = s.in_flight {
        let secs = f.elapsed_ms / 1000;
        out.push_str(&format!(
            "- currently running: `$ {}` (elapsed {}s)\n",
            f.command, secs
        ));
    }
    if !s.last_blocks.is_empty() {
        out.push_str("- recent blocks (oldest first):\n");
        for b in &s.last_blocks {
            let exit = b
                .exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into());
            out.push_str(&format!(
                "  - `$ {}` → exit {} ({} ms)\n",
                b.command, exit, b.duration_ms
            ));
        }
    }
}

fn render_session_brief(out: &mut String, s: &SessionSnapshot) {
    let short = short_id(&s.id);
    let cwd = if s.cwd.is_empty() {
        "—"
    } else {
        s.cwd.as_str()
    };
    let summary_line = s.summary.as_deref().map(first_line).unwrap_or_else(|| {
        s.last_blocks
            .last()
            .map(|b| {
                let exit = b
                    .exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "?".into());
                format!("last: `$ {}` → exit {}", b.command, exit)
            })
            .unwrap_or_else(|| "idle".to_string())
    });
    out.push_str(&format!(
        "- session [id `{short}` — machine-only] · cwd `{cwd}` · {summary_line}\n"
    ));
}

fn short_id(id: &SessionId) -> String {
    let s = id.to_string();
    let take = s.chars().count().saturating_sub(6);
    s.chars().skip(take).collect()
}

fn first_line(s: &str) -> String {
    s.lines().next().unwrap_or("").trim().to_string()
}

fn indent_lines(s: &str, indent: &str) -> String {
    s.lines().collect::<Vec<_>>().join(&format!("\n{indent}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::world::{BlockSnapshot, SessionWorldModel};
    use std::path::PathBuf;

    fn world_with(cwd: &str, summary: Option<&str>, blocks: Vec<(&str, i32)>) -> SessionWorldModel {
        let mut w = SessionWorldModel::default();
        w.cwd = PathBuf::from(cwd);
        w.summary = summary.map(|s| s.to_string());
        for (cmd, exit) in blocks {
            w.blocks.push_back(BlockSnapshot {
                command: cmd.into(),
                cwd: PathBuf::from(cwd),
                exit_code: Some(exit),
                duration_ms: 10,
                output_text: String::new(),
            });
        }
        w
    }

    #[test]
    fn renders_empty_state_when_no_sessions() {
        let out = render(&[]);
        assert!(out.contains("no open terminal sessions"));
    }

    #[test]
    fn renders_active_session_full() {
        let id = SessionId::new();
        let w = world_with(
            "/tmp/x",
            Some("user is debugging cargo build"),
            vec![("cargo build", 1), ("cargo check", 0)],
        );
        let snap = project(id, &w, true, 0);
        let out = render(&[snap]);
        assert!(out.contains("## Active session"));
        assert!(out.contains("/tmp/x"));
        assert!(out.contains("user is debugging cargo build"));
        assert!(out.contains("cargo build"));
        assert!(out.contains("exit 1"));
    }

    #[test]
    fn renders_other_sessions_brief() {
        let a = SessionId::new();
        let b = SessionId::new();
        let snap_a = project(a, &world_with("/a", None, vec![("ls", 0)]), true, 0);
        let snap_b = project(b, &world_with("/b", None, vec![("rm bad", 1)]), false, 0);
        let out = render(&[snap_a, snap_b]);
        assert!(out.contains("## Active session"));
        assert!(out.contains("/a"));
        assert!(out.contains("## Other open sessions"));
        assert!(out.contains("/b"));
        assert!(out.contains("rm bad"));
        // The "Other open sessions" section must not expand into a full block list.
        let other_section = out.split("## Other open sessions").nth(1).unwrap_or("");
        assert!(!other_section.contains("- recent blocks"));
    }

    #[test]
    fn renders_in_flight_command() {
        let id = SessionId::new();
        let mut w = world_with("/x", None, vec![]);
        w.in_flight = Some(crate::world::InFlightBlock {
            command: "npm run dev".into(),
            cwd: PathBuf::from("/x"),
            started_at_unix_ms: 1_000,
        });
        let snap = project(id, &w, true, 6_000);
        let out = render(&[snap]);
        assert!(out.contains("currently running"));
        assert!(out.contains("npm run dev"));
        assert!(out.contains("elapsed 5s"));
    }

    #[test]
    fn handles_no_active_session() {
        let id = SessionId::new();
        let w = world_with("/x", None, vec![("ls", 0)]);
        let snap = project(id, &w, false, 0);
        let out = render(&[snap]);
        assert!(out.contains("no session is marked active"));
        assert!(out.contains("## Other open sessions"));
        assert!(out.contains("/x"));
    }
}
