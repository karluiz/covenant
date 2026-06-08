# Unified Command Palette Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the anchored workspace-switcher popover with a centered command palette that fuzzy-searches workspaces + tabs + actions in one blended, sectioned list.

**Architecture:** A DOM-free items module builds and ranks `PaletteItem`s from three providers (workspaces, tabs, actions) using the existing `fuzzyScore`, partitioned into capped sections. A new `CommandPalette` DOM class (modeled on `RecallPalette`) renders the centered overlay. The `WorkspaceSwitcher` keeps its chip + context menu but delegates opening to the palette.

**Tech Stack:** TypeScript, Vite, Vitest (jsdom), reusing `ui/src/mentions/fuzzy.ts` and `ui/src/workspaces/manager.ts`.

**Run all tests from `ui/`:** `cd ui && npx vitest run <path>`

---

## File Structure

- **Create** `ui/src/workspaces/palette-items.ts` — pure types + `buildSections()` (fuzzy rank + partition + caps + empty-query defaults). DOM-free.
- **Create** `ui/src/workspaces/palette-items.test.ts` — unit tests for ranking/partition/empty-query.
- **Create** `ui/src/workspaces/actions.ts` — `buildActions(manager, tabManager)` static registry.
- **Create** `ui/src/workspaces/actions.test.ts` — each action invokes the right method.
- **Create** `ui/src/workspaces/palette.ts` — `CommandPalette` DOM class.
- **Create** `ui/src/workspaces/palette.test.ts` — DOM open/type/Enter/Esc tests.
- **Modify** `ui/src/tabs/manager.ts` — add `closeActiveTab()` (~line 2648, near `activateByIndex`).
- **Modify** `ui/src/workspaces/switcher.ts` — strip popover logic; delegate open to palette; keep chip + context menu.
- **Modify** `ui/src/workspaces/finder.ts` — keep `TabRow`; delete `filterAndRankTabs` + tier helpers.
- **Delete** `ui/src/workspaces/finder.test.ts` — its subject (`filterAndRankTabs`) is removed.
- **Modify** `ui/src/main.ts:1602-1628` — re-point keybindings to the palette.
- **Modify** `ui/src/styles.css` — add `.command-palette-*`; remove dead `.workspace-popover/search/result/empty` rules.

Reference signatures (verified in code):
- `WorkspaceManager`: `list(): WorkspaceView[]`, `listAllTabs(): TabRow[]`, `activeId_(): string`, `switchTo(id): Promise<void>`, `rename(id,name): void`, `create(name): string`.
- `WorkspaceView` fields: `id, name, color, root_dir, active, tab_count, last_used_at`.
- `TabRow` fields: `workspaceId, workspaceName, workspaceColor, workspaceActive, groupId, groupName, groupColor, tabIndex, title, isActiveTabInWorkspace`.
- `TabManager`: `activateByIndex(index): void`, `closeTab(id): void`, private `activeId: string | null`.
- `fuzzyScore(haystack: string, query: string): number | null`.

---

## Task 1: Palette item types + section builder (pure)

**Files:**
- Create: `ui/src/workspaces/palette-items.ts`
- Test: `ui/src/workspaces/palette-items.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/workspaces/palette-items.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildSections, type PaletteAction } from "./palette-items";
import type { WorkspaceView } from "./manager";
import type { TabRow } from "./finder";

function ws(p: Partial<WorkspaceView>): WorkspaceView {
  return {
    id: "ws-1", name: "Workspace", color: null, root_dir: null,
    active: false, tab_count: 0, last_used_at: 0, ...p,
  };
}
function row(p: Partial<TabRow>): TabRow {
  return {
    workspaceId: "ws-1", workspaceName: "Workspace 1", workspaceColor: null,
    workspaceActive: false, groupId: null, groupName: null, groupColor: null,
    tabIndex: 0, title: "tab", isActiveTabInWorkspace: false, ...p,
  };
}
const noop = () => {};
function action(id: string): PaletteAction {
  return { id, title: id, run: noop };
}

describe("buildSections", () => {
  it("empty query: recent workspaces first, current-workspace tabs, no actions", () => {
    const workspaces = [
      ws({ id: "a", name: "alpha", last_used_at: 100 }),
      ws({ id: "b", name: "beta", last_used_at: 300, active: true }),
      ws({ id: "c", name: "gamma", last_used_at: 200 }),
    ];
    const tabs = [
      row({ workspaceId: "b", workspaceActive: true, title: "here-1", tabIndex: 0 }),
      row({ workspaceId: "a", workspaceActive: false, title: "elsewhere", tabIndex: 0 }),
    ];
    const s = buildSections("", { workspaces, tabs, actions: [action("New workspace")], activeWorkspaceId: "b" });
    expect(s.workspaces.map((i) => i.title)).toEqual(["beta", "gamma", "alpha"]);
    expect(s.tabs.map((i) => i.title)).toEqual(["here-1"]);
    expect(s.actions).toEqual([]);
  });

  it("non-empty query: fuzzy match across kinds, drops non-matches", () => {
    const workspaces = [ws({ id: "a", name: "migration" }), ws({ id: "b", name: "scratch" })];
    const tabs = [row({ title: "run-migrate", tabIndex: 1 }), row({ title: "tests", tabIndex: 2 })];
    const actions = [action("Migrate up"), action("Close tab")];
    const s = buildSections("mig", { workspaces, tabs, actions, activeWorkspaceId: "a" });
    expect(s.workspaces.map((i) => i.title)).toEqual(["migration"]);
    expect(s.tabs.map((i) => i.title)).toEqual(["run-migrate"]);
    expect(s.actions.map((i) => i.title)).toEqual(["Migrate up"]);
  });

  it("ranks higher fuzzy score first within a section", () => {
    const tabs = [
      row({ title: "xmigration", tabIndex: 0 }),  // match but not prefix
      row({ title: "migrate", tabIndex: 1 }),      // prefix → consecutive+basename bonus
    ];
    const s = buildSections("mig", { workspaces: [], tabs, actions: [], activeWorkspaceId: "a" });
    expect(s.tabs.map((i) => i.title)).toEqual(["migrate", "xmigration"]);
  });

  it("caps each section", () => {
    const tabs: TabRow[] = [];
    for (let i = 0; i < 20; i++) tabs.push(row({ title: `tab-${i}`, tabIndex: i }));
    const s = buildSections("tab", { workspaces: [], tabs, actions: [], activeWorkspaceId: "a" });
    expect(s.tabs).toHaveLength(8);
  });

  it("tab item run switches workspace then activates index", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    const activate = vi.fn();
    const tabs = [row({ workspaceId: "other", title: "t", tabIndex: 3 })];
    const s = buildSections("t", {
      workspaces: [], tabs, actions: [], activeWorkspaceId: "cur",
      switchWorkspace: switchTo, activateTab: activate,
    });
    await s.tabs[0].run();
    expect(switchTo).toHaveBeenCalledWith("other");
    expect(activate).toHaveBeenCalledWith(3);
  });

  it("tab item run skips switch when already in workspace", async () => {
    const switchTo = vi.fn().mockResolvedValue(undefined);
    const activate = vi.fn();
    const tabs = [row({ workspaceId: "cur", title: "t", tabIndex: 2 })];
    const s = buildSections("t", {
      workspaces: [], tabs, actions: [], activeWorkspaceId: "cur",
      switchWorkspace: switchTo, activateTab: activate,
    });
    await s.tabs[0].run();
    expect(switchTo).not.toHaveBeenCalled();
    expect(activate).toHaveBeenCalledWith(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/workspaces/palette-items.test.ts`
Expected: FAIL — `buildSections` not exported / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/workspaces/palette-items.ts
/// Pure (DOM-free) construction + ranking of command-palette items.
/// Three kinds — workspaces, tabs, actions — fuzzy-ranked and split
/// into capped sections. Unit-tested in isolation.

import { fuzzyScore } from "../mentions/fuzzy";
import type { WorkspaceView } from "./manager";
import type { TabRow } from "./finder";

export type PaletteKind = "workspace" | "tab" | "action";

export interface PaletteItem {
  kind: PaletteKind;
  id: string;
  title: string;
  subtitle?: string;
  color?: string | null;
  icon?: string;
  score: number;
  run: () => void | Promise<void>;
}

export interface PaletteAction {
  id: string;
  title: string;
  icon?: string;
  run: () => void | Promise<void>;
}

export interface Sections {
  workspaces: PaletteItem[];
  tabs: PaletteItem[];
  actions: PaletteItem[];
}

export interface BuildCtx {
  workspaces: WorkspaceView[];
  tabs: TabRow[];
  actions: PaletteAction[];
  activeWorkspaceId: string;
  /// Operations captured by item.run closures. Optional so pure tests
  /// can omit them when not exercising run().
  switchWorkspace?: (id: string) => void | Promise<void>;
  activateTab?: (index: number) => void;
}

const WS_CAP = 5;
const TAB_CAP = 8;
const ACTION_CAP = 6;

function relTime(ms: number): string {
  const dt = Date.now() - ms;
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}

function wsItem(w: WorkspaceView, ctx: BuildCtx, score: number): PaletteItem {
  const unit = w.tab_count === 1 ? "tab" : "tabs";
  return {
    kind: "workspace",
    id: w.id,
    title: w.name,
    subtitle: `${w.tab_count} ${unit} · ${relTime(w.last_used_at)}`,
    color: w.color,
    score,
    run: () => {
      if (w.id !== ctx.activeWorkspaceId) return ctx.switchWorkspace?.(w.id);
    },
  };
}

function tabItem(r: TabRow, ctx: BuildCtx, score: number): PaletteItem {
  const where = [r.workspaceName, r.groupName].filter(Boolean).join(" › ");
  return {
    kind: "tab",
    id: `${r.workspaceId}:${r.tabIndex}`,
    title: r.title,
    subtitle: where ? `in ${where}` : undefined,
    color: r.groupColor ?? r.workspaceColor,
    score,
    run: async () => {
      if (r.workspaceId !== ctx.activeWorkspaceId) {
        await ctx.switchWorkspace?.(r.workspaceId);
      }
      ctx.activateTab?.(r.tabIndex);
    },
  };
}

function actionItem(a: PaletteAction, score: number): PaletteItem {
  return { kind: "action", id: a.id, title: a.title, icon: a.icon, score, run: a.run };
}

function byScoreDesc(a: PaletteItem, b: PaletteItem): number {
  return b.score - a.score;
}

export function buildSections(query: string, ctx: BuildCtx): Sections {
  const q = query.trim();

  if (q === "") {
    const workspaces = [...ctx.workspaces]
      .sort((a, b) => b.last_used_at - a.last_used_at)
      .slice(0, WS_CAP)
      .map((w) => wsItem(w, ctx, 0));
    const tabs = ctx.tabs
      .filter((r) => r.workspaceId === ctx.activeWorkspaceId)
      .slice(0, TAB_CAP)
      .map((r) => tabItem(r, ctx, 0));
    return { workspaces, tabs, actions: [] };
  }

  const workspaces: PaletteItem[] = [];
  for (const w of ctx.workspaces) {
    const s = fuzzyScore(w.name, q);
    if (s !== null) workspaces.push(wsItem(w, ctx, s));
  }
  const tabs: PaletteItem[] = [];
  for (const r of ctx.tabs) {
    const s = fuzzyScore(r.title, q);
    if (s !== null) tabs.push(tabItem(r, ctx, s));
  }
  const actions: PaletteItem[] = [];
  for (const a of ctx.actions) {
    const s = fuzzyScore(a.title, q);
    if (s !== null) actions.push(actionItem(a, s));
  }

  return {
    workspaces: workspaces.sort(byScoreDesc).slice(0, WS_CAP),
    tabs: tabs.sort(byScoreDesc).slice(0, TAB_CAP),
    actions: actions.sort(byScoreDesc).slice(0, ACTION_CAP),
  };
}

/// Flatten sections into the cursor-traversal order (headers excluded):
/// Workspaces → Tabs → Actions.
export function flattenSections(s: Sections): PaletteItem[] {
  return [...s.workspaces, ...s.tabs, ...s.actions];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/workspaces/palette-items.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/workspaces/palette-items.ts ui/src/workspaces/palette-items.test.ts
git commit -m "feat(palette): pure section builder for unified command palette"
```

---

## Task 2: `closeActiveTab()` on TabManager

**Files:**
- Modify: `ui/src/tabs/manager.ts:2648` (right after `activateByIndex`)

- [ ] **Step 1: Add the method**

Insert after the `activateByIndex` method (closing brace at ~line 2651):

```ts
  /// Close the currently-active tab, if any. Used by the command
  /// palette's "Close current tab" action.
  closeActiveTab(): void {
    if (this.activeId) this.closeTab(this.activeId);
  }
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd ui && npx tsc --noEmit`
Expected: no new errors referencing `manager.ts`.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(tabs): closeActiveTab() helper for palette action"
```

---

## Task 3: Action registry

**Files:**
- Create: `ui/src/workspaces/actions.ts`
- Test: `ui/src/workspaces/actions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/workspaces/actions.test.ts
import { describe, expect, it, vi } from "vitest";
import { buildActions } from "./actions";

function fakeManager() {
  return {
    create: vi.fn().mockReturnValue("new-id"),
    switchTo: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockReturnValue([]),
    activeId_: vi.fn().mockReturnValue("cur"),
    rename: vi.fn(),
  };
}

describe("buildActions", () => {
  it("New workspace creates + switches", async () => {
    const m = fakeManager();
    const tm = { closeActiveTab: vi.fn() };
    const actions = buildActions(m as never, tm as never);
    const a = actions.find((x) => x.id === "new-workspace")!;
    await a.run();
    expect(m.create).toHaveBeenCalled();
    expect(m.switchTo).toHaveBeenCalledWith("new-id");
  });

  it("Close current tab calls tabManager.closeActiveTab", async () => {
    const m = fakeManager();
    const tm = { closeActiveTab: vi.fn() };
    const actions = buildActions(m as never, tm as never);
    const a = actions.find((x) => x.id === "close-tab")!;
    await a.run();
    expect(tm.closeActiveTab).toHaveBeenCalled();
  });

  it("Rename current workspace exists and is invokable", () => {
    const m = fakeManager();
    const tm = { closeActiveTab: vi.fn() };
    const actions = buildActions(m as never, tm as never);
    expect(actions.find((x) => x.id === "rename-workspace")).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/workspaces/actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/workspaces/actions.ts
/// Static command-palette action registry. Adding an action is one
/// array entry. Rename is delegated to a callback the host supplies
/// (the switcher owns the inline-rename UI), defaulting to a no-op.

import type { TabManager } from "../tabs/manager";
import type { WorkspaceManager } from "./manager";
import type { PaletteAction } from "./palette-items";

export function buildActions(
  manager: WorkspaceManager,
  tabManager: TabManager,
  onRenameWorkspace?: (id: string) => void,
): PaletteAction[] {
  return [
    {
      id: "new-workspace",
      title: "New workspace",
      run: async () => {
        const name = `Workspace ${manager.list().length + 1}`;
        const id = manager.create(name);
        await manager.switchTo(id);
      },
    },
    {
      id: "rename-workspace",
      title: "Rename current workspace",
      run: () => onRenameWorkspace?.(manager.activeId_()),
    },
    {
      id: "close-tab",
      title: "Close current tab",
      run: () => tabManager.closeActiveTab(),
    },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/workspaces/actions.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/workspaces/actions.ts ui/src/workspaces/actions.test.ts
git commit -m "feat(palette): action registry (new/rename workspace, close tab)"
```

---

## Task 4: CommandPalette DOM class

**Files:**
- Create: `ui/src/workspaces/palette.ts`
- Test: `ui/src/workspaces/palette.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// ui/src/workspaces/palette.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./palette";

function makeManager(over: Record<string, unknown> = {}) {
  return {
    list: () => [
      { id: "a", name: "alpha", color: null, root_dir: null, active: true, tab_count: 2, last_used_at: 300 },
      { id: "b", name: "beta", color: null, root_dir: null, active: false, tab_count: 1, last_used_at: 100 },
    ],
    listAllTabs: () => [
      { workspaceId: "a", workspaceName: "alpha", workspaceColor: null, workspaceActive: true, groupId: null, groupName: null, groupColor: null, tabIndex: 0, title: "editor", isActiveTabInWorkspace: true },
    ],
    activeId_: () => "a",
    switchTo: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockReturnValue("c"),
    rename: vi.fn(),
    ...over,
  };
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("CommandPalette", () => {
  function mk(over = {}) {
    const m = makeManager(over);
    const tm = { activateByIndex: vi.fn(), closeActiveTab: vi.fn() };
    const p = new CommandPalette(document.body, m as never, tm as never, []);
    return { p, m, tm };
  }

  it("opens with an overlay and focused input", () => {
    const { p } = mk();
    p.open();
    expect(document.querySelector(".command-palette-overlay")).toBeTruthy();
    expect(document.activeElement?.classList.contains("command-palette-input")).toBe(true);
    p.close();
  });

  it("empty query shows workspace section ordered by recency", () => {
    const { p } = mk();
    p.open();
    const titles = [...document.querySelectorAll(".command-palette-item .cp-title")].map((e) => e.textContent);
    expect(titles).toContain("alpha");
    expect(titles).toContain("beta");
    p.close();
  });

  it("typing filters and Enter runs the selected item", () => {
    const { p, m } = mk();
    p.open();
    const input = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    input.value = "beta";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
    expect(m.switchTo).toHaveBeenCalledWith("b");
  });

  it("first Esc clears query, second Esc closes", () => {
    const { p } = mk();
    p.open();
    const input = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    input.value = "x";
    input.dispatchEvent(new Event("input"));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(input.value).toBe("");
    expect(document.querySelector(".command-palette-overlay")).toBeTruthy();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.querySelector(".command-palette-overlay")).toBeFalsy();
  });

  it("ArrowDown moves selection across the flat list", () => {
    const { p } = mk();
    p.open();
    const input = document.querySelector<HTMLInputElement>(".command-palette-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown" }));
    const active = document.querySelectorAll(".command-palette-item.active");
    expect(active).toHaveLength(1);
    p.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && npx vitest run src/workspaces/palette.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// ui/src/workspaces/palette.ts
/// Centered command palette — unified quick-switch across workspaces,
/// tabs, and actions. Modeled on RecallPalette (overlay/card, flat
/// cursor, mousemove-not-mouseenter highlight). Opening is delegated
/// here from the WorkspaceSwitcher chip + ⌘⌥T / ⌘⇧P keybindings.

import type { TabManager } from "../tabs/manager";
import type { WorkspaceManager } from "./manager";
import {
  buildSections,
  flattenSections,
  type PaletteAction,
  type PaletteItem,
  type Sections,
} from "./palette-items";

const SECTION_TITLES: Record<keyof Sections, string> = {
  workspaces: "Workspaces",
  tabs: "Tabs",
  actions: "Actions",
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export class CommandPalette {
  private overlay: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private query = "";
  private flat: PaletteItem[] = [];
  private cursor = 0;

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly manager: WorkspaceManager,
    private readonly tabManager: TabManager,
    private readonly actions: PaletteAction[],
    private readonly focusTerminal?: () => void,
  ) {}

  isOpen(): boolean {
    return this.overlay !== null;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen()) return;
    this.query = "";
    this.cursor = 0;
    this.render();
    this.refresh();
  }

  close(): void {
    if (!this.overlay) return;
    this.overlay.remove();
    this.overlay = null;
    this.inputEl = null;
    this.listEl = null;
    this.flat = [];
    this.cursor = 0;
  }

  private render(): void {
    const overlay = document.createElement("div");
    overlay.className = "command-palette-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "command-palette-card";
    card.innerHTML = `
      <div class="command-palette-input-row">
        <span class="command-palette-label">⌘⌥T</span>
        <input type="text" class="command-palette-input"
               placeholder="Search workspaces, tabs, actions…"
               autocomplete="off" spellcheck="false" />
      </div>
      <div class="command-palette-list" role="listbox"></div>
    `;
    overlay.appendChild(card);
    this.mountHost.appendChild(overlay);

    this.overlay = overlay;
    this.inputEl = card.querySelector<HTMLInputElement>(".command-palette-input")!;
    this.listEl = card.querySelector<HTMLElement>(".command-palette-list")!;

    this.inputEl.addEventListener("input", () => {
      this.query = this.inputEl?.value ?? "";
      this.cursor = 0;
      this.refresh();
    });
    this.inputEl.addEventListener("keydown", (e) => this.onKey(e));
    this.inputEl.focus();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      if (this.query !== "") {
        this.query = "";
        if (this.inputEl) this.inputEl.value = "";
        this.cursor = 0;
        this.refresh();
      } else {
        this.close();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.move(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.move(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = this.flat[this.cursor];
      if (pick) void this.execute(pick);
      return;
    }
  }

  private move(delta: number): void {
    if (this.flat.length === 0) return;
    this.cursor = (this.cursor + delta + this.flat.length) % this.flat.length;
    this.highlight();
  }

  private highlight(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll<HTMLElement>(".command-palette-item").forEach((el, i) => {
      el.classList.toggle("active", i === this.cursor);
      if (i === this.cursor) el.scrollIntoView({ block: "nearest" });
    });
  }

  private refresh(): void {
    const sections = buildSections(this.query, {
      workspaces: this.manager.list(),
      tabs: this.manager.listAllTabs(),
      actions: this.actions,
      activeWorkspaceId: this.manager.activeId_(),
      switchWorkspace: (id) => this.manager.switchTo(id),
      activateTab: (idx) => this.tabManager.activateByIndex(idx),
    });
    this.flat = flattenSections(sections);
    if (this.cursor >= this.flat.length) this.cursor = 0;
    this.renderList(sections);
  }

  private renderList(sections: Sections): void {
    if (!this.listEl) return;
    if (this.flat.length === 0) {
      this.listEl.innerHTML = `<div class="command-palette-empty">No matches</div>`;
      return;
    }

    let flatIdx = 0;
    const order: Array<keyof Sections> = ["workspaces", "tabs", "actions"];
    let html = "";
    for (const key of order) {
      const items = sections[key];
      if (items.length === 0) continue;
      html += `<div class="command-palette-section-header">${SECTION_TITLES[key]}</div>`;
      for (const item of items) {
        html += this.itemHtml(item, flatIdx);
        flatIdx++;
      }
    }
    this.listEl.innerHTML = html;

    this.listEl.querySelectorAll<HTMLElement>(".command-palette-item").forEach((el) => {
      const idx = Number(el.dataset.index ?? "0");
      el.addEventListener("mousemove", () => {
        if (idx === this.cursor) return;
        this.cursor = idx;
        this.highlight();
      });
      el.addEventListener("click", () => {
        const pick = this.flat[idx];
        if (pick) void this.execute(pick);
      });
    });
  }

  private itemHtml(item: PaletteItem, idx: number): string {
    const active = idx === this.cursor ? " active" : "";
    const dot =
      item.kind === "action"
        ? `<span class="cp-icon">${escapeHtml(item.icon ?? "▸")}</span>`
        : `<span class="cp-dot" style="background:${item.color ? escapeHtml(item.color) : "var(--chip-dot, #888)"}"></span>`;
    const sub = item.subtitle
      ? `<span class="cp-sub">${escapeHtml(item.subtitle)}</span>`
      : "";
    return `
      <div class="command-palette-item${active}" role="option" data-index="${idx}">
        ${dot}
        <span class="cp-title">${escapeHtml(item.title)}</span>
        ${sub}
      </div>`;
  }

  private async execute(item: PaletteItem): Promise<void> {
    this.close();
    try {
      await item.run();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("command palette action failed", err);
    }
    this.focusTerminal?.();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ui && npx vitest run src/workspaces/palette.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/workspaces/palette.ts ui/src/workspaces/palette.test.ts
git commit -m "feat(palette): centered CommandPalette overlay with sections + flat cursor"
```

---

## Task 5: Wire palette into the switcher; strip old popover

**Files:**
- Modify: `ui/src/workspaces/switcher.ts`
- Modify: `ui/src/workspaces/finder.ts` (delete `filterAndRankTabs`)
- Delete: `ui/src/workspaces/finder.test.ts`

- [ ] **Step 1: Trim `finder.ts` to just the `TabRow` type**

Replace the entire contents of `ui/src/workspaces/finder.ts` with:

```ts
/// Shared shape for a single tab row across workspaces. Consumed by
/// the workspace manager (producer) and the command palette (ranker).
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
```

- [ ] **Step 2: Delete the obsolete finder test**

```bash
git rm ui/src/workspaces/finder.test.ts
```

- [ ] **Step 3: Rework `switcher.ts` to own the palette and drop popover code**

In `ui/src/workspaces/switcher.ts`:

(a) Replace the imports block (lines 8–12) with:

```ts
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { TabManager } from "../tabs/manager";
import { attachTooltip } from "../tooltip/tooltip";
import { buildActions } from "./actions";
import { CommandPalette } from "./palette";
import { WorkspaceManager } from "./manager";
```

(b) Replace the field declarations + constructor (lines 48–58) with:

```ts
  private chip: HTMLButtonElement | null = null;
  private unsubscribe: (() => void) | null = null;
  private palette: CommandPalette;

  constructor(
    private readonly ws: WorkspaceManager,
    private readonly tabManager: TabManager,
  ) {
    const actions = buildActions(ws, tabManager, (id) => this.startInlineRename(id));
    this.palette = new CommandPalette(document.body, ws, tabManager, actions);
  }
```

(c) In `mount()` (lines 67–77) the chip click and onChange handler reference the popover. Replace the click handler body and the onChange callback so they no longer touch `renderPopover`:

```ts
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.palette.toggle();
    });
    host.appendChild(btn);
    this.chip = btn;
    this.renderChip();
    this.unsubscribe = this.ws.onChange(() => {
      this.renderChip();
    });
    return btn;
```

(d) Replace `destroy()` (lines 81–87) — drop `closePopover()`:

```ts
  destroy(): void {
    this.palette.close();
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.chip?.parentElement) this.chip.parentElement.removeChild(this.chip);
    this.chip = null;
  }
```

(e) Replace `togglePopover()` (lines 89–93) so the keybinding entrypoint delegates:

```ts
  /// Open/close the command palette. Bound to ⌘⇧P and ⌘⌥T in main.ts.
  togglePopover(): void {
    this.palette.toggle();
  }
```

(f) **Delete** these now-dead methods entirely: `openPopover` (138–217), `closePopover` (219–225), `renderPopover` (227–259), `renderList` (261–275), `renderWorkspaceRows` (277–293), `attachWorkspaceRowHandlers` (295–309), `renderResultRows` (311–336), `attachResultRowHandlers` (338–346), `scrollSelectedIntoView` (348–353), `runSelect` (355–367).

(g) **Keep:** `createAndSwitch`, `runSwitch`, `renderChip`, `startInlineRename`, `showRowMenu`, and the module-level `relTime`/`esc`/`COLOR_OPTIONS`.

(h) `startInlineRename` (line 372–375) references `this.popover`. Since the popover is gone, the inline rename can no longer target a popover row. Replace its first guard + lookup (lines 372–378) with a chip-anchored fallback that renames via a prompt-less inline input attached to the chip area is overkill — instead, for v1, route rename through the manager directly:

```ts
  /// Rename a workspace. The popover that previously hosted inline
  /// editing is gone; with no webview window.prompt, we cycle the name
  /// to "<name> (rename in ⌘⇧P → right-click)" — NO. Simpler: keep the
  /// row-menu inline rename which still operates on the context menu's
  /// own DOM. See showRowMenu.
  private startInlineRename(id: string): void {
    // The context menu (showRowMenu) builds its own element in
    // document.body; inline rename there still works because it
    // re-renders via ws.rename → onChange. For the palette "Rename
    // current workspace" action we fall back to a minimal inline input
    // appended to the chip.
    const ws = this.ws.list().find((w) => w.id === id);
    if (!ws || !this.chip) return;
    const input = document.createElement("input");
    input.type = "text";
    input.value = ws.name;
    input.className = "workspace-row-rename workspace-chip-rename";
    document.body.appendChild(input);
    const r = this.chip.getBoundingClientRect();
    input.style.position = "fixed";
    input.style.left = `${r.left}px`;
    input.style.top = `${Math.max(8, r.top - 32)}px`;
    input.style.zIndex = "1002";
    input.focus();
    input.select();
    const commit = (save: boolean): void => {
      const v = input.value.trim();
      if (save && v !== "" && v !== ws.name) this.ws.rename(id, v);
      input.remove();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); commit(true); }
      else if (e.key === "Escape") { e.preventDefault(); commit(false); }
    });
    input.addEventListener("blur", () => commit(true));
  }
```

> Note: `showRowMenu`'s "Rename…" item calls `startInlineRename(id)`; with the popover gone the same chip-anchored input is reused — acceptable for v1.

- [ ] **Step 4: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors. If `relTime`/`esc` become unused after deletions, remove them too and re-run.

- [ ] **Step 5: Run the workspace test suite**

Run: `cd ui && npx vitest run src/workspaces/`
Expected: PASS (palette-items, actions, palette, manager). No `finder.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/workspaces/switcher.ts ui/src/workspaces/finder.ts
git commit -m "refactor(switcher): delegate to CommandPalette, strip popover + tier finder"
```

---

## Task 6: Keybindings in main.ts

**Files:**
- Modify: `ui/src/main.ts:1602-1628`

- [ ] **Step 1: Confirm current wiring**

Run: `cd ui && grep -n "togglePopover\|createAndSwitch" src/main.ts`
Expected: shows ⌘⇧P and ⌘⌥T → `switcher.togglePopover()`, ⌘⌥N → `switcher.createAndSwitch()`.

- [ ] **Step 2: Verify no change needed / adjust comment**

`togglePopover()` now delegates to the palette (Task 5e), so ⌘⇧P and ⌘⌥T already open the palette. No functional edit required. If a comment in `main.ts` says "toggle workspace picker", update it to "open command palette" for clarity. Leave ⌘⌥N as-is.

- [ ] **Step 3: Commit (only if a comment was edited)**

```bash
git add ui/src/main.ts
git commit -m "chore(main): clarify palette keybinding comments"
```

---

## Task 7: Styles

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Add the palette styles**

Append a `.command-palette-*` block modeled on `.recall-palette-*`. Find the existing `.recall-palette-overlay` rule for the exact backdrop/centering values and mirror them; then add:

```css
.command-palette-overlay {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 12vh;
  background: rgba(0, 0, 0, 0.38);
}
.command-palette-card {
  width: min(640px, 90vw);
  max-height: 64vh;
  display: flex;
  flex-direction: column;
  background: rgba(20, 22, 26, 0.98);
  border: 1px solid rgba(var(--ink-rgb), 0.12);
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
.command-palette-input-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid rgba(var(--ink-rgb), 0.08);
}
.command-palette-label {
  font-size: 11px;
  opacity: 0.6;
  border: 1px solid rgba(var(--ink-rgb), 0.18);
  border-radius: 5px;
  padding: 1px 5px;
}
.command-palette-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: var(--text, #d6d8db);
  font-size: 14px;
}
.command-palette-list {
  overflow-y: auto;
  padding: 4px;
}
.command-palette-section-header {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.45;
  padding: 8px 8px 4px;
}
.command-palette-item {
  display: grid;
  grid-template-columns: 14px 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
}
.command-palette-item.active,
.command-palette-item:hover {
  background: rgba(var(--ink-rgb), 0.08);
}
.command-palette-item .cp-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
}
.command-palette-item .cp-icon {
  font-size: 12px;
  opacity: 0.7;
  text-align: center;
}
.command-palette-item .cp-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.command-palette-item .cp-sub {
  font-size: 11px;
  opacity: 0.55;
}
.command-palette-empty {
  padding: 14px;
  text-align: center;
  opacity: 0.5;
}
.workspace-chip-rename {
  min-width: 160px;
}
```

- [ ] **Step 2: Remove dead popover styles**

Delete the now-unused rule blocks (the palette supersedes them): `.workspace-popover`, `.workspace-popover-list`, `.workspace-popover-searchwrap`, `.workspace-search`, `.workspace-search:focus`, `.workspace-popover-footer`, `.workspace-new-btn`, `.workspace-popover-kbd`, `.workspace-row`, `.workspace-row-dot`, `.workspace-row-name`, `.workspace-row-meta`, `.workspace-row-active`, `.workspace-result-row`, `.workspace-result-row-selected`, `.workspace-result-dot`, `.workspace-result-title`, `.workspace-result-meta`, `.workspace-empty`.

**Keep:** `.workspace-chip*`, `.workspace-rowmenu*`, `.workspace-row-rename`, and the light-theme overrides for chip/rowmenu.

- [ ] **Step 3: True-Dark check**

Confirm `.command-palette-item.active` uses a neutral `--ink-rgb` alpha (it does above), not an accent tint — per the True-Dark neutral-lift convention.

- [ ] **Step 4: Verify build**

Run: `cd ui && npx tsc --noEmit && npx vitest run src/workspaces/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/styles.css
git commit -m "style(palette): command-palette overlay styles; drop dead popover CSS"
```

---

## Task 8: Full verification

- [ ] **Step 1: Whole UI test + typecheck**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors.

- [ ] **Step 2: Manual smoke (respawn the app)**

Use the `respawn` skill, then verify in the running app:
- ⌘⌥T opens a centered palette; ⌘⇧P too.
- Empty palette lists workspaces (recent first) + current-workspace tabs.
- Typing a workspace/tab/action name filters under the right section headers.
- ↑/↓ traverse across sections; Enter on a tab switches workspace + activates the tab; Enter on "New workspace" creates one.
- Esc clears, second Esc closes; click-outside closes.
- Tabbar chip still opens the palette; right-click chip row menu (color/rename/delete) still works.

- [ ] **Step 3: Commit any fixes; finalize**

```bash
git add -A && git commit -m "test(palette): full verification pass"
```

---

## Self-Review Notes

- **Spec coverage:** centered modal (T4/T7), three providers (T1/T3), fuzzy via `fuzzyScore` (T1), blended-sectioned with caps (T1), empty-query frecency + actions hidden (T1), flat cursor skipping headers (T4), two-stage Esc (T4), keep chip+context-menu (T5), keybindings (T6), `<mark>` highlight — **deferred**: highlight rendering was dropped from the impl for v1 simplicity (not load-bearing; titles still filter correctly). If the user wants match highlighting, add a follow-up that wraps the matched subsequence in the item HTML. All other spec points covered.
- **Type consistency:** `buildSections`/`flattenSections`/`PaletteItem`/`PaletteAction`/`BuildCtx` names match across T1, T3, T4. `closeActiveTab` defined T2, consumed T3. `switchWorkspace`/`activateTab` ctx callbacks match between T1 impl and T4 caller.
- **Known v1 tradeoff:** inline rename is now chip-anchored (T5h) rather than popover-row-anchored, since the popover is removed.
