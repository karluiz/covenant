# Shell-prompt autodetect → super-agent

**Date:** 2026-06-20
**Status:** Design approved, pending spec review

## Problem

When a terminal tab is a **bare shell** (no executor agent running), a user often
types a natural-language question at the prompt — `how to reload env` — expecting
help. Today that just runs and the shell errors `command not found`. Warp solves
this with live autodetection: as you type prose, it offers to route the line to an
AI conversation instead of the shell (`↵ new /agent conversation (autodetected)
⌘I to override`).

We want the same *feel* in Covenant: a live, pre-Enter hint that reroutes a prose
line to our existing **⌘K super-agent panel**, prefilled.

## Why Warp can do it and we can't copy it directly

Warp's input is its own editor widget, decoupled from the PTY — it has the full
line as plain text before Enter. Covenant renders the **real shell** via xterm.js,
so zsh's ZLE owns the line. We never get a clean pre-Enter buffer; we only see raw
keystroke bytes at the write chokepoint. So we reconstruct a *best-effort* buffer
and fail safe whenever we can't trust it.

## Decisions (locked)

- **Route target:** open the existing **⌘K super-agent panel**, prefilled. Non-destructive — never executes anything.
- **Timing:** predictive / live — hint appears while typing, before Enter.
- **Placement:** anchored under the cursor row (Warp-like).
- **No Rust changes.** Every signal needed already reaches the frontend.

## Architecture

One new frontend module, `ui/src/terminal/prompt-detect.ts`, one instance per
terminal — mounted where `welcome-hint` mounts. It needs three things passed in:
the xterm `Terminal`, the `AgentPanel` instance (for `openWithSeed`), and the
session's `writeToSession` sender (to clear the shell line on commit). It also
needs to observe `SessionUiEvent`s for that session.

### Existing seams reused

| Need | Seam | Location |
|---|---|---|
| Shadow line buffer | `RecallManager.currentLine()` (new getter) | `ui/src/recall/manager.ts` |
| Keystroke/Enter interception | `term.attachCustomKeyEventHandler` (Shift+Enter already lives here) | `ui/src/tabs/manager.ts:3619` |
| Bare-shell signal | `activePane(tab).executor === null` | `ui/src/tabs/manager.ts:3092+` |
| Prefill the ⌘K panel | `agent.openWithSeed(seed)` | `ui/src/agent/panel.ts:44` |
| Overlay precedent | `mountWelcomeHint` overlay card | `ui/src/terminal/welcome-hint.ts` |

## Components

### 1. Best-effort line buffer (fail-safe)

**We do not build a buffer.** `RecallManager` (`ui/src/recall/manager.ts`) already
shadows the shell line for the identical reason: it subscribes to `onData`, handles
backspace / Ctrl-U / Ctrl-W / arrows, and resets on `prompt_start` (OSC 133). Its
top-of-file doc spells out the exact "heuristic, bounded by prompt_start" discipline
this feature needs. Rebuilding it would be duplication.

Change: add one getter `RecallManager.currentLine(): string` returning the trimmed
`buffer`. The prose detector reads it on demand — no new byte-handling, no duplicated
dirty-tracking.

`// ponytail: piggyback on Recall's shadow buffer. If Recall is removed, this getter
is the single seam to re-home.`

### 2. Gate

Hint may show only when **all** hold:

- bare shell: the tab's active pane has no executor — `!activePane(tab).executor`
  (set by `detectExecutor` on `block_started`, cleared on `block_finished`; this is
  the codebase's existing per-tab executor signal, same one the status-bar brand chip
  reads). This also means we never fight a running coding-agent's TUI.
- Recall popup not showing — `!recall.isVisible()` (they share the buffer; only one
  surface at a time). In practice Recall stays hidden for genuine prose, since the
  history search returns no matches.
- the line is non-empty (Recall's buffer is live, i.e. we're mid-input at a prompt)

### 3. `looksLikePrompt(buf): boolean` — pure, unit-tested

Returns true when the line reads as English, not a command:

- ≥ 2 words
- contains no shell metacharacter: `| & ; > < $ ( ) \` =`
- first token contains no `/ . ~`
- AND (trailing `?` **or** first word ∈ conservative question/request set:
  `how what why when where who which whats hows can could should would is are do does`,
  plus two-word openers `tell me`, `show me`, `give me`, `help me`, `how to`)

Deliberately **excludes** imperatives that collide with real binaries
(`make create run write add fix show`). Those won't trigger → near-zero false
positives, at the cost of missing imperative prose. Acceptable for v1.

`// ponytail: heuristic only, no PATH resolution. Upgrade = a backend `command -v`
check to also catch imperative prose without colliding with real binaries.`

### 4. Hint overlay + commit

The controller re-evaluates on every keystroke (it's invoked from
`attachCustomKeyEventHandler`, which fires per key):

- gate passes and `looksLikePrompt(recall.currentLine())` → render an overlay strip
  anchored under the cursor row — `↵ ask the super-agent · ⌘I run literally`.
  Hide it the instant either stops holding.
- Cursor anchor: compute from xterm cursor coords + cell dimensions (same overlay
  layer `welcome-hint` already uses). `// ponytail: reads xterm's css cell
  dimensions (semi-private). Fall back to pane-bottom strip if that API moves.`
- **⌘I** keydown while shown → `overridden = true` for this line; hide hint (Enter
  runs literally). Cleared on next `prompt_start`.
- **Enter** keydown while shown and `!overridden` → intercept (return `false` from
  the custom key handler so xterm sends no `\r`):
  1. send `\x15` (Ctrl-U) to clear the typed shell line *(one byte, multibyte-safe;
     cursor-at-end invariant guarantees a clean wipe)*
  2. `agent.openWithSeed(line)` with the captured line
  3. hide the hint

Interception lives in `attachCustomKeyEventHandler` — the same place Shift+Enter is
already intercepted (`manager.ts:3619`). Returning `false` suppresses xterm's default
key handling, so no stray byte reaches the PTY.

## Data flow

```
keydown ─▶ attachCustomKeyEventHandler ─▶ hint.onKey(ev)
              │ (printable/edit keys also flow to recall.notifyInput via onData)
              ▼
        gate(bareShell && !recall.isVisible) && looksLikePrompt(recall.currentLine())?
              │ yes                          │ no
              ▼                              ▼
        show hint @cursor                 hide hint
              │
   Enter & !overridden │  ⌘I
              ▼  ▼
   intercept (return false): clear line (Ctrl-U) + agent.openWithSeed(line)
```

## Error handling / safety

Both fragile pieces fail *toward hiding the hint*:

- buffer drift → Recall marks its buffer untrustworthy/empty → no hint → Enter passes through
- heuristic miss → no hint (false negative) → line runs as usual
- Enter interception fires **only** while the hint is visible, which requires a clean
  non-empty Recall buffer, so the Ctrl-U clear can never mangle a line.

Worst case in any failure mode: the ⌘K panel opens when the user didn't want it
(dismissable). Never a wrong command, never lost input, never an auto-execution.

## Testing

- `prompt-detect.test.ts` — `looksLikePrompt` table: positives (`how to reload env`,
  `what is this?`, `why did it fail`) and negatives (`git status`, `npm run dev`,
  `ls -la`, `./build.sh`, `make`, `FOO=bar cmd`, single-word `htop`).
- `shouldHint(opts)` pure-decision helper tested directly: true only when
  `bareShell && !recallVisible && looksLikePrompt(line)`; false if any input flips.
- Recall's `currentLine()` getter — a one-line test that it returns the trimmed buffer.

## Out of scope (v1)

- PATH/alias/builtin resolution (imperative prose like `refactor this file`).
- Multi-line / pasted prose (paste marks `dirty`).
- Routing to an executor or inline answer — ⌘K panel only.
- Windows key handling (M8).
