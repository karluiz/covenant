//! Group-supervision correlation watcher.
//!
//! `crates/app/src/cross_session.rs`'s architecture, scoped to a single tab
//! group instead of every open session. Subscribes to every session's
//! broadcast bus and wakes on two triggers in a *supervised* group
//! (debounced 1.5s):
//!
//! - **a failure** (`BlockFinished` exit≠0) — asks whether any
//!   cross-session pattern explains it. Needs ≥2 tabs in the group;
//!   a lone failure is the M4 fix-proposer's job.
//! - **an executor turn ending** (`AgentIdleWaiting`) — asks whether what
//!   the agent just reported needs the user. Fires for a group of one,
//!   and carries the tab's RENDERED SCREEN, because an executor tab's
//!   world model is empty: its block never finishes, so the screen is the
//!   only place its report exists.
//!
//! Findings are emitted as a global Tauri event the frontend renders as a
//! toast, attributed to the supervisor by name, de-duplicated against the
//! group's previous finding (an executor idles once per turn, and
//! consecutive turns often read the same).
//!
//! Rate-limited 6 checks/minute globally (mirrors cross_session). Notify
//! only: never writes to any PTY, never awards XP. Deliberate duplication
//! of cross_session.rs over a shared abstraction — the two watchers will
//! diverge (`cross_session` is global-scope, this one is group-scope and
//! carries a supervisor identity into the prompt).

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_session::{SessionEvent, SessionId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::cross_session::{build_snapshot_message, SimpleRate};
use crate::operator_registry::{voice_directive, Operator, OperatorRegistry};
use crate::settings::Settings;
use crate::world::SessionWorldModel;

const DEBOUNCE: Duration = Duration::from_millis(1500);
/// Enough to hold an executor's closing report without pasting a whole
/// scrollback into the prompt.
const SCREEN_TAIL_LINES: usize = 40;
const MAX_CHECKS_PER_MINUTE: usize = 6;
const FINDING_EVENT_NAME: &str = "group-supervision-finding";

const SYSTEM_PROMPT: &str = "\
You watch multiple terminal sessions for an AI super-agent. You will be \
given short summaries and recent block lists from each open session. \
Your job is to flag CROSS-SESSION patterns the user might miss:

- a file edited in one tab while another tab's tests fail on it
- the same error appearing in multiple tabs
- a long-running task in one tab that explains failures in another
- resource conflicts (port already in use, db locked, etc.)

Output EXACTLY ONE of:
  FINDING: <one short sentence the user reads as a notification, ≤140 chars>
or
  FINDING: (none)

Rules:
- Be conservative. False-positives destroy trust. If sessions look \
  independent, output (none).
- Reference tabs by their session number when useful (\"tab 2\").
- No preamble, no markdown, no extra lines.";

/// Why a check ran. The two triggers ask DIFFERENT questions, so they
/// carry different prompts and different session-count floors: a failure
/// is only interesting next to another tab, an executor finishing its
/// turn is interesting on its own.
#[derive(Debug, Clone)]
pub(crate) enum TriggerKind {
    /// A command exited non-zero.
    Failure,
    /// A known executor (claude/codex/pi/…) went quiet waiting on the human.
    Idle { agent: String },
}

const IDLE_SYSTEM_PROMPT: &str = "\
An AI executor running inside one of the terminal tabs you supervise just \
finished its turn and is waiting on the user. You are given each tab's \
recent state, including the rendered screen of the tab that went idle — \
that screen is where the executor's report lives.

Output EXACTLY ONE of:
  FINDING: <one short sentence the user reads as a notification, ≤140 chars>
or
  FINDING: (none)

Flag ONLY things the user has to act on or would regret missing:
- work finished that now needs a decision (review, merge, next wave)
- the executor is BLOCKED or asking a question
- it reported a failure, a skipped step, or something it could not verify
- it contradicts or duplicates what another supervised tab is doing

Rules:
- Say WHAT happened, not that something happened. \"canon wave 3 committed, \
  wave 4 (03/08/11/14) still open\" — not \"the agent finished a task\".
- Be conservative. A routine turn with nothing to decide is (none). \
  False-positives destroy trust.
- No preamble, no markdown, no extra lines.";

/// Payload emitted to the frontend when a finding lands. Plain JSON.
/// Attributed: the FE prefixes the toast message with `operator_name` so
/// every finding arrives signed by the supervisor that made it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GroupSupervisionFinding {
    pub group_id: String,
    pub operator_id: String,
    pub operator_name: String,
    pub message: String,
    pub timestamp_unix_ms: u64,
}

/// Public handle. Hand one to `lib.rs`'s setup() and call `attach()`
/// from inside `spawn_session` for every new session.
#[derive(Clone)]
pub struct GroupSupervisionWatcher {
    inner: Arc<Mutex<Inner>>,
    incoming_tx: mpsc::UnboundedSender<(SessionId, SessionEvent)>,
}

struct Inner {
    /// Live world models. Updated via Arc — the watcher just reads them
    /// when building context. Removed when the corresponding session's
    /// bus closes.
    worlds: HashMap<SessionId, Arc<Mutex<SessionWorldModel>>>,
    /// Last finding emitted per group. An executor idles once per turn,
    /// and consecutive turns often look identical to the model — without
    /// this the same sentence toasts over and over.
    last_finding: HashMap<String, String>,
}

impl GroupSupervisionWatcher {
    pub fn spawn(
        app: AppHandle,
        settings: Arc<Mutex<Settings>>,
        registry: Arc<OperatorRegistry>,
        vitals: crate::vitals::VitalsHandle,
    ) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            worlds: HashMap::new(),
            last_finding: HashMap::new(),
        }));
        let (incoming_tx, incoming_rx) = mpsc::unbounded_channel();

        // tauri::async_runtime::spawn (vs tokio::spawn) is required
        // here: this runs inside the Builder::setup callback, BEFORE
        // Tauri has handed control to its async runtime, so a raw
        // tokio::spawn panics with "no reactor running".
        tauri::async_runtime::spawn(watch_loop(
            inner.clone(),
            settings,
            app,
            registry,
            incoming_rx,
            vitals,
        ));

        Self { inner, incoming_tx }
    }

    /// Wire a freshly-spawned session into the watcher: store its world
    /// model and start forwarding bus events to the central pump.
    pub async fn attach(
        &self,
        session_id: SessionId,
        world: Arc<Mutex<SessionWorldModel>>,
        mut bus: broadcast::Receiver<SessionEvent>,
    ) {
        self.inner.lock().await.worlds.insert(session_id, world);

        let tx = self.incoming_tx.clone();
        let inner_for_drop = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            loop {
                match bus.recv().await {
                    Ok(event) => {
                        if tx.send((session_id, event)).is_err() {
                            break;
                        }
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(
                            session = %session_id,
                            skipped = n,
                            "group-supervision forwarder lagged"
                        );
                    }
                }
            }
            inner_for_drop.lock().await.worlds.remove(&session_id);
            tracing::debug!(session = %session_id, "group-supervision forwarder exited");
        });
    }
}

/// The (group_id, supervisor) this failure belongs to, or None when the
/// session is ungrouped / the group unsupervised / the operator lost the
/// capability. Pure — unit-testable without the watcher. Delegates to
/// `OperatorRegistry::supervised_pair`, which derives the pair from a
/// SINGLE `session_group` read — a group move can never pair a stale
/// group_id with a different group's supervisor.
pub(crate) fn supervised_group_for(
    registry: &OperatorRegistry,
    session_id: SessionId,
) -> Option<(String, Operator)> {
    registry.supervised_pair(session_id)
}

/// Which events wake the supervisor. A zero exit is not news, and an
/// executor going idle IS a turn boundary — `idle::Detector` fires one
/// edge per turn, so this never degrades into polling.
pub(crate) fn trigger_kind(event: &SessionEvent) -> Option<TriggerKind> {
    match event {
        SessionEvent::BlockFinished {
            exit_code: Some(code),
            ..
        } if *code != 0 => Some(TriggerKind::Failure),
        SessionEvent::AgentIdleWaiting { agent, .. } => Some(TriggerKind::Idle {
            agent: agent.clone(),
        }),
        _ => None,
    }
}

async fn watch_loop(
    inner: Arc<Mutex<Inner>>,
    settings: Arc<Mutex<Settings>>,
    app: AppHandle,
    registry: Arc<OperatorRegistry>,
    mut incoming_rx: mpsc::UnboundedReceiver<(SessionId, SessionEvent)>,
    vitals: crate::vitals::VitalsHandle,
) {
    // Deliberately does NOT carry `group_id` (or the `Operator`) across the
    // debounce window — only `Instant` + `SessionId`. The trigger-time gate
    // below only decides WHETHER to schedule a check; `check_for_pattern`
    // re-derives `(group_id, op)` atomically at check time via
    // `supervised_group_for`, so a session that moves to a *different*
    // supervised group mid-debounce can never have its old group_id paired
    // with its new supervisor (or vice versa).
    let mut pending: Option<(Instant, SessionId, TriggerKind)> = None;
    let mut rate = SimpleRate::new(MAX_CHECKS_PER_MINUTE, Duration::from_secs(60));

    loop {
        tokio::select! {
            biased;

            event = incoming_rx.recv() => {
                let Some((session_id, event)) = event else { return };
                if let Some(kind) = trigger_kind(&event) {
                    if supervised_group_for(&registry, session_id).is_some() {
                        pending = Some((Instant::now(), session_id, kind));
                    }
                }
            }

            _ = wait_until_debounce(pending.as_ref().map(|(t, _, _)| *t)) => {
                let trigger = pending.take();
                if !rate.try_acquire() {
                    tracing::debug!("group-supervision rate-limited");
                    continue;
                }
                if let Some((_, trigger_id, kind)) = trigger {
                    if let Err(e) =
                        check_for_pattern(&inner, &settings, &app, &registry, trigger_id, kind, &vitals).await
                    {
                        tracing::warn!(error = %e, "group-supervision check failed");
                    }
                }
            }
        }
    }
}

async fn wait_until_debounce(last: Option<Instant>) {
    match last {
        Some(t) => {
            let elapsed = t.elapsed();
            if elapsed < DEBOUNCE {
                tokio::time::sleep(DEBOUNCE - elapsed).await;
            }
        }
        None => std::future::pending::<()>().await,
    }
}

async fn check_for_pattern(
    inner: &Arc<Mutex<Inner>>,
    settings: &Arc<Mutex<Settings>>,
    app: &AppHandle,
    registry: &Arc<OperatorRegistry>,
    trigger_id: SessionId,
    kind: TriggerKind,
    vitals: &crate::vitals::VitalsHandle,
) -> Result<(), String> {
    // Re-derive (group_id, supervisor) TOGETHER at check time, not at
    // trigger time — `supervised_group_for` returns them as one atomic
    // pair, so a session that moved to a different supervised group (or
    // lost supervision entirely) during the debounce window can never
    // pair a stale group_id with a fresh operator or vice versa.
    let Some((group_id, op)) = supervised_group_for(registry, trigger_id) else {
        tracing::debug!(session = %trigger_id, "group-supervision: supervisor gone, skipping");
        return Ok(());
    };
    let group_id = group_id.as_str();

    // Snapshot state without holding any lock across the http call.
    let resolved = {
        let s = settings.lock().await;
        match crate::provider_resolve::resolve_route(&s, crate::settings::Role::Chat) {
            Ok(r) => r,
            Err(_) => return Ok(()),
        }
    };

    // A failure needs at least 2 sessions IN THIS GROUP to be a *pattern*
    // — single-session failures are the M4 fix-proposer's job (same rule
    // as cross_session). An executor finishing its turn is worth a word on
    // its own, so idle triggers accept a group of one.
    let min_sessions = match kind {
        TriggerKind::Failure => 2,
        TriggerKind::Idle { .. } => 1,
    };
    let members = registry.group_sessions(group_id);

    let snapshots = {
        let i = inner.lock().await;
        let mut entries: Vec<(SessionId, Arc<Mutex<SessionWorldModel>>)> = members
            .iter()
            .filter_map(|sid| i.worlds.get(sid).map(|w| (*sid, w.clone())))
            .collect();
        if entries.len() < min_sessions {
            tracing::debug!(
                group = %group_id,
                sessions = entries.len(),
                "skipping group-supervision check"
            );
            return Ok(());
        }
        // Sort for stable presentation (oldest Ulid first ≈ session 1).
        entries.sort_by_key(|(id, _)| id.0);
        entries
    };

    let mut user_msg = build_snapshot_message(&snapshots, trigger_id).await;
    // The whole point of the idle trigger: an executor tab's world model is
    // empty (its block never finishes), so the rendered screen is the only
    // place its report exists.
    // ponytail: only the trigger tab's screen. Add the siblings' if a
    // finding ever needs to compare two executors' output verbatim.
    if let TriggerKind::Idle { agent } = &kind {
        if let Some(screen) = screen_tail(app, trigger_id, SCREEN_TAIL_LINES).await {
            user_msg.push_str(&format!(
                "\n# Rendered screen of the tab that went idle (`{agent}`, last {SCREEN_TAIL_LINES} lines)\n\n{screen}\n"
            ));
        }
    }

    let base = match kind {
        TriggerKind::Failure => SYSTEM_PROMPT,
        TriggerKind::Idle { .. } => IDLE_SYSTEM_PROMPT,
    };
    let system_prompt = format!(
        "You are \"{name}\", the supervisor attached to ONE tab group.\n\
         {persona}\n\
         Only the sessions listed below (all members of this group) are in scope.\n\n\
         {base}\n\n\
         {voice}",
        name = op.name,
        persona = op.persona,
        voice = voice_directive(op.voice),
    );

    let started = Instant::now();
    let req = karl_agent::AskRequest {
        api_key: String::new(),
        model: resolved.model.clone(),
        system_prompt,
        user_message: user_msg,
        max_tokens: 180,
        thinking_budget: None,
        force_tool: None,
    };
    let model_for_vitals = req.model.clone();
    let resp = karl_agent::provider::collect_oneshot(&*resolved.provider, req)
        .await
        .map_err(|e| e.to_string())?;
    let usage = resp.usage;
    let response = resp.text;

    tracing::info!(
        latency_ms = started.elapsed().as_millis() as u64,
        group = %group_id,
        "group-supervision check complete"
    );
    vitals.record_complete(
        trigger_id,
        model_for_vitals,
        usage,
        started.elapsed().as_millis() as u32,
    );

    let Some(message) = parse_finding(&response) else {
        return Ok(());
    };

    // An executor idles once per turn; two consecutive turns often produce
    // the same sentence. Toast it once.
    {
        let mut i = inner.lock().await;
        if i.last_finding.get(group_id) == Some(&message) {
            tracing::debug!(group = %group_id, "group-supervision: duplicate finding suppressed");
            return Ok(());
        }
        i.last_finding.insert(group_id.to_string(), message.clone());
    }

    let finding = GroupSupervisionFinding {
        group_id: group_id.to_string(),
        operator_id: op.id.to_string(),
        operator_name: op.name.clone(),
        message,
        timestamp_unix_ms: now_ms(),
    };
    if let Err(e) = app.emit(FINDING_EVENT_NAME, &finding) {
        tracing::warn!(error = ?e, "failed to emit group-supervision finding");
    } else {
        tracing::info!(
            finding = %finding.message,
            group = %group_id,
            "group-supervision finding emitted"
        );
    }

    Ok(())
}

/// Last `max_lines` non-empty lines of a session's rendered screen,
/// secret-masked (CLAUDE.md rule #7). The vt100 grid is already plain
/// text, so no ANSI stripping is needed. `None` when the session is gone.
async fn screen_tail(app: &AppHandle, session_id: SessionId, max_lines: usize) -> Option<String> {
    use tauri::Manager;
    let handle = {
        let state = app.try_state::<crate::AppState>()?;
        // Drop the sessions guard before touching the screen: it holds
        // non-Sync PTY types and must never live across an await.
        let sessions = state.sessions.lock().await;
        sessions
            .get(&session_id)
            .map(|m| m.session.screen_handle())?
    };
    let text = handle.lock().ok()?.clone();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = lines[lines.len().saturating_sub(max_lines)..].join("\n");
    if tail.trim().is_empty() {
        return None;
    }
    Some(crate::safety::mask_secrets(&tail))
}

fn parse_finding(text: &str) -> Option<String> {
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("FINDING:") {
            let msg = rest.trim();
            if msg.is_empty()
                || msg.eq_ignore_ascii_case("(none)")
                || msg.eq_ignore_ascii_case("none")
            {
                return None;
            }
            return Some(msg.to_string());
        }
    }
    None
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::operator_registry::{GroupSupervision, OperatorId, OperatorRegistry};
    use ulid::Ulid;

    #[test]
    fn parses_finding() {
        assert_eq!(
            parse_finding("FINDING: tab 2 fails on src/foo.rs that you edited in tab 1"),
            Some("tab 2 fails on src/foo.rs that you edited in tab 1".to_string())
        );
    }

    #[test]
    fn drops_none() {
        assert!(parse_finding("FINDING: (none)").is_none());
        assert!(parse_finding("FINDING:none").is_none());
        assert!(parse_finding("FINDING:   ").is_none());
    }

    #[test]
    fn missing_finding_returns_none() {
        assert!(parse_finding("nothing here").is_none());
    }

    fn block_finished(session: SessionId, exit_code: i32) -> SessionEvent {
        SessionEvent::BlockFinished {
            session,
            block: karl_blocks::BlockId::new(),
            command: "cargo test".into(),
            cwd: std::path::PathBuf::from("/tmp"),
            exit_code: Some(exit_code),
            duration_ms: 10,
            output_text: String::new(),
        }
    }

    #[test]
    fn triggers_on_failure_and_executor_idle_only() {
        let sid = karl_session::SessionId::new();

        assert!(matches!(
            trigger_kind(&block_finished(sid, 1)),
            Some(TriggerKind::Failure)
        ));

        // A clean exit is not news.
        assert!(trigger_kind(&block_finished(sid, 0)).is_none());

        // The executor finished its turn — this is the proactive trigger.
        let idle = trigger_kind(&SessionEvent::AgentIdleWaiting {
            session: sid,
            agent: "claude".into(),
            prompt_text: None,
            quiet_ms: 3000,
        });
        assert!(matches!(idle, Some(TriggerKind::Idle { ref agent }) if agent == "claude"));

        assert!(trigger_kind(&SessionEvent::AgentResumed { session: sid }).is_none());
    }

    #[test]
    fn supervised_group_for_gates_on_membership_and_capability() {
        let reg = OperatorRegistry::for_tests("Default");
        let sid = karl_session::SessionId::new();

        // ungrouped session → None
        assert!(supervised_group_for(&reg, sid).is_none());

        // grouped but unsupervised → None
        reg.set_session_group(sid, Some("g1".into()));
        assert!(supervised_group_for(&reg, sid).is_none());

        // supervised (operator with supervision_enabled, per Task 2 helper) → Some
        let mut op = reg.default().expect("default operator");
        op.id = OperatorId(Ulid::new());
        op.name = "Warden".into();
        op.is_default = false;
        op.supervision_enabled = true;
        let sup_id = op.id;
        reg.insert_for_test(op);
        reg.set_group_supervisor(
            "g1".into(),
            Some(GroupSupervision {
                operator: sup_id,
                intervene: false,
            }),
        );
        assert!(supervised_group_for(&reg, sid).is_some());
    }
}
