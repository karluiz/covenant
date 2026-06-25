//! Filesystem watcher that records newly emitted spec files into the score store.
//!
//! Match rule: a path is a "spec" if it lives under a `**/specs/**` directory
//! and ends in `.md`.

use crate::Context;
use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub struct WatcherHandle {
    _watcher: RecommendedWatcher,
    _thread: JoinHandle<()>,
}

pub fn start(roots: Vec<PathBuf>) -> (WatcherHandle, mpsc::Sender<()>) {
    let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
    let (stop_tx, stop_rx) = mpsc::channel::<()>();

    let mut watcher: RecommendedWatcher = notify::recommended_watcher(tx).expect("watcher");
    for r in &roots {
        let _ = watcher.watch(r, RecursiveMode::Recursive);
    }

    let thread = std::thread::spawn(move || {
        let mut last_seen: std::collections::HashMap<PathBuf, Instant> = Default::default();
        let debounce = Duration::from_millis(500);
        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }
            match rx.recv_timeout(Duration::from_millis(250)) {
                Ok(Ok(ev)) => handle_event(ev, &mut last_seen, debounce),
                Ok(Err(_)) => {}
                Err(mpsc::RecvTimeoutError::Timeout) => continue,
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });

    (
        WatcherHandle {
            _watcher: watcher,
            _thread: thread,
        },
        stop_tx,
    )
}

fn handle_event(
    ev: Event,
    seen: &mut std::collections::HashMap<PathBuf, Instant>,
    debounce: Duration,
) {
    let is_create = matches!(ev.kind, EventKind::Create(_) | EventKind::Modify(_));
    if !is_create {
        return;
    }
    for path in ev.paths {
        if !is_spec_path(&path) {
            continue;
        }
        let now = Instant::now();
        if let Some(prev) = seen.get(&path) {
            if now.duration_since(*prev) < debounce {
                continue;
            }
        }
        seen.insert(path.clone(), now);
        let path_s = path.to_string_lossy().to_string();
        let mut ctx = derive_context(&path);
        // The path gives us the repo; inherit the active group/workspace from the
        // current session so per-group Inference views count specs.
        let cur = crate::current_context();
        if ctx.group_name.is_none() {
            ctx.group_name = cur.group_name;
        }
        if ctx.workspace.is_none() {
            ctx.workspace = cur.workspace;
        }
        crate::record_spec(&path_s, &ctx);
    }
}

fn is_spec_path(p: &Path) -> bool {
    p.extension().and_then(|e| e.to_str()) == Some("md")
        && p.components().any(|c| c.as_os_str() == "specs")
}

fn derive_context(p: &Path) -> Context {
    let mut cur = p.parent();
    while let Some(d) = cur {
        if d.join(".git").exists() {
            return Context {
                repo: d.file_name().and_then(|s| s.to_str()).map(String::from),
                branch: None,
                group_name: None,
                workspace: None,
            };
        }
        cur = d.parent();
    }
    Context::default()
}

#[cfg(test)]
mod unit {
    use super::*;

    #[test]
    fn is_spec_recognizes_specs_dir() {
        assert!(is_spec_path(Path::new("/x/docs/specs/foo.md")));
        assert!(!is_spec_path(Path::new("/x/docs/foo.md")));
        assert!(!is_spec_path(Path::new("/x/specs/foo.txt")));
    }
}
