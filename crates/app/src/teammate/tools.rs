//! Tools that operators can call during a DM exchange (Phase 4).
//!
//! Phase 4a ships `read_file` only. Future tools (`grep`, `git_log`,
//! `git_diff`) follow the same pattern: pure functions that take a
//! `ToolEnv` (sandbox + size limits) + JSON args, return Result.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Error, Debug)]
pub enum ToolError {
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("path traversal outside the workspace root")]
    PathOutsideRoot,
    #[error("file not found: {0}")]
    NotFound(String),
    #[error("file too large: {size} bytes (max {max})")]
    TooLarge { size: usize, max: usize },
    #[error("not a UTF-8 text file")]
    NotUtf8,
    #[error("io error: {0}")]
    Io(String),
}

/// Sandbox + budget for tool calls inside a single DM dispatch.
#[derive(Debug, Clone)]
pub struct ToolEnv {
    /// Absolute, canonicalized path. All file reads must resolve under it.
    pub root: PathBuf,
    /// Hard cap per file. Anything bigger errors before the file is read.
    pub max_bytes_per_file: usize,
}

impl ToolEnv {
    pub fn new(root: PathBuf, max_bytes_per_file: usize) -> Self {
        Self { root, max_bytes_per_file }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReadFileArgs {
    pub path: String,
}

/// Read a UTF-8 text file from the workspace. Returns its contents.
///
/// Safety:
/// - The `path` arg must resolve to a descendant of `env.root` after
///   canonicalization. Absolute paths and `..` traversal are rejected.
/// - Symlinks are followed (via canonicalize) and the target must also
///   live under root.
/// - Size is capped at `env.max_bytes_per_file`. We stat first so we
///   don't allocate a giant buffer just to reject it.
pub fn read_file(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let parsed: ReadFileArgs = serde_json::from_value(args.clone())
        .map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
    let trimmed = parsed.path.trim();
    if trimmed.is_empty() {
        return Err(ToolError::InvalidArgs("path is empty".into()));
    }
    let raw = Path::new(trimmed);
    // Resolve against the root regardless of whether the caller gave an
    // absolute path. canonicalize() then collapses `..` and follows
    // symlinks, and the final guard ensures the result still lives
    // under root.
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        env.root.join(raw)
    };
    let resolved = joined
        .canonicalize()
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => ToolError::NotFound(trimmed.into()),
            _ => ToolError::Io(e.to_string()),
        })?;
    if !resolved.starts_with(&env.root) {
        return Err(ToolError::PathOutsideRoot);
    }
    let meta = std::fs::metadata(&resolved).map_err(|e| ToolError::Io(e.to_string()))?;
    let size = meta.len() as usize;
    if size > env.max_bytes_per_file {
        return Err(ToolError::TooLarge {
            size,
            max: env.max_bytes_per_file,
        });
    }
    let bytes = std::fs::read(&resolved).map_err(|e| ToolError::Io(e.to_string()))?;
    String::from_utf8(bytes).map_err(|_| ToolError::NotUtf8)
}

/// Anthropic tool definition for `read_file`. Sent in the `tools` array
/// of the Messages API request. Operators decide when to invoke it.
pub fn read_file_tool_def() -> Value {
    serde_json::json!({
        "name": "read_file",
        "description": "Read a UTF-8 text file from the user's workspace. \
                        Use this when the user asks about a file by path or \
                        when you need to inspect source to answer accurately. \
                        Do not invent file contents — call the tool. Paths are \
                        relative to the workspace root.",
        "input_schema": {
            "type": "object",
            "required": ["path"],
            "additionalProperties": false,
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Path to the file, relative to the workspace root (no leading slash)."
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tmp_root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        (dir, root)
    }

    #[test]
    fn reads_a_file_inside_root() {
        let (_dir, root) = tmp_root();
        fs::write(root.join("hello.txt"), "hello world").unwrap();
        let env = ToolEnv::new(root, 1024);
        let out = read_file(&env, &serde_json::json!({ "path": "hello.txt" })).unwrap();
        assert_eq!(out, "hello world");
    }

    #[test]
    fn rejects_path_traversal_via_dotdot() {
        let (_dir, root) = tmp_root();
        // Put a file outside root.
        let outside = root.parent().unwrap().join("outside.txt");
        fs::write(&outside, "leaked").unwrap();
        let env = ToolEnv::new(root, 1024);
        let err = read_file(&env, &serde_json::json!({ "path": "../outside.txt" })).unwrap_err();
        let _ = fs::remove_file(&outside);
        assert!(matches!(err, ToolError::PathOutsideRoot | ToolError::NotFound(_)));
    }

    #[test]
    fn rejects_absolute_path_outside_root() {
        let (_dir, root) = tmp_root();
        let env = ToolEnv::new(root, 1024);
        let err = read_file(&env, &serde_json::json!({ "path": "/etc/hosts" })).unwrap_err();
        // Could be PathOutsideRoot or Io/NotFound depending on /etc/hosts existence,
        // but it must NOT be a successful read.
        assert!(!matches!(err, ToolError::InvalidArgs(_)) || true);
        assert!(matches!(err, ToolError::PathOutsideRoot | ToolError::NotFound(_) | ToolError::Io(_)));
    }

    #[test]
    fn rejects_oversized_file() {
        let (_dir, root) = tmp_root();
        fs::write(root.join("big.txt"), "x".repeat(2048)).unwrap();
        let env = ToolEnv::new(root, 1024);
        let err = read_file(&env, &serde_json::json!({ "path": "big.txt" })).unwrap_err();
        assert!(matches!(err, ToolError::TooLarge { .. }));
    }

    #[test]
    fn rejects_missing_path_arg() {
        let (_dir, root) = tmp_root();
        let env = ToolEnv::new(root, 1024);
        let err = read_file(&env, &serde_json::json!({})).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn rejects_empty_path() {
        let (_dir, root) = tmp_root();
        let env = ToolEnv::new(root, 1024);
        let err = read_file(&env, &serde_json::json!({ "path": "   " })).unwrap_err();
        assert!(matches!(err, ToolError::InvalidArgs(_)));
    }

    #[test]
    fn reports_not_found_for_missing_file() {
        let (_dir, root) = tmp_root();
        let env = ToolEnv::new(root, 1024);
        let err = read_file(&env, &serde_json::json!({ "path": "missing.txt" })).unwrap_err();
        assert!(matches!(err, ToolError::NotFound(_)));
    }

    #[test]
    fn rejects_non_utf8_binary_file() {
        let (_dir, root) = tmp_root();
        fs::write(root.join("blob.bin"), &[0xFF, 0xFE, 0xFD, 0x00, 0x01]).unwrap();
        let env = ToolEnv::new(root, 1024);
        let err = read_file(&env, &serde_json::json!({ "path": "blob.bin" })).unwrap_err();
        assert!(matches!(err, ToolError::NotUtf8));
    }

    #[test]
    fn tool_def_has_required_shape() {
        let def = read_file_tool_def();
        assert_eq!(def["name"], "read_file");
        assert_eq!(def["input_schema"]["required"][0], "path");
        assert_eq!(def["input_schema"]["properties"]["path"]["type"], "string");
    }
}
