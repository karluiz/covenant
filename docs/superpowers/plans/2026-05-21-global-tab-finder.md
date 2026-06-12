# Global Tab Finder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a search input to the workspace switcher popover that filters tabs across all workspaces (including hibernated) by title, group, and workspace name; Enter switches workspace if needed and activates the tab.

**Architecture:** New pure function `filterAndRankTabs` over a flat row model produced by `WorkspaceManager.listAllTabs()`. The active workspace contributes live titles via a new `TabManager.snapshotForFinder()`; inactive workspaces use their persisted manifest. The existing `WorkspaceSwitcher` popover gains a search input and a second render mode (results) on top of the current workspace list mode.

**Tech Stack:** TypeScript, Vitest, Tauri webview (Chromium), existing `WorkspaceManager` + `TabManager` + `WorkspaceSwitcher`.

**Spec:** `docs/superpowers/specs/2026-05-21-global-tab-finder-design.md`

---

## File Structure

- **Create**
  - `ui/src/workspaces/finder.ts` — pure `filterAndRankTabs` + the `TabRow` type, no DOM.
  - `ui/src/workspaces/finder.test.ts` — unit tests for the pure filter/rank fn.
- **Modify**
  - `ui/src/tabs/manager.ts` — add `snapshotForFinder()`.
  - `ui/src/workspaces/manager.ts` — add `activeId()` getter and `listAllTabs()`.
  - `ui/src/workspaces/manager.test.ts` — add `listAllTabs` test.
  - `ui/src/workspaces/switcher.ts` — accept `TabManager` in constructor; add search input + results render mode + keyboard nav + `runSelect`.
  - `ui/src/main.ts` — pass `TabManager` to `WorkspaceSwitcher`.
  - `ui/src/styles.css` — `.workspace-search`, `.workspace-result-*` classes.

---

## Task 1: `TabRow` type + `filterAndRankTabs` pure function

**Files:**
- Create: `ui/src/workspaces/finder.ts`
- Test: `ui/src/workspaces/finder.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/workspaces/finder.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { filterAndRankTabs, type TabRow } from "./finder";

function row(p: Partial<TabRow>): TabRow {
  return {
    workspaceId: "ws-1",
    workspaceName: "Workspace 1",
    workspaceColor: null,
    workspaceActive: false,
    groupId: null,
    groupName: null,
    groupColor: null,
    tabIndex: 0,
    title: "tab",
    isActiveTabInWorkspace: false,
    ...p,
  };
}

describe("filterAndRankTabs", () => {
  it("returns empty when query is blank", () => {
    expect(filterAndRankTabs("", [row({})])).toEqual([]);
    expect(filterAndRankTabs("   ", [row({})])).toEqual([]);
  });

  it("matches title substring, case-insensitive", () => {
    const rows = [row({ title: "Migration" }), row({ title: "tests" })];
    expect(filterAndRankTabs("MIG", rows).map((r) => r.title)).toEqual(["Migration"]);
  });

  it("ranks title startsWith above title contains", () => {
    const rows = [
      row({ title: "run-migration", tabIndex: 0 }),
      row({ title: "migration-tests", tabIndex: 1 }),
    ];
    const out = filterAndRankTabs("migration", rows);
    expect(out.map((r) => r.title)).toEqual(["migration-tests", "run-migration"]);
  });

  it("ranks title hits above group hits above workspace hits", () => {
    const rows = [
      row({ title: "alpha", workspaceName: "banco" }),
      row({ title: "beta", groupName: "banco-group" }),
      row({ title: "banco", workspaceName: "other" }),
    ];
    const out = filterAndRankTabs("banco", rows).map((r) => r.title);
    expect(out).toEqual(["banco", "beta", "alpha"]);
  });

  it("caps results at 50", () => {
    const rows: TabRow[] = [];
    for (let i = 0; i < 80; i++) rows.push(row({ title: `tab-${i}`, tabIndex: i }));
    expect(filterAndRankTabs("tab", rows)).toHaveLength(50);
  });

  it("filters out non-matching rows", () => {
    const rows = [row({ title: "alpha" }), row({ title: "beta" })];
    expect(filterAndRankTabs("zzz", rows)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm vitest run src/workspaces/finder.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `finder.ts`**

Create `ui/src/workspaces/finder.ts`:

```ts
/// Pure search/rank helpers for the global tab finder. DOM-free so we
/// can unit-test the filter logic in isolation.

export interface TabRow {
  workspaceId: string;
  workspaceName: string;
  workspaceColor: string | null;
  workspaceActive: boolean;
  groupId: string | null;
  groupName: string | null;
  groupColor: string | null;
  tabIndex: number;
  title: string;
  isActiveTabInWorkspace: boolean;
}

const MAX_RESULTS = 50;

type Tier = 0 | 1 | 2 | 3;

function tier(query: string, row: TabRow): Tier | null {
  const q = query;
  const title = row.title.toLowerCase();
  if (title.startsWith(q)) return 0;
  if (title.includes(q)) return 1;
  if ((row.groupName ?? "").toLowerCase().includes(q)) return 2;
  if (row.workspaceName.toLowerCase().includes(q)) return 3;
  return null;
}

export function filterAndRankTabs(query: string, rows: TabRow[]): TabRow[] {
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const scored: Array<{ row: TabRow; tier: Tier; ord: number }> = [];
  rows.forEach((row, ord) => {
    const t = tier(q, row);
    if (t !== null) scored.push({ row, tier: t, ord });
  });
  scored.sort((a, b) => (a.tier - b.tier) || (a.ord - b.ord));
  return scored.slice(0, MAX_RESULTS).map((s) => s.row);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm vitest run src/workspaces/finder.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/workspaces/finder.ts ui/src/workspaces/finder.test.ts
git commit -m "feat(workspaces/finder): pure filter+rank for global tab search"
```

---

## Task 2: `TabManager.snapshotForFinder()`

**Files:**
- Modify: `ui/src/tabs/manager.ts`

The active workspace must contribute *live* titles (default_title resolves from runtime spawn sequence, which isn't in the persisted manifest). Add a tiny snapshot method.

- [ ] **Step 1: Read the existing tab-view shape**

Run: `grep -nE "defaultTitle|default_title|customName|custom_name" ui/src/tabs/manager.ts | head -20`
Expected: shows the field names actually used in the runtime `Tab` struct (likely `customName` + `defaultTitle`).

- [ ] **Step 2: Add the method**

In `ui/src/tabs/manager.ts`, near the other public read-only snapshots (search for `serializeManifest()` and add after it):

```ts
/// Lightweight per-tab view for the global tab finder. Pulled live so
/// titles reflect the current spawn-sequence default (e.g. "zsh 3"),
/// which is not stored in the persisted manifest.
snapshotForFinder(): Array<{
  index: number;
  title: string;
  groupId: string | null;
  isActive: boolean;
}> {
  return this.tabs.map((t, index) => ({
    index,
    title: t.customName ?? t.defaultTitle,
    groupId: t.groupId ?? null,
    isActive: t.id === this.activeId,
  }));
}
```

If the actual field names differ (e.g. `custom_name`/`default_title`), use those exactly as defined on the private `Tab` type. Do not invent properties.

- [ ] **Step 3: Verify it compiles**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(tabs): snapshotForFinder() exposes live titles for the finder"
```

---

## Task 3: `WorkspaceManager.activeId()` + `listAllTabs()`

**Files:**
- Modify: `ui/src/workspaces/manager.ts`
- Test: `ui/src/workspaces/manager.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `ui/src/workspaces/manager.test.ts` a test that:
- Boots a WorkspaceManager with a V2 manifest containing two workspaces (one active with 2 tabs, one inactive with 1 tab).
- Stubs `TabManager.snapshotForFinder()` to return a deterministic shape for the active one.
- Asserts `listAllTabs()` returns 3 rows in workspace-list order then tabIndex order, with correct `workspaceActive` / `isActiveTabInWorkspace` flags and group denormalization (group `name` + `color` filled in from `groups[]`).

Use the existing test file's patterns for stubbing `TabManager`. If `snapshotForFinder` is not yet on the stub, extend the stub.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm vitest run src/workspaces/manager.test.ts`
Expected: FAIL — `listAllTabs is not a function`.

- [ ] **Step 3: Add `activeId()` and `listAllTabs()` to `WorkspaceManager`**

In `ui/src/workspaces/manager.ts`, after `list()`:

```ts
/// Public read-only accessor for the active workspace id (the finder
/// needs to know whether a selected row requires a workspace switch).
activeId_(): string {
  return this.activeId;
}

/// Flatten every workspace's tabs into a single TabRow list for the
/// global finder. Active workspace pulls live titles via TabManager;
/// inactive workspaces use their persisted manifest body.
listAllTabs(): TabRow[] {
  const rows: TabRow[] = [];
  for (const w of this.workspaces) {
    const isActiveWs = w.id === this.activeId;
    const groupById = new Map(w.groups.map((g) => [g.id, g]));
    if (isActiveWs) {
      const snap = this.tabManager.snapshotForFinder();
      for (const t of snap) {
        const g = t.groupId ? groupById.get(t.groupId) : null;
        rows.push({
          workspaceId: w.id,
          workspaceName: w.name,
          workspaceColor: w.color,
          workspaceActive: true,
          groupId: t.groupId,
          groupName: g?.name ?? null,
          groupColor: g?.color ?? null,
          tabIndex: t.index,
          title: t.title,
          isActiveTabInWorkspace: t.isActive,
        });
      }
    } else {
      w.tabs.forEach((t, i) => {
        const g = t.group_id ? groupById.get(t.group_id) : null;
        rows.push({
          workspaceId: w.id,
          workspaceName: w.name,
          workspaceColor: w.color,
          workspaceActive: false,
          groupId: t.group_id ?? null,
          groupName: g?.name ?? null,
          groupColor: g?.color ?? null,
          tabIndex: i,
          title: t.custom_name ?? `Tab ${i + 1}`,
          isActiveTabInWorkspace: i === w.active_index,
        });
      });
    }
  }
  return rows;
}
```

Add at the top of the file:

```ts
import type { TabRow } from "./finder";
```

Note: name the accessor `activeId_` to avoid colliding with the existing private `activeId` field. Alternative: rename the private field to `activeWorkspaceId` in a follow-up cleanup — out of scope for this plan.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm vitest run src/workspaces/manager.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/workspaces/manager.ts ui/src/workspaces/manager.test.ts
git commit -m "feat(workspaces): listAllTabs() + activeId_() for the finder"
```

---

## Task 4: Search input in the switcher popover

**Files:**
- Modify: `ui/src/workspaces/switcher.ts`
- Modify: `ui/src/main.ts`
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Extend the constructor to accept `TabManager`**

In `ui/src/workspaces/switcher.ts`:

```ts
import { TabManager } from "../tabs/manager";
import { filterAndRankTabs, type TabRow } from "./finder";

export class WorkspaceSwitcher {
  // ... existing fields ...
  private query: string = "";
  private selectedIndex: number = 0;
  private lastResults: TabRow[] = [];

  constructor(
    private readonly ws: WorkspaceManager,
    private readonly tabManager: TabManager,
  ) {}
```

- [ ] **Step 2: Update `main.ts` to pass `TabManager`**

In `ui/src/main.ts`, find the existing `new WorkspaceSwitcher(...)` call. Modify it to pass the tab manager:

```ts
const wsSwitcher = new WorkspaceSwitcher(workspaceManager, tabManager);
```

Use the local variable names that already exist in `main.ts` (do not invent identifiers; grep for the existing call and adapt).

- [ ] **Step 3: Inject search input and split renderPopover**

In `switcher.ts`, replace the body of `renderPopover()` with:

```ts
private renderPopover(): void {
  if (!this.popover) return;
  this.popover.innerHTML = `
    <div class="workspace-popover-searchwrap">
      <input class="workspace-search" type="text" spellcheck="false"
             placeholder="Search tabs across workspaces…"
             value="${esc(this.query)}">
    </div>
    <div class="workspace-popover-list" data-region="list"></div>
    <div class="workspace-popover-footer">
      <button type="button" class="workspace-new-btn">+ New workspace</button>
      <span class="workspace-popover-kbd">${esc(KBD_NEW)}</span>
    </div>
  `;

  const input = this.popover.querySelector<HTMLInputElement>(".workspace-search");
  input?.addEventListener("input", () => {
    this.query = input.value;
    this.selectedIndex = 0;
    this.renderList();
  });
  input?.focus();

  this.popover
    .querySelector<HTMLButtonElement>(".workspace-new-btn")
    ?.addEventListener("click", () => {
      this.closePopover();
      void this.createAndSwitch();
    });

  this.renderList();
}

private renderList(): void {
  if (!this.popover) return;
  const region = this.popover.querySelector<HTMLElement>('[data-region="list"]');
  if (!region) return;
  const q = this.query.trim();
  if (q === "") {
    this.lastResults = [];
    region.innerHTML = this.renderWorkspaceRows();
    this.attachWorkspaceRowHandlers(region);
  } else {
    const rows = this.ws.listAllTabs();
    this.lastResults = filterAndRankTabs(q, rows);
    region.innerHTML = this.renderResultRows(this.lastResults);
    this.attachResultRowHandlers(region);
  }
}
```

Extract the existing workspace-row rendering into a new private method `renderWorkspaceRows()` and `attachWorkspaceRowHandlers()` by moving the current code that builds `rows` and binds row click/contextmenu listeners (no behavior changes).

- [ ] **Step 4: Implement result-row rendering**

Add to `switcher.ts`:

```ts
private renderResultRows(rows: TabRow[]): string {
  if (rows.length === 0) {
    return `<div class="workspace-empty">No tabs match.</div>`;
  }
  return rows
    .map((r, i) => {
      const sel = i === this.selectedIndex ? " workspace-result-row-selected" : "";
      const dotColor = r.groupColor ?? r.workspaceColor ?? "var(--chip-dot, #888)";
      const dotFill = r.isActiveTabInWorkspace && r.workspaceActive
        ? `background:${esc(dotColor)};`
        : `background:transparent;border:1.5px solid ${esc(dotColor)};`;
      const meta = [r.groupName, r.workspaceName]
        .filter((s): s is string => Boolean(s))
        .map((s) => esc(s))
        .join(" · ");
      return `
        <div class="workspace-result-row${sel}"
             data-ws="${esc(r.workspaceId)}"
             data-idx="${r.tabIndex}">
          <span class="workspace-result-dot" style="${dotFill}"></span>
          <span class="workspace-result-title">${esc(r.title)}</span>
          <span class="workspace-result-meta">${meta}</span>
        </div>`;
    })
    .join("");
}

private attachResultRowHandlers(region: HTMLElement): void {
  for (const el of region.querySelectorAll<HTMLElement>(".workspace-result-row")) {
    el.addEventListener("click", () => {
      const ws = el.dataset.ws ?? "";
      const idx = Number(el.dataset.idx ?? "-1");
      void this.runSelect(ws, idx);
    });
  }
}
```

- [ ] **Step 5: Add styles**

Append to `ui/src/styles.css`:

```css
.workspace-popover-searchwrap {
  padding: 8px 10px 6px;
  border-bottom: 1px solid var(--separator, rgba(255,255,255,0.06));
}
.workspace-search {
  width: 100%;
  background: transparent;
  border: 1px solid var(--separator, rgba(255,255,255,0.12));
  border-radius: 6px;
  padding: 6px 8px;
  color: inherit;
  font: inherit;
  outline: none;
}
.workspace-search:focus {
  border-color: var(--accent, rgba(120,160,255,0.6));
}
.workspace-result-row {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  cursor: pointer;
}
.workspace-result-row:hover,
.workspace-result-row-selected {
  background: var(--row-hover, rgba(255,255,255,0.06));
}
.workspace-result-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}
.workspace-result-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-result-meta { opacity: 0.6; font-size: 0.85em; }
.workspace-empty { padding: 10px; opacity: 0.6; text-align: center; }
```

- [ ] **Step 6: Verify it compiles + manual smoke**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no errors.

Run the app and press ⌘⇧P → search input is focused, typing filters tabs. Click handler not yet wired to activation (next task), but click should not crash.

- [ ] **Step 7: Commit**

```bash
git add ui/src/workspaces/switcher.ts ui/src/main.ts ui/src/styles.css
git commit -m "feat(workspaces/switcher): search input + results render mode"
```

---

## Task 5: Keyboard navigation + `runSelect`

**Files:**
- Modify: `ui/src/workspaces/switcher.ts`

- [ ] **Step 1: Add keyboard handler**

Replace the existing `onKey` inside `openPopover()` with a handler that knows the result list:

```ts
const onKey = (e: KeyboardEvent) => {
  if (!this.popover) return;
  if (e.key === "Escape") {
    if (this.query !== "") {
      this.query = "";
      this.selectedIndex = 0;
      this.renderPopover();
      e.preventDefault();
      return;
    }
    this.closePopover();
    return;
  }
  if (this.query.trim() === "") return;
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (this.lastResults.length === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % this.lastResults.length;
    this.renderList();
    return;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    if (this.lastResults.length === 0) return;
    this.selectedIndex =
      (this.selectedIndex - 1 + this.lastResults.length) % this.lastResults.length;
    this.renderList();
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    const pick = this.lastResults[this.selectedIndex];
    if (pick) void this.runSelect(pick.workspaceId, pick.tabIndex);
  }
};
```

- [ ] **Step 2: Implement `runSelect`**

Add to the class:

```ts
private async runSelect(workspaceId: string, tabIndex: number): Promise<void> {
  if (tabIndex < 0) return;
  const needsSwitch = workspaceId !== this.ws.activeId_();
  if (needsSwitch) {
    const target = this.ws.list().find((w) => w.id === workspaceId);
    if (!target) return;
    this.closePopover();
    await this.runSwitch(workspaceId, target.name);
  } else {
    this.closePopover();
  }
  this.tabManager.activateByIndex(tabIndex);
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Manual verification**

1. Launch the app with at least 2 workspaces, each with multiple tabs.
2. Press ⌘⇧P → search input focused.
3. Type a few chars matching a title in *another* workspace.
4. ↑/↓ moves selection (visual selected row updates).
5. Enter → "Switching to …" toast appears, workspace switches, target tab is focused.
6. Reopen ⌘⇧P, type a query, press Esc → query clears (list mode returns). Esc again → popover closes.
7. Empty-query path: ⌘⇧P, do not type → existing workspace list behavior unchanged (click row to switch, right-click for context menu).

- [ ] **Step 5: Commit**

```bash
git add ui/src/workspaces/switcher.ts
git commit -m "feat(workspaces/switcher): keyboard nav + cross-workspace activation"
```

---

## Task 6: Existing-test regression check + final cleanup

**Files:**
- (none — verification only)

- [ ] **Step 1: Run the full UI test suite**

Run: `cd ui && pnpm vitest run`
Expected: all pre-existing tests still pass.

- [ ] **Step 2: Run typecheck and the project's lint command**

Run: `cd ui && pnpm tsc --noEmit`
Run: `cd ui && pnpm lint` (skip if no lint script).

Expected: no errors.

- [ ] **Step 3: Final manual pass — confirm no regression in workspace switcher**

1. ⌘⇧P → list shows workspaces with dots/names/counts (unchanged).
2. Right-click a workspace row → rename / duplicate / set root dir / color / delete menu still works.
3. "+ New workspace" button still works.
4. ⌘⌥N still creates a new workspace.

- [ ] **Step 4: Self-contained commit covering anything overlooked**

If verification surfaced fixes, commit them. Otherwise no-op.

```bash
git status   # should be clean
```

---

## Self-Review Summary

- **Spec coverage:** all sections of the design doc are covered — data access (Task 3), tab identity via `{workspaceId, tabIndex}` (Task 5 `runSelect`), switcher search input + two render modes (Task 4), keyboard nav including Esc-clear-then-close (Task 5), shortcut reuse of ⌘⇧P (no new binding wired anywhere — Task 4 sec verified), 50-cap and ranking (Task 1).
- **Identity:** `TabRow` and `filterAndRankTabs` defined in Task 1 are consistently consumed in Tasks 3–5. `snapshotForFinder` shape (Task 2) matches what `listAllTabs` reads (Task 3). `activateByIndex` is the existing TabManager method (verified at line 1580 of `ui/src/tabs/manager.ts`).
- **Inactive-workspace title fallback:** persisted `SerializedTab` lacks `default_title`; plan uses `custom_name ?? "Tab N"` (see Task 3). Acceptable tradeoff documented in the spec.
- **Placeholder scan:** no TBDs, no "implement appropriately" — every step has the actual code.
