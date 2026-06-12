# Drafts Relocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate Drafts from a full-page panel launched by a sidebar nav button into a per-group `drafts` tab inside `ProjectNotesPanel`, with the existing wizard trimmed to creation-only and `.md` review handled by the existing markdown editor.

**Architecture:** New `DraftsTab` component mounted by `ProjectNotesPanel` (4th tab). It calls `draftsApi.list(repoRoot)` filtered to non-published. Clicking an item routes through `manager.openFileAtLine(absolutePath)`. "+ New spec" opens the trimmed `DraftsPanel` (now wizard-only) with the active group's `rootDir` injected. The sidebar "Drafts" button is removed; `⌘⇧D` is re-targeted to open ProjectNotesPanel on the drafts tab. Backend `save_draft` emits a `draft:saved` Tauri event consumed by the frontend to refresh + toast.

**Tech Stack:** TypeScript, vanilla DOM (no framework), Vitest, Tauri 2 (Rust backend events).

**Spec:** `docs/superpowers/specs/2026-05-16-drafts-relocation-design.md`

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `ui/src/project-notes/drafts-tab.ts` | **Create** | Lists drafts for `group.rootDir`, "+ New" button, item-click → open `.md` |
| `ui/src/project-notes/drafts-tab.test.ts` | **Create** | Unit tests for DraftsTab |
| `ui/src/project-notes/panel.ts` | **Modify** | Add `"drafts"` to `PanelTab` union; render `DraftsTab` in `updateTabUI()`; accept `groupRootDir` + `onOpenFile` + `onOpenWizard` in opts |
| `ui/src/project-notes/panel.test.ts` | **Modify** | New cases: drafts tab renders; tab persistence still works |
| `ui/src/tabs/manager.ts` | **Modify** | (a) Remove `navDrafts` button (lines 1853-1864); (b) extend `activeGroup()` return type to include `rootDir`; (c) add `activeGroupRootDir()` helper |
| `ui/src/drafts/panel.ts` | **Modify** | Trim to wizard-only: remove list view and "Published specs" tab; accept `{ repoRoot }` in `open()`; emit `draft:saved` event on wizard save |
| `ui/src/main.ts` | **Modify** | Pass `groupRootDir`, `onOpenFile`, `onOpenWizard` into `ProjectNotesPanel`; re-wire `⌘⇧D`; remove old `drafts:toggle` listener; add `draft:saved` Tauri event listener for toast |
| `ui/src/shortcuts/registry.ts` | **Modify** | Update line 49 description for `⌘⇧D` |
| `crates/app/src/drafts.rs` | **Modify** | `save_draft` accepts `AppHandle`, emits `draft:saved` Tauri event after a successful write |

---

## Task 1: Extend `TabManager.activeGroup()` to include `rootDir`

**Files:**
- Modify: `ui/src/tabs/manager.ts:566-571`

- [ ] **Step 1: Update the return type and value of `activeGroup()`**

Replace lines 566-571 with:

```ts
activeGroup(): { id: string; name: string; color: string | null; rootDir: string | null } | null {
  const tab = this.tabs.find((t) => t.id === this.activeId);
  if (!tab?.groupId) return null;
  const g = this.groups.get(tab.groupId);
  return g
    ? { id: g.id, name: g.name, color: g.color ?? null, rootDir: g.rootDir ?? null }
    : null;
}
```

- [ ] **Step 2: Verify TS compiles**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors in `tabs/manager.ts`. (Pre-existing `settings/panel.ts` errors are fine.)

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(tabs): include rootDir in activeGroup() return"
```

---

## Task 2: Add `DraftsTab` skeleton (TDD)

**Files:**
- Create: `ui/src/project-notes/drafts-tab.ts`
- Create: `ui/src/project-notes/drafts-tab.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `ui/src/project-notes/drafts-tab.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DraftsTab } from "./drafts-tab";

vi.mock("../drafts/api", () => ({
  draftsApi: {
    list: vi.fn(),
  },
}));

import { draftsApi } from "../drafts/api";

describe("DraftsTab", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
    vi.clearAllMocks();
  });

  it("renders empty state when group has no rootDir", async () => {
    new DraftsTab({
      groupId: "g1",
      groupRootDir: null,
      onOpenFile: () => {},
      onOpenWizard: () => {},
    }).mount(host);
    await Promise.resolve();
    expect(host.textContent).toContain("Set a root dir");
    expect(draftsApi.list).not.toHaveBeenCalled();
  });

  it("lists drafts returned by the API", async () => {
    (draftsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { slug: "foo", title: "Foo spec", updated_at: "2026-05-16T12:00:00Z" },
      { slug: "bar", title: "Bar spec", updated_at: "2026-05-15T12:00:00Z" },
    ]);
    new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo",
      onOpenFile: () => {},
      onOpenWizard: () => {},
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    const items = host.querySelectorAll(".pn-drafts-item");
    expect(items.length).toBe(2);
    expect(items[0].textContent).toContain("Foo spec");
  });

  it("calls onOpenFile with absolute spec path when an item is clicked", async () => {
    (draftsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([
      { slug: "foo", title: "Foo spec", updated_at: "2026-05-16T12:00:00Z" },
    ]);
    const opened: string[] = [];
    new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo",
      onOpenFile: (path) => opened.push(path),
      onOpenWizard: () => {},
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    (host.querySelector(".pn-drafts-item") as HTMLElement).click();
    expect(opened).toEqual(["/repo/docs/specs/foo.md"]);
  });

  it("calls onOpenWizard when '+ New spec' is clicked", async () => {
    (draftsApi.list as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    let openedRoot: string | null = null;
    new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo",
      onOpenFile: () => {},
      onOpenWizard: (root) => { openedRoot = root; },
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    (host.querySelector(".pn-drafts-new") as HTMLElement).click();
    expect(openedRoot).toBe("/repo");
  });

  it("re-renders when refresh() is called", async () => {
    const mock = draftsApi.list as ReturnType<typeof vi.fn>;
    mock.mockResolvedValueOnce([
      { slug: "foo", title: "Foo", updated_at: "2026-05-16T12:00:00Z" },
    ]);
    const tab = new DraftsTab({
      groupId: "g1",
      groupRootDir: "/repo",
      onOpenFile: () => {},
      onOpenWizard: () => {},
    }).mount(host);
    await new Promise((r) => setTimeout(r, 0));
    expect(host.querySelectorAll(".pn-drafts-item").length).toBe(1);

    mock.mockResolvedValueOnce([
      { slug: "foo", title: "Foo", updated_at: "2026-05-16T12:00:00Z" },
      { slug: "bar", title: "Bar", updated_at: "2026-05-16T13:00:00Z" },
    ]);
    await tab.refresh();
    expect(host.querySelectorAll(".pn-drafts-item").length).toBe(2);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ui && pnpm vitest run src/project-notes/drafts-tab.test.ts`
Expected: FAIL — cannot resolve `./drafts-tab`.

- [ ] **Step 3: Implement `DraftsTab`**

Create `ui/src/project-notes/drafts-tab.ts`:

```ts
import { draftsApi, type DraftSummary } from "../drafts/api";

export interface DraftsTabOpts {
  groupId: string;
  groupRootDir: string | null;
  onOpenFile: (absolutePath: string) => void;
  onOpenWizard: (repoRoot: string) => void;
}

export class DraftsTab {
  private container: HTMLElement;
  private listEl: HTMLElement;
  private newBtn: HTMLButtonElement;

  constructor(private opts: DraftsTabOpts) {
    this.container = document.createElement("div");
    this.container.className = "pn-drafts-tab";

    this.newBtn = document.createElement("button");
    this.newBtn.type = "button";
    this.newBtn.className = "pn-drafts-new";
    this.newBtn.textContent = "+ New spec (AI-assisted)";
    this.newBtn.addEventListener("click", () => {
      if (this.opts.groupRootDir) this.opts.onOpenWizard(this.opts.groupRootDir);
    });

    this.listEl = document.createElement("div");
    this.listEl.className = "pn-drafts-list";

    this.container.appendChild(this.newBtn);
    this.container.appendChild(this.listEl);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.refresh();
    return this;
  }

  async refresh(): Promise<void> {
    const root = this.opts.groupRootDir;
    if (!root) {
      this.newBtn.disabled = true;
      this.listEl.innerHTML =
        `<div class="pn-empty pn-empty-inline">
           <div class="pn-empty-title">No root dir</div>
           <div class="pn-empty-hint">Set a root dir for this group to track drafts.</div>
         </div>`;
      return;
    }
    this.newBtn.disabled = false;
    try {
      const drafts = await draftsApi.list(root);
      this.renderList(root, drafts);
    } catch (err) {
      console.error("drafts list failed", err);
      this.listEl.innerHTML =
        `<div class="pn-empty pn-empty-inline">
           <div class="pn-empty-title">Failed to load drafts</div>
           <div class="pn-empty-hint">${(err as Error).message ?? "Unknown error"}</div>
         </div>`;
    }
  }

  private renderList(root: string, drafts: DraftSummary[]): void {
    if (drafts.length === 0) {
      this.listEl.innerHTML =
        `<div class="pn-empty pn-empty-inline">
           <div class="pn-empty-title">No drafts</div>
           <div class="pn-empty-hint">Agents will write drafts here, or start one with the button above.</div>
         </div>`;
      return;
    }
    this.listEl.innerHTML = "";
    for (const d of drafts) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "pn-drafts-item";
      item.innerHTML =
        `<span class="pn-drafts-title"></span>
         <span class="pn-drafts-meta"></span>`;
      (item.querySelector(".pn-drafts-title") as HTMLElement).textContent = d.title;
      (item.querySelector(".pn-drafts-meta") as HTMLElement).textContent =
        `${d.slug} · ${relTime(d.updated_at)}`;
      const absolutePath = `${root}/docs/specs/${d.slug}.md`;
      item.addEventListener("click", () => this.opts.onOpenFile(absolutePath));
      this.listEl.appendChild(item);
    }
  }
}

function relTime(iso: string): string {
  const dt = Date.now() - new Date(iso).getTime();
  if (dt < 60_000) return "just now";
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm vitest run src/project-notes/drafts-tab.test.ts`
Expected: 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/project-notes/drafts-tab.ts ui/src/project-notes/drafts-tab.test.ts
git commit -m "feat(project-notes): DraftsTab lists per-group drafts"
```

---

## Task 3: Integrate `DraftsTab` into `ProjectNotesPanel`

**Files:**
- Modify: `ui/src/project-notes/panel.ts`
- Modify: `ui/src/project-notes/panel.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `ui/src/project-notes/panel.test.ts` (inside the same `describe` block):

```ts
vi.mock("./drafts-tab", () => ({
  DraftsTab: class {
    mount(parent: HTMLElement) {
      const el = document.createElement("div");
      el.className = "pn-drafts-tab";
      parent.appendChild(el);
      return this;
    }
  },
}));

it("renders the drafts tab when selected", () => {
  const p = new ProjectNotesPanel({
    groupId: "g1",
    groupLabel: "G1",
    groupRootDir: "/repo",
    onOpenFile: () => {},
    onOpenWizard: () => {},
  }).mount(host);
  p.switchTab("drafts");
  expect(host.querySelector(".pn-drafts-tab")).not.toBeNull();
  const buttons = host.querySelectorAll(".pn-tabs button");
  expect(buttons.length).toBe(4);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ui && pnpm vitest run src/project-notes/panel.test.ts`
Expected: FAIL — `PanelTab` doesn't include `"drafts"`, four buttons not rendered.

- [ ] **Step 3: Update `panel.ts`**

In `ui/src/project-notes/panel.ts`:

Replace line 6:
```ts
export type PanelTab = "commands" | "notes" | "docs" | "drafts";
```

Replace lines 8-15 (the `PanelOpts` interface):
```ts
export interface PanelOpts {
  groupId: string;
  groupLabel: string;
  groupColor?: string | null;
  groupRootDir?: string | null;
  defaultTab?: PanelTab;
  onClose?: () => void;
  onOpenFile?: (absolutePath: string) => void;
  onOpenWizard?: (repoRoot: string) => void;
}
```

Replace line 22:
```ts
    if (raw === "commands" || raw === "notes" || raw === "docs" || raw === "drafts") return raw;
```

Replace line 70 (the tab-button loop):
```ts
    for (const t of ["commands", "notes", "docs", "drafts"] as PanelTab[]) {
```

Add `import { DraftsTab } from "./drafts-tab";` at the top alongside the other tab imports.

Replace the `if/else` chain inside `updateTabUI` (lines 121-127) with:

```ts
    if (this.currentTab === "commands") {
      new CommandsTab({ groupId: this.opts.groupId }).mount(this.body);
    } else if (this.currentTab === "notes") {
      new NotesTab({ groupId: this.opts.groupId }).mount(this.body);
    } else if (this.currentTab === "docs") {
      void new DocsTab({ groupId: this.opts.groupId }).mount(this.body);
    } else {
      new DraftsTab({
        groupId: this.opts.groupId,
        groupRootDir: this.opts.groupRootDir ?? null,
        onOpenFile: (p) => this.opts.onOpenFile?.(p),
        onOpenWizard: (r) => this.opts.onOpenWizard?.(r),
      }).mount(this.body);
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ui && pnpm vitest run src/project-notes/panel.test.ts`
Expected: all tests PASS (existing 5 + new 1 = 6).

- [ ] **Step 5: Commit**

```bash
git add ui/src/project-notes/panel.ts ui/src/project-notes/panel.test.ts
git commit -m "feat(project-notes): add drafts tab to ProjectNotesPanel"
```

---

## Task 4: Style the drafts tab

**Files:**
- Modify: `ui/src/project-notes/styles.css`

- [ ] **Step 1: Append styles**

Add at the end of `ui/src/project-notes/styles.css`:

```css
.pn-drafts-tab {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  height: 100%;
  overflow-y: auto;
}

.pn-drafts-new {
  background: transparent;
  border: 1px dashed var(--border);
  color: var(--fg-muted);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.pn-drafts-new:hover:not(:disabled) {
  color: var(--fg);
  border-color: var(--fg-muted);
}

.pn-drafts-new:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.pn-drafts-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.pn-drafts-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  text-align: left;
  color: var(--fg);
}

.pn-drafts-item:hover {
  background: var(--bg-hover);
  border-color: var(--border);
}

.pn-drafts-title {
  font-size: 13px;
  font-weight: 500;
}

.pn-drafts-meta {
  font-size: 11px;
  color: var(--fg-muted);
}
```

- [ ] **Step 2: Verify the build picks the CSS up**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/project-notes/styles.css
git commit -m "style(project-notes): drafts tab visuals"
```

---

## Task 5: Wire `ProjectNotesPanel` into main.ts with new opts

**Files:**
- Modify: `ui/src/main.ts:414-430`

- [ ] **Step 1: Update `openProjectNotes` signature and callers**

Replace lines 414-430 with:

```ts
  let activeProjectNotesPanel: ProjectNotesPanel | null = null;

  function openProjectNotes(
    groupId: string,
    groupLabel: string,
    groupColor: string | null,
    opts?: { defaultTab?: "commands" | "notes" | "docs" | "drafts" },
  ): void {
    if (activeProjectNotesPanel) activeProjectNotesPanel.close();
    const g = manager.activeGroup();
    const groupRootDir = g?.id === groupId ? g.rootDir : null;
    activeProjectNotesPanel = new ProjectNotesPanel({
      groupId,
      groupLabel,
      groupColor,
      groupRootDir,
      defaultTab: opts?.defaultTab,
      onClose: () => { activeProjectNotesPanel = null; },
      onOpenFile: (absolutePath) => {
        manager.openFileAtLine(absolutePath);
        activeProjectNotesPanel?.close();
      },
      onOpenWizard: (repoRoot) => {
        window.dispatchEvent(new CustomEvent("drafts:open-wizard", { detail: { repoRoot } }));
      },
    }).mount(document.body);
  }
```

Note: `manager.activeGroup()` may not be the group whose chip was clicked. We accept the inconsistency for now — if the user opened ProjectNotes for a non-active group, `groupRootDir` falls back to `null` and the empty state renders. A future task can teach `TabManager` a `groupRootDirFor(id)` accessor; out of scope.

- [ ] **Step 2: Verify TS compiles**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(main): pass rootDir + open handlers into ProjectNotesPanel"
```

---

## Task 6: Add `groupRootDirFor(id)` to `TabManager`

This removes the limitation flagged in Task 5 so any group's panel gets the right rootDir.

**Files:**
- Modify: `ui/src/tabs/manager.ts`
- Modify: `ui/src/main.ts`

- [ ] **Step 1: Add the helper to TabManager**

Insert after `activeGroup()` (after line 571 in `ui/src/tabs/manager.ts`):

```ts
  /// Lookup the `rootDir` of a group by id. Returns null if the group
  /// doesn't exist or has no root dir set.
  groupRootDirFor(groupId: string): string | null {
    return this.groups.get(groupId)?.rootDir ?? null;
  }
```

- [ ] **Step 2: Use it in `openProjectNotes`**

In `ui/src/main.ts`, replace these lines from Task 5:

```ts
    const g = manager.activeGroup();
    const groupRootDir = g?.id === groupId ? g.rootDir : null;
```

with:

```ts
    const groupRootDir = manager.groupRootDirFor(groupId);
```

- [ ] **Step 3: Verify TS compiles**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/main.ts
git commit -m "feat(tabs): groupRootDirFor() accessor"
```

---

## Task 7: Trim `DraftsPanel` to wizard-only and emit `draft:saved` on save

**Files:**
- Modify: `ui/src/drafts/panel.ts`

- [ ] **Step 1: Read the current panel structure to identify what to remove**

Run: `cd ui && wc -l src/drafts/panel.ts`
Expected: ~237 lines.

Inspect `ui/src/drafts/panel.ts`. The `view: "list" | "wizard"` and `tab: "drafts" | "published"` state will be removed; `open()` will always boot into the wizard mode.

- [ ] **Step 2: Rewrite `open()` to accept `{ repoRoot }` and skip list view**

In `ui/src/drafts/panel.ts`, change:

```ts
  open(): void {
    this.isOpenState = true;
    this.pageHost.hidden = false;
    this.workspace.hidden = true;
    this.view = "list";
    this.currentSlug = null;
    void this.render();
  }
```

to:

```ts
  open(opts?: { repoRoot?: string; slug?: string | null }): void {
    this.isOpenState = true;
    this.pageHost.hidden = false;
    this.workspace.hidden = true;
    if (opts?.repoRoot) this.getRepoRoot = () => opts.repoRoot!;
    this.openWizard(opts?.slug ?? null);
  }
```

- [ ] **Step 3: Emit `draft:saved` after wizard save**

Find where the wizard's save callback resolves (search for `this.wizard` callbacks or `draftsApi.save` calls inside `openWizard`/`render`). Wrap the post-save handler to dispatch:

```ts
window.dispatchEvent(new CustomEvent("draft:saved", {
  detail: { repoRoot: this.getRepoRoot(), slug: savedSlug, title: savedTitle },
}));
```

(Exact insertion point: after a successful `draftsApi.save(...)` call inside `DraftsPanel`. If the save happens entirely inside `DraftWizard`, expose a `wizard.onSaved` callback and wire it through `openWizard`.)

- [ ] **Step 4: Remove the list view and "Published specs" tab rendering**

In `render()` (and any helper it calls), drop all branches that depend on `this.view === "list"` or `this.tab === "drafts" | "published"`. Keep only the wizard render path.

If `render()` becomes trivial, inline it into `openWizard`.

- [ ] **Step 5: Run tests to confirm wizard still works**

Run: `cd ui && pnpm vitest run src/drafts/wizard.test.ts`
Expected: existing wizard tests PASS.

- [ ] **Step 6: Run typecheck**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/drafts/panel.ts
git commit -m "refactor(drafts): trim DraftsPanel to wizard-only"
```

---

## Task 8: Wire `drafts:open-wizard` and update `⌘⇧D`

**Files:**
- Modify: `ui/src/main.ts:696-698` and `:1034` (and surrounding shortcut block)

- [ ] **Step 1: Replace the `drafts:toggle` listener with `drafts:open-wizard`**

In `ui/src/main.ts`, replace lines 696-698:

```ts
  window.addEventListener("drafts:toggle", () => draftsPanel.toggle());
  window.addEventListener("drafts:open", (e: Event) => {
    ...
```

with:

```ts
  window.addEventListener("drafts:open-wizard", (e: Event) => {
    const detail = (e as CustomEvent<{ repoRoot?: string; slug?: string | null }>).detail;
    draftsPanel.open({ repoRoot: detail?.repoRoot, slug: detail?.slug ?? null });
  });
```

(Keep the existing `drafts:open` listener if other code paths use it — search first.)

Run: `grep -rn 'drafts:open\b\|drafts:toggle' ui/src --include="*.ts"`
Expected: only main.ts references remain after this change.

- [ ] **Step 2: Re-target `⌘⇧D` to open ProjectNotesPanel on drafts tab**

Locate the existing `⌘⇧D` handler near line 1034. Replace it with:

```ts
    // ⌘⇧D → open Project Notes panel for the active group on drafts tab.
    if (e.metaKey && e.shiftKey && !e.altKey && (e.key === "d" || e.key === "D")) {
      const g = manager.activeGroup();
      if (g) {
        e.preventDefault();
        openProjectNotes(g.id, g.name, g.color ?? null, { defaultTab: "drafts" });
      }
    }
```

(Remove any existing exclusivity logic with settings/docs — opening ProjectNotesPanel is independent.)

- [ ] **Step 3: Update shortcut registry**

In `ui/src/shortcuts/registry.ts:49`, replace the existing entry with:

```ts
  { category: "Operator & AI", keys: ["⌘", "⇧", "D"], label: "Drafts tab", description: "Open Project Notes for the active group on the Drafts tab." },
```

- [ ] **Step 4: Verify TS compiles**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/main.ts ui/src/shortcuts/registry.ts
git commit -m "feat(shortcuts): retarget ⌘⇧D to ProjectNotesPanel drafts tab"
```

---

## Task 9: Remove the sidebar "Drafts" nav button

**Files:**
- Modify: `ui/src/tabs/manager.ts:1853-1864`

- [ ] **Step 1: Delete the button creation and append**

In `ui/src/tabs/manager.ts`, delete lines 1853-1864 (the `navDrafts` declaration and the `navEl.appendChild(navDrafts);` line).

After deletion, the nav-strip block should append only `navBlocks` and `navStructure`:

```ts
    navEl.appendChild(navBlocks);
    navEl.appendChild(navStructure);
    blocksHost.insertBefore(navEl, blocksHost.firstChild);
```

- [ ] **Step 2: Verify TS compiles**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(sidebar): remove Drafts nav button (relocated to ProjectNotesPanel)"
```

---

## Task 10: Backend emits `draft:saved` Tauri event

**Files:**
- Modify: `crates/app/src/drafts.rs`

- [ ] **Step 1: Add the AppHandle parameter and emit**

In `crates/app/src/drafts.rs`, replace lines 810-823:

```rust
#[tauri::command]
pub async fn save_draft(
    app: tauri::AppHandle,
    repo_root: String,
    slug: String,
    title: String,
    body: String,
) -> Result<DraftDocumentDto, String> {
    use tauri::Emitter;
    let path = PathBuf::from(repo_root.clone());
    let doc = tokio::task::spawn_blocking(move || save_draft_sync(&path, &slug, &title, &body))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;
    let payload = serde_json::json!({
        "repoRoot": repo_root,
        "slug": doc.frontmatter.slug,
        "title": doc.frontmatter.title,
    });
    let _ = app.emit("draft:saved", payload);
    Ok(DraftDocumentDto::from(doc))
}
```

- [ ] **Step 2: Build the backend**

Run: `cargo build -p covenant-app`
Expected: build succeeds. Tauri injects `AppHandle` automatically; no registration change needed.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/drafts.rs
git commit -m "feat(drafts): emit draft:saved Tauri event on save"
```

---

## Task 11: Frontend listens for `draft:saved` and refreshes + toasts

**Files:**
- Modify: `ui/src/main.ts` (near other Tauri event listeners)

- [ ] **Step 1: Locate the existing Tauri event setup**

Run: `grep -n "listen.*draft\|listen.*spec:candidate\|@tauri-apps/api/event" ui/src/main.ts`
Use that pattern. If `import { listen } from "@tauri-apps/api/event";` isn't already imported, add it.

- [ ] **Step 2: Add the listener**

In `ui/src/main.ts`, after `openProjectNotes` is defined and `manager` is constructed, add:

```ts
  void listen<{ repoRoot: string; slug: string; title: string }>("draft:saved", (e) => {
    const { repoRoot, slug, title } = e.payload;
    // Refresh the open panel if it matches this repo.
    if (activeProjectNotesPanel) {
      const openGroupId = (activeProjectNotesPanel as unknown as { groupId: string }).groupId;
      const openRoot = manager.groupRootDirFor(openGroupId);
      if (openRoot === repoRoot) {
        // Re-open on drafts tab to force the list to refetch.
        const g = manager.activeGroup();
        if (g && g.id === openGroupId) {
          openProjectNotes(g.id, g.name, g.color ?? null, { defaultTab: "drafts" });
        }
      }
    }
    pushInfoToast({
      message: `Draft saved: ${title}`,
      action: {
        label: "Review",
        onClick: () => {
          const absolutePath = `${repoRoot}/docs/specs/${slug}.md`;
          manager.openFileAtLine(absolutePath);
        },
      },
    });
  });
```

If `pushInfoToast` doesn't support an `action` field, use the existing notification API the file already imports (search `pushInfoToast` and `pushToast` in the file). Fall back to a plain-message toast if the existing toast API has no CTA — open question 3 in the spec.

- [ ] **Step 3: Verify TS compiles**

Run: `cd ui && pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(drafts): toast + refresh on draft:saved event"
```

---

## Task 12: Manual integration test

**Files:** none (testing only)

- [ ] **Step 1: Launch dev**

Run: `pnpm tauri dev`
Wait for the window.

- [ ] **Step 2: Verify sidebar no longer has Drafts button**

Open the right sidebar. The nav strip shows only `[Blocks] [Files]`.
Pass: only two buttons.

- [ ] **Step 3: Verify `⌘⇧D` opens ProjectNotesPanel on drafts tab**

With a group active that has a `rootDir`, press `⌘⇧D`.
Pass: ProjectNotesPanel opens with the Drafts tab active.

- [ ] **Step 4: Verify draft list renders**

If the repo has drafts in `docs/specs/`, they appear in the list.
Pass: items match files on disk; "+ New spec (AI-assisted)" button visible at top.

- [ ] **Step 5: Verify click → editor**

Click a draft item.
Pass: ProjectNotesPanel closes, the `.md` opens in the editor pane.

- [ ] **Step 6: Verify "+ New spec" opens the wizard**

Reopen the panel, click "+ New spec (AI-assisted)".
Pass: DraftsPanel (wizard) opens directly in wizard mode with the group's rootDir; no list view visible.

- [ ] **Step 7: Verify wizard save triggers toast + panel refresh**

Complete a minimal wizard save.
Pass: toast appears with "Draft saved: …"; if ProjectNotesPanel is reopened, the new draft appears in the list.

- [ ] **Step 8: Verify no-rootDir group shows empty state**

Switch to or create a group without a root dir, open `⌘⇧D`.
Pass: "Set a root dir for this group to track drafts" message; "+ New spec" button disabled.

- [ ] **Step 9: Commit any cleanups, then merge prep**

If any UI bugs surfaced during manual testing, fix them with a follow-up commit. Otherwise:

```bash
git log --oneline -15
```

Expected: 10–11 commits implementing Tasks 1–11.

---

## Self-Review Notes

- Spec section "Markdown editor renders a `spec draft` chip" is **deferred** — Task 12 verifies the .md opens; the chip is a polish item the spec flagged as an open question. Not implemented in this plan; capture as follow-up if desired.
- Spec section "rename DraftsPanel to SpecAuthorPage" is **not implemented** — Task 7 trims the class but leaves the name. Renaming touches imports across `main.ts` and is mechanical; defer unless it bothers you.
- All other spec sections (sidebar button removal, ⌘⇧D retarget, per-group filtering, ` draft:saved` event, error handling for null rootDir, manual test coverage) map to specific tasks.
