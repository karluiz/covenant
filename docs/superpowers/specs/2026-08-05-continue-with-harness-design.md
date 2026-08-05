# Continue with… — hand work to another harness

2026-08-05 · Pane context menu

## What

Manual gesture: when a pane is running an executor, right-click →
**Continue with…** → pick another PTY harness from the user's spawns.
Covenant opens a **new tab** in the same group/cwd/placement and feeds it a
short brief plus the last N finished blocks from the source session
(ANSI-stripped, secret-masked).

This is a general “keep going on another harness” action. Quota / session-limit
screens are a common trigger, not a special code path.

Not the same as operator `handoff_task` (teammate routing by skills).

## Product rules

| Rule | Detail |
|---|---|
| Gate | Show only when `pane.executor` is set |
| Destination list | `listSpawns()` minus ACP spawns (`spec.acp`) and minus the spawn whose detected executor matches `pane.executor` |
| Empty list | Omit the menu item entirely |
| Tab | Always **new** tab; source pane untouched |
| Placement | Same `groupId`, `pane.cwd`, tab color; inherit worktree/isolate from how the source tab was placed (do not invent a new worktree) |
| Focus | Activate the new tab (user wants to continue there) |
| Title | `Continue · <spec.label>` |

## Prompt payload

Reuse `readSessionExcerpt(sessionId, n)` (`n = 5`). Backend already returns
plain tails; keep using that path so `mask_secrets` stays server-side.

Template (single string):

```text
Continue this work from another harness.

Source: <source-executor> · cwd <cwd> · branch <branch?>
Why: user asked to continue with <dest-label>.

## Recent terminal context (oldest → newest)
$ <cmd>  (exit <code>)
<tail>

…

## Instruction
Pick up where the previous harness left off. Prefer the existing
worktree/branch; don't re-scaffold. Summarize what you understood, then continue.
```

Caps (fixed, no settings in v1):

- `N = 5` finished blocks
- Total prompt clip ~12–16 KB after assembly
- Branch line omitted if unresolved
- Excerpt failure → still spawn with a minimal brief (cwd + continue instruction) + info toast

Pure builder lives in `ui/src/continue-with.ts` (unit-testable).

## Orchestration

1. User picks destination `SpawnSpec`.
2. Build prompt via `continue-with` + `readSessionExcerpt`.
3. `createTab({ groupId, cwd, color, title, initialCommand: buildSpawnCmdline(spec, claudeTheme) })`.
4. After settle: deliver the **prompt as a separate bracketed-paste submit**
   via `sendPromptToSession` (same path as Prompts in the pane menu).
   - Delay: reuse handoff’s `1500ms` as baseline; prefer “new pane got an
     `executor` detection” with a timeout fallback so we don’t paste into a
     bare shell.
5. Toast: `Continuing with <label>`.

Do **not** stuff the multi-block prompt into argv/`shellQuote` — that path is
fine for short teammate briefs, not for excerpt payloads.

### Errors (best-effort)

| Failure | Behavior |
|---|---|
| Excerpt fails | Minimal brief + toast; still spawn |
| Spawn / createTab fails | Error toast; stop |
| Prompt inject fails | Tab stays open; toast that context was not sent |

## UI

In `TabManager.showPaneContextMenu`, near **Start ACP**:

- Submenu **Continue with…** (chevron + brand icons per spawn, same helpers as
  Start ACP / SpawnsChip).
- Wired through a callback set from `main.ts` (same style as
  `runDefaultAgent` / spawn runners) so the menu stays free of spawn/API
  imports beyond what’s already there.

## Files

| File | Role |
|---|---|
| `ui/src/continue-with.ts` | Prompt assembly, spawn eligibility filter, caps |
| `ui/src/continue-with.test.ts` | Template, clip, fallbacks, filter rules |
| `ui/src/tabs/manager.ts` | Menu item + submenu gating |
| `ui/src/main.ts` | Wire: listSpawns → createTab → delayed `sendPromptToSession` |

No new Rust commands. No MCP changes.

## Tests

- Prompt builder: full template; clips oversize; minimal brief when excerpt empty/fails; branch optional.
- Eligibility: drops ACP specs; drops current executor; returns empty → menu omits item.
- Menu gating (light): item absent when `!pane.executor`.

## Out of scope (v1)

- Auto-detect session/rate-limit strings or inline banner
- ACP destinations (`createAcpTab` + composer submit)
- Editable prompt preview before send
- Killing / interrupting the source harness
- Settings for N / byte caps
- Operator handoff / task attachment

## Done when

1. Pane with a live executor → Continue with… → other PTY harness → new tab
   launches that harness and receives the continue prompt.
2. Source tab unchanged.
3. Injected text has no raw secrets (excerpt path).
4. No quota parser and no ACP path in this ship.
