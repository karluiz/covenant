# ACP Tab (A2) — Design

**Status:** approved-pending-user-review (design decisions taken autonomously per session; Karluiz to confirm)
**Depends on:** A0 (`crates/agent/src/acp/`) + A1 (`dispatch_acp`), merged in `e1f986b`.
**Spike reference:** render mockup at claude.ai/code/artifact/b72379af-bbda-4810-ae09-37ef473edf1f; plan `docs/superpowers/plans/2026-07-02-acp-copilot-a0-a1.md`.

## Goal

An opt-in tab (`kind:"acp"`) that hosts an interactive, long-lived Copilot ACP session rendered as a structured agent stream — prose, tool cards with diffs/exit codes, and interactive permission cards — instead of an xterm. The copilot TUI tab remains untouched and default. Template: the pi chat tab (`kind:"pi"`), wired end-to-end the same way.

## Decisions (taken in-session, flag if wrong)

1. **Permissions: hybrid.** The deny-biased policy auto-approves what it already allows headless (edits/reads in cwd, `Risk::Safe` executes). Everything it would deny is NOT auto-denied — it surfaces as an interactive card (Allow once / Always allow / Deny) and the turn waits. This is M6 SuggestOnly philosophy applied to executors.
2. **Entry point: parity with pi.** Keyboard shortcut (⌘⌥⇧C — verify unclaimed; pi uses ⌘⌥⇧P) + manifest restore. No palette/menu entry in v1 (pi has none either).
3. **v1 scope: minimal surface.** Stream + composer + permission cards + phase pill. NO model picker, NO mode pills (Agent/Plan/Autopilot), NO slash-command autocomplete — the wire supports them; defer to A2.1.
4. **Persistence: same as pi.** Tab persists in the manifest with cwd; restore respawns a clean session (transcript lost). ACP `loadSession:true` resume is a follow-up.
5. **`aomExcluded: true`.** No PTY to drive; operator interacts via `dispatch_acp`, not by injecting into this tab.
6. **Per-operator gating of `dispatch_acp`: deferred** (was listed as A2 in the ladder; it needs registry + settings UI and is orthogonal to the tab — now explicitly A3 scope).

## Architecture

Backend mirrors `pi_commands.rs`; frontend mirrors `executors/pi/`.

```
AcpSession (A0, extended)          acp_commands.rs (new)            ui (new)
 broadcast: AcpSessionEvent   →    forwarder task                →  session://{id}/acp events
   Update(SessionNotification)       emit + acp_event_to_phase        AcpChatView renders
   PermissionPending{key,req}        → NotchHub::set_phase            permission card ⇄
 respond_permission(key, opt) ←    acp_respond_permission        ←   Allow/Deny buttons
```

### 1. `crates/agent/src/acp/session.rs` — interactive permission seam (only A0 change)

- New enum + widened resolver:
  ```rust
  pub enum PermissionDecision { Select(String), Defer }
  pub type PermissionResolver = Arc<dyn Fn(&PermissionRequest) -> PermissionDecision + Send + Sync>;
  ```
- On `Defer`: the session parks the raw JSON-RPC id under a generated `request_key` (`perm-{n}`, monotonic counter) in a `Mutex<HashMap<String, Value>>` and broadcasts `PermissionPending { request_key, request }` instead of replying.
- New `pub async fn respond_permission(&self, request_key: &str, option_id: &str) -> Result<(), AcpError>` — writes `{"outcome":{"outcome":"selected","optionId":...}}` with the parked id; empty `option_id` sends the ACP `{"outcome":{"outcome":"cancelled"}}` shape instead (this also retires the `""`-sentinel Minor from the A0 review at the session layer).
- Broadcast payload widens from `SessionNotification` to:
  ```rust
  pub enum AcpSessionEvent { Update(SessionNotification), PermissionPending { request_key: String, request: PermissionRequest } }
  ```
- Parked requests are answered `cancelled` on shutdown so copilot isn't left hanging.
- `run.rs` (headless) wraps its resolver: `PermissionDecision::Select(resolve_headless_with_log(...))` — zero behavior change; all A0 tests stay green modulo the type change.

### 2. `crates/app/src/acp_commands.rs` (new) — mirror of pi_commands.rs

- `AcpRegistry`: `Mutex<HashMap<SessionId, AcpTabSession>>` on `AppState`, where `AcpTabSession { session: Arc<AcpSession>, acp_session_id: String }` (the wire sessionId from `session/new`).
- Commands (all registered in `lib.rs` `generate_handler!` ~:4564):
  - `spawn_acp_session(app, state, opts: SpawnAcpOpts { cwd }) -> Result<SpawnAcpResult { session_id }, String>` — mints `SessionId(Ulid)`, spawns `AcpSession` with the **hybrid resolver** (policy allow → `Select(allow_once id)`; policy deny → `Defer`), runs `initialize` + `session/new`, `notch_hub.register_external(id, "copilot")`, starts forwarder task.
  - `acp_send_prompt(state, session_id, text) -> Result<(), String>` — spawns a task that awaits the `session/prompt` request and, on completion, emits a synthetic `prompt_done { stop_reason }` event on the same Tauri topic + `set_phase(Done)`. Rejects (String error) if a prompt is already in flight (single-turn-at-a-time v1).
  - `acp_respond_permission(state, session_id, request_key, option_id) -> Result<(), String>` — analog of `pi_extension_ui_response`.
  - `acp_cancel(state, session_id)` — `session/cancel` notify.
  - `close_acp_session(state, session_id)` — registry remove + `shutdown(2s)` + `notch_hub.drop_session`.
- Forwarder task: `session.events()` → `app.emit("session://{id}/acp", event)`; maps updates via `acp_event_to_phase`:
  - `tool_call`/`tool_call_update` kind `edit` → `Writing{file}` (path from rawInput/diff), `execute` → `Running{cmd}`, `read` → `Reading{file}`
  - `agent_message_chunk` → `Thinking` heartbeat (NotchHub already throttles)
  - `PermissionPending` → `Waiting{reason}`
  - `prompt_done` → `Done{summary}`
  - `Lagged` → warn+continue; `Closed` → break + `drop_session` (same as pi forwarder).

### 3. Frontend

- `ui/src/api.ts`: `AcpTabEvent` union type (mirrors `AcpSessionEvent` + `prompt_done`), wrappers `spawnAcpSession`, `acpSendPrompt`, `acpRespondPermission`, `acpCancel`, `closeAcpSession`, `subscribeAcpEvents(sessionId, handler)` on `session://{id}/acp`.
- `ui/src/executors/acp/view.ts` — `AcpChatView { sessionId, host, onClose?, cwd? }`, structural clone of `PiChatView`:
  - Stream: user bubbles, streamed prose (markdown via the same renderer pi uses; NO raw HTML injection of agent text), tool cards keyed by `toolCallId` updated in place (kind chip edit/execute/read, title, status dot, collapsible diff for `ContentBlock::Diff`, output + exit chip for shell), permission cards with the wire's real options as buttons → `acpRespondPermission`; card collapses to a one-line "allowed/denied" record after answering.
  - Composer: textarea + Send (`acpSendPrompt`), Cancel while a turn is in flight (`acpCancel`). Input disabled during a turn except Cancel.
  - `destroy()` / `closeSession()` split identical to PiChatView.
- `ui/src/executors/acp/acp.css` — visual language from the spike mockup, on existing tokens (`--bg-*`, `--text-*`, `--accent`, status colors). No new tooltips except via `attachTooltip`. English copy.
- `ui/src/tabs/manager.ts` + `tabs/pane.ts`: `"acp"` added to `PaneKind`, `Tab.kind`, `SerializedTab/Pane.kind`; `createAcpTab(opts?)` cloning `createPiTab` (`:4231`) with `acpView` field + `aomExcluded: true`; `activate()` guard (focus composer, skip xterm fit); `closeTab` pane-loop branch → `acpView.closeSession()`; `serializeTab`/`restoreFromManifest` branch → `createAcpTab({cwd, skipActivate:true})`; folded-rail/tab-strip glyph branch (`⧉` or copilot glyph) alongside the browser branch.
- `ui/src/main.ts`: shortcut ⌘⌥⇧C → `manager.createAcpTab({ cwd: manager.activeCwd() })` (verify the combo is free first; fall back to ⌘⌥⇧A).

## Error handling

- Spawn/handshake failure (missing/old copilot): `spawn_acp_session` returns the A0 stderr-tail error string; the shortcut handler surfaces it as a toast/notice and does NOT create the tab.
- Session dies mid-conversation: forwarder `Closed` → emit synthetic `session_dead` event; view renders an inline notice with a "Restart session" action (respawns via `spawnAcpSession` into the same view).
- Prompt while turn in flight → command errors; composer prevents it client-side anyway.

## Testing

- Backend: unit tests for `acp_event_to_phase` (table-driven, fixture updates → expected phases); session.rs tests extended for Defer/respond_permission/cancelled-on-shutdown (fake agent scripts, same idiom); run.rs green untouched (resolver wrap).
- Frontend: vitest for the view's reducer bits — tool-card merge by `toolCallId`, permission-card lifecycle (pending → answered → collapsed), composer state machine (idle/in-flight). Run from repo ROOT (vitest/tsc gotcha).
- In-app verify (post-merge, manual): ⌘⌥⇧C, ask for a file creation + a mutating command; confirm diff card, permission card on the mutating command, Allow executes it, phase pill transitions, close tab kills the child.

## Out of scope (A2.1+/A3)

Model/mode pickers, slash-command autocomplete, conversation resume (`loadSession`), per-operator gating of `dispatch_acp`, extending ACP to claude/codex, multi-turn queueing, images in prompts.
