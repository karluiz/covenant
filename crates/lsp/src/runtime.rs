use std::path::PathBuf;
use std::process::Command;

use crate::LspError;

#[derive(Debug, Clone)]
pub struct RuntimeReq {
    pub name: String,        // "node"
    pub min_version: String, // "18"
    pub version_arg: String, // "--version"
}

#[derive(Debug, Clone)]
pub struct Resolved {
    pub path: PathBuf,
    pub version: String,
}

/// Resolve a runtime binary on the USER's login-shell PATH. GUI apps on
/// macOS inherit a minimal PATH, so we must ask the login shell (`-lc`)
/// rather than trust our own env — same class of problem the PTY env has.
pub fn detect(req: &RuntimeReq) -> Result<Resolved, LspError> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    // `command -v` prints the resolved path; then run --version.
    let out = Command::new(&shell)
        .args(["-lc", &format!("command -v {}", req.name)])
        .output()
        .map_err(|e| LspError::Spawn(format!("login shell: {e}")))?;
    let path_str = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || path_str.is_empty() {
        return Err(LspError::RuntimeMissing {
            name: req.name.clone(),
            min: req.min_version.clone(),
            found: None,
        });
    }
    let path = PathBuf::from(&path_str);
    let ver_out = Command::new(&path)
        .arg(&req.version_arg)
        .output()
        .map_err(|e| LspError::Spawn(format!("{} {}: {e}", req.name, req.version_arg)))?;
    let raw = String::from_utf8_lossy(&ver_out.stdout).trim().to_string();
    let version = extract_version(&raw).unwrap_or(raw);
    if !version_ge(&version, &req.min_version) {
        return Err(LspError::RuntimeMissing {
            name: req.name.clone(),
            min: req.min_version.clone(),
            found: Some(version),
        });
    }
    Ok(Resolved { path, version })
}

/// Scan `output` (the runtime's version-flag stdout, e.g. `--version`) for
/// the first whitespace-delimited token that looks like a version number
/// (`\d+(\.\d+)+`, an optional leading `v` tolerated and stripped). Unlike
/// naively taking the first token, this skips leading vendor/label words —
/// `"openjdk 17.0.18 2026-01-20"` has `openjdk` as its first token, not a
/// version, so the scan must land on the second token instead. For
/// runtimes whose first token already IS the version (`"v18.19.0"` for
/// node, `"10.0.101"` for dotnet) this returns the same value a first-token
/// parse would, so it's a pure generalization — no behavior change for
/// those two.
pub fn extract_version(output: &str) -> Option<String> {
    for token in output.split_whitespace() {
        let candidate = token.trim_start_matches('v');
        // Trim trailing punctuation a label might carry (e.g. a stray
        // comma or quote) without accepting non-version junk.
        let candidate = candidate.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
        if is_version_like(candidate) {
            return Some(candidate.to_string());
        }
    }
    None
}

/// `\d+(\.\d+)+` — at least one dot, every segment numeric and non-empty.
fn is_version_like(s: &str) -> bool {
    if s.is_empty() {
        return false;
    }
    let mut segments = s.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    if first.is_empty() || !first.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let mut saw_dot = false;
    for seg in segments {
        saw_dot = true;
        if seg.is_empty() || !seg.chars().all(|c| c.is_ascii_digit()) {
            return false;
        }
    }
    saw_dot
}

/// True if `found` (e.g. "v18.19.0") is >= `min` (e.g. "18" or "18.2")
/// on a major[.minor] comparison. Tolerates a leading `v`.
pub fn version_ge(found: &str, min: &str) -> bool {
    fn parts(s: &str) -> Option<(u32, u32)> {
        let s = s.trim().trim_start_matches('v');
        let mut it = s.split('.');
        let major = it.next()?.parse::<u32>().ok()?;
        let minor = it.next().and_then(|m| m.parse::<u32>().ok()).unwrap_or(0);
        Some((major, minor))
    }
    let (Some((fmaj, fmin)), Some((mmaj, mmin))) = (parts(found), parts(min)) else {
        return false;
    };
    (fmaj, fmin) >= (mmaj, mmin)
}

/// A remedy the UI can show when `detect` reports a runtime missing/too old.
#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeSuggestion {
    /// A satisfying version exists on disk but its bin dir isn't on the
    /// login-shell PATH. `dir` is the bin dir to prepend.
    OnDiskNotOnPath { version: String, dir: String },
    /// No satisfying version found in the curated locations.
    Install { hint: String },
}

/// Parse a version string to a sortable (major, minor, patch) key. Missing
/// segments default to 0; a leading `v` is tolerated. Non-numeric → 0.
fn version_key(v: &str) -> (u32, u32, u32) {
    let mut it = v.trim().trim_start_matches('v').split('.');
    let p = |x: Option<&str>| x.and_then(|s| s.parse::<u32>().ok()).unwrap_or(0);
    (p(it.next()), p(it.next()), p(it.next()))
}

/// From `(dir, version)` candidates, return the newest that is `>= min`.
fn pick_newest_satisfying(candidates: &[(String, String)], min: &str) -> Option<(String, String)> {
    candidates
        .iter()
        .filter(|(_, v)| version_ge(v, min))
        .max_by_key(|(_, v)| version_key(v))
        .cloned()
}

/// Bin dirs to probe for a given runtime, macOS-curated. Each returned dir
/// is expected to contain an executable named `req.name`. ponytail: a
/// curated list, not a filesystem walk; extend per-OS as needed.
fn candidate_bin_dirs(name: &str) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let home = std::env::var("HOME").ok().map(PathBuf::from);
    match name {
        "java" => {
            // Homebrew openjdk / openjdk@NN → <keg>/bin
            dirs.extend(homebrew_opt_bins("openjdk"));
            // macOS java_home lists every registered JVM's Home dir.
            if let Ok(out) = std::process::Command::new("/usr/libexec/java_home")
                .arg("-V")
                .output()
            {
                let text = String::from_utf8_lossy(&out.stderr); // java_home -V prints to stderr
                for line in text.lines() {
                    if let Some(idx) = line.find('/') {
                        let p = PathBuf::from(line[idx..].trim());
                        if p.is_dir() {
                            dirs.push(p.join("bin"));
                        }
                    }
                }
            }
            if let Some(h) = &home {
                push_glob_children(&mut dirs, &h.join(".sdkman/candidates/java"), "bin");
            }
        }
        "node" => {
            dirs.extend(homebrew_opt_bins("node"));
            dirs.push(PathBuf::from("/usr/local/bin"));
            if let Some(h) = &home {
                push_glob_children(&mut dirs, &h.join(".nvm/versions/node"), "bin");
            }
        }
        "dotnet" => {
            // dotnet's dir holds the `dotnet` binary directly (no /bin).
            dirs.push(PathBuf::from("/usr/local/share/dotnet"));
            for d in homebrew_opt_bins("dotnet") {
                // homebrew_opt_bins appends /bin; dotnet keg exposes bin too.
                dirs.push(d);
            }
        }
        _ => {}
    }
    dirs
}

/// `/opt/homebrew/opt/<prefix>*/bin` for every keg whose name starts with prefix.
fn homebrew_opt_bins(prefix: &str) -> Vec<PathBuf> {
    let base = PathBuf::from("/opt/homebrew/opt");
    let mut out = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&base) {
        for e in entries.flatten() {
            if e.file_name().to_string_lossy().starts_with(prefix) {
                out.push(e.path().join("bin"));
            }
        }
    }
    out
}

/// For each immediate child dir of `parent`, push `child/<sub>`.
fn push_glob_children(dirs: &mut Vec<PathBuf>, parent: &std::path::Path, sub: &str) {
    if let Ok(entries) = std::fs::read_dir(parent) {
        for e in entries.flatten() {
            if e.path().is_dir() {
                dirs.push(e.path().join(sub));
            }
        }
    }
}

fn install_hint(name: &str) -> String {
    match name {
        "java" => "brew install openjdk".into(),
        "node" => "brew install node".into(),
        "dotnet" => "brew install dotnet".into(),
        other => format!("install {other}"),
    }
}

/// The bin dirs currently on the login-shell PATH (what `detect` uses).
fn login_shell_path_dirs() -> Vec<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into());
    let out = std::process::Command::new(&shell)
        .args(["-lc", "echo $PATH"])
        .output();
    match out {
        Ok(o) => String::from_utf8_lossy(&o.stdout)
            .trim()
            .split(':')
            .map(|s| s.to_string())
            .collect(),
        Err(_) => Vec::new(),
    }
}

/// Called after `detect` reports RuntimeMissing. Scans curated locations
/// for a satisfying version; suggests a PATH fix if one exists off-PATH,
/// else an install hint. Never fails — always returns a usable suggestion.
pub fn suggest_fix(req: &RuntimeReq) -> RuntimeSuggestion {
    let mut candidates: Vec<(String, String)> = Vec::new();
    for dir in candidate_bin_dirs(&req.name) {
        let exe = dir.join(&req.name);
        if !exe.is_file() {
            continue;
        }
        if let Ok(out) = std::process::Command::new(&exe)
            .arg(&req.version_arg)
            .output()
        {
            let raw = String::from_utf8_lossy(&out.stdout);
            // node/dotnet print to stdout; java --version also stdout.
            let raw = if raw.trim().is_empty() {
                String::from_utf8_lossy(&out.stderr).into_owned()
            } else {
                raw.into_owned()
            };
            if let Some(v) = extract_version(&raw) {
                candidates.push((dir.to_string_lossy().into_owned(), v));
            }
        }
    }
    match pick_newest_satisfying(&candidates, &req.min_version) {
        Some((dir, version)) => {
            let on_path = login_shell_path_dirs().iter().any(|p| p == &dir);
            if on_path {
                // Already on PATH yet detect failed → the on-PATH one is the
                // old one and this dir is too; don't tell the user to add a
                // dir they have. Fall back to install hint.
                RuntimeSuggestion::Install {
                    hint: install_hint(&req.name),
                }
            } else {
                RuntimeSuggestion::OnDiskNotOnPath { version, dir }
            }
        }
        None => RuntimeSuggestion::Install {
            hint: install_hint(&req.name),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn version_ge_compares_major_minor() {
        assert!(version_ge("18.19.0", "18"));
        assert!(version_ge("20.0.0", "18"));
        assert!(version_ge("v18.19.1", "18")); // leading v tolerated
        assert!(!version_ge("16.20.0", "18"));
        assert!(version_ge("18.0.0", "18.0"));
        assert!(!version_ge("18.0.0", "18.1"));
    }
    #[test]
    fn version_ge_handles_garbage() {
        assert!(!version_ge("", "18"));
        assert!(!version_ge("not-a-version", "18"));
    }

    #[test]
    fn extract_version_scans_past_a_leading_vendor_token() {
        // java --version: vendor word first, version is the SECOND token.
        assert_eq!(
            extract_version("openjdk 17.0.18 2026-01-20"),
            Some("17.0.18".to_string())
        );
    }

    #[test]
    fn extract_version_strips_leading_v_and_still_matches_first_token() {
        // node --version: the version already IS the first token.
        assert_eq!(extract_version("v18.19.0"), Some("18.19.0".to_string()));
    }

    #[test]
    fn extract_version_matches_bare_first_token() {
        // dotnet --version: bare version, no vendor prefix, no leading v.
        assert_eq!(extract_version("10.0.101"), Some("10.0.101".to_string()));
    }

    #[test]
    fn extract_version_returns_none_for_garbage() {
        assert_eq!(extract_version("garbage"), None);
        assert_eq!(extract_version(""), None);
    }

    #[test]
    fn extract_version_node_and_dotnet_outputs_are_not_regressed() {
        // Full detect()-shaped outputs (single line, trimmed) for the two
        // pre-existing runtimes must still extract cleanly and satisfy
        // version_ge the same way the old first-token parse did.
        let node = extract_version("v18.19.0").unwrap();
        assert!(version_ge(&node, "18"));

        let dotnet = extract_version("10.0.101").unwrap();
        assert!(version_ge(&dotnet, "10"));
    }

    #[test]
    fn pick_newest_satisfying_picks_highest_above_min() {
        let c = vec![
            ("/a".to_string(), "17.0.18".to_string()),
            ("/b".to_string(), "26.0.1".to_string()),
            ("/c".to_string(), "21.0.2".to_string()),
        ];
        assert_eq!(
            pick_newest_satisfying(&c, "21"),
            Some(("/b".to_string(), "26.0.1".to_string()))
        );
    }

    #[test]
    fn pick_newest_satisfying_ignores_below_min() {
        let c = vec![
            ("/a".to_string(), "17.0.18".to_string()),
            ("/b".to_string(), "20.9.9".to_string()),
        ];
        assert_eq!(pick_newest_satisfying(&c, "21"), None);
    }

    #[test]
    fn pick_newest_satisfying_empty_is_none() {
        assert_eq!(pick_newest_satisfying(&[], "21"), None);
    }

    #[test]
    fn pick_newest_satisfying_orders_by_full_version_not_just_major() {
        let c = vec![
            ("/a".to_string(), "21.0.9".to_string()),
            ("/b".to_string(), "21.2.0".to_string()),
        ];
        assert_eq!(
            pick_newest_satisfying(&c, "21"),
            Some(("/b".to_string(), "21.2.0".to_string()))
        );
    }

    #[test]
    fn suggest_fix_returns_install_hint_for_unknown_runtime() {
        // A runtime we scan no locations for → always Install (never panics).
        let req = RuntimeReq {
            name: "totally-not-a-real-runtime".into(),
            min_version: "1".into(),
            version_arg: "--version".into(),
        };
        match suggest_fix(&req) {
            RuntimeSuggestion::Install { hint } => assert!(!hint.is_empty()),
            other => panic!("expected Install, got {other:?}"),
        }
    }

    #[test]
    fn suggest_fix_never_panics_for_known_runtimes() {
        for name in ["java", "node", "dotnet"] {
            let req = RuntimeReq {
                name: name.into(),
                min_version: "999".into(), // nothing satisfies → forces Install or a real on-disk<999
                version_arg: "--version".into(),
            };
            let _ = suggest_fix(&req); // must not panic
        }
    }
}
