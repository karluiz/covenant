//! PTY abstraction over `portable-pty` for Covenant.
//!
//! Two surfaces:
//!
//! 1. [`smoke_zsh_echo`] — M0 acceptance test that proves portable-pty
//!    plumbing works on this host.
//! 2. [`PtySession`] — the real handle used by `covenant` and (later)
//!    `karl-session`. Owns one PTY pair plus the child shell, spawns a
//!    dedicated blocking reader thread, and exposes an async
//!    [`OutputReceiver`] of byte chunks.
//!
//! Per CLAUDE.md, the read loop is deliberately synchronous and runs on a
//! dedicated thread (not a tokio task) so it can drain the kernel buffer
//! as fast as the shell produces bytes. Downstream processing is event
//! driven on top of the channel.

pub mod shell;
pub use shell::{ShellError, ShellKind};

use std::io::{Read, Write};
#[cfg(unix)]
use std::os::fd::RawFd;
use std::time::Duration;

#[cfg(unix)]
mod fg_proc;
#[cfg(unix)]
pub use fg_proc::foreground_process_name;

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
    pub fn from_default_shell() -> Result<Self, crate::shell::ShellError> {
        let shell = crate::shell::ShellKind::default_for_platform()?;
        let program = shell.program().to_string_lossy().into_owned();
        let args: Vec<String> = match &shell {
            #[cfg(unix)]
            crate::shell::ShellKind::Zsh { .. } | crate::shell::ShellKind::Bash { .. } => {
                vec!["-i".to_string()]
            }
            #[cfg(windows)]
            crate::shell::ShellKind::PowerShell { .. } => {
                vec!["-NoLogo".to_string()]
            }
        };
        let env = vec![
            ("TERM".to_string(), "xterm-256color".to_string()),
            ("LANG".to_string(), "en_US.UTF-8".to_string()),
            ("COLORTERM".to_string(), "truecolor".to_string()),
        ];
        Ok(Self {
            program,
            args,
            size: DEFAULT_SIZE,
            env,
            cwd: None,
        })
    }

    /// Sensible default: interactive zsh, sized 80x24, with a TERM hint
    /// xterm.js can negotiate against.
    #[cfg(unix)]
    pub fn zsh_interactive() -> Self {
        Self {
            program: "/bin/zsh".to_string(),
            args: vec!["-i".to_string()],
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
    #[cfg(unix)]
    master_fd: RawFd,
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
        #[cfg(unix)]
        let master_fd = pair
            .master
            .as_raw_fd()
            .ok_or_else(|| PtyError::Backend("pty master has no raw fd".to_string()))?;

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
                #[cfg(unix)]
                master_fd,
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

    /// Raw fd of the PTY master, for syscalls like `tcgetpgrp(2)`.
    /// The fd is owned by `self.master`; do not close it.
    #[cfg(unix)]
    pub fn master_fd(&self) -> RawFd {
        self.master_fd
    }

    /// Best-effort kill of the child process.
    pub fn kill(&mut self) -> Result<(), PtyError> {
        self.child
            .kill()
            .map_err(|e| PtyError::Backend(format!("kill failed: {e}")))?;
        Ok(())
    }
}

/// Smoke test: spawn `/bin/zsh -i`, send `echo hello`, return the
/// ANSI-stripped output the master side observed before the shell exited.
///
/// This is the M0 acceptance check — exercises portable-pty end-to-end on
/// the host, but does not yet wire anything into the event bus.
#[cfg(unix)]
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

    #[cfg(unix)]
    #[test]
    fn smoke_echoes_hello() {
        let out = smoke_zsh_echo().expect("pty smoke should succeed");
        assert!(
            out.contains("hello"),
            "expected 'hello' in pty output, got: {out:?}"
        );
    }

    #[test]
    fn spawn_options_from_default_shell_matches_platform() {
        let opts = SpawnOptions::from_default_shell().expect("default shell options");
        #[cfg(unix)]
        assert!(opts.program.ends_with("zsh") || opts.program.ends_with("bash"));
        #[cfg(windows)]
        assert!(opts.program.to_lowercase().ends_with("pwsh.exe"));
    }

    #[cfg(unix)]
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pty_session_round_trip() {
        let (mut session, mut rx) =
            PtySession::spawn(SpawnOptions::zsh_interactive()).expect("spawn");

        // Wait for any rc-loading output to settle, then send a marker.
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
