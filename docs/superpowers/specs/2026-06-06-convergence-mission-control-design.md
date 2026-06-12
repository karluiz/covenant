# Convergence → Mission Control — design

**Date:** 2026-06-06
**Status:** Approved (design), pending implementation plan
**Spec area:** 3.8 Convergence Mode (supersedes the 3.8.1 inbox+roster layout)

---

## 1. Problem

The Convergence overlay (⌘⇧M) renders **completely blank** — no tiles, no
empty-state, just the grid's center divider. It has read as "zero purpose"
because it has been **dead-on-arrival since the "Phase C" tab refactor** and
has likely never been seen populated.

### Root cause (confirmed)

The "Phase C" refactor moved per-session data off `Tab` and onto `Pane`
(`ui/src/tabs/manager.ts:273` — *"all data fields (sessionId, …) have been
removed from Tab. Access via activePane(tab).<field> instead"*). `Pane.sessionId`
now lives at `ui/src/tabs/pane.ts:27`.

But `ui/src/convergence/tabs-bridge.ts:18` still reads `t.sessionId` off the
tab. The bridge casts `manager as unknown as TabManagerInternal`, which
**suppressed the compile error**, so it rotted silently:

```
t.sessionId  →  undefined
→ hint { session_id: undefined, title, color }
→ Rust TabHint { session_id: String }  (required, not Option)
→ serde rejects the whole Vec<TabHint>
→ get_convergence_snapshot rejects
→ overlay.ts refresh() catch → early return
→ grid stays mounted+visible but empty; empty-state stays hidden  ⇒ blank + divider
```

### Not affected

`get_blocked_session_ids` (3.14 tab-strip dots) is called with `[]`
(`manager.ts:1647`), so it deserializes fine. Sessions come from
`state.sessions`; tab hints only decorate with title/color. The tab dots work.
**Only the overlay is broken.** This also proves the backend already produces
everything Mission Control needs — the snapshot is complete; only the frontend
is wrong.

---

## 2. Goal

Replace the inbox|roster two-pane with a **live operator Mission Control**: a
glanceable card grid, one card per operator, showing what every operator is
doing right now across every tab. Blocked operators demand attention as a
**card state**, not a separate inbox region.

**Success:** open ⌘⇧M → instantly see all operators, their live status, current
activity, and cost; reply to a blocked operator without leaving the overlay;
click any card to jump to its tab.

---

## 3. Non-goals (YAGNI)

- No new persistence / DB schema. Backend structs are in-memory and already complete.
- No new agent capabilities, no policy changes, no autonomy surface.
- No cross-session correlation (M5) — status only.
- The compact table mode (B) is **specified but secondary** — ships behind the
  `⊞ cards / ▤ compact` toggle; cards is the default and the MVP.

---

## 4. Architecture

| Layer | Change |
|---|---|
| `ui/src/tabs/manager.ts` | **New public method** `listSessionHints()` enumerating panes → `{ sessionId, title, color }[]`. Kills the `as unknown as` rot. |
| `ui/src/convergence/tabs-bridge.ts` | Use `manager.listSessionHints()`; drop the `TabManagerInternal` cast. |
| `ui/src/convergence/overlay.ts` | Rewrite: single card grid + header strip; resilient refresh (no blank on transient error). |
| `ui/src/convergence/tile.ts` | Replace `renderInboxCard`/`renderRosterRow` with `renderOperatorCard` (+ blocked-expanded variant, multi-session sub-rows). |
| `ui/src/styles.css` | New `.mc-*` styles; retire unused `.cv-inbox*` rules. |
| `crates/app/src/convergence.rs` | **Harden only:** `op_state.lock()` must not panic on poison — recover via `unwrap_or_else(|p| p.into_inner())`. No struct/logic change. |

The Rust snapshot (`build_convergence_snapshot`) and command surface
(`get_convergence_snapshot`) are **reused as-is** apart from the lock hardening.

---

## 5. Data flow

`get_convergence_snapshot(tabs)` returns `{ roster, escalations }` (unchanged):

- **roster**: `OperatorRosterEntry[]` — grouped by operator, each with
  `sessions: SessionSummary[]` and `has_escalation`. Drives the cards.
- **escalations**: `EscalationCard[]` — oldest-first; carries the two fields a
  `SessionSummary` lacks: `question` (rationale) and `executor_excerpt` (tail).

The frontend builds `Map<session_id, EscalationCard>` and, when a session's
status is `blocked`, joins it in to render the question + tail + reply. This
keeps the backend untouched.

`listSessionHints()` enumerates **panes**, so a split tab contributes both
sessions (each with the tab's title/color). Panes with `sessionId === null`
(browser panes) are filtered out — this is exactly what prevents the
`undefined` deserialization failure from recurring.

---

## 6. The view

### 6.1 Card anatomy (per operator)

| Part | Source | Notes |
|---|---|---|
| Avatar + status ring | `operator_avatar`, status | ring color = live status; persona is the unit |
| Name + status pill | `operator_name`, status | redundant on purpose (glance + color-blind) |
| Tab link | `tab_title` | click → jump to tab, close overlay |
| "Ns ago" | `escalated_at_unix_ms` | **blocked cards only** — the one timestamp the backend exposes. No generic per-card age (would need a new status-change timestamp; out of scope). |
| Activity line | `vendor` + `last_command` else `last_output_line` | the single most important line |
| Context chips | `mission_name`, model | render only when present |
| Cost bar | `cost_usd` / `budget_usd` | **only** when AOM-enrolled; amber→red near budget |

**Decision (open call resolved):** keep the cost bar — it only appears for
AOM-enrolled sessions, so it is not noise in the common case. Revisit if it
feels heavy.

### 6.2 Status taxonomy (already in `classify_status` / `decide_status`)

| state | color | means | trigger |
|---|---|---|---|
| working | green | executor producing output | bytes within 750ms |
| operator-thinking | blue | the LLM operator is deciding | operator call in flight |
| awaiting-input | amber | output stalled, may want input | idle >1.5s after new output |
| blocked | red | operator escalated to YOU | last decision = `escalate` |
| idle | grey | nothing happening | default |

Operator header pill = highest-priority status across its sessions
(blocked > thinking > working > awaiting > idle).

### 6.3 Blocked = a card state

A blocked card: red border + glow, **sorts to the front**, and expands in place:

- **Question** — `EscalationCard.question`.
- **Executor tail** — `EscalationCard.executor_excerpt` (last ~15 ANSI-stripped
  lines), monospace, scrollable, capped height.
- **Reply composer** — textarea + scope select (`one-shot` / `mission` /
  `global`) + Send (⌘↵). Calls `submit_convergence_reply(sessionId, text, scope)`
  (unchanged). After send, clears and lets the next snapshot reflect the unblock.

**Decision (open call resolved):** keep the executor tail. It is the context
that lets the user reply without flipping to the tab — the core value of the
escalation surface. It only renders on blocked (expanded) cards, so it costs
nothing on the calm path.

### 6.4 Grid + header strip

- **Header:** summary (`N operators · X needs you · W working · I idle · $cost`),
  filter chips (`all / needs you / working / idle`), and the
  `⊞ cards / ▤ compact` mode toggle. Exit button (Esc) as today.
- **Grid:** responsive `auto-fill` columns, min card width ~320px.
- **Sort:** needs-you (oldest-first, via `escalations` order) → thinking →
  working → awaiting → idle; then by name.
- **Idle stays visible**, dimmed (user explicitly wants to see idle operators).
- **Multi-session operator:** header shows aggregate (`2 sessions · 1 blocked`);
  expands to per-session sub-rows, each with its own status dot, tab link,
  activity, and cost; a blocked sub-row carries the reply composer.

### 6.5 Compact mode (secondary)

The `▤ compact` toggle renders the same data as a dense table (one row per
session: operator · tab · status · activity · $ · age), blocked rows pinned and
expandable. Persist the chosen mode in local settings. MVP may stub this toggle
disabled and land cards first; the toggle UI exists so the path is reserved.

---

## 7. Interactions

- **Click card / tab link** → `bridge.activateBySessionId(id)` → jump + close
  (existing behavior; keep `keepOverlayOpen` for reply focus).
- **Reply** → focus composer, ⌘↵ sends, does not jump.
- **Keyboard:** ↑/↓ move active card; Enter jumps; Esc closes (or blurs an
  active textarea first — keep current handler). Reuse the existing
  `escHandler` arrow-nav logic, retargeted from escalation list to card list.
- **Filters** update the rendered subset; empty filter result shows a small
  "no operators match · show all" reset (keep existing pattern).

---

## 8. Resilience (so it can never silently blank again)

`refresh()` must not leave a blank grid on a transient failure:

1. On snapshot **success with data** → render cards.
2. On snapshot **success, empty** (no operators pinned) → show the
   "Nothing to converge / enable an operator (⌘O)" empty-state (existing copy).
3. On snapshot **reject** → keep the last-good render if any; overlay a subtle
   "reconnecting…" chip in the header; **never** drop to a blank grid. If there
   is no last-good yet, show a one-line error state with a Retry, not a blank.
4. Backend: poisoned `op_state` mutex recovers (`into_inner`) instead of
   panicking the command.

---

## 9. Testing

**Rust (`convergence.rs`):**
- Keep existing `assemble_snapshot` / `classify_status` / `detect_vendor` tests.
- Add: poisoned-`op_state` path does not panic the snapshot (recovers tail).

**TS (vitest):**
- `listSessionHints()` enumerates both panes of a split tab; filters
  null-sessionId (browser) panes. *(This is the regression test for the bug.)*
- `tabs-bridge` returns valid `session_id` strings (never `undefined`).
- Card sort order (needs-you oldest-first → … → idle).
- Operator header status = highest-priority across sessions.
- Blocked card joins `EscalationCard` (question + tail + reply present).
- `refresh()` on reject keeps last-good render (no blank).

**Manual:** ⌘⇧M with 1 working + 2 idle + 1 blocked operator → grid populated,
blocked sorted first and expanded, reply unblocks, click jumps to tab.

---

## 10. Rollout

Single PR. Behind no flag — it replaces a broken surface, so there is no
regression risk to a working feature. The card grid (6.1–6.4) + bug fix
(§4 manager/bridge) + resilience (§8) are the MVP; compact mode (6.5) may be a
follow-up commit if it grows.

---

## 11. Decisions log

- **Layout:** operator card grid (A), chosen over dense table (B) and hybrid
  inbox+grid (C). Rationale: persona-centric model, real scale (handful of
  operators), and a clean break from the dead two-pane.
- **Escalation:** a card *state*, not a separate region — avoids re-introducing
  the inbox the user rejected.
- **Cost bar:** kept (AOM-enrolled only).
- **Executor tail:** kept (blocked-expanded only).
- **Backend:** reused; only lock-poison hardening. No schema change.
