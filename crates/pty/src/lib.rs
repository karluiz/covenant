//! PTY abstraction over `portable-pty` for karl-terminal.
//!
//! M0 surface: a single smoke entry point that proves we can spawn an
//! interactive zsh inside a real PTY, write a command, and read its output
//! back. Higher-level session management lives in `karl-session` and is
//! built on top of this crate.

use std::io::{Read, Write};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("pty backend error: {0}")]
    Backend(#[from] anyhow::Error),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("reader thread panicked")]
    ReaderThread,
}

/// Smoke test: spawn `/bin/zsh -i`, send `echo hello`, return the
/// ANSI-stripped output the master side observed before the shell exited.
///
/// This is the M0 acceptance check — exercises portable-pty end-to-end on
/// the host, but does not yet wire anything into the event bus.
pub fn smoke_zsh_echo() -> Result<String, PtyError> {
    let pty_system = native_pty_system();
    let pair = pty_system.openpty(PtySize {
        rows: 24,
        cols: 80,
        pixel_width: 0,
        pixel_height: 0,
    })?;

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
        let out = smoke_zsh_echo().expect("pty smoke should succeed");
        assert!(
            out.contains("hello"),
            "expected 'hello' in pty output, got: {out:?}"
        );
    }
}
