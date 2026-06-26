//! Beacon: GitHub deployment status for the active session's repo.

use serde::Serialize;

/// One environment's current deployment state, as the UI consumes it.
#[derive(Debug, Clone, Serialize)]
pub struct EnvDeploy {
    pub environment: String,
    /// success | failure | in_progress | pending | error | inactive
    pub state: String,
    pub description: Option<String>,
    pub target_url: Option<String>,
    pub sha: String, // short (7)
    pub creator: Option<String>,
    pub updated_at: String,
}

/// Tagged so the frontend can switch on `kind`.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum BeaconState {
    NotAuthed,
    NoRepo,
    Ok { repo: String, envs: Vec<EnvDeploy> },
    Error { message: String },
}

/// Minimal shape we keep from the deployments list response.
#[derive(Debug, Clone)]
pub struct RawDeployment {
    pub id: u64,
    pub environment: String,
    pub sha: String,
    pub creator: Option<String>,
    pub created_at: String,
}

/// Keep only the newest deployment per environment (by `created_at`,
/// ISO-8601 sorts lexically), capped at 10 environments.
pub fn latest_per_environment(deployments: Vec<RawDeployment>) -> Vec<RawDeployment> {
    use std::collections::HashMap;
    let mut by_env: HashMap<String, RawDeployment> = HashMap::new();
    for d in deployments {
        match by_env.get(&d.environment) {
            Some(existing) if existing.created_at >= d.created_at => {}
            _ => {
                by_env.insert(d.environment.clone(), d);
            }
        }
    }
    let mut kept: Vec<RawDeployment> = by_env.into_values().collect();
    kept.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    kept.truncate(10);
    kept
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

/// Resolve owner/repo from `cwd`'s `origin` remote, load the keychain
/// token, and build the per-environment deployment state.
pub async fn load_deployments(cwd: String) -> BeaconState {
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

    // 3. list deployments.
    let list_url = format!("{api}/repos/{owner}/{repo}/deployments?per_page=30");
    let list = match gh_get(&client, &token, &list_url).await {
        Ok(v) => v,
        Err(e) => return BeaconState::Error { message: e },
    };
    let raw: Vec<RawDeployment> = list
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|d| {
                    Some(RawDeployment {
                        id: d.get("id")?.as_u64()?,
                        environment: d.get("environment")?.as_str().unwrap_or("").to_string(),
                        sha: short_sha(d.get("sha").and_then(|s| s.as_str()).unwrap_or("")),
                        creator: d
                            .get("creator")
                            .and_then(|c| c.get("login"))
                            .and_then(|l| l.as_str())
                            .map(|s| s.to_string()),
                        created_at: d.get("created_at").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let kept = latest_per_environment(raw);

    // 4. latest status per kept deployment.
    let mut envs = Vec::with_capacity(kept.len());
    for d in kept {
        let status_url = format!("{api}/repos/{owner}/{repo}/deployments/{}/statuses?per_page=1", d.id);
        let (state, description, target_url, updated_at) = match gh_get(&client, &token, &status_url).await {
            Ok(v) => {
                let latest = v.as_array().and_then(|a| a.first()).cloned();
                match latest {
                    Some(s) => (
                        s.get("state").and_then(|x| x.as_str()).unwrap_or("pending").to_string(),
                        s.get("description").and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(|x| x.to_string()),
                        s.get("environment_url")
                            .and_then(|x| x.as_str())
                            .or_else(|| s.get("target_url").and_then(|x| x.as_str()))
                            .filter(|x| !x.is_empty())
                            .map(|x| x.to_string()),
                        s.get("created_at").and_then(|x| x.as_str()).unwrap_or(&d.created_at).to_string(),
                    ),
                    None => ("pending".to_string(), None, None, d.created_at.clone()),
                }
            }
            Err(e) => return BeaconState::Error { message: e },
        };
        envs.push(EnvDeploy {
            environment: d.environment,
            state,
            description,
            target_url,
            sha: d.sha,
            creator: d.creator,
            updated_at,
        });
    }

    BeaconState::Ok { repo: format!("{owner}/{repo}"), envs }
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
    fn keeps_only_newest_deployment_per_environment() {
        let raw = vec![
            RawDeployment { id: 1, environment: "production".into(), sha: "aaaaaaa".into(), creator: None, created_at: "2026-06-01T00:00:00Z".into() },
            RawDeployment { id: 2, environment: "production".into(), sha: "bbbbbbb".into(), creator: None, created_at: "2026-06-02T00:00:00Z".into() },
            RawDeployment { id: 3, environment: "preview".into(), sha: "ccccccc".into(), creator: None, created_at: "2026-06-01T00:00:00Z".into() },
        ];
        let kept = latest_per_environment(raw);
        assert_eq!(kept.len(), 2);
        let prod = kept.iter().find(|d| d.environment == "production").unwrap();
        assert_eq!(prod.id, 2, "should keep the newest production deployment");
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
