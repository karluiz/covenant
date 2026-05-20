//! Directory-context detection for the status bar (3.7).
//!
//! Pure functions over a `cwd`:
//!   - `detect_git_context`  — `git -C <cwd> rev-parse / symbolic-ref` shells
//!     out (cheap, ~5 ms warm). Detached HEAD reports the short SHA.
//!   - `detect_runtime`      — file probes only (`Cargo.toml`, `package.json`,
//!     `pyproject.toml`, `go.mod`, `Gemfile`). No subprocesses, no version
//!     resolution beyond what the manifest declares.
//!
//! Both feed `dir_context(cwd)` which combines them and stuffs the answer
//! into a tiny LRU keyed by cwd. The frontend re-calls on every
//! `cwd_changed` event so the cache is mostly there to keep tab-switch
//! flicker invisible — branch changes inside the same cwd are accepted
//! to lag until the next `cd` (per spec).

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitInfo {
    /// Basename of `git rev-parse --show-toplevel`. Empty toplevel → empty
    /// string (shouldn't happen for a real repo but we don't panic).
    pub repo_name: String,
    /// `main`, `feat/foo`, or `DETACHED@<short-sha>` for detached HEAD.
    pub branch: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct RuntimeInfo {
    /// Lowercase identifier we render in the UI (`node`, `python`, `rust`,
    /// `go`, `ruby`).
    pub language: String,
    /// File-declared version when extractable, else `None`. We never run
    /// the actual binary — declared is "good enough" for the v1 spec.
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct DirContext {
    pub git: Option<GitInfo>,
    pub runtime: Option<RuntimeInfo>,
}

/// Probe order = popularity at top-level, per spec Open Question.
/// First match wins; polyglot repos surface only the head of the list.
const RUNTIME_PROBES: &[(&str, &str)] = &[
    ("package.json", "node"),
    ("pyproject.toml", "python"),
    ("Cargo.toml", "rust"),
    ("go.mod", "go"),
    ("Gemfile", "ruby"),
];

pub fn detect_runtime(cwd: &Path) -> Option<RuntimeInfo> {
    for (manifest, language) in RUNTIME_PROBES {
        let path = cwd.join(manifest);
        if !path.is_file() {
            continue;
        }
        let body = std::fs::read_to_string(&path).ok();
        let version = body
            .as_deref()
            .and_then(|b| extract_version(language, b))
            .or_else(|| read_version_file(language, cwd))
            .or_else(|| query_runtime_binary(language));
        return Some(RuntimeInfo {
            language: (*language).to_string(),
            version,
        });
    }
    None
}

/// Tier-2 fallback: read a sibling version file like `.nvmrc`,
/// `.python-version`, `.ruby-version`, `rust-toolchain[.toml]`, or an
/// asdf-style `.tool-versions`. File-only — no subprocess.
fn read_version_file(language: &str, cwd: &Path) -> Option<String> {
    // asdf / mise style: `<lang> <ver>` lines, applies to any runtime.
    if let Ok(body) = std::fs::read_to_string(cwd.join(".tool-versions")) {
        for line in body.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix(&format!("{language} ")) {
                let v = rest.split_whitespace().next()?.trim();
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    let candidates: &[&str] = match language {
        "node" => &[".nvmrc", ".node-version"],
        "python" => &[".python-version"],
        "ruby" => &[".ruby-version"],
        "rust" => &["rust-toolchain.toml", "rust-toolchain"],
        _ => &[],
    };
    for name in candidates {
        let p = cwd.join(name);
        let Ok(body) = std::fs::read_to_string(&p) else {
            continue;
        };
        // rust-toolchain.toml: `[toolchain] channel = "1.84"`
        if *name == "rust-toolchain.toml" {
            if let Some(v) = extract_quoted_after(&body, "channel") {
                return Some(v);
            }
            continue;
        }
        let first = body.lines().next().unwrap_or("").trim();
        let v = first.trim_start_matches('v');
        if !v.is_empty() {
            return Some(v.to_string());
        }
    }
    None
}

/// Tier-3 fallback: ask the runtime binary itself. Short, blocking call;
/// the caller is already on a worker thread and the result is cached.
fn query_runtime_binary(language: &str) -> Option<String> {
    let cmd = match language {
        "node" => "node -v",
        "python" => "python3 --version 2>&1",
        "rust" => "rustc --version",
        "go" => "go version",
        "ruby" => "ruby --version",
        _ => return None,
    };
    // GUI apps on macOS launched from Finder/.app inherit a minimal PATH
    // (no nvm, pyenv, asdf, or Homebrew shims). Run through the user's
    // login+interactive shell so PATH-mutating rc files (~/.zshrc, ~/.bash_profile)
    // run first. Slower than a direct exec, but the LRU caches the answer
    // per cwd, so this only happens on first detection of an unknown cwd.
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    // Marker isolates our output from any chatter rc files print on
    // interactive startup (banners, MOTDs, plugin manager status lines).
    let wrapped = format!("printf '__KT_V_START__\\n'; {cmd}");
    let out = Command::new(&shell)
        .args(["-ilc", &wrapped])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let raw = String::from_utf8(out.stdout).ok()?;
    let s = raw
        .split("__KT_V_START__")
        .nth(1)
        .unwrap_or(raw.as_str())
        .trim();
    // Pluck the first dotted version-looking token from the output.
    // Examples: "v20.11.0" → "20.11.0"; "Python 3.12.1" → "3.12.1";
    // "rustc 1.84.0 (...)" → "1.84.0"; "go version go1.22 darwin/arm64".
    for tok in s.split_whitespace() {
        let t = tok.trim_start_matches('v').trim_start_matches("go");
        if t.chars().next()?.is_ascii_digit() && t.contains('.') {
            // Strip a trailing paren/comma/etc.
            let end = t
                .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c.is_alphabetic()))
                .unwrap_or(t.len());
            return Some(t[..end].to_string());
        }
    }
    None
}

/// Best-effort version extraction from the manifest body. Each branch is
/// a small, intentionally forgiving regex/string scan — the goal is "a
/// version when we can find one"; we never fail the whole detection on
/// a parse miss.
fn extract_version(language: &str, body: &str) -> Option<String> {
    match language {
        "node" => {
            // package.json: "engines": { "node": ">=20.11" }
            let key = "\"node\"";
            let pos = body.find(key)?;
            let after = &body[pos + key.len()..];
            let colon = after.find(':')?;
            let rest = &after[colon + 1..];
            let q1 = rest.find('"')?;
            let q2 = rest[q1 + 1..].find('"')?;
            let v = rest[q1 + 1..q1 + 1 + q2].trim();
            Some(strip_version_prefix(v).to_string())
        }
        "python" => {
            // pyproject.toml: requires-python = ">=3.12"
            extract_quoted_after(body, "requires-python")
                .map(|v| strip_version_prefix(&v).to_string())
        }
        "rust" => {
            // Cargo.toml: rust-version = "1.84"
            extract_quoted_after(body, "rust-version")
        }
        "go" => {
            // go.mod: line `go 1.22`
            for line in body.lines() {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("go ") {
                    return Some(rest.trim().to_string());
                }
            }
            None
        }
        "ruby" => {
            // Gemfile: line `ruby "3.2"` or `ruby '3.2'`
            for line in body.lines() {
                let t = line.trim();
                if let Some(rest) = t.strip_prefix("ruby ") {
                    let rest = rest.trim();
                    let stripped = rest
                        .trim_matches(|c: char| c == '\'' || c == '"')
                        .to_string();
                    return Some(stripped);
                }
            }
            None
        }
        _ => None,
    }
}

/// Find `key = "<value>"` (or `key: "<value>"`) and return `<value>`. Used
/// for both TOML and JSON-ish lines.
fn extract_quoted_after(body: &str, key: &str) -> Option<String> {
    let pos = body.find(key)?;
    let after = &body[pos + key.len()..];
    let q1 = after.find('"')?;
    let q2 = after[q1 + 1..].find('"')?;
    Some(after[q1 + 1..q1 + 1 + q2].trim().to_string())
}

/// `>=3.12` → `3.12`. Keeps ranges like `^1.2 || ^2.0` intact (we'd rather
/// surface the raw declaration than guess wrong).
fn strip_version_prefix(v: &str) -> &str {
    let v = v.trim();
    v.trim_start_matches(|c: char| {
        c == '>' || c == '=' || c == '<' || c == '~' || c == '^' || c == ' '
    })
}

pub fn detect_git_context(cwd: &Path) -> Option<GitInfo> {
    if !cwd.is_dir() {
        return None;
    }
    let toplevel = run_git(cwd, &["rev-parse", "--show-toplevel"])?;
    let toplevel = toplevel.trim();
    if toplevel.is_empty() {
        return None;
    }
    let repo_name = crate::git_tools::display_repo_name(Path::new(toplevel));

    // Branch first, fall back to detached short-sha.
    let branch = match run_git(cwd, &["symbolic-ref", "--short", "HEAD"]) {
        Some(s) => {
            let t = s.trim();
            if t.is_empty() {
                detached_label(cwd)?
            } else {
                t.to_string()
            }
        }
        None => detached_label(cwd)?,
    };

    Some(GitInfo { repo_name, branch })
}

fn detached_label(cwd: &Path) -> Option<String> {
    let sha = run_git(cwd, &["rev-parse", "--short", "HEAD"])?;
    let sha = sha.trim();
    if sha.is_empty() {
        None
    } else {
        Some(format!("DETACHED@{sha}"))
    }
}

fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = Command::new("git")
        .arg("-C")
        .arg(cwd)
        .args(args)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

// ─── LRU cache ───────────────────────────────────────────────

const CACHE_TTL: Duration = Duration::from_secs(5);
const CACHE_CAP: usize = 16;

struct CacheEntry {
    inserted_at: Instant,
    last_used_at: Instant,
    value: DirContext,
}

#[derive(Default)]
pub struct ContextCache {
    inner: Mutex<HashMap<PathBuf, CacheEntry>>,
}

impl ContextCache {
    pub fn new() -> Self {
        Self::default()
    }

    /// Probe the cache. `None` is also returned for expired entries —
    /// callers should fall back to fresh detection and `insert` the result.
    pub fn get(&self, cwd: &Path) -> Option<DirContext> {
        let mut map = self.inner.lock().ok()?;
        let entry = map.get_mut(cwd)?;
        if entry.inserted_at.elapsed() > CACHE_TTL {
            map.remove(cwd);
            return None;
        }
        entry.last_used_at = Instant::now();
        Some(entry.value.clone())
    }

    pub fn insert(&self, cwd: PathBuf, value: DirContext) {
        let Ok(mut map) = self.inner.lock() else {
            return;
        };
        if map.len() >= CACHE_CAP && !map.contains_key(&cwd) {
            // Evict the entry whose last_used_at is oldest.
            if let Some(victim) = map
                .iter()
                .min_by_key(|(_, e)| e.last_used_at)
                .map(|(k, _)| k.clone())
            {
                map.remove(&victim);
            }
        }
        let now = Instant::now();
        map.insert(
            cwd,
            CacheEntry {
                inserted_at: now,
                last_used_at: now,
                value,
            },
        );
    }

    pub fn invalidate(&self, cwd: &Path) {
        if let Ok(mut map) = self.inner.lock() {
            map.remove(cwd);
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.inner.lock().map(|m| m.len()).unwrap_or(0)
    }
}

/// Combined, cached probe — the entry point the Tauri command calls.
pub fn dir_context(cwd: &Path, cache: &ContextCache) -> DirContext {
    if let Some(hit) = cache.get(cwd) {
        return hit;
    }
    let ctx = DirContext {
        git: detect_git_context(cwd),
        runtime: detect_runtime(cwd),
    };
    cache.insert(cwd.to_path_buf(), ctx.clone());
    ctx
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, name: &str, body: &str) {
        fs::write(dir.join(name), body).unwrap();
    }

    // ── Runtime detection ──────────────────────────────────

    #[test]
    fn runtime_none_for_empty_dir() {
        let dir = tempfile::tempdir().unwrap();
        assert!(detect_runtime(dir.path()).is_none());
    }

    #[test]
    fn runtime_node_with_engines_version() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "package.json",
            r#"{"name":"x","engines":{"node":">=20.11"}}"#,
        );
        let r = detect_runtime(dir.path()).unwrap();
        assert_eq!(r.language, "node");
        assert_eq!(r.version.as_deref(), Some("20.11"));
    }

    #[test]
    fn runtime_node_without_version() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "package.json", r#"{"name":"x"}"#);
        let r = detect_runtime(dir.path()).unwrap();
        assert_eq!(r.language, "node");
        assert!(r.version.is_none());
    }

    #[test]
    fn runtime_python_strips_range_prefix() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "pyproject.toml",
            "[project]\nname = \"x\"\nrequires-python = \">=3.12\"\n",
        );
        let r = detect_runtime(dir.path()).unwrap();
        assert_eq!(r.language, "python");
        assert_eq!(r.version.as_deref(), Some("3.12"));
    }

    #[test]
    fn runtime_rust_picks_up_rust_version() {
        let dir = tempfile::tempdir().unwrap();
        write(
            dir.path(),
            "Cargo.toml",
            "[package]\nname = \"x\"\nrust-version = \"1.84\"\n",
        );
        let r = detect_runtime(dir.path()).unwrap();
        assert_eq!(r.language, "rust");
        assert_eq!(r.version.as_deref(), Some("1.84"));
    }

    #[test]
    fn runtime_rust_without_rust_version() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "Cargo.toml", "[package]\nname = \"x\"\n");
        let r = detect_runtime(dir.path()).unwrap();
        assert_eq!(r.language, "rust");
        assert!(r.version.is_none());
    }

    #[test]
    fn runtime_go_uses_go_directive() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "go.mod", "module x\n\ngo 1.22\n");
        let r = detect_runtime(dir.path()).unwrap();
        assert_eq!(r.language, "go");
        assert_eq!(r.version.as_deref(), Some("1.22"));
    }

    #[test]
    fn runtime_ruby_strips_quotes() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "Gemfile", "source 'x'\nruby '3.2.2'\n");
        let r = detect_runtime(dir.path()).unwrap();
        assert_eq!(r.language, "ruby");
        assert_eq!(r.version.as_deref(), Some("3.2.2"));
    }

    #[test]
    fn runtime_polyglot_picks_node_first() {
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "package.json", r#"{"name":"x"}"#);
        write(dir.path(), "Cargo.toml", "[package]\nname = \"x\"\n");
        let r = detect_runtime(dir.path()).unwrap();
        assert_eq!(r.language, "node");
    }

    // ── Git detection ──────────────────────────────────────

    fn init_git(dir: &Path) {
        // Use plumbing flags so we don't depend on the user's default branch.
        let out = Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(out.status.success(), "git init failed: {:?}", out);
        // Identity needed for any later commit-creating tests.
        for (k, v) in &[("user.email", "t@t"), ("user.name", "t")] {
            Command::new("git")
                .args(["config", k, v])
                .current_dir(dir)
                .output()
                .unwrap();
        }
    }

    #[test]
    fn git_none_outside_repo() {
        let dir = tempfile::tempdir().unwrap();
        // No `git init` here.
        assert!(detect_git_context(dir.path()).is_none());
    }

    #[test]
    fn git_reports_repo_and_branch() {
        let dir = tempfile::tempdir().unwrap();
        init_git(dir.path());
        let g = detect_git_context(dir.path()).unwrap();
        assert_eq!(g.branch, "main");
        // Repo name should match the temp dir's basename.
        let expected = dir
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert_eq!(g.repo_name, expected);
    }

    #[test]
    fn git_detached_head_uses_short_sha() {
        let dir = tempfile::tempdir().unwrap();
        init_git(dir.path());
        // Make a commit so HEAD points somewhere.
        write(dir.path(), "a.txt", "hi");
        Command::new("git")
            .args(["add", "."])
            .current_dir(dir.path())
            .output()
            .unwrap();
        Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(dir.path())
            .output()
            .unwrap();
        // Detach HEAD by checking out the SHA.
        let sha = run_git(dir.path(), &["rev-parse", "HEAD"]).unwrap();
        let sha = sha.trim();
        Command::new("git")
            .args(["checkout", "--detach", sha])
            .current_dir(dir.path())
            .output()
            .unwrap();
        let g = detect_git_context(dir.path()).unwrap();
        assert!(
            g.branch.starts_with("DETACHED@"),
            "expected DETACHED@…, got {:?}",
            g.branch
        );
    }

    // ── Cache ──────────────────────────────────────────────

    #[test]
    fn cache_returns_inserted_value() {
        let cache = ContextCache::new();
        let dir = tempfile::tempdir().unwrap();
        write(dir.path(), "Cargo.toml", "[package]\nname=\"x\"\n");
        let first = dir_context(dir.path(), &cache);
        // Mutate disk: drop the manifest. A cached read must still return rust.
        fs::remove_file(dir.path().join("Cargo.toml")).unwrap();
        let second = dir_context(dir.path(), &cache);
        assert_eq!(
            first.runtime.as_ref().map(|r| &r.language),
            second.runtime.as_ref().map(|r| &r.language),
        );
    }

    #[test]
    fn cache_evicts_to_capacity() {
        let cache = ContextCache::new();
        for i in 0..(CACHE_CAP + 4) {
            let p = PathBuf::from(format!("/tmp/zzz-{i}"));
            cache.insert(
                p,
                DirContext {
                    git: None,
                    runtime: None,
                },
            );
        }
        assert!(
            cache.len() <= CACHE_CAP,
            "cache grew past cap: {}",
            cache.len()
        );
    }
}
