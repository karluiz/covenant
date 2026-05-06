# Covenant

> An AI-native terminal for macOS. The terminal *is* the substrate the agent operates on.

Covenant is not a terminal with an AI assistant bolted on. It is a terminal built from the ground up around an autonomous **super-agent** that observes every session you open, builds a live model of what you're doing across all of them, and — when authorized — acts on your behalf.

Built with **Tauri 2 + Rust + xterm.js**.

---

## The covenant

Every session you open emits a structured stream of events: commands, outputs, exit codes, working-directory changes. A long-lived agent subscribes to this stream across **all your tabs** and:

- Maintains a rolling per-session world-model that survives indefinitely (prompt caching).
- Correlates activity across sessions — you edit `foo.rs` in tab 1, tests fail in tab 2, the agent connects the dots.
- Surfaces next-best-actions, catches errors early, and proposes fixes inline on non-zero exit.
- Executes commands autonomously **only** under an explicit policy you choose per session (`SuggestOnly` by default; `Allowlist`, `ConfirmEach`, or sandboxed `FullAuto`).

In exchange, the agent operates under a hard contract:

- A **non-removable blocklist** for destructive commands (`rm -rf`, `sudo`, `curl | sh`, `dd`, `mkfs`, writes to `~/.ssh`, force-pushes to protected branches, fork bombs, …). Removing entries requires a code-review justification.
- **Secrets are masked** before reaching the model — API keys, JWTs, GitHub/AWS tokens, private keys.
- **Cost guardrails** in every code path: per-minute and per-day token caps. There is no path that calls the LLM outside the central dispatcher.

That is the covenant: full observability and capability, in exchange for hard, code-enforced limits.

---

## Why

Existing terminals treat AI as a sidebar. Output goes to the user; the assistant gets whatever you paste into a chat. Covenant inverts this: the shell runs inside a PTY **we own**. Every byte is structured into blocks via OSC 133 shell integration, broadcast on an event bus, and made available to the agent in real time. There is no "interception" — we are the master of the PTY.

This unlocks things a chat-bolted-on terminal cannot do:

- The agent sees your failing test the instant it fails — no copy-paste round trip.
- Cross-session reasoning: long-running build in one tab, edits in another, deploy in a third, all in one world-model.
- Autonomous work, gated by policy and a real safety surface, not vibes.

---

## Status

Pre-1.0. Active development on macOS. Windows support is architected for but deferred until the macOS path is solid (see `CLAUDE.md` → M8).

Current capabilities include multi-session tabs with persistence, OSC 133 block parsing, mission-driven autonomous operation with cost caps, command recall over shell history, OS notifications, and a Familiars roster for per-session agents. See `CHANGELOG.md` for the running log.

---

## Install

Download the latest `.dmg` from [Releases](../../releases/latest), drag `Covenant.app` to `/Applications`, and launch.

On first run, Covenant will offer to install OSC 133 snippets into your `~/.zshrc`, `~/.bashrc`, or fish config. Without these, block segmentation falls back to heuristics — accept the prompt for the real experience.

You will need an **Anthropic API key** for the agent. Set it in `Settings → API Key`, or export `ANTHROPIC_API_KEY` in your shell.

---

## Build from source

Prerequisites: Rust (stable), Node.js 20+, Xcode command-line tools.

```bash
git clone <this-repo>
cd karlTerminal
npm install
npm run tauri:dev      # dev build with hot reload
npm run tauri:build    # release build → src-tauri/target/release/bundle/dmg/
```

Run the test suite:

```bash
cargo test --workspace
npm test
```

---

## Architecture (TL;DR)

```
xterm.js (UI)  ⇄  Tauri IPC  ⇄  Rust backend (Tokio)
                                  ├─ Session Manager → portable-pty
                                  ├─ Block parser (OSC 133)
                                  ├─ Event bus (tokio::broadcast)
                                  └─ Super-agent (Anthropic Messages API, prompt-cached)
```

Full design notes, milestones, and non-negotiables are in [`CLAUDE.md`](CLAUDE.md). Read it before opening a non-trivial PR — it documents the architectural commitments (own the PTY, don't reimplement VT, don't bypass the safety dispatcher) that contributors are expected to respect.

---

## Contributing

Covenant is open source and contributions are welcome. A few things to know before you start:

### What we want

- **Bug fixes** with a failing test that demonstrates the bug, then the fix.
- **New features that fit the current milestone** (see `CLAUDE.md` → Milestones). If a feature jumps milestones, open an issue first describing the dependency and a smaller scoped version.
- **Improvements to shell integration**, OSC 133 robustness, or block parsing edge cases.
- **Safety contributions**: additions to the blocklist, better secret masking, sandbox work for `FullAuto`. These are reviewed carefully but enthusiastically.

### What we will push back on

- Reimplementing the VT/ANSI parser. Use `vt100` for headless reads; xterm.js renders. This is non-negotiable.
- Heuristic block parsing without OSC 133.
- Polling stdout instead of draining the PTY reader.
- Sending raw ANSI or unmasked content to the LLM.
- Bypassing `agent::dispatch()` to call the Anthropic API directly.
- Adding Electron, React, Webpack, or other heavyweight frontend dependencies. The frontend stays minimal.
- Removing entries from the safety blocklist without a written justification in the PR description.

### Workflow

1. **Open an issue first** for anything beyond a small fix. Describe the problem, the proposed approach, and which milestone it fits.
2. **Branch from `main`**. Keep commits small and focused; conventional commit prefixes (`feat:`, `fix:`, `refactor:`, `chore:`) are appreciated.
3. **Write tests.** Rust changes ride with `cargo test`; UI changes with `vitest`. New safety rules require unit tests in `crates/app/src/safety.rs`.
4. **No `unwrap()` outside tests and `main()`.** Errors use `thiserror` in libraries, `anyhow` at the binary boundary.
5. **No secrets in fixtures.** Use the existing test fixtures in `safety.rs` for credential-like patterns; gitleaks runs on every push.
6. **Open the PR** with a short description of *why* (the *what* is in the diff), the milestone it touches, and any safety implications.

### Code of conduct

Be direct and technical. No hedging, no over-explaining basics, no performative niceness. Disagreement is fine; bad-faith argument is not. If a maintainer pushes back on an architectural choice, the burden is on the contributor to either update the design or explain why the architecture should change — not the other way around.

---

## Future work to revisit

- **Project Notes — repo-backed storage.** The first cut of Project Notes
  (Commands / Notes / Docs per group, see
  `docs/superpowers/specs/2026-05-06-project-notes-design.md`) stores data
  in the app's SQLite. The interesting medium-term direction is binding a
  project to a filesystem root and persisting `commands.toml`,
  `notes.jsonl`, and `project.md` under `<root>/.covenant/`. That makes
  notes portable across installs, git-versionable, and readable directly
  by operator subagents without IPC. Worth picking up once the in-app
  shape settles.

---

## License

Dual-licensed under either of:

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT License ([LICENSE-MIT](LICENSE-MIT))

at your option. Contributions are accepted under the same terms.
