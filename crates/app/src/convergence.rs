//! Convergence Mode (spec 3.8) — read-only aggregator that builds one
//! tile per open session for the ⌘⇧O overlay. NO schema changes; pulls
//! from existing AppState handles only.

use karl_session::ExecutorPhase;
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
pub enum Vendor {
    Claude,
    Copilot,
    Opencode,
    Aider,
    Codex,
    Unknown,
}

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
        head = s
            .trim_start_matches("npx")
            .trim_start()
            .split_whitespace()
            .next()
            .unwrap_or("");
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

/// Which lane produced an agent card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Lane {
    Pty,
    Acp,
}

/// Phase→status mapping for operator-less agent sessions (spec P1 table).
/// Thinking is `Working` — `OperatorThinking` stays operator-only.
pub fn phase_to_status(p: &ExecutorPhase) -> TileStatus {
    match p {
        ExecutorPhase::Thinking
        | ExecutorPhase::Running { .. }
        | ExecutorPhase::Writing { .. }
        | ExecutorPhase::Reading { .. } => TileStatus::Working,
        ExecutorPhase::Waiting { .. } => TileStatus::Blocked,
        ExecutorPhase::Done { .. } => TileStatus::AwaitingInput,
        ExecutorPhase::Idle => TileStatus::Idle,
    }
}

/// Human line under the card title ("writing overlay.ts").
pub fn phase_label(p: &ExecutorPhase) -> Option<String> {
    match p {
        ExecutorPhase::Idle => None,
        ExecutorPhase::Thinking => Some("thinking".into()),
        ExecutorPhase::Running { cmd } => Some(format!("running {cmd}")),
        ExecutorPhase::Writing { file } => Some(format!("writing {file}")),
        ExecutorPhase::Reading { file } => Some(format!("reading {file}")),
        ExecutorPhase::Waiting { reason } => Some(format!("waiting: {reason}")),
        ExecutorPhase::Done { summary } => summary.clone().or_else(|| Some("done".into())),
    }
}

/// Derive the displayed mission name from a stored `mission_path`.
/// Strips `.md` (via `Path::file_stem`) and truncates to 40 chars.
pub fn mission_name_from_path(path: Option<&str>) -> Option<String> {
    let p = path?;
    let stem = std::path::Path::new(p)
        .file_stem()?
        .to_string_lossy()
        .to_string();
    if stem.is_empty() {
        return None;
    }
    Some(stem.chars().take(40).collect())
}

/// One selectable answer on a pending ACP permission prompt.
#[derive(Debug, Clone, Serialize)]
pub struct PermissionChoice {
    pub option_id: String,
    /// "allow_once" | "allow_always" | "reject_once" (open set).
    pub kind: String,
    pub name: Option<String>,
}

/// The permission prompt an ACP tab is currently blocked on, recorded by
/// the forwarder so Convergence can answer it inline.
#[derive(Debug, Clone, Serialize)]
pub struct PendingAcpPermission {
    pub request_key: String,
    /// Human line: tool title, else rawInput.command, else kind.
    pub title: String,
    pub options: Vec<PermissionChoice>,
    pub since_unix_ms: u64,
}

/// One live sub-agent under an ACP session — a Task tool call the
/// executor spawned. One level only; rows vanish at turn end.
#[derive(Debug, Clone, Serialize)]
pub struct SubAgentRow {
    /// tool_call_id
    pub id: String,
    /// rawInput.description ?? title ?? "subagent"
    pub label: String,
    /// rawInput.subagent_type
    pub detail: Option<String>,
    pub running: bool,
    pub started_unix_ms: u64,
}

/// One Convergence card — an agent session from any lane. The operator,
/// when present, is a badge on the card, not its grouping key.
#[derive(Debug, Clone, Serialize)]
pub struct AgentCard {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub lane: Lane,
    /// NotchHub foreground agent / ACP executor ("claude", "codex", …).
    pub executor: Option<String>,
    pub status: TileStatus,
    pub phase_label: Option<String>,
    pub cwd: Option<String>,
    pub vendor: Vendor,
    pub raw_command_label: Option<String>,
    pub last_command: Option<String>,
    pub last_output_line: Option<String>,
    /// The detail pane's tail, secret-masked. PTY lanes: last ~15 lines
    /// of the vt100 screen render; ACP lane: last chat turns. None when
    /// there's nothing to show yet.
    pub excerpt: Option<String>,
    pub mission_name: Option<String>,
    /// Operator badge — all None when no operator is enabled on the tab.
    pub operator_id: Option<String>,
    pub operator_name: Option<String>,
    pub operator_avatar: Option<String>,
    pub cost_usd: Option<f64>,
    pub budget_usd: Option<f64>,
    /// Wall-clock session start, decoded from the session id's Ulid
    /// timestamp — no extra plumbing. None when the id isn't a Ulid.
    pub started_at_unix_ms: Option<u64>,
    /// Live sub-agents (ACP lane only; empty elsewhere).
    pub subagents: Vec<SubAgentRow>,
}

/// Session start from the Ulid-encoded creation time of the session id.
fn started_ms_from_id(id: &str) -> Option<u64> {
    id.parse::<karl_session::SessionId>()
        .ok()
        .map(|s| s.0.timestamp_ms())
}

/// What kind of blocked signal an attention item carries. Determines the
/// inline affordance: option buttons (acp-permission), PTY reply
/// (pty-waiting), or the scoped operator composer (operator-escalation).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttentionKind {
    AcpPermission,
    PtyWaiting,
    OperatorEscalation,
}

/// One row of the "needs you" queue — a session blocked on the human,
/// from any lane, answerable inline.
#[derive(Debug, Clone, Serialize)]
pub struct AttentionItem {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub lane: Lane,
    pub executor: Option<String>,
    pub kind: AttentionKind,
    /// What's being asked: operator question / permission title /
    /// waiting reason.
    pub question: Option<String>,
    /// ACP only: the pending permission (options answer inline).
    pub permission: Option<PendingAcpPermission>,
    pub operator_name: Option<String>,
    pub operator_avatar: Option<String>,
    pub mission_name: Option<String>,
    /// None when the lane keeps no wall-clock for the blocked moment
    /// (PTY waiting) — those sort after timestamped items.
    pub since_unix_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvergenceSnapshot {
    pub agents: Vec<AgentCard>,
    pub attention: Vec<AttentionItem>,
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
    let bytes_since_last_decision = inp
        .bytes_total
        .saturating_sub(inp.last_decision_at_bytes_total);
    // `error` (a failed model call) blocks too, and deliberately so: the
    // executor is still waiting on whatever it asked, and the operator is
    // in no position to answer it. It is not an escalation for counting
    // purposes, but it absolutely needs a human — going Idle here would
    // hide a dead operator behind a quiet tab.
    // ponytail: shares Blocked with escalate; split into its own
    // OperatorDown tile state if the two need different affordances.
    if matches!(inp.last_decision_action, Some("escalate") | Some("error"))
        && bytes_since_last_decision == 0
    {
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
    let line = s.lines().rev().find(|l| !l.trim().is_empty())?.to_string();
    Some(line.chars().take(max_chars).collect())
}

/// Last `max_lines` non-empty lines of already-plain text.
fn last_lines_of_str(s: &str, max_lines: usize, max_chars_per_line: usize) -> Option<String> {
    let mut tail: Vec<String> = s
        .lines()
        .rev()
        .filter(|l| !l.trim().is_empty())
        .take(max_lines)
        .map(|l| l.chars().take(max_chars_per_line).collect::<String>())
        .collect();
    if tail.is_empty() {
        return None;
    }
    tail.reverse();
    Some(tail.join("\n"))
}

/// The detail pane's tail for a PTY session. Prefer the tidied vt100
/// screen render (cell-grid text) — linearly stripping a TUI's byte
/// stream scrambles words and leaves control residue — and fall back to
/// the stripped raw tail only when the screen is blank (e.g. just
/// spawned). Always secret-masked.
///
/// Chrome is normalized BEFORE the last-15 cut: the composer frame and its
/// status footer are the last thing on a Claude Code screen, so trimming
/// after the cut would spend the whole pane on them (the "raw PTY dump"
/// the detail pane used to show).
fn pty_excerpt(screen: Option<&str>, tail_bytes: &[u8]) -> Option<String> {
    let clean = |s: &str| crate::operator::normalize_executor_chrome(s);
    screen
        .and_then(|s| last_lines_of_str(&clean(s), 15, 200))
        .or_else(|| {
            let raw = strip_ansi_escapes::strip(tail_bytes);
            last_lines_of_str(&clean(&String::from_utf8_lossy(&raw)), 15, 200)
        })
        .map(|e| crate::safety::mask_secrets(&e))
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
    /// Live display phase from `NotchHub::phase_snapshot`. `None` when the
    /// session isn't registered there.
    pub notch_phase: Option<ExecutorPhase>,
    /// Foreground agent name from NotchHub ("claude", …). `None` at a
    /// plain shell prompt — the operator-less gate for this lane.
    pub notch_agent: Option<String>,
    /// Tidied headless vt100 screen render at snapshot time (plain text,
    /// no escapes). `None` when blank/not yet rendered — the excerpt then
    /// falls back to stripping the raw byte tail.
    pub screen: Option<String>,
}

/// Per-ACP-tab inputs (from `AcpRegistry` + NotchHub + tab hints).
pub struct AcpSessionInput {
    pub session_id: SessionId,
    pub executor: String,
    pub cwd: Option<String>,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub notch_phase: Option<ExecutorPhase>,
    pub operator_id: Option<String>,
    pub operator_name: Option<String>,
    pub operator_avatar: Option<String>,
    /// The permission prompt this tab is blocked on, if any.
    pub pending: Option<PendingAcpPermission>,
    /// Live sub-agents recorded on the tab (Task tool calls).
    pub subagents: Vec<SubAgentRow>,
    /// Last chat turns from the ACP world model (role-labeled plain
    /// text). None when the conversation is empty.
    pub excerpt: Option<String>,
}

/// Card for an operator-less PTY session. `None` unless NotchHub sees a
/// foreground agent (plain shells stay out of Convergence).
pub fn pty_agent_card(
    session_id: &str,
    tab_title: &str,
    tab_color: Option<String>,
    notch_agent: Option<String>,
    notch_phase: Option<ExecutorPhase>,
) -> Option<AgentCard> {
    let agent = notch_agent?;
    let phase = notch_phase.unwrap_or(ExecutorPhase::Idle);
    Some(AgentCard {
        session_id: session_id.into(),
        tab_title: tab_title.into(),
        tab_color,
        lane: Lane::Pty,
        executor: Some(agent),
        status: phase_to_status(&phase),
        phase_label: phase_label(&phase),
        cwd: None,
        vendor: Vendor::Unknown,
        raw_command_label: None,
        last_command: None,
        last_output_line: None,
        excerpt: None,
        mission_name: None,
        operator_id: None,
        operator_name: None,
        operator_avatar: None,
        cost_usd: None,
        budget_usd: None,
        started_at_unix_ms: started_ms_from_id(session_id),
        subagents: Vec::new(),
    })
}

/// Card for an ACP chat tab. Always present — an open ACP tab IS an agent
/// session even between turns (phase defaults to Idle).
pub fn acp_agent_card(inp: AcpSessionInput) -> AgentCard {
    let phase = inp.notch_phase.unwrap_or(ExecutorPhase::Idle);
    AgentCard {
        session_id: inp.session_id.to_string(),
        tab_title: inp.tab_title,
        tab_color: inp.tab_color,
        lane: Lane::Acp,
        executor: Some(inp.executor),
        status: phase_to_status(&phase),
        phase_label: phase_label(&phase),
        cwd: inp.cwd,
        vendor: Vendor::Unknown,
        raw_command_label: None,
        last_command: None,
        last_output_line: None,
        excerpt: inp.excerpt.map(|e| crate::safety::mask_secrets(&e)),
        mission_name: None,
        operator_id: inp.operator_id,
        operator_name: inp.operator_name,
        operator_avatar: inp.operator_avatar,
        cost_usd: None,
        budget_usd: None,
        started_at_unix_ms: Some(inp.session_id.0.timestamp_ms()),
        subagents: inp.subagents,
    }
}

/// Operator-lane row produced by the first pass of
/// `build_convergence_snapshot`. Exposed so `assemble_snapshot` can be
/// unit-tested without async I/O.
pub struct BuiltRow {
    pub card: AgentCard,
    pub escalated_at_unix_ms: u64,
    /// Operator's open question (decision escalation/rationale) — feeds
    /// EscalationCard.question; not carried on the card itself.
    pub question: Option<String>,
}

/// Agent-lane card plus attention carriers that don't belong on the wire
/// card (the pending permission feeds the queue, not the grid).
pub struct AgentCardInput {
    pub card: AgentCard,
    pub permission_for_attention: Option<PendingAcpPermission>,
}

fn attention_from(item_base: &AgentCard) -> AttentionItem {
    AttentionItem {
        session_id: item_base.session_id.clone(),
        tab_title: item_base.tab_title.clone(),
        tab_color: item_base.tab_color.clone(),
        lane: item_base.lane,
        executor: item_base.executor.clone(),
        kind: AttentionKind::PtyWaiting, // caller overrides
        question: None,
        permission: None,
        operator_name: item_base.operator_name.clone(),
        operator_avatar: item_base.operator_avatar.clone(),
        mission_name: item_base.mission_name.clone(),
        since_unix_ms: None,
    }
}

/// Pure second pass: one unified attention queue (blocked sessions from
/// every lane, timestamped items oldest-first, timestamp-less last) plus
/// one flat card list. Grid sorting is the frontend's job.
pub fn assemble_snapshot(
    op_rows: Vec<BuiltRow>,
    agent_inputs: Vec<AgentCardInput>,
) -> ConvergenceSnapshot {
    let mut attention: Vec<AttentionItem> = Vec::new();

    for b in &op_rows {
        if !matches!(b.card.status, TileStatus::Blocked) {
            continue;
        }
        let mut item = attention_from(&b.card);
        item.kind = AttentionKind::OperatorEscalation;
        item.question = b.question.clone();
        item.since_unix_ms = Some(b.escalated_at_unix_ms);
        attention.push(item);
    }

    for a in &agent_inputs {
        if !matches!(a.card.status, TileStatus::Blocked) {
            continue;
        }
        let mut item = attention_from(&a.card);
        match &a.permission_for_attention {
            Some(p) => {
                item.kind = AttentionKind::AcpPermission;
                item.question = Some(p.title.clone());
                item.since_unix_ms = Some(p.since_unix_ms);
                item.permission = Some(p.clone());
            }
            None => {
                item.kind = AttentionKind::PtyWaiting;
                item.question = a.card.phase_label.clone();
            }
        }
        attention.push(item);
    }

    attention.sort_by(|a, b| {
        let key = |i: &AttentionItem| {
            (
                i.since_unix_ms.is_none(),
                i.since_unix_ms.unwrap_or(u64::MAX),
                i.session_id.clone(),
            )
        };
        key(a).cmp(&key(b))
    });

    let mut agents: Vec<AgentCard> = op_rows.into_iter().map(|b| b.card).collect();
    agents.extend(agent_inputs.into_iter().map(|a| a.card));
    ConvergenceSnapshot { agents, attention }
}

/// Lock a `std::sync::Mutex`, recovering from poisoning instead of
/// panicking. A panic elsewhere while holding `op_state` must not
/// permanently brick the snapshot (which blanks the whole overlay). See
/// spec 2026-06-06 §8.
fn lock_recover<T>(m: &StdMutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|p| p.into_inner())
}

pub async fn build_convergence_snapshot(
    sessions: Vec<SessionInput>,
    acp_sessions: Vec<AcpSessionInput>,
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
    let mut agent_inputs: Vec<AgentCardInput> = Vec::new();
    for s in sessions {
        let Some(op_id) = s.operator_id else {
            // Operator-less PTY session: a card iff NotchHub sees a
            // foreground agent (plain shells stay out).
            if let Some(c) = pty_agent_card(
                &s.session_id.to_string(),
                &s.tab_title,
                s.tab_color.clone(),
                s.notch_agent.clone(),
                s.notch_phase.clone(),
            ) {
                let mut c = c;
                c.excerpt = {
                    let tail = lock_recover(&s.op_state).snapshot_tail(8 * 1024);
                    pty_excerpt(s.screen.as_deref(), &tail)
                };
                agent_inputs.push(AgentCardInput {
                    card: c,
                    permission_for_attention: None,
                });
            }
            continue;
        };
        let op_name = s.operator_name.clone().unwrap_or_default();
        let op_avatar = s.operator_avatar.clone();

        let id_str = s.session_id.to_string();
        let short = shorten6(&id_str);

        let (last_byte_at, bytes_total, last_decision_at_bytes_total, tail_bytes) = {
            let st = lock_recover(&s.op_state);
            (
                st.last_byte_at,
                st.bytes_total,
                st.last_decision_at_bytes_total,
                st.snapshot_tail(8 * 1024),
            )
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
            &StatusInputs {
                last_byte_at,
                bytes_total,
                last_decision_at_bytes_total,
                last_decision_action: last_action,
                now,
            },
        );

        let op_enabled = operator.is_enabled(s.session_id).await;
        let aom_excluded = operator.is_aom_excluded(s.session_id).await;
        let enrolled = aom_enabled && op_enabled && !aom_excluded;
        let cost_usd = if enrolled {
            Some(sum_cost_for_short(&recent, &short, aom_started_ms))
        } else {
            None
        };

        let card = AgentCard {
            session_id: id_str,
            tab_title: s.tab_title,
            tab_color: s.tab_color,
            lane: Lane::Pty,
            executor: s.notch_agent,
            status,
            phase_label: s.notch_phase.as_ref().and_then(phase_label),
            cwd: None,
            vendor,
            raw_command_label,
            last_command: last.and_then(|d| d.in_flight_command.clone()),
            last_output_line: last_non_empty_line(&tail_bytes, 160),
            excerpt: pty_excerpt(s.screen.as_deref(), &tail_bytes),
            mission_name: mission_name_from_path(last.and_then(|d| d.mission_path.as_deref())),
            operator_id: Some(op_id),
            operator_name: Some(op_name),
            operator_avatar: op_avatar,
            cost_usd,
            budget_usd: if enrolled { Some(aom_budget) } else { None },
            started_at_unix_ms: Some(s.session_id.0.timestamp_ms()),
            subagents: Vec::new(),
        };

        built.push(BuiltRow {
            escalated_at_unix_ms: last.map(|d| d.timestamp_unix_ms).unwrap_or(0),
            question: last.and_then(decision_question),
            card,
        });
    }

    agent_inputs.extend(acp_sessions.into_iter().map(|mut inp| {
        let pending = inp.pending.take();
        let mut card = acp_agent_card(inp);
        // A recorded pending permission IS blocked, even if the notch
        // phase hasn't caught up (or flapped) — card and queue must agree.
        if pending.is_some() && !matches!(card.status, TileStatus::Blocked) {
            card.status = TileStatus::Blocked;
        }
        AgentCardInput {
            card,
            permission_for_attention: pending,
        }
    }));
    assemble_snapshot(built, agent_inputs)
}

fn shorten6(id: &str) -> String {
    let n = id.len();
    if n > 6 {
        id[n - 6..].to_string()
    } else {
        id.to_string()
    }
}

fn sum_cost_for_short(rows: &[OperatorDecisionRow], short: &str, since_ms: u64) -> f64 {
    rows.iter()
        .filter(|r| r.session_id_short == short && r.timestamp_unix_ms >= since_ms)
        .map(|r| r.cost_usd)
        .sum()
}

/// The operator's open question for a decision row, for Convergence's
/// escalation list. Prefers `escalation`, falls back to `rationale`.
///
/// Under mind_v2 the turn schema carries no separate rationale for an
/// escalation — the mapping in `operator.rs` stores `String::new()` — so
/// the question lives in `escalation` alone. Reading `rationale` first
/// left the "open question" blank on every v2 escalation (95 of 95 in a
/// real profile's most recent month). Empty/whitespace in either column
/// is treated as absent rather than rendered as a blank question.
fn decision_question(d: &OperatorDecisionRow) -> Option<String> {
    let pick = |s: &Option<String>| s.clone().filter(|v| !v.trim().is_empty());
    pick(&d.escalation).or_else(|| pick(&d.rationale))
}

fn index_decisions_by_short_id(
    rows: &[OperatorDecisionRow],
) -> HashMap<&str, &OperatorDecisionRow> {
    let mut out = HashMap::new();
    for r in rows {
        out.entry(r.session_id_short.as_str()).or_insert(r);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(now: Instant, ms_ago: u64) -> Instant {
        now - Duration::from_millis(ms_ago)
    }

    fn si(
        now: Instant,
        ms_ago: u64,
        bt: u64,
        ldb: u64,
        act: Option<&'static str>,
    ) -> StatusInputs<'static> {
        StatusInputs {
            last_byte_at: at(now, ms_ago),
            bytes_total: bt,
            last_decision_at_bytes_total: ldb,
            last_decision_action: act,
            now,
        }
    }

    #[test]
    fn classify_status_table() {
        let n = Instant::now();
        assert_eq!(
            classify_status(&si(n, 200, 100, 50, Some("reply"))),
            TileStatus::Working
        );
        assert_eq!(
            classify_status(&si(n, 5_000, 200, 200, Some("escalate"))),
            TileStatus::Blocked
        );
        assert_eq!(
            classify_status(&si(n, 3_000, 500, 200, Some("reply"))),
            TileStatus::AwaitingInput
        );
        assert_eq!(
            classify_status(&si(n, 10_000, 100, 100, None)),
            TileStatus::Idle
        );
    }

    #[test]
    fn api_error_still_blocks_the_tile() {
        // A failed model call must NOT read as a quiet, healthy tab.
        // The executor is still waiting on its question and the operator
        // cannot answer — the one state that must stay visible.
        let n = Instant::now();
        assert_eq!(
            classify_status(&si(n, 5_000, 200, 200, Some("error"))),
            TileStatus::Blocked
        );
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
        assert_eq!(
            last_non_empty_line(b"foo\n\x1b[31mbar\x1b[0m\n   \n", 200).as_deref(),
            Some("bar")
        );
        assert_eq!(
            last_non_empty_line(b"hello world this is a long tail line", 10).as_deref(),
            Some("hello worl")
        );
        assert!(last_non_empty_line(b"\n   \n\t\n", 200).is_none());
    }

    #[test]
    fn pty_excerpt_prefers_screen_render_over_raw_tail() {
        // A TUI's linear byte stream strips into scrambled words — the
        // tidied vt100 screen render must win whenever it has content.
        let screen = "line one\nline two\n";
        let tail = b"\x1b[2Kraw\x1b[0mstream";
        assert_eq!(
            pty_excerpt(Some(screen), tail).as_deref(),
            Some("line one\nline two")
        );
        // Blank or absent screen falls back to the stripped byte tail.
        assert_eq!(
            pty_excerpt(Some("   \n"), tail).as_deref(),
            Some("rawstream")
        );
        assert_eq!(pty_excerpt(None, tail).as_deref(), Some("rawstream"));
        assert!(pty_excerpt(None, b"").is_none());
    }

    #[test]
    fn pty_excerpt_drops_the_composer_frame_and_status_footer() {
        // The bottom of a live Claude Code screen. Everything below the
        // agent's last real line is chrome; without normalizing BEFORE
        // the last-15 cut it ate most of the detail pane.
        let screen = "\
groowcity-frontend → write (verified)\n\
✱ Cooking… (1m 19s)\n\
────────────────────────────────\n\
❯ desarchiva groowcity-frontend-newui\n\
────────────────────────────────\n\
  ~/Sources/groowcity [agent/repo-access] Opus 5 (1M context) ctx:5%\n\
  ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
        let e = pty_excerpt(Some(screen), b"").expect("some excerpt");
        assert!(!e.contains("────"), "composer frame leaked: {e:?}");
        assert!(!e.contains("ctx:5%"), "status footer leaked: {e:?}");
        assert!(!e.contains("bypass permissions"), "footer leaked: {e:?}");
        assert!(!e.contains("Cooking"), "spinner leaked: {e:?}");
        // Real output and the pending prompt survive.
        assert!(e.contains("groowcity-frontend → write"));
        assert!(e.contains("desarchiva groowcity-frontend-newui"));
    }

    #[test]
    fn pty_excerpt_masks_secrets_from_the_screen_render_too() {
        let screen = "token=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA suffix\n";
        let e = pty_excerpt(Some(screen), b"").expect("some excerpt");
        assert!(!e.contains("sk-ant-api03"), "secret leaked: {e}");
    }

    #[test]
    fn excerpt_pipeline_masks_secrets_and_keeps_newline_structure() {
        // A leaked API key on the PTY tail must not survive into the
        // card's excerpt.
        let tail =
            b"about to authenticate\ntoken=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA suffix\ndone\n";
        let excerpt = pty_excerpt(None, tail).expect("some excerpt");
        assert!(
            !excerpt.contains("sk-ant-api03"),
            "secret leaked into excerpt: {excerpt}"
        );
        assert!(excerpt.contains("[REDACTED:anthropic]"));
        // Newline structure across the 3 tail lines is preserved.
        assert_eq!(excerpt.lines().count(), 3);
        assert_eq!(excerpt.lines().next(), Some("about to authenticate"));
        assert_eq!(excerpt.lines().last(), Some("done"));
    }

    #[test]
    fn detect_vendor_table() {
        let cases: &[(Option<&str>, Vendor)] = &[
            (Some("claude"), Vendor::Claude),
            (
                Some("claude --dangerously-skip-permissions"),
                Vendor::Claude,
            ),
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
        for (i, e) in cases {
            assert_eq!(detect_vendor(*i), *e, "{:?}", i);
        }
    }

    #[test]
    fn sum_cost_for_short_window() {
        let r = |s: &str, ts: u64, c: f64| OperatorDecisionRow {
            id: 0,
            session_id_short: s.into(),
            timestamp_unix_ms: ts,
            in_flight_command: None,
            output_excerpt: String::new(),
            action: "reply".into(),
            reply_text: None,
            rationale: None,
            executed: false,
            mission_path: None,
            executor_name: None,
            operator_id: None,
            operator_name: None,
            cost_usd: c,
            applied_memory_id: None,
            escalation: None,
        };
        let rows = vec![
            r("aaaaaa", 1000, 0.10),
            r("aaaaaa", 2000, 0.25),
            r("aaaaaa", 500, 0.99),
            r("bbbbbb", 1500, 0.50),
        ];
        assert!((sum_cost_for_short(&rows, "aaaaaa", 1000) - 0.35).abs() < 1e-9);
        assert_eq!(sum_cost_for_short(&rows, "zzzzzz", 0), 0.0);
    }

    #[test]
    fn mission_name_from_path_table() {
        assert_eq!(
            mission_name_from_path(Some("/foo/3.12.md")).as_deref(),
            Some("3.12")
        );
        assert_eq!(
            mission_name_from_path(Some("bar.md")).as_deref(),
            Some("bar")
        );
        assert_eq!(
            mission_name_from_path(Some("noext")).as_deref(),
            Some("noext")
        );
        assert_eq!(mission_name_from_path(None), None);
        let long = format!("/x/{}.md", "a".repeat(100));
        let got = mission_name_from_path(Some(&long)).expect("some");
        assert_eq!(got.chars().count(), 40);
        assert!(got.chars().all(|c| c == 'a'));
    }

    fn card(sid: &str, status: TileStatus, op: Option<&str>) -> AgentCard {
        AgentCard {
            session_id: sid.into(),
            tab_title: format!("tab-{sid}"),
            tab_color: None,
            lane: Lane::Pty,
            executor: Some("claude".into()),
            status,
            phase_label: None,
            cwd: None,
            vendor: Vendor::Claude,
            raw_command_label: None,
            last_command: None,
            last_output_line: None,
            mission_name: None,
            operator_id: op.map(Into::into),
            operator_name: op.map(|o| format!("op-{o}")),
            operator_avatar: None,
            cost_usd: None,
            budget_usd: None,
            started_at_unix_ms: None,
            subagents: Vec::new(),
            excerpt: None,
        }
    }

    #[test]
    fn cards_carry_started_at_from_the_session_ulid() {
        let id = karl_session::SessionId::new();
        let c = pty_agent_card(&id.to_string(), "t", None, Some("claude".into()), None)
            .expect("foreground agent → card");
        assert_eq!(c.started_at_unix_ms, Some(id.0.timestamp_ms()));
        // Non-ulid ids (defensive): no timestamp, no panic.
        let c2 = pty_agent_card("not-a-ulid", "t", None, Some("claude".into()), None)
            .expect("foreground agent → card");
        assert_eq!(c2.started_at_unix_ms, None);
    }

    #[test]
    fn attention_items_carry_no_excerpt_field_the_card_owns_the_tail() {
        // The detail pane reads AgentCard.excerpt; the attention item
        // deliberately has no excerpt of its own (field removed).
        let mut c = card("s1", TileStatus::Blocked, Some("Zeta"));
        c.excerpt = Some("cargo test\nrunning 34/210".into());
        let snap = assemble_snapshot(
            vec![BuiltRow {
                card: c,
                escalated_at_unix_ms: 100,
                question: Some("release?".into()),
            }],
            vec![],
        );
        // The tail still reaches the UI — on the card.
        assert_eq!(
            snap.agents[0].excerpt.as_deref(),
            Some("cargo test\nrunning 34/210")
        );
        assert_eq!(snap.attention.len(), 1);
    }

    #[test]
    fn working_card_keeps_its_excerpt_on_the_wire() {
        let mut c = card("s1", TileStatus::Working, None);
        c.excerpt = Some("$ npm test".into());
        let snap = assemble_snapshot(
            vec![],
            vec![AgentCardInput {
                card: c,
                permission_for_attention: None,
            }],
        );
        assert_eq!(snap.agents[0].excerpt.as_deref(), Some("$ npm test"));
        assert!(snap.attention.is_empty());
    }

    fn op_row(sid: &str, status: TileStatus, op: &str, esc_ms: u64) -> BuiltRow {
        BuiltRow {
            card: card(sid, status, Some(op)),
            escalated_at_unix_ms: esc_ms,
            question: None,
        }
    }

    #[test]
    fn pty_agent_card_requires_foreground_agent() {
        use karl_session::ExecutorPhase as P;
        // plain shell: no foreground agent → no card
        assert!(pty_agent_card("s1", "tab", None, None, Some(P::Idle)).is_none());
        // claude running → card with mapped status + label
        let c = pty_agent_card(
            "s1",
            "tab",
            None,
            Some("claude".into()),
            Some(P::Writing {
                file: "a.rs".into(),
            }),
        )
        .expect("card");
        assert_eq!(c.status, TileStatus::Working);
        assert_eq!(c.phase_label.as_deref(), Some("writing a.rs"));
        assert_eq!(c.executor.as_deref(), Some("claude"));
        assert!(matches!(c.lane, Lane::Pty));
    }

    fn plain_input(card: AgentCard) -> AgentCardInput {
        AgentCardInput {
            card,
            permission_for_attention: None,
        }
    }

    #[test]
    fn assemble_attention_unifies_three_kinds_timestamped_first() {
        // operator escalation @200
        let mut op_card = card("op1", TileStatus::Blocked, Some("o1"));
        op_card.excerpt = Some("tail".into());
        let op = BuiltRow {
            card: op_card,
            escalated_at_unix_ms: 200,
            question: Some("q?".into()),
        };
        // acp permission @100 (older → leads)
        let mut acp_card = card("acp1", TileStatus::Blocked, None);
        acp_card.lane = Lane::Acp;
        let acp = AgentCardInput {
            card: acp_card,
            permission_for_attention: Some(PendingAcpPermission {
                request_key: "k1".into(),
                title: "npm test".into(),
                options: vec![],
                since_unix_ms: 100,
            }),
        };
        // pty waiting, no timestamp → last
        let mut pty_card = card("pty1", TileStatus::Blocked, None);
        pty_card.phase_label = Some("waiting: permission".into());
        pty_card.excerpt = Some("[y/N]".into());
        let pty = AgentCardInput {
            card: pty_card,
            permission_for_attention: None,
        };

        let snap = assemble_snapshot(vec![op], vec![acp, pty]);
        let kinds: Vec<_> = snap
            .attention
            .iter()
            .map(|a| (a.session_id.as_str(), a.kind))
            .collect();
        assert_eq!(
            kinds,
            vec![
                ("acp1", AttentionKind::AcpPermission),
                ("op1", AttentionKind::OperatorEscalation),
                ("pty1", AttentionKind::PtyWaiting),
            ]
        );
        assert_eq!(snap.attention[0].question.as_deref(), Some("npm test"));
        assert!(snap.attention[0].permission.is_some());
        assert_eq!(snap.attention[1].question.as_deref(), Some("q?"));
        assert_eq!(snap.attention[2].since_unix_ms, None);
        assert_eq!(snap.agents.len(), 3); // every attention session keeps its card
    }

    #[test]
    fn assemble_non_blocked_produce_no_attention() {
        let snap = assemble_snapshot(
            vec![op_row("a", TileStatus::Working, "o1", 0)],
            vec![plain_input(card("b", TileStatus::Idle, None))],
        );
        assert!(snap.attention.is_empty());
        assert_eq!(snap.agents.len(), 2);
    }

    #[test]
    fn decision_question_prefers_escalation_over_empty_rationale() {
        let mk = |esc: Option<&str>, rat: Option<&str>| OperatorDecisionRow {
            id: 1,
            session_id_short: "s1".into(),
            timestamp_unix_ms: 0,
            in_flight_command: None,
            output_excerpt: String::new(),
            action: "escalate".into(),
            reply_text: None,
            rationale: rat.map(str::to_string),
            executed: false,
            mission_path: None,
            executor_name: None,
            operator_id: None,
            operator_name: None,
            cost_usd: 0.0,
            applied_memory_id: None,
            escalation: esc.map(str::to_string),
        };
        // The v2 shape: rationale hardcoded empty, question in escalation.
        assert_eq!(
            decision_question(&mk(Some("needs your call on the migration"), Some(""))),
            Some("needs your call on the migration".into())
        );
        // Pre-v2 rows kept the text in rationale only.
        assert_eq!(
            decision_question(&mk(None, Some("legacy rationale"))),
            Some("legacy rationale".into())
        );
        // Both blank → absent, never a blank question in the UI.
        assert_eq!(decision_question(&mk(Some("  "), Some(""))), None);
        assert_eq!(decision_question(&mk(None, None)), None);
    }

    #[test]
    fn phase_to_status_table() {
        use karl_session::ExecutorPhase as P;
        assert_eq!(phase_to_status(&P::Thinking), TileStatus::Working);
        assert_eq!(
            phase_to_status(&P::Running {
                cmd: "cargo test".into()
            }),
            TileStatus::Working
        );
        assert_eq!(
            phase_to_status(&P::Writing {
                file: "a.rs".into()
            }),
            TileStatus::Working
        );
        assert_eq!(
            phase_to_status(&P::Reading {
                file: "a.rs".into()
            }),
            TileStatus::Working
        );
        assert_eq!(
            phase_to_status(&P::Waiting {
                reason: "permission".into()
            }),
            TileStatus::Blocked
        );
        assert_eq!(
            phase_to_status(&P::Done { summary: None }),
            TileStatus::AwaitingInput
        );
        assert_eq!(phase_to_status(&P::Idle), TileStatus::Idle);
    }

    #[test]
    fn phase_label_table() {
        use karl_session::ExecutorPhase as P;
        assert_eq!(phase_label(&P::Idle), None);
        assert_eq!(phase_label(&P::Thinking).as_deref(), Some("thinking"));
        assert_eq!(
            phase_label(&P::Running {
                cmd: "cargo test".into()
            })
            .as_deref(),
            Some("running cargo test")
        );
        assert_eq!(
            phase_label(&P::Writing {
                file: "a.rs".into()
            })
            .as_deref(),
            Some("writing a.rs")
        );
        assert_eq!(
            phase_label(&P::Reading {
                file: "a.rs".into()
            })
            .as_deref(),
            Some("reading a.rs")
        );
        assert_eq!(
            phase_label(&P::Waiting {
                reason: "permission".into()
            })
            .as_deref(),
            Some("waiting: permission")
        );
        assert_eq!(
            phase_label(&P::Done {
                summary: Some("2 files".into())
            })
            .as_deref(),
            Some("2 files")
        );
        assert_eq!(
            phase_label(&P::Done { summary: None }).as_deref(),
            Some("done")
        );
    }

    #[test]
    fn lock_recover_survives_poison() {
        let m = std::sync::Mutex::new(7i32);
        // Poison the mutex: panic while holding the guard.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _g = m.lock().unwrap();
            panic!("poison it");
        }));
        assert!(m.lock().is_err(), "mutex should be poisoned");
        assert_eq!(*lock_recover(&m), 7);
    }

    #[test]
    fn vendor_wired_from_decision_command() {
        for (cmd, want_v, want_label) in [
            (
                Some("claude --dangerously-skip-permissions x"),
                Vendor::Claude,
                None,
            ),
            (
                Some("vim foo.rs"),
                Vendor::Unknown,
                Some("vim foo.rs".to_string()),
            ),
        ] {
            let v = detect_vendor(cmd);
            let label = matches!(v, Vendor::Unknown)
                .then(|| cmd.map(|c| c.chars().take(40).collect::<String>()))
                .flatten();
            assert_eq!((v, label), (want_v, want_label));
        }
    }
}
