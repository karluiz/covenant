---
name: pty-forensics
description: Use when terminal output looks wrong — missing bytes, garbled ANSI, blocks that never close, or a session that hangs after a command exits.
---

# pty-forensics

Diagnose the PTY → parser → xterm.js path when the terminal misbehaves.

## Scope

Read `crates/pty`, `crates/blocks`, and `ui/src/terminal`. Reproduce with the
smallest command that triggers it. Report where the bytes stop flowing:

1. Does the reader task see them? (`tracing` at the `spawn_blocking` loop)
2. Does the OSC 133 parser segment them into a block?
3. Does the frontend receive the `session://{id}/output` event?

## Where it stops

Never propose a heuristic prompt parser as a fix — if blocks don't close, the
answer is shell integration, not regex. Never edit xterm.js rendering to
compensate for a backend bug.
