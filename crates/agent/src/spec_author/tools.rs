//! Read-only repo tools for the streaming spec author. All file access is
//! confined to a canonicalized repo root.

use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error, PartialEq)]
pub enum ToolError {
    #[error("path escapes repo root")]
    Escape,
    #[error("path not found")]
    NotFound,
    #[error("blocked secret path")]
    Secret,
}

/// Secret directory fragments that are always rejected regardless of root.
const SECRET_FRAGMENTS: &[&str] = &[".ssh", ".aws", ".gnupg", ".config/gh"];

/// Resolve `rel` against canonical `root`, rejecting escapes and secret paths.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, ToolError> {
    use std::path::Component;

    let rel_norm = rel.replace('\\', "/");
    if SECRET_FRAGMENTS.iter().any(|f| rel_norm.contains(f)) {
        return Err(ToolError::Secret);
    }

    // Absolute paths are always outside the root (root is never `/`).
    if Path::new(&rel_norm).is_absolute() {
        // Still try to canonicalize; if it succeeds and is outside root → Escape.
        // If it doesn't exist → also Escape (absolute path outside our root).
        return Err(ToolError::Escape);
    }

    // Lexical escape check: if any `..` component would walk above root, reject
    // before even hitting the filesystem (covers non-existent escape paths).
    let mut depth: isize = 0;
    for component in Path::new(&rel_norm).components() {
        match component {
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return Err(ToolError::Escape);
                }
            }
            Component::Normal(_) => depth += 1,
            _ => {}
        }
    }

    let candidate = root.join(&rel_norm);
    let canon = std::fs::canonicalize(&candidate).map_err(|e| match e.kind() {
        std::io::ErrorKind::NotFound => ToolError::NotFound,
        _ => ToolError::Escape,
    })?;
    if !canon.starts_with(root) {
        return Err(ToolError::Escape);
    }
    Ok(canon)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let d = std::env::temp_dir().join("spec-tools-test-root");
        std::fs::create_dir_all(d.join("src")).unwrap();
        std::fs::write(d.join("src/a.rs"), "fn main() {}").unwrap();
        std::fs::canonicalize(&d).unwrap()
    }

    #[test]
    fn allows_path_inside_root() {
        let r = root();
        assert_eq!(safe_join(&r, "src/a.rs").unwrap(), r.join("src/a.rs"));
    }

    #[test]
    fn rejects_parent_escape() {
        let r = root();
        assert_eq!(safe_join(&r, "../../etc/passwd").unwrap_err(), ToolError::Escape);
    }

    #[test]
    fn rejects_absolute_outside() {
        let r = root();
        assert_eq!(safe_join(&r, "/etc/passwd").unwrap_err(), ToolError::Escape);
    }

    #[test]
    fn rejects_secret_fragment() {
        let r = root();
        assert_eq!(safe_join(&r, ".ssh/id_rsa").unwrap_err(), ToolError::Secret);
    }

    #[test]
    fn missing_path_errors() {
        let r = root();
        assert_eq!(safe_join(&r, "src/nope.rs").unwrap_err(), ToolError::NotFound);
    }
}
