# Operator Session Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** the operator can answer "what am I working on in this session?" for ACP tabs (today blind) and for PTY tabs right after an app restart (today empty ring).

**Architecture:** (A) a new in-memory `AcpWorldModel` per ACP tab, fed from the two existing choke points in `acp_commands.rs` (prompt command + forwarder loop), surfaced through `world_snapshot` into the operator's `# Terminal context`. (B) PTY world models seed their ring/summary from SQLite by cwd at spawn (`recent_blocks_by_cwd` exists; add `latest_summary_by_cwd`), with inherited blocks visibly separated.

**Tech Stack:** Rust (tokio, rusqlite via existing `Storage`), no frontend changes expected (verify Task 7).

## Global Constraints

- No new dependencies. No SQLite schema changes.
- No LLM calls added (ACP model is mechanical accumulation).
- std `Mutex` on `AcpTabSession` fields is never held across an await (existing pattern).
- Spec: `docs/superpowers/specs/2026-07-14-operator-session-visibility-design.md`.
- Commits: one per feature — `feat(world): rehydrate PTY world model by cwd` (Tasks 1–3) and `feat(acp): ACP world model feeds operator context` (Tasks 4–7).

---

### Task 1: `inherited` flag on `BlockSnapshot` + render separation

**Files:**
- Modify: `crates/app/src/world.rs`
- Modify: `crates/app/src/teammate/world_snapshot.rs`

**Interfaces:**
- Produces: `BlockSnapshot.inherited: bool`, `SessionWorldModel::seed_history(blocks: Vec<BlockSnapshot>, summary: Option<String>)`, `BlockBrief.inherited: bool`.

- [ ] **Step 1: failing tests** — in `world.rs` tests: `seed_history_prepends_inherited_blocks` (seed 2 blocks then apply 1 live `BlockFinished`; assert order inherited→live, flags correct, summary set only if none); in `world_snapshot.rs` tests: `renders_inherited_blocks_separately` (active snapshot with 1 inherited + 1 live block renders a `from previous sessions in this cwd` list and the live one under `recent blocks`).
- [ ] **Step 2: run** `cargo test -p karl-app world:: teammate::world_snapshot::` → FAIL (no field/method).
- [ ] **Step 3: implement**
  - `BlockSnapshot` gains `pub inherited: bool`; all existing constructors set `false`.
  - `SessionWorldModel::seed_history`: push_front blocks (given newest-first, so front ends oldest-first), trim ring to `MAX_BLOCKS` popping front; set `self.summary = summary` only if `self.summary.is_none()`.
  - `world_snapshot::project`: copy `inherited` into `BlockBrief`.
  - `world_snapshot::render_session_full`: split `last_blocks` into inherited/live; inherited under `- from previous sessions in this cwd (oldest first):`, live under the existing `- recent blocks (oldest first):`. `render_session_brief` fallback line prefixes `prior:` when the last block is inherited.
  - `world.rs` `render_block_full/brief`: suffix `[prior session]` when inherited.
- [ ] **Step 4: run tests** → PASS (plus existing tests untouched).

### Task 2: `Storage::latest_summary_by_cwd`

**Files:**
- Modify: `crates/app/src/storage.rs`

**Interfaces:**
- Produces: `pub async fn latest_summary_by_cwd(&self, cwd: String) -> Result<Option<String>, StorageError>`.

- [ ] **Step 1: failing test** — two sessions at same cwd with summaries, blocks timestamped so session B is newer → returns B's summary; empty cwd → `None`.
- [ ] **Step 2: implement** — query:
```sql
SELECT summary FROM summaries WHERE session_id =
  (SELECT session_id FROM blocks WHERE cwd = ?1 ORDER BY finished_at_unix_ms DESC LIMIT 1)
```
`spawn_blocking` + `.optional()`, same shape as `load_summary`. Empty-cwd early return.
- [ ] **Step 3: run** `cargo test -p karl-app storage::` → PASS.

### Task 3: seed at spawn (wire 1+2)

**Files:**
- Modify: `crates/app/src/lib.rs` (~line 592, after `world` creation in `spawn_session`)

**Interfaces:**
- Consumes: `seed_history`, `latest_summary_by_cwd`, `recent_blocks_by_cwd` (`storage.rs:985`, returns newest-first `HistoricalBlock` without output_text).

- [ ] **Step 1: implement** — when `initial_cwd` is `Some(cwd)` and non-empty, spawn a task cloning `world` + `state.storage`:
```rust
let blocks = storage.recent_blocks_by_cwd(cwd.clone(), 8).await.unwrap_or_default();
let summary = storage.latest_summary_by_cwd(cwd.clone()).await.ok().flatten()
    .map(|s| format!("(carried over from a previous session in this directory) {s}"));
if !blocks.is_empty() || summary.is_some() {
    let snaps = blocks.into_iter().map(|b| BlockSnapshot {
        command: b.command, cwd: PathBuf::from(&b.cwd.unwrap_or_default()),
        exit_code: b.exit_code, duration_ms: b.duration_ms,
        output_text: String::new(), inherited: true,
    }).collect();
    world.lock().await.seed_history(snaps, summary);
}
```
(Adjust to `HistoricalBlock`'s real field types; failures log `tracing::warn!` and start empty.)
- [ ] **Step 2: run** `cargo test -p karl-app` + `cargo clippy -p karl-app` → clean.
- [ ] **Step 3: commit** `feat(world): rehydrate PTY world model by cwd on spawn`.

### Task 4: `AcpWorldModel`

**Files:**
- Create: `crates/app/src/acp_world.rs`; register `mod acp_world;` in `lib.rs`.

**Interfaces:**
- Produces:
```rust
pub struct AcpWorldModel { pub executor: String, /* private ring + agent buffer */ }
impl AcpWorldModel {
    pub fn new(executor: String) -> Self;
    pub fn record_user(&mut self, text: &str);      // dedupes consecutive identical user turns (live + replay echo)
    pub fn on_agent_chunk(&mut self, text: &str);   // accumulate
    pub fn on_tool_call(&mut self, title: &str);    // flushes agent buffer first, records Tool turn
    pub fn flush_agent_turn(&mut self);             // on PromptDone; no-op if buffer empty
    pub fn turns(&self) -> Vec<(AcpRole, String)>;  // for snapshot projection
    pub fn last_user_prompt(&self) -> Option<String>;
}
pub enum AcpRole { User, Agent, Tool }
```
- Semantics: `MAX_TURNS = 12` ring; each stored turn truncated to 500 chars (head 350 + `…` + tail 150); `record_user` flushes any pending agent buffer first (turn boundary for `session/load` replays that never see PromptDone).

- [ ] **Step 1: failing tests** — chunk accumulation flushes to ONE Agent turn on `flush_agent_turn`; `record_user` flushes pending agent buffer (replay ordering); consecutive-duplicate user dedupe; ring caps at 12; >500-char turn truncated with head+tail.
- [ ] **Step 2: implement minimal model.**
- [ ] **Step 3: run** `cargo test -p karl-app acp_world::` → PASS.

### Task 5: feed the model in `acp_commands.rs`

**Files:**
- Modify: `crates/app/src/acp_commands.rs`

**Interfaces:**
- `AcpTabSession` gains `world: std::sync::Mutex<crate::acp_world::AcpWorldModel>` (constructed with the executor name at spawn, ~line 594).
- `AcpRegistry` gains `pub async fn snapshot_worlds(&self) -> Vec<(SessionId, String /*executor*/, Vec<(AcpRole, String)>, Option<String> /*last prompt*/, PathBuf /*cwd*/)>` — or a small struct `AcpWorldSnapshot`; clones under the lock, no awaits inside.

- [ ] **Step 1: wire feed points**
  - `acp_send_prompt` (~line 1078): after building blocks, `tab.world.lock() → record_user(&text)`; in the spawned prompt task after the request resolves: `flush_agent_turn()`.
  - Forwarder loop (~line 879, next to the commands-cache match): on `AcpSessionEvent::Update(n)` match `n.update`: `AgentMessageChunk { content }` → `content.as_text()` → `on_agent_chunk`; `UserMessageChunk { content }` → `record_user` (replay path; dedupe handles the live echo); `ToolCall(f)` → `on_tool_call(f.title.as_deref().or(f.command()).unwrap_or("tool call"))` (ignore `ToolCallUpdate`).
  - Use `std::sync::Mutex` poison-recovery pattern already used for `commands` (`Ok(g) | Err(p) => p.into_inner()`).
- [ ] **Step 2: run** `cargo test -p karl-app && cargo clippy -p karl-app` → clean. (Behavioral coverage lives in Task 4's unit tests; this task is glue.)

### Task 6: surface ACP tabs in the operator context

**Files:**
- Modify: `crates/app/src/teammate/world_snapshot.rs`
- Modify: `crates/app/src/teammate/commands.rs` (~lines 198–252)
- Modify: `crates/app/src/teammate/llm.rs` (~line 185, context-shape description)

**Interfaces:**
- `world_snapshot` gains:
```rust
pub struct AcpTabSnapshot { pub id: SessionId, pub is_active: bool, pub executor: String,
                            pub turns: Vec<(crate::acp_world::AcpRole, String)>,
                            pub last_prompt: Option<String>, pub cwd: String }
pub fn render_with_acp(sessions: &[SessionSnapshot], acp: &[AcpTabSnapshot]) -> String
```
`render_with_acp` = existing `render` + a `## Agent sessions (interactive AI chats)` section: active ACP tab → executor + role-prefixed turn list (`user:` / `agent:` / `tool:`); inactive → one-liner `- claude — cwd `…` · last prompt: "…"` (or `idle`). Existing `render` delegates to `render_with_acp(s, &[])`.

- [ ] **Step 1: failing tests** — active ACP tab renders turns under `## Agent sessions`; inactive renders one-liner; empty acp slice renders identically to old `render` output.
- [ ] **Step 2: implement render + projection.**
- [ ] **Step 3: integrate in `commands.rs`** — after PTY snapshots: `let acp_worlds = state.acp_sessions.snapshot_worlds().await;` (captured before the `tokio::spawn`, like `session_data`); build `AcpTabSnapshot`s marking `is_active = Some(id) == active_session_id_parsed`; call `render_with_acp`. Additionally: when `active_cwd` resolves to `None` and the active id is an ACP tab, use that tab's `cwd` as the tool-sandbox root (canonicalized) so tools work while an ACP tab is focused.
- [ ] **Step 4: prompt shape** — in `llm.rs` `build_system_prompt`, extend the `# Terminal context` description: agent sessions section exists, active one includes recent chat turns; answer "what am I doing" on an agent tab from those turns.
- [ ] **Step 5: run** `cargo test -p karl-app && cargo clippy -p karl-app` → clean.

### Task 7: frontend active-id check + commit

**Files:**
- Verify: `ui/src/teammate/panel.ts` (or wherever `teammateSendText` gets `activeSessionId`)

- [ ] **Step 1:** confirm the frontend passes the focused tab's session id even when it's an ACP tab (grep `teammateSendText` callers). If it filters to PTY tabs, remove the filter.
- [ ] **Step 2:** `npm run build` only if frontend touched; `cargo test --workspace` for the Rust side (skip known-hanging telegram tests per repo gotchas — run `cargo test -p karl-app`).
- [ ] **Step 3: commit** `feat(acp): ACP world model feeds operator terminal context`.

## Self-review notes

- Spec coverage: A.1→Task 4, A.2→Task 5, A.3→Task 6, B.1-3→Tasks 1–3, testing section→each task's step 1. Restore-replay repopulation falls out of Task 5's UserMessageChunk/AgentMessageChunk handling (no extra work).
- Type check: `AcpRole` defined Task 4, consumed Tasks 5–6; `seed_history` defined Task 1, consumed Task 3; `latest_summary_by_cwd` defined Task 2, consumed Task 3.
