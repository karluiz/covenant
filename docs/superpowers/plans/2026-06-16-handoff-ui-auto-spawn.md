# Handoff UI Auto-Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the backend routes an inter-operator handoff (emits `teammate-handoff-routed`), the frontend automatically materializes the receiver's task as a live, background tab — spawned in the delegator's workspace, bound to the receiver operator, attached to the task, and running the chosen executor — with no human click.

**Architecture:** A new pure orchestration module `ui/src/teammate/handoff-spawn.ts` holds `handleHandoffRouted(event, deps, seen)` — all logic, fully unit-testable via injected dependencies. `main.ts` registers one `listen("teammate-handoff-routed", …)` that wires the real dependencies (a new `TabManager.placementForOperator`, the existing `spawnTabForTask`/`bindOperatorToTab`/`attachSessionToTask`/`injectCommand`/`buildTaskInjection`, and the panel's localStorage spawn-meta helpers) into that function. No backend change — the event and payload already ship (`crates/app/src/teammate/commands.rs`).

**Tech Stack:** TypeScript (strict), Vitest, Tauri `listen`. Tests are Vitest unit tests with mocked deps.

**Spec:** `docs/superpowers/specs/2026-06-16-inter-operator-handoff-ui-design.md`

---

## Background: what already exists (verified against current code)

- Backend emits `teammate-handoff-routed` with `{ handoff_id, chain_id, from_operator, to_operator, task_id, executor, brief, deliverable }` (all strings; operator/task ids are ULIDs). **Nothing listens for it yet** (`grep teammate-handoff-routed ui/src` → empty).
- The receiver `Task` is already created by the backend router and the receiver operator already claimed in the runtime. The frontend only spawns + binds + attaches + injects.
- Building blocks (all in the `TeammatePanel` deps object built in `main.ts`):
  - `spawnTabForTask(task, overrides?) → { sessionId, cwd, groupId, color }` (`main.ts:663`). With `overrides` null it falls back to the active group/cwd — exactly the placement fallback we want.
  - `bindOperatorToTab(sessionId, operatorId)` (`main.ts:715`).
  - `teammateAttachSessionToTask(operatorId, taskId, sessionId)` (`api.ts:584`; already imported in `main.ts`).
  - `injectCommand(sessionId, line)` (`api.ts:156`; already imported in `main.ts`).
  - `buildTaskInjection(title, deliverable, operatorPicked, mentionMap?, specPath?, cwd?, defaultExecutor?) → string` (`panel.ts:2160`, exported). Passing the executor as `operatorPicked` yields `<executor> '<title> — <deliverable>'\n`.
  - The confirm path (`panel.ts:1648` `respawnAndInject`, `panel.ts:1740` confirm-`spawn`) is the parity reference: spawn → record spawn-meta → attach → bind → `setTimeout(injectCommand, 1500)`.
  - Spawn-meta persistence: `loadTaskSpawnedSessions()`, `persistTaskSpawnedSessions(map)`, `interface TaskSpawnInfo` (`panel.ts:192/201/212`) — currently **not exported**.
- `TabManager` stores the operator per pane: `activePane(tab).operator` (a `string | null` operator id), `activePane(tab).cwd`, plus `tab.groupId` / `tab.color` (`manager.ts:4302`, Tab/Pane shape at `manager.ts:219`/`284`). `TabManager` is **not instantiable in unit tests** (heavy constructor) — its tests delegate to exported **pure helpers** (see `manager.ts` `computeAddObserver` + `src/tabs/__tests__/observer-bindings.test.ts`). We follow that pattern.

---

## File Structure

| File | Responsibility | New? |
|---|---|---|
| `ui/src/tabs/manager.ts` | `TabPlacement` type + pure `resolveOperatorPlacement` helper + thin `placementForOperator` method | modify |
| `ui/src/tabs/__tests__/placement-for-operator.test.ts` | unit tests for `resolveOperatorPlacement` | **create** |
| `ui/src/teammate/handoff-spawn.ts` | `HandoffRoutedEvent`, `HandoffSpawnDeps`, `handleHandoffRouted` (all orchestration logic) | **create** |
| `ui/src/teammate/handoff-spawn.test.ts` | unit tests for `handleHandoffRouted` | **create** |
| `ui/src/teammate/panel.ts` | export the 3 spawn-meta symbols so `main.ts` can reuse them | modify |
| `ui/src/main.ts` | import deps, register the `teammate-handoff-routed` listener wiring | modify |

Decomposition note: `main.ts` is the app entry and has no test harness. All behavior lives in `handoff-spawn.ts` (Task 2) and `resolveOperatorPlacement` (Task 1), both unit-tested. The `main.ts` change (Task 3) is thin wiring verified by `tsc` + build — this is a deliberate, cleaner split than embedding logic in `main.ts`.

---

## Task 1: `resolveOperatorPlacement` pure helper + `placementForOperator` method

**Files:**
- Modify: `ui/src/tabs/manager.ts`
- Create: `ui/src/tabs/__tests__/placement-for-operator.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/tabs/__tests__/placement-for-operator.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { resolveOperatorPlacement } from "../manager";

describe("resolveOperatorPlacement — pure helper", () => {
  const rows = [
    { operator: "op-A", cwd: "/work/a", groupId: "g1", color: "#111" },
    { operator: null,   cwd: "/work/x", groupId: null, color: null },
    { operator: "op-B", cwd: "/work/b", groupId: "g2", color: "#222" },
  ];

  it("returns the placement of the tab driven by the operator", () => {
    expect(resolveOperatorPlacement(rows, "op-B")).toEqual({
      cwd: "/work/b", groupId: "g2", color: "#222",
    });
  });

  it("returns null when no tab is driven by that operator", () => {
    expect(resolveOperatorPlacement(rows, "op-Z")).toBeNull();
  });

  it("returns the first match when the operator drives multiple tabs", () => {
    const multi = [
      { operator: "op-A", cwd: "/first", groupId: "g1", color: "#1" },
      { operator: "op-A", cwd: "/second", groupId: "g2", color: "#2" },
    ];
    expect(resolveOperatorPlacement(multi, "op-A")?.cwd).toBe("/first");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/tabs/__tests__/placement-for-operator.test.ts 2>&1 | tail -20`
Expected: FAIL — `resolveOperatorPlacement` is not exported from `../manager`.

- [ ] **Step 3: Add the type + pure helper**

In `ui/src/tabs/manager.ts`, near the other exported pure helpers (`computeAddObserver`, `stripObserverOnPromote`, ~line 527), add:

```ts
/// Placement facts inherited by an auto-spawned tab: working dir, group, color.
export interface TabPlacement {
  cwd: string | null;
  groupId: string | null;
  color: string | null;
}

/// Pure resolver: from a snapshot of (operator, cwd, groupId, color) per tab,
/// return the placement of the FIRST tab currently driven by `operatorId`, or
/// null if none. Kept pure so it's unit-testable without a TabManager instance
/// (the manager has dozens of constructor-time deps).
export function resolveOperatorPlacement(
  rows: Array<{ operator: string | null; cwd: string | null; groupId: string | null; color: string | null }>,
  operatorId: string,
): TabPlacement | null {
  const hit = rows.find((r) => r.operator === operatorId);
  return hit ? { cwd: hit.cwd, groupId: hit.groupId, color: hit.color } : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/tabs/__tests__/placement-for-operator.test.ts 2>&1 | tail -20`
Expected: PASS (3 tests).

- [ ] **Step 5: Add the thin method on the class**

In the `TabManager` class (next to `activeGroup()` ~`manager.ts:1591`, which already reads `this.tabs` + `this.groups`), add a method that builds the snapshot from live tabs and delegates to the pure helper. `activePane(tab)` is already used throughout this file (e.g. `setTabOperator` at line 4302):

```ts
  /// Resolve the placement (cwd/group/color) of the tab currently driven by
  /// `operatorId`. Used to spawn a delegated handoff tab in the delegator's
  /// own workspace. Returns null when the operator has no bound tab.
  public placementForOperator(operatorId: string): TabPlacement | null {
    const rows = this.tabs.map((t) => {
      const p = activePane(t);
      return {
        operator: p.operator ?? null,
        cwd: p.cwd ?? null,
        groupId: t.groupId ?? null,
        color: t.color ?? null,
      };
    });
    return resolveOperatorPlacement(rows, operatorId);
  }
```

- [ ] **Step 6: Verify it compiles**

Run: `cd ui && npx tsc --noEmit 2>&1 | grep -E "manager\.ts|placement" | tail -20`
Expected: no errors referencing `manager.ts` or the new symbols (a pre-existing unrelated `vite/client` error elsewhere is fine).

- [ ] **Step 7: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/tabs/__tests__/placement-for-operator.test.ts
git commit -m "feat(handoff-ui): TabManager.placementForOperator + pure resolver"
```

---

## Task 2: `handoff-spawn.ts` orchestration module + tests

**Files:**
- Create: `ui/src/teammate/handoff-spawn.ts`
- Create: `ui/src/teammate/handoff-spawn.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/teammate/handoff-spawn.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleHandoffRouted, type HandoffRoutedEvent, type HandoffSpawnDeps } from "./handoff-spawn";

function ev(over: Partial<HandoffRoutedEvent> = {}): HandoffRoutedEvent {
  return {
    handoff_id: "h1",
    chain_id: "c1",
    from_operator: "op-from",
    to_operator: "op-to",
    task_id: "task-1",
    executor: "codex",
    brief: "migrate auth",
    deliverable: "tests green",
    ...over,
  };
}

function mkDeps(over: Partial<HandoffSpawnDeps> = {}): HandoffSpawnDeps {
  return {
    placementForOperator: vi.fn().mockReturnValue(null),
    spawnTab: vi.fn().mockResolvedValue({ sessionId: "sess-1" }),
    attachSessionToTask: vi.fn().mockResolvedValue(undefined),
    bindOperatorToTab: vi.fn().mockResolvedValue(undefined),
    injectLater: vi.fn(),
    buildInjection: vi.fn().mockReturnValue("codex 'migrate auth — tests green'\n"),
    alreadySpawned: vi.fn().mockReturnValue(false),
    recordSpawn: vi.fn(),
    ...over,
  };
}

describe("handleHandoffRouted", () => {
  let seen: Set<string>;
  beforeEach(() => { seen = new Set(); });

  it("spawns, attaches, binds, and injects in order on the happy path", async () => {
    const d = mkDeps();
    await handleHandoffRouted(ev(), d, seen);
    expect(d.spawnTab).toHaveBeenCalledWith("migrate auth", null);
    expect(d.attachSessionToTask).toHaveBeenCalledWith("op-to", "task-1", "sess-1");
    expect(d.bindOperatorToTab).toHaveBeenCalledWith("sess-1", "op-to");
    expect(d.buildInjection).toHaveBeenCalledWith("migrate auth", "tests green", "codex");
    expect(d.injectLater).toHaveBeenCalledWith("sess-1", "codex 'migrate auth — tests green'\n", 1500);
  });

  it("spawns into the delegator's tab placement when resolvable", async () => {
    const placement = { cwd: "/work/b", groupId: "g2", color: "#222" };
    const d = mkDeps({ placementForOperator: vi.fn().mockReturnValue(placement) });
    await handleHandoffRouted(ev(), d, seen);
    expect(d.placementForOperator).toHaveBeenCalledWith("op-from");
    expect(d.spawnTab).toHaveBeenCalledWith("migrate auth", placement);
  });

  it("falls back to active placement (null) when the delegator has no tab, without throwing", async () => {
    const d = mkDeps({ placementForOperator: vi.fn().mockReturnValue(null) });
    await expect(handleHandoffRouted(ev(), d, seen)).resolves.toBeUndefined();
    expect(d.spawnTab).toHaveBeenCalledWith("migrate auth", null);
  });

  it("records the spawn meta for the task", async () => {
    const d = mkDeps();
    await handleHandoffRouted(ev(), d, seen);
    expect(d.recordSpawn).toHaveBeenCalledWith("task-1", "sess-1", null);
  });

  it("is idempotent on a duplicate handoff_id (spawns once)", async () => {
    const d = mkDeps();
    await handleHandoffRouted(ev(), d, seen);
    await handleHandoffRouted(ev(), d, seen);
    expect(d.spawnTab).toHaveBeenCalledTimes(1);
  });

  it("skips when the task was already spawned", async () => {
    const d = mkDeps({ alreadySpawned: vi.fn().mockReturnValue(true) });
    await handleHandoffRouted(ev(), d, seen);
    expect(d.spawnTab).not.toHaveBeenCalled();
  });

  it("aborts (no attach/bind/inject) when spawn yields no sessionId", async () => {
    const d = mkDeps({ spawnTab: vi.fn().mockResolvedValue({ sessionId: "" }) });
    await handleHandoffRouted(ev(), d, seen);
    expect(d.attachSessionToTask).not.toHaveBeenCalled();
    expect(d.bindOperatorToTab).not.toHaveBeenCalled();
    expect(d.injectLater).not.toHaveBeenCalled();
  });

  it("aborts and does not throw when spawnTab rejects", async () => {
    const d = mkDeps({ spawnTab: vi.fn().mockRejectedValue(new Error("createTab failed")) });
    await expect(handleHandoffRouted(ev(), d, seen)).resolves.toBeUndefined();
    expect(d.attachSessionToTask).not.toHaveBeenCalled();
    expect(d.injectLater).not.toHaveBeenCalled();
  });

  it("ignores events with no task_id", async () => {
    const d = mkDeps();
    await handleHandoffRouted(ev({ task_id: "" }), d, seen);
    expect(d.spawnTab).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/teammate/handoff-spawn.test.ts 2>&1 | tail -20`
Expected: FAIL — cannot resolve `./handoff-spawn` / `handleHandoffRouted` not exported.

- [ ] **Step 3: Write the module**

Create `ui/src/teammate/handoff-spawn.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/teammate/handoff-spawn.test.ts 2>&1 | tail -20`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/teammate/handoff-spawn.ts ui/src/teammate/handoff-spawn.test.ts
git commit -m "feat(handoff-ui): handleHandoffRouted orchestration module"
```

---

## Task 3: Wire the listener in `main.ts`

**Files:**
- Modify: `ui/src/teammate/panel.ts` (export the 3 spawn-meta symbols)
- Modify: `ui/src/main.ts` (imports + listener registration)

- [ ] **Step 1: Export the spawn-meta helpers from `panel.ts`**

In `ui/src/teammate/panel.ts`, add `export` to all three declarations (currently un-exported):

- Line ~192: `interface TaskSpawnInfo {` → `export interface TaskSpawnInfo {`
- Line ~201: `function loadTaskSpawnedSessions(` → `export function loadTaskSpawnedSessions(`
- Line ~212: `function persistTaskSpawnedSessions(` → `export function persistTaskSpawnedSessions(`

(Do not change their bodies or the internal call sites — only add `export`.)

- [ ] **Step 2: Verify the export compiles**

Run: `cd ui && npx tsc --noEmit 2>&1 | grep -E "panel\.ts" | tail -10`
Expected: no new errors in `panel.ts`.

- [ ] **Step 3: Add imports to `main.ts`**

In `ui/src/main.ts`:

- Extend the existing `from "./teammate/panel"` import. It currently is `import { TeammatePanel } from "./teammate/panel";` (line ~83). Replace with:

```ts
import {
  TeammatePanel,
  buildTaskInjection,
  loadTaskSpawnedSessions,
  persistTaskSpawnedSessions,
} from "./teammate/panel";
```

- Add the handoff-spawn import near the other `./teammate/*` imports:

```ts
import { handleHandoffRouted, type HandoffRoutedEvent } from "./teammate/handoff-spawn";
import type { TabPlacement } from "./tabs/manager";
```

(`injectCommand` and `teammateAttachSessionToTask` are already imported at `main.ts:43` — do not re-import them.)

- [ ] **Step 4: Register the listener**

In `main.ts`, in the same setup scope as the other `void listen<…>(…)` registrations (next to the `operator-xp-updated` / `mission-changed` listeners, ~line 1605–1621), add. `manager` and the `spawnTabForTask` / `bindOperatorToTab` closures are defined in this scope (the TeammatePanel deps object at ~line 663–726). Reuse those exact closures:

```ts
  // Inter-operator handoff (Plan 2): when the backend routes a handoff, the
  // receiver task already exists + the operator is claimed. Materialize it as
  // a live BACKGROUND tab (spawn in the delegator's workspace → attach → bind →
  // auto-launch executor). No focus steal: the delegator thread stays visible.
  const seenHandoffs = new Set<string>();
  void listen<HandoffRoutedEvent>("teammate-handoff-routed", (event) => {
    const spawnMeta = loadTaskSpawnedSessions();
    void handleHandoffRouted(event.payload, {
      placementForOperator: (operatorId) => manager.placementForOperator(operatorId),
      spawnTab: async (title, placement: TabPlacement | null) => {
        // spawnTabForTask only reads `task.title`; a minimal object is safe.
        const spawned = await spawnTabForTask(
          { title } as Task,
          placement ? { cwd: placement.cwd, groupId: placement.groupId, color: placement.color } : undefined,
        );
        return { sessionId: spawned.sessionId };
      },
      attachSessionToTask: teammateAttachSessionToTask,
      bindOperatorToTab,
      injectLater: (sessionId, line, delayMs) => {
        window.setTimeout(() => {
          void injectCommand(sessionId, line).catch((e) =>
            console.error("handoff auto-spawn: injectCommand failed", e),
          );
        }, delayMs);
      },
      buildInjection: (brief, deliverable, executor) =>
        buildTaskInjection(brief, deliverable, executor, new Map(), null, null, null),
      alreadySpawned: (taskId) => spawnMeta.has(taskId),
      recordSpawn: (taskId, sessionId, placement) => {
        spawnMeta.set(taskId, {
          sessionId,
          cwd: placement?.cwd ?? null,
          groupId: placement?.groupId ?? null,
          color: placement?.color ?? null,
        });
        persistTaskSpawnedSessions(spawnMeta);
      },
    }, seenHandoffs).catch((e) => console.error("handoff auto-spawn handler error", e));
  });
```

> **Wiring notes (verified against current code):**
> - `spawnTabForTask` and `bindOperatorToTab` are the local closures defined in the `TeammatePanel` deps object (`main.ts:663` / `715`). They are in scope at the listener site. If they are *not* in lexical scope there (e.g. they are only inline in the object literal), hoist them into named `const spawnTabForTask = async (…) => {…}` / `const bindOperatorToTab = async (…) => {…}` declarations ABOVE both the deps object and the listener, and reference the same const in the deps object — do NOT duplicate the bodies. Report DONE_WITH_CONCERNS if hoisting was needed.
> - `Task` is the type used by `spawnTabForTask`; it is already imported in `main.ts` (the deps object is typed against it). If `Task` is not already imported, add it to the existing teammate-types import.
> - `manager.placementForOperator` is the method added in Task 1.

- [ ] **Step 5: Typecheck + build**

Run: `cd ui && npx tsc --noEmit 2>&1 | tail -20`
Expected: no NEW errors from `main.ts` (a single pre-existing `vite/client` triple-slash error unrelated to this change is acceptable — confirm it also exists on `git stash` / is not in `main.ts`).

Run: `cd ui && npx vite build 2>&1 | tail -15`
Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add ui/src/teammate/panel.ts ui/src/main.ts
git commit -m "feat(handoff-ui): listen for teammate-handoff-routed and auto-spawn receiver tab"
```

---

## Task 4: Full frontend gate

**Files:** none (verification only)

- [ ] **Step 1: Run the new + adjacent unit tests**

Run: `cd ui && npx vitest run src/teammate/handoff-spawn.test.ts src/tabs/__tests__/placement-for-operator.test.ts src/teammate/panel.test.ts 2>&1 | tail -25`
Expected: all green (handoff-spawn 9, placement 3, plus the existing panel suite unaffected by the `export` additions).

- [ ] **Step 2: Typecheck the whole frontend**

Run: `cd ui && npx tsc --noEmit 2>&1 | tail -20`
Expected: no errors introduced by this work. Pre-existing unrelated errors (if any) must be unchanged — note them but don't fix.

- [ ] **Step 3: Commit any fixups**

If Steps 1–2 required fixes:
```bash
git add -A && git commit -m "chore(handoff-ui): typecheck + test pass"
```
If clean, do not create an empty commit — just report the gate is green.

---

## End-to-end verification (manual — not a code task)

After merge, in a running app with two seeded operators that have distinct skill tags: have the delegator issue a `handoff_task` for skills the receiver covers, then observe (1) a receiver tab spawns in the background (no focus steal) in the delegator's workspace, (2) the executor launches and the receiver begins work, (3) the `→ Handed off to <receiver>` message in the delegator thread, and — on receiver completion — (4) the report-back returns to the delegator thread (Plan 1 behavior). This is the spec's §Testing end-to-end item; it can't be a unit test.

---

## Self-review notes

- **Spec coverage:** §Architecture (single listener delegating to reused blocks) → Task 3; §Behavior.1 background/no-focus (no focus call exists in `handleHandoffRouted`) → Task 2 (+ test asserts only spawn/attach/bind/inject, never focus); §Behavior.2 delegator-tab placement + active fallback → Task 1 (`placementForOperator`/null) + Task 2 (placement + fallback tests) + Task 3 (wiring passes null → `spawnTabForTask` active-group fallback); §Behavior.3 auto-launch executor → Task 2 (`buildInjection`/`injectLater`) + Task 3 (`buildTaskInjection` wiring, 1500ms); §Behavior.4 idempotency (handoff_id + already-spawned) → Task 2 (two tests) + Task 3 (`seenHandoffs` + `spawnMeta`); §Data flow (consume payload, no re-fetch) → Task 2; §Error handling (best-effort, no throw, abort on no sessionId) → Task 2 (three tests); §Testing frontend-unit → Tasks 1–2; §Testing e2e → manual section above. §Out-of-scope (re-engagement, Convergence graph) → not implemented, correctly.
- **Placeholder scan:** none — every code step has complete code; every run step has command + expected output.
- **Type consistency:** `HandoffRoutedEvent` fields used identically in Task 2 module, Task 2 tests, and Task 3 listener. `TabPlacement` defined in Task 1 (`manager.ts`), imported by Task 2 module and Task 3 wiring. `HandoffSpawnDeps` method names (`placementForOperator`, `spawnTab`, `attachSessionToTask`, `bindOperatorToTab`, `injectLater`, `buildInjection`, `alreadySpawned`, `recordSpawn`) match exactly between the module (Task 2), its tests (Task 2), and the wiring (Task 3). `TaskSpawnInfo` shape (`{ sessionId, cwd, groupId, color }`) used in `recordSpawn` matches the panel's existing interface exported in Task 3 Step 1.
- **Sequencing:** Task 1 (placement) and Task 2 (module) are independent; Task 3 depends on both + the panel export; Task 4 gates. This plan depends only on merged Plan 1 + skill-routing — both on `main`.
