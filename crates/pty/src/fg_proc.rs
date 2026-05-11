#![cfg(unix)]
//! Look up the foreground process group name for a PTY master fd.
//! Used by the idle detector to know which CLI is currently in front.

use std::os::fd::RawFd;

/// Returns the executable name (basename, no path) of the process group
/// currently in the foreground of the PTY whose master fd is given,
/// or `None` if it cannot be determined (other OS, dead child, etc.).
#[cfg(target_os = "macos")]
pub fn foreground_process_name(master_fd: RawFd) -> Option<String> {
    let pgid = unsafe { libc::tcgetpgrp(master_fd) };
    if pgid <= 0 {
        tracing::trace!(master_fd, pgid, "tcgetpgrp returned non-positive");
        return None;
    }
    libproc::proc_pid::name(pgid)
        .map_err(|e| tracing::trace!(pgid, error = %e, "libproc::name failed"))
        .ok()
}

#[cfg(not(target_os = "macos"))]
pub fn foreground_process_name(_master_fd: RawFd) -> Option<String> {
    None
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
}
