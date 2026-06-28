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

/// Tagged so the frontend can switch on `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BeaconState {
    NotAuthed,
    NoRepo,
    Ok { repo: String, runs: Vec<WorkflowRun> },
    Error { message: String },
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

async fn gh_get(client: &reqwest::Client, token: &str, url: &str) -> Result<serde_json::Value, String> {
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
        return Err(match status {
            401 => "github: token invalid or expired — reconnect GitHub in Settings".into(),
            403 => "github: forbidden — rate-limited or missing repo permission".into(),
            404 => "github: repo not found — private repos need repo scope".into(),
            s => format!("github: HTTP {s}"),
        });
    }
    serde_json::from_str(&text).map_err(|e| format!("github: invalid JSON: {e}"))
}

fn short_sha(sha: &str) -> String {
    sha.chars().take(7).collect()
}

/// Resolve owner/repo from `cwd`'s `origin` remote, load the keychain token,
/// and build the latest-run-per-Actions-workflow state.
pub async fn load_workflow_runs(cwd: String) -> BeaconState {
    // 1. owner/repo from git remote.
    let remote = match tokio::process::Command::new("git")
        .args(["-C", &cwd, "remote", "get-url", "origin"])
        .output()
        .await
    {
        Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout).trim().to_string(),
        _ => return BeaconState::NoRepo,
    };
    let (owner, repo) = match parse_owner_repo(&remote) {
        Some(v) => v,
        None => return BeaconState::NoRepo,
    };

    // 2. token.
    let token = match karl_score::auth::load_token_from_keychain() {
        Ok(Some(t)) => t,
        Ok(None) => return BeaconState::NotAuthed,
        Err(e) => return BeaconState::Error { message: format!("keychain: {e}") },
    };

    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
    {
        Ok(c) => c,
        Err(e) => return BeaconState::Error { message: format!("http client init failed: {e}") },
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
            name,
            state: run_state(status, conclusion),
            run_number: r.get("run_number").and_then(|x| x.as_u64()).unwrap_or(0),
            branch: r.get("head_branch").and_then(|x| x.as_str()).map(|s| s.to_string()),
            sha: short_sha(r.get("head_sha").and_then(|x| x.as_str()).unwrap_or("")),
            actor: r
                .get("actor")
                .and_then(|a| a.get("login"))
                .and_then(|l| l.as_str())
                .map(|s| s.to_string()),
            url: r.get("html_url").and_then(|x| x.as_str()).map(|s| s.to_string()),
            updated_at: r.get("updated_at").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        });
    }

    // Most recently updated first.
    runs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));

    BeaconState::Ok { repo: format!("{owner}/{repo}"), runs }
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
        s.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
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
            ("git@github.com:karluiz/covenant.git", Some(("karluiz", "covenant"))),
            ("https://github.com/karluiz/covenant.git", Some(("karluiz", "covenant"))),
            ("https://github.com/karluiz/covenant", Some(("karluiz", "covenant"))),
            ("ssh://git@github.com/karluiz/covenant.git", Some(("karluiz", "covenant"))),
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
}
