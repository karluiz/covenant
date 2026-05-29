# Teammate "Executive Read" of the Active Tab — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a teammate operator answer "what am I doing on this tab?" with a synthesized executive read grounded in the tab's live rendered screen, instead of restating the foreground command + elapsed seconds.

**Architecture:** The session pump already runs a headless `vt100::Parser`. We (1) fix it so it tracks the live PTY size (today it is clamped to 24×80), (2) publish its rendered screen into a shared cell on `Session`, (3) expose that cell to the teammate tool layer as a new `read_terminal_screen` tool wired into both the Anthropic and OpenAI dispatch loops, and (4) reframe the system prompt to give an executive read and call the tool for interactive-agent tabs.

**Tech Stack:** Rust (tokio, vt100, serde_json), `karl_session` crate + `karl-app` crate (`crates/app`). Spec: `docs/superpowers/specs/2026-05-29-teammate-tab-executive-read-design.md`.

---

## File Structure

- `crates/session/src/lib.rs` — add dims helpers, screen-tidy helper, screen cell + dims atomic on `Session`, resize-sync + capture in `pump`. (MODIFY)
- `crates/app/src/teammate/tools.rs` — add `ToolEnv.active_screen`, `read_terminal_screen_tool_def()`, `read_terminal_screen()`. (MODIFY)
- `crates/app/src/teammate/llm.rs` — register the tool in both `dispatch_reply_with_tools` (Anthropic) and `dispatch_reply_with_tools_openai`; add executive-read prompt framing + tool bullet. (MODIFY)
- `crates/app/src/teammate/commands.rs` — collect the active session's screen handle and pass it into `ToolEnv`. (MODIFY)

---

## Task 1: Dims pack/unpack + screen-tidy helpers (session crate, pure)

**Files:**
- Modify: `crates/session/src/lib.rs` (add helpers near `now_ms`, ~L598)
- Test: same file, `#[cfg(test)] mod tests`

- [ ] **Step 1: Write failing tests**

Add to the `tests` module in `crates/session/src/lib.rs`:

```rust
#[test]
fn dims_roundtrip() {
    let packed = super::pack_dims(120, 40);
    assert_eq!(super::unpack_dims(packed), (120, 40));
    let packed2 = super::pack_dims(80, 24);
    assert_eq!(super::unpack_dims(packed2), (80, 24));
}

#[test]
fn tidy_screen_trims_trailing_blank_lines_and_padding() {
    let raw = "hello   \nworld\n\n\n   \n";
    assert_eq!(super::tidy_screen(raw), "hello\nworld");
}

#[test]
fn tidy_screen_empty_when_all_blank() {
    assert_eq!(super::tidy_screen("   \n\n  \n"), "");
}
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cargo test -p karl-session dims_roundtrip tidy_screen`
Expected: FAIL — `pack_dims`, `unpack_dims`, `tidy_screen` not found.

- [ ] **Step 3: Implement the helpers**

Add to `crates/session/src/lib.rs` (module level, e.g. just below `fn now_ms`):

```rust
/// Pack (cols, rows) into a single u32 for lock-free sharing with the
/// pump task. cols in the high 16 bits, rows in the low 16.
fn pack_dims(cols: u16, rows: u16) -> u32 {
    ((cols as u32) << 16) | (rows as u32)
}

/// Inverse of [`pack_dims`]; returns (cols, rows).
fn unpack_dims(packed: u32) -> (u16, u16) {
    (((packed >> 16) & 0xffff) as u16, (packed & 0xffff) as u16)
}

/// Tidy a raw vt100 `screen().contents()` dump for LLM consumption:
/// strip trailing whitespace on each line, then drop leading/trailing
/// blank lines. The rendered grid is already plain text (no escapes),
/// so no ANSI stripping is needed here.
fn tidy_screen(raw: &str) -> String {
    let lines: Vec<&str> = raw.lines().map(|l| l.trim_end()).collect();
    let start = lines.iter().position(|l| !l.is_empty());
    let end = lines.iter().rposition(|l| !l.is_empty());
    match (start, end) {
        (Some(s), Some(e)) => lines[s..=e].join("\n"),
        _ => String::new(),
    }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cargo test -p karl-session dims_roundtrip tidy_screen`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add crates/session/src/lib.rs
git commit -m "feat(session): dims pack/unpack + screen-tidy helpers for headless capture"
```

---

## Task 2: Capture the live rendered screen + track PTY size in the pump

**Files:**
- Modify: `crates/session/src/lib.rs` — `Session` struct (~L397), `Session::spawn` (~L407), `Session::resize` (~L453), add `Session::screen_handle`, `pump` signature + tick body (~L467, L562).
- Test: same file, `tests` module (e2e capture).

- [ ] **Step 1: Add the screen cell + dims atomic to `Session` and plumb into `pump`**

In `crates/session/src/lib.rs`, add imports near the top (if not present):

```rust
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex as StdMutex;
```

Extend the `Session` struct (~L397):

```rust
pub struct Session {
    pub id: SessionId,
    pub started_at: Instant,
    pty: PtySession,
    events_tx: broadcast::Sender<SessionEvent>,
    /// Latest tidied headless screen render, refreshed by the pump once
    /// per tick. Read on demand by the teammate `read_terminal_screen`
    /// tool so an operator can see inside an interactive-agent tab.
    screen: Arc<StdMutex<String>>,
    /// Live PTY dimensions (cols<<16|rows), written by `resize`, read by
    /// the pump so the headless vt100 grid matches the real terminal.
    dims: Arc<AtomicU32>,
}
```

In `Session::spawn` (~L407), before the `tokio::spawn(pump(...))` line:

```rust
        let screen = Arc::new(StdMutex::new(String::new()));
        let dims = Arc::new(AtomicU32::new(pack_dims(80, 24)));
        let pump_screen = screen.clone();
        let pump_dims = dims.clone();
```

Change the spawn call to pass them:

```rust
        tokio::spawn(pump(
            id, pty_rx, raw_tx, pump_events_tx, master_fd, pump_screen, pump_dims,
        ));
```

Add the two fields to the returned `Self { ... }`:

```rust
            Self {
                id,
                started_at: Instant::now(),
                pty,
                events_tx,
                screen,
                dims,
            },
```

Update `Session::resize` (~L453) to record the new size for the pump:

```rust
    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), SessionError> {
        self.dims.store(pack_dims(cols, rows), Ordering::Relaxed);
        self.pty.resize(cols, rows).map_err(Into::into)
    }
```

Add a handle accessor (after `resize` or near `subscribe`):

```rust
    /// Shared handle to the latest tidied headless screen render. The
    /// app layer clones this into the teammate tool sandbox.
    pub fn screen_handle(&self) -> Arc<StdMutex<String>> {
        self.screen.clone()
    }

    /// Snapshot of the current rendered screen (for tests / callers that
    /// want the value, not the handle).
    pub fn screen_snapshot(&self) -> String {
        self.screen.lock().map(|g| g.clone()).unwrap_or_default()
    }
```

Update the `pump` signature (~L467):

```rust
async fn pump(
    id: SessionId,
    mut pty_rx: mpsc::UnboundedReceiver<Bytes>,
    raw_tx: mpsc::UnboundedSender<Bytes>,
    events_tx: broadcast::Sender<SessionEvent>,
    #[cfg(unix)] master_fd: std::os::fd::RawFd,
    #[cfg(not(unix))] _master_fd: (),
    screen: Arc<StdMutex<String>>,
    dims: Arc<AtomicU32>,
) {
```

In the `_ = tick.tick()` branch (~L562), at the very top of the branch body (before the `#[cfg(unix)]` block), sync the headless size and capture the screen once per tick:

```rust
            _ = tick.tick() => {
                // Keep the headless vt100 grid the same size as the real
                // PTY so the captured screen isn't clipped to 24×80.
                let (cols, rows) = unpack_dims(dims.load(Ordering::Relaxed));
                if vt.screen().size() != (rows, cols) {
                    vt.set_size(rows, cols);
                }
                // Capture the rendered screen for on-demand teammate reads.
                let screen_text = vt.screen().contents();
                if let Ok(mut g) = screen.lock() {
                    *g = tidy_screen(&screen_text);
                }
```

Then keep the existing `#[cfg(unix)]` block. Inside it, the existing idle path recomputes `vt.screen().contents()` at ~L579 — **replace** that line so it reuses the value we already rendered:

Existing:
```rust
                            let screen_text = vt.screen().contents();
                            if let Decision::Idle { agent, prompt_text, quiet_ms } =
                                detector.evaluate(Instant::now(), Some(name), alt, &screen_text)
```
Replace with (use the already-captured render; note it's now tidied, which the idle detector tolerates since it matches on substrings):
```rust
                            if let Decision::Idle { agent, prompt_text, quiet_ms } =
                                detector.evaluate(Instant::now(), Some(name), alt, &screen_text)
```

(The outer `let screen_text` from the new code is in scope for the whole tick branch, so the inner shadowing line is simply deleted.)

- [ ] **Step 2: Build to confirm it compiles**

Run: `cargo build -p karl-session`
Expected: compiles clean (no warnings about unused `screen`/`dims`).

- [ ] **Step 3: Write the e2e capture test**

Add to the `tests` module in `crates/session/src/lib.rs`. This mirrors the existing real-zsh e2e style:

```rust
#[tokio::test]
async fn pump_captures_rendered_screen() {
    use karl_pty::SpawnOptions;
    let (mut session, _streams) = Session::spawn(SpawnOptions::default())
        .expect("spawn session");
    session.resize(100, 30).expect("resize");
    // Emit a unique marker, then wait past one 1s tick so the pump
    // renders + stores the screen.
    session
        .write(b"printf 'CAPTURE_MARKER_42\\n'\n")
        .expect("write");
    tokio::time::sleep(Duration::from_millis(1400)).await;
    let screen = session.screen_snapshot();
    assert!(
        screen.contains("CAPTURE_MARKER_42"),
        "screen snapshot did not contain marker; got:\n{screen}"
    );
}
```

- [ ] **Step 4: Run the test, verify pass**

Run: `cargo test -p karl-session pump_captures_rendered_screen -- --nocapture`
Expected: PASS. (If the host shell is slow, the 1400ms sleep covers one tick + echo.)

- [ ] **Step 5: Run the full session crate test suite (no regressions)**

Run: `cargo test -p karl-session`
Expected: all PASS, including the existing `detects_alternate_screen_toggle` and the real-zsh block tests.

- [ ] **Step 6: Commit**

```bash
git add crates/session/src/lib.rs
git commit -m "feat(session): track PTY size + publish rendered screen from pump"
```

---

## Task 3: `read_terminal_screen` tool — def, executor, ToolEnv field

**Files:**
- Modify: `crates/app/src/teammate/tools.rs` — `ToolEnv` (~L37), add def + executor.
- Test: `crates/app/src/teammate/tools.rs` `tests` module.

- [ ] **Step 1: Extend `ToolEnv` with the active-tab screen handle**

In `crates/app/src/teammate/tools.rs`, update the struct + constructor (~L36):

```rust
/// Sandbox + budget for tool calls inside a single DM dispatch.
#[derive(Debug, Clone)]
pub struct ToolEnv {
    /// Absolute, canonicalized path. All file reads must resolve under it.
    pub root: PathBuf,
    /// Hard cap per file. Anything bigger errors before the file is read.
    pub max_bytes_per_file: usize,
    /// Live rendered screen of the active tab, if one is known. Read by
    /// `read_terminal_screen`. `None` when there's no active tab.
    pub active_screen: Option<std::sync::Arc<std::sync::Mutex<String>>>,
}

impl ToolEnv {
    pub fn new(root: PathBuf, max_bytes_per_file: usize) -> Self {
        Self { root, max_bytes_per_file, active_screen: None }
    }

    /// Attach the active tab's rendered-screen handle (builder style).
    pub fn with_screen(
        mut self,
        screen: Option<std::sync::Arc<std::sync::Mutex<String>>>,
    ) -> Self {
        self.active_screen = screen;
        self
    }
}
```

- [ ] **Step 2: Write the failing executor test**

Add to the `tests` module in `crates/app/src/teammate/tools.rs`:

```rust
#[test]
fn read_terminal_screen_returns_active_screen() {
    use std::sync::{Arc, Mutex};
    let screen = Arc::new(Mutex::new("$ cargo test\nrunning 3 tests".to_string()));
    let env = ToolEnv::new(std::path::PathBuf::from("/tmp"), 1024)
        .with_screen(Some(screen));
    let out = read_terminal_screen(&env, &serde_json::json!({})).expect("ok");
    assert!(out.contains("cargo test"));
    assert!(out.contains("running 3 tests"));
}

#[test]
fn read_terminal_screen_handles_no_active_tab() {
    let env = ToolEnv::new(std::path::PathBuf::from("/tmp"), 1024);
    let out = read_terminal_screen(&env, &serde_json::json!({})).expect("ok");
    assert!(out.to_lowercase().contains("no active terminal"));
}

#[test]
fn read_terminal_screen_handles_empty_capture() {
    use std::sync::{Arc, Mutex};
    let env = ToolEnv::new(std::path::PathBuf::from("/tmp"), 1024)
        .with_screen(Some(Arc::new(Mutex::new(String::new()))));
    let out = read_terminal_screen(&env, &serde_json::json!({})).expect("ok");
    assert!(out.to_lowercase().contains("no screen captured"));
}
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `cargo test -p karl-app read_terminal_screen`
Expected: FAIL — `read_terminal_screen` not found.

- [ ] **Step 4: Implement the def + executor**

Add to `crates/app/src/teammate/tools.rs` (near the other `*_tool_def` fns):

```rust
pub fn read_terminal_screen_tool_def() -> Value {
    serde_json::json!({
        "name": "read_terminal_screen",
        "description": "Read the CURRENT rendered screen of the user's active \
                        terminal tab. Use this to see what an interactive \
                        program (like a `claude`, `codex`, or `pi` agent, a \
                        REPL, a TUI, or a long-running process) is showing \
                        right now — these never finish as 'blocks', so their \
                        state is invisible unless you read the screen. Call \
                        this when the user asks what's happening on their tab \
                        and the foreground command is interactive. Returns \
                        plain text (no path argument; always the active tab).",
        "input_schema": {
            "type": "object",
            "additionalProperties": false,
            "properties": {}
        }
    })
}

/// Return the active tab's current rendered screen. Plain text already
/// (the vt100 grid carries no escape sequences). No args.
pub fn read_terminal_screen(env: &ToolEnv, _args: &Value) -> Result<String, ToolError> {
    match &env.active_screen {
        None => Ok("(no active terminal tab to read)".to_string()),
        Some(cell) => {
            let text = cell
                .lock()
                .map(|g| g.clone())
                .map_err(|_| ToolError::Io("screen lock poisoned".into()))?;
            if text.trim().is_empty() {
                Ok("(no screen captured for the active tab yet)".to_string())
            } else {
                Ok(text)
            }
        }
    }
}
```

- [ ] **Step 5: Run tests, verify pass**

Run: `cargo test -p karl-app read_terminal_screen`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/teammate/tools.rs
git commit -m "feat(teammate): read_terminal_screen tool + ToolEnv screen handle"
```

---

## Task 4: Wire the tool into both dispatch loops

**Files:**
- Modify: `crates/app/src/teammate/llm.rs` — Anthropic loop (tools vec ~L435, match ~L482); OpenAI loop (tools_oa ~L647, match ~L704).

- [ ] **Step 1: Register the def in the Anthropic tools vec (~L435)**

In `dispatch_reply_with_tools`, add the new def to the `tools` vec:

```rust
    let tools = vec![
        tools::read_file_tool_def(),
        tools::list_directory_tool_def(),
        tools::search_files_tool_def(),
        tools::git_status_tool_def(),
        tools::git_diff_tool_def(),
        tools::run_command_tool_def(),
        tools::read_terminal_screen_tool_def(),
        tools::propose_task_tool_def(),
    ];
```

- [ ] **Step 2: Add the Anthropic match arm (~L503, after `run_command`)**

```rust
                    "read_terminal_screen" => match tools::read_terminal_screen(&tool_env, &input) {
                        Ok(text) => (text, true, None),
                        Err(e) => (format!("error: {}", e), false, Some(e.to_string())),
                    },
```

- [ ] **Step 3: Register the def in the OpenAI tools_oa array (~L647)**

In `dispatch_reply_with_tools_openai`:

```rust
    let tools_oa: Vec<serde_json::Value> = [
        tools::read_file_tool_def(),
        tools::list_directory_tool_def(),
        tools::search_files_tool_def(),
        tools::git_status_tool_def(),
        tools::git_diff_tool_def(),
        tools::run_command_tool_def(),
        tools::read_terminal_screen_tool_def(),
        tools::propose_task_tool_def(),
    ]
    .iter()
    .map(openai_http::convert_tool_def)
    .collect();
```

- [ ] **Step 4: Add the OpenAI match arm (~L724, after `run_command`)**

```rust
                    "read_terminal_screen" => match tools::read_terminal_screen(&tool_env, &input) {
                        Ok(text) => (text, true, None),
                        Err(e) => (format!("error: {}", e), false, Some(e.to_string())),
                    },
```

- [ ] **Step 5: Build, verify it compiles**

Run: `cargo build -p karl-app`
Expected: compiles clean.

- [ ] **Step 6: Confirm the existing tool-def shape test still covers the new tool**

Run: `cargo test -p karl-app -- teammate::llm`
Expected: PASS. (The existing `system_prompt`/tool tests at llm.rs ~L1064 should be unaffected.)

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/teammate/llm.rs
git commit -m "feat(teammate): wire read_terminal_screen into both dispatch loops"
```

---

## Task 5: Pass the active tab's screen handle into ToolEnv

**Files:**
- Modify: `crates/app/src/teammate/commands.rs` — session snapshot collection (~L62) and `ToolEnv` construction (~L128).

- [ ] **Step 1: Collect screen handles alongside world arcs (~L60-65)**

Replace the `session_worlds` collection block:

```rust
    // 2) Snapshot the open sessions' world arcs + screen handles while we
    //    hold the sessions lock, then drop it before locking worlds.
    type WorldArc = std::sync::Arc<tokio::sync::Mutex<crate::world::SessionWorldModel>>;
    type ScreenArc = std::sync::Arc<std::sync::Mutex<String>>;
    let session_data: Vec<(karl_session::SessionId, WorldArc, ScreenArc)> = {
        let g = state.sessions.lock().await;
        g.iter()
            .map(|(id, m)| (*id, m.world.clone(), m.session.screen_handle()))
            .collect()
    };
```

- [ ] **Step 2: Update the snapshot-building loop (~L92-99) to use `session_data`**

```rust
        // Build snapshot per session under each world's own lock.
        let mut snapshots = Vec::with_capacity(session_data.len());
        for (sid, world_arc, _screen) in &session_data {
            let w = world_arc.lock().await;
            let is_active = Some(*sid) == active_session_id_parsed;
            snapshots.push(crate::teammate::world_snapshot::project(
                *sid, &*w, is_active, now_ms(),
            ));
        }
```

- [ ] **Step 3: Resolve the active screen handle and attach to ToolEnv (~L127-128)**

In the `if let Some(root) = active_cwd {` arm, replace the `tool_env` line:

```rust
            let active_screen: Option<std::sync::Arc<std::sync::Mutex<String>>> =
                active_session_id_parsed.and_then(|aid| {
                    session_data
                        .iter()
                        .find(|(id, _, _)| *id == aid)
                        .map(|(_, _, screen)| screen.clone())
                });
            let tool_env = crate::teammate::tools::ToolEnv::new(root, 200 * 1024)
                .with_screen(active_screen);
```

- [ ] **Step 4: Build, verify it compiles**

Run: `cargo build -p karl-app`
Expected: compiles clean (watch for any other reference to the old `session_worlds` name — there should be none after Steps 1-2).

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/teammate/commands.rs
git commit -m "feat(teammate): pass active tab screen handle into tool sandbox"
```

---

## Task 6: Executive-read prompt framing

**Files:**
- Modify: `crates/app/src/teammate/llm.rs` — `build_system_prompt` (~L172 tool list, and add a new guidance block).

- [ ] **Step 1: Add the tool bullet to the system prompt tool list (~L188, after the `run_command` bullet)**

Insert into the `header` string, after the `run_command` bullet and before `propose_task`:

```rust
         - `read_terminal_screen` — read the active tab's current rendered \
           screen. Use this when the user asks what's happening on a tab and \
           the foreground command is an interactive agent (claude/codex/pi), \
           a REPL, or a TUI — those never finish as blocks, so the screen is \
           the only way to see their state.\n\
```

- [ ] **Step 2: Add an executive-read guidance block**

Insert a new section into `header` immediately before the `# Bias to action (YOLO mode)` block (~L201):

```rust
         # Answering \"what am I doing / what's going on\" on a tab\n\
         \n\
         When the user asks what they're doing on a tab, or what's happening \
         there, give an EXECUTIVE READ — do not transcribe the command line \
         or recite elapsed seconds as the whole answer. Infer: the kind of \
         work in progress, the current state, anything notable or blocked, \
         and a suggested next step. If the active tab's foreground command is \
         an interactive agent (claude/codex/pi), a REPL, or a TUI — i.e. it \
         has no recent finished blocks — call `read_terminal_screen` FIRST, \
         then synthesize from what's on screen. Keep it to a couple of \
         sentences; the panel is narrow.\n\
         \n\
```

- [ ] **Step 3: Build + run the prompt tests**

Run: `cargo test -p karl-app -- teammate::llm`
Expected: PASS. The existing assertion at ~L1064 (`p.contains("read_file")`) still holds; the prompt is larger but unchanged in shape.

- [ ] **Step 4: Commit**

```bash
git add crates/app/src/teammate/llm.rs
git commit -m "feat(teammate): executive-read framing + read_terminal_screen guidance"
```

---

## Task 7: Full verification

- [ ] **Step 1: Workspace build**

Run: `cargo build`
Expected: clean.

- [ ] **Step 2: Full test suite**

Run: `cargo test`
Expected: all PASS.

- [ ] **Step 3: Clippy (no new warnings)**

Run: `cargo clippy --all-targets -- -D warnings`
Expected: clean.

- [ ] **Step 4: Manual verify (the original repro)**

1. `npm run tauri:dev` (or the `respawn` skill).
2. Open a tab, run a long-lived interactive agent (e.g. `claude`), let it sit at a prompt.
3. In the teammate panel, ask the active-tab operator: **"what am I doing on this tab?"**
4. Expect: the operator calls `read_terminal_screen` (a tool-call chip appears) and replies with a synthesized read of the on-screen state + a suggested next step — NOT "you're running `claude …`, 12379 seconds, no recent interaction."

- [ ] **Step 5: Mark plan complete / finish the branch**

Use `superpowers:finishing-a-development-branch` to decide merge/PR.

---

## Self-Review

- **Spec coverage:** Component 1 (live screen capture + resize) → Tasks 1-2. Component 2 (`read_terminal_screen` tool, both dispatch paths, ToolEnv plumbing) → Tasks 3-5. Component 3 (executive-read framing) → Task 6. Resize prerequisite → Task 2. Visible-screen-only / on-demand-only → honored (no scrollback, tool not auto-injected). ✓
- **Placeholders:** none — every code step is concrete.
- **Type consistency:** `screen_handle() -> Arc<std::sync::Mutex<String>>` (Task 2) matches `ToolEnv.active_screen: Option<Arc<std::sync::Mutex<String>>>` (Task 3) and the resolution in commands.rs (Task 5). `pack_dims`/`unpack_dims`/`tidy_screen` defined in Task 1, used in Task 2. Tool name string `"read_terminal_screen"` consistent across def, both match arms, and prompt. ✓
- **Risk note:** `vt.screen().size()` returns `(rows, cols)`; compared against `(rows, cols)` from `unpack_dims` (which returns `(cols, rows)`) — the comparison in Task 2 Step 1 deliberately reorders to `(rows, cols)`. Implementer must keep that ordering. Flagged inline.
```
