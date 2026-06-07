# Mission Control: per-operator Stop + kill floating toasts

**Date:** 2026-06-07
**Status:** Approved (design)

## Problem

Floating operator-decision toasts (the `aom-feed` cards, e.g. `…WE6JN9
ESCALATED` / `WOULD-TYPE (DRY-RUN)`) appear over the workspace with no way to
tell which tab/group/workspace they came from — they print only the last 6
chars of the session ULID and are not actionable. Operators run **per session**,
so a manually-armed operator on a tab in a collapsed group of another workspace
keeps ticking and toasting, with the user unable to locate or silence it.

Separately, **Mission Control** (the Convergence overlay, `ui/src/convergence/`)
already aggregates every operator across all tabs and can focus/reply, but has
**no way to shut a single operator down** without navigating to its tab.

## Goals

1. Stop floating operator toasts entirely. Operator decisions surface only in
   pull-based UI: Mission Control (roster) and the teammate panel Activity tab.
2. Add a per-operator **Stop** control in Mission Control that disables the
   operator on its session(s) without leaving the current workspace.

## Non-goals

- No backend changes. The `set_operator_enabled(session_id, enabled)` command
  (`crates/app/src/lib.rs:875`) and its `api.ts` wrapper `setOperatorEnabled`
  (`ui/src/api.ts:165`) already exist.
- No "close tab" / kill-tab action.
- No per-sub-row stop for multi-session operators (header Stop covers all).
- No settings toggle for toasts — they are removed, not made optional.
- The operator `att.enabled` re-check race (escalations leaking from an
  in-flight tick after disable, `operator.rs:~1948`) is a **separate** fix,
  tracked independently.

## Design

### 1. Kill floating toasts

`AomActivityFeed` (`ui/src/aom/activity-feed.ts`) keeps its event listeners
(`operator-decision`, `operator-startup-action`) and its dedup / `lastWait`
bookkeeping so other behavior is untouched, but **`pushCard` becomes a no-op**
(early return). Nothing floats over the workspace. The class remains a thin
event sink; Mission Control and the Activity tab — which consume the same
events independently — are the only surfaces.

No event-shape changes. No change to the `suppress` flag's other consumers.

### 2. Per-operator Stop in Mission Control

Add a **Stop** button to each operator card header in
`ui/src/convergence/tile.ts` (`renderHeader`), beside the status pill / tab
button.

- Wire a new callback `onStop(operatorId, sessionIds: string[])` through
  `CardCallbacks` (same pattern as `onFocus` / `onSubmit`).
- Single-session operator → Stop disables that one session.
- Multi-session operator → header Stop disables **all** the operator's sessions
  (loop `setOperatorEnabled(sid, false)` over `entry.sessions`).
- The overlay (`ui/src/convergence/overlay.ts`) supplies `onStop`, calling
  `setOperatorEnabled` for each session id, then triggers a refresh (the 1s
  poll also covers this). Disabled sessions are inert and drop out of the
  roster snapshot, so the card disappears / the operator goes idle — no
  optimistic UI required.
- Stop has a confirm affordance appropriate to a destructive-ish action
  (e.g. button shows a brief "Stop?" confirm state, or relies on the
  reversibility note below). Reversible: ⌘O on the tab re-arms.

## Data flow

```
operator tick → operator-decision event ──► AomActivityFeed (no-op, dropped)
                                          └► Activity tab (sidebar)
                                          └► (Mission Control polls roster, not this event)

Mission Control roster (poll getConvergenceSnapshot, 1s)
   └ Stop click → setOperatorEnabled(sid,false) ×N → next poll drops the card
```

## Testing

- Manual: arm an operator on a tab, open Mission Control, click Stop → operator
  card leaves roster within ~1s; tab stays open; no floating toast appears at
  any point.
- Multi-session operator: Stop disables all sessions in one click.
- Verify no `aom-feed` card ever renders (floating feed silent).

## Files touched

- `ui/src/aom/activity-feed.ts` — `pushCard` no-op.
- `ui/src/convergence/tile.ts` — Stop button + `onStop` in `CardCallbacks`.
- `ui/src/convergence/overlay.ts` — supply `onStop` → `setOperatorEnabled`.
- (`ui/src/api.ts`, `crates/app/src/lib.rs` — already in place, no change.)
