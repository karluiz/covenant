//! Per-session rolling summary generator.
//!
//! Subscribes to a session's broadcast bus and, debounced ~500ms after
//! the most recent `BlockFinished`, calls `claude-sonnet-4-6` (or
//! whatever `settings.agent.model_summary` is) to refresh the summary
//! held inside the [`SessionWorldModel`]. The summary is then sent
//! instead of the raw block list when the user invokes ⌘K, which
//! keeps the user-message size flat regardless of session length.
//!
//! Failure modes degrade gracefully:
//!   - missing api key → skip silently (no summary, agent falls back to
//!     raw blocks).
//!   - api / network error → log warn, try again on the next block.
//!   - bus lag → log warn, keep going; blocks we missed are still in
//!     the world model since the world's own subscriber populated them.

use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use karl_session::{SessionEvent, SessionId};
use tokio::sync::{broadcast, Mutex};

use crate::provider_resolve::{resolve_route, ResolveError};
use crate::settings::{Role, Settings};
use crate::storage::Storage;
use crate::world::SessionWorldModel;

const DEBOUNCE: Duration = Duration::from_millis(500);
const SUMMARY_MAX_TOKENS: u32 = 700;

const SUMMARY_SYSTEM_PROMPT: &str = "\
You maintain a rolling summary of a single shell session for an AI \
super-agent. You will be given the previous summary plus the current \
block history and must output a fresh summary that supersedes both.

Rules:
- Your FIRST line must be exactly `TITLE: <label>` where <label> is at \
  most 2 lowercase words naming the current activity (e.g. `release prep`, \
  `debugging auth`, `tab titles`). If nothing meaningful has happened, \
  leave it empty: `TITLE:`. Then a blank line, then the summary body \
  following the rules below.
- Output the new summary text only. No preamble, no markdown headings, \
  no code fences, no bullet titles like 'Summary:'.
- Stay under ~400 tokens. Drop redundant detail. Compress chronological \
  noise into themes.
- Focus on: what the user is working on, recent failures or notable \
  outcomes, files / projects / tools in play, open questions or stuck \
  points the agent should remember.
- If nothing meaningful has happened (only `ls` / `pwd` / `cd`), say so \
  in one sentence — do not pad.";

pub fn spawn_loop(
    session_id: SessionId,
    world: Arc<Mutex<SessionWorldModel>>,
    settings: Arc<Mutex<Settings>>,
    storage: Storage,
    bus: broadcast::Receiver<SessionEvent>,
    bus_tx: broadcast::Sender<SessionEvent>,
    vitals: crate::vitals::VitalsHandle,
) {
    tauri::async_runtime::spawn(run_loop(session_id, world, settings, storage, bus, bus_tx, vitals));
}

async fn run_loop(
    session_id: SessionId,
    world: Arc<Mutex<SessionWorldModel>>,
    settings: Arc<Mutex<Settings>>,
    storage: Storage,
    mut bus: broadcast::Receiver<SessionEvent>,
    bus_tx: broadcast::Sender<SessionEvent>,
    vitals: crate::vitals::VitalsHandle,
) {
    let mut last_block_at: Option<Instant> = None;
    let mut last_title: Option<String> = None;

    loop {
        tokio::select! {
            biased;

            event = bus.recv() => {
                match event {
                    Ok(SessionEvent::BlockFinished { .. }) => {
                        last_block_at = Some(Instant::now());
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Closed) => {
                        tracing::debug!(session = %session_id, "summarizer exiting (bus closed)");
                        return;
                    }
                    Err(broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(session = %session_id, skipped = n, "summarizer lagged");
                    }
                }
            }

            _ = wait_until_debounce(last_block_at) => {
                last_block_at = None;
                if let Err(e) = regenerate(session_id, &world, &settings, &storage, &bus_tx, &mut last_title, &vitals).await {
                    tracing::warn!(
                        session = %session_id,
                        error = %e,
                        "summary regen failed (degrading to raw blocks until next try)"
                    );
                }
            }
        }
    }
}

/// Sleeps until DEBOUNCE has elapsed since `last`. If `last` is None,
/// blocks forever (the select! arm never fires until a block lands).
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

async fn regenerate(
    session_id: SessionId,
    world: &Arc<Mutex<SessionWorldModel>>,
    settings: &Arc<Mutex<Settings>>,
    storage: &Storage,
    bus_tx: &broadcast::Sender<SessionEvent>,
    last_title: &mut Option<String>,
    vitals: &crate::vitals::VitalsHandle,
) -> Result<(), String> {
    // Snapshot inputs without holding any locks across the http call.
    let resolved = {
        let s = settings.lock().await;
        match resolve_route(&s, Role::Summary) {
            Ok(r) => r,
            Err(ResolveError::NoRoute(_)) => return Ok(()), // no route → silently skip
            Err(e) => {
                tracing::warn!(?e, "summary: provider unavailable, skipping");
                return Ok(());
            }
        }
    };

    let (prev_summary, blocks_text) = {
        let w = world.lock().await;
        if w.blocks.is_empty() {
            return Ok(()); // nothing to summarize
        }
        let mut blocks_text = String::with_capacity(2048);
        for (i, b) in w.blocks.iter().enumerate() {
            let exit = b
                .exit_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".to_string());
            blocks_text.push_str(&format!(
                "\n--- block {idx} ---\n\
                 $ {cmd}\n\
                 cwd:   {cwd}\n\
                 exit:  {exit}    duration: {dur}ms\n",
                idx = i + 1,
                cmd = b.command,
                cwd = b.cwd.display(),
                dur = b.duration_ms,
            ));
            if !b.output_text.trim().is_empty() {
                blocks_text.push_str("output:\n");
                blocks_text.push_str(&b.output_text);
                if !b.output_text.ends_with('\n') {
                    blocks_text.push('\n');
                }
            }
        }
        (w.summary.clone().unwrap_or_default(), blocks_text)
    };

    let user_message = format!(
        "# Previous summary\n{prev}\n\n# Current block history (oldest first)\n{blocks}",
        prev = if prev_summary.is_empty() {
            "(none — this is the first summary for this session)"
        } else {
            &prev_summary
        },
        blocks = blocks_text,
    );

    let started = Instant::now();
    let req = karl_agent::AskRequest {
        api_key: String::new(), // unused on the trait path
        model: resolved.model.clone(),
        system_prompt: SUMMARY_SYSTEM_PROMPT.to_string(),
        user_message,
        max_tokens: SUMMARY_MAX_TOKENS,
        thinking_budget: None,
        force_tool: None,
    };
    let model_for_vitals = req.model.clone();
    let resp = karl_agent::provider::collect_oneshot(&*resolved.provider, req)
        .await
        .map_err(|e| e.to_string())?;
    let usage = resp.usage;

    let (title, summary) = split_title(&resp.text);
    // `summary` is already trimmed by split_title

    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    if !summary.is_empty() {
        // Full response: persist both summary + title, update world.
        let tokens_estimate = summary.len() / 4;
        if let Err(e) = storage
            .save_summary(session_id, summary.clone(), title.clone(), updated_at)
            .await
        {
            tracing::warn!(error = %e, "failed to persist summary");
        }
        {
            let mut w = world.lock().await;
            w.summary = Some(summary.clone());
            if !title.is_empty() {
                w.title = Some(title.clone());
            }
        }
        let _ = tokens_estimate; // used implicitly via tracing below
        tracing::debug!(session = %session_id, tokens_estimate, "summary body persisted");
    } else {
        // Degenerate title-only response: save title without clobbering the
        // existing stored summary. Load what we have, re-save with new title.
        let existing_summary = storage
            .load_summary(session_id)
            .await
            .ok()
            .flatten()
            .map(|(s, _)| s)
            .unwrap_or_default();
        if let Err(e) = storage
            .save_summary(session_id, existing_summary, title.clone(), updated_at)
            .await
        {
            tracing::warn!(error = %e, "failed to persist title (summary preserved)");
        }
        {
            let mut w = world.lock().await;
            if !title.is_empty() {
                w.title = Some(title.clone());
            }
            // Do NOT touch w.summary — keep the previous good summary.
        }
        tracing::debug!(session = %session_id, "title-only response; summary preserved");
    }

    let tokens_estimate = summary.len() / 4;

    if !title.is_empty() && last_title.as_deref() != Some(title.as_str()) {
        let _ = bus_tx.send(SessionEvent::TitleSuggested {
            session: session_id,
            title: title.clone(),
        });
        *last_title = Some(title);
    }

    let latency_ms = started.elapsed().as_millis();
    tracing::info!(
        session = %session_id,
        latency_ms = latency_ms as u64,
        tokens_estimate,
        "summary refreshed"
    );
    vitals.record_complete(session_id, model_for_vitals, usage, latency_ms as u32);

    Ok(())
}

/// Split a summarizer response into (title, summary). The model is asked
/// to make its first line `TITLE: <label>`. If absent, title is empty and
/// the whole text is the summary (back-compat).
fn split_title(raw: &str) -> (String, String) {
    let raw = raw.trim_start();
    if let Some(rest) = raw.strip_prefix("TITLE:") {
        let mut lines = rest.splitn(2, '\n');
        let title = lines.next().unwrap_or("").trim().to_string();
        let summary = lines.next().unwrap_or("").trim().to_string();
        (title, summary)
    } else {
        (String::new(), raw.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::split_title;

    #[test]
    fn parses_title_sentinel() {
        let (t, s) = split_title("TITLE: release prep\n\nUser cut a release.");
        assert_eq!(t, "release prep");
        assert_eq!(s, "User cut a release.");
    }

    #[test]
    fn missing_sentinel_yields_empty_title() {
        let (t, s) = split_title("Just a summary, no title line.");
        assert_eq!(t, "");
        assert_eq!(s, "Just a summary, no title line.");
    }
}
