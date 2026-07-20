//! Authed HTTP client for the covenant-server Canon package registry.
// ponytail: wire path stays `/cdlc/packages` — the deployed forge.covenant.uno
// backend still serves that route. Rename to `/canon/` only alongside a server
// deploy that adds the new route (keep the old one until old clients age out).
use karl_score::auth;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Org {
    pub id: i64,
    pub slug: String,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub personal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub login: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PkgMeta {
    pub id: i64,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub publisher_login: String,
    pub installs: i32,
    pub sha: String,
    #[serde(default = "default_kind")]
    pub kind: String,
}

#[allow(dead_code)] // description/sha/publisher_login/kind are part of the server JSON contract
#[derive(Debug, Clone, Deserialize)]
pub struct PkgFull {
    pub id: i64,
    pub name: String,
    pub version: String,
    #[serde(default)]
    pub description: String,
    pub skill_toml: String,
    pub skill_md: String,
    pub sha: String,
    pub publisher_login: String,
    #[serde(default = "default_kind")]
    pub kind: String,
}

fn default_kind() -> String {
    "skill".to_string()
}

fn jwt() -> Result<String, String> {
    auth::load_jwt()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "not signed in to Covenant".to_string())
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Send an authed request via [`auth::send_authed`] (401 → refresh JWT +
/// retry once), then surface HTTP errors as strings.
async fn send_authed(
    build: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    let j = jwt()?;
    auth::send_authed(&j, build)
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())
}

pub async fn list_orgs() -> Result<Vec<Org>, String> {
    let url = format!("{}/orgs", auth::backend_url());
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn create_org(slug: &str, name: &str) -> Result<Value, String> {
    let url = format!("{}/orgs", auth::backend_url());
    let body = serde_json::json!({ "slug": slug, "name": name });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

/// Owner-only display-name edit; the slug never changes.
pub async fn rename_org(org: &str, name: &str) -> Result<(), String> {
    let url = format!("{}/orgs/{}", auth::backend_url(), urlencoding(org));
    let body = serde_json::json!({ "name": name });
    send_authed(|j| client().patch(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

/// Owner-only org deletion, keyed by slug (mirrors `rename_org`).
pub async fn delete_org(org: &str) -> Result<(), String> {
    let url = format!("{}/orgs/{}", auth::backend_url(), urlencoding(org));
    send_authed(|j| client().delete(&url).bearer_auth(j)).await?;
    Ok(())
}

pub async fn list_members(org: &str) -> Result<Vec<Member>, String> {
    let url = format!("{}/orgs/{}/members", auth::backend_url(), urlencoding(org));
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn add_member(org: &str, login: &str) -> Result<(), String> {
    let url = format!("{}/orgs/{}/members", auth::backend_url(), urlencoding(org));
    let body = serde_json::json!({ "login": login });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

pub async fn remove_member(org: &str, login: &str) -> Result<(), String> {
    let url = format!(
        "{}/orgs/{}/members/{}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(login)
    );
    send_authed(|j| client().delete(&url).bearer_auth(j)).await?;
    Ok(())
}

pub async fn search(org: &str, q: Option<&str>, kind: &str) -> Result<Vec<PkgMeta>, String> {
    let mut url = format!(
        "{}/cdlc/packages?org={}&kind={}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(kind)
    );
    if let Some(q) = q.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&q={}", urlencoding(q)));
    }
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn resolve(org: &str, name: &str, version: &str, kind: &str) -> Result<PkgFull, String> {
    let url = format!(
        "{}/cdlc/packages/{}/{}/{}?kind={}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(name),
        urlencoding(version),
        urlencoding(kind)
    );
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)]
pub async fn publish(
    org: &str,
    name: &str,
    version: &str,
    description: &str,
    skill_toml: &str,
    skill_md: &str,
    kind: &str,
) -> Result<Value, String> {
    let url = format!("{}/cdlc/packages", auth::backend_url());
    let body = serde_json::json!({
        "org": org, "name": name, "version": version,
        "description": description, "skill_toml": skill_toml, "skill_md": skill_md,
        "kind": kind,
    });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn record_install(id: i64) -> Result<(), String> {
    let url = format!("{}/cdlc/packages/{}/install", auth::backend_url(), id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

/// Minimal percent-encoding for path/query segments (slug/name/version are
/// already restricted to url-safe chars server-side, but encode defensively).
fn urlencoding(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::urlencoding;

    #[test]
    fn urlencoding_escapes_unsafe() {
        assert_eq!(urlencoding("kyc-peru"), "kyc-peru");
        assert_eq!(urlencoding("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencoding("1.0.0"), "1.0.0");
    }
}
