//! Filesystem watcher for capability directories.
//!
//! Wraps `notify::RecommendedWatcher` and broadcasts coarse `Added/Modified/Removed`
//! events over a `tokio::sync::broadcast` channel. Consumers (e.g. the Tauri layer)
//! subscribe and re-scan affected scopes on demand.
//!
//! **No debouncing in v0** — raw events are forwarded as-is. UI is expected to
//! coalesce/debounce as needed (typical: 200-500ms after last event per scope).
//!
//! Missing paths at `start()` time are silently skipped: capability directories
//! often do not exist until a user installs their first skill, and erroring on
//! that would force every caller to pre-stat the paths.
//!
//! Dropping the `CapabilityWatcher` stops the underlying notify watcher.

use std::path::PathBuf;

use notify::{Event, EventKind, Watcher};
use tokio::sync::broadcast;

use crate::model::{CapabilityError, CapabilityResult};

pub use notify::RecursiveMode;

const CHANNEL_CAPACITY: usize = 128;

#[derive(Debug, Clone)]
pub enum CapabilityEvent {
    Added(PathBuf),
    Modified(PathBuf),
    Removed(PathBuf),
}

/// Owns a `notify::RecommendedWatcher` and a broadcast sender. Drop to stop.
pub struct CapabilityWatcher {
    // Field order matters: `_inner` must drop before `tx` is dropped to ensure
    // the notify thread does not try to send into a closed channel — but in
    // practice the notify callback holds its own clone of `tx`, so dropping
    // `_inner` first cleanly tears down the OS handles.
    _inner: notify::RecommendedWatcher,
    tx: broadcast::Sender<CapabilityEvent>,
}

impl CapabilityWatcher {
    /// Start watching `paths`. Missing paths are skipped (logged at debug level).
    /// Errors from `notify::Watcher::new` are propagated as `CapabilityError::Io`.
    pub fn start(paths: Vec<(PathBuf, RecursiveMode)>) -> CapabilityResult<Self> {
        let (tx, _rx) = broadcast::channel::<CapabilityEvent>(CHANNEL_CAPACITY);
        let tx_cb = tx.clone();

        let mut watcher = notify::recommended_watcher(move |res: notify::Result<Event>| {
            match res {
                Ok(ev) => {
                    let variant: fn(PathBuf) -> CapabilityEvent = match ev.kind {
                        EventKind::Create(_) => CapabilityEvent::Added,
                        EventKind::Modify(_) => CapabilityEvent::Modified,
                        EventKind::Remove(_) => CapabilityEvent::Removed,
                        // Access, Any, Other — ignored.
                        _ => return,
                    };
                    for p in ev.paths {
                        // `send` errors only when no receivers exist; that is fine.
                        let _ = tx_cb.send(variant(p));
                    }
                }
                Err(e) => {
                    tracing::warn!(error = %e, "capability watcher: notify error");
                }
            }
        })
        .map_err(notify_to_io)?;

        for (path, mode) in paths {
            if !path.exists() {
                tracing::debug!(path = %path.display(), "capability watcher: skipping missing path");
                continue;
            }
            if let Err(e) = watcher.watch(&path, mode) {
                tracing::warn!(path = %path.display(), error = %e, "capability watcher: failed to watch path");
            }
        }

        Ok(Self {
            _inner: watcher,
            tx,
        })
    }

    pub fn subscribe(&self) -> broadcast::Receiver<CapabilityEvent> {
        self.tx.subscribe()
    }
}

fn notify_to_io(e: notify::Error) -> CapabilityError {
    CapabilityError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tempfile::TempDir;
    use tokio::time::timeout;

    /// Pull events until we find one matching the predicate, or timeout.
    async fn wait_for<F>(
        rx: &mut broadcast::Receiver<CapabilityEvent>,
        pred: F,
    ) -> Option<CapabilityEvent>
    where
        F: Fn(&CapabilityEvent) -> bool,
    {
        let fut = async {
            loop {
                match rx.recv().await {
                    Ok(ev) => {
                        if pred(&ev) {
                            return Some(ev);
                        }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => return None,
                }
            }
        };
        timeout(Duration::from_secs(3), fut).await.ok().flatten()
    }

    fn is_added(ev: &CapabilityEvent, name: &str) -> bool {
        matches!(ev, CapabilityEvent::Added(p) if p.file_name().map(|n| n == name).unwrap_or(false))
    }
    fn is_modified(ev: &CapabilityEvent, name: &str) -> bool {
        matches!(ev, CapabilityEvent::Modified(p) if p.file_name().map(|n| n == name).unwrap_or(false))
    }
    fn is_removed(ev: &CapabilityEvent, name: &str) -> bool {
        matches!(ev, CapabilityEvent::Removed(p) if p.file_name().map(|n| n == name).unwrap_or(false))
    }

    #[tokio::test]
    async fn create_file_emits_added() {
        let dir = TempDir::new().unwrap();
        let w = CapabilityWatcher::start(vec![(
            dir.path().to_path_buf(),
            RecursiveMode::NonRecursive,
        )])
        .unwrap();
        let mut rx = w.subscribe();
        tokio::time::sleep(Duration::from_millis(100)).await;

        let f = dir.path().join("hello.md");
        std::fs::write(&f, b"# hi").unwrap();

        let ev = wait_for(&mut rx, |e| is_added(e, "hello.md")).await;
        assert!(ev.is_some(), "expected Added(hello.md), got nothing");
    }

    #[tokio::test]
    async fn modify_file_emits_modified() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("a.txt");
        std::fs::write(&f, b"v1").unwrap();

        let w = CapabilityWatcher::start(vec![(
            dir.path().to_path_buf(),
            RecursiveMode::NonRecursive,
        )])
        .unwrap();
        let mut rx = w.subscribe();
        tokio::time::sleep(Duration::from_millis(100)).await;

        std::fs::write(&f, b"v2-changed").unwrap();

        let ev = wait_for(&mut rx, |e| is_modified(e, "a.txt")).await;
        assert!(ev.is_some(), "expected Modified(a.txt)");
    }

    #[tokio::test]
    async fn remove_file_emits_removed() {
        let dir = TempDir::new().unwrap();
        let f = dir.path().join("gone.txt");
        std::fs::write(&f, b"bye").unwrap();

        let w = CapabilityWatcher::start(vec![(
            dir.path().to_path_buf(),
            RecursiveMode::NonRecursive,
        )])
        .unwrap();
        let mut rx = w.subscribe();
        tokio::time::sleep(Duration::from_millis(100)).await;

        std::fs::remove_file(&f).unwrap();

        let ev = wait_for(&mut rx, |e| is_removed(e, "gone.txt")).await;
        assert!(ev.is_some(), "expected Removed(gone.txt)");
    }

    #[tokio::test]
    async fn missing_path_silently_skipped() {
        let dir = TempDir::new().unwrap();
        let missing = dir.path().join("does-not-exist");
        let real = dir.path().to_path_buf();
        // Mixing a missing path with a real one must succeed.
        let w = CapabilityWatcher::start(vec![
            (missing, RecursiveMode::NonRecursive),
            (real.clone(), RecursiveMode::NonRecursive),
        ])
        .expect("start should not error on missing paths");

        // And the real path still receives events.
        let mut rx = w.subscribe();
        tokio::time::sleep(Duration::from_millis(100)).await;
        std::fs::write(real.join("x.txt"), b"x").unwrap();
        let ev = wait_for(&mut rx, |e| is_added(e, "x.txt")).await;
        assert!(ev.is_some());
    }

    #[tokio::test]
    async fn two_subscribers_both_receive() {
        let dir = TempDir::new().unwrap();
        let w = CapabilityWatcher::start(vec![(
            dir.path().to_path_buf(),
            RecursiveMode::NonRecursive,
        )])
        .unwrap();
        let mut rx1 = w.subscribe();
        let mut rx2 = w.subscribe();
        tokio::time::sleep(Duration::from_millis(100)).await;

        std::fs::write(dir.path().join("dual.txt"), b"hi").unwrap();

        let e1 = wait_for(&mut rx1, |e| is_added(e, "dual.txt")).await;
        let e2 = wait_for(&mut rx2, |e| is_added(e, "dual.txt")).await;
        assert!(e1.is_some(), "rx1 missed event");
        assert!(e2.is_some(), "rx2 missed event");
    }

    #[tokio::test]
    async fn recursive_picks_up_subdir_events() {
        let dir = TempDir::new().unwrap();
        let w = CapabilityWatcher::start(vec![(
            dir.path().to_path_buf(),
            RecursiveMode::Recursive,
        )])
        .unwrap();
        let mut rx = w.subscribe();
        tokio::time::sleep(Duration::from_millis(100)).await;

        let sub = dir.path().join("nested");
        std::fs::create_dir(&sub).unwrap();
        tokio::time::sleep(Duration::from_millis(150)).await;
        std::fs::write(sub.join("deep.md"), b"# deep").unwrap();

        let ev = wait_for(&mut rx, |e| is_added(e, "deep.md")).await;
        assert!(ev.is_some(), "expected Added(deep.md) from subdir");
    }
}
