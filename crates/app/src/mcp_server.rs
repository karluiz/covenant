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
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use schemars::JsonSchema;
use serde::Deserialize;
use tauri::Manager;

use crate::storage::Storage;
use crate::teammate::{TaskId, TaskStatus};

/// Port + token of the running server, managed as tauri state so spawn
/// paths (ACP injection) and `mcp-config` printing can read them.
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

    // Create at 0600 in the same syscall that creates the file — a
    // create-then-chmod sequence has a window where the token sits in a
    // world-readable file at the umask-default mode.
    #[cfg(unix)]
    {
        use std::io::Write as _;
        use std::os::unix::fs::OpenOptionsExt as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(path)
            .map_err(|e| e.to_string())?;
        file.write_all(rendered.as_bytes())
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(unix))]
    {
        std::fs::write(path, rendered).map_err(|e| e.to_string())?;
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

/// Pure shape of the ACP `session/new`/`session/load` `mcpServers` entry
/// (ACP http variant). Split out from [`acp_entry`] so the shape is
/// testable without a running `McpRuntime`.
fn acp_entry_json(port: u16, token: &str) -> serde_json::Value {
    serde_json::json!({
        "name": "covenant",
        "type": "http",
        "url": format!("http://127.0.0.1:{port}/mcp"),
        "headers": [{ "name": "Authorization", "value": format!("Bearer {token}") }],
    })
}

/// ACP `session/new` mcpServers entry (ACP http variant). None if the
/// server isn't up yet (rare — `start` manages the state before it starts
/// accepting connections, but a spawn racing very early boot could still
/// see it absent).
pub fn acp_entry(app: &tauri::AppHandle) -> Option<serde_json::Value> {
    let rt = app.try_state::<McpRuntime>()?;
    Some(acp_entry_json(rt.port, &rt.token))
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

/// The MCP handler. Hosts both task tools (`task_list`/`task_complete`/
/// `task_create`) and notes tools (`notes_read`/`notes_append`).
#[derive(Clone)]
pub struct CovenantMcp {
    pub app: tauri::AppHandle,
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TaskListArgs {
    /// Filter: "draft" | "active" | "blocked" | "done" | "cancelled". Omit for all.
    pub status: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct TaskCompleteArgs {
    /// The task to mark done. If you were spawned by Covenant, this is $COVENANT_TASK_ID.
    pub task_id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct TaskCreateArgs {
    /// Existing task this follow-up belongs to (usually your own task id).
    pub parent_task_id: String,
    pub title: String,
    pub body: Option<String>,
}

#[derive(Deserialize, JsonSchema)]
pub struct NotesReadArgs {
    /// Project group id. If spawned by Covenant, $COVENANT_GROUP_ID.
    pub group_id: String,
    /// Max notes to return, newest first. Default 20.
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct NotesAppendArgs {
    pub group_id: String,
    pub body: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Parse a task id, echoing the offending input on failure so the model can
/// tell "I typo'd the id" from "the tool is broken".
fn parse_task_id(s: &str) -> Result<TaskId, String> {
    ulid::Ulid::from_string(s)
        .map(TaskId)
        .map_err(|e| format!("bad task id {s:?}: {e}"))
}

fn parse_status(s: &str) -> Result<TaskStatus, String> {
    match s {
        "draft" => Ok(TaskStatus::Draft),
        "active" => Ok(TaskStatus::Active),
        "blocked" => Ok(TaskStatus::Blocked),
        "done" => Ok(TaskStatus::Done),
        "cancelled" => Ok(TaskStatus::Cancelled),
        other => Err(format!(
            "bad status {other:?}: expected draft|active|blocked|done|cancelled"
        )),
    }
}

#[rmcp::tool_router]
impl CovenantMcp {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self {
            app,
            tool_router: Self::tool_router(),
        }
    }

    fn storage(&self) -> Arc<Storage> {
        self.app.state::<Arc<Storage>>().inner().clone()
    }

    fn notes(&self) -> crate::project_notes::Store {
        self.app
            .state::<crate::project_notes::Store>()
            .inner()
            .clone()
    }

    #[rmcp::tool(description = "List Covenant operator tasks, optionally filtered by status.")]
    async fn task_list(
        &self,
        params: Parameters<TaskListArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let status = match params.0.status.as_deref() {
            None => None,
            Some(s) => Some(parse_status(s).map_err(|e| rmcp::ErrorData::invalid_params(e, None))?),
        };
        match self.storage().teammate_list_tasks_all(status).await {
            Ok(tasks) => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&tasks).unwrap_or_default(),
            )])),
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(
                e.to_string(),
            )])),
        }
    }

    #[rmcp::tool(
        description = "Mark a Covenant task done — same effect as the UI 'Mark done', including operator release."
    )]
    async fn task_complete(
        &self,
        params: Parameters<TaskCompleteArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let id = parse_task_id(&params.0.task_id)
            .map_err(|e| rmcp::ErrorData::invalid_params(e, None))?;
        match crate::teammate::commands::complete_task_full(&self.app, id).await {
            Ok(()) => Ok(CallToolResult::success(vec![ContentBlock::text(
                "task marked done",
            )])),
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(e)])),
        }
    }

    #[rmcp::tool(
        description = "Create a follow-up task on the Covenant board, owned by the parent task's operator."
    )]
    async fn task_create(
        &self,
        params: Parameters<TaskCreateArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let parent = parse_task_id(&params.0.parent_task_id)
            .map_err(|e| rmcp::ErrorData::invalid_params(e, None))?;
        let storage = self.storage();
        match crate::teammate::commands::create_followup_task_inner(
            &storage,
            parent,
            params.0.title,
            params.0.body.unwrap_or_default(),
            now_ms(),
        )
        .await
        {
            Ok(task) => {
                use tauri::Emitter;
                let _ = self.app.emit("teammate-task", &task);
                Ok(CallToolResult::success(vec![ContentBlock::text(
                    serde_json::to_string_pretty(&task).unwrap_or_default(),
                )]))
            }
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(e)])),
        }
    }

    #[rmcp::tool(description = "Read recent Covenant project notes for a group, newest first.")]
    async fn notes_read(
        &self,
        params: Parameters<NotesReadArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let limit = params.0.limit.unwrap_or(20) as usize;
        match self
            .notes()
            .list_notes(&params.0.group_id, limit, None)
            .await
        {
            Ok(notes) => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&notes).unwrap_or_default(),
            )])),
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(
                e.to_string(),
            )])),
        }
    }

    #[rmcp::tool(description = "Append a note to a Covenant project group's notes.")]
    async fn notes_append(
        &self,
        params: Parameters<NotesAppendArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self
            .notes()
            .append_note(&params.0.group_id, &params.0.body, Some("mcp"))
            .await
        {
            Ok(note) => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&note).unwrap_or_default(),
            )])),
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(
                e.to_string(),
            )])),
        }
    }
}

#[rmcp::tool_handler(router = self.tool_router)]
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
            // Exercises the atomic OpenOptions().mode(0o600) create path —
            // there is no create-then-chmod window for a concurrent reader
            // to observe a wider mode.
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

    #[test]
    fn parse_task_id_roundtrips_a_valid_ulid() {
        let id = TaskId::new();
        let parsed = parse_task_id(&id.0.to_string()).expect("valid ulid parses");
        assert_eq!(parsed, id);
    }

    #[test]
    fn parse_task_id_bad_id_echoes_input() {
        let err = parse_task_id("not-a-ulid").unwrap_err();
        assert!(err.contains("not-a-ulid"), "got: {err}");
    }

    #[test]
    fn acp_entry_json_has_the_acp_http_shape() {
        let v = acp_entry_json(43210, "tok123");
        assert_eq!(v["name"], "covenant");
        assert_eq!(v["type"], "http");
        assert_eq!(v["url"], "http://127.0.0.1:43210/mcp");
        assert_eq!(v["headers"][0]["name"], "Authorization");
        assert_eq!(v["headers"][0]["value"], "Bearer tok123");
    }

    #[test]
    fn parse_status_covers_all_variants_and_rejects_unknown() {
        assert_eq!(parse_status("draft").unwrap(), TaskStatus::Draft);
        assert_eq!(parse_status("active").unwrap(), TaskStatus::Active);
        assert_eq!(parse_status("blocked").unwrap(), TaskStatus::Blocked);
        assert_eq!(parse_status("done").unwrap(), TaskStatus::Done);
        assert_eq!(parse_status("cancelled").unwrap(), TaskStatus::Cancelled);
        let err = parse_status("bogus").unwrap_err();
        assert!(err.contains("bogus"), "got: {err}");
    }
}
