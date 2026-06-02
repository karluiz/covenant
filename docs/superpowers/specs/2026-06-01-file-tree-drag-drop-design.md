# File Tree Drag-Drop (drop files into the tree from outside the app)

**Date:** 2026-06-01
**Status:** Approved, ready for implementation plan

## Goal

Let the user drag files/folders from Finder (or any other app) and drop them
onto Covenant's file-tree panel. Dropped items are **copied** into the target
folder.

## Behavior

- Drop zone is the **file-tree panel only**. Drops elsewhere (terminal, other
  panels, outside the tree) are ignored — no-op.
- **Folder-aware target resolution:**
  - Drop on a folder row → copy into that folder.
  - Drop on a file row → copy into that file's parent folder.
  - Drop on empty space within the tree panel → copy into the tree root (`cwd`).
- **Directories copy recursively**; plain files copy directly.
- **Collisions auto-rename**, never clobber: `name (2).ext`, `name (3).ext`, …
  Extension-aware for files; for directories / extensionless names use
  `name (2)`.
- Only active when the structure view is the visible sidebar tab.
- After a successful drop, the affected subtree refreshes and the target folder
  auto-expands.

## Architecture / data flow

Native OS file drop in Tauri 2 is a **window-level event**, not an HTML5 DnD
event — the webview's HTML5 `drop` does not fire for real OS files. Use
`getCurrentWebview().onDragDropEvent()`, which emits `enter` / `over` / `drop` /
`leave` with `position` (physical pixels) and `paths: string[]`.

1. **New module `ui/src/structure/file-drop.ts`** — subscribes to
   `onDragDropEvent`, owns drop-target resolution + highlight, calls the copy
   API, and triggers tree refresh. Wired up where `StructureTree` is
   instantiated (`ui/src/tabs/manager.ts` ~3244), given a handle to the tree.
2. **Hit-testing:** on `over`/`drop`, convert `position` → CSS px (divide by
   `devicePixelRatio`), `document.elementFromPoint(x, y)`, then
   `.closest(".structure-node")`. Resolve target folder per the rules above.
   If the point is not over the tree panel, ignore.
3. **Guard:** only act when the structure sidebar view is visible.

## Backend command (new)

No copy command exists today. Add:

```rust
#[tauri::command]
async fn structure_copy_into(sources: Vec<String>, dest_dir: String)
    -> Result<Vec<String>, String>
```

Pure logic in `crates/app/src/structure.rs` as `copy_into(sources, dest_dir)`:

- For each source, compute a non-clobbering target name in `dest_dir`
  (auto-rename loop).
- File → `std::fs::copy`. Directory → hand-rolled recursive copy (no new dep).
- Refuse to copy a directory into itself or a descendant (guard against `dest`
  being inside `src`).
- Return the list of created top-level paths (for refresh / expand / select).
- Run inside `spawn_blocking`, consistent with the other `structure_*` commands.

Registered in the `invoke_handler` in `crates/app/src/lib.rs` alongside the
other `structure_*` commands.

**Frontend wrapper** in `ui/src/api.ts`:

```ts
export async function structureCopyInto(
  sources: string[],
  destDir: string,
): Promise<string[]>
```

**Unit tests** in `structure.rs`:
- file copy
- recursive directory copy
- auto-rename collision (file with extension, extensionless, directory)
- self-into-descendant rejection

## Visual feedback

- `over`: add `.structure-drop-target` to the resolved target folder row
  (accent outline/tint). Root-target drop highlights the panel edge subtly.
- `leave` / `drop`: clear all highlights.
- On error (e.g. permission denied), surface via the same notify path the tree
  already uses for trash errors.

## Out of scope (v1)

- Moving (vs copying) files in.
- Inserting dropped paths into the terminal PTY.
- Internal drag-to-move within the tree.
- Dragging files out of the app to the OS.
