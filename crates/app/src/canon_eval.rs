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

/// Create a temp dir holding a one-unit Canon tree, project it with the same
/// code that projects the real repo, then write the deny-list `settings.json`.
///
/// Projecting rather than hand-writing the executor file means the eval tests
/// the unit AS PROJECTED — a context doc becomes a synthesized skill, a memory
/// becomes a bullet in the managed block — which is what actually reaches the
/// model. It also means memory and context work with no code of their own.
pub(crate) fn prepare_sandbox(
    repo_root: &Path,
    kind: karl_canon::ContextKind,
    name: &str,
) -> std::io::Result<tempfile::TempDir> {
    use karl_canon::ContextKind;
    if !kind.evaluable() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{} units are not evaluable", kind.label()),
        ));
    }
    // `name` reaches path joins below (both the sandbox destination and the
    // real-repo source read) — an unvalidated `../../etc/...` or a leading
    // `/` would either escape the tempdir or, via `Path::join`'s absolute-path
    // override, discard the base entirely. Same predicate `delete_unit` and
    // `uninstall_skill` already rely on, reused rather than re-hand-rolled.
    if !karl_canon::valid_pkg_name(name) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{name:?} is not a valid unit name"),
        ));
    }

    let sbox = tempfile::Builder::new().prefix("eval-sbox-").tempdir()?;
    let dst_canon = sbox.path().join(".covenant/canon");

    if kind == ContextKind::Skill {
        // A skill is a directory of exactly the two files a package carries.
        let src = karl_canon::canon_dir(repo_root).join("skills").join(name);
        let dst = dst_canon.join("skills").join(name);
        std::fs::create_dir_all(&dst)?;
        std::fs::copy(src.join("SKILL.md"), dst.join("SKILL.md"))?; // missing → Err
        let toml_src = src.join("skill.toml");
        if toml_src.exists() {
            std::fs::copy(&toml_src, dst.join("skill.toml"))?;
        }
        // project_with_active reads its skill set from the manifest, NOT from
        // disk — without this the sandbox projects nothing and the eval
        // silently measures an empty context. (`dst_canon` already exists —
        // `dst` above is a child of it — so no create_dir_all needed here.)
        std::fs::write(
            dst_canon.join("canon.toml"),
            format!(
                "version = 1\n\n[[installed]]\nname = \"{name}\"\nversion = \"0.0.0\"\n\
                 source = \"local:eval-sandbox\"\nsha = \"\"\ninstalledAt = \"\"\n"
            ),
        )?;
    } else {
        // Every other evaluable kind is one markdown file under its kind dir.
        let file = format!("{name}.md");
        let src = karl_canon::canon_dir(repo_root)
            .join(kind.dir())
            .join(&file);
        let body = std::fs::read_to_string(&src)?; // missing unit → Err
        let dst = dst_canon.join(kind.dir());
        std::fs::create_dir_all(&dst)?;
        std::fs::write(dst.join(&file), body)?;
    }

    karl_canon::project(sbox.path())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::Other, e.to_string()))?;

    // `project()` writes memory bullets, context summaries and skill bodies
    // into a managed block inside AGENTS.md. In a real repo that reaches the
    // model because CLAUDE.md is a symlink to AGENTS.md — but a fresh tempdir
    // has no such symlink, so Claude Code (which reads CLAUDE.md, not
    // AGENTS.md) never sees any of it. Verified empirically: probing a
    // sandbox of this exact shape with the harness's own
    // `--allowedTools Read Grep Glob` returned the placeholder
    // `PASSPHRASE=NOT-IN-CONTEXT` for a memory bullet until this copy was
    // added, and the real value afterward. Without this, memory/context/
    // skill evals grade the bare model against an empty control and report
    // a fabricated ~0 lift for every managed-block kind.
    let agents_md = sbox.path().join("AGENTS.md");
    if agents_md.exists() {
        std::fs::copy(&agents_md, sbox.path().join("CLAUDE.md"))?;
    }

    // AFTER project(): the deny-list is the sandbox's only safety boundary and
    // must not be clobbered by a future projection target claiming the name.
    std::fs::create_dir_all(sbox.path().join(".claude"))?;
    std::fs::write(
        sbox.path().join(".claude/settings.json"),
        denylist_settings(),
    )?;
    Ok(sbox)
}

/// Baseline sandbox: the same deny-list `settings.json` as `prepare_sandbox`,
/// but with NO skill projected — the control arm for context-lift.
pub(crate) fn prepare_sandbox_bare(_repo_root: &Path) -> std::io::Result<tempfile::TempDir> {
    let sbox = tempfile::Builder::new().prefix("eval-sbox-").tempdir()?;
    std::fs::create_dir_all(sbox.path().join(".claude"))?;
    std::fs::write(
        sbox.path().join(".claude/settings.json"),
        denylist_settings(),
    )?;
    Ok(sbox)
}

/// Returns CLI args for `claude -p <scenario>` that enforce non-mutating
/// tools (Read/Grep/Glob/SlashCommand) + deny-list settings.json + cwd
/// sandbox + timeout. Full-tool agentic runs need the deferred hardened
/// container.
///
/// `SlashCommand` is allowed alongside the read-only trio because a
/// command's body — the thing a `command`-kind eval is meant to test — only
/// enters the prompt when the command is invoked; a projected
/// `.claude/commands/<name>.md` otherwise contributes just its frontmatter
/// `description` line. Verified empirically: the same probe that caught
/// Finding 1 returned the placeholder `QUIBBLE=NOT-IN-CONTEXT` for a command
/// body without this tool, and the real value with it — the model reaches
/// the body on its own, without the scenario telling it to invoke anything.
/// It does not grant Bash/Write/exec — invoking a slash command still only
/// expands its markdown into context, it does not run it.
fn harness_args(scenario: &str) -> Vec<String> {
    vec![
        "-p".to_string(),
        scenario.to_string(),
        "--allowedTools".to_string(),
        "Read".to_string(),
        "Grep".to_string(),
        "Glob".to_string(),
        "SlashCommand".to_string(),
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
            format!(
                "claude failed: {}",
                stderr.trim().chars().take(200).collect::<String>()
            )
        };
        HarnessStatus::Skipped(why)
    }
}

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
            Ok(Err(e)) => (
                String::new(),
                HarnessStatus::Skipped(format!("claude spawn failed: {e}")),
            ),
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

/// Run one scenario through `claude -p` in the sandbox. Confined by read-only
/// tools (Read/Grep/Glob) + deny-list settings.json + cwd sandbox + timeout.
/// Full-tool agentic runs need the deferred hardened container.
pub async fn run_harness(
    repo_root: &Path,
    kind: karl_canon::ContextKind,
    name: &str,
    scenario: &str,
) -> HarnessOutcome {
    let started = Instant::now();
    let available = tokio::task::spawn_blocking(claude_available)
        .await
        .unwrap_or(false);
    if !available {
        return HarnessOutcome {
            transcript: String::new(),
            status: HarnessStatus::Skipped("claude CLI not found on PATH".into()),
            duration_ms: 0,
        };
    }
    let sbox = match prepare_sandbox(repo_root, kind, name) {
        Ok(s) => s,
        Err(e) => {
            return HarnessOutcome {
                transcript: String::new(),
                status: HarnessStatus::Skipped(format!("sandbox prep failed: {e}")),
                duration_ms: started.elapsed().as_millis() as u64,
            }
        }
    };
    run_scenario_in(sbox.path(), scenario, started).await
}

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
            Err(ResolveError::NoRoute(_)) => {
                return Err("no LLM route configured for judging".into())
            }
            Err(e) => return Err(format!("judge provider unavailable: {e}")),
        }
    };
    let user =
        format!("## SCENARIO\n{scenario}\n\n## RUBRIC\n{rubric}\n\n## TRANSCRIPT\n{transcript}");
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

/// Parse a kind slug from the frontend. Rejects anything unevaluable, so an
/// MCP server cannot be run through the harness by passing its name.
fn parse_evaluable_kind(s: &str) -> Result<karl_canon::ContextKind, String> {
    use karl_canon::ContextKind::*;
    let k = match s {
        "skill" => Skill,
        "command" => Command,
        "agent" => Agent,
        "context" => Context,
        "memory" => Memory,
        other => return Err(format!("unknown kind: {other}")),
    };
    debug_assert!(k.evaluable());
    Ok(k)
}

#[derive(Debug, Clone, Serialize)]
pub struct EvalUnitSummary {
    pub kind: String,
    pub name: String,
    pub passed: usize,
    pub total: usize,
    pub baseline_passed: usize,
    pub baseline_total: usize,
}

fn emit_progress(
    app: &AppHandle,
    kind: &str,
    name: &str,
    eval_id: &str,
    status: &str,
    reason: &str,
) {
    let _ = app.emit(
        "canon-eval-progress",
        serde_json::json!({
            "kind": kind,
            "name": name,
            "eval_id": eval_id,
            "status": status,
            "reason": reason,
        }),
    );
}

/// Share this run's results with the org registry, if the skill came from one.
///
/// Takes exactly the `EvalResult`s this run produced — NOT a re-read of the
/// on-disk store, which can hold stale entries from a prior run (skipped/
/// timed-out evals never overwrite their old verdict) or entries pinned to a
/// package version the manifest no longer points at (a v1→v2 upgrade leaves
/// v1 rows on disk under a manifest source that now resolves to v2). Pushing
/// only what was just measured keeps every pushed row honest about both
/// "was this eval run this time" and "which version was it run against".
///
/// Best-effort by construction: a locally-authored skill returns early with no
/// network call, and every failure past that point is a warn. The evals have
/// already run and are already on disk — a push problem must never surface as
/// an error for a side effect the user did not ask for.
async fn push_results_for(
    repo_root: &std::path::Path,
    kind: karl_canon::ContextKind,
    name: &str,
    results: &[karl_canon::EvalResult],
) {
    if results.is_empty() {
        return;
    }
    // Only installed skills carry a registry: source. Memory is not packageable
    // at all, so its results correctly never leave the machine.
    if kind != karl_canon::ContextKind::Skill {
        return;
    }
    let Ok(manifest) = karl_canon::read_manifest(repo_root) else {
        return;
    };
    let Some(entry) = manifest.installed.iter().find(|i| i.name == name) else {
        return; // authored here, not installed — nothing to attribute it to
    };
    let Some((org, pkg_name, version)) = karl_canon::parse_registry_source(&entry.source) else {
        return; // local: source — no registry to push to
    };
    // Resolve the PINNED version, never `latest` — results belong to the row
    // the user actually installed.
    let pkg = match crate::canon_registry::resolve(&org, &pkg_name, &version, "skill").await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(target: "canon", name, error = %e, "eval push: resolve failed");
            return;
        }
    };
    if let Err(e) = crate::canon_registry::push_evals(pkg.id, results).await {
        tracing::warn!(target: "canon", name, error = %e, "eval push failed");
    }
}

/// Run every eval for `name`: harness → judge → persist → emit. Sequential
/// (each eval is a full agent run + a judge call — slow and expensive on
/// purpose). Aborts the whole run only if claude is not installed; a per-eval
/// transient failure (non-zero exit, empty stdout) skips that eval and continues.
#[tauri::command]
pub async fn canon_run_evals(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    cwd: String,
    kind: String,
    name: String,
) -> Result<(), String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    // `read_evals` below does a plain path join with no traversal guard —
    // `prepare_sandbox`'s `valid_pkg_name` check runs one layer deeper, only
    // once the harness actually spawns, so without this a traversing `name`
    // (e.g. "../../../../etc") makes `read_evals` scan and parse an arbitrary
    // directory's `*.toml` files before anything rejects the name. Bounded —
    // every resulting eval still gets skipped once `prepare_sandbox` runs its
    // own check — but each skip would emit that attacker-chosen `Eval::id`
    // to the frontend as a toast. Validate here too; `prepare_sandbox` keeps
    // its check as defense in depth.
    if !karl_canon::valid_pkg_name(&name) {
        return Err(format!("{name:?} is not a valid unit name"));
    }
    let repo_root = std::path::PathBuf::from(&cwd);
    let evals = karl_canon::read_evals(&repo_root, unit_kind, &name);
    if evals.is_empty() {
        emit_progress(&app, &kind, &name, "", "done", "no evals found");
        return Ok(());
    }
    // Global precondition: claude must be on PATH. Check once so a missing CLI
    // gives a single clean abort instead of N per-eval skips.
    let available = tokio::task::spawn_blocking(claude_available)
        .await
        .unwrap_or(false);
    if !available {
        emit_progress(
            &app,
            &kind,
            &name,
            "",
            "skipped",
            "claude CLI not found on PATH",
        );
        emit_progress(&app, &kind, &name, "", "done", "");
        return Ok(());
    }
    let settings = state.settings.clone();
    // Results this run actually produced — the only ones pushed to the
    // registry. Deliberately NOT a re-read of eval-results.json: that file
    // can hold stale/mis-versioned entries from prior runs (see
    // `push_results_for`).
    let mut fresh_results: Vec<karl_canon::EvalResult> = Vec::new();
    for ev in evals {
        emit_progress(&app, &kind, &name, &ev.id, "running", "");
        let outcome = run_harness(&repo_root, unit_kind, &name, &ev.scenario).await;
        match outcome.status {
            HarnessStatus::Skipped(reason) => {
                // Per-eval transient (non-zero exit, empty stdout, sandbox failure):
                // skip this one eval and continue with the rest.
                emit_progress(&app, &kind, &name, &ev.id, "skipped", &reason);
                continue;
            }
            HarnessStatus::TimedOut => {
                emit_progress(&app, &kind, &name, &ev.id, "error", "harness timed out");
                continue;
            }
            HarnessStatus::Ran => {}
        }
        match judge(&settings, &ev.scenario, &ev.rubric, &outcome.transcript).await {
            Ok(v) => {
                // Baseline arm: same scenario/rubric, no skill projected.
                let base_outcome = run_baseline(&repo_root, &ev.scenario).await;
                let baseline_pass = match base_outcome.status {
                    HarnessStatus::Ran => {
                        match judge(
                            &settings,
                            &ev.scenario,
                            &ev.rubric,
                            &base_outcome.transcript,
                        )
                        .await
                        {
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
                if let Err(e) = karl_canon::write_result(&repo_root, unit_kind, &name, &result) {
                    tracing::warn!(target: "canon", error = %e, "write_result failed");
                }
                emit_progress(
                    &app,
                    &kind,
                    &name,
                    &ev.id,
                    if v.pass { "pass" } else { "fail" },
                    &v.reason,
                );
                fresh_results.push(result);
            }
            Err(e) => emit_progress(&app, &kind, &name, &ev.id, "error", &e),
        }
    }
    push_results_for(&repo_root, unit_kind, &name, &fresh_results).await;
    emit_progress(&app, &kind, &name, "", "done", "");
    Ok(())
}

/// Per-unit `(passed,total)` for the Impact section, read from eval-results.json.
#[tauri::command]
pub async fn canon_eval_summary(cwd: String) -> Result<Vec<EvalUnitSummary>, String> {
    let repo_root = std::path::PathBuf::from(&cwd);
    let all = karl_canon::read_results(&repo_root);
    Ok(all
        .into_iter()
        .map(|(key, inner)| {
            // Keys are "<kind>/<name>"; a legacy bare key is a skill.
            let (kind, name) = match key.split_once('/') {
                Some((k, n)) => (k.to_string(), n.to_string()),
                None => ("skill".to_string(), key.clone()),
            };
            let passed = inner.values().filter(|r| r.pass).count();
            let baseline_total = inner.values().filter(|r| r.baseline_pass.is_some()).count();
            let baseline_passed = inner
                .values()
                .filter(|r| r.baseline_pass == Some(true))
                .count();
            EvalUnitSummary {
                kind,
                name,
                passed,
                total: inner.len(),
                baseline_passed,
                baseline_total,
            }
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parse_evaluable_kind_accepts_the_five_and_rejects_everything_else() {
        use karl_canon::ContextKind;
        for (slug, expected) in [
            ("skill", ContextKind::Skill),
            ("command", ContextKind::Command),
            ("agent", ContextKind::Agent),
            ("context", ContextKind::Context),
            ("memory", ContextKind::Memory),
        ] {
            assert_eq!(
                parse_evaluable_kind(slug).unwrap(),
                expected,
                "{slug} must parse"
            );
        }
        // The boundary: an MCP server is a connection, and a spec is never
        // projected — neither may be pushed through the agent harness by name.
        for bad in ["mcp", "spec", "", "Skill", "skills", "bogus"] {
            assert!(
                parse_evaluable_kind(bad).is_err(),
                "{bad:?} must be rejected"
            );
        }
    }

    /// Every slug this parser accepts must also be one ContextKind::evaluable()
    /// agrees with — if the two ever drift, the parser is the one that decides
    /// what reaches the harness.
    #[test]
    fn every_parsed_kind_is_evaluable() {
        for slug in ["skill", "command", "agent", "context", "memory"] {
            assert!(parse_evaluable_kind(slug).unwrap().evaluable());
        }
    }

    #[tokio::test]
    async fn canon_eval_summary_splits_the_kind_from_the_name() {
        use karl_canon::{ContextKind, EvalResult};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let r = |pass: bool| EvalResult {
            eval_id: "e1".into(),
            pass,
            reason: "r".into(),
            ran_at_ms: 0,
            duration_ms: 0,
            baseline_pass: None,
        };
        karl_canon::write_result(root, ContextKind::Command, "horizon", &r(true)).unwrap();
        karl_canon::write_result(root, ContextKind::Skill, "kyc-peru", &r(false)).unwrap();

        let mut out = canon_eval_summary(root.to_string_lossy().into_owned())
            .await
            .unwrap();
        out.sort_by(|a, b| (&a.kind, &a.name).cmp(&(&b.kind, &b.name)));

        assert_eq!(out.len(), 2);
        assert_eq!(
            (out[0].kind.as_str(), out[0].name.as_str()),
            ("command", "horizon")
        );
        assert_eq!((out[0].passed, out[0].total), (1, 1));
        assert_eq!(
            (out[1].kind.as_str(), out[1].name.as_str()),
            ("skill", "kyc-peru")
        );
        assert_eq!((out[1].passed, out[1].total), (0, 1));
    }

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
    fn prepare_sandbox_projects_a_command() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        fs::create_dir_all(canon.join("commands")).unwrap();
        fs::write(canon.join("commands/horizon.md"), "# Ship a release\n").unwrap();

        let sbox = prepare_sandbox(root, ContextKind::Command, "horizon").unwrap();

        let projected = sbox.path().join(".claude/commands/horizon.md");
        assert!(
            projected.exists(),
            "command was not projected into the sandbox"
        );
        assert!(fs::read_to_string(&projected)
            .unwrap()
            .contains("Ship a release"));
        assert!(sbox.path().join(".claude/settings.json").exists());
    }

    /// The dangerous one: a skill projects only if canon.toml lists it, so a
    /// sandbox without the manifest silently tests nothing.
    #[test]
    fn prepare_sandbox_projects_a_skill_via_a_written_manifest() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let dir = root.join(".covenant/canon/skills/kyc-peru");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            "---\nname: kyc-peru\n---\nKYC rules.\n",
        )
        .unwrap();
        fs::write(
            dir.join("skill.toml"),
            "name = \"kyc-peru\"\nversion = \"1.0.0\"\n",
        )
        .unwrap();

        let sbox = prepare_sandbox(root, ContextKind::Skill, "kyc-peru").unwrap();

        let projected = sbox.path().join(".claude/skills/canon-kyc-peru/SKILL.md");
        assert!(
            projected.exists(),
            "skill not projected — is canon.toml written?"
        );
        assert!(fs::read_to_string(&projected)
            .unwrap()
            .contains("KYC rules"));
    }

    /// Memory has no file-per-item target; it lands in the managed block.
    ///
    /// Fixture note: `project()`'s memory bullet is built ONLY from the
    /// frontmatter `description` (see `project_writes_memory_section_into_agents_md`
    /// in `crates/canon/src/project.rs`, which asserts the bullet is exactly
    /// `- We chose X` — the file stem never appears). So the description text
    /// here embeds the unit name (`decision-x`) itself, otherwise this test
    /// would assert on a substring that real projection never produces.
    #[test]
    fn prepare_sandbox_projects_memory_into_the_managed_block() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let canon = root.join(".covenant/canon");
        fs::create_dir_all(canon.join("memory")).unwrap();
        fs::write(
            canon.join("memory/decision-x.md"),
            "---\ndescription: We chose decision-x\n---\nlonger body\n",
        )
        .unwrap();

        let sbox = prepare_sandbox(root, ContextKind::Memory, "decision-x").unwrap();

        let agents_md = fs::read_to_string(sbox.path().join("AGENTS.md")).unwrap();
        // Exact shape, matching `project_writes_memory_section_into_agents_md`
        // in crates/canon/src/project.rs — a bare substring would still pass
        // for a malformed, duplicated, or out-of-section bullet.
        assert!(agents_md.contains("## Memory"), "memory heading missing");
        assert!(
            agents_md.contains("- We chose decision-x"),
            "memory bullet missing"
        );

        // Finding 1: Claude Code reads CLAUDE.md, not AGENTS.md. A real repo's
        // CLAUDE.md is a symlink to AGENTS.md; a tempdir sandbox has no such
        // symlink, so without a CLAUDE.md copy the model never sees this
        // bullet and the eval measures nothing. Assert on CLAUDE.md
        // specifically — that is the file that determines whether the eval
        // means anything, not AGENTS.md.
        let claude_md = sbox.path().join("CLAUDE.md");
        assert!(
            claude_md.exists(),
            "CLAUDE.md must exist in the sandbox — Claude Code does not read AGENTS.md"
        );
        assert!(
            fs::read_to_string(&claude_md)
                .unwrap()
                .contains("- We chose decision-x"),
            "CLAUDE.md must carry the same memory bullet AGENTS.md does"
        );
    }

    #[test]
    fn prepare_sandbox_rejects_unevaluable_kinds_and_unknown_units() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        assert!(prepare_sandbox(root, ContextKind::Mcp, "ctx7").is_err());
        assert!(prepare_sandbox(root, ContextKind::Spec, "3.1-alpha").is_err());
        assert!(prepare_sandbox(root, ContextKind::Command, "ghost").is_err());
    }

    /// `canon_run_evals` itself can't be invoked here — it's a `#[tauri::command]`
    /// taking `AppHandle` + `State<'_, AppState>`, and this crate doesn't build
    /// with `tauri`'s `test` feature or any mock-app harness (checked: no other
    /// command with an `AppHandle` param is invoked directly from a unit test
    /// anywhere in `crates/app/src`). So this test pins the validation path one
    /// layer down: `canon_run_evals` guards `name` with exactly
    /// `karl_canon::valid_pkg_name` before it ever calls `read_evals` (see the
    /// comment at the top of that function). Confirming the predicate rejects
    /// the traversal shapes `read_evals`'s plain `Path::join` cannot defend
    /// against on its own is the closest in-process pin available; the
    /// end-to-end behavior is exercised by `prepare_sandbox_rejects_a_traversing_name`
    /// below for the second (defense-in-depth) check.
    #[test]
    fn canon_run_evals_name_guard_rejects_traversal() {
        for bad in [
            "../../../../Users/x/somewhere",
            "../../../../etc/cron.d/evil",
            "/etc/passwd",
            ".hidden",
            "has/slash",
        ] {
            assert!(
                !karl_canon::valid_pkg_name(bad),
                "{bad:?} must be rejected by the same guard canon_run_evals runs \
                 before read_evals, so an unvalidated name never reaches read_dir"
            );
        }
        // Sanity: the guard isn't rejecting everything.
        assert!(karl_canon::valid_pkg_name("horizon"));
    }

    #[test]
    fn prepare_sandbox_rejects_a_traversing_name() {
        use karl_canon::ContextKind;
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        for bad in [
            "../../../../etc/cron.d/evil",
            "/etc/passwd",
            ".hidden",
            "has/slash",
        ] {
            assert!(
                prepare_sandbox(root, ContextKind::Command, bad).is_err(),
                "{bad:?} must be rejected before any filesystem write"
            );
        }
    }

    #[test]
    fn prepare_sandbox_projects_skill_and_denylist() {
        use karl_canon::ContextKind;
        let repo = tempfile::tempdir().unwrap();
        let skill_dir = repo.path().join(".covenant/canon/skills/kyc-peru");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "# KYC Peru\nrefuse without KYC").unwrap();

        let sbox = prepare_sandbox(repo.path(), ContextKind::Skill, "kyc-peru").unwrap();
        let projected = sbox.path().join(".claude/skills/canon-kyc-peru/SKILL.md");
        assert!(projected.exists(), "skill projected into sandbox");
        assert!(
            fs::read_to_string(&projected)
                .unwrap()
                .contains("refuse without KYC"),
            "skill body copied"
        );
        let settings = sbox.path().join(".claude/settings.json");
        assert!(settings.exists(), "deny-list settings written");
        assert!(
            fs::read_to_string(&settings)
                .unwrap()
                .contains("Bash(rm:*)"),
            "deny-list mirrors the safety blocklist"
        );
    }

    #[test]
    fn missing_skill_md_is_an_error() {
        use karl_canon::ContextKind;
        let repo = tempfile::tempdir().unwrap();
        assert!(prepare_sandbox(repo.path(), ContextKind::Skill, "nope").is_err());
    }

    #[test]
    fn prepare_sandbox_bare_has_settings_but_no_skill() {
        let tmp = tempfile::tempdir().unwrap();
        let sbox = prepare_sandbox_bare(tmp.path()).unwrap();
        assert!(
            sbox.path().join(".claude/settings.json").exists(),
            "deny-list settings present"
        );
        assert!(
            !sbox.path().join(".claude/skills").exists(),
            "no skill projected in baseline"
        );
    }

    #[test]
    fn harness_args_are_readonly_no_bypass() {
        let a = harness_args("do the thing");
        assert!(
            !a.iter().any(|s| s.contains("bypassPermissions")),
            "must not bypass permissions"
        );
        assert!(a.iter().any(|s| s == "--allowedTools"));
        assert!(
            a.iter().any(|s| s == "Read")
                && a.iter().any(|s| s == "Grep")
                && a.iter().any(|s| s == "Glob"),
            "read-only tools present"
        );
        assert!(
            a.iter().any(|s| s == "SlashCommand"),
            "SlashCommand allowed so a command-kind eval's body is reachable"
        );
        assert!(
            !a.iter()
                .any(|s| s == "Bash" || s == "Write" || s == "WebFetch"),
            "no write/exec/net tools"
        );
        assert!(a.iter().any(|s| s == "--strict-mcp-config"));
        assert!(
            a.contains(&"do the thing".to_string()),
            "scenario passed through"
        );
    }

    #[test]
    fn classify_output_treats_infra_failure_as_skipped_not_ran() {
        assert_eq!(
            classify_output(true, "refuses correctly", ""),
            HarnessStatus::Ran
        );
        assert!(matches!(
            classify_output(false, "", "auth error"),
            HarnessStatus::Skipped(_)
        ));
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
