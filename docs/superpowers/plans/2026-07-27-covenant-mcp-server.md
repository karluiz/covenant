# Covenant MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed an MCP streamable-http server in the Tauri app so executors (spawned or external) can list/complete/create operator tasks and read/append project notes.

**Architecture:** New module `crates/app/src/mcp_server.rs` hosts an `rmcp` streamable-http server on `127.0.0.1:<ephemeral>`, authenticated by a per-boot bearer token, discovered via `<app-data>/mcp.json` (0600). Tool handlers hold a `tauri::AppHandle` and delegate to existing logic in `teammate/commands.rs` and `project_notes.rs`. Spawned ACP executors get the server injected into `session/new`'s `mcpServers` plus `COVENANT_TASK_ID`/`COVENANT_GROUP_ID` env vars; external agents use `covenant mcp-config`.

**Tech Stack:** Rust, tauri 2, tokio, rmcp (official Rust MCP SDK, streamable-http server transport), axum (rmcp's transport is a tower service), schemars (tool schemas).

**Spec:** `docs/superpowers/specs/2026-07-27-covenant-mcp-server-design.md`

## Global Constraints

- No `unwrap()` outside `#[cfg(test)]` and `main()` (repo rule).
- App-crate fallible fns return `Result<_, String>` (matches existing Tauri-command style in `crates/app`).
- Logging via `tracing` with structured fields, never string-interpolated ids.
- Conventional Commits; one feature-coherent commit per task.
- Tests sit beside their targets (`#[cfg(test)]` mod in the same file, or `tests/` per crate).
- Run Rust tests as `cargo test -p covenant-app <filter>` (check the actual package name in `crates/app/Cargo.toml` — use whatever `name = ...` says; below written as `-p app` placeholder, substitute the real name once in Task 1 and reuse).
- Do NOT run bare `cargo test --workspace` casually — telegram tests hang under broad runs (known gotcha); scope with `-p`.
- The dev build and installed build are different apps with different app-data dirs; the discovery file naturally splits because it lives under `app_data_dir()`.

## Scoping model (read before any task)

The server cannot see the caller's environment, so **tools take explicit ids**:

- `task_*` tools take `task_id` / `operator_id` as arguments.
- `notes_*` tools take `group_id`.
- Spawned executors learn their ids two ways: (1) env vars `COVENANT_TASK_ID`, `COVENANT_SESSION_ID`, `COVENANT_GROUP_ID` injected into the adapter process (agents with a shell read them), and (2) tool descriptions say "if you don't know your task id, read $COVENANT_TASK_ID".
- No cwd→task/group magic in v1.

---

### Task 1: Server skeleton — deps, token, discovery file, auth, boot

**Files:**
- Modify: `crates/app/Cargo.toml` (add deps)
- Create: `crates/app/src/mcp_server.rs`
- Modify: `crates/app/src/lib.rs` (module decl, boot in setup, discovery cleanup on `RunEvent::ExitRequested` — existing handler near `crates/app/src/lib.rs:6066`)

**Interfaces:**
- Produces: `mcp_server::start(app: tauri::AppHandle) -> Result<(), String>` (spawns the server task, writes discovery file); `mcp_server::remove_discovery_file(app: &tauri::AppHandle)`; `mcp_server::McpRuntime { pub port: u16, pub token: String }` managed via `app.manage(...)`; `mcp_server::CovenantMcp` handler struct (empty tool router for now).
- Consumes: nothing from other tasks.

- [ ] **Step 1: Add dependencies**

```bash
cd crates/app
cargo add rmcp --features server,transport-streamable-http-server
cargo add axum
cargo add schemars
```

Record the resolved rmcp version. If feature names fail, run `cargo add rmcp --features server` then check `cargo doc`/docs.rs for the streamable-http server feature name of the resolved version (it is `transport-streamable-http-server` as of rmcp 0.8.x).

- [ ] **Step 2: Write failing unit tests** (in `mcp_server.rs` `#[cfg(test)]`)

```rust
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
        let app = Router::new()
            .route("/mcp", get(|| async { "ok" }))
            .layer(axum::middleware::from_fn_with_state(
                "secret".to_string(),
                require_bearer,
            ));
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
```

If `tempfile` is not already a dev-dependency of the app crate (check `Cargo.toml`), `cargo add tempfile --dev`. If `tower` isn't available for the oneshot test, `cargo add tower --dev --features util`.

- [ ] **Step 3: Run tests to verify they fail**

Run: `cargo test -p app mcp_server`
Expected: compile FAIL (functions not defined).

- [ ] **Step 4: Implement the skeleton**

```rust
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
#[derive(Clone)]
pub struct CovenantMcp {
    pub app: tauri::AppHandle,
    tool_router: rmcp::handler::server::router::tool::ToolRouter<Self>,
}

#[rmcp::tool_router]
impl CovenantMcp {
    pub fn new(app: tauri::AppHandle) -> Self {
        Self { app, tool_router: Self::tool_router() }
    }
}

#[rmcp::tool_handler]
impl rmcp::ServerHandler for CovenantMcp {
    fn get_info(&self) -> rmcp::model::ServerInfo {
        rmcp::model::ServerInfo {
            instructions: Some(
                "Covenant terminal control surface. Task tools operate on \
                 operator tasks; notes tools on project notes. If you don't \
                 know your ids, read $COVENANT_TASK_ID / $COVENANT_GROUP_ID."
                    .into(),
            ),
            ..Default::default()
        }
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
    let router = axum::Router::new()
        .nest_service("/mcp", service)
        .layer(axum::middleware::from_fn_with_state(
            token.clone(),
            require_bearer,
        ));

    write_discovery_file(&discovery_path(&app)?, port, &token)?;
    app.manage(McpRuntime { port, token });
    tracing::info!(port, "covenant mcp server listening");
    axum::serve(listener, router).await.map_err(|e| e.to_string())
}
```

Import-path note: the `LocalSessionManager` path and `StreamableHttpService::new` signature vary slightly across rmcp minor versions — if this exact path doesn't compile, find the right one with `cargo doc -p rmcp --no-deps --open` and adjust; do not hand-roll the transport.

- [ ] **Step 5: Wire into lib.rs**

In `crates/app/src/lib.rs`: add `pub mod mcp_server;` next to the other module decls. In the tauri `setup` closure (after storage/runtime are managed), add:

```rust
if let Err(e) = crate::mcp_server::start(app.handle().clone()) {
    tracing::warn!(error = %e, "mcp server did not start");
}
```

In the existing `RunEvent::ExitRequested` arm (near `lib.rs:6066`), add `crate::mcp_server::remove_discovery_file(app_handle);` (match the variable name in scope there). A SIGKILL leaves a stale file — acceptable; `write_discovery_file` on next boot overwrites it.

- [ ] **Step 6: Run tests + clippy**

Run: `cargo test -p app mcp_server && cargo clippy -p app --all-targets`
Expected: 3 tests PASS, no new clippy warnings.

- [ ] **Step 7: Manual smoke**

Run the dev app (`npm run tauri:dev` — if port 1420 is held or incremental cache exploded, use the `respawn` skill). Then:

```bash
F=~/Library/Application\ Support/com.karluiz.covenant.dev/mcp.json
cat "$F"
URL=$(jq -r .url "$F"); TOK=$(jq -r .token "$F")
curl -s -o /dev/null -w '%{http_code}\n' "$URL"                     # expect 401
curl -s -X POST "$URL" -H "Authorization: Bearer $TOK" \
  -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
```

Expected: 401 without token; an `initialize` result with token.

- [ ] **Step 8: Commit**

```bash
git add crates/app/Cargo.toml crates/app/src/mcp_server.rs crates/app/src/lib.rs Cargo.lock
git commit -m "feat(mcp): embedded MCP server skeleton — discovery file, bearer auth"
```

---

### Task 2: Extract `complete_task_full` from the Tauri command

**Files:**
- Modify: `crates/app/src/teammate/commands.rs:978-1030` (the `teammate_complete_task` command)

**Interfaces:**
- Produces: `pub(crate) async fn complete_task_full(app: &tauri::AppHandle, task_id: crate::teammate::TaskId) -> Result<(), String>` in `crates/app/src/teammate/commands.rs` — the FULL completion path (mark done + runtime release + achievement emits + supervisor/spec-tracker cleanup + operator disable + `teammate-task`/`teammate-message` emits).
- Consumes: nothing new.

- [ ] **Step 1: Extract**

Move the entire body of `teammate_complete_task` into `complete_task_full`, resolving state from the handle instead of extractors:

```rust
/// Full completion path shared by the Tauri command and the MCP tool.
pub(crate) async fn complete_task_full(
    app: &tauri::AppHandle,
    task_id: crate::teammate::TaskId,
) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let state = app.state::<crate::AppState>();
    let storage = app.state::<Arc<Storage>>();
    let runtime = app.state::<Arc<TeammateRuntime>>();
    let supervisor = app.state::<Arc<crate::teammate::task_supervisor::TaskSupervisor>>();
    let spec_tracker = app.state::<Arc<crate::teammate::spec_edit_tracker::SpecEditTracker>>();
    // ...existing body verbatim from here (complete_task_inner call onward),
    // with `storage.inner()` → `&*storage`, etc.
    Ok(())
}

#[tauri::command]
pub async fn teammate_complete_task(
    app: tauri::AppHandle,
    task_id: crate::teammate::TaskId,
) -> Result<(), String> {
    complete_task_full(&app, task_id).await
}
```

Check the managed-state types against what `lib.rs` actually calls `.manage(...)` with (e.g. `Arc<Storage>` vs `Storage`) and match them exactly.

- [ ] **Step 2: Verify nothing broke**

Run: `cargo test -p app teammate && cargo clippy -p app --all-targets`
Expected: existing `complete_task_*` tests PASS (they target `complete_task_inner`, untouched). `cargo check` confirms the command still compiles as a Tauri handler.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/teammate/commands.rs
git commit -m "refactor(teammate): extract complete_task_full for reuse by MCP tools"
```

---

### Task 3: Task tools — `task_list`, `task_complete`, `task_create`

**Files:**
- Modify: `crates/app/src/storage.rs` (add `teammate_list_tasks_all`)
- Modify: `crates/app/src/mcp_server.rs` (three tools)
- Modify: `crates/app/src/teammate/commands.rs` (add `create_followup_task_inner`)

**Interfaces:**
- Consumes: `complete_task_full(&AppHandle, TaskId)` from Task 2; `Storage::teammate_get_task`, `Storage::teammate_insert_task` (existing, `crates/app/src/storage.rs:2960`).
- Produces: `Storage::teammate_list_tasks_all(&self, status: Option<crate::teammate::TaskStatus>) -> Result<Vec<Task>, StorageError>`; `pub(crate) async fn create_followup_task_inner(storage: &Arc<Storage>, parent: TaskId, title: String, body: String, now_ms: u64) -> Result<Task, String>` in `teammate/commands.rs`; MCP tools `task_list`, `task_complete`, `task_create`.

- [ ] **Step 1: Write failing tests for the two new inner pieces**

In `storage.rs` tests (follow the existing `teammate_*` test pattern in that file — they build an in-memory `Storage`):

```rust
#[tokio::test]
async fn list_tasks_all_filters_by_status() {
    let storage = test_storage().await; // reuse the file's existing helper name
    // insert two tasks via teammate_insert_task, mark one done via
    // teammate_mark_task_done, then:
    let all = storage.teammate_list_tasks_all(None).await.unwrap();
    assert_eq!(all.len(), 2);
    let done = storage
        .teammate_list_tasks_all(Some(crate::teammate::TaskStatus::Done))
        .await
        .unwrap();
    assert_eq!(done.len(), 1);
}
```

In `teammate/commands.rs` tests (same harness the `complete_task_*` tests use):

```rust
#[tokio::test]
async fn followup_task_inherits_operator_and_is_draft() {
    let (storage, _runtime, task) = setup_with_active_task().await; // mirror existing helper
    let f = create_followup_task_inner(&storage, task.id, "follow".into(), "body".into(), 7)
        .await
        .unwrap();
    assert_eq!(f.operator_id, task.operator_id);
    assert!(matches!(f.status, crate::teammate::TaskStatus::Draft));
    assert_eq!(f.title, "follow");
}
```

Adapt helper names to whatever the existing tests in each file actually use — read the surrounding `#[cfg(test)]` mod first.

- [ ] **Step 2: Run to verify FAIL**

Run: `cargo test -p app list_tasks_all_filters followup_task_inherits`
Expected: compile FAIL.

- [ ] **Step 3: Implement**

`teammate_list_tasks_all`: copy `teammate_list_tasks_for_operator` (`storage.rs:3270`), drop the operator WHERE clause, add optional `AND status = ?` when `status.is_some()` (serialize the status the same way the existing queries do — check how rows encode it before writing SQL).

`create_followup_task_inner`: load parent via `teammate_get_task` (error `"parent task not found"` if absent), then build and insert:

```rust
let task = Task {
    id: TaskId::new(),
    operator_id: parent.operator_id,
    archetype: parent.archetype,
    title,
    body,
    deliverable: String::new(),
    status: TaskStatus::Draft,
    scope: TaskScope::default(),
    spawned_session: None,
    created_at_unix_ms: now_ms,
    updated_at_unix_ms: now_ms,
    completed_at_unix_ms: None,
    cost_usd_cents: 0,
};
storage.teammate_insert_task(&task).await.map_err(|e| e.to_string())?;
Ok(task)
```

(Check `teammate_insert_task`'s exact signature at `storage.rs:2960` — by-ref vs by-value.)

- [ ] **Step 4: Run tests, PASS, then add the MCP tools**

In `mcp_server.rs`, inside the existing `#[rmcp::tool_router] impl CovenantMcp`:

```rust
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, Content};
use schemars::JsonSchema;
use serde::Deserialize;

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

#[rmcp::tool(description = "List Covenant operator tasks, optionally filtered by status.")]
async fn task_list(&self, params: Parameters<TaskListArgs>) -> Result<CallToolResult, rmcp::ErrorData> {
    let storage = self.storage();
    let status = match params.0.status.as_deref() {
        None => None,
        Some(s) => Some(parse_status(s).map_err(|e| rmcp::ErrorData::invalid_params(e, None))?),
    };
    match storage.teammate_list_tasks_all(status).await {
        Ok(tasks) => Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&tasks).unwrap_or_default(),
        )])),
        Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
    }
}

#[rmcp::tool(description = "Mark a Covenant task done — same effect as the UI 'Mark done', including operator release.")]
async fn task_complete(&self, params: Parameters<TaskCompleteArgs>) -> Result<CallToolResult, rmcp::ErrorData> {
    let id = parse_task_id(&params.0.task_id)
        .map_err(|e| rmcp::ErrorData::invalid_params(e, None))?;
    match crate::teammate::commands::complete_task_full(&self.app, id).await {
        Ok(()) => Ok(CallToolResult::success(vec![Content::text("task marked done")])),
        Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
    }
}

#[rmcp::tool(description = "Create a follow-up task on the Covenant board, owned by the parent task's operator.")]
async fn task_create(&self, params: Parameters<TaskCreateArgs>) -> Result<CallToolResult, rmcp::ErrorData> {
    let parent = parse_task_id(&params.0.parent_task_id)
        .map_err(|e| rmcp::ErrorData::invalid_params(e, None))?;
    let storage = self.storage();
    match crate::teammate::commands::create_followup_task_inner(
        &storage, parent, params.0.title, params.0.body.unwrap_or_default(), now_ms(),
    ).await {
        Ok(task) => {
            use tauri::Emitter;
            let _ = self.app.emit("teammate-task", &task);
            Ok(CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&task).unwrap_or_default(),
            )]))
        }
        Err(e) => Ok(CallToolResult::error(vec![Content::text(e)])),
    }
}
```

Plus small private helpers in `mcp_server.rs`: `fn storage(&self) -> Arc<Storage>` (`self.app.state::<Arc<Storage>>().inner().clone()` — match managed type), `fn parse_task_id(s: &str) -> Result<TaskId, String>` (Ulid parse, error echoes the bad id), `fn parse_status(s: &str) -> Result<TaskStatus, String>`, `fn now_ms() -> u64` (copy of `now_unix_ms`). Unit-test `parse_task_id` (bad id → Err containing the input) and `parse_status` (all five variants + unknown → Err).

- [ ] **Step 5: Run everything**

Run: `cargo test -p app mcp_server teammate storage && cargo clippy -p app --all-targets`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/mcp_server.rs crates/app/src/storage.rs crates/app/src/teammate/commands.rs
git commit -m "feat(mcp): task_list / task_complete / task_create tools"
```

---

### Task 4: Notes tools — `notes_read`, `notes_append`

**Files:**
- Modify: `crates/app/src/mcp_server.rs`

**Interfaces:**
- Consumes: `project_notes::Store::list_notes(group_id, ...)` and `Store::append_note(...)` (`crates/app/src/project_notes.rs:232,308` — read their exact signatures first; `append_note` takes a `source: Option<String>`-style field, check). The `Store` is managed state — find how `lib.rs` manages it (search `project_notes::Store` in `lib.rs`) and mirror that in a `fn notes(&self)` helper.
- Produces: MCP tools `notes_read`, `notes_append`.

- [ ] **Step 1: Add the tools**

```rust
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

#[rmcp::tool(description = "Read recent Covenant project notes for a group, newest first.")]
async fn notes_read(&self, params: Parameters<NotesReadArgs>) -> Result<CallToolResult, rmcp::ErrorData> {
    let store = self.notes();
    let limit = params.0.limit.unwrap_or(20) as i64;
    match store.list_notes(&params.0.group_id, /* match real signature; pass limit if it takes one, else truncate after */).await {
        Ok(mut notes) => {
            notes.truncate(limit as usize);
            Ok(CallToolResult::success(vec![Content::text(
                serde_json::to_string_pretty(&notes).unwrap_or_default(),
            )]))
        }
        Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
    }
}

#[rmcp::tool(description = "Append a note to a Covenant project group's notes.")]
async fn notes_append(&self, params: Parameters<NotesAppendArgs>) -> Result<CallToolResult, rmcp::ErrorData> {
    let store = self.notes();
    match store.append_note(&params.0.group_id, &params.0.body, Some("mcp".to_string())).await {
        Ok(note) => Ok(CallToolResult::success(vec![Content::text(
            serde_json::to_string_pretty(&note).unwrap_or_default(),
        )])),
        Err(e) => Ok(CallToolResult::error(vec![Content::text(e.to_string())])),
    }
}
```

The two `/* match real signature */` spots are deliberate: read `project_notes.rs:232` (`append_note`) and `:308` (`list_notes`) and call them exactly as the existing Tauri commands (`project_note_append` / `project_note_list` at `:652`/`:682`) do, including any ordering / source semantics. `source: "mcp"` marks provenance (spec). After a successful append, emit whatever event the UI listens to for note refresh — check `project_note_append`'s command body; if it emits, mirror it; if the panel refetches on demand, emit nothing.

- [ ] **Step 2: Test**

`list_notes`/`append_note` already have coverage in `project_notes.rs`; the tool bodies are thin delegation. Add one test only if you wrote real logic (e.g. truncation): a unit test on the truncation helper if extracted, else skip — no test theater.

Run: `cargo test -p app mcp_server project_notes && cargo clippy -p app --all-targets`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/mcp_server.rs
git commit -m "feat(mcp): notes_read / notes_append tools"
```

---

### Task 5: Inject the server into ACP spawns (config + env)

**Files:**
- Modify: `crates/app/src/mcp_server.rs` (entry builder)
- Modify: `crates/app/src/acp_commands.rs:962,988,1682` (the three `"mcpServers": []` sites) and the ACP spawn env path
- Modify: `crates/agent/src/acp/run.rs:30` (`AcpRunOpts`) and `:181` (its `session/new`)

**Interfaces:**
- Consumes: `McpRuntime { port, token }` managed state from Task 1.
- Produces: `mcp_server::acp_entry(app: &tauri::AppHandle) -> Option<serde_json::Value>` returning the ACP-shape server entry; `AcpRunOpts.mcp_servers: Vec<serde_json::Value>` (default empty).

- [ ] **Step 1: Entry builder + unit test**

```rust
/// ACP `session/new` mcpServers entry (ACP http variant). None if the
/// server isn't up yet.
pub fn acp_entry(app: &tauri::AppHandle) -> Option<serde_json::Value> {
    let rt = app.try_state::<McpRuntime>()?;
    Some(serde_json::json!({
        "name": "covenant",
        "type": "http",
        "url": format!("http://127.0.0.1:{}/mcp", rt.port),
        "headers": [{ "name": "Authorization", "value": format!("Bearer {}", rt.token) }],
    }))
}
```

Test the pure shape via a small `fn acp_entry_json(port: u16, token: &str) -> serde_json::Value` that `acp_entry` calls; assert name/type/url/headers.

- [ ] **Step 2: Fill the three sites in `acp_commands.rs`**

At each of `:962`, `:988`, `:1682`, replace `"mcpServers": []` with `"mcpServers": servers` where `let servers = crate::mcp_server::acp_entry(&app).into_iter().collect::<Vec<_>>();` (an `AppHandle` is in scope at each site — verify the variable name). Missing runtime → empty array, spawn proceeds (executor just lacks the tools).

- [ ] **Step 3: Thread through `AcpRunOpts` for the agent-crate path**

Add `pub mcp_servers: Vec<serde_json::Value>` (with `Default`) to `AcpRunOpts` (`run.rs:30`); use it at `run.rs:181` (`"mcpServers": opts.mcp_servers`). In `acp_commands.rs`, populate it from `acp_entry` wherever `AcpRunOpts` is constructed. The agent crate stays tauri-free — it receives plain JSON.

- [ ] **Step 4: Env vars for id discovery**

Find where the ACP adapter process env is assembled (the `AcpExecutorConfig.env` application point in `acp_commands.rs` — search `cfg.env`). Where the spawn knows them, insert `COVENANT_SESSION_ID`, and — when the spawn is operator/task-driven (the attach path, `teammate_attach_session_to_task` flow) — `COVENANT_TASK_ID`. If the spawn command receives a group/tab context from the frontend, add `COVENANT_GROUP_ID`; **if it doesn't already, do NOT plumb a new FE param in this task** — note it as a follow-up in the commit message and rely on `notes_read`'s explicit `group_id` arg (the operator prompt can carry it).

- [ ] **Step 5: Tests + manual smoke**

Run: `cargo test -p app acp && cargo test -p agent && cargo clippy --workspace --all-targets`
Expected: PASS (fix any `AcpRunOpts` construction sites the compiler flags).

Manual smoke (the real acceptance): dev app → open a claude ACP tab → ask it "list your covenant MCP tools", then "complete task <id>" against a real active task → the Tasker/teammate UI updates and the operator is released. If the claude-code-acp adapter ignores http-type `mcpServers`, record exactly what `session/new` returned and STOP — fallback (writing the entry into the claude-acp config dir prepared by `prepare_claude_acp_config`, `acp_commands.rs:626`) is a design change; surface it for review rather than improvising.

- [ ] **Step 6: Commit**

```bash
git add crates/app/src/mcp_server.rs crates/app/src/acp_commands.rs crates/agent/src/acp/run.rs
git commit -m "feat(mcp): inject covenant MCP server + id env vars into ACP spawns"
```

---

### Task 6: `covenant mcp-config` for external agents

**Files:**
- Modify: `crates/app/src/main.rs`

**Interfaces:**
- Consumes: the discovery file format from Task 1.
- Produces: `covenant mcp-config` prints a ready-to-paste MCP entry JSON to stdout and exits 0; app not running (no discovery file) → message on stderr, exit 1.

- [ ] **Step 1: Early-arg handling in `main()`**

Before the Tauri builder runs (and before single-instance forwards argv — this must exit first), add:

```rust
if std::env::args().nth(1).as_deref() == Some("mcp-config") {
    // Same dir tauri's app_data_dir resolves to; keep in sync with
    // mcp_server::discovery_path. Respect the dev bundle id if this
    // binary is the dev build (read tauri.conf identifier at compile
    // time via env!/config include if available; otherwise document
    // that mcp-config targets the installed app's path).
    let path = dirs::data_dir()
        .map(|d| d.join("com.karluiz.covenant").join("mcp.json"));
    match path.and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(raw) => {
            let v: serde_json::Value = serde_json::from_str(&raw).unwrap_or_default();
            println!(
                "{}",
                serde_json::to_string_pretty(&serde_json::json!({
                    "covenant": {
                        "type": "http",
                        "url": v["url"],
                        "headers": { "Authorization": format!("Bearer {}", v["token"].as_str().unwrap_or_default()) }
                    }
                })).unwrap_or_default()
            );
            std::process::exit(0);
        }
        None => {
            eprintln!("Covenant is not running (no mcp.json discovery file).");
            std::process::exit(1);
        }
    }
}
```

(`unwrap_or_default` not `unwrap` — main() allows unwrap but a garbled file shouldn't panic a UX path. If `dirs` isn't a dep of the app crate, check what `discovery_path` uses and reuse that mechanism — hardcoding macOS `~/Library/Application Support` via `dirs::data_dir()` is correct on macOS which is the only supported platform today.)

- [ ] **Step 2: Verify + confirm the CLI shim forwards args**

Run: `cargo check -p app`, then with the dev app closed and open, run the built binary directly:

```bash
./target/debug/covenant mcp-config   # adjust binary name/path to the real one
```

Expected: exit 1 + stderr message when no discovery file; the JSON entry when the app is running (note: dev app writes under `.dev` — for the smoke, point the path override or temporarily copy; the printed path logic targets the installed bundle id, which is correct for real users).

Also verify `cli_open.rs::paths_from_argv` ignores `mcp-config` (it only accepts args that resolve to existing paths — a bare `mcp-config` doesn't, so no spurious open; confirm with its unit tests).

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/main.rs
git commit -m "feat(cli): covenant mcp-config prints the MCP entry for external agents"
```

---

### Task 7: Docs + final verification

**Files:**
- Modify: `CLAUDE.md`/`AGENTS.md` (short section under the architecture docs)

- [ ] **Step 1: Document**

Add a compact section to AGENTS.md (which CLAUDE.md symlinks) under the Super-Agent/Security area: what the MCP server is, the discovery file path, the five tools, the injection behavior for ACP spawns, `covenant mcp-config`, and the security posture (localhost + per-boot bearer token; the server can complete/create tasks and write notes — it does NOT execute commands, keep it that way without a safety review).

- [ ] **Step 2: Full verification**

Run: `cargo test -p app && cargo test -p agent && cargo clippy --workspace --all-targets && cargo fmt --all -- --check && npm test`
Expected: all green (npm from repo root; pre-existing failures on main, if any, noted — compare before blaming this branch).

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: covenant MCP server — discovery, tools, security posture"
```
