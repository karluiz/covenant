//! Authed HTTP client + local share-state for view-only file gists.
use karl_score::auth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GistShare {
    pub gist_id: i64,
    pub token: String,
    pub url: String,
}

/// Lowercased final path extension, or "txt" when there is none.
fn language_of(path: &str) -> String {
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_else(|| "txt".to_string())
}

fn filename_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(path)
        .to_string()
}

pub fn load_shares(path: &Path) -> HashMap<String, GistShare> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_shares(path: &Path, m: &HashMap<String, GistShare>) -> Result<(), String> {
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
    Ok(dir.join("gist_shares.json"))
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

async fn post_gist(
    filename: &str,
    language: &str,
    content: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/gists", auth::backend_url());
    let body =
        serde_json::json!({ "filename": filename, "language": language, "content": content });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn put_gist(id: i64, filename: &str, language: &str, content: &str) -> Result<(), String> {
    let url = format!("{}/gists/{}", auth::backend_url(), id);
    let body =
        serde_json::json!({ "filename": filename, "language": language, "content": content });
    send_authed(|j| client().put(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

async fn post_revoke(id: i64) -> Result<(), String> {
    let url = format!("{}/gists/{}/revoke", auth::backend_url(), id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

#[tauri::command]
pub async fn gist_get_share(
    app: tauri::AppHandle,
    path: String,
) -> Result<Option<GistShare>, String> {
    Ok(load_shares(&shares_path(&app)?).get(&path).cloned())
}

#[tauri::command]
pub async fn gist_publish(app: tauri::AppHandle, path: String) -> Result<GistShare, String> {
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let filename = filename_of(&path);
    let language = language_of(&path);
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    // Re-share the same file in place → keep the link.
    if let Some(existing) = shares.get(&path).cloned() {
        put_gist(existing.gist_id, &filename, &language, &content).await?;
        return Ok(existing);
    }
    let resp = post_gist(&filename, &language, &content).await?;
    let gist_id = resp["id"].as_i64().ok_or("missing id in response")?;
    let token = resp["token"]
        .as_str()
        .ok_or("missing token in response")?
        .to_string();
    let share = GistShare {
        gist_id,
        token: token.clone(),
        url: format!("{}/g/{}", auth::backend_url(), token),
    };
    shares.insert(path, share.clone());
    save_shares(&file, &shares)?;
    Ok(share)
}

#[tauri::command]
pub async fn gist_revoke(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    let share = shares.get(&path).cloned().ok_or("not shared")?;
    post_revoke(share.gist_id).await?;
    shares.remove(&path);
    save_shares(&file, &shares)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn language_from_path() {
        assert_eq!(language_of("/a/b/main.rs"), "rs");
        assert_eq!(language_of("/a/b/README.md"), "md");
        assert_eq!(language_of("/a/b/Makefile"), "txt"); // no extension → txt
        assert_eq!(language_of("/a/b/archive.tar.gz"), "gz");
    }
    #[test]
    fn share_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cov-gist-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("gist_shares.json");
        let mut m = load_shares(&p);
        assert!(m.is_empty());
        m.insert(
            "/tmp/f.rs".into(),
            GistShare {
                gist_id: 7,
                token: "t".into(),
                url: "u".into(),
            },
        );
        save_shares(&p, &m).unwrap();
        assert_eq!(load_shares(&p).get("/tmp/f.rs").unwrap().gist_id, 7);
    }
}
