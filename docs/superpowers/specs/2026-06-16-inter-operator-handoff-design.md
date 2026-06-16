# Inter-Operator Handoff — design

**Date:** 2026-06-16
**Status:** Approved (design), pending implementation plan
**Spec area:** Teammate operators + Convergence Mode (3.8). Concretizes the
operator-coordination model deferred in `docs/specs/3.2-multi-operator.md`.

---

## 1. Problem

Operators (LLM personas: Zeta, Kiro, Lia…) cannot talk to or hand work to
each other. Collaboration today is routed entirely through the human:

- A teammate `@`-mention is **reference-only** — `expandMentions` emits a
  one-liner `teammate @Name (id=…)` (`ui/src/teammate/mentions.ts:256`) and
  nothing routes to the mentioned operator.
- `propose_task`'s `executor` field is a **CLI agent** (claude/codex/…),
  never another operator (`crates/app/src/teammate/llm.rs:217`).
- The `good_delegate` achievement is defined + tested but **dormant — no
  caller** (`crates/score/src/lib.rs:217`).

Karluiz wants operators to **hand off work to each other autonomously**, with
the relationship surfaced in **Convergence Mode** (its intended home).

## 2. Decisions (locked in brainstorming)

| Axis | Decision |
|---|---|
| Interaction model | **Directed handoff** — one operator transfers concrete work to another. |
| Gating | **Autonomous** — the operator emits a handoff in AOM/Convergence with no user confirmation. Requires strong guardrails. |
| Payload | **Work assignment** — the handoff is a task w/ context; the receiver runs it with its own executor and reports back. |
| Receiver execution | **Auto-spawn a tab** for the receiver (reuses the existing task-spawn path). |
| Report-back | **Report-and-resume** — the receiver reports its result into the delegator's thread; the delegator reactivates and continues. |
| Convergence surfacing | **Tile graph** — draw live `from→to` edges between tiles. |
| Implementation approach | **A** — a new `handoff` tool + a router module inside the teammate runtime, reusing task-spawn / supervisor / AOM-wake primitives. |

## 3. Architecture (Approach A)

```
operator LLM (delegator)
  │  emits handoff_task tool call
  ▼
teammate/handoff.rs (router)            ← NEW
  ├─ safety gate (depth, cycle, concurrency, blocklist)   ← teammate/handoff_safety.rs (NEW)
  ├─ persist Handoff edge                ← storage: teammate_handoffs (NEW table)
  ├─ create receiver Task (reuse types::Task + confirm path)
  └─ emit HandoffRouted event on the session/teammate bus
        │
        ▼
  UI listener (main.ts) auto-spawns + binds receiver tab     ← reuse panel.ts spawn path + bindOperatorToTab
        │
        ▼
  receiver operator runs its executor (OperatorState::OnTask)
        │  task reaches TaskStatus::Done
        ▼
  task_supervisor.rs detects completion
        ├─ synth report TaskMessage → delegator's origin_thread_id
        ├─ mark Handoff status = Reported (+ result_summary)
        ├─ score::record_task_delegated(...)  ← lights up good_delegate
        └─ wake the delegator (reuse aom_idle_repoll path)
        │
        ▼
  delegator operator re-engages, reads result, continues/decides next step
```

Everything heavy is reused: the `Task` type, the confirm/spawn machinery
(`teammate/commands.rs`, `panel.ts`), the `task_supervisor` completion watch
+ synth-message sink, and the AOM wake (`aom_idle_repoll_due`,
`crates/app/src/operator.rs`). The **only genuinely new state** is the
`Handoff` edge + the safety gate.

## 4. Data model

One new entity — the `Handoff` edge. The work itself is an ordinary `Task`.

```rust
pub struct Handoff {
    pub id: HandoffId,              // Ulid
    pub chain_id: ChainId,          // root of the delegation chain — anti-loop key
    pub depth: u8,                  // 0 = first hop of the chain
    pub from_operator_id: OperatorId,
    pub to_operator_id:   OperatorId,
    pub task_id:        TaskId,           // task spawned on the receiver
    pub origin_task_id: Option<TaskId>,   // delegator's task (resume context)
    pub origin_thread_id: ThreadId,       // where the report-back is injected
    pub status: HandoffStatus,
    pub brief: String,                    // what was asked (delegator's text)
    pub result_summary: Option<String>,   // filled on report-back
    pub created_at_unix_ms: u64,
    pub reported_at_unix_ms: Option<u64>,
}

pub enum HandoffStatus { Running, Reported, Failed, Rejected, BlockedBySafety }
```

- `chain_id` + `depth`: every chain (Zeta→Kiro→Lia…) shares one `chain_id`;
  `depth` increments per hop. Basis for the guardrails in §8.
- **Storage:** new `teammate_handoffs` table in `crates/app/src/storage.rs`.
  No change to the `tasks` schema.
- **Provenance:** the receiver `Task` carries metadata `source = "handoff"`
  + `handoff_id`, so audit / Convergence / Score can tell delegated work from
  user-initiated work. (The `Task` struct gains a `source` discriminator or a
  metadata map; chosen during planning.)
- **No new operator state:** the receiver uses the existing
  `OperatorState::OnTask`. The `Handoff` is side metadata linking two tasks.

## 5. Handoff emission (the tool)

New operator tool `handoff_task`, registered next to `propose_task` in
`all_tool_defs` (`crates/app/src/teammate/llm.rs:524`) and handled in
`execute_tool` (`:480`). Mirrors `propose_task`'s leading-position rule.

Input schema:

```jsonc
{
  "to_operator": "Kiro",       // must resolve to a known operator ≠ self
  "brief":       "string",     // concrete work, self-contained (no raw @tokens)
  "deliverable": "string",     // what 'done' looks like
  "executor":    "codex",      // CLI the receiver should drive (same roster as propose_task)
  "context":     "string?"     // optional inlined facts (files/specs already expanded)
}
```

- System-prompt guidance (extends the existing `# Mentions in propose_task
  fields` block, `llm.rs:274`): never pass raw `@tokens`; restate concrete
  goals; pick a `to_operator` from the roster; you cannot hand off to
  yourself.
- Autonomous trigger: an operator running under AOM/Convergence may emit
  `handoff_task` on its own turn, exactly like it emits `propose_task` today
  under YOLO auto-confirm (`llm.rs:239`). No user confirmation step.
- Self-handoff and unknown-operator targets are rejected at the router (→
  `HandoffStatus::Rejected`, surfaced as an error message back to the
  delegator), not silently dropped.

## 6. Routing & receiver execution

`teammate/handoff.rs::route(handoff_request)`:

1. Resolve `to_operator` name → `OperatorId`; reject self / unknown.
2. Run the safety gate (§8). On fail → persist `BlockedBySafety`, return an
   explanatory message to the delegator, **do not** spawn anything.
3. Persist the `Handoff` edge (`Running`) + create the receiver `Task`
   (`source = handoff`) via the same inner path `propose_task` uses.
4. Emit `HandoffRouted { handoff_id, to_operator, task_id, executor }` on the
   bus.
5. UI listener in `ui/src/main.ts` reacts: spawn a tab, bind the receiver
   (`bindOperatorToTab`, `main.ts:715`), attach the spawned session to the
   task (`teammateAttachSessionToTask`), set the operator live. This reuses
   the exact path the teammate panel runs when a user confirms a task
   (`panel.ts` spawn + `bindOperatorToTab`).

**App-open requirement.** Autonomous handoff only progresses while the app is
running (operators only act in-app; the tab spawn is a frontend action). If
the app is closed there is no autonomy anyway — consistent with how AOM
already behaves. No headless execution in v1.

**Receiver busy.** The runtime models **one task per operator**
(`OperatorState::OnTask { task, session }`, `teammate/types.rs:18`). So in
v1 an operator accepts a delegated task only when **Idle**; a handoff to an
operator already `OnTask` (its own or another delegation) is `Rejected` with
a "receiver busy" message, and the delegator retries later or picks another
operator. Concurrent multi-task per operator (cap > 1) would require
per-session operator state and is a deliberate v2 extension — called out, not
assumed.

## 7. Report-back & delegator resume

When the receiver task reaches `TaskStatus::Done`, `task_supervisor.rs`
(which already watches task status and owns a synth-`TaskMessage` sink,
`:196`) additionally:

1. Looks up the `Handoff` by `task_id`; if found:
2. Builds a result summary (task deliverable + final state + cost) and injects
   it as a `Role::Operator`/system message into `origin_thread_id` (the
   delegator's thread), tagged as a handoff report.
3. Sets `Handoff.status = Reported` + `result_summary` + `reported_at`.
4. Calls `score::record_task_delegated(from_operator, task_id)`
   (`crates/score/src/lib.rs:218`) — **this lights up `good_delegate`**.
5. **Wakes the delegator**: reuses the AOM re-engagement escape hatch
   (`aom_idle_repoll_due`, `operator.rs`) so the delegator re-opens its loop,
   reads the injected report, and continues. A failed/cancelled receiver task
   maps to `HandoffStatus::Failed` and still reports back (so the delegator
   isn't left hanging).

The resume is **the same mechanism** AOM already uses to re-poll a parked
executor — we are giving it a second trigger (incoming handoff report), not
inventing a new wake path.

## 8. Guardrails / safety (`teammate/handoff_safety.rs`)

Autonomous handoff is the riskiest decision here; the gate is non-negotiable
and unit-tested, mirroring `crates/agent/src/safety.rs` discipline (removing
a check requires a justifying review comment).

- **Max chain depth** (default 4): reject when `depth >= MAX_DEPTH`. Stops
  Zeta→Kiro→Lia→… runaways.
- **Cycle detection**: walk the chain by `chain_id`; reject if `to_operator`
  already appears as a `from_operator` in the chain (no A→B→A ping-pong).
- **Receiver-idle requirement** (v1 concurrency cap = 1): reject when the
  receiver is already `OnTask` (matches the one-task-per-operator runtime).
- **Global in-flight cap** per `chain_id` (default 8): bounds a fan-out
  explosion from one root.
- **Inherited command blocklist**: the receiver's executor still runs under
  the existing exec-policy + hard blocklist (`crates/agent/src/safety.rs`);
  handoff grants no new execution authority.
- **Rate limit**: handoffs go through the same `agent::dispatch()` budget /
  per-minute caps as any agent call — never a side channel.
- Every rejection is **logged** (`tracing`, fields `handoff_id`, `chain_id`,
  `from`, `to`, `reason`) and reported back to the delegator as text, never
  silently dropped.

Defaults live in one consts block and are configurable per-operator later
(out of scope for v1).

## 9. Convergence surfacing (tile graph)

Convergence Mode (`crates/app/src/convergence.rs` + `ui/src/convergence/
overlay.ts`) gains a delegation-graph layer:

- The backend aggregator exposes active/recent `Handoff` edges alongside the
  existing per-session tiles (read-only, same 1 s snapshot poll as today).
- The overlay draws an SVG edge `from_operator_tile → to_operator_tile` per
  active handoff, labeled with status (`running` / `reported` / `failed`) and
  the brief (truncated). Reported edges fade after a short linger.
- Tiles already carry operator identity; edges connect tile centers via an
  SVG overlay above the CSS grid (no layout change to the tiles themselves).
- Empty state unchanged when there are zero handoffs (just tiles, no edges).

This is the most render-heavy piece; if it threatens the v1 timeline it can
ship one increment behind the backend handoff loop (graph data exists; the
SVG layer is additive). Called out so the slice is explicit, not silently
dropped.

## 10. Achievements tie-in

`good_delegate` (`crates/score/src/achievements.rs:556`) becomes live the
moment §7.4 fires `record_task_delegated`. No new achievement work — we are
supplying the missing production caller the dormant code was waiting for.

## 11. Out of scope (v1)

- Peer-to-peer free chat, blackboard, and orchestrator/subordinate models
  (we chose directed handoff).
- `consult`-kind handoffs (ask-for-opinion without spawning work) — payload
  is work-assignment only in v1; `kind` field is a v2 extension point.
- Per-operator handoff policy / allowlist UI (defaults are hardcoded consts).
- Headless / app-closed autonomous execution.
- Handoff from the `@`-mention UI (mention stays reference-only; the
  self-exclusion fix already shipped, commit `6ff1954`). A future "mention →
  suggest handoff" affordance is a separate spec.
- Managed session pool (we chose simple per-handoff auto-spawn).
- Receiver explicit accept/decline UX (autonomous accept; the safety gate is
  the only veto in v1).

## 12. Testing

- **Unit — safety gate** (`handoff_safety.rs`): depth ceiling, cycle
  detection (A→B→A, A→B→C→A), receiver-busy rejection, global chain cap,
  blocklist inheritance. The discipline mirror of `agent/src/safety.rs` tests.
- **Unit — router** (`handoff.rs`): self-handoff rejected, unknown operator
  rejected, happy path persists edge + creates receiver task w/ `source =
  handoff`, busy receiver → `Rejected` with message.
- **Unit — supervisor report-back** (`task_supervisor.rs`): on receiver
  `Done`, injects report into `origin_thread_id`, sets `Reported` +
  `result_summary`, calls `record_task_delegated`, triggers wake; on
  `Cancelled` → `Failed` still reports.
- **Unit — storage**: `teammate_handoffs` round-trip + edge queries for the
  graph.
- **Frontend — overlay** (`overlay.test.ts`): given N handoff edges, renders N
  SVG connectors with correct status classes; zero edges → no connectors.
- **Frontend — auto-spawn listener** (`main.ts`): `HandoffRouted` event →
  spawn + `bindOperatorToTab` + attach-session called once, idempotent on
  duplicate events.
- **Score**: `good_delegate` unlock end-to-end once `record_task_delegated`
  is wired (the existing dormant-path test at `achievements.rs:667` already
  asserts the fact targets the achievement).

## 13. Risks / open questions

- **Resume reliability.** Report-and-resume leans on the AOM wake; if the
  delegator's executor has drifted (renamed comm, ghost prompts — see
  existing operator quirks) the wake must still fire. Mitigation: the report
  is a persisted thread message, so even a missed wake leaves an auditable
  result the user can act on.
- **`Task.source` shape.** Whether to add a typed `source` enum to `Task` or
  a generic metadata map — decided in planning; affects the storage
  migration.
- **Graph edge anchoring** when a tile scrolls out of the ~12-tile visible
  cap (Convergence virtualization is itself deferred). v1: only draw edges
  between visible tiles; off-screen handoffs still appear in the per-tile
  badge fallback.
- **Cost attribution.** Delegated task cost accrues to the receiver's
  `Task.cost_usd_cents`; whether the delegator's chain shows an aggregate
  rollup is a v2 nicety.

## 14. File-touch map

| Area | File | Change |
|---|---|---|
| Tool def + dispatch | `crates/app/src/teammate/llm.rs` | add `handoff_task` def + execute branch + prompt guidance |
| Router | `crates/app/src/teammate/handoff.rs` | NEW — resolve, gate, persist, create task, emit event |
| Safety | `crates/app/src/teammate/handoff_safety.rs` | NEW — depth/cycle/cap/blocklist gate + tests |
| Types | `crates/app/src/teammate/types.rs` | `Handoff`, `HandoffStatus`, ids; `Task.source` |
| Report-back | `crates/app/src/teammate/task_supervisor.rs` | on Done: inject report, set Reported, score, wake |
| Wake | `crates/app/src/operator.rs` | second trigger into `aom_idle_repoll` path |
| Storage | `crates/app/src/storage.rs` | `teammate_handoffs` table + queries |
| Convergence data | `crates/app/src/convergence.rs` | expose handoff edges |
| Score caller | (wired from supervisor) `crates/score/src/lib.rs:218` | call `record_task_delegated` |
| Auto-spawn | `ui/src/main.ts` | `HandoffRouted` listener → spawn + bind + attach |
| Graph render | `ui/src/convergence/overlay.ts` (+ `.test.ts`) | SVG edge layer |
| Styles | `ui/src/styles.css` | edge connector styling |
```
