//! Agentic eval harness: run `claude -p <scenario>` in a throwaway sandbox
//! with the skill-under-test projected, capture the transcript, judge it.
//!
//! Safety (#1 risk): the run is confined to a temp `cwd` + a deny-list
//! `settings.json` + a hard timeout. Not a true sandbox — a hardened
//! container is a follow-up. Authored scenarios are semi-trusted.

use std::path::Path;
use std::time::{Duration, Instant};

use crate::provider_resolve::{resolve_route, ResolveError};
use crate::settings::{Role, Settings};

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

/// Create a temp dir, project the skill into `.claude/skills/canon-<skill>/`,
/// and write the deny-list `settings.json`. Errors if SKILL.md is missing.
pub(crate) fn prepare_sandbox(repo_root: &Path, skill: &str) -> std::io::Result<tempfile::TempDir> {
    let src = karl_canon::canon_dir(repo_root)
        .join("skills")
        .join(skill)
        .join("SKILL.md");
    let body = std::fs::read_to_string(&src)?; // missing skill → Err
    let sbox = tempfile::Builder::new().prefix("eval-sbox-").tempdir()?;
    let skill_dir = sbox.path().join(".claude/skills").join(format!("canon-{skill}"));
    std::fs::create_dir_all(&skill_dir)?;
    std::fs::write(skill_dir.join("SKILL.md"), body)?;
    std::fs::write(sbox.path().join(".claude/settings.json"), denylist_settings())?;
    Ok(sbox)
}

/// Returns CLI args for `claude -p <scenario>` that enforce read-only tools
/// (Read/Grep/Glob) + deny-list settings.json + cwd sandbox + timeout.
/// Full-tool agentic runs need the deferred hardened container.
fn harness_args(scenario: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        scenario.to_string(),
        "--allowedTools".to_string(),
        "Read".to_string(),
        "Grep".to_string(),
        "Glob".to_string(),
        "--strict-mcp-config".to_string(),
    ]
}

/// Non-zero exit or empty stdout is an infra failure (auth, crash) — a non-result,
/// NOT a compliance fail. Only a clean, non-empty run is judged.
fn classify_output(success: bool, stdout: &str, stderr: &str) -> HarnessStatus {
    if success && !stdout.trim().is_empty() {
        HarnessStatus::Ran
    } else {
        let why = if stderr.trim().is_empty() {
            "claude produced no output".to_string()
        } else {
            format!("claude failed: {}", stderr.trim().chars().take(200).collect::<String>())
        };
        HarnessStatus::Skipped(why)
    }
}

/// Run one scenario through `claude -p` in the sandbox. Confined by read-only
/// tools (Read/Grep/Glob) + deny-list settings.json + cwd sandbox + timeout.
/// Full-tool agentic runs need the deferred hardened container.
pub async fn run_harness(repo_root: &Path, skill: &str, scenario: &str) -> HarnessOutcome {
    let started = Instant::now();
    let available = tokio::task::spawn_blocking(claude_available).await.unwrap_or(false);
    if !available {
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
    cmd.args(harness_args(scenario))
        .current_dir(sbox.path())
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
    HarnessOutcome {
        transcript,
        status,
        duration_ms: started.elapsed().as_millis() as u64,
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    pub pass: bool,
    pub reason: String,
}

const JUDGE_SYSTEM: &str = "You are a strict compliance judge. You are given a SCENARIO, a RUBRIC, \
and a TRANSCRIPT of an AI agent's response to the scenario. Decide whether the transcript satisfies \
the rubric. Reply with exactly one word on the first line — PASS or FAIL — then a one-line reason on \
the next line. Judge ONLY the rubric; do not invent extra criteria.";

/// Return the byte-offset of the first occurrence of `word` in `haystack`
/// that is bounded by non-ASCII-alphabetic characters on both sides.
fn word_pos(haystack: &str, word: &str) -> Option<usize> {
    let bytes = haystack.as_bytes();
    let mut from = 0;
    while let Some(rel) = haystack[from..].find(word) {
        let pos = from + rel;
        let before_ok = pos == 0 || !bytes[pos - 1].is_ascii_alphabetic();
        let after = pos + word.len();
        let after_ok = after >= bytes.len() || !bytes[after].is_ascii_alphabetic();
        if before_ok && after_ok {
            return Some(pos);
        }
        from = pos + word.len();
    }
    None
}

/// Parse `PASS`/`FAIL` (case-insensitive) + a reason. `None` if no standalone
/// verdict token is present — the caller must treat that as an error, not a pass.
///
/// Verdict is determined from the FIRST NON-EMPTY LINE only (judge contract).
/// Scanning the whole text would promote a trailing token — e.g. "It's not a
/// clear pass... FAIL" — to a false PASS, silently corrupting compliance results.
/// If both tokens appear on the first line (ambiguous) → `None`.
pub fn parse_verdict(text: &str) -> Option<Verdict> {
    // Judge contract: PASS or FAIL on the FIRST non-empty line only.
    let first_line = text.lines().find(|l| !l.trim().is_empty())?;
    let lower_first = first_line.to_lowercase();
    let pass_at = word_pos(&lower_first, "pass");
    let fail_at = word_pos(&lower_first, "fail");
    let pass = match (pass_at, fail_at) {
        // Both tokens on the first line → ambiguous; not a valid verdict.
        (Some(_), Some(_)) => return None,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => return None,
    };
    // Reason: the remainder after the first NON-EMPTY line, trimmed of separators.
    // Using skip(1) would be wrong if there are leading blank lines — it would
    // include the verdict line itself in the reason. Instead we find the index
    // of the first non-empty line and skip past it.
    let first_non_empty_idx = text.lines().position(|l| !l.trim().is_empty()).unwrap_or(0);
    let reason = text
        .lines()
        .skip(first_non_empty_idx + 1)
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_start_matches(['—', '-', ':', ' '])
        .trim()
        .to_string();
    let reason = if reason.is_empty() {
        // Single-line verdict like "FAIL — it approved": take the tail of line 1.
        first_line
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
        tracing::warn!(target: "canon", attempt, "judge produced no PASS/FAIL token, retrying");
    }
    Err("judge did not return a PASS/FAIL verdict".into())
}

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
        "canon-eval-progress",
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
/// purpose). Aborts the whole run only if claude is not installed; a per-eval
/// transient failure (non-zero exit, empty stdout) skips that eval and continues.
#[tauri::command]
pub async fn canon_run_evals(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    cwd: String,
    skill: String,
) -> Result<(), String> {
    let repo_root = std::path::PathBuf::from(&cwd);
    let evals = karl_canon::read_evals(&repo_root, &skill);
    if evals.is_empty() {
        emit_progress(&app, &skill, "", "done", "no evals found");
        return Ok(());
    }
    // Global precondition: claude must be on PATH. Check once so a missing CLI
    // gives a single clean abort instead of N per-eval skips.
    let available = tokio::task::spawn_blocking(claude_available).await.unwrap_or(false);
    if !available {
        emit_progress(&app, &skill, "", "skipped", "claude CLI not found on PATH");
        emit_progress(&app, &skill, "", "done", "");
        return Ok(());
    }
    let settings = state.settings.clone();
    for ev in evals {
        emit_progress(&app, &skill, &ev.id, "running", "");
        let outcome = run_harness(&repo_root, &skill, &ev.scenario).await;
        match outcome.status {
            HarnessStatus::Skipped(reason) => {
                // Per-eval transient (non-zero exit, empty stdout, sandbox failure):
                // skip this one eval and continue with the rest.
                emit_progress(&app, &skill, &ev.id, "skipped", &reason);
                continue;
            }
            HarnessStatus::TimedOut => {
                emit_progress(&app, &skill, &ev.id, "error", "harness timed out");
                continue;
            }
            HarnessStatus::Ran => {}
        }
        match judge(&settings, &ev.scenario, &ev.rubric, &outcome.transcript).await {
            Ok(v) => {
                let result = karl_canon::EvalResult {
                    eval_id: ev.id.clone(),
                    pass: v.pass,
                    reason: v.reason.clone(),
                    ran_at_ms: chrono::Utc::now().timestamp_millis(),
                    duration_ms: outcome.duration_ms,
                };
                if let Err(e) = karl_canon::write_result(&repo_root, &skill, &result) {
                    tracing::warn!(target: "canon", error = %e, "write_result failed");
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
pub async fn canon_eval_summary(cwd: String) -> Result<Vec<EvalSkillSummary>, String> {
    let repo_root = std::path::PathBuf::from(&cwd);
    let all = karl_canon::read_results(&repo_root);
    Ok(all
        .into_iter()
        .map(|(skill, inner)| {
            let passed = inner.values().filter(|r| r.pass).count();
            EvalSkillSummary { skill, passed, total: inner.len() }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

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

    #[test]
    fn parse_verdict_ignores_substring_false_positives() {
        assert!(parse_verdict("I cannot determine if this passes the rubric").is_none());
        assert!(parse_verdict("The work surpassed expectations").is_none());
        // genuine verdicts still parse
        assert!(parse_verdict("PASS\nrefused correctly").unwrap().pass);
        assert!(!parse_verdict("FAIL — approved without KYC").unwrap().pass);
    }

    #[test]
    fn prepare_sandbox_projects_skill_and_denylist() {
        let repo = tempfile::tempdir().unwrap();
        let skill_dir = repo.path().join(".covenant/canon/skills/kyc-peru");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# KYC Peru\nrefuse without KYC").unwrap();

        let sbox = prepare_sandbox(repo.path(), "kyc-peru").unwrap();
        let projected = sbox.path().join(".claude/skills/canon-kyc-peru/SKILL.md");
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

    #[test]
    fn harness_args_are_readonly_no_bypass() {
        let a = harness_args("do the thing");
        assert!(!a.iter().any(|s| s.contains("bypassPermissions")), "must not bypass permissions");
        assert!(a.iter().any(|s| s == "--allowedTools"));
        assert!(
            a.iter().any(|s| s == "Read") && a.iter().any(|s| s == "Grep") && a.iter().any(|s| s == "Glob"),
            "read-only tools present"
        );
        assert!(
            !a.iter().any(|s| s == "Bash" || s == "Write" || s == "WebFetch"),
            "no write/exec/net tools"
        );
        assert!(a.iter().any(|s| s == "--strict-mcp-config"));
        assert!(a.contains(&"do the thing".to_string()), "scenario passed through");
    }

    #[test]
    fn classify_output_treats_infra_failure_as_skipped_not_ran() {
        assert_eq!(classify_output(true, "refuses correctly", ""), HarnessStatus::Ran);
        assert!(matches!(classify_output(false, "", "auth error"), HarnessStatus::Skipped(_)));
        assert!(
            matches!(classify_output(true, "   ", ""), HarnessStatus::Skipped(_)),
            "empty stdout = non-result"
        );
    }

    #[test]
    fn parse_verdict_rejects_ambiguous_first_line() {
        // both tokens on the first line = non-compliant judge output = unparseable, NOT a silent pass
        assert!(parse_verdict("It's not a clear pass... FAIL").is_none());
        assert!(parse_verdict("Could be PASS or FAIL, unsure").is_none());
        // genuine single-token first lines still parse
        assert!(parse_verdict("PASS\nrefused").unwrap().pass);
        assert!(!parse_verdict("FAIL\napproved").unwrap().pass);
    }
}
