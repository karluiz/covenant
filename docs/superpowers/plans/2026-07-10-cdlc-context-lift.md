# CDLC Context Lift Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the per-skill eval pass-rate into a controlled A/B **Context Lift** = `pass-rate(with the skill projected) − pass-rate(without)`, and surface it in the Canon Loop.

**Architecture:** The eval runner already runs a scenario in a sandbox with the skill projected + a judge. Add a **baseline arm** — the same scenario/rubric in a sandbox with NO skill — and store both verdicts per eval. The Loop shows the lift.

**Tech Stack:** Rust (`crates/canon` eval store, `crates/app` runner), TypeScript (`ui/src/canon/cockpit/view.ts`, Vitest).

## Global Constraints

- Rust: no `unwrap()` outside `#[cfg(test)]`. Serialized structs derive `Serialize`.
- `EvalResult.baseline_pass` is `Option<bool>` with `#[serde(default)]` → pre-existing stored results deserialize to `None` ("baseline not measured", excluded from lift). No migration.
- The baseline sandbox is IDENTICAL to the treatment sandbox except the skill is NOT projected (same deny-list `settings.json`, same read-only tools, same timeout).
- Lift shows only for a **clean A/B** (every eval for the skill has a baseline, i.e. `baseline_total == total`); otherwise fall back to the absolute pass-rate.
- TypeScript strict; no `as any` without a comment. Tauri commands wrapped in `api.ts`.
- Tests from repo ROOT: `npm test`, `cargo test -p karl-canon` / `cargo test -p covenant`. Never vitest from `ui/`.
- UI copy English. Conventional Commits; stage explicit paths.
- Worktree `.claude/worktrees/cdlc-context-lift` (branch `feat/cdlc-context-lift`).
- Known pre-existing unrelated failure: `ui/src/tasker/panel.test.ts` "calendar sets and clears dueDate" — ignore.

---

### Task 1: Backend — `EvalResult.baseline_pass`

**Files:**
- Modify: `crates/canon/src/eval.rs` (`EvalResult` struct)
- Test: inline in `crates/canon/src/eval.rs`

**Interfaces:**
- Produces: `EvalResult { eval_id, pass, reason, ran_at_ms, duration_ms, baseline_pass: Option<bool> }`. `pass` = treatment (skill projected); `baseline_pass = Some(b)` for the no-skill arm, `None` when not measured.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `crates/canon/src/eval.rs`:

```rust
#[test]
fn eval_result_baseline_pass_defaults_to_none_and_roundtrips() {
    // Old JSON without the field → None.
    let old = r#"{"eval_id":"e1","pass":true,"reason":"ok","ran_at_ms":1,"duration_ms":2}"#;
    let r: EvalResult = serde_json::from_str(old).unwrap();
    assert_eq!(r.baseline_pass, None);

    // New value round-trips.
    let mut r2 = r.clone();
    r2.baseline_pass = Some(false);
    let s = serde_json::to_string(&r2).unwrap();
    let back: EvalResult = serde_json::from_str(&s).unwrap();
    assert_eq!(back.baseline_pass, Some(false));
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p karl-canon eval_result_baseline_pass_defaults_to_none_and_roundtrips`
Expected: FAIL — no field `baseline_pass`.

- [ ] **Step 3: Add the field**

In `crates/canon/src/eval.rs`, add to `EvalResult` (after `duration_ms`):

```rust
    #[serde(default)]
    pub baseline_pass: Option<bool>,
```

Update any existing test/helper in this file that constructs `EvalResult` with a struct literal (e.g. the `mk` closure in `write_result_roundtrips_and_pass_rate`) to add `baseline_pass: None,` so it still compiles.

- [ ] **Step 4: Run to verify it passes + full suite**

Run: `cargo test -p karl-canon eval_result_baseline_pass_defaults_to_none_and_roundtrips && cargo test -p karl-canon`
Expected: PASS (all green).

- [ ] **Step 5: Commit**

```bash
git add crates/canon/src/eval.rs
git commit -m "feat(canon): EvalResult.baseline_pass for A/B context-lift"
```

---

### Task 2: Backend — baseline arm in the runner + lift in the summary

**Files:**
- Modify: `crates/app/src/canon_eval.rs` (`prepare_sandbox_bare`, `run_baseline`, `run_scenario_in`, `canon_run_evals`, `EvalSkillSummary`, `canon_eval_summary`)
- Test: inline in `crates/app/src/canon_eval.rs`

**Interfaces:**
- Consumes: `EvalResult.baseline_pass` (Task 1), existing `prepare_sandbox`/`judge`/`classify_output`.
- Produces: `prepare_sandbox_bare(repo_root) -> io::Result<TempDir>`; `run_baseline(repo_root, scenario) -> HarnessOutcome`; `EvalSkillSummary { skill, passed, total, baseline_passed, baseline_total }`.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` in `crates/app/src/canon_eval.rs`:

```rust
#[test]
fn prepare_sandbox_bare_has_settings_but_no_skill() {
    let tmp = tempfile::tempdir().unwrap();
    let sbox = prepare_sandbox_bare(tmp.path()).unwrap();
    assert!(sbox.path().join(".claude/settings.json").exists(), "deny-list settings present");
    assert!(!sbox.path().join(".claude/skills").exists(), "no skill projected in baseline");
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant prepare_sandbox_bare_has_settings_but_no_skill`
Expected: FAIL — `prepare_sandbox_bare` not found.

- [ ] **Step 3: Add `prepare_sandbox_bare` + extract `run_scenario_in` + `run_baseline`**

In `crates/app/src/canon_eval.rs`, add next to `prepare_sandbox`:

```rust
/// Baseline sandbox: the same deny-list `settings.json` as `prepare_sandbox`,
/// but with NO skill projected — the control arm for context-lift.
pub(crate) fn prepare_sandbox_bare(_repo_root: &Path) -> std::io::Result<tempfile::TempDir> {
    let sbox = tempfile::Builder::new().prefix("eval-sbox-").tempdir()?;
    std::fs::create_dir_all(sbox.path().join(".claude"))?;
    std::fs::write(sbox.path().join(".claude/settings.json"), denylist_settings())?;
    Ok(sbox)
}
```

Extract the command-execution tail of `run_harness` into a shared helper so both
arms use identical execution. Add:

```rust
/// Run `claude -p <scenario>` inside an already-prepared sandbox dir.
async fn run_scenario_in(sbox_path: &Path, scenario: &str, started: Instant) -> HarnessOutcome {
    let mut cmd = tokio::process::Command::new("claude");
    cmd.args(harness_args(scenario))
        .current_dir(sbox_path)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    let (transcript, status) =
        match tokio::time::timeout(Duration::from_secs(HARNESS_TIMEOUT_SECS), cmd.output()).await {
            Err(_) => (String::new(), HarnessStatus::TimedOut),
            Ok(Err(e)) => (String::new(), HarnessStatus::Skipped(format!("claude spawn failed: {e}"))),
            Ok(Ok(out)) => {
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                let status = classify_output(out.status.success(), &stdout, &stderr);
                (stdout, status)
            }
        };
    HarnessOutcome { transcript, status, duration_ms: started.elapsed().as_millis() as u64 }
}
```

Refactor `run_harness` so its command block (currently the `let mut cmd = …` through the returned `HarnessOutcome`) is replaced by `run_scenario_in(sbox.path(), scenario, started).await` (keep the `claude_available` check and `prepare_sandbox` call). Add the baseline runner:

```rust
/// The baseline (no-skill) arm: same scenario in `prepare_sandbox_bare`.
pub async fn run_baseline(repo_root: &Path, scenario: &str) -> HarnessOutcome {
    let started = Instant::now();
    let sbox = match prepare_sandbox_bare(repo_root) {
        Ok(s) => s,
        Err(e) => {
            return HarnessOutcome {
                transcript: String::new(),
                status: HarnessStatus::Skipped(format!("baseline sandbox prep failed: {e}")),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
    };
    run_scenario_in(sbox.path(), scenario, started).await
}
```

- [ ] **Step 4: Run the baseline arm in `canon_run_evals`**

In `canon_run_evals`, after the treatment `judge(...)` produces the treatment
`Verdict` and BEFORE building the `EvalResult`, run + judge the baseline arm and
fold the result into `baseline_pass`. Replace the `Ok(v) => { … }` treatment
branch body so it computes the baseline:

```rust
            Ok(v) => {
                // Baseline arm: same scenario/rubric, no skill projected.
                let base_outcome = run_baseline(&repo_root, &ev.scenario).await;
                let baseline_pass = match base_outcome.status {
                    HarnessStatus::Ran => {
                        match judge(&settings, &ev.scenario, &ev.rubric, &base_outcome.transcript).await {
                            Ok(bv) => Some(bv.pass),
                            Err(_) => None, // baseline judge failed → lift not measurable for this eval
                        }
                    }
                    _ => None, // baseline run skipped/timed out → no baseline for this eval
                };
                let result = karl_canon::EvalResult {
                    eval_id: ev.id.clone(),
                    pass: v.pass,
                    reason: v.reason.clone(),
                    ran_at_ms: chrono::Utc::now().timestamp_millis(),
                    duration_ms: outcome.duration_ms,
                    baseline_pass,
                };
                if let Err(e) = karl_canon::write_result(&repo_root, &skill, &result) {
                    tracing::warn!(target: "canon", error = %e, "write_result failed");
                }
                emit_progress(&app, &skill, &ev.id, if v.pass { "pass" } else { "fail" }, &v.reason);
            }
```

(The `emit_progress` status token stays `"pass"`/`"fail"` — the UI progress
contract is unchanged; baseline is persisted in the result, surfaced via the
summary.)

- [ ] **Step 5: Extend `EvalSkillSummary` + `canon_eval_summary`**

Change the struct:

```rust
pub struct EvalSkillSummary {
    pub skill: String,
    pub passed: usize,
    pub total: usize,
    pub baseline_passed: usize,
    pub baseline_total: usize,
}
```

Update `canon_eval_summary`'s `.map(...)` to populate the new fields:

```rust
        .map(|(skill, inner)| {
            let passed = inner.values().filter(|r| r.pass).count();
            let baseline_total = inner.values().filter(|r| r.baseline_pass.is_some()).count();
            let baseline_passed = inner.values().filter(|r| r.baseline_pass == Some(true)).count();
            EvalSkillSummary { skill, passed, total: inner.len(), baseline_passed, baseline_total }
        })
```

- [ ] **Step 6: Run the test + build**

Run: `cargo test -p covenant prepare_sandbox_bare_has_settings_but_no_skill && cargo build -p covenant`
Expected: test PASS; covenant builds clean. (The agentic A/B run itself needs a real `claude` binary and is exercised manually — same as the existing runner.)

- [ ] **Step 7: Commit**

```bash
git add crates/app/src/canon_eval.rs
git commit -m "feat(canon): baseline arm + lift fields in the eval runner"
```

---

### Task 3: Frontend — Context Lift in the Loop

**Files:**
- Modify: `ui/src/api.ts` (`EvalSkillSummary`)
- Create: `ui/src/canon/cockpit/lift.ts` (pure lift-formatting helper)
- Modify: `ui/src/canon/cockpit/view.ts` (`renderLoopSection` eval box)
- Test: `ui/src/canon/cockpit/lift.test.ts`

**Interfaces:**
- Consumes: `EvalSkillSummary { skill, passed, total, baseline_passed, baseline_total }`.
- Produces: `liftRow(s: EvalSkillSummary) -> { label: string; sign: "pos"|"neg"|"neutral"|"none"; pct: number }` and `groupVerdict(rows: EvalSkillSummary[]) -> string`.

- [ ] **Step 1: Update `ui/src/api.ts`**

The Rust `EvalSkillSummary` has NO `#[serde(rename_all)]`, so it serializes
field names verbatim — the wire fields are snake_case (`passed`, `total`, and now
`baseline_passed`, `baseline_total`). The existing TS interface already uses
`passed`/`total` (snake matches for single words). Add the two new fields in
snake_case to mirror the wire exactly:

```typescript
export interface EvalSkillSummary {
  skill: string;
  passed: number;
  total: number;
  baseline_passed: number;
  baseline_total: number;
}
```

(`lift.ts` and `lift.test.ts` below reference `s.baseline_passed` / `s.baseline_total` — keep them snake_case to match.)

- [ ] **Step 2: Write the failing test for the lift helper**

Create `ui/src/canon/cockpit/lift.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { liftRow, groupVerdict } from "./lift";

describe("liftRow", () => {
  it("computes a positive lift for a clean A/B", () => {
    const r = liftRow({ skill: "kyc", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 });
    expect(r.sign).toBe("pos");
    expect(r.pct).toBe(20); // 80% - 60%
    expect(r.label).toContain("+20");
    expect(r.label).toContain("80%");
    expect(r.label).toContain("60%");
  });

  it("flags negative lift", () => {
    const r = liftRow({ skill: "x", passed: 5, total: 10, baseline_passed: 7, baseline_total: 10 });
    expect(r.sign).toBe("neg");
    expect(r.pct).toBe(-20);
  });

  it("falls back to absolute pass-rate when the A/B is incomplete", () => {
    const r = liftRow({ skill: "x", passed: 8, total: 10, baseline_passed: 0, baseline_total: 0 });
    expect(r.sign).toBe("none");
    expect(r.label).toContain("80%"); // absolute only, no lift
  });
});

describe("groupVerdict", () => {
  it("summarizes average lift across clean-A/B skills", () => {
    const v = groupVerdict([
      { skill: "a", passed: 8, total: 10, baseline_passed: 6, baseline_total: 10 }, // +20
      { skill: "b", passed: 9, total: 10, baseline_passed: 5, baseline_total: 10 }, // +40
    ]);
    expect(v).toContain("+30"); // average
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run (repo ROOT): `npm test -- ui/src/canon/cockpit/lift.test`
Expected: FAIL — `./lift` not found.

- [ ] **Step 4: Implement `ui/src/canon/cockpit/lift.ts`**

```typescript
import type { EvalSkillSummary } from "../../api";

export interface LiftView {
  label: string;
  sign: "pos" | "neg" | "neutral" | "none";
  pct: number; // lift in percentage points; 0 when sign === "none"
}

/** A clean A/B needs every eval to carry a baseline. */
function isCleanAB(s: EvalSkillSummary): boolean {
  return s.baseline_total > 0 && s.baseline_total === s.total;
}

export function liftRow(s: EvalSkillSummary): LiftView {
  const withPct = s.total > 0 ? Math.round((s.passed / s.total) * 100) : 0;
  if (!isCleanAB(s)) {
    return { label: `${withPct}% · run baseline for lift`, sign: "none", pct: 0 };
  }
  const withoutPct = Math.round((s.baseline_passed / s.baseline_total) * 100);
  const pct = withPct - withoutPct;
  const sign = pct > 0 ? "pos" : pct < 0 ? "neg" : "neutral";
  const arrow = pct > 0 ? "+" : "";
  return {
    label: `${arrow}${pct} pts · ${withPct}% with / ${withoutPct}% without`,
    sign,
    pct,
  };
}

/** One-line group verdict over the clean-A/B skills (ignores incomplete ones). */
export function groupVerdict(rows: EvalSkillSummary[]): string {
  const clean = rows.filter(isCleanAB);
  if (clean.length === 0) return "Run evals with a baseline to measure context lift.";
  const lifts = clean.map((s) => liftRow(s).pct);
  const avg = Math.round(lifts.reduce((a, b) => a + b, 0) / lifts.length);
  const nonPos = clean.filter((s) => liftRow(s).pct <= 0).length;
  const head = `Context adds ${avg > 0 ? "+" : ""}${avg} pts on average across ${clean.length} skill${clean.length === 1 ? "" : "s"}.`;
  return nonPos > 0 ? `${head} ${nonPos} show ≤0 lift — prune candidates.` : head;
}
```

- [ ] **Step 5: Run to verify it passes**

Run (repo ROOT): `npm test -- ui/src/canon/cockpit/lift.test`
Expected: PASS.

- [ ] **Step 6: Wire the Loop UI (`ui/src/canon/cockpit/view.ts`)**

In `renderLoopSection`, replace the eval-box body (the `canonEvalSummary(cwd).then(...)` block that currently builds `meterRow(r.skill, \`${r.passed}/${r.total} · ${pct}%\`, pct, true)`) with lift rows + a verdict. Import `liftRow`, `groupVerdict` from `./lift`, then:

```typescript
      void canonEvalSummary(cwd)
        .then((evalSummary) => {
          if (evalSummary.length === 0) {
            evalBox.appendChild(this.note("Run evals on a skill to measure its context-lift (with vs without)."));
            return;
          }
          evalBox.appendChild(loopSubhead("Context lift"));
          const verdict = document.createElement("div");
          verdict.className = "canon-loop-verdict";
          verdict.textContent = groupVerdict(evalSummary);
          evalBox.appendChild(verdict);
          for (const r of evalSummary) {
            const lv = liftRow(r);
            // meterRow(label, value, percent, positive?) — reuse the existing helper.
            // Bar width = |pct| for a clean A/B (capped at 100), else the absolute pass-rate.
            const bar = lv.sign === "none"
              ? (r.total > 0 ? (r.passed / r.total) * 100 : 0)
              : Math.min(100, Math.abs(lv.pct));
            const row = meterRow(r.skill, lv.label, bar, lv.sign === "pos");
            row.classList.add(`lift-${lv.sign}`);
            evalBox.appendChild(row);
          }
        })
        .catch(() => {});
```

Add a minimal style hook (in the cockpit CSS or inline via the existing pattern)
so `lift-neg` reads as a warning; `lift-pos`/`lift-neutral`/`lift-none` can inherit
the default meter color. (If there is no dedicated cockpit stylesheet, a small
rule in `ui/src/canon/styles.css` mirroring the existing `.canon-loop`/meter
styling suffices — keep it to a color on `.lift-neg`.)

- [ ] **Step 7: Build + canon tests green**

Run (repo ROOT): `npm run build && npm test -- ui/src/canon`
Expected: TS compiles; canon suite PASS (incl. the new `lift.test`).

- [ ] **Step 8: Commit**

```bash
git add ui/src/api.ts ui/src/canon/cockpit/lift.ts ui/src/canon/cockpit/lift.test.ts ui/src/canon/cockpit/view.ts ui/src/canon/styles.css
git commit -m "feat(canon): Context Lift rows + verdict in the Loop"
```

---

## Final verification

- [ ] `cargo test -p karl-canon` — green.
- [ ] `cargo test -p covenant prepare_sandbox_bare_has_settings_but_no_skill` + `cargo build -p covenant` — green/clean.
- [ ] `npm run build` (repo ROOT) — clean.
- [ ] `npm test -- ui/src/canon` (repo ROOT) — green (incl. `lift.test`).
- [ ] Manual smoke (needs `claude` on PATH): author an eval for a skill, Run evals from the rail, then open cockpit → Loop → "Context lift" shows `+N pts · X% with / Y% without` per skill and a group verdict. Confirm a skill with no baseline yet shows the absolute pass-rate fallback.
