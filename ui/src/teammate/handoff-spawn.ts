import type { TabPlacement } from "../tabs/manager";

/// Payload of the backend `teammate-handoff-routed` Tauri event. All ids are
/// ULID strings. Emitted once per ACCEPTED handoff (see crates/app/src/
/// teammate/commands.rs). `from_operator`/`to_operator` are operator ids;
/// `task_id` is the already-created receiver task.
export interface HandoffRoutedEvent {
  handoff_id: string;
  chain_id: string;
  from_operator: string;
  to_operator: string;
  task_id: string;
  executor: string;
  brief: string;
  deliverable: string;
}

/// Side-effecting dependencies, injected so the orchestration is unit-testable.
export interface HandoffSpawnDeps {
  /// Placement (cwd/group/color) of the delegator's bound tab, or null.
  placementForOperator(operatorId: string): TabPlacement | null;
  /// Spawn a background tab titled from the brief; returns the new session id.
  spawnTab(title: string, placement: TabPlacement | null): Promise<{ sessionId: string }>;
  attachSessionToTask(operatorId: string, taskId: string, sessionId: string): Promise<void>;
  bindOperatorToTab(sessionId: string, operatorId: string): Promise<void>;
  /// Inject `line` into the session's PTY after `delayMs` (lets the new shell
  /// settle, exactly like the confirm-spawn path's 1500ms delay).
  injectLater(sessionId: string, line: string, delayMs: number): void;
  /// Build the executor launch line (e.g. `codex '<brief> — <deliverable>'\n`).
  buildInjection(brief: string, deliverable: string, executor: string): string;
  /// True when this task already has a recorded spawned session.
  alreadySpawned(taskId: string): boolean;
  /// Persist the spawned session for the task (resume parity + dedup).
  recordSpawn(taskId: string, sessionId: string, placement: TabPlacement | null): void;
}

/// Delay before injecting the executor line into the freshly spawned tab.
/// Mirrors the confirm-`spawn` path in teammate/panel.ts.
const SPAWN_INJECT_DELAY_MS = 1500;

/// Materialize a routed handoff as a live, BACKGROUND receiver tab: spawn in
/// the delegator's workspace, attach the task, bind the receiver operator, and
/// auto-launch the executor. No focus change — the user's current tab stays
/// put. Idempotent on `handoff_id` (the in-memory `seen` set) and on a task
/// that was already spawned. Every step is best-effort: a failure is logged
/// and the handoff is abandoned, never thrown (this runs inside an event
/// listener, so an unhandled rejection would be invisible).
export async function handleHandoffRouted(
  ev: HandoffRoutedEvent,
  deps: HandoffSpawnDeps,
  seen: Set<string>,
): Promise<void> {
  if (!ev.task_id || seen.has(ev.handoff_id)) return;
  seen.add(ev.handoff_id);
  if (deps.alreadySpawned(ev.task_id)) return;

  const placement = deps.placementForOperator(ev.from_operator);

  let sessionId: string;
  try {
    const spawned = await deps.spawnTab(ev.brief, placement);
    sessionId = spawned?.sessionId ?? "";
  } catch (e) {
    console.error("handoff auto-spawn: spawnTab failed", ev.handoff_id, ev.task_id, e);
    return;
  }
  if (!sessionId) {
    console.error("handoff auto-spawn: spawn returned no sessionId", ev.handoff_id, ev.task_id);
    return;
  }

  deps.recordSpawn(ev.task_id, sessionId, placement);

  try {
    await deps.attachSessionToTask(ev.to_operator, ev.task_id, sessionId);
  } catch (e) {
    console.error("handoff auto-spawn: attachSessionToTask failed", ev.task_id, e);
  }
  try {
    await deps.bindOperatorToTab(sessionId, ev.to_operator);
  } catch (e) {
    console.error("handoff auto-spawn: bindOperatorToTab failed", sessionId, e);
  }

  const line = deps.buildInjection(ev.brief, ev.deliverable, ev.executor);
  deps.injectLater(sessionId, line, SPAWN_INJECT_DELAY_MS);
}
