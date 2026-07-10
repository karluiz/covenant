# CDLC Context Lift — measuring effectiveness in the Loop

**Date:** 2026-07-10
**Status:** Design approved, proceeding to plan
**Branch:** `feat/cdlc-context-lift`

## Problem

The Canon cockpit's **Loop** section is the CDLC's "Observe" surface, but today
it only shows *footprint / volume*: adoption (installs), inference
(tokens/prompts/specs/commits), and an absolute per-skill eval pass-rate. None of
these answer the question that closes the loop — **does the authored context
actually make the executor better?** A skill can pass its evals at 82% and that
tells you nothing unless you know the executor would have scored 61% *without*
it.

## Goal

Add **Context Lift** — a controlled A/B measure of whether a context unit earns
its place — to the eval runner and surface it in the Loop:

```
Context Lift = pass-rate(WITH the context projected) − pass-rate(WITHOUT it)
```

Positive lift → the context earns its tokens. ≈0 → prune candidate. Negative →
the context is hurting; investigate.

## Background — the runner is already the A/B machinery

`crates/app/src/canon_eval.rs` today, per eval scenario:
1. `prepare_sandbox(repo_root, skill)` → temp dir with the skill projected into
   `.claude/skills/canon-<skill>/SKILL.md` + a deny-list `settings.json`.
2. `run_harness(repo_root, skill, scenario)` → `claude -p <scenario>` (read-only
   Read/Grep/Glob tools, timeout) → transcript.
3. `judge(settings, scenario, rubric, transcript)` → PASS/FAIL verdict.
4. `write_result` persists an `EvalResult { eval_id, pass, reason, ran_at_ms, duration_ms }`.

This IS the treatment arm. The **baseline arm** is the *same scenario + rubric*
run in a sandbox with **no skill projected**. The delta is the lift.

## Design

### 1. The metric

Per skill with K evals, run each eval through BOTH arms:
- **treatment_rate** = (# treatment PASS) / K
- **baseline_rate** = (# baseline PASS) / K
- **lift** = treatment_rate − baseline_rate (in percentage points)

Authoring guideline (doc only): a scenario must be a **realistic domain task
the context helps with** — never "use the skill." The rubric judges the
*outcome*, not whether the context was invoked. (Existing evals are already
outcome-based, so this holds.)

### 2. Backend — extend the runner to A/B (`crates/canon` + `crates/app`)

- **`EvalResult` gains `baseline_pass: Option<bool>`** (`crates/canon/src/eval.rs`).
  `#[serde(default)]` → `None` for pre-existing stored results, which means
  "baseline not measured" and are excluded from lift (only the treatment rate
  shows). New runs always populate it.
- **`crates/canon/src/eval.rs`** gains `lift_rate(repo_root, skill) -> Option<LiftRate>`
  where `LiftRate { treatment_passed, baseline_passed, total }` (only counts evals
  whose `baseline_pass` is `Some`). `pass_rate` stays for back-compat.
- **`crates/app/src/canon_eval.rs`:**
  - `prepare_sandbox_bare(repo_root) -> TempDir` — same deny-list `settings.json`
    as `prepare_sandbox`, but projects NO skill (empty `.claude/skills/`).
  - `run_baseline(repo_root, scenario) -> HarnessOutcome` — `run_harness` against
    the bare sandbox (identical tools/timeout/classification).
  - `canon_run_evals` runs each eval through treatment (`run_harness`) AND
    baseline (`run_baseline`), judges both with the same rubric, and stores
    `EvalResult { pass: <treatment>, baseline_pass: Some(<baseline>), .. }`.
    Progress events emit both arms.
  - Cost doubles (2 agent runs + 2 judge calls per eval) — acceptable; evals are
    already gated behind the "this costs tokens and minutes" confirm.

### 3. Backend — extend the summary (`crates/app/src/canon_eval.rs`)

`canon_eval_summary` / `EvalSkillSummary` gains `baseline_passed: usize` (treatment
count is the existing `passed`). Lift is `passed/total − baseline_passed/total`
computed client-side (or a `lift_pts: i32` field). Skills with no baseline data
report lift as absent.

### 4. Loop UI (`ui/src/canon/cockpit/view.ts`)

- Replace the "Eval pass-rate" meter with a **Context Lift** row per skill:
  `<skill>   +21 pts · 82% with / 61% without`, the lift number color-coded
  (positive = good/green token, ≈0 = neutral, negative = warn/red). Skills with
  no baseline yet fall back to the current absolute pass-rate display.
- A one-line **group verdict** above the rows: e.g. "Context adds +14 pts on
  average across N skills" or "M skills show ≤0 lift — prune candidates."
- The inference footprint (tokens/prompts) stays; Context Lift is the value
  denominator beside it.

## Testing

- `crates/canon/src/eval.rs`: `EvalResult` serde round-trips with and without
  `baseline_pass` (old files deserialize to `None`); `lift_rate` computes
  `(treatment_passed, baseline_passed, total)` over only baseline-present evals
  and returns `None` when none have baselines.
- `crates/app/src/canon_eval.rs`: `prepare_sandbox_bare` writes the deny-list
  settings and does NOT create a `canon-<skill>` skill dir.
- `ui/src/canon/cockpit/view.ts` (or a small helper module): the lift-row
  formatter renders `+N pts` / `with` / `without` correctly and picks the right
  sign class; the group verdict summarizes correctly. (The agentic run itself
  needs a real `claude` binary and is not unit-tested — this matches the existing
  runner, which is exercised manually.)

## Non-goals (ceilings)

- **Per-skill only (v1).** Evals attach to skills today; lift for
  context/memory/agent kinds needs evals attachable to those kinds — a follow-up.
- **One run per arm per eval.** Lift aggregates across the skill's K evals; for
  statistical robustness against the LLM's stochasticity, N runs per arm is a
  follow-up.
- **Observational session signals** (escalations / errors / retries in real
  sessions) — the option-B mechanism — is a separate future dimension, not this
  sub-project.
- Hardened sandbox — already a pre-existing runner follow-up, unchanged here.

## File touch-list

- `crates/canon/src/eval.rs` — `EvalResult.baseline_pass`, `lift_rate` + `LiftRate`.
- `crates/app/src/canon_eval.rs` — `prepare_sandbox_bare`, `run_baseline`, A/B in `canon_run_evals`, `EvalSkillSummary.baseline_passed`.
- `ui/src/api.ts` — `EvalSkillSummary.baseline_passed`.
- `ui/src/canon/cockpit/view.ts` — Context Lift rows + group verdict in `renderLoopSection`.

## Ponytail boundaries

- `// ponytail:` `baseline_pass: Option<bool>` (not a separate results file) —
  one field carries the A/B; old results degrade to treatment-only, no migration.
- `// ponytail:` single run per arm; N-run statistical version deferred.
- `// ponytail:` lift is percentage-point delta, no significance test — with few
  evals per skill it is indicative, not inferential; label it as such in the UI.
