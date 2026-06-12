# Windows Release v0.3.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a Windows build of Covenant Terminal with functional parity to macOS — `pwsh` shell, OSC 133 integration, ConPTY-backed sessions, full app stack — distributed unsigned via GitHub Releases.

**Architecture:** Reuse the existing cross-platform stack (Tauri 2, `portable-pty`, `rusqlite`, xterm.js). Add a PowerShell OSC 133 snippet, extend `pty` crate to resolve and spawn `pwsh.exe`, audit `#[cfg(unix)]` blocks for Windows counterparts, configure Tauri MSI bundling, and add a `windows-latest` GitHub Actions release workflow.

**Tech Stack:** Rust + Tokio + `portable-pty` + ConPTY, PowerShell 7 (`pwsh`), Tauri 2 with MSI bundler + WebView2 bootstrapper, GitHub Actions `windows-latest`, xterm.js.

**Spec:** `docs/superpowers/specs/2026-05-10-windows-release-design.md`

---

## File Structure

**Create:**
- `shell-integration/osc133.ps1` — PowerShell OSC 133 + OSC 7 snippet
- `crates/pty/src/shell.rs` — `ShellKind` enum + per-platform resolution (`pwsh.exe` on Windows, `zsh`/`bash` on Unix)
- `crates/pty/tests/windows_smoke.rs` — `#[cfg(windows)]` ConPTY smoke test
- `crates/blocks/tests/pwsh_fixtures.rs` — block parser tests against pwsh-style OSC 133 sequences
- `.github/workflows/release-windows.yml` — Windows release CI
- `docs/install-windows.md` — short install / first-run notes (linked from README)

**Modify:**
- `crates/pty/src/lib.rs` — replace hardcoded `/bin/zsh` defaults with shell-resolved `SpawnOptions`; add `windows_smoke_test` analogue
- `crates/app/tauri.conf.json` — Windows bundle config (msi target, webview2 bootstrapper)
- `crates/app/Cargo.toml` — verify `rusqlite` has `bundled` feature on Windows
- `crates/app/icons/` — add `icon.ico` if missing (Tauri config already references it)
- Any `#[cfg(unix)]` blocks discovered in audit (see Task 9)

---

## Task 1: Add `ShellKind` enum with platform resolution

**Files:**
- Create: `crates/pty/src/shell.rs`
- Modify: `crates/pty/src/lib.rs` (add `pub mod shell;` and re-export)
- Test: `crates/pty/src/shell.rs` (inline `#[cfg(test)]`)

- [ ] **Step 1: Write the failing test**

Append to `crates/pty/src/shell.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_shell_resolves_on_current_platform() {
        let shell = ShellKind::default_for_platform().expect("must resolve a shell");
        match shell {
            #[cfg(unix)]
            ShellKind::Zsh { program } | ShellKind::Bash { program } => {
                assert!(program.exists(), "resolved shell must exist on disk: {:?}", program);
            }
            #[cfg(windows)]
            ShellKind::PowerShell { program, .. } => {
                assert!(program.exists(), "resolved pwsh must exist on disk: {:?}", program);
            }
            #[allow(unreachable_patterns)]
            other => panic!("unexpected shell kind: {:?}", other),
        }
    }

    #[cfg(windows)]
    #[test]
    fn windows_rejects_cmd_exe() {
        let err = ShellKind::resolve_explicit("cmd.exe").unwrap_err();
        assert!(matches!(err, ShellError::Unsupported(_)));
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-pty shell::tests`
Expected: FAIL — `ShellKind` undefined.

- [ ] **Step 3: Implement `shell.rs`**

Create `crates/pty/src/shell.rs`:

```rust
//! Per-platform shell resolution.
//!
//! On Unix: prefer `$SHELL`, fall back to `/bin/zsh` then `/bin/bash`.
//! On Windows: prefer `pwsh.exe` (PowerShell 7+) found via `PATH`. Reject
//! `cmd.exe` (no reliable OSC 133). Windows PowerShell 5.1 is out of scope
//! for v0.3.0.

use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum ShellError {
    #[error("no supported shell found on this platform")]
    NotFound,
    #[error("shell `{0}` is not supported by Covenant")]
    Unsupported(String),
}

#[derive(Debug, Clone)]
pub enum ShellKind {
    #[cfg(unix)]
    Zsh { program: PathBuf },
    #[cfg(unix)]
    Bash { program: PathBuf },
    #[cfg(windows)]
    PowerShell { program: PathBuf, pwsh: bool },
}

impl ShellKind {
    pub fn program(&self) -> &Path {
        match self {
            #[cfg(unix)]
            ShellKind::Zsh { program } | ShellKind::Bash { program } => program,
            #[cfg(windows)]
            ShellKind::PowerShell { program, .. } => program,
        }
    }

    pub fn default_for_platform() -> Result<Self, ShellError> {
        #[cfg(unix)]
        {
            if let Ok(env_shell) = std::env::var("SHELL") {
                let p = PathBuf::from(&env_shell);
                if p.exists() {
                    if env_shell.ends_with("zsh") {
                        return Ok(ShellKind::Zsh { program: p });
                    }
                    if env_shell.ends_with("bash") {
                        return Ok(ShellKind::Bash { program: p });
                    }
                }
            }
            for candidate in ["/bin/zsh", "/bin/bash"] {
                let p = PathBuf::from(candidate);
                if p.exists() {
                    return Ok(if candidate.ends_with("zsh") {
                        ShellKind::Zsh { program: p }
                    } else {
                        ShellKind::Bash { program: p }
                    });
                }
            }
            Err(ShellError::NotFound)
        }

        #[cfg(windows)]
        {
            if let Some(p) = which_on_path("pwsh.exe") {
                return Ok(ShellKind::PowerShell { program: p, pwsh: true });
            }
            Err(ShellError::NotFound)
        }
    }

    pub fn resolve_explicit(name: &str) -> Result<Self, ShellError> {
        let lower = name.to_ascii_lowercase();
        #[cfg(windows)]
        {
            if lower == "cmd" || lower == "cmd.exe" {
                return Err(ShellError::Unsupported(name.to_string()));
            }
            if lower == "powershell" || lower == "powershell.exe" {
                return Err(ShellError::Unsupported(
                    "Windows PowerShell 5.1 not supported in v0.3.0".to_string(),
                ));
            }
            if lower == "pwsh" || lower == "pwsh.exe" {
                if let Some(p) = which_on_path("pwsh.exe") {
                    return Ok(ShellKind::PowerShell { program: p, pwsh: true });
                }
                return Err(ShellError::NotFound);
            }
        }
        #[cfg(unix)]
        {
            let _ = lower;
        }
        Err(ShellError::Unsupported(name.to_string()))
    }
}

#[cfg(windows)]
fn which_on_path(exe: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        let candidate = dir.join(exe);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}
```

Add to `crates/pty/src/lib.rs` near the top:

```rust
pub mod shell;
pub use shell::{ShellError, ShellKind};
```

Verify `thiserror` is in `crates/pty/Cargo.toml`. If missing: `cargo add thiserror -p karl-pty`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-pty shell::tests`
Expected: PASS on the current platform; the `windows_rejects_cmd_exe` test is gated `#[cfg(windows)]` so it's only checked on Windows runs.

- [ ] **Step 5: Commit**

```bash
git add crates/pty/src/shell.rs crates/pty/src/lib.rs crates/pty/Cargo.toml
git commit -m "feat(pty): add ShellKind enum with per-platform resolution"
```

---

## Task 2: Plumb `ShellKind` into `SpawnOptions`

**Files:**
- Modify: `crates/pty/src/lib.rs:64-90` (the `SpawnOptions` struct and its constructors)
- Test: same file, extend the existing `#[cfg(test)] mod tests`

- [ ] **Step 1: Write the failing test**

Append to the existing `#[cfg(test)] mod tests` in `crates/pty/src/lib.rs`:

```rust
#[test]
fn spawn_options_from_default_shell_matches_platform() {
    let opts = SpawnOptions::from_default_shell().expect("default shell options");
    #[cfg(unix)]
    assert!(opts.program.ends_with("zsh") || opts.program.ends_with("bash"));
    #[cfg(windows)]
    assert!(opts.program.to_lowercase().ends_with("pwsh.exe"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cargo test -p karl-pty spawn_options_from_default_shell_matches_platform`
Expected: FAIL — `from_default_shell` undefined.

- [ ] **Step 3: Add `from_default_shell` constructor**

In `crates/pty/src/lib.rs`, add alongside `zsh_interactive`:

```rust
impl SpawnOptions {
    pub fn from_default_shell() -> Result<Self, crate::shell::ShellError> {
        let shell = crate::shell::ShellKind::default_for_platform()?;
        let program = shell.program().to_string_lossy().into_owned();
        let args: Vec<String> = match &shell {
            #[cfg(unix)]
            crate::shell::ShellKind::Zsh { .. } | crate::shell::ShellKind::Bash { .. } => {
                vec!["-i".into()]
            }
            #[cfg(windows)]
            crate::shell::ShellKind::PowerShell { .. } => {
                // -NoLogo suppresses banner; -NoExit keeps the shell alive.
                vec!["-NoLogo".into()]
            }
        };
        Ok(Self {
            program,
            args,
            cwd: None,
            env: Default::default(),
            cols: 80,
            rows: 24,
        })
    }
}
```

(Adjust field names to match the actual `SpawnOptions` definition discovered at lines 64-90.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `cargo test -p karl-pty spawn_options_from_default_shell_matches_platform`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/pty/src/lib.rs
git commit -m "feat(pty): add SpawnOptions::from_default_shell"
```

---

## Task 3: Windows ConPTY smoke test

**Files:**
- Create: `crates/pty/tests/windows_smoke.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/pty/tests/windows_smoke.rs`:

```rust
//! M0-equivalent for Windows: spawn pwsh.exe via ConPTY, write a command,
//! assert the output appears. Gated so non-Windows hosts skip the file.

#![cfg(windows)]

use karl_pty::{PtySession, SpawnOptions};
use std::io::Write;
use std::time::{Duration, Instant};

#[test]
fn pwsh_echo_round_trip() {
    let opts = SpawnOptions::from_default_shell()
        .expect("pwsh.exe must be on PATH for this test");
    let (mut session, mut rx) = PtySession::spawn(opts).expect("spawn pwsh");

    // Pwsh needs a moment to print its banner-less prompt.
    std::thread::sleep(Duration::from_millis(400));

    session
        .writer
        .write_all(b"Write-Output covenant-hello\r\n")
        .expect("write to pty");
    session.writer.flush().ok();

    let deadline = Instant::now() + Duration::from_secs(6);
    let mut buf = Vec::new();
    while Instant::now() < deadline {
        if let Ok(chunk) = rx.try_recv() {
            buf.extend_from_slice(&chunk);
            if String::from_utf8_lossy(&buf).contains("covenant-hello") {
                return;
            }
        } else {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    panic!(
        "did not observe 'covenant-hello' within 6s. buffer was: {:?}",
        String::from_utf8_lossy(&buf)
    );
}
```

(Adjust `PtySession`/`OutputReceiver` field/method names to match `crates/pty/src/lib.rs:103`.)

- [ ] **Step 2: Run the test to verify it fails locally (on macOS)**

Run: `cargo test -p karl-pty --test windows_smoke`
Expected: PASS trivially on macOS (file is empty under `#![cfg(windows)]`). On Windows it would fail until `from_default_shell` is wired up — which Task 2 already did.

- [ ] **Step 3: (Windows CI) Verify smoke passes**

This step executes on the Windows CI runner introduced in Task 11. Locally on macOS, no action.

- [ ] **Step 4: Commit**

```bash
git add crates/pty/tests/windows_smoke.rs
git commit -m "test(pty): ConPTY pwsh round-trip smoke test"
```

---

## Task 4: PowerShell OSC 133 + OSC 7 snippet

**Files:**
- Create: `shell-integration/osc133.ps1`

- [ ] **Step 1: Write the snippet**

Create `shell-integration/osc133.ps1`:

```powershell
# OSC 133 + OSC 7 shell integration for Covenant Terminal (PowerShell 7+).
#
# Emits the same prompt/command/exit markers as osc133.zsh so the karl-blocks
# parser segments pwsh streams identically. Source from your $PROFILE *after*
# any prompt framework (oh-my-posh, starship) so our PS1 wrapping survives:
#
#     oh-my-posh init pwsh | Invoke-Expression
#     . "$HOME\.covenant\osc133.ps1"
#
# Reference:
#   https://wezfurlong.org/wezterm/shell-integration.html

if ($Global:_CovenantOsc133Loaded) { return }
$Global:_CovenantOsc133Loaded = $true

# Force UTF-8 so OSC payloads (and command output in general) survive the PTY.
try { [Console]::OutputEncoding = [Text.UTF8Encoding]::new() } catch {}
try { $OutputEncoding = [Text.UTF8Encoding]::new() } catch {}

$ESC = [char]27
$ST  = "$ESC\"  # ST = ESC \

function global:__Covenant-EmitOsc7 {
    $cwd = (Get-Location).Path -replace '\\','/'
    [Console]::Write("$ESC]7;file://$env:COMPUTERNAME/$cwd$ST")
}

# Wrap the user's existing `prompt` function so we keep their PS1 chrome and
# only sandwich our markers around it.
$prevPrompt = (Get-Item function:prompt -ErrorAction SilentlyContinue)
$Global:_CovenantPrevPrompt = if ($prevPrompt) { $prevPrompt.ScriptBlock } else { { "PS $($executionContext.SessionState.Path.CurrentLocation)> " } }

function global:prompt {
    $exit = $LASTEXITCODE
    if ($null -ne $Global:_CovenantLastCmd) {
        [Console]::Write("$ESC]133;D;$exit$ST")
        $Global:_CovenantLastCmd = $null
    }
    [Console]::Write("$ESC]133;A$ST")
    __Covenant-EmitOsc7
    $rendered = & $Global:_CovenantPrevPrompt
    "$rendered$ESC]133;B$ST"
}

# Hook command submission via PSReadLine to emit OSC 133;C with the command
# text. AcceptLine is the canonical Enter handler.
if (Get-Module -ListAvailable PSReadLine) {
    Import-Module PSReadLine -ErrorAction SilentlyContinue
    Set-PSReadLineKeyHandler -Key Enter -ScriptBlock {
        param($key, $arg)
        $line = $null; $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        $clean = ($line -replace "[\x00\x07\x1b]", '')
        [Console]::Write("$ESC]133;C;$clean$ST")
        $Global:_CovenantLastCmd = $clean
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
    }
}
```

- [ ] **Step 2: Manual sanity check (defer to CI/QA)**

The snippet can only be exercised end-to-end on Windows. Step 8 of the QA checklist (Task 13) covers it. No local test.

- [ ] **Step 3: Commit**

```bash
git add shell-integration/osc133.ps1
git commit -m "feat(shell-integration): PowerShell OSC 133 + OSC 7 snippet"
```

---

## Task 5: Block parser fixtures for pwsh output

**Files:**
- Create: `crates/blocks/tests/pwsh_fixtures.rs`

- [ ] **Step 1: Write the failing test**

Create `crates/blocks/tests/pwsh_fixtures.rs`:

```rust
//! Verify the OSC 133 parser handles pwsh-shaped streams: CRLF line
//! endings, UTF-8 BOMs that PowerShell sometimes prepends, and the
//! 133;C payload coming from the PSReadLine Enter handler.

use karl_blocks::{BlockEvent, OscParser};

fn esc(s: &str) -> Vec<u8> {
    s.replace("ESC", "\x1b").replace("ST", "\x1b\\").into_bytes()
}

#[test]
fn pwsh_full_cycle_with_crlf_emits_block() {
    let mut parser = OscParser::new();
    let stream = [
        esc("ESC]133;AST"),
        esc("ESC]7;file://HOST/C:/Users/karl ST"),
        esc("PS C:/Users/karl> ESC]133;BST"),
        esc("ESC]133;C;Get-Process pwshST"),
        b"\r\nNPM(K) PM(M) CPU(s)   Id  ProcessName\r\n".to_vec(),
        b"--- ----- ------ -- -----------\r\n".to_vec(),
        b"  5  12.3   1.42 1234 pwsh\r\n".to_vec(),
        esc("ESC]133;D;0ST"),
    ]
    .concat();

    let events: Vec<_> = parser.feed(&stream).collect();
    assert!(
        events.iter().any(|e| matches!(e, BlockEvent::CommandStarted { cmd } if cmd == "Get-Process pwsh")),
        "expected CommandStarted with pwsh command, got: {:?}",
        events
    );
    assert!(
        events.iter().any(|e| matches!(e, BlockEvent::CommandFinished { exit_code: 0 })),
        "expected CommandFinished(exit=0), got: {:?}",
        events
    );
}
```

(Adjust `OscParser` / `BlockEvent` symbol names to match `crates/blocks/src/lib.rs`. If the public API differs, mirror the shape of the existing zsh test in that file.)

- [ ] **Step 2: Run the test to verify it fails (or passes if parser already handles this)**

Run: `cargo test -p karl-blocks --test pwsh_fixtures`
Expected: PASS if the parser is shell-agnostic (it should be — it parses bytes). If it FAILS, the parser is making zsh-specific assumptions; fix in `crates/blocks/src/lib.rs` before continuing.

- [ ] **Step 3: Commit**

```bash
git add crates/blocks/tests/pwsh_fixtures.rs
git commit -m "test(blocks): pwsh-shaped OSC 133 stream fixtures"
```

---

## Task 6: Replace hardcoded `/bin/zsh` callsites

**Files:**
- Modify: `crates/pty/src/lib.rs` (`SpawnOptions::zsh_interactive` callers, `smoke_zsh_echo`)
- Modify: `crates/session/src/*.rs` — any session spawn point
- Modify: `crates/app/src/*.rs` — Tauri command that spawns the user-facing session

- [ ] **Step 1: Find every hardcoded `/bin/zsh` reference**

Run:
```bash
rg -n '/bin/zsh|/bin/bash|"zsh"|"bash"' crates/ --type rust
```
Expected: list of callsites (at minimum `crates/pty/src/lib.rs:78`, `:195`).

- [ ] **Step 2: Replace each session-spawning callsite with `from_default_shell`**

For every callsite that creates a *user-facing* session (not the `smoke_zsh_echo` Unix-only smoke test, which stays as-is and remains `#[cfg(unix)]`), swap:

```rust
let opts = SpawnOptions::zsh_interactive();
```

with:

```rust
let opts = SpawnOptions::from_default_shell()
    .map_err(|e| /* convert to local error */)?;
```

Gate `smoke_zsh_echo` with `#[cfg(unix)]` if it isn't already, so Windows builds don't try to spawn `/bin/zsh`.

- [ ] **Step 3: Build for the current platform**

Run: `cargo build --workspace`
Expected: clean build.

- [ ] **Step 4: Run full test suite**

Run: `cargo test --workspace`
Expected: all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(pty,session,app): resolve shell via from_default_shell"
```

---

## Task 7: Gate `smoke_zsh_echo` and Unix-only paths

**Files:**
- Modify: `crates/pty/src/lib.rs` (around line 186-260)

- [ ] **Step 1: Add `#[cfg(unix)]` gates**

In `crates/pty/src/lib.rs`, wrap `smoke_zsh_echo`, the test that calls it, and any `/bin/zsh` literal with `#[cfg(unix)]`:

```rust
#[cfg(unix)]
pub fn smoke_zsh_echo() -> Result<String, PtyError> {
    // ... existing body ...
}
```

Do the same for the test:

```rust
#[cfg(unix)]
#[test]
fn smoke_zsh_echo_returns_hello() { /* ... */ }
```

- [ ] **Step 2: Build for Windows (cross-check)**

Run on macOS:
```bash
cargo check -p karl-pty --target x86_64-pc-windows-msvc
```

If the toolchain isn't installed, skip — CI will catch it. Otherwise expect: clean check.

- [ ] **Step 3: Commit**

```bash
git add crates/pty/src/lib.rs
git commit -m "build(pty): gate Unix-only smoke test and zsh literals"
```

---

## Task 8: Cross-platform paths and home-dir audit

**Files:**
- Modify: as discovered

- [ ] **Step 1: Grep for `/` path literals and forbidden Unix-only APIs**

Run:
```bash
rg -n '"\.config/|"\.local/|/etc/|/tmp/|"\$HOME' crates/ --type rust
rg -n 'std::os::unix|#\[cfg\(unix\)\]' crates/ --type rust
```

- [ ] **Step 2: For each hit, choose one of**

- If the literal is a Unix-specific path that has a Windows equivalent → replace with `dirs::config_dir()`, `dirs::data_local_dir()`, `std::env::temp_dir()`, or similar.
- If the code is genuinely Unix-only (signal handling, file modes) → wrap in `#[cfg(unix)]` and add a `#[cfg(windows)]` no-op or alternative.
- If the code is fine cross-platform (e.g. `PathBuf::join` with `/`) → no change needed.

- [ ] **Step 3: Verify `rusqlite` is bundled on Windows**

Inspect `Cargo.toml` files in the workspace:
```bash
rg -n 'rusqlite' crates/*/Cargo.toml
```

Ensure the line reads `rusqlite = { version = "...", features = ["bundled"] }` (or equivalent) in every crate that depends on it. If `bundled` is missing, add it. Without it, Windows builds will fail looking for `sqlite3.dll`.

- [ ] **Step 4: Build & test**

Run: `cargo build --workspace && cargo test --workspace`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: cross-platform paths and bundled sqlite"
```

---

## Task 9: Tauri Windows bundle configuration

**Files:**
- Modify: `crates/app/tauri.conf.json`
- Verify: `crates/app/icons/icon.ico` exists

- [ ] **Step 1: Confirm `icon.ico` is present**

Run: `ls crates/app/icons/icon.ico`
Expected: file exists. If missing, regenerate from `icon.png` using:
```bash
sips -s format ico crates/app/icons/128x128@2x.png --out crates/app/icons/icon.ico
```
(or use ImageMagick / an online converter; commit the result).

- [ ] **Step 2: Update `tauri.conf.json` to add Windows bundle settings**

Replace the `bundle` block in `crates/app/tauri.conf.json` with:

```json
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "windows": {
      "webviewInstallMode": {
        "type": "downloadBootstrapper"
      },
      "wix": {
        "language": "en-US"
      }
    }
  }
```

`targets: "all"` already includes `msi` on Windows hosts, so we do not have to enumerate it. The `webviewInstallMode.downloadBootstrapper` ensures the installer fetches WebView2 on machines that lack it (older Win10).

- [ ] **Step 3: Validate JSON**

Run: `python3 -m json.tool < crates/app/tauri.conf.json > /dev/null`
Expected: no output (valid JSON).

- [ ] **Step 4: Commit**

```bash
git add crates/app/tauri.conf.json crates/app/icons/icon.ico
git commit -m "build(tauri): Windows bundle config with WebView2 bootstrapper"
```

---

## Task 10: Frontend Windows audit

**Files:**
- Modify: `ui/src/**/*.ts` as needed

- [ ] **Step 1: Grep for hardcoded Unix paths in the frontend**

Run:
```bash
rg -n '"~/|"/home/|"/Users/|/bin/' ui/src --type ts
```

- [ ] **Step 2: For each hit, replace with backend-provided path**

If the frontend constructs filesystem paths, it must receive them from the backend (where `dirs::*` already abstracts platform). Move any such construction into a Tauri command and expose it via `ui/src/api.ts`. No fix expected for the common case (xterm.js doesn't touch paths) — this is a defensive sweep.

- [ ] **Step 3: Build the frontend**

Run: `npm run build`
Expected: clean build, no errors.

- [ ] **Step 4: Commit if changes**

```bash
git add ui/
git commit -m "refactor(ui): replace hardcoded Unix paths with backend-provided values"
```

If no changes, skip the commit.

---

## Task 11: GitHub Actions Windows release workflow

**Files:**
- Create: `.github/workflows/release-windows.yml`

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/release-windows.yml`:

```yaml
name: Release Windows

on:
  push:
    tags:
      - 'v*'
  workflow_dispatch:

jobs:
  build:
    runs-on: windows-latest
    permissions:
      contents: write

    steps:
      - uses: actions/checkout@v4

      - name: Install Rust stable
        uses: dtolnay/rust-toolchain@stable

      - name: Cache cargo registry
        uses: actions/cache@v4
        with:
          path: |
            ~/.cargo/registry
            ~/.cargo/git
            target
          key: ${{ runner.os }}-cargo-${{ hashFiles('**/Cargo.lock') }}

      - name: Setup Node
        uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install frontend deps
        run: npm ci

      - name: Run pty smoke test
        run: cargo test -p karl-pty --test windows_smoke -- --nocapture

      - name: Run workspace tests
        run: cargo test --workspace --release

      - name: Build Tauri MSI
        run: npm run tauri build
        env:
          # Unsigned build — TAURI_SIGNING_PRIVATE_KEY intentionally omitted.
          RUST_BACKTRACE: 1

      - name: Locate MSI
        id: msi
        shell: pwsh
        run: |
          $msi = Get-ChildItem -Recurse -Filter '*.msi' | Select-Object -First 1
          if (-not $msi) { Write-Error 'no msi produced'; exit 1 }
          "path=$($msi.FullName)" >> $env:GITHUB_OUTPUT
          "name=$($msi.Name)"     >> $env:GITHUB_OUTPUT

      - name: Upload MSI to release
        if: startsWith(github.ref, 'refs/tags/v')
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        shell: pwsh
        run: |
          gh release upload "${{ github.ref_name }}" "${{ steps.msi.outputs.path }}" --clobber

      - name: Upload MSI as workflow artifact
        if: github.event_name == 'workflow_dispatch'
        uses: actions/upload-artifact@v4
        with:
          name: covenant-windows-msi
          path: ${{ steps.msi.outputs.path }}
```

- [ ] **Step 2: Validate YAML syntax**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/release-windows.yml'))"`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-windows.yml
git commit -m "ci: Windows release workflow (windows-latest, MSI build, smoke test)"
```

---

## Task 12: First Windows CI run (workflow_dispatch dry-run)

**Files:** none

- [ ] **Step 1: Push branch and trigger workflow manually**

```bash
git push origin <branch>
gh workflow run release-windows.yml --ref <branch>
```

- [ ] **Step 2: Watch the run**

```bash
gh run watch
```

Expected: green run. Common failures and remedies:
- `pwsh.exe not found` → `windows-latest` runners ship pwsh; if missing, add `- uses: PowerShell/PowerShell@v1` step.
- `cargo test windows_smoke` fails → ConPTY behavior diverges from expected; inspect captured output, adjust the test's `Get-Process`/`Write-Output` choice or timing.
- MSI build fails on `wix` → install WiX toolset: `dotnet tool install --global wix` or use `tauri-action`'s built-in handling (Tauri 2 bundles wix311 automatically; if not, add a `Install WiX` step).
- `rusqlite` link errors → confirm Task 8 step 3 (bundled feature) was applied.

- [ ] **Step 3: Download the MSI artifact and verify it opens**

```bash
gh run download --name covenant-windows-msi
```

Inspect the `.msi` file size (should be 8-40 MB). Forward to a Windows tester or VM for Task 13.

- [ ] **Step 4: Commit any CI fixes**

If the workflow needed adjustments:
```bash
git add .github/workflows/release-windows.yml
git commit -m "ci(windows): <specific fix>"
```

---

## Task 13: Manual QA on Windows 11

**Files:** none (manual test pass)

- [ ] **Step 1: Install the MSI on a clean Windows 11 VM**

Expected: installer completes; first launch downloads WebView2 if absent; Covenant opens.

- [ ] **Step 2: Install `pwsh` 7 if missing, source `osc133.ps1`**

```powershell
winget install Microsoft.PowerShell
notepad $PROFILE
# Add: . "$HOME\.covenant\osc133.ps1"  (path documented in install-windows.md)
```

Expected: a new Covenant tab shows pwsh prompt; typing `Get-Date` produces a block in the sidebar.

- [ ] **Step 3: Functional checklist (mark each)**

- [ ] Tabs open/close, groups drag-fold
- [ ] Sidebar hierarchy renders (no CSS regressions vs macOS)
- [ ] Agent panel responds; super-agent receives `BlockFinished` events
- [ ] AOM executes a decision, persists to `operator_decisions` SQLite table
- [ ] App restart restores tabs/groups
- [ ] `vim` / `nvim` enters alternate-screen and exits cleanly
- [ ] `git` interactive prompts (e.g. commit message editor) work
- [ ] Resize the window — terminal reflows

- [ ] **Step 4: File any regressions as issues, fix or defer**

For each failing item, decide: blocker (fix now) vs. follow-up (file issue, ship anyway). Update this plan with a Task 14+ if a blocker fix is needed.

---

## Task 14: Install / first-run docs

**Files:**
- Create: `docs/install-windows.md`
- Modify: `README.md` (link to install docs)

- [ ] **Step 1: Write the doc**

Create `docs/install-windows.md`:

```markdown
# Installing Covenant on Windows

> v0.3.0 — unsigned build. SmartScreen will warn on first launch; click "More info → Run anyway".

## Requirements

- Windows 10 (build 1809+) or Windows 11
- [PowerShell 7+](https://learn.microsoft.com/powershell/scripting/install/installing-powershell-on-windows) (`pwsh`)
- WebView2 Runtime — bundled installer fetches it automatically if missing

## Install

1. Download `Covenant_0.3.0_x64_en-US.msi` from the latest [GitHub Release](https://github.com/karluiz/karlTerminal/releases/latest).
2. Run the MSI. SmartScreen → "More info" → "Run anyway".
3. Launch Covenant from the Start menu.

## Enable shell integration (required for blocks)

Open a Covenant tab and run:

```powershell
mkdir $HOME\.covenant -Force
Copy-Item "$env:LOCALAPPDATA\Programs\Covenant\shell-integration\osc133.ps1" $HOME\.covenant\
Add-Content $PROFILE '. "$HOME\.covenant\osc133.ps1"'
. $PROFILE
```

Reload the tab. You should see commands appear as discrete blocks in the sidebar.

## Known limitations (v0.3.0)

- Build is **unsigned** — SmartScreen warning is expected
- Windows PowerShell 5.1, `cmd.exe`, and WSL not supported (use `pwsh`)
- No auto-updater — re-download to upgrade
```

- [ ] **Step 2: Link from README**

In `README.md`, add under installation:

```markdown
- macOS: download the `.dmg` from [Releases](...)
- Windows: see [docs/install-windows.md](docs/install-windows.md)
```

- [ ] **Step 3: Commit**

```bash
git add docs/install-windows.md README.md
git commit -m "docs: Windows install and first-run guide"
```

---

## Task 15: Tag and release v0.3.0

**Files:** none

- [ ] **Step 1: Merge branch to main**

```bash
git checkout main
git merge --no-ff <branch>
git push origin main
```

- [ ] **Step 2: Bump version**

Update `crates/app/tauri.conf.json` `"version"` → `"0.3.0"` and root `Cargo.toml` workspace version if used. Run `cargo build` to refresh `Cargo.lock`.

```bash
git add -A
git commit -m "chore(release): v0.3.0"
```

- [ ] **Step 3: Tag and push**

```bash
git tag v0.3.0
git push origin v0.3.0
```

This triggers both `release-macos.yml` (existing) and `release-windows.yml` (Task 11).

- [ ] **Step 4: Watch both workflows, confirm release has macOS dmg + Windows msi**

```bash
gh release view v0.3.0
```

Expected: two assets listed.

- [ ] **Step 5: Announce in release notes**

Edit the release on GitHub (or via `gh release edit v0.3.0 --notes-file ...`) with a summary highlighting Windows support and the unsigned-build caveat.

---

## Done Criteria

- `cargo test --workspace` green on Ubuntu, macOS, and Windows CI
- `release-windows.yml` produces an MSI on every tag push
- Manual QA checklist (Task 13) passes on a clean Windows 11 VM
- `v0.3.0` GitHub Release has both macOS and Windows artifacts
- `docs/install-windows.md` accurately describes the install path
