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
//! mapping `cwd → MissionRef`. New writes use the structured form
//! `{"kind":"covenant","spec_path":"...","plan_path":null}`. Legacy
//! reads accept a bare string (the previous on-disk shape) and treat
//! it as a Covenant mission. Atomic writes (tmp file + rename) so a
//! crash mid-write leaves the prior version.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::mission_pair::MissionRef;

pub type MissionMap = HashMap<String, MissionRef>;

/// On-disk entry: either the structured `MissionRef` (current shape) or
/// a bare string (legacy shape — pre-Superpowers, treated as Covenant).
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum StoredEntry {
    Structured(MissionRef),
    Legacy(String),
}

impl From<StoredEntry> for MissionRef {
    fn from(s: StoredEntry) -> Self {
        match s {
            StoredEntry::Structured(r) => r,
            StoredEntry::Legacy(p) => MissionRef::covenant(PathBuf::from(p)),
        }
    }
}

/// Read the mapping from disk. Missing file → empty map (first run).
/// Malformed file → empty map + a warn log; we never overwrite a
/// broken file silently (mirrors `settings::load`).
pub fn load(path: &Path) -> MissionMap {
    let text = match std::fs::read_to_string(path) {
        Ok(t) => t,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MissionMap::new(),
        Err(e) => {
            tracing::warn!(
                error = ?e,
                path = %path.display(),
                "session_missions read failed, starting empty"
            );
            return MissionMap::new();
        }
    };
    let raw: HashMap<String, StoredEntry> = match serde_json::from_str(&text) {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(
                error = ?e,
                path = %path.display(),
                "session_missions file unparseable, starting empty"
            );
            return MissionMap::new();
        }
    };
    raw.into_iter().map(|(k, v)| (k, v.into())).collect()
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

/// Convenience: set mapping[cwd] = mref and persist.
pub fn record(path: &Path, cwd: String, mref: &MissionRef) {
    if cwd.is_empty() {
        return;
    }
    let mut map = load(path);
    map.insert(cwd, mref.clone());
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

/// Lookup helper used by the cwd-restore path. Returns the `MissionRef`
/// the user previously associated with `cwd`, if any.
#[allow(dead_code)]
pub fn lookup(path: &Path, cwd: &str) -> Option<MissionRef> {
    if cwd.is_empty() {
        return None;
    }
    load(path).remove(cwd)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mission_pair::MissionKind;

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
        let mref = MissionRef::covenant(PathBuf::from("/Users/me/proj/spec.md"));
        record(&path, "/Users/me/proj".to_string(), &mref);
        let got = lookup(&path, "/Users/me/proj").unwrap();
        assert_eq!(got.kind, MissionKind::Covenant);
        assert_eq!(got.spec_path, PathBuf::from("/Users/me/proj/spec.md"));
        assert!(got.plan_path.is_none());
        assert!(lookup(&path, "/Users/me/other").is_none());
    }

    #[test]
    fn round_trip_superpowers_with_plan() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missions.json");
        let mref = MissionRef::superpowers(
            PathBuf::from("/p/spec.md"),
            Some(PathBuf::from("/p/plan.md")),
        );
        record(&path, "/p".to_string(), &mref);
        let got = lookup(&path, "/p").unwrap();
        assert_eq!(got.kind, MissionKind::Superpowers);
        assert_eq!(got.plan_path, Some(PathBuf::from("/p/plan.md")));
    }

    #[test]
    fn forget_removes_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missions.json");
        let mref = MissionRef::covenant(PathBuf::from("/p/s.md"));
        record(&path, "/p".to_string(), &mref);
        forget(&path, "/p");
        assert!(load(&path).is_empty());
    }

    #[test]
    fn record_with_empty_cwd_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("missions.json");
        let mref = MissionRef::covenant(PathBuf::from("/p/s.md"));
        record(&path, "".to_string(), &mref);
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

    #[test]
    fn reads_legacy_bare_string_as_covenant_mission() {
        let dir = tempfile::tempdir().unwrap();
        let store = dir.path().join("missions.json");
        std::fs::write(&store, r#"{"/some/cwd":"/path/to/spec.md"}"#).unwrap();
        let got = lookup(&store, "/some/cwd").expect("legacy entry should load");
        assert_eq!(got.kind, MissionKind::Covenant);
        assert_eq!(got.spec_path, PathBuf::from("/path/to/spec.md"));
        assert!(got.plan_path.is_none());
    }
}
