//! GitHub OAuth Device Flow. https://docs.github.com/en/apps/oauth-apps/
//! building-oauth-apps/authorizing-oauth-apps#device-flow

use crate::{session, ScoreStore, User};
use serde::{Deserialize, Serialize};

pub const GITHUB_CLIENT_ID: &str = "Ov23liWVUtut6NkCyDAE";
pub const KEYCHAIN_SERVICE: &str = "covenant.uno";
pub const KEYCHAIN_USERNAME: &str = "github-token";
pub const KEYCHAIN_JWT_USERNAME: &str = "covenant-jwt";

pub fn backend_url() -> String {
    std::env::var("COVENANT_BACKEND_URL")
        .unwrap_or_else(|_| "https://forge.covenant.uno".to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExchangeResp {
    pub jwt: String,
    pub login: String,
    pub avatar_url: String,
    pub github_id: i64,
}

pub async fn exchange_with_backend(
    backend_url: &str,
    github_access_token: &str,
) -> Result<ExchangeResp, AuthError> {
    let url = format!("{backend_url}/auth/exchange");
    let resp = reqwest::Client::new()
        .post(&url)
        .header("User-Agent", "covenant-client")
        .json(&serde_json::json!({"github_access_token": github_access_token}))
        .send()
        .await?
        .error_for_status()?;
    Ok(resp.json().await?)
}

pub fn store_jwt(jwt: &str) -> Result<(), AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_JWT_USERNAME)?;
    entry.set_password(jwt)?;
    Ok(())
}

pub fn load_jwt() -> Result<Option<String>, AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_JWT_USERNAME)?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_jwt() -> Result<(), AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_JWT_USERNAME)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u32,
    pub expires_in: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum DeviceTokenResponse {
    Success {
        access_token: String,
        token_type: String,
        scope: String,
    },
    Pending {
        error: String,
        error_description: Option<String>,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("github: {0}")]
    Github(String),
    #[error("keyring: {0}")]
    Keyring(#[from] keyring::Error),
    #[error("score: {0}")]
    Score(#[from] crate::store::ScoreError),
}

pub async fn start_device_flow(base_url: &str) -> Result<DeviceCodeResponse, AuthError> {
    let url = format!("{base_url}/login/device/code");
    let resp = reqwest::Client::new()
        .post(&url)
        .header("Accept", "application/json")
        .form(&[("client_id", GITHUB_CLIENT_ID)])
        .send()
        .await?
        .error_for_status()?;
    let body: DeviceCodeResponse = resp.json().await?;
    Ok(body)
}

pub async fn poll_token(
    base_url: &str,
    device_code: &str,
) -> Result<DeviceTokenResponse, AuthError> {
    let url = format!("{base_url}/login/oauth/access_token");
    let resp = reqwest::Client::new()
        .post(&url)
        .header("Accept", "application/json")
        .form(&[
            ("client_id", GITHUB_CLIENT_ID),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await?
        .error_for_status()?;
    let body: DeviceTokenResponse = resp.json().await?;
    Ok(body)
}

pub async fn fetch_user(api_base: &str, token: &str) -> Result<User, AuthError> {
    let url = format!("{api_base}/user");
    let resp = reqwest::Client::new()
        .get(&url)
        .header("Accept", "application/vnd.github+json")
        .header("User-Agent", "covenant-score")
        .bearer_auth(token)
        .send()
        .await?
        .error_for_status()?;
    let v: serde_json::Value = resp.json().await?;
    Ok(User {
        github_id: v["id"]
            .as_i64()
            .ok_or_else(|| AuthError::Github("missing id".into()))?,
        login: v["login"]
            .as_str()
            .ok_or_else(|| AuthError::Github("missing login".into()))?
            .to_string(),
        avatar_url: v["avatar_url"].as_str().unwrap_or("").to_string(),
        connected_at_ms: chrono::Utc::now().timestamp_millis(),
    })
}

pub fn store_token_in_keychain(token: &str) -> Result<(), AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)?;
    entry.set_password(token)?;
    Ok(())
}

pub fn load_token_from_keychain() -> Result<Option<String>, AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)?;
    match entry.get_password() {
        Ok(t) => Ok(Some(t)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

pub fn delete_token_from_keychain() -> Result<(), AuthError> {
    let entry = keyring::Entry::new(KEYCHAIN_SERVICE, KEYCHAIN_USERNAME)?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// High-level: once the user has a token, fetch their /user record and
/// persist it (Keychain + SQLite). Returns the User.
pub async fn finalize_signin(
    api_base: &str,
    backend_url: &str,
    token: &str,
    store: &ScoreStore,
) -> Result<User, AuthError> {
    let user = fetch_user(api_base, token).await?;
    store_token_in_keychain(token)?;
    session::set_current(store, &user)?;
    match exchange_with_backend(backend_url, token).await {
        Ok(r) => {
            let _ = store_jwt(&r.jwt);
        }
        Err(e) => tracing::warn!(error = %e, "backend exchange failed (will retry on next sync)"),
    }
    Ok(user)
}

pub fn signout(store: &ScoreStore) -> Result<(), AuthError> {
    delete_token_from_keychain()?;
    delete_jwt()?;
    session::clear(store)?;
    Ok(())
}

pub const GITHUB_OAUTH_BASE: &str = "https://github.com";
pub const GITHUB_API_BASE: &str = "https://api.github.com";
