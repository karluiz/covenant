# Run selection in new tab — design

## Goal
Let the user select text in a terminal pane, right-click, and run that selection
in a freshly spawned tab. Mirrors the "run this somewhere else" affordance shown
in the pane context menu mockup (alongside Split right / Split down / Prompts).

## Scope (this iteration)
- One new context-menu item: **`Run selection in new tab`**.
- Split-pane target is explicitly deferred (the split spawn path lacks the
  "wait for first prompt, then execute" hook that `createTab` already has).

## Behavior
- In `showPaneContextMenu` (`ui/src/tabs/manager.ts`), read
  `pane.xterm?.getSelection()`.
- Trim it. If empty/whitespace-only → **do not** add the item (no impact on the
  current menu). If `pane.kind === "pi"` there is no xterm → `getSelection()` is
  unavailable → item absent.
- When present, insert the item at the **top** of the menu, above the Split
  actions.
- Click → `createTab({ cwd: pane.cwd, groupId: tab.groupId, color: tab.color,
  initialCommand: selection })`, then dismiss the menu.

## Payload semantics
- Send the **raw** `getSelection()` text, multiline as-is (no comment filtering,
  no first-line extraction).
- `createTab`'s existing `initialCmdPending` mechanism writes `${cmd}\n` on the
  first `prompt_start`, i.e. **paste-and-execute** once the shell is ready.
- Truncation, if any, applies only to a display label/tooltip — never the payload.

## UI details
- Label: fixed string `Run selection in new tab` (English-first).
- No native `title` tooltip. If a preview of the selection is desired, route it
  through `attachTooltip` from `ui/src/tooltip/tooltip.ts`.

## Files touched
- `ui/src/tabs/manager.ts` only — a small block inside `showPaneContextMenu`.
- No Rust, no new Tauri commands, no new APIs.

## Edge cases
- Whitespace-only selection → item absent.
- Pi (chat) pane → item absent.
- New tab inherits source pane's cwd, group, and color.

## Out of scope / future
- "Run in split" — needs `spawnPtyForPane` to accept an initial command via the
  same pending-first-command mechanism as `createTab`.
- Paste-without-execute variant.
