//! Resolve a crawler-proposed unit against what Canon already holds, so every
//! inventory row can say whether it is new, unchanged, drifted, or a foreign
//! item waiting to be adopted.

use crate::kind::ContextUnit;
use crate::manifest::canon_dir;
use crate::CanonError;
use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UnitState {
    /// No Canon source with this (kind, slug).
    New,
    /// Canon holds this unit and the rendered bytes match.
    Exists,
    /// Canon holds this unit but the crawler rendered different bytes.
    Changed,
    /// A foreign item on disk with no Canon source — adoptable, not writable.
    ///
    /// Never constructed in Rust: `detected_rows` returns the units themselves
    /// and the frontend stamps this state on them while merging the two lists
    /// (see `applyStates` in `ui/src/canon/miner/state.ts`). It lives here so
    /// the wire enum names every state a row can carry, not just the emitted
    /// ones.
    Detected,
}

/// Where a `(kind, slug)` unit lands on disk, relative to the repo root.
/// `None` for kinds the crawler never emits (mcp, spec, context).
fn unit_path(repo_root: &Path, kind: &str, slug: &str) -> Option<std::path::PathBuf> {
    let base = canon_dir(repo_root);
    Some(match kind {
        "skill" => base.join("skills").join(slug).join("SKILL.md"),
        "memory" => base.join("memory").join(format!("{slug}.md")),
        "command" => base.join("commands").join(format!("{slug}.md")),
        "subagent" => base.join("agents").join(format!("{slug}.md")),
        _ => return None,
    })
}

/// `body` is the fully rendered artifact — `render_md_entry` output for
/// memory/command/subagent, `render_skill_md` output for skill.
///
/// ponytail: byte comparison, not a semantic diff. Cosmetic drift reports
/// `Changed`, which is the conservative direction — it offers Update rather
/// than hiding a real change. Upgrade to a normalized compare only if users
/// complain about false Changed rows.
pub fn resolve_state(repo_root: &Path, kind: &str, slug: &str, body: &str) -> UnitState {
    let Some(path) = unit_path(repo_root, kind, slug) else {
        return UnitState::New;
    };
    match std::fs::read_to_string(&path) {
        Ok(on_disk) if on_disk == body => UnitState::Exists,
        Ok(_) => UnitState::Changed,
        // Only a genuinely absent file is `New`. Any other I/O error (permission
        // denied, a directory sitting where a file belongs, a symlink loop, a
        // transient read failure) means something IS there and we simply could
        // not read it this once. Reporting that as `New` would pre-select the
        // row for an overwrite-in-place write, silently clobbering a real file.
        // `Changed` is the conservative call: it leaves the row unselected and
        // offers Update instead. Do not "simplify" this back to a blanket
        // `Err(_) => New`.
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => UnitState::New,
        Err(_) => UnitState::Changed,
    }
}

/// Foreign items already on disk with no Canon source. These are not crawl
/// output — they answer the same question from the other direction and are
/// merged into the same inventory list, with Adopt instead of Materialize.
pub fn detected_rows(repo_root: &Path) -> Result<Vec<ContextUnit>, CanonError> {
    crate::detect::scan_detected(repo_root)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compile::{write_memory_entry, CompiledFinding};

    fn finding(title: &str, body: &str) -> CompiledFinding {
        CompiledFinding {
            category: "convention".into(),
            title: title.into(),
            body_md: body.into(),
            evidence: vec![],
            confidence: "high".into(),
            kind: "memory".into(),
        }
    }

    #[test]
    fn resolves_new_exists_and_changed() {
        let tmp = std::env::temp_dir().join(format!("canon-inv-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // Nothing on disk yet.
        assert_eq!(
            resolve_state(&tmp, "memory", "use-tabs", "whatever"),
            UnitState::New
        );

        let f = finding("Use tabs", "Always use tabs.");
        write_memory_entry(&tmp, "use-tabs", &f).unwrap();
        let same = crate::compile::render_md_entry(&f);

        assert_eq!(
            resolve_state(&tmp, "memory", "use-tabs", &same),
            UnitState::Exists
        );
        assert_eq!(
            resolve_state(&tmp, "memory", "use-tabs", "different bytes"),
            UnitState::Changed
        );
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn unknown_kind_is_new() {
        let tmp = std::env::temp_dir().join(format!("canon-inv2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();
        assert_eq!(resolve_state(&tmp, "mcp", "x", "y"), UnitState::New);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_error_other_than_not_found_is_changed_not_new() {
        // Put a *directory* at the exact path a unit's file would occupy.
        // Reading it as a string fails with an io::Error whose kind is not
        // `NotFound` (e.g. `IsADirectory` on macOS/Linux) — precisely the case
        // this fix targets: something is there, we just can't read it as a
        // file, and that must never be reported as `New`.
        let tmp = std::env::temp_dir().join(format!("canon-inv3-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let blocked_dir = tmp.join(".covenant").join("canon").join("memory").join("blocked.md");
        std::fs::create_dir_all(&blocked_dir).unwrap();

        assert_eq!(
            resolve_state(&tmp, "memory", "blocked", "anything"),
            UnitState::Changed
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
