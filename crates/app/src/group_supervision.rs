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
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_session::{
    EscalationKind, OperatorAction as SessionOperatorAction, SessionEvent, SessionId,
};
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
/// How many past findings a group remembers for de-duplication.
const RECENT_FINDINGS: usize = 8;
const FINDING_EVENT_NAME: &str = "group-supervision-finding";
const BRAKE_EVENT_NAME: &str = "group-supervision-braked";
/// How long after announcing a brake we stay quiet about the SAME group
/// while the frontend round-trips the downgrade. Deliberately short: a
/// duplicate toast is strictly cheaper than a missed brake, so this only
/// ever delays a repeat by one window — it can never cancel one.
const BRAKE_REPEAT_GRACE: Duration = Duration::from_secs(15);
/// Cap on the cwd→toplevel memo. The terrain check now runs on every wake
/// (it must not ride the model-call rate limiter), so the memo is what
/// keeps `git rev-parse` spawns bounded.
// ponytail: clear-on-overflow instead of an LRU. Distinct session cwds in
// one app lifetime are a handful; if that stops being true, swap in an LRU.
const ROOT_MEMO_CAP: usize = 256;

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
- it reported a failure, a skipped step, or something it could not verify
- it contradicts or duplicates what another supervised tab is doing

Rules:
- A PENDING QUESTION IS NOT A FINDING. That the executor is blocked, is \
  waiting, or is asking the user to choose already reaches the user \
  through its own channels (the needs-you chip, the tab dot, \
  Convergence). Repeating it back is noise — output (none). Say \
  something only when you know something the question itself does not \
  say: it contradicts another tab, it rests on a wrong premise, the \
  answer was already decided elsewhere.
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
    /// Recent findings per group, newest last, capped at `RECENT_FINDINGS`.
    /// An executor idles once per turn and consecutive turns often read the
    /// same; a one-slot memory only caught *back-to-back* repeats, so an
    /// A-B-A-B pair toasted forever. Compared verbatim — near-duplicate
    /// detection would need embeddings, and the ring already kills the
    /// repeats seen in practice.
    // ponytail: exact match over a small ring. Fuzzy-match if paraphrases
    // start slipping through.
    recent_findings: HashMap<String, Vec<String>>,
    /// Groups whose supervisor WE suspended, and when we last said so.
    ///
    /// This is NOT the brake's trigger — the brake is level-triggered on
    /// `collision && decides()`, because this set records what we
    /// *announced*, not what is *true*. Keying the brake off it made any
    /// re-arm (a manual detach/re-attach, an Intervene click, an emit
    /// nobody listened to) silence the brake permanently. Its two jobs
    /// now: mark exactly which groups this path may RE-ARM, and hold the
    /// timestamp that suppresses a duplicate toast inside
    /// `BRAKE_REPEAT_GRACE`.
    braked: HashMap<String, Instant>,
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
            recent_findings: HashMap::new(),
            braked: HashMap::new(),
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

/// Whether this trigger is the WATCHER's to report, given whether the
/// group's supervisor can act. A deciding supervisor owns idle turns —
/// answering is its job and AOM escalates what it won't take, so a toast
/// on top is a forwarded question. Failures stay with the watcher either
/// way: a cross-tab pattern is the one thing only it can see.
pub(crate) fn watcher_owns(kind: &TriggerKind, supervisor_decides: bool) -> bool {
    match kind {
        TriggerKind::Failure => true,
        TriggerKind::Idle { .. } => !supervisor_decides,
    }
}

/// True when this group's supervisor may ACT, not just watch. Until now
/// `GroupSupervision.intervene` was written by the UI and read by nobody
/// but a label — this is the first decision path that consults it.
pub(crate) fn decides(registry: &OperatorRegistry, group_id: &str) -> bool {
    registry
        .group_supervision(group_id)
        .is_some_and(|s| s.intervene)
}

/// Two or more supervised sessions standing on one git working tree.
#[derive(Debug, Clone)]
pub(crate) struct Collision {
    pub root: PathBuf,
    pub sessions: Vec<SessionId>,
}

/// Awareness, the whole rule: two executors editing one working tree
/// clobber each other regardless of branch, so no supervisor may hold
/// decision authority over them. Pure — takes already-resolved toplevels
/// so this is testable without git. Sessions whose cwd is not inside a
/// repo are simply absent from `roots` and cannot collide.
///
/// Returns the LOWEST colliding root by path order (the list is sorted
/// before the pick, so the answer is deterministic); one collision is
/// enough to brake the whole group, so finding all of them buys nothing.
// ponytail: one rule (shared root). Protected branch and dirty-tree
// signals were considered and dropped as noise — see the design doc.
pub(crate) fn terrain_collision(roots: &[(SessionId, PathBuf)]) -> Option<Collision> {
    let mut by_root: HashMap<&PathBuf, Vec<SessionId>> = HashMap::new();
    for (sid, root) in roots {
        by_root.entry(root).or_default().push(*sid);
    }
    // Sort for a stable answer: HashMap iteration order is not.
    let mut hits: Vec<(&PathBuf, Vec<SessionId>)> = by_root
        .into_iter()
        .filter(|(_, sessions)| sessions.len() >= 2)
        .collect();
    hits.sort_by(|a, b| a.0.cmp(b.0));
    let (root, mut sessions) = hits.into_iter().next()?;
    sessions.sort_by_key(|s| s.0);
    Some(Collision {
        root: root.clone(),
        sessions,
    })
}

/// One session's terrain answer. The `Unresolvable` variant is the whole
/// point: `git` missing from a GUI-launched `.app`'s PATH, a deleted cwd,
/// a non-zero exit, non-UTF8 output — every one of those used to read as
/// *safe terrain*, which both hid collisions and actively UN-braked a
/// correctly braked group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RootResolution {
    /// git answered: this is the session's working tree.
    Resolved(PathBuf),
    /// git answered: this cwd is not inside a repo. Nothing to collide
    /// with, and a definite answer — it does not block a re-arm.
    NotARepo,
    /// We do not know. Never collides (we have no root), and forbids any
    /// re-arm of the group.
    Unresolvable,
}

/// The group's terrain as a whole.
#[derive(Debug, Clone)]
pub(crate) struct TerrainSurvey {
    /// Members whose working tree we know. Only these can collide.
    pub roots: Vec<(SessionId, PathBuf)>,
    /// True only when EVERY member answered definitively. A false here
    /// forbids a re-arm: partial knowledge must never read as clean.
    pub complete: bool,
}

/// Fold per-session answers into the group's survey. Pure.
pub(crate) fn survey_from(answers: Vec<(SessionId, RootResolution)>) -> TerrainSurvey {
    let mut roots = Vec::with_capacity(answers.len());
    let mut complete = true;
    for (sid, r) in answers {
        match r {
            RootResolution::Resolved(root) => roots.push((sid, root)),
            RootResolution::NotARepo => {}
            RootResolution::Unresolvable => complete = false,
        }
    }
    TerrainSurvey { roots, complete }
}

/// What the terrain step should do this tick.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TerrainVerdict {
    /// Announce the brake and stamp the group.
    Brake,
    /// Announce the re-arm and forget the group.
    ReArm,
    /// Forget the group without announcing — nothing of ours left to
    /// restore (the user re-armed it himself, or the supervisor is gone).
    Forget,
    /// Say nothing, change nothing.
    Quiet,
}

/// The brake decision. **Level-triggered on `colliding && decides`**, not
/// edge-triggered on terrain alone: `braked` records what we announced,
/// and an announcement that did not land (emit with no listener, a
/// frontend early-return, a failed per-pane IPC) or a re-arm the user
/// performed by hand would otherwise silence the brake forever on the
/// very terrain it exists for. Level-triggering is self-limiting — a
/// landed downgrade makes `decides` false on the next tick.
///
/// `braked_since` only ever suppresses a REPEAT inside
/// `BRAKE_REPEAT_GRACE`, so the worst it can cost is one window of delay.
///
/// Re-arm is deliberately stricter than brake: it needs clean terrain,
/// a COMPLETE survey, and a brake of ours to undo. A group the user
/// downgraded by hand is never in `braked`, so this path never re-arms it.
pub(crate) fn terrain_verdict(
    colliding: bool,
    complete: bool,
    decides: bool,
    braked_since: Option<Instant>,
    now: Instant,
) -> TerrainVerdict {
    if colliding {
        if !decides {
            // Already observe-only. Keep the marker so we can restore
            // what we took once the terrain clears.
            return TerrainVerdict::Quiet;
        }
        return match braked_since {
            Some(t) if now.saturating_duration_since(t) < BRAKE_REPEAT_GRACE => {
                TerrainVerdict::Quiet
            }
            _ => TerrainVerdict::Brake,
        };
    }
    if braked_since.is_none() {
        // Never restore autonomy we did not suspend.
        return TerrainVerdict::Quiet;
    }
    if !complete {
        // A member's terrain is unknown. Unknown is not clean.
        return TerrainVerdict::Quiet;
    }
    if decides {
        // The user already put it back. Drop our marker so a later clean
        // tick cannot toast a re-arm nobody is waiting for.
        return TerrainVerdict::Forget;
    }
    TerrainVerdict::ReArm
}

/// Which events wake the supervisor. A zero exit is not news, and an
/// executor going idle IS a turn boundary — `idle::Detector` fires one
/// edge per turn, so this never degrades into polling.
///
/// 128+n exits are not news either: that's the shell reporting a signal,
/// which is nearly always the user ⌃C'ing a dev server or quitting an
/// interactive TUI. Deliberate stops must never read as failures.
pub(crate) fn trigger_kind(event: &SessionEvent) -> Option<TriggerKind> {
    match event {
        SessionEvent::BlockFinished {
            exit_code: Some(code),
            ..
        } if *code != 0 && *code < 128 => Some(TriggerKind::Failure),
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
    // cwd → toplevel, so the terrain check's git shell-outs stay bounded
    // now that it runs on every wake instead of behind the rate gate.
    // Only DEFINITE answers are cached; an `Unresolvable` is retried every
    // tick, because caching a transient git failure would freeze a group's
    // terrain at "unknown".
    let mut root_memo: HashMap<PathBuf, RootResolution> = HashMap::new();

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
                let Some((_, trigger_id, kind)) = pending.take() else { continue };

                // Terrain BEFORE the rate gate. `SimpleRate` is global
                // (6/min across every group) and sized for LLM spend; the
                // brake costs no model call, just a git shell-out and an
                // emit. Riding the limiter let a busy sibling group starve
                // a colliding group's brake for minutes while its
                // supervisor kept deciding.
                let braked = terrain_check(
                    &inner, &app, &registry, trigger_id, &mut root_memo,
                ).await;
                if braked {
                    // The brake IS this tick's report; a model call on top
                    // would say something less important, and would run
                    // against a supervisor we just stripped of authority.
                    continue;
                }

                if !rate.try_acquire() {
                    tracing::debug!("group-supervision rate-limited");
                    continue;
                }
                if let Err(e) =
                    check_for_pattern(&inner, &settings, &app, &registry, trigger_id, kind, &vitals).await
                {
                    tracing::warn!(error = %e, "group-supervision check failed");
                }
            }
        }
    }
}

/// Awareness, the whole rule: a supervisor may not decide for executors
/// that share one working tree — four agents editing one checkout clobber
/// each other regardless of branch. Returns true when a brake was
/// announced this tick (the caller then skips the model call).
// ponytail: braking returns the group to observe-only, and in observe-only
// `watcher_owns` lets the watcher resume a model call per idle turn — so
// braking costs MORE model calls, not fewer. First place to look if toast
// noise returns on a braked group.
async fn terrain_check(
    inner: &Arc<Mutex<Inner>>,
    app: &AppHandle,
    registry: &Arc<OperatorRegistry>,
    trigger_id: SessionId,
    memo: &mut HashMap<PathBuf, RootResolution>,
) -> bool {
    // Derive (group_id, supervisor) as ONE atomic pair, same reason as
    // `check_for_pattern`: a session that moved groups mid-debounce must
    // never pair a stale group_id with a fresh operator.
    let Some((group_id, op)) = supervised_group_for(registry, trigger_id) else {
        // No supervisor here any more. Drop any marker we hold for this
        // session's group so a stale entry can never toast a re-arm later.
        if let Some(gid) = registry.session_group(trigger_id) {
            inner.lock().await.braked.remove(&gid);
        }
        return false;
    };
    let group_id = group_id.as_str();

    let survey = survey_roots(inner, app, registry, group_id, memo).await;
    let hit = terrain_collision(&survey.roots);
    let decides_now = decides(registry, group_id);

    let (verdict, since) = {
        let i = inner.lock().await;
        let since = i.braked.get(group_id).copied();
        (
            terrain_verdict(
                hit.is_some(),
                survey.complete,
                decides_now,
                since,
                Instant::now(),
            ),
            since,
        )
    };
    tracing::debug!(
        group = %group_id,
        colliding = hit.is_some(),
        complete = survey.complete,
        decides = decides_now,
        was_braked = since.is_some(),
        verdict = ?verdict,
        "group-supervision terrain verdict"
    );

    match verdict {
        TerrainVerdict::Quiet => false,
        TerrainVerdict::Forget => {
            inner.lock().await.braked.remove(group_id);
            false
        }
        TerrainVerdict::ReArm => {
            inner.lock().await.braked.remove(group_id);
            announce_brake(app, &op, group_id, trigger_id, None).await;
            false
        }
        TerrainVerdict::Brake => {
            // Stamp BEFORE announcing: the announcement awaits, and a
            // second trigger arriving meanwhile must see the grace window.
            inner
                .lock()
                .await
                .braked
                .insert(group_id.to_string(), Instant::now());
            announce_brake(app, &op, group_id, trigger_id, hit.as_ref()).await;
            true
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

    // The terrain brake used to live here. It now runs in `terrain_check`,
    // BEFORE the model-call rate gate in `watch_loop` — it costs no model
    // call and must never be starved by one.

    // Attach = decide. A supervisor that can act OWNS the idle turn: the
    // executor's question is its to answer, and AOM already escalates
    // (`SessionEvent::EscalationRequested`) the ones it won't take. Toasting
    // here too made the supervisor a forwarder — it burned a model call to
    // echo a question already on screen, once per turn. Failures still get
    // checked: a cross-tab pattern is the one thing only the watcher sees.
    if !watcher_owns(&kind, decides(registry, group_id)) {
        tracing::debug!(
            group = %group_id,
            "group-supervision: idle turn belongs to the deciding supervisor, skipping"
        );
        return Ok(());
    }

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

    let verb = match kind {
        TriggerKind::Failure => "failed",
        TriggerKind::Idle { .. } => "went idle",
    };
    let mut user_msg = build_snapshot_message(&snapshots, trigger_id, verb).await;
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

    // An executor idles once per turn; turns often produce the same
    // sentence. Toast each one once per ring window.
    {
        let mut i = inner.lock().await;
        let ring = i.recent_findings.entry(group_id.to_string()).or_default();
        if ring.contains(&message) {
            tracing::debug!(group = %group_id, "group-supervision: duplicate finding suppressed");
            return Ok(());
        }
        ring.push(message.clone());
        if ring.len() > RECENT_FINDINGS {
            ring.remove(0);
        }
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

/// Every member's cwd, from whichever registry knows it. PTY sessions
/// carry it on their `SessionWorldModel`; ACP sessions have no world model
/// here at all (`attach` is only called from the PTY `spawn_session`
/// path), so they fall back to the ACP registry. A member neither source
/// knows is `None` — *unresolvable*, not absent.
///
/// Pure so the fallback is testable without a live registry or AppHandle.
pub(crate) fn merge_cwds(
    members: &[SessionId],
    pty: &HashMap<SessionId, PathBuf>,
    acp: &HashMap<SessionId, PathBuf>,
) -> Vec<(SessionId, Option<PathBuf>)> {
    members
        .iter()
        .map(|sid| (*sid, pty.get(sid).or_else(|| acp.get(sid)).cloned()))
        .collect()
}

/// Resolve every supervised session's git toplevel. Shells out (once per
/// uncached cwd) on a blocking task — the watcher's own task must never
/// block.
async fn survey_roots(
    inner: &Arc<Mutex<Inner>>,
    app: &AppHandle,
    registry: &Arc<OperatorRegistry>,
    group_id: &str,
    memo: &mut HashMap<PathBuf, RootResolution>,
) -> TerrainSurvey {
    let members = registry.group_sessions(group_id);

    // Collect the Arc handles under `inner`'s guard, then drop it before
    // locking any world model — two mutexes must never nest, one of them
    // across an await, or `attach`/the detach-on-drop path block on
    // `inner.lock()` for the whole walk.
    let handles: Vec<(SessionId, Arc<Mutex<SessionWorldModel>>)> = {
        let i = inner.lock().await;
        members
            .iter()
            .filter_map(|sid| i.worlds.get(sid).map(|w| (*sid, w.clone())))
            .collect()
    };
    let mut pty: HashMap<SessionId, PathBuf> = HashMap::with_capacity(handles.len());
    for (sid, world) in handles {
        pty.insert(sid, world.lock().await.cwd.clone());
    }

    // ACP fallback. Reached the same way `screen_tail` reaches AppState.
    let mut acp: HashMap<SessionId, PathBuf> = HashMap::new();
    {
        use tauri::Manager;
        if let Some(state) = app.try_state::<crate::AppState>() {
            for sid in members.iter().filter(|s| !pty.contains_key(s)) {
                if let Some(cwd) = state.acp_sessions.cwd_of(sid).await {
                    acp.insert(*sid, cwd);
                }
            }
        }
    }

    let pairs = merge_cwds(&members, &pty, &acp);

    // Split cached from uncached so the blocking hop only carries misses.
    let mut answers: Vec<(SessionId, RootResolution)> = Vec::with_capacity(pairs.len());
    let mut misses: Vec<(SessionId, PathBuf)> = Vec::new();
    for (sid, cwd) in pairs {
        match cwd {
            None => {
                tracing::warn!(
                    session = %sid,
                    group = %group_id,
                    reason = "no cwd source (neither PTY world model nor ACP registry)",
                    "group-supervision: session terrain unresolvable"
                );
                answers.push((sid, RootResolution::Unresolvable));
            }
            Some(cwd) => match memo.get(&cwd) {
                Some(hit) => answers.push((sid, hit.clone())),
                None => misses.push((sid, cwd)),
            },
        }
    }

    if !misses.is_empty() {
        let to_resolve = misses.clone();
        let resolved = tokio::task::spawn_blocking(move || {
            to_resolve
                .into_iter()
                .map(|(sid, cwd)| (sid, cwd.clone(), toplevel_of(&cwd)))
                .collect::<Vec<_>>()
        })
        .await;
        match resolved {
            Ok(rows) => {
                if memo.len().saturating_add(rows.len()) > ROOT_MEMO_CAP {
                    memo.clear();
                }
                for (sid, cwd, res) in rows {
                    if matches!(res, RootResolution::Unresolvable) {
                        tracing::warn!(
                            session = %sid,
                            group = %group_id,
                            cwd = %cwd.display(),
                            reason = "git could not resolve the toplevel",
                            "group-supervision: session terrain unresolvable"
                        );
                    } else {
                        // Cache DEFINITE answers only.
                        memo.insert(cwd, res.clone());
                    }
                    answers.push((sid, res));
                }
            }
            Err(e) => {
                // A panicked blocking task used to `.unwrap_or_default()`
                // into an empty root list, i.e. read as clean terrain.
                tracing::warn!(
                    error = %e,
                    group = %group_id,
                    unresolved = misses.len(),
                    "group-supervision: terrain resolution task failed"
                );
                for (sid, _) in misses {
                    answers.push((sid, RootResolution::Unresolvable));
                }
            }
        }
    }

    survey_from(answers)
}

/// `git rev-parse --show-toplevel`. Every failure mode is distinguished:
/// a definite "not a repo" is clean terrain, everything else is
/// `Unresolvable` and must not read as safe.
fn toplevel_of(cwd: &Path) -> RootResolution {
    let out = match std::process::Command::new("git")
        .current_dir(cwd)
        .args(["rev-parse", "--show-toplevel"])
        .output()
    {
        Ok(out) => out,
        // git not on PATH (a GUI-launched `.app` has a minimal one), or
        // the cwd no longer exists.
        Err(_) => return RootResolution::Unresolvable,
    };
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr).to_ascii_lowercase();
        return if stderr.contains("not a git repository") {
            RootResolution::NotARepo
        } else {
            RootResolution::Unresolvable
        };
    }
    let Ok(text) = String::from_utf8(out.stdout) else {
        return RootResolution::Unresolvable;
    };
    let trimmed = text.trim();
    if trimmed.is_empty() {
        RootResolution::Unresolvable
    } else {
        RootResolution::Resolved(PathBuf::from(trimmed))
    }
}

/// Payload the frontend consumes to downgrade (or restore) the group and
/// to toast the reason. `braked: false` means the terrain came back clean.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TerrainBrake {
    pub group_id: String,
    pub operator_id: String,
    pub operator_name: String,
    pub braked: bool,
    pub root: String,
    pub session_count: usize,
    pub message: String,
}

/// The user-facing brake sentence. The operator's name is NOT in it: the
/// toast host already prefixes `operator_name`, and both together read
/// "Zeta: Zeta stepped back — …".
///
/// Pure so the copy is testable.
pub(crate) fn brake_message(sessions: usize, root: &Path, branch: &str) -> String {
    let repo = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| root.display().to_string());
    format!(
        "stepped back — {sessions} sessions share the {repo} working tree ({branch}). \
         Supervision is now observe-only."
    )
}

/// Announce a brake / re-arm on both lanes: the Tauri event the frontend
/// acts on, and the escalation bus so it reaches the user the way any
/// "needs you" does (Telegram today, any future subscriber for free).
/// The re-arm only takes the Tauri lane — restoring what the user already
/// asked for is not a "needs you".
async fn announce_brake(
    app: &AppHandle,
    op: &Operator,
    group_id: &str,
    trigger_id: SessionId,
    hit: Option<&Collision>,
) {
    // The branch comes from the COLLISION ROOT we already resolved, not
    // from a second guess at the trigger session's cwd: falling back to
    // `"."` ran git in the app process's cwd (`/` for a bundled `.app`)
    // and attributed the brake to the wrong repo — or to "unknown".
    let project = match hit {
        Some(c) => {
            let root = c.root.clone();
            match tokio::task::spawn_blocking(move || {
                crate::project_ref::project_ref_from_cwd(&root)
            })
            .await
            {
                Ok(p) => Some(p),
                Err(e) => {
                    tracing::warn!(error = %e, group = %group_id, "project_ref resolution failed");
                    None
                }
            }
        }
        None => None,
    };

    let payload = match hit {
        Some(c) => TerrainBrake {
            group_id: group_id.to_string(),
            operator_id: op.id.to_string(),
            operator_name: op.name.clone(),
            braked: true,
            root: c.root.display().to_string(),
            session_count: c.sessions.len(),
            message: brake_message(
                c.sessions.len(),
                &c.root,
                project
                    .as_ref()
                    .map(|p| p.branch.as_str())
                    .unwrap_or("unknown"),
            ),
        },
        None => TerrainBrake {
            group_id: group_id.to_string(),
            operator_id: op.id.to_string(),
            operator_name: op.name.clone(),
            braked: false,
            root: String::new(),
            session_count: 0,
            message: "deciding again — the sessions no longer share a working tree.".to_string(),
        },
    };

    if let Err(e) = app.emit(BRAKE_EVENT_NAME, &payload) {
        tracing::warn!(error = ?e, group = %group_id, "failed to emit terrain brake");
    } else {
        tracing::info!(
            group = %group_id,
            braked = payload.braked,
            sessions = payload.session_count,
            "group-supervision terrain brake"
        );
    }

    if !payload.braked {
        return;
    }
    let Some(project) = project else { return };

    use tauri::Manager;
    let Some(state) = app.try_state::<crate::AppState>() else {
        return;
    };

    let _ = state
        .escalation_bus_tx
        .send(SessionEvent::EscalationRequested {
            session: trigger_id,
            escalation_id: ulid::Ulid::new().to_string(),
            // Its OWN kind, not `Blocked`. Two reasons, both harmful:
            // Telegram coalesces on `(session_id, kind_key(kind))` within
            // 120s, so a `Blocked` brake would EDIT a live executor
            // escalation's message in place — replacing the executor's
            // real question with the brake text while keeping its
            // keyboard — and the header label would misread it as a
            // question.
            kind: EscalationKind::TerrainCollision,
            summary: payload.message.clone(),
            // NO `Reply`. A Telegram free-text reply to an open
            // escalation is written straight into that session's PTY
            // (see lib.rs's inbound drain), so a user typing "why?" at a
            // brake notice would submit that sentence to a live executor
            // standing on the shared tree. A brake is an announcement,
            // not a question.
            actions: vec![SessionOperatorAction::Snooze { minutes: 10 }],
            operator: op.to_session_ref(),
            project,
        });
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

        // Neither is ⌃C on a dev server, or a kill: 128+signal.
        assert!(trigger_kind(&block_finished(sid, 130)).is_none()); // SIGINT
        assert!(trigger_kind(&block_finished(sid, 137)).is_none()); // SIGKILL
        assert!(trigger_kind(&block_finished(sid, 143)).is_none()); // SIGTERM

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
                started_at_unix_ms: 0,
            }),
        );
        assert!(supervised_group_for(&reg, sid).is_some());
        // …and `intervene` is now a decision path, not a label.
        assert!(!decides(&reg, "g1"), "observe-only must not claim the turn");
        reg.set_group_supervisor(
            "g1".into(),
            Some(GroupSupervision {
                operator: sup_id,
                intervene: true,
                started_at_unix_ms: 0,
            }),
        );
        assert!(decides(&reg, "g1"));
        assert!(!decides(&reg, "no-such-group"));
    }

    #[test]
    fn a_deciding_supervisor_owns_the_idle_turn_but_never_the_failure() {
        let idle = TriggerKind::Idle {
            agent: "claude".into(),
        };
        // The regression this exists for: the executor asks a question, the
        // supervisor can answer it, and the user gets toasted anyway.
        assert!(!watcher_owns(&idle, true));
        // Observe-only has nobody to answer, so the turn still gets looked at
        // (the prompt is what stops it echoing the question back).
        assert!(watcher_owns(&idle, false));
        // A cross-tab failure pattern is the watcher's alone, either way.
        assert!(watcher_owns(&TriggerKind::Failure, true));
        assert!(watcher_owns(&TriggerKind::Failure, false));
    }

    #[test]
    fn distinct_worktrees_do_not_collide() {
        let a = SessionId::new();
        let b = SessionId::new();
        let roots = vec![
            (a, PathBuf::from("/repo/.covenant/worktrees/one")),
            (b, PathBuf::from("/repo/.covenant/worktrees/two")),
        ];
        assert!(terrain_collision(&roots).is_none());
    }

    #[test]
    fn shared_worktree_collides_and_names_its_sessions() {
        let a = SessionId::new();
        let b = SessionId::new();
        let c = SessionId::new();
        let roots = vec![
            (a, PathBuf::from("/repo")),
            (b, PathBuf::from("/repo/.covenant/worktrees/one")),
            (c, PathBuf::from("/repo")),
        ];
        let hit = terrain_collision(&roots).expect("two sessions share /repo");
        assert_eq!(hit.root, PathBuf::from("/repo"));
        assert_eq!(hit.sessions.len(), 2);
        assert!(hit.sessions.contains(&a));
        assert!(hit.sessions.contains(&c));
    }

    #[test]
    fn a_lone_session_never_collides() {
        let roots = vec![(SessionId::new(), PathBuf::from("/repo"))];
        assert!(terrain_collision(&roots).is_none());
    }

    /// A brake stamp old enough that the duplicate-toast grace has passed.
    fn stale() -> Instant {
        Instant::now() - BRAKE_REPEAT_GRACE - Duration::from_secs(1)
    }

    #[test]
    fn brake_is_level_triggered_not_edge_triggered() {
        let now = Instant::now();
        // Colliding, deciding, never braked → brake.
        assert_eq!(
            terrain_verdict(true, true, true, None, now),
            TerrainVerdict::Brake
        );
        // THE CRITICAL REGRESSION: colliding, deciding AGAIN (the user
        // detached and re-attached the supervisor, or clicked Intervene,
        // or the downgrade never landed) and we already braked once.
        // Edge-triggering returned "nothing to do" here — forever.
        assert_eq!(
            terrain_verdict(true, true, true, Some(stale()), now),
            TerrainVerdict::Brake
        );
        // Self-limiting: once the downgrade lands, `decides` is false and
        // the brake stops firing on its own.
        assert_eq!(
            terrain_verdict(true, true, false, Some(stale()), now),
            TerrainVerdict::Quiet
        );
        // An incomplete survey never stops a brake — a collision we CAN
        // see is a collision.
        assert_eq!(
            terrain_verdict(true, false, true, None, now),
            TerrainVerdict::Brake
        );
    }

    #[test]
    fn a_repeat_inside_the_grace_window_is_suppressed_but_not_cancelled() {
        let now = Instant::now();
        // Just braked: stay quiet while the frontend round-trips.
        assert_eq!(
            terrain_verdict(true, true, true, Some(now), now),
            TerrainVerdict::Quiet
        );
        // …and the very next tick past the window brakes again. The
        // suppression can only ever DELAY a brake by one window.
        assert_eq!(
            terrain_verdict(true, true, true, Some(stale()), now),
            TerrainVerdict::Brake
        );
    }

    #[test]
    fn an_unresolvable_member_never_produces_a_rearm() {
        let now = Instant::now();
        // Clean-looking terrain, but one member's toplevel is unknown
        // (git missing from PATH, cwd deleted, transient failure). Unknown
        // is not clean: a correctly braked group must stay braked.
        assert_eq!(
            terrain_verdict(false, false, false, Some(stale()), now),
            TerrainVerdict::Quiet
        );
        // Complete + clean + ours to restore → re-arm.
        assert_eq!(
            terrain_verdict(false, true, false, Some(stale()), now),
            TerrainVerdict::ReArm
        );
    }

    #[test]
    fn never_rearms_a_group_the_user_downgraded_himself() {
        let now = Instant::now();
        // No stamp of ours → nothing to restore.
        assert_eq!(
            terrain_verdict(false, true, false, None, now),
            TerrainVerdict::Quiet
        );
        // The user already re-armed it by hand: drop our marker silently
        // instead of toasting a restoration nobody is waiting for.
        assert_eq!(
            terrain_verdict(false, true, true, Some(stale()), now),
            TerrainVerdict::Forget
        );
    }

    #[test]
    fn unresolvable_members_do_not_read_as_clean_terrain() {
        let a = SessionId::new();
        let b = SessionId::new();
        let c = SessionId::new();
        let survey = survey_from(vec![
            (a, RootResolution::Resolved(PathBuf::from("/repo"))),
            (b, RootResolution::NotARepo),
            (c, RootResolution::Unresolvable),
        ]);
        assert_eq!(survey.roots.len(), 1, "only resolved members can collide");
        assert!(!survey.complete, "an unresolvable member forbids a re-arm");

        // A cwd outside any repo is a DEFINITE answer — it must not block
        // a re-arm the way an unknown does.
        let clean = survey_from(vec![
            (a, RootResolution::Resolved(PathBuf::from("/repo"))),
            (b, RootResolution::NotARepo),
        ]);
        assert!(clean.complete);
    }

    #[test]
    fn acp_sessions_count_toward_a_collision() {
        let pty_tab = SessionId::new();
        let acp_one = SessionId::new();
        let acp_two = SessionId::new();
        let members = vec![pty_tab, acp_one, acp_two];

        // Only the PTY tab has a world model — the incident that motivated
        // the feature was four Claude tabs, which may well have been ACP.
        let mut pty = HashMap::new();
        pty.insert(pty_tab, PathBuf::from("/repo/sub"));
        let mut acp = HashMap::new();
        acp.insert(acp_one, PathBuf::from("/repo"));
        acp.insert(acp_two, PathBuf::from("/repo/other"));

        let merged = merge_cwds(&members, &pty, &acp);
        assert_eq!(merged.len(), 3);
        assert!(
            merged.iter().all(|(_, cwd)| cwd.is_some()),
            "the ACP fallback must resolve a cwd for ACP members"
        );

        // All three cwds live in one working tree, so the group collides.
        let answers = merged
            .into_iter()
            .map(|(sid, cwd)| {
                (
                    sid,
                    match cwd {
                        Some(_) => RootResolution::Resolved(PathBuf::from("/repo")),
                        None => RootResolution::Unresolvable,
                    },
                )
            })
            .collect();
        let survey = survey_from(answers);
        assert!(survey.complete);
        let hit = terrain_collision(&survey.roots).expect("three sessions share /repo");
        assert_eq!(hit.sessions.len(), 3);
    }

    #[test]
    fn a_member_no_registry_knows_is_unresolvable_not_absent() {
        let known = SessionId::new();
        let ghost = SessionId::new();
        let mut pty = HashMap::new();
        pty.insert(known, PathBuf::from("/repo"));
        let merged = merge_cwds(&[known, ghost], &pty, &HashMap::new());
        assert_eq!(merged.len(), 2, "an unknown member must not be dropped");
        assert!(merged[1].1.is_none());
    }

    #[test]
    fn brake_message_names_repo_and_branch_but_never_the_operator() {
        let msg = brake_message(4, &PathBuf::from("/Users/k/karlTerminal"), "main");
        assert!(msg.starts_with("stepped back"), "got: {msg}");
        assert!(
            msg.contains("karlTerminal working tree (main)"),
            "got: {msg}"
        );
        // The toast host prefixes the operator name; repeating it here
        // rendered "Zeta: Zeta stepped back — …".
        assert!(!msg.contains("Zeta"));
    }
}
