# Operator Awareness — terrain collision brake

**Date:** 2026-07-30
**Status:** implemented — revised 2026-07-30 after the whole-branch review
**Related:** `docs/superpowers/specs/2026-07-28-group-supervision-design.md`

> **Revision note.** Sections 1–4 below describe the SHIPPED mechanism, which
> differs from what this document originally specified. The original spec was
> defective in three ways the final review caught, and every difference is
> governed by one asymmetry: **failing to brake is the harm.** Failing to
> re-arm, braking twice, or one redundant toast are all acceptable prices.
>
> | Originally specified | Why it was wrong | What ships |
> |---|---|---|
> | Brake edge-triggered on terrain vs. a `braked: HashSet` | The set records what we *announced*, not what is *true*. Any re-arm (detach/re-attach, an Intervene click, an emit with no listener, a failed per-pane IPC) silenced the brake permanently on the very terrain it exists for. | Level-triggered on `collision && decides()`. `braked` is only a re-arm marker + duplicate-toast stamp. |
> | Sessions git can't resolve are "skipped" | Indistinguishable from safe terrain, and a transient git failure actively UN-braked a correctly braked group. | Three-way resolution; unknown ≠ clean; a re-arm needs a *complete* survey. |
> | `EscalationKind::Blocked` (no new variant) with `Reply` + `Snooze` | A Telegram free-text `Reply` is typed straight into that session's PTY, and the 120s coalescer keys on `(session, kind)` — so a brake could overwrite a live executor's real question. | New `EscalationKind::TerrainCollision`, `Snooze` only. |
> | PTY world models are the cwd source | ACP tabs are in `session_groups` but have no world model, so a mixed group under-counted. The motivating incident was four Claude tabs, possibly ACP. | ACP registry fallback; a member neither source knows is *unresolvable*, not absent. |

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
struct Collision { root: PathBuf, sessions: Vec<SessionId> }

/// Two executors editing one working tree clobber each other regardless of
/// branch. Pure — takes already-resolved toplevels so the test needs no git.
fn terrain_collision(roots: &[(SessionId, PathBuf)]) -> Option<Collision>;
```

It returns the LOWEST colliding root by path order (the candidates are sorted
before the pick, so the answer is deterministic). One collision is enough to
brake the whole group.

**Resolution is three-way, and that is the load-bearing part.** Each member's
cwd goes through `git rev-parse --show-toplevel` and lands on one of:

```rust
enum RootResolution {
    Resolved(PathBuf), // git answered: this is the working tree
    NotARepo,          // git answered: not inside a repo — definite, clean
    Unresolvable,      // we do not know
}
```

`Unresolvable` covers git missing from a GUI-launched `.app`'s minimal PATH, a
cwd that no longer exists, a non-zero exit that isn't "not a git repository",
non-UTF8 output, a member no registry knows a cwd for, and a panicked
`spawn_blocking` hop. Every one of those used to collapse to "no root", i.e.
*safe terrain*. The survey therefore carries a `complete` flag alongside the
roots, and **a re-arm requires `complete`**: unknown is never clean. Each
unresolvable member is `tracing::warn!`ed with structured `session` / `group` /
`cwd` fields.

**Cwd sources are two.** PTY sessions carry it on `SessionWorldModel.cwd` via
`inner.worlds`. ACP sessions have no entry there at all — `attach()` is only
called from the PTY `spawn_session` path — so they fall back to
`AcpRegistry::cwd_of`. Without that fallback a group of one PTY tab and two ACP
tabs in one checkout showed *one* root and never braked.

**Where it runs.** In `watch_loop`, on every debounced wake, **before** the
`SimpleRate` gate — not inside `check_for_pattern`. `SimpleRate` is global
(6/min across all groups) and sized for LLM spend; the brake costs no model
call, just a git shell-out and an emit. Behind the gate, a busy sibling group
could starve a colliding group's brake for minutes while its supervisor kept
deciding. The model-calling `check_for_pattern` stays after the gate.

Cost is bounded by a cwd→toplevel memo (`ROOT_MEMO_CAP`, clear-on-overflow)
now that the check runs on every wake. **Only definite answers are cached** —
an `Unresolvable` is retried each tick, so a transient git failure can't freeze
a group's terrain at "unknown".

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

`panesForIntervene` — the pure eligibility filter both the manual toggle and
the automatic re-arm go through — additionally excludes panes that are
`operatorEnabled` *without* `supervisorAom`, i.e. panes the USER armed. Claiming
one flags it `supervisorAom`, and the next unapply then turns the user's own AOM
off. That hole predates awareness for the manual toggle, but the automatic
re-arm reaches it with no user action at all, which would break this document's
own "user-armed AOM untouched" promise.

### 3. Notification

The brake announces itself through the escalation lane, which since the
2026-07-29 attach-is-decide change is the only path to a "needs you" toast:

`SessionEvent::EscalationRequested` on the trigger session, with `operator` set
to the supervisor's `OperatorRef`, and `project` derived from **the resolved
collision root** (not the trigger session's cwd — the old `"."` fallback ran git
in the app process's cwd, `/` for a bundled `.app`, and attributed the brake to
the wrong repo or to "unknown"; it also spawned a second, redundant
`git rev-parse`).

**`kind: EscalationKind::TerrainCollision`** — its own variant, not `Blocked`.
Telegram coalesces outbound pings on `(session_id, kind_key(kind))` within
120s, and the brake fires off an `AgentIdleWaiting` turn, exactly when AOM has
likely just posted its own `Blocked` escalation for that session. Sharing the
key made the brake **edit that message in place**, replacing the executor's real
question with the brake text while keeping the old keyboard.

**Actions: `Snooze { minutes: 10 }` only — never `Reply`.** A Telegram free-text
reply to an open escalation is written straight into that session's PTY (see
`lib.rs`'s inbound drain), so a user answering "why?" to a brake notice would
submit that sentence to a live executor standing on the shared tree. A brake is
an announcement, not a question.

Summary text (the operator's name is *not* in it — the toast host already
prefixes `operator_name`, and both together read "Zeta: Zeta stepped back"):

> stepped back — 4 sessions share the covenant working tree (main).
> Supervision is now observe-only.

### 4. Dedup and re-arm

`inner.braked` is a `HashMap<String, Instant>` keyed by group id. It does **not**
drive the brake — it records what we *announced*, which is not what is *true*.
Its two jobs are to mark which groups this path may re-arm, and to hold the
stamp that suppresses a duplicate toast within `BRAKE_REPEAT_GRACE` (15s) while
the frontend round-trips the downgrade.

The decision is one pure function, `terrain_verdict(colliding, complete,
decides, braked_since, now)`:

| Terrain | Supervisor | Marker | Verdict |
|---|---|---|---|
| colliding | decides | none, or stamp older than the grace | **Brake** |
| colliding | decides | stamped within the grace | Quiet (repeat suppressed) |
| colliding | observes | any | Quiet — the downgrade landed; keep the marker |
| clean, complete | observes | ours | **ReArm** |
| clean, complete | decides | ours | Forget — the user re-armed it himself |
| clean, **incomplete** | any | ours | Quiet — unknown is not clean |
| clean | any | none | Quiet — never restore what we did not suspend |

Braking is level-triggered and self-limiting: a landed downgrade makes
`decides()` false on the next tick, so the brake stops firing on its own without
ever depending on a memory of having fired. The grace window can only ever
*delay* a repeat by one window; it can never cancel a brake.

Re-arming is deliberately stricter than braking — clean terrain, a complete
survey, and a brake of ours to undo. This does not contradict the 2026-07-28
decision to leave migrated groups observe-only: there, flipping stored groups
would have armed autonomy nobody asked for; here the principal armed it and we
suspended it.

Stale markers cannot suppress a brake (nothing reads `braked` to decide one),
and they are pruned two ways: `Forget` when the user re-armed by hand, and a
removal on any tick whose trigger session has no supervisor left.

## Testing

Pure unit tests in `group_supervision.rs`, no git and no fixtures:

- `terrain_collision`: three sessions, two sharing a root → `Some` naming those
  two; all distinct → `None`; a lone session → `None`.
- `brake_is_level_triggered_not_edge_triggered` — the critical regression: a
  colliding group whose supervisor is deciding brakes **even when it was braked
  before**.
- `a_repeat_inside_the_grace_window_is_suppressed_but_not_cancelled`.
- `an_unresolvable_member_never_produces_a_rearm` and
  `unresolvable_members_do_not_read_as_clean_terrain`.
- `never_rearms_a_group_the_user_downgraded_himself`.
- `acp_sessions_count_toward_a_collision` (via the pure `merge_cwds`) and
  `a_member_no_registry_knows_is_unresolvable_not_absent`.
- `brake_message_names_repo_and_branch_but_never_the_operator`.

Frontend (`ui/src/tabs/manager.test.ts`): `panesForIntervene` never claims a
pane the user armed AOM on, and stays idempotent for panes already ours.

## Known ceiling

Braking returns the group to observe-only, and in observe-only `watcher_owns`
lets the watcher resume a model call per idle turn. Braking therefore costs
*more* model calls, not fewer. Acceptable because the IDLE prompt no longer
reports pending questions as findings (the 2026-07-29 fix), but this is the
first place to look if toast noise returns on a braked group. Carried in-code
as a `ponytail:` comment at the brake site.

Three more, recorded by the final re-review and deliberately left standing.
None is load-bearing — nothing else in the design rests on them — but the
first two fail in the harmful direction, so they are the places to look first
if the brake ever seems not to fire.

**An all-unresolvable group never brakes.** `Unresolvable` members are dropped
from the root set, so they cannot collide with each other. If `git` is missing
from the app's PATH — a real risk for a GUI-launched `.app`, whose PATH is
minimal — every member resolves to `Unresolvable`, the survey is incomplete
(so nothing re-arms, correctly) but nothing brakes either; the only trace is
the per-member `tracing::warn!`. Braking on unknown was considered and not
taken: it would brake every supervised group on a machine where git cannot be
found, including groups whose sessions are not in a repo at all. Revisit by
distinguishing "git itself is unavailable" (a process-wide fact, worth
braking on) from "this one cwd could not be resolved".

**Dropping `Reply` gates the affordance, not the path.** The brake's
escalation offers only `Snooze`, so no reply button is rendered. But
`send_escalation` registers every escalation in `session_map` regardless of
its action list, and any Telegram reply to a still-open escalation is routed
as `FreeText` and written into that session's PTY. A user who replies to a
brake notice by other means still injects text into a live executor standing
on the shared tree. Pre-existing for every escalation kind, not introduced
here; closing it means gating on the kind at the inbound router.

**The cwd→toplevel memo can mask a collision.** Only definite answers are
cached and the memo is per-process, but a session's toplevel can change under
a live app (a nested `git init`, a worktree conversion) and the stale entry
would hide the resulting collision until restart.
