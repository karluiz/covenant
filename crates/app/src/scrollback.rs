//! Per-tab scrollback persistence.
//!
//! Each tab gets an append-only log of raw PTY bytes at
//! `<data_dir>/scrollback/<key>.log`. On reopen the frontend asks for
//! the tail of this file and writes it into xterm before the live
//! session attaches — gives the user the illusion of a terminal that
//! never closed.
//!
//! Cap is enforced lazily: if the file is larger than `MAX_BYTES` when
//! opened for append, we truncate to the last `MAX_BYTES` first. Writes
//! after that are unbounded until the next reopen — terminals don't
//! produce enough bytes per session for this to matter in practice.

use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

/// 2 MiB cap per tab — about a screen of `cargo build` output and
/// then some. Bigger logs would make replay slow without adding value.
pub const MAX_BYTES: u64 = 2 * 1024 * 1024;

/// Sanity-check a replay key. Tab ids are ulids in practice but we
/// only need to defend against path traversal here.
pub fn is_safe_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 64
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

pub fn dir_for(data_dir: &Path) -> PathBuf {
    data_dir.join("scrollback")
}

pub fn path_for(data_dir: &Path, key: &str) -> PathBuf {
    dir_for(data_dir).join(format!("{key}.log"))
}

/// Open an append writer, truncating from the front if the file is
/// already over the cap. Returns `None` and logs on any I/O error —
/// scrollback persistence is best-effort.
pub fn open_writer(data_dir: &Path, key: &str) -> Option<File> {
    if !is_safe_key(key) {
        tracing::warn!(key, "scrollback: refusing unsafe key");
        return None;
    }
    let dir = dir_for(data_dir);
    if let Err(e) = fs::create_dir_all(&dir) {
        tracing::warn!(error = %e, dir = %dir.display(), "scrollback: mkdir failed");
        return None;
    }
    let path = path_for(data_dir, key);
    if let Ok(meta) = fs::metadata(&path) {
        if meta.len() > MAX_BYTES {
            if let Err(e) = trim_to_tail(&path, MAX_BYTES) {
                tracing::warn!(error = %e, path = %path.display(), "scrollback: trim failed");
            }
        }
    }
    match OpenOptions::new().create(true).append(true).open(&path) {
        Ok(f) => Some(f),
        Err(e) => {
            tracing::warn!(error = %e, path = %path.display(), "scrollback: open failed");
            None
        }
    }
}

/// Replace `path` with its last `keep` bytes. Used to bound file size
/// on reopen — atomic via a sibling temp file.
fn trim_to_tail(path: &Path, keep: u64) -> std::io::Result<()> {
    let mut src = File::open(path)?;
    let len = src.metadata()?.len();
    if len <= keep {
        return Ok(());
    }
    src.seek(SeekFrom::Start(len - keep))?;
    let tmp_path = path.with_extension("log.tmp");
    {
        let mut dst = File::create(&tmp_path)?;
        std::io::copy(&mut src, &mut dst)?;
        dst.flush()?;
    }
    fs::rename(&tmp_path, path)
}

/// Read up to the last `MAX_BYTES` of `<key>.log`. Returns an empty
/// vec for an absent file (new tab) or any I/O hiccup.
pub fn read_tail(data_dir: &Path, key: &str) -> Vec<u8> {
    if !is_safe_key(key) {
        return Vec::new();
    }
    let path = path_for(data_dir, key);
    let mut file = match File::open(&path) {
        Ok(f) => f,
        Err(_) => return Vec::new(),
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let start = len.saturating_sub(MAX_BYTES);
    if file.seek(SeekFrom::Start(start)).is_err() {
        return Vec::new();
    }
    let mut buf = Vec::with_capacity((len - start) as usize);
    let _ = file.read_to_end(&mut buf);
    buf
}

/// Best-effort delete. No-op if the file does not exist.
pub fn delete(data_dir: &Path, key: &str) {
    if !is_safe_key(key) {
        return;
    }
    let path = path_for(data_dir, key);
    if let Err(e) = fs::remove_file(&path) {
        if e.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(error = %e, path = %path.display(), "scrollback: delete failed");
        }
    }
}

/// Wrapper that swallows write errors after logging once. Each session
/// gets one of these so a failing disk doesn't kill the pump.
pub struct Writer {
    file: File,
    failed: bool,
}

impl Writer {
    pub fn new(file: File) -> Self {
        Self { file, failed: false }
    }
    pub fn append(&mut self, bytes: &[u8]) {
        if self.failed {
            return;
        }
        if let Err(e) = self.file.write_all(bytes) {
            tracing::warn!(error = %e, "scrollback: write failed; disabling for this session");
            self.failed = true;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_append_and_read_tail() {
        let dir = tempfile::tempdir().unwrap();
        let key = "01TEST";
        {
            let mut w = Writer::new(open_writer(dir.path(), key).unwrap());
            w.append(b"hello ");
            w.append(b"world");
        }
        assert_eq!(read_tail(dir.path(), key), b"hello world");
    }

    #[test]
    fn trim_keeps_only_tail() {
        let dir = tempfile::tempdir().unwrap();
        let key = "01BIG";
        let path = path_for(dir.path(), key);
        fs::create_dir_all(dir_for(dir.path())).unwrap();
        let big = vec![b'A'; (MAX_BYTES + 1024) as usize];
        fs::write(&path, &big).unwrap();
        let _ = open_writer(dir.path(), key).unwrap();
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), MAX_BYTES);
    }

    #[test]
    fn rejects_unsafe_keys() {
        assert!(!is_safe_key("../etc/passwd"));
        assert!(!is_safe_key(""));
        assert!(!is_safe_key("with space"));
        assert!(is_safe_key("01HZ1ABCDEFG"));
    }
}
