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
pub(crate) const STORE_CAP: usize = 2 * 1024 * 1024; // 2 MB — matches DISPLAY_CAP so history replay can re-render the JSON tree

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
    let mime = ct
        .split(';')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
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
    let url =
        reqwest::Url::parse(req.url.trim()).map_err(|e| format!("somnus: invalid URL — {e}"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        return Err("somnus: only http/https URLs are supported".into());
    }
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("somnus: http client init failed — {e}"))?;
    let reqwest_method =
        reqwest::Method::from_bytes(method.as_bytes()).map_err(|e| format!("somnus: {e}"))?;
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
        .map(|(k, v)| {
            (
                k.to_string(),
                String::from_utf8_lossy(v.as_bytes()).to_string(),
            )
        })
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
        (
            String::from_utf8_lossy(&bytes[..end]).to_string(),
            truncated,
            false,
        )
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
    #[error("somnus: {0}")]
    Invalid(String),
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
                    id,
                    method,
                    url,
                    req_headers,
                    req_body,
                    status,
                    resp_headers,
                    resp_body,
                    error,
                    duration_ms,
                    size_bytes,
                    now
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
                raw.and_then(|s| serde_json::from_str(&s).ok())
                    .unwrap_or_default()
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
                    |(
                        id,
                        method,
                        url,
                        req_h,
                        req_body,
                        status,
                        resp_h,
                        resp_body,
                        error,
                        dur,
                        size,
                        at,
                    )| {
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

// ── Collections tree + environments (v2) ────────────────────────────
//
// `request` (tree) and `vars` (environments) are opaque JSON strings —
// the frontend owns their shape (SomnusDraft / SomnusEnvVar[] in api.ts).
// Rust stores and returns them verbatim.

pub const TREE_KINDS: [&str; 3] = ["collection", "folder", "request"];

#[derive(Debug, Clone, Serialize)]
pub struct SomnusTreeNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub kind: String,
    pub name: String,
    pub sort: i64,
    pub request: Option<String>,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SomnusImportNode {
    pub kind: String,
    pub name: String,
    pub request: Option<String>,
    #[serde(default)]
    pub children: Vec<SomnusImportNode>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SomnusEnvironment {
    pub id: String,
    pub name: String,
    pub vars: String,
    pub is_active: bool,
}

impl Store {
    pub async fn tree_list(&self) -> Result<Vec<SomnusTreeNode>, StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<SomnusTreeNode>, StoreError> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, parent_id, kind, name, sort, request, updated_at
                 FROM somnus_tree ORDER BY sort ASC, rowid ASC",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(SomnusTreeNode {
                        id: row.get(0)?,
                        parent_id: row.get(1)?,
                        kind: row.get(2)?,
                        name: row.get(3)?,
                        sort: row.get(4)?,
                        request: row.get(5)?,
                        updated_at: row.get(6)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn tree_create(
        &self,
        parent_id: Option<String>,
        kind: String,
        name: String,
        request: Option<String>,
    ) -> Result<String, StoreError> {
        if !TREE_KINDS.contains(&kind.as_str()) {
            return Err(StoreError::Invalid(format!("bad tree kind {kind}")));
        }
        let conn = self.conn.clone();
        let id = ulid::Ulid::new().to_string();
        let id_out = id.clone();
        let now = Self::now_ms();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO somnus_tree (id, parent_id, kind, name, sort, request, updated_at)
                 VALUES (?1, ?2, ?3, ?4,
                   1 + COALESCE((SELECT MAX(sort) FROM somnus_tree WHERE parent_id IS ?2), 0),
                   ?5, ?6)",
                params![id, parent_id, kind, name, request, now],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))??;
        Ok(id_out)
    }

    /// Partial update: `None` fields keep their stored value.
    pub async fn tree_update(
        &self,
        id: &str,
        name: Option<String>,
        request: Option<String>,
    ) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        let now = Self::now_ms();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            let rows = c.execute(
                "UPDATE somnus_tree
                 SET name = COALESCE(?2, name), request = COALESCE(?3, request), updated_at = ?4
                 WHERE id = ?1",
                params![id, name, request, now],
            )?;
            if rows == 0 {
                return Err(StoreError::Invalid(format!("no tree node {id}")));
            }
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    /// Recursive delete: the node and all descendants, one statement.
    pub async fn tree_delete(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "DELETE FROM somnus_tree WHERE id IN (
                   WITH RECURSIVE d(id) AS (
                     SELECT ?1
                     UNION ALL
                     SELECT t.id FROM somnus_tree t JOIN d ON t.parent_id = d.id
                   ) SELECT id FROM d)",
                params![id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    /// Deep copy of a subtree next to the original; root gets " copy".
    pub async fn tree_duplicate(&self, id: &str) -> Result<String, StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        let now = Self::now_ms();
        tokio::task::spawn_blocking(move || -> Result<String, StoreError> {
            let mut c = conn.blocking_lock();
            let tx = c.transaction()?;
            // BFS order guarantees parents precede children.
            let rows: Vec<(String, Option<String>, String, String, Option<String>)> = {
                let mut stmt = tx.prepare(
                    "WITH RECURSIVE d(id) AS (
                       SELECT ?1
                       UNION ALL
                       SELECT t.id FROM somnus_tree t JOIN d ON t.parent_id = d.id
                     )
                     SELECT s.id, s.parent_id, s.kind, s.name, s.request
                     FROM somnus_tree s JOIN d ON s.id = d.id",
                )?;
                let mapped = stmt.query_map(params![id], |r| {
                    Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))
                })?;
                mapped.collect::<Result<Vec<_>, _>>()?
            };
            if rows.is_empty() {
                return Err(StoreError::Invalid(format!("no tree node {id}")));
            }
            let mut remap: std::collections::HashMap<String, String> =
                std::collections::HashMap::new();
            for (old_id, _, _, _, _) in &rows {
                remap.insert(old_id.clone(), ulid::Ulid::new().to_string());
            }
            let mut new_root = String::new();
            for (old_id, parent, kind, name, request) in &rows {
                let is_root = *old_id == id;
                let new_id = remap[old_id].clone();
                if is_root {
                    new_root = new_id.clone();
                }
                // Root keeps its original parent; descendants remap to their copied parent.
                let new_parent = if is_root {
                    parent.clone()
                } else {
                    parent
                        .as_ref()
                        .map(|p| remap.get(p).cloned().unwrap_or_else(|| p.clone()))
                };
                let new_name = if is_root {
                    format!("{name} copy")
                } else {
                    name.clone()
                };
                tx.execute(
                    "INSERT INTO somnus_tree (id, parent_id, kind, name, sort, request, updated_at)
                     VALUES (?1, ?2, ?3, ?4,
                       1 + COALESCE((SELECT MAX(sort) FROM somnus_tree WHERE parent_id IS ?2), 0),
                       ?5, ?6)",
                    params![new_id, new_parent, kind, new_name, request, now],
                )?;
            }
            tx.commit()?;
            Ok(new_root)
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    /// Import a whole collection atomically. Creates the root collection
    /// named `name`, inserts `nodes` beneath it, returns the request count.
    pub async fn tree_import(
        &self,
        name: String,
        nodes: Vec<SomnusImportNode>,
    ) -> Result<u32, StoreError> {
        for n in &nodes {
            validate_import_kinds(n)?;
        }
        let conn = self.conn.clone();
        let now = Self::now_ms();
        tokio::task::spawn_blocking(move || -> Result<u32, StoreError> {
            let mut c = conn.blocking_lock();
            let tx = c.transaction()?;
            let root = ulid::Ulid::new().to_string();
            tx.execute(
                "INSERT INTO somnus_tree (id, parent_id, kind, name, sort, request, updated_at)
                 VALUES (?1, NULL, 'collection', ?2,
                   1 + COALESCE((SELECT MAX(sort) FROM somnus_tree WHERE parent_id IS NULL), 0),
                   NULL, ?3)",
                params![root, name, now],
            )?;
            fn insert_nodes(
                tx: &rusqlite::Transaction<'_>,
                parent: &str,
                nodes: &[SomnusImportNode],
                now: i64,
                count: &mut u32,
            ) -> Result<(), rusqlite::Error> {
                for (i, n) in nodes.iter().enumerate() {
                    let id = ulid::Ulid::new().to_string();
                    tx.execute(
                        "INSERT INTO somnus_tree (id, parent_id, kind, name, sort, request, updated_at)
                         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                        params![id, parent, n.kind, n.name, (i + 1) as i64, n.request, now],
                    )?;
                    if n.kind == "request" {
                        *count += 1;
                    }
                    insert_nodes(tx, &id, &n.children, now, count)?;
                }
                Ok(())
            }
            let mut count = 0u32;
            insert_nodes(&tx, &root, &nodes, now, &mut count)?;
            tx.commit()?;
            Ok(count)
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn env_list(&self) -> Result<Vec<SomnusEnvironment>, StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<Vec<SomnusEnvironment>, StoreError> {
            let c = conn.blocking_lock();
            let mut stmt = c.prepare(
                "SELECT id, name, vars, is_active FROM somnus_environments ORDER BY rowid ASC",
            )?;
            let rows = stmt
                .query_map([], |row| {
                    Ok(SomnusEnvironment {
                        id: row.get(0)?,
                        name: row.get(1)?,
                        vars: row.get(2)?,
                        is_active: row.get::<_, i64>(3)? != 0,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()?;
            Ok(rows)
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn env_create(&self, name: String) -> Result<String, StoreError> {
        let conn = self.conn.clone();
        let id = ulid::Ulid::new().to_string();
        let id_out = id.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "INSERT INTO somnus_environments (id, name, vars, is_active) VALUES (?1, ?2, '[]', 0)",
                params![id, name],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))??;
        Ok(id_out)
    }

    pub async fn env_update(&self, id: &str, name: String, vars: String) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE somnus_environments SET name = ?2, vars = ?3 WHERE id = ?1",
                params![id, name, vars],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    pub async fn env_delete(&self, id: &str) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        let id = id.to_owned();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute("DELETE FROM somnus_environments WHERE id = ?1", params![id])?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }

    /// At most one active environment; `None` deactivates all.
    pub async fn env_activate(&self, id: Option<String>) -> Result<(), StoreError> {
        let conn = self.conn.clone();
        tokio::task::spawn_blocking(move || -> Result<(), StoreError> {
            let c = conn.blocking_lock();
            c.execute(
                "UPDATE somnus_environments
                 SET is_active = CASE WHEN id = ?1 THEN 1 ELSE 0 END",
                params![id],
            )?;
            Ok(())
        })
        .await
        .map_err(|e| StoreError::Join(e.to_string()))?
    }
}

fn validate_import_kinds(n: &SomnusImportNode) -> Result<(), StoreError> {
    if n.kind != "folder" && n.kind != "request" {
        return Err(StoreError::Invalid(format!("bad import kind {}", n.kind)));
    }
    for c in &n.children {
        validate_import_kinds(c)?;
    }
    Ok(())
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
    store
        .list(limit.unwrap_or(50))
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_history_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.delete(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_history_clear(store: State<'_, Store>) -> Result<(), String> {
    store.clear().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_list(store: State<'_, Store>) -> Result<Vec<SomnusTreeNode>, String> {
    store.tree_list().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_create(
    store: State<'_, Store>,
    parent_id: Option<String>,
    kind: String,
    name: String,
    request: Option<String>,
) -> Result<String, String> {
    store
        .tree_create(parent_id, kind, name, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_update(
    store: State<'_, Store>,
    id: String,
    name: Option<String>,
    request: Option<String>,
) -> Result<(), String> {
    store
        .tree_update(&id, name, request)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.tree_delete(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_duplicate(store: State<'_, Store>, id: String) -> Result<String, String> {
    store.tree_duplicate(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_tree_import(
    store: State<'_, Store>,
    name: String,
    nodes: Vec<SomnusImportNode>,
) -> Result<u32, String> {
    store
        .tree_import(name, nodes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_list(store: State<'_, Store>) -> Result<Vec<SomnusEnvironment>, String> {
    store.env_list().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_create(store: State<'_, Store>, name: String) -> Result<String, String> {
    store.env_create(name).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_update(
    store: State<'_, Store>,
    id: String,
    name: String,
    vars: String,
) -> Result<(), String> {
    store
        .env_update(&id, name, vars)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_delete(store: State<'_, Store>, id: String) -> Result<(), String> {
    store.env_delete(&id).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn somnus_env_activate(
    store: State<'_, Store>,
    id: Option<String>,
) -> Result<(), String> {
    store.env_activate(id).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn req(method: &str, url: String) -> SomnusRequest {
        SomnusRequest {
            method: method.into(),
            url,
            headers: Vec::new(),
            body: None,
        }
    }

    #[test]
    fn text_content_type_detection() {
        assert!(is_text_content_type(Some("application/json")));
        assert!(is_text_content_type(Some(
            "application/json; charset=utf-8"
        )));
        assert!(is_text_content_type(Some("text/html")));
        assert!(is_text_content_type(Some("application/vnd.github+json")));
        assert!(is_text_content_type(Some("application/xml")));
        assert!(is_text_content_type(Some(
            "application/x-www-form-urlencoded"
        )));
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
        let resp = send_request(&req("get", format!("{}/ping", server.url())))
            .await
            .unwrap();
        assert_eq!(resp.status, 200);
        assert_eq!(resp.status_text, "OK");
        assert_eq!(resp.body, r#"{"ok":true}"#);
        assert!(!resp.body_truncated);
        assert!(!resp.body_binary);
        assert!(resp
            .headers
            .iter()
            .any(|(k, v)| k == "x-covenant" && v == "1"));
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
        let resp = send_with_cap(&req("GET", format!("{}/big", server.url())), 10)
            .await
            .unwrap();
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
        let resp = send_request(&req("GET", format!("{}/blob", server.url())))
            .await
            .unwrap();
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
        let resp = send_request(&req("GET", format!("{}/nope", server.url())))
            .await
            .unwrap();
        assert_eq!(resp.status, 500);
        assert_eq!(resp.body, "boom");
    }

    #[tokio::test]
    async fn rejects_bad_method_and_scheme() {
        let e = send_request(&req("BREW", "https://example.test".into()))
            .await
            .unwrap_err();
        assert!(e.contains("unsupported method"), "{e}");
        let e = send_request(&req("GET", "ftp://example.test".into()))
            .await
            .unwrap_err();
        assert!(e.contains("only http/https"), "{e}");
        let e = send_request(&req("GET", "not a url".into()))
            .await
            .unwrap_err();
        assert!(e.starts_with("somnus: invalid URL"), "{e}");
    }

    #[tokio::test]
    async fn connection_error_is_shaped() {
        // Port 1 is virtually guaranteed closed.
        let e = send_request(&req("GET", "http://127.0.0.1:1/x".into()))
            .await
            .unwrap_err();
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
        let id = store
            .record(&request, &Ok(ok_resp("created")))
            .await
            .unwrap();
        assert!(!id.is_empty());
        let rows = store.list(10).await.unwrap();
        assert_eq!(rows.len(), 1);
        let row = &rows[0];
        assert_eq!(row.id, id);
        assert_eq!(row.method, "POST");
        assert_eq!(row.url, "https://api.test/things");
        assert_eq!(
            row.req_headers,
            vec![("Authorization".to_string(), "Bearer x".to_string())]
        );
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
        assert_eq!(
            rows[0].error.as_deref(),
            Some("somnus: connection failed — refused")
        );
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
        store
            .record(&mk("https://a.test"), &Ok(ok_resp("a")))
            .await
            .unwrap();
        store
            .record(&mk("https://b.test"), &Ok(ok_resp("b")))
            .await
            .unwrap();
        store
            .record(&mk("https://c.test"), &Ok(ok_resp("c")))
            .await
            .unwrap();
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

    // ── v2: collections tree ──

    async fn mk_collection(store: &Store, name: &str) -> String {
        store
            .tree_create(None, "collection".into(), name.into(), None)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn tree_create_and_list_roundtrip() {
        let store = mem_store();
        let col = mk_collection(&store, "My API").await;
        let folder = store
            .tree_create(Some(col.clone()), "folder".into(), "Auth".into(), None)
            .await
            .unwrap();
        let req_json = r#"{"method":"GET","url":"https://{{base_url}}/users","headers":[],"body":"","body_mode":"none","auth":{"type":"none"}}"#;
        let req_id = store
            .tree_create(
                Some(folder.clone()),
                "request".into(),
                "List users".into(),
                Some(req_json.into()),
            )
            .await
            .unwrap();
        let rows = store.tree_list().await.unwrap();
        assert_eq!(rows.len(), 3);
        let req_row = rows.iter().find(|r| r.id == req_id).unwrap();
        assert_eq!(req_row.parent_id.as_deref(), Some(folder.as_str()));
        assert_eq!(req_row.kind, "request");
        assert_eq!(req_row.request.as_deref(), Some(req_json));
    }

    #[tokio::test]
    async fn tree_sort_increments_per_sibling_group() {
        let store = mem_store();
        let col = mk_collection(&store, "A").await;
        let r1 = store
            .tree_create(Some(col.clone()), "request".into(), "one".into(), None)
            .await
            .unwrap();
        let r2 = store
            .tree_create(Some(col.clone()), "request".into(), "two".into(), None)
            .await
            .unwrap();
        let rows = store.tree_list().await.unwrap();
        let s = |id: &str| rows.iter().find(|r| r.id == id).unwrap().sort;
        assert!(s(&r1) < s(&r2));
    }

    #[tokio::test]
    async fn tree_create_rejects_bad_kind() {
        let store = mem_store();
        let e = store
            .tree_create(None, "blob".into(), "x".into(), None)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("kind"), "{e}");
    }

    #[tokio::test]
    async fn tree_update_renames_and_saves_request() {
        let store = mem_store();
        let col = mk_collection(&store, "A").await;
        let id = store
            .tree_create(Some(col), "request".into(), "old".into(), None)
            .await
            .unwrap();
        store
            .tree_update(&id, Some("new".into()), Some(r#"{"method":"POST"}"#.into()))
            .await
            .unwrap();
        let rows = store.tree_list().await.unwrap();
        let row = rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(row.name, "new");
        assert_eq!(row.request.as_deref(), Some(r#"{"method":"POST"}"#));
        // Partial update: rename only must not clobber the stored request.
        store
            .tree_update(&id, Some("newer".into()), None)
            .await
            .unwrap();
        let rows = store.tree_list().await.unwrap();
        let row = rows.iter().find(|r| r.id == id).unwrap();
        assert_eq!(row.name, "newer");
        assert_eq!(row.request.as_deref(), Some(r#"{"method":"POST"}"#));
    }

    #[tokio::test]
    async fn tree_update_errors_on_missing_id() {
        let store = mem_store();
        let e = store
            .tree_update("does-not-exist", Some("new".into()), None)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("no tree node"), "{e}");
    }

    #[tokio::test]
    async fn tree_delete_is_recursive() {
        let store = mem_store();
        let col = mk_collection(&store, "A").await;
        let folder = store
            .tree_create(Some(col.clone()), "folder".into(), "f".into(), None)
            .await
            .unwrap();
        store
            .tree_create(Some(folder.clone()), "request".into(), "leaf".into(), None)
            .await
            .unwrap();
        store.tree_delete(&col).await.unwrap();
        assert!(store.tree_list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn tree_duplicate_copies_subtree_with_new_ids() {
        let store = mem_store();
        let col = mk_collection(&store, "A").await;
        let folder = store
            .tree_create(Some(col.clone()), "folder".into(), "f".into(), None)
            .await
            .unwrap();
        store
            .tree_create(
                Some(folder.clone()),
                "request".into(),
                "leaf".into(),
                Some("{}".into()),
            )
            .await
            .unwrap();
        let copy_id = store.tree_duplicate(&folder).await.unwrap();
        let rows = store.tree_list().await.unwrap();
        assert_eq!(rows.len(), 5); // col + f + leaf + "f copy" + copied leaf
        let copy = rows.iter().find(|r| r.id == copy_id).unwrap();
        assert_eq!(copy.name, "f copy");
        assert_eq!(copy.parent_id.as_deref(), Some(col.as_str()));
        let copied_leaf = rows
            .iter()
            .find(|r| r.parent_id.as_deref() == Some(copy_id.as_str()))
            .unwrap();
        assert_eq!(copied_leaf.name, "leaf");
        assert_eq!(copied_leaf.request.as_deref(), Some("{}"));
    }

    #[tokio::test]
    async fn tree_import_builds_structure_and_counts_requests() {
        let store = mem_store();
        let nodes = vec![
            SomnusImportNode {
                kind: "folder".into(),
                name: "Users".into(),
                request: None,
                children: vec![SomnusImportNode {
                    kind: "request".into(),
                    name: "List".into(),
                    request: Some("{}".into()),
                    children: vec![],
                }],
            },
            SomnusImportNode {
                kind: "request".into(),
                name: "Ping".into(),
                request: Some("{}".into()),
                children: vec![],
            },
        ];
        let count = store.tree_import("Imported".into(), nodes).await.unwrap();
        assert_eq!(count, 2);
        let rows = store.tree_list().await.unwrap();
        assert_eq!(rows.len(), 4); // collection + folder + 2 requests
        let root = rows.iter().find(|r| r.kind == "collection").unwrap();
        assert_eq!(root.name, "Imported");
        assert!(root.parent_id.is_none());
    }

    // ── v2: environments ──

    #[tokio::test]
    async fn env_crud_roundtrip() {
        let store = mem_store();
        let id = store.env_create("Staging".into()).await.unwrap();
        store
            .env_update(
                &id,
                "Staging".into(),
                r#"[{"key":"base_url","value":"https://stg.test","secret":false}]"#.into(),
            )
            .await
            .unwrap();
        let envs = store.env_list().await.unwrap();
        assert_eq!(envs.len(), 1);
        assert_eq!(envs[0].name, "Staging");
        assert!(envs[0].vars.contains("base_url"));
        assert!(!envs[0].is_active);
        store.env_delete(&id).await.unwrap();
        assert!(store.env_list().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn env_activate_is_exclusive_and_clearable() {
        let store = mem_store();
        let a = store.env_create("A".into()).await.unwrap();
        let b = store.env_create("B".into()).await.unwrap();
        store.env_activate(Some(a.clone())).await.unwrap();
        store.env_activate(Some(b.clone())).await.unwrap();
        let envs = store.env_list().await.unwrap();
        assert!(!envs.iter().find(|e| e.id == a).unwrap().is_active);
        assert!(envs.iter().find(|e| e.id == b).unwrap().is_active);
        store.env_activate(None).await.unwrap();
        assert!(store.env_list().await.unwrap().iter().all(|e| !e.is_active));
    }
}
