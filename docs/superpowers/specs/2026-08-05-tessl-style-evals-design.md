# Tessl-style Evals — Design

**Date:** 2026-08-05
**Status:** Approved (design), pending implementation plan
**North star:** [Tessl Evals](https://tessl.io/blog/improving-your-skills-with-tessl-evals/) — weighted criteria scoring, baseline-vs-context lift as the headline result, unit review/lint before evals, and eval-informed publishing.

## Context — what exists today

The Canon eval runner (`crates/app/src/canon_eval.rs`, `crates/canon/src/eval.rs`) already covers more of the Tessl loop than it looks:

- **Scenario generation**: LLM drafter emits `{id, scenario, rubric}` pairs into a review drawer.
- **Baseline arm**: same scenario in a bare sandbox (no unit projected), verdict cached by content hash — lift is already *measured*, just not surfaced.
- **Cockpit** (⌘⌥E): durable runs, history, transcripts, cancel, per-unit manage.
- **Registry push**: aggregate results already travel to the org registry (Plan B).
- **Kind-generic**: evals live at `evals/<kind>/<name>/*.toml` for all 5 publishable kinds.

The gaps vs Tessl, in dependency order: binary PASS/FAIL judging (no per-criterion weighted scores), lift buried in data instead of headlining the UI, no audit of the unit itself before evals, and no eval-freshness link to publishing.

## Decisions (settled with Karluiz)

1. **Scoring is all-or-nothing per criterion.** Each criterion carries a point weight; the judge grants it fully or not at all (Tessl's 40/40 model). No gradual 0..max — LLM judges are not reproducible at that granularity.
2. **Publish gate informs, never blocks.** Stale content → auto-run evals on publish; scores travel with the package and show on the registry card. Publishing with a low score is allowed.
3. **Harness selection is deferred.** The pin to `claude` CLI + `sonnet` (`EXECUTOR_MODEL`) stays — it is what makes scores comparable across runs. Parameterizing the harness is a later wave if ever needed.
4. **Zero migration.** Legacy `{id, scenario, rubric}` evals stay valid forever; a bare rubric executes as a single derived criterion worth 100 pts.

## Wave 1 — Weighted criteria scoring (foundation)

### Schema (`crates/canon/src/eval.rs`)

```rust
pub struct Criterion {
    pub id: String,     // kebab-case slug
    pub text: String,   // what the judge verifies from the transcript
    pub points: u32,    // weight; suite total = sum of points
}

pub struct Eval {
    pub id: String,
    pub scenario: String,
    #[serde(default)]
    pub rubric: String,               // legacy; kept for old files
    #[serde(default)]
    pub criteria: Vec<Criterion>,     // new; wins when non-empty
}
```

- At run time, `effective_criteria(&eval)` returns `criteria` when non-empty, else one derived criterion `{id: "rubric", text: rubric, points: 100}`. All downstream code sees only criteria.
- Validation (shared by `canon_write_evals`, manager Save, drafter accept): non-empty scenario; at least one criterion with non-empty text and `points >= 1`; criterion ids unique within the eval.
- The **drafter prompt** changes to emit `criteria` (2-4 per scenario, points summing to 100) instead of a flat rubric.

### Judge (`canon_eval.rs`)

- Prompt: given scenario + criteria list + transcript, reply with **only** a JSON array `[{"id": "...", "pass": true|false, "reason": "..."}]`, one entry per criterion, judging only the stated criteria.
- Parse strictly (tolerating fences/prose around the array, same posture as `parse_drafts`); a missing or unknown criterion id fails the parse. Reuse the existing judge retry + `JUDGE_TIMEOUT_SECS`.
- Derived values:
  - `score = Σ points of passed criteria`, `max_score = Σ all points`.
  - `pass = all criteria passed` — exactly equivalent to today's binary verdict when there is one criterion, so existing chips ("2/5 pass"), history records, and registry aggregates keep their meaning unchanged.

### Baseline & lift

- The baseline arm is judged against the **same criteria** → `baseline_score / max_score`.
- `lift = score% − baseline_score%`, computed for display, not stored redundantly.
- **Baseline cache versioning:** the cached verdict gains criteria-aware fields; a cache entry whose criteria hash no longer matches the eval's current criteria is a miss (re-run). Old boolean-only entries are misses.

### Results storage

- `EvalResult` / `EvalRunDetail` / `EvalCaseRecord` gain `#[serde(default)]` fields: `score: u32`, `max_score: u32`, `baseline_score: Option<u32>`, and per-criterion verdicts `criteria: Vec<CriterionVerdict {id, pass, reason, points}>` on the detail record. Old results files deserialize cleanly (defaults = zeros/empty) and render as legacy binary rows.

## Wave 2 — Cockpit results, Tessl-style

- **Case detail pane** (right column, empty today): criterion rows with ✓/✗ glyph (inline SVG per design rules, never emoji), text, `earned/points`; then a rule; then `Total  N/M (P%)`, `Baseline  N/M (P%)`, `Lift  +Δ`. Transcript links for both arms below.
- **Run header / history rows**: alongside "2/5 pass", show aggregate score % and average lift for runs that have criteria data; legacy runs render as today.
- **Retry per scenario**: a re-run action on a single case row, reusing the existing single-case pipeline (`run_one`) and overwriting that case's detail record; the suite aggregate recomputes.
- Sharp corners, True Dark neutral lifts, `attachTooltip` — per `docs/DESIGN.md` hard rules.

## Wave 3 — Unit review/lint (pre-eval quality)

Two layers, both surfaced in the cockpit's Manage view and the Canon unit view; neither blocks anything.

- **Static lint** (deterministic, per kind, in `crates/canon`): frontmatter parses; `name` matches its folder; `description` present, within length bounds, and — for skills — contains a "Use when" trigger phrase; body non-empty. Output: list of `{severity, message, hint}`.
- **LLM review**: one call through the Summary-role model (same dispatch as the judge) that audits trigger quality, description completeness, and clarity, returning 3-7 actionable suggestions. On demand (a "Review" button), never automatic — keeps cost predictable.

## Wave 4 — Publish gate (informative)

- Each suite run records the unit's **content hash** (hash of the unit's source files — distinct from the baseline cache's per-scenario hash).
- On publish: current hash ≠ last run's hash (or no run) → auto-enqueue the suite through the existing run loop; the publish proceeds without waiting.
- The publish payload (Plan B's registry push) gains `score`, `max_score`, `lift`, and `evals_fresh: bool`; the registry card shows score % + lift, or "evals stale/none" when applicable.
- Requires a small `covenant-server` change to accept + display the new payload fields (backward-compatible: fields optional).

## Error handling

- Judge JSON unparseable after retry → case verdict `Skipped` with the parse error as reason (same posture as today's judge failure), never a fabricated score.
- Baseline judge failure → lift "not measurable" (existing behavior), score still shown for the unit arm.
- Cancel/timeout semantics unchanged; `stale` flag semantics unchanged.

## Testing (regression coverage required)

- `crates/canon`: criteria validation; `effective_criteria` legacy derivation; results (de)serialization old→new.
- `canon_eval.rs`: judge JSON parse (fenced, prose-wrapped, missing id, unknown id); score/pass derivation; baseline cache miss on criteria change; content-hash staleness.
- UI: case-detail rendering for criteria vs legacy results (vitest, beside the panel source).
- Server: publish payload with and without eval fields.

## Out of scope (deferred)

- Harness/executor selection (claude+sonnet pin stays).
- Gradual 0..max scoring.
- Blocking publish thresholds.
- Web-shareable eval reports (forge share lane exists if wanted later).
