//! Settings persistence for karl-terminal.
//!
//! Stored as JSON at `<config_dir>/config.json` where `<config_dir>` is
//! Tauri's per-app `app_config_dir` (on macOS:
//! `~/Library/Application Support/com.karluiz.karl-terminal/`).
//!
//! Writes are atomic (tmp file + rename) and the on-disk file is
//! chmod'd to 0600 so only the current user can read it.
//!
//! M3.5 will optionally migrate `anthropic_api_key` to the macOS
//! Keychain via the `keyring` crate; this file stays as a fallback for
//! portability and debugging.

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    /// Empty / whitespace-only values are normalized to `None` on save.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anthropic_api_key: Option<String>,

    #[serde(default)]
    pub agent: AgentConfig,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            anthropic_api_key: None,
            agent: AgentConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConfig {
    #[serde(default = "default_model_summary")]
    pub model_summary: String,
    #[serde(default = "default_model_chat")]
    pub model_chat: String,
    #[serde(default = "default_max_calls_per_minute")]
    pub max_calls_per_minute: u32,
}

impl Default for AgentConfig {
    fn default() -> Self {
        Self {
            model_summary: default_model_summary(),
            model_chat: default_model_chat(),
            max_calls_per_minute: default_max_calls_per_minute(),
        }
    }
}

fn default_model_summary() -> String {
    "claude-sonnet-4-6".to_string()
}

fn default_model_chat() -> String {
    "claude-opus-4-7".to_string()
}

fn default_max_calls_per_minute() -> u32 {
    6
}

/// Read settings from disk. Missing file → defaults. Malformed file →
/// defaults + a `tracing::warn!` (we never overwrite a user's broken
/// file silently).
pub fn load(path: &Path) -> Settings {
    match fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!(
                error = ?e,
                path = %path.display(),
                "settings file unparseable, using defaults — not overwriting"
            );
            Settings::default()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
        Err(e) => {
            tracing::warn!(
                error = ?e,
                path = %path.display(),
                "failed to read settings, using defaults"
            );
            Settings::default()
        }
    }
}

/// Atomic write + chmod 0600. Empty string values for `anthropic_api_key`
/// are normalized to `None` so the on-disk file doesn't carry a
/// confusing empty key.
pub fn save(path: &Path, settings: &Settings) -> std::io::Result<()> {
    let mut to_persist = settings.clone();
    if let Some(ref key) = to_persist.anthropic_api_key {
        if key.trim().is_empty() {
            to_persist.anthropic_api_key = None;
        }
    }

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(&to_persist)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, body)?;
    fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600))?;
    fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let s = load(&dir.path().join("nope.json"));
        assert!(s.anthropic_api_key.is_none());
        assert_eq!(s.agent.max_calls_per_minute, 6);
    }

    #[test]
    fn round_trip_preserves_key() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut s = Settings::default();
        s.anthropic_api_key = Some("sk-ant-test".to_string());
        save(&path, &s).unwrap();

        let loaded = load(&path);
        assert_eq!(loaded.anthropic_api_key.as_deref(), Some("sk-ant-test"));
    }

    #[test]
    fn empty_key_normalizes_to_none() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        let mut s = Settings::default();
        s.anthropic_api_key = Some("   ".to_string());
        save(&path, &s).unwrap();

        let loaded = load(&path);
        assert!(loaded.anthropic_api_key.is_none());
    }

    #[test]
    fn saved_file_has_owner_only_perms() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        save(&path, &Settings::default()).unwrap();
        let mode = fs::metadata(&path).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    #[test]
    fn malformed_file_falls_back_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("config.json");
        fs::write(&path, "{ this is not json").unwrap();
        let s = load(&path);
        assert!(s.anthropic_api_key.is_none());
        // Original content untouched.
        let raw = fs::read_to_string(&path).unwrap();
        assert!(raw.contains("not json"));
    }
}
