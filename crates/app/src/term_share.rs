//! Authed HTTP client + local share-state for read-only terminal shares.
//! Mirrors `covenant_gist.rs`: same store shape, same send_authed flow.
use karl_score::auth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TermShare {
    pub share_id: i64,
    pub token: String,
    pub url: String,
}

pub fn load_shares(path: &Path) -> HashMap<String, TermShare> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_shares(path: &Path, m: &HashMap<String, TermShare>) -> Result<(), String> {
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
    Ok(dir.join("term_shares.json"))
}

/// Serializes read-modify-write cycles on the share store. The sibling
/// gist store shares this flaw; scoped here to avoid touching it.
static STORE_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

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

async fn post_share(session_id: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/term-shares", auth::backend_url());
    let body = serde_json::json!({ "session_id": session_id });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn post_revoke(id: i64) -> Result<(), String> {
    let url = format!("{}/term-shares/{}/revoke", auth::backend_url(), id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

#[tauri::command]
pub async fn term_share_get(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<Option<TermShare>, String> {
    Ok(load_shares(&shares_path(&app)?).get(&session_id).cloned())
}

/// All locally-known shared sessions — lets the UI badge tabs
/// without a per-tab round-trip.
#[tauri::command]
pub async fn term_share_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(load_shares(&shares_path(&app)?).into_keys().collect())
}

#[tauri::command]
pub async fn term_share_create(
    app: tauri::AppHandle,
    session_id: String,
) -> Result<TermShare, String> {
    let _guard = STORE_LOCK.lock().await;
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    // Always ask the server: it returns the existing live token for a
    // re-share, and a fresh one if the old was revoked out-of-band — the
    // local file is a cache, not the truth.
    let resp = post_share(&session_id).await?;
    let share_id = resp["id"].as_i64().ok_or("missing id in response")?;
    let token = resp["token"]
        .as_str()
        .ok_or("missing token in response")?
        .to_string();
    let share = TermShare {
        share_id,
        token: token.clone(),
        url: format!("{}/t/{}", auth::backend_url(), token),
    };
    shares.insert(session_id, share.clone());
    save_shares(&file, &shares)?;
    Ok(share)
}

#[tauri::command]
pub async fn term_share_revoke(app: tauri::AppHandle, session_id: String) -> Result<(), String> {
    let _guard = STORE_LOCK.lock().await;
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    let share = shares.get(&session_id).cloned().ok_or("not shared")?;
    post_revoke(share.share_id).await?;
    shares.remove(&session_id);
    save_shares(&file, &shares)
}

/// Sessions never survive an app restart, so every share on disk is stale
/// at boot — revoke them all (covers quit AND crash) and clear the file.
/// Fire-and-forget: failures leave links pointing at an offline desktop,
/// which the viewer surfaces as "Desktop offline".
pub fn spawn_startup_revoke(app: &tauri::AppHandle) {
    let Ok(file) = shares_path(app) else { return };
    tauri::async_runtime::spawn(async move {
        let _guard = STORE_LOCK.lock().await;
        let shares = load_shares(&file);
        if shares.is_empty() {
            return;
        }
        for share in shares.values() {
            let _ = post_revoke(share.share_id).await;
        }
        let _ = save_shares(&file, &HashMap::new());
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cov-tshare-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("term_shares.json");
        let mut m = load_shares(&p);
        assert!(m.is_empty());
        m.insert(
            "01SESSION".into(),
            TermShare {
                share_id: 7,
                token: "t".into(),
                url: "u".into(),
            },
        );
        save_shares(&p, &m).unwrap();
        assert_eq!(load_shares(&p).get("01SESSION").unwrap().share_id, 7);
    }
}
