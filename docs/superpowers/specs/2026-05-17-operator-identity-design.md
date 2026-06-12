# Operator Identity — Design

**Date:** 2026-05-17
**Status:** Draft, awaiting review
**Author:** Karluiz (with Claude)

## Problem

The operator feature feels clunky across three surfaces:

1. **Creating/configuring operators.** `ui/src/settings/operators.ts` is a single 400-line form. No sense of "who is this operator"; just a behavior config.
2. **Behavior/intervention.** Internal parse failures escape to user-facing Telegram escalations as `BLOCKED` messages with generic `Approve / Reject / Snooze 10m` buttons. The circuit breaker referenced in prior memory either regressed or never covered all paths.
3. **Telegram integration.** `format_escalation(tab_name, kind, summary)` has no operator field. Messages render as `[tab: session:01KRJ3] BLOCKED …` — no name, no avatar, no project context, no operator identity.

All three are symptoms of one root cause: **the operator is a settings struct, not an identity that flows end-to-end.** Every surface re-derives "who is this" from raw config fields (persona, model id, fallback strings) and they drift.

## Goal

Give every operator a typed identity (`name`, `avatar`, `color`, `voice`) that is required at creation and is the sole source of truth for every outbound surface (Telegram, banner, activity feed, tab bar, status bar, CMD-K). Quarantine internal errors so they never reach user-facing escalation paths.

## Non-Goals

- Per-operator Telegram chats or topics. Same chat, visually distinguished.
- Voice synthesis (audio). `voice` is text tone only.
- Operator marketplace or sharing across users.
- Changing escalation *decision* logic. Only rendering and error quarantine change.

## Design

### 1. Identity model

Split `Operator` into two layers. Identity crosses outbound boundaries; behavior stays internal.

```rust
pub struct OperatorIdentity {
    pub id: OperatorId,
    pub name: String,           // required, non-empty, max 24 chars
    pub avatar: Avatar,         // emoji | initial-disc
    pub color: HexColor,        // accent
    pub voice: VoiceTone,       // Terse | Warm | Formal
}

pub enum Avatar { Emoji(String), Initial }

pub struct Operator {
    pub identity: OperatorIdentity,
    pub behavior: OperatorBehavior, // existing config: model route, policies,
                                    // allowlist regexes, mission/spec link, etc.
}
```

`Operator` is settings-shaped. `OperatorIdentity` is rendering-shaped. No outbound surface ever reads `behavior`. No internal logic ever needs more than `identity.id` to look up `behavior`.

### 2. Outbound formatter + parse-failure quarantine

Replace the current signature:

```rust
// before
pub fn format_escalation(tab_name: &str, kind: &str, summary: &str) -> String

// after
pub struct OutboundContext<'a> {
    pub operator: &'a OperatorIdentity,
    pub project: ProjectRef,       // repo name + branch from cwd
    pub session_short: &'a str,    // last 4 of session id, tiebreaker only
    pub kind: EscalationKind,      // Approval | Question | Notice
    pub summary: &'a str,
    pub actions: &'a [OperatorAction], // typed, not strings
}

pub enum OperatorAction {
    PushAndPR,
    RunCommand { cmd: String },
    Reply,
    Snooze { minutes: u32 },
    Custom { id: String, label: String }, // for behavior-defined actions
}

pub fn format_message(ctx: &OutboundContext) -> String;
pub fn keyboard_for(ctx: &OutboundContext, escalation_id: &str) -> InlineKeyboardMarkup;
```

Rendered Telegram message:

```
🟣 Maya · karlTerminal (main)
feat/task-dnd-and-folds is done — wants to push & open PR.

[✓ Approve push]  [✗ Reject]  [⏸ Snooze 10m]
```

The emoji+name dot uses the operator's avatar and color. Buttons render from typed `OperatorAction`s so the label is contextual — never a generic "Approve" attached to a meaningless event.

**Parse-failure quarantine.** In `crates/familiar/src/observer.rs` and any path that today funnels into `escalate()`:

- `ParseFailure` is a distinct error type. It cannot be converted into an `Escalation` (no `From` impl, no string coercion).
- `ParseFailure` is routed to: (a) `tracing::warn!` with structured fields; (b) an in-app toast on the originating tab. It never touches outbound.
- A per-session counter trips a circuit breaker at **N=3 within 60s** → that session's operator switches to `SuggestOnly`, and a single in-app notice (not Telegram) is surfaced.
- `escalate()` accepts only `OutboundContext`-compatible inputs. The type system makes "Approve a parse error" a compile error.

**Inbound callbacks** (`telegram/inbound.rs`) use the same `OperatorAction` enum. Confirmation reply names the operator and the action:

```
✓ Maya pushed feat/task-dnd-and-folds and opened PR #42
```

Replaces today's `Resolved: Approved via Telegram`.

### 3. Config UI redesign

Today: one 400-line form (`ui/src/settings/operators.ts`). Replace with a two-step modal plus a card-grid list view.

**Step 1 — Identity (required, can't skip):**
- Name (text, required, max 24 chars)
- Avatar picker: emoji grid; falls back to initial-disc using `color`
- Color: 8 swatches + custom hex
- Voice: `Terse | Warm | Formal` with a one-line preview of how a sample escalation reads in each

**Step 2 — Behavior** (existing fields, regrouped):
- Model & route
- Escalation policy (when to ping Telegram)
- Execution policy (`SuggestOnly | Allowlist | ConfirmEach | FullAuto`)
- Allowlist regexes
- Mission/spec link

**Presets** on creation entry: `Reviewer` (Terse, gpt-4o, Allowlist), `Pair` (Warm, sonnet, ConfirmEach), `Watcher` (Terse, SuggestOnly, read-only), `Auto` (Terse, FullAuto + allowlist). Presets seed both steps; user can edit any field before saving.

**List view:** grid of operator cards (avatar, name, color tint, behavior summary line like `Maya · Terse · Allowlist · gpt-4o`). Edit/delete/duplicate per card. `⌘E` or right-click opens the modal in edit mode (jumps to Step 2; identity already set).

### 4. In-app surfaces

One shared TS helper, `renderOperatorChip(identity, size)`. Consumed by:

- Tab bar avatar (`ui/src/main.ts`, glow-ring active operator)
- Banner (`ui/src/aom/banner.ts`) — leading chip + status text, color tint at low opacity on chip background
- Activity feed (`ui/src/aom/activity-feed.ts`) — each row prefixed with chip
- Status bar / Covenant score chip — operator color becomes the accent when active
- CMD-K palette — operator switcher entries use the chip

**Voice integration:** a single helper `voice_directive(voice) -> &'static str` appended to the operator's system prompt. Terse → ≤12 words, no pleasantries. Warm → conversational, first person allowed. Formal → no contractions, full sentences. Applies to outbound message bodies (Telegram summaries, banner text), not to terminal commands.

### 5. Migration

On first launch after upgrade, for each existing operator:

- `name` ← existing `persona` if set, else `"Operator " + short_id`
- `avatar` ← deterministic emoji from `hash(id)` against a stable palette
- `color` ← deterministic from `hash(id)` against the 8-swatch palette
- `voice` ← `Terse`
- `identity_confirmed: false`

Settings → Operators shows a one-time "Confirm names" banner with inline edit. Once user saves, flag flips to `true`. No deletes. Reversible by editing settings.json.

## Test Plan

**Rust:**

- `outbound::format_message` — golden tests per `EscalationKind` × representative identity. Asserts name, color marker, project, summary present; session id appears only as `…XXXX` tiebreaker.
- Outbound boundary — `format_message` accepts only `OutboundContext`. Constructing one from a `ParseFailure` must not compile (compile-fail test via `trybuild`).
- `observer::parse_failure_circuit_breaker` — 3 failures in 60s flips session to `SuggestOnly`; 4th does not invoke outbound sink (mock asserts zero calls).
- `migration::synthesize_identity` — same id → same avatar+color across runs; `identity_confirmed: false`.

**TypeScript:**

- `renderOperatorChip` — snapshot tests for each size × representative identity.
- Settings two-step flow — Step 1 blocks empty name; preset seeds both steps; edit-mode opens at Step 2.
- Operator card list — renders avatar, name, color tint, behavior summary line.

## Files Touched (estimate)

**Rust:**
- `crates/app/src/operator.rs` — split into `OperatorIdentity` + `Operator`
- `crates/app/src/telegram/outbound.rs` — new signature, typed actions
- `crates/app/src/telegram/inbound.rs` — typed action dispatch + named confirmations
- `crates/familiar/src/observer.rs` — parse-failure quarantine + circuit breaker
- `crates/app/src/settings.rs` — migration logic

**TypeScript:**
- `ui/src/settings/operators.ts` — rewrite to two-step modal + card grid
- `ui/src/settings/operator_chip.ts` — new shared renderer
- `ui/src/aom/banner.ts`, `ui/src/aom/activity-feed.ts`, `ui/src/main.ts` — consume chip
- `ui/src/api.ts` — typed `OperatorIdentity`, `OperatorAction`

## Open Questions

None at design time. Implementation plan will decompose the work; some sub-tasks may surface smaller decisions (e.g., exact emoji palette, exact 8 color swatches).
