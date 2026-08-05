# Tessl-Style Evals Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Weighted per-criterion eval scoring with baseline/lift as the headline result, plus unit review/lint and an informative publish gate — per `docs/superpowers/specs/2026-08-05-tessl-style-evals-design.md`.

**Architecture:** Extend the existing Canon eval pipeline in place. `crates/canon` (package `karl-canon`) owns schema + stores; `crates/app` (package `covenant`) owns the runner/judge/drafter Tauri commands (`crates/app/src/canon_eval.rs`); `ui/src/canon/evals-cockpit.ts` owns the cockpit. Legacy `{id, scenario, rubric}` evals run unchanged via a derived single criterion — zero migration.

**Tech Stack:** Rust (serde, toml, sha2, tokio), Tauri 2 commands, TypeScript + Vitest.

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]` and `main()` (CLAUDE.md).
- `thiserror` in library crates; `anyhow` only at the app binary boundary.
- Conventional Commits; one feature-coherent commit per task (user preference: one commit per feature, not per TDD step — each task commits once, at its end).
- Rust tests: `cargo test -p karl-canon` / `cargo test -p covenant --lib`. UI tests: `npm test` **from repo root**, never from `ui/`.
- UI: sharp corners (`border-radius: 0`), inline SVG glyphs only (never emoji / `element.title` — use `attachTooltip`), English copy, True Dark = neutral lifts. See `docs/DESIGN.md` hard rules.
- Never send raw ANSI or unmasked secrets to an LLM; transcripts already pass `safety::mask_secrets` — keep it that way.
- The harness stays pinned to `claude` CLI + `EXECUTOR_MODEL = "sonnet"`. Do not parameterize it.
- All work in this worktree; stage files explicitly (never `git add -A` — it commits the `node_modules` symlink).

---

## Wave 1 — Weighted criteria scoring

### Task 1: `Criterion` schema, `effective_criteria`, validation

**Files:**
- Modify: `crates/canon/src/eval.rs` (struct `Eval` at line ~16, tests mod at ~484)
- Modify: `crates/canon/src/lib.rs` (re-export the new items where `Eval` is exported)

**Interfaces:**
- Produces: `pub struct Criterion { pub id: String, pub text: String, pub points: u32 }`; `pub fn effective_criteria(eval: &Eval) -> Vec<Criterion>`; `pub fn validate_eval(eval: &Eval) -> Result<(), String>`; `pub fn criteria_hash(criteria: &[Criterion]) -> String`. `Eval` gains `#[serde(default)] pub criteria: Vec<Criterion>` and `rubric` becomes `#[serde(default)]`.

- [ ] **Step 1: Write failing tests** in the existing `#[cfg(test)]` mod of `crates/canon/src/eval.rs`:

```rust
#[test]
fn legacy_eval_toml_still_parses_and_derives_one_criterion() {
    let ev: Eval =
        toml::from_str("id = \"a\"\nscenario = \"do x\"\nrubric = \"must do x\"\n").unwrap();
    assert!(ev.criteria.is_empty());
    let crits = effective_criteria(&ev);
    assert_eq!(crits.len(), 1);
    assert_eq!(crits[0].id, "rubric");
    assert_eq!(crits[0].text, "must do x");
    assert_eq!(crits[0].points, 100);
}

#[test]
fn criteria_eval_toml_roundtrips_and_wins_over_rubric() {
    let ev = Eval {
        id: "a".into(),
        scenario: "do x".into(),
        rubric: String::new(),
        criteria: vec![
            Criterion { id: "stops".into(), text: "stops the release".into(), points: 60 },
            Criterion { id: "reports".into(), text: "reports the command".into(), points: 40 },
        ],
    };
    let s = toml::to_string_pretty(&ev).unwrap();
    let back: Eval = toml::from_str(&s).unwrap();
    assert_eq!(back, ev);
    assert_eq!(effective_criteria(&back).len(), 2);
}

#[test]
fn validate_eval_rules() {
    let ok = Eval {
        id: "a".into(),
        scenario: "s".into(),
        rubric: String::new(),
        criteria: vec![Criterion { id: "c1".into(), text: "t".into(), points: 1 }],
    };
    assert!(validate_eval(&ok).is_ok());
    // no criteria and no rubric → invalid
    let mut bad = ok.clone();
    bad.criteria.clear();
    assert!(validate_eval(&bad).is_err());
    // legacy shape (rubric only) → valid
    bad.rubric = "must".into();
    assert!(validate_eval(&bad).is_ok());
    // zero points → invalid
    let mut zp = ok.clone();
    zp.criteria[0].points = 0;
    assert!(validate_eval(&zp).is_err());
    // duplicate ids → invalid
    let mut dup = ok.clone();
    dup.criteria.push(dup.criteria[0].clone());
    assert!(validate_eval(&dup).is_err());
    // empty scenario → invalid
    let mut es = ok.clone();
    es.scenario = "  ".into();
    assert!(validate_eval(&es).is_err());
}

#[test]
fn criteria_hash_is_stable_and_content_sensitive() {
    let c = vec![Criterion { id: "a".into(), text: "t".into(), points: 10 }];
    assert_eq!(criteria_hash(&c), criteria_hash(&c.clone()));
    let mut c2 = c.clone();
    c2[0].points = 20;
    assert_ne!(criteria_hash(&c), criteria_hash(&c2));
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p karl-canon legacy_eval_toml` → FAIL (unknown `criteria` field / missing functions).

- [ ] **Step 3: Implement** in `crates/canon/src/eval.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Criterion {
    pub id: String,
    pub text: String,
    pub points: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Eval {
    pub id: String,
    pub scenario: String,
    /// Legacy single-rubric shape; still valid when `criteria` is empty.
    #[serde(default)]
    pub rubric: String,
    /// Weighted pass/fail criteria; wins over `rubric` when non-empty.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub criteria: Vec<Criterion>,
}

/// The criteria this eval is judged against. A legacy rubric-only eval is a
/// single derived criterion worth 100 points, so downstream code sees one shape.
pub fn effective_criteria(eval: &Eval) -> Vec<Criterion> {
    if !eval.criteria.is_empty() {
        return eval.criteria.clone();
    }
    vec![Criterion { id: "rubric".into(), text: eval.rubric.clone(), points: 100 }]
}

/// Shared validation for every write path (manager Save, drafter accept, MCP).
pub fn validate_eval(eval: &Eval) -> Result<(), String> {
    if eval.id.trim().is_empty() || eval.scenario.trim().is_empty() {
        return Err("eval needs a non-empty id and scenario".into());
    }
    if eval.criteria.is_empty() {
        if eval.rubric.trim().is_empty() {
            return Err("eval needs criteria or a rubric".into());
        }
        return Ok(());
    }
    let mut seen = std::collections::BTreeSet::new();
    for c in &eval.criteria {
        if c.id.trim().is_empty() || c.text.trim().is_empty() {
            return Err("every criterion needs a non-empty id and text".into());
        }
        if c.points == 0 {
            return Err(format!("criterion {:?} needs points >= 1", c.id));
        }
        if !seen.insert(c.id.as_str()) {
            return Err(format!("duplicate criterion id {:?}", c.id));
        }
    }
    Ok(())
}

/// Stable digest of a criteria set — baseline verdicts are only reusable when
/// judged against the same criteria.
pub fn criteria_hash(criteria: &[Criterion]) -> String {
    use sha2::{Digest, Sha256};
    let mut h = Sha256::new();
    for c in criteria {
        h.update(c.id.as_bytes());
        h.update([0]);
        h.update(c.text.as_bytes());
        h.update([0]);
        h.update(c.points.to_le_bytes());
        h.update([0xff]);
    }
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
```

Re-export in `crates/canon/src/lib.rs` alongside the existing eval exports: `Criterion`, `effective_criteria`, `validate_eval`, `criteria_hash`.

- [ ] **Step 4: Verify.** `cargo test -p karl-canon` → all pass (including pre-existing eval tests: `Eval` construction sites in old tests need `criteria: Vec::new()` added — fix them, do not weaken them). Then `cargo test -p covenant --lib` — compile errors will appear at every `Eval { .. }` literal in `canon_eval.rs` (drafter, manager save); add `criteria: Vec::new()` there for now (Task 6 makes them real).

- [ ] **Step 5: Commit.** `git add crates/canon/src/eval.rs crates/canon/src/lib.rs crates/app/src/canon_eval.rs && git commit -m "feat(canon): weighted eval criteria schema with legacy rubric derivation"`

### Task 2: Score fields on result records (back-compat serde)

**Files:**
- Modify: `crates/canon/src/eval.rs` (`EvalResult` ~line 23, `EvalRunDetail` ~47, `EvalCaseRecord` ~72, `BaselineVerdict` ~323, tests mod)

**Interfaces:**
- Produces: `pub struct CriterionVerdict { pub id: String, pub pass: bool, pub reason: String, pub points: u32 }`. `EvalResult` + `EvalCaseRecord` gain `#[serde(default)] pub score: u32` and `#[serde(default)] pub max_score: u32`; `EvalResult` gains `#[serde(default)] pub baseline_score: Option<u32>`. `EvalRunDetail` gains those three plus `#[serde(default)] pub criteria: Vec<CriterionVerdict>` and `#[serde(default)] pub baseline_criteria: Vec<CriterionVerdict>`. `BaselineVerdict` gains `#[serde(default)] pub criteria_hash: String`, `#[serde(default)] pub score: u32`, `#[serde(default)] pub max_score: u32`, `#[serde(default)] pub criteria: Vec<CriterionVerdict>` (existing `pass` + `judged_at_ms` stay).

- [ ] **Step 1: Write failing tests** (same tests mod):

```rust
#[test]
fn old_results_json_deserializes_with_zero_scores() {
    let old = r#"{"eval_id":"a","pass":true,"reason":"ok","ran_at_ms":1,"duration_ms":2}"#;
    let r: EvalResult = serde_json::from_str(old).unwrap();
    assert_eq!((r.score, r.max_score, r.baseline_score), (0, 0, None));
}

#[test]
fn old_baseline_cache_entry_has_empty_criteria_hash() {
    let old = r#"{"pass":true,"judged_at_ms":5}"#;
    let v: BaselineVerdict = serde_json::from_str(old).unwrap();
    assert!(v.criteria_hash.is_empty());
    assert_eq!(v.max_score, 0);
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p karl-canon old_results_json` → FAIL (fields don't exist).

- [ ] **Step 3: Implement** the field additions exactly as the Interfaces block above; add `CriterionVerdict` next to `Criterion`, re-export from `lib.rs`. Fix struct literals in existing tests/code by adding the new fields (`score: 0, max_score: 0, baseline_score: None`, etc.).

- [ ] **Step 4: Verify.** `cargo test -p karl-canon && cargo test -p covenant --lib` → pass (again patching `EvalResult`/`EvalRunDetail` literals in `canon_eval.rs` and `canon_registry.rs` tests with zero-value fields).

- [ ] **Step 5: Commit.** `git add -u crates && git commit -m "feat(canon): per-criterion score fields on eval records, serde back-compat"`

### Task 3: Criteria judge — prompt + strict JSON parse

**Files:**
- Modify: `crates/app/src/canon_eval.rs` (replace `JUDGE_SYSTEM` ~502, `judge` ~574, `judge_with_timeout` ~614; tests mod at ~1449)

**Interfaces:**
- Consumes: `karl_canon::{Criterion, CriterionVerdict}` (Tasks 1-2).
- Produces: `pub fn parse_criteria_verdicts(text: &str, criteria: &[karl_canon::Criterion]) -> Result<Vec<karl_canon::CriterionVerdict>, String>`; `pub async fn judge(settings, scenario, criteria: &[Criterion], transcript) -> Result<Vec<CriterionVerdict>, String>` (signature change: `rubric: &str` → `criteria: &[Criterion]`); same for `judge_with_timeout`. The old `Verdict` struct and `parse_verdict` are **deleted** (all callers move to criteria).

- [ ] **Step 1: Write failing tests** in the `#[cfg(test)]` mod:

```rust
fn crits() -> Vec<karl_canon::Criterion> {
    vec![
        karl_canon::Criterion { id: "stops".into(), text: "stops".into(), points: 60 },
        karl_canon::Criterion { id: "reports".into(), text: "reports".into(), points: 40 },
    ]
}

#[test]
fn parse_criteria_verdicts_happy_path_attaches_points() {
    let text = r#"[{"id":"stops","pass":true,"reason":"halted"},{"id":"reports","pass":false,"reason":"silent"}]"#;
    let v = parse_criteria_verdicts(text, &crits()).unwrap();
    assert_eq!(v.len(), 2);
    assert!(v[0].pass && !v[1].pass);
    assert_eq!((v[0].points, v[1].points), (60, 40));
}

#[test]
fn parse_criteria_verdicts_tolerates_fences_and_prose() {
    let text = "Here you go:\n```json\n[{\"id\":\"stops\",\"pass\":true,\"reason\":\"r\"},{\"id\":\"reports\",\"pass\":true,\"reason\":\"r\"}]\n```";
    assert!(parse_criteria_verdicts(text, &crits()).is_ok());
}

#[test]
fn parse_criteria_verdicts_rejects_missing_unknown_or_duplicate_ids() {
    // missing "reports"
    assert!(parse_criteria_verdicts(r#"[{"id":"stops","pass":true,"reason":"r"}]"#, &crits()).is_err());
    // unknown id
    assert!(parse_criteria_verdicts(
        r#"[{"id":"stops","pass":true,"reason":"r"},{"id":"nope","pass":true,"reason":"r"}]"#,
        &crits()
    ).is_err());
    // duplicate id
    assert!(parse_criteria_verdicts(
        r#"[{"id":"stops","pass":true,"reason":"r"},{"id":"stops","pass":false,"reason":"r"}]"#,
        &crits()
    ).is_err());
    // no array at all
    assert!(parse_criteria_verdicts("PASS", &crits()).is_err());
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p covenant --lib parse_criteria` → FAIL.

- [ ] **Step 3: Implement.**

```rust
const JUDGE_SYSTEM: &str = "You are a strict compliance judge. You are given a SCENARIO, a list of \
CRITERIA, and a TRANSCRIPT of an AI agent's response to the scenario. For EACH criterion decide, \
all-or-nothing, whether the transcript satisfies it. Judge ONLY the stated criteria; do not invent \
extra ones. Reply with ONLY a JSON array, no prose and no code fences, one entry per criterion, in \
order: [{\"id\": \"<criterion id>\", \"pass\": true|false, \"reason\": \"one line\"}, ...]";

#[derive(serde::Deserialize)]
struct RawCriterionVerdict {
    id: String,
    pass: bool,
    #[serde(default)]
    reason: String,
}

/// Strict parse of the judge's JSON array. Every criterion must appear exactly
/// once; anything else is a parse error (retry, then hard error — never a
/// fabricated score).
pub fn parse_criteria_verdicts(
    text: &str,
    criteria: &[karl_canon::Criterion],
) -> Result<Vec<karl_canon::CriterionVerdict>, String> {
    let start = text.find('[').ok_or("judge output had no JSON array")?;
    let end = text.rfind(']').ok_or("judge output had no JSON array")?;
    if end < start {
        return Err("judge output had no JSON array".into());
    }
    let raw: Vec<RawCriterionVerdict> = serde_json::from_str(&text[start..=end])
        .map_err(|e| format!("judge output unparseable: {e}"))?;
    let mut by_id: std::collections::BTreeMap<&str, &RawCriterionVerdict> = Default::default();
    for r in &raw {
        if by_id.insert(r.id.as_str(), r).is_some() {
            return Err(format!("judge repeated criterion {:?}", r.id));
        }
    }
    if let Some(unknown) = raw.iter().find(|r| !criteria.iter().any(|c| c.id == r.id)) {
        return Err(format!("judge invented criterion {:?}", unknown.id));
    }
    criteria
        .iter()
        .map(|c| {
            let r = by_id
                .get(c.id.as_str())
                .ok_or_else(|| format!("judge omitted criterion {:?}", c.id))?;
            Ok(karl_canon::CriterionVerdict {
                id: c.id.clone(),
                pass: r.pass,
                reason: r.reason.clone(),
                points: c.points,
            })
        })
        .collect()
}
```

Rewrite `judge` to format criteria into the user message and parse with the new function (retry loop and `Role::Summary` resolution unchanged):

```rust
pub async fn judge(
    settings: &std::sync::Arc<tokio::sync::Mutex<Settings>>,
    scenario: &str,
    criteria: &[karl_canon::Criterion],
    transcript: &str,
) -> Result<Vec<karl_canon::CriterionVerdict>, String> {
    // ... resolve_route exactly as before ...
    let crit_lines = criteria
        .iter()
        .map(|c| format!("- id: {} — {}", c.id, c.text))
        .collect::<Vec<_>>()
        .join("\n");
    let user = format!(
        "## SCENARIO\n{scenario}\n\n## CRITERIA\n{crit_lines}\n\n## TRANSCRIPT\n{transcript}"
    );
    for attempt in 0..2 {
        // ... AskRequest as before (max_tokens: 1024 — per-criterion reasons need room) ...
        match parse_criteria_verdicts(&resp.text, criteria) {
            Ok(v) => return Ok(v),
            Err(e) => tracing::warn!(target: "canon", attempt, error = %e, "judge verdict unparseable, retrying"),
        }
    }
    Err("judge did not return a parseable criteria verdict".into())
}
```

`judge_with_timeout` changes its `rubric: &str` param to `criteria: &[karl_canon::Criterion]` and forwards. Delete `Verdict`, `parse_verdict`, `word_pos` and their tests (`run_one_eval` won't compile until Task 4 — do Tasks 3+4 in one working session, commit separately only if both build, otherwise fold into one commit).

- [ ] **Step 4: Verify.** `cargo test -p covenant --lib parse_criteria` → PASS. Full build stays red until Task 4 wires callers — acceptable inside the session, not across a commit.

- [ ] **Step 5: Commit** together with Task 4 if the tree doesn't build standalone; otherwise `git add crates/app/src/canon_eval.rs && git commit -m "feat(evals): per-criterion JSON judge with strict parse"`.

### Task 4: Wire `run_one_eval` to criteria (score, pass, baseline cache)

**Files:**
- Modify: `crates/app/src/canon_eval.rs` (`run_one_eval` ~809, baseline block ~870)

**Interfaces:**
- Consumes: `effective_criteria`, `criteria_hash`, `CriterionVerdict` (Tasks 1-2); new `judge_with_timeout` (Task 3).
- Produces: `EvalResult`/`EvalRunDetail` written with `score`, `max_score`, `baseline_score`, `criteria`, `baseline_criteria` populated. Legacy binary semantics preserved: `pass = all criteria passed`.

- [ ] **Step 1: Write failing unit tests** for the pure aggregation (extract it so it's testable):

```rust
/// Derived scalars from a set of criterion verdicts.
fn score_of(verdicts: &[karl_canon::CriterionVerdict]) -> (u32, bool, String) {
    let score = verdicts.iter().filter(|v| v.pass).map(|v| v.points).sum();
    let pass = verdicts.iter().all(|v| v.pass);
    let reason = if pass {
        "all criteria met".to_string()
    } else {
        verdicts
            .iter()
            .filter(|v| !v.pass)
            .map(|v| format!("{}: {}", v.id, v.reason))
            .collect::<Vec<_>>()
            .join("; ")
    };
    (score, pass, reason)
}
```

```rust
#[test]
fn score_of_sums_passed_points_and_derives_binary_pass() {
    let vs = vec![
        karl_canon::CriterionVerdict { id: "a".into(), pass: true, reason: "ok".into(), points: 60 },
        karl_canon::CriterionVerdict { id: "b".into(), pass: false, reason: "missed".into(), points: 40 },
    ];
    let (score, pass, reason) = score_of(&vs);
    assert_eq!(score, 60);
    assert!(!pass);
    assert!(reason.contains("b: missed"));
    let all = vs.iter().map(|v| karl_canon::CriterionVerdict { pass: true, ..v.clone() }).collect::<Vec<_>>();
    assert_eq!(score_of(&all), (100, true, "all criteria met".into()));
}
```

- [ ] **Step 2: Run to verify failure**, then add `score_of` and make it pass: `cargo test -p covenant --lib score_of`.

- [ ] **Step 3: Rewire `run_one_eval`:**

```rust
let crits = karl_canon::effective_criteria(ev);
let max_score: u32 = crits.iter().map(|c| c.points).sum();
// unit arm
let verdicts = match judge_with_timeout(settings, &ev.scenario, &crits, &outcome.transcript).await {
    Ok(v) => v,
    Err(e) => { stale_out(&e, "error"); return None; }
};
let (score, pass, reason) = score_of(&verdicts);
```

Baseline block: cache hit requires matching criteria —

```rust
let ch = karl_canon::criteria_hash(&crits);
let hash = karl_canon::scenario_hash(&ev.scenario);
let cached = karl_canon::read_baseline_cache(repo_root)
    .get(&hash)
    .filter(|v| v.criteria_hash == ch)
    .cloned();
```

On a miss, judge the baseline transcript against `crits`, then persist the richer verdict:

```rust
let (b_score, b_pass, _) = score_of(&b_verdicts);
karl_canon::write_baseline_verdict(repo_root, &hash, &karl_canon::BaselineVerdict {
    pass: b_pass,
    judged_at_ms: chrono::Utc::now().timestamp_millis(),
    criteria_hash: ch.clone(),
    score: b_score,
    max_score,
    criteria: b_verdicts.clone(),
});
```

Track `baseline_score: Option<u32>` and `baseline_criteria: Vec<CriterionVerdict>` alongside the existing `baseline_pass` (from `cached.score`/`cached.criteria` on hit). Populate the new fields on `EvalResult` and `EvalRunDetail` (detail keeps `rubric: ev.rubric.clone()` for legacy display). `EvalCaseRecord` construction (in `canon_run_evals`'s history append) gains `score`/`max_score` from the result.

- [ ] **Step 4: Verify.** `cargo test -p covenant --lib && cargo test -p karl-canon` → PASS. Then `cargo clippy --workspace --all-targets` clean.

- [ ] **Step 5: Commit.** `git add crates/app/src/canon_eval.rs && git commit -m "feat(evals): criteria-scored runs with criteria-aware baseline cache"` (folding Task 3 if it wasn't committable alone).

### Task 5: Drafter emits criteria; write paths validate

**Files:**
- Modify: `crates/app/src/canon_eval.rs` (`DRAFT_SYSTEM` ~1212, `parse_drafts` ~1221, `canon_draft_evals` filter ~1288, manager-save validation ~1184, `canon_write_evals` validation)
- Modify: `ui/src/api.ts` (`CanonEvalDraft` ~2209)
- Modify: `ui/src/canon/evals.ts` (drawer renders each draft's criteria as a read-only list under the scenario)

**Interfaces:**
- Consumes: `validate_eval` (Task 1).
- Produces: drafts carry `criteria: [{id, text, points}]` (2-4 per scenario, points summing to 100); every write path rejects invalid evals via `validate_eval`. `CanonEvalDraft` gains `criteria?: { id: string; text: string; points: number }[]`.

- [ ] **Step 1: Write failing tests:**

```rust
#[test]
fn parse_drafts_accepts_criteria_shape() {
    let text = r#"[{"id":"a","scenario":"s","criteria":[{"id":"c1","text":"t","points":100}]}]"#;
    let ds = parse_drafts(text).unwrap();
    assert_eq!(ds[0].criteria.len(), 1);
    assert!(karl_canon::validate_eval(&ds[0]).is_ok());
}

#[test]
fn parse_drafts_still_accepts_legacy_rubric_shape() {
    let text = r#"[{"id":"a","scenario":"s","rubric":"must"}]"#;
    assert!(karl_canon::validate_eval(&parse_drafts(text).unwrap()[0]).is_ok());
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p covenant --lib parse_drafts_accepts` → the criteria one FAILS (serde already tolerates the missing rubric via `#[serde(default)]`, but criteria round-trip must be asserted red first if it isn't).

- [ ] **Step 3: Implement.** New prompt:

```rust
const DRAFT_SYSTEM: &str = "You write behavior evals for an AI agent's context unit (a skill, \
command, agent, context doc, or memory). Given the unit's source, produce 3-5 evals. Each eval is a \
scenario that would tempt an agent WITHOUT this unit to do the wrong thing, plus 2-4 weighted \
criteria stating observable behaviors the unit should force. The scenario is 1-3 sentences addressed \
to the agent as a user request. Each criterion is one verifiable-from-transcript behavior with an \
integer point weight; a scenario's points sum to 100 and weights reflect importance. Reply with ONLY \
a JSON array, no prose and no code fences: [{\"id\": \"kebab-case-slug\", \"scenario\": \"...\", \
\"criteria\": [{\"id\": \"kebab-case-slug\", \"text\": \"...\", \"points\": 60}, ...]}, ...]";
```

In `canon_draft_evals`, replace the current "non-empty scenario/rubric" filter with `karl_canon::validate_eval(&d).is_ok()` (also slug each criterion id through `draft_slug`). In the manager-save command (~1184) and `canon_write_evals`, replace the manual emptiness checks with `validate_eval`. In `ui/src/api.ts`, extend `CanonEvalDraft` with the optional `criteria` array (the drawer UI renders criteria read-only in this task — a labeled list under the scenario; editable weights are YAGNI until asked).

- [ ] **Step 4: Verify.** `cargo test -p covenant --lib && npm test` → PASS.

- [ ] **Step 5: Commit.** `git add crates/app/src/canon_eval.rs ui/src/api.ts ui/src/canon/evals.ts && git commit -m "feat(evals): drafter emits weighted criteria; write paths share validate_eval"`

---

## Wave 2 — Cockpit: criteria breakdown, lift, per-case retry

### Task 6: API types + case detail pane (criteria table, Total/Baseline/Lift)

**Files:**
- Modify: `ui/src/api.ts` (`CanonEvalRunDetail` ~2165)
- Modify: `ui/src/canon/evals-cockpit.ts` (`renderDetail` ~486)
- Modify: `ui/src/canon/evals-cockpit.css`
- Test: `ui/src/canon/evals-cockpit.test.ts`

**Interfaces:**
- Consumes: detail JSON now carrying `score`, `max_score`, `baseline_score`, `criteria[]`, `baseline_criteria[]` (Task 4).
- Produces: `CanonEvalRunDetail` gains `score: number; max_score: number; baseline_score: number | null; criteria: { id: string; pass: boolean; reason: string; points: number }[]; baseline_criteria: ...same[]`. A pure helper `export function scoreSummary(d: CanonEvalRunDetail): { pct: number; basePct: number | null; lift: number | null } | null` (null when `max_score === 0`, i.e. legacy detail → render exactly as today).

- [ ] **Step 1: Write failing test** in `evals-cockpit.test.ts` (follow the file's existing harness conventions):

```ts
import { scoreSummary } from "./evals-cockpit";

it("scoreSummary computes pct, baseline pct and lift", () => {
  const d = {
    score: 75, max_score: 100, baseline_score: 15,
    criteria: [{ id: "a", pass: true, reason: "", points: 75 }],
  } as never;
  expect(scoreSummary(d)).toEqual({ pct: 75, basePct: 15, lift: 60 });
});

it("scoreSummary is null for legacy details and lift null without baseline", () => {
  expect(scoreSummary({ score: 0, max_score: 0 } as never)).toBeNull();
  expect(scoreSummary({ score: 50, max_score: 100, baseline_score: null } as never))
    .toEqual({ pct: 50, basePct: null, lift: null });
});
```

- [ ] **Step 2: Run to verify failure.** `npm test -- evals-cockpit` (from repo root) → FAIL.

- [ ] **Step 3: Implement.** In `evals-cockpit.ts`:

```ts
export function scoreSummary(
  d: Pick<CanonEvalRunDetail, "score" | "max_score" | "baseline_score">,
): { pct: number; basePct: number | null; lift: number | null } | null {
  if (!d.max_score) return null; // legacy record — no criteria data
  const pct = Math.round((d.score / d.max_score) * 100);
  const basePct = d.baseline_score == null
    ? null
    : Math.round((d.baseline_score / d.max_score) * 100);
  return { pct, basePct, lift: basePct == null ? null : pct - basePct };
}
```

In `renderDetail`, when `scoreSummary(d)` is non-null, render above the transcript: one row per `d.criteria` entry — pass/fail SVG glyph (reuse the cockpit's existing pass/fail glyph source; never emoji), criterion `id`, `reason` (tooltip via `attachTooltip` when truncated), right-aligned `earned/points` where earned is `points` when pass else `0`; then a separator and three summary rows `Total N/M (P%)`, `Baseline N/M (P%)` (or `Baseline — not measured`), `Lift +Δ` / `−Δ` (green when > 0, red when < 0, using existing cockpit pass/fail color vars). Legacy details (`scoreSummary` null) keep today's rendering untouched. CSS in `evals-cockpit.css`: `.evc-crit-row`, `.evc-crit-points`, `.evc-score-summary` — sharp corners, monospace numerals to match the cockpit.

- [ ] **Step 4: Verify.** `npm test && npm run build` → PASS.

- [ ] **Step 5: Commit.** `git add ui/src/api.ts ui/src/canon/evals-cockpit.ts ui/src/canon/evals-cockpit.css ui/src/canon/evals-cockpit.test.ts && git commit -m "feat(evals-ui): criteria breakdown with total/baseline/lift in case detail"`

### Task 7: Aggregate score in run header + history rows + per-case retry

**Files:**
- Modify: `crates/app/src/canon_eval.rs` (`EvalRunRecord` history append site inside `canon_run_evals`; `EvalUnitSummary` ~648 gains `score: u32; max_score: u32`)
- Modify: `crates/canon/src/eval.rs` (`EvalRunRecord` gains `#[serde(default)] pub score: u32` and `#[serde(default)] pub max_score: u32`)
- Modify: `ui/src/canon/evals-cockpit.ts` (run header, history rows, case row actions), `ui/src/api.ts`
- Test: `ui/src/canon/evals-cockpit.test.ts`, `crates/canon/src/eval.rs` tests mod

**Interfaces:**
- Consumes: `canon_run_evals(cwd, kind, name, baseline, only)` — the `only: Option<String>` param **already exists** (`canon_eval.rs:977`); retry is UI-only.
- Produces: history records with suite `score`/`max_score`; a per-case re-run button calling the existing `canonRunEvals` api wrapper with `only: caseId`.

- [ ] **Step 1: Write failing tests.** Rust: an `EvalRunRecord` JSON without `score` deserializes to zeros (same pattern as Task 2). TS: a formatter test —

```ts
import { runScoreLabel } from "./evals-cockpit";

it("runScoreLabel renders pct only when criteria data exists", () => {
  expect(runScoreLabel({ score: 150, max_score: 200 } as never)).toBe("75%");
  expect(runScoreLabel({ score: 0, max_score: 0 } as never)).toBe("");
});
```

- [ ] **Step 2: Run to verify failure**, both sides.

- [ ] **Step 3: Implement.** Backend: at the history-append site in `canon_run_evals`, sum `score`/`max_score` across the run's `EvalResult`s into the record; extend `EvalUnitSummary` the same way (sum over non-stale stored results) so unit rows can show a percentage. UI: `runScoreLabel` helper + render the percentage next to the existing "N/M pass" chip in the run header and history rows (empty string → nothing renders, legacy unchanged). Case rows (`evc-case`, ~443) gain a re-run glyph button (SVG refresh icon, `attachTooltip("Re-run this case")`), click → `canonRunEvals(cwd, kind, name, { only: id })` — stop propagation so it doesn't toggle selection; the cockpit's existing progress-event subscription already repaints the case when the fresh verdict lands.

- [ ] **Step 4: Verify.** `cargo test -p karl-canon && cargo test -p covenant --lib && npm test && npm run build` → PASS.

- [ ] **Step 5: Commit.** `git add -u crates ui && git commit -m "feat(evals-ui): aggregate score chips and per-case retry"`

---

## Wave 3 — Unit review/lint

### Task 8: Static lint in `crates/canon`

**Files:**
- Create: `crates/canon/src/review.rs`
- Modify: `crates/canon/src/lib.rs` (mod + re-exports)

**Interfaces:**
- Consumes: `read_source(repo_root, kind, name)` (`crates/canon/src/install.rs:224`), `parse_frontmatter_str`.
- Produces: `pub enum LintSeverity { Error, Warn }`; `pub struct LintFinding { pub severity: LintSeverity, pub message: String, pub hint: String }` (both `Serialize` + `Clone` + `Debug`); `pub fn lint_unit(repo_root: &Path, kind: ContextKind, name: &str) -> Result<Vec<LintFinding>, String>`.

- [ ] **Step 1: Write failing tests** in `review.rs` (tempdir fixture writing a unit under `.covenant/canon/`, mirroring the fixture style of `eval.rs`'s tests):

```rust
#[test]
fn lint_flags_missing_description_and_use_when() {
    let dir = tempfile::tempdir().unwrap();
    write_unit(dir.path(), ContextKind::Skill, "demo", "---\nname: demo\n---\n\nBody here.\n");
    let f = lint_unit(dir.path(), ContextKind::Skill, "demo").unwrap();
    assert!(f.iter().any(|x| x.message.contains("description")));
}

#[test]
fn lint_passes_a_well_formed_skill() {
    let dir = tempfile::tempdir().unwrap();
    write_unit(
        dir.path(), ContextKind::Skill, "demo",
        "---\nname: demo\ndescription: Cut a release end-to-end. Use when the user asks to cut a release.\n---\n\nSteps...\n",
    );
    assert!(lint_unit(dir.path(), ContextKind::Skill, "demo").unwrap().is_empty());
}

#[test]
fn lint_flags_name_folder_mismatch() {
    let dir = tempfile::tempdir().unwrap();
    write_unit(dir.path(), ContextKind::Skill, "demo", "---\nname: other\ndescription: X. Use when Y.\n---\n\nB.\n");
    let f = lint_unit(dir.path(), ContextKind::Skill, "demo").unwrap();
    assert!(f.iter().any(|x| x.message.contains("name")));
}
```

(`write_unit` is a test helper that writes the file at `source_path(root, kind, name)` — reuse/adapt the existing eval-test fixture helpers.)

- [ ] **Step 2: Run to verify failure.** `cargo test -p karl-canon lint_` → FAIL.

- [ ] **Step 3: Implement** deterministic checks, each finding carrying an actionable `hint`:
  - source readable (else single `Error`);
  - frontmatter parses and has `description` (`Error`, hint: "add a description: line to the frontmatter");
  - description length 20..=500 chars (`Warn`);
  - skill/command/agent kinds: description contains `use when` case-insensitively (`Warn`, hint: "start the trigger clause with 'Use when …' so agents know when to load it");
  - frontmatter `name` (when present) equals the folder `name` (`Error`);
  - body after frontmatter non-empty (`Error`).
  No trait, no registry of rules — one function with a `Vec::push` per check (`// ponytail: flat check list; a rules table when kinds diverge for real`).

- [ ] **Step 4: Verify.** `cargo test -p karl-canon` → PASS.

- [ ] **Step 5: Commit.** `git add crates/canon/src/review.rs crates/canon/src/lib.rs && git commit -m "feat(canon): static unit lint with actionable findings"`

### Task 9: `canon_lint_unit` + `canon_review_unit` commands

**Files:**
- Modify: `crates/app/src/canon_eval.rs` (new commands beside `canon_draft_evals`; reuse its `resolve_route(Role::Summary)` + `read_source` pattern)
- Modify: `crates/app/src/lib.rs` (register both in the `invoke_handler` list where `canon_draft_evals` is registered)
- Modify: `ui/src/api.ts` (typed wrappers)

**Interfaces:**
- Consumes: `lint_unit` (Task 8), the drafter's dispatch pattern (`canon_eval.rs:1247`).
- Produces:
  - `#[tauri::command] async fn canon_lint_unit(cwd, kind, name) -> Result<Vec<karl_canon::LintFinding>, String>` (spawn_blocking around `lint_unit`);
  - `#[tauri::command] async fn canon_review_unit(state, cwd, kind, name) -> Result<Vec<ReviewSuggestion>, String>` with `pub struct ReviewSuggestion { pub area: String, pub suggestion: String }` (Serialize);
  - `pub fn parse_review(text: &str) -> Result<Vec<ReviewSuggestion>, String>`;
  - api.ts: `canonLintUnit`, `canonReviewUnit` wrappers + `CanonLintFinding`, `CanonReviewSuggestion` interfaces.

- [ ] **Step 1: Write failing test** for the parser:

```rust
#[test]
fn parse_review_extracts_suggestions_and_caps_at_seven() {
    let text = r#"ok: [{"area":"triggers","suggestion":"add 'Use when'"},{"area":"description","suggestion":"name the output"}]"#;
    let s = parse_review(text).unwrap();
    assert_eq!(s.len(), 2);
    let many = format!("[{}]", vec![r#"{"area":"a","suggestion":"s"}"#; 12].join(","));
    assert_eq!(parse_review(&many).unwrap().len(), 7);
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p covenant --lib parse_review` → FAIL.

- [ ] **Step 3: Implement.** `parse_review` = same bracket-extraction as `parse_drafts`, deserialize, drop entries with empty `area`/`suggestion`, truncate to 7. Review prompt:

```rust
const REVIEW_SYSTEM: &str = "You audit an AI agent context unit (skill, command, agent, context \
doc, or memory) for quality. Given its source, return 3-7 concrete, actionable suggestions \
covering: trigger quality (does the description say when to use it), description completeness, \
clarity and structure of the body, and anything misleading. Reply with ONLY a JSON array, no prose \
and no code fences: [{\"area\": \"triggers|description|clarity|structure\", \"suggestion\": \"one \
sentence, imperative\"}, ...]";
```

`canon_review_unit` mirrors `canon_draft_evals`: validate name, `read_source` via spawn_blocking, one `collect_oneshot` call (max_tokens 1024), `parse_review`, no retry (`// ponytail: no retry — review is on-demand and re-clickable`). On-demand only; nothing calls it automatically.

- [ ] **Step 4: Verify.** `cargo test -p covenant --lib && npm run build` → PASS.

- [ ] **Step 5: Commit.** `git add crates/app/src/canon_eval.rs crates/app/src/lib.rs ui/src/api.ts && git commit -m "feat(canon): unit lint + LLM review commands"`

### Task 10: Review surface in the cockpit Manage view

**Files:**
- Modify: `ui/src/canon/evals-cockpit.ts` (the Manage view), `ui/src/canon/evals-cockpit.css`
- Test: `ui/src/canon/evals-cockpit.test.ts`

**Interfaces:**
- Consumes: `canonLintUnit`, `canonReviewUnit` (Task 9).
- Produces: a "Review" section in Manage: lint findings render immediately on open (cheap, local); a `Run review` button fetches LLM suggestions on demand and renders them beneath.

- [ ] **Step 1: Write failing test** for the pure renderer (extract one):

```ts
import { renderFindings } from "./evals-cockpit";

it("renderFindings orders errors before warnings", () => {
  const host = document.createElement("div");
  renderFindings(host, [
    { severity: "warn", message: "w", hint: "" },
    { severity: "error", message: "e", hint: "fix" },
  ] as never);
  const rows = host.querySelectorAll(".evc-lint-row");
  expect(rows[0].textContent).toContain("e");
  expect(rows).toHaveLength(2);
});
```

- [ ] **Step 2: Run to verify failure.** `npm test -- evals-cockpit` → FAIL.

- [ ] **Step 3: Implement.** `renderFindings(host, findings)` sorts errors first, one row each: severity glyph (existing error/warn SVGs), message, hint in dimmed text. Manage view: on open, fire `canonLintUnit` and render (empty → a quiet "No lint findings." line); `Run review` button (disabled while in flight, label → "Reviewing…") → `canonReviewUnit` → rows of `area` chip + suggestion text. Errors from either call render as a single dimmed line, never a toast loop. The Canon panel's unit detail view (`ui/src/canon/panel.ts`) reuses the exported `renderFindings` + the same review button in its unit detail section — one renderer, two mounts (spec requires both surfaces).

- [ ] **Step 4: Verify.** `npm test && npm run build` → PASS.

- [ ] **Step 5: Commit.** `git add ui/src/canon/evals-cockpit.ts ui/src/canon/evals-cockpit.css ui/src/canon/evals-cockpit.test.ts && git commit -m "feat(evals-ui): lint + LLM review section in cockpit manage view"`

---

## Wave 4 — Informative publish gate

### Task 11: Record unit content hash per run; freshness helper

**Files:**
- Modify: `crates/canon/src/eval.rs` (`EvalRunRecord` gains `#[serde(default)] pub content_hash: String`; new `unit_content_hash`, `evals_fresh`)
- Modify: `crates/app/src/canon_eval.rs` (history-append site fills `content_hash`)

**Interfaces:**
- Consumes: `read_source` (all evaluable kinds), `read_skill_package` for `ContextKind::Skill`.
- Produces: `pub fn unit_content_hash(repo_root: &Path, kind: ContextKind, name: &str) -> Option<String>` (None when unreadable); `pub fn evals_fresh(repo_root: &Path, kind: ContextKind, name: &str) -> bool` — true iff the unit has authored evals AND the newest history record for it has a non-empty `content_hash` equal to the current one.

- [ ] **Step 1: Write failing tests** (tempdir fixtures as in Task 8):

```rust
#[test]
fn unit_content_hash_changes_when_source_changes() {
    let dir = tempfile::tempdir().unwrap();
    write_unit(dir.path(), ContextKind::Command, "h", "---\ndescription: d\n---\nv1");
    let h1 = unit_content_hash(dir.path(), ContextKind::Command, "h").unwrap();
    write_unit(dir.path(), ContextKind::Command, "h", "---\ndescription: d\n---\nv2");
    assert_ne!(h1, unit_content_hash(dir.path(), ContextKind::Command, "h").unwrap());
}

#[test]
fn evals_fresh_only_when_last_run_hash_matches() {
    let dir = tempfile::tempdir().unwrap();
    write_unit(dir.path(), ContextKind::Command, "h", "src");
    write_eval_toml(dir.path(), ContextKind::Command, "h", "case-a"); // authored eval exists
    assert!(!evals_fresh(dir.path(), ContextKind::Command, "h")); // never run
    let hash = unit_content_hash(dir.path(), ContextKind::Command, "h").unwrap();
    append_history(dir.path(), &EvalRunRecord {
        kind: "command".into(), name: "h".into(), passed: 1, total: 1,
        at_ms: 1, cases: vec![], score: 100, max_score: 100, content_hash: hash,
    }).unwrap();
    assert!(evals_fresh(dir.path(), ContextKind::Command, "h"));
    write_unit(dir.path(), ContextKind::Command, "h", "src v2"); // content drifts
    assert!(!evals_fresh(dir.path(), ContextKind::Command, "h"));
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p karl-canon evals_fresh` → FAIL.

- [ ] **Step 3: Implement.** `unit_content_hash` = sha256 (reuse the `sha2` pattern of `scenario_hash`) over the unit source: for `Skill`, hash `skill_toml` bytes + `\0` + `skill_md` bytes from `read_skill_package`; other kinds, hash `read_source` output. `evals_fresh` = `!read_evals(..).is_empty()` && last matching `read_history` record (iterate `.rev()`, filter `kind.slug()`/`name`) has non-empty `content_hash == unit_content_hash(..)`. In `canon_run_evals`, compute the hash once at run start and stamp it on the appended `EvalRunRecord`; partial runs (`only: Some(_)`) stamp `String::new()` — a single-case retry must not certify the whole suite fresh.

- [ ] **Step 4: Verify.** `cargo test -p karl-canon && cargo test -p covenant --lib` → PASS.

- [ ] **Step 5: Commit.** `git add crates/canon/src/eval.rs crates/app/src/canon_eval.rs && git commit -m "feat(canon): per-run unit content hash + evals_fresh staleness check"`

### Task 12: Publish carries eval scores; stale publish auto-enqueues a run

**Files:**
- Modify: `crates/app/src/lib.rs` (`canon_publish` ~3226 — add `app: AppHandle` param)
- Modify: `crates/app/src/canon_registry.rs` (`publish` ~185 gains `evals: Option<serde_json::Value>`)
- Modify: `crates/app/src/canon_eval.rs` (make the internal run entry callable from `canon_publish` — extract the body of `canon_run_evals` into `pub(crate) async fn run_evals_inner(app, settings, cwd, kind, name, baseline, only) -> Result<(), String>` and have the command delegate)
- Modify: `ui/src/api.ts` (publish wrapper passes nothing new — the backend decides)

**Interfaces:**
- Consumes: `evals_fresh`, `unit_content_hash` (Task 11), `read_results` aggregate.
- Produces: publish body gains an optional `"evals": {"score": u32, "max_score": u32, "baseline_score": u32|null, "fresh": bool}` object (omitted when the unit has no non-stale results); on `fresh == false` with authored evals, `canon_publish` fire-and-forgets `run_evals_inner` (tokio::spawn) **after** the publish call returns — publish never waits.

- [ ] **Step 1: Write failing test** for the aggregate helper in `canon_eval.rs`:

```rust
/// Sum non-stale stored results for a unit into a publish-ready aggregate.
pub(crate) fn eval_aggregate(
    repo_root: &std::path::Path,
    kind: karl_canon::ContextKind,
    name: &str,
) -> Option<serde_json::Value> { ... }
```

```rust
#[test]
fn eval_aggregate_sums_non_stale_results_only() {
    let dir = tempfile::tempdir().unwrap();
    let mk = |id: &str, score: u32, stale: bool| karl_canon::EvalResult {
        eval_id: id.into(), pass: score == 100, reason: String::new(), ran_at_ms: 1,
        duration_ms: 1, baseline_pass: Some(false), stale,
        executor_model: None, judge_model: None,
        score, max_score: 100, baseline_score: Some(10),
    };
    karl_canon::write_result(dir.path(), karl_canon::ContextKind::Skill, "s", &mk("a", 100, false)).unwrap();
    karl_canon::write_result(dir.path(), karl_canon::ContextKind::Skill, "s", &mk("b", 0, true)).unwrap();
    let agg = eval_aggregate(dir.path(), karl_canon::ContextKind::Skill, "s").unwrap();
    assert_eq!(agg["score"], 100);
    assert_eq!(agg["max_score"], 100); // stale row excluded
    assert_eq!(agg["baseline_score"], 10);
}
```

- [ ] **Step 2: Run to verify failure.** `cargo test -p covenant --lib eval_aggregate` → FAIL.

- [ ] **Step 3: Implement.**
  - `eval_aggregate`: read `read_results`, take the unit's map, filter `!stale && max_score > 0`, sum `score`/`max_score`/`baseline_score` (baseline term is `None` overall if any contributing row lacks it), return `None` when nothing contributes.
  - `canon_registry::publish`: append `"evals": evals` to the body only when `Some` (server ignores unknown keys today, so this is safe to ship before Task 13).
  - `canon_publish`: compute `fresh = karl_canon::evals_fresh(&repo, k, &name)`; build `evals = eval_aggregate(..).map(|mut v| { v["fresh"] = fresh.into(); v })`; pass to both publish call sites (skill + generic). After a successful publish, if `!fresh` and the unit has authored evals, `tokio::spawn(run_evals_inner(app, ...))` with `baseline: None, only: None` — the cockpit picks it up via the run registry like any other run.
  - Extract `run_evals_inner` mechanically (the command keeps its `#[tauri::command]` signature and delegates; `State<AppState>` unwraps to the `Arc<Mutex<Settings>>` clone the inner fn takes).

- [ ] **Step 4: Verify.** `cargo test -p covenant --lib && cargo clippy --workspace --all-targets && npm run build` → PASS.

- [ ] **Step 5: Commit.** `git add -u crates ui && git commit -m "feat(publish): eval score aggregate in publish payload + auto-run when stale"`

### Task 13: Server accepts + serves eval score fields (covenant-server repo)

**Files (separate repo `~/Sources/covenant-server`):**
- Modify: the `POST /cdlc/packages` handler + package row model
- Create: a sqlx migration adding nullable columns
- Test: `#[sqlx::test]` beside the handler's existing tests (memory: `covenant-server` DB tests use `#[sqlx::test]` + `DATABASE_URL`; there is no handler-level harness — test at the DB/query layer)

**Interfaces:**
- Consumes: publish body's optional `evals` object (Task 12).
- Produces: `packages` table gains nullable `eval_score INTEGER`, `eval_max_score INTEGER`, `eval_baseline_score INTEGER`, `eval_fresh BOOLEAN`; package list/detail responses include them (null → absent via `skip_serializing_if`). Existing `eval_passed`/`eval_total` aggregates stay untouched.

- [ ] **Step 1: Discovery.** In the server repo: locate the packages insert handler (`rg "cdlc/packages" src/`) and its row struct; note the migrations dir naming convention.

- [ ] **Step 2: Write failing `#[sqlx::test]`:** insert a package row with the new columns populated, read it back through the existing package query, assert the four values round-trip and that a row inserted without them reads back as `None`.

- [ ] **Step 3: Implement.** Migration `ALTER TABLE packages ADD COLUMN eval_score INTEGER; ...` (nullable ×4); deserialize the optional `evals` object in the publish handler into the insert; add the fields to the row struct + response serialization.

- [ ] **Step 4: Verify.** `DATABASE_URL=... cargo test` in the server repo → PASS.

- [ ] **Step 5: Commit + deploy** per that repo's flow (`git commit -m "feat(cdlc): eval score fields on packages"`; deployment follows the covenant-server Pulzen redeploy runbook — do not deploy without Karluiz's go).

### Task 14: Registry card shows score % + lift

**Files:**
- Modify: `crates/app/src/canon_registry.rs` (registry pkg struct ~37 gains the four optional fields)
- Modify: `ui/src/api.ts` (registry pkg interface), `ui/src/canon/panel.ts` (the card that currently renders `eval_passed`/`eval_total`)
- Test: `ui/src/canon/panel.test.ts`

**Interfaces:**
- Consumes: server fields from Task 13 (absent on a pre-upgrade server → `None` → hidden, same pattern as the existing `eval_passed` comment at `canon_registry.rs:37`).
- Produces: card line `Score 75% · Lift +60` when `eval_max_score > 0`; "evals stale" dimmed suffix when `eval_fresh === false`; nothing renders when fields are absent.

- [ ] **Step 1: Write failing test** for the pure label helper in `panel.ts`:

```ts
import { evalScoreLabel } from "./panel";

it("evalScoreLabel formats score, lift and staleness", () => {
  expect(evalScoreLabel({ eval_score: 75, eval_max_score: 100, eval_baseline_score: 15, eval_fresh: true } as never))
    .toBe("Score 75% · Lift +60");
  expect(evalScoreLabel({ eval_score: 75, eval_max_score: 100, eval_baseline_score: null, eval_fresh: false } as never))
    .toBe("Score 75% · evals stale");
  expect(evalScoreLabel({ eval_max_score: 0 } as never)).toBe("");
});
```

- [ ] **Step 2: Run to verify failure.** `npm test -- panel` → FAIL.

- [ ] **Step 3: Implement.** Rust struct fields `#[serde(default)] pub eval_score: Option<i64>` ×3 + `#[serde(default)] pub eval_fresh: Option<bool>`; TS interface mirrors; `evalScoreLabel` builds the string (lift only when baseline present; staleness suffix when `eval_fresh === false`); render it where the pass/total chip renders today, hidden when empty.

- [ ] **Step 4: Verify.** `cargo test -p covenant --lib && npm test && npm run build` → PASS.

- [ ] **Step 5: Commit.** `git add crates/app/src/canon_registry.rs ui/src/api.ts ui/src/canon/panel.ts ui/src/canon/panel.test.ts && git commit -m "feat(registry-ui): eval score + lift on package cards"`

---

## Final verification (after Task 14)

- [ ] `cargo fmt --all && cargo clippy --workspace --all-targets` clean.
- [ ] `cargo test --workspace` (note memory: telegram tests hang under broad `cargo test` — if it hangs, fall back to `-p karl-canon -p covenant --lib`).
- [ ] `npm test && npm run build` from repo root.
- [ ] Live smoke via the `verify` skill (DOM-dump recipe): run one criteria eval against a toy skill in the dev app; assert the detail POST carries `criteria.length > 0` and a numeric `score`.
- [ ] Legacy check: an existing rubric-only eval (e.g. horizon's) still runs, still shows binary pass, and its old on-disk results render unchanged in the cockpit.
