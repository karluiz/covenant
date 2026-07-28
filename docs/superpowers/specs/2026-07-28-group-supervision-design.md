# Group Supervision — Design Spec

**Date:** 2026-07-28
**Status:** Approved for planning
**Approach:** A — registry fallback + phased delivery (no backend group registry)

## Problem

Operators can only be pinned to a single pane (`pane.operator` → `registry.pins: HashMap<SessionId, OperatorId>`). Real work happens in tab groups spanning several tabs, and there is no way to leave one operator watching a whole group. Groups today are a frontend construct — `groupId` reaches the backend only as a notes/commands scope key and the `COVENANT_GROUP_ID` env var.

## Concept

**Supervision is an operator capability** (a per-operator flag, like `perception_enabled`). An operator with the capability can be *attached to a tab group* as its **supervisor**. Semantics agreed:

- **Driver wins.** On tabs with their own pinned operator, the supervisor only observes/correlates — it never auto-answers or intervenes there. On unpinned tabs, the supervisor acts.
- **Observe by default, intervene opt-in.** Attaching enables group perception + cross-tab correlation. PTY intervention (group AOM) requires an explicit per-group toggle. `aomExcluded` per pane is always respected. The hard blocklist always applies.

## Data model

### Operator (`crates/app/src/operator_registry.rs`)

- New field `supervision_enabled: bool` on `Operator`, default `false`, editable in the operator editor next to the perception toggle. Only operators with the flag appear in the supervisor picker.

### Frontend (`ui/src/tabs/manager.ts`)

- `TabGroup` gains `supervisorId: string | null` and `supervisorIntervene: boolean`.
- Persisted in `SerializedGroup` — the tab manifest is the durable copy, mirroring how pane pins persist.

### Backend (in-memory, in the operator registry — same pattern as `pins`)

```rust
pub struct GroupSupervision {
    pub operator: OperatorId,
    pub intervene: bool,
}

group_supervisors: RwLock<HashMap<String /* group_id */, GroupSupervision>>,
session_groups:    RwLock<HashMap<SessionId, String /* group_id */>>,
```

No server-side group registry: the backend knows only these mappings, never the group itself (name, color, tabs stay FE-owned).

### Sync (FE → BE)

Two new Tauri commands, wrapped in `ui/src/api.ts`:

- `group_set_supervisor(group_id, operator_id: Option<OperatorId>, intervene: bool)` — attach, detach (`None`), and intervene toggle.
- `session_set_group(session_id, group_id: Option<String>)` — membership sync.

FE call sites: boot/workspace restore, supervisor attach/detach, intervene toggle, spawn-in-group, tab moved into/out of a group, tab close, group destroy/ungroup.

## Phase 1 — Group perception

One resolution change: `effective_for(session_id)` (and the panic-free `perception_enabled_for`) goes from `pin → default` to:

```
pin → group supervisor (via session_groups → group_supervisors) → default
```

- Both perception lanes (ACP `PermissionPending` in `acp_commands.rs`, PTY `AgentIdleWaiting` in `pty_perception.rs`) already resolve through these functions — **zero changes in the lanes**.
- The supervisor's own `perception_enabled` flag still gates whether it auto-answers, exactly as for a pinned operator.
- The existing `perceptionOperator` dotted chip already attributes who answered.
- Driver wins by construction: a pinned pane never reaches the fallback.

## Phase 2 — Cross-tab correlation

New runtime `GroupSupervisor` (module beside `teammate/task_supervisor.rs`, same shape):

- Consumes the existing aggregated `SessionEvent` bus (`supervisor_bus`), filters events by `session_groups` membership. Groups without a supervisor cost nothing.
- On significant events (`BlockFinished` with `exit_code != 0`, debounced ~500ms), builds context from the group members' `SessionWorldModel`s (already maintained per session) plus the supervisor's soul, and dispatches through `agent::dispatch()` — existing rate limits and token guardrails apply.
- Output: **notifications/suggestions only**, attributed to the supervisor, through the existing notify pipeline. This phase never writes to a PTY.
- Correlation covers *all* group sessions, including pinned ones (observing is allowed everywhere; acting is not).

## Phase 3 — Group intervention (opt-in)

Per-group `intervene` toggle, default off.

- When toggled on, the FE enables the **existing** AOM loop on every pane in the group that (a) has no own pin and (b) is not `aomExcluded`. The effective operator resolves to the supervisor via the Phase 1 fallback.
- No second execution loop: same `operator.rs` tick, same gates, the supervisor's `hard_constraints` compile into the extra denylist, blocklist always enforced.
- New tab joins the group → coverage applies automatically. A pin is added to a covered tab → the supervisor withdraws from that pane automatically (fallback no longer reached; FE disables its AOM enablement for that pane).
- Toggling off (or detach) disables AOM on every pane the supervisor had enabled.

## UI

- **Group context menu:** "Attach supervisor…" → operator picker filtered to `supervision_enabled` operators; once attached, the same menu offers the Intervene toggle and Detach.
- **Group header:** supervisor chip (inline SVG, standard operator styling — the supervisor *is* an operator).
- Nothing new per tab — the existing dotted perception chip is the only per-tab trace.
- **Operator editor:** Supervision capability toggle next to Perception.

## Edge cases

| Event | Behavior |
|---|---|
| Tab moved out of the group | `session_set_group(session, null)`; supervisor releases it; AOM disabled if intervene had enabled it |
| Group destroyed / ungrouped | Detach: clear supervision, disable any supervisor-enabled AOM |
| Supervisor operator deleted, or loses `supervision_enabled` | FE clears `supervisorId`, syncs detach |
| Split panes (2 panes, 1 tab) | Both sessions inherit the tab's group; each pane's own pin/`aomExcluded` evaluated independently |
| Pin removed from a group tab | Pane falls back to the supervisor automatically; if intervene is on, coverage starts |

## Testing

- **Rust:** `effective_for` fallback chain (pin > supervisor > default); `group_set_supervisor` / `session_set_group` behavior; `GroupSupervisor` filters events to its group; Phase 3 gates (pinned and `aomExcluded` panes never touched).
- **Vitest:** `SerializedGroup` round-trip for `supervisorId`/`supervisorIntervene`; membership sync on move/close/destroy; supervisor picker filters by capability.

## Out of scope

- Backend-first-class groups (`GroupId` newtype, server-side group registry) — approach B, deferred until something else needs it.
- Supervisor-to-driver handoff (supervisor feeding findings into a driver's mind) — noted as a possible Phase 4, not designed here.
- Multiple supervisors per group; supervising ungrouped tabs or whole workspaces.
