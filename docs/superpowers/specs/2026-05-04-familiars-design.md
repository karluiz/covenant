# Familiars — Design Spec

**Date:** 2026-05-04
**Status:** Approved (brainstorming → ready for implementation plan)
**Tier:** Premium feature

---

## Vision

Each operator (each AOM-running tab) gets a **Familiar**: a separate companion agent with a proper name, configurable style, and persistent memory. The Familiar observes the operator's event bus in real time, maintains its own world-model, and converses with the coordinator in natural language. It can propose structured *directives* that the coordinator approves; approved directives are injected into the operator's next cycle.

Three roles, three responsibilities:

- **Operator** *(existing)* — executes commands in the terminal.
- **Familiar** *(new)* — observes, remembers, opines, converses, proposes.
- **Coordinator** *(you)* — converses with Familiars, approves directives.

The product promise: *"Each operator has a Familiar — a named copilot with persistent memory who watches, remembers, and speaks for them."*

---

## Architectural Decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| Job-to-be-done | Active dialogue (opinion + interlocutor) | Makes the feature distinctive vs a logs chatbot |
| Agent identity | Separate companion (not the operator itself) | Decouples ejecución de reflexión; allows cheaper model |
| Influence channel | Hybrid: companion + back-channel directives | Conversation can affect operator via approved directives |
| Memory horizon | **Phase B now** (per-operator persistent), pathway to Phase C (episodic recall) | B is shippable; C documented as future work |
| Identity | Named + configurable style | High emotional return at low technical cost |
| Directive flow | Coordinator-approved only | Auditable, reversible, respects existing safety framework |
| UI surfaces | Roster (⌘⇧M) phase 1, Inline (⌘K) phase 2 | Roster is the sellable feature; inline is convenience |
| Cost model | Tiered (eager Haiku + lazy Sonnet + chat Sonnet) | Constant low-cost observation + deep thinking on demand |
| Premium name | **Familiar(s)** | Folklore metaphor: bound personal companion with memory & voice |

---

## Architecture

### New components

```
crates/familiar/
  ├── agent.rs        — agent loop per Familiar (Mastra-style pattern)
  ├── memory.rs       — world-model store (event log + rolling summary + mission digests)
  ├── observer.rs     — subscribes to SessionEvent bus, feeds memory
  ├── directive.rs    — proposes / approves / injects directives
  └── identity.rs     — name, style, persistence

ui/src/familiars/
  ├── roster.ts       — full-screen team view (⌘⇧M)
  ├── inline.ts       — quick-chat overlay (⌘K, phase 2)
  └── chat.ts         — shared chat component
```

### Data flow

```
Operator session → SessionEvent bus
                       ↓
              Familiar.observer (eager, Haiku)
                       ↓
              Familiar.memory (event log + rolling + digests)
                       ↑
              Familiar.agent ← chat input (coordinator)
                       ↓
              Directive proposal → coordinator approves
                       ↓
              Inject as synthetic user message → Operator next cycle
```

### Mastra fit

Mastra is JS/TS; the operator stack is Rust. The implementation will adopt the **Mastra-style agent pattern** (agent with tools, memory provider, structured outputs) implemented in Rust against the Anthropic SDK. Tools: `read_world_model`, `propose_directive`, `recall_episode` *(phase 2)*.

Memory backed by SQLite at `~/.karlTerminal/familiars/<familiar_id>.sqlite`. Survives restarts, updates, crashes.

---

## Memory Model

### Phase B (ship now)

Three memory layers per Familiar:

**1. Event log (raw, cheap).**
Append-only SQLite table `familiar_events`: every `BlockFinished`, `CwdChanged`, operator decision, cost-cap event, etc. No LLM. Pure storage. Immutable source of truth.

**2. Rolling summary (eager, Haiku 4.5).**
Table `familiar_summaries`: incremental summary of operator state, updated every N events (default: every 5 `BlockFinished` or 60s, whichever first). ~500–1000 tokens. Haiku 4.5 for low cost. This is what the Familiar "knows" without thinking deeply.

**3. Mission digests (lazy, Sonnet 4.6).**
Table `familiar_missions`: when a mission ends (or chat opens after long idle), Sonnet generates a structured *digest* of that mission: objective, key decisions, outcome, blockers. ~2k tokens. Citable in conversation: *"On the May 3 mission you decided X because Y."*

### Phase C (documented, NOT shipped)

Pathway to episodic recall, marked **Phase 2 — requires embeddings infra**:

- Embeddings over `familiar_missions.digest` via `sqlite-vec`.
- Tool `recall_episode(query)` for semantic recall in conversation.
- Cross-Familiar recall (Phase C+): *"Iris, did Marcus's operator hit this same problem?"*

---

## Directive Flow

```
1. Coordinator chats with Marcus in roster
2. Marcus emits structured proposal:

   Directive {
     id: ulid,
     familiar_id, target_session_id,
     kind: Stop | Focus | Avoid | Resume | Custom,
     payload: String,
     rationale: String,
     proposed_at: timestamp,
   }

3. UI shows directive card with [Approve] [Reject] [Edit]
4. On approve → directive injected into operator's next cycle
   as a synthetic user message tagged FAMILIAR_DIRECTIVE
5. Audit log: every directive (proposed, approved, rejected, executed,
   blocked-by-safety) stored in familiar_directives — auditable forever
```

**Safety integration:** directives go through the existing blocklist/policy framework (`crates/agent/src/safety.rs`). A Familiar **cannot** propose a command that violates safety. Attempts → automatic rejection with audit entry.

---

## UI Surfaces

### Phase 1: Roster (⌘⇧M)

Full-screen, three panels:

```
┌──────────────┬─────────────────────────────┬──────────────┐
│  Familiars   │   Conversation              │  Snapshot    │
│              │                             │              │
│ ● Marcus     │  You: ¿qué pasó anoche?     │  Operator:   │
│   tab 3      │                             │  Migration   │
│   active     │  Marcus: Corrí 47 comandos. │  Mission     │
│              │  Bloqueador en test 12...   │              │
│ ○ Iris       │                             │  Last block: │
│   tab 7      │  [Propose directive]        │  test 12 ✗   │
│   idle       │                             │              │
│              │  Marcus: Sugiero STOP en X. │  Cost: $0.42 │
│ ○ Rook       │  [Approve] [Reject] [Edit]  │              │
│   tab 11     │                             │  Familiar:   │
│   sleeping   │  ─────────                  │  Last sync:  │
│              │  [type message...]          │  12s ago     │
└──────────────┴─────────────────────────────┴──────────────┘
```

- **Familiars list (left):** state per Familiar — `active` (operator running), `idle` (operator waiting), `sleeping` (tab closed, memory alive). Click switches conversation.
- **Conversation (center):** chat + inline directive cards with [Approve] [Reject] [Edit] showing the exact synthetic message that will be injected.
- **Snapshot (right):** compact operator view: current mission, last block, cost-to-date, last Familiar↔world-model sync. Reuses operator panel components.

### Phase 2: Inline (⌘K)

Command-palette-style overlay over the active tab. Quick chat with that tab's Familiar without context-switching to the roster. Same backend, minimal UI.

### Phase 3: Status bar indicator

Small dot per tab: 🟢 Familiar in sync · 🟡 directive pending · 🔴 sync lost. Click → opens roster on that Familiar.

---

## Cost Model

Tiered — observation cheap, thinking expensive only on demand.

| Tier | Model | Trigger | Output | Est. Cost |
|---|---|---|---|---|
| Eager | Haiku 4.5 | Every 5 `BlockFinished` or 60s | Updated rolling summary | ~$0.001/update |
| Lazy | Sonnet 4.6 | Mission end OR chat open after >30min idle OR explicit resync | Mission digest (~2k tokens) | ~$0.05/digest |
| Chat | Sonnet 4.6 | Coordinator types in chat | Conversational turn | ~$0.02/turn (with prompt caching) |

**Guardrails (via existing `agent::dispatch()`):**

- Max 60 eager updates / hour / Familiar
- Max 20 chat turns / minute / Familiar
- Hard daily cap configurable per Familiar (default: $5/day)
- Cap exceeded → Familiar enters **frozen mode**: events accumulate raw, no summarization, no chat until reset or manual cap raise.

**Typical daily cost (1 active operator):**
Eager observation ~$1 · 1 mission digest ~$0.05 · 30 chat turns ~$0.60 → **~$1.65/day/Familiar**.

---

## Premium Gating

**Settings → Familiars (premium toggle):**
- `Familiars enabled` — master switch, premium-locked.
- Per-operator config: `Familiar name`, `Style` *(concise / formal / conversational / sarcastic)*, `Daily cap USD`.
- Audit log viewer — read-only timeline of all directives (proposed / approved / rejected / executed / safety-blocked).

**Free tier:** no Familiars. Operators function normally without companions.
**Premium tier:** Familiars enabled, one Familiar per operator, configurable daily cap.

License check: reuse existing `is_premium() -> bool` config (or stub). Billing integration is **out of scope** for this spec.

---

## Phasing

### Phase 1 — Familiars MVP *(this spec)*
- `crates/familiar/` with observer, memory (3 layers), agent loop, directive flow
- Roster UI (⌘⇧M) — three panels
- Status bar indicator
- Per-Familiar SQLite persistence
- Tiered cost model (Haiku eager + Sonnet lazy/chat)
- Settings: enable, name, style, daily cap per Familiar
- Directive audit log

### Phase 2 — Inline & Episodic Recall
- ⌘K inline chat overlay
- Embeddings over mission digests (`sqlite-vec`)
- Tool `recall_episode(query)` for semantic citation
- Cross-mission pattern detection (*"you've seen this error before in mission X"*)

### Phase 3 — Cross-Familiar Intelligence *(future)*
- Familiars consulting other Familiars' memory (with permission)
- Roster-level briefing: "give me the whole team's status in one answer"
- Global pattern detection (*"Marcus and Iris hit the same blocker this week"*)

---

## Out of Scope

Explicitly NOT in this spec:

- Multi-user / team Familiars (a Familiar shared across coordinators)
- Autonomous Familiar-to-Familiar conversation (no coordinator in the loop)
- Voice interface
- Mobile / web companion
- Emergent personality (option C in identity brainstorm — rejected)
- Embeddings & episodic recall (Phase 2)
- Inline ⌘K overlay (Phase 2)
- Billing / payment integration

---

## Open Questions for Implementation Plan

1. **Mastra integration depth.** Mastra is JS/TS; we'll implement the *pattern* in Rust against Anthropic SDK rather than depend on the lib. Confirm during planning.
2. **Operator → Familiar isolation.** Default proposed: Familiar **cannot** read the operator's system prompt. Only sees event bus.
3. **Directive injection format.** Synthetic user message vs system message — needs tests against the real operator loop.
4. **Style prompts.** Initial drafts for `concise`, `formal`, `conversational`, `sarcastic` need iteration with the user during implementation.

---

## Executive Summary

> **Familiars** — an AI companion with proper name, configurable style, and persistent memory per operator. Observes the event bus in real time (Haiku), converses with the coordinator in natural language (Sonnet), and proposes structured directives that the coordinator approves to influence the operator. Centralized roster UI (⌘⇧M), tiered cost model (~$1.65/day/Familiar), premium pricing. Phase 2 adds episodic recall via embeddings.
