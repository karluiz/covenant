#![cfg(unix)]
//! End-to-end check that the real `shell-integration/osc133.zsh` snippet,
//! sourced from a sandboxed ZDOTDIR, makes zsh emit the OSC sequences
//! `BlockParser` understands. Verifies both halves of the contract — the
//! shell snippet AND the parser — at once.

use std::path::PathBuf;
use std::time::Duration;

use karl_blocks::{BlockEvent, BlockParser};
use karl_pty::{PtySession, SpawnOptions};

fn snippet_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../shell-integration/osc133.zsh")
        .canonicalize()
        .expect("locate osc133.zsh")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zsh_snippet_emits_osc133_markers() {
    let dir = tempfile::tempdir().expect("tempdir");
    let zshrc = dir.path().join(".zshrc");
    std::fs::write(
        &zshrc,
        format!("PROMPT='$ '\nsource {}\n", snippet_path().display()),
    )
    .expect("write .zshrc");

    // Sandbox: ZDOTDIR points at our tempdir so user .zshrc is bypassed,
    // and --no-globalrcs skips /etc/zshrc which can be slow / chatty.
    let mut opts = SpawnOptions::zsh_interactive();
    opts.args.push("--no-globalrcs".to_string());
    opts.env
        .push(("ZDOTDIR".to_string(), dir.path().display().to_string()));

    let (mut session, mut rx) = PtySession::spawn(opts).expect("spawn zsh");

    // Let the first prompt render (precmd fires once for the initial A
    // marker and prompt-side B injection).
    tokio::time::sleep(Duration::from_millis(200)).await;
    session
        .write(b"echo karl-test\nexit\n")
        .expect("write to pty");

    // Drain until EOF with a hard timeout so a hung shell fails fast.
    let bytes = tokio::time::timeout(Duration::from_secs(10), async {
        let mut buf = Vec::new();
        while let Some(chunk) = rx.recv().await {
            buf.extend_from_slice(&chunk);
        }
        buf
    })
    .await
    .expect("pty drain timed out");

    let mut parser = BlockParser::new();
    let events = parser.feed(&bytes);

    assert!(
        events.iter().any(|e| matches!(e, BlockEvent::PromptStart)),
        "expected at least one PromptStart in: {events:?}"
    );
    assert!(
        events.iter().any(|e| matches!(
            e,
            BlockEvent::CommandSubmitted { command } if command.contains("echo karl-test")
        )),
        "expected CommandSubmitted{{echo karl-test}} in: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, BlockEvent::CommandFinished { exit_code: Some(0) })),
        "expected CommandFinished{{0}} for `echo karl-test` in: {events:?}"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, BlockEvent::CwdChanged { .. })),
        "expected CwdChanged from OSC 7 in: {events:?}"
    );

    drop(dir);
}
