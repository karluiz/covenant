# Windows Release — Functional Parity with macOS (v0.3.0)

**Date:** 2026-05-10
**Status:** Approved design, pending implementation plan
**Target version:** v0.3.0

## Goal

Ship a Windows build of Covenant Terminal with full functional parity to macOS: tabs, super-agent, AOM, sidebar, persistence. PowerShell 7 (`pwsh`) as default shell. Distributed via GitHub Releases unsigned (code signing deferred to a separate milestone).

## Non-Goals

- Code signing / SmartScreen reputation (separate pre-launch milestone)
- WSL bash/zsh support (deferred to v0.4.0)
- Auto-updater on Windows (depends on signing)
- `cmd.exe` support (OSC 133 not reliable)
- Windows PowerShell 5.1 (only `pwsh` v7+)

## Work Items

### 1. PowerShell shell integration

**File:** `shell-integration/osc133.ps1`

Hook into the pwsh `prompt` function to emit:
- `ESC ] 133 ; A ST` — prompt start
- `ESC ] 133 ; B ST` — prompt end / command starts
- `ESC ] 133 ; C ST` — command output starts (via `PSReadLine` `OnViMode`/`PromptText` or wrapper)
- `ESC ] 133 ; D ; $LASTEXITCODE ST` — command finished
- `ESC ] 7 ; file://<host>/<path> ST` — cwd changed

Installer flow mirrors zsh/bash: detect `$PROFILE` (typically `$HOME\Documents\PowerShell\Microsoft.PowerShell_profile.ps1`), ask for explicit consent, append snippet.

**Tests:** Add fixtures in `crates/blocks` exercising pwsh output streams to verify parser handles them identically to zsh.

### 2. Shell detection on Windows

**Crate:** `crates/pty`

- Resolve order: `pwsh.exe` > `powershell.exe` (5.1, only if pwsh missing) > error
- Lookup via `where.exe` / `PATH`; never hardcode paths
- Extend `ShellKind` with `PowerShell { pwsh: bool }` variant
- `cmd.exe` explicitly unsupported (return error)

### 3. PTY adaptation for ConPTY

**Crate:** `crates/pty`

`portable-pty` already abstracts ConPTY; validate the following Windows-specific behaviors:

- **Resize:** ConPTY uses `ResizePseudoConsole` (no SIGWINCH). Confirm `PtyPair::resize()` calls land correctly.
- **Encoding:** Force UTF-8. Set `[Console]::OutputEncoding = [Text.UTF8Encoding]::new()` in the ps1 snippet, and/or run `chcp 65001` on spawn.
- **Line endings:** Pwsh emits CRLF. xterm.js handles this, but verify block parser does not double-count newlines.

**Smoke test (M0-equivalent for Windows):** spawn `pwsh.exe`, write `echo hello\n`, assert `"hello"` appears in output. This is the Windows gate — nothing else proceeds until this passes.

### 4. Backend platform audit

**Crates:** `crates/app`, `crates/session`, others as needed

- Audit any `#[cfg(unix)]` blocks for missing Windows counterparts
- Path handling: confirm all paths use `PathBuf`, no `/` literals in joins
- Home dir: keep `dirs::home_dir()` (already cross-platform)
- SQLite: ensure `rusqlite` has `bundled` feature enabled so no system sqlite dependency on Windows

### 5. Tauri Windows configuration

**File:** `crates/app/tauri.conf.json` (or platform-specific override)

- `bundle.targets`: add `"msi"` (consider `"nsis"` as secondary)
- `bundle.windows.webviewInstallMode`: `downloadBootstrapper` (handles Win10 machines without WebView2)
- Icon: generate `.ico` from existing macOS icon set
- Do **not** set `signingIdentity` or `certificateThumbprint` — builds ship unsigned

### 6. CI on GitHub Actions

**File:** `.github/workflows/release-windows.yml`

- Trigger: tag push matching `v*` (runs in parallel with existing macOS workflow)
- Runner: `windows-latest`
- Steps: checkout, setup-rust (stable), setup-node + bun, `cargo build --release`, `bun run tauri build`
- Artifacts: upload `.msi` to the GitHub Release via `gh release upload`
- Cache: `~/.cargo/registry`, `~/.cargo/git`, `target/`, `node_modules/`

### 7. Manual QA checklist (pre-release)

On a clean Windows 11 VM:

- [ ] `.msi` installs without admin elevation prompts beyond expected
- [ ] First launch spawns `pwsh`, OSC 133 markers detected, blocks render in sidebar
- [ ] Tabs, groups, drag-fold work
- [ ] Sidebar hierarchy renders correctly (CSS regressions check)
- [ ] Agent panel responds; super-agent receives events from the bus
- [ ] AOM executes a decision and persists to `operator_decisions` table
- [ ] App restart restores tabs/groups from SQLite
- [ ] TUI smoke test: `vim`, `htop`-equivalent (`btop` if available), git interactive prompts

## Risks & Unknowns

- **ConPTY TUI edge cases.** Vim, alternate-screen apps, and complex escape sequences may behave differently than on macOS. Mitigation: catch in step 3 smoke test and TUI QA; if a specific app breaks, file a follow-up, do not block the release.
- **WebView2 runtime missing on older Win10.** `downloadBootstrapper` mode adds an install step on first run; document this in release notes.
- **xterm-addon-webgl in WebView2.** Possible performance degradation vs WKWebView. Fallback: ship with canvas addon if webgl is visibly degraded.
- **PSReadLine interference.** PSReadLine may intercept rendering in ways that conflict with OSC 133 emission timing. Mitigation: test with PSReadLine enabled (default) and verify markers still emit.

## Milestones / Sequencing

1. Steps 2 + 3 (shell detection + ConPTY smoke test) — establishes the Windows beachhead
2. Step 1 (PowerShell integration) — unlocks block parsing
3. Step 4 (backend audit) — fix any breakages found
4. Step 5 (Tauri config) — produce a local `.msi`
5. Step 6 (CI) — automate
6. Step 7 (QA) — gate the v0.3.0 tag

## Out of Scope (Future Work)

- Code signing (OV or EV cert, SmartScreen reputation)
- Notarization equivalent
- Auto-updater
- WSL integration (`wsl.exe -d <distro>` spawn path)
- Windows PowerShell 5.1
- `cmd.exe`
