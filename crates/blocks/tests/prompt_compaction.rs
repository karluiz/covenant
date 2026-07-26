#![cfg(unix)]
//! Prompt-compaction contract for the shell-integration snippets:
//! inside `<repo>/.covenant/worktrees/<slug>`, the rendered prompt
//! collapses to `repo ⌥slug` — but only when COVENANT_COMPACT_WORKTREE
//! is set.

use std::path::PathBuf;
use std::time::Duration;

use karl_pty::{PtySession, SpawnOptions};

fn snippet_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../shell-integration")
        .join(name)
        .canonicalize()
        .expect("locate snippet")
}

/// Spawn zsh with our snippet + `%~` prompt, cd into a fake worktree,
/// and return everything the PTY printed within the window.
async fn zsh_prompt_capture(compact: bool) -> (String, PathBuf) {
    let dir = tempfile::tempdir().expect("tempdir");
    // Fake worktree: <tmp>/groowcity/.covenant/worktrees/agent-claude-x
    let wt = dir
        .path()
        .join("groowcity/.covenant/worktrees/agent-claude-x");
    std::fs::create_dir_all(&wt).expect("mk worktree");

    let zdot = tempfile::tempdir().expect("zdotdir");
    std::fs::write(
        zdot.path().join(".zshrc"),
        format!(
            "PROMPT='%~ $ '\nsource {}\n",
            snippet_path("osc133.zsh").display()
        ),
    )
    .expect("write .zshrc");

    let mut opts = SpawnOptions::zsh_interactive();
    opts.args.push("--no-globalrcs".to_string());
    opts.env
        .push(("ZDOTDIR".to_string(), zdot.path().display().to_string()));
    if compact {
        opts.env
            .push(("COVENANT_COMPACT_WORKTREE".to_string(), "1".to_string()));
    }

    let (mut session, mut rx) = PtySession::spawn(opts).expect("spawn zsh");
    tokio::time::sleep(Duration::from_millis(300)).await;
    session
        .write(format!("cd {}\n", wt.display()).as_bytes())
        .expect("write cd");

    // Wait for the `cd`'s OSC 133;D (command-finished) marker, then keep
    // draining until the PTY goes quiet — that's when precmd has finished
    // redrawing the post-cd prompt. A plain substring-count heuristic
    // breaks too early: preexec's OSC 133;C marker echoes the full `cd`
    // command line, which alone can satisfy a naive "seen the path twice"
    // check before the actual second prompt has rendered.
    let mut got = String::new();
    let mut saw_command_done = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(bytes)) => {
                got.push_str(&String::from_utf8_lossy(&bytes));
                if got.contains("\u{1b}]133;D") {
                    saw_command_done = true;
                }
            }
            Ok(None) => break, // channel closed: shell exited
            Err(_) => {
                // recv() timed out: no new bytes in the last 200ms.
                if saw_command_done {
                    break; // quiet period after cd finished — prompt settled
                }
            }
        }
    }
    let _ = session.write(b"exit\n");
    (got, wt)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zsh_worktree_prompt_compacts_when_gated_on() {
    let (got, _wt) = zsh_prompt_capture(true).await;
    assert!(
        got.contains("~[groowcity ⌥agent-claude-x]"),
        "expected compacted dynamic-dir prompt, got: {got:?}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn zsh_worktree_prompt_full_when_gate_unset() {
    let (got, _wt) = zsh_prompt_capture(false).await;
    assert!(
        !got.contains("~["),
        "gate off must not rewrite the prompt, got: {got:?}"
    );
    // The post-cd prompt itself shows the full path (the cd echo is the
    // 1st occurrence; the rendered prompt is the 2nd).
    assert!(
        got.matches("worktrees/agent-claude-x").count() >= 2,
        "expected full path in prompt, got: {got:?}"
    );
}
