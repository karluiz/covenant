//! Authed HTTP client for the covenant-server Canon package registry.
// ponytail: wire path stays `/cdlc/packages` — the deployed forge.covenant.uno
// backend still serves that route. Rename to `/canon/` only alongside a server
// deploy that adds the new route (keep the old one until old clients age out).
use karl_score::auth;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::future::Future;

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
}

#[allow(dead_code)] // description/sha/publisher_login are part of the server JSON contract
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

/// Send an authed request; on 401 mint a fresh JWT via `refresh` and retry
/// once. The backend JWT expires after ~30 days while the stored GitHub token
/// stays valid, so a 401 usually just means the JWT aged out.
async fn send_authed_with<F>(
    build: impl Fn(&str) -> reqwest::RequestBuilder,
    refresh: F,
) -> Result<reqwest::Response, String>
where
    F: Future<Output = Result<String, String>>,
{
    let j = jwt()?;
    let mut resp = build(&j).send().await.map_err(|e| e.to_string())?;
    if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
        let j = refresh.await?;
        resp = build(&j).send().await.map_err(|e| e.to_string())?;
    }
    resp.error_for_status().map_err(|e| e.to_string())
}

async fn send_authed(
    build: impl Fn(&str) -> reqwest::RequestBuilder,
) -> Result<reqwest::Response, String> {
    send_authed_with(build, async {
        auth::refresh_jwt()
            .await
            .map_err(|e| format!("Covenant session expired — sign in again ({e})"))
    })
    .await
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

pub async fn search(org: &str, q: Option<&str>) -> Result<Vec<PkgMeta>, String> {
    let mut url = format!(
        "{}/cdlc/packages?org={}",
        auth::backend_url(),
        urlencoding(org)
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

pub async fn resolve(org: &str, name: &str, version: &str) -> Result<PkgFull, String> {
    let url = format!(
        "{}/cdlc/packages/{}/{}/{}",
        auth::backend_url(),
        urlencoding(org),
        urlencoding(name),
        urlencoding(version)
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
) -> Result<Value, String> {
    let url = format!("{}/cdlc/packages", auth::backend_url());
    let body = serde_json::json!({
        "org": org, "name": name, "version": version,
        "description": description, "skill_toml": skill_toml, "skill_md": skill_md,
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
    use super::{send_authed_with, urlencoding};

    #[test]
    fn urlencoding_escapes_unsafe() {
        assert_eq!(urlencoding("kyc-peru"), "kyc-peru");
        assert_eq!(urlencoding("a b/c"), "a%20b%2Fc");
        assert_eq!(urlencoding("1.0.0"), "1.0.0");
    }

    /// Serves exactly two requests: 401 first, 200 second, recording the
    /// Authorization header of each.
    async fn mock_401_then_200() -> (
        std::net::SocketAddr,
        std::sync::Arc<std::sync::Mutex<Vec<String>>>,
    ) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let auths = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let auths2 = auths.clone();
        tokio::spawn(async move {
            for status in ["401 Unauthorized", "200 OK"] {
                let (mut sock, _) = listener.accept().await.unwrap();
                let mut buf = vec![0u8; 4096];
                let n = sock.read(&mut buf).await.unwrap();
                let req = String::from_utf8_lossy(&buf[..n]).to_string();
                let auth = req
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                    .unwrap_or("")
                    .trim()
                    .to_string();
                auths2.lock().unwrap().push(auth);
                let body = "[]";
                let resp = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                    body.len()
                );
                sock.write_all(resp.as_bytes()).await.unwrap();
            }
        });
        (addr, auths)
    }

    #[tokio::test]
    async fn retries_once_with_refreshed_jwt_on_401() {
        // Debug builds honor COVENANT_DEV_JWT in auth::load_jwt(), which keeps
        // this test off the real macOS Keychain.
        std::env::set_var("COVENANT_DEV_JWT", "stale-jwt");
        let (addr, auths) = mock_401_then_200().await;
        let url = format!("http://{addr}/orgs");
        let resp = send_authed_with(|j| reqwest::Client::new().get(&url).bearer_auth(j), async {
            Ok("fresh-jwt".to_string())
        })
        .await
        .unwrap();
        assert_eq!(resp.status(), 200);
        let auths = auths.lock().unwrap();
        assert_eq!(
            *auths,
            vec![
                "authorization: Bearer stale-jwt",
                "authorization: Bearer fresh-jwt"
            ]
        );
    }
}
