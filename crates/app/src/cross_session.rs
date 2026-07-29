//! Cross-session pattern watcher.
//!
//! Subscribes to every active session's broadcast bus. After a failure
//! in any session (debounced 1.5s), assembles a snapshot of all open
//! sessions — each one's summary plus its most recent blocks — and asks
//! `claude-sonnet-4-6` whether any cross-tab pattern is worth flagging
//! to the user. Findings are emitted as a global Tauri event the
//! frontend renders as a toast.
//!
//! Rate-limited 6 checks/minute globally. False-positives erode trust,
//! so the system prompt explicitly biases toward "(none)".

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_session::{SessionEvent, SessionId};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::sync::{broadcast, mpsc, Mutex};

use crate::settings::Settings;
use crate::world::SessionWorldModel;

const DEBOUNCE: Duration = Duration::from_millis(1500);
const MAX_CHECKS_PER_MINUTE: usize = 6;
const FINDING_EVENT_NAME: &str = "cross-session-finding";

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

/// Payload emitted to the frontend when a finding lands. Plain JSON.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrossSessionFinding {
    pub message: String,
    pub timestamp_unix_ms: u64,
}

/// Public handle. Hand one to `lib.rs`'s setup() and call `attach()`
/// from inside `spawn_session` for every new session.
#[derive(Clone)]
pub struct CrossSessionWatcher {
    inner: Arc<Mutex<Inner>>,
    incoming_tx: mpsc::UnboundedSender<(SessionId, SessionEvent)>,
}

struct Inner {
    /// Live world models. Updated via Arc — the watcher just reads them
    /// when building context. Removed when the corresponding session's
    /// bus closes.
    worlds: HashMap<SessionId, Arc<Mutex<SessionWorldModel>>>,
}

impl CrossSessionWatcher {
    pub fn spawn(
        app: AppHandle,
        settings: Arc<Mutex<Settings>>,
        vitals: crate::vitals::VitalsHandle,
    ) -> Self {
        let inner = Arc::new(Mutex::new(Inner {
            worlds: HashMap::new(),
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
                            "cross-session forwarder lagged"
                        );
                    }
                }
            }
            inner_for_drop.lock().await.worlds.remove(&session_id);
            tracing::debug!(session = %session_id, "cross-session forwarder exited");
        });
    }
}

async fn watch_loop(
    inner: Arc<Mutex<Inner>>,
    settings: Arc<Mutex<Settings>>,
    app: AppHandle,
    mut incoming_rx: mpsc::UnboundedReceiver<(SessionId, SessionEvent)>,
    vitals: crate::vitals::VitalsHandle,
) {
    let mut last_failure_at: Option<(Instant, SessionId)> = None;
    let mut rate = SimpleRate::new(MAX_CHECKS_PER_MINUTE, Duration::from_secs(60));

    loop {
        tokio::select! {
            biased;

            event = incoming_rx.recv() => {
                let Some((session_id, event)) = event else { return };
                if let SessionEvent::BlockFinished {
                    exit_code: Some(code),
                    ..
                } = event
                {
                    if code != 0 {
                        last_failure_at = Some((Instant::now(), session_id));
                    }
                }
            }

            _ = wait_until_debounce(last_failure_at.map(|(t, _)| t)) => {
                let trigger = last_failure_at.take();
                if !rate.try_acquire() {
                    tracing::debug!("cross-session rate-limited");
                    continue;
                }
                if let Some((_, trigger_id)) = trigger {
                    if let Err(e) =
                        check_for_pattern(&inner, &settings, &app, trigger_id, &vitals).await
                    {
                        tracing::warn!(error = %e, "cross-session check failed");
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
    trigger_id: SessionId,
    vitals: &crate::vitals::VitalsHandle,
) -> Result<(), String> {
    // Snapshot state without holding any lock across the http call.
    let resolved = {
        let s = settings.lock().await;
        match crate::provider_resolve::resolve_route(&s, crate::settings::Role::Chat) {
            Ok(r) => r,
            Err(_) => return Ok(()),
        }
    };

    // Need at least 2 sessions to find a CROSS-session pattern. Single-
    // session findings are the M4 fix-proposer's job.
    let snapshots = {
        let i = inner.lock().await;
        if i.worlds.len() < 2 {
            tracing::debug!(sessions = i.worlds.len(), "skipping cross-session check");
            return Ok(());
        }

        let mut entries: Vec<(SessionId, Arc<Mutex<SessionWorldModel>>)> =
            i.worlds.iter().map(|(k, v)| (*k, v.clone())).collect();
        // Sort for stable presentation (oldest Ulid first ≈ session 1).
        entries.sort_by_key(|(id, _)| id.0);
        entries
    };

    let user_msg = build_snapshot_message(&snapshots, trigger_id, "failed").await;

    let started = Instant::now();
    let req = karl_agent::AskRequest {
        api_key: String::new(),
        model: resolved.model.clone(),
        system_prompt: SYSTEM_PROMPT.to_string(),
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
        "cross-session check complete"
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

    let finding = CrossSessionFinding {
        message,
        timestamp_unix_ms: now_ms(),
    };
    if let Err(e) = app.emit(FINDING_EVENT_NAME, &finding) {
        tracing::warn!(error = ?e, "failed to emit cross-session finding");
    } else {
        tracing::info!(finding = %finding.message, "cross-session finding emitted");
    }

    Ok(())
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

fn position_of(
    snapshots: &[(SessionId, Arc<Mutex<SessionWorldModel>>)],
    target: SessionId,
) -> Option<usize> {
    snapshots.iter().position(|(id, _)| *id == target)
}

/// Render the "Open sessions snapshot" block shared by both watchers: a
/// numbered list of session summaries + recent blocks, with `trigger_id`
/// flagged as the one that just failed. Extracted so `group_supervision`
/// doesn't duplicate the formatting — the *architecture* (watch loop, rate
/// limiting, prompt framing) still diverges per-watcher by design.
/// `trigger_verb` is what the trigger session just did — "failed",
/// "went idle". It drives both the header and the per-session marker:
/// group-supervision reuses this builder for an IDLE trigger, and
/// hardcoding "JUST FAILED" told the model a perfectly healthy executor
/// tab had failed, which it then dutifully toasted.
pub(crate) async fn build_snapshot_message(
    snapshots: &[(SessionId, Arc<Mutex<SessionWorldModel>>)],
    trigger_id: SessionId,
    trigger_verb: &str,
) -> String {
    let mut user_msg = String::with_capacity(4096);
    user_msg.push_str("# Open sessions snapshot\n");
    user_msg.push_str(&format!(
        "(triggered by session {n}, which just {trigger_verb})\n\n",
        n = position_of(snapshots, trigger_id)
            .map(|p| (p + 1).to_string())
            .unwrap_or_else(|| trigger_id.to_string())
    ));

    for (i, (session_id, world)) in snapshots.iter().enumerate() {
        let w = world.lock().await;
        user_msg.push_str(&format!(
            "## Session {n} {is_trigger}\n",
            n = i + 1,
            is_trigger = if *session_id == trigger_id {
                format!("(JUST {})", trigger_verb.to_uppercase())
            } else {
                String::new()
            }
        ));
        if !w.cwd.as_os_str().is_empty() {
            user_msg.push_str(&format!("cwd: {}\n", w.cwd.display()));
        }
        if let Some(summary) = &w.summary {
            user_msg.push_str("summary:\n");
            user_msg.push_str(summary.trim());
            user_msg.push_str("\n\n");
        }
        if !w.blocks.is_empty() {
            user_msg.push_str("recent blocks (last 5):\n");
            for b in w.blocks.iter().rev().take(5).rev() {
                let exit = b
                    .exit_code
                    .map(|c| c.to_string())
                    .unwrap_or_else(|| "?".to_string());
                // `[prior session]` matters as much as the exit code: a
                // tab seeds its world model from this cwd's history, so
                // an `exit 1` from LAST WEEK sits in "recent blocks" and
                // reads as a live failure unless it says otherwise.
                let prior = if b.inherited { " [prior session]" } else { "" };
                user_msg.push_str(&format!(
                    "  $ {cmd}    [exit {exit}, {dur}ms]{prior}\n",
                    cmd = b.command,
                    dur = b.duration_ms,
                ));
            }
        }
        user_msg.push('\n');
    }
    user_msg
}

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) struct SimpleRate {
    max: usize,
    window: Duration,
    bucket: Vec<Instant>,
}

impl SimpleRate {
    pub(crate) fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            bucket: Vec::with_capacity(max),
        }
    }

    pub(crate) fn try_acquire(&mut self) -> bool {
        let now = Instant::now();
        self.bucket.retain(|&t| now.duration_since(t) < self.window);
        if self.bucket.len() < self.max {
            self.bucket.push(now);
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_finding() {
        assert_eq!(
            parse_finding("FINDING: tab 2 fails on src/foo.rs that you edited in tab 1"),
            Some("tab 2 fails on src/foo.rs that you edited in tab 1".to_string())
        );
    }

    #[test]
    fn parses_finding_with_extra_lines() {
        let txt = "\nFINDING:   port 5432 in use across tabs   \n\n";
        assert_eq!(
            parse_finding(txt),
            Some("port 5432 in use across tabs".to_string())
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

    /// The bug that made a supervised executor tab get toasted as
    /// "session 3 failed `claude ...`": an IDLE trigger rendered its own
    /// tab as JUST FAILED, and a block inherited from the cwd's history
    /// looked live.
    #[tokio::test]
    async fn idle_trigger_is_not_labelled_failed_and_prior_blocks_say_so() {
        let sid = SessionId::new();
        let mut w = SessionWorldModel::default();
        w.seed_history(
            vec![crate::world::BlockSnapshot {
                command: "claude --dangerously-skip-permissions".into(),
                cwd: std::path::PathBuf::from("/tmp"),
                exit_code: Some(1),
                duration_ms: 5000,
                output_text: String::new(),
                inherited: true,
            }],
            None,
        );
        let snaps = vec![(sid, Arc::new(Mutex::new(w)))];

        let msg = build_snapshot_message(&snaps, sid, "went idle").await;
        assert!(msg.contains("just went idle"), "{msg}");
        assert!(msg.contains("(JUST WENT IDLE)"), "{msg}");
        assert!(!msg.contains("FAILED"), "{msg}");
        assert!(msg.contains("[prior session]"), "{msg}");

        let msg = build_snapshot_message(&snaps, sid, "failed").await;
        assert!(msg.contains("(JUST FAILED)"), "{msg}");
    }

    #[test]
    fn rate_caps_at_max() {
        let mut r = SimpleRate::new(2, Duration::from_secs(60));
        assert!(r.try_acquire());
        assert!(r.try_acquire());
        assert!(!r.try_acquire());
    }
}
