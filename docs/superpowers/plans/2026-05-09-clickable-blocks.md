# Clickable Blocks Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Block rows in the right-side panel clickable: single-click inserts the command into the active prompt; double-click runs it; if `block.cwd ≠ active.cwd`, prompt the user with Insert / Insert-with-cd / Cancel.

**Architecture:** Pure-function helper for cwd comparison + a small confirm modal mounted on demand. Wire `click` and `dblclick` on `.block-item` rows in `ui/src/blocks/manager.ts`. Reuse the existing `injectCommand` Tauri command — append `\n` for run, omit for insert. Historical block `<li>`s gain `data-cmd` and `data-cwd` attributes since they aren't in `blocksById`.

**Tech Stack:** TypeScript, Vitest + jsdom (already present), existing `inject_command` Tauri command in `crates/app/src/lib.rs:1733`.

**Spec:** `docs/superpowers/specs/2026-05-09-clickable-blocks-design.md`

---

## File Structure

- **Create**: `ui/src/blocks/cwd-compare.ts` — pure helper `cwdsEqual(a, b)`.
- **Create**: `ui/src/blocks/cwd-compare.test.ts` — unit tests.
- **Create**: `ui/src/blocks/cwd-mismatch-modal.ts` — `openCwdMismatchModal(...)` returns a Promise<"insert" | "insert-cd" | "cancel">.
- **Create**: `ui/src/blocks/cwd-mismatch-modal.test.ts` — DOM tests.
- **Modify**: `ui/src/blocks/manager.ts` — wire click/dblclick, add data-attrs to historical items.
- **Modify**: `ui/src/styles.css` — `.block-item:hover` + `cursor: pointer`, modal styles.

---

## Task 1: cwd-compare helper

**Files:**
- Create: `ui/src/blocks/cwd-compare.ts`
- Test: `ui/src/blocks/cwd-compare.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/blocks/cwd-compare.test.ts
import { describe, expect, it } from "vitest";
import { cwdsEqual } from "./cwd-compare";

describe("cwdsEqual", () => {
  it("identical paths match", () => {
    expect(cwdsEqual("/Users/x/repo", "/Users/x/repo")).toBe(true);
  });
  it("trailing slash is ignored", () => {
    expect(cwdsEqual("/Users/x/repo", "/Users/x/repo/")).toBe(true);
    expect(cwdsEqual("/Users/x/repo/", "/Users/x/repo")).toBe(true);
  });
  it("different paths do not match", () => {
    expect(cwdsEqual("/Users/x/repo", "/Users/x/other")).toBe(false);
  });
  it("null / empty is treated as not-equal", () => {
    expect(cwdsEqual(null, "/x")).toBe(false);
    expect(cwdsEqual("/x", "")).toBe(false);
    expect(cwdsEqual(null, null)).toBe(false);
  });
  it("case-sensitive (macOS HFS+ may not be, but safer to compare strictly)", () => {
    expect(cwdsEqual("/Users/X/repo", "/Users/x/repo")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, verify fails**

Run: `npm test -- cwd-compare`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// ui/src/blocks/cwd-compare.ts
/// Compare two cwd paths for "same directory". Strips a single trailing
/// slash from each side; otherwise strict string compare. Null/empty on
/// either side is never equal.
export function cwdsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => (s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s);
  return norm(a) === norm(b);
}
```

- [ ] **Step 4: Run test, verify passes**

Run: `npm test -- cwd-compare`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/blocks/cwd-compare.ts ui/src/blocks/cwd-compare.test.ts
git commit -m "feat(blocks): cwd-compare helper for click guard"
```

---

## Task 2: cwd-mismatch confirm modal

**Files:**
- Create: `ui/src/blocks/cwd-mismatch-modal.ts`
- Test: `ui/src/blocks/cwd-mismatch-modal.test.ts`
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/blocks/cwd-mismatch-modal.test.ts
import { afterEach, describe, expect, it } from "vitest";
import { openCwdMismatchModal } from "./cwd-mismatch-modal";

afterEach(() => { document.body.innerHTML = ""; });

describe("openCwdMismatchModal", () => {
  it("renders the block cwd in the body", () => {
    void openCwdMismatchModal("/Users/x/other");
    const body = document.querySelector(".cwd-mismatch-modal")!;
    expect(body.textContent).toContain("/Users/x/other");
  });

  it("resolves 'insert' when Insert is clicked", async () => {
    const p = openCwdMismatchModal("/Users/x/other");
    (document.querySelector('[data-action="insert"]') as HTMLButtonElement).click();
    await expect(p).resolves.toBe("insert");
    expect(document.querySelector(".cwd-mismatch-modal")).toBeNull();
  });

  it("resolves 'insert-cd' when Insert-with-cd is clicked", async () => {
    const p = openCwdMismatchModal("/Users/x/other");
    (document.querySelector('[data-action="insert-cd"]') as HTMLButtonElement).click();
    await expect(p).resolves.toBe("insert-cd");
  });

  it("resolves 'cancel' when Cancel is clicked", async () => {
    const p = openCwdMismatchModal("/Users/x/other");
    (document.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    await expect(p).resolves.toBe("cancel");
  });

  it("resolves 'cancel' on Escape key", async () => {
    const p = openCwdMismatchModal("/Users/x/other");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await expect(p).resolves.toBe("cancel");
  });
});
```

- [ ] **Step 2: Run test, verify fails**

Run: `npm test -- cwd-mismatch-modal`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// ui/src/blocks/cwd-mismatch-modal.ts
export type CwdMismatchChoice = "insert" | "insert-cd" | "cancel";

/// Open a small modal asking the user how to handle a cwd mismatch when
/// re-running a historical block. Resolves with the user's choice and
/// removes the modal from the DOM. Idempotent: caller is responsible
/// for not opening multiple at once.
export function openCwdMismatchModal(blockCwd: string): Promise<CwdMismatchChoice> {
  return new Promise((resolve) => {
    const root = document.createElement("div");
    root.className = "cwd-mismatch-modal-backdrop";
    root.innerHTML = `
      <div class="cwd-mismatch-modal" role="dialog" aria-modal="true">
        <div class="cwd-mismatch-modal-body">
          This command ran in <code>${escapeHtml(blockCwd)}</code>.
          Insert anyway?
        </div>
        <div class="cwd-mismatch-modal-actions">
          <button type="button" data-action="insert">Insert</button>
          <button type="button" data-action="insert-cd">Insert with <code>cd</code></button>
          <button type="button" data-action="cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    const finish = (choice: CwdMismatchChoice) => {
      document.removeEventListener("keydown", onKey);
      root.remove();
      resolve(choice);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") finish("cancel");
    };
    document.addEventListener("keydown", onKey);

    root.querySelectorAll<HTMLButtonElement>("button[data-action]").forEach((btn) => {
      btn.addEventListener("click", () => {
        finish(btn.dataset.action as CwdMismatchChoice);
      });
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!),
  );
}
```

- [ ] **Step 4: Add styles**

Append to `ui/src/styles.css`:

```css
.cwd-mismatch-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9999;
}
.cwd-mismatch-modal {
  background: var(--bg-panel, #1a1d24);
  border: 1px solid var(--border, #2a2e38);
  border-radius: 8px;
  padding: 20px 22px;
  min-width: 360px;
  max-width: 520px;
  color: var(--fg, #e6e6e6);
  font-size: 13px;
}
.cwd-mismatch-modal-body { margin-bottom: 16px; line-height: 1.5; }
.cwd-mismatch-modal-body code {
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 3px;
  font-size: 12px;
}
.cwd-mismatch-modal-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.cwd-mismatch-modal-actions button {
  background: var(--bg-button, #2a2e38);
  border: 1px solid var(--border, #3a3e48);
  color: var(--fg, #e6e6e6);
  padding: 6px 12px;
  border-radius: 5px;
  font-size: 12px;
  cursor: pointer;
}
.cwd-mismatch-modal-actions button:hover {
  background: var(--bg-button-hover, #353945);
}
```

- [ ] **Step 5: Run test, verify passes**

Run: `npm test -- cwd-mismatch-modal`
Expected: PASS, 5 tests.

- [ ] **Step 6: Commit**

```bash
git add ui/src/blocks/cwd-mismatch-modal.ts ui/src/blocks/cwd-mismatch-modal.test.ts ui/src/styles.css
git commit -m "feat(blocks): cwd-mismatch confirm modal"
```

---

## Task 3: Wire click/dblclick on current-session blocks

**Files:**
- Modify: `ui/src/blocks/manager.ts:234-314` (the `render()` method)

- [ ] **Step 1: Add the click handler method on `BlocksManager`**

Inside `BlocksManager` (above `openBlockContextMenu`), add:

```ts
private async handleBlockActivation(blockCmd: string, blockCwd: string | null, run: boolean): Promise<void> {
  const targetCmd = blockCmd;
  let toInject = targetCmd;

  if (blockCwd && !cwdsEqual(blockCwd, this.currentCwd)) {
    const choice = await openCwdMismatchModal(blockCwd);
    if (choice === "cancel") return;
    if (choice === "insert-cd") {
      toInject = `cd ${shellQuote(blockCwd)} && ${targetCmd}`;
    }
  }

  if (run) toInject += "\n";
  try {
    await injectCommand(this.sessionId, toInject);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error("inject_command failed", err);
  }
}
```

Add at the top of the file (with the other imports):

```ts
import { cwdsEqual } from "./cwd-compare";
import { openCwdMismatchModal } from "./cwd-mismatch-modal";
```

And add a helper at the bottom of the file (module scope, near other helpers):

```ts
/// POSIX-safe single-quote shell quoting for cwd → cd injection.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
```

- [ ] **Step 2: Wire the listeners in `render()`**

After the existing `.block-fix-cmd` and context-menu handlers (around line 311, before the `scrollTop` line), add:

```ts
// Single-click: insert command (no newline). Double-click: insert + run.
// We use a small timer to disambiguate single from double, since
// 'click' fires before 'dblclick' otherwise.
this.content
  .querySelectorAll<HTMLElement>(".block-item")
  .forEach((el) => {
    let clickTimer: number | null = null;
    el.addEventListener("click", (e) => {
      // Ignore clicks that bubbled from inner buttons (fix, dismiss, etc).
      if ((e.target as HTMLElement).closest(".block-fix-cmd, .block-fix-dismiss")) return;
      const blockId = el.dataset.blockId;
      const cmdAttr = el.dataset.cmd;
      const cwdAttr = el.dataset.cwd ?? null;
      let cmd = cmdAttr ?? "";
      let cwd: string | null = cwdAttr;
      if (blockId) {
        const b = this.blocksById.get(blockId);
        if (b) { cmd = b.command; cwd = b.cwd ?? null; }
      }
      if (!cmd) return;
      if (clickTimer != null) return; // dblclick handler will fire
      clickTimer = window.setTimeout(() => {
        clickTimer = null;
        void this.handleBlockActivation(cmd, cwd, false);
      }, 220);
    });
    el.addEventListener("dblclick", (e) => {
      if ((e.target as HTMLElement).closest(".block-fix-cmd, .block-fix-dismiss")) return;
      if (clickTimer != null) { clearTimeout(clickTimer); clickTimer = null; }
      const blockId = el.dataset.blockId;
      const cmdAttr = el.dataset.cmd;
      const cwdAttr = el.dataset.cwd ?? null;
      let cmd = cmdAttr ?? "";
      let cwd: string | null = cwdAttr;
      if (blockId) {
        const b = this.blocksById.get(blockId);
        if (b) { cmd = b.command; cwd = b.cwd ?? null; }
      }
      if (!cmd) return;
      void this.handleBlockActivation(cmd, cwd, true);
    });
  });
```

- [ ] **Step 3: Add `data-cmd` and `data-cwd` attributes to current-session block rows**

In `render()` at line 247-254, change:

```ts
return `
  <li class="block-item" data-block-id="${escapeHtml(b.id)}">
    ${cwd ? `<div class="block-cwd">${cwd}</div>` : ""}
    <div class="block-cmd">$ ${escapeHtml(b.command)}</div>
    <div class="block-meta">${status}</div>
    ${fix}
  </li>
`;
```

to:

```ts
return `
  <li class="block-item" data-block-id="${escapeHtml(b.id)}" data-cmd="${escapeHtml(b.command)}" data-cwd="${escapeHtml(b.cwd ?? "")}">
    ${cwd ? `<div class="block-cwd">${cwd}</div>` : ""}
    <div class="block-cmd">$ ${escapeHtml(b.command)}</div>
    <div class="block-meta">${status}</div>
    ${fix}
  </li>
`;
```

- [ ] **Step 4: Verify build**

Run: `npm run build`
Expected: succeeds, no TS errors.

- [ ] **Step 5: Manual smoke test**

Run: `npm run tauri:dev`
- Run `ls` in a tab. Click the block in the right panel → `ls` should appear at the prompt without Enter. Edit it, press Enter — runs.
- Double-click the same block → should run immediately.
- `cd /tmp` then click an older block from the original cwd → modal appears with three options. Verify each option does the expected thing (Insert / Insert with cd / Cancel).

- [ ] **Step 6: Commit**

```bash
git add ui/src/blocks/manager.ts
git commit -m "feat(blocks): clickable current-session blocks with cwd guard"
```

---

## Task 4: Make historical blocks clickable

**Files:**
- Modify: `ui/src/blocks/manager.ts:166-194` (`renderHistoricalSection`)

- [ ] **Step 1: Add `data-cmd` to historical `<li>`**

`HistoricalBlockRow` (`ui/src/api.ts:494`) has no `cwd` field — historical rows are server-filtered to the current cwd (the section header literally reads "from previous sessions in this dir"), so the cwd guard never needs to fire for them. We omit `data-cwd` for historical rows; the click handler in Task 3 treats a missing/empty `data-cwd` as "no guard needed" (cwd guard only triggers when `blockCwd` is truthy and differs from `currentCwd`).

In `renderHistoricalSection`, change the `<li>` open tag:

```ts
return `
  <li class="block-item block-item-history" data-cmd="${escapeHtml(b.command)}">
    <div class="block-cmd">$ ${escapeHtml(b.command)}</div>
    <div class="block-meta">
      <span class="block-exit ${ok ? "ok" : "fail"}">exit ${escapeHtml(codeText)}</span>
      <span class="block-history-tab">…${escapeHtml(b.session_id_short)}</span>
      <span class="block-history-when">${when}</span>
      <span class="block-dur">${dur}</span>
    </div>
  </li>
`;
```

- [ ] **Step 2: Verify the same listeners apply**

The `.block-item` selector in Task 3 already matches `.block-item.block-item-history`. No additional wiring needed.

- [ ] **Step 3: Manual smoke test**

Run: `npm run tauri:dev`
- Open a tab in a directory with prior blocks (the "from previous sessions in this dir" section is populated).
- Single-click a historical block → command appears in prompt.
- Double-click a historical block in the *current* cwd → runs.
- If the historical block has a different cwd than current → modal appears.

- [ ] **Step 4: Commit**

```bash
git add ui/src/blocks/manager.ts
git commit -m "feat(blocks): clickable historical blocks"
```

---

## Task 5: Hover affordance

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Add hover + cursor styles**

Find the existing `.block-item` rule in `ui/src/styles.css` (`grep -n "\.block-item" ui/src/styles.css`). Append a hover rule near it:

```css
.block-item {
  cursor: pointer;
}
.block-item:hover {
  background: rgba(255, 255, 255, 0.04);
}
```

If a `.block-item:hover` rule already exists, merge (do not duplicate).

- [ ] **Step 2: Manual smoke test**

Run: `npm run tauri:dev`
Hover over any block row → cursor turns into pointer, row gets a subtle highlight.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "style(blocks): hover affordance on clickable rows"
```

---

## Task 6: Full test + final verification

- [ ] **Step 1: Run all UI tests**

Run: `npm test`
Expected: All tests pass, including new `cwd-compare` and `cwd-mismatch-modal` suites.

- [ ] **Step 2: Run TypeScript build**

Run: `npm run build`
Expected: succeeds, no errors.

- [ ] **Step 3: End-to-end manual verification**

Run: `npm run tauri:dev` and verify the full matrix:

| Action | Expected |
|---|---|
| Single click, same cwd | Command in prompt, no Enter, terminal focused |
| Double click, same cwd | Command runs |
| Single click, different cwd → Insert | Command in prompt, no Enter |
| Single click, different cwd → Insert with cd | `cd '<cwd>' && <cmd>` in prompt |
| Single click, different cwd → Cancel | Nothing happens |
| Double click, different cwd → Insert with cd | `cd '<cwd>' && <cmd>` runs |
| Escape on modal | Treated as Cancel |
| Click inside `.block-fix-cmd` button | Fix flow runs (existing behavior preserved) |
| Right-click on block | Context menu opens (existing behavior preserved) |

- [ ] **Step 4: Final commit if any fixups were needed**

```bash
git status
# Only commit if there are leftover changes from manual verification fixes.
```

---

## Notes for the implementer

- `injectCommand` (`ui/src/api.ts:119`) writes raw bytes to the PTY. It does **not** add a newline. Append `\n` yourself for run.
- The PTY-side handler is `crates/app/src/lib.rs:1733` — no changes needed there.
- The existing context-menu handler on `.block-item` (line ~299) uses `e.preventDefault()` on `contextmenu`; left-click and dblclick won't conflict with it.
- The fix-suggestion handler (line ~270) uses `e.stopPropagation()` so its click won't bubble to the row, but the new row click handler also defensively bails if the click target is inside `.block-fix-cmd` or `.block-fix-dismiss`.
- Click/dblclick disambiguation uses a 220ms timer — short enough to feel responsive, long enough to capture a deliberate dblclick.
