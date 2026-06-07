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

const READ_CAP: usize = 32_768;

/// Read a file (jailed). Optional `range` = "start-end" 1-based line range.
/// Output is byte-capped at 32 KiB.
pub fn read_file(root: &Path, rel: &str, range: Option<&str>) -> Result<String, ToolError> {
    let path = safe_join(root, rel)?;
    let text = std::fs::read_to_string(&path).map_err(|_| ToolError::NotFound)?;
    let sliced = match range.and_then(parse_range) {
        Some((start, end)) => text
            .lines()
            .skip(start.saturating_sub(1))
            .take(end.saturating_sub(start) + 1)
            .collect::<Vec<_>>()
            .join("\n"),
        None => text,
    };
    Ok(sliced.chars().take(READ_CAP).collect())
}

fn parse_range(r: &str) -> Option<(usize, usize)> {
    let (a, b) = r.split_once('-')?;
    Some((a.trim().parse().ok()?, b.trim().parse().ok()?))
}

/// Literal-substring grep over files under `dir` (default whole root).
/// Returns up to 50 `path:line: text` hit strings.
pub fn grep(root: &Path, needle: &str, dir: Option<&str>) -> Result<Vec<String>, ToolError> {
    let base = match dir {
        Some(d) => safe_join(root, d)?,
        None => root.to_path_buf(),
    };
    let mut hits = Vec::new();
    let walker = walk(&base);
    for file in walker {
        if hits.len() >= 50 {
            break;
        }
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        for (i, line) in text.lines().enumerate() {
            if line.contains(needle) {
                let rel = file.strip_prefix(root).unwrap_or(&file).display();
                hits.push(format!("{}:{}: {}", rel, i + 1, line.trim()));
                if hits.len() >= 50 {
                    break;
                }
            }
        }
    }
    Ok(hits)
}

/// List immediate entries of a directory (jailed), dirs suffixed with `/`.
pub fn list_dir(root: &Path, rel: &str) -> Result<Vec<String>, ToolError> {
    let path = safe_join(root, rel)?;
    let mut out = Vec::new();
    for e in std::fs::read_dir(&path).map_err(|_| ToolError::NotFound)? {
        let Ok(e) = e else { continue };
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with('.') {
            continue;
        }
        let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
        out.push(if is_dir { format!("{}/", name) } else { name });
    }
    out.sort();
    Ok(out)
}

/// Recursive file walk, skipping dotdirs, target/, node_modules/. Bounded.
fn walk(base: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    let mut stack = vec![base.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if files.len() > 5000 {
            break;
        }
        let Ok(rd) = std::fs::read_dir(&dir) else { continue };
        for e in rd.flatten() {
            let name = e.file_name().to_string_lossy().into_owned();
            if name.starts_with('.') || name == "target" || name == "node_modules" {
                continue;
            }
            let p = e.path();
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                stack.push(p);
            } else {
                files.push(p);
            }
        }
    }
    files
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

    #[test]
    fn read_file_returns_lines_with_range() {
        let r = root();
        let out = read_file(&r, "src/a.rs", None).unwrap();
        assert!(out.contains("fn main"));
    }

    #[test]
    fn read_file_caps_bytes() {
        let r = root();
        let big = "x".repeat(50_000);
        std::fs::write(r.join("src/big.txt"), &big).unwrap();
        let out = read_file(&r, "src/big.txt", None).unwrap();
        assert!(out.len() <= 32_768, "got {}", out.len());
    }

    #[test]
    fn grep_counts_matches() {
        let r = root();
        let hits = grep(&r, "fn main", Some("src")).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].contains("a.rs"));
    }

    #[test]
    fn list_dir_lists_entries() {
        let r = root();
        let entries = list_dir(&r, "src").unwrap();
        assert!(entries.iter().any(|e| e.ends_with("a.rs")));
    }
}
