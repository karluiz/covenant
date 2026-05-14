# Telegram Approve Propagation — Design

**Date:** 2026-05-13
**Branch:** `feat/telegram-approve-propagation`
**Status:** Approved for planning

## Problem

Pressing **Approve** on a Telegram escalation does nothing visible to the user:

1. The blocked executor (Claude Code, Copilot, etc.) stays blocked at its TUI prompt.
2. The operator re-emits the same `EscalationRequested` on its next tick because nothing told it the human resolved it.
3. The Telegram chat fills with duplicate "BLOCKED" cards (observed 3× in the failing screenshot), and eventually buttons go stale, producing "Responde al mensaje original… o esa escalación ya cerró."

### Root cause

In `crates/app/src/lib.rs` the drain task that handles `InboundEvent::Resolved` only injects bytes into the PTY for the `FreeText` variant. `Approved` / `Rejected` / `Snoozed` publish a `SessionEvent::EscalationResolved` on the bus and edit the Telegram message — but **no consumer of `EscalationResolved` writes to the PTY or clears any operator state**. The executor literally never sees the keystroke it was waiting for, and the operator has no memory that an escalation is in flight.

## Goals

- Pressing Approve in Telegram unblocks the executor TUI.
- The operator's next decision tick is informed that the human resolved the escalation, so it does not re-escalate immediately.
- While an escalation is pending for a session, the operator does not fire a new tick for that session.

## Non-goals (explicit)

- Redesigning the Telegram message format (`[tab: session:01KRJ3] BLOCKED` ugliness, missing project/branch context, ES/EN mix). Covered in a follow-up UX spec.
- Per-executor fine-grained menu selection (e.g. Claude's "2) Yes, and don't ask again"). Approve always picks the first affirmative option.
- Translating the "Responde al mensaje original…" warning. It should become unreachable; we keep it as-is for safety.
- Snooze semantics beyond "do not inject, do not clear pending". A richer re-reminder schedule is out of scope.

## Architecture

Three additive pieces, all inside `crates/app`:

```
TG Approve callback
  └─► InboundEvent::Resolved(Approved)
        └─► drain task (lib.rs):
              1. lookup fg_proc for session
              2. write approve-bytes to PTY               ← unblocks TUI
              3. operator.resolve_pending(sid, outcome)   ← clears gate + injects note
              4. publish SessionEvent::EscalationResolved ← UI dot clears
              5. tg.on_resolved(...)                      ← edits TG message
```

### Component 1 — Keystroke table

**New file:** `crates/app/src/telegram/keystrokes.rs` (~40 LOC + tests).

```rust
pub struct ApproveReject {
    pub approve: &'static [u8],
    pub reject:  &'static [u8],
}

pub fn approve_reject_bytes(fg_name: Option<&str>) -> ApproveReject { ... }
```

Initial table (matched case-insensitively on the executor name produced by `fg_proc::foreground_process_name`):

| fg_proc match | Approve | Reject |
|---|---|---|
| `claude`, `claude-code` | `1\n` | `2\n` |
| `copilot` | `1\n` | `2\n` |
| `gemini` | `1\n` | `2\n` |
| `aider` | `y\n` | `n\n` |
| `codex` | `y\n` | `n\n` |
| `ollama` | `y\n` | `n\n` |
| anything else / `None` | `y\n` | `n\n` |

Pure function, no I/O. One unit test per row.

### Component 2 — Operator pending-escalation gate

**Modified:** `crates/app/src/operator.rs`.

Add to `OperatorInner`:

```rust
/// Active escalation per session. While set, run_tick is a no-op for
/// that session. Cleared when the escalation is resolved (via UI
/// modal, Telegram, or — future — timeout).
pending_escalation: HashMap<SessionId, String>, // SessionId -> escalation_id
```

New methods on `OperatorInner`:

- `mark_pending(sid, escalation_id)` — called from the two existing `escalation_tx.send(EscalationRequested {...})` sites (lines ~2866 and ~2996) immediately before publishing.
- `resolve_pending(sid, escalation_id, outcome: ResolutionOutcome)` — removes the entry if the id matches, and calls the existing `note_user_input(sid, formatted)` mechanism (operator.rs:54). `outcome` is a small enum `{ Approved, Rejected, FreeText(String) }`. `Snoozed` is intentionally not a valid outcome for this method.

In `run_tick` (operator.rs:1336+): before any LLM call for a given session, check `pending_escalation.contains_key(&sid)` → skip that session this tick.

### Component 3 — Drain task uses both

**Modified:** `crates/app/src/lib.rs:2622-2686`.

For `Approved` / `Rejected`:

1. Look up the session id from `tg_for_drain.state.session_map` (already populated at send time, `telegram/mod.rs:107-112`).
2. With the session locked from `AppState.sessions`, read `managed.session.foreground_process_name()` (the underlying call already exists via `pty::fg_proc`).
3. Compute bytes via `keystrokes::approve_reject_bytes(fg_name.as_deref())`.
4. `managed.session.write(&bytes)` — same path FreeText already uses.
5. Call `operator.resolve_pending(sid, escalation_id, outcome)`.
6. Publish `SessionEvent::EscalationResolved` (already done today).
7. `tg.on_resolved(...)` (already done today).

`Snoozed` keeps current behavior: edit the TG message, publish `EscalationResolved` with `Snoozed`, but do **not** call `resolve_pending` (the gate stays held; future spec adds the re-reminder).

`FreeText` keeps current PTY injection AND also calls `resolve_pending` with `Outcome::FreeText`.

## Data flow (sequence)

```
User taps Approve on TG
  │
  ▼
inbound::spawn ─ InboundEvent::Resolved(Approved, eid)
  │
  ▼
drain task in lib.rs:
  sid = session_map[eid]                              // already stored
  fg  = sessions[sid].fg_proc                         // claude / copilot / …
  ar  = keystrokes::approve_reject_bytes(fg)
  sessions[sid].write(ar.approve)                     // → executor unblocks
  operator.resolve_pending(sid, eid, Approved)        // → gate clears, note added
  bus.send(EscalationResolved{eid, Approved, Telegram})
  tg.on_resolved(eid, "Approved via Telegram")        // → message edited
```

Next operator tick: `pending_escalation` empty, LLM sees fresh `note_user_input` ("user approved escalation: <summary>"), decides something other than `ESCALATE`.

## Error handling

- Session no longer exists (tab closed): log warn, still publish `EscalationResolved` and edit the TG message. No retry.
- `foreground_process_name` returns `None` (process exited, race): use fallback bytes (`y\n`).
- `operator.resolve_pending` called for an unknown sid or with a stale eid: no-op + debug log. Idempotent.
- PTY write fails: log warn (matches current FreeText behavior), continue with the rest of the steps.

## Testing (TDD)

All tests in existing modules; no new test crates.

**`crates/app/src/telegram/keystrokes.rs`** — table-driven unit tests covering every row plus `None`.

**`crates/app/src/telegram/mod.rs`** (extending the existing test module):

1. `approve_injects_keystrokes_for_claude` — set up FakeTelegramClient + fake session whose `fg_proc` reports `claude`. Drive an `Approved` resolution. Assert PTY received `b"1\n"`.
2. `approve_falls_back_when_fg_unknown` — fg_proc returns None. Assert PTY received `b"y\n"`.

**`crates/app/src/operator.rs`** (operator unit tests):

3. `mark_pending_then_resolve_clears_and_notes_input` — call `mark_pending`, assert tick is a no-op, call `resolve_pending`, assert tick now runs and `note_user_input` recorded the outcome.
4. `reescalation_suppressed_until_resolved` — fake LLM returns ACTION:ESCALATE on two consecutive ticks; assert only one `EscalationRequested` is published.

Integration coverage at the lib.rs drain task is exercised by tests 1+3 in combination (the drain task is thin glue once components 1 and 2 work).

## Out-of-scope follow-ups (tracked for the next spec)

- Message format redesign — distinct compact card per kind, project/branch in the header, no repeated `BLOCKED` line, ES/EN consistency.
- Pending-escalation timeout escape (10 min default) — so a forgotten approval doesn't deadlock the session forever.
- Richer per-executor approve options (e.g. surface Claude's "Yes, and don't ask again").
- Snooze re-reminder cadence.

## File-level change estimate

| Path | Δ LOC | Note |
|---|---|---|
| `crates/app/src/telegram/keystrokes.rs` | +~40 | new |
| `crates/app/src/telegram/mod.rs` | +~30 | pub use + 2 tests |
| `crates/app/src/operator.rs` | +~80 | field, methods, gate, 2 tests |
| `crates/app/src/lib.rs` | +~50 | drain task branches |
| **Total** | **~200** | |
