# `cd`-picker — inline directory autocomplete

**Date:** 2026-06-26
**Status:** Approved (brainstorming)

## Goal

When the user types `cd ` (and an optional partial path) at a bare shell prompt,
show an inline overlay listing the directories at the resolved location —
matching the reference screenshot (a `CURRENT LOCATION` header over a list of
folders with folder icons). Selecting a directory `cd`s the active terminal
into it.

## Scope

Pure **frontend** feature. **No backend changes** — `structure_list_dir`
already returns directory entries in the needed shape. One new module plus a
hook in the existing `onData` flow.

### Out of scope (v1)
- Click-to-drill-down into a directory without running `cd` (deeper paths are
  reached by typing more, which re-filters). Select = `cd`-and-run.
- File completion — directories only (`cd` only takes dirs).
- A new server-side prefix-search command (we filter client-side).

## Reused infrastructure

| Need | Existing piece |
|---|---|
| What the user has typed on the prompt line | `RecallManager.currentLine()` (`ui/src/recall/manager.ts`) |
| Keystroke interception + PTY write-back | `term.onData` hook in `ui/src/tabs/manager.ts` (~3617) |
| List directories at a path | `structureListDir(cwd)` → `DirEntry[]` (`ui/src/api.ts`) |
| Write bytes to the active PTY | `writeToSession(sessionId, bytes)` (`ui/src/api.ts`) |
| Active session cwd | `activePane(tab).cwd` |
| Anchored overlay positioning | `.prompt-hint` pattern (`ui/src/terminal/prompt-detect.ts`) |
| Folder icon | `Icons.folder()` |

## Component

**New file:** `ui/src/terminal/cd-picker.ts`

Exports `mountCdPicker(host, term, { writeBytes, syncRecall }) -> CdPicker`,
mirroring `mountPromptHint`. The `CdPicker` interface:

```ts
interface CdPicker {
  readonly visible: boolean;
  // re-evaluate against the current prompt line; shows/hides + refreshes list
  update(bare: boolean, line: string, cwd: string | null): void;
  // returns true if it consumed the key (caller must NOT forward to PTY)
  handleKey(data: string): boolean;
  reset(): void;   // OSC 133 prompt_start
  dispose(): void;
}
```

State held internally: resolved `listDir`, `prefix`, the filtered `DirEntry[]`,
the highlighted index, and a debounce timer.

## Flow

### 1. Trigger
In the bare-shell branch of the `onData` hook, after `recall.notifyInput(data)`:

```ts
const line = recall?.currentLine() ?? "";
cdPicker.update(bare, line, activePane(tab).cwd);
```

`update` shows the picker iff `bare && /^cd\s+/.test(line)`; otherwise it hides.

### 2. Resolve path
Strip the `cd ` prefix → `arg`. Split `arg` at the **last** `/`:
- `prefix` = text after the last `/` (the basename being typed)
- `dirPart` = text up to and including the last `/` (empty if no `/`)

Resolve the listing directory:
- starts with `/` → absolute: `listDir = dirname-of(arg)`
- starts with `~` → expand leading `~` to `$HOME`, then resolve
- otherwise → `listDir = join(cwd, dirPart)`

Empty `arg` → `listDir = cwd`, `prefix = ""` (the screenshot's "current location"
case).

### 3. Query + filter (debounced ~120ms)
`structureListDir(listDir)` → keep `kind === "dir"`, keep `name` whose
lowercased value `startsWith` lowercased `prefix`. Sort dirs-first is already
done server-side. Store as the candidate list; reset highlight to 0.

A stale/invalid `listDir` (e.g. user mid-typing a path that doesn't exist yet)
returns an error → hide the picker silently.

### 4. UI
DOM overlay `.cd-picker` appended to the same `host` as `.prompt-hint`:
- `position: absolute; z-index: 7; pointer-events: auto`
- Anchored under the cursor line: `top = (cursorY + 1) * cellHeight + 4`, `left: 8px`
  (same math as `prompt-detect.ts` reposition)
- Header row: `CURRENT LOCATION` label + the resolved `listDir` path (ellipsized)
- Scrollable list: each row = `Icons.folder()` + `name`; highlighted row has the
  selected-surface background. Mouse `mousemove` moves highlight (not
  `mouseenter`, per existing convention); click selects.
- Empty filtered list → hide (don't show an empty box).

### 5. Navigate (key interception)
`handleKey(data)` is called in `onData` **before** forwarding to the PTY, only
when `cdPicker.visible`. It consumes and returns `true` for:
- `\x1b[A` / `\x1b[B` (↑/↓) → move highlight, re-render
- `\r` (Enter) → select highlighted, return true
- `\x1b` (Esc) → hide, return true

Everything else returns `false` → forwarded normally, then `update` re-filters.
Consuming ↑/↓/Enter prevents the shell from seeing them (no history scroll, no
premature submit).

### 6. Select
Full path typed back = `dirPart + name`. Inject:
```ts
writeBytes(encode("\x15" + "cd " + fullPath + "\n"));  // ^U kill line, retype, run
syncRecall("\x15" + "cd " + fullPath + "\n");           // keep shadow buffer honest
cdPicker.reset();
```
`^U` clears whatever the user typed; we retype the canonical `cd <path>` and run
it. Overlay closes.

### 7. Reset
On OSC 133 `prompt_start` (same place `promptHint.reset()` is called), call
`cdPicker.reset()` — clears list, highlight, hides.

## Wiring in `tabs/manager.ts`

1. Mount alongside `promptHint` where `RecallManager`/`promptHint` are created,
   passing `writeBytes: (b) => writeToSession(sessionId, b)` and
   `syncRecall: (s) => recall?.notifyInput(s)`.
2. In `onData`, **before** the default PTY forward: if `cdPicker.handleKey(data)`
   returns true, `return` (don't forward).
3. After `recall.notifyInput(data)` in the bare branch, call
   `cdPicker.update(bare, line, cwd)`.
4. In the OSC 133 prompt_start handler, add `cdPicker.reset()`.
5. In dispose, `cdPicker.dispose()`.

## ponytail simplifications (deliberate)

- **Client-side filter** over `structureListDir` (lists all dirs, filters in JS)
  instead of a new server prefix command. `// ponytail: client-side dir filter;
  add a server-side prefix arg if a dir with thousands of entries lags.`
- **Shadow-buffer drift** on arrow-keys / history recall is inherited from
  `RecallManager` and bounded to one prompt line — acceptable, same as the
  existing prompt-hint.
- **`~` expansion** needs `$HOME`. If no frontend home source exists, the
  implementation adds the smallest thing (one Tauri/env read) rather than a
  config. `// ponytail: leading ~ only; no $VAR expansion.`

## Test

One vitest covering the pure logic in `cd-picker.ts`, extracted as a helper:
`resolveCdArg(arg, cwd, home) -> { listDir, prefix }` and
`filterDirs(entries, prefix) -> DirEntry[]`. Cases: empty arg → cwd; `src/comp`
→ join + prefix `comp`; `/abs/pa` → abs dirname + prefix `pa`; `~/Doc` → home +
prefix `Doc`; case-insensitive prefix match; non-dirs excluded.
(Run vitest from the repo **root**, not `ui/`.)
