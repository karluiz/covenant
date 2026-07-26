# Worktree Prompt Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shell prompts inside `.covenant/worktrees/<slug>` show `repo ⌥slug` instead of the full ~60-char path, per shell (zsh/bash/pwsh), gated by a default-on Settings toggle.

**Architecture:** Extend the existing `shell-integration/osc133.*` snippets (already sourced after the user's rc in every Covenant tab) with native per-shell mechanisms: `zsh_directory_name` hook (zsh), conditional `PROMPT_DIRTRIM` (bash), display-string replace in the existing prompt wrapper (pwsh). A new `TerminalConfig.compact_worktree_prompt` bool (default true) exports `COVENANT_COMPACT_WORKTREE=1` at PTY spawn; snippets no-op without it.

**Tech Stack:** zsh dynamic named directories, bash PROMPT_DIRTRIM, PowerShell regex replace, Rust (serde settings + spawn env), TS settings panel.

**Spec:** `docs/superpowers/specs/2026-07-26-worktree-prompt-compaction-design.md`

## Global Constraints

- Display-only: never change `$PWD`, `cd` behavior, or completion.
- Never clobber user hooks: append to `zsh_directory_name_functions`; save/restore prior `PROMPT_DIRTRIM`; pwsh replace only on the rendered string.
- Gate everything on `COVENANT_COMPACT_WORKTREE` being non-empty; unset ⇒ byte-identical prompt behavior to today.
- Glyph is `⌥` (U+2325), matching the git-popover worktree glyph.
- English copy in UI chrome; toggle uses existing `.settings-field-row` chrome (no new CSS).
- Run `cargo test` from the repo root; `npm test` from repo root, NOT `ui/`.
- Commits: Conventional Commits, one commit per task.

---

### Task 1: Settings field + spawn env export (Rust)

**Files:**
- Modify: `crates/app/src/settings.rs` (TerminalConfig struct ~line 902, its `Default` impl ~line 926)
- Modify: `crates/app/src/lib.rs` (spawn_session env block, directly after the `COVENANT_CLAUDE_THEME` push at ~line 683)
- Test: `crates/app/src/settings.rs` `#[cfg(test)]` module (bottom of file)

**Interfaces:**
- Produces: `TerminalConfig.compact_worktree_prompt: bool` (serde name `compact_worktree_prompt`, default `true`) — Task 5's UI reads/writes this exact JSON key. Env var `COVENANT_COMPACT_WORKTREE=1` exported to every spawned PTY when true — Tasks 2–4's snippets check this exact name.

- [ ] **Step 1: Write the failing test**

In the existing `#[cfg(test)] mod tests` at the bottom of `crates/app/src/settings.rs` (create the module if the file has none — check first; other structs' tests may exist):

```rust
#[test]
fn terminal_compact_worktree_prompt_defaults_true() {
    // Field absent in stored JSON (all pre-feature configs) → true.
    let t: TerminalConfig = serde_json::from_str("{}").expect("parse");
    assert!(t.compact_worktree_prompt);
    assert!(TerminalConfig::default().compact_worktree_prompt);
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-app terminal_compact_worktree_prompt_defaults_true`
Expected: FAIL — `no field compact_worktree_prompt` (compile error). If the package name differs, get it from `crates/app/Cargo.toml` `[package] name`.

- [ ] **Step 3: Add the field**

In `TerminalConfig` (after `ligatures`):

```rust
    /// Collapse `.covenant/worktrees/<slug>` paths in the shell prompt
    /// to `repo ⌥slug` (zsh/bash/pwsh via the integration snippets).
    /// Display-only; exported as COVENANT_COMPACT_WORKTREE at spawn.
    #[serde(default = "default_true")]
    pub compact_worktree_prompt: bool,
```

`default_true` already exists in this file (used at lines ~395, ~582). Update `impl Default for TerminalConfig` to set `compact_worktree_prompt: true`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl-app terminal_compact_worktree_prompt_defaults_true`
Expected: PASS

- [ ] **Step 5: Export the env var at spawn**

In `crates/app/src/lib.rs`, `spawn_session`, immediately after the block that pushes `COVENANT_CLAUDE_THEME` (~line 684):

```rust
    // Worktree prompt compaction gate — the osc133 snippets collapse
    // `.covenant/worktrees/<slug>` prompt paths only when this is set.
    // Same lifetime semantics as the theme env: fixed per shell, new
    // tabs pick up a toggled setting.
    if state.settings.lock().await.terminal.compact_worktree_prompt {
        opts.env
            .push(("COVENANT_COMPACT_WORKTREE".to_string(), "1".to_string()));
    }
```

(`state.settings` is `Arc<tokio::sync::Mutex<Settings>>`; `spawn_session` is async — `.lock().await` matches existing usage at lib.rs:1043.)

- [ ] **Step 6: Verify workspace compiles and tests pass**

Run: `cargo test -p karl-app settings && cargo clippy -p karl-app --all-targets 2>&1 | tail -5`
Expected: tests PASS, no new clippy warnings.

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/settings.rs crates/app/src/lib.rs
git commit -m "feat(settings): compact_worktree_prompt toggle + COVENANT_COMPACT_WORKTREE spawn env"
```

---

### Task 2: zsh — `zsh_directory_name` hook + e2e tests

**Files:**
- Modify: `shell-integration/osc133.zsh` (append a new section before the theme-sync section)
- Test: Create `crates/blocks/tests/prompt_compaction.rs`

**Interfaces:**
- Consumes: env var `COVENANT_COMPACT_WORKTREE` (Task 1; tests set it directly on `SpawnOptions.env`, so this task does not depend on Task 1 being merged).
- Produces: prompt renders `~[<repo> ⌥<slug>]` for any PROMPT using `%~` when inside a worktree.

- [ ] **Step 1: Write the failing e2e tests**

Create `crates/blocks/tests/prompt_compaction.rs`. Follow the harness in `crates/blocks/tests/snippet_integration.rs` (same crate deps: `karl_pty::{PtySession, SpawnOptions}`, `tempfile`). The PROMPT must include `%~` (the stock tests use `PROMPT='$ '`, which never shows a path):

```rust
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

    let mut got = String::new();
    let deadline = tokio::time::Instant::now() + Duration::from_secs(8);
    while tokio::time::Instant::now() < deadline {
        match tokio::time::timeout(Duration::from_millis(200), rx.recv()).await {
            Ok(Some(bytes)) => {
                got.push_str(&String::from_utf8_lossy(&bytes));
                // Stop once the post-cd prompt with either form rendered.
                if got.contains('⌥') || got.matches("worktrees/agent-claude-x").count() >= 2 {
                    break;
                }
            }
            _ => {}
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
```

NOTE for implementer: if `PtySession::spawn`'s return channel type differs (peek at `snippet_integration.rs` lines 38–60 for the exact `rx.recv()` shape), adapt the drain loop to match that file — it is the source of truth for the harness.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl-blocks --test prompt_compaction`
Expected: `zsh_worktree_prompt_compacts_when_gated_on` FAILS (no `~[...]` in output); `zsh_worktree_prompt_full_when_gate_unset` PASSES already (it asserts current behavior — that's fine, it pins the gate).

- [ ] **Step 3: Implement the zsh hook**

In `shell-integration/osc133.zsh`, insert before the `zsh-autosuggestions` section:

```zsh
# ─── Worktree prompt compaction ───────────────────────────────────────
#
# Covenant spawns executors inside `<repo>/.covenant/worktrees/<slug>`,
# which turns every `%~` prompt into a ~60-char path. zsh's dynamic
# named directories collapse it: any prompt using `%~` renders
# `~[repo ⌥slug]` instead. Display-only — $PWD, completion and `cd`
# are untouched. Gated on COVENANT_COMPACT_WORKTREE (Settings →
# Terminal). We append to zsh_directory_name_functions, so a user's own
# zsh_directory_name / hooks keep working.
__karl_worktree_dirname() {
    emulate -L zsh
    setopt extendedglob
    [[ "$1" == d ]] || return 1  # only path→name; never invent names
    [[ -n "${COVENANT_COMPACT_WORKTREE:-}" ]] || return 1
    local mid="/.covenant/worktrees/"
    if [[ "$2" == (#b)(*)${mid}([^/]##)(|/*) ]]; then
        typeset -ga reply
        reply=(
            "${match[1]:t} ⌥${match[2]}"
            $(( ${#match[1]} + ${#mid} + ${#match[2]} ))
        )
        return 0
    fi
    return 1
}

typeset -ga zsh_directory_name_functions
if (( ! ${zsh_directory_name_functions[(I)__karl_worktree_dirname]} )); then
    zsh_directory_name_functions+=(__karl_worktree_dirname)
fi
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-blocks --test prompt_compaction`
Expected: both PASS. If the compact test still fails, debug interactively: `COVENANT_COMPACT_WORKTREE=1 ZDOTDIR=<tmp> zsh -i` and check `echo ${(D)PWD}` inside a fake worktree — it must print `~[repo ⌥slug]`.

- [ ] **Step 5: Confirm existing snippet tests still pass**

Run: `cargo test -p karl-blocks --test snippet_integration && cargo test -p karl-session 2>&1 | tail -3`
Expected: PASS (the new hook must not disturb OSC 133 emission). Use the actual package names from each crate's Cargo.toml if `-p` names differ.

- [ ] **Step 6: Commit**

```bash
git add shell-integration/osc133.zsh crates/blocks/tests/prompt_compaction.rs
git commit -m "feat(shell): compact worktree paths in zsh prompt via zsh_directory_name"
```

---

### Task 3: bash — conditional PROMPT_DIRTRIM + test

**Files:**
- Modify: `shell-integration/osc133.bash` (before the theme-sync section)
- Test: `crates/blocks/tests/prompt_compaction.rs` (append)

**Interfaces:**
- Consumes: `snippet_path()` helper from Task 2's test file; env var `COVENANT_COMPACT_WORKTREE`.
- Produces: `PROMPT_DIRTRIM=2` while `$PWD` is inside a worktree; user's prior value restored outside.

- [ ] **Step 1: Write the failing test**

Append to `crates/blocks/tests/prompt_compaction.rs`. No PTY needed — drive bash directly and eval the PROMPT_COMMAND chain:

```rust
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test -p karl-blocks --test prompt_compaction bash_`
Expected: `bash_dirtrim_set_inside_worktree_and_restored_outside` FAILS (`IN=7`); the gate-off test PASSES (pins current behavior).

- [ ] **Step 3: Implement**

In `shell-integration/osc133.bash`, insert before the theme-sync section:

```bash
# ── Worktree prompt compaction ───────────────────────────────────────
# Inside `<repo>/.covenant/worktrees/<slug>`, trim the `\w` prompt path
# to its last 2 components (`.../worktrees/<slug>`) via bash-native
# PROMPT_DIRTRIM; restore the user's prior value everywhere else.
# Display-only. Gated on COVENANT_COMPACT_WORKTREE (Settings → Terminal).
if [ -n "${COVENANT_COMPACT_WORKTREE:-}" ]; then
    _karl_prev_dirtrim="${PROMPT_DIRTRIM:-}"
    __karl_dirtrim() {
        case "$PWD" in
            */.covenant/worktrees/*) PROMPT_DIRTRIM=2 ;;
            *)
                if [ -n "$_karl_prev_dirtrim" ]; then
                    PROMPT_DIRTRIM="$_karl_prev_dirtrim"
                else
                    unset PROMPT_DIRTRIM
                fi
                ;;
        esac
    }
    case "$PROMPT_COMMAND" in
        *__karl_dirtrim*) ;;
        # APPEND, never prepend: __karl_precmd must stay first so its
        # `local exit=$?` sees the user command's status, not ours.
        *) PROMPT_COMMAND="${PROMPT_COMMAND:+$PROMPT_COMMAND; }__karl_dirtrim" ;;
    esac
fi
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cargo test -p karl-blocks --test prompt_compaction bash_`
Expected: both PASS.

- [ ] **Step 5: Commit**

```bash
git add shell-integration/osc133.bash crates/blocks/tests/prompt_compaction.rs
git commit -m "feat(shell): compact worktree paths in bash prompt via PROMPT_DIRTRIM"
```

---

### Task 4: PowerShell — rendered-string replace + test

**Files:**
- Modify: `shell-integration/osc133.ps1` (the `global:prompt` function, ~line 41, plus a new helper)
- Test: `crates/blocks/tests/prompt_compaction.rs` (append)

**Interfaces:**
- Consumes: `$env:COVENANT_COMPACT_WORKTREE`.
- Produces: `__Covenant-CompactPath([string])` global function; the prompt wrapper applies it to the inner prompt's rendered string.

- [ ] **Step 1: Write the failing test**

Append to `crates/blocks/tests/prompt_compaction.rs`. Skips when `pwsh` isn't installed (macOS CI may lack it; real e2e belongs to the M8 Windows pipeline):

```rust
/// pwsh: dot-source the snippet and unit-test the pure string function.
/// Skipped when pwsh is not installed.
#[test]
fn pwsh_compact_path_collapses_worktree_segment() {
    if std::process::Command::new("pwsh")
        .arg("-Version")
        .output()
        .is_err()
    {
        eprintln!("pwsh not installed; skipping");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test -p karl-blocks --test prompt_compaction pwsh_`
Expected: FAIL — `__Covenant-CompactPath` not recognized (or skip note if pwsh missing; if skipped locally, still implement Step 3 — the function is trivially inspectable and the test runs where pwsh exists).

- [ ] **Step 3: Implement**

In `shell-integration/osc133.ps1`:

3a. Wrap the PSReadLine key-handler registration (lines ~47–58) in `try { ... } catch {}` so dot-sourcing the snippet from a `-NonInteractive` test shell can't blow up. Keep the existing `if (Get-Module -ListAvailable PSReadLine)` guard.

3b. Add the helper after `__Covenant-EmitOsc7`:

```powershell
# Worktree prompt compaction: collapse `<repo>/.covenant/worktrees/<slug>`
# in the RENDERED prompt string to `repo ⌥slug`. Display-only; covers the
# default prompt and any string-returning framework (oh-my-posh, starship).
# Prompts that Write-Host directly bypass this — acceptable no-op. Gated
# on COVENANT_COMPACT_WORKTREE (Settings → Terminal).
function global:__Covenant-CompactPath([string]$s) {
    if (-not $env:COVENANT_COMPACT_WORKTREE) { return $s }
    return $s -replace '([^\\/\s]+)[\\/]\.covenant[\\/]worktrees[\\/]([^\\/>\s]+)', '$1 ⌥$2'
}
```

3c. In `global:prompt`, apply it to the inner result — replace:

```powershell
    $rendered = & $Global:_CovenantPrevPrompt
```

with:

```powershell
    $rendered = __Covenant-CompactPath (& $Global:_CovenantPrevPrompt)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cargo test -p karl-blocks --test prompt_compaction pwsh_`
Expected: PASS (or clean skip without pwsh; if skipped, verify manually once: `pwsh -NoProfile -Command '. ./shell-integration/osc133.ps1; __Covenant-CompactPath "PS /a/.covenant/worktrees/b> "'` with the env var set).

- [ ] **Step 5: Commit**

```bash
git add shell-integration/osc133.ps1 crates/blocks/tests/prompt_compaction.rs
git commit -m "feat(shell): compact worktree paths in pwsh prompt via rendered-string replace"
```

---

### Task 5: Settings UI toggle

**Files:**
- Modify: `ui/src/settings/panel.ts` — local `TerminalConfig`-shaped interface (~line 88 area, field `ligatures: boolean;`), defaults object (~line 368), form HTML (after the Font ligatures field, ~line 1104), input query (~line 1423), load (~line 1601), save (~line 2374)
- Modify: `ui/src/api.ts` — settings type with `ligatures: boolean;` (~line 1189)

**Interfaces:**
- Consumes: JSON key `compact_worktree_prompt` on the `terminal` settings object (Task 1). Backend serde default fills it for old configs, but the UI save path must always send it.
- Produces: checkbox `input[name="term_compact_worktree"]` in Settings → Terminal.

- [ ] **Step 1: Add the field to both TS types**

In `ui/src/api.ts` and the matching interface in `ui/src/settings/panel.ts`, after `ligatures: boolean;`:

```ts
  compact_worktree_prompt: boolean;
```

- [ ] **Step 2: Wire defaults, HTML, load, save**

Defaults object (panel.ts ~line 368), after `ligatures: false,`:

```ts
          compact_worktree_prompt: true,
```

Form HTML, after the Font ligatures `</label>` (~line 1104), same chrome as its neighbor:

```html
          <label class="settings-field settings-field-row">
            <input type="checkbox" name="term_compact_worktree" />
            <span class="settings-label">Compact worktree paths in prompt</span>
            <small class="settings-hint">
              Show <code>repo ⌥slug</code> instead of the full
              <code>.covenant/worktrees/…</code> path (zsh, bash, PowerShell).
              Applies to new tabs.
            </small>
          </label>
```

Query block (~line 1423), next to `termLigatures`:

```ts
    const termCompactWorktree = form.querySelector<HTMLInputElement>(
      'input[name="term_compact_worktree"]',
    )!;
```

Load (~line 1601), next to the ligatures line — note `?? true` so a config saved by an older build reads as on:

```ts
    termCompactWorktree.checked =
      this.current.terminal.compact_worktree_prompt ?? true;
```

Save (~line 2374), inside the `terminal: {` object after `ligatures:`:

```ts
          compact_worktree_prompt: termCompactWorktree.checked,
```

- [ ] **Step 3: Type-check and test**

Run: `npm run build && npm test`
Expected: clean type-check; existing vitest suites green. (Run from repo root, not `ui/`.)

- [ ] **Step 4: Verify in the app**

Run: `npm run tauri:dev`, open Settings → Terminal — the toggle renders checked by default. Open a new terminal tab, `echo $COVENANT_COMPACT_WORKTREE` prints `1`; `cd` into any `.covenant/worktrees/<slug>` dir and the prompt shows `~[repo ⌥slug]`. Untick the toggle, open another new tab — env var empty, full path back. (Dev build is a separate app instance and may start unconfigured; that's expected.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/panel.ts ui/src/api.ts
git commit -m "feat(ui): Settings toggle for worktree prompt compaction"
```
