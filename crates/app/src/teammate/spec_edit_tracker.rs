//! Per-session tracker for the `spec_keeper` achievement: did the executor
//! read or create a spec BEFORE its first non-spec code edit, within a task?
//!
//! Fed from `NotchHub::set_phase` (every ExecutorPhase carries the file it
//! targets). Queried at task completion.

use std::collections::HashMap;

use karl_session::{ExecutorPhase, SessionId};
use parking_lot::Mutex;

#[derive(Clone, Debug, Default)]
struct State {
    saw_spec: bool,
    saw_code_edit: bool,
    satisfied: bool,
    repo: Option<String>,
}

#[derive(Default)]
pub struct SpecEditTracker {
    by_session: Mutex<HashMap<SessionId, State>>,
}

/// A spec path is anything under a `specs/` directory (matches the spec
/// watcher convention) or a superpowers spec doc.
fn is_spec_file(path: &str) -> bool {
    let p = path.replace('\\', "/").to_ascii_lowercase();
    p.contains("/specs/") || p.contains("/docs/superpowers/")
}

impl SpecEditTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Observe a phase transition for `session`. Latches `satisfied` the
    /// first time a code edit happens, recording whether a spec was seen
    /// before it.
    pub fn note_phase(&self, session: SessionId, phase: &ExecutorPhase) {
        let mut g = self.by_session.lock();
        let st = g.entry(session).or_default();
        match phase {
            ExecutorPhase::Reading { file } | ExecutorPhase::Writing { file }
                if is_spec_file(file) =>
            {
                if !st.saw_code_edit {
                    st.saw_spec = true;
                }
            }
            ExecutorPhase::Writing { file } if !is_spec_file(file) => {
                if !st.saw_code_edit {
                    st.saw_code_edit = true;
                    st.satisfied = st.saw_spec;
                    if st.satisfied {
                        st.repo = std::path::Path::new(file)
                            .parent()
                            .and_then(karl_score::context::repo_name_for_cwd);
                    }
                }
            }
            _ => {}
        }
    }

    /// Did this session read/create a spec before its first code edit?
    pub fn satisfied(&self, session: SessionId) -> bool {
        self.by_session.lock().get(&session).map(|s| s.satisfied).unwrap_or(false)
    }

    /// The repo of the satisfying code edit, if known. Best-effort — None
    /// when the edit wasn't inside a resolvable git repo.
    pub fn satisfied_repo(&self, session: SessionId) -> Option<String> {
        self.by_session.lock().get(&session).and_then(|s| s.repo.clone())
    }

    pub fn forget(&self, session: SessionId) {
        self.by_session.lock().remove(&session);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(f: &str) -> ExecutorPhase { ExecutorPhase::Reading { file: f.into() } }
    fn writing(f: &str) -> ExecutorPhase { ExecutorPhase::Writing { file: f.into() } }

    #[test]
    fn spec_read_before_edit_is_satisfied() {
        let t = SpecEditTracker::new();
        let s = SessionId::new();
        t.note_phase(s, &reading("/repo/specs/feature.md"));
        t.note_phase(s, &writing("/repo/src/main.rs"));
        assert!(t.satisfied(s));
    }

    #[test]
    fn edit_before_spec_is_not_satisfied() {
        let t = SpecEditTracker::new();
        let s = SessionId::new();
        t.note_phase(s, &writing("/repo/src/main.rs"));
        t.note_phase(s, &reading("/repo/specs/feature.md"));
        assert!(!t.satisfied(s));
    }

    #[test]
    fn creating_a_spec_counts_as_spec_activity() {
        let t = SpecEditTracker::new();
        let s = SessionId::new();
        t.note_phase(s, &writing("/repo/specs/new.md")); // creating a spec
        t.note_phase(s, &writing("/repo/src/lib.rs"));
        assert!(t.satisfied(s));
    }

    #[test]
    fn no_activity_is_not_satisfied() {
        let t = SpecEditTracker::new();
        assert!(!t.satisfied(SessionId::new()));
    }
}
