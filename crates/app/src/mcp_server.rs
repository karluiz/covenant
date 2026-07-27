//! Covenant MCP server — localhost streamable-http endpoint exposing app
//! functionality (tasks, notes) to executors. See
//! docs/superpowers/specs/2026-07-27-covenant-mcp-server-design.md.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::{
    body::Body,
    extract::State,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};
use tauri::Manager;

/// Port + token of the running server, managed as tauri state so spawn
/// paths (ACP injection) and `mcp-config` printing can read them.
// Unread within this task — consumers land with ACP injection / mcp-config
// printing in a later task.
#[allow(dead_code)]
#[derive(Debug, Clone)]
pub struct McpRuntime {
    pub port: u16,
    pub token: String,
}

pub(crate) fn new_token() -> String {
    // ponytail: two ulids ≈ 160 bits incl. timestamp; enough behind a
    // 0600 file on localhost. Swap for a CSPRNG hex string if this ever
    // leaves the machine.
    format!("{}{}", ulid::Ulid::new(), ulid::Ulid::new()).to_lowercase()
}

pub(crate) fn write_discovery_file(path: &Path, port: u16, token: &str) -> Result<(), String> {
    let payload = serde_json::json!({
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "token": token,
    });
    let rendered = serde_json::to_string_pretty(&payload).map_err(|e| e.to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(path, rendered).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub(crate) fn remove_discovery_at(path: &Path) {
    let _ = std::fs::remove_file(path);
}

pub(crate) fn discovery_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(dir.join("mcp.json"))
}

/// Best-effort cleanup, called from the ExitRequested handler in lib.rs.
pub fn remove_discovery_file(app: &tauri::AppHandle) {
    if let Ok(p) = discovery_path(app) {
        remove_discovery_at(&p);
    }
}

/// Axum middleware: require `Authorization: Bearer <state>`.
pub(crate) async fn require_bearer(
    State(expected): State<String>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    let ok = req
        .headers()
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t == expected)
        .unwrap_or(false);
    if ok {
        Ok(next.run(req).await)
    } else {
        Err(StatusCode::UNAUTHORIZED)
    }
}

/// The MCP handler. Tools arrive in Tasks 3–4; for now it serves an empty
/// tool list so `initialize` + `tools/list` round-trip.
// `app` and `tool_router` are unread until `#[tool]` methods land in Tasks
// 3-4 (the tool_router macro wires `tool_router` in; tool bodies use `app`).
#[allow(dead_code)]
#[derive(Clone)]
pub struct CovenantMcp {
    pub app: tauri::AppHandle,
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
}

#[rmcp::tool_router]
impl CovenantMcp {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            tool_router: Self::tool_router(),
        }
    }
}

#[rmcp::tool_handler]
impl rmcp::ServerHandler for CovenantMcp {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo::default().with_instructions(
            "Covenant terminal control surface. Task tools operate on \
             operator tasks; notes tools on project notes. If you don't \
             know your ids, read $COVENANT_TASK_ID / $COVENANT_GROUP_ID.",
        )
    }
}

/// Bind an ephemeral localhost port, write the discovery file, serve
/// forever on a spawned task. Called once from lib.rs setup.
pub fn start(app: tauri::AppHandle) -> Result<(), String> {
    let token = new_token();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = serve(app, token).await {
            tracing::error!(error = %e, "covenant mcp server failed");
        }
    });
    Ok(())
}

async fn serve(app: tauri::AppHandle, token: String) -> Result<(), String> {
    use rmcp::transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();

    let handler_app = app.clone();
    let service = StreamableHttpService::new(
        move || Ok(CovenantMcp::new(handler_app.clone())),
        Arc::new(LocalSessionManager::default()),
        StreamableHttpServerConfig::default(),
    );
    let router = axum::Router::new().nest_service("/mcp", service).layer(
        axum::middleware::from_fn_with_state(token.clone(), require_bearer),
    );

    write_discovery_file(&discovery_path(&app)?, port, &token)?;
    app.manage(McpRuntime { port, token });
    tracing::info!(port, "covenant mcp server listening");
    axum::serve(listener, router)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_is_long_and_random() {
        let a = new_token();
        let b = new_token();
        assert!(a.len() >= 32);
        assert_ne!(a, b);
    }

    #[test]
    fn discovery_file_written_0600_and_removed() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("mcp.json");
        write_discovery_file(&path, 43210, "tok123").unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["url"], "http://127.0.0.1:43210/mcp");
        assert_eq!(v["token"], "tok123");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        remove_discovery_at(&path);
        assert!(!path.exists());
    }

    #[tokio::test]
    async fn auth_middleware_rejects_bad_token() {
        use axum::{body::Body, http::Request, routing::get, Router};
        use tower::ServiceExt;
        let app = Router::new().route("/mcp", get(|| async { "ok" })).layer(
            axum::middleware::from_fn_with_state("secret".to_string(), require_bearer),
        );
        let no_auth = Request::builder().uri("/mcp").body(Body::empty()).unwrap();
        let res = app.clone().oneshot(no_auth).await.unwrap();
        assert_eq!(res.status(), 401);
        let good = Request::builder()
            .uri("/mcp")
            .header("authorization", "Bearer secret")
            .body(Body::empty())
            .unwrap();
        let res = app.oneshot(good).await.unwrap();
        assert_eq!(res.status(), 200);
    }
}
