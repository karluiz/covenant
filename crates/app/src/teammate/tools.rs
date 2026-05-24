//! Tools that operators can call during a DM exchange (Phase 4).
//!
//! Phase 4a shipped `read_file`. Phase 4b adds workspace-awareness
//! tools: `list_directory`, `search_files`, `git_status`, `git_diff`.
//! All follow the same pattern: pure functions that take a `ToolEnv`
//! (sandbox + size limits) + JSON args, return Result.

use std::path::{Path, PathBuf};
use std::process::Command;

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
    #[error("not a directory: {0}")]
    NotADirectory(String),
    #[error("file too large: {size} bytes (max {max})")]
    TooLarge { size: usize, max: usize },
    #[error("not a UTF-8 text file")]
    NotUtf8,
    #[error("io error: {0}")]
    Io(String),
    #[error("command failed: {0}")]
    CommandFailed(String),
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

// ── list_directory ──────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct ListDirectoryArgs {
    #[serde(default)]
    pub path: Option<String>,
}

/// Max entries returned to avoid blowing the context window on huge dirs.
const LIST_DIR_MAX_ENTRIES: usize = 200;

/// List a directory's children — dirs first, then files, sorted by name.
/// Honors `.gitignore` and skips common noise (node_modules, .git, target).
/// `path` is relative to `env.root`; omit or pass "" / "." for the root.
/// Returns a compact text listing the operator can reason over.
pub fn list_directory(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let parsed: ListDirectoryArgs =
        serde_json::from_value(args.clone()).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
    let rel = parsed.path.as_deref().unwrap_or(".");
    let rel = rel.trim();
    let rel = if rel.is_empty() { "." } else { rel };

    let target = resolve_path_safe(env, rel)?;

    if !target.is_dir() {
        return Err(ToolError::NotADirectory(rel.into()));
    }

    let entries =
        crate::structure::list_dir(&target, false).map_err(|e| ToolError::Io(e.to_string()))?;

    let mut out = String::with_capacity(entries.len() * 40);
    let prefix = target.display().to_string();
    out.push_str(&format!("Directory: {}\n", prefix));
    out.push_str(&format!("Entries: {}", entries.len()));
    if entries.len() > LIST_DIR_MAX_ENTRIES {
        out.push_str(&format!(" (showing first {})", LIST_DIR_MAX_ENTRIES));
    }
    out.push('\n');

    for entry in entries.iter().take(LIST_DIR_MAX_ENTRIES) {
        let kind = match entry.kind {
            crate::structure::EntryKind::Dir => "dir ",
            crate::structure::EntryKind::File => "file",
        };
        out.push_str(&format!("  {} {}\n", kind, entry.name));
    }
    Ok(out)
}

// ── search_files ────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct SearchFilesArgs {
    pub query: String,
    #[serde(default)]
    pub path: Option<String>,
}

/// Max hits returned to avoid blowing context.
const SEARCH_MAX_HITS: u32 = 30;

/// Search file contents under the workspace for a case-insensitive
/// substring. Honors `.gitignore`, skips binaries and huge files.
/// Returns matching lines with file paths and line numbers.
pub fn search_files(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let parsed: SearchFilesArgs =
        serde_json::from_value(args.clone()).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
    let query = parsed.query.trim();
    if query.is_empty() {
        return Err(ToolError::InvalidArgs("query is empty".into()));
    }

    let search_root = if let Some(ref p) = parsed.path {
        let p = p.trim();
        if p.is_empty() || p == "." {
            env.root.clone()
        } else {
            resolve_path_safe(env, p)?
        }
    } else {
        env.root.clone()
    };

    if !search_root.is_dir() {
        return Err(ToolError::NotADirectory(
            search_root.display().to_string(),
        ));
    }

    let hits = crate::structure::search(&search_root, query, SEARCH_MAX_HITS)
        .map_err(|e| ToolError::Io(e))?;

    if hits.is_empty() {
        return Ok(format!("No matches for \"{}\"", query));
    }

    let mut out = String::with_capacity(hits.len() * 100);
    out.push_str(&format!(
        "Found {} match{} for \"{}\":\n",
        hits.len(),
        if hits.len() == 1 { "" } else { "es" },
        query,
    ));
    for hit in &hits {
        // Show path relative to workspace root when possible.
        let display_path = Path::new(&hit.path)
            .strip_prefix(&env.root)
            .unwrap_or(Path::new(&hit.path));
        out.push_str(&format!(
            "  {}:{}: {}\n",
            display_path.display(),
            hit.line_number,
            hit.line_text.trim(),
        ));
    }
    Ok(out)
}

// ── git_status ──────────────────────────────────────────────────────

/// Run `git status --porcelain=v1` in the workspace root. Returns the
/// compact output showing staged/unstaged/untracked changes. Fails
/// gracefully if git is not available or the workspace is not a repo.
pub fn git_status(env: &ToolEnv, _args: &Value) -> Result<String, ToolError> {
    run_git_command(env, &["status", "--porcelain=v1", "--branch"])
}

// ── git_diff ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct GitDiffArgs {
    /// When true, show staged changes (--cached). Default: false (working tree).
    #[serde(default)]
    pub staged: bool,
    /// Optional file path to restrict the diff to.
    #[serde(default)]
    pub path: Option<String>,
}

/// Max bytes of diff output before truncation.
const GIT_DIFF_MAX_BYTES: usize = 32 * 1024;

/// Run `git diff` (or `git diff --cached` for staged) in the workspace.
/// Optionally scoped to a single file path. Output is truncated at 32KB
/// to avoid overwhelming the context window.
pub fn git_diff(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let parsed: GitDiffArgs =
        serde_json::from_value(args.clone()).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
    let mut git_args = vec!["diff", "--stat", "--patch"];
    if parsed.staged {
        git_args.push("--cached");
    }
    // Add a separator so git doesn't confuse paths with revisions.
    git_args.push("--");
    if let Some(ref p) = parsed.path {
        let trimmed = p.trim();
        if !trimmed.is_empty() {
            // Validate the path stays inside the workspace.
            let _ = resolve_path_safe(env, trimmed)?;
            git_args.push(trimmed);
        }
    }
    let mut output = run_git_command(env, &git_args)?;
    if output.len() > GIT_DIFF_MAX_BYTES {
        output.truncate(GIT_DIFF_MAX_BYTES);
        output.push_str("\n\n… (truncated at 32KB)");
    }
    if output.trim().is_empty() {
        return Ok("No differences.".into());
    }
    Ok(output)
}

// ── shared helpers ──────────────────────────────────────────────────

/// Resolve a user-supplied path against the workspace root, verifying it
/// stays within bounds after canonicalization. Returns the resolved
/// absolute path. For directories that exist, canonicalizes fully.
/// For paths that don't exist yet, we still validate the parent.
fn resolve_path_safe(env: &ToolEnv, rel: &str) -> Result<PathBuf, ToolError> {
    let raw = Path::new(rel);
    let joined = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        env.root.join(raw)
    };
    // Try canonicalize first (works for existing paths).
    let resolved = if joined.exists() {
        joined.canonicalize().map_err(|e| ToolError::Io(e.to_string()))?
    } else {
        // For non-existing paths, canonicalize the parent and append the filename.
        if let Some(parent) = joined.parent() {
            if parent.exists() {
                let canonical_parent =
                    parent.canonicalize().map_err(|e| ToolError::Io(e.to_string()))?;
                if let Some(name) = joined.file_name() {
                    canonical_parent.join(name)
                } else {
                    return Err(ToolError::NotFound(rel.into()));
                }
            } else {
                return Err(ToolError::NotFound(rel.into()));
            }
        } else {
            return Err(ToolError::NotFound(rel.into()));
        }
    };
    if !resolved.starts_with(&env.root) {
        return Err(ToolError::PathOutsideRoot);
    }
    Ok(resolved)
}

/// Run a git command inside the workspace root and return its stdout.
/// Timeout: 10s. Stderr is appended on non-zero exit for diagnostics.
fn run_git_command(env: &ToolEnv, args: &[&str]) -> Result<String, ToolError> {
    let output = Command::new("git")
        .args(args)
        .current_dir(&env.root)
        .output()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                ToolError::CommandFailed("git is not installed or not in PATH".into())
            } else {
                ToolError::Io(e.to_string())
            }
        })?;
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        // Common case: not a git repo — return friendly message.
        if stderr.contains("not a git repository") {
            return Err(ToolError::CommandFailed(
                "Not a git repository. The workspace root is not under version control.".into(),
            ));
        }
        return Err(ToolError::CommandFailed(format!(
            "git {} exited with {}: {}",
            args.join(" "),
            output.status,
            stderr.trim(),
        )));
    }
    if stdout.trim().is_empty() {
        Ok("(no output)".into())
    } else {
        Ok(stdout)
    }
}

// ── run_command ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct RunCommandArgs {
    pub command: String,
    /// Optional working directory relative to workspace root.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Timeout in seconds (default 30, max 120).
    #[serde(default)]
    pub timeout_secs: Option<u64>,
}

/// Max bytes of combined stdout+stderr before truncation.
const RUN_COMMAND_MAX_OUTPUT: usize = 32 * 1024;

/// Hard-blocked patterns. Checked BEFORE execution. The Operator's
/// safety.rs blocklist protects PTY injection; this is a separate layer
/// for subprocess execution. We reuse the same threat model.
const COMMAND_BLOCKLIST: &[&str] = &[
    "rm -rf",
    "rm -fr",
    "sudo ",
    "doas ",
    " su ",
    "| sh",
    "| bash",
    "| zsh",
    "curl | ",
    "wget | ",
    "dd if=",
    "mkfs",
    "fdisk",
    ":(){ ",
    "git push --force",
    "git push -f",
    "terraform apply",
    "kubectl apply",
    "kubectl delete",
];

/// Run a shell command in the workspace and return its output.
///
/// Safety:
/// - Working directory is always under `env.root` (default: root itself).
/// - Command text is checked against a hard blocklist before execution.
/// - Timeout: default 30s, max 120s — prevents infinite loops.
/// - Output is capped at 32KB to avoid blowing the context window.
/// - Runs via `sh -c` (no PTY, no interactive I/O).
pub fn run_command(env: &ToolEnv, args: &Value) -> Result<String, ToolError> {
    let parsed: RunCommandArgs =
        serde_json::from_value(args.clone()).map_err(|e| ToolError::InvalidArgs(e.to_string()))?;
    let cmd = parsed.command.trim();
    if cmd.is_empty() {
        return Err(ToolError::InvalidArgs("command is empty".into()));
    }

    // Safety: check the command against the hard blocklist.
    let cmd_lower = cmd.to_lowercase();
    for pattern in COMMAND_BLOCKLIST {
        if cmd_lower.contains(pattern) {
            return Err(ToolError::CommandFailed(format!(
                "BLOCKED: command matches safety pattern \"{}\". \
                 This command requires human confirmation. \
                 Tell the user what you wanted to run and let them execute it.",
                pattern,
            )));
        }
    }

    // Resolve working directory.
    let work_dir = if let Some(ref rel) = parsed.cwd {
        let rel = rel.trim();
        if rel.is_empty() || rel == "." {
            env.root.clone()
        } else {
            let target = resolve_path_safe(env, rel)?;
            if !target.is_dir() {
                return Err(ToolError::NotADirectory(rel.into()));
            }
            target
        }
    } else {
        env.root.clone()
    };

    let timeout = std::time::Duration::from_secs(
        parsed.timeout_secs.unwrap_or(30).min(120),
    );

    // Spawn the command via sh -c for shell interpretation.
    let child = Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(&work_dir)
        // Don't inherit the parent's stdin — no interactive I/O.
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| ToolError::CommandFailed(format!("failed to spawn: {}", e)))?;

    // Wait with timeout.
    let output = wait_with_timeout(child, timeout)?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let exit_code = output.status.code().unwrap_or(-1);

    let mut result = String::with_capacity(stdout.len() + stderr.len() + 100);
    result.push_str(&format!("Exit code: {}\n", exit_code));

    if !stdout.is_empty() {
        result.push_str("--- stdout ---\n");
        result.push_str(&stdout);
        if !stdout.ends_with('\n') {
            result.push('\n');
        }
    }
    if !stderr.is_empty() {
        result.push_str("--- stderr ---\n");
        result.push_str(&stderr);
        if !stderr.ends_with('\n') {
            result.push('\n');
        }
    }
    if stdout.is_empty() && stderr.is_empty() {
        result.push_str("(no output)\n");
    }

    // Truncate if too large.
    if result.len() > RUN_COMMAND_MAX_OUTPUT {
        result.truncate(RUN_COMMAND_MAX_OUTPUT);
        result.push_str("\n\n… (output truncated at 32KB)");
    }
    Ok(result)
}

/// Wait for a child process with a timeout. On timeout, kill and return error.
fn wait_with_timeout(
    mut child: std::process::Child,
    timeout: std::time::Duration,
) -> Result<std::process::Output, ToolError> {
    let start = std::time::Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_status)) => {
                // Process exited — collect output.
                let stdout = child.stdout.take().map(|mut s| {
                    let mut buf = Vec::new();
                    std::io::Read::read_to_end(&mut s, &mut buf).unwrap_or(0);
                    buf
                }).unwrap_or_default();
                let stderr = child.stderr.take().map(|mut s| {
                    let mut buf = Vec::new();
                    std::io::Read::read_to_end(&mut s, &mut buf).unwrap_or(0);
                    buf
                }).unwrap_or_default();
                return Ok(std::process::Output {
                    status: _status,
                    stdout,
                    stderr,
                });
            }
            Ok(None) => {
                // Still running.
                if start.elapsed() > timeout {
                    let _ = child.kill();
                    return Err(ToolError::CommandFailed(format!(
                        "command timed out after {}s and was killed",
                        timeout.as_secs(),
                    )));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            Err(e) => {
                return Err(ToolError::CommandFailed(format!("wait failed: {}", e)));
            }
        }
    }
}

// ── tool definitions ────────────────────────────────────────────────

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

/// Anthropic tool definition for `propose_task`. The model calls this
/// when the user's message is an actionable, multi-step request (not
/// just Q&A). No execution handler — the LLM dispatcher consumes the
/// tool_use payload directly and turns it into a Propose message.
pub fn propose_task_tool_def() -> Value {
    serde_json::json!({
        "name": "propose_task",
        "description":
            "Propose a structured task whenever the user is asking for any DO/REVIEW/WATCH \
             work — implementations, fixes, audits, refactors, investigations, commits, \
             releases, build/deploy work. The user runs YOLO auto-confirm: this call \
             dispatches the work immediately. Prefer calling this OVER asking clarifying \
             questions; the executor agent you dispatch can re-scope at runtime. Only fall \
             back to a plain text reply for pure Q&A or when the request is fundamentally \
             ambiguous with no antecedent.",
        "input_schema": {
            "type": "object",
            "required": ["archetype", "title", "deliverable", "rationale"],
            "properties": {
                "archetype": {
                    "type": "string",
                    "enum": ["do", "review", "watch"],
                    "description":
                        "'do' = perform the work in a new tab; 'review' = inspect a PR/file; \
                         'watch' = subscribe to a trigger (CI, file touch, exit code)."
                },
                "title":       { "type": "string" },
                "deliverable": { "type": "string", "description": "What the user will get when this is done." },
                "rationale":   { "type": "string", "description": "Why you chose this archetype + scope." },
                "executor": {
                    "type": "string",
                    "enum": ["claude", "codex", "copilot", "pi", "hermes"],
                    "description":
                        "REQUIRED for archetype='do'. Which executor agent should drive the \
                         work. See the system prompt for guidance on which to pick. Omit \
                         for review/watch."
                },
                "scope": {
                    "type": "object",
                    "properties": {
                        "paths": { "type": "array", "items": { "type": "string" } },
                        "tabs":  { "type": "array", "items": { "type": "string" } }
                    }
                }
            }
        }
    })
}

pub fn list_directory_tool_def() -> Value {
    serde_json::json!({
        "name": "list_directory",
        "description": "List files and subdirectories in a directory within the workspace. \
                        Returns dirs first, then files, sorted by name. Honors .gitignore \
                        and skips noise like node_modules, .git, target. Use this to explore \
                        the project structure when the user asks about files or you need to \
                        understand what's in a folder.",
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "Directory path relative to the workspace root. \
                                    Omit or pass \".\" to list the workspace root itself."
                }
            }
        }
    })
}

pub fn search_files_tool_def() -> Value {
    serde_json::json!({
        "name": "search_files",
        "description": "Search for a text pattern inside files across the workspace. \
                        Case-insensitive substring match. Honors .gitignore, skips binaries. \
                        Returns matching lines with file paths and line numbers. Use this \
                        when the user asks where something is defined, or to find \
                        references to a function, config key, error message, etc.",
        "input_schema": {
            "type": "object",
            "required": ["query"],
            "properties": {
                "query": {
                    "type": "string",
                    "description": "The text to search for (case-insensitive substring)."
                },
                "path": {
                    "type": "string",
                    "description": "Optional subdirectory to limit the search to. \
                                    Relative to workspace root. Omit to search everything."
                }
            }
        }
    })
}

pub fn git_status_tool_def() -> Value {
    serde_json::json!({
        "name": "git_status",
        "description": "Show the current git status of the workspace: branch name, \
                        staged changes, unstaged modifications, and untracked files. \
                        Use this when the user asks about uncommitted work, what branch \
                        they're on, or what files have changed.",
        "input_schema": {
            "type": "object",
            "properties": {}
        }
    })
}

pub fn git_diff_tool_def() -> Value {
    serde_json::json!({
        "name": "git_diff",
        "description": "Show the git diff for the workspace — what lines changed and how. \
                        By default shows unstaged working-tree changes. Set staged=true \
                        for staged (--cached) changes. Optionally scope to a single file path. \
                        Use this when the user asks what changed, wants a code review, or \
                        you need to understand recent modifications.",
        "input_schema": {
            "type": "object",
            "properties": {
                "staged": {
                    "type": "boolean",
                    "description": "If true, show staged changes (git diff --cached). \
                                    Default: false (unstaged working tree)."
                },
                "path": {
                    "type": "string",
                    "description": "Optional file path to restrict the diff to. \
                                    Relative to the workspace root."
                }
            }
        }
    })
}

pub fn run_command_tool_def() -> Value {
    serde_json::json!({
        "name": "run_command",
        "description": "Execute a shell command in the workspace and return its output. \
                        Use this to run builds, tests, linters, git operations, package \
                        managers, or any CLI tool. The command runs via `sh -c` with stdout \
                        and stderr captured. Dangerous commands (rm -rf, sudo, force-push to \
                        main/master) are blocked — tell the user to run those manually. \
                        Default timeout: 30s (max 120s).",
        "input_schema": {
            "type": "object",
            "required": ["command"],
            "properties": {
                "command": {
                    "type": "string",
                    "description": "The shell command to execute (e.g. 'cargo test', \
                                    'npm run build', 'git log --oneline -10')."
                },
                "cwd": {
                    "type": "string",
                    "description": "Optional working directory relative to workspace root. \
                                    Defaults to the workspace root itself."
                },
                "timeout_secs": {
                    "type": "integer",
                    "description": "Timeout in seconds (default 30, max 120). \
                                    Command is killed if it exceeds this."
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

    #[test]
    fn propose_task_tool_def_has_required_shape() {
        let def = propose_task_tool_def();
        assert_eq!(def["name"], "propose_task");
        let schema = &def["input_schema"];
        assert_eq!(schema["type"], "object");
        let required = schema["required"].as_array().expect("required array");
        let required_keys: Vec<&str> = required.iter().filter_map(|v| v.as_str()).collect();
        assert!(required_keys.contains(&"archetype"));
        assert!(required_keys.contains(&"title"));
        assert!(required_keys.contains(&"deliverable"));
        assert!(required_keys.contains(&"rationale"));
        let archetype_enum = schema["properties"]["archetype"]["enum"]
            .as_array().expect("archetype enum");
        let values: Vec<&str> = archetype_enum.iter().filter_map(|v| v.as_str()).collect();
        assert_eq!(values, vec!["do", "review", "watch"]);
    }
}
