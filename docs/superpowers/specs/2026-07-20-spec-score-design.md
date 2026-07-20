# SpecScore by Covenant — Design

Date: 2026-07-20 · Status: approved

## Goal

Score any Covenant spec 0–100 against spec-writing best practices, live while it
is written and everywhere it is read, so authors fix weak specs before they ship
to an executor or a reviewer.

## Out of scope

- Scoring arbitrary markdown that is not a Covenant spec (no generic doc linter).
- Re-scoring on the forge: the server renders a stored score, never computes.
- Historical score tracking / trends.
- Blocking publish on low score (informational only).

## Architecture

Hybrid engine, one module, three surfaces.

- **Deterministic engine** — `ui/src/spec-score/engine.ts`, pure
  `scoreSpec(md): SpecScore`, no deps, reuses `parseSectionsFromMarkdown` from
  `ui/src/spec-chat/sections.ts`. Cheap enough to run per keystroke.
- **Deep score (LLM, optional)** — one call through the existing agent dispatch
  with the rubric in the prompt; returns per-dimension adjustments (±) plus
  textual findings the heuristics cannot see (semantic ambiguity,
  cross-section contradiction, untestable criteria). Cached by content hash;
  invalidated on edit. Displayed score = deterministic, adjusted when a fresh
  deep result exists.
- **Forge** — the spec publish payload gains a `spec_score` field (score,
  grade, per-dimension breakdown, deep flag). `/r/:token` renders it verbatim.

## Rubric

7 weighted dimensions over the 6 canonical sections. Each emits concrete
findings ("Acceptance criteria #3 is not verifiable: 'works well'").

| Dimension | Weight | Heuristic |
|---|---|---|
| Goal clarity | 20 | Goal present, non-empty, 1–5 sentences (neither one bare line nor a wall) |
| Verifiability | 25 | Acceptance criteria present, itemized (≥2 bullets), each item checkable (imperative/measurable) |
| Scope discipline | 15 | Out of scope present and non-empty |
| Boundaries | 10 | File boundaries present, mentions real-looking paths |
| Complexity honesty | 10 | Complexity section present, non-trivial |
| No loose ends | 10 | Open questions empty/resolved; no `TBD`/`TODO`/`???` anywhere |
| Precision | 10 | Vague-word density penalizes ("should", "maybe", "etc.", "somehow", "properly", "handle") |

Grades: **S** ≥95 · **A** ≥85 · **B** ≥70 · **C** ≥50 · **D** below.

## Surfaces

- **Spec Creator (live):** `SpecScore 78 B` chip beside the live spec,
  debounced ~300ms on section change. Click → breakdown panel.
- **Picker / viewer:** badge per spec in the list; expandable breakdown in the
  viewer — per-dimension bars + findings, Lighthouse-style. Sharp corners,
  inline SVG icons, tokens per DESIGN.md.
- **Forge:** renders the stored `spec_score` from the publish payload. A spec
  edited after publish keeps the publish-time score by definition.

## Files

```
ui/src/spec-score/
  engine.ts        # scoreSpec(md): SpecScore — pure
  engine.test.ts
  deep.ts          # LLM deep-score call + content-hash cache
  badge.ts         # chip/badge + breakdown panel
  spec-score.css
```

Integration points: spec-chat live-spec (creator chip), spec picker rows,
spec viewer, spec publish payload + forge render.

## Testing

Vitest over `engine.ts`: one golden spec (high score), one empty spec (D), and
one fixture per dimension that fails only that dimension. Deep score: test
response parsing only, not the LLM's judgment.
