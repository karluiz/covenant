//! Push-only sync to covenant-server. Reads new local events, sends them
//! in batches, advances the local cursor on success.

use crate::{
    auth,
    profile_card::{build_snapshot, PublicProfileSnapshot},
    EventKind, ScoreStore,
};
use chrono::TimeZone;
use serde::{Deserialize, Serialize};

const BATCH_SIZE: usize = 500;

#[derive(Debug, Serialize)]
struct PushEvent<'a> {
    client_ts_ms: i64,
    kind: &'static str,
    executor: &'a str,
    day: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    repo: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    branch: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    group_name: Option<&'a str>,
}

#[derive(Debug, Deserialize)]
struct PushResp {
    #[allow(dead_code)]
    inserted: u64,
    server_cursor_ms: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum SyncError {
    #[error("not signed in")]
    NotSignedIn,
    #[error("http: {0}")]
    Http(#[from] reqwest::Error),
    #[error("auth: {0}")]
    Auth(#[from] auth::AuthError),
    #[error("score: {0}")]
    Score(#[from] crate::store::ScoreError),
    #[error("server: {0}")]
    Server(String),
}

pub async fn push_once(store: &ScoreStore) -> std::result::Result<u64, SyncError> {
    let jwt = auth::load_jwt()?.ok_or(SyncError::NotSignedIn)?;
    let backend = auth::backend_url();
    let (last_id, server_cursor, _synced_at) = store.get_sync_cursor()?;
    let rows = store.unsynced_events(last_id, BATCH_SIZE)?;
    if rows.is_empty() {
        let now = chrono::Utc::now().timestamp_millis();
        store.set_sync_cursor(last_id, server_cursor, now)?;
        return Ok(0);
    }
    let max_id = rows.iter().map(|(id, ..)| *id).max().unwrap_or(last_id);
    let events: Vec<PushEvent> = rows
        .iter()
        .map(|(_id, ts, kind, exec, repo, branch, group)| {
            let day = chrono::Local
                .timestamp_millis_opt(*ts)
                .unwrap()
                .format("%Y-%m-%d")
                .to_string();
            PushEvent {
                client_ts_ms: *ts,
                kind: match kind {
                    EventKind::Prompt => "prompt",
                    EventKind::Commit => "commit",
                    EventKind::CanonInstall => "canon_install",
                },
                executor: exec.as_str(),
                day,
                repo: repo.as_deref(),
                branch: branch.as_deref(),
                group_name: group.as_deref(),
            }
        })
        .collect();

    let count = events.len() as u64;
    let url = format!("{backend}/sync/events");
    let resp = reqwest::Client::new()
        .post(&url)
        .bearer_auth(&jwt)
        .json(&serde_json::json!({"events": events}))
        .send()
        .await?;
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(SyncError::Server(body));
    }
    let body: PushResp = resp.json().await?;
    let now = chrono::Utc::now().timestamp_millis();
    store.set_sync_cursor(max_id, body.server_cursor_ms, now)?;
    Ok(count)
}

/// Push batches repeatedly until the backlog is drained (the batch comes
/// back smaller than `BATCH_SIZE`). Sleeps `batch_delay` between full
/// batches so a large first-sync backlog doesn't hammer the server.
pub async fn push_drain(
    store: &ScoreStore,
    batch_delay: std::time::Duration,
) -> std::result::Result<u64, SyncError> {
    let mut total = 0u64;
    loop {
        let n = push_once(store).await?;
        total += n;
        if (n as usize) < BATCH_SIZE {
            return Ok(total);
        }
        if !batch_delay.is_zero() {
            tokio::time::sleep(batch_delay).await;
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SyncStatus {
    pub signed_in: bool,
    pub last_synced_at_ms: i64,
    pub last_server_cursor_ms: i64,
    pub pending_events: i64,
}

pub fn status(store: &ScoreStore) -> std::result::Result<SyncStatus, SyncError> {
    let signed_in = auth::load_jwt()?.is_some();
    let (last_pushed_id, last_server_cursor, last_synced_at) = store.get_sync_cursor()?;
    let pending = {
        let c = store.connection();
        let c = c.lock().unwrap();
        c.query_row(
            "SELECT COUNT(*) FROM score_events WHERE id > ?1",
            rusqlite::params![last_pushed_id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(crate::store::ScoreError::from)?
    };
    Ok(SyncStatus {
        signed_in,
        last_synced_at_ms: last_synced_at,
        last_server_cursor_ms: last_server_cursor,
        pending_events: pending,
    })
}

#[derive(Debug, Deserialize)]
struct PublishResp {
    url: String,
    #[allow(dead_code)]
    covenant_score: f64,
}

/// Build the current public snapshot from local data. Returns None if not signed in.
pub fn current_snapshot(
    store: &ScoreStore,
) -> std::result::Result<Option<PublicProfileSnapshot>, SyncError> {
    let user = match crate::session::current(store)? {
        Some(u) => u,
        None => return Ok(None),
    };
    let summary = store.summary()?;
    let ach = store.achievement_summary()?;
    let awards = store.achievement_awards_recent(10_000)?;
    let now = chrono::Utc::now().timestamp_millis();
    Ok(Some(build_snapshot(
        &user,
        &summary,
        &ach.by_category,
        &awards,
        now,
    )))
}

/// PUT the current snapshot to the backend. Returns the public profile URL.
pub async fn publish_profile(store: &ScoreStore) -> std::result::Result<String, SyncError> {
    let jwt = auth::load_jwt()?.ok_or(SyncError::NotSignedIn)?;
    let snap = current_snapshot(store)?.ok_or(SyncError::NotSignedIn)?;
    let backend = auth::backend_url();
    let url = format!("{backend}/profile/publish");
    let resp = reqwest::Client::new()
        .put(&url)
        .bearer_auth(&jwt)
        .json(&snap)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(SyncError::Server(resp.text().await.unwrap_or_default()));
    }
    let body: PublishResp = resp.json().await?;
    Ok(body.url)
}

/// DELETE the published profile (unpublish). Idempotent on the server.
pub async fn unpublish_profile() -> std::result::Result<(), SyncError> {
    let jwt = auth::load_jwt()?.ok_or(SyncError::NotSignedIn)?;
    let backend = auth::backend_url();
    let url = format!("{backend}/profile/publish");
    let resp = reqwest::Client::new()
        .delete(&url)
        .bearer_auth(&jwt)
        .send()
        .await?;
    if !resp.status().is_success() {
        return Err(SyncError::Server(resp.text().await.unwrap_or_default()));
    }
    Ok(())
}
