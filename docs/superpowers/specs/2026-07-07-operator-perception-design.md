# Operator Perception — Design (v0)

> Status: approved concept, pending spec review
> Branch: `feat/operator-perception`
> Date: 2026-07-07

## Problem

Today an operator supervising an ACP executor in **AOM mode** watches the
work, but every interactive permission prompt the executor raises
(`session/request_permission` — "Allow Bash?", "Allow edit?", a menu with a
`(recommended)` option) stops and waits for the human to give the tab focus
and click. Most of those decisions are trivial and we'd all agree on the
answer. The human is a bottleneck on choices that were never in doubt.

## Goal

A per-operator capability, **Perception**, that when assigned lets the
operator answer the *trivial, obviously-correct* interactive prompts on the
human's behalf — with a hard safety floor and full auditability — so the
human is only pulled in for decisions that actually need judgment.

Perception is a standalone property of the operator: it acts on the small
gates whenever an operator carrying the capability is **assigned to the
session**, independent of AOM. (AOM is a separate declaration of intent —
"the operator is actively reviewing"; Perception does not require it.)

## Activation (corrected during implementation)

The original draft assumed the flag threads in at ACP-tab spawn. It doesn't:
interactive ACP tabs (copilot/claude) are opened by the user with only
`cwd`/`executor` and have **no owning operator**. The real seam is the
existing per-session operator assignment: `OperatorRegistry::effective_for(
session_id) -> Operator` returns the operator pinned to the session (via
`pin_session` / `session_set_operator`) or the Default operator. Perception
reads `effective_for(session_id).perception_enabled` **at decision time** in
the forwarder — not a spawn-time bool. If no perception-enabled operator is
assigned (and the Default operator has it off, the default), Perception stays
dormant. Not gated on AOM anywhere.

## Scope

**In (v0):**
- ACP executors only (claude / copilot / pi via ACP). Prompts arrive as
  structured `session/request_permission` with `options[]` and `kind`.
- LLM-judged decisions (reuse the operator's existing Haiku triage tier).
- Per-operator toggle, off by default.
- Audit chip per auto-answer + consecutive-auto-answer handback cap.

**Out (deferred):**
- `// ponytail: ACP-only v0` — PTY-run executors (screen-scraping Claude
  Code's vt100 TUI menus). Same Perception brain, second backend, only when a
  real PTY-daily flow needs it. Reimplementing a TUI parser is explicitly
  against the CLAUDE.md "don't reinvent the VT parser" rule.
- Learned/per-prompt-type policies. YAGNI until the coarse v0 proves
  insufficient.
- Persisted grants (`allow_always`). Never — an auto-answer must not widen
  future sessions.

## Architecture

Perception inserts into the existing `PermissionResolver` callback in
`crates/agent/src/acp/run.rs` (today at ~`run.rs:64`). In an **interactive**
session that resolver currently emits `AcpSessionEvent::PermissionPending`
and waits for the human. With Perception ON for the supervising operator, the
resolver runs this decision before falling back to the human:

```
session/request_permission
   │
   ├─ 1. safety::classify(command) != Safe ? ──── yes ──▶ escalate to human
   │                                               no          (PermissionPending)
   │
   ├─ 2. Haiku triage judge:
   │      "Given this prompt + options, is this a trivial decision with an
   │       obviously-correct answer? If yes, return the optionId. If any
   │       doubt, decline."
   │        ├─ trivial + high confidence + optionId is safe ─▶ auto-answer
   │        │                                                   + audit chip
   │        └─ uncertain / non-trivial / low confidence ──────▶ escalate to human
   │
   └─ 3. consecutive-auto-answer count >= CAP ? ── yes ──▶ pause Perception
                                                            for session + notify
```

**Hard invariants:**
- The safety floor (`crates/agent/src/safety.rs::classify`) runs **first** and
  is non-negotiable. Haiku decides only *inside* what is already Safe. The LLM
  may be more conservative than the rules, never more permissive.
- Perception only ever selects a **non-persistent** option (`allow_once` /
  the recommended non-"always" option), reusing the deny-biased `pick_option`
  floor already in `policy.rs`.
- On any failure of the judge (timeout, parse error, ambiguous reply) →
  escalate to human. Failure mode is always "ask the human", never "guess".

### Reuse map (what already exists)

| Need | Existing code |
|---|---|
| Pick an optionId safely / deny-biased floor | `acp/policy.rs::pick_option`, `resolve_headless_with_log` |
| Safety classification | `safety.rs::classify` → `Risk::Safe` |
| Cheap LLM judge | operator Haiku triage tier (`operator.rs:~2439`) |
| Per-operator capability gating | `gh_*` tool gating pattern (operator_registry / capabilities) |
| Interactive permission wait | `AcpSessionEvent::PermissionPending` in `acp/run.rs` |
| Tab audit chips | ACP tab event/chip rendering |

The genuinely new code is: a `perception` decision function wrapping
`policy` + the Haiku judge, the per-operator toggle + its plumbing into the
interactive resolver, the audit event, and the consecutive-count guard.

## Components

1. **`acp::perception` (Rust, new)** — `decide(req, ctx) -> Decision` where
   `Decision = AutoAnswer(optionId, reason) | Escalate`. Runs the floor →
   judge → cap pipeline. Pure over its inputs (safety verdict, judge verdict,
   count) so it unit-tests without a live model.
2. **Haiku judge call** — a thin prompt builder + parser over the existing
   triage inference path. Input: prompt text + options; output:
   `{ optionId | none, confidence, reason }`.
3. **Per-operator `perception_enabled` flag** — stored alongside existing
   operator capabilities; toggled in the Capabilities panel; default `false`.
4. **Interactive resolver wiring** — when the supervising operator has
   Perception on, the interactive `PermissionResolver` calls
   `perception::decide` before emitting `PermissionPending`.
5. **Audit + handback** — emit a chip per auto-answer; maintain a per-session
   consecutive-auto-answer counter that pauses Perception and notifies at CAP
   (default 5); any human interaction resets it.

## Data flow

Executor → ACP `session/request_permission` → resolver → `perception::decide`
→ either `PermissionDecision::Select(optionId)` (+ audit event to the tab) or
fall through to `PermissionPending` (human answers as today).

## Error handling

- Judge unreachable/slow/garbled → escalate.
- Safety-risky command → escalate (judge never consulted for the allow path).
- CAP reached → pause + notify; no silent runaway.
- Operator toggle off → resolver behaves exactly as today (zero behavior
  change when disabled).

## Testing

Reuse the `policy.rs` unit-test harness with a stubbed judge:
- risky prompt + judge stub says "allow" → **still escalates** (floor wins).
- trivial safe prompt + judge says allow(optionId) → auto-answers that id.
- judge says "uncertain" → escalates.
- N+1 consecutive auto-answers → pauses (CAP guard).
- toggle off → identical to current interactive behavior.

One integration-style test drives `perception::decide` end-to-end with a
fake `PermissionRequest` and a stub judge; no live model in tests.

## Open questions (for spec review)

- CAP default: 5 consecutive? per-session or rolling window?
- Does the audit chip need an inline "undo/override" affordance in v0, or is
  visibility (grants are `once`) enough?
- Judge model: confirm the AOM Haiku triage path is reusable as-is, or does
  Perception need its own prompt-scoped call.
