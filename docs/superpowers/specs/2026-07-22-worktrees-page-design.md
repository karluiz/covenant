# Worktrees management page — design

**Date:** 2026-07-22
**Branch:** `agent/worktrees-page-0722`
**Status:** approved, pending implementation plan

## Problem

Worktree management currently lives entirely in the git status-bar popover: a
scrollable list with `Open tab` / `Reclaim` / `Prune` / `Relocate` actions. It
answers "which worktrees exist" but not the two questions that matter once
worktrees accumulate:

1. **How much disk is each one eating?** Build artifacts pile up invisibly — a
   single worktree is currently **6.2 GB** (≈6.1 GB of it `target/`) while its
   siblings are 52 MB each. The popover surfaces size only inside the bulk
   reclaim confirm toast.
2. **What was this worktree working on?** Branch name alone doesn't say. There's
   no view of the last commit, uncommitted changes, or diffstat per worktree.

We need a bigger surface — same class as the full-screen **Changes** (⌘⇧C) and
**Pulse** (⌘⌥M) views — that is both a **disk-reclaim dashboard** and a
**per-worktree context/diff view**.

## Non-goals

- **No LLM diff-explain.** A free structured summary (branch + last commit +
  changed files + diffstat) covers ~80% of "what was this". An AI `Explain`
  button is a possible follow-up, explicitly deferred.
- No per-subdirectory disk breakdown beyond `target/`.
- No popover restructure. The popover keeps its full list and gains one link.
- No new router / navigation model. This is a toggled overlay, like Changes/Pulse.

## Architecture

New `WorktreesSurface` overlay mirroring the existing full-screen pattern
(`ui/src/pulse/index.ts` is the minimal template; `ui/src/changes/index.ts` the
fuller one). Uniform state model already used by both:

- A dedicated host `<div>` appended to `document.body`, instantiated once in
  `main.ts`.
- Internal `open_` boolean + `isOpen` getter.
- `body.worktrees-fullscreen` class toggled for CSS.
- A **capture-phase** `keydown` listener (`addEventListener("keydown", fn, true)`)
  so Escape isn't swallowed by the xterm terminal behind the overlay.
- `open(repoRoot)` mounts the shell + loads data; `close()` empties the host.

New files:

- `ui/src/worktrees/index.ts` — `WorktreesSurface` (shell, list, detail, actions).
- `ui/src/worktrees/worktrees.css` — `.worktrees-fullscreen` / `.wt-frame` styling.

Reused, not duplicated:

- `ui/src/status/worktree-state.ts` — `worktreeDefaultAction`, `worktreeStateLabel`,
  `worktreeStateClass`, `hasOccupiedTab`.
- `ui/src/status/bar.ts` helper `compactPath` (extract/share if not exported).
- `ChangesSurface` — the "View diff" action hops into it for a given cwd.

## Wiring (`main.ts`)

1. Create host div + instantiate `WorktreesSurface` (next to the Changes/Pulse
   instances, ~`main.ts:2019-2026`).
2. Global keydown toggle **⌘⇧W**: `if (worktreesSurface.isOpen) close() else open()`.
   Follow the existing macOS key-variant guard style used for ⌘⌥M.
3. `window`/`document` event `covenant:open-worktrees` → open (lets other
   surfaces trigger it).
4. Entry resolves `gitRepoSummary(cwd).repo_root` before opening (same as
   `openChanges()`), so the page always keys off the main repo root.

Popover change (`ui/src/status/bar.ts`, `.status-git-pop-actions` footer,
~`bar.ts:1059`): add a **"⌥ Manage worktrees"** button beside "View changes"
that dispatches `covenant:open-worktrees`. Nothing else in the popover changes.

## Layout — master/detail

```
┌ Worktrees · karlTerminal · 4 · 6.3 GB ──────────────── [esc] ┐
│ LEFT (list, biggest-first)      │ RIGHT (selected detail)    │
│ ●agent/claude-qnc  6.2GB █████  │ agent/claude-0722-qnc      │
│   ~/…/.covenant/…  · 3 changed  │ last: "feat: scaffold…"    │
│ ●agent/release…    52MB  ▏      │ 2h ago · 3 changed +240/-12│
│  main             ~/…    HERE   │                            │
│                                 │  M crates/app/src/git.rs   │
│                                 │  A ui/src/worktrees/…      │
│                                 │                            │
│                                 │ disk 6.2GB · target 6.1GB  │
│                                 │  reclaimable               │
│                                 │ [Open tab][View diff]      │
│                                 │ [Clean build artifacts]    │
│                                 │ [Prune]                    │
└──────────────────────────────────────────────────────────────┘
```

**Header:** title "Worktrees", repo basename, aggregate `N · total GB`, esc/close.

**Left list** — one row per worktree, **sorted by size desc** (rows with unknown
size sort last until sizes resolve). Row contents:

- state dot (`worktreeStateClass`)
- branch label (`worktreeLabel`), `HERE` marker on the current worktree,
  live-dot on the dev-launched worktree if `dev_live_worktree_root` matches
- `compactPath`
- disk bar (proportional to largest worktree) + human size
- dirty/state badge (`N changed` from `dirty_count`, else `worktreeStateLabel`)

Selecting a row loads its detail panel. Default selection = current worktree,
or the biggest if current is main.

**Right detail** — the structured "what was this working on":

- branch + full path
- last commit subject + relative time (from `last_commit_unix`)
- `N changed`, diffstat `+insertions / -deletions`
- changed-files list (status letter + path), from `gitChanges(path)`
- disk line: total + `target/ ~X reclaimable`
- action row (below)

## Actions

- **Open tab** — existing `onOpenGitWorktree(path)` path.
- **View diff** — dispatch into `ChangesSurface.open(worktreePath)`.
- **Clean build artifacts** — new command (below). Confirm dialog shows freed
  size. **Disabled or extra-confirmed** on the live/current worktree.
- **State action** — from `worktreeDefaultAction(wt, occupiedCwds)`: Prune /
  Reclaim / Relocate / Retire, reusing the existing command wrappers
  (`worktreeReclaim`, `worktreeRelocate`, `worktreeRetire`).

After any destructive action, re-fetch `gitRepoSummary` and re-render.

## Data flow

Mostly reuse. Sizes are lazy so the page paints instantly.

| Need | Source | New? |
|---|---|---|
| worktree list + states | `gitRepoSummary(repoRoot)` | no |
| total + `target/` sizes | `worktreeSizes([...paths, ...paths.map(p => p+"/target")])` — one call, split by stripping `/target`; missing `target` dirs are silently omitted by the existing `filter_map` | **no** |
| changed-files (selected) | `gitChanges(path)` | no |
| last commit subject + diffstat (selected) | `worktree_detail(path)` | **yes** |
| clean build artifacts | `worktree_clean_target(path)` | **yes** |

The size trick reuses the existing `worktree_sizes` command verbatim — no
backend change for sizing. Sizes fire after first paint; rows show a skeleton
size until they resolve, then re-sort.

## New Rust commands (`crates/app/src/git_tools.rs` + `lib.rs` wrappers)

### `worktree_detail(path) -> WorktreeDetail`

```rust
struct WorktreeDetail {
    last_subject: Option<String>, // git log -1 --format=%s
    insertions: u64,              // git diff --shortstat (working tree)
    deletions: u64,
}
```

Runs in `spawn_blocking`. Called only for the selected worktree, so cost is one
worktree at a time. Tolerates a worktree with no commits (`last_subject = None`,
zero diffstat).

### `worktree_clean_target(path) -> u64` (freed KB)

`rm -rf <path>/target` with guards:

1. Resolve `target = <path>/target`. Assert it exists and is a **real
   directory**, not a symlink (`symlink_metadata`, reject `is_symlink()`).
2. Assert `target` is lexically inside the given worktree `path` (no `..`
   escape) and `path` is a known git worktree of this repo (cross-check against
   `git worktree list`).
3. Measure size (`du -sk`) before delete, return freed KB.
4. `std::fs::remove_dir_all(target)`.

Never touches `node_modules` (it's a symlink to main's deps — deleting it
clobbers main). The live/current-worktree guard is enforced **frontend-side**
(disable/extra-confirm) since the backend can't know which build is running.

Both registered in the invoke handler (`lib.rs` ~`5749`) and wrapped in
`ui/src/api.ts`.

## Testing

- **Rust unit test** for `worktree_clean_target`: build a temp dir with a real
  `target/` (containing a file), a `node_modules` **symlink**, and a tracked
  git file. Assert after clean: `target/` gone, `node_modules` symlink intact,
  git file intact. Second case: a **symlinked** `target` is refused (returns
  error, nothing deleted).
- **Rust unit test** for `worktree_detail`: a temp repo with one commit + an
  uncommitted edit → asserts `last_subject` and non-zero diffstat; an empty repo
  → `None` subject, zero diffstat.
- Frontend: size-split logic (`worktree_sizes` result → per-worktree total +
  target) gets a small vitest — given a mixed `[path, kb]` array with and
  without `/target` entries, produces correct `{total, target}` per worktree.

## Files touched

- `ui/src/worktrees/index.ts` (new)
- `ui/src/worktrees/worktrees.css` (new)
- `ui/src/worktrees/*.test.ts` (new — size-split)
- `ui/src/main.ts` (host + toggle + event)
- `ui/src/status/bar.ts` (popover "Manage worktrees" button; maybe export `compactPath`)
- `ui/src/api.ts` (`worktreeDetail`, `worktreeCleanTarget`)
- `crates/app/src/git_tools.rs` (two commands + tests)
- `crates/app/src/lib.rs` (two command wrappers + registration)
