//! `covenant <path>` (CLI shim / second instance) and Finder "Open With"
//! entry points. Both funnel into one in-memory pending queue: the
//! frontend drains it via `take_cli_open_paths` at boot, and a
//! `cli://open-paths` poke event tells an already-running frontend to
//! drain again. All consumption goes through the drain command so a path
//! is never handled twice.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Runtime};

static PENDING: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// Canonicalize a raw argv entry if it points at an existing path.
/// Relative paths resolve against `base` (the invoking shell's cwd).
fn resolve(raw: &str, base: Option<&Path>) -> Option<String> {
    let p = PathBuf::from(raw);
    let p = if p.is_absolute() { p } else { base?.join(p) };
    let p = p.canonicalize().ok()?;
    Some(p.to_string_lossy().into_owned())
}

/// Positional args that resolve to existing paths. Skips argv[0] and
/// anything flag-shaped so stray `-psn`/`--flag` launch args never open.
pub fn paths_from_argv<S: AsRef<str>>(argv: &[S], base: Option<&Path>) -> Vec<String> {
    argv.iter()
        .skip(1)
        .map(|a| a.as_ref())
        .filter(|a| !a.starts_with('-'))
        .filter_map(|a| resolve(a, base))
        .collect()
}

/// Queue paths without an app handle (cold start, before the webview
/// exists). The boot-time drain picks them up.
pub fn queue(paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    if let Ok(mut pending) = PENDING.lock() {
        pending.extend(paths);
    }
}

/// Queue paths and poke a live frontend to drain them.
pub fn queue_and_notify<R: Runtime>(app: &AppHandle<R>, paths: Vec<String>) {
    if paths.is_empty() {
        return;
    }
    queue(paths);
    let _ = app.emit("cli://open-paths", ());
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CliOpenPath {
    pub path: String,
    pub is_dir: bool,
}

/// Drain the pending queue. Called by the frontend at boot and on every
/// `cli://open-paths` poke.
#[tauri::command]
pub fn take_cli_open_paths() -> Vec<CliOpenPath> {
    PENDING
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default()
        .into_iter()
        .map(|path| {
            let is_dir = Path::new(&path).is_dir();
            CliOpenPath { path, is_dir }
        })
        .collect()
}

/// Symlink the bundled `covenant` shim into /usr/local/bin. For DMG
/// installs (Homebrew's `binary` stanza already does this for cask
/// users). Tries a plain symlink first, escalates through osascript
/// admin prompt when /usr/local/bin isn't writable.
#[cfg(target_os = "macos")]
#[tauri::command]
pub fn install_cli(app: AppHandle) -> Result<String, String> {
    use tauri::Manager;

    let shim = app
        .path()
        .resource_dir()
        .map_err(|e| format!("resolve resources: {e}"))?
        .join("covenant");
    if !shim.exists() {
        return Err("CLI shim not found — only available in the packaged app".into());
    }
    let dest = Path::new("/usr/local/bin/covenant");

    let direct = std::fs::remove_file(dest)
        .or_else(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                Ok(())
            } else {
                Err(e)
            }
        })
        .and_then(|_| std::os::unix::fs::symlink(&shim, dest));
    if direct.is_ok() {
        return Ok(dest.to_string_lossy().into_owned());
    }

    // Not writable — one admin prompt, same as VSCode's install command.
    let script = format!(
        "do shell script \"mkdir -p /usr/local/bin && ln -sf '{}' '{}' && chmod +x '{}'\" with administrator privileges",
        shim.display(),
        dest.display(),
        shim.display(),
    );
    let out = std::process::Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("osascript: {e}"))?;
    if out.status.success() {
        Ok(dest.to_string_lossy().into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub fn install_cli() -> Result<String, String> {
    Err("CLI install is macOS-only for now".into())
}

/// Whether /usr/local/bin/covenant already points at something.
#[tauri::command]
pub fn cli_installed() -> bool {
    cfg!(target_os = "macos") && Path::new("/usr/local/bin/covenant").exists()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_argv0_and_flags() {
        let tmp = std::env::temp_dir();
        let tmp_str = tmp.to_string_lossy().into_owned();
        let argv = vec![
            "covenant".into(),
            "--flag".into(),
            tmp_str,
            "/nonexistent-xyz".into(),
        ];
        let paths = paths_from_argv(&argv, None);
        assert_eq!(paths.len(), 1);
        assert!(PathBuf::from(&paths[0]).is_dir());
    }

    #[test]
    fn relative_resolves_against_base() {
        let base = std::env::temp_dir();
        let argv: Vec<String> = vec!["covenant".into(), ".".into()];
        let paths = paths_from_argv(&argv, Some(&base));
        assert_eq!(paths.len(), 1);
        assert!(PathBuf::from(&paths[0]).is_absolute());
    }

    #[test]
    fn relative_without_base_is_dropped() {
        let argv: Vec<String> = vec!["covenant".into(), ".".into()];
        assert!(paths_from_argv(&argv, None).is_empty());
    }
}
