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

/// Default harness timeout; overridable via `settings.eval.harness_timeout_secs`.
pub(crate) const HARNESS_TIMEOUT_SECS: u64 = 120;
/// Judge LLM call ceiling (covers the retry) — a hung provider must not hang the run.
const JUDGE_TIMEOUT_SECS: u64 = 90;
/// Model alias pinned on every harness run so results are comparable across
/// `claude` CLI upgrades, and recorded as provenance in each result.
const EXECUTOR_MODEL: &str = "sonnet";
/// Concurrent harness runs. The sandboxes are independent temp dirs, so the
/// only shared state is the results file (already behind a write lock).
const EVAL_CONCURRENCY: usize = 2;

/// Cancel flags, keyed by `unit_key` ("skill/horizon"). Set by
/// `canon_cancel_evals`, polled by the run loop and by in-flight harness
/// spawns (which kill the child via `kill_on_drop` when their future drops).
fn cancels() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    static C: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
        std::sync::OnceLock::new();
    C.get_or_init(Default::default)
}

fn request_cancel(key: &str) {
    cancels()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(key.to_string());
}

fn is_cancelled(key: &str) -> bool {
    cancels()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(key)
}

fn clear_cancel(key: &str) {
    cancels()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(key);
}

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

/// The PATH the harness spawns with. GUI apps launched from Finder inherit
/// launchd's minimal PATH (no brew/nvm/asdf shims), so `claude` — typically in
/// `~/.local/bin` or `/opt/homebrew/bin` — is invisible without asking the
/// login shell. Resolved once and cached: the shell probe costs ~100ms.
fn harness_path() -> Option<String> {
    static P: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    P.get_or_init(crate::login_shell_path).clone()
}

/// True if the `claude` CLI is on PATH and runnable.
pub fn claude_available() -> bool {
    let mut cmd = std::process::Command::new("claude");
    cmd.arg("--version");
    if let Some(p) = harness_path() {
        cmd.env("PATH", p);
    }
    cmd.output().map(|o| o.status.success()).unwrap_or(false)
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
        "--model".to_string(),
        EXECUTOR_MODEL.to_string(),
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

/// Waits until the unit's cancel flag is set. Paired with `kill_on_drop` in
/// `run_scenario_in`: when select! drops the spawn future, the child dies.
async fn wait_cancelled(key: &str) {
    loop {
        if is_cancelled(key) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

/// Run `claude -p <scenario>` inside an already-prepared sandbox dir.
async fn run_scenario_in(
    sbox_path: &Path,
    scenario: &str,
    started: Instant,
    timeout: Duration,
    cancel_key: &str,
) -> HarnessOutcome {
    let mut cmd = tokio::process::Command::new("claude");
    cmd.args(harness_args(scenario))
        .current_dir(sbox_path)
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true);
    // Cache is warm: every caller runs `claude_available` (spawn_blocking) first.
    if let Some(p) = harness_path() {
        cmd.env("PATH", p);
    }
    let (transcript, status) = tokio::select! {
        _ = wait_cancelled(cancel_key) => {
            (String::new(), HarnessStatus::Skipped("cancelled".into()))
        }
        run = tokio::time::timeout(timeout, cmd.output()) => match run {
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
        },
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
    timeout: Duration,
    cancel_key: &str,
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
    run_scenario_in(sbox.path(), scenario, started, timeout, cancel_key).await
}

/// The baseline (no-skill) arm: same scenario in `prepare_sandbox_bare`.
pub async fn run_baseline(
    repo_root: &Path,
    scenario: &str,
    timeout: Duration,
    cancel_key: &str,
) -> HarnessOutcome {
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
    run_scenario_in(sbox.path(), scenario, started, timeout, cancel_key).await
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

/// `judge` with a hard ceiling — a hung provider call must not hang the run.
async fn judge_with_timeout(
    settings: &std::sync::Arc<tokio::sync::Mutex<Settings>>,
    scenario: &str,
    rubric: &str,
    transcript: &str,
) -> Result<Verdict, String> {
    tokio::time::timeout(
        Duration::from_secs(JUDGE_TIMEOUT_SECS),
        judge(settings, scenario, rubric, transcript),
    )
    .await
    .map_err(|_| format!("judge timed out after {JUDGE_TIMEOUT_SECS}s"))?
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
    /// Eval .toml files on disk for this unit — nonzero even before any run,
    /// so rows can show "3 evals · not run" instead of looking eval-less.
    pub authored: usize,
    /// Stored verdicts whose latest run timed out / errored — from a PRIOR
    /// run, excluded from `passed`.
    pub stale: usize,
    /// Most recent `ran_at_ms` across this unit's results.
    pub last_ran_at_ms: Option<i64>,
    /// The previous completed run's aggregate, for a pass-rate delta.
    pub prev_passed: Option<usize>,
    pub prev_total: Option<usize>,
}

fn emit_progress(
    app: &AppHandle,
    kind: &str,
    name: &str,
    eval_id: &str,
    status: &str,
    reason: &str,
) {
    emit_progress_full(app, kind, name, eval_id, status, reason, "", None);
}

#[allow(clippy::too_many_arguments)]
fn emit_progress_full(
    app: &AppHandle,
    kind: &str,
    name: &str,
    eval_id: &str,
    status: &str,
    reason: &str,
    arm: &str,
    duration_ms: Option<u64>,
) {
    let _ = app.emit(
        "canon-eval-progress",
        serde_json::json!({
            "kind": kind,
            "name": name,
            "eval_id": eval_id,
            "status": status,
            "reason": reason,
            "arm": arm,
            "duration_ms": duration_ms,
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
    app: &AppHandle,
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
    let push_err = match crate::canon_registry::resolve(&org, &pkg_name, &version, "skill").await {
        Ok(pkg) => crate::canon_registry::push_evals(pkg.id, results)
            .await
            .err()
            .map(|e| e.to_string()),
        Err(e) => Some(format!("resolve failed: {e}")),
    };
    if let Some(e) = push_err {
        // The confirm card promised sharing — a failed push must be visible,
        // not a tracing::warn the user never sees. Results are on disk either
        // way; this is informational, never an error for the run itself.
        tracing::warn!(target: "canon", name, error = %e, "eval push failed");
        emit_progress(
            app,
            kind.slug(),
            name,
            "",
            "push_failed",
            &format!("results saved locally, registry push failed: {e}"),
        );
    }
}

/// Everything one eval task needs, cloned per task for the bounded fan-out.
#[derive(Clone)]
struct RunCtx {
    app: AppHandle,
    settings: std::sync::Arc<tokio::sync::Mutex<Settings>>,
    repo_root: std::path::PathBuf,
    unit_kind: karl_canon::ContextKind,
    kind: String,
    name: String,
    cancel_key: String,
    timeout: Duration,
    with_baseline: bool,
    judge_model: Option<String>,
}

/// Run one eval end-to-end: harness → judge → baseline (cached) → persist →
/// emit. Returns the fresh result, or None on skip/timeout/error/cancel.
async fn run_one_eval(ctx: &RunCtx, ev: &karl_canon::Eval) -> Option<karl_canon::EvalResult> {
    let RunCtx {
        app,
        settings,
        repo_root,
        unit_kind,
        kind,
        name,
        cancel_key,
        timeout,
        with_baseline,
        judge_model,
    } = ctx;
    if is_cancelled(cancel_key) {
        emit_progress(app, kind, name, &ev.id, "skipped", "cancelled");
        return None;
    }
    // A prior verdict that a failed re-run would otherwise leave looking
    // current. Cancels don't stale it — the eval was never attempted.
    let stale_out = |why: &str, status: &str| {
        let _ = karl_canon::mark_result_stale(repo_root, *unit_kind, name, &ev.id);
        emit_progress(app, kind, name, &ev.id, status, why);
    };
    emit_progress_full(app, kind, name, &ev.id, "running", "", "unit", None);
    let outcome = run_harness(
        repo_root,
        *unit_kind,
        name,
        &ev.scenario,
        *timeout,
        cancel_key,
    )
    .await;
    match outcome.status {
        HarnessStatus::Skipped(reason) if reason == "cancelled" => {
            emit_progress(app, kind, name, &ev.id, "skipped", "cancelled");
            return None;
        }
        HarnessStatus::Skipped(reason) => {
            stale_out(&reason, "skipped");
            return None;
        }
        HarnessStatus::TimedOut => {
            stale_out(
                &format!("harness timed out after {}s", timeout.as_secs()),
                "error",
            );
            return None;
        }
        HarnessStatus::Ran => {}
    }
    let v = match judge_with_timeout(settings, &ev.scenario, &ev.rubric, &outcome.transcript).await
    {
        Ok(v) => v,
        Err(e) => {
            stale_out(&e, "error");
            return None;
        }
    };

    // Baseline arm: same scenario/rubric, no unit projected. The bare sandbox
    // is identical for a given scenario, so its verdict is cached by hash.
    let mut baseline_transcript: Option<String> = None;
    let baseline_pass = if !with_baseline || is_cancelled(cancel_key) {
        None
    } else {
        let hash = karl_canon::scenario_hash(&ev.scenario);
        match karl_canon::read_baseline_cache(repo_root).get(&hash) {
            Some(cached) => Some(cached.pass),
            None => {
                emit_progress_full(app, kind, name, &ev.id, "running", "", "baseline", None);
                let base = run_baseline(repo_root, &ev.scenario, *timeout, cancel_key).await;
                match base.status {
                    HarnessStatus::Ran => {
                        match judge_with_timeout(
                            settings,
                            &ev.scenario,
                            &ev.rubric,
                            &base.transcript,
                        )
                        .await
                        {
                            Ok(bv) => {
                                let _ = karl_canon::write_baseline_verdict(
                                    repo_root,
                                    &hash,
                                    &karl_canon::BaselineVerdict {
                                        pass: bv.pass,
                                        judged_at_ms: chrono::Utc::now().timestamp_millis(),
                                    },
                                );
                                baseline_transcript = Some(base.transcript);
                                Some(bv.pass)
                            }
                            Err(_) => None, // baseline judge failed → lift not measurable
                        }
                    }
                    _ => None, // baseline run skipped/timed out/cancelled → no baseline
                }
            }
        }
    };

    let result = karl_canon::EvalResult {
        eval_id: ev.id.clone(),
        pass: v.pass,
        reason: v.reason.clone(),
        ran_at_ms: chrono::Utc::now().timestamp_millis(),
        duration_ms: outcome.duration_ms,
        baseline_pass,
        stale: false,
        executor_model: Some(EXECUTOR_MODEL.to_string()),
        judge_model: judge_model.clone(),
    };
    if let Err(e) = karl_canon::write_result(repo_root, *unit_kind, name, &result) {
        tracing::warn!(target: "canon", error = %e, "write_result failed");
    }
    // Full detail (transcripts included) for the per-eval detail view.
    // Secret-masked: sandboxed agent output can still echo tokens from the
    // unit body or the environment.
    let detail = karl_canon::EvalRunDetail {
        eval_id: ev.id.clone(),
        scenario: ev.scenario.clone(),
        rubric: ev.rubric.clone(),
        pass: v.pass,
        reason: v.reason.clone(),
        ran_at_ms: result.ran_at_ms,
        duration_ms: outcome.duration_ms,
        baseline_pass,
        executor_model: result.executor_model.clone(),
        judge_model: result.judge_model.clone(),
        transcript: crate::safety::mask_secrets(&outcome.transcript),
        baseline_transcript: baseline_transcript
            .as_deref()
            .map(crate::safety::mask_secrets),
    };
    if let Err(e) = karl_canon::write_run_detail(repo_root, *unit_kind, name, &detail) {
        tracing::warn!(target: "canon", error = %e, "write_run_detail failed");
    }
    emit_progress_full(
        app,
        kind,
        name,
        &ev.id,
        if v.pass { "pass" } else { "fail" },
        &v.reason,
        "",
        Some(outcome.duration_ms),
    );
    Some(result)
}

/// Run evals for `name` — all of them, or one via `only`. Bounded fan-out
/// (EVAL_CONCURRENCY sandboxes at a time); `baseline: Some(false)` skips the
/// control arm for quick iteration. Aborts the whole run only if claude is
/// not installed; a per-eval transient failure skips that eval and continues.
#[tauri::command]
pub async fn canon_run_evals(
    app: AppHandle,
    state: State<'_, crate::AppState>,
    cwd: String,
    kind: String,
    name: String,
    baseline: Option<bool>,
    only: Option<String>,
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
    let mut evals = karl_canon::read_evals(&repo_root, unit_kind, &name);
    if let Some(only_id) = &only {
        evals.retain(|e| &e.id == only_id);
    }
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
    let cancel_key = karl_canon::unit_key(unit_kind, &name);
    clear_cancel(&cancel_key); // a stale flag from a prior stop must not kill this run
    let settings = state.settings.clone();
    let (timeout, judge_model) = {
        let s = settings.lock().await;
        (
            Duration::from_secs(s.eval.harness_timeout_secs.max(10)),
            resolve_route(&s, Role::Summary).ok().map(|r| r.model),
        )
    };
    let ctx = RunCtx {
        app: app.clone(),
        settings,
        repo_root: repo_root.clone(),
        unit_kind,
        kind: kind.clone(),
        name: name.clone(),
        cancel_key: cancel_key.clone(),
        timeout,
        with_baseline: baseline.unwrap_or(true),
        judge_model,
    };
    // Results this run actually produced — the only ones pushed to the
    // registry. Deliberately NOT a re-read of eval-results.json: that file
    // can hold stale/mis-versioned entries from prior runs (see
    // `push_results_for`).
    use futures_util::StreamExt;
    let fresh_results: Vec<karl_canon::EvalResult> = futures_util::stream::iter(evals)
        .map(|ev| {
            let ctx = ctx.clone();
            async move { run_one_eval(&ctx, &ev).await }
        })
        .buffer_unordered(EVAL_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .flatten()
        .collect();
    let was_cancelled = is_cancelled(&cancel_key);
    clear_cancel(&cancel_key);
    if !fresh_results.is_empty() {
        let record = karl_canon::EvalRunRecord {
            kind: kind.clone(),
            name: name.clone(),
            passed: fresh_results.iter().filter(|r| r.pass).count(),
            total: fresh_results.len(),
            at_ms: chrono::Utc::now().timestamp_millis(),
        };
        if let Err(e) = karl_canon::append_history(&repo_root, &record) {
            tracing::warn!(target: "canon", error = %e, "append_history failed");
        }
    }
    push_results_for(&app, &repo_root, unit_kind, &name, &fresh_results).await;
    emit_progress(
        &app,
        &kind,
        &name,
        "",
        "done",
        if was_cancelled { "cancelled" } else { "" },
    );
    Ok(())
}

/// Stop a running suite. The run loop skips unstarted evals and in-flight
/// harness spawns are killed (`kill_on_drop`) within ~300ms.
#[tauri::command]
pub async fn canon_cancel_evals(kind: String, name: String) -> Result<(), String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    if !karl_canon::valid_pkg_name(&name) {
        return Err(format!("{name:?} is not a valid unit name"));
    }
    request_cancel(&karl_canon::unit_key(unit_kind, &name));
    Ok(())
}

/// One eval's last run detail (transcripts included). Err if never run.
#[tauri::command]
pub async fn canon_eval_detail(
    cwd: String,
    kind: String,
    name: String,
    eval_id: String,
) -> Result<karl_canon::EvalRunDetail, String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    if !karl_canon::valid_pkg_name(&name) || !karl_canon::valid_pkg_name(&eval_id) {
        return Err("invalid unit or eval name".into());
    }
    karl_canon::read_run_detail(&std::path::PathBuf::from(&cwd), unit_kind, &name, &eval_id)
        .ok_or_else(|| format!("no run recorded for {eval_id} — run it first"))
}

/// Overwrite one eval's scenario/rubric — the manager's Save. The id names an
/// existing or new file; content is validated like `canon_write_evals`.
#[tauri::command]
pub async fn canon_update_eval(
    cwd: String,
    kind: String,
    name: String,
    eval: karl_canon::Eval,
) -> Result<(), String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    if !karl_canon::valid_pkg_name(&name) {
        return Err(format!("{name:?} is not a valid unit name"));
    }
    let mut eval = eval;
    eval.id = draft_slug(&eval.id);
    if !karl_canon::valid_pkg_name(&eval.id)
        || eval.scenario.trim().is_empty()
        || eval.rubric.trim().is_empty()
    {
        return Err("eval needs a valid id and non-empty scenario + rubric".into());
    }
    karl_canon::overwrite_eval(&std::path::PathBuf::from(&cwd), unit_kind, &name, &eval)
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// Delete one authored eval (file + stored verdict + run detail).
#[tauri::command]
pub async fn canon_delete_eval(
    cwd: String,
    kind: String,
    name: String,
    eval_id: String,
) -> Result<(), String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    if !karl_canon::valid_pkg_name(&name) || !karl_canon::valid_pkg_name(&eval_id) {
        return Err("invalid unit or eval name".into());
    }
    karl_canon::delete_eval(&std::path::PathBuf::from(&cwd), unit_kind, &name, &eval_id)
        .map_err(|e| e.to_string())
}

const DRAFT_SYSTEM: &str = "You write behavior evals for an AI agent's context unit (a skill, \
command, agent, context doc, or memory). Given the unit's source, produce 3-5 evals. Each eval is a \
scenario that would tempt an agent WITHOUT this unit to do the wrong thing, plus a rubric stating \
the observable behavior the unit should force. The scenario is 1-3 sentences addressed to the agent \
as a user request; the rubric is 1-2 sentences of pass criteria a judge can verify from a transcript \
alone. Reply with ONLY a JSON array, no prose and no code fences: \
[{\"id\": \"kebab-case-slug\", \"scenario\": \"...\", \"rubric\": \"...\"}, ...]";

/// Extract the drafter's JSON array, tolerating prose or fences around it.
fn parse_drafts(text: &str) -> Result<Vec<karl_canon::Eval>, String> {
    let start = text.find('[').ok_or("draft output had no JSON array")?;
    let end = text.rfind(']').ok_or("draft output had no JSON array")?;
    if end < start {
        return Err("draft output had no JSON array".into());
    }
    serde_json::from_str(&text[start..=end]).map_err(|e| format!("draft output unparseable: {e}"))
}

/// Force a model-chosen id into the filename charset `valid_pkg_name` accepts.
fn draft_slug(id: &str) -> String {
    let mut out = String::new();
    for c in id.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            out.push(c);
        } else if !out.ends_with('-') && !out.is_empty() {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_string()
}

/// Draft 3-5 evals for a unit: read its source, ask the Summary-role model
/// for scenario/rubric pairs, and return them for review in the drawer.
/// Nothing touches disk here — `canon_write_evals` persists the approved set.
#[tauri::command]
pub async fn canon_draft_evals(
    state: State<'_, crate::AppState>,
    cwd: String,
    kind: String,
    name: String,
) -> Result<Vec<karl_canon::Eval>, String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    if !karl_canon::valid_pkg_name(&name) {
        return Err(format!("{name:?} is not a valid unit name"));
    }
    let repo_root = std::path::PathBuf::from(&cwd);
    let body = {
        let repo = repo_root.clone();
        let n = name.clone();
        tokio::task::spawn_blocking(move || karl_canon::read_source(&repo, unit_kind, &n))
            .await
            .map_err(|e| format!("read_source join: {e}"))?
            .map_err(|e| e.to_string())?
    };
    let resolved = {
        let s = state.settings.lock().await;
        match resolve_route(&s, Role::Summary) {
            Ok(r) => r,
            Err(ResolveError::NoRoute(_)) => {
                return Err("no LLM route configured for drafting".into())
            }
            Err(e) => return Err(format!("draft provider unavailable: {e}")),
        }
    };
    let req = karl_agent::AskRequest {
        api_key: String::new(),
        model: resolved.model.clone(),
        system_prompt: DRAFT_SYSTEM.to_string(),
        user_message: format!("## UNIT ({kind} \"{name}\")\n\n{body}"),
        max_tokens: 4096,
        thinking_budget: None,
        force_tool: None,
    };
    let resp = karl_agent::provider::collect_oneshot(&*resolved.provider, req)
        .await
        .map_err(|e| e.to_string())?;
    let drafts: Vec<karl_canon::Eval> = parse_drafts(&resp.text)?
        .into_iter()
        .map(|mut d| {
            d.id = draft_slug(&d.id);
            d
        })
        .filter(|d| {
            // a malformed draft is dropped, never surfaced
            karl_canon::valid_pkg_name(&d.id)
                && !d.scenario.trim().is_empty()
                && !d.rubric.trim().is_empty()
        })
        .collect();
    if drafts.is_empty() {
        return Err("model drafted no usable evals — try again".into());
    }
    Ok(drafts)
}

/// Persist the user-approved drafts as `.covenant/canon/evals/<kind>/<name>/
/// <id>.toml`. Re-validates every draft (the frontend is not trusted with
/// filenames). By default ids whose file already exists are silently skipped
/// — never overwritten; `overwrite: Some(true)` is the explicit opt-in that
/// clobbers them. Returns the ids actually written.
#[tauri::command]
pub async fn canon_write_evals(
    cwd: String,
    kind: String,
    name: String,
    evals: Vec<karl_canon::Eval>,
    overwrite: Option<bool>,
) -> Result<Vec<String>, String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    if !karl_canon::valid_pkg_name(&name) {
        return Err(format!("{name:?} is not a valid unit name"));
    }
    let repo_root = std::path::PathBuf::from(&cwd);
    let overwrite = overwrite.unwrap_or(false);
    let mut written = Vec::new();
    for mut d in evals {
        d.id = draft_slug(&d.id);
        if !karl_canon::valid_pkg_name(&d.id)
            || d.scenario.trim().is_empty()
            || d.rubric.trim().is_empty()
        {
            continue;
        }
        let res = if overwrite {
            karl_canon::overwrite_eval(&repo_root, unit_kind, &name, &d)
        } else {
            karl_canon::write_eval(&repo_root, unit_kind, &name, &d)
        };
        match res {
            Ok(_) => written.push(d.id),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(format!("writing eval {}: {e}", d.id)),
        }
    }
    if written.is_empty() {
        return Err("no new evals written — all were empty, invalid, or already exist".into());
    }
    Ok(written)
}

/// The authored evals for one unit, sorted by id — lets the progress panel
/// show every eval as pending before the first event arrives.
#[tauri::command]
pub async fn canon_list_evals(
    cwd: String,
    kind: String,
    name: String,
) -> Result<Vec<karl_canon::Eval>, String> {
    let unit_kind = parse_evaluable_kind(&kind)?;
    // Same traversal guard as canon_run_evals — read_evals joins the name
    // into a path unchecked.
    if !karl_canon::valid_pkg_name(&name) {
        return Err(format!("{name:?} is not a valid unit name"));
    }
    let repo_root = std::path::PathBuf::from(&cwd);
    Ok(karl_canon::read_evals(&repo_root, unit_kind, &name))
}

/// Per-unit `(passed,total)` for the Impact section, read from eval-results.json.
#[tauri::command]
pub async fn canon_eval_summary(cwd: String) -> Result<Vec<EvalUnitSummary>, String> {
    let repo_root = std::path::PathBuf::from(&cwd);
    let all = karl_canon::read_results(&repo_root);
    // Union of both trees: results rows pick up their authored file count,
    // and units with evals authored but never run still get a row — that is
    // what lets a list say "3 evals · not run" instead of nothing.
    let mut authored = karl_canon::authored_counts(&repo_root);
    // Previous completed run per unit key, for the pass-rate delta: the
    // second-to-last history record (the last one IS the current state).
    let history = karl_canon::read_history(&repo_root);
    let prev_of = |kind: &str, name: &str| -> Option<(usize, usize)> {
        let mine: Vec<_> = history
            .iter()
            .filter(|r| r.kind == kind && r.name == name)
            .collect();
        (mine.len() >= 2).then(|| {
            let p = mine[mine.len() - 2];
            (p.passed, p.total)
        })
    };
    let mut out: Vec<EvalUnitSummary> = all
        .into_iter()
        .map(|(key, inner)| {
            // Keys are "<kind>/<name>"; a legacy bare key is a skill.
            let (kind, name) = match key.split_once('/') {
                Some((k, n)) => (k.to_string(), n.to_string()),
                None => ("skill".to_string(), key.clone()),
            };
            // A stale verdict is from a prior run — never counted as a pass.
            let passed = inner.values().filter(|r| r.pass && !r.stale).count();
            let stale = inner.values().filter(|r| r.stale).count();
            let last_ran_at_ms = inner.values().map(|r| r.ran_at_ms).max();
            let baseline_total = inner.values().filter(|r| r.baseline_pass.is_some()).count();
            let baseline_passed = inner
                .values()
                .filter(|r| r.baseline_pass == Some(true))
                .count();
            let (prev_passed, prev_total) = match prev_of(&kind, &name) {
                Some((p, t)) => (Some(p), Some(t)),
                None => (None, None),
            };
            EvalUnitSummary {
                authored: authored.remove(&format!("{kind}/{name}")).unwrap_or(0),
                kind,
                name,
                passed,
                total: inner.len(),
                baseline_passed,
                baseline_total,
                stale,
                last_ran_at_ms,
                prev_passed,
                prev_total,
            }
        })
        .collect();
    for (key, n) in authored {
        let Some((kind, name)) = key.split_once('/') else {
            continue;
        };
        out.push(EvalUnitSummary {
            kind: kind.to_string(),
            name: name.to_string(),
            passed: 0,
            total: 0,
            baseline_passed: 0,
            baseline_total: 0,
            authored: n,
            stale: 0,
            last_ran_at_ms: None,
            prev_passed: None,
            prev_total: None,
        });
    }
    Ok(out)
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
            ..Default::default()
        };
        karl_canon::write_result(root, ContextKind::Command, "horizon", &r(true)).unwrap();
        karl_canon::write_result(root, ContextKind::Skill, "kyc-peru", &r(false)).unwrap();
        // Authored files: two for a unit with results, one for a unit with
        // none — the latter must still surface as a row ("not run").
        let ev = |id: &str| karl_canon::Eval {
            id: id.into(),
            scenario: "s".into(),
            rubric: "r".into(),
        };
        karl_canon::write_eval(root, ContextKind::Command, "horizon", &ev("e1")).unwrap();
        karl_canon::write_eval(root, ContextKind::Command, "horizon", &ev("e2")).unwrap();
        karl_canon::write_eval(root, ContextKind::Skill, "drafted-only", &ev("e1")).unwrap();

        let mut out = canon_eval_summary(root.to_string_lossy().into_owned())
            .await
            .unwrap();
        out.sort_by(|a, b| (&a.kind, &a.name).cmp(&(&b.kind, &b.name)));

        assert_eq!(out.len(), 3);
        assert_eq!(
            (out[0].kind.as_str(), out[0].name.as_str()),
            ("command", "horizon")
        );
        assert_eq!((out[0].passed, out[0].total, out[0].authored), (1, 1, 2));
        assert_eq!(
            (out[1].kind.as_str(), out[1].name.as_str()),
            ("skill", "drafted-only")
        );
        assert_eq!((out[1].passed, out[1].total, out[1].authored), (0, 0, 1));
        assert_eq!(
            (out[2].kind.as_str(), out[2].name.as_str()),
            ("skill", "kyc-peru")
        );
        assert_eq!((out[2].passed, out[2].total, out[2].authored), (0, 1, 0));
    }

    #[tokio::test]
    async fn canon_list_evals_returns_sorted_and_guards_the_name() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();
        for id in ["b-second", "a-first"] {
            karl_canon::write_eval(
                tmp.path(),
                karl_canon::ContextKind::Skill,
                "horizon",
                &karl_canon::Eval {
                    id: id.into(),
                    scenario: "s".into(),
                    rubric: "r".into(),
                },
            )
            .unwrap();
        }
        let out = canon_list_evals(cwd.clone(), "skill".into(), "horizon".into())
            .await
            .unwrap();
        assert_eq!(
            out.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(),
            vec!["a-first", "b-second"]
        );
        assert!(
            canon_list_evals(cwd.clone(), "skill".into(), "../../etc".into())
                .await
                .is_err()
        );
        assert!(canon_list_evals(cwd, "mcp".into(), "horizon".into())
            .await
            .is_err());
    }

    #[tokio::test]
    async fn canon_write_evals_writes_valid_skips_junk_and_existing() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();
        let ev = |id: &str, s: &str, r: &str| karl_canon::Eval {
            id: id.into(),
            scenario: s.into(),
            rubric: r.into(),
        };
        // Pre-existing hand-tuned eval must survive untouched.
        karl_canon::write_eval(
            tmp.path(),
            karl_canon::ContextKind::Skill,
            "horizon",
            &ev("kept", "original", "original"),
        )
        .unwrap();

        let written = canon_write_evals(
            cwd.clone(),
            "skill".into(),
            "horizon".into(),
            vec![
                ev("Refuses A Dirty Tree", "s", "r"), // slugged then written
                ev("kept", "clobber attempt", "x"),   // exists → skipped
                ev("no-rubric", "s", "  "),           // empty rubric → dropped
            ],
            None,
        )
        .await
        .unwrap();
        assert_eq!(written, vec!["refuses-a-dirty-tree"]);

        let on_disk = karl_canon::read_evals(tmp.path(), karl_canon::ContextKind::Skill, "horizon");
        assert_eq!(on_disk.len(), 2);
        let kept = on_disk.iter().find(|e| e.id == "kept").unwrap();
        assert_eq!(
            kept.scenario, "original",
            "existing eval must not be clobbered"
        );

        // Nothing usable → a hard error, not a silent empty success.
        assert!(canon_write_evals(
            cwd.clone(),
            "skill".into(),
            "horizon".into(),
            vec![ev("kept", "s", "r")],
            None,
        )
        .await
        .is_err());

        // Explicit overwrite is the one path that clobbers.
        let overwritten = canon_write_evals(
            cwd,
            "skill".into(),
            "horizon".into(),
            vec![ev("kept", "replaced scenario", "r")],
            Some(true),
        )
        .await
        .unwrap();
        assert_eq!(overwritten, vec!["kept"]);
        let after = karl_canon::read_evals(tmp.path(), karl_canon::ContextKind::Skill, "horizon");
        assert_eq!(
            after.iter().find(|e| e.id == "kept").unwrap().scenario,
            "replaced scenario"
        );
    }

    #[test]
    fn parse_drafts_tolerates_fences_and_prose() {
        let wrapped = "Here you go:\n```json\n[{\"id\":\"refuses-x\",\"scenario\":\"s\",\"rubric\":\"r\"}]\n```\nEnjoy!";
        let out = parse_drafts(wrapped).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].id, "refuses-x");

        assert!(parse_drafts("no array here").is_err());
        assert!(parse_drafts("[{\"id\": broken").is_err());
    }

    #[test]
    fn draft_slug_forces_the_pkg_name_charset() {
        assert_eq!(draft_slug("Refuses A Dirty Tree!"), "refuses-a-dirty-tree");
        assert_eq!(draft_slug("--weird__id--"), "weird-id");
        for s in ["Refuses A Dirty Tree!", "ok-already", "UPPER"] {
            assert!(karl_canon::valid_pkg_name(&draft_slug(s)), "{s:?}");
        }
        // Degenerate input slugs to empty — the caller drops it, never writes.
        assert_eq!(draft_slug("!!!"), "");
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
        // Model pinned for provenance/reproducibility across CLI upgrades.
        let model_at = a.iter().position(|s| s == "--model").expect("--model");
        assert_eq!(a[model_at + 1], EXECUTOR_MODEL);
    }

    #[test]
    fn cancel_registry_sets_reads_and_clears_per_unit() {
        let key = "skill/cancel-test-unit";
        assert!(!is_cancelled(key));
        request_cancel(key);
        assert!(is_cancelled(key));
        assert!(!is_cancelled("skill/other-unit"), "flags are per unit");
        clear_cancel(key);
        assert!(!is_cancelled(key));
    }

    #[tokio::test]
    async fn canon_cancel_evals_guards_kind_and_name() {
        assert!(canon_cancel_evals("mcp".into(), "x".into()).await.is_err());
        assert!(canon_cancel_evals("skill".into(), "../../etc".into())
            .await
            .is_err());
        canon_cancel_evals("skill".into(), "fine".into())
            .await
            .unwrap();
        assert!(is_cancelled("skill/fine"));
        clear_cancel("skill/fine");
    }

    #[tokio::test]
    async fn canon_update_and_delete_eval_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let cwd = tmp.path().to_string_lossy().into_owned();
        let ev = karl_canon::Eval {
            id: "Refuses Something".into(), // slugged on save
            scenario: "s".into(),
            rubric: "r".into(),
        };
        canon_update_eval(cwd.clone(), "skill".into(), "horizon".into(), ev.clone())
            .await
            .unwrap();
        let on_disk = karl_canon::read_evals(tmp.path(), karl_canon::ContextKind::Skill, "horizon");
        assert_eq!(on_disk[0].id, "refuses-something");
        // Update overwrites in place (that's the point of Save).
        let mut edited = ev.clone();
        edited.scenario = "tightened".into();
        canon_update_eval(cwd.clone(), "skill".into(), "horizon".into(), edited)
            .await
            .unwrap();
        assert_eq!(
            karl_canon::read_evals(tmp.path(), karl_canon::ContextKind::Skill, "horizon")[0]
                .scenario,
            "tightened"
        );
        // Junk is rejected, not silently dropped.
        assert!(canon_update_eval(
            cwd.clone(),
            "skill".into(),
            "horizon".into(),
            karl_canon::Eval {
                id: "ok".into(),
                scenario: "  ".into(),
                rubric: "r".into()
            }
        )
        .await
        .is_err());
        canon_delete_eval(
            cwd.clone(),
            "skill".into(),
            "horizon".into(),
            "refuses-something".into(),
        )
        .await
        .unwrap();
        assert!(
            karl_canon::read_evals(tmp.path(), karl_canon::ContextKind::Skill, "horizon")
                .is_empty()
        );
        assert!(
            canon_delete_eval(cwd, "skill".into(), "horizon".into(), "../../etc".into())
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn canon_eval_summary_excludes_stale_from_passed_and_carries_prev() {
        use karl_canon::{ContextKind, EvalResult};
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let mk = |id: &str, pass: bool, at: i64| EvalResult {
            eval_id: id.into(),
            pass,
            ran_at_ms: at,
            ..Default::default()
        };
        karl_canon::write_result(root, ContextKind::Skill, "kyc", &mk("e1", true, 10)).unwrap();
        karl_canon::write_result(root, ContextKind::Skill, "kyc", &mk("e2", true, 20)).unwrap();
        karl_canon::mark_result_stale(root, ContextKind::Skill, "kyc", "e2").unwrap();
        // Two completed runs in history → prev is the first.
        for (p, at) in [(0usize, 1i64), (2, 20)] {
            karl_canon::append_history(
                root,
                &karl_canon::EvalRunRecord {
                    kind: "skill".into(),
                    name: "kyc".into(),
                    passed: p,
                    total: 2,
                    at_ms: at,
                },
            )
            .unwrap();
        }
        let out = canon_eval_summary(root.to_string_lossy().into_owned())
            .await
            .unwrap();
        let s = out.iter().find(|s| s.name == "kyc").unwrap();
        assert_eq!(
            (s.passed, s.total, s.stale),
            (1, 2, 1),
            "a stale pass is not a current pass"
        );
        assert_eq!(s.last_ran_at_ms, Some(20));
        assert_eq!((s.prev_passed, s.prev_total), (Some(0), Some(2)));
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
