#![cfg(unix)]
//! Look up the foreground process group name for a PTY master fd.
//! Used by the idle detector to know which CLI is currently in front.

use std::os::fd::RawFd;

/// Returns the executable name (basename, no path) of the process group
/// currently in the foreground of the PTY whose master fd is given,
/// or `None` if it cannot be determined (other OS, dead child, etc.).
///
/// When the kernel-reported name is a generic runtime (`node`, `python`,
/// `python3`, `ruby`), we peek at the process's argv to recover the
/// logical CLI name (e.g. `copilot`, `claude`, `opencode`, `aider`).
/// Without this, Node-based agent CLIs get reported as `node` and slip
/// past the busy-dot allowlist exclusion.
#[cfg(target_os = "macos")]
pub fn foreground_process_name(master_fd: RawFd) -> Option<String> {
    let pgid = unsafe { libc::tcgetpgrp(master_fd) };
    if pgid <= 0 {
        tracing::trace!(master_fd, pgid, "tcgetpgrp returned non-positive");
        return None;
    }
    let comm = libproc::proc_pid::name(pgid)
        .map_err(|e| tracing::trace!(pgid, error = %e, "libproc::name failed"))
        .ok()?;
    // Some CLIs (Claude Code v2.1+) overwrite their own comm with their
    // version string (e.g. "2.1.143"). Always try argv when comm doesn't
    // already match a known logical CLI — covers both runtime-hosted
    // agents (`node`, `python`) and self-renamed binaries.
    let comm_is_known = LOGICAL_CLIS.iter().any(|c| comm.contains(c));
    if !comm_is_known || is_generic_runtime(&comm) {
        if let Some(logical) = logical_name_from_argv(pgid) {
            return Some(logical);
        }
    }
    Some(comm)
}

#[cfg(not(target_os = "macos"))]
pub fn foreground_process_name(_master_fd: RawFd) -> Option<String> {
    None
}

fn is_generic_runtime(comm: &str) -> bool {
    matches!(
        comm,
        "node" | "python" | "python3" | "ruby" | "deno" | "bun"
    )
}

/// Known agent / interactive CLIs we want to surface by their logical
/// name rather than the runtime that hosts them.
const LOGICAL_CLIS: &[&str] = &[
    "copilot",
    "claude",
    "opencode",
    "aider",
    "codex",
    "cursor-agent",
    "gemini",
    "ollama",
    "pi",
];

fn logical_name_from_arg(arg: &str) -> Option<&'static str> {
    let basename = arg.rsplit('/').next().unwrap_or(arg);
    for cli in LOGICAL_CLIS {
        if *cli == "pi" {
            // Pi's npm/shebang process often reports as `node` with either
            // argv[1] = `/.../bin/pi` or a realpath under `pi-coding-agent`.
            // Keep this exact/package-scoped so random paths like
            // `pi-clipboard-*.png` don't get mistaken for the Pi CLI.
            if basename == "pi" || basename == "pi.js" || arg.contains("pi-coding-agent") {
                return Some("pi");
            }
        } else if basename.contains(cli) {
            return Some(*cli);
        }
    }
    None
}

#[cfg(target_os = "macos")]
fn logical_name_from_argv(pid: i32) -> Option<String> {
    let argv = read_proc_argv(pid)?;
    for arg in &argv {
        if let Some(cli) = logical_name_from_arg(arg) {
            return Some(cli.to_string());
        }
    }
    None
}

/// Read argv of `pid` via `sysctl(KERN_PROCARGS2)`. Layout:
///   [argc: i32][exec_path: cstr][NUL padding][argv[0] cstr]...[argv[argc-1] cstr][env...]
#[cfg(target_os = "macos")]
fn read_proc_argv(pid: i32) -> Option<Vec<String>> {
    let mut argmax: libc::c_int = 0;
    let mut size = std::mem::size_of::<libc::c_int>();
    let mut mib = [libc::CTL_KERN, libc::KERN_ARGMAX];
    let rc = unsafe {
        libc::sysctl(
            mib.as_mut_ptr(),
            2,
            &mut argmax as *mut _ as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || argmax <= 0 {
        return None;
    }

    let mut buf: Vec<u8> = vec![0u8; argmax as usize];
    let mut size = buf.len();
    let mut mib2 = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid];
    let rc = unsafe {
        libc::sysctl(
            mib2.as_mut_ptr(),
            3,
            buf.as_mut_ptr() as *mut libc::c_void,
            &mut size,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 || size < 4 {
        return None;
    }
    buf.truncate(size);

    let argc = i32::from_ne_bytes(buf[..4].try_into().ok()?);
    if argc <= 0 {
        return None;
    }

    let mut cursor = 4usize;
    while cursor < buf.len() && buf[cursor] != 0 {
        cursor += 1;
    }
    while cursor < buf.len() && buf[cursor] == 0 {
        cursor += 1;
    }

    let mut argv = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        if cursor >= buf.len() {
            break;
        }
        let start = cursor;
        while cursor < buf.len() && buf[cursor] != 0 {
            cursor += 1;
        }
        if let Ok(s) = std::str::from_utf8(&buf[start..cursor]) {
            argv.push(s.to_string());
        }
        cursor += 1;
    }
    Some(argv)
}

/// Send a signal to the foreground process group of the PTY whose master
/// fd is given. Used to kill the entire foreground process tree (e.g.
/// `npm run tauri:dev` plus its descendants) when the user hits the
/// force-kill shortcut. Returns the pgid on success.
pub fn kill_foreground_pgrp(master_fd: RawFd, signal: i32) -> std::io::Result<i32> {
    let pgid = unsafe { libc::tcgetpgrp(master_fd) };
    if pgid <= 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("tcgetpgrp returned {pgid}"),
        ));
    }
    let rc = unsafe { libc::killpg(pgid, signal) };
    if rc != 0 {
        return Err(std::io::Error::last_os_error());
    }
    Ok(pgid)
}

/// Return true if `pgid` still has at least one live process.
pub fn pgrp_alive(pgid: i32) -> bool {
    unsafe { libc::killpg(pgid, 0) == 0 }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use crate::{PtySession, SpawnOptions};

    #[tokio::test]
    async fn returns_shell_name_for_idle_zsh() {
        let opts = SpawnOptions::zsh_interactive();
        let (session, _rx) = PtySession::spawn(opts).expect("spawn zsh");
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let name = foreground_process_name(session.master_fd());
        assert_eq!(name.as_deref(), Some("zsh"), "got {name:?}");
    }

    #[test]
    fn argv_of_self_is_readable() {
        let pid = std::process::id() as i32;
        let argv = read_proc_argv(pid).expect("read_proc_argv self");
        assert!(!argv.is_empty(), "argv should not be empty");
    }

    #[test]
    fn logical_match_recognises_copilot_path() {
        assert_eq!(
            logical_name_from_arg("/usr/local/bin/copilot.js"),
            Some("copilot")
        );
    }

    #[test]
    fn logical_match_recognises_pi_npm_entrypoints_without_false_clipboard_hit() {
        assert_eq!(logical_name_from_arg("/opt/homebrew/bin/pi"), Some("pi"));
        assert_eq!(
            logical_name_from_arg(
                "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js",
            ),
            Some("pi")
        );
        assert_eq!(
            logical_name_from_arg("/var/folders/tmp/pi-clipboard-123.png"),
            None
        );
    }
}
