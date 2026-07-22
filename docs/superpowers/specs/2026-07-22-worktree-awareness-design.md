# Worktree awareness — branch chip + live dot

**Date:** 2026-07-22
**Status:** approved, ready for plan
**Mock:** https://claude.ai/code/artifact/51a67d04-6b87-408e-8976-0ef7d8014b9e

## Problem

Worktree-first is correct, but every surface now roots at a different
`.covenant/worktrees/<slug>/`. Two things became invisible:

1. **Which branch am I looking at.** The file tree header shows a truncated path
   (`…/worktrees/agent-claude-0722-wez`) whose tail repeats across every worktree
   and never names the branch. You can't tell it apart from the tab beside it.
2. **Which worktree the running app was built from.** `npm run tauri:dev` compiles
   from whichever worktree launched it. You edit in tab A, test an app built from
   tab B's worktree, and the change never shows. There is no on-screen signal for
   which worktree is live.

The file browser itself is *not* the bug — it roots at the active tab's terminal
cwd (`StructureTree.cwd`, single source of truth, header derived from the same
value). The gap is purely *labelling*: the surfaces don't name the branch or the
live worktree.

## Solution

Two additive signals. No behavior change, no new watcher.

### A — Branch chip on the file tree header

A quiet mono chip on a second line under the path, naming the branch the tree is
rooted at.

- **Data:** `getDirContext(cwd).git.branch` — already used by the ACP view
  (`ui/src/executors/acp/view.ts:1292`) and status bar (`ui/src/status/bar.ts:647`).
  Backed by `git symbolic-ref --short HEAD`, LRU-cached 5s
  (`crates/app/src/context.rs:246`). No backend change.
- **Placement:** second line, below the existing path row, above the file list.
- **Render point:** `StructureTree.renderHeader(cwd)` (`ui/src/structure/tree.ts:504`),
  already called from `setCwd` with the same `cwd` on every re-root.
- **Empty states:**
  - detached HEAD → `getDirContext` already returns the short sha; show it as-is
    (`@ 231e081d`).
  - cwd is not a git repo (`git` null) → hide the chip entirely (no empty second line).
- **Async:** `renderHeader` is sync today; the branch is an async fetch. Render the
  path row immediately, then fill the chip when the promise resolves. Guard against
  a stale fill: capture the cwd at call time and drop the result if `this.cwd`
  changed before it resolved (setCwd can re-fire during the await).

### B — Green running dot on the live worktree's tab

The tab whose worktree is the one the running app was launched from gets its dot
turned green (same visual language as an active process). Dev build only. No text.

- **Backend (new, ~6 lines):** command `dev_live_worktree_root() -> Option<String>`.
  - In `cfg!(debug_assertions)`: `git rev-parse --show-toplevel` on
    `std::env::current_dir()`, canonicalized. In `tauri dev` this cwd equals the
    worktree that ran `npm run tauri:dev` — the codebase already relies on this
    (`crates/app/src/lib.rs:5234`).
  - In release builds: return `None` (Finder-launched `.app` has cwd `/`; nothing
    is "live").
- **Frontend:** fetch the live root once at tab-manager init and cache it. The live
  worktree can't change without restarting the app, and `respawn` restarts the app
  (re-running init), so no re-fetch is needed. A tab is live if its pane cwd hangs
  off the live root: `tabCwd.startsWith(liveRoot)`. Worktrees are sibling dirs under
  `.covenant/worktrees/` and never nested (enforced by AGENTS.md), so prefix
  containment is unambiguous. Apply/remove the `live` class on the tab's existing
  dot whenever a tab is created and on `cwd_changed`.
- **Scope:** the tab only. Not replicated in the git popover or status bar — one
  datum, one place.
- **No match / release:** dot stays in its normal state. Silent, never wrong.

## Files touched

- `ui/src/structure/tree.ts` — branch chip in `renderHeader`, chip CSS.
- `crates/app/src/lib.rs` — `dev_live_worktree_root` command + register in the
  invoke handler.
- `ui/src/api.ts` — thin wrapper `devLiveWorktreeRoot(): Promise<string | null>`.
- `ui/src/tabs/manager.ts` — fetch live root on init + after respawn; apply/refresh
  the `live` dot class across tabs.
- Tab CSS — `.tdot.live` green + subtle pulse (respect `prefers-reduced-motion`).

## Testing

- **A:** unit — `renderHeader` shows the chip for a repo cwd, the short sha for
  detached HEAD, and no chip for a non-repo cwd; stale-fill guard drops a result
  whose cwd no longer matches `this.cwd`.
- **B:** unit — `tabCwd.startsWith(liveRoot)` matches a cwd inside the live
  worktree and rejects a sibling worktree; `dev_live_worktree_root` returns `None`
  under `not(debug_assertions)`. Rust: a test that `rev-parse --show-toplevel` of a
  known worktree canonicalizes to that worktree root.

## Non-goals

- No branch/live-worktree push events or watchers — pull on re-root (A) and once at
  init (B). The live worktree can't change without restarting the app.
- No badge text, no git-popover or status-bar replication of the live dot.
- No change to how the file tree roots itself — it already follows the active
  pane's cwd correctly.
