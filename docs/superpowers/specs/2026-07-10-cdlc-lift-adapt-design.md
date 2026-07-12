# CDLC Lift → Adapt — acting on Context Lift

**Date:** 2026-07-10
**Status:** Design approved, proceeding to spec review → plan
**Branch:** `feat/cdlc-lift-adapt`
**Builds on:** CDLC Context Lift (the Loop now computes per-skill lift = pass-rate with vs without the skill's context).

## Problem

Context Lift measures whether each skill's context earns its tokens, but nothing
*acts* on it — the number lives in the Loop and the human has to go read it, then
separately decide. The CDLC's payoff is the **Adapt** step; to close the
Observe→Adapt loop, the lift signal must appear **where you already act on skills**
(the rail, next to Publish / Run-evals) and the Loop verdict must name concrete
prune candidates.

## Goal

Surface Context Lift as an **actionable badge** on every skill row (rail + Loop),
turning the existing affordances into lift-informed decisions — **no new
commands**. Promote = the existing Publish button, now obviously pointed at
high-lift skills. Prune = a warn badge flagging ≤0-lift skills, with the skill's
existing preview/expand to review; removal stays a manual human act (a one-click
`canon_remove_skill` is a deliberate follow-up, option B).

## Design

### 1. Shared lift classifier (`ui/src/canon/cockpit/lift.ts`)

A pure function reused by rail and Loop:

```typescript
export type LiftKind = "earning" | "not-earning" | "unmeasured";
export interface LiftBadge { kind: LiftKind; text: string }
export function liftClass(s: EvalSkillSummary): LiftBadge;
```

- **earning** — clean A/B (`baseline_total === total && baseline_total > 0`) and
  lift `> 0` → `text = "+N earning"`.
- **not-earning** — clean A/B and lift `≤ 0` → `text = "N not earning"` (this is
  the prune candidate; `N` is negative or `0`).
- **unmeasured** — no baseline (`baseline_total < total` or `0`) →
  `text = "no baseline"`.

(`liftClass` and the existing `liftRow`/`groupVerdict` share the same clean-A/B
gate and pct computation — factor the pct/clean-A/B logic so all three agree.)

### 2. Rail — a lift badge per skill row (the new piece)

- `skillCard` gains an optional `badge?: { text: string; cls: string }` rendered
  as a small `.canon-lift-badge` chip in the card head (after `meta`, before the
  preview/expand/actions).
- In `renderStatus`, the Skills section builds each skill row as today, then
  fetches `canonEvalSummary(cwd)` once and fills each skill's badge by name
  (async, mirroring how the Loop and the preview panes already resolve after
  render). Skills with no eval data get no badge (or the `unmeasured` chip).
- The badge `cls` = `lift-<kind>` so `lift-not-earning` reads as a warning; the
  existing **Publish** button is the promote affordance and the existing
  **preview/expand** is the "review this prune candidate" affordance — no new
  buttons.
- Because eval data is per-skill (evals attach to skills), only the Skills section
  is badged; the other kinds are unaffected.

### 3. Loop — verdict names the prune candidates (refinement)

- The Loop's eval box already renders per-skill lift rows + `groupVerdict`. Refine
  `groupVerdict` so instead of the generic "N show ≤0 lift — prune candidates" it
  **names them**: e.g. `"Context adds +14 pts avg across 5 skills. kyc, legacy-x
  don't earn their tokens — review."` (cap the named list, e.g. first 3 + "…").
- The lift rows already color by sign (`lift-<sign>` from `liftRow`); align that
  with the shared classifier so the rail and Loop use the same visual language.

### 4. Testing

- `lift.ts`: `liftClass` returns `earning`/`not-earning`/`unmeasured` with the
  correct `text` for lift `> 0`, `= 0`, `< 0`, and no-baseline inputs.
- `lift.ts`: `groupVerdict` names the ≤0-lift skills (contains their names, caps
  the list).
- `ui/src/canon/panel.test.ts`: a skill row rendered with a `not-earning` badge
  carries the `lift-not-earning` class + the badge text; an `earning` skill
  carries `lift-earning`. (Drive the badge via the `skillCard` `badge` param
  directly — the async `canonEvalSummary` fetch is mocked/'[] ' in the suite, so
  test the `skillCard` badge rendering + a small helper that maps a summary to a
  badge, not the network fill.)

## Non-goals (deliberate follow-ups)

- **`canon_remove_skill` / one-click prune** (option B) — removal stays a manual
  human act in v1.
- **Autonomous operator Adapt** (option C).
- **Lift for non-skill kinds** — evals attach to skills only today.
- Re-ranking / sorting the rail by lift — the badge is enough for v1.

## File touch-list

- `ui/src/canon/cockpit/lift.ts` — `liftClass`/`LiftBadge`; `groupVerdict` names prune candidates; shared clean-A/B/pct helper.
- `ui/src/canon/cockpit/lift.test.ts` — `liftClass` + `groupVerdict`-naming tests.
- `ui/src/canon/panel.ts` — `skillCard` optional `badge`; async lift-badge fill in `renderStatus`'s Skills section; import `canonEvalSummary` + `liftClass`.
- `ui/src/canon/panel.test.ts` — rail badge rendering test.
- `ui/src/canon/styles.css` — `.canon-lift-badge` + `.lift-earning`/`.lift-not-earning`/`.lift-unmeasured` chip colors (minimal; `lift-not-earning` warn).

## Ponytail boundaries

- `// ponytail:` no new backend — promote reuses `canonPublish`, prune reuses the
  existing preview/expand; the badge is the whole "action" surface.
- `// ponytail:` rail badges fill async after `canonEvalSummary`; a skill with no
  eval data simply shows no lift badge (or `unmeasured`), never blocks the row.
- `// ponytail:` `not-earning` is `lift ≤ 0` (0 included — a skill that matches its
  baseline isn't earning its tokens); no separate "flat" band.
