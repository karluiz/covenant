# Operator Awareness — terrain collision brake

**Date:** 2026-07-30
**Status:** design approved, not implemented
**Related:** `docs/superpowers/specs/2026-07-28-group-supervision-design.md`

## Why

A supervisor operator (Zeta) was attached to a group of four Claude tabs. All
four ran in the **same working tree** — the repo's main worktree, on `main`,
no isolation. Supervision behaved exactly as specified and the principal still
felt he had lost control, because the thing that made the situation dangerous
was never modelled anywhere: `group_supervision.rs` does not mention git in a
single line. A supervisor today decides for executors without knowing what
ground they stand on.

Four executors editing one working tree clobber each other regardless of
branch. That is not a supervision failure to detect at runtime — it is a
precondition that makes autonomous supervision unsafe in the first place.

Per the ontology in AGENTS.md: an operator is a projection of the principal's
judgment. The principal would not have let four executors run unisolated on
one tree. An operator that permits it is not projecting his criterion.

## What awareness is

Awareness is not a flag. It is **how supervision behaves**: a supervisor never
holds decision authority over executors that share a working tree.

Rejected alternative: `awareness_enabled` as a fourth per-operator capability
next to `perception_enabled` / `supervision_enabled`. Rejected because it would
default to off — meaning the exact incident that motivated this design would
recur with every newly created operator — and because it contradicts the
`crates/agent/src/safety.rs` doctrine: adding safety never needs a flag,
removing it needs a review.

The operator is still named in the outcome. The escalation is attributed to
the supervisor by name, so awareness reads as that operator's judgment, not as
an anonymous system rule.

## Scope

One rule: **working-tree collision**. Two or more live sessions in a supervised
group resolving to the same git toplevel.

Explicitly out of scope for v1:

- Protected branch (`main`/`master`) on its own — a single session on `main` is
  ordinary work; firing there would be noise.
- Dirty shared tree as a separate signal.
- Sessions outside any git repo.
- Perception and user-armed AOM: those are the principal's own decisions, not
  the supervisor's authority. Untouched.
- Moving sessions into worktrees, or gating spawns.

## Design

### 1. Detection

In `crates/app/src/group_supervision.rs`:

```rust
struct Collision {
    root: PathBuf,
    sessions: Vec<SessionId>,
}

/// Two executors editing one working tree clobber each other regardless of
/// branch. Pure — takes already-resolved toplevels so the test needs no git.
fn terrain_collision(roots: &[(SessionId, PathBuf)]) -> Option<Collision>;
```

The caller resolves each member's toplevel by shelling out to
`git rev-parse --show-toplevel` from `SessionWorldModel.cwd`, which `run_check`
already holds via `inner.worlds`. Sessions whose cwd is not in a repo are
skipped (no root, no collision).

Trigger: inside `run_check`, immediately before the `watcher_owns` gate
(around line 356). No new wake source — the watcher already fires on every
member idle/failure and is capped at `MAX_CHECKS_PER_MINUTE`.

Cost: one `git rev-parse` per member per wake. Acceptable at 6 checks/min.
Caching by cwd string is a later optimization, not part of v1.

### 2. Brake

When a collision is present and the group is in deciding mode:

- Backend emits a Tauri event `group-supervision-braked` carrying
  `{ group_id, root, sessions, operator_id, operator_name, braked: true }`.
- The frontend listens and calls the **existing** `TabManager.setGroupIntervene(groupId, false)`.
  That already: reverts every `supervisorAom`-flagged pane (never a pane where
  the user enabled AOM himself), writes `supervisor_intervene: false` through
  `groupSetSupervisor`, repaints the tabbar, and schedules a manifest save. The
  backend's own `decides()` therefore converges through the same round-trip
  that the UI already uses — the FE manifest stays the single source of truth.
  Frontend cost: one listener, ~6 lines.

The supervisor **stays attached**. It loses authority, not its post. The UI
label becomes "Observes only" through the existing path.

### 3. Notification

The brake announces itself through the escalation lane, which since the
2026-07-29 attach-is-decide change is the only path to a "needs you" toast:

`SessionEvent::EscalationRequested` on the trigger session, with
`kind: EscalationKind::Blocked` (no new variant), `operator` set to the
supervisor's `OperatorRef`, and `project` derived from the session cwd via
`project_ref_from_cwd` so the toast names repo and branch.

Summary text, e.g.:

> Zeta stepped back — 4 sessions share the covenant working tree (main).
> Supervision is now observe-only.

Actions: the standard `Reply` + `Snooze { minutes: 10 }` pair used by
`Blocked` escalations elsewhere.

### 4. Dedup and re-arm

The watcher's `inner` gains `braked: HashSet<String>` keyed by group id. It is
required regardless, to keep the brake from re-firing on every wake.

Given that set, re-arming is one extra branch: when a check finds clean terrain
and the group is in `braked`, emit the same event with `braked: false` and
remove it from the set; the frontend calls `setGroupIntervene(groupId, true)`.

This does not contradict the 2026-07-28 decision to leave migrated groups
observe-only. There, flipping stored groups would have armed autonomy nobody
asked for. Here, the principal armed it and we suspended it; restoring it
returns the state he chose.

A group the user manually downgrades is not in `braked`, so it is never
re-armed by this path.

## Testing

One unit test on `terrain_collision`: three sessions, two sharing a root →
`Some` naming those two; all three distinct → `None`. Pure function, no git,
no fixtures.

## Known ceiling

Braking returns the group to observe-only, and in observe-only `watcher_owns`
lets the watcher resume a model call per idle turn. Braking therefore costs
*more* model calls, not fewer. Acceptable because the IDLE prompt no longer
reports pending questions as findings (the 2026-07-29 fix), but this is the
first place to look if toast noise returns on a braked group. Carried in-code
as a `ponytail:` comment at the brake site.
