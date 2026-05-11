//! End-to-end smoke: spawn a plain zsh session and verify NO
//! AgentIdleWaiting event fires within 6s — because zsh isn't a known
//! agent and isn't in alt-screen.
//!
//! macOS-only because foreground_process_name returns None elsewhere.

#![cfg(target_os = "macos")]

use std::time::Duration;

use karl_pty::SpawnOptions;
use karl_session::{Session, SessionEvent};

#[tokio::test(flavor = "multi_thread")]
async fn does_not_fire_for_plain_idle_shell() {
    let (_session, _streams) = Session::spawn(SpawnOptions::zsh_interactive())
        .expect("spawn");
    let mut bus = _session.subscribe();

    let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
    while tokio::time::Instant::now() < deadline {
        if let Ok(Ok(SessionEvent::AgentIdleWaiting { .. })) =
            tokio::time::timeout(Duration::from_millis(500), bus.recv()).await
        {
            panic!("unexpected AgentIdleWaiting for plain shell");
        }
    }
}
