# XP only on write/deliberate actions

**Date:** 2026-05-04
**Status:** Approved, ready for implementation plan
**Related:** Spec 3.12 (operators-experience-and-level)

## Problem

The operator XP system currently rewards every decision, including `wait`:

| Action | XP awarded |
|---|---|
| `reply` (injects bytes into the PTY) | 10 |
| `escalate` (raises a notification to the user) | 25 |
| `wait` (no-op decision) | 1 |

Awarding XP on `wait` dilutes the meaning of operator level. `wait` is the default outcome when there is nothing useful to do; an idle tab that ticks every poll cycle accumulates XP indefinitely without the operator providing any value. This inflates levels and breaks the intuition that "higher level = more applied judgment".

## Goal

XP should reflect deliberate operator actions. Only decisions that are visible to the user or alter terminal state earn XP.

## Design

### Reward table (after change)

| Action | XP |
|---|---|
| `reply`    | 10 |
| `escalate` | 25 |
| `wait`     | **0** |

`reply` writes to the PTY; `escalate` surfaces a notification — both are deliberate. `wait` is the absence of action and earns nothing.

### Implementation

Single site: `crates/app/src/operator.rs` (decision dispatch around line 1934). Remove the `"wait" => 1` arm so `wait` falls through to the `_ => 0` default.

The existing `if xp_amount > 0` guard already short-circuits the SQLite update and the `operator-xp-updated` event when no XP is awarded, so no other code paths need changes.

### Data migration

None. Existing accumulated XP is preserved as-is. Retroactively subtracting historical `wait` XP would be confusing (operators would suddenly drop levels) and provides no real benefit.

### UI / event surface

No changes. The `operator-xp-updated` event simply fires less often. The level formula (`floor(xp / 100) + 1`) is unchanged.

## Tests

Add a unit test in the existing operator test module verifying that a `wait` decision does not change the operator's XP. Existing tests for `reply` / `escalate` XP remain valid.

## Out of scope

- Rebalancing `reply` vs `escalate` values.
- Retroactive recomputation of XP from the decisions log.
- Per-mission or per-executor XP multipliers.
