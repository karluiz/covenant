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
