# Repository Guidelines

## Project Structure & Module Organization

Covenant is a Tauri 2 desktop app with a Rust backend and a minimal TypeScript frontend. Rust workspace crates live in `crates/`: `app` owns Tauri commands and app wiring, `pty` wraps terminal process handling, `blocks` parses OSC 133 terminal blocks, `session` manages lifecycle/events, `agent` handles LLM/provider logic, and `capabilities`/`familiar` provide higher-level features. Frontend code is in `ui/src`, with feature folders such as `terminal`, `operator`, `settings`, `spec-chat`, and `project-notes`. Tests sit beside their targets as `*.test.ts` in `ui/src` and under each crate's `tests/` directory. Shell snippets are in `shell-integration/`; design notes and specs are in `docs/`.

## Build, Test, and Development Commands

- `npm install`: install frontend and Tauri CLI dependencies.
- `npm run dev`: run the Vite frontend only.
- `npm run tauri:dev`: run the full desktop app with hot reload.
- `npm run build`: type-check TypeScript and build the Vite bundle.
- `npm run tauri:build`: create a production Tauri build.
- `npm test`: run Vitest tests.
- `cargo test --workspace`: run all Rust workspace tests.
- `cargo fmt --all` and `cargo clippy --workspace --all-targets`: format and lint Rust before larger PRs.

## Coding Style & Naming Conventions

Rust uses edition 2021, 4-space indentation, `snake_case` modules/functions, and `PascalCase` types. Prefer `thiserror` in library crates and `anyhow` at app boundaries. Avoid `unwrap()` outside tests and `main()`. TypeScript is strict ESM; use `camelCase` functions/variables, `PascalCase` types, and typed wrappers for Tauri IPC in `ui/src/api.ts` or local feature APIs. Keep frontend dependencies lightweight; xterm.js renders terminal output.

## Testing Guidelines

Add focused tests with behavior changes. Use `cargo test --workspace` for Rust crates and `npm test` for UI logic. Name UI tests `feature.test.ts` near the source file. New parsing, safety, persistence, or provider behavior should include regression coverage.

## Commit & Pull Request Guidelines

History follows Conventional Commits, for example `feat(pi-rpc): ...` and `chore(shortcuts): ...`. Keep commits scoped and milestone-relevant. PRs should explain why the change exists, list user-visible behavior, link related issues/specs, include screenshots for UI changes, and call out safety implications such as command execution, secret handling, or LLM dispatch paths.

## Architecture & Safety Notes

Respect the PTY-first architecture: do not reimplement VT parsing, do not bypass OSC 133 block handling, and do not call model providers outside the central safety/dispatch path. Never persist or send unmasked secrets or raw ANSI content to LLM code paths.

<!-- cdlc:start -->
# CDLC context (auto-generated — do not edit inside this block)

## kyc-peru v1.0.0

# KYC — Perú (SBS)

Al evaluar onboarding o aprobación de productos:

- **Exigir** documento de identidad vigente y verificación de identidad antes de aprobar.
- Si falta KYC, **rechazar** y citar la resolución SBS aplicable.
- Conservar evidencia de la verificación según el período de retención regulatorio.
<!-- cdlc:end -->
