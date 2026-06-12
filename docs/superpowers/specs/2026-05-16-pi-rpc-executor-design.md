# Pi RPC Executor — Design

**Date:** 2026-05-16
**Status:** Approved design, pending implementation plan
**Target version:** v0.6.0

## Goal

Add **Pi** (Earendil Inc., `@earendil-works/pi-coding-agent`) as a first-class executor alongside Claude Code and Codex — but using Pi's **RPC mode** (JSONL over stdin/stdout) instead of the PTY-as-TUI integration we use for the other two.

This is the first executor in Covenant that escapes terminal-heuristics for idle/turn detection: lifecycle signals (`agent_start`, `turn_end`, `agent_end`) come from the agent itself, not from `fg_proc` polling or vt100 cursor introspection.

Secondary goal: expose Pi's unique multi-provider capability — switch model (Anthropic / OpenAI / Google / 15+) mid-session from the operator chip without restarting the tab.

## Non-goals

- Image attachments in prompts (defer).
- Fork / clone / `switch_session` UI surface (RPC supports it — wire later).
- Proxying the RPC `bash` command (we have terminal tabs for that).
- Replacing Codex / Claude Code integrations. Pi is additive.
- Full Pi extension UI protocol (`select` / `confirm` / `input` / `editor` / `notify` / `setStatus` / `setWidget` / `setTitle` / `set_editor_text`). Ship `select` + `confirm` only in v1; rest deferred.

## Architecture

Pi tabs are a new `TabKind::PiExecutor`. Unlike Claude / Codex tabs, the backing process is **not** a shell child under a PTY — it is `pi --mode rpc` spawned with piped stdin/stdout, and the tab body renders a **custom Pi chat panel** instead of xterm.js.

```
Tab(kind: PiExecutor)
  └─ ChildProcess(pi --mode rpc --provider ... --model ...)
       ├─ stdin:  JSONL commands   (prompt / abort / set_model / steer / ...)
       └─ stdout: JSONL events     (message_update / tool_execution_* / turn_end / agent_end)
            └─ reader task → SessionEvent::PiEvent(session, event)
                 └─ Tauri event session://{id}/pi → PiChatView
```

PTY is untouched for Pi tabs. Existing block parser, OSC 133 handling, and `fg_proc` polling stay only for shell-backed sessions.

### Why pipes, not PTY

RPC mode emits machine JSONL, not VT-encoded human output. A PTY would add SIGWINCH / line-discipline noise we'd just have to filter out. `tokio::process::Command::new("pi").stdin(piped).stdout(piped)` is the clean shape.

## Backend (Rust)

### New module: `crates/agent/src/pi_rpc.rs`

```rust
pub struct PiSession {
    pub id: SessionId,
    child: tokio::process::Child,
    stdin: ChildStdin,
    pending: Mutex<HashMap<String, oneshot::Sender<PiResponse>>>,
    events_tx: broadcast::Sender<PiEvent>,
}

pub enum PiCommand {
    Prompt { id: String, message: String, streaming_behavior: Option<StreamingBehavior> },
    Steer { message: String },
    FollowUp { message: String },
    Abort,
    NewSession { parent_session: Option<PathBuf> },
    GetState,
    GetMessages,
    SetModel { provider: String, model_id: String },
    CycleModel,
    GetAvailableModels,
    SetThinkingLevel(ThinkingLevel),
    CycleThinkingLevel,
    Compact { custom_instructions: Option<String> },
    GetSessionStats,
    GetLastAssistantText,
    // …
}

pub enum PiEvent {
    AgentStart,
    AgentEnd { messages: Vec<AgentMessage> },
    TurnStart,
    TurnEnd { message: AssistantMessage, tool_results: Vec<ToolResultMessage> },
    MessageStart { message: AgentMessage },
    MessageUpdate { message: AgentMessage, assistant_message_event: DeltaEvent },
    MessageEnd { message: AgentMessage },
    ToolExecutionStart { tool_call_id: String, tool_name: String, args: Value },
    ToolExecutionUpdate { /* … */ },
    ToolExecutionEnd { /* … */ },
    QueueUpdate { steering: Vec<String>, follow_up: Vec<String> },
    CompactionStart { reason: CompactionReason },
    CompactionEnd { /* … */ },
    AutoRetryStart { /* … */ },
    AutoRetryEnd { /* … */ },
    ExtensionError { /* … */ },
    ExtensionUiRequest { id: String, method: UiMethod, /* method-specific */ },
}
```

All variants are `#[serde(tag = "type", rename_all = "snake_case")]` tagged unions matching Pi's wire format verbatim.

### Reader task (CRITICAL — framing)

Pi's docs explicitly warn: **"Node `readline` is not protocol-compliant for RPC mode"** because Unicode line separators (U+2028 / U+2029) get treated as line endings. We must follow the same rule:

- Read raw bytes into a `Vec<u8>` buffer.
- Split **only** on `\n` (0x0A) byte-exact.
- Strip a trailing `\r` (0x0D) from each chunk.
- Decode UTF-8 **only after** a full line is isolated.
- Never use `BufRead::read_line` or any function that decodes-while-reading — it will break on 4-byte UTF-8 codepoints split across `read()` calls.

```rust
async fn read_loop(mut stdout: ChildStdout, events_tx: broadcast::Sender<PiEnvelope>) {
    let mut buf = Vec::<u8>::with_capacity(8192);
    let mut chunk = [0u8; 4096];
    loop {
        let n = match stdout.read(&mut chunk).await { Ok(0) => break, Ok(n) => n, Err(e) => { tracing::error!(?e); break; } };
        buf.extend_from_slice(&chunk[..n]);
        while let Some(nl) = buf.iter().position(|&b| b == b'\n') {
            let mut line = buf.drain(..=nl).collect::<Vec<_>>();
            line.pop(); // \n
            if line.last() == Some(&b'\r') { line.pop(); }
            if line.is_empty() { continue; }
            match serde_json::from_slice::<PiEnvelope>(&line) {
                Ok(env) => { let _ = events_tx.send(env); }
                Err(e) => tracing::warn!(?e, line=?String::from_utf8_lossy(&line), "pi rpc parse failure"),
            }
        }
    }
}
```

Tests must cover:
- `\r\n` line endings.
- UTF-8 4-byte codepoints split across `read()` boundaries (emoji at buffer edge).
- Embedded U+2028 inside a JSON string field — must NOT terminate the line.
- Lines larger than initial buffer capacity.
- Blank lines (skip).
- Malformed JSON (log + skip, do not crash session).

### Request/response correlation

Commands carry an optional `id`; responses echo it. Maintain `HashMap<String, oneshot::Sender>` keyed by id. Generate ids as ULID for ordering + debuggability.

Events do **not** carry an id — fan out via broadcast to subscribers (the Tauri event emitter).

### Session manager integration

Extend the session abstraction:

```rust
pub enum SessionBackend {
    Pty(PtySession),       // existing
    PiRpc(PiSession),      // new
}

impl Session {
    pub fn backend(&self) -> &SessionBackend { &self.backend }
    pub fn kind(&self) -> SessionKind {
        match &self.backend { SessionBackend::Pty(_) => SessionKind::Shell, SessionBackend::PiRpc(_) => SessionKind::PiExecutor }
    }
}
```

PiRpc sessions never go through `portable-pty` and never emit `BlockStarted` / `OutputChunk` / `BlockFinished`. They emit `PiEvent` directly. The block-parser pipeline (`crates/blocks`) is untouched.

### Tauri commands

| Command | Args | Returns |
|---|---|---|
| `spawn_pi_session` | `{ cwd, provider?, model?, session_dir? }` | `SessionId` |
| `pi_send_prompt` | `{ session_id, text, streaming_behavior? }` | `()` (fire-and-forget; events stream back) |
| `pi_steer` | `{ session_id, text }` | `()` |
| `pi_follow_up` | `{ session_id, text }` | `()` |
| `pi_abort` | `{ session_id }` | `()` |
| `pi_set_model` | `{ session_id, provider, model_id }` | `()` |
| `pi_get_state` | `{ session_id }` | `PiState` |
| `pi_new_session` | `{ session_id, parent_session? }` | `()` |
| `pi_compact` | `{ session_id, custom_instructions? }` | `()` |
| `pi_get_session_stats` | `{ session_id }` | `PiSessionStats` |
| `pi_extension_ui_response` | `{ session_id, request_id, value? \| confirmed? \| cancelled? }` | `()` |

Tauri event channel: `session://{id}/pi` carries `PiEvent` payloads.

### Idle / turn-end semantics

This replaces fg_proc heuristics entirely for Pi tabs:

- `agent_start` → tab marked busy, operator chip pulse on.
- `turn_end` → equivalent of OSC 133;D. Treat as block boundary for activity feed.
- `agent_end` → idle. Operator chip flips to idle, executor-idle notification fires (reusing existing notification path).
- `auto_retry_start` → keep busy with retry badge.
- `compaction_start` → "Compacting…" status.

No vt100 polling, no `comm` lookup, no PTY foreground-process tracking. Zero heuristics.

### Capabilities scan

New adapter `karl_capabilities::adapters::pi`:

- `~/.pi/extensions/*.ts` → extensions
- `~/.pi/skills/**/SKILL.md` → skills
- `~/.pi/prompts/*.md` → prompts
- `~/.pi/config.json` (if present) → settings

(Exact paths verified during PI-0 by inspecting an installed Pi.)

Capabilities panel gets a fourth filter pill: `Pi`.

### Binary detection & install

Mirror Codex's detection path:

1. `which pi` in user's shell.
2. If missing, show install affordance with two options: `curl -fsSL https://pi.dev/install.sh | sh` or `npm install -g @earendil-works/pi-coding-agent`. Never run silently — explicit consent.
3. Version check: `pi --version` parsed; warn if < some pinned minimum once we hit one.

### Process lifecycle

- Tab close → `pi_abort` → close stdin → `child.wait()` with 2s timeout → SIGKILL.
- Pi crash (stdout EOF before agent_end pending) → emit `PiEvent::ProcessExited { code }` synthetic event, show tab as crashed with "Restart" affordance.
- Workspace switch → same persistence path as PTY sessions (Pi tabs serialize their `session-dir` so reopen restores conversation).

## Frontend (TS)

### New tab kind

`TabKind.PiExecutor` in `ui/src/tabs/types.ts`. New-tab menu gets a "Pi" entry between "Codex" and "Shell". Spawn flow:

1. User picks Pi → `spawn_pi_session({ cwd })`.
2. Returns `SessionId`.
3. Tab mounts `PiChatView` instead of `xterm.js`.
4. Subscribes to `session://{id}/pi`.

### `PiChatView` (`ui/src/executors/pi/view.ts`)

Single root component, no React. Plain DOM (consistent with rest of UI).

Layout:

```
┌──────────────────────────────────────────────────────┐
│ [Model: claude-sonnet-4 ▼]  [Thinking: high ▼]   ⚙   │  ← header chips
├──────────────────────────────────────────────────────┤
│                                                      │
│  user:  fix the failing test in foo.rs               │
│                                                      │
│  assistant: Looking at the test now…                 │
│    🔧 bash  ls crates/foo                            │
│    └─ Cargo.toml  src/                               │
│    🔧 read crates/foo/src/lib.rs                     │
│    The issue is on line 42 — the assertion …        │
│                                                      │  ← message list (streams)
├──────────────────────────────────────────────────────┤
│ Pending: steering (1) · follow-up (0)                │  ← queue indicator (when non-empty)
├──────────────────────────────────────────────────────┤
│ [_________________________________]  [Send] [Abort]  │  ← input
└──────────────────────────────────────────────────────┘
```

Streaming rules:
- `message_start` → append empty assistant block.
- `message_update` with `text_delta` → append delta to current text run.
- `message_update` with `thinking_delta` → append to a collapsed-by-default thinking section.
- `message_update` with `toolcall_*` → render tool invocation pill that progressively reveals args.
- `tool_execution_start/update/end` → tool result expandable card under the tool call.
- `message_end` → finalize block.

Input states:
- Idle: `[Send]` enabled.
- Streaming: `[Abort]` + `[Steer]` + `[Follow up]`. Send is disabled; pressing Enter is interpreted as steer.

Model selector chip:
- Click → popover listing `get_available_models` response, grouped by provider.
- Select → `pi_set_model` → header chip updates on next event.

### Extension UI handler v1

`extension_ui_request` arrives via event. Modal dialog renders for `select` + `confirm`. `cancelled: true` on close, `value` / `confirmed` on submit. All other UI methods (`input`, `editor`, `notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`) get logged + ignored in v1 with a TODO; queue follow-up plan.

### Status bar

Mission chip: works unchanged (session-scoped).
Operator chip: detects PiExecutor via session kind, no fg_proc lookup. Shows current Pi model name.
Executor-idle notifications: same code path, triggered by `agent_end` instead of fg_proc transitions.

### Persistence

Pi tab serialization in the workspace manifest:

```ts
{
  kind: "pi_executor",
  session_dir: "/Users/.../.pi/sessions/abc.jsonl",
  provider: "anthropic",
  model: "claude-sonnet-4-20250514",
  cwd: "/path/to/project",
}
```

On reload, `spawn_pi_session({ session_dir, provider, model, cwd })` rehydrates the conversation (Pi reads its own JSONL session log).

## Wire-up checklist

- [ ] `crates/agent/Cargo.toml`: add `tokio = { features = ["process", "io-util", "sync"] }` if missing.
- [ ] `crates/agent/src/pi_rpc.rs`: full module.
- [ ] `crates/agent/src/lib.rs`: `pub mod pi_rpc;`.
- [ ] `crates/app/src/main.rs`: register 11 new Tauri commands.
- [ ] `crates/app/src/session.rs` (or equivalent): `SessionBackend` extension.
- [ ] `crates/capabilities/src/adapters/pi.rs`: scanner.
- [ ] `crates/app/src/capabilities_commands.rs`: add Pi to detect / scan / list.
- [ ] `ui/src/api.ts`: typed wrappers + `PiEvent` / `PiCommand` types.
- [ ] `ui/src/executors/pi/view.ts`: chat panel.
- [ ] `ui/src/executors/pi/styles.css`: scoped styles (or fold into `styles.css`).
- [ ] `ui/src/tabs/manager.ts`: `PiExecutor` kind handling in `buildTabShell`.
- [ ] `ui/src/tabs/types.ts`: enum addition.
- [ ] `ui/src/icons/brands.ts`: Pi icon.
- [ ] `ui/src/operator/persona-templates.ts`: optional Pi-aware persona.
- [ ] `ui/src/settings/panel.ts`: Pi install / detect UI.

## Milestones

| M | Deliverable | LOC (R + TS) |
|---|---|---|
| **PI-0** | `pi_rpc.rs` smoke: spawn `pi --mode rpc`, send `get_state`, assert parsed response. Unit test for JSONL framer (incl. UTF-8 split, U+2028, `\r\n`). | ~250 R |
| **PI-1** | Full `PiCommand` / `PiEvent` enums, reader task, request-id correlation, broadcast bus integration. Idle event mapping. | ~400 R |
| **PI-2** | Tauri commands + frontend `api.ts` wrappers. | ~150 R + 100 TS |
| **PI-3** | `PiChatView` MVP — header chips, message list, input box, `prompt` + streaming text rendering. | ~350 TS |
| **PI-4** | Tool execution rendering, thinking blocks, queue indicator, abort / steer / follow-up wiring. | ~300 TS |
| **PI-5** | Model selector popover + `set_model` flow + operator-chip idle wiring + executor-idle notification. | ~200 TS |
| **PI-6** | Capabilities scanner + panel pill. Binary detection + install affordance. | ~200 R + 150 TS |
| **PI-7** | Extension UI v1 (`select` + `confirm` dialogs). Persistence in workspace manifest + rehydrate. | ~100 R + 250 TS |

Total: ~1100 R + 1350 TS. Estimate 4–6 days sustained.

## Risks

1. **JSONL framing edge cases.** Mitigation: byte-exact framer, explicit U+2028 / 4-byte UTF-8 / `\r\n` tests in PI-0 before any wiring. Treat the framer as the highest-trust module in the integration.
2. **Binary detection / install UX.** Mitigation: reuse Codex's pattern verbatim; no novel install flow.
3. **Multi-provider credentials.** Pi delegates to provider env vars (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). Reuse the shell's env at spawn time — do **not** invent secret storage. If a provider is selected without creds, Pi will surface the error on `set_model` response; pass it through verbatim.
4. **Pi process leaks on crash.** Mitigation: PID tracked in session; on app shutdown, walk live sessions and `abort` + close stdin + `wait()` with timeout. Same pattern as Codex.
5. **Conversation persistence drift.** Pi owns its session JSONL. If we change `session-dir` between launches the conversation disappears. Mitigation: persist `session_dir` per tab in the manifest; never relocate.
6. **`agent_end` not firing.** If Pi crashes or hangs mid-turn, the chip would stay busy forever. Mitigation: synthetic `ProcessExited` event when stdout closes; UI treats it as idle + crashed.

## Open questions

- Pi's `session-dir` default location — verify during PI-0. The capabilities scanner paths above are best-guess.
- Does Pi's `--provider` flag accept a custom base URL (for self-hosted / proxied providers)? If yes, expose in spawn opts.
- Cost tracking — `get_session_stats` returns token usage & cost. Should we feed that into the existing cost-cap budget that Operator uses? Decision: yes, but defer to a follow-up plan; out of scope here.

## Out-of-scope follow-ups

- Pi as **operator-mode** (background companion observing a shell tab instead of tab-as-shell). Discussed during design; deferred until tab-as-shell is dogfooded. Would reuse the same RPC plumbing — only the UI shell differs.
- Full extension UI protocol (input / editor / notify / setStatus / setWidget / setTitle / set_editor_text).
- Fork / clone / `switch_session` UI surface.
- Image attachments.
- Pi's `bash` RPC command proxied through Covenant's PTY tabs.
