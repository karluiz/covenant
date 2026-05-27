# File-tree active-row highlight — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a file is open in the structure editor, highlight its row in the tree (accent-tinted background + 2px left stripe) and on the initial open auto-expand collapsed ancestors + scroll the row into view.

**Architecture:** `StructureTree` gains an `activePath` state + a single sync `setActivePath(path | null)` entry point. Internally an async `revealActivePath` walks the cwd→file ancestor chain, awaits `expand()` on each collapsed dir, then applies the `.is-active-file` class on the leaf row and scrolls. A lightweight `applyActiveClass` re-applies the class after refreshes without scrolling. `manager.ts` pushes the path from its existing `openEditor` helper and nullifies via the existing `editor.onClose` callback — both single call sites since all editor close paths route through `editor.close()` which fires `onClose`.

**Tech Stack:** TypeScript (strict), vitest + jsdom for unit tests, CSS in `ui/src/styles.css`.

**Worktree:** `.claude/worktrees/file-tree-active-row-a/` on `feat/file-tree-active-row`. All work here.

**Spec:** `docs/superpowers/specs/2026-05-26-file-tree-active-row-design.md`.

**Commit policy:** ONE commit at the end (one feature, one commit per user preference). Tasks below describe progressive development but only Task 5 commits.

---

## File Structure

- `ui/src/structure/tree.ts` — adds `activePath`, `activeNode`, `revealToken` state. Adds `setActivePath`, `revealActivePath`, `applyActiveClass`, `findNodeByPath` methods. Modifies `refreshRoot` to call `applyActiveClass` at the end and `setCwd` to clear active state.
- `ui/src/structure/tree.test.ts` — NEW. Vitest + jsdom. Mocks `structureListDir` from `../api`. Covers same-path no-op, out-of-cwd clear, in-loaded-tree apply, ancestor-expand, scroll-into-view called, refresh-reapply.
- `ui/src/styles.css` — adds `.structure-row.is-active-file` block (≈8 lines) under the existing structure-row CSS section.
- `ui/src/tabs/manager.ts` — two single-line edits: push path in `openEditor` (line 2335), nullify in the existing `onClose` callback (line 2276).

---

## Task 1: `setActivePath` + reveal helpers in `StructureTree`

**Files:**
- Create: `ui/src/structure/tree.test.ts`
- Modify: `ui/src/structure/tree.ts` (add fields + 4 methods, don't touch `refreshRoot` yet — that's Task 2)

### Step 1: Create the test file with the failing tests

- [ ] **Step 1: Create `ui/src/structure/tree.test.ts`**

```typescript
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the backend list call BEFORE importing tree.ts so the module
// picks up the mock at import time.
vi.mock("../api", () => ({
  structureListDir: vi.fn(),
}));

import { StructureTree } from "./tree";
import { structureListDir } from "../api";

const listDirMock = structureListDir as unknown as ReturnType<typeof vi.fn>;

function entry(path: string, name: string, kind: "file" | "dir") {
  return { path, name, kind, is_symlink: false };
}

async function flush() {
  // Drain microtasks so awaited expand() chains resolve before assertion.
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe("StructureTree.setActivePath", () => {
  let host: HTMLDivElement;
  let tree: StructureTree;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    listDirMock.mockReset();
    // jsdom doesn't implement scrollIntoView. Stub on the prototype
    // before each test so reveal logic can call it without throwing.
    Element.prototype.scrollIntoView = vi.fn();
    tree = new StructureTree(host, () => undefined);
  });

  it("clears active class when called with null", async () => {
    // Two top-level files in cwd.
    listDirMock.mockResolvedValueOnce([
      entry("/cwd/a.md", "a.md", "file"),
      entry("/cwd/b.md", "b.md", "file"),
    ]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/cwd/a.md");
    await flush();
    const aRow = host.querySelector(
      '[data-kind="file"] .structure-row',
    ) as HTMLElement | null;
    expect(aRow?.classList.contains("is-active-file")).toBe(true);

    tree.setActivePath(null);
    expect(aRow?.classList.contains("is-active-file")).toBe(false);
  });

  it("is a no-op when called with the same path twice", async () => {
    listDirMock.mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();

    tree.setActivePath("/cwd/a.md");
    await flush();
    const callsAfterFirst = (Element.prototype.scrollIntoView as ReturnType<
      typeof vi.fn
    >).mock.calls.length;
    tree.setActivePath("/cwd/a.md");
    await flush();
    expect(
      (Element.prototype.scrollIntoView as ReturnType<typeof vi.fn>).mock.calls
        .length,
    ).toBe(callsAfterFirst);
  });

  it("does nothing when the path is outside cwd", async () => {
    listDirMock.mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/other/somewhere.md");
    await flush();
    const rows = host.querySelectorAll(".structure-row.is-active-file");
    expect(rows.length).toBe(0);
  });

  it("applies class to an already-loaded leaf without expanding", async () => {
    listDirMock.mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    const expandCallsBefore = listDirMock.mock.calls.length;
    tree.setActivePath("/cwd/a.md");
    await flush();
    expect(listDirMock.mock.calls.length).toBe(expandCallsBefore);
    const aRow = host.querySelector(
      '[data-kind="file"] .structure-row',
    ) as HTMLElement | null;
    expect(aRow?.classList.contains("is-active-file")).toBe(true);
  });

  it("auto-expands a collapsed ancestor to reach the target leaf", async () => {
    // Root has one dir "deep". Reveal target lives inside it.
    listDirMock
      .mockResolvedValueOnce([entry("/cwd/deep", "deep", "dir")])
      .mockResolvedValueOnce([entry("/cwd/deep/file.md", "file.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/cwd/deep/file.md");
    await flush();
    // The deep dir's children were lazy-loaded by the reveal.
    expect(listDirMock).toHaveBeenCalledTimes(2);
    // Leaf row carries the class.
    const leaf = Array.from(host.querySelectorAll(".structure-row")).find(
      (r) => r.textContent?.includes("file.md"),
    );
    expect(leaf?.classList.contains("is-active-file")).toBe(true);
  });
});
```

### Step 2: Run tests to confirm failure

Run: `cd ui && npx vitest run structure/tree.test 2>&1 | tail -20`
Expected: tests fail because `setActivePath` doesn't exist yet.

### Step 3: Implement state + `setActivePath` in `ui/src/structure/tree.ts`

Add these fields to the `StructureTree` class near the other `private` fields (after `private refreshGen = 0;` at line 93):

```typescript
  /// Path of the file currently open in the editor pane, or null when
  /// no file is open. The matching row gets `.is-active-file` (CSS
  /// gives it an accent tint + 2px left stripe). Set by manager.ts
  /// from openEditor / editor onClose.
  private activePath: string | null = null;
  private activeNode: NodeState | null = null;
  /// Monotonic counter. Each call to `revealActivePath` captures the
  /// current value and bails on any await if a newer reveal has
  /// started — avoids two reveals interleaving DOM updates.
  private revealToken = 0;
```

Then add these methods near the bottom of the class, BEFORE the closing brace and AFTER the existing `collapse` method (around line 654 — search for `private collapse(node: NodeState)`):

```typescript
  /// Public entry point: tell the tree which file is currently open in
  /// the editor pane. Pass `null` to clear. Same-path repeated calls
  /// are no-ops so callers can be lazy.
  ///
  /// Effects when path changes to a non-null value:
  ///   - clear `.is-active-file` from the previously-marked row (if any)
  ///   - if path is outside this tree's cwd, stop (no marker)
  ///   - otherwise: walk ancestors, expand collapsed ones, mark the
  ///     leaf row, and scrollIntoView({ block: "nearest" })
  ///
  /// Set by manager.ts after `editor.open(path)` and again with `null`
  /// from the editor's `onClose` callback.
  setActivePath(path: string | null): void {
    if (path === this.activePath) return;
    this.clearActive();
    this.activePath = path;
    if (path === null) return;
    void this.revealActivePath(path);
  }

  private clearActive(): void {
    const prev = this.activeNode;
    if (prev) {
      const row = prev.el.querySelector(".structure-row");
      row?.classList.remove("is-active-file");
    }
    this.activeNode = null;
  }

  /// Full reveal: expand ancestors + apply class + scroll. Used on a
  /// fresh open. Refresh re-apply uses applyActiveClass instead so a
  /// routine refresh doesn't steal the user's scroll position.
  private async revealActivePath(path: string): Promise<void> {
    if (!this.cwd) return;
    if (path !== this.cwd && !path.startsWith(this.cwd + "/")) return;
    const token = ++this.revealToken;

    // Build relative segments. For a path identical to cwd there's
    // nothing to reveal (the file IS the cwd, which can't happen for
    // a file open, but guard anyway).
    const rel = path === this.cwd ? "" : path.slice(this.cwd.length + 1);
    if (rel === "") return;
    const segments = rel.split("/");

    // Walk top-down. For each non-leaf segment, find the matching
    // child node at the current level and expand it if collapsed.
    let level: NodeState[] = this.nodes;
    let prefix = this.cwd;
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = `${prefix}/${segments[i]}`;
      const dirNode = level.find((n) => n.entry.path === prefix);
      if (!dirNode || dirNode.entry.kind !== "dir") return;
      if (!dirNode.expanded) {
        await this.expand(dirNode);
        if (token !== this.revealToken) return;
      }
      level = dirNode.children ?? [];
    }

    // Final segment: the file leaf.
    const leaf = level.find((n) => n.entry.path === path);
    if (!leaf) return;
    const row = leaf.el.querySelector(".structure-row");
    if (!(row instanceof HTMLElement)) return;
    row.classList.add("is-active-file");
    this.activeNode = leaf;
    row.scrollIntoView({ block: "nearest", behavior: "auto" });
  }

  /// Lightweight: walks the currently-loaded nodes to re-apply the
  /// `.is-active-file` class without expanding anything new and
  /// without scrolling. Called from refreshRoot after a re-render so
  /// a refresh during which the active path hasn't changed keeps the
  /// marker visible on the new DOM nodes.
  private applyActiveClass(): void {
    if (!this.activePath || !this.cwd) return;
    if (
      this.activePath !== this.cwd &&
      !this.activePath.startsWith(this.cwd + "/")
    ) {
      return;
    }
    const rel =
      this.activePath === this.cwd
        ? ""
        : this.activePath.slice(this.cwd.length + 1);
    if (rel === "") return;
    const segments = rel.split("/");
    let level: NodeState[] = this.nodes;
    let prefix = this.cwd;
    for (let i = 0; i < segments.length - 1; i++) {
      prefix = `${prefix}/${segments[i]}`;
      const dirNode = level.find((n) => n.entry.path === prefix);
      if (!dirNode || !dirNode.expanded || !dirNode.children) return;
      level = dirNode.children;
    }
    const leaf = level.find((n) => n.entry.path === this.activePath);
    if (!leaf) return;
    const row = leaf.el.querySelector(".structure-row");
    if (!(row instanceof HTMLElement)) return;
    row.classList.add("is-active-file");
    this.activeNode = leaf;
  }
```

**Sanity checks the engineer must verify by reading surrounding code:**
- `NodeState` already has `{ entry, expanded, children, depth, el }` (operator.rs equivalent at `tree.ts:27-34`). The `el` is the `<li>`; the `<div class="structure-row">` is inside it (see `makeNode` at `tree.ts:266-267`).
- `private async expand(node: NodeState)` at `tree.ts:613` does the lazy-load and sets `node.children` (look at `expand` to confirm children-array population).
- The cwd check: `setCwd` stores `this.cwd` as the raw string (no trailing slash). Path comparisons use `cwd + "/"` as the prefix.

### Step 4: Run tests to confirm pass

Run: `cd ui && npx vitest run structure/tree.test 2>&1 | tail -20`
Expected: all 5 tests pass.

### Step 5: Confirm clearActive on cwd change

Add this test inside the same `describe` block:

```typescript
  it("clears active state when cwd changes", async () => {
    listDirMock
      .mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")])
      .mockResolvedValueOnce([entry("/cwd2/b.md", "b.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/cwd/a.md");
    await flush();
    await tree.setCwd("/cwd2");
    await flush();
    expect(host.querySelectorAll(".is-active-file").length).toBe(0);
  });
```

This test needs `setCwd` to call `this.clearActive()` and reset `this.activePath = null`. Find `setCwd` in tree.ts (around line 139) and add this at the start of its body (after the early-return if `cwd === current`):

```typescript
    this.clearActive();
    this.activePath = null;
```

### Step 6: Run tests again

Run: `cd ui && npx vitest run structure/tree.test 2>&1 | tail -20`
Expected: all 6 tests pass.

---

## Task 2: Refresh re-apply

**Files:**
- Modify: `ui/src/structure/tree.ts` — `refreshRoot` calls `applyActiveClass()` at the end

### Step 1: Add a test that refresh preserves the active highlight

In `ui/src/structure/tree.test.ts`, append to the existing describe:

```typescript
  it("re-applies active class after a refresh", async () => {
    // Initial list + later refresh both return the same file.
    listDirMock
      .mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")])
      .mockResolvedValueOnce([entry("/cwd/a.md", "a.md", "file")]);
    await tree.setCwd("/cwd");
    await flush();
    tree.setActivePath("/cwd/a.md");
    await flush();

    await tree.refresh();
    await flush();

    const row = host.querySelector(
      '[data-kind="file"] .structure-row',
    ) as HTMLElement | null;
    expect(row?.classList.contains("is-active-file")).toBe(true);
  });
```

`refresh()` is the existing public method at `tree.ts:150` (also bound to the refresh button at line 217).

### Step 2: Run test to verify failure

Run: `cd ui && npx vitest run structure/tree.test 2>&1 | tail -20`
Expected: the new test fails because refresh wipes the DOM and the new row doesn't carry the class.

### Step 3: Patch `refreshRoot`

Find `refreshRoot` at `tree.ts:222`. The method ends with a `for` loop that builds nodes. Add a single line after the loop body (immediately before the closing brace of the method, around line 257-258):

```typescript
    // Re-apply active highlight on the freshly-built DOM. No scroll
    // (a routine refresh shouldn't steal the user's scroll position).
    this.applyActiveClass();
```

### Step 4: Confirm pass

Run: `cd ui && npx vitest run structure/tree.test 2>&1 | tail -20`
Expected: all 7 tests pass.

---

## Task 3: CSS for `.is-active-file`

**Files:**
- Modify: `ui/src/styles.css`

### Step 1: Locate the `.structure-row` block

Run: `grep -n "^\.structure-row\b\|^\.structure-row " ui/src/styles.css | head -5`
Find the existing `.structure-row` rule (likely a flex container) and the line range where the structure-tree rules live.

### Step 2: Add the active-file rules

Insert this block immediately after the existing `.structure-row` rule and its variants (e.g. `:hover`):

```css
/* Currently-open file in the editor — accent tint + 2px left stripe.
   Set by StructureTree.setActivePath() from manager.ts when
   editor.open() succeeds and cleared from the editor's onClose
   callback. See docs/superpowers/specs/2026-05-26-file-tree-active-row-design.md. */
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

### Step 3: Verify no other rules collide

Run: `grep -n "is-active-file" ui/src/styles.css`
Expected: only the three rules above. If another file uses this class for an unrelated purpose, rename to `.structure-row.is-open-file` and update the JS + tests in Task 1 to match.

---

## Task 4: Wire up `manager.ts`

**Files:**
- Modify: `ui/src/tabs/manager.ts` lines 2276-2300 (editor onClose) and 2335-2341 (openEditor)

### Step 1: Push the path from openEditor

Find `openEditor` at `ui/src/tabs/manager.ts:2335`. The current code is:

```typescript
    const openEditor = (path: string, opts?: { line?: number }): void => {
      editorHost.hidden = false;
      // Editor now overlays the terminal (CSS position:absolute) — no
      // splitter, no grid reflow, no terminal refit needed on open.
      showSplitter(false);
      void editor.open(path, opts);
    };
```

Add a single line at the end:

```typescript
    const openEditor = (path: string, opts?: { line?: number }): void => {
      editorHost.hidden = false;
      // Editor now overlays the terminal (CSS position:absolute) — no
      // splitter, no grid reflow, no terminal refit needed on open.
      showSplitter(false);
      void editor.open(path, opts);
      structure.setActivePath(path);
    };
```

(Note: `structure` is declared on the NEXT line at `manager.ts:2343` after this function. Hoisted const declarations don't help — the function is a closure that runs LATER, by which time `structure` is initialized. Confirm by reading the surrounding 30 lines: `openEditor` is only invoked from user events after the whole setup function returns, so the reference is safe.)

### Step 2: Nullify from the existing onClose

Find the editor's `onClose` callback at `manager.ts:2276`. The current code:

```typescript
      onClose: () => {
        editorHost.hidden = true;
        showSplitter(false);
        refitAfterLayoutTransition();
      },
```

becomes:

```typescript
      onClose: () => {
        editorHost.hidden = true;
        showSplitter(false);
        refitAfterLayoutTransition();
        structure.setActivePath(null);
      },
```

The trash branch at `manager.ts:2356` calls `editor.close()` which fires `onClose` (verified via `editor.ts:1062` — `this.callbacks.onClose?.()` runs at the end of close). So this single edit handles all close paths: explicit close button (`editor.ts:284`), trash, editor.close on rename mismatch, etc.

### Step 3: Typecheck

Run: `cd ui && npx tsc --noEmit 2>&1 | tail -10`
Expected: clean, no type errors.

### Step 4: Run the structure tests one more time

Run: `cd ui && npx vitest run structure 2>&1 | tail -15`
Expected: all tests pass (the new tree tests + the existing preview/languages tests).

---

## Task 5: Manual smoke + single commit

### Step 1: Manual smoke

Skip if no display available. Otherwise from the worktree:

Run: `cargo run -p covenant 2>&1 | tail -5`

In the app:
1. Open the structure sidebar in any tab.
2. Click a file in a CURRENTLY-VISIBLE folder → row highlights with the accent tint + stripe.
3. Close the file (X button on the editor toolbar OR open another file) → previous highlight clears; if a new file was opened, that one is now marked.
4. Right-click → "Reveal in Finder" or similar — these shouldn't touch the highlight.
5. Click a file in a DEEPLY NESTED folder via Recall or @file mention → the tree should auto-expand the ancestors and scroll the row into view, highlighted.
6. Switch tabs → highlight in each tab is independent.

### Step 2: Single commit

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/file-tree-active-row-a
git add ui/src/structure/tree.ts ui/src/structure/tree.test.ts ui/src/styles.css ui/src/tabs/manager.ts
git commit -m "$(cat <<'EOF'
feat(structure): highlight + reveal currently-open file in tree

The structure sidebar gave no visual indication of which file the
editor pane was showing. In deep trees (docs/superpowers/plans, big
crate folders) the user had to manually scan to find the open file.

Adds a single sync entry point `StructureTree.setActivePath(path|null)`
that marks the matching row with `.is-active-file` (accent-tinted
background + 2px left stripe) and, on the initial open, auto-expands
collapsed ancestor folders and scrolls the row into view.

Wiring is one push call from manager.ts::openEditor and one null push
from the existing editor onClose callback — all close paths route
through editor.close() which fires onClose, so a single edit covers
the trash flow, the close button, and rename-mismatch close.

Refreshes preserve the highlight via a lightweight applyActiveClass
that re-marks the row on the new DOM without scrolling, so a routine
refresh doesn't steal the user's scroll position.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
