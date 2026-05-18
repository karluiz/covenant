# Technical steering — Covenant

## Stack

- Desktop shell: Tauri 2.
- Backend: Rust 2021 workspace, Tokio async runtime.
- Frontend: strict TypeScript ESM, Vite, minimal dependencies.
- Terminal rendering: xterm.js plus addons; do not reimplement terminal rendering.
- PTY: `portable-pty`; PTY reader work belongs on `tokio::task::spawn_blocking`.
- Block parsing: OSC 133 markers and OSC 7 cwd updates.
- LLM provider path: central agent dispatch with masking, policy, and cost guardrails.
- Persistence: SQLite via `rusqlite` where existing app patterns use it.

## Rust conventions

- Workspace crates live under `crates/`.
- Use `thiserror` in library crates and `anyhow` at app/Tauri boundaries.
- Avoid `unwrap()` outside tests and `main()`.
- Prefer newtyped sortable IDs with `ulid`.
- Use structured `tracing` fields such as `session_id` and `block_id`.
- Public event/data types should derive `Debug`, `Clone`, and `Serialize` where appropriate.

## TypeScript conventions

- Keep `strict` type safety; avoid `as any` unless documented.
- Wrap Tauri IPC in `ui/src/api.ts` or feature-local typed API helpers.
- Use `camelCase` for functions/variables and `PascalCase` for types.
- Keep xterm instances stable; do not remount on ordinary prop changes.
- Tests live near targets as `*.test.ts` and run with Vitest.

## Safety requirements

- Never send unmasked secrets to model providers.
- Never send raw ANSI to LLM code paths.
- Never call Anthropic/provider APIs outside the central dispatch/safety path.
- New autonomous execution behavior must respect command policy and the non-removable destructive-command blocklist.
- Shell profile modifications require explicit user consent.

## Validation commands

Use the narrowest relevant validation first:

```bash
npm test
npm run build
cargo test --workspace
cargo fmt --all
cargo clippy --workspace --all-targets
```

For Rust dependency or workspace changes, include at least `cargo test --workspace` or a justified narrower package test.
For UI behavior changes, include `npm test`; for type/API changes, include `npm run build`.

## Build/dev commands

```bash
npm install
npm run dev
npm run tauri:dev
npm run build
npm run tauri:build
```
