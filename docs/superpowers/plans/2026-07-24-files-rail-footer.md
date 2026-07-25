# Files Rail Footer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the Files tree path + branch chip from a two-row header into a fixed rail footer so the file list gains vertical space.

**Architecture:** Keep pin/worktree/branch probe logic in `StructureTree`. Relocate DOM: header = title + actions; new footer hosts path + branch. Status bar unchanged.

**Tech Stack:** Vanilla TS + CSS in `ui/`; Vitest for DOM assertions.

**Spec:** `docs/superpowers/specs/2026-07-24-files-rail-footer-design.md`

## Global Constraints

- English UI copy; icons via `Icons.*` (no emoji in chrome).
- Tooltips via `attachTooltip`, never native `title=` for new interactive chrome (existing action `title=` may remain until a separate sweep).
- Compose ink alphas as `rgb(var(--ink-rgb) / …)`.
- Footer metrics match `--rail-footer-h: 30px`; header prefers rail header density.
- Branch chip display-only in v1 (no click → git switcher).
- No status-bar changes; Files rail only.

## File map

| File | Role |
|---|---|
| `ui/src/structure/tree.ts` | Construct footer; split path/actions render; `renderBranch` → footer |
| `ui/src/styles.css` | Retire mid-strip; style `.structure-footer` |
| `ui/src/structure/tree.test.ts` | Assert path/branch in footer, not mid-header |

---

### Task 1: Failing tests for footer placement

**Files:**
- Modify: `ui/src/structure/tree.test.ts` (branch chip describe + new layout asserts)
- Test: same

**Interfaces:**
- Consumes: existing `StructureTree`, `.structure-branch-name`, mocks for `getDirContext`
- Produces: tests that expect `.structure-footer` containing path + chip; header without `.structure-cwd`

- [ ] **Step 1: Update branch-chip tests and add layout tests**

In `describe("StructureTree branch chip")`, change mid-strip assertions to footer:

```ts
expect(host.querySelector(".structure-footer .structure-branch-name")?.textContent).toBe("…");
expect(host.querySelector<HTMLElement>(".structure-footer .structure-branch")?.hidden).toBe(false);
// non-repo:
expect(host.querySelector<HTMLElement>(".structure-footer .structure-branch")?.hidden).toBe(true);
```

Add:

```ts
describe("StructureTree footer layout", () => {
  // same beforeEach as branch chip
  it("puts path in the footer and actions in the header", async () => {
    listDirMock.mockResolvedValueOnce([entry("/wt/a.md", "a.md", "file")]);
    dirCtxMock.mockResolvedValueOnce({ git: { repo_name: "r", branch: "main" }, runtime: null });
    await tree.setCwd("/wt");
    await flush();
    expect(host.querySelector(".structure-header .structure-cwd")).toBeNull();
    expect(host.querySelector(".structure-footer .structure-cwd")).not.toBeNull();
    expect(host.querySelector(".structure-header .structure-action")).not.toBeNull();
    expect(host.querySelector(".structure-header .structure-branch")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect FAIL**

Run: `npm test -- ui/src/structure/tree.test.ts`
Expected: FAIL — `.structure-footer` missing / cwd still in header.

- [ ] **Step 3: Commit tests**

```bash
git add ui/src/structure/tree.test.ts
git commit -m "test(structure): expect path+branch in Files rail footer"
```

---

### Task 2: Relocate path + branch into footer DOM

**Files:**
- Modify: `ui/src/structure/tree.ts` (constructor, `renderWaiting`, `renderHeader`, `renderBranch`)
- Modify: `ui/src/styles.css` (`.structure-header`, retire mid `.structure-branch` strip, add `.structure-footer`)

**Interfaces:**
- Consumes: existing `renderHeader` / `renderBranch` / `decorateWorktreeSelector`
- Produces: `footerEl` after `listEl`/`emptyEl`; `branchEl` inside footer; path rendered into footer

- [ ] **Step 1: Constructor — add footer, nest branch**

```ts
// After emptyEl append:
this.footerEl = document.createElement("footer");
this.footerEl.className = "structure-footer";
this.root.appendChild(this.footerEl);

this.branchEl = document.createElement("div");
this.branchEl.className = "structure-branch";
this.branchEl.hidden = true;
// Do NOT append branchEl to root between header and list.
// Append branchEl inside footer in renderBranch / keep as child of footerEl always:
this.footerEl.appendChild(this.branchEl);
```

Order in host: `header` → `list` → `empty` → `footer` (with `branch` inside footer). Path label mounts into `footerEl` before the branch node.

- [ ] **Step 2: Split renderHeader**

`renderHeader(cwd)`:
- Clear `headerEl` and `footerEl` (re-append `branchEl` after clear, or clear only a path slot).
- Prefer: `footerEl` structure = `[pathLabel][branchEl]`. On re-render, replace path only; leave `branchEl` in place and call `renderBranch`.
- Header gets title span `.structure-title` / `.rail-title-label` text `Files` + existing action buttons (no path).
- Path label + pin + `decorateWorktreeSelector` mount in footer before `branchEl`.

`renderWaiting`: clear header actions/title appropriately; footer shows waiting cwd label; hide branch.

- [ ] **Step 3: CSS**

```css
.structure-header {
  /* tighten toward rail-header: fixed height, title + actions */
  flex: 0 0 var(--rail-header-h);
  height: var(--rail-header-h);
  padding: 0 8px 0 var(--rail-pad-x);
}
.structure-footer {
  flex: 0 0 var(--rail-footer-h);
  height: var(--rail-footer-h);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 var(--rail-pad-x);
  border-top: 1px solid var(--border);
  font-size: var(--fs-micro);
  color: var(--muted);
  min-width: 0;
}
.structure-footer .structure-cwd { flex: 1; min-width: 0; }
.structure-branch {
  /* remove mid-strip padding/border-bottom; footer chip host */
  display: flex;
  align-items: center;
  flex-shrink: 0;
  padding: 0;
  border-bottom: none;
  max-width: 45%;
}
```

Keep `.structure-branch-chip` / `.structure-branch-name` styles (ellipsis).

- [ ] **Step 4: Run tests — expect PASS**

Run: `npm test -- ui/src/structure/tree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add ui/src/structure/tree.ts ui/src/styles.css
git commit -m "feat(structure): move Files path+branch into rail footer"
```

---

### Task 3: Pin + waiting regression check

**Files:**
- Modify: `ui/src/structure/tree.test.ts` only if gaps remain
- Verify: existing worktree-selector tests still pass

- [ ] **Step 1: Run full structure test file**

Run: `npm test -- ui/src/structure/tree.test.ts`
Expected: all green (selector still on path; path now in footer).

- [ ] **Step 2: Manual checklist (dev app)**

- Open Files rail in a git repo → footer shows path + branch; header only actions.
- Non-repo cwd → path only.
- Pin to sibling worktree → pin glyph in footer; status bar may differ.
- Status bar unchanged.

- [ ] **Step 3: Commit any test fixes if needed**

---

## Spec coverage

| Spec item | Task |
|---|---|
| Header = title + actions | 2 |
| Footer = path + branch | 2 |
| Delete mid branch strip | 2 |
| Pin / selector unchanged | 2–3 |
| Branch display-only | 2 (no click wired) |
| Status bar untouched | — (no files) |
| Tests for placement | 1, 3 |
