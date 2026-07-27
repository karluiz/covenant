# Convergence P1 — Agent Substrate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convergence (⌘⇧M) shows one card per agent session (PTY executors + ACP tabs), operator demoted from entry ticket to badge.

**Architecture:** `NotchHub` already aggregates `ExecutorPhase` for both lanes (PTY via `ingest`, ACP via `acp_event_to_phase` → `set_phase`). The backend snapshot builder unions three sources — operator-enabled PTY sessions (rich path, unchanged), operator-less PTY sessions with a detected foreground agent, and ACP registry sessions — into a flat `Vec<AgentCard>`. Frontend drops the operator-grouping layer and renders flat cards.

**Tech Stack:** Rust (crate `covenant`, `crates/app`), TypeScript strict + Vitest (`ui/src`), no new deps.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-27-convergence-rework-design.md` (P1 section only — no attention inbox, no sub-agents, no push; `subagents` field NOT added until P3).
- `TileStatus` enum unchanged; `operator-thinking` remains operator-only.
- Escalations stay operator-only in P1; agent-lane `Waiting` maps to `blocked` status but produces NO `EscalationCard`.
- `get_blocked_session_ids` (tab-strip dots) must keep returning operator escalation ids only.
- Rust: no `unwrap()` outside tests; UI: sharp corners, no emoji glyphs (SVG/text only), English copy.
- Run Rust tests as `cargo test -p covenant --lib convergence` (broad `cargo test` hangs on telegram tests — known).
- Run frontend tests from repo ROOT: `npx vitest run ui/src/convergence`.

## File Structure

- `crates/app/src/convergence.rs` — mapping fns, `Lane`, `AgentCard`, reshaped snapshot + builder (stays one file; it's the whole feature's backend).
- `crates/app/src/acp_commands.rs` — one new `AcpRegistry::list_meta()` accessor.
- `crates/app/src/lib.rs` — `build_convergence_inputs` fetches notch phases + ACP inputs.
- `ui/src/api.ts` — type reshape.
- `ui/src/convergence/hints.ts` — ACP panes contribute hints.
- `ui/src/convergence/model.ts` — flat sort/filter.
- `ui/src/convergence/tile.ts` — `renderAgentCard`.
- `ui/src/convergence/overlay.ts` — flat render, summary, empty state.
- `ui/src/styles.css` — small additions (`.mc-card__exec`, `.mc-oplabel`).

---

### Task 1: Backend phase mapping (`Lane`, `phase_to_status`, `phase_label`)

**Files:**
- Modify: `crates/app/src/convergence.rs` (top of file + tests module)

**Interfaces:**
- Produces: `pub enum Lane { Pty, Acp }` (serialize kebab-case → `"pty"`/`"acp"`), `pub fn phase_to_status(&ExecutorPhase) -> TileStatus`, `pub fn phase_label(&ExecutorPhase) -> Option<String>`.
- Consumes: `karl_session::ExecutorPhase` (re-export of `karl_blocks::executor_phase::ExecutorPhase`).

- [x] **Step 1: Write the failing tests** (append inside `mod tests`)

```rust
#[test]
fn phase_to_status_table() {
    use karl_session::ExecutorPhase as P;
    assert_eq!(phase_to_status(&P::Thinking), TileStatus::Working);
    assert_eq!(phase_to_status(&P::Running { cmd: "cargo test".into() }), TileStatus::Working);
    assert_eq!(phase_to_status(&P::Writing { file: "a.rs".into() }), TileStatus::Working);
    assert_eq!(phase_to_status(&P::Reading { file: "a.rs".into() }), TileStatus::Working);
    assert_eq!(phase_to_status(&P::Waiting { reason: "permission".into() }), TileStatus::Blocked);
    assert_eq!(phase_to_status(&P::Done { summary: None }), TileStatus::AwaitingInput);
    assert_eq!(phase_to_status(&P::Idle), TileStatus::Idle);
}

#[test]
fn phase_label_table() {
    use karl_session::ExecutorPhase as P;
    assert_eq!(phase_label(&P::Idle), None);
    assert_eq!(phase_label(&P::Thinking).as_deref(), Some("thinking"));
    assert_eq!(phase_label(&P::Running { cmd: "cargo test".into() }).as_deref(), Some("running cargo test"));
    assert_eq!(phase_label(&P::Writing { file: "a.rs".into() }).as_deref(), Some("writing a.rs"));
    assert_eq!(phase_label(&P::Reading { file: "a.rs".into() }).as_deref(), Some("reading a.rs"));
    assert_eq!(phase_label(&P::Waiting { reason: "permission".into() }).as_deref(), Some("waiting: permission"));
    assert_eq!(phase_label(&P::Done { summary: Some("2 files".into()) }).as_deref(), Some("2 files"));
    assert_eq!(phase_label(&P::Done { summary: None }).as_deref(), Some("done"));
}
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p covenant --lib convergence::tests::phase`
Expected: compile error — `phase_to_status` not found.

- [x] **Step 3: Implement** (near `detect_vendor`)

```rust
use karl_session::ExecutorPhase;

/// Which lane produced an agent card.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum Lane {
    Pty,
    Acp,
}

/// Phase→status mapping for operator-less agent sessions (spec P1 table).
/// Thinking is `Working` — `OperatorThinking` stays operator-only.
pub fn phase_to_status(p: &ExecutorPhase) -> TileStatus {
    match p {
        ExecutorPhase::Thinking
        | ExecutorPhase::Running { .. }
        | ExecutorPhase::Writing { .. }
        | ExecutorPhase::Reading { .. } => TileStatus::Working,
        ExecutorPhase::Waiting { .. } => TileStatus::Blocked,
        ExecutorPhase::Done { .. } => TileStatus::AwaitingInput,
        ExecutorPhase::Idle => TileStatus::Idle,
    }
}

/// Human line under the card title ("writing overlay.ts").
pub fn phase_label(p: &ExecutorPhase) -> Option<String> {
    match p {
        ExecutorPhase::Idle => None,
        ExecutorPhase::Thinking => Some("thinking".into()),
        ExecutorPhase::Running { cmd } => Some(format!("running {cmd}")),
        ExecutorPhase::Writing { file } => Some(format!("writing {file}")),
        ExecutorPhase::Reading { file } => Some(format!("reading {file}")),
        ExecutorPhase::Waiting { reason } => Some(format!("waiting: {reason}")),
        ExecutorPhase::Done { summary } => summary.clone().or_else(|| Some("done".into())),
    }
}
```

- [x] **Step 4: Run to verify pass**

Run: `cargo test -p covenant --lib convergence::tests::phase`
Expected: 2 passed.

- [x] **Step 5: Commit**

```bash
git add crates/app/src/convergence.rs
git commit -m "feat(convergence): Lane enum + ExecutorPhase→TileStatus mapping"
```

---

### Task 2: `AgentCard` + reshaped snapshot assembly

**Files:**
- Modify: `crates/app/src/convergence.rs`

**Interfaces:**
- Produces:

```rust
#[derive(Debug, Clone, Serialize)]
pub struct AgentCard {
    pub session_id: String,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub lane: Lane,
    /// NotchHub foreground agent / ACP executor ("claude", "codex", …).
    pub executor: Option<String>,
    pub status: TileStatus,
    pub phase_label: Option<String>,
    pub cwd: Option<String>,
    pub vendor: Vendor,
    pub raw_command_label: Option<String>,
    pub last_command: Option<String>,
    pub last_output_line: Option<String>,
    pub mission_name: Option<String>,
    /// Operator badge — all None when no operator is enabled on the tab.
    pub operator_id: Option<String>,
    pub operator_name: Option<String>,
    pub operator_avatar: Option<String>,
    pub cost_usd: Option<f64>,
    pub budget_usd: Option<f64>,
}

pub struct ConvergenceSnapshot { pub agents: Vec<AgentCard>, pub escalations: Vec<EscalationCard> }
pub struct BuiltRow {
    pub card: AgentCard,
    pub escalated_at_unix_ms: u64,
    pub executor_excerpt: Option<String>,
    /// Operator's open question (decision escalation/rationale) — feeds
    /// EscalationCard.question; not carried on the card itself.
    pub question: Option<String>,
}
pub fn assemble_snapshot(op_rows: Vec<BuiltRow>, agent_cards: Vec<AgentCard>) -> ConvergenceSnapshot
```

- `SessionSummary` and `OperatorRosterEntry` structs are DELETED. `EscalationCard` unchanged.

- [x] **Step 1: Rewrite the assembly tests.** Delete roster-based tests in `mod tests` that construct `SessionSummary`/`OperatorRosterEntry` (`assemble_*` tests). Add:

```rust
fn card(sid: &str, status: TileStatus, op: Option<&str>) -> AgentCard {
    AgentCard {
        session_id: sid.into(),
        tab_title: format!("tab-{sid}"),
        tab_color: None,
        lane: Lane::Pty,
        executor: Some("claude".into()),
        status,
        phase_label: None,
        cwd: None,
        vendor: Vendor::Claude,
        raw_command_label: None,
        last_command: None,
        last_output_line: None,
        mission_name: None,
        operator_id: op.map(Into::into),
        operator_name: op.map(|o| format!("op-{o}")),
        operator_avatar: None,
        cost_usd: None,
        budget_usd: None,
    }
}

#[test]
fn assemble_concats_operator_rows_then_agent_cards() {
    let op = BuiltRow { card: card("a", TileStatus::Working, Some("o1")), escalated_at_unix_ms: 0, executor_excerpt: None };
    let snap = assemble_snapshot(vec![op], vec![card("b", TileStatus::Idle, None)]);
    assert_eq!(snap.agents.len(), 2);
    assert!(snap.escalations.is_empty());
}

#[test]
fn assemble_builds_escalations_from_blocked_operator_rows_only() {
    let blocked_op = BuiltRow {
        card: card("a", TileStatus::Blocked, Some("o1")),
        escalated_at_unix_ms: 200,
        executor_excerpt: Some("tail".into()),
    };
    let older = BuiltRow {
        card: card("b", TileStatus::Blocked, Some("o2")),
        escalated_at_unix_ms: 100,
        executor_excerpt: None,
    };
    // Agent-lane blocked (Waiting) produces NO escalation in P1.
    let snap = assemble_snapshot(vec![blocked_op, older], vec![card("c", TileStatus::Blocked, None)]);
    assert_eq!(snap.escalations.len(), 2);
    assert_eq!(snap.escalations[0].session_id, "b"); // oldest first
    assert_eq!(snap.escalations[1].executor_excerpt.as_deref(), Some("tail"));
}
```

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p covenant --lib convergence`
Expected: compile errors (old structs referenced / new not found).

- [x] **Step 3: Implement.** Replace `SessionSummary`/`OperatorRosterEntry` with `AgentCard`; reshape `ConvergenceSnapshot`; `BuiltRow` becomes `{ card, escalated_at_unix_ms, executor_excerpt }`; rewrite `assemble_snapshot`:

```rust
pub fn assemble_snapshot(op_rows: Vec<BuiltRow>, agent_cards: Vec<AgentCard>) -> ConvergenceSnapshot {
    let mut escalations: Vec<EscalationCard> = op_rows
        .iter()
        .filter(|b| matches!(b.card.status, TileStatus::Blocked))
        .map(|b| EscalationCard {
            session_id: b.card.session_id.clone(),
            tab_title: b.card.tab_title.clone(),
            tab_color: b.card.tab_color.clone(),
            operator_id: b.card.operator_id.clone().unwrap_or_default(),
            operator_name: b.card.operator_name.clone().unwrap_or_default(),
            operator_avatar: b.card.operator_avatar.clone(),
            vendor: b.card.vendor,
            raw_command_label: b.card.raw_command_label.clone(),
            question: b.question.clone(),
            executor_excerpt: b.executor_excerpt.clone(),
            mission_name: b.card.mission_name.clone(),
            escalated_at_unix_ms: b.escalated_at_unix_ms,
        })
        .collect();
    escalations.sort_by_key(|e| e.escalated_at_unix_ms);
    let mut agents: Vec<AgentCard> = op_rows.into_iter().map(|b| b.card).collect();
    agents.extend(agent_cards);
    ConvergenceSnapshot { agents, escalations }
}
```

`question` note: `SessionSummary.last_decision_rationale` disappears with the struct; the operator's open question rides `BuiltRow.question` (set from `decision_question(row)` in the builder). Update the two tests to set `question: None`.

Keep `build_convergence_snapshot` compiling by adapting its `summary` construction to `AgentCard` (operator path fields: `lane: Lane::Pty`, `executor: None` for now — Task 3 wires the real value, `phase_label: None`, `cwd: None`) and passing `vec![]` as `agent_cards`.

- [x] **Step 4: Run to verify pass**

Run: `cargo test -p covenant --lib convergence`
Expected: all convergence tests pass (phase tests + new assemble tests + untouched classifier tests).

- [x] **Step 5: Check nothing else referenced the deleted structs**

Run: `cargo check -p covenant 2>&1 | head -30`
Expected: only errors in `lib.rs` if any (fixed in Task 3). If `lib.rs` breaks on `SessionSummary`, patch minimally there now so the tree compiles (rename field access to `card`).

- [x] **Step 6: Commit**

```bash
git add crates/app/src/convergence.rs crates/app/src/lib.rs
git commit -m "feat(convergence): AgentCard flat snapshot, escalations operator-only"
```

---

### Task 3: Union the three lanes in the builder + wire commands

**Files:**
- Modify: `crates/app/src/convergence.rs` (`SessionInput`, new `AcpSessionInput`, `build_convergence_snapshot`)
- Modify: `crates/app/src/acp_commands.rs` (`AcpRegistry::list_meta`)
- Modify: `crates/app/src/lib.rs` (`build_convergence_inputs`, both command call sites)

**Interfaces:**
- Consumes: `NotchHub::phase_snapshot(SessionId) -> Option<(ExecutorPhase, Option<String>)>` (`state.notch_hub`), `AcpRegistry` (`state.acp_sessions`), Task 1/2 types.
- Produces:

```rust
// convergence.rs — SessionInput gains two fields:
pub notch_phase: Option<ExecutorPhase>,
pub notch_agent: Option<String>,

pub struct AcpSessionInput {
    pub session_id: SessionId,
    pub executor: String,
    pub cwd: Option<String>,
    pub tab_title: String,
    pub tab_color: Option<String>,
    pub notch_phase: Option<ExecutorPhase>,
    pub operator_id: Option<String>,
    pub operator_name: Option<String>,
    pub operator_avatar: Option<String>,
}

pub async fn build_convergence_snapshot(
    sessions: Vec<SessionInput>,
    acp_sessions: Vec<AcpSessionInput>,
    operator: &OperatorWatcher,
    storage: &Storage,
    aom: &AomHandle,
) -> ConvergenceSnapshot

// acp_commands.rs:
impl AcpRegistry {
    /// (session_id, executor, cwd) per live ACP tab, for Convergence.
    pub async fn list_meta(&self) -> Vec<(SessionId, String, Option<String>)>
}
```

- [x] **Step 1: Write failing test for the operator-less PTY gate** (pure part — extract card building for a non-operator PTY session into a testable fn):

```rust
#[test]
fn pty_agent_card_requires_foreground_agent() {
    use karl_session::ExecutorPhase as P;
    // plain shell: no foreground agent → no card
    assert!(pty_agent_card("s1", "tab", None, None, Some(P::Idle)).is_none());
    // claude running → card with mapped status + label
    let c = pty_agent_card("s1", "tab", None, Some("claude".into()), Some(P::Writing { file: "a.rs".into() }))
        .expect("card");
    assert_eq!(c.status, TileStatus::Working);
    assert_eq!(c.phase_label.as_deref(), Some("writing a.rs"));
    assert_eq!(c.executor.as_deref(), Some("claude"));
    assert!(matches!(c.lane, Lane::Pty));
}
```

with signature `fn pty_agent_card(session_id: &str, tab_title: &str, tab_color: Option<String>, notch_agent: Option<String>, notch_phase: Option<ExecutorPhase>) -> Option<AgentCard>`.

- [x] **Step 2: Run to verify failure**

Run: `cargo test -p covenant --lib convergence::tests::pty_agent`
Expected: compile error — `pty_agent_card` not found.

- [x] **Step 3: Implement.**

`pty_agent_card` (public in convergence.rs):

```rust
/// Card for an operator-less PTY session. `None` unless NotchHub sees a
/// foreground agent (plain shells stay out of Convergence).
pub fn pty_agent_card(
    session_id: &str,
    tab_title: &str,
    tab_color: Option<String>,
    notch_agent: Option<String>,
    notch_phase: Option<ExecutorPhase>,
) -> Option<AgentCard> {
    let agent = notch_agent?;
    let phase = notch_phase.unwrap_or(ExecutorPhase::Idle);
    Some(AgentCard {
        session_id: session_id.into(),
        tab_title: tab_title.into(),
        tab_color,
        lane: Lane::Pty,
        executor: Some(agent),
        status: phase_to_status(&phase),
        phase_label: phase_label(&phase),
        cwd: None,
        vendor: Vendor::Unknown,
        raw_command_label: None,
        last_command: None,
        last_output_line: None,
        mission_name: None,
        operator_id: None,
        operator_name: None,
        operator_avatar: None,
        cost_usd: None,
        budget_usd: None,
    })
}
```

`acp_agent_card(inp: AcpSessionInput) -> AgentCard` (same shape; `lane: Lane::Acp`, `executor: Some(inp.executor)`, `cwd: inp.cwd`, operator badge fields copied, phase defaulting to Idle).

Builder loop changes in `build_convergence_snapshot`:
- Operator path (`operator_id == Some`): unchanged rich logic, but set `executor: s.notch_agent.clone()`, `phase_label: s.notch_phase.as_ref().and_then(phase_label)`, `lane: Lane::Pty`.
- `else` branch (was `continue`): `if let Some(c) = pty_agent_card(&id_str, &s.tab_title, s.tab_color.clone(), s.notch_agent.clone(), s.notch_phase.clone()) { agent_cards.push(c); }`.
- After the loop: `agent_cards.extend(acp_sessions.into_iter().map(acp_agent_card));`
- Return `assemble_snapshot(built, agent_cards)`.

`AcpRegistry::list_meta` in acp_commands.rs:

```rust
/// (session_id, executor, cwd) per live ACP tab — Convergence card inputs.
pub async fn list_meta(&self) -> Vec<(SessionId, String, Option<String>)> {
    let g = self.inner.lock().await;
    g.iter()
        .map(|(id, tab)| (*id, tab.executor.clone(), Some(tab.cwd.to_string_lossy().into_owned())))
        .collect()
}
```

`lib.rs build_convergence_inputs` — new signature returns both vecs:

```rust
async fn build_convergence_inputs(
    state: &State<'_, AppState>,
    registry: &std::sync::Arc<crate::operator_registry::OperatorRegistry>,
    tab_hints: Vec<convergence::TabHint>,
) -> (Vec<convergence::SessionInput>, Vec<convergence::AcpSessionInput>) {
    // existing by_id map + PTY loop, plus per session:
    //   let (notch_phase, notch_agent) = match state.notch_hub.phase_snapshot(*id).await {
    //       Some((p, a)) => (Some(p), a),
    //       None => (None, None),
    //   };
    // ACP loop:
    //   for (id, executor, cwd) in state.acp_sessions.list_meta().await {
    //       let id_str = id.to_string();
    //       let (title, color) = by_id.get(&id_str).map(|h| (h.title.clone(), h.color.clone()))
    //           .unwrap_or_else(|| (executor.clone(), None));
    //       let phase = state.notch_hub.phase_snapshot(id).await.map(|(p, _)| p);
    //       let (operator_id, operator_name, operator_avatar) = /* same registry.pinned lookup as PTY */;
    //       acp_out.push(convergence::AcpSessionInput { session_id: id, executor, cwd, tab_title: title, tab_color: color, notch_phase: phase, operator_id, operator_name, operator_avatar });
    //   }
}
```

(Write the real code, not the comments — the comments above show exactly what each line does.) Both command call sites (`get_convergence_snapshot`, `get_blocked_session_ids`) destructure the tuple and pass both vecs.

- [x] **Step 4: Run to verify pass + full check**

Run: `cargo test -p covenant --lib convergence && cargo check -p covenant`
Expected: tests pass; whole crate compiles.

- [x] **Step 5: Commit**

```bash
git add crates/app/src/convergence.rs crates/app/src/acp_commands.rs crates/app/src/lib.rs
git commit -m "feat(convergence): union PTY-agent + ACP lanes into snapshot"
```

---

### Task 4: Frontend types + ACP hints

**Files:**
- Modify: `ui/src/api.ts:2334-2400` (convergence types)
- Modify: `ui/src/convergence/hints.ts`
- Test: `ui/src/convergence/hints.test.ts`

**Interfaces:**
- Produces (api.ts — replaces `SessionSummary`/`OperatorRosterEntry`):

```ts
export type Lane = "pty" | "acp";

export interface AgentCard {
  session_id: string;
  tab_title: string;
  tab_color: string | null;
  lane: Lane;
  executor: string | null;
  status: TileStatus;
  phase_label: string | null;
  cwd: string | null;
  vendor: Vendor;
  raw_command_label: string | null;
  last_command: string | null;
  last_output_line: string | null;
  mission_name: string | null;
  operator_id: string | null;
  operator_name: string | null;
  operator_avatar: string | null;
  cost_usd: number | null;
  budget_usd: number | null;
}

export interface ConvergenceSnapshot {
  agents: AgentCard[];
  escalations: EscalationCard[];
}
```

- Produces (hints.ts): `HintTab.panes` element type becomes `{ sessionId: string | null; acpSessionId?: string | null }`; ACP panes emit hints keyed by `acpSessionId`.

- [x] **Step 1: Write the failing hints test** (append to `hints.test.ts`)

```ts
it("emits a hint for acp panes using acpSessionId", () => {
  const tabs = [
    {
      panes: [{ sessionId: null, acpSessionId: "acp-1" }],
      defaultTitle: "copilot chat",
      customName: null,
      color: "#123456",
    },
  ];
  expect(sessionHintsFromTabs(tabs)).toEqual([
    { sessionId: "acp-1", title: "copilot chat", color: "#123456" },
  ]);
});
```

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/convergence/hints.test.ts`
Expected: FAIL — empty array returned.

- [x] **Step 3: Implement.** In `hints.ts`:

```ts
export interface HintTab {
  panes: ReadonlyArray<{ sessionId: string | null; acpSessionId?: string | null }>;
  defaultTitle: string;
  customName: string | null;
  color: string | null;
}

export function sessionHintsFromTabs(tabs: ReadonlyArray<HintTab>): SessionHint[] {
  const out: SessionHint[] = [];
  for (const t of tabs) {
    const title = t.customName?.trim() || t.defaultTitle || "untitled";
    for (const p of t.panes) {
      const sid = p.sessionId ?? p.acpSessionId;
      if (!sid) continue;
      out.push({ sessionId: sid, title, color: t.color });
    }
  }
  return out;
}
```

Then api.ts: replace the two structs with `Lane`/`AgentCard`, reshape `ConvergenceSnapshot`. (`TileStatus`, `Vendor`, `EscalationCard`, `ConvergenceTabHint`, wrapper functions untouched.)

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run ui/src/convergence/hints.test.ts`
Expected: PASS (type-check of dependent files may still fail — fixed next tasks).

- [x] **Step 5: Commit**

```bash
git add ui/src/api.ts ui/src/convergence/hints.ts ui/src/convergence/hints.test.ts
git commit -m "feat(convergence): AgentCard types + ACP pane hints"
```

---

### Task 5: Flat model — sort + filter

**Files:**
- Modify: `ui/src/convergence/model.ts`
- Test: `ui/src/convergence/model.test.ts`

**Interfaces:**
- Consumes: `AgentCard`, `EscalationCard`, `TileStatus` from `../api`.
- Produces: `statusPriority(s: TileStatus): number` (unchanged), `escalationIndex(esc: EscalationCard[]): Map<string, EscalationCard>` (unchanged), `sortAgents(agents: AgentCard[], esc: EscalationCard[]): AgentCard[]`. DELETES `operatorStatus`, `sortOperators`.

- [x] **Step 1: Rewrite model.test.ts** — drop `operatorStatus`/`sortOperators` tests, add:

```ts
import { sortAgents, statusPriority, escalationIndex } from "./model";
import type { AgentCard, EscalationCard } from "../api";

function agent(sid: string, status: AgentCard["status"], title = sid): AgentCard {
  return {
    session_id: sid, tab_title: title, tab_color: null, lane: "pty",
    executor: "claude", status, phase_label: null, cwd: null,
    vendor: "unknown", raw_command_label: null, last_command: null,
    last_output_line: null, mission_name: null, operator_id: null,
    operator_name: null, operator_avatar: null, cost_usd: null, budget_usd: null,
  };
}
function esc(sid: string, at: number): EscalationCard {
  return {
    session_id: sid, tab_title: sid, tab_color: null, operator_id: "o",
    operator_name: "o", operator_avatar: null, vendor: "unknown",
    raw_command_label: null, question: null, executor_excerpt: null,
    mission_name: null, escalated_at_unix_ms: at,
  };
}

describe("sortAgents", () => {
  it("blocked first, oldest escalation leading, then status priority, then title", () => {
    const cards = [
      agent("idle1", "idle"),
      agent("work1", "working"),
      agent("blockNew", "blocked"),
      agent("blockOld", "blocked"),
      agent("blockNoEsc", "blocked"),
      agent("wait1", "awaiting-input"),
    ];
    const escs = [esc("blockNew", 200), esc("blockOld", 100)];
    const out = sortAgents(cards, escs).map((c) => c.session_id);
    expect(out).toEqual(["blockOld", "blockNew", "blockNoEsc", "work1", "wait1", "idle1"]);
  });
});
```

(`blockNoEsc` sorts after escalated blocked cards: no timestamp → `Infinity` key, ties broken by title.)

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/convergence/model.test.ts`
Expected: FAIL — `sortAgents` not exported.

- [x] **Step 3: Implement** (model.ts — full new content for the changed part)

```ts
/// Grid order: blocked first (oldest escalation first; blocked without an
/// escalation card after those), then status priority, then title.
export function sortAgents(agents: AgentCard[], esc: EscalationCard[]): AgentCard[] {
  const at = new Map(esc.map((e) => [e.session_id, e.escalated_at_unix_ms]));
  return [...agents].sort((a, b) => {
    const ab = a.status === "blocked";
    const bb = b.status === "blocked";
    if (ab !== bb) return ab ? -1 : 1;
    if (ab && bb) {
      const d = (at.get(a.session_id) ?? Infinity) - (at.get(b.session_id) ?? Infinity);
      if (d !== 0) return d;
    }
    const dp = statusPriority(a.status) - statusPriority(b.status);
    if (dp !== 0) return dp;
    return a.tab_title.localeCompare(b.tab_title);
  });
}
```

Delete `operatorStatus` and `sortOperators`; keep `statusPriority` (with its `PRIORITY` table incl. `operator-thinking`) and `escalationIndex`; imports change to `AgentCard, EscalationCard, TileStatus`.

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run ui/src/convergence/model.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add ui/src/convergence/model.ts ui/src/convergence/model.test.ts
git commit -m "feat(convergence): flat agent sort replaces operator grouping"
```

---

### Task 6: Card renderer — `renderAgentCard`

**Files:**
- Modify: `ui/src/convergence/tile.ts`
- Test: `ui/src/convergence/tile.test.ts`
- Modify: `ui/src/styles.css` (two small rules)

**Interfaces:**
- Consumes: `AgentCard`, `EscalationCard` from `../api`; `renderAvatarHtml` from `../operator/avatars`.
- Produces:

```ts
export interface CardCallbacks {
  onFocus: (sessionId: string, keepOpen: boolean) => void;
  onSubmit: (sessionId: string, text: string, scope: ReplyScope) => Promise<void>;
  /// Operator cards only: disable the operator on this session.
  onStop: (sessionId: string) => void;
}
export function renderAgentCard(card: AgentCard, esc: EscalationCard | undefined, cb: CardCallbacks): HTMLElement
```

`onToggleExpand` is DELETED (cards are single-session). `ReplyScope` unchanged.

- [x] **Step 1: Rewrite tile.test.ts.** Reuse the `agent()` factory from Task 5's test (copy it — tests don't share helpers here). Cover:

```ts
describe("renderAgentCard", () => {
  it("renders executor, title, status pill and phase label", () => {
    const el = renderAgentCard(
      { ...agent("s1", "working"), executor: "codex", phase_label: "writing a.rs", tab_title: "fix parser" },
      undefined, cbs(),
    );
    expect(el.querySelector(".mc-card__exec")?.textContent).toBe("codex");
    expect(el.textContent).toContain("fix parser");
    expect(el.querySelector(".mc-pill")?.textContent).toBe("working");
    expect(el.querySelector(".mc-card__activity")?.textContent).toContain("writing a.rs");
    expect(el.querySelector(".mc-card__stop")).toBeNull(); // no operator → no Stop
  });

  it("shows operator badge + Stop when an operator is enabled", () => {
    const onStop = vi.fn();
    const el = renderAgentCard(
      { ...agent("s1", "working"), operator_id: "o1", operator_name: "Raven", operator_avatar: "🦅" },
      undefined, { ...cbs(), onStop },
    );
    expect(el.querySelector(".mc-oplabel")?.textContent).toContain("Raven");
    el.querySelector<HTMLButtonElement>(".mc-card__stop")?.click();
    expect(onStop).toHaveBeenCalledWith("s1");
  });

  it("blocked operator card shows question, tail and reply composer", () => {
    const el = renderAgentCard(
      { ...agent("s1", "blocked"), operator_id: "o1", operator_name: "Raven" },
      { ...esc("s1", 1), question: "Deploy?", executor_excerpt: "the tail" },
      cbs(),
    );
    expect(el.querySelector(".mc-card__question")?.textContent).toBe("Deploy?");
    expect(el.querySelector(".mc-card__tail")?.textContent).toBe("the tail");
    expect(el.querySelector(".mc-reply")).not.toBeNull();
  });

  it("blocked agent card (no escalation) shows phase label, no composer", () => {
    const el = renderAgentCard(
      { ...agent("s1", "blocked"), phase_label: "waiting: permission" },
      undefined, cbs(),
    );
    expect(el.querySelector(".mc-pill")?.textContent).toBe("NEEDS YOU");
    expect(el.querySelector(".mc-reply")).toBeNull();
    expect(el.querySelector(".mc-card__activity")?.textContent).toContain("waiting: permission");
  });
});
```

with `const cbs = (): CardCallbacks => ({ onFocus: vi.fn(), onSubmit: vi.fn(async () => {}), onStop: vi.fn() });` and the `esc()` factory from Task 5.

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/convergence/tile.test.ts`
Expected: FAIL — `renderAgentCard` not exported.

- [x] **Step 3: Implement.** Rework tile.ts:

- `renderAgentCard(card, esc, cb)`: `article.mc-card.mc-card--{status}` with `dataset.sessionId = card.session_id`.
- Header (`.mc-card__head`): status dot (`.mc-dot.mc-dot--{status}`), executor strong (`.mc-card__exec`, text `card.executor ?? vendorLabel(card)`), tab button (`.mc-card__tab`, `→ {tab_title}`, onFocus), status pill (blocked → "NEEDS YOU", else `STATUS_LABEL[status]`), and — only when `card.operator_id` — an operator label span `.mc-oplabel` (avatar via `renderAvatarHtml(card.operator_avatar ?? "👤", 18)` + name) and the Stop button wired to `cb.onStop(card.session_id)`.
- Body: if `status === "blocked" && esc` → existing question/tail/reply block (unchanged code, single session id). Else: `.mc-card__activity` = `card.phase_label ?? activityLine(card)`, mission chip + cost bar as today (`activityLine`/`vendorLabel`/`contextChips`/`costBar` retyped from `SessionSummary` to `AgentCard` — field names identical).
- Delete `renderOperatorCard`, `renderHeader`, `renderSubRow`, `operatorStatus` import, multi-session branches.

styles.css additions (near existing `.mc-card` rules):

```css
.mc-card__exec { font-weight: 600; letter-spacing: 0.02em; }
.mc-oplabel { display: inline-flex; align-items: center; gap: 4px; color: var(--muted, #8b98ac); font-size: 11px; }
```

(Follow the file's existing token names — if `.mc-*` rules use a different muted var, match them.)

- [x] **Step 4: Run to verify pass**

Run: `npx vitest run ui/src/convergence/tile.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add ui/src/convergence/tile.ts ui/src/convergence/tile.test.ts ui/src/styles.css
git commit -m "feat(convergence): renderAgentCard — flat card w/ operator badge"
```

---

### Task 7: Overlay — flat render, summary, filters, empty state

**Files:**
- Modify: `ui/src/convergence/overlay.ts`
- Test: `ui/src/convergence/overlay.test.ts`

**Interfaces:**
- Consumes: `sortAgents`, `escalationIndex` (model), `renderAgentCard` (tile), `getConvergenceSnapshot`, `setOperatorEnabled`, `submitConvergenceReply` (api).
- Produces: same public class surface (`ConvergenceOverlay`, `toggle/open/close/isVisible/refreshForTest`) — `main.ts` untouched.

- [x] **Step 1: Update overlay.test.ts.** Snapshot fixtures switch from roster to `agents`. Keep the existing test intents (empty state, error retry, render-on-refresh) and update assertions:

```ts
// fixture
const snap = {
  agents: [
    { ...agent("s1", "working"), tab_title: "alpha" },
    { ...agent("s2", "blocked"), tab_title: "beta" },
  ],
  escalations: [],
};
// assertions after refreshForTest():
// - grid has 2 .mc-card elements, beta (blocked) first
// - summary strip text contains "2 agents" and "1 needs you"
```

(Reuse the Task 5 `agent()` factory; adapt to however the current test mocks `getConvergenceSnapshot`.)

- [x] **Step 2: Run to verify failure**

Run: `npx vitest run ui/src/convergence/overlay.test.ts`
Expected: FAIL (old roster fixtures no longer type-check / assertions miss).

- [x] **Step 3: Implement.** In overlay.ts:

- State: `expanded` set and `activeOperatorId` → `activeSessionId: string | null`.
- `visibleAgents()`: `sortAgents(this.snap.agents, this.snap.escalations)` filtered by chip: `"needs you"` → `status === "blocked"`; `"working"` → `status === "working"`; `"idle"` → `status === "idle"`; `"all"` → all.
- `render()`: summary = `` `<b>${agents.length}</b> agents · ` `` + needs-you count (status blocked) + working/idle counts + cost sum (unchanged formula over `agents`). Card loop: `renderAgentCard(card, escIdx.get(card.session_id), { onFocus, onSubmit: this.submitReply.bind(this), onStop: (sid) => this.stopOperator(sid) })`; active card by `session_id`.
- `stopOperator(sessionId: string)`: single `setOperatorEnabled(sessionId as SessionId, false)` + refresh (drop the loop).
- Keyboard: ArrowUp/Down move `activeSessionId` through `visibleAgents()`; Enter activates `activeSessionId`'s tab directly.
- Empty state copy:

```html
<div class="convergence-overlay__empty-title">No agents running</div>
<div class="convergence-overlay__empty-body">
  Convergence shows every agent across your tabs.<br/>
  Run an executor in any terminal (claude, codex, …) or open an ACP chat — it appears here automatically.
</div>
```

(keep the ⌘⇧M kbd hint; drop the ⌘O line).

- [x] **Step 4: Run all convergence FE tests + typecheck**

Run: `npx vitest run ui/src/convergence && npm run build`
Expected: tests pass; `tsc` clean (this is where any missed `SessionSummary` reference dies).

- [x] **Step 5: Commit**

```bash
git add ui/src/convergence/overlay.ts ui/src/convergence/overlay.test.ts
git commit -m "feat(convergence): overlay renders flat agent grid + new empty state"
```

---

### Task 8: Full verification pass

**Files:** none new.

- [x] **Step 1: Rust suite + lints**

Run: `cargo test -p covenant --lib && cargo fmt --all && cargo clippy -p covenant --all-targets 2>&1 | tail -5`
Expected: tests green (telegram-hang caveat: `--lib` only), no clippy errors.

- [x] **Step 2: Frontend suite**

Run: `npm test 2>&1 | tail -15` (repo root)
Expected: green, including untouched suites that import convergence types (fix any straggler imports).

- [x] **Step 3: Manual smoke (dev app)**

Run: `/respawn` skill (tauri dev). In the app: open a terminal tab, run `claude`, hit ⌘⇧M → a card appears with executor "claude" and live phase; open an ACP tab → second card; enable an operator on a tab (⌘O) → badge + Stop appear; trigger an ACP permission prompt → card flips to NEEDS YOU.
Expected: all four behaviors; escalation dots on tab strip unchanged.

- [x] **Step 4: Commit any fixups**

```bash
git add -u && git commit -m "fix(convergence): P1 verification fixups"
```

(skip if nothing changed)
