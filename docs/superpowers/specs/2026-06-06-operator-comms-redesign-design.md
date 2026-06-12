# Operator → User Communication Redesign (Conversational Channel)

> Status: design approved (brainstorm). Pending spec review before implementation plan.
> Date: 2026-06-06 · Branch: `operator-comms-redesign`

## 1. Problem

The operator's communication with the user (Telegram channel + in-app Activity feed) is noisy, low-information, and sometimes wrong. Observed in production (2026-06-06):

- A healthy 27-minute Claude Code run (`cargo test -p covenant`, tokens streaming, tool calls progressing) was reported four times in four minutes as **"stuck in a Whirlpooling loop / unresponsive."** "Whirlpooling…" is Claude Code's own spinner gerund — the executor was working, not stuck.
- The four escalations were **near-duplicates with no coalescing** — each minted a fresh `escalation_id`, OS notification, Telegram message, and Activity row.
- The user asked **"what's going on?"** (not as a threaded reply) and got a hardcoded **Spanish scold**: *"Responde al mensaje original de la tab a la que te refieres, o esa escalación ya cerró."* — there is no "ask the operator a question" path at all.
- Escalation messages are thin: `emoji name · repo (branch)\n<one sentence>`. The Activity feed truncates to 60–90 chars and **discards the richer data it already persists** (`in_flight_command`, `output_excerpt`, full escalation text).

### Root causes (verified against code)

1. **No executor-phase gate.** The operator decision loop never consults `crates/blocks/src/executor_phase.rs` (which can already classify Claude Code's TUI). The LLM is fed the screen excerpt ANSI-stripped only (`operator.rs:3862`), so the literal line `✱ Whirlpooling… (27m 51s · ↓19.6k tokens)` reaches it, and the system prompt (`operator.rs:3868-3877`) tells it spinners are "CURRENT state — NOT stale," nudging it to treat a long spinner as a live fault. It "diagnosed" a stuck loop and authored escalations. The same blindness caused the earlier "typed the same reply 2x" loop (`operator.rs:2729-2741`): the operator typed into a busy executor, didn't see it consumed, retyped.
2. **Zero escalation dedup/coalescing.** Every escalate emits a fresh ULID (`operator.rs:3161-3178`) and the Telegram notifier sends unconditionally (`telegram/mod.rs:87-135`). The only throttle is a 120s per-tab *decision* cooldown the user clears by typing — nothing throttles the *events*.
3. **Broken inbound path.** Non-threaded free text hits `UnknownReply` → hardcoded Spanish reply (`lib.rs:3318`); replies are not threaded (`SendMessageReq` lacks `reply_to_message_id`, `telegram/types.rs:4-11`). More Spanish leaks from `familiar/src/prompts.rs:84-88`.
4. **Thin messages / discarded data.** `format_message` (`telegram/outbound.rs:33-48`) is minimal; Activity (`ui/src/teammate/activity-view.ts`) drops `escalation`, `in_flight_command`, `output_excerpt` (all persisted in `storage.rs:75-89`).

## 2. Goals / Non-goals

**Goals**
- The operator never reports healthy work as a problem. "Slow / long-running / still working / spinner" is *never* a ping.
- The Telegram channel is **conversational**: silent by default; the user asks and gets a synthesized cross-tab report; unprompted pings are reserved for four real triggers.
- Persisting situations are **one self-updating message**, never a flood.
- All operator copy is **English-first**.
- Both the channel and the Activity feed surface the rich context that already exists.

**Non-goals**
- No change to operator *autonomy* policy (SuggestOnly/Allowlist/ConfirmEach/FullAuto). This is about *communication*, not what the operator is allowed to do.
- No full world-model service unification (Approach C) — we drift toward it incrementally, not in this plan.
- No new executor types; we harden phase detection for `claude` first, conservative fallback for others.

## 3. Design decisions (locked in brainstorm)

- **Channel model: Conversational.** Mostly silent; user asks → operator answers a synthesized cross-tab report; proactive pings rare.
- **The only unprompted ping triggers:**
  1. **Needs your decision** — executor genuinely waiting (real prompt/menu, phase `WaitingForInput`) on something the operator can't/shouldn't answer itself.
  2. **Hard failure** — non-zero exit, crash, build/test broke, repeated API errors.
  3. **Safety stop** — operator refused a blocklisted/destructive action and needs the human.
  4. **Mission done / ship point** — executor finished or reached a ship gate.
- Everything else (including a genuinely idle-but-not-errored executor) stays silent and is only revealed when the user asks.

## 4. Architecture — Approach A-hybrid

Put an **executor-phase gate** in front of the operator decision loop, reading the live phase already maintained by `NotchHub`. The operator is *forbidden* from typing or escalating while the executor is in a working phase. When at rest, the existing decision LLM runs and its output is run through a trigger classifier; only output that maps to one of the four triggers pings. The LLM is also used for the on-demand status report. A coalescer edits the live message instead of posting new ones.

```
tick (500ms)
  └─ phase = NotchHub::phase_snapshot(session)   ── already computed for the UI notch
       ├─ Thinking | Running | Reading | Writing → OBSERVE ONLY (no engage, no type, no ping)
       └─ Waiting | Idle | Done → engage existing decision flow:
            └─ render excerpt with normalize_executor_chrome()  ── strip spinner/timer/token/TUI chrome
            └─ LLM decision → classify_trigger():
                 ├─ NeedsDecision (executor waiting, operator declines to answer) → ping
                 ├─ MissionDone (Done + mission complete / ship marker)           → ping
                 └─ (slow / working / generic loop / idle) → NO ping (world-model note only)
  └─ SafetyStop (blocklisted action refused) → ping   [any phase]
  └─ Failure (SessionEvent::MissionFailed, already wired) → ping   [own path]
  └─ ping → coalescer → (edit existing | send new) Telegram + Activity row
```

This single gate kills both the double-type loop and every "Whirlpooling" escalation: the operator can't engage during `Thinking`/`Running`/`Reading`/`Writing`, and "slow/working" maps to no trigger.

## 5. Section 1 — Phase gate + chrome stripping (the spine)

### 5.1 Executor phase model — ALREADY EXISTS

> **Reconciliation (post-extraction).** `ExecutorPhase` and a stateful, multi-executor `ExecutorPhaseDetector` already exist in `crates/blocks/src/executor_phase.rs`, and `crates/app/src/notch.rs` (`NotchHub`) already maintains one detector **per session**, ingests PTY bytes (`NotchHub::ingest`), and broadcasts `SessionEvent::ExecutorStateChanged { session, phase, agent, tab_label }` to drive the UI notch — with a sticky-window and stale-clear that already handle the "long spinner" / "flap" cases. **The operator's decision loop simply never reads it.** So this is wire-not-build.

The real enum (do not redefine):
```rust
pub enum ExecutorPhase {
    Idle,
    Thinking,
    Running { cmd: String },
    Writing { file: String },
    Reading { file: String },
    Waiting { reason: String },
    Done { summary: Option<String> },
}
```
There is **no `Error` / `Unknown` variant.** Implications:
- **Working phases** = `Thinking | Running | Reading | Writing`. The gate forbids typing/escalation in these.
- **At-rest phases** = `Waiting | Idle | Done`. Only here may the operator engage.
- **Failure** has no phase. It rides the **already-wired** `SessionEvent::MissionFailed` → `send_mission_event` path (`lib.rs`), plus the LLM classifying an agent-error banner when the executor is at rest. We do **not** invent an `Error` phase.
- **Done** = the agent's turn-end recap (`re_done`: "Cooked for Ns"), deduped per turn by `NotchHub`. It means "now at rest," not necessarily "mission complete."

### 5.2 Gate rules (in the operator tick, `operator.rs`)
The operator reads the live phase from `NotchHub` (new `phase_snapshot(session)` query — §5.2a) and gates **before** engaging:
- `Thinking | Running | Reading | Writing` (and an agent is in foreground) → **observe only**: do not engage the decision LLM, **never** type, **never** escalate. This is the spine — it kills the double-type loop and every "Whirlpooling" escalation.
- `Waiting | Idle | Done` → engage the existing decision flow. The LLM's output is then run through the trigger classifier (§6.1); anything that doesn't map to one of the four triggers does **not** ping.
- `SafetyStop` (blocklisted action refused) and `Failure` (`MissionFailed`) are raised on their own paths, independent of phase.

### 5.2a NotchHub phase query (new)
Add to `NotchHub` (reads `entry.display` + `entry.agent`, no new plumbing):
```rust
pub async fn phase_snapshot(&self, session: SessionId) -> Option<(ExecutorPhase, Option<String>)>;
// returns (display phase, foreground agent name) or None if the session isn't registered
```
The operator's `run_tick` already has `app: &AppHandle`; fetch `NotchHub` from `AppState` (or pass `&Arc<NotchHub>` as a `run_tick` param) and call `phase_snapshot` once per engaged session.

### 5.3 Chrome normalizer
New `normalize_executor_chrome(text: &str) -> String`, extending `strip_spinner_churn` (`operator.rs:4076-4117`), applied to the **LLM excerpt** in `render_user_message` (`operator.rs:3854-3885`) — not just to hash signatures. Removes/collapses:
- spinner gerund lines (`^\s*[✶✷✸✹✺✻*]?\s*\w+ing…\s*(\(.*\))?\s*$`)
- elapsed timers and token counters (`(27m 51s)`, `↓ 19.6k tokens`)
- `esc to interrupt`, `ctrl+o to expand`, `ctrl+b to run in background`, `Tip: …`
- ghost `Try "…"` placeholder hints (see `project_executor_ghost_prompts`)
- box-drawing status-bar chrome
Keeps: real command output, tool names + results, prompts/questions, errors.

### 5.4 System prompt change
Replace the "spinners are CURRENT state, not stale" framing (`operator.rs:3868-3877`) with: *"A gerund spinner + elapsed timer + climbing token counter means the executor is actively WORKING; working is never a reason to act or escalate. You are only invoked when the executor is waiting for input. The harness gives you the computed phase — trust it."* Pass the computed `ExecutorPhase` to the LLM explicitly.

### 5.5 Backstop detectors (reframed)
`general-loop`, `repeat-reply`, `idle-wait` (`operator.rs:2698-2831`) become rare because the gate prevents their conditions. They are downgraded:
- They no longer emit raw escalations.
- A genuinely idle/stalled executor (phase `Idle`/`Waiting` with no actionable prompt for a long window) updates the world model as a "possibly stalled" note — surfaced **only** when the user asks. It is **not** one of the four ping triggers, so it never pings (per the locked decision).

## 6. Section 2 — Trigger classifier + coalescer

### 6.1 Trigger taxonomy
```rust
pub enum PingTrigger {
    NeedsDecision { question: String, options: Vec<String> },
    Failure       { kind: String, detail: String },
    SafetyStop    { blocked_action: String, reason: String },
    MissionDone   { summary: String, ship_action: Option<String> },
}
```
Anything not mapping to a variant → no ping.

### 6.2 Coalescer
New module (`operator::ping` or extend Telegram outbound state) holding:
```rust
struct ActivePing {
    escalation_id: String,
    telegram_message_id: i64,
    trigger_class: TriggerClass, // NeedsDecision|Failure|SafetyStop|MissionDone
    first_seen: Instant,
    last_update: Instant,
    signature: u64,              // dedup hash of (session, class, salient detail)
}
active_pings: HashMap<(SessionId, TriggerClass), ActivePing>
```
- New trigger with an **open** ping of the same `(session, class)` → **edit** the existing Telegram message (`edit_message_text`, already used by `on_resolved`, `telegram/mod.rs:179-230`) + update the Activity row; refresh `last_update`. No new message.
- No open ping → send new, record mapping (extends existing `message_id ↔ escalation_id` map, `telegram/mod.rs:124-128`).
- Edits throttled to ≥ 30s to avoid edit-spam.
- **Auto-resolve:** when phase transitions off the triggering state (e.g. `WaitingForInput`→`RunningTool`, or `Error`→`Done`), edit the message to a closed/resolved state ("✏️ resolved itself; executor resumed") and drop from `active_pings`. Conservative: only auto-close on a clear forward transition.

The coalescer is the single choke point both Telegram and the Activity feed consult, so they coalesce identically.

## 7. Section 3 — Conversational inbound

### 7.1 Routing (replace `lib.rs:3304-3325` UnknownReply handling)
- Threaded reply to an **open** escalation → treat as the *answer* → inject to executor PTY (existing FreeText path, `lib.rs:3280-3282`).
- Anything else (non-threaded free text, or reply to a closed escalation, or an explicit question) → **operator Q&A** via the report synthesizer.
- Optional `/status` command → same synthesizer.
- **Delete** the Spanish scold (`lib.rs:3318`). **Translate** the Spanish headers in `familiar/src/prompts.rs:84-88` to English.

### 7.2 Report synthesizer
One LLM call over the per-tab rolling world-model summaries + current `ExecutorPhase` per session → a concise English cross-tab status report. Replies **threaded** to the user's message. Includes contextual action buttons when there's an obvious next step (e.g. "api is waiting on y/n — [Send y] [Send N]"). System prompt pins English (`english_first_copy`).

### 7.3 Threading fix
Add `reply_to_message_id: Option<i64>` to `SendMessageReq` (`telegram/types.rs:4-11`); set it on report replies and (optionally) on pings.

## 8. Section 4 — Richness

### 8.1 Ping message format (replace `format_message`, `telegram/outbound.rs:33-48`)
```
{emoji} {operator} · {repo} ({tab})            {trigger_label}
{tab_context}: {phase} · {elapsed}
─────────────────────────────
{in_flight_command}
{the actual question / failure / blocked action}
→ {operator's one-line judgment}
{contextual buttons}
```
- `trigger_label`: `needs you` | `failed` | `blocked` | `done`.
- **Contextual buttons** (not a permanent "Approve push"):
  - `NeedsDecision`: `[Send <optA>] [Send <optB>] [Open tab] [Snooze]`
  - `Failure`: `[Open tab] [Retry?] [Snooze]`
  - `SafetyStop`: `[Approve once] [Reject] [Open tab]`
  - `MissionDone`: `[Approve push] [Open tab] [Not yet]`
- **Open tab** deep link: URL button `covenant://session/<id>` if the scheme is registered; otherwise a callback that focuses the tab in-app. (Sub-task with fallback; not a blocker.)

### 8.2 Activity feed (storage + `activity-view.ts`)
- Add `escalation TEXT NULL` and `trigger_class TEXT NULL` columns to `operator_decisions` (`storage.rs:75-89`) with a migration; persist them on save (`storage.rs:1219-1268`).
- Expose `in_flight_command`, `output_excerpt`, `escalation`, `trigger_class` via the list API (`storage.rs:1514-1557`) and `DecisionEvent` (`activity-view.ts:23-35`).
- Render rows **expandable**: collapsed = one line (current); expanded (click) = in-flight command + full escalation/rationale + tail of output excerpt + per-entry cost. Replaces tooltip-only recovery (lost on re-render).
- Show **per-entry cost** within coalesced runs/incidents, not only the aggregate.
- Keep grouping but key it on the same `(session, trigger_class)` concept as the Telegram coalescer.

## 9. Data-model changes (summary)
- `operator_decisions`: `+ escalation TEXT NULL`, `+ trigger_class TEXT NULL` (migration).
- `SendMessageReq`: `+ reply_to_message_id: Option<i64>`.
- `ExecutorPhase` enum + `classify_phase` (in `executor_phase.rs`).
- `PingTrigger` enum + `TriggerClass`.
- In-memory `active_pings` coalescer state.

## 10. Testing
- **Phase classifier** over recorded Claude Code TUI captures: `Thinking` ("Whirlpooling… (27m)"), `RunningTool` ("Bash(…) Running…"), `WaitingForInput` (prompt/menu), `Done` ("Cooked for Ns" / agent idle), `Error` (panic/API-error banner). Assert **no escalation** for `Thinking`/`RunningTool` regardless of elapsed time, and that a lone non-zero child-command exit does **not** produce `Error`.
- **Chrome normalizer**: strips gerunds, timers, token counters, `esc to interrupt`, `ctrl+o`, ghost `Try …`; keeps real output.
- **Coalescer**: N identical triggers in a window → 1 message + edits; forward phase transition → auto-close.
- **Trigger classifier**: phase+exit → correct variant; "slow"/"long-running" → no trigger.
- **Inbound**: non-threaded free text → report path (never the Spanish scold); threaded-to-open → PTY inject.
- **Regression (golden)**: replay the exact screenshot scenario (typed 2× + Whirlpooling 27m) → expect **zero** pings.
- **English-first**: assert no Spanish strings in outbound paths.

## 11. Rollout / risks
- **Default-on, no feature flag** — the legacy behavior is strictly broken. Changes are additive (new gate short-circuits before existing escalation emit). Coordinate with in-flight operator work on `main` (`teammate/commands.rs` et al.) and the `solo-autonomous-mode` worktree to avoid merge churn.
- **Phase detection for non-Claude executors** (`codex`/`copilot`/`pi`/`hermes`): conservative `Unknown`→observe; Claude Code fully gated first; expand patterns iteratively.
- **Auto-resolve correctness**: only close on a clear forward phase transition; otherwise keep the ping open.
- **Deep-link "Open tab"**: needs `covenant://` scheme registration; fallback to in-app focus. Non-blocking.

## 12. Open questions
1. Should `MissionDone` auto-offer push/PR via a button that *executes* (gated by autonomy policy), or always just notify? (Current "Approve push" doesn't execute — it only resolves.)
2. Do we want a `/status` slash command in addition to free-text Q&A, or is free-text enough?
3. Retry button for `Failure` — in scope now or follow-up?
