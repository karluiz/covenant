//! Auto-suggest a fix for any block that exits non-zero.
//!
//! Subscribes to a session's broadcast bus and, on every
//! `BlockFinished` with `exit_code: Some(n) where n != 0`, calls the
//! summary model (`claude-sonnet-4-6` by default) for a one-line shell
//! fix plus a short rationale. Successful suggestions are republished
//! on the same bus as `SessionEvent::FixSuggested`, so the UI relay
//! task — and any future autonomous-execution policy in M6 — picks them
//! up via the same plumbing as everything else.
//!
//! SuggestOnly: the bus event carries a command string only, never an
//! Execute. Acting on it is the user's choice (M4 frontend writes the
//! suggestion into the PTY without trailing newline; the user reviews
//! and presses Enter).
//!
//! Failure modes degrade silently:
//!   - missing api key → no call, no event.
//!   - api / network error → log warn, skip.
//!   - rate exceeded (30/min/session) → drop.
//!   - model returns "(no suggestion)" → drop.

use std::path::Path;
use std::sync::Arc;
use std::time::{Duration, Instant};

use karl_session::{SessionEvent, SessionId};
use tokio::sync::{broadcast, Mutex};

use crate::settings::Settings;

const MAX_SUGGESTIONS_PER_MINUTE: usize = 30;
const SUGGEST_MAX_TOKENS: u32 = 220;

const FIX_SYSTEM_PROMPT: &str = "\
A shell command just failed. Output the most likely fix in EXACTLY this format, nothing else:

FIX: <one shell command>
WHY: <one short sentence, under 100 chars>

Rules:
- The FIX must be a single shell command, runnable as-is.
- No backticks, no leading $, no markdown.
- If you have no confident suggestion, output: FIX: (no suggestion)
- Prefer fixes obvious from the error output (typo, missing arg, wrong cwd, missing dep).
- Do NOT include any other lines, explanations, or trailing prose.";

pub fn spawn_loop(
    session_id: SessionId,
    settings: Arc<Mutex<Settings>>,
    bus_rx: broadcast::Receiver<SessionEvent>,
    bus_tx: broadcast::Sender<SessionEvent>,
    vitals: crate::vitals::VitalsHandle,
) {
    tokio::spawn(run_loop(session_id, settings, bus_rx, bus_tx, vitals));
}

async fn run_loop(
    session_id: SessionId,
    settings: Arc<Mutex<Settings>>,
    mut bus_rx: broadcast::Receiver<SessionEvent>,
    bus_tx: broadcast::Sender<SessionEvent>,
    vitals: crate::vitals::VitalsHandle,
) {
    let mut rate = SimpleRate::new(MAX_SUGGESTIONS_PER_MINUTE, Duration::from_secs(60));

    loop {
        match bus_rx.recv().await {
            Ok(SessionEvent::BlockFinished {
                block,
                command,
                cwd,
                exit_code: Some(code),
                output_text,
                ..
            }) if code != 0 => {
                if !rate.try_acquire() {
                    tracing::debug!(
                        session = %session_id,
                        "fix-proposer rate-limited, dropping suggestion"
                    );
                    continue;
                }

                match propose_fix(&settings, &command, &cwd, code, &output_text, &vitals).await {
                    Ok(Some((fix_cmd, why))) => {
                        let _ = bus_tx.send(SessionEvent::FixSuggested {
                            session: session_id,
                            block,
                            command: fix_cmd,
                            rationale: why,
                        });
                    }
                    Ok(None) => {
                        tracing::debug!(
                            session = %session_id,
                            block = %block,
                            "no fix suggested for failed command"
                        );
                    }
                    Err(e) => {
                        tracing::warn!(
                            session = %session_id,
                            block = %block,
                            error = %e,
                            "propose_fix failed"
                        );
                    }
                }
            }
            Ok(_) => {}
            Err(broadcast::error::RecvError::Closed) => return,
            Err(broadcast::error::RecvError::Lagged(n)) => {
                tracing::warn!(session = %session_id, skipped = n, "fix-proposer lagged");
            }
        }
    }
}

async fn propose_fix(
    settings: &Arc<Mutex<Settings>>,
    command: &str,
    cwd: &Path,
    exit_code: i32,
    output: &str,
    vitals: &crate::vitals::VitalsHandle,
) -> Result<Option<(String, String)>, String> {
    // Snapshot what we need without holding the lock across the http call.
    let resolved = {
        let s = settings.lock().await;
        match crate::provider_resolve::resolve_route(&s, crate::settings::Role::Chat) {
            Ok(r) => r,
            Err(_) => return Ok(None), // no provider → silently skip
        }
    };

    let user_msg = format!(
        "cwd: {cwd}\n\
         command: {cmd}\n\
         exit code: {code}\n\
         output:\n{out}\n",
        cwd = cwd.display(),
        cmd = command,
        code = exit_code,
        out = truncate(output, 1500),
    );

    let started = Instant::now();
    let req = karl_agent::AskRequest {
        api_key: String::new(),
        model: resolved.model.clone(),
        system_prompt: FIX_SYSTEM_PROMPT.to_string(),
        user_message: user_msg,
        max_tokens: SUGGEST_MAX_TOKENS,
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
        "fix proposal generated"
    );
    vitals.record_complete(model_for_vitals, usage, started.elapsed().as_millis() as u32);

    Ok(parse_response(&response))
}

fn parse_response(text: &str) -> Option<(String, String)> {
    let mut fix: Option<String> = None;
    let mut why: Option<String> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("FIX:") {
            fix = Some(rest.trim().to_string());
        } else if let Some(rest) = line.strip_prefix("WHY:") {
            why = Some(rest.trim().to_string());
        }
    }
    let fix = fix?;
    if fix.is_empty()
        || fix.eq_ignore_ascii_case("(no suggestion)")
        || fix.eq_ignore_ascii_case("no suggestion")
    {
        return None;
    }
    Some((fix, why.unwrap_or_default()))
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cut: String = s.chars().take(max).collect();
        format!("{cut}…[truncated]")
    }
}

/// Bare-bones sliding-window counter. Not contention-tuned — a single
/// fix-proposer task owns the only instance per session.
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
        self.bucket
            .retain(|&t| now.duration_since(t) < self.window);
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
    fn parses_typical_response() {
        let txt = "FIX: cargo build\nWHY: run from a Rust project root";
        assert_eq!(
            parse_response(txt),
            Some((
                "cargo build".to_string(),
                "run from a Rust project root".to_string()
            ))
        );
    }

    #[test]
    fn parses_with_extra_whitespace() {
        let txt = "  FIX:   ls -la  \n  WHY:    list files including hidden\n\n";
        assert_eq!(
            parse_response(txt),
            Some((
                "ls -la".to_string(),
                "list files including hidden".to_string()
            ))
        );
    }

    #[test]
    fn drops_no_suggestion() {
        assert!(parse_response("FIX: (no suggestion)\nWHY: unclear failure").is_none());
        assert!(parse_response("FIX: no suggestion\nWHY: x").is_none());
    }

    #[test]
    fn missing_fix_returns_none() {
        assert!(parse_response("WHY: alone").is_none());
    }

    #[test]
    fn rate_limiter_rejects_after_max() {
        let mut r = SimpleRate::new(3, Duration::from_secs(60));
        assert!(r.try_acquire());
        assert!(r.try_acquire());
        assert!(r.try_acquire());
        assert!(!r.try_acquire());
    }
}
