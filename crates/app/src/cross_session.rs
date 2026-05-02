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
    pub fn spawn(app: AppHandle, settings: Arc<Mutex<Settings>>) -> Self {
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
        self.inner
            .lock()
            .await
            .worlds
            .insert(session_id, world);

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
                        check_for_pattern(&inner, &settings, &app, trigger_id).await
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
) -> Result<(), String> {
    // Snapshot state without holding any lock across the http call.
    let (api_key, model) = {
        let s = settings.lock().await;
        let key = match s.anthropic_api_key.clone() {
            Some(k) if !k.trim().is_empty() => k,
            _ => return Ok(()),
        };
        (key, s.agent.model_summary.clone())
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

    let mut user_msg = String::with_capacity(4096);
    user_msg.push_str("# Open sessions snapshot\n");
    user_msg.push_str(&format!(
        "(triggered by failure in session {})\n\n",
        position_of(&snapshots, trigger_id)
            .map(|p| (p + 1).to_string())
            .unwrap_or_else(|| trigger_id.to_string())
    ));

    for (i, (session_id, world)) in snapshots.iter().enumerate() {
        let w = world.lock().await;
        user_msg.push_str(&format!(
            "## Session {n} {is_trigger}\n",
            n = i + 1,
            is_trigger = if *session_id == trigger_id {
                "(JUST FAILED)"
            } else {
                ""
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
                user_msg.push_str(&format!(
                    "  $ {cmd}    [exit {exit}, {dur}ms]\n",
                    cmd = b.command,
                    dur = b.duration_ms,
                ));
            }
        }
        user_msg.push('\n');
    }

    let started = Instant::now();
    let response = karl_agent::ask_oneshot(karl_agent::AskRequest {
        api_key,
        model,
        system_prompt: SYSTEM_PROMPT.to_string(),
        user_message: user_msg,
        max_tokens: 180,
    })
    .await
    .map_err(|e| e.to_string())?;

    tracing::info!(
        latency_ms = started.elapsed().as_millis() as u64,
        "cross-session check complete"
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

fn now_ms() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct SimpleRate {
    max: usize,
    window: Duration,
    bucket: Vec<Instant>,
}

impl SimpleRate {
    fn new(max: usize, window: Duration) -> Self {
        Self {
            max,
            window,
            bucket: Vec::with_capacity(max),
        }
    }

    fn try_acquire(&mut self) -> bool {
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

    #[test]
    fn rate_caps_at_max() {
        let mut r = SimpleRate::new(2, Duration::from_secs(60));
        assert!(r.try_acquire());
        assert!(r.try_acquire());
        assert!(!r.try_acquire());
    }
}
