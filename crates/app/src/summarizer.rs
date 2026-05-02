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

use crate::settings::Settings;
use crate::storage::Storage;
use crate::world::SessionWorldModel;

const DEBOUNCE: Duration = Duration::from_millis(500);
const SUMMARY_MAX_TOKENS: u32 = 700;

const SUMMARY_SYSTEM_PROMPT: &str = "\
You maintain a rolling summary of a single shell session for an AI \
super-agent. You will be given the previous summary plus the current \
block history and must output a fresh summary that supersedes both.

Rules:
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
) {
    tauri::async_runtime::spawn(run_loop(session_id, world, settings, storage, bus));
}

async fn run_loop(
    session_id: SessionId,
    world: Arc<Mutex<SessionWorldModel>>,
    settings: Arc<Mutex<Settings>>,
    storage: Storage,
    mut bus: broadcast::Receiver<SessionEvent>,
) {
    let mut last_block_at: Option<Instant> = None;

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
                if let Err(e) = regenerate(session_id, &world, &settings, &storage).await {
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
) -> Result<(), String> {
    // Snapshot inputs without holding any locks across the http call.
    let (api_key, model) = {
        let s = settings.lock().await;
        let key = match s.anthropic_api_key.clone() {
            Some(k) if !k.trim().is_empty() => k,
            _ => return Ok(()), // no key → silently skip
        };
        (key, s.agent.model_summary.clone())
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
    let summary = karl_agent::ask_oneshot(karl_agent::AskRequest {
        api_key,
        model,
        system_prompt: SUMMARY_SYSTEM_PROMPT.to_string(),
        user_message,
        max_tokens: SUMMARY_MAX_TOKENS,
    })
    .await
    .map_err(|e| e.to_string())?;

    let trimmed = summary.trim().to_string();
    let tokens_estimate = trimmed.len() / 4;

    let updated_at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Err(e) = storage
        .save_summary(session_id, trimmed.clone(), updated_at)
        .await
    {
        tracing::warn!(error = %e, "failed to persist summary");
    }

    world.lock().await.summary = Some(trimmed);
    tracing::info!(
        session = %session_id,
        latency_ms = started.elapsed().as_millis() as u64,
        tokens_estimate,
        "summary refreshed"
    );

    Ok(())
}
