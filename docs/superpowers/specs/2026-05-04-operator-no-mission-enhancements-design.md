# Operator enhancements: no-mission rename + /color + /effort

> Date: 2026-05-04
> Status: design draft, pending approval
> Related: Operator (M-OP*), tab manifest, mission system

## Problem

Three small operator capabilities are missing today. They share a theme:
giving the operator (and the user) lightweight signals about what each
tab is doing, even when no mission is set.

1. **No-mission rename**: today the agent only renames the tab when a
   mission is active. Without a mission the tab keeps its default name
   ("zsh", "Tab 3", etc.), so the sidebar gives zero hint of WIP. The
   agent should *always* rename, mission or not — the tab name becomes
   a free-form WIP summary that future features (cross-tab correlation,
   recall) can lean on.

2. **/color (Claude-only)**: when the executor is Claude Code (detected
   by mission kind or process), expose a `/color` slash-style action on
   the tab that recolors the tab chip. Currently color is only set at
   `createTab` and via right-click. A first-class control inside the
   operator surface lets the agent (or user) signal status visually
   (red = blocked, green = passing, yellow = running, etc.).

3. **/effort (Claude-only)**: Claude Code supports a per-session effort
   knob (`low|medium|high|xhigh|max|auto`). The operator should be able
   to set it from the UI without the user typing it into the shell.

## § 1 — Always rename (no-mission included)

### Today

`build_system_prompt` in `crates/app/src/operator.rs` instructs the
agent to call `tab_rename` only when a mission summary exists. The
no-mission branch omits the rename directive entirely.

### Change

- Move the rename directive *out* of the mission block into the always-on
  preamble. New wording (paraphrased): "Always keep the tab name a 2–4
  word summary of current WIP. Rename eagerly when the focus shifts.
  Without a mission, derive the name from the most recent command(s)."
- Keep the existing `tab_rename` IPC unchanged.
- Cache invariant: the new directive lives in the static system prompt
  block (cached). No mutable values — safe.

### Risk

Slight cost increase: agents may rename more often. Mitigated by the
existing rename throttle (no-op if name unchanged) and by Anthropic
prompt cache.

## § 2 — /color (Claude-only)

### Detection

Claude-only because non-Claude executors (raw shell, custom CLIs) have
no native concept of color metadata. Gate by:
- mission kind = `superpowers` *or* operator process detected as
  `claude` (the existing `agent_kind` field on AttachmentState).
- Fallback: hide the affordance when the gate is false.

### Surface

Two entry points:
- **Agent-side**: new IPC `tab_set_color(session_id, color)` exposed
  to the executor via the operator tool list. Agent emits e.g.
  `tab_set_color("red")` when tests fail.
- **User-side**: `/color <name>` typed in the operator panel input
  (existing slash-command parser) calls the same IPC.

Allowed values: `red|blue|green|yellow|purple|orange|pink|cyan|default`.
`default` clears the override and falls back to the manifest color.

### Persistence

- Color override stored on `AttachmentState` (in-memory) and mirrored
  to `TabManifestV1.color` so it survives restart.
- Distinguish "user-chosen color" (sticky) from "agent-suggested
  color" (cleared on mission change / new tab) via a `color_source`
  enum: `User | Agent | Default`. Agent writes only overwrite Agent
  or Default; never User.

## § 3 — /effort (Claude-only)

### Surface

- IPC `tab_set_effort(session_id, level)` with level in
  `low|medium|high|xhigh|max|auto`.
- User-side slash: `/effort <level>` in operator panel input.
- Agent-side: exposed as a tool only when needed; default off to avoid
  the agent thrashing its own effort.

### Wiring to Claude

Two options:
- **A — write to PTY**: emit the literal `/effort <level>\n` into the
  child PTY (Claude Code interprets it as its own slash command). Zero
  backend coupling, fully relies on Claude's existing handler.
- **B — env/flag**: set `CLAUDE_EFFORT=<level>` on the next spawn. Only
  affects new sessions; useless for the live tab.

Pick **A**. Live, no respawn, matches what the user would type.

### Persistence

- Last chosen effort per tab → `TabManifestV1.effort_level: Option<String>`.
- On tab restore, replay the `/effort` write after `prompt_start`
  (same hook used for `initialCommand`).

## § 4 — UI

Minimal additions:

| Surface | Change |
|---|---|
| Operator panel header (Claude tabs only) | Two small dropdowns: Color / Effort. |
| Sidebar tab chip | Existing color rendering already handles arbitrary palette; just consume `color_source != Default`. |
| Status bar | No change. |

## § 5 — Out of scope

- Non-Claude executor effort/color (no equivalent primitive).
- Per-mission default color/effort (could be a follow-up; for now,
  the user picks once and it sticks via persistence).
- Cross-tab batch operations (e.g. "set effort high on all").

## Open questions

1. Should `/color` and `/effort` be available without a mission too?
   → Yes, both are tab-level not mission-level.
2. Should the rename throttle be more aggressive (e.g. min 5s between
   renames) to avoid flicker? → Probably yes; quantify with M-OP
   telemetry once shipped.
3. Color override on excluded-from-AOM tabs: should they get a forced
   muted variant? → Defer; AOM exclusion already has its own icon.
