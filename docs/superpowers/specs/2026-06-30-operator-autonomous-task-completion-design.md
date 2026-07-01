# Operator Autonomous Task Completion — Design

**Date:** 2026-06-30
**Status:** Proposed
**Author:** Karluiz + Claude

## Problem

An operator (e.g. Zeta) dispatches a task to an interactive executor (`claude`,
`codex`, `pi`, …) and the task shows `Active`. When the executor **finishes**
the work, nothing marks the task `Done`. It stays `Active` forever until the
user manually clicks "Mark done."

Root cause:

- The task supervisor (`crates/app/src/teammate/task_supervisor.rs`) only ever
  transitions a task **Active ↔ Blocked** and emits sentiment. **No code path
  sets a task to `Done`.** The only Done transitions are the manual
  `teammate_complete_task` command (the button) and cancel.
- The supervisor is driven entirely by `BlockFinished` events (per-command exit
  codes). Interactive agents like `claude` run as a foreground TUI and **emit no
  OSC 133 block events** — so the supervisor is blind to their progress and
  their completion.

Net: the operator does **not** know when to stop. This design gives it that
ability, autonomously.

## Goal

When an executor finishes the task's deliverable, the operator recognizes it,
optionally confirms by asking the executor directly, and **auto-marks the task
`Done`** — no user action required.

## Key insight: the AOM loop already does 90% of this

The autonomous operator (AOM) tick loop already:

- Runs every 500ms (`operator.rs` `tick_loop` → `run_tick`); re-engages an idle
  executor at most once per **45s** (`AOM_IDLE_REPOLL_INTERVAL`).
- Only engages executors that are **at-rest** — `ExecutorPhase::Idle` /
  `Waiting` / `Done`, never `Reading` / `Writing` / `Running` / `Thinking`
  (`should_suppress_for_phase`, `PHASE_STALE_AFTER = 10s`).
- Reads the executor's screen (the `tail` passed into `render_user_message`).
- Calls the model, which returns an `OperatorAction`:
  - `Reply { text, rationale }` → **types into the executor's PTY** via
    `inject_operator_reply` (two-stage write so the TUI treats it as Enter, not
    paste).
  - `Escalate { notification, rationale }` → notify the user.
  - `Wait { rationale }` → do nothing.
- Already passes the task **archetype** into the system prompt
  (`task_archetype`).

So "read the screen" and "ask the executor" are **already implemented** (`tail`
+ `Reply`). The only missing verb is "mark the task done."

## Design

Add a fourth action: **`OperatorAction::Complete { rationale }`.**

### Behavior

1. **Task awareness.** When the engaged session maps to an active task, inject
   the task's **title + deliverable** into the operator's context and instruct
   it:
   > This tab is executing task «TITLE», deliverable «DELIVERABLE». If the
   > executor has clearly finished the deliverable, emit `complete`. If you are
   > not sure, `reply` to ask the executor ("Have you finished? Reply DONE, or
   > say what's left."), then decide on the next check. **Never `complete` on
   > ambiguity** — prefer `reply` or `wait`.

2. **Detection = screen read.** The model reads the `tail` it already receives.

3. **Active confirmation = existing `Reply`.** To "ask the executor," the model
   emits `Reply` with a completion question; `inject_operator_reply` types it
   into the PTY. The executor's answer appears on the next 45s re-poll, where the
   model reads it and decides `complete` / `wait`.

4. **Auto-complete = `Complete`.** On `Complete`, call the existing
   `complete_task_inner(task_id)` (already tested, idempotent, releases the
   operator runtime) and post a chat note:
   `✓ Marked done: «title» — <rationale>`.

### Why the safety comes (mostly) free

- **Cadence:** the 45s idle re-poll naturally paces the probe → read → complete
  cycle. No new timer.
- **At-rest gate:** the phase gate means `Complete` is only ever *considered*
  when the executor is genuinely at-rest. The operator never tries to complete a
  task while the executor is mid-work.
- **Idempotency:** `complete_task_inner` already errors on double-complete
  (`complete_task_twice_returns_error` test).
- **Reversible:** wrong closes can be reopened; auto-complete matches the user's
  existing YOLO auto-confirm posture.

## Components / changes (small)

All in `crates/app/src/operator.rs` unless noted:

1. **`OperatorAction::Complete { rationale }`** — new variant + `kind()` arm
   (`"complete"`) + parse it in the model-response decoder (wherever
   Reply/Escalate/Wait are parsed and the tool/JSON schema is defined).
2. **Session → task lookup** — resolve the active `task_id` (+ operator) for the
   engaged `session_id`. Reuse `TaskSupervisor.by_session`
   (`task_supervisor.rs:70`, `operator_for`/a new `task_for` accessor).
   **Open wiring question:** confirm `TaskSupervisor` is reachable from the tick
   loop via `AppState`; if not, thread the lookup through `AppState`.
3. **Handler branch** for `Complete` — call
   `crate::teammate::commands::complete_task_inner(storage, runtime, task_id,
   now_ms)`, then emit a `teammate-message` chat note and the `teammate-task`
   update (mirror what `apply_decision` does for status changes).
4. **Prompt additions** — in `build_system_prompt` (and the user message), gated
   on "this session has an active task": describe the `complete` verb and the
   never-complete-on-ambiguity rule. When there is no active task, `complete` is
   not offered.

## Data flow

```
tick (500ms) ─▶ session at-rest & 45s re-poll due?
                     │yes
                     ▼
            session → task_id? (TaskSupervisor.by_session)
                     │yes                    │no → existing behavior
                     ▼
        model call (screen tail + task title/deliverable + complete verb)
                     │
        ┌────────────┼───────────────┬──────────────┐
        ▼            ▼               ▼              ▼
     Complete      Reply           Wait          Escalate
        │        (ask exec)         │              │
        ▼            │              (unchanged)  (unchanged)
 complete_task_inner │
 + chat note "✓..."  └─▶ answer read on next re-poll ─▶ Complete/Wait
```

## Error handling

- `complete_task_inner` failure (already Done, storage error) → log + emit
  nothing; the 45s dedup prevents a retry storm (one attempt per idle window).
- No active task for the session → `complete` verb absent; model can't call it.
- Executor answers "not done" to a probe → model `Wait`s; next re-poll retries.

## Testing

- **Unit:** `OperatorAction::Complete` parses from a model response;
  `kind() == "complete"`.
- **Unit:** session→task resolution returns the right `task_id` for a
  registered session and `None` for an unregistered one.
- **Unit (reuse):** `complete_task_inner` idempotency already covered
  (`complete_task_twice_returns_error`).
- **Integration (manual, in-app):** dispatch a task to `claude`, let it finish,
  observe the operator probe-then-complete within ~1–2 re-poll cycles and the
  task flip to `Done` with a chat note.

## Explicitly skipped (YAGNI)

- **No new background loop** — rides the existing 45s AOM re-poll.
- **No `ExecutorPhase::Done` trigger wiring** — the LLM screen-read subsumes it;
  the at-rest phase gate already fences when `Complete` is considered. (Could add
  `Done` phase as a cheap pre-filter later if the LLM read proves noisy.)
- **No confirm step** — user chose auto-complete. Add a "propose, confirm"
  variant only if wrong closes become a problem in practice.
- **No completion-marker protocol** in executor wrappers — works with vanilla
  `claude` via screen-read + probe; a machine-readable sentinel is a later
  optimization if screen judgment proves unreliable.
