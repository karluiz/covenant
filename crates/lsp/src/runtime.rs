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
    let version = String::from_utf8_lossy(&ver_out.stdout).trim().to_string();
    if !version_ge(&version, &req.min_version) {
        return Err(LspError::RuntimeMissing {
            name: req.name.clone(),
            min: req.min_version.clone(),
            found: Some(version),
        });
    }
    Ok(Resolved { path, version })
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
}
