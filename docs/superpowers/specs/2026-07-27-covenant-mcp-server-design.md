# Covenant MCP Server — design

Date: 2026-07-27
Status: approved approach (Opción A — embedded HTTP server), pending spec review

## Problem

Executors (claude / codex / copilot / pi / hermes) are child processes spawned
by Covenant with no channel back into the app. They cannot mark their task
done (`complete_task` has been pending since the task-completion feature
shipped), read or append project notes, or touch any in-app functionality.
Every harness already speaks MCP, so MCP is the channel.

## Consumers

1. **Covenant-spawned executors** (primary, v1): running in a worktree, bound
   to a Task and a Session the app already knows about.
2. **External agents** (secondary, must not be designed out): a Claude Code
   the user opens by hand in any terminal. Discovery via a well-known file;
   if the app is not running the connection fails with an honest error.

## Architecture (Opción A)

The Tauri app hosts an MCP **streamable-http** server on localhost.

- **Implementation**: `rmcp` (official Rust MCP SDK) with its axum-based
  streamable-http transport, in a new module `crates/app/src/mcp_server.rs`.
  We do not hand-roll the protocol.
- **Port**: bind `127.0.0.1:0` (OS-assigned). No fixed-port collisions between
  the dev build and the installed build — each app instance writes its own
  discovery file.
- **Discovery file**: `~/Library/Application Support/<bundle-id>/mcp.json`,
  perms 0600, written on server start, removed on clean shutdown:

  ```json
  { "url": "http://127.0.0.1:PORT/mcp", "token": "<random-per-boot>" }
  ```

  The bundle id split (com.karluiz.covenant vs .dev) keeps the two apps'
  discovery files separate for free.
- **Auth**: `Authorization: Bearer <token>` required on every request. Token
  is random per app boot. Localhost-only bind + bearer token; nothing more.

## Wiring executors to the server

- **Spawned executors**: at spawn time Covenant injects
  - the MCP server entry (url + Authorization header) into the executor's
    derived config — same mechanism that already derives per-spawn settings
    (e.g. claude-acp settings.json) and the same merged-config shape as the
    Canon `mcp` projection (`crates/canon/src/mcp.rs`), under the reserved
    name `covenant`;
  - env vars `COVENANT_TASK_ID` and `COVENANT_SESSION_ID` so tools can
    default their target without arguments.
- **External agents**: `covenant mcp-config` (new subcommand of the existing
  CLI) prints the MCP entry JSON by reading the discovery file, so the user
  can paste/pipe it into any harness config. If no discovery file or the app
  is unreachable: clear error "Covenant is not running".

## Tool surface v1

Scoping rule: the server cannot see the caller's environment, so tools take
explicit ids. The env vars (`COVENANT_TASK_ID`, `COVENANT_GROUP_ID`,
`COVENANT_SESSION_ID`) are for the *agent* to discover its own ids (read via
its shell) and pass as arguments; tool descriptions say so. No cwd→scope
magic in v1.

| Tool | Args | Behavior |
|---|---|---|
| `task_list` | `status?` | All operator tasks from the teammate store, optionally filtered by status |
| `task_complete` | `task_id` | Marks done via the same path the UI "Mark done" uses (runtime release included) |
| `task_create` | `parent_task_id`, `title`, `body?` | Creates a Draft follow-up task owned by the parent's operator |
| `notes_read` | `group_id`, `limit?` | Recent project notes (`project_notes.rs`), newest first |
| `notes_append` | `group_id`, `body` | Appends a note; `source` set to `"mcp"` |

Note: tasks here are **operator tasks** (teammate store, SQLite). The Tasker
kanban board is frontend localStorage and is out of reach of the backend —
explicitly out of scope for this server.

Tool handlers call the existing logic in `teammate/` and `project_notes.rs`
directly (same process). No new storage, no new domain types — request/response
DTOs only.

Task mutations (`task_complete`, `task_create`) emit the same events the UI
paths emit so the Tasker board and operator runtime update live.

## Errors

- Unknown/missing token → 401.
- Tool called with a `task_id` the store doesn't have → MCP tool error with
  the id echoed back.
- App-side failures surface as MCP tool errors with the underlying message;
  never panic the server task.

## Out of scope (deliberate)

- Canon query tools — Canon already projects to files executors read natively.
- Somnus request execution — nothing has asked for it yet.
- Remote access, OAuth, multi-user — localhost bearer token is the ceiling
  until a real need appears.
- Windows path for the discovery file (follows the same app-data dir; no
  extra work expected, but untested until M8).

## Testing

- Unit: discovery-file write/perms/cleanup; token check; scoping resolution
  (env var vs cwd vs error).
- Integration (Rust): boot the server on an ephemeral port with an in-memory
  store, drive `initialize` → `tools/list` → `tools/call task_complete` with
  a real MCP client (rmcp client half) and assert the task flips to done and
  the completion event fires.
- Manual smoke: spawn a claude executor from Covenant, ask it to list tools,
  complete its own task, verify the board updates.
