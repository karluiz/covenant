//! 3.26 — MCP client for the operator loop.
//!
//! Connects to user-configured streamable-http MCP servers
//! (`Settings.mcp_servers`) gated per-operator by the registry
//! allowlist. HTTP only — no stdio (spawning child processes from
//! operator config is a command-execution surface that needs its own
//! safety review; see the blocklist rules in `crates/agent/src/safety.rs`).
//!
//! Lifecycle: connections are established at dispatch time in
//! `commands.rs` (bounded by [`CONNECT_TIMEOUT`], failures skip the
//! server), live inside the `ToolEnv` for the duration of one LLM turn,
//! and are dropped with it. No persistent pool.

use rmcp::model::{CallToolRequestParams, Tool};
use rmcp::service::{RoleClient, RunningService};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig;
use rmcp::transport::StreamableHttpClientTransport;
use rmcp::ServiceExt;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

/// Per-server budget for connect + initialize + tools/list. A dead
/// server must never stall the operator's reply.
pub const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);

/// Per-call budget for tools/call.
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// Tool names must satisfy the LLM API's `^[a-zA-Z0-9_-]{1,128}$`.
const MAX_TOOL_NAME_LEN: usize = 128;

/// One live MCP server connection scoped to a dispatch. Cloned freely
/// (the service handle is shared); the connection closes when the last
/// clone drops.
#[derive(Clone)]
pub struct McpConn {
    /// Normalized server name (`[a-z0-9_-]`, enforced on settings save).
    pub name: String,
    /// tools/list result, already filtered to LLM-representable names.
    pub tools: Vec<Tool>,
    service: Arc<RunningService<RoleClient, ()>>,
}

impl std::fmt::Debug for McpConn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("McpConn")
            .field("name", &self.name)
            .field("tools", &self.tools.len())
            .finish()
    }
}

impl McpConn {
    /// Connect to a streamable-http MCP server and list its tools.
    /// `headers` are sent verbatim on every request; invalid header
    /// names/values are skipped (logged), not fatal.
    pub async fn connect(
        name: &str,
        url: &str,
        headers: &[(String, String)],
    ) -> Result<Self, String> {
        ensure_crypto_provider();
        let mut custom_headers = HashMap::new();
        for (k, v) in headers {
            match (
                k.parse::<http::HeaderName>(),
                v.parse::<http::HeaderValue>(),
            ) {
                (Ok(hk), Ok(hv)) => {
                    custom_headers.insert(hk, hv);
                }
                _ => tracing::warn!(server = name, header = %k, "invalid MCP header skipped"),
            }
        }
        let mut config = StreamableHttpClientTransportConfig::with_uri(url.to_string());
        config.custom_headers = custom_headers;
        config.allow_stateless = true;
        let transport = StreamableHttpClientTransport::from_config(config);
        let fut = async {
            let service = ().serve(transport).await.map_err(|e| e.to_string())?;
            let tools = service.list_all_tools().await.map_err(|e| e.to_string())?;
            Ok::<_, String>((service, tools))
        };
        let (service, tools) = tokio::time::timeout(CONNECT_TIMEOUT, fut)
            .await
            .map_err(|_| format!("timed out after {CONNECT_TIMEOUT:?}"))??;
        let prefix_len = "mcp__".len() + name.len() + "__".len();
        let tools = tools
            .into_iter()
            .filter(|t| {
                let ok = prefix_len + t.name.len() <= MAX_TOOL_NAME_LEN
                    && t.name
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
                if !ok {
                    tracing::warn!(server = name, tool = %t.name, "MCP tool name not LLM-representable; skipped");
                }
                ok
            })
            .collect();
        Ok(Self {
            name: name.to_string(),
            tools,
            service: Arc::new(service),
        })
    }

    /// Call one tool; flatten the result's text content blocks.
    /// `is_error: true` results come back as `Err` so the LLM turn sees
    /// them as tool failures, same as native tools.
    pub async fn call(&self, tool: &str, args: serde_json::Value) -> Result<String, String> {
        let arguments = match args {
            serde_json::Value::Object(map) => Some(map),
            serde_json::Value::Null => None,
            other => return Err(format!("arguments must be an object, got {other}")),
        };
        let mut params = CallToolRequestParams::default();
        params.name = tool.to_string().into();
        params.arguments = arguments;
        let fut = self.service.call_tool(params);
        let result = tokio::time::timeout(CALL_TIMEOUT, fut)
            .await
            .map_err(|_| format!("timed out after {CALL_TIMEOUT:?}"))?
            .map_err(|e| e.to_string())?;
        let mut text: String = result
            .content
            .iter()
            .filter_map(|c| c.as_text().map(|t| t.text.as_str()))
            .collect::<Vec<_>>()
            .join("\n");
        if text.is_empty() {
            if let Some(s) = &result.structured_content {
                text = s.to_string();
            }
        }
        if result.is_error.unwrap_or(false) {
            return Err(if text.is_empty() {
                "tool returned an error".into()
            } else {
                text
            });
        }
        Ok(text)
    }
}

/// rmcp's reqwest 0.13 transport builds its client against the
/// process-level rustls default provider, which nothing else in the app
/// installs (our own reqwest 0.12 picks ring explicitly). Without this,
/// the first MCP connect panics with "No provider set".
fn ensure_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

/// LLM tool def for one MCP tool, namespaced `mcp__<server>__<tool>`.
fn tool_def(server: &str, t: &Tool) -> serde_json::Value {
    serde_json::json!({
        "name": format!("mcp__{server}__{}", t.name),
        "description": t.description.as_deref().unwrap_or(""),
        "input_schema": &*t.input_schema,
    })
}

/// LLM tool defs for every tool on every connected server.
pub fn tool_defs(conns: &[McpConn]) -> Vec<serde_json::Value> {
    conns
        .iter()
        .flat_map(|c| c.tools.iter().map(|t| tool_def(&c.name, t)))
        .collect()
}

/// Split a namespaced `mcp__<server>__<tool>` name. `None` when the
/// name isn't MCP-namespaced.
pub fn split_tool_name(name: &str) -> Option<(&str, &str)> {
    name.strip_prefix("mcp__")?.split_once("__")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn split_tool_name_roundtrip() {
        assert_eq!(
            split_tool_name("mcp__infra__get_status"),
            Some(("infra", "get_status"))
        );
        // First `__` after the server name splits; tool keeps the rest.
        assert_eq!(split_tool_name("mcp__a__b__c"), Some(("a", "b__c")));
        assert_eq!(split_tool_name("read_file"), None);
        assert_eq!(split_tool_name("mcp__noseparator"), None);
    }

    #[test]
    fn tool_def_namespaces_and_maps_schema() {
        let tool: Tool = serde_json::from_value(serde_json::json!({
            "name": "get_status",
            "description": "Get status",
            "inputSchema": {"type": "object", "properties": {"env": {"type": "string"}}}
        }))
        .expect("tool json");
        let def = tool_def("infra", &tool);
        assert_eq!(def["name"], "mcp__infra__get_status");
        assert_eq!(def["input_schema"]["properties"]["env"]["type"], "string");
    }

    // ---- E2E against an in-process streamable-http rmcp server ----

    #[derive(Clone)]
    struct EchoServer {
        tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
    }

    #[derive(serde::Deserialize, schemars::JsonSchema)]
    struct EchoArgs {
        text: String,
    }

    #[rmcp::tool_router]
    impl EchoServer {
        fn new() -> Self {
            Self {
                tool_router: Self::tool_router(),
            }
        }

        #[rmcp::tool(description = "Echo the input back")]
        async fn echo(
            &self,
            params: rmcp::handler::server::wrapper::Parameters<EchoArgs>,
        ) -> Result<rmcp::model::CallToolResult, rmcp::ErrorData> {
            Ok(rmcp::model::CallToolResult::success(vec![
                rmcp::model::ContentBlock::text(format!("echo: {}", params.0.text)),
            ]))
        }

        #[rmcp::tool(description = "Always fails")]
        async fn boom(&self) -> Result<rmcp::model::CallToolResult, rmcp::ErrorData> {
            Ok(rmcp::model::CallToolResult::error(vec![
                rmcp::model::ContentBlock::text("kaput"),
            ]))
        }
    }

    #[rmcp::tool_handler(router = self.tool_router)]
    impl rmcp::ServerHandler for EchoServer {}

    /// Serve EchoServer on an ephemeral port; returns its /mcp URL.
    async fn spawn_echo_server() -> String {
        use rmcp::transport::streamable_http_server::{
            session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
        };
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let port = listener.local_addr().expect("addr").port();
        let service = StreamableHttpService::new(
            || Ok(EchoServer::new()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default(),
        );
        let router = axum::Router::new().nest_service("/mcp", service);
        tokio::spawn(async move {
            let _ = axum::serve(listener, router).await;
        });
        format!("http://127.0.0.1:{port}/mcp")
    }

    #[tokio::test]
    async fn connect_lists_and_calls_end_to_end() {
        let url = spawn_echo_server().await;
        let conn = McpConn::connect("echo", &url, &[]).await.expect("connect");
        let names: Vec<_> = conn.tools.iter().map(|t| t.name.as_ref()).collect();
        assert!(names.contains(&"echo"), "tools/list: {names:?}");
        let defs = tool_defs(std::slice::from_ref(&conn));
        assert!(defs.iter().any(|d| d["name"] == "mcp__echo__echo"));

        let out = conn
            .call("echo", serde_json::json!({"text": "hola"}))
            .await
            .expect("call");
        assert_eq!(out, "echo: hola");

        // is_error results surface as Err, like native tool failures.
        let err = conn
            .call("boom", serde_json::json!({}))
            .await
            .expect_err("boom must err");
        assert!(err.contains("kaput"));
    }

    #[tokio::test]
    async fn connect_to_dead_server_errors_fast() {
        // Port 9 (discard) on localhost is closed; connect must fail
        // within CONNECT_TIMEOUT, not hang.
        let start = std::time::Instant::now();
        let res = McpConn::connect("dead", "http://127.0.0.1:9/mcp", &[]).await;
        assert!(res.is_err());
        assert!(start.elapsed() < CONNECT_TIMEOUT + Duration::from_secs(2));
    }
}
