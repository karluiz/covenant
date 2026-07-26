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

/// bash has no zsh_directory_name; the snippet instead flips
/// PROMPT_DIRTRIM while inside a worktree. Drive bash non-interactively
/// and eval PROMPT_COMMAND by hand to observe the toggle.
#[test]
fn bash_dirtrim_set_inside_worktree_and_restored_outside() {
    let dir = tempfile::tempdir().expect("tempdir");
    let wt = dir.path().join("groowcity/.covenant/worktrees/agent-claude-x");
    std::fs::create_dir_all(&wt).expect("mk worktree");

    let script = format!(
        r#"export COVENANT_COMPACT_WORKTREE=1
export PROMPT_DIRTRIM=7
source {snippet}
cd {wt}
eval "$PROMPT_COMMAND" >/dev/null 2>&1
echo "IN=${{PROMPT_DIRTRIM:-unset}}"
cd /
eval "$PROMPT_COMMAND" >/dev/null 2>&1
echo "OUT=${{PROMPT_DIRTRIM:-unset}}"
"#,
        snippet = snippet_path("osc133.bash").display(),
        wt = wt.display(),
    );
    let out = std::process::Command::new("bash")
        .args(["--norc", "-c", &script])
        .output()
        .expect("run bash");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("IN=2"), "inside worktree: {stdout:?}");
    assert!(stdout.contains("OUT=7"), "restore prior value: {stdout:?}");
}

/// Gate off ⇒ the snippet must not touch PROMPT_DIRTRIM at all.
#[test]
fn bash_dirtrim_untouched_when_gate_unset() {
    let dir = tempfile::tempdir().expect("tempdir");
    let wt = dir.path().join("groowcity/.covenant/worktrees/agent-claude-x");
    std::fs::create_dir_all(&wt).expect("mk worktree");

    let script = format!(
        r#"unset COVENANT_COMPACT_WORKTREE
source {snippet}
cd {wt}
eval "$PROMPT_COMMAND" >/dev/null 2>&1
echo "IN=${{PROMPT_DIRTRIM:-unset}}"
"#,
        snippet = snippet_path("osc133.bash").display(),
        wt = wt.display(),
    );
    let out = std::process::Command::new("bash")
        .args(["--norc", "-c", &script])
        .output()
        .expect("run bash");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("IN=unset"), "gate off: {stdout:?}");
}

/// Regression test: appending __karl_dirtrim must preserve exit codes.
/// With COVENANT_COMPACT_WORKTREE=1, a failing command (false) should
/// emit OSC 133;D with exit code 1, not 0. The critical invariant:
/// __karl_precmd must capture $? before __karl_dirtrim runs.
#[test]
fn bash_exit_code_preserved_with_dirtrim_hook() {
    let dir = tempfile::tempdir().expect("tempdir");
    let wt = dir.path().join("groowcity/.covenant/worktrees/agent-claude-x");
    std::fs::create_dir_all(&wt).expect("mk worktree");

    let script = format!(
        r#"export COVENANT_COMPACT_WORKTREE=1
source {snippet}
cd {wt}
# Manually set _karl_cmd_active to simulate preexec, then run eval
# The key invariant: __karl_precmd's local exit=$? must capture the
# $? FROM BEFORE eval runs, i.e., from the previous 'false' command.
_karl_cmd_active=1; false; eval "$PROMPT_COMMAND" 2>&1
"#,
        snippet = snippet_path("osc133.bash").display(),
        wt = wt.display(),
    );
    let out = std::process::Command::new("bash")
        .args(["--norc", "-c", &script])
        .output()
        .expect("run bash");
    let stdout = String::from_utf8_lossy(&out.stdout);
    // The OSC 133;D marker must carry exit code 1, not 0
    assert!(
        stdout.contains("\u{1b}]133;D;1"),
        "OSC 133;D must report exit code 1 from 'false', got: {stdout:?}"
    );
}

/// Regression test (review finding 1): a pre-existing `PROMPT_COMMAND`
/// that already ends in `;` (e.g. `history -a;`, common with
/// `shopt -s histappend` setups) used to be joined with `"; __karl_dirtrim"`,
/// producing `history -a;; __karl_dirtrim` — a bash syntax error that
/// aborts parsing of the ENTIRE eval'd string, including `__karl_precmd`,
/// silently killing OSC 133 markers for the rest of the session. The
/// splice must join on a newline instead, which bash always treats as a
/// valid command separator regardless of what precedes it.
#[test]
fn bash_prompt_command_trailing_semicolon_does_not_break_chain() {
    let dir = tempfile::tempdir().expect("tempdir");
    let wt = dir.path().join("groowcity/.covenant/worktrees/agent-claude-x");
    std::fs::create_dir_all(&wt).expect("mk worktree");

    let script = format!(
        r#"export COVENANT_COMPACT_WORKTREE=1
export PROMPT_COMMAND='history -a;'
source {snippet}
cd {wt}
_karl_cmd_active=1; false; eval "$PROMPT_COMMAND"
echo "DIRTRIM=${{PROMPT_DIRTRIM:-unset}}"
"#,
        snippet = snippet_path("osc133.bash").display(),
        wt = wt.display(),
    );
    let out = std::process::Command::new("bash")
        .args(["--norc", "-c", &script])
        .output()
        .expect("run bash");
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(
        !stderr.contains("syntax error"),
        "trailing `;` in the prior PROMPT_COMMAND must not produce a bash \
         syntax error, stderr: {stderr:?}"
    );
    assert!(
        stdout.contains("DIRTRIM=2"),
        "__karl_dirtrim must still run (proves the chain didn't abort), got: {stdout:?}"
    );
    assert!(
        stdout.contains("\u{1b}]133;D;1"),
        "__karl_precmd must still run and emit OSC 133;D despite the \
         trailing `;`, got: {stdout:?}"
    );
}

/// Regression test (review finding 2): outside a worktree, the snippet
/// used to unconditionally overwrite PROMPT_DIRTRIM with the value
/// captured once at source time on EVERY prompt — clobbering anything
/// the user set interactively mid-session. It must now only touch
/// PROMPT_DIRTRIM on the worktree -> outside TRANSITION; a value set
/// outside a worktree, with no worktree visit in between, is left alone.
#[test]
fn bash_dirtrim_outside_worktree_never_clobbered() {
    // Must cd out of whatever directory the test runner started in —
    // that could itself be inside a `.covenant/worktrees/` checkout
    // (this repo IS one), which would spuriously match the worktree case.
    let outside = tempfile::tempdir().expect("tempdir");
    let script = format!(
        r#"export COVENANT_COMPACT_WORKTREE=1
source {snippet}
cd {outside}
export PROMPT_DIRTRIM=5
eval "$PROMPT_COMMAND" >/dev/null 2>&1
eval "$PROMPT_COMMAND" >/dev/null 2>&1
echo "DIRTRIM=${{PROMPT_DIRTRIM:-unset}}"
"#,
        snippet = snippet_path("osc133.bash").display(),
        outside = outside.path().display(),
    );
    let out = std::process::Command::new("bash")
        .args(["--norc", "-c", &script])
        .output()
        .expect("run bash");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(
        stdout.contains("DIRTRIM=5"),
        "interactive PROMPT_DIRTRIM outside a worktree must survive repeated \
         prompt redraws, got: {stdout:?}"
    );
}

/// pwsh: dot-source the snippet and unit-test the pure string function.
/// This file is `#![cfg(unix)]`, so the test only compiles on Unix hosts.
/// It self-skips when pwsh is not installed (macOS CI has no pwsh; native
/// Windows e2e belongs to the M8 Windows pipeline, not this test). Runs and
/// asserts wherever pwsh is available (e.g., pwsh on Linux/macOS).
#[test]
fn pwsh_compact_path_collapses_worktree_segment() {
    if std::process::Command::new("pwsh")
        .arg("-Version")
        .output()
        .is_err()
    {
        let msg = "SKIPPED: pwsh not installed — __Covenant-CompactPath unverified on this host";
        println!("{}", msg);
        eprintln!("{}", msg);
        return;
    }
    let script = format!(
        r#"$env:COVENANT_COMPACT_WORKTREE = '1'
. "{snippet}"
$win = __Covenant-CompactPath 'PS C:\Users\k\Sources\groowcity\.covenant\worktrees\agent-claude-x> '
if ($win -ne 'PS C:\Users\k\Sources\groowcity ⌥agent-claude-x> ') {{ Write-Output "WIN-FAIL: $win"; exit 1 }}
$nix = __Covenant-CompactPath 'PS /Users/k/Sources/groowcity/.covenant/worktrees/agent-claude-x> '
if ($nix -ne 'PS /Users/k/Sources/groowcity ⌥agent-claude-x> ') {{ Write-Output "NIX-FAIL: $nix"; exit 1 }}
$plain = __Covenant-CompactPath 'PS C:\Users\k> '
if ($plain -ne 'PS C:\Users\k> ') {{ Write-Output "PLAIN-FAIL: $plain"; exit 1 }}
$env:COVENANT_COMPACT_WORKTREE = $null
$gated = __Covenant-CompactPath 'PS /x/.covenant/worktrees/y> '
if ($gated -ne 'PS /x/.covenant/worktrees/y> ') {{ Write-Output "GATE-FAIL: $gated"; exit 1 }}
Write-Output OK
"#,
        snippet = snippet_path("osc133.ps1").display(),
    );
    let out = std::process::Command::new("pwsh")
        .args(["-NoProfile", "-NonInteractive", "-Command", &script])
        .output()
        .expect("run pwsh");
    let stdout = String::from_utf8_lossy(&out.stdout);
    assert!(stdout.contains("OK"), "pwsh: {stdout:?}");
}
