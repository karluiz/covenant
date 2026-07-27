# Convergence Rework — Agent Fleet Mission Control

**Date:** 2026-07-27
**Status:** Approved (brainstorm artifact: options A→D→B, phased)
**Owner surfaces:** `ui/src/convergence/`, `crates/app/src/convergence.rs`, `crates/app/src/notch.rs`, `crates/app/src/acp_commands.rs`

## Problem

Convergence (⌘⇧M) shows one card per **operator**. The entry ticket is
`SessionInput.operator_id` — `convergence.rs:351` drops any session without
one. Today the real fleet is agent sessions that mostly have no operator:
spawned agent tabs in worktrees, ACP chat tabs, and raw `claude`/`codex`
runs in plain terminals. Result: five agents working, overlay says
"Nothing to converge".

## Insight the design builds on

`NotchHub` (`crates/app/src/notch.rs`) is **already** the unified per-session
phase aggregator across both lanes:

- **PTY lane** — sessions `register()` a bus; `ingest()` runs
  `ExecutorPhaseDetector` over bytes and tracks the foreground `agent`
  name (`claude`, `codex`, `copilot`, `pi`, `hermes`, …). `agent == None`
  means plain shell → not an agent session.
- **ACP lane** — ACP tabs `register_external(session, executor)` and push
  phases via `acp_event_to_phase()` (`acp_commands.rs:51`), which already
  maps `permission_pending → ExecutorPhase::Waiting { reason: "permission" }`
  and tool_calls → Running/Writing/Reading.

Both lanes converge on `karl_session::ExecutorPhase`
(Idle · Thinking · Running · Writing · Reading · Waiting · Done), readable
per session via `NotchHub::phase_snapshot()`. The rework is therefore a
**union + regrouping**, not new instrumentation.

## Architecture

One data model, three phases shipped in order. Each phase is independently
shippable and committable.

The snapshot unit changes from `OperatorRosterEntry` (operator → sessions)
to a flat list of **agent cards**; the operator demotes from door to badge.

```rust
// crates/app/src/convergence.rs
#[derive(Debug, Clone, Serialize)]
pub struct AgentCard {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    /// Which lane produced this card. Frontend uses it for the reply
    /// affordance (PTY write vs ACP message) and a small lane glyph.
    pub lane: Lane,                    // Pty | Acp
    /// Executor name from NotchHub ("claude", "codex", …).
    pub executor: String,
    pub status: TileStatus,            // derived from ExecutorPhase (see mapping)
    /// Human line under the title: phase detail ("writing overlay.ts",
    /// "running cargo test", "waiting: permission").
    pub phase_label: Option<String>,
    pub cwd: Option<String>,
    /// Operator badge — all None when no operator is enabled on the tab.
    pub operator_id: Option<String>,
    pub operator_name: Option<String>,
    pub operator_avatar: Option<String>,
    pub cost_usd: Option<f64>,         // operator lane only, as today
    pub mission_name: Option<String>,
    /// P3: live sub-agents (empty until P3 ships).
    pub subagents: Vec<SubAgentRow>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ConvergenceSnapshot {
    pub agents: Vec<AgentCard>,
    /// P1: today's `Vec<EscalationCard>`, unchanged.
    /// P2: replaced by `Vec<AttentionItem>` (unified queue).
    pub escalations: Vec<EscalationCard>,
}
```

### ExecutorPhase → TileStatus mapping

Pure function, unit-tested, lives in `convergence.rs`:

| ExecutorPhase | TileStatus | Rationale |
|---|---|---|
| Thinking | working | Agents don't get `operator-thinking`; that state stays operator-only (decided: brainstorm Q2) |
| Running / Writing / Reading | working | |
| Waiting { reason } | blocked | Needs the human — feeds the attention queue |
| Done | awaiting-input | Turn finished, agent wants the next instruction |
| Idle | idle | |

Operator-enabled sessions keep today's richer classifier
(`decide_status` over byte activity + decisions); the phase mapping is the
fallback for operator-less agents. When both exist, operator status wins
(it sees escalations the phase detector can't).

---

## P1 — Substrate: every agent is a card (Option A)

### Backend

1. `TabHint` gains `lane: Option<String>` ("pty" | "acp") so the frontend
   can pass ACP panes; backend also self-serves: a hint whose session id is
   registered in `AcpSessionRegistry` is ACP regardless of the field.
2. `build_convergence_snapshot` builds cards in two passes:
   - For each tab hint, `notch_hub.phase_snapshot(session_id)`:
     - `None` or `agent == None` **and** no operator → skip (plain shell).
     - Else emit an `AgentCard` with phase-mapped status.
   - Operator-enabled sessions overlay their operator fields + status from
     the existing classifier path (reusing today's `BuiltRow` internals).
3. Escalation cards keep working exactly as today; they populate
   `attention` (operator source only, until P2).
4. Sessions leave the snapshot naturally: executor exits → NotchHub
   foreground flips to `None` → card drops (no staleness timer needed;
   decided: brainstorm Q4).

### Frontend

1. `sessionHintsFromTabs` (`ui/src/convergence/hints.ts`) also emits a hint
   per ACP pane using its `acpSessionId` (today only PTY panes with
   `sessionId` contribute).
2. `tile.ts`: `renderOperatorCard` → `renderAgentCard`. Header: executor
   name + lane glyph + tab title; status pill unchanged; operator becomes a
   headphones badge when present. Body line = `phase_label`.
3. `model.ts`: sorting becomes flat — blocked first (oldest first), then
   status priority, then title. Filters (`all / needs you / working /
   idle`) unchanged in behavior.
4. Empty state rewritten: no ⌘O instruction; explains that any tab running
   an executor (or ACP chat) appears automatically.
5. Summary strip counts agents, not operators.

### Out of scope for P1

Sub-agents, unified attention (beyond existing escalations), push updates,
group-by-worktree. Poll stays at 1s while the overlay is open (decided:
brainstorm Q3).

---

## P2 — Attention inbox: "needs you" is the top of the overlay (Option D)

### Data

```rust
#[derive(Debug, Clone, Serialize)]
pub struct AttentionItem {
    pub session_id: String,
    pub tab_title: String,
    pub executor: String,
    pub lane: Lane,
    pub kind: AttentionKind,          // AcpPermission | PtyWaiting | OperatorEscalation
    /// What's being asked. ACP: tool title + command; PTY: waiting reason;
    /// operator: decision rationale (today's `question`).
    pub question: Option<String>,
    /// Raw context: ACP → pending tool rawInput summary; PTY/operator →
    /// last ~15 non-empty lines of the screen (existing
    /// `last_non_empty_lines` over scrollback tail).
    pub excerpt: Option<String>,
    /// ACP only: the pending permission's request_key + options, so the
    /// card can answer inline.
    pub permission: Option<PendingPermission>, // { request_key, options: Vec<{option_id, kind, label}> }
    pub since_unix_ms: u64,
}
```

Sources, all existing plumbing:

- **AcpPermission** — `AcpTabSession` records its currently-pending
  permission request (request_key, tool call fields, options, asked-at)
  when the forwarder emits `permission_pending`, clears it on
  `acp_respond_permission` / Perception auto-answer. New small field on the
  tab session; the registry exposes `pending_attention()`.
- **PtyWaiting** — any card whose phase is `Waiting`; excerpt from
  scrollback tail.
- **OperatorEscalation** — today's `EscalationCard`, reshaped.

### UI

- The overlay's top section becomes the attention queue (replaces the
  current escalation-only treatment). Ordered oldest-first.
- Inline actions per kind:
  - ACP: one button per permission option (allow once / always / deny) →
    `acp_respond_permission`; plus a reply box → `acp_send_prompt`.
  - PTY: reply box → writes to the PTY (existing
    `submit_convergence_reply` path) + "jump to tab".
  - Operator: today's reply + scope UI, unchanged.
- The "needs you" filter chip scrolls to / focuses the queue instead of
  filtering cards.
- Working/idle cards render below as a denser grid (they lose vertical
  priority, not information).

### Risk noted from brainstorm

PTY question extraction is heuristic — the card must always show the
screen excerpt (as escalations do today) so the user replies with context.
No auto-parsing of PTY prompts into structured options.

---

## P3 — Depth: sub-agents (Option B)

### ACP lane (full fidelity)

- Classify `tool_call` / `tool_call_update` frames as sub-agent rows when
  the tool is an agent spawn (claude-acp: `Task` tool — match on tool
  title/kind and `rawInput.subagent_type`; keep the predicate in one
  tested function).
- `SubAgentRow { id, label, detail, running: bool, started_unix_ms }`,
  accumulated on `AcpTabSession` (bounded: last 8; completed rows kept
  until turn end).
- Card expands (existing expand affordance) to show rows: label, current
  detail from the latest update, elapsed.

### PTY lane (best-effort, honest)

- Extend `ExecutorPhaseDetector` with recognition of Claude Code's Task
  spinner lines → a running-subagent **count only**. Card shows
  "N subagents active", no per-row detail. If detection proves too noisy
  in practice, ship ACP-only and keep the count at 0 — the UI hides the
  affordance when `subagents` is empty.

### Rollup

Parent status is unaffected by children (children are the parent's work).
No recursive nesting — one level, matching reality.

---

## Deferred (explicitly not in this spec)

- **Group-by-worktree (Option C)** — becomes a group-by toggle on the card
  grid later; needs no architectural provision now beyond `cwd` on the card.
- **Push updates** — 1s poll while open is retained; revisit if P2 feels
  laggy.
- **Spawns-chip absorption** — separate decision after P1 ships.
- **Cost for operator-less agents** — no per-agent token accounting exists;
  stays `None`.

## Error handling

Lanes degrade independently: an ACP registry lock failure or a missing
NotchHub entry drops that card, never the snapshot (same last-good +
"reconnecting…" behavior the overlay has today).

## Testing

- `convergence.rs`: phase→status mapping table test; snapshot assembly with
  mixed lanes (pty-only, acp-only, operator-overlay, plain-shell-skipped).
- `acp_commands.rs`: pending-permission record/clear lifecycle; sub-agent
  classifier (P3).
- `executor_phase.rs`: Task spinner count detection (P3).
- `ui/src/convergence/`: model sort/filter tests updated to flat cards;
  tile render test for operator badge present/absent; hints test for ACP
  panes.
- Existing escalation tests keep passing through P1 (reshaped in P2).
