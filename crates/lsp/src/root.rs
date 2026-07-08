use std::path::{Path, PathBuf};

/// Does `dir` contain an entry matching `marker`? A marker starting with
/// `*` (e.g. `*.sln`) is a simple suffix glob — matched against every
/// direct entry's file name — since root markers only ever need "any file
/// with this extension" (a solution file, a project file), never full glob
/// syntax. Anything else is matched by exact filename, as before.
fn marker_matches(dir: &Path, marker: &str) -> bool {
    match marker.strip_prefix('*') {
        Some(suffix) => std::fs::read_dir(dir)
            .map(|entries| {
                entries.flatten().any(|e| {
                    e.file_name()
                        .to_str()
                        .is_some_and(|name| name.ends_with(suffix))
                })
            })
            .unwrap_or(false),
        None => dir.join(marker).exists(),
    }
}

/// Outermost ancestor containing any marker file; else nearest ancestor
/// containing `.git`; else the file's parent directory.
pub fn detect_root(file: &Path, markers: &[String]) -> PathBuf {
    let start = file.parent().unwrap_or(file);
    let mut marker_hit: Option<PathBuf> = None;
    let mut git_hit: Option<PathBuf> = None;
    for dir in start.ancestors() {
        if markers.iter().any(|m| marker_matches(dir, m)) {
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

    #[test]
    fn glob_marker_matches_any_file_with_extension() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("proj/Foo.sln"));
        touch(&t.path().join("proj/src/Program.cs"));
        let root = detect_root(
            &t.path().join("proj/src/Program.cs"),
            &["*.sln".into(), "*.csproj".into(), "global.json".into()],
        );
        assert_eq!(root, t.path().join("proj"));
    }

    #[test]
    fn glob_marker_outermost_wins_like_exact_markers() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("ws/Foo.sln")); // solution root
        touch(&t.path().join("ws/lib/Bar.csproj")); // nested project
        touch(&t.path().join("ws/lib/src/Class.cs"));
        let root = detect_root(
            &t.path().join("ws/lib/src/Class.cs"),
            &["*.sln".into(), "*.csproj".into()],
        );
        assert_eq!(root, t.path().join("ws"));
    }

    #[test]
    fn exact_markers_still_match_without_glob() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("proj/global.json"));
        touch(&t.path().join("proj/src/Program.cs"));
        let root = detect_root(
            &t.path().join("proj/src/Program.cs"),
            &["*.sln".into(), "global.json".into()],
        );
        assert_eq!(root, t.path().join("proj"));
    }

    #[test]
    fn glob_marker_does_not_match_unrelated_extension() {
        let t = tempfile::tempdir().unwrap();
        touch(&t.path().join("proj/Notes.txt"));
        touch(&t.path().join("proj/src/Program.cs"));
        fs::create_dir_all(t.path().join("proj/.git")).unwrap();
        let root = detect_root(&t.path().join("proj/src/Program.cs"), &["*.sln".into()]);
        // No *.sln anywhere; falls back to git root.
        assert_eq!(root, t.path().join("proj"));
    }
}
