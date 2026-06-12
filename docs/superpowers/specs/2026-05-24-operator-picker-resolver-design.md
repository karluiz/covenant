# Operator Picker Resolver — Design

**Status:** Draft
**Date:** 2026-05-24
**Owner:** karluiz

## Problem

Executors (Claude Code, Codex, etc.) sometimes render interactive TUI widgets that wait on keyboard input — most importantly:

- **`AskUserQuestion` pickers** with a tab strip header, checkbox/radio options, and an `Enter to select · Tab/Arrow keys to navigate · Esc to cancel` footer.
- **Claude Code permission prompts** with `❯ 1. Yes  2. No` shaped numbered options used for tool approvals.

The Covenant operator currently only knows how to emit plain text into the executor's PTY. When a picker appears, the operator types things like `"1"`, `"1, 2, 3, 4"`, or `"itworks"` — the picker ignores all of it because it wants arrow keys + space + enter, not characters. The executor sits frozen, the operator's loop-guard trips (`same reply 2x`), retries hit 429s, the task stalls. See activity log from session J3HRHR / NYP4HT for the canonical failure mode.

This is closely related to the existing "ghost prompts" issue (`project_executor_ghost_prompts.md`) — same root cause (operator emits text that the executor's UI does not consume), different surface (interactive widget vs placeholder).

## Goals

- Detect known interactive widgets in executor output.
- Resolve them autonomously when possible: the operator LLM picks an answer; the operator drives real key sequences into the PTY.
- Fall back cleanly to a human (karluiz, via Mibli) when autonomous resolution fails.
- Do not interfere with the existing text-reply pipeline, loop-guard, or cost tracking.

## Non-Goals

- General-purpose TUI driving (vim, fzf, less, etc.). v1 handles two specific widget shapes.
- Escalation-to-user as the default. v1 picks autonomously; humans only see pickers that fail.
- Replacing or refactoring the existing ghost-prompt scrubber. They coexist.

## Architecture

The operator gains one new module, **`picker-resolver`**, as a side-path off the existing PTY-output stream:

```
executor PTY bytes
   → vt100::Parser (existing, used for fg_proc/screen tracking)
   → PickerDetector  (pure: Screen → Option<PickerSnapshot>)
   → if Some(snapshot):
        suppress text-reply pipeline for this session
        → PickerResolver  (LLM call → IntendedAnswer)
        → PickerDriver    (write key sequence to PTY)
        → detector watches for picker to disappear (success oracle)
   → if None:
        existing text-reply pipeline runs unchanged
```

Key property: the picker path **bypasses the text-reply pipeline entirely**. Loop-guard, "same reply 2x" detection, and normal reply cost accounting all live on the text path and never see picker turns. Pickers have their own activity events and their own rate budget.

## Components

### `PickerDetector`

Pure, stateless. Signature: `fn detect(screen: &vt100::Screen) -> Option<PickerSnapshot>`.

Holds a registry of `Recognizer` trait objects. v1 ships two:

**`AskUserQuestionRecognizer`** — matches:
- A tab-strip row (e.g. `← ⊠ Scope  □ Storage  □ Agent reach  ✓ Submit →`).
- The literal footer `Enter to select · Tab/Arrow keys to navigate · Esc to cancel`.

Extracts: question title, active tab name, question text, ordered list of options (label + checked-state), focused row index (the row prefixed with `›`).

**`ClaudeCodePromptRecognizer`** — matches the `❯ N. <label>` shape Claude Code uses for tool-permission prompts (a focused-row marker `❯` followed by 2–N numbered options).

Extracts: prompt text, ordered options, focused row index.

Both produce a normalized `PickerSnapshot`:

```rust
pub struct PickerSnapshot {
    pub kind: PickerKind,            // AskUserQuestion | ClaudeCodePrompt
    pub question: String,
    pub options: Vec<PickerOption>,  // label, checked, focused
    pub multi_select: bool,
    pub focused_index: usize,
    pub fingerprint: u64,            // hash for change-detection
}
```

Negative fixtures (markdown tables, fzf results, anything that looks picker-ish) must NOT match.

### `PickerResolver`

Per-session. Given a `PickerSnapshot` plus session context (current task description, rolling summary), calls the operator LLM with a tight prompt:

> "The executor is showing this picker. Here is what the current task is trying to do: {task}. Return JSON: `{action: \"select\" | \"cancel\", indices: [0-based], submit: bool}`."

Returns an `IntendedAnswer`. Validates: indices in range, `select` requires non-empty indices for non-cancel, `multi_select=false` allows at most one index.

Resolver uses the same model/credentials as the existing operator reply pipeline. Calls are tracked under a separate cost line (`picker_resolution`).

### `PickerDriver`

Translates `IntendedAnswer` → byte sequence per widget type, writes to PTY with a small inter-key delay (~30 ms; TUIs drop bursts).

**AskUserQuestion driver:**
- From `focused_index`, emit `↓` (or `↑`) to reach each target row.
- `space` to toggle each selected option.
- If `submit`: `tab` through to the Submit tab, `enter`.
- If `cancel`: `esc`.

**Claude Code prompt driver:**
- `↓` / `↑` to reach target row, then `enter`.
- `cancel` → `esc`.

Driver is a pure function from `(snapshot, intended_answer)` → `Vec<u8>` — easy to unit-test.

## Data Flow (one resolution cycle)

1. Executor emits PTY bytes; existing `vt100::Parser` consumes them.
2. A debounced "screen settled" tick (~150 ms after last byte) triggers `PickerDetector::detect(&screen)`.
3. On `Some(snapshot)`:
   - Suppress the text-reply pipeline for this session.
   - Emit `PickerDetected { session, snapshot.fingerprint }` to the activity bus.
4. `PickerResolver` makes the LLM call → `IntendedAnswer`.
5. `PickerDriver` writes the key sequence to the PTY, ~30 ms between keys.
6. Detector keeps running on each settled tick. **Success oracle:** when no recognizer matches the screen anymore (or the fingerprint changes to a different picker), emit `PickerResolved { session, duration_ms, selections }` and re-enable the text-reply pipeline.
7. If the same fingerprint is still present 5 s after the driver finished, treat as a drive failure (see Error Handling).

The detector itself is the success oracle. We never trust "we sent the right keys" — only "the picker is gone."

## Error Handling

| Failure | Handling |
|---|---|
| Anthropic 429 / network error on resolver call | Exponential backoff: 2 s → 5 s → 12 s. After 3 attempts → park. |
| Resolver returns malformed JSON or out-of-range indices | One retry with a stricter prompt. Still bad → park. |
| Driver sent keys but the same fingerprint persists after 5 s | One re-drive attempt (lost keystroke). Still present → park. |
| Recognizer matched but extracted zero options | Park immediately — widget not well-understood, do not guess. |

**Park** =
- Stop sending input to the executor for this session.
- Mark the task `WAITING_HUMAN`.
- Emit `PickerParked { session, reason, rendered_screen }` to Mibli's activity feed, including the captured picker text so karluiz can manually answer in the executor's TTY.
- Operator does **not** auto-cancel the picker. It stays open for the human.

**Rate budget:** picker resolution gets its own counter, **max 10 resolutions per session per 5 minutes**. Beyond that → park with reason `picker_rate_limit`. Defends against an executor stuck in a picker loop burning tokens.

## Testing

**Unit — recognizers.** Capture real rendered screens (text dumps of `vt100::Screen.contents()`) from live executor sessions into `crates/operator/tests/fixtures/pickers/*.txt`. Each fixture asserts: detector matches (or doesn't), extracted snapshot equals expected struct. Include negative fixtures (markdown tables, fzf, plain numbered lists) to pin down false-positive rate.

**Unit — driver.** Given a starting snapshot and an `IntendedAnswer`, assert the exact byte sequence written. Pure function.

**Integration — full loop, mocked LLM.** A fake executor prints a canned picker into a real PTY. A stub `PickerResolver` returns a fixed `IntendedAnswer`. Assert the picker disappears from the screen and `PickerResolved` fires. Covers detector → driver → success-oracle wiring without real API cost.

**No end-to-end LLM tests in CI** (too flaky/expensive). Manual smoke test added to release checklist: run a real Claude Code session, trigger an `AskUserQuestion`, watch the operator resolve it; trigger a permission prompt, watch the operator answer it.

## Telemetry / Activity Events

Three new event types in the operator activity bus:

- `PickerDetected { session, kind, fingerprint }`
- `PickerResolved { session, duration_ms, selections, cost }`
- `PickerParked { session, reason, rendered_screen }`

Mibli's activity panel renders all three with distinct icons. `PickerParked` is interactive — clicking surfaces the captured picker so the user knows what to answer in the TTY.

## Open Questions

None blocking — call out anything that surfaces during planning.

## Out of Scope (future)

- Recognizers for additional widgets (Codex's prompts, generic dialog boxes).
- Operator-driven `Esc` on parked pickers after a timeout.
- Confidence-based escalation (mixed posture from the original brainstorm — deferred until we have telemetry on what resolver gets wrong).
