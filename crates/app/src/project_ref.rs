//! Helper for deriving a [`karl_session::ProjectRef`] from a session cwd.
//!
//! Used at `EscalationRequested` emit sites so operator events carry enough
//! context for downstream consumers (Telegram, UI) to label which repo /
//! branch a paused session lives in. Falls back to `"unknown"` when the
//! cwd isn't inside a git repo or git can't answer.

use std::path::Path;
use std::process::Command;

use karl_session::ProjectRef;

/// Build a [`ProjectRef`] for `cwd`. Synchronous + best-effort:
/// shells out to `git` once for the toplevel and once for the branch.
/// Both fall back to `"unknown"` on any error.
pub fn project_ref_from_cwd(cwd: &Path) -> ProjectRef {
    let repo = git_str(cwd, &["rev-parse", "--show-toplevel"])
        .and_then(|p| {
            Path::new(p.trim())
                .file_name()
                .map(|s| s.to_string_lossy().to_string())
        })
        .unwrap_or_else(|| "unknown".to_string());

    let branch = git_str(cwd, &["rev-parse", "--abbrev-ref", "HEAD"])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string());

    ProjectRef { repo, branch }
}

fn git_str(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git").current_dir(cwd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn non_git_cwd_returns_unknown() {
        // tmpdir is not inside a git repo (well, it might be on CI, but
        // at least the branch lookup from a non-existent dir errors).
        let p = std::env::temp_dir().join("definitely-not-a-repo-xyz-9f3a");
        let _ = std::fs::create_dir_all(&p);
        let r = project_ref_from_cwd(&p);
        // We don't assert on `repo` since /tmp may itself live inside a repo
        // on some dev machines; just confirm the call doesn't panic and
        // returns non-empty strings.
        assert!(!r.repo.is_empty());
        assert!(!r.branch.is_empty());
    }
}
