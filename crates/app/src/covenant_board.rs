//! Authed HTTP client + local share-state for read-only Tasker board shares.
use karl_score::auth;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BoardShare {
    pub board_id: i64,
    pub token: String,
    pub url: String,
}

pub fn load_shares(path: &Path) -> HashMap<String, BoardShare> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn save_shares(path: &Path, m: &HashMap<String, BoardShare>) -> Result<(), String> {
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
    Ok(dir.join("board_shares.json"))
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

async fn post_board(title: &str, payload: &serde_json::Value) -> Result<serde_json::Value, String> {
    let url = format!("{}/boards", auth::backend_url());
    let body = serde_json::json!({ "title": title, "payload": payload });
    send_authed(|j| client().post(&url).bearer_auth(j).json(&body))
        .await?
        .json()
        .await
        .map_err(|e| e.to_string())
}

async fn put_board(id: i64, title: &str, payload: &serde_json::Value) -> Result<(), String> {
    let url = format!("{}/boards/{}", auth::backend_url(), id);
    let body = serde_json::json!({ "title": title, "payload": payload });
    send_authed(|j| client().put(&url).bearer_auth(j).json(&body)).await?;
    Ok(())
}

async fn post_revoke(id: i64) -> Result<(), String> {
    let url = format!("{}/boards/{}/revoke", auth::backend_url(), id);
    send_authed(|j| client().post(&url).bearer_auth(j)).await?;
    Ok(())
}

#[tauri::command]
pub async fn board_get_share(
    app: tauri::AppHandle,
    project_id: String,
) -> Result<Option<BoardShare>, String> {
    Ok(load_shares(&shares_path(&app)?).get(&project_id).cloned())
}

/// All locally-known shared project ids — lets the UI badge rows without a
/// per-project round-trip.
#[tauri::command]
pub async fn board_list_shares(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    Ok(load_shares(&shares_path(&app)?).into_keys().collect())
}

#[tauri::command]
pub async fn board_publish(
    app: tauri::AppHandle,
    project_id: String,
    title: String,
    payload: serde_json::Value,
) -> Result<BoardShare, String> {
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    // Re-publish in place → the link the boss already has keeps working.
    if let Some(existing) = shares.get(&project_id).cloned() {
        put_board(existing.board_id, &title, &payload).await?;
        return Ok(existing);
    }
    let resp = post_board(&title, &payload).await?;
    let board_id = resp["id"].as_i64().ok_or("missing id in response")?;
    let token = resp["token"]
        .as_str()
        .ok_or("missing token in response")?
        .to_string();
    let share = BoardShare {
        board_id,
        token: token.clone(),
        url: format!("{}/b/{}", auth::backend_url(), token),
    };
    shares.insert(project_id, share.clone());
    if let Err(save_err) = save_shares(&file, &shares) {
        // The board now lives on the forge with a working public URL, but we
        // failed to record it locally — board_get_share/board_list_shares/
        // board_revoke all read from that local file, so without this the
        // board would be unrevokable and unlisted forever (a privacy leak
        // with no path back). Best-effort take it back down before erroring.
        return match post_revoke(share.board_id).await {
            Ok(()) => Err(format!(
                "failed to save share record ({save_err}); board was revoked"
            )),
            // Deliberate exception to "never surface share.url in an error":
            // the revoke ALSO failed here, so the board is now orphaned —
            // live on the forge with no local record and no automated way to
            // take it back down. The URL (with its token, the board's only
            // access control) is the one thing that lets the user revoke it
            // by hand, so it must reach them. No other error path in this
            // file embeds the URL — the frontend (share.ts's push()) mirrors
            // this by logging the project id on failure, never the raw
            // error, precisely so this token doesn't end up in a console.
            Err(revoke_err) => Err(format!(
                "failed to save share record ({save_err}); \
                 also failed to revoke the now-orphaned board ({revoke_err}); \
                 it is still live at {} — revoke it manually",
                share.url
            )),
        };
    }
    Ok(share)
}

#[tauri::command]
pub async fn board_revoke(app: tauri::AppHandle, project_id: String) -> Result<(), String> {
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    let share = shares.get(&project_id).cloned().ok_or("not shared")?;
    post_revoke(share.board_id).await?;
    shares.remove(&project_id);
    save_shares(&file, &shares)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn share_store_roundtrip() {
        let dir = std::env::temp_dir().join(format!("cov-board-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("board_shares.json");
        let mut m = load_shares(&p);
        assert!(m.is_empty());
        m.insert(
            "proj-1".into(),
            BoardShare {
                board_id: 7,
                token: "t".into(),
                url: "u".into(),
            },
        );
        save_shares(&p, &m).unwrap();
        assert_eq!(load_shares(&p).get("proj-1").unwrap().board_id, 7);
    }
}
