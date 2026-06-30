//! Live LLM vitals aggregator — owns the broadcast channel that every
//! Covenant LLM call site emits to, runs the rolling-window aggregator
//! task, and emits `vitals_update` Tauri events to the UI.
//!
//! See docs/superpowers/specs/2026-05-18-statusbar-vitals-design.md for
//! the data model, idle behavior, and chip layout.

// Scaffold module — constants and helpers below are referenced from
// the aggregator state, tick loop, and call-site instrumentation that
// land in Tasks 2–8 of the implementation plan. The allow keeps the
// build warning-free until those tasks fill in their consumers.
#![allow(dead_code)]

use karl_agent::TokenUsage;
use karl_session::SessionId;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tokio::sync::{broadcast, Mutex};

/// Sparkline window in seconds. 12 buckets × 5s = 60s.
const WINDOW_SECS: u64 = 60;
const BUCKET_COUNT: usize = 12;
const BUCKET_SECS: u64 = 5;
/// Cache stats window — longer than sparkline so a single fresh call
/// is enough to populate the cache pill without flickering.
const CACHE_WINDOW_SECS: u64 = 300;
/// Idle threshold — when `idle_secs >= IDLE_THRESHOLD_SECS`, the UI
/// fades the cluster. Matches the sparkline window so the cluster
/// disappears the moment the last bucket would have shown a flat zero.
pub(crate) const IDLE_THRESHOLD_SECS: u32 = 60;

/// Events from instrumented call sites to the aggregator task. Every
/// event is tagged with the session that owns the call so the aggregator
/// can keep per-session windows. The status-bar cluster only renders the
/// currently-active tab's bucket — other tabs accumulate silently and
/// surface the moment the user switches to them.
#[derive(Debug, Clone)]
pub(crate) enum VitalsEvent {
    CallStarted {
        session: SessionId,
        model: String,
        started_unix_ms: u64,
        /// True only for the agent executor's own calls (the transcript
        /// tailers / pi RPC). Covenant's internal workers (summariser,
        /// operator triage, fix-proposer, cross-session) pass false and
        /// are ignored by the aggregator — the status-bar cluster is
        /// executor stats, not system/operator activity.
        executor: bool,
    },
    CallCompleted {
        session: SessionId,
        model: String,
        usage: TokenUsage,
        latency_ms: u32,
        executor: bool,
    },
    /// Cancelled, errored, or dropped without completion. Clears
    /// in-flight without writing into the bucket / cache window.
    CallAbandoned { session: SessionId, executor: bool },
    /// Frontend tab change — switches which session's snapshot drives
    /// the `vitals_update` event stream.
    ActiveChanged { session: Option<SessionId> },
    /// Executor context-window occupancy, sourced ONLY from the transcript
    /// tailers (Claude Code jsonl / OpenCode sqlite / pi RPC) — never from
    /// Covenant's own internal calls. Kept separate from `CallCompleted` so
    /// an interleaved internal summariser/operator call can't overwrite the
    /// executor's context number.
    ExecutorContext {
        session: SessionId,
        model: String,
        context_tokens: u32,
    },
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct InFlightPayload {
    pub model: String,
    pub started_unix_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub(crate) struct VitalsPayload {
    pub tok_per_min: u32,
    pub spark: [u32; BUCKET_COUNT],
    pub cache_hit_pct: Option<u8>,
    pub last_model: Option<String>,
    pub last_latency_ms: Option<u32>,
    pub in_flight: Option<InFlightPayload>,
    pub idle_secs: u32,
    pub is_idle: bool,
    /// Tokens occupying the model's context window as of the most recent
    /// completed call (input + cache_creation + cache_read — i.e. the
    /// prompt that was sent, not cumulative throughput). 0 before any call.
    pub context_tokens: u32,
    /// `context_tokens` as a percentage of the model's context window.
    /// `None` when we can't name the window for `last_model` (the UI then
    /// shows the absolute token count instead of a %).
    pub context_pct: Option<u8>,
}

/// Context-window size for a model id, when we can name it *reliably*.
/// Returns `None` today for every executor we read: Claude Code's jsonl
/// doesn't encode whether a session is the 200k or 1M-context tier (the
/// model id is identical), and pi/opencode run arbitrary providers. We
/// refuse to guess — a wrong window cries "95%!" on a session that's
/// actually at 17%. The UI shows absolute tokens whenever this is `None`.
///
/// Wire a real window here per-source once one is available: codex's
/// transcript carries `model_context_window`; a per-tab override could
/// supply it for Claude.
fn context_window(_model: &str, _used: u32) -> Option<u32> {
    None
}

impl VitalsPayload {
    /// Empty / idle snapshot used when no tab is active.
    fn idle() -> Self {
        Self {
            tok_per_min: 0,
            spark: [0; BUCKET_COUNT],
            cache_hit_pct: None,
            last_model: None,
            last_latency_ms: None,
            in_flight: None,
            idle_secs: u32::MAX,
            is_idle: true,
            context_tokens: 0,
            context_pct: None,
        }
    }
}

/// Per-session bucket map + which session the UI currently mirrors.
#[derive(Debug)]
pub(crate) struct AggregatorState {
    per_session: HashMap<SessionId, VitalsState>,
    active: Option<SessionId>,
}

impl AggregatorState {
    fn new() -> Self {
        Self {
            per_session: HashMap::new(),
            active: None,
        }
    }

    fn touch_session(&mut self, session: SessionId, now_ms: u64) -> &mut VitalsState {
        self.per_session
            .entry(session)
            .or_insert_with(|| VitalsState::new(now_ms))
    }

    fn active_snapshot(&mut self, now_ms: u64) -> VitalsPayload {
        match self.active {
            Some(sid) => self
                .per_session
                .entry(sid)
                .or_insert_with(|| VitalsState::new(now_ms))
                .snapshot(now_ms),
            None => VitalsPayload::idle(),
        }
    }
}

fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[derive(Debug, Clone)]
struct CacheSample {
    unix_ms: u64,
    cache_read: u32,
    input: u32,
    cache_creation: u32,
}

#[derive(Debug, Clone)]
struct InFlight {
    model: String,
    started_unix_ms: u64,
}

#[derive(Debug)]
pub(crate) struct VitalsState {
    /// Tokens per 5s bucket. Idx 0 = oldest, last idx = newest.
    /// Each bucket stores input + output + cache_creation tokens.
    /// cache_read is intentionally excluded (it's free input —
    /// counting it would make the sparkline misleading).
    buckets: [u32; BUCKET_COUNT],
    /// Wall-clock time the *newest* bucket (last index) started.
    /// Rotate buckets when now - newest_started_unix_ms >= BUCKET_SECS*1000.
    newest_bucket_started_unix_ms: u64,

    cache_window: VecDeque<CacheSample>,

    last_model: Option<String>,
    last_latency_ms: Option<u32>,
    last_call_unix_ms: Option<u64>,

    in_flight: Option<InFlight>,

    /// Cumulative tokens charged to this session for its lifetime —
    /// same accounting as `buckets` (input + output + cache_creation;
    /// cache reads excluded). Doesn't roll over like buckets do, so
    /// callers can take a delta between two timestamps. Used by the
    /// notch bridge to attach "+N tok" annotations to phase events.
    total_tokens: u64,

    /// Executor context-window occupancy: input + cache_creation +
    /// cache_read of the executor's most recent turn. Set ONLY via
    /// `ExecutorContext` events from the transcript tailers — Covenant's
    /// own interleaved calls don't touch it, so the gauge stays pinned to
    /// the executor rather than flickering to a summariser's tiny prompt.
    exec_context_tokens: u32,
    /// Model behind `exec_context_tokens` (drives the window lookup,
    /// independent of `last_model` which tracks any/all calls).
    exec_context_model: Option<String>,
}

impl VitalsState {
    fn new(now_ms: u64) -> Self {
        Self {
            buckets: [0; BUCKET_COUNT],
            newest_bucket_started_unix_ms: now_ms,
            cache_window: VecDeque::new(),
            last_model: None,
            last_latency_ms: None,
            last_call_unix_ms: None,
            in_flight: None,
            total_tokens: 0,
            exec_context_tokens: 0,
            exec_context_model: None,
        }
    }

    /// Slide the bucket ring forward by however many BUCKET_SECS-second
    /// slots have elapsed. Each new slot is appended as a 0; oldest
    /// slots fall off the front.
    fn rotate_to(&mut self, now_ms: u64) {
        let elapsed_ms = now_ms.saturating_sub(self.newest_bucket_started_unix_ms);
        let slots = (elapsed_ms / (BUCKET_SECS * 1000)) as usize;
        if slots == 0 {
            return;
        }
        if slots >= BUCKET_COUNT {
            self.buckets = [0; BUCKET_COUNT];
        } else {
            // Shift left by `slots`, zero the new tail entries.
            self.buckets.rotate_left(slots);
            for i in (BUCKET_COUNT - slots)..BUCKET_COUNT {
                self.buckets[i] = 0;
            }
        }
        self.newest_bucket_started_unix_ms += slots as u64 * BUCKET_SECS * 1000;
    }

    fn record_complete(&mut self, model: String, usage: TokenUsage, latency_ms: u32, now_ms: u64) {
        self.rotate_to(now_ms);
        let counted = usage
            .input_tokens
            .saturating_add(usage.output_tokens)
            .saturating_add(usage.cache_creation_input_tokens);
        let last = BUCKET_COUNT - 1;
        self.buckets[last] = self.buckets[last].saturating_add(counted);
        self.total_tokens = self.total_tokens.saturating_add(counted as u64);

        self.cache_window.push_back(CacheSample {
            unix_ms: now_ms,
            cache_read: usage.cache_read_input_tokens,
            input: usage.input_tokens,
            cache_creation: usage.cache_creation_input_tokens,
        });
        self.purge_cache_window(now_ms);

        self.last_model = Some(model);
        self.last_latency_ms = Some(latency_ms);
        self.last_call_unix_ms = Some(now_ms);
        self.in_flight = None;
    }

    fn set_executor_context(&mut self, model: String, context_tokens: u32) {
        self.exec_context_tokens = context_tokens;
        self.exec_context_model = Some(model);
    }

    fn purge_cache_window(&mut self, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(CACHE_WINDOW_SECS * 1000);
        while let Some(front) = self.cache_window.front() {
            if front.unix_ms < cutoff {
                self.cache_window.pop_front();
            } else {
                break;
            }
        }
    }

    fn cache_hit_pct(&self) -> Option<u8> {
        let mut read = 0u64;
        let mut input = 0u64;
        let mut creation = 0u64;
        for s in &self.cache_window {
            read += s.cache_read as u64;
            input += s.input as u64;
            creation += s.cache_creation as u64;
        }
        let denom = read + input + creation;
        if denom == 0 {
            None
        } else {
            Some(((read * 100) / denom).min(100) as u8)
        }
    }

    fn snapshot(&mut self, now_ms: u64) -> VitalsPayload {
        self.rotate_to(now_ms);
        self.purge_cache_window(now_ms);

        let tok_per_min: u32 = self.buckets.iter().copied().sum();
        // An in-flight call is active even before the first completion
        // in a session. Without this special-case, a fresh tab's first
        // LLM request reports `idle_secs = u32::MAX` (no last call yet),
        // causing the UI to hide the live elapsed timer until the call
        // finishes.
        let idle_secs = if self.in_flight.is_some() {
            0
        } else {
            self.last_call_unix_ms
                .map(|t| ((now_ms.saturating_sub(t)) / 1000) as u32)
                .unwrap_or(u32::MAX)
        };
        let is_idle = self.in_flight.is_none() && idle_secs >= IDLE_THRESHOLD_SECS;

        let context_tokens = self.exec_context_tokens;
        let context_pct = self.exec_context_model.as_deref().and_then(|m| {
            context_window(m, context_tokens)
                .map(|w| ((context_tokens as u64 * 100) / w as u64).min(100) as u8)
        });

        VitalsPayload {
            tok_per_min,
            spark: self.buckets,
            cache_hit_pct: self.cache_hit_pct(),
            // Prefer the executor's model so the pill names what the user
            // is actually working with (e.g. Opus 4.8), not whichever of
            // Covenant's background workers (summariser/operator on gpt-4o)
            // happened to fire last. Falls back to the last call's model
            // when no executor is running in this tab.
            last_model: self
                .exec_context_model
                .clone()
                .or_else(|| self.last_model.clone()),
            last_latency_ms: self.last_latency_ms,
            in_flight: self.in_flight.as_ref().map(|f| InFlightPayload {
                model: f.model.clone(),
                started_unix_ms: f.started_unix_ms,
            }),
            idle_secs,
            is_idle,
            context_tokens,
            context_pct,
        }
    }
}

/// Shared handle exposed on AppState. Callers do everything through this:
/// instrument call sites, ask for a snapshot, etc.
#[derive(Clone)]
pub struct VitalsHandle {
    tx: broadcast::Sender<VitalsEvent>,
    inner: Arc<Mutex<AggregatorState>>,
}

impl VitalsHandle {
    /// Begin tracking an in-flight call by Covenant's own internal workers
    /// (summariser / operator / fix-proposer). Flagged non-executor, so the
    /// status-bar cluster ignores it. Returns a `CallHandle`; on drop
    /// without `.complete()`/`.abandon()` the in-flight slot is cleared.
    #[must_use]
    pub fn record_started(&self, session: SessionId, model: String) -> CallHandle {
        self.record_started_inner(session, model, false)
    }

    /// Executor variant of `record_started` — drives the cluster.
    #[must_use]
    pub fn record_executor_started(&self, session: SessionId, model: String) -> CallHandle {
        self.record_started_inner(session, model, true)
    }

    fn record_started_inner(&self, session: SessionId, model: String, executor: bool) -> CallHandle {
        let started = now_unix_ms();
        let _ = self.tx.send(VitalsEvent::CallStarted {
            session,
            model: model.clone(),
            started_unix_ms: started,
            executor,
        });
        CallHandle {
            tx: self.tx.clone(),
            session,
            model,
            started_unix_ms: started,
            consumed: false,
            executor,
        }
    }

    /// Direct one-shot record for Covenant's internal workers. Flagged
    /// non-executor → ignored by the cluster.
    pub fn record_complete(
        &self,
        session: SessionId,
        model: String,
        usage: TokenUsage,
        latency_ms: u32,
    ) {
        self.record_complete_inner(session, model, usage, latency_ms, false);
    }

    /// Executor variant of `record_complete` — drives the cluster
    /// (tok/min, cache, model, latency). Called by the transcript tailers
    /// and pi's RPC bridge.
    pub fn record_executor_complete(
        &self,
        session: SessionId,
        model: String,
        usage: TokenUsage,
        latency_ms: u32,
    ) {
        self.record_complete_inner(session, model, usage, latency_ms, true);
    }

    fn record_complete_inner(
        &self,
        session: SessionId,
        model: String,
        usage: TokenUsage,
        latency_ms: u32,
        executor: bool,
    ) {
        let _ = self.tx.send(VitalsEvent::CallCompleted {
            session,
            model,
            usage,
            latency_ms,
            executor,
        });
    }

    /// Report the executor's context-window occupancy for `session`. Only
    /// the transcript tailers call this; it never mixes with Covenant's
    /// own LLM calls, so the context gauge stays pinned to the executor.
    pub fn record_executor_context(&self, session: SessionId, model: String, context_tokens: u32) {
        let _ = self.tx.send(VitalsEvent::ExecutorContext {
            session,
            model,
            context_tokens,
        });
    }

    /// Mark which tab the status-bar cluster should reflect. None hides
    /// the cluster (no active session, e.g. all tabs closed).
    pub fn set_active(&self, session: Option<SessionId>) {
        let _ = self.tx.send(VitalsEvent::ActiveChanged { session });
    }

    /// Lifetime cumulative tokens charged to `session` — input + output
    /// + cache_creation, cache reads excluded. Returns 0 for sessions
    /// that have never recorded a call. Used by the notch bridge to
    /// emit per-phase token deltas.
    pub async fn session_tokens(&self, session: SessionId) -> u64 {
        let inner = self.inner.lock().await;
        inner
            .per_session
            .get(&session)
            .map(|s| s.total_tokens)
            .unwrap_or(0)
    }

    pub async fn snapshot(&self) -> VitalsPayload {
        let mut inner = self.inner.lock().await;
        let now = now_unix_ms();
        match inner.active {
            Some(sid) => inner
                .per_session
                .entry(sid)
                .or_insert_with(|| VitalsState::new(now))
                .snapshot(now),
            None => VitalsPayload::idle(),
        }
    }
}

/// RAII guard returned by `record_started`. The Drop impl sends
/// `CallAbandoned` if neither `.complete()` nor `.abandon()` was called,
/// so a panic / early-return path can't leave the in-flight slot stuck.
#[must_use = "complete() or abandon() must be called — letting it drop sends CallAbandoned"]
pub struct CallHandle {
    tx: broadcast::Sender<VitalsEvent>,
    session: SessionId,
    model: String,
    started_unix_ms: u64,
    consumed: bool,
    /// Carries the executor flag from `record_started` through to the
    /// completion / abandonment event so the aggregator gates consistently.
    executor: bool,
}

impl CallHandle {
    pub fn complete(mut self, usage: TokenUsage, latency_ms: u32) {
        let model = std::mem::take(&mut self.model);
        self.complete_with_model(model, usage, latency_ms);
    }

    pub fn complete_with_model(mut self, model: String, usage: TokenUsage, latency_ms: u32) {
        self.consumed = true;
        let _ = self.tx.send(VitalsEvent::CallCompleted {
            session: self.session,
            model,
            usage,
            latency_ms,
            executor: self.executor,
        });
    }

    pub fn abandon(mut self) {
        self.consumed = true;
        let _ = self.tx.send(VitalsEvent::CallAbandoned {
            session: self.session,
            executor: self.executor,
        });
    }
}

impl Drop for CallHandle {
    fn drop(&mut self) {
        if !self.consumed {
            let _ = self.tx.send(VitalsEvent::CallAbandoned {
                session: self.session,
                executor: self.executor,
            });
        }
    }
}

/// Spawn the aggregator task and return the shared handle. Called once
/// during Tauri setup (see `crates/app/src/lib.rs::run`).
pub fn spawn(app: tauri::AppHandle) -> VitalsHandle {
    let (tx, mut rx) = broadcast::channel::<VitalsEvent>(64);
    let inner = Arc::new(Mutex::new(AggregatorState::new()));
    let inner_for_task = inner.clone();
    let app_for_task = app.clone();

    tauri::async_runtime::spawn(async move {
        use tauri::Emitter;
        let mut tick = tokio::time::interval(Duration::from_secs(1));
        // Skip first tick (fires immediately); we only want subsequent
        // ticks to drive heartbeats.
        tick.tick().await;
        loop {
            tokio::select! {
                Ok(ev) = rx.recv() => {
                    let (emit_now, payload) = {
                        let mut agg = inner_for_task.lock().await;
                        let now = now_unix_ms();
                        let touched_session = match &ev {
                            // Non-executor calls (Covenant's summariser /
                            // operator / fix-proposer) are dropped here — the
                            // cluster reflects executor stats only.
                            VitalsEvent::CallStarted { executor: false, .. }
                            | VitalsEvent::CallCompleted { executor: false, .. }
                            | VitalsEvent::CallAbandoned { executor: false, .. } => None,
                            VitalsEvent::CallStarted { session, model, started_unix_ms, .. } => {
                                let s = agg.touch_session(*session, now);
                                s.in_flight = Some(InFlight {
                                    model: model.clone(),
                                    started_unix_ms: *started_unix_ms,
                                });
                                Some(*session)
                            }
                            VitalsEvent::CallCompleted { session, model, usage, latency_ms, .. } => {
                                let s = agg.touch_session(*session, now);
                                s.record_complete(model.clone(), *usage, *latency_ms, now);
                                Some(*session)
                            }
                            VitalsEvent::CallAbandoned { session, .. } => {
                                let s = agg.touch_session(*session, now);
                                s.in_flight = None;
                                Some(*session)
                            }
                            VitalsEvent::ActiveChanged { session } => {
                                agg.active = *session;
                                None
                            }
                            VitalsEvent::ExecutorContext { session, model, context_tokens } => {
                                let s = agg.touch_session(*session, now);
                                s.set_executor_context(model.clone(), *context_tokens);
                                Some(*session)
                            }
                        };
                        // Emit when either the event matched the active
                        // session (so the UI sees its own tab's update)
                        // OR when the active session itself changed
                        // (immediate re-render of the new tab's snapshot,
                        // including the empty/idle case).
                        let emit_now = match (&ev, agg.active) {
                            (VitalsEvent::ActiveChanged { .. }, _) => true,
                            (_, Some(active)) => touched_session == Some(active),
                            _ => false,
                        };
                        let payload = agg.active_snapshot(now);
                        (emit_now, payload)
                    };
                    if emit_now {
                        let _ = app_for_task.emit("vitals_update", &payload);
                    }
                }
                _ = tick.tick() => {
                    let payload = inner_for_task
                        .lock()
                        .await
                        .active_snapshot(now_unix_ms());
                    // Tick only emits when there's something to animate
                    // (in-flight elapsed) OR the cluster is still inside
                    // its visible window (advances idle_secs so the UI
                    // can fade exactly on 60s).
                    let should_emit = payload.in_flight.is_some()
                        || payload.idle_secs <= IDLE_THRESHOLD_SECS;
                    if should_emit {
                        let _ = app_for_task.emit("vitals_update", &payload);
                    }
                }
            }
        }
    });

    VitalsHandle { tx, inner }
}

/// Tauri command — the frontend calls this on every tab activation /
/// deactivation so the aggregator knows which session's vitals to emit.
#[tauri::command]
pub async fn set_active_session_for_vitals(
    handle: tauri::State<'_, VitalsHandle>,
    session_id: Option<String>,
) -> Result<(), String> {
    let parsed = match session_id {
        Some(s) => Some(s.parse::<SessionId>().map_err(|e| e.to_string())?),
        None => None,
    };
    handle.set_active(parsed);
    Ok(())
}

#[tauri::command]
pub async fn get_vitals(handle: tauri::State<'_, VitalsHandle>) -> Result<VitalsPayload, String> {
    Ok(handle.snapshot().await)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mk_usage(input: u32, output: u32, cache_creation: u32, cache_read: u32) -> TokenUsage {
        TokenUsage {
            input_tokens: input,
            output_tokens: output,
            cache_creation_input_tokens: cache_creation,
            cache_read_input_tokens: cache_read,
        }
    }

    #[test]
    fn tok_per_min_excludes_cache_read() {
        let mut s = VitalsState::new(0);
        s.record_complete(
            "claude-sonnet-4-6".into(),
            mk_usage(100, 50, 0, 10_000),
            42,
            0,
        );
        // cache_read=10_000 must NOT land in the bucket.
        let payload = s.snapshot(0);
        assert_eq!(payload.tok_per_min, 150);
    }

    #[test]
    fn bucket_rotation_drops_oldest() {
        let mut s = VitalsState::new(0);
        s.record_complete("m".into(), mk_usage(100, 0, 0, 0), 1, 0);
        // Advance 60 seconds → 12 buckets later → oldest (where we
        // recorded) must have rolled off.
        let payload = s.snapshot(60_000);
        assert_eq!(payload.tok_per_min, 0);
    }

    #[test]
    fn cache_hit_pct_zero_denominator_returns_none() {
        let s = VitalsState::new(0);
        assert!(s.cache_hit_pct().is_none());
    }

    #[test]
    fn cache_hit_pct_computed_correctly() {
        let mut s = VitalsState::new(0);
        s.record_complete("m".into(), mk_usage(100, 0, 0, 300), 1, 0);
        // read=300, input=100, creation=0 → 300 / 400 = 75%
        assert_eq!(s.cache_hit_pct(), Some(75));
    }

    #[test]
    fn cache_window_drops_old_entries() {
        let mut s = VitalsState::new(0);
        s.record_complete("m".into(), mk_usage(100, 0, 0, 100), 1, 0);
        // Snapshot at t=301s should purge the t=0 sample.
        let _ = s.snapshot(301_000);
        assert!(s.cache_window.is_empty());
    }

    #[test]
    fn idle_secs_advances() {
        let mut s = VitalsState::new(0);
        s.record_complete("m".into(), mk_usage(10, 10, 0, 0), 1, 0);
        let p1 = s.snapshot(30_000);
        assert_eq!(p1.idle_secs, 30);
        assert!(!p1.is_idle);
        let p2 = s.snapshot(65_000);
        assert_eq!(p2.idle_secs, 65);
        assert!(p2.is_idle);
    }

    #[test]
    fn in_flight_without_prior_completion_is_active() {
        let mut s = VitalsState::new(0);
        s.in_flight = Some(InFlight {
            model: "m".into(),
            started_unix_ms: 0,
        });
        let payload = s.snapshot(10_000);
        assert_eq!(payload.idle_secs, 0);
        assert!(!payload.is_idle);
        assert!(payload.in_flight.is_some());
    }

    #[test]
    fn context_window_unknown_until_a_reliable_source_exists() {
        // We refuse to guess Claude's 200k-vs-1M tier from the model id.
        assert_eq!(context_window("claude-opus-4-8", 50_000), None);
        assert_eq!(context_window("dynamic/balanced", 14_000), None);
    }

    #[test]
    fn executor_context_sets_tokens_pct_none_for_now() {
        let mut s = VitalsState::new(0);
        s.set_executor_context("claude-opus-4-8".into(), 171_280);
        let p = s.snapshot(0);
        assert_eq!(p.context_tokens, 171_280);
        // No reliable window → absolute tokens, no (possibly-wrong) %.
        assert_eq!(p.context_pct, None);
    }

    #[test]
    fn model_pill_prefers_executor_over_internal_calls() {
        let mut s = VitalsState::new(0);
        s.set_executor_context("claude-opus-4-8".into(), 50_000);
        // A background Covenant call on gpt-4o fires last...
        s.record_complete("gpt-4o".into(), mk_usage(200, 69, 0, 0), 1, 10);
        // ...but the pill still names the executor.
        let p = s.snapshot(10);
        assert_eq!(p.last_model.as_deref(), Some("claude-opus-4-8"));
    }

    #[test]
    fn model_pill_falls_back_when_no_executor() {
        let mut s = VitalsState::new(0);
        s.record_complete("gpt-4o".into(), mk_usage(200, 69, 0, 0), 1, 10);
        let p = s.snapshot(10);
        assert_eq!(p.last_model.as_deref(), Some("gpt-4o"));
    }

    #[test]
    fn internal_calls_do_not_touch_executor_context() {
        let mut s = VitalsState::new(0);
        s.set_executor_context("claude-opus-4-8".into(), 171_280);
        // An interleaved internal gpt-4o call must NOT overwrite the
        // executor's context number (the bug the screenshot caught).
        s.record_complete("gpt-4o".into(), mk_usage(200, 69, 0, 0), 1, 10);
        let p = s.snapshot(10);
        assert_eq!(p.context_tokens, 171_280);
    }

    #[test]
    fn executor_context_overwrites_on_compaction() {
        let mut s = VitalsState::new(0);
        s.set_executor_context("claude-opus-4-8".into(), 171_280);
        // Compaction drops the next prompt — gauge follows it down.
        s.set_executor_context("claude-opus-4-8".into(), 22_000);
        let p = s.snapshot(0);
        assert_eq!(p.context_tokens, 22_000);
    }

    #[test]
    fn call_handle_drop_sends_abandoned() {
        let (tx, mut rx) = broadcast::channel::<VitalsEvent>(8);
        let h = CallHandle {
            tx: tx.clone(),
            session: SessionId::new(),
            model: "m".into(),
            started_unix_ms: 0,
            consumed: false,
            executor: true,
        };
        drop(h);
        let recvd = rx.try_recv().expect("should have received an event");
        assert!(matches!(recvd, VitalsEvent::CallAbandoned { .. }));
    }

    #[test]
    fn call_handle_complete_does_not_send_abandoned() {
        let (tx, mut rx) = broadcast::channel::<VitalsEvent>(8);
        let h = CallHandle {
            tx: tx.clone(),
            session: SessionId::new(),
            model: "m".into(),
            started_unix_ms: 0,
            consumed: false,
            executor: true,
        };
        h.complete(mk_usage(10, 10, 0, 0), 50);
        // Expect exactly one CallCompleted, no CallAbandoned.
        let first = rx.try_recv().expect("first event");
        assert!(matches!(first, VitalsEvent::CallCompleted { .. }));
        assert!(rx.try_recv().is_err());
    }
}
