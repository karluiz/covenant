# Operator session visibility — ACP world model + PTY rehydration

**Date:** 2026-07-14
**Goal:** an operator can answer "¿qué estoy trabajando en esta sesión?" for BOTH tab kinds:
PTY tabs (already works, but blind after app restart) and ACP tabs (fully blind today).

## Context (as-built)

- Operator chat already injects `# Terminal context` per turn: active PTY tab gets cwd +
  rolling summary + last 4 blocks + in-flight command (`teammate/commands.rs:198-232`,
  `world_snapshot.rs`); other tabs get one-liners.
- `SessionWorldModel` (`world.rs`): 16-block ring + summary, fed off the session bus.
  Blocks/summaries persist to SQLite but there is NO read path on restore — restored
  sessions get a fresh ULID, so the ring starts empty (read path was deferred to M7.2).
- ACP tabs (claude/codex/copilot/pi) emit no OSC-133 blocks and their transcript is not
  stored in Covenant (agents replay via `session/load` on restore). The operator cannot
  see anything about them: no world model entry, and `read_terminal_screen` has no vt100.

## Section A — ACP world model (in-memory, no LLM, no SQLite)

New small module `crates/app/src/acp_world.rs`:

```rust
pub struct AcpWorldModel {
    pub agent: String,                 // executor name: claude/codex/copilot/pi
    pub turns: VecDeque<AcpTurn>,      // ring, MAX_TURNS = 12
    pub in_flight: Option<String>,     // agent turn being streamed (accumulated chunks)
}
pub struct AcpTurn { pub role: AcpRole, pub text: String, pub at_unix_ms: u64 }
pub enum AcpRole { User, Agent, Tool }
```

- Turn text truncated to ~500 chars (head+tail elision).
- No rolling LLM summary in v1: ACP turns are already prose; the ring answers the
  question directly. The shape allows plugging the summarizer later if needed.

**Feeding (two existing choke points in `acp_commands.rs`):**
1. The user-prompt command handler records a `User` turn.
2. The per-tab event forward loop (where `AcpTabEvent::Update` is re-emitted) accumulates
   `AgentMessageChunk`s into `in_flight`; on turn end (prompt response / stop) the
   accumulated text is flushed as one `Agent` turn. Tool calls become one-line
   `Tool` turns (`tool: <title>`).
3. Restore for free: `session/load` replays through the same event channel, so the model
   repopulates after app restart without any persistence in Covenant.

**Exposure:** `world_snapshot::project/render` includes ACP tabs in `# Terminal context`:
- Active ACP tab → executor name + last N turns (role-prefixed).
- Inactive ACP tabs → one-liner: `claude — last prompt: "…"`.

Registry: one `Arc<Mutex<AcpWorldModel>>` per ACP tab, owned alongside `AcpTabSession`
(or a parallel map keyed by tab session id), readable from `teammate/commands.rs`.

## Section B — PTY rehydration by cwd

There is no stable session key across restarts (tab manifest persists only cwd), so the
rehydration key is **cwd**. `recent_blocks_by_cwd` already exists (`storage.rs:985`).

1. When a `SessionWorldModel` is created for a session with a known cwd, seed:
   - Ring ← `recent_blocks_by_cwd(cwd, limit)` with blocks marked `inherited: true`.
   - Summary ← new query `latest_summary_by_cwd(cwd)`: most recent prior session with
     blocks at that cwd, joined to `summaries`.
2. `BlockSnapshot` gains `inherited: bool` (default false). Render separates inherited
   blocks under a `before this session:` header so the operator never confuses prior
   history with live activity.
3. Live blocks push inherited ones out of the ring naturally (same cap).

## Error handling

- Storage read failures on seed → log warn, start empty (today's behavior).
- ACP chunk accumulation is lossy-tolerant: missed turn-end just folds into the next flush.

## Testing

- `storage.rs`: unit test for `latest_summary_by_cwd` (picks most recent session at cwd).
- `world.rs`: render separates inherited vs live blocks.
- `acp_world.rs`: chunk accumulation → single Agent turn; ring cap; truncation.
- `world_snapshot`: ACP tab rendering (active detail vs one-liner).

## Out of scope

- LLM summary for ACP sessions (v2 if the ring proves insufficient).
- Persisting ACP transcripts in Covenant.
- Session lineage keys in the tab manifest.
