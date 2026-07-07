# Somnus REST Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A right-rail REST client panel (`somnus`) — compose method/URL/headers/body, send through the Rust backend, view the formatted response, with automatic SQLite-backed history and an expand-to-fullscreen mode.

**Architecture:** All HTTP goes through a new `crates/app/src/somnus.rs` Tauri command module (reqwest); `somnus_send` records its own history row into a new `somnus_history` table (storage.rs SCHEMA) via a feature-owned `somnus::Store` sharing the app DB connection (project_notes pattern). The frontend is a `.rail-*`-chromed panel following BeaconPanel, hosted as an in-grid `#somnus-panel` aside, with fullscreen via a `body.somnus-expanded` class flip (Tasker-board pattern).

**Tech Stack:** Rust (reqwest, rusqlite, mockito for tests), TypeScript strict (vitest), Tauri IPC, shared `.rail-*` CSS system.

**Spec:** `docs/superpowers/specs/2026-07-07-somnus-rest-client-design.md`

## Global Constraints

- All work happens in this worktree (`.claude/worktrees/somnus-rest-client`, branch `worktree-somnus-rest-client`). Never edit the main checkout.
- Run vitest and `npm run build` from the **repo root** (worktree root), never from `ui/`.
- **NEVER run `cargo test --workspace`** — telegram long-poll tests hang under broad runs (known gotcha; macOS has no `timeout` command). Use targeted: `cargo test -p covenant somnus`.
- Pre-existing baseline on this branch: **6 failing vitest tests across 8 files (987 pass)**. Zero NEW failures allowed; the 6 old ones are not yours to fix.
- TypeScript: `strict: true`, no `as any` without a justifying comment.
- Tooltips: always `attachTooltip` from `ui/src/tooltip/tooltip.ts`, never `element.title`.
- All UI copy in English.
- No new dependencies (reqwest, mockito, rusqlite, ulid all already present).
- Rust: no `unwrap()` outside `#[cfg(test)]`; errors as `Result<T, String>` at the command boundary.
- Commits: Conventional Commits, one commit per task (user preference: per feature-unit, not per TDD step). End commit messages with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Response caps (from spec): 2 MB display (`DISPLAY_CAP`), 256 KB stored (`STORE_CAP`). Text content-types: `text/*`, `application/json`, `application/xml`, `application/x-www-form-urlencoded`, `+json`/`+xml` suffixes; anything else (or missing) is binary — body neither returned nor stored.

---

### Task 1: Backend core — `somnus.rs` types + send (mockito TDD)

**Files:**
- Create: `crates/app/src/somnus.rs`
- Modify: `crates/app/src/lib.rs` (one line: `mod somnus;` — insert alphabetically near `mod project_notes;` at ~line 51)

**Interfaces:**
- Consumes: nothing (leaf module). reqwest is already a workspace dep.
- Produces: `SomnusRequest { method: String, url: String, headers: Vec<(String,String)>, body: Option<String> }` (Serialize+Deserialize), `SomnusResponse { status: u16, status_text: String, headers: Vec<(String,String)>, body: String, body_truncated: bool, body_binary: bool, duration_ms: u64, size_bytes: u64 }` (Serialize), `pub async fn send_request(&SomnusRequest) -> Result<SomnusResponse, String>`, `pub fn is_text_content_type(Option<&str>) -> bool`, `pub(crate) const STORE_CAP: usize`.

- [ ] **Step 1: Create the module with types, constants, and function skeletons + the full test module**

Create `crates/app/src/somnus.rs`:

```rust
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
    let _ = (req, cap);
    todo!()
}

fn shape_reqwest_err(e: &reqwest::Error) -> String {
    let _ = e;
    todo!()
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
}
```

Then in `crates/app/src/lib.rs`, next to the existing module declarations (around line 51, keep alphabetical-ish grouping):

```rust
mod somnus;
```

- [ ] **Step 2: Run the tests — verify they fail on the `todo!()`**

Run: `cargo test -p covenant somnus 2>&1 | tail -20`
Expected: `text_content_type_detection` PASSES (already implemented); every `#[tokio::test]` FAILS with a `not yet implemented` panic. If instead you get a compile error, fix the compile error first — the tests define the contract.

- [ ] **Step 3: Implement `send_with_cap` + `shape_reqwest_err`**

Replace the two `todo!()` skeletons in `crates/app/src/somnus.rs`:

```rust
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
```

- [ ] **Step 4: Run the tests — verify all pass**

Run: `cargo test -p covenant somnus 2>&1 | tail -5`
Expected: `test result: ok.` with 8 tests passed, 0 failed.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/somnus.rs crates/app/src/lib.rs
git commit -m "feat(somnus): backend request engine — reqwest send with caps, text/binary detection, shaped errors

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: History — `somnus_history` table + `somnus::Store` (in-memory SQLite TDD)

**Files:**
- Modify: `crates/app/src/storage.rs` (append DDL to `SCHEMA` const, just before the closing `";` at ~line 269)
- Modify: `crates/app/src/somnus.rs` (add Store + entry type + tests)

**Interfaces:**
- Consumes: `crate::storage::SCHEMA` (tests), `Arc<Mutex<Connection>>` from `Storage::conn()` (tokio `Mutex`, `blocking_lock()` inside `spawn_blocking` — project_notes pattern), Task 1's `SomnusRequest`/`SomnusResponse`/`STORE_CAP`.
- Produces: `somnus::Store` (Clone) with `new(conn)`, `async fn record(&self, req: &SomnusRequest, result: &Result<SomnusResponse, String>) -> Result<String, StoreError>` (returns new row id), `async fn list(&self, limit: u32) -> Result<Vec<SomnusHistoryEntry>, StoreError>`, `async fn delete(&self, id: &str)`, `async fn clear(&self)`. `SomnusHistoryEntry` (Serialize) — fields below.

- [ ] **Step 1: Add the table to `storage.rs` SCHEMA**

In `crates/app/src/storage.rs`, immediately before the closing `";` of the `SCHEMA` const (after the `idx_handoffs_to` index line at ~268):

```sql
CREATE TABLE IF NOT EXISTS somnus_history (
    id                  TEXT PRIMARY KEY,
    method              TEXT NOT NULL,
    url                 TEXT NOT NULL,
    req_headers         TEXT NOT NULL,   -- JSON array of [k, v] pairs
    req_body            TEXT,
    status              INTEGER,         -- NULL when the send failed at the network layer
    resp_headers        TEXT,            -- JSON array of [k, v] pairs
    resp_body           TEXT,            -- capped at STORE_CAP (256 KB)
    error               TEXT,            -- shaped network/timeout error, NULL on success
    duration_ms         INTEGER,
    size_bytes          INTEGER,
    created_at_unix_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_somnus_history_created ON somnus_history(created_at_unix_ms DESC);
```

- [ ] **Step 2: Add Store skeleton + entry type + failing tests to `somnus.rs`**

Add to `crates/app/src/somnus.rs` (below the send code, above `#[cfg(test)]`):

```rust
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
        let _ = (req, result);
        todo!()
    }

    /// Newest first.
    pub async fn list(&self, limit: u32) -> Result<Vec<SomnusHistoryEntry>, StoreError> {
        let _ = limit;
        todo!()
    }

    pub async fn delete(&self, id: &str) -> Result<(), StoreError> {
        let _ = id;
        todo!()
    }

    pub async fn clear(&self) -> Result<(), StoreError> {
        todo!()
    }
}
```

Append inside the existing `mod tests` in `somnus.rs`:

```rust
    fn mem_store() -> Store {
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
```

- [ ] **Step 3: Run tests — verify the new ones fail on `todo!()`**

Run: `cargo test -p covenant somnus 2>&1 | tail -12`
Expected: Task 1's 8 tests still pass; the 5 new store tests FAIL with `not yet implemented`.

- [ ] **Step 4: Implement the Store methods**

Replace the four `todo!()` bodies:

```rust
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
```

Note: `record`'s double `??` — outer for the Join error, inner for the closure's Result.

- [ ] **Step 5: Run tests — verify all pass**

Run: `cargo test -p covenant somnus 2>&1 | tail -5`
Expected: `test result: ok.` — 13 tests passed, 0 failed.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/somnus.rs crates/app/src/storage.rs
git commit -m "feat(somnus): history store — somnus_history table + record/list/delete/clear with 256KB body cap

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Commands, registration, api.ts wrappers

**Files:**
- Modify: `crates/app/src/somnus.rs` (add `send_and_record` + 4 `#[tauri::command]` fns)
- Modify: `crates/app/src/lib.rs` (manage the Store at ~line 3871 next to `project_notes::Store`; register 4 commands after `beacon_cancel_workflow,` at ~line 4572)
- Modify: `ui/src/api.ts` (types + wrappers after the Beacon block, ~line 1357)

**Interfaces:**
- Consumes: Task 1 `send_request`, Task 2 `Store`.
- Produces: Rust commands `somnus_send(req)`, `somnus_history(limit)`, `somnus_history_delete(id)`, `somnus_history_clear()`; `pub async fn send_and_record(&Store, SomnusRequest) -> Result<SomnusResponse, String>` (the v2 operator seam); TS `somnusSend(req: SomnusRequest): Promise<SomnusResponse>`, `somnusHistory(limit?): Promise<SomnusHistoryEntry[]>`, `somnusHistoryDelete(id)`, `somnusHistoryClear()` + TS types `SomnusRequest`/`SomnusResponse`/`SomnusHistoryEntry` (snake_case fields, tuples as `[string, string][]`).

- [ ] **Step 1: Add `send_and_record` + command fns to `somnus.rs`**

Below the `impl Store` block:

```rust
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
```

- [ ] **Step 2: Manage the store + register commands in `lib.rs`**

In the `.setup()` closure, directly after `app.manage(project_notes::Store::new(storage.conn()));` (~line 3871):

```rust
            app.manage(somnus::Store::new(storage.conn()));
```

In the `generate_handler![...]` list, directly after `beacon_cancel_workflow,` (~line 4572):

```rust
            somnus::somnus_send,
            somnus::somnus_history,
            somnus::somnus_history_delete,
            somnus::somnus_history_clear,
```

- [ ] **Step 3: Add api.ts types + wrappers**

In `ui/src/api.ts`, after the Beacon block (after `beaconCancelWorkflow`, before the `// CDLC` comment at ~line 1358):

```ts
// Somnus — REST client sidebar -----------------------------------------

export type SomnusRequest = {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
};

export type SomnusResponse = {
  status: number;
  status_text: string;
  headers: [string, string][];
  body: string;
  body_truncated: boolean;
  body_binary: boolean;
  duration_ms: number;
  size_bytes: number;
};

export type SomnusHistoryEntry = {
  id: string;
  method: string;
  url: string;
  req_headers: [string, string][];
  req_body: string | null;
  status: number | null;
  resp_headers: [string, string][];
  resp_body: string | null;
  error: string | null;
  duration_ms: number | null;
  size_bytes: number | null;
  created_at_unix_ms: number;
};

export async function somnusSend(req: SomnusRequest): Promise<SomnusResponse> {
  return invoke<SomnusResponse>("somnus_send", { req });
}

export async function somnusHistory(limit?: number): Promise<SomnusHistoryEntry[]> {
  return invoke<SomnusHistoryEntry[]>("somnus_history", { limit: limit ?? null });
}

export async function somnusHistoryDelete(id: string): Promise<void> {
  return invoke<void>("somnus_history_delete", { id });
}

export async function somnusHistoryClear(): Promise<void> {
  return invoke<void>("somnus_history_clear", {});
}
```

- [ ] **Step 4: Verify — Rust tests + compile, TS type-check**

Run: `cargo test -p covenant somnus 2>&1 | tail -3`
Expected: 13 passed.

Run: `cargo check -p covenant 2>&1 | tail -3`
Expected: no errors (warnings acceptable if pre-existing).

Run: `npm run build 2>&1 | tail -5`
Expected: tsc + vite complete with no type errors.

- [ ] **Step 5: Commit**

```bash
git add crates/app/src/somnus.rs crates/app/src/lib.rs ui/src/api.ts
git commit -m "feat(somnus): tauri commands + typed api.ts wrappers — send_and_record single write-path

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: curl paste parser (vitest TDD)

**Files:**
- Create: `ui/src/somnus/curl.ts`
- Create: `ui/src/somnus/curl.test.ts`

**Interfaces:**
- Consumes: nothing (pure module).
- Produces: `parseCurl(text: string): ParsedCurl | null` where `ParsedCurl = { method: string; url: string; headers: [string, string][]; body: string | null }`. Task 5's panel calls this on paste.

- [ ] **Step 1: Write the failing tests**

Create `ui/src/somnus/curl.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseCurl } from "./curl";

describe("parseCurl", () => {
  it("returns null for non-curl input", () => {
    expect(parseCurl("https://api.test/things")).toBeNull();
    expect(parseCurl("")).toBeNull();
    expect(parseCurl("curling is a sport")).toBeNull();
  });

  it("parses a bare GET", () => {
    expect(parseCurl("curl https://api.test/things")).toEqual({
      method: "GET",
      url: "https://api.test/things",
      headers: [],
      body: null,
    });
  });

  it("parses method, headers, and body with mixed quoting", () => {
    const p = parseCurl(
      `curl -X PUT https://api.test/things/1 -H 'Content-Type: application/json' -H "X-Token: abc" -d '{"name":"x"}'`,
    );
    expect(p).toEqual({
      method: "PUT",
      url: "https://api.test/things/1",
      headers: [
        ["Content-Type", "application/json"],
        ["X-Token", "abc"],
      ],
      body: '{"name":"x"}',
    });
  });

  it("--request/--header/--data long forms work", () => {
    const p = parseCurl(
      "curl --request DELETE --header 'X-A: 1' --data 'k=v' https://api.test/x",
    );
    expect(p?.method).toBe("DELETE");
    expect(p?.headers).toEqual([["X-A", "1"]]);
    expect(p?.body).toBe("k=v");
  });

  it("-d without -X implies POST", () => {
    expect(parseCurl("curl https://api.test -d a=b")?.method).toBe("POST");
  });

  it("survives line continuations and unknown flags", () => {
    const p = parseCurl("curl -s --compressed \\\n  -o out.json https://api.test/x");
    expect(p?.url).toBe("https://api.test/x");
    expect(p?.method).toBe("GET");
  });

  it("returns null when no URL is present", () => {
    expect(parseCurl("curl -s -X GET")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run ui/src/somnus/curl.test.ts 2>&1 | tail -5`
Expected: FAIL — cannot resolve `./curl`.

- [ ] **Step 3: Implement the parser**

Create `ui/src/somnus/curl.ts`:

```ts
// curl-paste import for the Somnus composer. Parses method (-X), URL,
// headers (-H) and body (-d/--data*) out of a pasted curl command.
// Unsupported flags are ignored; flags known to take a value consume it
// so the value can't be mistaken for the URL.

export interface ParsedCurl {
  method: string;
  url: string;
  headers: [string, string][];
  body: string | null;
}

/// Flags (besides the ones we parse) that consume a following value.
const VALUE_FLAGS = new Set([
  "-o", "--output", "-A", "--user-agent", "-b", "--cookie", "-u", "--user",
  "-e", "--referer", "--connect-timeout", "--max-time", "-m",
]);

/// Whitespace tokenizer honoring single/double quotes and backslash escapes.
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let quote: '"' | "'" | null = null;
  let sawQuote = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\" && i + 1 < input.length) {
        cur += input[++i];
        continue;
      }
      if (ch === '"') quote = null;
      else cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      sawQuote = true;
      continue;
    }
    if (ch === "\\" && i + 1 < input.length) {
      cur += input[++i];
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur || sawQuote) {
        tokens.push(cur);
        cur = "";
        sawQuote = false;
      }
      continue;
    }
    cur += ch;
  }
  if (cur || sawQuote) tokens.push(cur);
  return tokens;
}

export function parseCurl(text: string): ParsedCurl | null {
  const trimmed = text.trim();
  if (!/^curl\s/i.test(trimmed)) return null;
  // "\<newline>" line continuations are cosmetic — flatten them first.
  const tokens = tokenize(trimmed.replace(/\\\r?\n/g, " ")).slice(1);
  let method: string | null = null;
  let url: string | null = null;
  const headers: [string, string][] = [];
  let body: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "-X" || t === "--request") {
      method = tokens[++i]?.toUpperCase() ?? null;
      continue;
    }
    if (t === "-H" || t === "--header") {
      const h = tokens[++i] ?? "";
      const colon = h.indexOf(":");
      if (colon > 0) headers.push([h.slice(0, colon).trim(), h.slice(colon + 1).trim()]);
      continue;
    }
    if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") {
      body = tokens[++i] ?? null;
      continue;
    }
    if (VALUE_FLAGS.has(t)) {
      i++; // skip the flag's value
      continue;
    }
    if (t.startsWith("-")) continue; // bare flag we ignore
    if (!url) url = t;
  }
  if (!url) return null;
  return {
    method: method ?? (body !== null ? "POST" : "GET"),
    url,
    headers,
    body,
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `npx vitest run ui/src/somnus/curl.test.ts 2>&1 | tail -5`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add ui/src/somnus/curl.ts ui/src/somnus/curl.test.ts
git commit -m "feat(somnus): curl-paste parser — -X/-H/-d into composer fields

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: SomnusPanel — pure helpers (TDD), panel DOM, panel CSS

**Files:**
- Create: `ui/src/somnus/panel.ts`
- Create: `ui/src/somnus/panel.test.ts`
- Create: `ui/src/somnus/somnus.css`
- Modify: `docs/superpowers/specs/2026-07-07-somnus-rest-client-design.md` (one sentence, see Step 5)

**Interfaces:**
- Consumes: Task 3 api.ts (`somnusSend`, `somnusHistory`, `somnusHistoryDelete`, `somnusHistoryClear`, types), Task 4 `parseCurl`, `Icons` from `../icons`, `attachTooltip` from `../tooltip/tooltip`.
- Produces: `class SomnusPanel` with `constructor(host: HTMLElement, opts: { onClose: () => void })`, `render(): void` (called on open), `close(): void` (called on hide — also collapses fullscreen). Exported pure helpers for tests: `statusSpine`, `fmtSize`, `fmtDuration`, `prettyBody`, `relTimeMs`. Task 6 wires the class into main.ts.

- [ ] **Step 1: Write the failing helper tests**

Create `ui/src/somnus/panel.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fmtDuration, fmtSize, prettyBody, statusSpine } from "./panel";

describe("statusSpine", () => {
  it("maps outcomes to rail spines", () => {
    expect(statusSpine(200, null)).toBe("ok");
    expect(statusSpine(304, null)).toBe("ok");
    expect(statusSpine(404, null)).toBe("fail");
    expect(statusSpine(500, null)).toBe("fail");
    expect(statusSpine(null, "somnus: connection failed")).toBe("fail");
    expect(statusSpine(null, null)).toBe("fail");
  });
});

describe("fmtSize", () => {
  it("formats byte counts", () => {
    expect(fmtSize(0)).toBe("0 B");
    expect(fmtSize(512)).toBe("512 B");
    expect(fmtSize(2048)).toBe("2.0 KB");
    expect(fmtSize(3.5 * 1024 * 1024)).toBe("3.5 MB");
    expect(fmtSize(null)).toBe("");
  });
});

describe("fmtDuration", () => {
  it("formats milliseconds", () => {
    expect(fmtDuration(850)).toBe("850 ms");
    expect(fmtDuration(1500)).toBe("1.50 s");
    expect(fmtDuration(null)).toBe("");
  });
});

describe("prettyBody", () => {
  it("pretty-prints JSON and passes through everything else", () => {
    expect(prettyBody('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyBody("[1,2]")).toBe("[\n  1,\n  2\n]");
    expect(prettyBody("<html></html>")).toBe("<html></html>");
    expect(prettyBody("not { json")).toBe("not { json");
    expect(prettyBody("")).toBe("");
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `npx vitest run ui/src/somnus/panel.test.ts 2>&1 | tail -5`
Expected: FAIL — cannot resolve `./panel`.

- [ ] **Step 3: Implement the full panel**

Create `ui/src/somnus/panel.ts`:

```ts
import {
  somnusHistory,
  somnusHistoryClear,
  somnusHistoryDelete,
  somnusSend,
  type SomnusHistoryEntry,
  type SomnusRequest,
  type SomnusResponse,
} from "../api";
import { Icons } from "../icons";
import { attachTooltip } from "../tooltip/tooltip";
import { parseCurl } from "./curl";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/// Map an attempt outcome to a rail-row `data-spine` value.
export function statusSpine(status: number | null, error: string | null): string {
  if (error !== null || status === null) return "fail";
  return status < 400 ? "ok" : "fail";
}

export function fmtSize(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function fmtDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/// Pretty-print JSON bodies for display; pass through anything unparsable.
export function prettyBody(body: string): string {
  const t = body.trim();
  if (!t || (t[0] !== "{" && t[0] !== "[")) return body;
  try {
    return JSON.stringify(JSON.parse(t), null, 2);
  } catch {
    return body;
  }
}

export function relTimeMs(unixMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - unixMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function isSendableUrl(u: string): boolean {
  try {
    const parsed = new URL(u.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

interface HeaderRow {
  row: HTMLElement;
  key: HTMLInputElement;
  val: HTMLInputElement;
}

export class SomnusPanel {
  private root: HTMLElement;
  private methodSel: HTMLSelectElement;
  private urlInput: HTMLInputElement;
  private sendBtn: HTMLButtonElement;
  private expandBtn: HTMLButtonElement;
  private tabHeadersBtn: HTMLButtonElement;
  private tabBodyBtn: HTMLButtonElement;
  private headersHost: HTMLElement;
  private bodyArea: HTMLTextAreaElement;
  private responseHost: HTMLElement;
  private historyHost: HTMLElement;
  private headerRows: HeaderRow[] = [];
  private activeTab: "headers" | "body" = "headers";
  private sending = false;
  private loadedHistory = false;
  private expanded = false;
  private onEsc = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.expanded) {
      e.stopPropagation();
      this.setExpanded(false);
    }
  };

  constructor(
    host: HTMLElement,
    private opts: { onClose: () => void },
  ) {
    this.root = document.createElement("div");
    this.root.className = "rail-panel";

    // ── Header ──
    const header = document.createElement("div");
    header.className = "rail-header";
    const titleWrap = document.createElement("div");
    titleWrap.className = "rail-title";
    const dot = document.createElement("span");
    dot.className = "rail-dot is-idle";
    const label = document.createElement("span");
    label.className = "rail-title-label";
    label.textContent = "Somnus";
    titleWrap.append(dot, label);

    const actions = document.createElement("div");
    actions.className = "rail-actions";
    this.expandBtn = document.createElement("button");
    this.expandBtn.className = "rail-btn";
    this.expandBtn.setAttribute("aria-label", "Expand");
    this.expandBtn.innerHTML = Icons.maximize({ size: 15 });
    this.expandBtn.addEventListener("click", () => this.setExpanded(!this.expanded));
    attachTooltip(this.expandBtn, "Expand");
    const clearBtn = document.createElement("button");
    clearBtn.className = "rail-btn";
    clearBtn.setAttribute("aria-label", "Clear history");
    clearBtn.innerHTML = Icons.trash({ size: 15 });
    clearBtn.addEventListener("click", () => {
      if (!confirm("Clear all Somnus history?")) return;
      void somnusHistoryClear()
        .then(() => this.refreshHistory())
        .catch((e) => console.error("somnus clear failed", e));
    });
    attachTooltip(clearBtn, "Clear history");
    const close = document.createElement("button");
    close.className = "rail-btn";
    close.setAttribute("aria-label", "Close");
    close.innerHTML = Icons.x({ size: 15 });
    close.addEventListener("click", () => this.opts.onClose());
    attachTooltip(close, "Close");
    actions.append(this.expandBtn, clearBtn, close);
    header.append(titleWrap, actions);

    // ── Composer ──
    const composer = document.createElement("div");
    composer.className = "somnus-composer";

    const line = document.createElement("div");
    line.className = "somnus-line";
    this.methodSel = document.createElement("select");
    this.methodSel.className = "rail-select somnus-method";
    for (const m of METHODS) {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      this.methodSel.append(opt);
    }
    this.methodSel.addEventListener("change", () => this.syncBodyEnabled());
    this.urlInput = document.createElement("input");
    this.urlInput.className = "rail-search somnus-url";
    this.urlInput.type = "text";
    this.urlInput.placeholder = "https://api.example.com/…  (or paste a curl command)";
    this.urlInput.spellcheck = false;
    this.urlInput.addEventListener("input", () => this.syncSendEnabled());
    this.urlInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.sendBtn.disabled) void this.send();
    });
    this.urlInput.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text/plain") ?? "";
      const parsed = parseCurl(text);
      if (!parsed) return;
      e.preventDefault();
      this.loadRequest({
        method: parsed.method,
        url: parsed.url,
        headers: parsed.headers,
        body: parsed.body,
      });
    });
    this.sendBtn = document.createElement("button");
    this.sendBtn.className = "somnus-send";
    this.sendBtn.type = "button";
    this.sendBtn.textContent = "Send";
    this.sendBtn.disabled = true;
    this.sendBtn.addEventListener("click", () => void this.send());
    line.append(this.methodSel, this.urlInput, this.sendBtn);

    const tabs = document.createElement("div");
    tabs.className = "rail-tabs somnus-tabs";
    this.tabHeadersBtn = document.createElement("button");
    this.tabHeadersBtn.type = "button";
    this.tabHeadersBtn.textContent = "Headers";
    this.tabHeadersBtn.addEventListener("click", () => this.setTab("headers"));
    this.tabBodyBtn = document.createElement("button");
    this.tabBodyBtn.type = "button";
    this.tabBodyBtn.textContent = "Body";
    this.tabBodyBtn.addEventListener("click", () => this.setTab("body"));
    tabs.append(this.tabHeadersBtn, this.tabBodyBtn);

    this.headersHost = document.createElement("div");
    this.headersHost.className = "somnus-headers";
    const addHeader = document.createElement("button");
    addHeader.type = "button";
    addHeader.className = "somnus-add-header";
    addHeader.textContent = "+ header";
    addHeader.addEventListener("click", () => this.addHeaderRow("", ""));

    this.bodyArea = document.createElement("textarea");
    this.bodyArea.className = "somnus-bodybox";
    this.bodyArea.placeholder = "Request body";
    this.bodyArea.spellcheck = false;

    composer.append(line, tabs, this.headersHost, addHeader, this.bodyArea);

    // ── Scroller: response + history ──
    const body = document.createElement("div");
    body.className = "rail-body";
    this.responseHost = document.createElement("div");
    this.responseHost.className = "somnus-response";
    this.historyHost = document.createElement("div");
    this.historyHost.className = "somnus-history";
    body.append(this.responseHost, this.historyHost);

    this.root.append(header, composer, body);
    host.replaceChildren(this.root);

    this.addHeaderRow("", "");
    this.setTab("headers");
    this.syncBodyEnabled();
  }

  /// Called when the panel opens.
  render(): void {
    if (!this.loadedHistory) void this.refreshHistory();
  }

  /// Called when the panel hides. Also drops fullscreen if active.
  close(): void {
    this.setExpanded(false);
  }

  // ── Composer state ──

  private setTab(tab: "headers" | "body"): void {
    this.activeTab = tab;
    this.tabHeadersBtn.classList.toggle("is-active", tab === "headers");
    this.tabBodyBtn.classList.toggle("is-active", tab === "body");
    this.root.classList.toggle("somnus-tab-headers", tab === "headers");
    this.root.classList.toggle("somnus-tab-body", tab === "body");
  }

  private syncBodyEnabled(): void {
    const enabled = BODY_METHODS.has(this.methodSel.value);
    this.bodyArea.disabled = !enabled;
    this.tabBodyBtn.disabled = !enabled;
    if (!enabled && this.activeTab === "body") this.setTab("headers");
  }

  private syncSendEnabled(): void {
    this.sendBtn.disabled = this.sending || !isSendableUrl(this.urlInput.value);
  }

  private addHeaderRow(k: string, v: string): void {
    const row = document.createElement("div");
    row.className = "somnus-header-row";
    const key = document.createElement("input");
    key.className = "rail-search";
    key.type = "text";
    key.placeholder = "Header";
    key.spellcheck = false;
    key.value = k;
    const val = document.createElement("input");
    val.className = "rail-search";
    val.type = "text";
    val.placeholder = "Value";
    val.spellcheck = false;
    val.value = v;
    const rm = document.createElement("button");
    rm.type = "button";
    rm.className = "rail-btn";
    rm.setAttribute("aria-label", "Remove header");
    rm.innerHTML = Icons.x({ size: 13 });
    rm.addEventListener("click", () => {
      row.remove();
      this.headerRows = this.headerRows.filter((r) => r.row !== row);
    });
    row.append(key, val, rm);
    this.headersHost.append(row);
    this.headerRows.push({ row, key, val });
  }

  private currentRequest(): SomnusRequest {
    const headers: [string, string][] = [];
    for (const r of this.headerRows) {
      const k = r.key.value.trim();
      if (k) headers.push([k, r.val.value]);
    }
    const method = this.methodSel.value;
    return {
      method,
      url: this.urlInput.value.trim(),
      headers,
      body: BODY_METHODS.has(method) && this.bodyArea.value ? this.bodyArea.value : null,
    };
  }

  private loadRequest(req: {
    method: string;
    url: string;
    headers: [string, string][];
    body: string | null;
  }): void {
    this.methodSel.value = METHODS.includes(req.method) ? req.method : "GET";
    this.urlInput.value = req.url;
    this.headersHost.replaceChildren();
    this.headerRows = [];
    for (const [k, v] of req.headers) this.addHeaderRow(k, v);
    if (this.headerRows.length === 0) this.addHeaderRow("", "");
    this.bodyArea.value = req.body ?? "";
    this.syncBodyEnabled();
    this.syncSendEnabled();
    if (req.body) this.setTab("body");
  }

  // ── Send / response ──

  private async send(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    this.sendBtn.textContent = "…";
    this.syncSendEnabled();
    const req = this.currentRequest();
    try {
      const resp = await somnusSend(req);
      this.renderResponse(resp);
    } catch (e) {
      this.renderError(String(e));
    } finally {
      this.sending = false;
      this.sendBtn.textContent = "Send";
      this.syncSendEnabled();
      void this.refreshHistory();
    }
  }

  private renderResponse(resp: SomnusResponse): void {
    this.responseHost.replaceChildren();
    const status = document.createElement("div");
    status.className = "somnus-resp-status";
    status.setAttribute("data-spine", statusSpine(resp.status, null));
    status.textContent = [
      `${resp.status} ${resp.status_text}`.trim(),
      fmtDuration(resp.duration_ms),
      fmtSize(resp.size_bytes),
    ]
      .filter(Boolean)
      .join(" · ");
    this.responseHost.append(status);

    if (resp.headers.length) {
      const det = document.createElement("details");
      det.className = "somnus-resp-headers";
      const sum = document.createElement("summary");
      sum.textContent = `Response headers (${resp.headers.length})`;
      det.append(sum);
      const list = document.createElement("pre");
      list.textContent = resp.headers.map(([k, v]) => `${k}: ${v}`).join("\n");
      det.append(list);
      this.responseHost.append(det);
    }

    if (resp.body_binary) {
      const note = document.createElement("div");
      note.className = "rail-notice";
      note.textContent = `binary (${fmtSize(resp.size_bytes)})`;
      this.responseHost.append(note);
    } else {
      if (resp.body_truncated) {
        const note = document.createElement("div");
        note.className = "rail-notice";
        note.textContent = "Response truncated at 2 MB";
        this.responseHost.append(note);
      }
      const pre = document.createElement("pre");
      pre.className = "somnus-resp-body";
      pre.textContent = prettyBody(resp.body);
      this.responseHost.append(pre);
    }
  }

  private renderError(message: string): void {
    this.responseHost.replaceChildren();
    const clean = message.replace(/^somnus:\s*/i, "");
    const dash = clean.indexOf(" — ");
    const el = document.createElement("div");
    el.className = "rail-empty is-error";
    el.innerHTML =
      Icons.alertTriangle({ size: 24 }) +
      `<div class="rail-empty-title"></div>` +
      `<div class="rail-empty-hint"></div>`;
    const titleEl = el.querySelector(".rail-empty-title");
    const hintEl = el.querySelector(".rail-empty-hint");
    if (titleEl) titleEl.textContent = dash === -1 ? clean : clean.slice(0, dash);
    if (hintEl) hintEl.textContent = dash === -1 ? "" : clean.slice(dash + 3);
    this.responseHost.append(el);
  }

  // ── History ──

  private async refreshHistory(): Promise<void> {
    try {
      const rows = await somnusHistory(50);
      this.loadedHistory = true;
      this.renderHistory(rows);
    } catch (e) {
      console.error("somnus history load failed", e);
    }
  }

  private renderHistory(rows: SomnusHistoryEntry[]): void {
    this.historyHost.replaceChildren();
    if (rows.length === 0) {
      const empty = document.createElement("div");
      empty.className = "rail-notice";
      empty.textContent = "Sent requests will appear here.";
      this.historyHost.append(empty);
      return;
    }
    for (const entry of rows) {
      const row = document.createElement("div");
      row.className = "rail-row";
      row.setAttribute("data-spine", statusSpine(entry.status, entry.error));
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");

      const line = document.createElement("div");
      line.className = "rail-row-line";
      const name = document.createElement("span");
      name.className = "rail-name";
      name.textContent = entry.url;
      const when = document.createElement("span");
      when.className = "rail-when";
      when.textContent = relTimeMs(entry.created_at_unix_ms);
      line.append(name, when);

      const meta = document.createElement("div");
      meta.className = "rail-meta";
      const bits = [
        entry.method,
        entry.error ? "network error" : entry.status !== null ? String(entry.status) : "",
        fmtDuration(entry.duration_ms),
      ].filter(Boolean);
      meta.textContent = bits.join(" · ");
      row.append(line, meta);

      const del = document.createElement("button");
      del.type = "button";
      del.className = "rail-row-action";
      del.setAttribute("aria-label", "Delete entry");
      del.innerHTML = Icons.trash({ size: 13 });
      attachTooltip(del, "Delete entry");
      del.addEventListener("click", (e) => {
        e.stopPropagation();
        void somnusHistoryDelete(entry.id)
          .then(() => this.refreshHistory())
          .catch((err) => console.error("somnus delete failed", err));
      });
      row.append(del);

      const load = (): void => this.loadEntry(entry);
      row.addEventListener("click", load);
      row.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") load();
      });
      this.historyHost.append(row);
    }
  }

  private loadEntry(entry: SomnusHistoryEntry): void {
    this.loadRequest({
      method: entry.method,
      url: entry.url,
      headers: entry.req_headers,
      body: entry.req_body,
    });
    if (entry.error) {
      this.renderError(entry.error);
    } else if (entry.status !== null) {
      this.renderResponse({
        status: entry.status,
        status_text: "",
        headers: entry.resp_headers,
        body: entry.resp_body ?? "",
        body_truncated: false,
        body_binary: entry.resp_body === null,
        duration_ms: entry.duration_ms ?? 0,
        size_bytes: entry.size_bytes ?? 0,
      });
    }
  }

  // ── Fullscreen ──

  private setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    document.body.classList.toggle("somnus-expanded", expanded);
    this.expandBtn.innerHTML = expanded
      ? Icons.chevronsDownUp({ size: 15 })
      : Icons.maximize({ size: 15 });
    attachTooltip(this.expandBtn, expanded ? "Collapse" : "Expand");
    if (expanded) window.addEventListener("keydown", this.onEsc, true);
    else window.removeEventListener("keydown", this.onEsc, true);
  }
}
```

- [ ] **Step 4: Create `ui/src/somnus/somnus.css`**

```css
/* Somnus — REST client sidebar (right rail, Beacon/Tasker host pattern).
   Visual chrome comes from the shared .rail-* system in styles.css; this
   file owns the host placement, composer layout, and fullscreen mode. */

#somnus-panel.hidden {
  display: none !important;
}

#somnus-panel,
#somnus-panel * {
  box-sizing: border-box;
}

#somnus-panel {
  position: relative;
  grid-row: 2 / 3;
  grid-column: 2 / 3;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  z-index: 1;
  background: var(--sidebar-bg);
  border-left: 1px solid var(--border);
  font-family: var(--ui-font);
  /* Grid-item min-content otherwise stretches #layout's 1fr row when the
     history list is long — same rule as #tasker-panel / #beacon-panel. */
  overflow: hidden;
}

body:not(.sidebar-view-somnus) #somnus-panel {
  display: none;
}
body.blocks-globally-collapsed #somnus-panel {
  display: none;
}

/* Shared opaque-nudge entrance — no opacity fade (vibrancy bleed). */
body.sidebar-view-somnus #somnus-panel {
  animation: right-rail-panel-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

/* ── Composer ── */
.somnus-composer {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px var(--rail-pad-x);
  border-bottom: 1px solid var(--border);
}
.somnus-line {
  display: flex;
  gap: 6px;
  min-width: 0;
}
.somnus-method {
  flex: 0 0 auto;
  width: 74px;
}
.somnus-url {
  flex: 1 1 auto;
  min-width: 0;
}
.somnus-send {
  flex: 0 0 auto;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: var(--rail-radius);
  background: var(--bg-elevated);
  color: var(--text-primary, #e6e8ee);
  font-size: var(--fs-meta);
  cursor: pointer;
}
.somnus-send:disabled {
  opacity: 0.45;
  cursor: default;
}
.somnus-header-row {
  display: flex;
  gap: 4px;
  align-items: center;
}
.somnus-header-row .rail-search {
  flex: 1 1 50%;
  min-width: 0;
}
.somnus-add-header {
  align-self: flex-start;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: var(--fs-micro);
  cursor: pointer;
  padding: 0;
}
.somnus-bodybox {
  width: 100%;
  min-height: 72px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: var(--rail-radius);
  background: var(--bg-elevated);
  color: var(--text-primary, #e6e8ee);
  font-family: var(--mono-font, ui-monospace, monospace);
  font-size: var(--fs-meta);
  padding: 6px 8px;
}
.somnus-bodybox:disabled {
  opacity: 0.4;
}
/* Tab visibility: composer shows headers OR body */
.rail-panel.somnus-tab-headers .somnus-bodybox {
  display: none;
}
.rail-panel.somnus-tab-body .somnus-headers,
.rail-panel.somnus-tab-body .somnus-add-header {
  display: none;
}

/* ── Response ── */
.somnus-response {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px var(--rail-pad-x);
}
.somnus-response:empty {
  display: none;
}
.somnus-resp-status {
  font-size: var(--fs-meta);
  color: var(--text-secondary);
  padding-left: 8px;
  border-left: var(--rail-spine) solid var(--border);
}
.somnus-resp-status[data-spine="ok"] {
  border-left-color: #34d399;
}
.somnus-resp-status[data-spine="fail"] {
  border-left-color: #ef6b7e;
}
.somnus-resp-headers summary {
  font-size: var(--fs-micro);
  color: var(--text-tertiary);
  cursor: pointer;
}
.somnus-resp-headers pre,
.somnus-resp-body {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--rail-radius);
  background: var(--bg-elevated);
  font-family: var(--mono-font, ui-monospace, monospace);
  font-size: var(--fs-micro);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-x: auto;
  max-height: 40vh;
  overflow-y: auto;
}

/* ── History ── */
.somnus-history .rail-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ── Fullscreen (body.somnus-expanded) — mirrors body.tasker-board ── */
body.somnus-expanded #somnus-panel {
  position: fixed;
  inset: 38px 0 0 0;
  bottom: calc(var(--statusbar-h) + 1px);
  width: 100vw;
  height: auto;
  max-width: none;
  border: none;
  z-index: 80;
}
body.tabbar-left.somnus-expanded #somnus-panel {
  top: 38px;
}
/* History becomes a left column; response takes the main area. */
body.somnus-expanded #somnus-panel .rail-body {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  overflow: hidden;
}
body.somnus-expanded #somnus-panel .somnus-history {
  grid-column: 1;
  grid-row: 1;
  overflow-y: auto;
  border-right: 1px solid var(--border);
}
body.somnus-expanded #somnus-panel .somnus-response {
  grid-column: 2;
  grid-row: 1;
  overflow-y: auto;
}
body.somnus-expanded #somnus-panel .somnus-resp-body,
body.somnus-expanded #somnus-panel .somnus-resp-headers pre {
  max-height: none;
}
body.somnus-expanded #somnus-panel .somnus-composer {
  max-width: 960px;
  width: 100%;
  margin: 0 auto;
  border-bottom: none;
}
```

- [ ] **Step 5: Amend the spec's data-flow sentence**

The spec says the panel "prepends the history entry locally (no re-fetch needed)". The implementation re-fetches after send instead — the row's real ULID is needed for per-row delete, and one extra IPC on a user action is free. In `docs/superpowers/specs/2026-07-07-somnus-rest-client-design.md`, replace:

```
Panel Send → `api.ts somnus.send()` → `invoke("somnus_send")` → reqwest → history row written → `SomnusResponse` back → panel renders response + prepends the history entry locally (no re-fetch needed; `somnus_history` is for panel open / reload).
```

with:

```
Panel Send → `api.ts somnusSend()` → `invoke("somnus_send")` → reqwest → history row written → `SomnusResponse` back → panel renders response, then re-fetches `somnus_history` so rows carry their real ids (needed for per-row delete).
```

- [ ] **Step 6: Run tests — verify helpers pass**

Run: `npx vitest run ui/src/somnus/ 2>&1 | tail -5`
Expected: curl + panel suites pass (11 tests total: 7 curl + 4 panel describe blocks).

- [ ] **Step 7: Commit**

```bash
git add ui/src/somnus/ docs/superpowers/specs/2026-07-07-somnus-rest-client-design.md
git commit -m "feat(somnus): rail panel — composer, response viewer, history list, curl paste

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Wiring — host, rail target, titlebar button, grid CSS, moon icon, ⌘⌥R

**Files:**
- Modify: `ui/index.html` (titlebar button after `#titlebar-beacon` at ~line 645; aside after `#beacon-panel` at ~line 705)
- Modify: `ui/src/titlebar/right-rail.ts` (add `"somnus"` to `RailTarget` union at line 14)
- Modify: `ui/src/icons/index.ts` (add `moon` icon before the closing `};` at ~line 488)
- Modify: `ui/src/main.ts` (import, button lookup ~line 564, `railButtons` ~line 583, `openRail` ~line 621, `closeRail` ~line 644, panel instantiation after the Beacon block ~line 906, ⌘⌥R handler after the ⌘⌥K handler ~line 2245)
- Modify: `ui/src/styles.css` (grid rules after the Beacon block ~line 16356; full-page hide rules at ~line 3373; tabbar-left full-page collapse at ~line 3426)

**Interfaces:**
- Consumes: Task 5's `SomnusPanel` (`constructor(host, { onClose })`, `render()`, `close()`), `RightRailController.toggle("somnus")`.
- Produces: working end-to-end panel — titlebar moon button, `body.sidebar-view-somnus` grid, ⌘⌥R toggle.

- [ ] **Step 1: index.html — button + aside**

After the `#titlebar-beacon` button (line ~645), before `#titlebar-cdlc`:

```html
        <button
          id="titlebar-somnus"
          class="titlebar-icon-btn titlebar-view-btn"
          type="button"
          aria-label="Somnus REST client"
        ></button>
```

After `<aside id="beacon-panel" class="hidden"></aside>` (line ~705):

```html
      <aside id="somnus-panel" class="hidden"></aside>
```

- [ ] **Step 2: right-rail.ts — extend the union**

In `ui/src/titlebar/right-rail.ts`, the `RailTarget` union (line 4–14): add after `| "beacon"`:

```ts
  | "somnus";
```

(and change the `| "beacon";` line to `| "beacon"`.)

- [ ] **Step 3: icons — add `moon`**

In `ui/src/icons/index.ts`, before the closing `};` of the `Icons` object (after `radioTower`):

```ts
  /** Crescent moon — Somnus (REST client) panel. */
  moon: (o?: IconOptions): string =>
    svg(`<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>`, o),
```

- [ ] **Step 4: main.ts wiring (six edits)**

(a) Imports — next to the Beacon imports (~line 61):

```ts
import "./somnus/somnus.css";
import { SomnusPanel } from "./somnus/panel";
```

(b) Button lookup — after `const beaconBtn = ...` (~line 564):

```ts
  const somnusBtn = document.getElementById("titlebar-somnus");
```

(c) `railButtons` map (~line 583) — after `beacon: beaconBtn,`:

```ts
    somnus: somnusBtn,
```

(d) `openRail` switch (~line 621) — after the `case "beacon":` block:

```ts
      case "somnus":
        openSomnusPanel();
        break;
```

`closeRail` switch (~line 644) — after the `case "beacon":` block:

```ts
      case "somnus":
        closeSomnusPanel();
        break;
```

(e) Panel instantiation — after the Beacon block (after the `if (beaconBtn) {...}` at ~line 906):

```ts
  // Somnus sidebar — REST client (composer + history).
  const somnusPanelHost = requireEl<HTMLElement>("somnus-panel");
  const somnusPanel = new SomnusPanel(somnusPanelHost, {
    onClose: () => rail.toggle("somnus"),
  });
  const closeSomnusPanel = (): void => {
    if (!document.body.classList.contains("sidebar-view-somnus")) return;
    document.body.classList.remove("sidebar-view-somnus");
    somnusPanelHost.classList.add("hidden");
    somnusPanel.close();
  };
  const openSomnusPanel = (): void => {
    document.body.classList.add("sidebar-view-somnus");
    somnusPanelHost.classList.remove("hidden");
    somnusPanel.render();
  };

  if (somnusBtn) {
    somnusBtn.innerHTML = Icons.moon({ size: 14 });
    attachTooltip(somnusBtn, "Somnus (⌘⌥R)");
    somnusBtn.addEventListener("click", () => rail.toggle("somnus"));
  }
```

NOTE: `openSomnusPanel`/`closeSomnusPanel` are referenced by `openRail`/`closeRail` (defined earlier in the file) — that's fine, the switch arms only run on user interaction after boot, same as `openBeaconPanel`. Keep the same declaration order Beacon uses (function consts after the rail controller): if `tsc` complains about use-before-declare here, convert the two consts to `function` declarations.

(f) Keyboard shortcut — after the ⌘⌥K Tasker handler (~line 2245):

```ts
    // ⌘⌥R → Somnus REST client sidebar. "®" is what ⌥R produces on macOS
    // keyboards, so match it alongside the plain letter (same pattern as
    // the ⌘⌥T "†" and ⌘⌥N "˜" handlers).
    if (e.metaKey && e.altKey && !e.shiftKey && (e.key === "r" || e.key === "R" || e.key === "®")) {
      e.preventDefault();
      somnusBtn?.click();
      return;
    }
```

Before adding, verify the chord is still free: `grep -n 'metaKey && e.altKey' ui/src/main.ts` must show no other handler matching `"r"` without shiftKey.

- [ ] **Step 5: styles.css — grid rules + full-page hide rules**

(a) After the Beacon block (after line ~16356, before the `/* TASKER Board */` comment):

```css
/* Somnus sidebar — REST client (same layout as beacon) */
body.sidebar-view-somnus:not(.blocks-globally-collapsed):not(.tabbar-left) #layout {
  grid-template-columns: minmax(0, 1fr) var(--right-sidebar-w);
}
body.sidebar-view-somnus:not(.blocks-globally-collapsed):not(.tabbar-left) #tabbar-host,
body.sidebar-view-somnus:not(.blocks-globally-collapsed):not(.tabbar-left) #status-bar {
  grid-column: 1 / -1;
}
body.sidebar-view-somnus.tabbar-left:not(.blocks-globally-collapsed) #layout {
  grid-template-columns: var(--tabbar-w) minmax(0, 1fr) var(--right-sidebar-w);
}
body.sidebar-view-somnus.tabbar-left:not(.blocks-globally-collapsed) #somnus-panel {
  grid-row: 1 / 2;
  grid-column: 3 / 4;
}
body.sidebar-view-somnus.tabbar-left:not(.blocks-globally-collapsed) #status-bar {
  grid-column: 1 / -1;
}
body.sidebar-view-somnus:not(.blocks-globally-collapsed) .tab-pane {
  grid-template-columns: 1fr 0 0 0 !important;
}
body.sidebar-view-somnus:not(.blocks-globally-collapsed) .tab-blocks {
  display: none !important;
}
body.sidebar-view-somnus .tab-pane:has(.editor-host:not([hidden])) > .editor-host {
  right: 0 !important;
}
```

(b) Full-page route hide rules — in the selector list ending at line ~3373 (`...#capabilities-page:not([hidden])) #beacon-panel {`), extend with six more selectors before the `{`:

```css
#layout:has(> #settings-page:not([hidden])) #somnus-panel,
#layout:has(> #docs-page:not([hidden])) #somnus-panel,
#layout:has(> #drafts-page:not([hidden])) #somnus-panel,
#layout:has(> #mission-page:not([hidden])) #somnus-panel,
#layout:has(> #operator-page:not([hidden])) #somnus-panel,
#layout:has(> #capabilities-page:not([hidden])) #somnus-panel
```

(comma-join onto the existing list — the last existing selector gets a trailing comma.)

(c) tabbar-left full-page column collapse — in the selector list ending at line ~3426 (`body.tabbar-left.sidebar-view-beacon ... #capabilities-page...`), extend the same way:

```css
body.tabbar-left.sidebar-view-somnus #layout:has(> #settings-page:not([hidden])),
body.tabbar-left.sidebar-view-somnus #layout:has(> #docs-page:not([hidden])),
body.tabbar-left.sidebar-view-somnus #layout:has(> #drafts-page:not([hidden])),
body.tabbar-left.sidebar-view-somnus #layout:has(> #mission-page:not([hidden])),
body.tabbar-left.sidebar-view-somnus #layout:has(> #operator-page:not([hidden])),
body.tabbar-left.sidebar-view-somnus #layout:has(> #capabilities-page:not([hidden]))
```

- [ ] **Step 6: Verify — type-check + full vitest**

Run: `npm run build 2>&1 | tail -5`
Expected: clean tsc + vite build. The `RailTarget` union extension forces `railButtons` completeness — if you missed the map entry, tsc fails here (that's the union doing its job).

Run: `npm test 2>&1 | tail -4`
Expected: same 6 pre-existing failures, zero new; the two somnus suites pass.

- [ ] **Step 7: Commit**

```bash
git add ui/index.html ui/src/titlebar/right-rail.ts ui/src/icons/index.ts ui/src/main.ts ui/src/styles.css
git commit -m "feat(somnus): wire rail panel — moon titlebar button, RailTarget, grid CSS, cmd-opt-R

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Verification pass

**Files:**
- No new files. Fixes only if checks fail.

**Interfaces:** none — this task gates the branch.

- [ ] **Step 1: Rust — targeted tests, fmt, clippy**

Run: `cargo test -p covenant somnus 2>&1 | tail -3`
Expected: 13 passed.

Run: `cargo fmt --all && git diff --stat`
Expected: no diff (or commit the fmt fixes with the fixes below).

Run: `cargo clippy -p covenant --all-targets 2>&1 | grep -E "^(warning|error).*somnus" | head`
Expected: no somnus-related warnings. Pre-existing warnings in other modules are not yours.

- [ ] **Step 2: Frontend — full suite + build**

Run: `npm test 2>&1 | tail -4`
Expected: 6 pre-existing failures only (baseline), all somnus tests green.

Run: `npm run build 2>&1 | tail -3`
Expected: clean.

- [ ] **Step 3: Fix anything found, commit fixes**

```bash
git add -A
git commit -m "chore(somnus): fmt/clippy/test fixes from verification pass

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

(Skip the commit if nothing changed.)

- [ ] **Step 4: In-app smoke test (needs the running app)**

Run `npm run tauri:dev` (or the `respawn` skill from the main session) and verify by hand — this is the `verify` skill's job at integration time:
1. Moon button appears in the titlebar; click opens the Somnus rail; ⌘⌥R toggles it.
2. GET `https://api.github.com/zen` → 200, text body, duration/size line.
3. Paste `curl -X POST https://httpbin.org/post -H 'Content-Type: application/json' -d '{"a":1}'` into the URL field → composer fills; Send → 200 JSON pretty-printed.
4. Kill the network (or use `http://127.0.0.1:1/`) → shaped error card, history row with fail spine.
5. History rows: click loads the request back; hover-delete removes; trash-in-header clears (with confirm).
6. Expand button → fullscreen (history left column, response main); Esc collapses; close while expanded resets.
7. Open Settings while the panel is open → panel hides, no reserved-column gap (both tabbar modes).

---

## Out of Scope (per spec)

Collections, environments/variables, auth helpers, WebSocket/GraphQL/gRPC, OpenAPI/Postman import, and the v2 operator tool (`teammate/somnus_tools.rs` seam is documented in the spec §v2 — do NOT build it here).
