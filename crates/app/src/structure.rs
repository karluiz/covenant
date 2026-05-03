//! Structure sidebar (3.3) — filesystem backend for the file tree.
//!
//! Three Tauri commands: `structure_list_dir`, `structure_read_file`,
//! `structure_write_file`. All fs ops run via `spawn_blocking` from the
//! command handlers in `lib.rs`. This module is pure functions over
//! `Path` arguments.

use std::path::Path;

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    Dir,
    File,
}

/// Names we always skip regardless of `.gitignore`. Matches by exact
/// basename — these are universal noise sources.
const HARDCODED_IGNORES: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    ".next",
    "__pycache__",
];

pub fn list_dir(cwd: &Path) -> Result<Vec<DirEntry>, String> {
    if !cwd.is_dir() {
        return Err(format!("not a directory: {}", cwd.display()));
    }
    // Build a one-shot gitignore matcher rooted at this dir. The
    // `ignore` crate's WalkBuilder is overkill for one-level reads —
    // we just want the matcher. Errors loading .gitignore are
    // soft-fail: we still list the directory, just without those rules.
    let gi_path = cwd.join(".gitignore");
    let (matcher, _gi_err) = ignore::gitignore::Gitignore::new(&gi_path);
    let mut out = Vec::new();
    let read = std::fs::read_dir(cwd).map_err(|e| format!("read_dir: {e}"))?;
    for entry in read {
        let entry = entry.map_err(|e| format!("read_dir entry: {e}"))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if HARDCODED_IGNORES.iter().any(|n| *n == name) {
            continue;
        }
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let is_symlink = metadata.file_type().is_symlink();
        let kind = if metadata.is_dir() {
            EntryKind::Dir
        } else if metadata.is_file() {
            EntryKind::File
        } else {
            continue;
        };
        let abs = entry.path();
        if matcher.matched(&abs, matches!(kind, EntryKind::Dir)).is_ignore() {
            continue;
        }
        out.push(DirEntry {
            name,
            path: abs.display().to_string(),
            kind,
            is_symlink,
        });
    }
    out.sort_by(|a, b| match (a.kind, b.kind) {
        (EntryKind::Dir, EntryKind::File) => std::cmp::Ordering::Less,
        (EntryKind::File, EntryKind::Dir) => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn make_tree(tmp: &TempDir, names: &[&str]) {
        for n in names {
            let p = tmp.path().join(n);
            if n.ends_with('/') {
                fs::create_dir_all(&p).unwrap();
            } else {
                if let Some(parent) = p.parent() {
                    fs::create_dir_all(parent).unwrap();
                }
                fs::write(&p, b"").unwrap();
            }
        }
    }

    #[test]
    fn skips_hardcoded_ignores() {
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &["src/", "node_modules/", ".git/", "target/", "README.md"]);
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["src", "README.md"]);
    }

    #[test]
    fn folders_first_then_alpha() {
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &["b.txt", "a.txt", "z_dir/", "a_dir/"]);
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["a_dir", "z_dir", "a.txt", "b.txt"]);
    }

    #[test]
    fn err_on_non_dir() {
        let tmp = TempDir::new().unwrap();
        let f = tmp.path().join("file.txt");
        fs::write(&f, b"").unwrap();
        assert!(list_dir(&f).is_err());
    }

    #[test]
    fn honors_gitignore() {
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &[
            "src/main.rs",
            "build/output.bin",
            "secret.env",
            "README.md",
            ".gitignore",
        ]);
        fs::write(tmp.path().join(".gitignore"), "build/\n*.env\n").unwrap();
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        // .gitignore itself is shown (gitignore patterns don't hide it),
        // but build/ and secret.env are filtered.
        assert!(names.contains(&"src"));
        assert!(names.contains(&"README.md"));
        assert!(names.contains(&".gitignore"));
        assert!(!names.contains(&"build"));
        assert!(!names.contains(&"secret.env"));
    }

    #[test]
    fn gitignore_only_applies_inside_repo_or_with_root() {
        // No .gitignore = nothing extra is filtered (only hardcoded set).
        let tmp = TempDir::new().unwrap();
        make_tree(&tmp, &["foo.log", "bar.txt"]);
        let entries = list_dir(tmp.path()).unwrap();
        let names: Vec<_> = entries.iter().map(|e| e.name.as_str()).collect();
        assert!(names.contains(&"foo.log"));
        assert!(names.contains(&"bar.txt"));
    }
}
