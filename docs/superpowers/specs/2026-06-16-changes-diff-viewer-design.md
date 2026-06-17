# Changes — git diff viewer surface

> Design spec. Status: approved 2026-06-16. Branch: `feat/changes-diff-viewer`.

## Problem

Covenant has no way to review the working-tree changes of a repo. After a human or
an agent touches files, the only recourse is `git diff` in the terminal. We want a
GitHub-style, per-file diff surface — a master-detail "Changes" view that lists
modified files and renders each file's unified diff, with staging actions.

Reference: GitHub-style review pane (file list right, diff left), with Staged /
Unstaged groups, +/− counts, and per-file "Viewed" checkboxes.

## Decisions (locked during brainstorming)

| Question | Decision |
|---|---|
| Placement | Own **full-screen surface**, mounted like Project Notes / Tasker Board |
| Diff range | **Working tree vs HEAD**, split into **Staged / Unstaged**, with stage/unstage actions |
| Render | **Unified**, syntax-highlighted, line numbers, green/red gutter; clean binary placeholder |
| Repo scope | **Active session's repo** — git root of the focused tab's cwd |
| Entry points | Status-bar git chip → "View changes"; keyboard shortcut **⌘⇧G** |

## Out of scope (YAGNI v1)

Split/side-by-side view, arbitrary commit/branch ref diffing, hunk- or line-level
staging, live filesystem watching. Each is a clean fast-follow on this foundation.

---

## Architecture

### Backend — `crates/app/src/git_tools.rs` (extend)

Reuse the existing `git(cwd, args)` helper and the `project_ref` git-root resolution.
Add four functions, each surfaced as a `#[tauri::command]` in `lib.rs` and run via
`spawn_blocking` (consistent with `git_repo_summary` / `structure_*`).

| Command | git invocation | Returns |
|---|---|---|
| `git_changes(cwd)` | `git diff --numstat` (unstaged) + `git diff --cached --numstat` (staged) + `git status --porcelain` (untracked + rename detection) | `Changes { staged: Vec<FileChange>, unstaged: Vec<FileChange> }` |
| `git_file_diff(cwd, path, staged)` | `git diff [--cached] -- <path>`; untracked → `git diff --no-index -- /dev/null <file>` | `FileDiff` (parsed hunks, or `Binary`/`TooLarge` marker) |
| `git_stage(cwd, path)` | `git add -- <path>` | fresh `Changes` snapshot |
| `git_unstage(cwd, path)` | `git restore --staged -- <path>` | fresh `Changes` snapshot |

#### Types (serde `Serialize`, camelCase to TS)

```rust
pub struct FileChange {
    pub path: String,
    pub old_path: Option<String>,   // Some(_) only for renames
    pub status: ChangeStatus,       // Modified | Added | Deleted | Renamed | Untracked
    pub added: u32,                 // numstat insertions (0 for binary)
    pub removed: u32,               // numstat deletions
    pub binary: bool,
}

pub struct Changes { pub staged: Vec<FileChange>, pub unstaged: Vec<FileChange> }

pub enum FileDiffBody {
    Hunks(Vec<Hunk>),
    Binary { size_bytes: u64 },     // no text diff
    TooLarge { line_count: u32 },   // capped; show notice
}
pub struct FileDiff { pub path: String, pub old_path: Option<String>, pub body: FileDiffBody }

pub struct Hunk {
    pub old_start: u32,
    pub new_start: u32,
    pub header: String,             // the `@@ ... @@` context tail
    pub lines: Vec<DiffLine>,
}
pub struct DiffLine {
    pub kind: LineKind,             // Context | Add | Del
    pub old_no: Option<u32>,        // None for Add lines
    pub new_no: Option<u32>,        // None for Del lines
    pub text: String,               // without the leading +/-/space
}
```

#### Pure parsing module — `git_tools::diff_parse`

`parse_unified_diff(raw: &str) -> FileDiffBody` is a **pure function** (no I/O),
unit-tested independently:

- Splits on `@@ -a,b +c,d @@` hunk headers; tracks running old/new line numbers.
- Classifies each body line: ` ` → Context, `+` → Add, `-` → Del; `\ No newline at
  end of file` is swallowed (not rendered as a diff line).
- Detects `Binary files a/… and b/… differ` → returns `Binary`.
- Line cap: if total rendered lines exceed `MAX_DIFF_LINES` (e.g. 5000), return
  `TooLarge { line_count }` instead of hunks.

`numstat` parsing: each line is `<added>\t<removed>\t<path>`; `-` in either count
means binary (added/removed = 0, binary = true). Rename paths in numstat appear as
`old => new` / brace form — resolve via the matching `status --porcelain` `R` entry,
which carries the reliable `old -> new`.

### Frontend — `ui/src/changes/` (new module)

Mounted as a full-screen surface toggled by `body.changes-fullscreen` (same pattern
as `.pn-fullscreen` / `body.tasker-board`). Files:

- `index.ts` — surface lifecycle (open/close/focus), repo resolution, state.
- `rail.ts` — left file list (groups, search, status badges, stage/unstage, Viewed).
- `diff-view.ts` — right pane: render `Hunk[]` to DOM with gutter + highlighting.
- `changes.css` — styles, including the `body.theme-true-dark` neutral-lift block.
- `*.test.ts` — vitest.

#### Layout

```
┌──────────────────────────────┬───────────────────────────────────────┐
│  [search files…]             │  src/status/bar.ts            M  +43   │
│  ▾ Staged    (2)             │  ───────────────────────────────────── │
│    ● bar.ts    M  +43  [✓]   │   10   export function bar() {         │
│    ● foo.ts    A  +8         │   11 - return old                      │
│  ▾ Unstaged  (5)             │   11 + return diff                     │
│    ● a.rs      M  +3 −1      │   12   }                               │
│    ● emblem.bmp  (binary)    │                                        │
│                              │  [binary] emblem.bmp — image, 12 KB    │
└──────────────────────────────┴───────────────────────────────────────┘
```

- Rail rows reuse `structure/file-icons` for the leading icon. Status letter +
  `+a −r` counts. Hover reveals a stage (Unstaged group) / unstage (Staged group)
  button. "Viewed" is a **client-only** checkbox that dims the row; it resets when
  the file's diff content changes (track by path+content hash).
- Diff pane reuses the Structure preview's syntax highlighter. Add/Del rows get
  green/red backgrounds and a `+`/`−` marker; gutter shows old|new line numbers.
- Binary → placeholder; `TooLarge` → "diff too large to display (N lines)" notice.

#### Entry + repo resolution

- Status-bar git chip (`ui/src/status/bar.ts`) gains a "View changes" action in its
  existing branch popover; a global **⌘⇧G** shortcut opens the surface.
- On open: resolve git root from the focused tab's cwd (reuse `project_ref`
  logic / `git_repo_summary.repo_root`). Pass that root as `cwd` to all commands.

## Data flow

```
open ─▶ resolve git root (focused tab cwd)
     ─▶ git_changes(root) ─▶ render rail (Staged / Unstaged)
select file ─▶ git_file_diff(root, path, staged) ─▶ render hunks
stage/unstage click ─▶ git_stage|git_unstage(root, path)
                    ─▶ returns fresh Changes ─▶ re-render rail
                    ─▶ if selected file moved groups, re-pull its diff
refresh affordance / surface re-focus ─▶ git_changes(root) again
```

No live FS watch in v1. Manual refresh button + automatic refetch when the surface
regains focus keep it current without a watcher.

## Edge cases

| Case | Behavior |
|---|---|
| cwd not in a git repo | Empty state: "Not a git repository." |
| Clean working tree | Empty state: "Working tree clean." |
| Deleted file | Diff shows old content as all-removed; status `D`. |
| Untracked file | `git diff --no-index` → all-added diff; status `?`. |
| Rename | Header `old → new`; status `R`; diff against old content. |
| Binary file | No text diff; `Binary` placeholder with size. No garbage dump. |
| Huge diff | `TooLarge` notice past `MAX_DIFF_LINES`. |
| Submodule / symlink | Status row only, no diff body. |

## Testing

**Rust** (`git_tools` tests, temp-repo fixtures — precedent: `spec_detector` tests):
- `parse_unified_diff`: context/add/del classification, multi-hunk line numbering,
  `\ No newline` handling, binary detection, line-cap → `TooLarge`.
- numstat parse incl. binary (`-`) and rename resolution against porcelain.
- `git_changes` against a fixture repo with staged + unstaged + untracked files.
- `git_stage` / `git_unstage` round-trip moves a file between groups.

**TypeScript** (vitest, like `find-highlight.test.ts`):
- hunk → DOM render (gutter numbers, add/del classes).
- rail grouping + counts; search filter.
- stage/unstage optimistic re-render.
- binary + TooLarge render branches.
- "Viewed" reset on content change.

## File touch list

- `crates/app/src/git_tools.rs` — new fns + `diff_parse` submodule + tests.
- `crates/app/src/lib.rs` — register 4 commands in the invoke handler.
- `ui/src/changes/{index,rail,diff-view}.ts` + `changes.css` + tests.
- `ui/src/status/bar.ts` — "View changes" action in branch popover.
- `ui/src/main.ts` / shortcuts — ⌘⇧G binding + surface mount.
- `ui/src/api.ts` — typed wrappers for the 4 commands.
