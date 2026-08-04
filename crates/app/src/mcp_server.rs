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

/// Same file as [`discovery_path`], resolved without an `AppHandle` — the CLI
/// subcommands (`mcp-config`, `mcp-stdio`) run before Tauri exists.
/// ponytail: hardcodes the release bundle id, so it points at the installed
/// app even when a dev build is running. Thread the id through if the dev
/// build ever needs to be reachable from a bare harness.
pub(crate) fn discovery_path_cli() -> Option<PathBuf> {
    dirs::data_dir().map(|d| d.join("com.karluiz.covenant").join("mcp.json"))
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
    /// The task to mark done. If you don't know it, call task_list and find
    /// the task whose spawned_session matches $COVENANT_SESSION_ID (set in
    /// your environment). $COVENANT_TASK_ID may also be set in some spawn modes.
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
    /// Project group id. If Covenant spawned you, read $COVENANT_GROUP_ID
    /// from your environment.
    pub group_id: String,
    /// Max notes to return, newest first. Default 20.
    pub limit: Option<u32>,
}

#[derive(Deserialize, JsonSchema)]
pub struct NotesAppendArgs {
    pub group_id: String,
    pub body: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct CommandsListArgs {
    /// Project group id. If Covenant spawned you, read $COVENANT_GROUP_ID
    /// from your environment.
    pub group_id: String,
}

#[derive(Deserialize, JsonSchema)]
pub struct SomnusRunArgs {
    /// Saved request id, from somnus_list.
    pub request_id: String,
}

/// Flatten the Somnus tree into request rows with a folder path. Draft blobs
/// are parsed leniently just for display (method + url); the URL is masked.
fn somnus_rows(nodes: &[crate::somnus::SomnusTreeNode]) -> Vec<serde_json::Value> {
    use std::collections::HashMap;
    let names: HashMap<&str, (&str, Option<&str>)> = nodes
        .iter()
        .map(|n| (n.id.as_str(), (n.name.as_str(), n.parent_id.as_deref())))
        .collect();
    fn path_of<'a>(
        names: &HashMap<&'a str, (&'a str, Option<&'a str>)>,
        mut parent: Option<&'a str>,
    ) -> String {
        let mut parts: Vec<&str> = Vec::new();
        while let Some(id) = parent {
            let Some((name, up)) = names.get(id) else {
                break;
            };
            parts.push(name);
            parent = *up;
        }
        parts.reverse();
        parts.join("/")
    }
    nodes
        .iter()
        .filter(|n| n.kind == "request")
        .map(|n| {
            let draft: serde_json::Value = n
                .request
                .as_deref()
                .and_then(|r| serde_json::from_str(r).ok())
                .unwrap_or_default();
            serde_json::json!({
                "id": n.id,
                "name": n.name,
                "folder": path_of(&names, n.parent_id.as_deref()),
                "method": draft.get("method").and_then(|v| v.as_str()).unwrap_or("GET"),
                "url": crate::safety::mask_secrets(
                    draft.get("url").and_then(|v| v.as_str()).unwrap_or_default(),
                ),
            })
        })
        .collect()
}

#[derive(Deserialize, JsonSchema)]
pub struct SessionOutputArgs {
    /// Terminal session id, from session_list (or your own
    /// $COVENANT_SESSION_ID).
    pub session_id: String,
    /// Most recent finished blocks to return. Default 5, max 16.
    pub max_blocks: Option<u32>,
    /// Per-block output tail size in characters. Default 4000.
    pub max_output_chars: Option<u32>,
}

/// One session_list row. Everything textual passes through
/// `safety::mask_secrets` — terminal content routinely carries tokens.
fn session_row(id: &str, world: &crate::world::SessionWorldModel) -> serde_json::Value {
    let last = world.blocks.back();
    serde_json::json!({
        "session_id": id,
        "cwd": world.cwd.to_string_lossy(),
        "title": world.title,
        "running_command": world
            .in_flight
            .as_ref()
            .map(|f| crate::safety::mask_secrets(&f.command)),
        "last_command": last.map(|b| crate::safety::mask_secrets(&b.command)),
        "last_exit_code": last.and_then(|b| b.exit_code),
        "finished_blocks": world.blocks.len(),
    })
}

/// One session_output block: output tail truncated (from the end — the
/// interesting part of long output) then secret-masked.
fn render_block(b: &crate::world::BlockSnapshot, max_chars: usize) -> serde_json::Value {
    let text = &b.output_text;
    let (truncated, tail) = if text.chars().count() > max_chars {
        let tail: String = text
            .chars()
            .skip(text.chars().count() - max_chars)
            .collect();
        (true, tail)
    } else {
        (false, text.clone())
    };
    serde_json::json!({
        "command": crate::safety::mask_secrets(&b.command),
        "cwd": b.cwd.to_string_lossy(),
        "exit_code": b.exit_code,
        "duration_ms": b.duration_ms,
        "inherited": b.inherited,
        "output_truncated": truncated,
        "output": crate::safety::mask_secrets(&tail),
    })
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

    #[rmcp::tool(
        description = "List Covenant operator tasks, optionally filtered by status. Capped at the 200 most recently created tasks."
    )]
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

    #[rmcp::tool(
        description = "List the user's open terminal sessions (PTY tabs): id, cwd, activity title, the command currently running (if any), and the last finished command. Use session_output to read a session's recent output. All text is secret-masked."
    )]
    async fn session_list(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let state = self.app.state::<crate::AppState>();
        // Clone the world handles out and drop the sessions guard before any
        // further await: ManagedSession holds non-Sync PTY types, so keeping
        // the guard across an await would make this future non-Send.
        let worlds: Vec<(
            String,
            Arc<tokio::sync::Mutex<crate::world::SessionWorldModel>>,
        )> = {
            let sessions = state.sessions.lock().await;
            sessions
                .iter()
                .map(|(id, m)| (id.to_string(), m.world.clone()))
                .collect()
        };
        let mut rows = Vec::with_capacity(worlds.len());
        for (id, world) in &worlds {
            let world = world.lock().await;
            rows.push(session_row(id, &world));
        }
        // Stable order for the caller (HashMap iteration is arbitrary).
        rows.sort_by(|a, b| {
            a["session_id"]
                .as_str()
                .unwrap_or_default()
                .cmp(b["session_id"].as_str().unwrap_or_default())
        });
        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&rows).unwrap_or_default(),
        )]))
    }

    #[rmcp::tool(
        description = "Recent finished command blocks of one terminal session, oldest first: command, exit code, duration, output tail. Output is ANSI-free and secret-masked. Read-only — there is no way to write to a session."
    )]
    async fn session_output(
        &self,
        params: Parameters<SessionOutputArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let id: karl_session::SessionId = params.0.session_id.parse().map_err(|_| {
            rmcp::ErrorData::invalid_params(
                format!("bad session id {:?}", params.0.session_id),
                None,
            )
        })?;
        let max_blocks = params.0.max_blocks.unwrap_or(5).clamp(1, 16) as usize;
        let max_chars = params.0.max_output_chars.unwrap_or(4000).clamp(200, 20_000) as usize;
        let state = self.app.state::<crate::AppState>();
        // Same non-Sync-guard rule as session_list: take the world handle,
        // drop the sessions guard, then lock.
        let world = {
            let sessions = state.sessions.lock().await;
            sessions.get(&id).map(|m| m.world.clone())
        };
        let Some(world) = world else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "no live session {id}"
            ))]));
        };
        let world = world.lock().await;
        let blocks: Vec<serde_json::Value> = world
            .blocks
            .iter()
            .rev()
            .take(max_blocks)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|b| render_block(b, max_chars))
            .collect();
        Ok(CallToolResult::success(vec![ContentBlock::text(
            serde_json::to_string_pretty(&blocks).unwrap_or_default(),
        )]))
    }

    #[rmcp::tool(
        description = "List the user's saved Somnus REST requests: id, name, folder, method, url. Use somnus_run to execute one."
    )]
    async fn somnus_list(&self) -> Result<CallToolResult, rmcp::ErrorData> {
        let store = self.app.state::<crate::somnus::Store>().inner().clone();
        match store.tree_list().await {
            Ok(nodes) => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&somnus_rows(&nodes)).unwrap_or_default(),
            )])),
            Err(e) => Ok(CallToolResult::error(vec![ContentBlock::text(
                e.to_string(),
            )])),
        }
    }

    #[rmcp::tool(
        description = "Execute one saved Somnus request by id, with the active environment's {{vars}} and its configured auth. GET/HEAD only — mutating requests must be run by the user from the Somnus UI. Returns status + body (secret-masked); the run is recorded in Somnus history."
    )]
    async fn somnus_run(
        &self,
        params: Parameters<SomnusRunArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        let store = self.app.state::<crate::somnus::Store>().inner().clone();
        let nodes = match store.tree_list().await {
            Ok(n) => n,
            Err(e) => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    e.to_string(),
                )]))
            }
        };
        let Some(node) = nodes
            .iter()
            .find(|n| n.id == params.0.request_id && n.kind == "request")
        else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "no saved request {:?} — call somnus_list for valid ids",
                params.0.request_id
            ))]));
        };
        let Some(draft) = node.request.as_deref() else {
            return Ok(CallToolResult::error(vec![ContentBlock::text(
                "saved node has no request payload",
            )]));
        };
        let vars = match store.env_list().await {
            Ok(envs) => envs
                .iter()
                .find(|e| e.is_active)
                .map(|e| crate::somnus::env_vars_map(&e.vars))
                .unwrap_or_default(),
            Err(e) => {
                return Ok(CallToolResult::error(vec![ContentBlock::text(
                    e.to_string(),
                )]))
            }
        };
        let req = match crate::somnus::compile_saved_request(draft, &vars) {
            Ok(r) => r,
            Err(e) => return Ok(CallToolResult::error(vec![ContentBlock::text(e)])),
        };
        // Safety gate: agents only fire idempotent reads. The blocklist
        // philosophy applies — loosening this needs a review, not a flag.
        let method = req.method.to_ascii_uppercase();
        if method != "GET" && method != "HEAD" {
            return Ok(CallToolResult::error(vec![ContentBlock::text(format!(
                "somnus_run only executes GET/HEAD (this request is {method}). \
                 Ask the user to run it from the Somnus UI."
            ))]));
        }
        match crate::somnus::send_and_record(&store, req).await {
            Ok(resp) => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&serde_json::json!({
                    "status": resp.status,
                    "status_text": resp.status_text,
                    "duration_ms": resp.duration_ms,
                    "size_bytes": resp.size_bytes,
                    "body_truncated": resp.body_truncated,
                    "body_binary": resp.body_binary,
                    "body": crate::safety::mask_secrets(&resp.body),
                }))
                .unwrap_or_default(),
            )])),
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

    #[rmcp::tool(
        description = "List the saved project commands (the user's runbook) for a Covenant group: how things are built, run, and deployed here."
    )]
    async fn commands_list(
        &self,
        params: Parameters<CommandsListArgs>,
    ) -> Result<CallToolResult, rmcp::ErrorData> {
        match self.notes().snapshot(&params.0.group_id).await {
            Ok(snap) => Ok(CallToolResult::success(vec![ContentBlock::text(
                serde_json::to_string_pretty(&snap.commands).unwrap_or_default(),
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

/// Advertise the tools capability explicitly: MCP clients (the Claude
/// Agent SDK among them) skip tools/list entirely when initialize reports
/// hasTools=false, leaving every tool invisible.
fn server_info() -> rmcp::model::ServerInfo {
    rmcp::model::ServerInfo::new(
        rmcp::model::ServerCapabilities::builder()
            .enable_tools()
            .build(),
    )
    .with_instructions(
        "Covenant terminal control surface. Task tools operate on \
         operator tasks; notes tools on project notes. Your ids live in \
         your environment: $COVENANT_GROUP_ID scopes the notes tools, and \
         to find your own task, call task_list and match a task's \
         spawned_session field against $COVENANT_SESSION_ID.",
    )
}

#[rmcp::tool_handler(router = self.tool_router)]
impl rmcp::ServerHandler for CovenantMcp {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        server_info()
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
    fn server_info_advertises_tools_capability() {
        // Regression: with hasTools=false the Claude Agent SDK connects but
        // never calls tools/list — every tool silently vanishes.
        let info = server_info();
        assert!(info.capabilities.tools.is_some());
        assert!(info.instructions.is_some());
    }

    fn block(command: &str, output: &str) -> crate::world::BlockSnapshot {
        crate::world::BlockSnapshot {
            command: command.into(),
            cwd: std::path::PathBuf::from("/repo"),
            exit_code: Some(0),
            duration_ms: 12,
            output_text: output.into(),
            inherited: false,
        }
    }

    #[test]
    fn render_block_masks_secrets_and_keeps_the_tail() {
        let long = format!("{}THE-END", "x".repeat(5000));
        let v = render_block(
            &block("export T=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA", &long),
            100,
        );
        assert!(!v["command"].as_str().unwrap().contains("sk-ant-api03"));
        assert!(v["output"].as_str().unwrap().ends_with("THE-END"));
        assert_eq!(v["output"].as_str().unwrap().chars().count(), 100);
        assert_eq!(v["output_truncated"], true);
    }

    #[test]
    fn session_row_masks_running_and_last_command() {
        let mut world = crate::world::SessionWorldModel {
            cwd: std::path::PathBuf::from("/repo"),
            ..Default::default()
        };
        world.blocks.push_back(block(
            "curl -H 'Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'",
            "ok",
        ));
        let v = session_row("01ARZ3", &world);
        assert!(!v["last_command"].as_str().unwrap().contains("ghp_"));
        assert_eq!(v["finished_blocks"], 1);
        assert_eq!(v["last_exit_code"], 0);
    }

    #[test]
    fn somnus_rows_builds_folder_paths_and_masks_urls() {
        let node = |id: &str, parent: Option<&str>, kind: &str, name: &str, req: Option<&str>| {
            crate::somnus::SomnusTreeNode {
                id: id.into(),
                parent_id: parent.map(String::from),
                kind: kind.into(),
                name: name.into(),
                sort: 0,
                request: req.map(String::from),
                updated_at: 0,
            }
        };
        let nodes = vec![
            node("f1", None, "folder", "Prod", None),
            node(
                "r1",
                Some("f1"),
                "request",
                "health",
                Some(
                    r#"{"method":"GET","url":"https://api.x/health?tok=ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}"#,
                ),
            ),
        ];
        let rows = somnus_rows(&nodes);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["folder"], "Prod");
        assert_eq!(rows[0]["method"], "GET");
        assert!(!rows[0]["url"].as_str().unwrap().contains("ghp_A"));
    }

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
