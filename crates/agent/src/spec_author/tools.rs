//! Read-only repo tools for the streaming spec author. All file access is
//! confined to a canonicalized repo root.

use serde_json::Value;
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

/// Filename patterns that are always rejected (secret-bearing files).
const SECRET_FILENAMES: &[&str] = &[
    ".env",
    ".envrc",
    ".npmrc",
    ".netrc",
    "id_rsa",
    "id_ed25519",
    "id_dsa",
    ".pem",
    ".key",
    "credentials",
    ".pgpass",
    ".htpasswd",
];

/// Resolve `rel` against canonical `root`, rejecting escapes and secret paths.
pub fn safe_join(root: &Path, rel: &str) -> Result<PathBuf, ToolError> {
    use std::path::Component;

    let rel_norm = rel.replace('\\', "/");
    if SECRET_FRAGMENTS.iter().any(|f| rel_norm.contains(f)) {
        return Err(ToolError::Secret);
    }

    if let Some(fname) = Path::new(&rel_norm).file_name().and_then(|f| f.to_str()) {
        let lower = fname.to_ascii_lowercase();
        let blocked = SECRET_FILENAMES
            .iter()
            .any(|s| lower == *s || (s.starts_with('.') && lower.ends_with(s)));
        if blocked {
            return Err(ToolError::Secret);
        }
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
const GREP_CAP: usize = 200;

/// Compile a `*`/`?` filename glob into an anchored regex over the relative path.
/// `*` crosses directory separators on purpose — `*.rs` matches at any depth.
fn glob_to_regex(pattern: &str) -> Option<regex::Regex> {
    let mut re = String::with_capacity(pattern.len() + 8);
    re.push('^');
    for c in pattern.chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            other => re.push_str(&regex::escape(&other.to_string())),
        }
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

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

/// Regex grep over files under `dir` (default whole root), with an optional
/// `*`/`?` filename glob filter. Invalid regex degrades to a literal search.
/// Returns up to 200 `path:line: text` hit strings.
pub fn grep(
    root: &Path,
    pattern: &str,
    dir: Option<&str>,
    glob: Option<&str>,
) -> Result<Vec<String>, ToolError> {
    let base = match dir {
        Some(d) => safe_join(root, d)?,
        None => root.to_path_buf(),
    };
    let re = regex::Regex::new(pattern)
        .or_else(|_| regex::Regex::new(&regex::escape(pattern)))
        .map_err(|_| ToolError::NotFound)?;
    let glob_re = glob.and_then(glob_to_regex);
    let mut hits = Vec::new();
    let walker = walk(&base);
    for file in walker {
        if hits.len() >= GREP_CAP {
            break;
        }
        let rel = file.strip_prefix(root).unwrap_or(&file);
        if let Some(g) = &glob_re {
            if !g.is_match(&rel.to_string_lossy().replace('\\', "/")) {
                continue;
            }
        }
        let Ok(text) = std::fs::read_to_string(&file) else {
            continue;
        };
        for (i, line) in text.lines().enumerate() {
            if re.is_match(line) {
                hits.push(format!("{}:{}: {}", rel.display(), i + 1, line.trim()));
                if hits.len() >= GREP_CAP {
                    break;
                }
            }
        }
    }
    Ok(hits)
}

/// List repo files whose relative path matches a `*`/`?` glob. No content read.
pub fn glob_files(root: &Path, pattern: &str) -> Result<Vec<String>, ToolError> {
    let Some(re) = glob_to_regex(pattern) else {
        return Ok(Vec::new());
    };
    let mut out = Vec::new();
    for file in walk(root) {
        if out.len() >= GREP_CAP {
            break;
        }
        let rel = file
            .strip_prefix(root)
            .unwrap_or(&file)
            .to_string_lossy()
            .replace('\\', "/");
        if re.is_match(&rel) {
            out.push(rel);
        }
    }
    out.sort();
    Ok(out)
}

// ── Git history (read-only, fixed-arg subprocess — never a shell string) ─────

/// A git rev is accepted only if it looks like a plain rev token. Rejects
/// anything that could be parsed as a flag or shell metacharacter.
fn valid_rev(rev: &str) -> bool {
    !rev.is_empty()
        && !rev.starts_with('-')
        && rev.len() <= 128
        && rev
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '/' | '~' | '^' | '-'))
}

fn run_git(root: &Path, args: &[&str]) -> Result<String, ToolError> {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .map_err(|_| ToolError::NotFound)?;
    let text = if out.status.success() {
        String::from_utf8_lossy(&out.stdout).into_owned()
    } else {
        format!("git error: {}", String::from_utf8_lossy(&out.stderr))
    };
    Ok(text.chars().take(READ_CAP).collect())
}

/// `git log --oneline -n<n> [-- <path>]`, n clamped to 20.
pub fn git_log(root: &Path, path: Option<&str>, n: usize) -> Result<String, ToolError> {
    let n = n.clamp(1, 20).to_string();
    let count = format!("-n{}", n);
    let mut args: Vec<&str> = vec!["log", "--oneline", "--no-color", &count];
    let joined;
    if let Some(p) = path {
        joined = safe_join(root, p)?; // jail + secret check; also verifies existence
        let _ = &joined;
        args.push("--");
        args.push(p);
    }
    run_git(root, &args)
}

/// `git show --stat <rev>` or `git show <rev>:<path>` (file content at rev).
pub fn git_show(root: &Path, rev: &str, path: Option<&str>) -> Result<String, ToolError> {
    if !valid_rev(rev) {
        return Err(ToolError::Escape);
    }
    match path {
        Some(p) => {
            // Path may not exist in the working tree (historical file) — apply
            // the secret/escape checks lexically without requiring existence.
            let rel_norm = p.replace('\\', "/");
            if rel_norm.starts_with('/') || rel_norm.contains("..") {
                return Err(ToolError::Escape);
            }
            if SECRET_FRAGMENTS.iter().any(|f| rel_norm.contains(f)) {
                return Err(ToolError::Secret);
            }
            if let Some(fname) = Path::new(&rel_norm).file_name().and_then(|f| f.to_str()) {
                let lower = fname.to_ascii_lowercase();
                if SECRET_FILENAMES
                    .iter()
                    .any(|s| lower == *s || (s.starts_with('.') && lower.ends_with(s)))
                {
                    return Err(ToolError::Secret);
                }
            }
            let spec = format!("{}:{}", rev, rel_norm);
            run_git(root, &["show", "--no-color", &spec])
        }
        None => run_git(root, &["show", "--stat", "--no-color", rev]),
    }
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
        let Ok(rd) = std::fs::read_dir(&dir) else {
            continue;
        };
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

/// JSON tool schemas for the Anthropic `tools` request field.
pub fn tool_specs() -> Value {
    serde_json::json!([
        {
            "name": "grep",
            "description": "Regex search across repo files (invalid regex falls back to literal). Optional dir to scope, optional filename glob (e.g. *.rs). Returns up to 200 path:line hits.",
            "input_schema": { "type": "object",
                "properties": { "pattern": {"type":"string"}, "dir": {"type":"string"}, "glob": {"type":"string"} },
                "required": ["pattern"] }
        },
        {
            "name": "read_file",
            "description": "Read a repo file. Optional 1-based line range 'start-end'. Capped at 32KiB.",
            "input_schema": { "type": "object",
                "properties": { "path": {"type":"string"}, "range": {"type":"string"} },
                "required": ["path"] }
        },
        {
            "name": "list_dir",
            "description": "List immediate entries of a repo directory.",
            "input_schema": { "type": "object",
                "properties": { "path": {"type":"string"} }, "required": ["path"] }
        },
        {
            "name": "glob",
            "description": "Find files by relative-path glob (* and ?), e.g. ui/src/*.ts or *.test.ts. Returns up to 200 paths.",
            "input_schema": { "type": "object",
                "properties": { "pattern": {"type":"string"} }, "required": ["pattern"] }
        },
        {
            "name": "git_log",
            "description": "Recent commit history: git log --oneline (max 20). Optional path to scope to a file or directory.",
            "input_schema": { "type": "object",
                "properties": { "path": {"type":"string"}, "n": {"type":"integer"} } }
        },
        {
            "name": "git_show",
            "description": "Inspect a commit (git show --stat <rev>) or a file's content at a rev (rev + path).",
            "input_schema": { "type": "object",
                "properties": { "rev": {"type":"string"}, "path": {"type":"string"} },
                "required": ["rev"] }
        },
        {
            "name": "ask_user",
            "description": "Ask the coordinator ONE question with 2-4 concrete options. This ends your turn; the answer arrives as the next user message. Put your recommended option first and mark it. Use this for EVERY question — never ask in prose.",
            "input_schema": { "type": "object",
                "properties": {
                    "question": {"type":"string"},
                    "options": {"type":"array", "items": {"type":"object",
                        "properties": { "label": {"type":"string"}, "detail": {"type":"string"} },
                        "required": ["label"] }, "minItems": 2, "maxItems": 4 }
                },
                "required": ["question", "options"] }
        }
    ])
}

/// Same tools in OpenAI Chat Completions `tools` shape
/// (`{type:"function", function:{name, description, parameters}}`). Used by the
/// Azure / OpenAI-compat streaming dispatcher.
pub fn tool_specs_openai() -> Value {
    to_openai_tools(&tool_specs())
}

/// Convert an Anthropic-format tool array (`{name, description, input_schema}`)
/// to the OpenAI function-calling format. Shared by the spec author and the
/// context miner so a custom tool roster (e.g. `emit_finding`) works on either
/// provider without maintaining two hand-written schemas.
pub fn to_openai_tools(anthropic: &Value) -> Value {
    let arr = anthropic.as_array().cloned().unwrap_or_default();
    let converted: Vec<Value> = arr
        .into_iter()
        .map(|t| {
            serde_json::json!({
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["input_schema"],
                }
            })
        })
        .collect();
    Value::Array(converted)
}

fn pluralize(n: usize, noun: &str) -> String {
    format!("{} {}{}", n, noun, if n == 1 { "" } else { "s" })
}

/// Execute a tool call by name with JSON `input`; returns (result_text, summary).
/// `ask_user` never reaches here — the stream loop intercepts it.
pub fn run_tool(root: &Path, name: &str, input: &Value) -> (String, String) {
    let s = |k: &str| input.get(k).and_then(|v| v.as_str());
    match name {
        "grep" => {
            // Accept legacy `needle` too — resumed drafts may replay old calls.
            let pattern = s("pattern").or_else(|| s("needle")).unwrap_or("");
            match grep(root, pattern, s("dir"), s("glob")) {
                Ok(hits) => (hits.join("\n"), pluralize(hits.len(), "match")),
                Err(e) => (format!("error: {e}"), "error".into()),
            }
        }
        "read_file" => match read_file(root, s("path").unwrap_or(""), s("range")) {
            Ok(text) => (text, "read".into()),
            Err(e) => (format!("error: {e}"), "error".into()),
        },
        "list_dir" => match list_dir(root, s("path").unwrap_or("")) {
            Ok(entries) => (entries.join("\n"), pluralize(entries.len(), "entry")),
            Err(e) => (format!("error: {e}"), "error".into()),
        },
        "glob" => match glob_files(root, s("pattern").unwrap_or("")) {
            Ok(files) => (files.join("\n"), pluralize(files.len(), "file")),
            Err(e) => (format!("error: {e}"), "error".into()),
        },
        "git_log" => {
            let n = input.get("n").and_then(|v| v.as_u64()).unwrap_or(10) as usize;
            match git_log(root, s("path"), n) {
                Ok(text) => (text, "log".into()),
                Err(e) => (format!("error: {e}"), "error".into()),
            }
        }
        "git_show" => match git_show(root, s("rev").unwrap_or(""), s("path")) {
            Ok(text) => (text, "show".into()),
            Err(e) => (format!("error: {e}"), "error".into()),
        },
        other => (format!("unknown tool: {other}"), "error".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        use std::sync::atomic::{AtomicUsize, Ordering};
        static N: AtomicUsize = AtomicUsize::new(0);
        let unique = format!(
            "spec-tools-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        );
        let d = std::env::temp_dir().join(unique);
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
        assert_eq!(
            safe_join(&r, "../../etc/passwd").unwrap_err(),
            ToolError::Escape
        );
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
        assert_eq!(
            safe_join(&r, "src/nope.rs").unwrap_err(),
            ToolError::NotFound
        );
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
        let hits = grep(&r, "fn main", Some("src"), None).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].contains("a.rs"));
    }

    #[test]
    fn grep_supports_regex() {
        let r = root();
        let hits = grep(&r, r"fn \w+\(\)", None, None).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].contains("a.rs"));
    }

    #[test]
    fn grep_invalid_regex_falls_back_to_literal() {
        let r = root();
        std::fs::write(r.join("src/weird.txt"), "a(b [literal").unwrap();
        let hits = grep(&r, "a(b [literal", None, None).unwrap();
        assert_eq!(hits.len(), 1);
    }

    #[test]
    fn grep_glob_filters_files() {
        let r = root();
        std::fs::write(r.join("src/notes.txt"), "fn main() {}").unwrap();
        let hits = grep(&r, "fn main", None, Some("*.rs")).unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].contains("a.rs"));
    }

    #[test]
    fn glob_files_matches_relative_paths() {
        let r = root();
        std::fs::write(r.join("src/b.txt"), "x").unwrap();
        let files = glob_files(&r, "*.rs").unwrap();
        assert_eq!(files, vec!["src/a.rs".to_string()]);
        let all_src = glob_files(&r, "src/*").unwrap();
        assert_eq!(all_src.len(), 2);
    }

    fn git_root() -> PathBuf {
        let r = root();
        let run = |args: &[&str]| {
            let ok = std::process::Command::new("git")
                .args(args)
                .current_dir(&r)
                .env("GIT_AUTHOR_NAME", "t")
                .env("GIT_AUTHOR_EMAIL", "t@t")
                .env("GIT_COMMITTER_NAME", "t")
                .env("GIT_COMMITTER_EMAIL", "t@t")
                .output()
                .unwrap()
                .status
                .success();
            assert!(ok, "git {:?} failed", args);
        };
        run(&["init", "-q"]);
        run(&["add", "."]);
        run(&["commit", "-qm", "initial"]);
        r
    }

    #[test]
    fn git_log_returns_history() {
        let r = git_root();
        let log = git_log(&r, None, 10).unwrap();
        assert!(log.contains("initial"));
        let scoped = git_log(&r, Some("src/a.rs"), 10).unwrap();
        assert!(scoped.contains("initial"));
    }

    #[test]
    fn git_show_reads_file_at_rev() {
        let r = git_root();
        let content = git_show(&r, "HEAD", Some("src/a.rs")).unwrap();
        assert!(content.contains("fn main"));
        let stat = git_show(&r, "HEAD", None).unwrap();
        assert!(stat.contains("initial"));
    }

    #[test]
    fn git_show_rejects_flag_and_metachar_revs() {
        let r = git_root();
        assert_eq!(
            git_show(&r, "--upload-pack=/bin/sh", None).unwrap_err(),
            ToolError::Escape
        );
        assert_eq!(
            git_show(&r, "$(rm -rf /)", None).unwrap_err(),
            ToolError::Escape
        );
        assert_eq!(git_show(&r, "", None).unwrap_err(), ToolError::Escape);
    }

    #[test]
    fn git_show_path_rejects_escape_and_secrets() {
        let r = git_root();
        assert_eq!(
            git_show(&r, "HEAD", Some("../outside")).unwrap_err(),
            ToolError::Escape
        );
        assert_eq!(
            git_show(&r, "HEAD", Some(".ssh/id_rsa")).unwrap_err(),
            ToolError::Secret
        );
        assert_eq!(
            git_show(&r, "HEAD", Some("config/.env")).unwrap_err(),
            ToolError::Secret
        );
    }

    #[test]
    fn list_dir_lists_entries() {
        let r = root();
        let entries = list_dir(&r, "src").unwrap();
        assert!(entries.iter().any(|e| e.ends_with("a.rs")));
    }

    #[test]
    fn run_tool_grep_summarizes() {
        let r = root();
        let (text, summary) = run_tool(
            &r,
            "grep",
            &serde_json::json!({"pattern":"fn main","dir":"src"}),
        );
        assert!(text.contains("a.rs"));
        assert_eq!(summary, "1 match");
        // Legacy `needle` calls from resumed drafts still work.
        let (text2, _) = run_tool(&r, "grep", &serde_json::json!({"needle":"fn main"}));
        assert!(text2.contains("a.rs"));
    }

    #[test]
    fn run_tool_unknown_is_error() {
        let r = root();
        let (text, summary) = run_tool(&r, "rm", &serde_json::json!({}));
        assert_eq!(summary, "error");
        assert!(text.contains("unknown tool"));
    }

    #[test]
    fn tool_specs_lists_seven_tools() {
        let specs = tool_specs();
        let arr = specs.as_array().unwrap();
        assert_eq!(arr.len(), 7);
        let names: Vec<&str> = arr.iter().filter_map(|t| t["name"].as_str()).collect();
        assert!(names.contains(&"ask_user"));
        assert!(names.contains(&"git_log"));
        assert_eq!(tool_specs_openai().as_array().unwrap().len(), 7);
    }

    #[test]
    fn read_file_rejects_dotenv() {
        let r = root();
        std::fs::write(r.join(".env"), "API_KEY=sk-secret").unwrap();
        assert_eq!(read_file(&r, ".env", None).unwrap_err(), ToolError::Secret);
    }

    #[test]
    fn safe_join_rejects_pem_and_key() {
        let r = root();
        std::fs::write(r.join("server.pem"), "x").unwrap();
        assert_eq!(safe_join(&r, "server.pem").unwrap_err(), ToolError::Secret);
        assert_eq!(safe_join(&r, "app.key").unwrap_err(), ToolError::Secret);
    }
}
