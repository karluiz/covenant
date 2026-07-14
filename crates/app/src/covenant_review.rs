//! Authed HTTP client + local share-state for spec share & review.
use karl_score::auth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareState {
    pub spec_id: i64,
    pub token: String,
    pub url: String,
    pub version: i32,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: i64,
    pub version: i32,
    #[serde(alias = "anchor_heading")]
    pub anchor_heading: Option<String>,
    #[serde(alias = "parent_id")]
    pub parent_id: Option<i64>,
    #[serde(alias = "author_name")]
    pub author_name: String,
    pub body: String,
    pub resolved: bool,
    #[serde(alias = "created_at")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewVerdict {
    pub version: i32,
    #[serde(alias = "author_name")]
    pub author_name: String,
    pub verdict: String,
    pub note: Option<String>,
    #[serde(alias = "created_at")]
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    #[serde(alias = "latest_version")]
    pub latest_version: i32,
    pub comments: Vec<ReviewComment>,
    pub verdicts: Vec<ReviewVerdict>,
}

pub fn load_shares(path: &Path) -> HashMap<String, ShareState> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_shares(path: &Path, m: &HashMap<String, ShareState>) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    std::fs::write(
        &tmp,
        serde_json::to_vec_pretty(m).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn shares_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app.path().app_config_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("spec_shares.json"))
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

async fn post_spec(title: &str, markdown: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/specs", auth::backend_url());
    let body = serde_json::json!({ "title": title, "markdown": markdown });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn post_version(spec_id: i64, markdown: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/specs/{}/versions", auth::backend_url(), spec_id);
    let body = serde_json::json!({ "markdown": markdown });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn post_revoke(spec_id: i64) -> Result<(), String> {
    let url = format!("{}/specs/{}/revoke", auth::backend_url(), spec_id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

async fn get_activity(spec_id: i64) -> Result<Activity, String> {
    let url = format!("{}/specs/{}/activity", auth::backend_url(), spec_id);
    send_authed(|j| client().get(&url).bearer_auth(j))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn post_resolve_comment(spec_id: i64, comment_id: i64) -> Result<(), String> {
    let url = format!(
        "{}/specs/{}/comments/{}/resolve",
        auth::backend_url(),
        spec_id,
        comment_id
    );
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

#[tauri::command]
pub async fn review_get_share(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<ShareState>, String> {
    let shares = load_shares(&shares_path(&app)?);
    Ok(shares.get(&path).cloned())
}

#[tauri::command]
pub async fn review_publish_spec(
    app: tauri::AppHandle,
    path: String,
    title: String,
) -> Result<ShareState, String> {
    let markdown = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let resp = post_spec(&title, &markdown).await?;
    let spec_id = resp["id"].as_i64().ok_or("missing id in response")?;
    let token = resp["token"]
        .as_str()
        .ok_or("missing token in response")?
        .to_string();
    let version = resp["version"]
        .as_i64()
        .ok_or("missing version in response")? as i32;
    let share = ShareState {
        spec_id,
        token: token.clone(),
        url: format!("{}/r/{}", auth::backend_url(), token),
        version,
        title,
    };
    let shares_file = shares_path(&app)?;
    let mut shares = load_shares(&shares_file);
    shares.insert(path, share.clone());
    save_shares(&shares_file, &shares)?;
    Ok(share)
}

#[tauri::command]
pub async fn review_republish_spec(
    app: tauri::AppHandle,
    path: String,
) -> Result<ShareState, String> {
    let shares_file = shares_path(&app)?;
    let mut shares = load_shares(&shares_file);
    let mut share = shares.get(&path).cloned().ok_or("not shared")?;
    let markdown = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let resp = post_version(share.spec_id, &markdown).await?;
    let version = resp["version"]
        .as_i64()
        .ok_or("missing version in response")? as i32;
    share.version = version;
    shares.insert(path, share.clone());
    save_shares(&shares_file, &shares)?;
    Ok(share)
}

#[tauri::command]
pub async fn review_revoke_spec(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let shares_file = shares_path(&app)?;
    let mut shares = load_shares(&shares_file);
    let share = shares.get(&path).cloned().ok_or("not shared")?;
    post_revoke(share.spec_id).await?;
    shares.remove(&path);
    save_shares(&shares_file, &shares)
}

#[tauri::command]
pub async fn review_activity(app: tauri::AppHandle, path: String) -> Result<Activity, String> {
    let shares_file = shares_path(&app)?;
    let shares = load_shares(&shares_file);
    let share = shares.get(&path).cloned().ok_or("not shared")?;
    get_activity(share.spec_id).await
}

#[tauri::command]
pub async fn review_resolve_comment(
    app: tauri::AppHandle,
    path: String,
    comment_id: i64,
) -> Result<(), String> {
    let shares_file = shares_path(&app)?;
    let shares = load_shares(&shares_file);
    let share = shares.get(&path).cloned().ok_or("not shared")?;
    post_resolve_comment(share.spec_id, comment_id).await
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cov-review-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("spec_shares.json");
        let mut m = load_shares(&p);
        assert!(m.is_empty());
        m.insert(
            "/tmp/spec.md".into(),
            ShareState {
                spec_id: 1,
                token: "t".into(),
                url: "u".into(),
                version: 1,
                title: "S".into(),
            },
        );
        save_shares(&p, &m).unwrap();
        let m2 = load_shares(&p);
        assert_eq!(m2.get("/tmp/spec.md").unwrap().version, 1);
    }
}
