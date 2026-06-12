# Solo Autonomous Mode — Design

**Date:** 2026-06-06
**Status:** Approved (pending spec review)

## Problem

Global AOM (`Cmd+Shift+A`) flips *every* operator-enabled tab into autonomous
posture at once. There's no way to arm a *single* operator autonomously while
leaving the rest in their normal suggest/escalate posture. The user wants to
start one operator in full autonomous mode on its own.

## Key insight

The autonomy machinery is already per-session at the gate. In `run_tick`
(`crates/app/src/operator.rs`):

```rust
let effective_aom = aom_active && !aom_excluded;   // line ~1909
let live = per_tab_live || effective_aom;          // line ~1910
```

`effective_aom` (not the global `AomState.enabled`) is what actually drives:

- AOM directive injection (prompt build, ~3559, currently passed `aom_active`)
- decisions_count increment (~3069)
- triage + call cost accumulation (~2317, ~2501)
- `live` → auto-execute of REPLY actions

So "full AOM for one tab" = make `effective_aom` true for just that tab. No new
autonomy pipeline; we widen one boolean.

## Decisions (locked)

- **Behavior:** full AOM treatment scoped to the tab (directive, proactive
  startup actions, decisions_count, cost accounting) — not bare auto-execute.
- **Budget:** share the global pot (`AomState` stays the single accounting
  sink). Lazily initialize the pot when the first autonomy session starts.
- **Lifetime:** **ephemeral** — solo state is runtime-only. A reload/restart
  clears it; an autonomous operator never silently resumes acting unattended.
- **Shortcut:** `Cmd+Shift+S` (S = solo/single), distinct from global
  `Cmd+Shift+A`. No Select-All collision.
- **Triggers:** both the shortcut *and* an operator-chip context-menu item.

## Design

### 1. Backend state — one new per-tab bool

Add `solo_aom: bool` to the `Attached` struct (`crates/app/src/operator.rs`).
**Not persisted** to the tab manifest (ephemeral). Defaults to `false`.

Widen the gate at ~1909:

```rust
let effective_aom = (aom_active || solo_aom) && !aom_excluded;
```

`aom_excluded` still wins, keeping per-tab opt-out semantics coherent. The
candidate snapshot at ~1822 gains `att.solo_aom`. The prompt build at ~3559
should be passed `effective_aom` (the per-tab value) rather than the global
`aom_active`, so a solo tab gets the directive and a global-AOM-but-excluded
tab correctly does not.

### 2. Budget — shared global pot, factored init

Cost accumulation already keys off `effective_aom`, so it works when the global
banner is off. The only gap: the cost cap at ~2504 checks `a.budget_usd`, which
is 0 until some autonomy session initializes it.

Extract the budget-init block from `aom_start` (`lib.rs:1390-1397` +
`aom_session_start` row) into a helper:

```rust
async fn ensure_autonomy_pot(state, settings) -> ()  // idempotent
```

- If no autonomy is currently active (global AOM off AND no other solo tab),
  set `budget_usd`/reset `accumulated_cost_usd`/`started_at_unix_ms` from
  settings and open an `aom_session_start` row.
- If a pot is already live, no-op (piggyback).

Both `aom_start` and `operator_solo_start` call it, so there's no drift. Track
solo tab count (or scan sessions for `solo_aom`) to answer "any solo active?".

### 3. Startup actions, scoped

`queue_aom_startup_actions()` is all-sessions. Extract the per-session body into
`queue_aom_startup_actions_for(session_id)`; the existing all-sessions version
loops over it. Solo start calls the scoped version for its tab only.

### 4. Commands

```rust
operator_solo_start(session_id)  // set solo_aom=true; ensure_autonomy_pot;
                                  // queue_aom_startup_actions_for(session);
                                  // if !att.enabled { enable + enabled_by_aom }
operator_solo_stop(session_id)   // clear solo_aom; revert enabled_by_aom for
                                  // this tab; leave pot alone if global AOM or
                                  // other solo tabs still active
operator_solo_status(session_id) -> bool   // for chip menu + reload-safe UI
```

Wrapped in `ui/src/api.ts` as a single `toggleSolo(sessionId)` (reads status,
calls start/stop) plus `soloStatus(sessionId)`.

### 5. Triggers

- **Keybinding:** `Cmd+Shift+S` handler in `ui/src/main.ts`, placed next to the
  existing `Cmd+Shift+A` block. Toggles solo on the focused tab's session.
- **Operator chip menu:** context-menu item "Go autonomous (this tab)" /
  "Stop autonomous", reflecting current solo status. Both paths call
  `toggleSolo`.

### 6. Visual indicator

No global banner for solo. The operator chip on the solo tab gets an
"autonomous" accent — reuse the existing live/AOM chip treatment. This keeps
solo visually distinct from global AOM (which owns the top banner).

## Scope guards (YAGNI)

- No separate solo budget UI; solo shares the global cap/counter.
- No solo morning-report split; decisions land in the same `aom_session` row.
- No multi-tab orchestration; each tab independently toggles solo.
- No persistence; ephemeral by decision.

## Files touched

- `crates/app/src/operator.rs` — `Attached.solo_aom`; gate at ~1909; candidate
  snapshot ~1822; prompt build arg ~3559;
  `queue_aom_startup_actions_for`.
- `crates/app/src/lib.rs` — `ensure_autonomy_pot` helper; `operator_solo_start`
  / `operator_solo_stop` / `operator_solo_status` commands; register them.
- `crates/app/src/aom.rs` — (if needed) helper to count active solo sessions.
- `ui/src/api.ts` — `toggleSolo`, `soloStatus`.
- `ui/src/main.ts` — `Cmd+Shift+S` handler.
- operator chip component (context menu + autonomous accent).

## Testing

- Unit: gate logic — `solo_aom=true, aom_excluded=true` ⇒ `effective_aom=false`
  (exclusion wins); `solo_aom=true, global off` ⇒ `effective_aom=true`.
- Unit: `ensure_autonomy_pot` idempotency — second call with a live pot no-ops;
  first call sets budget from settings.
- Unit: `operator_solo_stop` leaves the pot intact while global AOM is on.
- Manual: `Cmd+Shift+S` on a tab arms one operator; other tabs stay manual;
  reload clears solo (ephemeral); chip menu reflects status; cost accrues to the
  shared pot and the global cap halts the solo tab.
