# CDLC Eval Runner — Plan A (local runner) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run a CDLC skill's evals locally — spawn `claude -p` on each scenario with the skill projected into a sandbox, LLM-judge the transcript, store pass/fail, and show the per-skill pass-rate in the panel's Loop section.

**Architecture:** Eval format + scanner + results store live in `crates/cdlc/src/eval.rs` (pure, fully tested). The agentic harness (sandboxed `claude -p`) + the LLM judge + the Tauri command live in `crates/app/src/cdlc_eval.rs`, reusing `karl_agent::provider::collect_oneshot` + `provider_resolve::resolve_route` (Role::Summary) for the judge, and `AppHandle::emit` for per-eval progress. The panel gets a "Run evals" button per skill and a real pass-rate in the Loop.

**Tech Stack:** Rust (tokio, serde, toml, tempfile), Tauri 2, TypeScript + xterm.js UI, vitest.

## Global Constraints

- Scope is **Plan A only** (local runner). Registry push (`POST /cdlc/evals`, cross-org pass-rate) is **Plan B** — out of scope here. The runner must emit a registry-ready `EvalResult { eval_id, pass, ran_at_ms }` so Plan B can POST without changing the runner.
- **Executor = claude** in v1. No pi/codex.
- **With-skill pass-rate only.** No red/green (without-skill baseline).
- **No `unwrap()`** outside `#[cfg(test)]` / `main()`. Errors: `thiserror` in libs, `String` at the Tauri boundary (match existing cdlc commands).
- **Never send raw ANSI to the LLM** — the harness captures `claude -p` stdout (plain text already; no extra strip needed, but do not feed terminal control bytes).
- **Sandbox safety:** the harness runs `claude -p` with `cwd` jailed to a throwaday temp dir + a deny-list `settings.json` + a hard timeout. This is the #1 risk; a hardened container sandbox is a later follow-up.
- **UI copy is English** (project rule). Group names render uppercase via CSS, not string mutation.
- **No native tooltips** — use `attachTooltip` from `ui/src/tooltip/tooltip.ts` (already imported in panel.ts).
- **TypeScript:** `strict`, no `as any` without a justifying comment. Run `npx tsc --noEmit` (NOT `npm run typecheck` — that script does not exist) and `npx vitest run` from the **repo root** (not `ui/`).

---

### Task 1: Eval format, scanner, and results store (`crates/cdlc/src/eval.rs`)

Pure Rust — fully unit-testable. No process spawning, no LLM.

**Files:**
- Create: `crates/cdlc/src/eval.rs`
- Modify: `crates/cdlc/src/lib.rs` (add `pub mod eval;` + re-exports)
- Test: inline `#[cfg(test)]` in `crates/cdlc/src/eval.rs`

**Interfaces:**
- Consumes: `crate::manifest::cdlc_dir(repo_root: &Path) -> PathBuf` (returns `<repo>/.covenant/cdlc`).
- Produces:
  - `struct Eval { pub id: String, pub scenario: String, pub rubric: String }` (derives `Debug, Clone, Serialize, Deserialize, PartialEq`)
  - `fn read_evals(repo_root: &Path, skill: &str) -> Vec<Eval>` — scans `cdlc_dir/skills/<skill>/evals/*.toml`, sorted by `id`, skipping unparseable files.
  - `struct EvalResult { pub eval_id: String, pub pass: bool, pub reason: String, pub ran_at_ms: i64, pub duration_ms: u64 }` (derives `Debug, Clone, Serialize, Deserialize, PartialEq`)
  - `fn read_results(repo_root: &Path) -> BTreeMap<String, BTreeMap<String, EvalResult>>` — outer key = skill, inner key = eval_id. Empty map if the file is missing/corrupt.
  - `fn write_result(repo_root: &Path, skill: &str, result: &EvalResult) -> std::io::Result<()>` — load, upsert `[skill][eval_id]`, write back to `cdlc_dir/eval-results.json` (pretty JSON).
  - `fn pass_rate(repo_root: &Path, skill: &str) -> Option<(usize, usize)>` — `(passed, total)` over stored results for that skill; `None` if no results.

- [ ] **Step 1: Write the failing test for eval parsing + scanning**

Add to `crates/cdlc/src/eval.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write_eval(dir: &std::path::Path, file: &str, body: &str) {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join(file), body).unwrap();
    }

    #[test]
    fn reads_and_sorts_evals_for_a_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let evals_dir = tmp.path().join(".covenant/cdlc/skills/kyc-peru/evals");
        write_eval(
            &evals_dir,
            "b.toml",
            "id = \"two\"\nscenario = \"S2\"\nrubric = \"R2\"\n",
        );
        write_eval(
            &evals_dir,
            "a.toml",
            "id = \"one\"\nscenario = \"S1\"\nrubric = \"R1\"\n",
        );
        // A non-toml file and a malformed toml are ignored.
        write_eval(&evals_dir, "notes.md", "not an eval");
        write_eval(&evals_dir, "bad.toml", "id = ");

        let evals = read_evals(tmp.path(), "kyc-peru");
        assert_eq!(evals.len(), 2, "two valid evals, malformed/non-toml skipped");
        assert_eq!(evals[0].id, "one", "sorted by id");
        assert_eq!(evals[1].scenario, "S2");
    }

    #[test]
    fn no_evals_dir_returns_empty() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(read_evals(tmp.path(), "missing").is_empty());
    }
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test -p karl-cdlc eval::tests::reads_and_sorts_evals_for_a_skill 2>&1 | tail -20`
Expected: FAIL — `read_evals` / `Eval` not found (does not compile).

- [ ] **Step 3: Implement the format + scanner**

Write the top of `crates/cdlc/src/eval.rs` (above the `#[cfg(test)]` block):

```rust
//! CDLC eval format + results store (Plan A of the eval runner).
//!
//! Evals are per-skill `.toml` files under
//! `.covenant/cdlc/skills/<skill>/evals/*.toml`. Each is a behavior test:
//! a `scenario` fed to a real executor and a `rubric` the judge applies to
//! the transcript. Results are stored in `.covenant/cdlc/eval-results.json`.

use crate::manifest::cdlc_dir;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Eval {
    pub id: String,
    pub scenario: String,
    pub rubric: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EvalResult {
    pub eval_id: String,
    pub pass: bool,
    pub reason: String,
    pub ran_at_ms: i64,
    pub duration_ms: u64,
}

fn evals_dir(repo_root: &Path, skill: &str) -> std::path::PathBuf {
    cdlc_dir(repo_root).join("skills").join(skill).join("evals")
}

/// Scan `.covenant/cdlc/skills/<skill>/evals/*.toml`, sorted by id.
/// Unparseable or non-toml files are skipped (warned), never fatal.
pub fn read_evals(repo_root: &Path, skill: &str) -> Vec<Eval> {
    let dir = evals_dir(repo_root, skill);
    let mut out = Vec::new();
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out, // no evals dir → no evals
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("toml") {
            continue;
        }
        match std::fs::read_to_string(&path).ok().and_then(|s| toml::from_str::<Eval>(&s).ok()) {
            Some(ev) => out.push(ev),
            None => tracing::warn!(target: "cdlc", path = %path.display(), "skipping unparseable eval"),
        }
    }
    out.sort_by(|a, b| a.id.cmp(&b.id));
    out
}

fn results_path(repo_root: &Path) -> std::path::PathBuf {
    cdlc_dir(repo_root).join("eval-results.json")
}

type ResultMap = BTreeMap<String, BTreeMap<String, EvalResult>>;

/// Load all stored results (skill → eval_id → result). Empty on missing/corrupt.
pub fn read_results(repo_root: &Path) -> ResultMap {
    std::fs::read_to_string(results_path(repo_root))
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// Upsert one result and persist. Creates `.covenant/cdlc/` if needed.
pub fn write_result(repo_root: &Path, skill: &str, result: &EvalResult) -> std::io::Result<()> {
    let mut all = read_results(repo_root);
    all.entry(skill.to_string())
        .or_default()
        .insert(result.eval_id.clone(), result.clone());
    let path = results_path(repo_root);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&all)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    std::fs::write(path, json)
}

/// `(passed, total)` over stored results for `skill`; `None` if none yet.
pub fn pass_rate(repo_root: &Path, skill: &str) -> Option<(usize, usize)> {
    let all = read_results(repo_root);
    let inner = all.get(skill)?;
    if inner.is_empty() {
        return None;
    }
    let passed = inner.values().filter(|r| r.pass).count();
    Some((passed, inner.len()))
}
```

Add the module + re-exports to `crates/cdlc/src/lib.rs` (alongside the existing `pub use` lines):

```rust
pub mod eval;
pub use eval::{pass_rate, read_evals, read_results, write_result, Eval, EvalResult};
```

Confirm `toml`, `serde_json`, `tracing`, and `tempfile` (dev) are deps of `karl-cdlc`. If `toml` or `tempfile` is missing, add to `crates/cdlc/Cargo.toml`:

```toml
[dependencies]
toml = "0.8"

[dev-dependencies]
tempfile = "3"
```

- [ ] **Step 4: Run the scanner tests to verify they pass**

Run: `cargo test -p karl-cdlc eval:: 2>&1 | tail -20`
Expected: PASS — both tests green.

- [ ] **Step 5: Write the failing test for the results store**

Add inside the `tests` module:

```rust
    #[test]
    fn write_result_roundtrips_and_pass_rate() {
        let tmp = tempfile::tempdir().unwrap();
        let mk = |id: &str, pass: bool| EvalResult {
            eval_id: id.into(),
            pass,
            reason: "because".into(),
            ran_at_ms: 1,
            duration_ms: 10,
        };
        write_result(tmp.path(), "kyc-peru", &mk("e1", true)).unwrap();
        write_result(tmp.path(), "kyc-peru", &mk("e2", false)).unwrap();
        // Re-running an eval overwrites its prior result.
        write_result(tmp.path(), "kyc-peru", &mk("e2", true)).unwrap();

        assert_eq!(pass_rate(tmp.path(), "kyc-peru"), Some((2, 2)));
        assert_eq!(pass_rate(tmp.path(), "other"), None);
        let all = read_results(tmp.path());
        assert_eq!(all["kyc-peru"]["e2"].pass, true, "latest run wins");
    }
```

- [ ] **Step 6: Run to verify it passes** (implementation from Step 3 already covers it)

Run: `cargo test -p karl-cdlc eval:: 2>&1 | tail -20`
Expected: PASS — three tests green.

- [ ] **Step 7: Commit**

```bash
git add crates/cdlc/src/eval.rs crates/cdlc/src/lib.rs crates/cdlc/Cargo.toml
git commit -m "feat(cdlc): eval format, scanner, and local results store"
```

---

### Task 2: The sandboxed `claude -p` harness (`crates/app/src/cdlc_eval.rs`)

**Files:**
- Create: `crates/app/src/cdlc_eval.rs`
- Modify: `crates/app/src/lib.rs` (add `mod cdlc_eval;` near the other `mod` lines, e.g. by `mod cdlc_registry;` at line 14)
- Test: inline `#[cfg(test)]` in `crates/app/src/cdlc_eval.rs`

**Interfaces:**
- Consumes: `karl_cdlc::cdlc_dir` (via `karl_cdlc::manifest`? it's re-exported as `karl_cdlc::cdlc_dir`).
- Produces:
  - `enum HarnessStatus { Ran, TimedOut, Skipped(String) }` (derive `Debug, Clone, PartialEq`)
  - `struct HarnessOutcome { pub transcript: String, pub status: HarnessStatus, pub duration_ms: u64 }`
  - `fn claude_available() -> bool`
  - `async fn run_harness(repo_root: &Path, skill: &str, scenario: &str) -> HarnessOutcome`
  - (internal, tested) `fn prepare_sandbox(repo_root: &Path, skill: &str) -> std::io::Result<tempfile::TempDir>`

- [ ] **Step 1: Write the failing test for sandbox preparation**

Create `crates/app/src/cdlc_eval.rs` with the test first:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn prepare_sandbox_projects_skill_and_denylist() {
        let repo = tempfile::tempdir().unwrap();
        let skill_dir = repo.path().join(".covenant/cdlc/skills/kyc-peru");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# KYC Peru\nrefuse without KYC").unwrap();

        let sbox = prepare_sandbox(repo.path(), "kyc-peru").unwrap();
        let projected = sbox.path().join(".claude/skills/cdlc-kyc-peru/SKILL.md");
        assert!(projected.exists(), "skill projected into sandbox");
        assert!(
            fs::read_to_string(&projected).unwrap().contains("refuse without KYC"),
            "skill body copied"
        );
        let settings = sbox.path().join(".claude/settings.json");
        assert!(settings.exists(), "deny-list settings written");
        assert!(
            fs::read_to_string(&settings).unwrap().contains("Bash(rm:*)"),
            "deny-list mirrors the safety blocklist"
        );
    }

    #[test]
    fn missing_skill_md_is_an_error() {
        let repo = tempfile::tempdir().unwrap();
        assert!(prepare_sandbox(repo.path(), "nope").is_err());
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant cdlc_eval::tests::prepare_sandbox_projects_skill_and_denylist 2>&1 | tail -20`
Expected: FAIL — does not compile (`prepare_sandbox` undefined). (`covenant` is the app crate package name per `crates/app/Cargo.toml`.)

- [ ] **Step 3: Implement the harness**

Write the top of `crates/app/src/cdlc_eval.rs`:

```rust
//! Agentic eval harness: run `claude -p <scenario>` in a throwaway sandbox
//! with the skill-under-test projected, capture the transcript, judge it.
//!
//! Safety (#1 risk): the run is confined to a temp `cwd` + a deny-list
//! `settings.json` + a hard timeout. Not a true sandbox — a hardened
//! container is a follow-up. Authored scenarios are semi-trusted.

use std::path::Path;
use std::time::{Duration, Instant};

const HARNESS_TIMEOUT_SECS: u64 = 120;

#[derive(Debug, Clone, PartialEq)]
pub enum HarnessStatus {
    Ran,
    TimedOut,
    Skipped(String),
}

#[derive(Debug, Clone)]
pub struct HarnessOutcome {
    pub transcript: String,
    pub status: HarnessStatus,
    pub duration_ms: u64,
}

/// True if the `claude` CLI is on PATH and runnable.
pub fn claude_available() -> bool {
    std::process::Command::new("claude")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Deny-list mirroring `crates/agent/src/safety.rs` — keeps a prompt-injected
/// scenario from doing damage even inside the sandbox cwd.
fn denylist_settings() -> String {
    serde_json::json!({
        "permissions": {
            "deny": [
                "Bash(rm:*)",
                "Bash(sudo:*)",
                "Bash(su:*)",
                "Bash(dd:*)",
                "Bash(mkfs:*)",
                "Bash(curl:*)",
                "Bash(wget:*)",
                "Bash(git push:*)",
                "WebFetch",
                "WebSearch"
            ]
        }
    })
    .to_string()
}

/// Create a temp dir, project the skill into `.claude/skills/cdlc-<skill>/`,
/// and write the deny-list `settings.json`. Errors if SKILL.md is missing.
pub(crate) fn prepare_sandbox(repo_root: &Path, skill: &str) -> std::io::Result<tempfile::TempDir> {
    let src = karl_cdlc::cdlc_dir(repo_root)
        .join("skills")
        .join(skill)
        .join("SKILL.md");
    let body = std::fs::read_to_string(&src)?; // missing skill → Err
    let sbox = tempfile::Builder::new().prefix("eval-sbox-").tempdir()?;
    let skill_dir = sbox.path().join(".claude/skills").join(format!("cdlc-{skill}"));
    std::fs::create_dir_all(&skill_dir)?;
    std::fs::write(skill_dir.join("SKILL.md"), body)?;
    std::fs::write(sbox.path().join(".claude/settings.json"), denylist_settings())?;
    Ok(sbox)
}

/// Run one scenario through `claude -p` in the sandbox. Confined by cwd-jail +
/// deny-list + timeout. ponytail: bypassPermissions is safe only because the
/// cwd is empty and the deny-list blocks the dangerous tools; harden with a
/// container before running untrusted third-party evals.
pub async fn run_harness(repo_root: &Path, skill: &str, scenario: &str) -> HarnessOutcome {
    let started = Instant::now();
    if !claude_available() {
        return HarnessOutcome {
            transcript: String::new(),
            status: HarnessStatus::Skipped("claude CLI not found on PATH".into()),
            duration_ms: 0,
        };
    }
    let sbox = match prepare_sandbox(repo_root, skill) {
        Ok(s) => s,
        Err(e) => {
            return HarnessOutcome {
                transcript: String::new(),
                status: HarnessStatus::Skipped(format!("sandbox prep failed: {e}")),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
    };

    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p")
        .arg(scenario)
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .current_dir(sbox.path())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);

    let fut = cmd.output();
    let outcome = match tokio::time::timeout(Duration::from_secs(HARNESS_TIMEOUT_SECS), fut).await {
        Err(_) => HarnessStatus::TimedOut,
        Ok(Err(e)) => HarnessStatus::Skipped(format!("claude spawn failed: {e}")),
        Ok(Ok(_)) => HarnessStatus::Ran,
    };
    let transcript = match &outcome {
        HarnessStatus::Ran => {
            // Re-run captured output: we already consumed it above. Restructure:
            String::new()
        }
        _ => String::new(),
    };
    // (Step 3b restructures capture — see next step.)
    HarnessOutcome {
        transcript,
        status: outcome,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}
```

- [ ] **Step 3b: Fix output capture (the `Ran` branch must keep stdout)**

The draft above discards stdout. Replace the `let outcome = ...` block through the end of `run_harness` with a version that keeps the captured output:

```rust
    let mut cmd = tokio::process::Command::new("claude");
    cmd.arg("-p")
        .arg(scenario)
        .arg("--permission-mode")
        .arg("bypassPermissions")
        .current_dir(sbox.path())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);

    let (transcript, status) =
        match tokio::time::timeout(Duration::from_secs(HARNESS_TIMEOUT_SECS), cmd.output()).await {
            Err(_) => (String::new(), HarnessStatus::TimedOut),
            Ok(Err(e)) => (String::new(), HarnessStatus::Skipped(format!("claude spawn failed: {e}"))),
            Ok(Ok(out)) => (
                String::from_utf8_lossy(&out.stdout).to_string(),
                HarnessStatus::Ran,
            ),
        };
    HarnessOutcome {
        transcript,
        status,
        duration_ms: started.elapsed().as_millis() as u64,
    }
```

Delete the earlier `let fut = ...`, `let outcome = ...`, and `let transcript = ...` scaffolding so only this block remains. Add `mod cdlc_eval;` to `crates/app/src/lib.rs` (near line 14, by `mod cdlc_registry;`). Ensure `tempfile` is a dep of `covenant` (check `crates/app/Cargo.toml`; add `tempfile = "3"` to `[dependencies]` if absent — the sandbox dir must persist past the test scope, so it's a runtime dep, not dev-only).

- [ ] **Step 4: Run the sandbox tests to verify they pass**

Run: `cargo test -p covenant cdlc_eval::tests:: 2>&1 | tail -20`
Expected: PASS — both `prepare_sandbox_*` and `missing_skill_md_is_an_error`. (These don't spawn claude; the real `claude -p` run is verified in-app in Task 5.)

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/cdlc_eval.rs crates/app/src/lib.rs crates/app/Cargo.toml
git commit -m "feat(cdlc): sandboxed claude -p eval harness"
```

---

### Task 3: The LLM judge (append to `crates/app/src/cdlc_eval.rs`)

**Files:**
- Modify: `crates/app/src/cdlc_eval.rs` (append judge code + tests)

**Interfaces:**
- Consumes: `crate::provider_resolve::{resolve_route, ResolveError}`, `crate::settings::{Settings, Role}`, `karl_agent::AskRequest`, `karl_agent::provider::collect_oneshot`.
- Produces:
  - `struct Verdict { pub pass: bool, pub reason: String }` (derive `Debug, Clone, PartialEq`)
  - `fn parse_verdict(text: &str) -> Option<Verdict>` (pure)
  - `async fn judge(settings: &std::sync::Arc<tokio::sync::Mutex<Settings>>, scenario: &str, rubric: &str, transcript: &str) -> Result<Verdict, String>`

- [ ] **Step 1: Write the failing test for verdict parsing**

Append to the `tests` module in `crates/app/src/cdlc_eval.rs`:

```rust
    #[test]
    fn parse_verdict_reads_pass_fail_and_reason() {
        let p = parse_verdict("PASS\nThe agent refused and cited SBS.").unwrap();
        assert!(p.pass);
        assert_eq!(p.reason, "The agent refused and cited SBS.");

        let f = parse_verdict("FAIL — it approved the withdrawal").unwrap();
        assert!(!f.pass);
        assert!(f.reason.contains("approved"));

        // Case-insensitive, tolerant of leading prose.
        assert!(parse_verdict("Verdict: pass").unwrap().pass);
        // No verdict token → None (caller treats as an error, never a silent pass).
        assert!(parse_verdict("I'm not sure honestly").is_none());
    }
```

- [ ] **Step 2: Run to verify it fails**

Run: `cargo test -p covenant cdlc_eval::tests::parse_verdict_reads_pass_fail_and_reason 2>&1 | tail -20`
Expected: FAIL — `parse_verdict` / `Verdict` undefined.

- [ ] **Step 3: Implement the judge**

Append to `crates/app/src/cdlc_eval.rs` (above the `#[cfg(test)]` block):

```rust
use crate::provider_resolve::{resolve_route, ResolveError};
use crate::settings::{Role, Settings};

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub pass: bool,
    pub reason: String,
}

const JUDGE_SYSTEM: &str = "You are a strict compliance judge. You are given a SCENARIO, a RUBRIC, \
and a TRANSCRIPT of an AI agent's response to the scenario. Decide whether the transcript satisfies \
the rubric. Reply with exactly one word on the first line — PASS or FAIL — then a one-line reason on \
the next line. Judge ONLY the rubric; do not invent extra criteria.";

/// Parse `PASS`/`FAIL` (case-insensitive) + a reason. `None` if no verdict
/// token is present — the caller must treat that as an error, not a pass.
pub fn parse_verdict(text: &str) -> Option<Verdict> {
    let lower = text.to_lowercase();
    // Find the first PASS/FAIL token as a standalone occurrence.
    let pass_at = lower.find("pass");
    let fail_at = lower.find("fail");
    let pass = match (pass_at, fail_at) {
        (Some(p), Some(f)) => p < f,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => return None,
    };
    // Reason: the remainder after the first line, trimmed of separators.
    let reason = text
        .lines()
        .skip(1)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_start_matches(['—', '-', ':', ' '])
        .trim()
        .to_string();
    let reason = if reason.is_empty() {
        // Single-line verdict like "FAIL — it approved": take the tail of line 1.
        let first = text.lines().next().unwrap_or("");
        first
            .trim_start_matches(|c: char| c.is_alphabetic() || c.is_whitespace())
            .trim_start_matches(['—', '-', ':', ' '])
            .trim()
            .to_string()
    } else {
        reason
    };
    Some(Verdict { pass, reason })
}

/// Judge a transcript against a rubric via the configured Summary-role model.
/// One retry on an unparseable verdict; then a hard error (never a silent pass).
pub async fn judge(
    settings: &std::sync::Arc<tokio::sync::Mutex<Settings>>,
    scenario: &str,
    rubric: &str,
    transcript: &str,
) -> Result<Verdict, String> {
    let resolved = {
        let s = settings.lock().await;
        match resolve_route(&s, Role::Summary) {
            Ok(r) => r,
            Err(ResolveError::NoRoute(_)) => return Err("no LLM route configured for judging".into()),
            Err(e) => return Err(format!("judge provider unavailable: {e}")),
        }
    };
    let user = format!(
        "## SCENARIO\n{scenario}\n\n## RUBRIC\n{rubric}\n\n## TRANSCRIPT\n{transcript}"
    );
    for attempt in 0..2 {
        let req = karl_agent::AskRequest {
            api_key: String::new(),
            model: resolved.model.clone(),
            system_prompt: JUDGE_SYSTEM.to_string(),
            user_message: user.clone(),
            max_tokens: 512,
            thinking_budget: None,
            force_tool: None,
        };
        let resp = karl_agent::provider::collect_oneshot(&*resolved.provider, req)
            .await
            .map_err(|e| e.to_string())?;
        if let Some(v) = parse_verdict(&resp.text) {
            return Ok(v);
        }
        tracing::warn!(target: "cdlc", attempt, "judge produced no PASS/FAIL token, retrying");
    }
    Err("judge did not return a PASS/FAIL verdict".into())
}
```

- [ ] **Step 4: Run the parse test to verify it passes**

Run: `cargo test -p covenant cdlc_eval::tests::parse_verdict_reads_pass_fail_and_reason 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/cdlc_eval.rs
git commit -m "feat(cdlc): LLM judge for eval transcripts (PASS/FAIL contract)"
```

---

### Task 4: Orchestration + Tauri commands + api wrappers

Wires harness + judge into a `cdlc_run_evals` command that streams per-eval progress, plus a `cdlc_eval_summary` read for the Loop.

**Files:**
- Modify: `crates/app/src/cdlc_eval.rs` (append `run_evals` + the two `#[tauri::command]`s)
- Modify: `crates/app/src/lib.rs` (register both commands in `generate_handler!`, ~line 4191)
- Modify: `ui/src/api.ts` (add wrappers + types + a progress-listen helper)

**Interfaces:**
- Consumes: `tauri::{AppHandle, Emitter, State}`, `crate::AppState` (`state.settings: Arc<Mutex<Settings>>`), Task 1 (`karl_cdlc::{read_evals, write_result, read_results, EvalResult}`), Task 2 (`run_harness`, `HarnessStatus`), Task 3 (`judge`).
- Produces (Rust):
  - `async fn cdlc_run_evals(app: AppHandle, state: State<'_, AppState>, cwd: String, skill: String) -> Result<(), String>`
  - `async fn cdlc_eval_summary(cwd: String) -> Result<Vec<EvalSkillSummary>, String>` where `struct EvalSkillSummary { pub skill: String, pub passed: usize, pub total: usize }` (Serialize)
  - emits topic `"cdlc-eval-progress"` with payload `{ skill: String, eval_id: String, status: "running"|"pass"|"fail"|"skipped"|"error", reason: String }` and a final `{ skill, eval_id: "", status: "done", reason: "" }`.
- Produces (TS):
  - `cdlcRunEvals(cwd: string, skill: string): Promise<void>`
  - `cdlcEvalSummary(cwd: string): Promise<EvalSkillSummary[]>`
  - `onCdlcEvalProgress(handler: (e: CdlcEvalProgress) => void): Promise<UnlistenFn>`
  - interfaces `EvalSkillSummary { skill: string; passed: number; total: number }`, `CdlcEvalProgress { skill: string; eval_id: string; status: string; reason: string }`

- [ ] **Step 1: Implement the orchestration + commands**

Append to `crates/app/src/cdlc_eval.rs`:

```rust
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Debug, Clone, Serialize)]
pub struct EvalSkillSummary {
    pub skill: String,
    pub passed: usize,
    pub total: usize,
}

fn emit_progress(app: &AppHandle, skill: &str, eval_id: &str, status: &str, reason: &str) {
    let _ = app.emit(
        "cdlc-eval-progress",
        serde_json::json!({
            "skill": skill,
            "eval_id": eval_id,
            "status": status,
            "reason": reason,
        }),
    );
}

/// Run every eval for `skill`: harness → judge → persist → emit. Sequential
/// (each eval is a full agent run + a judge call — slow and expensive on
/// purpose). Aborts the remaining evals if claude is unavailable.
#[tauri::command]
pub async fn cdlc_run_evals(
    app: AppHandle,
    state: State<'_, AppState>,
    cwd: String,
    skill: String,
) -> Result<(), String> {
    let repo_root = std::path::PathBuf::from(&cwd);
    let evals = karl_cdlc::read_evals(&repo_root, &skill);
    if evals.is_empty() {
        emit_progress(&app, &skill, "", "done", "no evals found");
        return Ok(());
    }
    let settings = state.settings.clone();
    for ev in evals {
        emit_progress(&app, &skill, &ev.id, "running", "");
        let outcome = run_harness(&repo_root, &skill, &ev.scenario).await;
        match outcome.status {
            HarnessStatus::Skipped(reason) => {
                emit_progress(&app, &skill, &ev.id, "skipped", &reason);
                // claude missing / sandbox failure applies to all evals — stop.
                emit_progress(&app, &skill, "", "done", "");
                return Ok(());
            }
            HarnessStatus::TimedOut => {
                emit_progress(&app, &skill, &ev.id, "error", "harness timed out");
                continue;
            }
            HarnessStatus::Ran => {}
        }
        match judge(&settings, &ev.scenario, &ev.rubric, &outcome.transcript).await {
            Ok(v) => {
                let result = karl_cdlc::EvalResult {
                    eval_id: ev.id.clone(),
                    pass: v.pass,
                    reason: v.reason.clone(),
                    ran_at_ms: chrono::Utc::now().timestamp_millis(),
                    duration_ms: outcome.duration_ms,
                };
                if let Err(e) = karl_cdlc::write_result(&repo_root, &skill, &result) {
                    tracing::warn!(target: "cdlc", error = %e, "write_result failed");
                }
                emit_progress(&app, &skill, &ev.id, if v.pass { "pass" } else { "fail" }, &v.reason);
            }
            Err(e) => emit_progress(&app, &skill, &ev.id, "error", &e),
        }
    }
    emit_progress(&app, &skill, "", "done", "");
    Ok(())
}

/// Per-skill `(passed,total)` for the Loop, read from eval-results.json.
#[tauri::command]
pub async fn cdlc_eval_summary(cwd: String) -> Result<Vec<EvalSkillSummary>, String> {
    let repo_root = std::path::PathBuf::from(&cwd);
    let all = karl_cdlc::read_results(&repo_root);
    Ok(all
        .into_iter()
        .map(|(skill, inner)| {
            let passed = inner.values().filter(|r| r.pass).count();
            EvalSkillSummary { skill, passed, total: inner.len() }
        })
        .collect())
}
```

Confirm `crate::AppState` is reachable from `cdlc_eval.rs` (it's `pub(crate) struct AppState` in `lib.rs`; reference as `crate::AppState`). Confirm `chrono` is a dep of `covenant` (it is — used widely). `tauri::Emitter` is the trait that provides `app.emit` in Tauri 2.

- [ ] **Step 2: Register the commands**

In `crates/app/src/lib.rs`, add to the `tauri::generate_handler![ ... ]` list (next to the other `cdlc_*` entries around line 4191):

```rust
            cdlc_eval::cdlc_run_evals,
            cdlc_eval::cdlc_eval_summary,
```

- [ ] **Step 3: Verify the backend compiles**

Run: `cargo check -p covenant 2>&1 | tail -25`
Expected: `Finished` with no errors. (Fix any import/path mismatches surfaced — e.g. `Emitter` trait import.)

- [ ] **Step 4: Add the TypeScript wrappers**

In `ui/src/api.ts`, near the other `cdlc*` wrappers (around line 1340), add:

```ts
export interface EvalSkillSummary {
  skill: string;
  passed: number;
  total: number;
}

export interface CdlcEvalProgress {
  skill: string;
  eval_id: string;
  status: "running" | "pass" | "fail" | "skipped" | "error" | "done";
  reason: string;
}

export async function cdlcRunEvals(cwd: string, skill: string): Promise<void> {
  return invoke<void>("cdlc_run_evals", { cwd, skill });
}

export async function cdlcEvalSummary(cwd: string): Promise<EvalSkillSummary[]> {
  return invoke<EvalSkillSummary[]>("cdlc_eval_summary", { cwd });
}

export async function onCdlcEvalProgress(
  handler: (e: CdlcEvalProgress) => void,
): Promise<UnlistenFn> {
  return listen<CdlcEvalProgress>("cdlc-eval-progress", (e) => handler(e.payload));
}
```

Confirm `listen` and `UnlistenFn` are already imported at the top of `api.ts` (they are — used by `onResourcesUpdate` etc.). If `UnlistenFn` isn't imported, add it to the existing `@tauri-apps/api/event` import.

- [ ] **Step 5: Verify the frontend typechecks**

Run (from repo root): `npx tsc --noEmit 2>&1 | tail -20`
Expected: no errors referencing `api.ts`.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/cdlc_eval.rs crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(cdlc): cdlc_run_evals + eval_summary commands with progress events"
```

---

### Task 5: Panel UI — "Run evals" button + Loop pass-rate

**Files:**
- Modify: `ui/src/cdlc/panel.ts` (skill-row action + Loop section + progress handling)
- Modify: `ui/src/cdlc/styles.css` (status colors for the running/pass/fail row — optional, only if needed)
- Test: `ui/src/cdlc/panel.test.ts` (existing — extend; vitest)

**Interfaces:**
- Consumes: Task 4 (`cdlcRunEvals`, `cdlcEvalSummary`, `onCdlcEvalProgress`, `EvalSkillSummary`, `CdlcEvalProgress`), `Icons.play`, `pushInfoToast`, existing `iconButton`, `loopSubhead`.

- [ ] **Step 1: Write the failing test**

In `ui/src/cdlc/panel.test.ts`, add a test (and the api mocks it needs). Add `cdlcEvalSummary`, `cdlcRunEvals`, `onCdlcEvalProgress` to the `vi.mock("../api", ...)` block, then:

```ts
it("renders eval pass-rate in the Loop when results exist", async () => {
  const { cdlcEvalSummary } = await import("../api");
  (cdlcEvalSummary as unknown as Mock).mockResolvedValue([
    { skill: "kyc-peru", passed: 4, total: 5 },
  ]);
  const panel = new CdlcPanel({ groupRootDir: "/repo", groupLabel: "payments" });
  await panel.refresh();
  // The Loop should show "4/5" for the skill rather than the deferred note.
  expect(panel.element.textContent).toContain("4/5");
  expect(panel.element.textContent).not.toContain("arrives in a later phase");
});

it("exposes a Run evals action on each installed skill", async () => {
  const panel = new CdlcPanel({ groupRootDir: "/repo", groupLabel: "payments" });
  await panel.refresh();
  const btn = panel.element.querySelector('button[aria-label="Run evals"]');
  expect(btn).not.toBeNull();
});
```

Match the existing test file's construction of `CdlcPanel` and its mock for `cdlcLocalStatus` (it must return at least one installed skill for the second test — reuse the file's existing status mock, adding `installed: [{ name: "kyc-peru", version: "1.0.0", source: "registry:payments" }]` if not already present).

- [ ] **Step 2: Run to verify it fails**

Run (from repo root): `npx vitest run ui/src/cdlc/panel.test.ts 2>&1 | tail -25`
Expected: FAIL — no `aria-label="Run evals"` button / no "4/5" text.

- [ ] **Step 3: Load eval summaries in `refresh()`**

In `panel.ts`, add a field near the other private state (by `private adoption = ...` at line 93):

```ts
  private evalRates = new Map<string, { passed: number; total: number }>();
```

In `refresh()` (line 151), extend the `Promise.all` and store the result:

```ts
      const [status, orgs, score, evalSummary] = await Promise.all([
        cdlcLocalStatus(cwd),
        cdlcMyOrgs().catch(() => [] as Org[]),
        scoreSummaryFiltered(this.opts.groupLabel ?? null).catch(() => null),
        cdlcEvalSummary(cwd).catch(() => [] as EvalSkillSummary[]),
      ]);
      this.evalRates = new Map(evalSummary.map((s) => [s.skill, { passed: s.passed, total: s.total }]));
```

Add the imports to the top-of-file `from "../api"` import: `cdlcEvalSummary, cdlcRunEvals, onCdlcEvalProgress` and the types `EvalSkillSummary, CdlcEvalProgress`.

- [ ] **Step 4: Add the "Run evals" button to each skill row**

In `renderStatus`, inside the `for (const i of s.installed)` loop (line 185), after the publish-button push, add:

```ts
        const runBtn = iconButton(Icons.play({ size: 15 }), "Run evals", () => void this.runEvals(i.name, runBtn));
        actions.push(runBtn);
```

Add the `runEvals` method to the class (next to `exportNow`, ~line 305):

```ts
  private async runEvals(skill: string, btn: HTMLButtonElement): Promise<void> {
    const cwd = this.opts.groupRootDir;
    if (!cwd) return;
    if (!window.confirm(`Run evals for "${skill}"? Each eval is a full agent run plus a judge call — this can take minutes and costs tokens.`)) {
      return;
    }
    btn.disabled = true;
    let unlisten: (() => void) | undefined;
    try {
      unlisten = await onCdlcEvalProgress((e: CdlcEvalProgress) => {
        if (e.skill !== skill) return;
        if (e.status === "running") pushInfoToast({ message: `Eval ${e.eval_id}: running…` });
        else if (e.status === "pass") pushInfoToast({ message: `Eval ${e.eval_id}: PASS` });
        else if (e.status === "fail") pushInfoToast({ message: `Eval ${e.eval_id}: FAIL — ${e.reason}` });
        else if (e.status === "skipped") pushInfoToast({ message: `Evals skipped: ${e.reason}` });
        else if (e.status === "error") pushInfoToast({ message: `Eval ${e.eval_id}: error — ${e.reason}` });
      });
      await cdlcRunEvals(cwd, skill);
      pushInfoToast({ message: `Evals finished for ${skill}` });
      await this.refresh();
    } catch (e) {
      pushInfoToast({ message: `Run evals failed: ${String(e)}` });
    } finally {
      unlisten?.();
      btn.disabled = false;
    }
  }
```

`window.confirm` is the lazy cost-gate. ponytail: a styled modal can replace it later; a native confirm is sufficient and blocks correctly. (This is the one allowed native dialog — it does not break the webview the way JS `alert` chains do, and it is user-initiated.)

- [ ] **Step 5: Replace the deferred Eval note with real pass-rate**

In `renderStatus`, replace the Eval-note block (lines 296-300) with:

```ts
    // Eval — context-TDD pass-rate from the local runner.
    const skillsWithEvals = s.installed.filter((i) => this.evalRates.has(i.name));
    if (skillsWithEvals.length > 0) {
      loop.appendChild(loopSubhead("Eval pass-rate"));
      for (const i of skillsWithEvals) {
        const r = this.evalRates.get(i.name)!;
        const row = document.createElement("div");
        row.className = "cdlc-loop-row";
        const name = document.createElement("span");
        name.className = "cdlc-name";
        name.textContent = i.name;
        const val = document.createElement("span");
        val.className = "cdlc-meta";
        const pct = r.total > 0 ? Math.round((r.passed / r.total) * 100) : 0;
        val.textContent = `${r.passed}/${r.total} · ${pct}%`;
        row.append(name, val);
        loop.appendChild(row);
      }
    } else {
      const evalNote = document.createElement("p");
      evalNote.className = "cdlc-loop-note";
      evalNote.textContent = "Run evals on a skill to measure its context-TDD pass-rate.";
      loop.appendChild(evalNote);
    }
```

- [ ] **Step 6: Run the panel tests to verify they pass**

Run (from repo root): `npx vitest run ui/src/cdlc/panel.test.ts 2>&1 | tail -25`
Expected: PASS — all panel tests including the two new ones.

- [ ] **Step 7: Typecheck + commit**

Run (from repo root): `npx tsc --noEmit 2>&1 | tail -20`
Expected: no errors.

```bash
git add ui/src/cdlc/panel.ts ui/src/cdlc/panel.test.ts ui/src/cdlc/styles.css
git commit -m "feat(cdlc): Run evals button + Loop pass-rate in the panel"
```

- [ ] **Step 8: In-app verification (manual — the real agentic loop)**

This is the only place the live `claude -p` run is exercised. Use the `respawn` skill if HMR didn't pick up the Rust change.

1. In a group with a CDLC skill installed (e.g. `kyc-peru`), create `.covenant/cdlc/skills/kyc-peru/evals/approve-without-kyc.toml` with the example from the spec (`id`/`scenario`/`rubric`).
2. Open the CDLC panel → the skill row shows a play (Run evals) button.
3. Click it → confirm the cost dialog → watch per-eval toasts (running → PASS/FAIL).
4. On completion, the Loop shows `kyc-peru · 1/1 · 100%` (or the real rate).
5. Confirm `.covenant/cdlc/eval-results.json` was written with the result.
6. If `claude` isn't on PATH, confirm the "Evals skipped: claude CLI not found" toast (graceful, not a crash).

---

## Self-Review

**1. Spec coverage:**
- Eval format (`.toml` id/scenario/rubric, dir scan) → Task 1. ✓
- Agentic sandboxed `claude -p` harness (temp dir, skill projection, deny-list, timeout, claude-precondition → Skipped) → Task 2. ✓
- LLM judge (transcript → pass/reason, retry, telemetry via `collect_oneshot`) → Task 3. ✓
- Local `eval-results.json` + registry-ready `EvalResult` shape → Task 1 (`EvalResult`) + Task 4 (persist). ✓
- "Run evals" UI per skill + cost warning + async progress → Task 5. ✓
- Loop pass-rate display replacing the deferred note → Task 5. ✓
- Telemetry feeds Inference: the judge call goes through `collect_oneshot` → `record_llm_call` automatically (lib.rs:180). The agent-run is `claude` (external) — its tokens are not Covenant-internal, so it does not feed Inference; only the judge does. (Acceptable; noted.)
- Plan B (registry push) → explicitly out of scope. ✓

**2. Placeholder scan:** No "TBD/TODO/handle edge cases". Task 2 Step 3→3b deliberately shows a draft then its fix (output capture) — both blocks are complete code, not placeholders.

**3. Type consistency:** `EvalResult` fields (`eval_id, pass, reason, ran_at_ms, duration_ms`) match across Task 1 (def) and Task 4 (construction). `HarnessStatus`/`HarnessOutcome` consistent T2↔T4. `Verdict {pass, reason}` consistent T3↔T4. TS `EvalSkillSummary {skill, passed, total}` matches the Rust `Serialize` struct. Progress payload keys (`skill, eval_id, status, reason`) match between `emit_progress` and the TS `CdlcEvalProgress`.

**Deviation from spec:** the judge uses a **plain-text PASS/FAIL contract**, not `force_tool` structured output — because `ask_oneshot_with_usage`/`collect_oneshot` drop tool-input deltas (agent/src/lib.rs:159-160), so forced-tool args never reach `.text`. The text contract is simpler and works with the existing helper. Functionally equivalent (still structured, still retried).
