# CLAUDE.md

> Project memory for Claude Code. Read this first on every session.

## Project: AI-Native Terminal for macOS

A modern terminal emulator built with **Tauri 2 + Rust + xterm.js**, designed from the ground up around an autonomous **super-agent** that observes every terminal session the user opens and can intervene intelligently across all of them.

This is **not** a terminal with an AI assistant bolted on. The terminal IS the substrate the agent operates on.

---

## North Star

Every session emits a stream of structured events (commands, outputs, exit codes, cwd changes). A long-lived super-agent subscribes to the event bus across **all open sessions** and:

- Builds and maintains a live world-model of what the user is doing in each terminal
- Correlates activity across sessions (e.g. user edits `foo.rs` in tab 1, tests fail in tab 2 → connect the dots)
- Surfaces next-best-actions, catches errors early, and — when authorized — executes commands autonomously
- Keeps a rolling summary per session that survives indefinitely (prompt caching)

If a feature does not contribute to that loop, it is out of scope until M5+.

---

## Core Principle: Own the PTY, do not "intercept stdout"

The shell (zsh / bash / fish) is a child process running inside a **pseudo-terminal we own**. Every byte of stdout/stderr passes through our Rust backend before being rendered, and we can write back to the PTY at any time. There is no "interception" — we are the master.

This single fact dictates the entire architecture below.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  Frontend (TypeScript + xterm.js + Vite)         │
│  - Renders terminal output (xterm.js handles VT) │
│  - Block-based UI (Warp-style)                   │
│  - Agent panel + inline suggestions              │
└─────────────┬────────────────────────────────────┘
              │ Tauri IPC (events + commands)
┌─────────────▼────────────────────────────────────┐
│  Backend (Rust + Tokio)                          │
│  ┌────────────┐    ┌──────────────────────────┐ │
│  │ Session    │───▶│ PTY pool (portable-pty) │ │
│  │ Manager    │    └──────────────────────────┘ │
│  └─────┬──────┘                                  │
│        │                                          │
│  ┌─────▼─────────┐    ┌─────────────────────┐   │
│  │ Block Parser  │───▶│ Event Bus           │   │
│  │ (OSC 133)     │    │ (tokio::broadcast)  │   │
│  └───────────────┘    └──────────┬──────────┘   │
│                                  │               │
│                          ┌───────▼───────────┐  │
│                          │ Super-Agent       │  │
│                          │ (Anthropic API)   │  │
│                          └───────────────────┘  │
└──────────────────────────────────────────────────┘
```

### Stack (do not deviate without asking)

| Layer | Choice | Why |
|---|---|---|
| App shell | Tauri 2.x | Small bundle, native webview, good IPC |
| Async runtime | `tokio` | Standard |
| PTY | `portable-pty` | Battle-tested, cross-platform |
| Terminal state (headless) | `vt100` | If we ever need to read screen state without xterm |
| Frontend renderer | `xterm.js` + `xterm-addon-fit` + `xterm-addon-webgl` | Do NOT reimplement a VT parser |
| Errors | `thiserror` (libs) + `anyhow` (bins) | |
| IDs | `ulid` | Sortable, human-debuggable |
| Logging | `tracing` + `tracing-subscriber` | Structured fields |
| ANSI stripping | `strip-ansi-escapes` | Before any text reaches the LLM |
| LLM client | `reqwest` + Anthropic Messages API streaming | Use prompt caching aggressively |

---

## Domain Model

### `Session`
Owns one PTY pair + one child shell process + metadata.

```rust
pub struct Session {
    pub id: SessionId,            // Ulid
    pub shell: ShellKind,         // Zsh | Bash | Fish
    pub cwd: PathBuf,             // updated via OSC 7 or shell hook
    pub env_snapshot: HashMap<String, String>,
    pub started_at: Instant,
    pub child: Box<dyn Child + Send + Sync>,
    pub writer: Box<dyn Write + Send>,
    // reader runs on a dedicated spawn_blocking task
}
```

### `Block`
Atomic unit of terminal activity. The unit we feed the agent.

```rust
pub struct Block {
    pub id: BlockId,
    pub session_id: SessionId,
    pub command: String,
    pub raw_output: Vec<u8>,       // bytes, includes ANSI
    pub plain_output: String,      // stripped, lazily computed
    pub exit_code: Option<i32>,
    pub cwd: PathBuf,
    pub started_at: Instant,
    pub finished_at: Option<Instant>,
}
```

### `SessionEvent` (broadcast bus)
```rust
pub enum SessionEvent {
    SessionOpened(SessionId),
    SessionClosed(SessionId),
    BlockStarted { session: SessionId, block: BlockId, command: String },
    OutputChunk  { session: SessionId, block: BlockId, bytes: Bytes },
    BlockFinished{ session: SessionId, block: BlockId, exit_code: i32 },
    CwdChanged   { session: SessionId, cwd: PathBuf },
}
```

### `AgentAction` (agent → bus)
```rust
pub enum AgentAction {
    Notify    { session: SessionId, message: String, severity: Severity },
    Suggest   { session: SessionId, command: String, rationale: String },
    Execute   { session: SessionId, command: String, policy: ExecPolicy },
}
```

---

## Shell Integration (CRITICAL — do not skip)

The block parser depends on **OSC 133** markers being emitted by the user's shell. On first run we offer to install snippets into `~/.zshrc`, `~/.bashrc`, or fish config (always behind explicit consent, never silently).

Markers we rely on:

| Sequence | Meaning |
|---|---|
| `ESC ] 133 ; A ST` | Prompt start |
| `ESC ] 133 ; B ST` | Prompt end / command starts |
| `ESC ] 133 ; C ST` | Command output starts |
| `ESC ] 133 ; D ; <exit_code> ST` | Command finished |
| `ESC ] 7 ; file://host/<path> ST` | CWD changed (use this for `CwdChanged`) |

Reference: WezTerm's shell integration docs. Without these, segmenting the stream into blocks is heuristic and unreliable. **Do not try to parse blocks without OSC 133.**

Snippets live in `shell-integration/` as part of the repo.

---

## Project Structure

```
super-term/
├── Cargo.toml                # workspace root
├── CLAUDE.md                 # this file
├── crates/
│   ├── pty/                  # PTY abstraction over portable-pty
│   ├── blocks/               # OSC 133 parser, Block types
│   ├── session/              # Session lifecycle, event bus
│   ├── agent/                # LLM client, super-agent loop, world model
│   └── app/                  # Tauri commands, IPC, main entry
├── shell-integration/
│   ├── osc133.zsh
│   ├── osc133.bash
│   └── osc133.fish
└── ui/
    ├── src/
    │   ├── api.ts            # typed wrappers around Tauri commands
    │   ├── terminal/         # xterm.js mount + lifecycle
    │   └── agent/            # agent panel, suggestions
    ├── index.html
    ├── package.json
    └── vite.config.ts
```

---

## Coding Conventions

### Rust
- Errors: `thiserror` inside library crates; `anyhow` only at the `app` binary boundary.
- **PTY reader runs on a dedicated `tokio::task::spawn_blocking` task.** The read loop is synchronous and blocking by nature. It pushes bytes into an `mpsc::channel`; the async side drains and broadcasts.
- Never block an async task. Use `spawn_blocking` for any sync I/O.
- No `unwrap()` outside `#[cfg(test)]` and `main()`.
- Public types derive `Debug` + `Clone` where reasonable; events derive `Serialize`.
- Logging: `tracing` with `session_id` and `block_id` as structured fields, never string-interpolated.
- All IDs are `ulid::Ulid` newtyped (`SessionId(Ulid)`, `BlockId(Ulid)`).

### TypeScript
- `strict: true`, no implicit any, no `as any` without a comment justifying it.
- All Tauri commands wrapped in `src/api.ts` with typed return values.
- xterm.js instance lives in a single component and is **never re-mounted on prop change**. Use refs.
- ANSI rendering is xterm.js's job — frontend never inspects bytes for content.

### Commits
- Conventional Commits (`feat:`, `fix:`, `refactor:`, `chore:`).
- One milestone-relevant change per commit when possible. Small commits, green tests.

---

## Critical Pitfalls — DO NOT

1. **Do not write a VT/ANSI parser from scratch.** Use `vt100` for headless state and let xterm.js render. Reimplementing this is a 6-month project on its own.
2. **Do not poll stdout.** A dedicated reader task drains the PTY; downstream processing is event-driven.
3. **Do not parse blocks without OSC 133.** Heuristics on prompts always break.
4. **Do not block the PTY reader task.** It must drain bytes as fast as the kernel produces them. All processing (block parsing, ANSI strip, broadcast) happens downstream.
5. **Do not send raw ANSI to the LLM.** Always `strip-ansi-escapes` first.
6. **Do not let the super-agent execute commands outside the policy framework** (see Security).
7. **Do not store secrets in the world-model.** Mask anything matching common token patterns (`sk-...`, `ghp_...`, JWT shapes, etc.) before persisting or sending to the LLM.
8. **Do not block the UI thread on agent calls.** Agent runs on its own task; UI subscribes to results.
9. **Do not introduce Electron, React, Webpack, or any heavyweight frontend deps without asking.** The frontend stays minimal.

---

## Super-Agent Design

### World model
Per-session: a rolling summary (≤ ~2k tokens) updated incrementally after each `BlockFinished`. Updates are batched (debounce ~500ms) so a fast-running command stream doesn't thrash the LLM.

Global: a top-level summary (≤ ~1k tokens) reconciling all session summaries, refreshed on a slower cadence (every N seconds or on significant events like a non-zero exit).

Storage: in-memory for v0; SQLite (`rusqlite` + `sqlite-vec` extension) once persistence matters.

### Prompt caching
Use Anthropic's prompt caching for:
- The system prompt (static, large — describes the agent's role and tool set)
- Per-session rolling summary (cached, updated ~every minute)
This is a 10x cost reduction. Wire it from day one.

### Triggers (when does the agent "wake up"?)
- `BlockFinished` with `exit_code != 0` → propose a fix
- User shortcut (e.g. ⌘K) → answer "what's going on?" using the world model
- Cross-session pattern detection (M5+) → proactive notification
- Explicit user message in the agent panel

### Rate limiting / cost guardrails
- Max N agent calls per minute per session (configurable, default 6)
- Hard cap on tokens per session per day
- All agent calls go through a single `agent::dispatch()` that enforces these. Never call the API directly from elsewhere.

---

## Security: Autonomous Execution

The agent CAN write to the PTY, but only under one of these per-session policies:

| Policy | Behavior |
|---|---|
| `SuggestOnly` (**default**) | Agent only proposes; user accepts with a keystroke |
| `Allowlist(regex_set)` | Agent runs unattended for matching commands (`^git status$`, `^ls( .*)?$`, etc.) |
| `ConfirmEach` | Agent runs but must show preview and wait for confirmation |
| `FullAuto { sandbox: SandboxKind }` | Anything goes; session is sandboxed (cwd jail, separate user, or container) |

### Hard blocklist (NEVER auto-executed regardless of policy)
- `rm -rf` (any flag combination resolving to recursive force)
- `sudo`, `doas`, `su`
- Pipes to `sh`/`bash`/`zsh` from network (`curl ... | sh`)
- `dd`, `mkfs`, `fdisk`
- Fork bombs, anything matching `:(){...};:` patterns
- Direct writes to `~/.ssh/`, `~/.aws/`, `~/.config/gh/`, `/etc/`, password stores
- `git push --force` to protected branches (configurable list)

The blocklist lives in `crates/agent/src/safety.rs` with full unit tests. Adding to it never requires a feature flag; **removing** from it requires a code review comment justifying the change.

---

## Milestones

### M0 — PTY hello world *(1–2 days)*
Tauri app spawns `zsh -i` via `portable-pty`, pipes bytes to xterm.js over Tauri events, keystrokes echo back. Single session. No blocks yet. **Stop here. Commit. Verify.**

### M1 — Block parser
Install OSC 133 snippet into a sandboxed test rc (do not touch user's real config yet). Implement parser in `crates/blocks`. Sidebar shows a list of blocks as they finish.

### M2 — Multi-session
Tabs UI. Each tab = one Session. Event bus aggregates. Verify nothing leaks between sessions.

### M3 — Super-agent v0 (read-only)
Agent task subscribes to the bus, maintains a per-session rolling summary in memory. ⌘K opens a panel; user asks "what's going on?" → agent answers using the world model. Prompt caching enabled.

### M4 — Failure suggestions
On `exit_code != 0`, agent auto-proposes a fix inline in the failed block. `SuggestOnly` policy.

### M5 — Cross-session correlation
World model promotes patterns: "your tests in tab 2 are failing on the file you just saved in tab 1." Notification surfaces in the agent panel.

### M6 — Autonomous execution (gated)
Implement all four policies. `Allowlist` ships first. `FullAuto` requires a sandbox implementation; do not ship without it.

### M7+ — Persistence, search, replay
SQLite-backed history. Embeddings over past blocks. "What did I do last Tuesday to fix this?" works.

---

## What to do FIRST when starting fresh

1. Initialize Tauri 2 project with vanilla TS template.
2. Convert to a Cargo workspace; create the empty crates listed above.
3. In `crates/pty`: spawn `/bin/zsh -i` via `portable-pty`. Write `echo hello\n`. Read back. Assert `"hello"` appears in the output. **This is the smoke test.** Commit.
4. Wire one Tauri command: `spawn_session() -> SessionId`. One event channel: `session://{id}/output` emitting raw bytes.
5. In `ui/`: mount xterm.js, call `spawn_session`, subscribe to the output event, write bytes into the terminal. Type into xterm → bytes flow back via a `write_to_session` command.
6. **Stop. Commit. Verify it feels like a real terminal.** No agent, no blocks, no tabs. Just a working PTY round-trip.
7. Then move to M1.

Resist the urge to design the agent before the PTY plumbing is rock solid. The agent is the easy part once events are reliable.

---

## When the user (Karluiz) asks for a feature

- If it fits in the current milestone → implement it.
- If it jumps milestones → flag the dependency, propose a smaller scoped version of the feature that fits the current milestone, and ask whether to proceed or defer.
- If it conflicts with the architecture above → push back with the reason, propose an alternative, and only proceed after confirmation.

The user is a senior engineer / CTO. Be direct, terse, and technical. No hedging. No over-explaining basics. Show diffs, not prose, when proposing code changes.
