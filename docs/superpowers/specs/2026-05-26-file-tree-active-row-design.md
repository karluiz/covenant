# File-tree active-row highlight — design

Date: 2026-05-26
Branch: `feat/file-tree-active-row`
Worktree: `.claude/worktrees/file-tree-active-row-a/`
Mockup: `design/file-tree-active-row-variants.html` (variant A approved)

## Context

The structure tree (`ui/src/structure/tree.ts`) is a flat-rendered file
list rooted at the tab's cwd. When the user opens a file from the tree
or from elsewhere (Recall, drag, `@file` mention), the editor
(`ui/src/structure/editor.ts`) takes over the right pane but the tree
gives no visual indication of *which* file is currently open. In deep
trees (e.g. `docs/superpowers/plans/` with dozens of dated files) the
user has to manually scan the list to relocate their active file.

## Goal

When a file is open in the editor, the corresponding row in the
structure tree gets a persistent visual marker — accent-tinted
background plus a 2px accent stripe on the left edge — and on the
*open* event the tree expands any collapsed parent folders and scrolls
the row into view.

## Non-goals

- Highlighting files opened in OTHER tabs (each tab has its own
  `StructureTree`; cross-tab "show me where this file lives" is a
  different feature).
- A persistent "recently opened" list of multiple highlighted rows.
- A "reveal in tree" button in the editor toolbar — deferred; the
  initial-open auto-reveal is enough for the common case.
- Highlighting files opened from outside the current tree's cwd
  (those clear the highlight rather than trying to render a marker for
  an unreachable row).
- Tracking dirty/modified state — out of scope.

---

## Architecture

```
manager.ts                       structure/tree.ts                editor.ts
─────────                        ─────────────────                ─────────
openEditor(path) {                                                editor.open(path)
  editor.open(path)        ───▶  structure.setActivePath(path)
  structure.setActivePath(path)
}

editor.close()             ───▶  structure.setActivePath(null)
```

`setActivePath(path | null)` is the only new public method on
`StructureTree`. The caller (`manager.ts`) already owns both ends of
the open/close lifecycle, so push-from-caller is simpler than having
the tree subscribe to editor events.

---

## API

### `StructureTree.setActivePath(path: string | null): void`

Synchronous entry point. Internally:

1. **No-op if `path` matches the current active path** — caller may
   call multiple times redundantly; only the first call per open
   triggers the reveal animation.
2. Clear `.is-active-file` from the previously-active row (if any).
3. Update internal `activePath: string | null`.
4. If `path` is null → done.
5. If `path` doesn't start with `this.cwd + "/"` (or equal `this.cwd`)
   → done. The file is outside this tree; no highlight, no error.
6. Walk path ancestors top-down from cwd:
   - For each ancestor segment that maps to a `dir` node, if it's
     collapsed → `await this.expand(node)`. Sequential awaits because
     each expansion lazy-loads children that the next segment needs.
   - If any ancestor is missing (e.g. the file was created on disk
     but the tree refresh hasn't picked it up yet) → bail, no error.
7. Find the leaf node for `path`. Add `.is-active-file` class to its
   `.structure-row` element. Cache the leaf in `activeNode` so the
   next call's "clear previous" doesn't have to re-walk.
8. `activeRow.scrollIntoView({ block: "nearest", behavior: "auto" })`.
   `behavior: "auto"` (not smooth) — smooth scroll in a fast-flipping
   tab feels janky.

### Internal additions

```ts
class StructureTree {
  // existing fields...
  private activePath: string | null = null;
  private activeNode: NodeState | null = null;

  setActivePath(path: string | null): void { /* see above */ }
  private async revealActivePath(path: string): Promise<void> { /* steps 5-8 */ }
}
```

`setActivePath` itself stays sync; `revealActivePath` is the async
helper it fires via `void this.revealActivePath(path)`.

### Race handling

- **setActivePath during a tree refresh:** the existing `refreshGen`
  counter (`tree.ts:93`) already guards against stale appends. The
  active reveal captures `refreshGen` at entry and bails if it moved
  by the time an `await expand(...)` resumes.
- **setActivePath while a previous reveal is still expanding:** the
  newer call wins. We track the latest call via a `revealToken` (just
  a monotonic counter on the instance); each `await` in
  `revealActivePath` checks `if (token !== this.revealToken) return;`.
- **cwd flip mid-reveal:** when `setCwd` is called, the active state
  resets to null. Any in-flight reveal sees its token invalidated.

### Refresh re-apply

When a refresh completes and the tree is re-rendered, the `<li>` /
`.structure-row` elements for the active path are different DOM nodes.
At the end of `refreshRoot`, if `this.activePath` is set, call
`void this.revealActivePath(this.activePath)` to re-apply the
highlight (without scrolling — see below).

To avoid stealing the user's scroll position on a routine refresh,
split the reveal into two methods:
- `revealActivePath(path)` — full: expand + scroll
- `applyActiveClass()` — just walk the loaded nodes, find the row,
  apply the class. Used after refreshes.

The post-refresh path uses `applyActiveClass`. The fresh-open path
uses `revealActivePath`.

---

## CSS

Add to `ui/src/styles.css`, namespaced under the existing structure
section (search for `.structure-row` to find the right location):

```css
/* Currently-open file in the editor — accent tint + 2px stripe.
   Set by StructureTree.setActivePath() from manager.ts when
   editor.open() succeeds and cleared on editor.close(). */
.structure-row.is-active-file {
  background: color-mix(in srgb, var(--accent, #b794f4) 14%, transparent);
  position: relative;
}
.structure-row.is-active-file::before {
  content: "";
  position: absolute;
  left: 0;
  top: 2px;
  bottom: 2px;
  width: 2px;
  background: var(--accent, #b794f4);
  border-radius: 0 2px 2px 0;
}
.structure-row.is-active-file .structure-name {
  color: var(--fg, #e5e7eb);
}
```

The accent variable + opacity matches `.structure-context-menu-item:hover`
at `styles.css:8034`, keeping the visual language consistent.

---

## Integration

### `ui/src/tabs/manager.ts` — single call site

Edit `openEditor` (`manager.ts:2335`) to push the path after the
editor open settles. The current code is:

```ts
const openEditor = (path: string, opts?: { line?: number }): void => {
  editorHost.hidden = false;
  showSplitter(false);
  void editor.open(path, opts);
};
```

becomes:

```ts
const openEditor = (path: string, opts?: { line?: number }): void => {
  editorHost.hidden = false;
  showSplitter(false);
  void editor.open(path, opts);
  structure.setActivePath(path);
};
```

`setActivePath` is sync so we don't have to chain it onto the
`editor.open()` promise; the async reveal runs in parallel with the
editor's first paint, which is fine — the highlight appears before
the editor is fully painted, which feels snappier.

### `ui/src/tabs/manager.ts` — close paths

Two places call `editor.close()` today:

1. `manager.ts:2356` — when the tree's trash action removes the
   currently-open file. Add `structure.setActivePath(null)` after
   `editor.close()`.
2. Search for any other `editor.close()` callers — the close button
   in the editor toolbar (if it exists, check `editor.ts`) needs the
   same nullification. Either route the close through `manager.ts`
   (cleanest) OR have `editor` emit a `closed` event the manager
   listens to.

Implementation will resolve this by inspecting `editor.ts`'s close
handlers and picking the routing approach (push from caller vs.
emit event). The spec mandates: every `editor.close()` lifecycle
endpoint must invalidate the tree's active row.

### Editor toolbar's "Reveal in tree" (deferred)

Not in scope. Could be added later by exposing a button that calls
`structure.setActivePath(editor.getCurrentPath())` — same primitive.

---

## Out-of-cwd opens

If the user opens a file outside the tree's cwd (e.g. a Recall result
points at `/Users/.../other-project/file.md`), `setActivePath` is
still called with that path. The cwd-prefix check (step 5) clears
the previously-active row and does nothing else. This is the right
behavior: the user can see in the editor pane *what* file is open;
the tree honestly says "this isn't in my cwd."

---

## Testing

### Unit-level
Add to `ui/src/structure/tree.test.ts` (or create if absent):

- `setActivePath(null)` clears the active class from any previously-
  marked row.
- `setActivePath(path)` where `path` is outside cwd → no marker
  applied, no error.
- `setActivePath(path)` for a file inside an already-expanded folder
  → marker applied, no expand calls dispatched.
- `setActivePath(path)` for a file in a collapsed folder → folder
  expanded, marker applied. (Mock the directory-list backend call.)
- Repeated `setActivePath(samePath)` → no-op (no extra expand calls,
  no extra scrollIntoView).
- `setActivePath` during a pending refresh — the active highlight
  re-applies after the refresh completes.

### Manual smoke

- Open a file from the tree → row highlights, no scroll (already
  visible).
- Click a Recall result that points to a deep nested file → tree
  auto-expands the ancestor chain, scrolls to it, highlights.
- Switch tabs back and forth → each tab keeps its own active
  highlight; no cross-tab interference.
- Close the file → highlight clears.

---

## Files touched (preview)

- `ui/src/structure/tree.ts` — new state + `setActivePath` method
  + private `revealActivePath` and `applyActiveClass` helpers + a
  `refreshRoot` tail call to re-apply.
- `ui/src/tabs/manager.ts` — `openEditor` pushes path; the trash-
  close branch nullifies. One more nullification site depending on
  editor-close routing (see Integration).
- `ui/src/structure/editor.ts` — possibly add a `onClose` callback /
  event so the manager can hook nullification (if no existing route).
- `ui/src/styles.css` — `.structure-row.is-active-file` block (8
  lines).
- `ui/src/structure/tree.test.ts` — new tests above. Create the file
  if it doesn't exist; the existing tree code has no tests today.

## Risks

- **Auto-expand on a huge directory** (e.g. user opens a file in a
  10k-entry folder) could feel slow because lazy-load runs once for
  the ancestor and then renders all siblings. Mitigation: the
  existing tree already paginates / lazy-loads, so this is bounded
  by the existing rendering cost — no new bottleneck introduced.
- **Scroll-into-view conflicting with user scroll** if `setActivePath`
  is called rapidly (e.g. a debounced editor switcher). The
  one-call-per-distinct-path no-op guard prevents this in practice.
- **Active-row CSS conflicts with hover state.** The `.structure-row:hover`
  background needs to remain readable when overlaid on the
  accent-tint. Mitigation: hover bg is `rgba(255,255,255,0.04)` —
  combined with the accent tint it stays subtle. Verify visually
  during implementation; if it muddies, layer hover via a separate
  pseudo-element with `mix-blend-mode: overlay`.
