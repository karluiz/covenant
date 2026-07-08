use std::path::{Path, PathBuf};

/// Outermost ancestor containing any marker file; else nearest ancestor
/// containing `.git`; else the file's parent directory.
pub fn detect_root(file: &Path, markers: &[String]) -> PathBuf {
    let start = file.parent().unwrap_or(file);
    let mut marker_hit: Option<PathBuf> = None;
    let mut git_hit: Option<PathBuf> = None;
    for dir in start.ancestors() {
        if markers.iter().any(|m| dir.join(m).exists()) {
            marker_hit = Some(dir.to_path_buf()); // keep walking — outermost wins
        }
        if git_hit.is_none() && dir.join(".git").exists() {
            git_hit = Some(dir.to_path_buf());
        }
    }
    marker_hit
        .or(git_hit)
        .unwrap_or_else(|| start.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn touch(p: &Path) {
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "").unwrap();
    }

    #[test]
    fn outermost_marker_wins_for_workspaces() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("ws/Cargo.toml")); // workspace root
        touch(&t.path().join("ws/member/Cargo.toml")); // member crate
        touch(&t.path().join("ws/member/src/lib.rs"));
        let root = detect_root(
            &t.path().join("ws/member/src/lib.rs"),
            &["Cargo.toml".into()],
        );
        assert_eq!(root, t.path().join("ws"));
    }

    #[test]
    fn falls_back_to_git_root() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir_all(t.path().join("repo/.git")).unwrap();
        touch(&t.path().join("repo/src/main.rs"));
        let root = detect_root(&t.path().join("repo/src/main.rs"), &["Cargo.toml".into()]);
        assert_eq!(root, t.path().join("repo"));
    }

    #[test]
    fn falls_back_to_parent_dir() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("loose/file.rs"));
        let root = detect_root(&t.path().join("loose/file.rs"), &["Cargo.toml".into()]);
        assert_eq!(root, t.path().join("loose"));
    }
}
