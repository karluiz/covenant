//! End-to-end: a session whose process moves WITHOUT emitting OSC 7 still
//! reports the new cwd. This is the agent-tab case — `claude`/`codex` run
//! the binary with no shell, so nothing emits OSC 7, and when the process
//! chdirs (or its worktree is deleted out from under it) the tab used to
//! keep the stale path forever.
//!
//! `/bin/sh -c 'cd …; sleep'` stands in for the agent: it changes its own
//! working directory and emits nothing.

#![cfg(any(target_os = "macos", target_os = "linux"))]

use std::time::Duration;

use karl_pty::{PtySize, SpawnOptions};
use karl_session::{Session, SessionEvent};

#[tokio::test(flavor = "multi_thread")]
async fn poll_reports_cwd_move_without_osc7() {
    let start = std::env::temp_dir();
    let target = std::fs::canonicalize(std::env::temp_dir().join("."))
        .unwrap()
        .join("cwd-poll-target");
    std::fs::create_dir_all(&target).expect("mkdir target");

    let (session, _streams) = Session::spawn(SpawnOptions {
        program: "/bin/sh".into(),
        args: vec!["-c".into(), format!("cd {} && sleep 30", target.display())],
        size: PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        },
        env: vec![],
        cwd: Some(start),
    })
    .expect("spawn");
    let mut bus = session.subscribe();

    // The poll runs on the 5-tick slow cadence (~6s worst case).
    let deadline = tokio::time::Instant::now() + Duration::from_secs(12);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Ok(SessionEvent::CwdChanged { cwd, .. })) =
            tokio::time::timeout(Duration::from_millis(500), bus.recv()).await
        {
            if std::fs::canonicalize(&cwd).unwrap_or(cwd) == target {
                return; // saw the move with no OSC 7 in play
            }
        }
    }
    panic!("no CwdChanged for {} within 12s", target.display());
}
