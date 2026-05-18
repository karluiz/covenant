# Structure steering — Covenant

## Repository map

- `crates/app/` — Tauri commands, IPC wiring, app state, app-boundary errors.
- `crates/pty/` — terminal process and pseudo-terminal abstraction.
- `crates/blocks/` — OSC 133/OSC 7 parsing and terminal block types.
- `crates/session/` — session lifecycle and event bus.
- `crates/agent/` — LLM client, dispatch path, super-agent/world-model logic.
- `crates/capabilities/`, `crates/familiar/`, `crates/score/` — higher-level operator/familiar/capability features.
- `ui/src/` — frontend TypeScript features (`terminal`, `operator`, `settings`, `spec-chat`, `project-notes`, etc.).
- `shell-integration/` — shell snippets for OSC markers.
- `docs/specs/` — implementation-ready feature specs.
- `docs/plans/`, `docs/mockups/`, `design/` — planning and visual references.

## Spec conventions

Canonical specs live in `docs/specs/` and follow `docs/specs/_template.md`.
A good spec includes:

- Goal stated as user-visible outcome.
- Aggressive out-of-scope list to prevent drift.
- Observable acceptance criteria.
- Explicit file boundaries and do-not-touch areas.
- Complexity estimate and open questions.
- AOM run notes after implementation begins.

When creating new specs, keep IDs consistent with existing files, e.g. `3.21-short-slug.md`, unless the maintainer chooses a different milestone namespace.

## Implementation boundaries

- Respect the file boundaries in the active spec. If acceptance criteria require expansion, stop and report the proposed scope change.
- Keep frontend feature code inside its feature folder unless shared UI/state is already established elsewhere.
- Keep backend domain logic in the owning crate; use `crates/app` for Tauri command exposure and wiring.
- Do not duplicate provider clients, PTY readers, block parsers, or safety logic in feature code.
- Prefer focused tests beside changed code rather than broad snapshot-style coverage.

## Existing project state

This repository already contains a mature spec habit under `docs/specs/`; SDD steering should augment that workflow, not replace it. Treat `.sdd/steering/*` as persistent context and `docs/specs/*` as the operational backlog for agent execution.
