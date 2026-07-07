//! Somnus — REST client backend.
//!
//! Sends user-composed HTTP requests via reqwest and records every attempt
//! into `somnus_history` (table in storage.rs SCHEMA). One write path:
//! the v2 operator tool will call the same `send_and_record`, so operator
//! requests land in the same history automatically.
//!
//! See `docs/superpowers/specs/2026-07-07-somnus-rest-client-design.md`.

use serde::{Deserialize, Serialize};

/// Display cap — response bodies larger than this are truncated in the
/// returned payload (the UI shows a truncation notice).
const DISPLAY_CAP: usize = 2 * 1024 * 1024; // 2 MB
/// Storage cap — bodies persisted into history are capped harder to keep
/// history.db lean.
pub(crate) const STORE_CAP: usize = 256 * 1024; // 256 KB

/// The verbs the composer offers. Validation whitelist for `send_request`.
pub const METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SomnusRequest {
    pub method: String,
    pub url: String,
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SomnusResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub body_truncated: bool,
    pub body_binary: bool,
    pub duration_ms: u64,
    pub size_bytes: u64,
}

/// Text detection by content-type: text/*, application/json, application/xml,
/// application/x-www-form-urlencoded, and +json/+xml suffixes. Anything else
/// (or no content-type at all) is binary — body neither returned nor stored.
pub fn is_text_content_type(ct: Option<&str>) -> bool {
    let Some(ct) = ct else { return false };
    let mime = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
    mime.starts_with("text/")
        || mime == "application/json"
        || mime == "application/xml"
        || mime == "application/x-www-form-urlencoded"
        || mime.ends_with("+json")
        || mime.ends_with("+xml")
}

/// Send a composed request. 30s timeout, http/https only, default redirects.
pub async fn send_request(req: &SomnusRequest) -> Result<SomnusResponse, String> {
    send_with_cap(req, DISPLAY_CAP).await
}

async fn send_with_cap(req: &SomnusRequest, cap: usize) -> Result<SomnusResponse, String> {
    let method = req.method.trim().to_ascii_uppercase();
    if !METHODS.contains(&method.as_str()) {
        return Err(format!("somnus: unsupported method {method}"));
    }
    let url = reqwest::Url::parse(req.url.trim()).map_err(|e| format!("somnus: invalid URL — {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("somnus: only http/https URLs are supported".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("somnus: http client init failed — {e}"))?;
    let reqwest_method = reqwest::Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("somnus: {e}"))?;
    let mut builder = client.request(reqwest_method, url);
    for (k, v) in &req.headers {
        if k.trim().is_empty() {
            continue; // skip blank composer rows
        }
        builder = builder.header(k.trim(), v.as_str());
    }
    if let Some(body) = &req.body {
        builder = builder.body(body.clone());
    }
    let started = std::time::Instant::now();
    let resp = builder.send().await.map_err(|e| shape_reqwest_err(&e))?;
    let status = resp.status();
    let headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), String::from_utf8_lossy(v.as_bytes()).to_string()))
        .collect();
    let content_type = headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case("content-type"))
        .map(|(_, v)| v.as_str());
    let is_text = is_text_content_type(content_type);
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("somnus: reading body failed — {e}"))?;
    let duration_ms = started.elapsed().as_millis() as u64;
    let size_bytes = bytes.len() as u64;
    let (body, body_truncated, body_binary) = if !is_text {
        (String::new(), false, true)
    } else {
        let truncated = bytes.len() > cap;
        let end = bytes.len().min(cap);
        (String::from_utf8_lossy(&bytes[..end]).to_string(), truncated, false)
    };
    Ok(SomnusResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers,
        body,
        body_truncated,
        body_binary,
        duration_ms,
        size_bytes,
    })
}

/// Shape reqwest failures as "somnus: <cause>" strings the UI splits for
/// its error card (same convention as beacon.rs "github: ..." errors).
fn shape_reqwest_err(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "somnus: request timed out (30s)".into()
    } else if e.is_connect() {
        format!("somnus: connection failed — {e}")
    } else {
        format!("somnus: request failed — {e}")
    }
}

// ── History store ───────────────────────────────────────────────────

use std::sync::Arc;

use rusqlite::{params, Connection};
use thiserror::Error;
use tokio::sync::Mutex;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("blocking task panicked: {0}")]
    Join(String),
}

/// One row of somnus_history, as the UI consumes it.
#[derive(Debug, Clone, Serialize)]
pub struct SomnusHistoryEntry {
    pub id: String,
    pub method: String,
    pub url: String,
    pub req_headers: Vec<(String, String)>,
    pub req_body: Option<String>,
    pub status: Option<u16>,
    pub resp_headers: Vec<(String, String)>,
    pub resp_body: Option<String>,
    pub error: Option<String>,
    pub duration_ms: Option<u64>,
    pub size_bytes: Option<u64>,
    pub created_at_unix_ms: i64,
}

/// Handle to the shared app DB connection (same pattern as project_notes).
#[derive(Clone)]
pub struct Store {
    conn: Arc<Mutex<Connection>>,
}

impl Store {
    pub fn new(conn: Arc<Mutex<Connection>>) -> Self {
        Self { conn }
    }

    fn now_ms() -> i64 {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0)
    }

    /// Persist one attempt (success or network error). Returns the new id.
    pub async fn record(
        &self,
        req: &SomnusRequest,
        result: &Result<SomnusResponse, String>,
    ) -> Result<String, StoreError> {
        let conn = self.conn.clone();
        let id = ulid::Ulid::new().to_string();
        let id_out = id.clone();
        let method = req.method.trim().to_ascii_uppercase();
        let url = req.url.trim().to_string();
        let req_headers = serde_json::to_string(&req.headers)?;
        let req_body = req.body.clone();
        let now = Self::now_ms();
        // Flatten the outcome into columns before entering spawn_blocking.
        let (status, resp_headers, resp_body, error, duration_ms, size_bytes) = match result {
            Ok(r) => {
                let capped: Option<String> = if r.body_binary {
                    None
                } else {
                    let end = r.body.len().min(STORE_CAP);
                    // Slice on a char boundary so the cap can't split UTF-8.
                    let mut end = end;
                    while end > 0 && !r.body.is_char_boundary(end) {
                        end -= 1;
                    }
                    Some(r.body[..end].to_string())
                };
                (
                    Some(r.status as i64),
                    Some(serde_json::to_string(&r.headers)?),
                    capped,
                    None,
                    Some(r.duration_ms as i64),
                    Some(r.size_bytes as i64),
                )
            }
            Err(e) => (None, None, None, Some(e.clone()), None, None),
        };
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO somnus_history
                 (id, method, url, req_headers, req_body, status, resp_headers,
                  resp_body, error, duration_ms, size_bytes, created_at_unix_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    id, method, url, req_headers, req_body, status, resp_headers,
                    resp_body, error, duration_ms, size_bytes, now
                ],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))??;
        Ok(id_out)
    }

    /// Newest first.
    pub async fn list(&self, limit: u32) -> Result<Vec<SomnusHistoryEntry>, StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<SomnusHistoryEntry>, StoreError> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, method, url, req_headers, req_body, status, resp_headers,
                        resp_body, error, duration_ms, size_bytes, created_at_unix_ms
                 FROM somnus_history
                 ORDER BY created_at_unix_ms DESC, rowid DESC
                 LIMIT ?1",
            )?;
            let parse_headers = |raw: Option<String>| -> Vec<(String, String)> {
                raw.and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default()
            };
            let rows = stmt
                .query_map(params![limit], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, Option<String>>(3)?,
                        row.get::<_, Option<String>>(4)?,
                        row.get::<_, Option<i64>>(5)?,
                        row.get::<_, Option<String>>(6)?,
                        row.get::<_, Option<String>>(7)?,
                        row.get::<_, Option<String>>(8)?,
                        row.get::<_, Option<i64>>(9)?,
                        row.get::<_, Option<i64>>(10)?,
                        row.get::<_, i64>(11)?,
                    ))
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows
                .into_iter()
                .map(
                    |(id, method, url, req_h, req_body, status, resp_h, resp_body, error, dur, size, at)| {
                        SomnusHistoryEntry {
                            id,
                            method,
                            url,
                            req_headers: parse_headers(req_h),
                            req_body,
                            status: status.map(|s| s as u16),
                            resp_headers: parse_headers(resp_h),
                            resp_body,
                            error,
                            duration_ms: dur.map(|d| d as u64),
                            size_bytes: size.map(|s| s as u64),
                            created_at_unix_ms: at,
                        }
                    },
                )
                .collect())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM somnus_history WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn clear(&self) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM somnus_history", [])?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }
}

// ── Tauri commands ──────────────────────────────────────────────────

use tauri::State;

/// Send + record in one path. The v1 UI command and the future v2 operator
/// tool both come through here, so every request lands in the same history.
pub async fn send_and_record(store: &Store, req: SomnusRequest) -> Result<SomnusResponse, String> {
    let result = send_request(&req).await;
    if let Err(e) = store.record(&req, &result).await {
        tracing::warn!(error = %e, "somnus history write failed");
    }
    result
}

#[tauri::command]
pub async fn somnus_send(
    store: State<'_, Store>,
    req: SomnusRequest,
) -> Result<SomnusResponse, String> {
    send_and_record(&store, req).await
}

#[tauri::command]
pub async fn somnus_history(
    store: State<'_, Store>,
    limit: Option<u32>,
) -> Result<Vec<SomnusHistoryEntry>, String> {
    store.list(limit.unwrap_or(50)).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_history_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.delete(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_history_clear(store: State<'_, Store>) -> Result<(), String> {
    store.clear().await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, url: String) -> SomnusRequest {
        SomnusRequest { method: method.into(), url, headers: Vec::new(), body: None }
    }

    #[test]
    fn text_content_type_detection() {
        assert!(is_text_content_type(Some("application/json")));
        assert!(is_text_content_type(Some("application/json; charset=utf-8")));
        assert!(is_text_content_type(Some("text/html")));
        assert!(is_text_content_type(Some("application/vnd.github+json")));
        assert!(is_text_content_type(Some("application/xml")));
        assert!(is_text_content_type(Some("application/x-www-form-urlencoded")));
        assert!(!is_text_content_type(Some("application/octet-stream")));
        assert!(!is_text_content_type(Some("image/png")));
        assert!(!is_text_content_type(None));
    }

    #[tokio::test]
    async fn get_roundtrip_status_headers_body() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/ping")
            .with_status(200)
            .with_header("content-type", "application/json")
            .with_header("x-covenant", "1")
            .with_body(r#"{"ok":true}"#)
            .create_async()
            .await;
        let resp = send_request(&req("get", format!("{}/ping", server.url()))).await.unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.status_text, "OK");
        assert_eq!(resp.body, r#"{"ok":true}"#);
        assert!(!resp.body_truncated);
        assert!(!resp.body_binary);
        assert!(resp.headers.iter().any(|(k, v)| k == "x-covenant" && v == "1"));
        assert_eq!(resp.size_bytes, 11);
    }

    #[tokio::test]
    async fn post_sends_body_and_headers() {
        let mut server = mockito::Server::new_async().await;
        let m = server
            .mock("POST", "/things")
            .match_header("x-token", "abc")
            .match_body("hello")
            .with_status(201)
            .with_header("content-type", "text/plain")
            .with_body("created")
            .create_async()
            .await;
        let resp = send_request(&SomnusRequest {
            method: "POST".into(),
            url: format!("{}/things", server.url()),
            headers: vec![("x-token".into(), "abc".into())],
            body: Some("hello".into()),
        })
        .await
        .unwrap();
        assert_eq!(resp.status, 201);
        assert_eq!(resp.body, "created");
        m.assert_async().await;
    }

    #[tokio::test]
    async fn oversized_text_body_truncates() {
        let mut server = mockito::Server::new_async().await;
        let big = "x".repeat(100);
        let _m = server
            .mock("GET", "/big")
            .with_status(200)
            .with_header("content-type", "text/plain")
            .with_body(big)
            .create_async()
            .await;
        let resp = send_with_cap(&req("GET", format!("{}/big", server.url())), 10).await.unwrap();
        assert!(resp.body_truncated);
        assert_eq!(resp.body.len(), 10);
        assert_eq!(resp.size_bytes, 100);
    }

    #[tokio::test]
    async fn binary_body_is_flagged_and_dropped() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/blob")
            .with_status(200)
            .with_header("content-type", "application/octet-stream")
            .with_body(vec![0u8, 159, 146, 150])
            .create_async()
            .await;
        let resp = send_request(&req("GET", format!("{}/blob", server.url()))).await.unwrap();
        assert!(resp.body_binary);
        assert_eq!(resp.body, "");
        assert!(!resp.body_truncated);
        assert_eq!(resp.size_bytes, 4);
    }

    #[tokio::test]
    async fn error_statuses_are_responses_not_errors() {
        let mut server = mockito::Server::new_async().await;
        let _m = server
            .mock("GET", "/nope")
            .with_status(500)
            .with_header("content-type", "text/plain")
            .with_body("boom")
            .create_async()
            .await;
        let resp = send_request(&req("GET", format!("{}/nope", server.url()))).await.unwrap();
        assert_eq!(resp.status, 500);
        assert_eq!(resp.body, "boom");
    }

    #[tokio::test]
    async fn rejects_bad_method_and_scheme() {
        let e = send_request(&req("BREW", "https://example.test".into())).await.unwrap_err();
        assert!(e.contains("unsupported method"), "{e}");
        let e = send_request(&req("GET", "ftp://example.test".into())).await.unwrap_err();
        assert!(e.contains("only http/https"), "{e}");
        let e = send_request(&req("GET", "not a url".into())).await.unwrap_err();
        assert!(e.starts_with("somnus: invalid URL"), "{e}");
    }

    #[tokio::test]
    async fn connection_error_is_shaped() {
        // Port 1 is virtually guaranteed closed.
        let e = send_request(&req("GET", "http://127.0.0.1:1/x".into())).await.unwrap_err();
        assert!(e.starts_with("somnus: "), "{e}");
    }

    fn mem_store() -> Store {
        crate::storage::ensure_sqlite_vec_loaded_for_tests();
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(crate::storage::SCHEMA).unwrap();
        Store::new(Arc::new(Mutex::new(conn)))
    }

    fn ok_resp(body: &str) -> SomnusResponse {
        SomnusResponse {
            status: 200,
            status_text: "OK".into(),
            headers: vec![("content-type".into(), "text/plain".into())],
            body: body.into(),
            body_truncated: false,
            body_binary: false,
            duration_ms: 42,
            size_bytes: body.len() as u64,
        }
    }

    #[tokio::test]
    async fn record_and_list_roundtrip() {
        let store = mem_store();
        let request = SomnusRequest {
            method: "POST".into(),
            url: "https://api.test/things".into(),
            headers: vec![("Authorization".into(), "Bearer x".into())],
            body: Some("{}".into()),
        };
        let id = store.record(&request, &Ok(ok_resp("created"))).await.unwrap();
        assert!(!id.is_empty());
        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id, id);
        assert_eq!(row.method, "POST");
        assert_eq!(row.url, "https://api.test/things");
        assert_eq!(row.req_headers, vec![("Authorization".to_string(), "Bearer x".to_string())]);
        assert_eq!(row.req_body.as_deref(), Some("{}"));
        assert_eq!(row.status, Some(200));
        assert_eq!(row.resp_body.as_deref(), Some("created"));
        assert_eq!(row.error, None);
        assert_eq!(row.duration_ms, Some(42));
    }

    #[tokio::test]
    async fn record_network_error_row() {
        let store = mem_store();
        let request = SomnusRequest {
            method: "GET".into(),
            url: "http://127.0.0.1:1/x".into(),
            headers: Vec::new(),
            body: None,
        };
        store
            .record(&request, &Err("somnus: connection failed — refused".into()))
            .await
            .unwrap();
        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].status, None);
        assert_eq!(rows[0].error.as_deref(), Some("somnus: connection failed — refused"));
        assert!(rows[0].resp_body.is_none());
    }

    #[tokio::test]
    async fn list_is_newest_first_and_limited() {
        let store = mem_store();
        let mk = |url: &str| SomnusRequest {
            method: "GET".into(),
            url: url.into(),
            headers: Vec::new(),
            body: None,
        };
        store.record(&mk("https://a.test"), &Ok(ok_resp("a"))).await.unwrap();
        store.record(&mk("https://b.test"), &Ok(ok_resp("b"))).await.unwrap();
        store.record(&mk("https://c.test"), &Ok(ok_resp("c"))).await.unwrap();
        let rows = store.list(2).await.unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].url, "https://c.test");
        assert_eq!(rows[1].url, "https://b.test");
    }

    #[tokio::test]
    async fn stored_body_is_capped() {
        let store = mem_store();
        let big = "y".repeat(STORE_CAP + 100);
        let request = SomnusRequest {
            method: "GET".into(),
            url: "https://big.test".into(),
            headers: Vec::new(),
            body: None,
        };
        store.record(&request, &Ok(ok_resp(&big))).await.unwrap();
        let rows = store.list(1).await.unwrap();
        assert_eq!(rows[0].resp_body.as_ref().unwrap().len(), STORE_CAP);
    }

    #[tokio::test]
    async fn delete_and_clear() {
        let store = mem_store();
        let request = SomnusRequest {
            method: "GET".into(),
            url: "https://a.test".into(),
            headers: Vec::new(),
            body: None,
        };
        let id = store.record(&request, &Ok(ok_resp("a"))).await.unwrap();
        store.record(&request, &Ok(ok_resp("b"))).await.unwrap();
        store.delete(&id).await.unwrap();
        assert_eq!(store.list(10).await.unwrap().len(), 1);
        store.clear().await.unwrap();
        assert_eq!(store.list(10).await.unwrap().len(), 0);
    }
}
