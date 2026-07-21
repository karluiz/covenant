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
        .map_err(|e| format!("github request failed: {e}"))?;
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
        .map_err(|e| format!("github request failed: {e}"))?;
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
    let mut out = Vec::new();
    for p in dirs.into_iter().take(50) {
        // ponytail: bound scan; project umbrellas rarely hold >50 repos
        let path = p.to_string_lossy().to_string();
        if let Some((owner, repo)) = resolve_owner_repo(&path).await {
            out.push(SubRepo {
                path,
                repo: format!("{owner}/{repo}"),
            });
        }
    }
    out
}

/// Resolve owner/repo from `cwd`'s `origin` remote, load the keychain token,
/// and build the latest-run-per-Actions-workflow state.
pub async fn load_workflow_runs(cwd: String) -> BeaconState {
    // 1. owner/repo from git remote. No GitHub remote here? Fall back to
    //    offering the sub-repos under this folder (umbrella-dir case).
    let (owner, repo) = match resolve_owner_repo(&cwd).await {
        Some(v) => v,
        None => {
            let dirs = scan_subrepos(&cwd).await;
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

    // 4. latest run per workflow.
    let mut runs = Vec::with_capacity(workflows.len());
    for (id, name) in workflows {
        let runs_url = format!("{api}/repos/{owner}/{repo}/actions/workflows/{id}/runs?per_page=1");
        let body = match gh_get(&client, &token, &runs_url).await {
            Ok(v) => v,
            Err(e) => return BeaconState::Error { message: e },
        };
        let latest = body
            .get("workflow_runs")
            .and_then(|a| a.as_array())
            .and_then(|a| a.first());
        let Some(r) = latest else { continue }; // workflow with no runs yet
        let status = r.get("status").and_then(|x| x.as_str()).unwrap_or("");
        let conclusion = r.get("conclusion").and_then(|x| x.as_str());
        runs.push(WorkflowRun {
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
        });
    }

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

    #[test]
    fn parse_jobs_tolerates_garbage() {
        assert!(parse_jobs(&serde_json::json!({})).is_empty());
        assert!(parse_jobs(&serde_json::json!({ "jobs": "nope" })).is_empty());
        // A job missing its id is skipped, not a panic.
        let v = serde_json::json!({ "jobs": [ { "name": "x" } ] });
        assert!(parse_jobs(&v).is_empty());
    }
}
