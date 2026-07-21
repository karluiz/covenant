//! Claude Code statusLine bridge — the *sustainable* source for an
//! interactive Claude session's context-fill / model / tokens.
//!
//! Claude Code 2.1 runs interactive sessions in a detached daemon and no
//! longer writes a real-time, tailable transcript to `~/.claude/projects`,
//! so the old jsonl-tailing (`exec_vitals`) can't see live data for it.
//! But Claude Code invokes a configured `statusLine` command on every
//! render (debounced 300ms) with a documented, stable JSON payload —
//! `model.display_name`, `context_window.used_percentage` (window-aware,
//! 200k vs 1M resolved at the source), `current_usage` token breakdown,
//! cost. That's a data contract, not the rendered TUI, so it survives
//! Claude UI churn.
//!
//! Covenant launches `claude` (via its shell wrapper) with `--settings`
//! pointing the statusLine at `covenant-statusline.sh`, which writes the
//! raw JSON to `~/.covenant/vitals/<COVENANT_TAB>.json` and chains the
//! user's original statusLine so their prompt is unchanged. This module
//! installs that helper, maps `COVENANT_TAB` tokens to `SessionId`s, and
//! polls the per-tab files to feed `VitalsHandle`.

#![allow(dead_code)]

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use karl_session::SessionId;
use serde::Deserialize;

use crate::vitals::VitalsHandle;

const POLL_INTERVAL: Duration = Duration::from_millis(700);

/// The bridge script, embedded so Covenant can install it without shipping
/// a separate file. Mirrors `shell-integration/covenant-statusline.sh`.
const HELPER_SCRIPT: &str = include_str!("../../../shell-integration/covenant-statusline.sh");

/// `~/.covenant`
fn covenant_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(".covenant"))
}

/// `~/.covenant/vitals`
fn vitals_dir() -> Option<PathBuf> {
    covenant_dir().map(|d| d.join("vitals"))
}

/// `~/.covenant/covenant-statusline.sh` — the path the shell wrapper points
/// Claude's statusLine at.
pub fn helper_path() -> Option<PathBuf> {
    covenant_dir().map(|d| d.join("covenant-statusline.sh"))
}

/// Shape of the fields we consume from Claude Code's statusLine JSON.
/// Everything else (git, pr, vim, effort, rate limits, ...) is ignored.
#[derive(Debug, Deserialize)]
struct StatusPayload {
    #[serde(default)]
    model: Model,
    #[serde(default)]
    context_window: ContextWindow,
}
#[derive(Debug, Default, Deserialize)]
struct Model {
    #[serde(default)]
    display_name: Option<String>,
    #[serde(default)]
    id: Option<String>,
}
#[derive(Debug, Default, Deserialize)]
struct ContextWindow {
    #[serde(default)]
    used_percentage: Option<f64>,
    #[serde(default)]
    current_usage: Usage,
}
#[derive(Debug, Default, Deserialize)]
struct Usage {
    #[serde(default)]
    input_tokens: u32,
    #[serde(default)]
    cache_read_input_tokens: u32,
    #[serde(default)]
    cache_creation_input_tokens: u32,
}

#[derive(Clone)]
pub struct ClaudeStatusline {
    inner: Arc<Inner>,
}

struct Inner {
    vitals: VitalsHandle,
    /// `COVENANT_TAB` token → Covenant `SessionId`. The token is minted at
    /// shell-spawn (before the SessionId exists) and registered once the
    /// session is created.
    tabs: Mutex<HashMap<String, SessionId>>,
}

impl ClaudeStatusline {
    pub fn new(vitals: VitalsHandle) -> Self {
        Self {
            inner: Arc::new(Inner {
                vitals,
                tabs: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// Write the bridge helper to `~/.covenant/covenant-statusline.sh` and
    /// make it executable. Idempotent; overwrites so updates ship.
    pub fn install_helper() {
        let Some(dir) = covenant_dir() else { return };
        let _ = std::fs::create_dir_all(dir.join("vitals"));
        let Some(path) = helper_path() else { return };
        if std::fs::write(&path, HELPER_SCRIPT).is_ok() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755));
            }
        }
    }

    /// Mint a fresh `COVENANT_TAB` token to inject into a shell's env.
    pub fn mint_tab_token() -> String {
        ulid::Ulid::new().to_string()
    }

    /// The user's existing statusLine command (from `~/.claude/settings.json`),
    /// so the helper can chain it and leave their prompt unchanged. `None`
    /// when they have no statusLine configured.
    pub fn user_statusline_command() -> Option<String> {
        let path = dirs::home_dir()?.join(".claude").join("settings.json");
        let txt = std::fs::read_to_string(path).ok()?;
        let v: serde_json::Value = serde_json::from_str(&txt).ok()?;
        v.get("statusLine")?
            .get("command")?
            .as_str()
            .map(|s| s.to_string())
    }

    pub fn register(&self, token: String, session: SessionId) {
        if let Ok(mut m) = self.inner.tabs.lock() {
            m.insert(token, session);
        }
    }

    pub fn unregister(&self, session: SessionId) {
        if let Ok(mut m) = self.inner.tabs.lock() {
            m.retain(|token, &mut s| {
                if s == session {
                    if let Some(dir) = vitals_dir() {
                        let _ = std::fs::remove_file(dir.join(format!("{token}.json")));
                    }
                    false
                } else {
                    true
                }
            });
        }
    }

    /// Spawn the poll loop that reads each registered tab's vitals file and
    /// feeds `VitalsHandle`. One task for all tabs.
    pub fn spawn_watcher(&self) {
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            // token → last-seen mtime, so we only parse on change.
            let mut seen: HashMap<String, SystemTime> = HashMap::new();
            let mut interval = tokio::time::interval(POLL_INTERVAL);
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            let Some(dir) = vitals_dir() else { return };
            loop {
                interval.tick().await;
                let snapshot: Vec<(String, SessionId)> = match inner.tabs.lock() {
                    Ok(m) => m.iter().map(|(t, s)| (t.clone(), *s)).collect(),
                    Err(_) => continue,
                };
                for (token, session) in snapshot {
                    let path = dir.join(format!("{token}.json"));
                    let Ok(meta) = std::fs::metadata(&path) else {
                        continue;
                    };
                    let Ok(mtime) = meta.modified() else { continue };
                    if seen.get(&token) == Some(&mtime) {
                        continue;
                    }
                    seen.insert(token.clone(), mtime);
                    let Ok(txt) = std::fs::read_to_string(&path) else {
                        continue;
                    };
                    let Ok(p) = serde_json::from_str::<StatusPayload>(&txt) else {
                        continue;
                    };
                    feed(&inner.vitals, session, p);
                }
            }
        });
    }
}

fn feed(vitals: &VitalsHandle, session: SessionId, p: StatusPayload) {
    let model = p
        .model
        .display_name
        .or(p.model.id)
        .unwrap_or_else(|| "claude".to_string());
    let u = &p.context_window.current_usage;
    let tokens = u
        .input_tokens
        .saturating_add(u.cache_read_input_tokens)
        .saturating_add(u.cache_creation_input_tokens);
    match p.context_window.used_percentage {
        Some(pct) => {
            let pct = pct.round().clamp(0.0, 100.0) as u8;
            vitals.record_executor_context_pct(session, model, tokens, pct);
        }
        None => vitals.record_executor_context(session, model, tokens),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_claude_statusline_payload() {
        let json = r#"{
            "model": {"display_name": "Opus 4.8", "id": "claude-opus-4-8"},
            "context_window": {
                "used_percentage": 17.4,
                "context_window_size": 1000000,
                "current_usage": {
                    "input_tokens": 1200,
                    "cache_read_input_tokens": 168000,
                    "cache_creation_input_tokens": 2000,
                    "output_tokens": 50
                }
            }
        }"#;
        let p: StatusPayload = serde_json::from_str(json).unwrap();
        assert_eq!(p.model.display_name.as_deref(), Some("Opus 4.8"));
        assert_eq!(p.context_window.used_percentage, Some(17.4));
        assert_eq!(
            p.context_window.current_usage.cache_read_input_tokens,
            168000
        );
        // tokens = 1200 + 168000 + 2000
        let u = &p.context_window.current_usage;
        let tokens = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
        assert_eq!(tokens, 171_200);
    }

    #[test]
    fn tolerates_missing_fields() {
        let p: StatusPayload = serde_json::from_str("{}").unwrap();
        assert!(p.model.display_name.is_none());
        assert!(p.context_window.used_percentage.is_none());
    }
}
