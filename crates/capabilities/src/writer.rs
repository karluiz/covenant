//! Atomic file writes with backup retention + frontmatter doc builder.

use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::model::CapabilityResult;

fn unix_ts() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn backup_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(format!(".bak.{}", unix_ts()));
    PathBuf::from(s)
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut s = path.as_os_str().to_owned();
    s.push(format!(".tmp.{}", std::process::id()));
    PathBuf::from(s)
}

/// Write `contents` to `path` atomically. Backs up any existing file first.
pub fn write_atomic(path: &Path, contents: &str) -> CapabilityResult<()> {
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            fs::create_dir_all(parent)?;
        }
    }
    if path.exists() {
        let bak = backup_path(path);
        if let Err(e) = fs::copy(path, &bak) {
            tracing::warn!(?path, ?bak, error = %e, "backup copy failed");
        }
    }
    let tmp = tmp_path(path);
    fs::write(&tmp, contents)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

/// Delete `path`, taking a `.bak.<ts>` snapshot first. No error if absent.
pub fn delete_with_backup(path: &Path) -> CapabilityResult<()> {
    if !path.exists() {
        return Ok(());
    }
    let bak = backup_path(path);
    if let Err(e) = fs::copy(path, &bak) {
        tracing::warn!(?path, ?bak, error = %e, "backup copy failed");
    }
    fs::remove_file(path)?;
    Ok(())
}

/// Build a `---\n<fields>\n---\n<body>` document. Keys emitted in slice order.
/// Values containing `:` or `"` are double-quoted with `"` escaped as `\"`.
pub fn build_frontmatter_md(fields: &[(&str, &str)], body: &str) -> String {
    let mut out = String::from("---\n");
    for (k, v) in fields {
        let needs_quote = v.contains(':') || v.contains('"');
        if needs_quote {
            let escaped = v.replace('"', "\\\"");
            out.push_str(&format!("{}: \"{}\"\n", k, escaped));
        } else {
            out.push_str(&format!("{}: {}\n", k, v));
        }
    }
    out.push_str("---\n");
    out.push_str(body);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontmatter;
    use tempfile::tempdir;

    #[test]
    fn write_atomic_creates_new_file() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.txt");
        write_atomic(&p, "hello").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "hello");
    }

    #[test]
    fn write_atomic_backs_up_existing() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.txt");
        fs::write(&p, "old").unwrap();
        write_atomic(&p, "new").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "new");
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".bak."))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), "old");
    }

    #[test]
    fn write_atomic_creates_parent_dirs() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("nested/deep/path.txt");
        write_atomic(&p, "x").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "x");
    }

    #[test]
    fn delete_with_backup_removes_and_snapshots() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("a.txt");
        fs::write(&p, "bye").unwrap();
        delete_with_backup(&p).unwrap();
        assert!(!p.exists());
        let backups: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".bak."))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(fs::read_to_string(backups[0].path()).unwrap(), "bye");
    }

    #[test]
    fn delete_with_backup_missing_is_noop() {
        let dir = tempdir().unwrap();
        let p = dir.path().join("nope.txt");
        delete_with_backup(&p).unwrap();
    }

    #[test]
    fn frontmatter_roundtrips() {
        let s = build_frontmatter_md(
            &[("name", "my-skill"), ("description", "does a thing")],
            "Body content\n",
        );
        let fm = frontmatter::parse(&s);
        assert_eq!(fm.name(), Some("my-skill"));
        assert_eq!(fm.description(), Some("does a thing"));
        assert_eq!(fm.body, "Body content\n");
    }

    #[test]
    fn frontmatter_quotes_colon_values() {
        let s = build_frontmatter_md(&[("description", "uses a: marker")], "");
        assert!(s.contains("description: \"uses a: marker\""));
        let fm = frontmatter::parse(&s);
        assert_eq!(fm.description(), Some("uses a: marker"));
    }

    #[test]
    fn frontmatter_escapes_quotes() {
        let s = build_frontmatter_md(&[("description", "says \"hi\"")], "");
        assert!(s.contains("\\\""));
    }
}
