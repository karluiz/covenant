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
}
