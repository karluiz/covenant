//! PTY abstraction over `portable-pty` for Covenant.
//!
//! Two surfaces:
//!
//! 1. [`smoke_shell_echo`] — M0 acceptance test that proves portable-pty
//!    plumbing works on this host using the user's default shell.
//! 2. [`PtySession`] — the real handle used by `covenant` and (later)
//!    `karl-session`. Owns one PTY pair plus the child shell, spawns a
//!    dedicated blocking reader thread, and exposes an async
//!    [`OutputReceiver`] of byte chunks.
//!
//! Per CLAUDE.md, the read loop is deliberately synchronous and runs on a
//! dedicated thread (not a tokio task) so it can drain the kernel buffer
//! as fast as the shell produces bytes. Downstream processing is event
//! driven on top of the channel.

use std::io::{Read, Write};
use std::time::Duration;

use bytes::Bytes;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use thiserror::Error;
use tokio::sync::mpsc;

const READ_CHUNK: usize = 8 * 1024;

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("pty backend error: {0}")]
    Backend(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("reader thread panicked")]
    ReaderThread,
    #[error("output receiver already taken for this session")]
    OutputAlreadyTaken,
}

impl From<anyhow::Error> for PtyError {
    fn from(e: anyhow::Error) -> Self {
        PtyError::Backend(format!("{e:#}"))
    }
}

/// Raw bytes drained from the PTY master. Includes ANSI; downstream is
/// responsible for stripping before LLM consumption.
pub type OutputChunk = Bytes;

/// Async receiver of [`OutputChunk`]s produced by the reader thread.
/// The sender half lives on the dedicated blocking reader; closing the
/// child closes the master, which ends the read loop, which drops the
/// sender and produces `None` on the receiver.
pub type OutputReceiver = mpsc::UnboundedReceiver<OutputChunk>;

/// Initial PTY size used when no caller-supplied size is given.
pub const DEFAULT_SIZE: PtySize = PtySize {
    rows: 24,
    cols: 80,
    pixel_width: 0,
    pixel_height: 0,
};

/// Identifies which shell to spawn. Strings come from the CLAUDE.md
/// `ShellKind` enum but we keep this crate shell-agnostic.
pub struct SpawnOptions {
    pub program: String,
    pub args: Vec<String>,
    pub size: PtySize,
    pub env: Vec<(String, String)>,
    pub cwd: Option<std::path::PathBuf>,
}

impl SpawnOptions {
    /// Sensible default: interactive zsh, sized 80x24, with a TERM hint
    /// xterm.js can negotiate against.
    ///
    /// Prefer [`SpawnOptions::for_shell`] when the shell path is detected
    /// at runtime (e.g. from `$SHELL`) so Linux users aren't forced onto
    /// `/bin/zsh` which may not be installed.
    pub fn zsh_interactive() -> Self {
        Self::for_shell("/bin/zsh")
    }

    /// Build `SpawnOptions` for any POSIX-compatible interactive shell.
    ///
    /// `shell_path` is the full path to the shell binary (e.g.
    /// `/bin/bash`, `/usr/bin/fish`, `/bin/zsh`).  The `-i` flag is
    /// omitted for fish, which is interactive by default; all other
    /// shells receive `-i`.
    pub fn for_shell(shell_path: &str) -> Self {
        let name = std::path::Path::new(shell_path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let args = if name.starts_with("fish") {
            vec![] // fish starts interactive without -i
        } else {
            vec!["-i".to_string()]
        };
        Self {
            program: shell_path.to_string(),
            args,
            size: DEFAULT_SIZE,
            env: vec![
                ("TERM".to_string(), "xterm-256color".to_string()),
                ("LANG".to_string(), "en_US.UTF-8".to_string()),
                ("COLORTERM".to_string(), "truecolor".to_string()),
            ],
            cwd: None,
        }
    }
}

/// Live PTY-backed shell. Send-only (the inner `MasterPty` handle is not
/// `Sync`), so wrap in a `Mutex` if shared across tasks.
pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
    child: Box<dyn Child + Send + Sync>,
}

impl PtySession {
    /// Spawn `options.program` inside a fresh PTY pair. Returns the
    /// session handle plus an [`OutputReceiver`] the caller drains on a
    /// tokio task.
    pub fn spawn(options: SpawnOptions) -> Result<(Self, OutputReceiver), PtyError> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(options.size)?;

        let mut cmd = CommandBuilder::new(&options.program);
        cmd.args(options.args.iter().map(|s| s.as_str()));
        for (k, v) in &options.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &options.cwd {
            cmd.cwd(cwd);
        }

        let child = pair.slave.spawn_command(cmd)?;
        // Drop our handle to slave so EOF propagates when the child exits.
        drop(pair.slave);

        let writer = pair.master.take_writer()?;
        let reader = pair.master.try_clone_reader()?;

        let (tx, rx) = mpsc::unbounded_channel();

        // Dedicated blocking thread per CLAUDE.md: never poll, drain.
        std::thread::Builder::new()
            .name("karl-pty-reader".to_string())
            .spawn(move || {
                let mut reader = reader;
                let mut buf = vec![0u8; READ_CHUNK];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            if tx.send(Bytes::copy_from_slice(&buf[..n])).is_err() {
                                // receiver gone — session was dropped
                                break;
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                        Err(_) => break,
                    }
                }
                tracing::debug!("pty reader thread exiting");
            })
            .map_err(PtyError::Io)?;

        Ok((
            Self {
                master: pair.master,
                writer,
                child,
            },
            rx,
        ))
    }

    /// Write inbound bytes (typically keystrokes) to the slave's stdin.
    pub fn write(&mut self, data: &[u8]) -> Result<(), PtyError> {
        self.writer.write_all(data)?;
        self.writer.flush()?;
        Ok(())
    }

    /// Resize the underlying PTY. Should be called whenever the front-end
    /// terminal grid changes; without it `vim`/`htop`/etc. will misrender.
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), PtyError> {
        self.master.resize(PtySize {
            cols,
            rows,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        Ok(())
    }

    /// Best-effort kill of the child process.
    pub fn kill(&mut self) -> Result<(), PtyError> {
        self.child
            .kill()
            .map_err(|e| PtyError::Backend(format!("kill failed: {e}")))?;
        Ok(())
    }
}

/// Smoke test: spawn the user's `$SHELL` (falling back to `/bin/sh`),
/// send `echo hello`, and return the ANSI-stripped output observed on
/// the master side before the shell exited.
///
/// This is the M0 acceptance check — exercises portable-pty end-to-end
/// on the host without zsh-specific assumptions, so the test passes on
/// Linux (bash/fish default) and macOS (zsh default) alike.
///
/// RC files are intentionally skipped (`--norc`/`--no-rcs`/`--no-config`)
/// so the test is portable across environments with heavy startup scripts
/// (e.g. Bazzite MOTD, Oh-My-Zsh) that would otherwise make it hang.
pub fn smoke_shell_echo() -> Result<String, PtyError> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(DEFAULT_SIZE)?;

    let name = std::path::Path::new(&shell)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");

    // Skip rc files in the smoke test so heavy startup scripts (Bazzite
    // MOTD, Oh-My-Zsh plugin loading, etc.) don't make the test hang or
    // time out. Production spawns use full rc files via the shim strategy.
    let args: Vec<&str> = if name.starts_with("fish") {
        vec!["--no-config"]
    } else if name.starts_with("zsh") {
        vec!["--no-rcs", "-i"]
    } else {
        // bash, sh, dash, ksh, etc.
        vec!["--norc", "--noprofile", "-i"]
    };

    let mut cmd = CommandBuilder::new(&shell);
    for arg in &args {
        cmd.arg(arg);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", "en_US.UTF-8");

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let mut writer = pair.master.take_writer()?;
    let reader = pair.master.try_clone_reader()?;

    let reader_handle = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
        let mut buf = Vec::with_capacity(8 * 1024);
        let mut reader = reader;
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => return Ok(buf),
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Ok(buf),
            }
        }
    });

    // Give the shell a moment to print its prompt before injecting the command.
    std::thread::sleep(Duration::from_millis(200));
    write!(writer, "echo hello\nexit\n")?;
    writer.flush()?;
    drop(writer);

    let _ = child.wait();
    drop(pair.master);

    let bytes = reader_handle
        .join()
        .map_err(|_| PtyError::ReaderThread)??;
    let stripped = strip_ansi_escapes::strip(&bytes);
    Ok(String::from_utf8_lossy(&stripped).into_owned())
}

/// Deprecated: use [`smoke_shell_echo`] which respects `$SHELL`.
/// Kept for backward compatibility; calls the new implementation with
/// `/bin/zsh` hard-coded (macOS only — will fail on Linux if zsh is absent).
#[deprecated(since = "0.2.22", note = "use smoke_shell_echo() instead")]
pub fn smoke_zsh_echo() -> Result<String, PtyError> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(DEFAULT_SIZE)?;

    let mut cmd = CommandBuilder::new("/bin/zsh");
    cmd.arg("-i");
    cmd.env("TERM", "xterm-256color");
    cmd.env("LANG", "en_US.UTF-8");

    let mut child = pair.slave.spawn_command(cmd)?;
    drop(pair.slave);

    let mut writer = pair.master.take_writer()?;
    let reader = pair.master.try_clone_reader()?;

    let reader_handle = std::thread::spawn(move || -> std::io::Result<Vec<u8>> {
        let mut buf = Vec::with_capacity(8 * 1024);
        let mut reader = reader;
        let mut chunk = [0u8; 4096];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => return Ok(buf),
                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => return Err(e),
            }
        }
    });

    // Give the shell a moment to load rc files before injecting the command.
    std::thread::sleep(Duration::from_millis(200));
    write!(writer, "echo hello\nexit\n")?;
    writer.flush()?;
    drop(writer);

    let _ = child.wait();
    drop(pair.master);

    let bytes = reader_handle
        .join()
        .map_err(|_| PtyError::ReaderThread)??;
    let stripped = strip_ansi_escapes::strip(&bytes);
    Ok(String::from_utf8_lossy(&stripped).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn smoke_echoes_hello() {
        let out = smoke_shell_echo().expect("pty smoke should succeed");
        assert!(
            out.contains("hello"),
            "expected 'hello' in pty output, got: {out:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pty_session_round_trip() {
        // Use the host shell so the test is portable across macOS (zsh)
        // and Linux (bash/fish/etc.) without requiring a specific shell at
        // a hard-coded path.
        // Skip rc files (same reason as smoke_shell_echo) so heavy startup
        // scripts don't cause the test to time out.
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".to_string());
        let name = std::path::Path::new(&shell)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("");
        let mut opts = SpawnOptions::for_shell(&shell);
        if name.starts_with("fish") {
            opts.args = vec!["--no-config".to_string()];
        } else if name.starts_with("zsh") {
            opts.args = vec!["--no-rcs".to_string(), "-i".to_string()];
        } else {
            opts.args = vec!["--norc".to_string(), "--noprofile".to_string(), "-i".to_string()];
        }

        let (mut session, mut rx) = PtySession::spawn(opts).expect("spawn");

        // Wait for any prompt output to settle, then send a marker.
        tokio::time::sleep(Duration::from_millis(200)).await;
        session.write(b"echo karl-marker\nexit\n").expect("write");

        let mut all = Vec::new();
        while let Some(chunk) = rx.recv().await {
            all.extend_from_slice(&chunk);
        }

        let stripped = strip_ansi_escapes::strip(&all);
        let text = String::from_utf8_lossy(&stripped);
        assert!(
            text.contains("karl-marker"),
            "expected 'karl-marker' in output, got: {text:?}"
        );
    }
}
