//! Cross-restart persistence for mission specs.
//!
//! Missions live in memory per-session today; this module gives them a
//! cwd-keyed home on disk so they survive `close tab` / app restart.
//! When a session changes cwd into a directory we've seen with a
//! mission before, the operator auto-restores it (silently — the user
//! sees the mission badge appear). The mental model:
//!
//!   "the mission is a property of the project I'm working on, not
//!    of the ephemeral terminal tab"
//!
//! Cwd is the closest stable handle Covenant has. Tab IDs are Ulids
//! that change every spawn; tab names are user-set and rare; cwd is
//! emitted by the shell on every directory change via OSC 7.
//!
//! Storage format: a flat JSON map at `<app_config_dir>/session_missions.json`
//! mapping `cwd → spec_path`. Both are absolute paths. Atomic writes
//! (tmp file + rename) so a crash mid-write leaves the prior version.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub type MissionMap = HashMap<String, String>;

/// Read the mapping from disk. Missing file → empty map (first run).
/// Malformed file → empty map + a warn log; we never overwrite a
/// broken file silently (mirrors `settings::load`).
pub fn load(path: &Path) -> MissionMap {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text).unwrap_or_else(|e| {
            tracing::warn!(
                error = ?e,
                path = %path.display(),
                "session_missions file unparseable, starting empty"
            );
            MissionMap::new()
        }),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => MissionMap::new(),
        Err(e) => {
            tracing::warn!(
                error = ?e,
                path = %path.display(),
                "session_missions read failed, starting empty"
            );
            MissionMap::new()
        }
    }
}

/// Atomic write. Creates parent dir if missing.
pub fn save(path: &Path, map: &MissionMap) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let body = serde_json::to_string_pretty(map)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Convenience: set mapping[cwd] = spec_path and persist.
pub fn record(path: &Path, cwd: String, spec_path: String) {
    if cwd.is_empty() {
        return;
    }
    let mut map = load(path);
    map.insert(cwd, spec_path);
    if let Err(e) = save(path, &map) {
        tracing::warn!(error = %e, "session_missions save failed");
    }
}

/// Convenience: remove the mapping for `cwd`. Silent if not present.
pub fn forget(path: &Path, cwd: &str) {
    if cwd.is_empty() {
        return;
    }
    let mut map = load(path);
    if map.remove(cwd).is_some() {
        if let Err(e) = save(path, &map) {
            tracing::warn!(error = %e, "session_missions save failed");
        }
    }
}

/// Lookup helper used by the cwd-restore path. Returns the spec path
/// the user previously associated with `cwd`, if any.
pub fn lookup(path: &Path, cwd: &str) -> Option<PathBuf> {
    if cwd.is_empty() {
        return None;
    }
    load(path).get(cwd).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_empty_map() {
        let dir = tempfile::tempdir().unwrap();
        let m = load(&dir.path().join("nope.json"));
        assert!(m.is_empty());
    }

    #[test]
    fn round_trip_record_lookup() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missions.json");
        record(&path, "/Users/me/proj".to_string(), "/Users/me/proj/spec.md".to_string());
        assert_eq!(
            lookup(&path, "/Users/me/proj"),
            Some(PathBuf::from("/Users/me/proj/spec.md"))
        );
        assert_eq!(lookup(&path, "/Users/me/other"), None);
    }

    #[test]
    fn forget_removes_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missions.json");
        record(&path, "/p".to_string(), "/p/s.md".to_string());
        forget(&path, "/p");
        assert!(load(&path).is_empty());
    }

    #[test]
    fn record_with_empty_cwd_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missions.json");
        record(&path, "".to_string(), "/p/s.md".to_string());
        assert!(load(&path).is_empty());
    }

    #[test]
    fn malformed_json_falls_back_without_overwriting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missions.json");
        std::fs::write(&path, "{ broken").unwrap();
        let m = load(&path);
        assert!(m.is_empty());
        // Source file untouched.
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("broken"));
    }
}
