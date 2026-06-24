//! Authed HTTP client for the covenant-server CDLC package registry.
use karl_score::auth;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Org {
    pub id: i64,
    pub slug: String,
    pub name: String,
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
}

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

pub async fn list_orgs() -> Result<Vec<Org>, String> {
    let j = jwt()?;
    let url = format!("{}/orgs", auth::backend_url());
    client()
        .get(&url)
        .bearer_auth(&j)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn search(org: &str, q: Option<&str>) -> Result<Vec<PkgMeta>, String> {
    let j = jwt()?;
    let mut url = format!("{}/cdlc/packages?org={}", auth::backend_url(), urlencoding(org));
    if let Some(q) = q.filter(|s| !s.is_empty()) {
        url.push_str(&format!("&q={}", urlencoding(q)));
    }
    client()
        .get(&url)
        .bearer_auth(&j)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn resolve(org: &str, name: &str, version: &str) -> Result<PkgFull, String> {
    let j = jwt()?;
    let url = format!(
        "{}/cdlc/packages/{}/{}/{}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(name),
        urlencoding(version)
    );
    client()
        .get(&url)
        .bearer_auth(&j)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
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
) -> Result<Value, String> {
    let j = jwt()?;
    let url = format!("{}/cdlc/packages", auth::backend_url());
    let body = serde_json::json!({
        "org": org, "name": name, "version": version,
        "description": description, "skill_toml": skill_toml, "skill_md": skill_md,
    });
    client()
        .post(&url)
        .bearer_auth(&j)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

pub async fn record_install(id: i64) -> Result<(), String> {
    let j = jwt()?;
    let url = format!("{}/cdlc/packages/{}/install", auth::backend_url(), id);
    client()
        .post(&url)
        .bearer_auth(&j)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
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
