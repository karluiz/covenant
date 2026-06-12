# Premium Spec Creator — Design

**Date:** 2026-06-07
**Status:** Approved (design)
**Author:** Karluiz + Claude

---

## Goal

Replace today's modal-chat Spec Creator with an **immersive, full-screen, animated** spec-authoring experience backed by a **real read-only research agent**. The agent (Opus 4.8 + extended thinking) actually explores the repository — grep / read / list — so the spec is grounded in real files and symbols, and so the "exploring" animations reflect honest work rather than decoration.

The experience must feel premium: a cinematic takeover, live streamed reasoning, a spec document that assembles itself section by section, an animated phase spine, and a publish celebration — all in Covenant's existing dark chrome.

A visual reference mockup exists at `docs/superpowers/specs/premium-spec-creator-mockup.html` (autoplaying animated preview of the target feel).

## Out of scope

- No change to the published-spec schema, `publish_draft` validation, `spec_detector`, AOM badge/toast/Set-Mission flow, or the on-disk draft format (`~/.covenant/spec-drafts/<ulid>.json`). The new creator is a producer for the *same* downstream pipeline.
- The **manual 6-section wizard** (`ui/src/drafts/wizard.ts`) stays as the no-AI escape hatch ("Blank draft"). We are not removing it.
- No write/exec tools for the agent — strictly read-only repo access.
- No new key-handling abstraction; Esc-to-close reuses the existing capture-phase pattern from `ui/src/shortcuts/panel.ts`.

## Acceptance criteria

**Surface & flow**
- Invoking the Spec Creator (existing entry points: drafts tab "+ New spec", chooser "Start a new one" / "Resume") opens a **full-window takeover**: the workspace recedes (blur + scale-down), a scrim fades in, and the creator scales up (~280ms physical ease). Esc closes via a capture-phase listener (works even with the terminal focused).
- The **chooser** (Resume / Start new / Blank draft) is preserved; "Resume" and "Start new" feed the new streaming surface; "Blank draft" routes to the existing manual wizard unchanged.

**Live reasoning (left column)**
- Agent **thinking** tokens stream live into collapsible "▸ thinking" blocks, **collapsed-but-peeking by default** (latest line visible, expandable on click).
- Each tool call renders as a compact activity row that types out the verb + target + result, e.g. `grep "addEventListener('keydown')" → 9 matches`, `read panel.ts:88-103`. Rows reflect real `tool_start` / `tool_result` events. File paths are briefly highlighted.
- Assistant questions render as chat bubbles; the user replies via the composer.

**Live spec (right column)**
- The six sections (Goal, Out of scope, Acceptance criteria, File boundaries, Complexity, Open questions) render as ghost placeholders, fill with **typed-in text** when their content resolves, and settle with a check + flash-glow.
- The currently-active section is visually outlined. A live `n/6 sections` counter updates.
- Section content is **code-grounded**: Acceptance cites real files/symbols, File boundaries lists actual discovered paths, Open questions reflect genuine ambiguities surfaced during exploration.

**Phase spine (header)**
- Six nodes (Goal → Open questions) advance: completed = filled green, active = accent glow, segments animate a progress fill between them. The spine reflects which sections are *filled*, not a forced linear march — the flow is adaptive.

**Publish**
- When all sections are grounded, the publish bar activates with a summary (`N files · M tool calls`). "Review & publish" runs a brief lift/settle confirmation, then hands off to the existing `publish_draft` → AOM "Set Mission" flow.

**Safety & cost**
- Tool paths are canonicalized and confined under the repo root; `..` escapes, symlinks out of the tree, and secret dirs (`~/.ssh`, `~/.aws`, etc.) are rejected.
- Per-draft token cap and tool-call cap (≤40 calls/spec) enforced; surfaced in the UI. All agent calls go through the existing `agent::dispatch()` guardrail path.

## File boundaries

**Backend (Rust)**
- `crates/agent/src/spec_author.rs` — add a **streaming research path** alongside the existing `step_with_context` (kept for the manual-suggest button). New: Opus 4.8 model id, extended-thinking enabled, SSE streaming parse (`thinking_delta`, text deltas, `tool_use` blocks), read-only tool loop.
- `crates/agent/src/spec_author/tools.rs` (new) — `grep`, `read_file`, `list_dir` tool definitions + executors, repo-root jailed. Path-safety helpers (reuse spirit of `crates/agent/src/safety.rs`).
- `crates/agent/src/spec_author/prompt.md` — revise: keep the 6-section output contract, but instruct adaptive exploration-first authoring and tool use.
- `crates/app/src/lib.rs` — new streaming Tauri command(s) emitting `spec://{draftId}/...` events (`thinking_delta`, `tool_start`, `tool_result`, `text_delta`, `section_update`, `phase`, `turn_done`, `final`, `error`); persist the activity log into the existing draft JSON.

**Frontend (TypeScript)**
- `ui/src/spec-chat/immersive.ts` (new) — full-screen surface: header + spine, two-column stage, composer, publish bar; entrance/exit animation; Esc capture-phase handling.
- `ui/src/spec-chat/activity-stream.ts` (new) — renders thinking blocks + tool activity rows from stream events.
- `ui/src/spec-chat/live-spec.ts` (new) — right-column section renderer (ghost → typed-in → done/flash), phase spine driver.
- `ui/src/spec-chat/state.ts` — extend to subscribe to the streaming event channel (replaces the single request/response `submit`).
- `ui/src/spec-chat/index.ts` — chooser wires "Resume"/"Start new" to the immersive surface; "Blank draft" stays → wizard.
- CSS: mirror the mockup's tokens/animations into the project's styling approach.

## Complexity

**Large.** The hardest parts are (1) the streaming SSE tool-loop with extended thinking in Rust and the granular Tauri event protocol, and (2) the choreographed frontend animation driven by live (variable-timing) events rather than a scripted timeline. The downstream pipeline reuse de-risks the publish/detect side. Recommend phasing: backend streaming + tools first (verifiable headless), then the immersive UI against a mocked event stream, then wire them together.

## Open questions

- **Nested/secondary modals over the immersive surface** (e.g. the publish ID/slug dialog) — layer above, or inline panel within the surface? Leaning inline to preserve immersion.
- **Interruptibility** — can the user send a new message / redirect while the agent is mid-tool-loop, or is each turn atomic? Leaning atomic for v1, with a visible "stop" affordance.
- **Thinking persistence** — do we store streamed thinking in the draft JSON (replayable on Resume) or treat it as ephemeral? Leaning: store a compacted activity log, drop raw thinking deltas.
- **Token/tool-cap UX** — soft warning then hard stop, vs. silent cap. Leaning soft warning surfaced in the publish bar.
