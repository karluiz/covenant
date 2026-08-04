//! `covenant mcp-stdio` — stdio↔streamable-http bridge for the embedded MCP
//! server (`mcp_server.rs`).
//!
//! The server binds `127.0.0.1:0` with a fresh token every boot, so no static
//! config can name it. Harnesses that get an ACP spawn receive the endpoint
//! injected; everything else (a hand-opened `claude`, opencode, cursor) only
//! speaks stdio. Canon therefore ships a static
//! `{"command":"covenant","args":["mcp-stdio"]}` entry and this subcommand
//! resolves url+token from the discovery file at spawn time.
//!
//! ponytail: a dumb JSON-RPC pipe, not an rmcp client — every method is
//! forwarded verbatim, so new tools need no change here. Two ceilings: no GET
//! stream (server→client messages like sampling/progress never arrive), and
//! each POST's body is read to completion before it is written out, so a
//! server that held its SSE stream open would stall the bridge. Both are fine
//! while the server is request/response-only; open a GET stream if that changes.

use std::path::Path;

use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

/// `(url, token)` from the discovery file's JSON. `None` if either is missing.
pub(crate) fn endpoint(raw: &str) -> Option<(String, String)> {
    let v: serde_json::Value = serde_json::from_str(raw).ok()?;
    let url = v.get("url")?.as_str()?.to_string();
    let token = v.get("token")?.as_str()?.to_string();
    Some((url, token))
}

/// JSON-RPC payloads carried by an SSE body: the `data` field of each event,
/// with multi-line data joined by newlines. Other fields and `:` comments are
/// ignored — we only care about the messages.
pub(crate) fn sse_payloads(body: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut buf: Vec<&str> = Vec::new();
    let flush = |buf: &mut Vec<&str>, out: &mut Vec<String>| {
        if !buf.is_empty() {
            let joined = buf.join("\n");
            if !joined.trim().is_empty() {
                out.push(joined);
            }
            buf.clear();
        }
    };
    for line in body.lines() {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if line.is_empty() {
            flush(&mut buf, &mut out);
        } else if let Some(rest) = line.strip_prefix("data:") {
            buf.push(rest.strip_prefix(' ').unwrap_or(rest));
        }
    }
    flush(&mut buf, &mut out);
    out
}

/// Read the discovery file and pump stdin↔the server until stdin closes.
/// Never returns: exits 1 when the app isn't running, 0 on clean EOF.
pub fn run(discovery: &Path) -> ! {
    let Some((url, token)) = std::fs::read_to_string(discovery)
        .ok()
        .as_deref()
        .and_then(endpoint)
    else {
        eprintln!("Covenant is not running (no mcp.json discovery file).");
        std::process::exit(1);
    };
    let rt = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("covenant mcp-stdio: runtime: {e}");
            std::process::exit(1);
        }
    };
    rt.block_on(pump(url, token));
    std::process::exit(0)
}

async fn pump(url: String, token: String) {
    let client = reqwest::Client::new();
    let mut session: Option<String> = None;
    let mut lines = BufReader::new(tokio::io::stdin()).lines();
    let mut out = tokio::io::stdout();

    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let mut req = client
            .post(&url)
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .header("accept", "application/json, text/event-stream")
            .body(line);
        if let Some(s) = &session {
            req = req.header("mcp-session-id", s.clone());
        }
        let res = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                eprintln!("covenant mcp-stdio: {e}");
                continue;
            }
        };
        // The server hands out the session id on the initialize response and
        // expects it echoed on every later request.
        if let Some(v) = res
            .headers()
            .get("mcp-session-id")
            .and_then(|v| v.to_str().ok())
        {
            session = Some(v.to_string());
        }
        let is_sse = res
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .is_some_and(|v| v.contains("text/event-stream"));
        let body = res.text().await.unwrap_or_default();
        if body.trim().is_empty() {
            // 202 Accepted — a notification, nothing to hand back.
            continue;
        }
        let msgs = if is_sse {
            sse_payloads(&body)
        } else {
            vec![body.trim().to_string()]
        };
        for m in msgs {
            if out.write_all(m.as_bytes()).await.is_err() {
                return;
            }
            if out.write_all(b"\n").await.is_err() {
                return;
            }
        }
        let _ = out.flush().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_reads_url_and_token() {
        let raw = r#"{"url":"http://127.0.0.1:43210/mcp","token":"tok123"}"#;
        assert_eq!(
            endpoint(raw),
            Some(("http://127.0.0.1:43210/mcp".into(), "tok123".into()))
        );
    }

    #[test]
    fn endpoint_none_when_incomplete_or_garbage() {
        assert!(endpoint(r#"{"url":"http://x/mcp"}"#).is_none());
        assert!(endpoint("not json").is_none());
    }

    #[test]
    fn sse_payloads_extracts_one_message_per_event() {
        let body = "event: message\ndata: {\"id\":1}\n\nevent: message\ndata: {\"id\":2}\n\n";
        assert_eq!(sse_payloads(body), vec!["{\"id\":1}", "{\"id\":2}"]);
    }

    #[test]
    fn sse_payloads_joins_multiline_data_and_tolerates_no_space() {
        // `:` comment ignored, two data lines joined, no space after `data:`.
        let body = ": keepalive\r\ndata:{\"a\":\r\ndata:1}\r\n\r\n";
        assert_eq!(sse_payloads(body), vec!["{\"a\":\n1}"]);
    }

    #[test]
    fn sse_payloads_empty_for_no_data() {
        assert!(sse_payloads(": comment\nevent: ping\n\n").is_empty());
    }
}
