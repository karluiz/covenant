//! Beacon: GitHub Actions workflow status for the active session's repo.
//!
//! Shows the latest run of each Actions workflow (CI/CD pipelines like
//! "Release macOS", "Deploy Landing"). This is the Actions API, not the
//! Deployments API — Release-style workflows publish GitHub Releases, not
//! deployments, so they only show up here.

use serde::Serialize;

/// The latest run of one Actions workflow, as the UI consumes it.
#[derive(Debug, Clone, Serialize)]
pub struct WorkflowRun {
    /// Run id — used to rerun/cancel this specific run.
    pub id: u64,
    /// Workflow name, e.g. "Release macOS".
    pub name: String,
    /// Collapsed state token (see `run_state`): success | failure |
    /// in_progress | queued | cancelled | ...
    pub state: String,
    pub run_number: u64,
    pub branch: Option<String>,
    pub sha: String, // short (7)
    pub actor: Option<String>,
    /// html_url of the run (web UI).
    pub url: Option<String>,
    pub updated_at: String,
}

/// A child directory that is itself a GitHub repo (for the picker).
#[derive(Debug, Clone, Serialize)]
pub struct SubRepo {
    /// Absolute path to the child dir — fed back to `load_workflow_runs`.
    pub path: String,
    /// owner/repo label.
    pub repo: String,
}

/// One job of a workflow run, with its steps — the expandable detail
/// behind a Beacon run row.
#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: u64,
    pub name: String,
    /// Collapsed state token (see `run_state`).
    pub state: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub steps: Vec<Step>,
}

/// One step of a job.
#[derive(Debug, Clone, Serialize)]
pub struct Step {
    pub name: String,
    pub state: String,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
}

/// Tagged so the frontend can switch on `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BeaconState {
    NotAuthed,
    NoRepo,
    /// cwd has no GitHub remote but contains sub-repos — let the user pick one.
    Repos {
        dirs: Vec<SubRepo>,
    },
    Ok {
        repo: String,
        runs: Vec<WorkflowRun>,
    },
    Error {
        message: String,
    },
}

/// Collapse Actions (status, conclusion) into one state token the UI colors.
/// A `completed` run reports its conclusion (success/failure/cancelled/…);
/// any other status (queued, in_progress, requested, waiting) is the state.
pub fn run_state(status: &str, conclusion: Option<&str>) -> String {
    if status == "completed" {
        conclusion.unwrap_or("unknown").to_string()
    } else {
        status.to_string()
    }
}

// ── GitHub fetch ────────────────────────────────────────────────────

/// Pull the human-readable incident line out of githubstatus.com's
/// `status.json`. `indicator: "none"` means all-green — say nothing rather
/// than reassure the user about a request that just failed anyway.
fn status_note(v: &serde_json::Value) -> Option<String> {
    let s = v.get("status")?;
    if s.get("indicator").and_then(|i| i.as_str())? == "none" {
        return None;
    }
    let desc = s.get("description").and_then(|d| d.as_str())?;
    Some(format!("GitHub reports: {desc}"))
}

/// Ask githubstatus.com whether this is GitHub's fault. Best-effort: any
/// failure here is silence, never a second error stacked on the first.
async fn github_incident(client: &reqwest::Client) -> Option<String> {
    let resp = client
        .get("https://www.githubstatus.com/api/v2/status.json")
        .header("User-Agent", "covenant-client")
        .send()
        .await
        .ok()?;
    status_note(&resp.json::<serde_json::Value>().await.ok()?)
}

/// reqwest's Display for a send failure is a URL dump ("error sending request
/// for url (https://api.github.com/…&per_page=100)") — unreadable in a 300px
/// rail. Shape it like the HTTP errors below: "github: <cause> — <remedy>".
fn transport_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "github: request timed out — GitHub or your network is slow; retry".into()
    } else if e.is_connect() {
        "github: can't reach github.com — check your internet connection".into()
    } else {
        // ponytail: one bucket for the rest (body/decode/redirect); split it
        // only if the logs show a case where the remedy actually differs.
        "github: request failed — check your connection and retry".into()
    }
}

async fn gh_get(
    client: &reqwest::Client,
    token: &str,
    url: &str,
) -> Result<serde_json::Value, String> {
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "covenant-client")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| transport_err(&e))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        // GitHub packs the real reason (SSO, OAuth-app restriction, rate-limit,
        // …) into the JSON `message`; surface it so a 403 isn't a coin-flip.
        tracing::warn!(url, status, "github request failed");
        let mut detail = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("message")
                    .and_then(|m| m.as_str())
                    .map(str::to_string)
            });
        // A 5xx is never the user's doing — if GitHub is having an incident,
        // that beats whatever prose the edge returned.
        if status >= 500 {
            detail = github_incident(client).await.or(detail);
        }
        return Err(match (status, detail) {
            (401, _) => "github: token invalid or expired — reconnect GitHub in Settings".into(),
            (403, Some(m)) => format!("github: {m}"),
            (403, None) => "github: forbidden — rate-limited or missing repo permission".into(),
            (404, _) => "github: repo not found — private repos need repo scope".into(),
            (s, Some(m)) => format!("github: HTTP {s} — {m}"),
            (s, None) => format!("github: HTTP {s}"),
        });
    }
    serde_json::from_str(&text).map_err(|e| format!("github: invalid JSON: {e}"))
}

/// POST with no body (rerun/cancel). Same error shaping as `gh_get`, minus
/// the JSON body — those endpoints return 201/202 with a run summary we
/// don't need.
async fn gh_post(client: &reqwest::Client, token: &str, url: &str) -> Result<(), String> {
    let resp = client
        .post(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "covenant-client")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| transport_err(&e))?;
    let status = resp.status().as_u16();
    if (200..300).contains(&status) {
        return Ok(());
    }
    let text = resp.text().await.unwrap_or_default();
    let detail = serde_json::from_str::<serde_json::Value>(&text)
        .ok()
        .and_then(|v| {
            v.get("message")
                .and_then(|m| m.as_str())
                .map(str::to_string)
        });
    Err(match (status, detail) {
        (401, _) => "github: token invalid or expired — reconnect GitHub in Settings".into(),
        (403, Some(m)) => format!("github: {m}"),
        (403, None) => "github: forbidden — missing repo permission".into(),
        (404, _) => "github: run not found".into(),
        (s, Some(m)) => format!("github: HTTP {s} — {m}"),
        (s, None) => format!("github: HTTP {s}"),
    })
}

async fn owner_repo_token(cwd: &str) -> Result<(String, String, String), String> {
    let (owner, repo) = resolve_owner_repo(cwd)
        .await
        .ok_or_else(|| "github: no GitHub remote in this folder".to_string())?;
    let token = karl_score::auth::load_token_from_keychain()
        .map_err(|e| format!("keychain: {e}"))?
        .ok_or_else(|| "github: not signed in — reconnect GitHub in Settings".to_string())?;
    Ok((owner, repo, token))
}

/// Re-run a completed workflow run (all jobs).
pub async fn rerun_workflow_run(cwd: String, run_id: u64) -> Result<(), String> {
    let (owner, repo, token) = owner_repo_token(&cwd).await?;
    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/rerun");
    gh_post(&client, &token, &url).await
}

/// Cancel an in-progress or queued workflow run.
pub async fn cancel_workflow_run(cwd: String, run_id: u64) -> Result<(), String> {
    let (owner, repo, token) = owner_repo_token(&cwd).await?;
    let client = reqwest::Client::new();
    let url = format!("https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/cancel");
    gh_post(&client, &token, &url).await
}

/// Parse the GitHub jobs-for-run payload into UI-shaped jobs. Queued jobs
/// omit `steps`; in-flight steps have null conclusion/completed_at.
pub fn parse_jobs(v: &serde_json::Value) -> Vec<Job> {
    let Some(arr) = v.get("jobs").and_then(|j| j.as_array()) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|j| {
            let id = j.get("id")?.as_u64()?;
            let steps = j
                .get("steps")
                .and_then(|s| s.as_array())
                .map(|arr| {
                    arr.iter()
                        .map(|s| Step {
                            name: s
                                .get("name")
                                .and_then(|x| x.as_str())
                                .unwrap_or("")
                                .to_string(),
                            state: run_state(
                                s.get("status").and_then(|x| x.as_str()).unwrap_or(""),
                                s.get("conclusion").and_then(|x| x.as_str()),
                            ),
                            started_at: s
                                .get("started_at")
                                .and_then(|x| x.as_str())
                                .map(str::to_string),
                            completed_at: s
                                .get("completed_at")
                                .and_then(|x| x.as_str())
                                .map(str::to_string),
                        })
                        .collect()
                })
                .unwrap_or_default();
            Some(Job {
                id,
                name: j
                    .get("name")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
                state: run_state(
                    j.get("status").and_then(|x| x.as_str()).unwrap_or(""),
                    j.get("conclusion").and_then(|x| x.as_str()),
                ),
                started_at: j
                    .get("started_at")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                completed_at: j
                    .get("completed_at")
                    .and_then(|x| x.as_str())
                    .map(str::to_string),
                steps,
            })
        })
        .collect()
}

/// Jobs + steps for one workflow run.
pub async fn run_jobs(cwd: String, run_id: u64) -> Result<Vec<Job>, String> {
    let (owner, repo, token) = owner_repo_token(&cwd).await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let url = format!(
        "https://api.github.com/repos/{owner}/{repo}/actions/runs/{run_id}/jobs?per_page=50"
    );
    let body = gh_get(&client, &token, &url).await?;
    Ok(parse_jobs(&body))
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

// ── Remediation: hand a failed run to an executor ───────────────────
//
// Builds TEXT — the first message of an executor chat. It never runs
// anything, so it sits outside the execution-policy framework entirely.

/// How much of a failed job's log an executor gets.
/// ponytail: fixed tail; add a summarization pre-pass if a log stops fitting.
const LOG_TAIL_LINES: usize = 200;
const LOG_TAIL_BYTES: usize = 8_000;

/// GitHub prefixes every log line with an ISO-8601 timestamp
/// ("2026-07-28T18:00:00.1234567Z ") — ~30 bytes a line of pure noise.
fn strip_timestamp(line: &str) -> &str {
    let Some((head, rest)) = line.split_once(' ') else {
        return line;
    };
    let b = head.as_bytes();
    if head.len() >= 20 && head.ends_with('Z') && b[4] == b'-' && b[10] == b'T' {
        rest
    } else {
        line
    }
}

/// Tail of a raw job log, safe to send to a model: ANSI stripped,
/// timestamps dropped, capped, and secrets masked LAST (CI logs carry
/// signing credentials).
pub fn log_tail(raw: &str) -> String {
    let clean = strip_ansi_escapes::strip_str(raw);
    let lines: Vec<&str> = clean.lines().map(strip_timestamp).collect();
    let start = lines.len().saturating_sub(LOG_TAIL_LINES);
    let mut out = lines[start..].join("\n");
    if out.len() > LOG_TAIL_BYTES {
        // Keep the END — the error is at the bottom.
        let want = out.len() - LOG_TAIL_BYTES;
        let cut = (want..out.len())
            .find(|i| out.is_char_boundary(*i))
            .unwrap_or(out.len());
        out = out[cut..].to_string();
    }
    crate::safety::mask_secrets(&out)
}

/// The job that actually failed, and the step inside it. First match wins:
/// a run with 19 green jobs and one red one must land on the red one.
/// ponytail: first failure only; add a picker when runs really fail twice.
pub fn first_failure(jobs: &[Job]) -> Option<(&Job, Option<&Step>)> {
    let bad = |s: &str| matches!(s, "failure" | "timed_out" | "startup_failure");
    let job = jobs.iter().find(|j| bad(&j.state))?;
    Some((job, job.steps.iter().find(|s| bad(&s.state))))
}

/// The prompt itself. Pure so the shape is testable without GitHub.
pub fn build_failure_prompt(
    repo: &str,
    run: &serde_json::Value,
    job: &Job,
    step: Option<&Step>,
    log: &str,
) -> String {
    let s = |k: &str| run.get(k).and_then(|v| v.as_str()).unwrap_or("");
    let workflow = s("name");
    let number = run.get("run_number").and_then(|v| v.as_u64()).unwrap_or(0);
    let branch = s("head_branch");
    let sha = short_sha(s("head_sha"));
    let title = s("display_title");
    let url = s("html_url");
    let step_line = step
        .map(|st| format!("step      {} ({})\n", st.name, st.state))
        .unwrap_or_default();
    format!(
        "A GitHub Actions run failed. Find the cause and propose a fix.\n\n\
         repo      {repo}\n\
         workflow  {workflow} · run #{number}\n\
         job       {job_name} ({job_state})\n\
         {step_line}\
         ref       {branch} @ {sha} — {title}\n\
         url       {url}\n\n\
         ── failed job log (tail, ANSI-stripped, secrets masked) ──\n\
         {log}\n\n\
         Work in this checkout. Name the root cause first, then propose the \
         smallest fix. Do not push and do not re-run the workflow — I will.\n",
        job_name = job.name,
        job_state = job.state,
    )
}

/// Plain-text GET — job logs 302 to a signed blob URL and return text,
/// not JSON.
async fn gh_get_text(client: &reqwest::Client, token: &str, url: &str) -> Result<String, String> {
    let resp = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "covenant-client")
        .bearer_auth(token)
        .send()
        .await
        .map_err(|e| transport_err(&e))?;
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        tracing::warn!(url, status, "github log fetch failed");
        return Err(match status {
            401 => "github: token invalid or expired — reconnect GitHub in Settings".into(),
            403 => "github: forbidden — rate-limited or missing actions:read".into(),
            404 | 410 => "github: log expired or unavailable".into(),
            s => format!("github: HTTP {s}"),
        });
    }
    Ok(text)
}

/// Package a failed run as the first message of an executor chat.
pub async fn failure_prompt(cwd: String, run_id: u64) -> Result<String, String> {
    let (owner, repo, token) = owner_repo_token(&cwd).await?;
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("http client init failed: {e}"))?;
    let api = "https://api.github.com";

    let run = gh_get(
        &client,
        &token,
        &format!("{api}/repos/{owner}/{repo}/actions/runs/{run_id}"),
    )
    .await?;
    let jobs_body = gh_get(
        &client,
        &token,
        &format!("{api}/repos/{owner}/{repo}/actions/runs/{run_id}/jobs?per_page=50"),
    )
    .await?;
    let jobs = parse_jobs(&jobs_body);
    let (job, step) = first_failure(&jobs)
        .ok_or_else(|| "beacon: this run has no failed job to remediate".to_string())?;

    // A missing log is a thinner prompt, not a dead button — the run
    // metadata alone is already more than the user had before.
    let log = match gh_get_text(
        &client,
        &token,
        &format!("{api}/repos/{owner}/{repo}/actions/jobs/{}/logs", job.id),
    )
    .await
    {
        Ok(raw) => log_tail(&raw),
        Err(e) => format!("(log unavailable: {e})"),
    };

    Ok(build_failure_prompt(
        &format!("{owner}/{repo}"),
        &run,
        job,
        step,
        &log,
    ))
}

/// owner/repo from a directory's `origin` remote, or None (no/non-GitHub remote).
async fn resolve_owner_repo(dir: &str) -> Option<(String, String)> {
    let out = tokio::process::Command::new("git")
        .args(["-C", dir, "remote", "get-url", "origin"])
        .output()
        .await
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let remote = String::from_utf8_lossy(&out.stdout).trim().to_string();
    parse_owner_repo(&remote)
}

/// Immediate child dirs of `cwd` that are GitHub repos, sorted by name.
/// Only dirs containing a `.git` entry are probed (avoids a git spawn per folder).
async fn scan_subrepos(cwd: &str) -> Vec<SubRepo> {
    let Ok(rd) = std::fs::read_dir(cwd) else {
        return Vec::new();
    };
    let mut dirs: Vec<std::path::PathBuf> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_dir() && p.join(".git").exists())
        .collect();
    dirs.sort();
    let mut out: Vec<SubRepo> = Vec::new();
    for p in dirs.into_iter().take(50) {
        // ponytail: bound scan; project umbrellas rarely hold >50 repos
        let path = p.to_string_lossy().to_string();
        if let Some((owner, repo)) = resolve_owner_repo(&path).await {
            let repo = format!("{owner}/{repo}");
            // Worktrees of one repo share a remote — one pick is enough
            // (Actions state is repo-level, any path works).
            if !out.iter().any(|s| s.repo == repo) {
                out.push(SubRepo { path, repo });
            }
        }
    }
    out
}

/// `cwd` then its ancestors (up to 3 hops, never past `$HOME`), stopping at the
/// first level that holds sub-repos. Covers standing inside a worktree — or any
/// nested folder — of a remote-less umbrella dir whose siblings are the repos.
async fn scan_subrepos_upward(cwd: &str) -> Vec<SubRepo> {
    let home = std::env::var("HOME").unwrap_or_default();
    let mut dir = std::path::PathBuf::from(cwd);
    for _ in 0..4 {
        let found = scan_subrepos(&dir.to_string_lossy()).await;
        if !found.is_empty() {
            return found;
        }
        if dir.as_os_str() == home.as_str() {
            break; // ponytail: $HOME is not an umbrella; every repo you own lives under it
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => break,
        }
    }
    Vec::new()
}

/// Resolve owner/repo from `cwd`'s `origin` remote, load the keychain token,
/// and build the latest-run-per-Actions-workflow state.
pub async fn load_workflow_runs(cwd: String) -> BeaconState {
    // 1. owner/repo from git remote. No GitHub remote here? Fall back to
    //    offering the sub-repos under this folder or an ancestor (umbrella case).
    let (owner, repo) = match resolve_owner_repo(&cwd).await {
        Some(v) => v,
        None => {
            let dirs = scan_subrepos_upward(&cwd).await;
            return if dirs.is_empty() {
                BeaconState::NoRepo
            } else {
                BeaconState::Repos { dirs }
            };
        }
    };

    // 2. token.
    let token = match karl_score::auth::load_token_from_keychain() {
        Ok(Some(t)) => t,
        Ok(None) => return BeaconState::NotAuthed,
        Err(e) => {
            return BeaconState::Error {
                message: format!("keychain: {e}"),
            }
        }
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            return BeaconState::Error {
                message: format!("http client init failed: {e}"),
            }
        }
    };

    let api = "https://api.github.com";

    // 3. list workflows (active ones only). Driving off the workflow list —
    // not a global runs window — guarantees every workflow's latest run shows,
    // even a rarely-triggered one.
    let wf_url = format!("{api}/repos/{owner}/{repo}/actions/workflows?per_page=100");
    let wf = match gh_get(&client, &token, &wf_url).await {
        Ok(v) => v,
        Err(e) => return BeaconState::Error { message: e },
    };
    let workflows: Vec<(u64, String)> = wf
        .get("workflows")
        .and_then(|w| w.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|w| w.get("state").and_then(|s| s.as_str()) == Some("active"))
                .filter_map(|w| {
                    let id = w.get("id")?.as_u64()?;
                    let name = w.get("name")?.as_str().unwrap_or("").to_string();
                    Some((id, name))
                })
                .take(25) // ponytail: bound requests; repos rarely have >25 workflows
                .collect()
        })
        .unwrap_or_default();

    // 4. latest run per workflow — fetched concurrently. Serial `.await` here
    // was the whole latency: ~25 round-trips to api.github.com at ~1.5s each
    // stacked to 30-40s of frozen panel. join_all collapses them to ~one RTT.
    let fetches = workflows.into_iter().map(|(id, name)| {
        let client = &client;
        let token = &token;
        let (owner, repo) = (&owner, &repo);
        async move {
            let runs_url =
                format!("{api}/repos/{owner}/{repo}/actions/workflows/{id}/runs?per_page=1");
            let body = gh_get(client, token, &runs_url).await.ok()?;
            let r = body
                .get("workflow_runs")
                .and_then(|a| a.as_array())
                .and_then(|a| a.first())?; // no runs yet, or fetch failed → skip
            let status = r.get("status").and_then(|x| x.as_str()).unwrap_or("");
            let conclusion = r.get("conclusion").and_then(|x| x.as_str());
            Some(WorkflowRun {
                id: r.get("id").and_then(|x| x.as_u64()).unwrap_or(0),
                name,
                state: run_state(status, conclusion),
                run_number: r.get("run_number").and_then(|x| x.as_u64()).unwrap_or(0),
                branch: r
                    .get("head_branch")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                sha: short_sha(r.get("head_sha").and_then(|x| x.as_str()).unwrap_or("")),
                actor: r
                    .get("actor")
                    .and_then(|a| a.get("login"))
                    .and_then(|l| l.as_str())
                    .map(|s| s.to_string()),
                url: r
                    .get("html_url")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                updated_at: r
                    .get("updated_at")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
        }
    });
    let mut runs: Vec<WorkflowRun> = futures_util::future::join_all(fetches)
        .await
        .into_iter()
        .flatten()
        .collect();

    // Most recently updated first.
    runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    BeaconState::Ok {
        repo: format!("{owner}/{repo}"),
        runs,
    }
}

/// Parse a GitHub `owner/repo` out of a `git remote` URL. Handles
/// `git@github.com:o/r(.git)`, `https://github.com/o/r(.git)`, and
/// `ssh://git@github.com/o/r(.git)`. Returns None for non-GitHub remotes.
pub fn parse_owner_repo(remote_url: &str) -> Option<(String, String)> {
    let s = remote_url.trim();
    // Strip scheme/userinfo down to "github.com<sep>owner/repo".
    let rest = s
        .strip_prefix("git@")
        .or_else(|| s.strip_prefix("ssh://git@"))
        .or_else(|| s.strip_prefix("https://"))
        .or_else(|| s.strip_prefix("http://"))
        .unwrap_or(s);
    let rest = rest.strip_prefix("github.com")?;
    // Separator is ':' (scp form) or '/' (url form).
    let path = rest.strip_prefix(':').or_else(|| rest.strip_prefix('/'))?;
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let mut parts = path.splitn(2, '/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty() && !s.contains('/'))?;
    // Reject segments containing characters outside [A-Za-z0-9._-] and
    // require at least one alphanumeric character (rules out "..", ".", etc.).
    let is_safe = |s: &str| {
        s.chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
            && s.chars().any(|c| c.is_ascii_alphanumeric())
    };
    if !is_safe(owner) || !is_safe(repo) {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A dead port is the offline case: the shaped message must carry the
    /// remedy and never leak reqwest's URL dump into the rail.
    #[tokio::test]
    async fn transport_errors_are_shaped_not_dumped() {
        let client = reqwest::Client::new();
        let e = client.get("http://127.0.0.1:1/x").send().await.unwrap_err();
        let msg = transport_err(&e);
        assert!(msg.starts_with("github: "), "{msg}");
        assert!(msg.contains(" — "), "{msg}");
        assert!(!msg.contains("http://"), "{msg}");
    }

    /// Standing in a nested folder of a remote-less umbrella must still surface
    /// the sibling repos (the worktree-inside-umbrella case).
    #[tokio::test]
    async fn scan_walks_up_to_the_umbrella() {
        let tmp = std::env::temp_dir().join(format!("beacon-scan-{}", std::process::id()));
        let repo = tmp.join("some-repo");
        let deep = tmp.join(".covenant/worktrees/wt");
        std::fs::create_dir_all(&deep).unwrap();
        std::fs::create_dir_all(&repo).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .arg(&repo)
            .status()
            .unwrap()
            .success());
        assert!(std::process::Command::new("git")
            .args(["-C", repo.to_str().unwrap(), "remote", "add", "origin"])
            .arg("https://github.com/acme/some-repo.git")
            .status()
            .unwrap()
            .success());

        let found = scan_subrepos_upward(deep.to_str().unwrap()).await;
        std::fs::remove_dir_all(&tmp).ok();
        assert_eq!(found.len(), 1, "expected the umbrella's sibling repo");
        assert_eq!(found[0].repo, "acme/some-repo");
    }

    /// An umbrella full of worktrees of ONE repo (`.covenant/worktrees/…`) must
    /// collapse into a single pick, not N identical rows.
    #[tokio::test]
    async fn scan_dedupes_same_remote() {
        let tmp = std::env::temp_dir().join(format!("beacon-dedupe-{}", std::process::id()));
        for name in ["wt-a", "wt-b"] {
            let repo = tmp.join(name);
            std::fs::create_dir_all(&repo).unwrap();
            assert!(std::process::Command::new("git")
                .args(["init", "-q"])
                .arg(&repo)
                .status()
                .unwrap()
                .success());
            assert!(std::process::Command::new("git")
                .args(["-C", repo.to_str().unwrap(), "remote", "add", "origin"])
                .arg("https://github.com/acme/one-repo.git")
                .status()
                .unwrap()
                .success());
        }

        let found = scan_subrepos(tmp.to_str().unwrap()).await;
        std::fs::remove_dir_all(&tmp).ok();
        assert_eq!(found.len(), 1, "same remote must appear once");
        assert_eq!(found[0].repo, "acme/one-repo");
    }

    #[test]
    fn status_note_speaks_only_during_an_incident() {
        let green = serde_json::json!({"status":{"indicator":"none","description":"All Systems Operational"}});
        assert_eq!(status_note(&green), None);

        let degraded = serde_json::json!({"status":{"indicator":"minor","description":"Minor Service Outage"}});
        assert_eq!(
            status_note(&degraded),
            Some("GitHub reports: Minor Service Outage".into())
        );

        // Shape drift upstream must not panic — just stay quiet.
        assert_eq!(status_note(&serde_json::json!({})), None);
        assert_eq!(
            status_note(&serde_json::json!({"status":{"indicator":"major"}})),
            None
        );
    }

    #[test]
    fn run_state_collapses_status_and_conclusion() {
        // Completed runs report their conclusion.
        assert_eq!(run_state("completed", Some("success")), "success");
        assert_eq!(run_state("completed", Some("failure")), "failure");
        assert_eq!(run_state("completed", Some("cancelled")), "cancelled");
        // Completed with no conclusion (shouldn't happen) → unknown.
        assert_eq!(run_state("completed", None), "unknown");
        // In-flight runs report their status, ignoring the (null) conclusion.
        assert_eq!(run_state("in_progress", None), "in_progress");
        assert_eq!(run_state("queued", None), "queued");
    }

    #[test]
    fn parses_remote_url_variants() {
        let cases = [
            (
                "git@github.com:karluiz/covenant.git",
                Some(("karluiz", "covenant")),
            ),
            (
                "https://github.com/karluiz/covenant.git",
                Some(("karluiz", "covenant")),
            ),
            (
                "https://github.com/karluiz/covenant",
                Some(("karluiz", "covenant")),
            ),
            (
                "ssh://git@github.com/karluiz/covenant.git",
                Some(("karluiz", "covenant")),
            ),
            ("git@gitlab.com:karluiz/covenant.git", None),
            ("", None),
            // Path traversal must be rejected.
            ("https://github.com/../x", None),
            // Owner with invalid chars must be rejected.
            ("https://github.com/owner@evil/repo", None),
        ];
        for (input, want) in cases {
            let got = parse_owner_repo(input);
            let want = want.map(|(o, r)| (o.to_string(), r.to_string()));
            assert_eq!(got, want, "input={input:?}");
        }
    }

    #[test]
    fn parses_jobs_payload_with_steps() {
        let v: serde_json::Value = serde_json::json!({
            "jobs": [
                {
                    "id": 101,
                    "name": "build-sign-notarize",
                    "status": "in_progress",
                    "conclusion": null,
                    "started_at": "2026-07-12T18:00:00Z",
                    "completed_at": null,
                    "steps": [
                        { "name": "Checkout", "status": "completed", "conclusion": "success",
                          "started_at": "2026-07-12T18:00:01Z", "completed_at": "2026-07-12T18:00:03Z" },
                        { "name": "Notarize", "status": "in_progress", "conclusion": null,
                          "started_at": "2026-07-12T18:03:00Z", "completed_at": null }
                    ]
                },
                {
                    "id": 102,
                    "name": "update-cask",
                    "status": "queued",
                    "conclusion": null,
                    "started_at": null,
                    "completed_at": null
                    // queued jobs omit "steps" entirely
                }
            ]
        });
        let jobs = parse_jobs(&v);
        assert_eq!(jobs.len(), 2);
        assert_eq!(jobs[0].id, 101);
        assert_eq!(jobs[0].state, "in_progress");
        assert_eq!(jobs[0].completed_at, None);
        assert_eq!(jobs[0].steps.len(), 2);
        assert_eq!(jobs[0].steps[0].state, "success");
        assert_eq!(jobs[0].steps[1].state, "in_progress");
        assert_eq!(jobs[0].steps[1].completed_at, None);
        assert_eq!(jobs[1].state, "queued");
        assert!(jobs[1].steps.is_empty());
    }

    /// The whole safety story of the remediate action lives here: nothing
    /// reaches the model with ANSI, timestamps, or a credential in it.
    #[test]
    fn log_tail_is_clean_capped_and_masked() {
        let raw = concat!(
            "2026-07-28T18:00:00.1234567Z \u{1b}[31mError\u{1b}[0m LGHT0103\n",
            "2026-07-28T18:00:01.1234567Z token=ghp_abcdefghijklmnopqrstuvwxyz123456\n",
            "not-a-timestamp stays whole\n",
        );
        let out = log_tail(raw);
        assert!(!out.contains('\u{1b}'), "ANSI survived: {out:?}");
        assert!(!out.contains("2026-07-28T"), "timestamp survived: {out:?}");
        assert!(!out.contains("ghp_abcdef"), "token survived: {out:?}");
        assert!(out.contains("Error LGHT0103"));
        assert!(out.contains("not-a-timestamp stays whole"));

        // Long logs keep the END — the error is at the bottom.
        let long = format!("{}\nTHE ACTUAL ERROR", "x".repeat(LOG_TAIL_BYTES * 2));
        let tail = log_tail(&long);
        assert!(tail.len() <= LOG_TAIL_BYTES);
        assert!(tail.ends_with("THE ACTUAL ERROR"));

        // And only the last N lines, however short they are.
        let many: String = (0..LOG_TAIL_LINES + 50)
            .map(|i| format!("line{i}\n"))
            .collect();
        let tail = log_tail(&many);
        assert!(!tail.contains("line0\n"));
        assert!(tail.ends_with(&format!("line{}", LOG_TAIL_LINES + 49)));
    }

    #[test]
    fn first_failure_lands_on_the_red_job_and_step() {
        let jobs = parse_jobs(&serde_json::json!({ "jobs": [
            { "id": 1, "name": "macOS", "status": "completed", "conclusion": "success", "steps": [] },
            { "id": 2, "name": "build", "status": "completed", "conclusion": "failure", "steps": [
                { "name": "Install Rust", "status": "completed", "conclusion": "success" },
                { "name": "Build Tauri MSI", "status": "completed", "conclusion": "failure" },
                { "name": "Upload MSI", "status": "completed", "conclusion": "skipped" }
            ]},
            { "id": 3, "name": "linux", "status": "completed", "conclusion": "failure", "steps": [] }
        ]}));
        let (job, step) = first_failure(&jobs).expect("a failed job");
        assert_eq!(job.name, "build");
        assert_eq!(step.map(|s| s.name.as_str()), Some("Build Tauri MSI"));

        // An all-green run has nothing to remediate.
        let green = parse_jobs(&serde_json::json!({ "jobs": [
            { "id": 1, "name": "ok", "status": "completed", "conclusion": "success", "steps": [] }
        ]}));
        assert!(first_failure(&green).is_none());

        // A failed job whose steps are all green (startup failure) still counts.
        let odd = parse_jobs(&serde_json::json!({ "jobs": [
            { "id": 1, "name": "boot", "status": "completed", "conclusion": "startup_failure", "steps": [] }
        ]}));
        let (job, step) = first_failure(&odd).expect("a failed job");
        assert_eq!(job.name, "boot");
        assert!(step.is_none());
    }

    #[test]
    fn failure_prompt_carries_what_the_executor_needs() {
        let run = serde_json::json!({
            "name": "Release Windows",
            "run_number": 421,
            "head_branch": "main",
            "head_sha": "0d6b9003abcdef",
            "display_title": "chore(release): v0.9.82",
            "html_url": "https://github.com/karluiz/covenant/actions/runs/421"
        });
        let jobs = parse_jobs(&serde_json::json!({ "jobs": [
            { "id": 9, "name": "build", "status": "completed", "conclusion": "failure", "steps": [
                { "name": "Build Tauri MSI", "status": "completed", "conclusion": "failure" }
            ]}
        ]}));
        let (job, step) = first_failure(&jobs).unwrap();
        let p = build_failure_prompt("karluiz/covenant", &run, job, step, "error LGHT0103");
        for needle in [
            "karluiz/covenant",
            "Release Windows · run #421",
            "build (failure)",
            "Build Tauri MSI (failure)",
            "main @ 0d6b900",
            "actions/runs/421",
            "error LGHT0103",
            "Do not push",
        ] {
            assert!(p.contains(needle), "prompt missing {needle:?}:\n{p}");
        }
    }

    #[test]
    fn parse_jobs_tolerates_garbage() {
        assert!(parse_jobs(&serde_json::json!({})).is_empty());
        assert!(parse_jobs(&serde_json::json!({ "jobs": "nope" })).is_empty());
        // A job missing its id is skipped, not a panic.
        let v = serde_json::json!({ "jobs": [ { "name": "x" } ] });
        assert!(parse_jobs(&v).is_empty());
    }
}
