# Workspace Keep-Alive — Design

**Date:** 2026-05-22
**Status:** Draft, awaiting review
**Branch:** `worktree-workspace-keepalive`

## Problem

Switching workspaces today calls `WorkspaceManager.switchTo` → `TabManager.replaceFromManifest`, which kills the outgoing workspace's PTYs and respawns the incoming workspace's PTYs from its serialized manifest. State (tab list, cwd) is preserved on disk, but **shell processes die**. Long-running commands (`cargo build`, `tail -f`, dev servers) are interrupted every time the user changes workspace.

This also conflicts with the project's north star: the super-agent is meant to observe all open sessions concurrently. Today, switching workspaces effectively hides them from the agent because their `Session` instances cease to exist.

## Goals

1. Switching workspaces does not kill PTYs of the previously-active workspace.
2. Background workspaces keep producing output; their `Session` instances stay alive in the Rust backend and continue to emit events on the bus.
3. The super-agent keeps observing background workspaces without any additional plumbing.
4. Resource usage is bounded: at most N (default 5) workspaces are kept "live" simultaneously; the rest hibernate (PTYs killed, scrollback serialized).
5. Activity in background workspaces surfaces to the user via badges on the workspace chips.

## Non-Goals

- Reviving the actual processes of a hibernated workspace. Hibernation kills PTYs; rehydration respawns fresh shells. The scrollback shown on rehydrate is cosmetic (a snapshot of the last live state) and is **not** labeled as such — the user accepted this trade-off.
- Restoring all workspaces as "live" on app launch. Only the last-active workspace boots into the live pool; others sit in hibernated-on-disk state until visited.
- Snapshotting PTY scrollback to disk for hibernated workspaces (in-memory only is fine; on app exit, only the active set persists their scrollback).

## Decisions (locked in during brainstorm)

| Topic                          | Decision                                                                 |
| ------------------------------ | ------------------------------------------------------------------------ |
| Background process behavior    | PTYs of inactive workspaces stay alive (full keep-alive).               |
| Agent scope                    | Super-agent observes all live workspaces, not just the visible one.     |
| Resource bound                 | LRU with default `live_limit = 5`; configurable [1..20].                |
| Hibernation strategy           | Serialize scrollback to memory, kill PTYs, drop TabManager instance.   |
| Rehydration UX                 | Reprint serialized scrollback at top of each tab; **no indicator**.    |
| Activity surface               | Per-chip badge: counter for new finished blocks; red dot if any failure. |
| Output chunks                  | Do NOT increment badge — only `BlockFinished` events do.                |
| Agent-targeted notifications   | Surface as a distinct icon on the chip; click → switch + open panel.    |
| App restart                    | Only last-active workspace rehydrates at boot; rest stay hibernated.    |

## Architecture

### Today

```
WorkspaceManager
  └── tabManager: TabManager   (singleton; one set of live PTYs)
        └── sessions...
```

`switchTo` calls `tabManager.replaceFromManifest(target)` → kills current sessions, spawns target sessions.

### Proposed

```
WorkspaceManager
  ├── liveManagers: Map<WorkspaceId, TabManager>   (≤ live_limit entries)
  ├── liveOrder: WorkspaceId[]                     (LRU; head = most recently active)
  └── activeId: WorkspaceId

each TabManager
  ├── sessions (PTYs alive, even when workspace is inactive)
  ├── xterm instances (mounted only for active workspace; detached for others)
  └── activityState { unseenBlocks: number, hasFailure: boolean, hasAgentNote: boolean }
```

Key invariants:

- The Rust-side `Session` objects of **every** workspace in `liveManagers` exist and are draining their PTYs. Their events flow on the global bus, unchanged.
- xterm.js instances of inactive workspaces are **detached from the DOM** (or in a hidden offscreen container) but still subscribed to their `OutputChunk` events. They buffer state internally so reattaching is instantaneous.
- Only the active workspace's container is visible in the main terminal area.

### Switching workspaces (no teardown)

`switchTo(id)` becomes:

1. If `id === activeId` → return.
2. If `liveManagers.has(id)`:
   - Detach active workspace's xterm container from DOM (no PTY teardown).
   - Reset target's `activityState` (counters → 0, flags → false).
   - Attach target's xterm container.
   - Update `activeId`, bump `liveOrder`.
3. Else (target is hibernated):
   - If `liveManagers.size === live_limit`, **hibernate** the LRU entry (see below).
   - Create new `TabManager`, call `replaceFromManifest(target)` to spawn its PTYs (this is the same path used today; preserves cwd, command history reattach, etc.).
   - On the new TabManager, prepend serialized scrollback (if any) into each tab before user interaction.
   - Insert into `liveManagers`, attach to DOM, update `activeId`/`liveOrder`.
4. Emit change.

### Hibernation

`hibernate(id)`:

1. For each tab in the workspace's TabManager: read xterm scrollback into a string (use existing buffer; xterm `serialize` addon if needed).
2. Persist scrollback to that workspace's in-memory record (`hibernatedScrollback: Map<TabId, string>`).
3. Call `tabManager.dispose()` → kills all PTYs (need a new method; today this happens implicitly inside `replaceFromManifest`).
4. Remove from `liveManagers` and `liveOrder`.
5. Workspace is now "hibernated": manifest still on disk, scrollback in memory; no PTYs, no TabManager.

### Rehydration

When the user switches to a hibernated workspace, step 3 of `switchTo` runs. The serialized scrollback (if present in memory) is reprinted into each newly-spawned terminal as the first thing the user sees. No banner, no label.

If the user restarts the app, scrollback is lost (in-memory only), and rehydration just spawns fresh shells with empty terminals — same as a brand-new workspace today.

## Activity tracking

Each non-active `TabManager` keeps an `activityState`:

```ts
interface ActivityState {
  unseenBlocks: number;     // count of BlockFinished events while inactive
  hasFailure: boolean;      // any block finished with exit_code !== 0
  hasAgentNote: boolean;    // AgentAction::Notify targeted at this workspace
}
```

Subscriptions:

- `BlockFinished` → `unseenBlocks++`; if `exit_code !== 0` set `hasFailure = true`.
- Agent notify event for this workspace → `hasAgentNote = true`.
- `OutputChunk` → ignored (do not contribute to badge).

Reset: on becoming active, all three fields reset to zero/false.

### Chip rendering

In the workspace sidebar chip:

- `hasFailure === true` → red dot (no number).
- Else if `hasAgentNote === true` → small agent glyph (distinct from neutral dot).
- Else if `unseenBlocks > 0` → neutral dot + count.
- Else → no indicator.

For hibernated workspaces, the badge state is frozen at whatever it was at hibernation time, and resets on rehydrate.

## Agent integration

The super-agent already subscribes at the bus level in the Rust backend and is workspace-agnostic. Because background workspaces' `Session` objects remain alive, no additional code is required for the agent to observe them.

Hibernation: when a workspace's PTYs are killed, the agent naturally stops receiving events from those sessions. The rolling summary for that workspace is **retained** in the world-model (not evicted), so when the user rehydrates and runs new commands, the agent still has context. Eviction from the world-model only happens when a workspace is **deleted** by the user.

`AgentAction::Notify { session, ... }` aimed at a session in a non-active workspace is routed to that workspace's `activityState.hasAgentNote = true`. Click on the agent glyph in the chip switches to that workspace and opens the agent panel scrolled to the relevant message.

## Persistence

App exit:

- Persist every workspace's manifest (already happens).
- Additionally: for each **live** workspace, persist its current scrollback alongside its manifest entry, so rehydration looks identical regardless of whether the user is reopening the same session or rehydrating mid-session.
- Hibernated workspaces persist their last-known scrollback as well, since it already lives in `hibernatedScrollback`.

App boot:

- Read all workspaces from disk. None are placed in `liveManagers` initially.
- Rehydrate **only** the workspace that was last active (`activeId` from previous session). All others wait until the user visits them.

## Settings

New key in user settings:

```
workspace.live_limit: number   // default 5, min 1, max 20
```

When the user lowers the limit and the current `liveManagers.size` exceeds the new value, hibernate LRU entries down to the new limit immediately.

## Files likely to change

- `ui/src/workspaces/manager.ts` — replace singleton `tabManager` with `liveManagers` map; add LRU + hibernate/rehydrate; rework `switchTo`.
- `ui/src/tabs/manager.ts` — add `dispose()` that tears down all PTYs cleanly (today this is implicit in `replaceFromManifest`); add `serializeScrollback()` and `restoreScrollback()` helpers.
- `ui/src/workspaces/switcher.ts` / sidebar chip renderer — render the new badge variants.
- `ui/src/settings/*` — expose `workspace.live_limit`.
- Tests:
  - `ui/src/workspaces/manager.test.ts` — switch preserves PTY identity; LRU eviction triggers hibernate; rehydrate restores scrollback.
  - New: activity badge counter math, agent-note routing.

No Rust changes are anticipated for the keep-alive itself, since `Session` objects already outlive any particular UI binding. (Verify during implementation: confirm `Session` is not GC'd by the backend when its xterm detaches.)

## Open questions deferred to plan stage

- Exact mechanism for detached xterm.js instances — keep them in a hidden DOM container vs. fully unmounted with a serialized buffer? Performance characteristics differ; pick during implementation with measurements.
- Whether `hibernatedScrollback` should be capped (e.g. last 10k lines per tab) to bound memory.
- Migration of existing on-disk workspace manifests (likely no schema change needed; scrollback is purely additive in-memory state).

## Success criteria

- Starting `cargo build` in workspace A, switching to B, and back to A shows the build still running with full output captured.
- Opening a 6th workspace while 5 are live transparently hibernates the LRU one; switching back to it within the same app session shows its last scrollback at the top and a fresh prompt below.
- A failing test in a background workspace surfaces as a red dot on its chip within 1s of the block finishing.
- Super-agent's ⌘K panel can answer "what's happening in workspace B?" while the user is in workspace A.
