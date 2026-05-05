//! Convergence Mode (spec 3.8) — read-only aggregator that builds one
//! tile per open session for the ⌘⇧O overlay. NO schema changes; pulls
//! from existing AppState handles only.

use serde::Serialize;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TileStatus {
    Idle,
    Working,
    AwaitingInput,
    Blocked,
    OperatorThinking,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Vendor { Claude, Copilot, Opencode, Aider, Codex, Unknown }

/// Heuristic vendor detection from a foreground command string.
/// `npx <pkg>` is unwrapped one level; `@scope/name` packages map by
/// the trailing name segment (e.g. `@anthropic-ai/claude-code` → claude).
/// Unknown is a first-class result, never an error.
pub fn detect_vendor(cmd: Option<&str>) -> Vendor {
    let s = match cmd {
        Some(s) if !s.trim().is_empty() => s.trim(),
        _ => return Vendor::Unknown,
    };
    let mut head = s.split_whitespace().next().unwrap_or("");
    if head == "npx" {
        head = s.trim_start_matches("npx").trim_start().split_whitespace().next().unwrap_or("");
    }
    let key = head.rsplit('/').next().unwrap_or(head);
    match key {
        h if h.starts_with("claude") => Vendor::Claude,
        h if h.starts_with("copilot") => Vendor::Copilot,
        h if h.starts_with("opencode") => Vendor::Opencode,
        h if h.starts_with("aider") => Vendor::Aider,
        h if h.starts_with("codex") => Vendor::Codex,
        _ => Vendor::Unknown,
    }
}


/// Derive the displayed mission name from a stored `mission_path`.
/// Strips `.md` (via `Path::file_stem`) and truncates to 40 chars.
pub fn mission_name_from_path(path: Option<&str>) -> Option<String> {
    let p = path?;
    let stem = std::path::Path::new(p).file_stem()?.to_string_lossy().to_string();
    if stem.is_empty() {
        return None;
    }
    Some(stem.chars().take(40).collect())
}

#[derive(Debug, Clone, Serialize)]
pub struct SessionSummary {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub status: TileStatus,
    pub vendor: Vendor,
    pub raw_command_label: Option<String>,
    pub last_command: Option<String>,
    pub last_output_line: Option<String>,
    pub last_decision_action: Option<String>,
    pub last_decision_rationale: Option<String>,
    pub mission_name: Option<String>,
    pub cost_usd: Option<f64>,
    pub budget_usd: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct OperatorRosterEntry {
    pub operator_id: String,
    pub operator_name: String,
    pub operator_avatar: Option<String>,
    pub sessions: Vec<SessionSummary>,
    /// Convenience: any session in the entry has TileStatus::Blocked.
    pub has_escalation: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct EscalationCard {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub operator_id: String,
    pub operator_name: String,
    pub operator_avatar: Option<String>,
    pub vendor: Vendor,
    pub raw_command_label: Option<String>,
    /// The operator's open question — `last_decision_rationale` of the
    /// escalating decision, full text (no truncation in backend).
    pub question: Option<String>,
    pub mission_name: Option<String>,
    /// Unix ms of the escalating decision row, used by the UI for
    /// "2m ago" labels and oldest-first sort.
    pub escalated_at_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvergenceSnapshot {
    pub roster: Vec<OperatorRosterEntry>,
    pub escalations: Vec<EscalationCard>,
}

/// Inputs the classifier needs. Kept separate from `OperatorState` so
/// we can unit-test without spinning up the watcher.
pub struct StatusInputs<'a> {
    pub last_byte_at: Instant,
    pub bytes_total: u64,
    pub last_decision_at_bytes_total: u64,
    pub last_decision_action: Option<&'a str>,
    pub now: Instant,
}

/// Pure status classifier. Rules (v1):
/// - `Working`     → bytes arrived within the last 750 ms
/// - `Blocked`     → last decision was `escalate` AND no new bytes
///                   since that decision
/// - `AwaitingInput` → bytes have arrived since the last decision AND
///                     the stream has been idle > 1500 ms
/// - `Idle`        → default
/// `OperatorThinking` is reserved for v2 (would require new surface
/// on OperatorWatcher). Always returns one of the four above in v1.
pub fn classify_status(inp: &StatusInputs) -> TileStatus {
    let idle = inp.now.duration_since(inp.last_byte_at);
    if idle < Duration::from_millis(750) {
        return TileStatus::Working;
    }
    let bytes_since_last_decision =
        inp.bytes_total.saturating_sub(inp.last_decision_at_bytes_total);
    if inp.last_decision_action == Some("escalate") && bytes_since_last_decision == 0 {
        return TileStatus::Blocked;
    }
    if bytes_since_last_decision > 0 && idle > Duration::from_millis(1500) {
        return TileStatus::AwaitingInput;
    }
    TileStatus::Idle
}

/// Snapshot-builder layer override. When the operator has an LLM call
/// in flight for this session, the tile shows `OperatorThinking`
/// regardless of byte activity; otherwise we fall through to the pure
/// 4-state classifier. Kept out of `classify_status` to preserve its
/// existing invariants and unit tests.
pub fn decide_status(is_thinking: bool, inp: &StatusInputs) -> TileStatus {
    if is_thinking {
        TileStatus::OperatorThinking
    } else {
        classify_status(inp)
    }
}

/// ANSI-strips the byte slice and returns the last non-empty line,
/// truncated to `max_chars` (chars, not bytes — emoji-safe).
pub fn last_non_empty_line(bytes: &[u8], max_chars: usize) -> Option<String> {
    let stripped = strip_ansi_escapes::strip(bytes);
    let s = String::from_utf8_lossy(&stripped);
    let line = s
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())?
        .to_string();
    Some(line.chars().take(max_chars).collect())
}

use crate::aom::AomHandle;
use crate::operator::{OperatorState, OperatorWatcher};
use crate::storage::{OperatorDecisionRow, Storage};
use karl_session::SessionId;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

/// Frontend-supplied tab metadata, sent with each command invocation.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct TabHint {
    pub session_id: String,
    pub title: String,
    pub color: Option<String>,
}

/// Per-session inputs the aggregator needs. The frontend supplies
/// title/color (it owns tab metadata); the backend supplies status +
/// activity. `op_state` is shared with the byte pump — we lock it
/// only briefly to snapshot the tail.
pub struct SessionInput {
    pub session_id: SessionId,
    pub op_state: Arc<StdMutex<OperatorState>>,
    /// Tab title (already-resolved customName→defaultTitle in caller).
    pub tab_title: String,
    /// Optional tab color stripe.
    pub tab_color: Option<String>,
    /// `None` → tab has no assigned operator → snapshot will drop it.
    pub operator_id: Option<String>,
    /// Display name of the operator (e.g. "Raven"). Required when
    /// `operator_id` is `Some`; pass empty string only if unknown.
    pub operator_name: Option<String>,
    /// Operator avatar (emoji or short string). Optional.
    pub operator_avatar: Option<String>,
}

/// Flat row produced by the first pass of `build_convergence_snapshot`.
/// Exposed so `assemble_snapshot` can be unit-tested without async I/O.
pub struct BuiltRow {
    pub operator_id: String,
    pub operator_name: String,
    pub operator_avatar: Option<String>,
    pub summary: SessionSummary,
    pub escalated_at_unix_ms: u64,
}

/// Pure second + third pass: groups rows by operator, builds escalation
/// list, and sorts both. Extracted so tests can drive it without async.
pub fn assemble_snapshot(built: Vec<BuiltRow>) -> ConvergenceSnapshot {
    let mut escalations: Vec<EscalationCard> = built
        .iter()
        .filter(|b| matches!(b.summary.status, TileStatus::Blocked))
        .map(|b| EscalationCard {
            session_id: b.summary.session_id.clone(),
            tab_title: b.summary.tab_title.clone(),
            tab_color: b.summary.tab_color.clone(),
            operator_id: b.operator_id.clone(),
            operator_name: b.operator_name.clone(),
            operator_avatar: b.operator_avatar.clone(),
            vendor: b.summary.vendor,
            raw_command_label: b.summary.raw_command_label.clone(),
            question: b.summary.last_decision_rationale.clone(),
            mission_name: b.summary.mission_name.clone(),
            escalated_at_unix_ms: b.escalated_at_unix_ms,
        })
        .collect();
    escalations.sort_by_key(|e| e.escalated_at_unix_ms);

    let mut roster: Vec<OperatorRosterEntry> = Vec::new();
    for b in built {
        if let Some(entry) = roster.iter_mut().find(|e| e.operator_id == b.operator_id) {
            if matches!(b.summary.status, TileStatus::Blocked) {
                entry.has_escalation = true;
            }
            entry.sessions.push(b.summary);
        } else {
            let has_escalation = matches!(b.summary.status, TileStatus::Blocked);
            roster.push(OperatorRosterEntry {
                operator_id: b.operator_id,
                operator_name: b.operator_name,
                operator_avatar: b.operator_avatar,
                sessions: vec![b.summary],
                has_escalation,
            });
        }
    }
    roster.sort_by(|a, b| match (a.has_escalation, b.has_escalation) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.operator_name.cmp(&b.operator_name),
    });
    ConvergenceSnapshot { roster, escalations }
}

pub async fn build_convergence_snapshot(
    sessions: Vec<SessionInput>,
    operator: &OperatorWatcher,
    storage: &Storage,
    aom: &AomHandle,
) -> ConvergenceSnapshot {
    let recent = storage
        .list_operator_decisions(200)
        .await
        .unwrap_or_default();
    let by_short = index_decisions_by_short_id(&recent);

    let aom_state = aom.read().await;
    let aom_enabled = aom_state.enabled;
    let aom_budget = aom_state.budget_usd;
    let aom_started_ms = aom_state.started_at_unix_ms;
    drop(aom_state);

    let now = Instant::now();

    let mut built: Vec<BuiltRow> = Vec::with_capacity(sessions.len());
    for s in sessions {
        let Some(op_id) = s.operator_id else {
            continue;
        };
        let op_name = s.operator_name.clone().unwrap_or_default();
        let op_avatar = s.operator_avatar.clone();

        let id_str = s.session_id.to_string();
        let short = shorten6(&id_str);

        let (last_byte_at, bytes_total, last_decision_at_bytes_total, tail_bytes) = {
            let st = s.op_state.lock().expect("op_state poisoned");
            (st.last_byte_at, st.bytes_total, st.last_decision_at_bytes_total, st.snapshot_tail(8 * 1024))
        };

        let last = by_short.get(short.as_str()).copied();
        let last_action = last.map(|d| d.action.as_str());
        let cmd_for_vendor = last.and_then(|d| d.in_flight_command.as_deref());
        let vendor = detect_vendor(cmd_for_vendor);
        let raw_command_label = matches!(vendor, Vendor::Unknown)
            .then(|| cmd_for_vendor.map(|c| c.chars().take(40).collect::<String>()))
            .flatten();

        let is_thinking = operator.is_thinking(s.session_id).await;
        let status = decide_status(
            is_thinking,
            &StatusInputs { last_byte_at, bytes_total, last_decision_at_bytes_total, last_decision_action: last_action, now },
        );

        let op_enabled = operator.is_enabled(s.session_id).await;
        let aom_excluded = operator.is_aom_excluded(s.session_id).await;
        let enrolled = aom_enabled && op_enabled && !aom_excluded;
        let cost_usd = if enrolled { Some(sum_cost_for_short(&recent, &short, aom_started_ms)) } else { None };

        let summary = SessionSummary {
            session_id: id_str,
            tab_title: s.tab_title,
            tab_color: s.tab_color,
            status,
            vendor,
            raw_command_label,
            last_command: last.and_then(|d| d.in_flight_command.clone()),
            last_output_line: last_non_empty_line(&tail_bytes, 160),
            last_decision_action: last.map(|d| d.action.clone()),
            last_decision_rationale: last.and_then(|d| d.rationale.clone()),
            mission_name: mission_name_from_path(last.and_then(|d| d.mission_path.as_deref())),
            cost_usd,
            budget_usd: if enrolled { Some(aom_budget) } else { None },
        };

        built.push(BuiltRow {
            operator_id: op_id,
            operator_name: op_name,
            operator_avatar: op_avatar,
            escalated_at_unix_ms: last.map(|d| d.timestamp_unix_ms).unwrap_or(0),
            summary,
        });
    }

    assemble_snapshot(built)
}

fn shorten6(id: &str) -> String {
    let n = id.len();
    if n > 6 { id[n - 6..].to_string() } else { id.to_string() }
}

fn sum_cost_for_short(rows: &[OperatorDecisionRow], short: &str, since_ms: u64) -> f64 {
    rows.iter().filter(|r| r.session_id_short == short && r.timestamp_unix_ms >= since_ms).map(|r| r.cost_usd).sum()
}

fn index_decisions_by_short_id(rows: &[OperatorDecisionRow]) -> HashMap<&str, &OperatorDecisionRow> {
    let mut out = HashMap::new();
    for r in rows { out.entry(r.session_id_short.as_str()).or_insert(r); }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(now: Instant, ms_ago: u64) -> Instant {
        now - Duration::from_millis(ms_ago)
    }

    fn si(now: Instant, ms_ago: u64, bt: u64, ldb: u64, act: Option<&'static str>) -> StatusInputs<'static> {
        StatusInputs { last_byte_at: at(now, ms_ago), bytes_total: bt, last_decision_at_bytes_total: ldb, last_decision_action: act, now }
    }

    #[test]
    fn classify_status_table() {
        let n = Instant::now();
        assert_eq!(classify_status(&si(n, 200, 100, 50, Some("reply"))), TileStatus::Working);
        assert_eq!(classify_status(&si(n, 5_000, 200, 200, Some("escalate"))), TileStatus::Blocked);
        assert_eq!(classify_status(&si(n, 3_000, 500, 200, Some("reply"))), TileStatus::AwaitingInput);
        assert_eq!(classify_status(&si(n, 10_000, 100, 100, None)), TileStatus::Idle);
    }

    #[test]
    fn decide_status_thinking_overrides_classifier() {
        let n = Instant::now();
        // Working-shaped inputs: bytes just arrived. Without the
        // override the classifier returns Working.
        let working = si(n, 200, 100, 50, Some("reply"));
        assert_eq!(decide_status(false, &working), TileStatus::Working);
        assert_eq!(decide_status(true, &working), TileStatus::OperatorThinking);

        // Idle-shaped inputs: long since any bytes, no decision.
        let idle = si(n, 10_000, 100, 100, None);
        assert_eq!(decide_status(false, &idle), TileStatus::Idle);
        assert_eq!(decide_status(true, &idle), TileStatus::OperatorThinking);

        // Blocked-shaped inputs: the override still wins while the
        // operator is thinking — the next decision may unblock it.
        let blocked = si(n, 5_000, 200, 200, Some("escalate"));
        assert_eq!(decide_status(false, &blocked), TileStatus::Blocked);
        assert_eq!(decide_status(true, &blocked), TileStatus::OperatorThinking);
    }

    #[test]
    fn last_non_empty_line_behavior() {
        assert_eq!(last_non_empty_line(b"foo\n\x1b[31mbar\x1b[0m\n   \n", 200).as_deref(), Some("bar"));
        assert_eq!(last_non_empty_line(b"hello world this is a long tail line", 10).as_deref(), Some("hello worl"));
        assert!(last_non_empty_line(b"\n   \n\t\n", 200).is_none());
    }

    #[test]
    fn detect_vendor_table() {
        let cases: &[(Option<&str>, Vendor)] = &[
            (Some("claude"), Vendor::Claude),
            (Some("claude --dangerously-skip-permissions"), Vendor::Claude),
            (Some("claude-code"), Vendor::Claude),
            (Some("copilot --yolo"), Vendor::Copilot),
            (Some("opencode"), Vendor::Opencode),
            (Some("aider --model gpt-4"), Vendor::Aider),
            (Some("codex"), Vendor::Codex),
            (Some("npx aider"), Vendor::Aider),
            (Some("npx @anthropic-ai/claude-code"), Vendor::Claude),
            (Some("vim foo.rs"), Vendor::Unknown),
            (None, Vendor::Unknown),
            (Some(""), Vendor::Unknown),
        ];
        for (i, e) in cases { assert_eq!(detect_vendor(*i), *e, "{:?}", i); }
    }

    #[test]
    fn sum_cost_for_short_window() {
        let r = |s: &str, ts: u64, c: f64| OperatorDecisionRow {
            id: 0, session_id_short: s.into(), timestamp_unix_ms: ts, in_flight_command: None,
            output_excerpt: String::new(), action: "reply".into(), reply_text: None,
            rationale: None, executed: false, mission_path: None, executor_name: None,
            operator_id: None, operator_name: None, cost_usd: c,
            applied_memory_id: None,
        };
        let rows = vec![r("aaaaaa",1000,0.10), r("aaaaaa",2000,0.25), r("aaaaaa",500,0.99), r("bbbbbb",1500,0.50)];
        assert!((sum_cost_for_short(&rows, "aaaaaa", 1000) - 0.35).abs() < 1e-9);
        assert_eq!(sum_cost_for_short(&rows, "zzzzzz", 0), 0.0);
    }

    #[test]
    fn mission_name_from_path_table() {
        assert_eq!(mission_name_from_path(Some("/foo/3.12.md")).as_deref(), Some("3.12"));
        assert_eq!(mission_name_from_path(Some("bar.md")).as_deref(), Some("bar"));
        assert_eq!(mission_name_from_path(Some("noext")).as_deref(), Some("noext"));
        assert_eq!(mission_name_from_path(None), None);
        let long = format!("/x/{}.md", "a".repeat(100));
        let got = mission_name_from_path(Some(&long)).expect("some");
        assert_eq!(got.chars().count(), 40);
        assert!(got.chars().all(|c| c == 'a'));
    }

    fn summary(session: &str, status: TileStatus) -> SessionSummary {
        SessionSummary {
            session_id: session.into(),
            tab_title: format!("tab-{session}"),
            tab_color: None,
            status,
            vendor: Vendor::Unknown,
            raw_command_label: None,
            last_command: None,
            last_output_line: None,
            last_decision_action: None,
            last_decision_rationale: matches!(status, TileStatus::Blocked).then(|| "q?".into()),
            mission_name: None,
            cost_usd: None,
            budget_usd: None,
        }
    }

    fn row(op: &str, op_name: &str, session: &str, status: TileStatus, esc_ms: u64) -> BuiltRow {
        BuiltRow {
            operator_id: op.into(),
            operator_name: op_name.into(),
            operator_avatar: None,
            summary: summary(session, status),
            escalated_at_unix_ms: esc_ms,
        }
    }

    #[test]
    fn roster_groups_same_operator_across_sessions() {
        let snap = assemble_snapshot(vec![
            row("op-frontend", "frontend", "s1", TileStatus::Working, 0),
            row("op-backend",  "backend",  "s2", TileStatus::Idle,    0),
            row("op-frontend", "frontend", "s3", TileStatus::Idle,    0),
        ]);
        assert_eq!(snap.roster.len(), 2);
        let frontend = snap.roster.iter().find(|r| r.operator_id == "op-frontend").unwrap();
        assert_eq!(frontend.sessions.len(), 2);
        assert!(snap.roster.iter().any(|r| r.operator_id == "op-backend"));
    }

    #[test]
    fn roster_sorts_escalating_operators_first() {
        let snap = assemble_snapshot(vec![
            row("op-a", "alpha",   "s1", TileStatus::Working, 0),
            row("op-b", "bravo",   "s2", TileStatus::Blocked, 100),
            row("op-c", "charlie", "s3", TileStatus::Idle,    0),
        ]);
        assert_eq!(snap.roster[0].operator_id, "op-b");
        assert!(snap.roster[0].has_escalation);
        assert_eq!(snap.roster[1].operator_name, "alpha");
        assert_eq!(snap.roster[2].operator_name, "charlie");
    }

    #[test]
    fn escalations_are_oldest_first() {
        let snap = assemble_snapshot(vec![
            row("op-a", "alpha", "s-new", TileStatus::Blocked, 500),
            row("op-b", "bravo", "s-old", TileStatus::Blocked, 100),
            row("op-c", "char",  "s-mid", TileStatus::Blocked, 300),
        ]);
        let order: Vec<_> = snap.escalations.iter().map(|e| e.session_id.as_str()).collect();
        assert_eq!(order, vec!["s-old", "s-mid", "s-new"]);
    }

    #[test]
    fn escalations_only_include_blocked_status() {
        let snap = assemble_snapshot(vec![
            row("op-a", "alpha", "s1", TileStatus::Working, 0),
            row("op-b", "bravo", "s2", TileStatus::Blocked, 100),
            row("op-c", "char",  "s3", TileStatus::AwaitingInput, 200),
        ]);
        assert_eq!(snap.escalations.len(), 1);
        assert_eq!(snap.escalations[0].session_id, "s2");
    }

    #[test]
    fn vendor_wired_from_decision_command() {
        for (cmd, want_v, want_label) in [
            (Some("claude --dangerously-skip-permissions x"), Vendor::Claude, None),
            (Some("vim foo.rs"), Vendor::Unknown, Some("vim foo.rs".to_string())),
        ] {
            let v = detect_vendor(cmd);
            let label = matches!(v, Vendor::Unknown).then(|| cmd.map(|c| c.chars().take(40).collect::<String>())).flatten();
            assert_eq!((v, label), (want_v, want_label));
        }
    }
}
