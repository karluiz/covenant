# Teammate "Executive Read" of the Active Tab

**Date:** 2026-05-29
**Status:** Approved design → planning
**Branch:** `feat/teammate-screen-read`

## Problem

Asking a teammate operator (e.g. Mibli) "what am I doing on this tab?" returns a
literal restatement of the foreground process:

> You're running the command `claude --dangerously-skip-permissions` in the
> `/Users/.../groowcity` directory. It's been running for 12379 seconds with no
> recent interaction.

The answer is LLM-generated but **the model is starved of signal**. For the
active tab, `world_snapshot::render()` (`crates/app/src/teammate/world_snapshot.rs`)
feeds the operator only: `cwd`, the rolling summary, the last finished blocks,
and the in-flight command + elapsed.

When the foreground command is an **interactive agent** (`claude`, `codex`,
`pi`, …) it never emits a finished OSC-133 block, so:

- `last_blocks` is empty (nothing finishes),
- `summary` is `None` (`summarizer.rs` only runs on `BlockFinished`),
- `in_flight` carries just the command string + elapsed seconds.

The operator therefore has nothing but *cwd + command + elapsed*, and the system
prompt reinforces transcription ("describe it by what it's doing — the running
command, the cwd, or the rolling summary"). Nested interactive agents are a
complete blind spot: everything happening *inside* the tab is invisible.

## Goal

When the user asks what's happening on a tab, the operator gives an **executive
read** — infers the *kind* of work, the current state, what's notable or blocked,
and a suggested next step — grounded in what is actually on the tab's screen, not
a transcription of the foreground process.

Target answer for the same scenario:

> Claude Code session in `groowcity`, mid-task — last visible action was editing
> `src/foo.rs`, now sitting at a prompt waiting on you. Idle ~3.4h. Want me to
> nudge it or take over?

## Design

Three components. Scope chosen with the user: **on-demand tool + prompt framing**
(not always-inject), and **visible-screen-only** (no extra scrollback history).

### 1. Live screen capture (session crate → app)

The session pump already maintains a per-session headless `vt100::Parser`
(`crates/session/src/lib.rs` ~L482) and reads `vt.screen().contents()` for idle
detection. This rendered grid is the **only clean source** for a TUI: raw
scrollback stripped of ANSI is garbage because cursor-addressed redraws collapse
into duplicated fragments, whereas the vt100 render resolves them into a final
2-D text screen.

- Expose the latest rendered screen text per session to the app layer via a
  shared snapshot (e.g. `Arc<Mutex<String>>` or a per-session cell in the
  session registry), updated on the **existing idle-check tick** — no new parser,
  no new read loop, no per-keystroke cost.
- Store the already-stripped `screen().contents()` (vt100 output is plain text;
  re-strip defensively per CLAUDE.md rule #5 before it can reach the LLM).

**Confirmed prerequisite — plumb resize into the pump.** The parser is
constructed `vt100::Parser::new(24, 80, 0)` as a local in the `pump` task
(`lib.rs:482`). `Session::resize()` (`lib.rs:453`) only calls `self.pty.resize`
— it never touches the `vt` parser, which is unreachable from the handle. The
headless screen is therefore **permanently clamped to 24×80** regardless of the
real terminal size, so today's `screen().contents()` is clipped. Required fix:
carry the live PTY dimensions into the pump (e.g. a shared `Arc<AtomicU…>` or a
small resize channel) and call `vt.set_size(rows, cols)` on change, so the
rendered grid matches what the user actually sees. Without this the capture is
unusable for the feature.

### 2. `read_terminal_screen` tool

A new entry in the teammate tool set: `read_terminal_screen_tool_def()` +
executor in `crates/app/src/teammate/tools.rs`, wired into the tool loops in
`crates/app/src/teammate/llm.rs`.

- **Both dispatch paths.** Mibli (the operator in the repro) runs on `gpt-4o`,
  i.e. `dispatch_reply_with_tools_openai`. The tool must be registered in the
  `tools` vec **and** the `match name.as_str()` dispatch of *both*
  `dispatch_reply_with_tools` (Anthropic, L435/L482) and
  `dispatch_reply_with_tools_openai` (L647/L704). Wiring only the Anthropic path
  would leave the live operator unable to call it.
- **Input:** optional session target; defaults to the **active tab**.
- **`ToolEnv` plumbing.** The executor resolves the target session's screen via
  the live capture from Component 1. `ToolEnv` (or the active-session handle it
  already carries) must expose a way to read the latest screen snapshot for the
  active tab.
- **Output:** the current rendered screen text for that tab (visible screen
  only). If the tab has no capture yet, return a clear "no screen captured"
  marker rather than fabricating.
- **On-demand only** — the operator calls it when it needs to see inside a tab.
  No per-message token cost (this is the user's chosen trade-off over always
  injecting the screen into world context).

### 3. Executive-read prompt framing

Update `build_system_prompt` guidance in `llm.rs`:

- When the user asks "what am I doing / what's going on / what's it doing" on a
  tab, give an **executive read**: infer the nature of the work, current state,
  what's notable or blocked, and a suggested next step — do **not** transcribe
  the foreground process or recite elapsed seconds as the whole answer.
- If the foreground command is an interactive agent (claude/codex/pi/…) with no
  recent finished blocks, **call `read_terminal_screen` first**, then synthesize
  from what's on screen.
- Document the new tool in the tool list block (kept in the cached portion of the
  system prompt).

## Data flow

```
PTY bytes → session pump → vt100::Parser (existing)
                              │ idle-check tick
                              ▼
                    rendered screen snapshot (new shared cell, per session)
                              │
        teammate read_terminal_screen tool (on demand) ──► operator LLM
                              ▲
              user: "what am I doing on this tab?"
```

## Testing

- **Unit:** screen-snapshot updates on tick and returns the rendered grid;
  empty-state returns the "no screen captured" marker.
- **Unit/resize:** capture reflects the active PTY dimensions after a resize.
- **Manual verify:** open a `claude` session in a tab, ask Mibli "what am I doing
  on this tab?" → expect a synthesized executive read referencing on-screen
  state, plus an offered next step, rather than a command/elapsed restatement.

## Out of scope

- Always-injecting the screen into world context (rejected: token cost).
- Returning extra scrollback history beyond the visible screen.
- Summarizing interactive-agent activity into the rolling `summary` (separate
  follow-up; the summarizer's `BlockFinished` trigger gap is acknowledged but not
  addressed here).
- Cross-tab correlation.
```
