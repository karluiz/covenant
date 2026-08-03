---
name: verify
description: Verify Covenant UI changes live in the dev app autonomously — DOM-dump recipe (boot snippet + local HTTP listener) driving the real code path from the boot scope.
---

# Covenant in-app verify (DOM dump)

Synthetic input is impossible (osascript blocked, no Accessibility). Verify by
running the dev app with a `// TEMP-VERIFY` boot snippet that exercises the
feature and POSTs DOM state to a local listener. **Always revert the snippet
(and any config change) after.**

## Recipe

1. **No identifier change needed.** `crates/app/tauri.dev.conf.json` already
   sets `com.karluiz.covenant.dev`, so `tauri-plugin-single-instance` lets the
   dev build run beside prod, with its own app-data dir. That dir is a fresh,
   unconfigured install (no API keys, no providers) — seed what your probe
   needs via the api.ts wrappers. The keychain token IS shared, so
   `canonMyOrgs()` may still succeed with the demo account's orgs.
   (Historical: before `tauri.dev.conf.json` existed, verify runs had to
   TEMP-change `identifier` in `tauri.conf.json`. Don't — it breaks the
   side-by-side guarantee.)

2. **Listener:** node HTTP server on `127.0.0.1:43117` writing the POST body to
   a file. MUST answer `OPTIONS` with CORS headers (allow-origin *,
   allow-methods POST, allow-headers content-type) — or skip preflight entirely
   by POSTing **without** a `content-type` header from the snippet (simple
   request). A 0-byte dump file = the preflight hit you and the POST never came.

3. **Snippet:** inject after `const settings = new SettingsPanel(...)` in
   `ui/src/main.ts` (that scope sees `manager`, `mountCanon`, `settings`, all
   api imports). `setTimeout(..., 5000)` after boot. `npx tsc --noEmit -p
   tsconfig.json` before launching — the snippet must type-check.

4. **Launch:** `npm run tauri:dev` in background **with sandbox disabled**
   (sandboxed GUI processes die). Fresh instance has NO active group —
   `mountCanon()` early-returns; construct `CanonPanel` / `CanonCockpitView`
   directly with fake group args instead, and `await panel.refresh()` rather
   than racing timers.

5. **HMR does NOT re-fire the snippet** — hidden/unfocused webview suspends
   timers. After every snippet edit: `pkill -f "target/debug/covenant"` and
   relaunch (incremental rebuild ~1min).

6. **Drive the real path, defang its payload.** Call the production entry point
   (a `manager.*` hook, a panel method) rather than re-implementing its logic in
   the snippet — otherwise you verified the snippet, not the feature. Private
   members are reachable at runtime through a cast, which is fine in a snippet
   you are about to delete. When the path ends in launching something expensive
   or irreversible (an executor, a push, a delete), swap the *payload* first:
   e.g. `upsertSpawn` a temp default spec running `echo` so "start agent"
   exercises every branch without spawning a real agent. Restore the prior
   state at the end of the snippet.

7. **Assert on counts + state, not screenshots.** `document.querySelectorAll(
   ".tab-pane").length` before/after, `tab.groupId`, `pane.cwd`, `pane.executor`
   — POST them as one JSON array of labelled probes. To exercise a "busy" branch,
   set the state directly (`pane.executor = "claude"`) instead of waiting for a
   real process.

8. **Clean up what the run created**, not just the snippet: worktrees and their
   `agent/*` branches (`git worktree remove --force` + `git branch -D` — the
   branch is named `agent/<slug>` while the directory is `agent-<slug>`), temp
   spawn specs, the listener process, and the dev app (`pkill -f
   "target/debug/covenant"`).

9. Org semantics gotcha for assertions: `resolveActiveOrg` falls back to
   `orgs[0]` when no personal org exists — a token with only non-personal orgs
   makes the rail/cockpit default to that org, so personal-bucket operators
   legitimately don't appear. Assign your seeded entity to the active org for
   a positive-render probe.
