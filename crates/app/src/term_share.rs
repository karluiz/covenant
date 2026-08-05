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
    pub mode: String,
}

/// One live token per (session, mode) — ro and collab links coexist on one
/// session. `|` cannot appear in a ULID or a mode string, so it's a safe
/// separator.
pub(crate) fn store_key(session_id: &str, mode: &str) -> String {
    format!("{session_id}|{mode}")
}

/// Splits a store key back into (session_id, mode). Stores written before
/// mode existed have bare session-id keys — treat those as `"ro"`.
fn split_key(k: &str) -> (&str, &str) {
    k.split_once('|').unwrap_or((k, "ro"))
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TermShareEntry {
    pub session_id: String,
    pub mode: String,
}

fn list_entries(shares: &HashMap<String, TermShare>) -> Vec<TermShareEntry> {
    shares
        .keys()
        .map(|k| {
            let (sid, mode) = split_key(k);
            TermShareEntry {
                session_id: sid.to_string(),
                mode: mode.to_string(),
            }
        })
        .collect()
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

pub(crate) fn shares_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
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

async fn post_share(session_id: &str, mode: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/term-shares", auth::backend_url());
    let body = serde_json::json!({ "session_id": session_id, "mode": mode });
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

fn validate_mode(mode: &str) -> Result<(), String> {
    match mode {
        "ro" | "collab" => Ok(()),
        other => Err(format!("invalid share mode: {other}")),
    }
}

/// Pure: does the local share store have a live collab share for this
/// session? `rc_grant_driver` calls this before ever installing a guest
/// driver — the relay-compromise defense's desktop-side half. A forged
/// `guest_request_control` frame naming a session nobody actually shared
/// in collab mode must not result in a granted driver, no matter what the
/// relay forwards.
pub(crate) fn grant_allowed(shares: &HashMap<String, TermShare>, session_id: &str) -> bool {
    shares.contains_key(&store_key(session_id, "collab"))
}

#[tauri::command]
pub async fn term_share_get(
    app: tauri::AppHandle,
    session_id: String,
    mode: String,
) -> Result<Option<TermShare>, String> {
    validate_mode(&mode)?;
    Ok(load_shares(&shares_path(&app)?)
        .get(&store_key(&session_id, &mode))
        .cloned())
}

/// All locally-known shared sessions — lets the UI badge tabs
/// without a per-tab round-trip. Migration shim: keys written before mode
/// existed have no `|` and are surfaced as `mode: "ro"`.
#[tauri::command]
pub async fn term_share_list(app: tauri::AppHandle) -> Result<Vec<TermShareEntry>, String> {
    Ok(list_entries(&load_shares(&shares_path(&app)?)))
}

#[tauri::command]
pub async fn term_share_create(
    app: tauri::AppHandle,
    session_id: String,
    mode: String,
) -> Result<TermShare, String> {
    validate_mode(&mode)?;
    let _guard = STORE_LOCK.lock().await;
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    // Always ask the server: it returns the existing live token for a
    // re-share, and a fresh one if the old was revoked out-of-band — the
    // local file is a cache, not the truth.
    let resp = post_share(&session_id, &mode).await?;
    let share_id = resp["id"].as_i64().ok_or("missing id in response")?;
    let token = resp["token"]
        .as_str()
        .ok_or("missing token in response")?
        .to_string();
    let share = TermShare {
        share_id,
        token: token.clone(),
        url: format!("{}/t/{}", auth::backend_url(), token),
        mode: mode.clone(),
    };
    shares.insert(store_key(&session_id, &mode), share.clone());
    save_shares(&file, &shares)?;
    Ok(share)
}

#[tauri::command]
pub async fn term_share_revoke(
    app: tauri::AppHandle,
    session_id: String,
    mode: String,
) -> Result<(), String> {
    validate_mode(&mode)?;
    let _guard = STORE_LOCK.lock().await;
    let file = shares_path(&app)?;
    let mut shares = load_shares(&file);
    let key = store_key(&session_id, &mode);
    let share = shares.get(&key).cloned().ok_or("not shared")?;
    post_revoke(share.share_id).await?;
    shares.remove(&key);
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
            store_key("01SESSION", "ro"),
            TermShare {
                share_id: 7,
                token: "t".into(),
                url: "u".into(),
                mode: "ro".into(),
            },
        );
        save_shares(&p, &m).unwrap();
        assert_eq!(
            load_shares(&p)
                .get(&store_key("01SESSION", "ro"))
                .unwrap()
                .share_id,
            7
        );
    }

    #[test]
    fn store_keeps_ro_and_collab_separately() {
        let dir = std::env::temp_dir().join(format!("cov-tshare2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("term_shares.json");
        let mut m = load_shares(&p);
        m.insert(
            store_key("S1", "ro"),
            TermShare {
                share_id: 1,
                token: "a".into(),
                url: "u1".into(),
                mode: "ro".into(),
            },
        );
        m.insert(
            store_key("S1", "collab"),
            TermShare {
                share_id: 2,
                token: "b".into(),
                url: "u2".into(),
                mode: "collab".into(),
            },
        );
        save_shares(&p, &m).unwrap();
        let back = load_shares(&p);
        assert_eq!(back.get(&store_key("S1", "ro")).unwrap().share_id, 1);
        assert_eq!(back.get(&store_key("S1", "collab")).unwrap().share_id, 2);
    }

    #[test]
    fn grant_allowed_true_when_collab_share_exists() {
        let mut shares = HashMap::new();
        shares.insert(
            store_key("S1", "collab"),
            TermShare {
                share_id: 1,
                token: "t".into(),
                url: "u".into(),
                mode: "collab".into(),
            },
        );
        assert!(grant_allowed(&shares, "S1"));
    }

    #[test]
    fn grant_allowed_false_when_no_share_at_all() {
        let shares: HashMap<String, TermShare> = HashMap::new();
        assert!(!grant_allowed(&shares, "S1"));
    }

    #[test]
    fn grant_allowed_false_when_only_ro_shared() {
        // A ro-shared session must not let a forged grant through — only
        // a collab share counts.
        let mut shares = HashMap::new();
        shares.insert(
            store_key("S1", "ro"),
            TermShare {
                share_id: 1,
                token: "t".into(),
                url: "u".into(),
                mode: "ro".into(),
            },
        );
        assert!(!grant_allowed(&shares, "S1"));
    }

    #[test]
    fn list_entries_migrates_legacy_keys_without_mode() {
        // Old stores wrote bare session-id keys (pre-mode). list must treat
        // those as ro.
        let dir = std::env::temp_dir().join(format!("cov-tshare3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("term_shares.json");
        let mut m: HashMap<String, TermShare> = HashMap::new();
        m.insert(
            "LEGACY_SID".into(),
            TermShare {
                share_id: 9,
                token: "z".into(),
                url: "u".into(),
                mode: "ro".into(),
            },
        );
        save_shares(&p, &m).unwrap();
        let entries = list_entries(&load_shares(&p));
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].session_id, "LEGACY_SID");
        assert_eq!(entries[0].mode, "ro");
    }
}
