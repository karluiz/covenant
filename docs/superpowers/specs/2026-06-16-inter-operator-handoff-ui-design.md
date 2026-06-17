# Inter-Operator Handoff — UI Auto-Spawn (Plan 2, critical path) Design

> Companion to `2026-06-16-inter-operator-handoff-design.md` (the original design) and
> `../plans/2026-06-16-inter-operator-handoff-backend.md` (Plan 1, merged in v0.8.87).
> This spec covers **Plan 2, critical path only**: the UI auto-spawn that turns a routed
> handoff into a live, working receiver tab, plus end-to-end verification.

## Goal

When one operator hands a unit of work to another, the receiver's task must become a
**live, hands-free tab** — spawned, bound to the receiver operator, attached to the task,
and running the chosen executor — without any human click. Today the backend already
routes the handoff, creates the receiver `Task`, claims the receiver operator in the
runtime, and emits a `teammate-handoff-routed` event. **Nothing listens for it.** This
spec closes that gap.

## Background (what already exists)

Plan 1 (merged) produced, on an accepted handoff:

- A persisted `Handoff` edge (`teammate_handoffs` table) with `status = running`.
- A receiver `Task` (status `Active`, `spawned_session = None`) created and persisted.
- The receiver operator claimed in `TeammateRuntime` (`OperatorState::OnTask`).
- A Tauri event emitted at `crates/app/src/teammate/commands.rs:317`:

  ```json
  {
    "handoff_id":    "<ulid>",
    "chain_id":      "<ulid>",
    "from_operator": "<operator_id>",
    "to_operator":   "<operator_id>",
    "task_id":       "<ulid>",
    "executor":      "<claude|codex|copilot|pi|hermes>",
    "brief":         "<string>",
    "deliverable":   "<string>"
  }
  ```

- A `→ Handed off to X: <brief> (running; will report back).` system message in the
  delegator's thread.

The report-back on receiver completion (delegator thread message + `good_delegate`
achievement) is also already wired in `task_supervisor.rs`.

The frontend building blocks already exist and are exercised by the existing
`target="spawn"` confirm-task path (`ui/src/teammate/panel.ts:1727`):

| Building block | Location | Role |
|---|---|---|
| `spawnTabForTask(task, overrides?)` | `ui/src/main.ts:663` | Creates a tab (cwd/group/color overridable) → `{sessionId, cwd, groupId, color}` |
| `bindOperatorToTab(sessionId, operatorId)` | `ui/src/main.ts:715` | Binds operator, enables operator + live, repaints ring/status |
| `attachSessionToTask(operatorId, taskId, sessionId)` | `ui/src/api.ts:584` → cmd `teammate_attach_session_to_task` | Sets `task.spawned_session` + registers session in task supervisor |
| `buildTaskInjection(title, deliverable, executor, …)` | `ui/src/teammate/panel.ts:2160` | Builds `<executor> '<prompt>'\n` |
| `injectCommand(sessionId, line)` | (Tauri) | Types the line into the PTY |

The auto-spawn **reuses all of these** and skips the confirm step (the task already exists).

## Architecture

A single new event listener in `ui/src/main.ts` on `teammate-handoff-routed`. No backend
change. The listener is the only new surface; it orchestrates the existing blocks in the
same order as the confirm-task `spawn` path.

```
teammate-handoff-routed (backend, already emitted)
        │
        ▼
 main.ts listener  ── idempotency guard (seen handoff_id / task already spawned)
        │
        ├─ resolve delegator's tab → cwd + groupId + color   (fallback: active group)
        ├─ spawnTabForTask({title: brief}, {cwd, groupId, color})   (BACKGROUND, no focus steal)
        ├─ attachSessionToTask(to_operator, task_id, sessionId)
        ├─ bindOperatorToTab(sessionId, to_operator)
        ├─ after spawn delay: injectCommand(sessionId, buildTaskInjection(brief, deliverable, executor))
        └─ persist into taskSpawnedSessions / localStorage
```

## Behavior decisions (locked)

1. **Background spawn, no focus steal.** The receiver tab appears in the strip and starts
   working, but the user's current tab stays focused so the delegator thread (with the
   `→ Handed off…` message) stays visible. Do **not** call any "activate/focus tab" path.

2. **Placement inherits the delegator's tab.** Resolve the delegator operator
   (`from_operator`) to its currently bound tab via the TabManager operator→tab mapping and
   inherit that tab's `cwd`, `groupId`, and `color`. The delegated work sits next to the
   work it came from. **Fallback:** if the delegator has no resolvable bound tab (it acted
   headless), fall back to the active group/cwd defaults that `spawnTabForTask` already
   uses — never throw on a missing delegator tab.

3. **Auto-launch the executor.** Full parity with the `target="spawn"` confirm path: after
   the spawned-tab inject delay (~1500ms, the existing constant), inject
   `<executor> '<brief> — <deliverable>'\n` so the receiver starts hands-free. The
   executor name comes from the event payload. The agent-side hard blocklist
   (`crates/agent/src/safety.rs`) still gates anything dangerous the launched agent attempts —
   auto-launch does not bypass it.

4. **Idempotent.** Guard against duplicate / re-delivered events: maintain an in-memory
   `Set<handoff_id>` for the session, and additionally skip if the `task_id` already has an
   entry in `taskSpawnedSessions`. Either hit → no-op.

## Data flow

The listener consumes only the event payload — it does **not** re-fetch the task. `brief`
and `deliverable` from the payload are sufficient to build the injection and the tab title;
`to_operator` / `task_id` are the ids needed for attach + bind; `executor` selects the CLI;
`from_operator` drives placement resolution.

The receiver task's `spawned_session` is set by `attachSessionToTask` (backend command
`teammate_attach_session_to_task`), which also calls `supervisor.register_task(...)` — so
the task supervisor begins tracking the receiver session automatically. No extra
registration step is needed in the frontend.

## Error handling

- Each handoff is independent. The listener body is wrapped so a thrown error logs and
  bails for **that** handoff without killing the listener or producing an unhandled
  promise rejection.
- If `spawnTabForTask` returns an empty/missing `sessionId`, abort before attach/inject
  (never attach or inject into a non-existent session).
- A UI spawn failure leaves the backend state intact: the task stays `Active` and
  session-less (the runtime claim persists), which is recoverable. The failure is logged
  with the `handoff_id` and `task_id` rather than silently dropped.
- The idempotency guard runs **before** the spawn so a re-delivered event after a
  successful spawn is a clean no-op.

## Testing

**Frontend unit tests** (the existing `main.ts` test harness pattern; mock the api wrappers
+ TabManager):

1. **Happy path call sequence** — fire a synthetic `teammate-handoff-routed` payload;
   assert the ordered calls `spawnTabForTask → attachSessionToTask → bindOperatorToTab →
   injectCommand` fire with the correct arguments (`to_operator`, `task_id`, `sessionId`,
   and the injection line containing the executor + brief + deliverable).
2. **Delegator-tab placement** — with the delegator bound to a tab that has a known
   cwd/group/color, assert `spawnTabForTask` is called with those overrides.
3. **Placement fallback** — with no resolvable delegator tab, assert it still spawns
   (active-group defaults) and does not throw.
4. **No focus steal** — assert no tab-activate/focus call is made.
5. **Idempotency** — fire the same `handoff_id` twice; assert only one spawn. Fire a second
   event whose `task_id` is already in `taskSpawnedSessions`; assert no spawn.
6. **Spawn failure** — `spawnTabForTask` returns no sessionId; assert no attach/bind/inject
   and no throw.

**End-to-end** (manual / harness): two seeded operators in a real app run; the delegator
issues a `handoff_task` tool-call; observe (a) the receiver tab spawns in the background,
(b) the executor launches and the receiver begins work, (c) the `→ Handed off…` message in
the delegator thread, and — on receiver completion — (d) the report-back message returns to
the delegator thread and `good_delegate` unlocks (the latter two are Plan 1 behavior,
verified here in-flow).

## Out of scope (deferred to a future Plan 3)

- **Delegator re-engagement wake** — automatically waking the delegator operator when a
  report-back lands (extending the `operator.rs` engagement gate beyond byte-driven
  wakeups). The report is already persisted + emitted regardless, so nothing is lost by
  deferring.
- **Convergence from→to graph** — exposing active/recent `Handoff` edges from
  `convergence.rs` and drawing SVG tile connectors in `ui/src/convergence/overlay.ts`
  (which today is pure HTML/CSS grid with no connector drawing).

## Self-review notes

- **Single new surface:** one listener in `main.ts`; everything else is reuse. Keeps the
  change small and the boundary clear.
- **Parity reference is real, not hypothetical:** the confirm-task `spawn` path
  (`panel.ts:1727`) does exactly spawn → attach → bind → delayed inject today; the
  auto-spawn differs only by skipping `confirmTask` (task already created) and by
  resolving placement from the delegator instead of the active tab.
- **No backend change** needed — the event and payload already exist (commands.rs:317).
- **Recoverability:** every failure mode leaves backend state consistent and logged.
