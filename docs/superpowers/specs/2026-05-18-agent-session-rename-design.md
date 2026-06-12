# Forward tab rename into running agent session

**Date:** 2026-05-18
**Status:** Draft — pending implementation plan

## Motivation

When an agent executor (claude / copilot / codex / opencode / pi) is running
in a tab, the *tab name* is the only handle the user has on that session.
Today, renaming a tab changes our local label but does not propagate into the
agent itself. Sessions therefore end up with our label saying one thing and
the agent's internal session name saying another (or nothing at all).

Naming every running agent session is a discipline we want to enforce: it
makes cross-session correlation, recall, and persistence behave predictably,
and it gives the super-agent a stable handle when reasoning about what's
happening in each tab.

## Scope

In scope:

1. When the user renames a tab in which an agent executor is running, treat
   the new `customName` as the canonical session name on our side. This is
   already what `commitTabRename` produces — we just commit to it as the
   authoritative source for the agent's session label going forward.
2. For executors we control via IPC (currently **pi** only), forward the
   rename into the agent so its internal session metadata matches.
3. Gate the forwarded rename on the agent session being currently *unnamed*
   on our side — i.e. the tab had no `customName` (or was on the default
   `defaultTitle`) prior to this rename. If the user is renaming an
   already-named tab, do not re-inject.

Out of scope (deferred until each agent exposes a rename API we can call
without PTY keystroke injection):

- Runtime rename for `claude`, `codex`, `copilot`, `opencode`. None of these
  expose a stable, documented runtime rename command today. We will not
  fake one by typing slash-commands into the PTY — that risks corrupting
  whatever the user is currently composing in the agent's input.
- Renaming sessions opened before this feature shipped (no migration).
- Two-way sync (agent renames itself → tab updates). One-way only for now.

## Design

### Detection of "unnamed"

A session is *unnamed* iff, immediately before the rename commit,
`tab.customName` is `null` or empty after trim. This is already the
distinction `tabDisplayName` (manager.ts:329) uses to fall back to
`defaultTitle`. We do not need a separate flag.

### Trigger point

In `TabManager.commitTabRename` (manager.ts:3403), after the existing
`tab.customName = …` assignment and before `scheduleSave`, capture:

- `wasUnnamed`: whether `customName` was null/empty *before* this call
- `newName`: the trimmed value (only if non-empty)
- `tab.executor` and `tab.kind`

If `wasUnnamed && newName && (tab.kind === "pi" || tab.executor === "pi")`,
dispatch a rename to the pi executor for `tab.sessionId`. For any other
executor value, do nothing (we still keep our local rename — only the
*forwarding* is skipped).

### Pi rename pathway

Pi already speaks to the backend over a typed RPC channel (see
`2026-05-16-pi-rpc-executor-design.md`). Add one method:

- Frontend: `api.renameAgentSession(sessionId, name)` in `ui/src/api.ts`,
  wrapping a new Tauri command `agent_session_rename`.
- Backend: `agent_session_rename(session_id, name)` in
  `crates/app/src/operator.rs` (or the pi RPC module — pick the file that
  already owns pi's IPC). Resolves the pi adapter, calls its rename method.
- Pi adapter: extend `crates/capabilities/src/adapters/pi.rs` with a
  `rename(&self, name: &str)` that updates pi's session metadata over its
  existing transport.

If pi is not actually attached to the tab (e.g. it crashed), the backend
returns an error and the frontend logs it but does not surface to the user
— the local rename has already succeeded and that's what the user cares
about.

### Other executors

For `claude`, `copilot`, `codex`, `opencode`: the frontend simply skips the
forwarding step. A `tracing::debug!` line on the backend logs that we'd
have renamed if a forwarding adapter existed, so it's visible during dev
without being noisy.

Adding a real runtime rename for any of these later is a one-file change:
implement `rename` on that adapter and extend the dispatch match arm.

## Non-goals / pitfalls avoided

- **No PTY keystroke injection.** We never `write_to_session` characters
  that pretend to be the user typing `/rename …`. That would race with
  whatever the user is composing and could leak into prompts.
- **No silent backfill.** Sessions already running before this ships keep
  whatever name they have. Only an explicit user rename triggers the
  forwarding.
- **No two-way sync.** Out of scope; would require each agent to emit a
  rename event we can subscribe to, which most don't.

## Testing

- Unit: `commitTabRename` with a pi-executor tab and previously-null
  `customName` calls the new api method exactly once with the new name.
- Unit: same call with a non-pi executor does *not* call the api method.
- Unit: renaming an already-named pi tab does *not* call the api method
  (re-rename case).
- Rust unit: `agent_session_rename` returns the adapter's error verbatim
  when pi isn't attached.

## Open questions

None blocking implementation. If `claude` / `codex` / `copilot` /
`opencode` add a documented rename surface later, each is a small follow-up
PR against its adapter.
