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

### M8 — Windows support *(deferred)*
Architecture is already cross-platform: Tauri 2 (WebView2), `portable-pty` (ConPTY on Win10 1809+), xterm.js, Rust/Tokio. Work required:
- **Shell integration for PowerShell**: emit OSC 133 from the `prompt` function (same approach as VSCode/WezTerm/Warp). Add `shell-integration/osc133.ps1`.
- **Default shell detection**: prefer `pwsh` > `powershell` > `cmd`, with WSL bash as opt-in (reuses existing zsh/bash snippets verbatim).
- **Build pipeline**: Windows runners for code signing and `.msi` packaging via Tauri.
- **Platform details**: ConPTY resize semantics (no SIGWINCH), font/chrome differences in WebView2, path separators already handled via `PathBuf`.

Do not start until M1–M5 are solid. Keep the macOS path canonical; Windows is additive.

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

---

## Release & Distribution

Covenant distributes via **GitHub Releases** with Apple Developer ID signing + notarization, and via a **Homebrew tap** at `karluiz/homebrew-covenant`. **NOT** via the Mac App Store — a terminal that spawns shells via PTY cannot pass Apple's sandbox requirements (iTerm2, Warp, WezTerm all distribute this same way for the same reason).

### Cutting a release

Use the `horizon` skill — it bumps version in `package.json`, `crates/app/Cargo.toml`, and `crates/app/tauri.conf.json`; writes the `CHANGELOG.md` entry; commits; tags; pushes.

The tag push triggers `.github/workflows/release-macos.yml`, which:
1. Compiles for `aarch64-apple-darwin`
2. Signs with Developer ID Application cert (via `APPLE_CERTIFICATE` / `APPLE_SIGNING_IDENTITY` secrets)
3. Notarizes with `notarytool` (via `APPLE_API_KEY` / `APPLE_API_ISSUER` / `APPLE_API_KEY_CONTENT` secrets)
4. Uploads `Covenant_<version>_aarch64.dmg` + `.app.tar.gz` + `.sig` to the GitHub Release
5. Computes the `.dmg` sha256 and **auto-updates the Homebrew cask** at `karluiz/homebrew-covenant` (requires `HOMEBREW_TAP_TOKEN` secret — see below)

The Windows workflow runs in parallel and emits the `.msi`. The aggregate `latest.json` (auto-updater manifest) is built by `release-manifest.yml` once both per-platform jobs finish.

### GitHub Actions secrets reference

| Secret | Source | Notes |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | `tauri signer generate` | For Tauri's auto-updater `.sig`, NOT Apple |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | (you set) | |
| `APPLE_CERTIFICATE` | `base64 -i covenant-dev-id.p12` | The Developer ID Application `.p12`, base64-encoded |
| `APPLE_CERTIFICATE_PASSWORD` | (you set when exporting) | |
| `APPLE_SIGNING_IDENTITY` | `security find-identity -v -p codesigning` | Exact string: `Developer ID Application: <Name> (<TeamID>)` |
| `APPLE_TEAM_ID` | developer.apple.com top-right | 10 chars |
| `APPLE_API_KEY` | App Store Connect → Users and Access → Keys | The 10-char Key ID |
| `APPLE_API_ISSUER` | Same page | UUID at top of page |
| `APPLE_API_KEY_CONTENT` | Contents of the `.p8` file | Includes `-----BEGIN PRIVATE KEY-----` lines |
| `HOMEBREW_TAP_TOKEN` | GitHub PAT (fine-grained) | Needs `Contents: read+write` on `karluiz/homebrew-covenant` only |

### Setting up `HOMEBREW_TAP_TOKEN` (one-time)

1. https://github.com/settings/personal-access-tokens → **Generate new token** → **Fine-grained**
2. Resource owner: `karluiz`. Repository access: **Only select repositories** → `karluiz/homebrew-covenant`
3. Permissions → **Repository permissions** → **Contents: Read and write**
4. Generate, copy the `github_pat_*` string
5. `gh secret set HOMEBREW_TAP_TOKEN --repo karluiz/covenant` and paste

If this secret is missing, the cask-update step in `release-macos.yml` is skipped (`continue-on-error: true`) and you'll need to manually update `Casks/covenant.rb` in the tap repo with the new version + sha256 from that release.

### Install command for users

```bash
brew install --cask karluiz/covenant/covenant
```

Tap auto-discovers under the `homebrew-` prefix. After first install, upgrades are just `brew upgrade --cask covenant`.

### What this DOES NOT cover yet

- **Intel (x86_64) builds** — release workflow currently only targets `aarch64-apple-darwin`. To add Intel: build a second target and either ship two `.dmg`s with `on_arm`/`on_intel` blocks in the cask, or build a universal binary with `lipo`.
- **Submission to the official `homebrew-cask` repo** — requires ~30 days of stable releases and ideally universal binaries. Self-tap is canonical for now.
- **Sparkle / auto-update through Homebrew** — Covenant's built-in updater (Tauri's) is the canonical update path; Homebrew users get updates via `brew upgrade`.
