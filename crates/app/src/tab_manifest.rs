//! Tab persistence — restore your tabs across app restarts.
//!
//! Backend keeps the file dumb: it stores a single JSON blob defined
//! by the frontend (TabManager.serializeManifest). We don't validate
//! schema here — the only failure modes we care about are I/O.
//! Schema evolution (version bumps, migrations) lives in the
//! frontend.
//!
//! What this DOES restore:
//!   - Tab list + order
//!   - Per-tab: customName, cwd, color, group_id
//!   - Group list (id, name, color, collapsed)
//!
//! What this does NOT restore (because it can't):
//!   - The PTY itself — every reopen spawns fresh shells
//!   - xterm scrollback — that's renderer memory, dies with the
//!     process
//!   - Executor state (claude / aider REPL) — those tools have
//!     their own session persistence (see /rename + claude --resume)
//!
//! File: `<app_config_dir>/tab_manifest.json`. Atomic writes
//! (tmp + rename) so a crash mid-write leaves the prior version.

use std::path::Path;

/// Read the raw JSON manifest. Returns:
///   - `Ok(Some(s))` when the file exists and is readable
///   - `Ok(None)` when the file doesn't exist (first run / cleared)
///   - `Err(_)` on I/O failure
pub fn load(path: &Path) -> std::io::Result<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

/// Write `body` (raw JSON from the frontend) atomically. Creates
/// parent dir if missing. Empty body deletes the file — the
/// frontend uses this to "forget" persisted state cleanly.
pub fn save(path: &Path, body: &str) -> std::io::Result<()> {
    if body.trim().is_empty() {
        // Treat empty save as a clear: rm if exists, else no-op.
        match std::fs::remove_file(path) {
            Ok(_) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e),
        }
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(&dir.path().join("nope.json")).unwrap().is_none());
    }

    #[test]
    fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.json");
        save(&path, "{\"hello\":1}").unwrap();
        assert_eq!(load(&path).unwrap().as_deref(), Some("{\"hello\":1}"));
    }

    #[test]
    fn empty_body_clears() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.json");
        save(&path, "{\"a\":1}").unwrap();
        save(&path, "").unwrap();
        assert!(load(&path).unwrap().is_none());
    }

    #[test]
    fn empty_body_clears_when_already_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.json");
        save(&path, "").unwrap();
        assert!(load(&path).unwrap().is_none());
    }
}
