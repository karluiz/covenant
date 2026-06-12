# TASKER Kanban Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fullscreen **Board** (kanban) view to the TASKER panel whose columns are task statuses, scoped to one project, with drag-to-change-status and per-column inline create.

**Architecture:** `TaskerPanel` (`ui/src/tasker/panel.ts`) gains a `viewMode` (`"list" | "board"`) and owns the List/Board toggle, the fullscreen body class, the project switcher, and the selected-task details dock (reusing its existing `renderTaskDetails` + `bindDetailsEvents`). A new self-contained `BoardView` (`ui/src/tasker/board.ts`) renders the three status columns and their cards, owns pointer-event drag-and-drop between columns, and inline add. All persistence stays in the existing `TaskStorage` (localStorage); **no type changes, no backend, no migration**. Fullscreen mirrors Project Notes' `.pn-fullscreen` via a new `body.tasker-board #tasker-panel` rule.

**Tech Stack:** TypeScript (strict), Vite, Vitest + jsdom, plain DOM (no framework), CSS with Covenant design tokens.

---

## Working Directory

All paths are relative to the worktree root:

```
/Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/tasker-kanban
```

`cd` there first. Run tests from that root.

- Focused test run: `npx vitest run ui/src/tasker/board.test.ts`
- Panel test run: `npx vitest run ui/src/tasker/panel.test.ts`
- Typecheck: `npx tsc --noEmit -p ui/tsconfig.json` (if that tsconfig path errors, use the path referenced by `ui/package.json`'s build script)

## Key Facts From the Codebase (do not re-derive)

- `TaskStorage` signatures (verbatim):
  - `getProjects(includeArchived = false): Project[]`
  - `getProject(id: string): Project | null`
  - `getTask(projectId: string, taskId: string): Task | null`
  - `createTask(projectId: string, title: string, options?: Partial<Task>): Task | null`
  - `updateTask(projectId: string, taskId: string, updates: Partial<Task>): Task | null`
- `TaskStatus = "pending" | "active" | "done" | "cancelled"`; `TaskPriority = "low" | "normal" | "high" | "urgent"`.
- `Task` has `id, title, description?, status, priority, dueDate?, completedAt?, createdAt, updatedAt, projectId?, tags?`.
- **`completedAt` is NOT automatic.** The existing status handler sets `completedAt: status === "done" ? Date.now() : undefined`. Mirror that everywhere status changes.
- `TaskerPanel` constructor is `constructor(host: HTMLElement)`; it creates its own `private storage: TaskStorage` and auto-creates an "Inbox" project when none exist (so there is always ≥1 project).
- `render()` **rebuilds the entire `host.innerHTML`** and re-runs `setupEventListeners()` on every change. Every handler mutates storage then calls `this.render()`.
- Existing persistence helper pattern: `localStorage.getItem/setItem(KEY)`, wrapped in try/catch. Existing key constant style: `const EXPANDED_PROJECTS_KEY = "covenant.tasker.expanded-projects";`.
- Existing header markup (in `render()`):
  ```html
  <div class="tasker-header">
    <h2 class="tasker-title">Tasker</h2>
    <div class="tasker-header-actions">
      <button class="tasker-btn-icon tasker-btn-new-project" type="button" title="New project">...</button>
    </div>
  </div>
  ```
- Existing detail reuse points: `private renderTaskDetails(projectId, task): string` and `private bindDetailsEvents(): void` (queries `this.host.querySelectorAll(".tasker-edit")`). The details card is `.tasker-edit.tasker-sheet` with `data-project-id` / `data-task-id`.
- Project Notes fullscreen values (to mirror):
  ```css
  .pn-panel.pn-fullscreen {
    position: fixed; inset: 38px 0 0 0; width: 100vw; height: auto;
    max-width: none; border-left: none; border-top: none; z-index: 80;
    bottom: calc(var(--statusbar-h) + 1px);
  }
  body.tabbar-left .pn-panel.pn-fullscreen { top: 38px; }
  ```
- Existing TASKER grid rules live near `body.sidebar-view-tasker ... #layout` in `ui/src/styles.css` (~line 15170). Add the new fullscreen block right after them.
- Pointer-drag reference pattern (`ui/src/tabs/manager.ts`): `pointerdown` → 5px threshold (`dx*dx+dy*dy < 5*5`) → activate → clone ghost into `document.body`, `transform: translate(...) rotate(2deg) scale(0.96)` on `pointermove`, `document.elementFromPoint(x,y).closest(target)` for hit-test, toggle a drop-highlight class, cleanup on `pointerup`/`pointercancel` (removeEventListener + ghost.remove()).
- **jsdom limitation:** `document.elementFromPoint` returns `null` in jsdom. So drag *hit-testing* is verified manually in-app (Task 7); the *status-mutation* logic is unit-tested by calling `BoardView.moveTaskToStatus(...)` directly. `.click()` works in jsdom and is used to test selection / checkbox / add.

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `ui/src/tasker/board.ts` | **Create** | `BoardView` class: render 3 status columns + cards for one project; pointer-drag between columns; inline add; checkbox toggle. Pure view over `TaskStorage`. |
| `ui/src/tasker/board.css` | **Create** | Column/card/drag styling, `.kb-*` scoped, Covenant tokens + `theme-light`/`true-dark` overrides. Imported from `board.ts`. |
| `ui/src/tasker/board.test.ts` | **Create** | Vitest/jsdom unit tests for `BoardView` (bucketing, sort, move, add, toggle) and panel integration (toggle, fullscreen class, switcher, dock). |
| `ui/src/tasker/panel.ts` | **Modify** | Add `viewMode` + `boardProjectId` state & persistence; List/Board toggle; `switchView`; Esc-to-list; project switcher; board body branch + details dock; instantiate/drive `BoardView`. |
| `ui/src/styles.css` | **Modify** | `body.tasker-board #tasker-panel` fullscreen block (mirrors `.pn-fullscreen`). |

---

## Task 1: View-mode state, List/Board toggle, fullscreen body class

**Files:**
- Modify: `ui/src/tasker/panel.ts`
- Modify: `ui/src/styles.css`
- Test: `ui/src/tasker/board.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `ui/src/tasker/board.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { TaskerPanel } from "./panel";

function mount(): { panel: TaskerPanel; host: HTMLElement } {
  document.body.innerHTML = `<div id="tasker-panel"></div>`;
  const host = document.getElementById("tasker-panel")!;
  const panel = new TaskerPanel(host);
  panel.render();
  return { panel, host };
}

beforeEach(() => {
  localStorage.clear();
  document.body.className = "";
  document.body.innerHTML = "";
});

describe("view toggle + fullscreen", () => {
  it("switches to board mode and adds body.tasker-board", () => {
    const { host } = mount();
    const boardBtn = host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!;
    expect(boardBtn).toBeTruthy();
    boardBtn.click();
    expect(document.body.classList.contains("tasker-board")).toBe(true);
    expect(host.querySelector(".tasker-panel-board")).toBeTruthy();
  });

  it("switches back to list and removes body.tasker-board", () => {
    const { host } = mount();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="list"]')!.click();
    expect(document.body.classList.contains("tasker-board")).toBe(false);
    expect(host.querySelector(".tasker-filters")).toBeTruthy();
  });

  it("Escape in board mode returns to list", () => {
    const { host } = mount();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(document.body.classList.contains("tasker-board")).toBe(false);
  });

  it("persists view mode across re-mount", () => {
    const { host } = mount();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();
    // remount with a fresh panel against the same localStorage
    document.body.innerHTML = `<div id="tasker-panel"></div>`;
    const host2 = document.getElementById("tasker-panel")!;
    new TaskerPanel(host2).render();
    expect(host2.querySelector(".tasker-panel-board")).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run ui/src/tasker/board.test.ts`
Expected: FAIL — no `.tasker-view-btn` in the DOM.

- [ ] **Step 3: Add view-mode state + persistence to `TaskerPanel`**

At the top of `panel.ts`, near `const EXPANDED_PROJECTS_KEY = ...`, add:

```ts
const VIEW_KEY = "covenant.tasker.view";
const BOARD_PROJECT_KEY = "covenant.tasker.board-project";
```

Add fields to the class (next to the other `private` fields):

```ts
private viewMode: "list" | "board" = "list";
private boardProjectId: string | null = null;
private boardKeyHandler: ((e: KeyboardEvent) => void) | null = null;
```

(The `BoardView` instance field is added in Task 2, once `board.ts` exists.)

In the constructor, after `this.loadExpandedProjects();`, add:

```ts
this.loadViewPrefs();
```

Add these methods to the class:

```ts
private loadViewPrefs(): void {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === "board" || v === "list") this.viewMode = v;
  } catch { /* ignore */ }
  try {
    this.boardProjectId = localStorage.getItem(BOARD_PROJECT_KEY);
  } catch { /* ignore */ }
  // Ensure boardProjectId points at a real project.
  const projects = this.storage.getProjects();
  if (!this.boardProjectId || !projects.some((p) => p.id === this.boardProjectId)) {
    this.boardProjectId = projects[0]?.id ?? null;
  }
}

private saveViewPrefs(): void {
  try {
    localStorage.setItem(VIEW_KEY, this.viewMode);
    if (this.boardProjectId) localStorage.setItem(BOARD_PROJECT_KEY, this.boardProjectId);
  } catch { /* ignore */ }
}

private switchView(mode: "list" | "board"): void {
  if (this.viewMode === mode) return;
  this.viewMode = mode;
  this.selectedTask = null;
  document.body.classList.toggle("tasker-board", mode === "board");
  this.saveViewPrefs();
  this.render();
}
```

- [ ] **Step 4: Render the toggle and branch the body**

Extract the current body of `render()` (everything inside `.tasker-panel` **after** the closing `</div>` of `.tasker-header` — i.e. `.tasker-filters` through `.tasker-footer`) into a new method, verbatim, returning the string:

```ts
private renderListBody(): string {
  return `
    <!-- the existing filters + newlist + projects + footer markup, moved verbatim -->
  `;
}
```

Add a shared header helper that includes the new toggle:

```ts
private renderHeader(): string {
  return `
    <div class="tasker-header">
      <h2 class="tasker-title">Tasker</h2>
      <div class="tasker-header-actions">
        <div class="tasker-view-toggle" role="group" aria-label="View">
          <button class="tasker-view-btn${this.viewMode === "list" ? " on" : ""}" type="button" data-view="list">List</button>
          <button class="tasker-view-btn${this.viewMode === "board" ? " on" : ""}" type="button" data-view="board">Board</button>
        </div>
        <button class="tasker-btn-icon tasker-btn-new-project" type="button" title="New project">${Icons.folder({ size: 14 })}</button>
      </div>
    </div>`;
}
```

Rewrite `render()` so it composes header + body by mode. Keep the existing pre/post logic (`closeDatePicker` guard, `this.host.classList.remove("hidden")`, `this.isOpen = true`, the final `setupEventListeners()` call, focus microtask):

```ts
render(): void {
  if (this.dateMenuEl && !this.openMenu) this.closeDatePicker();
  this.host.classList.remove("hidden");
  this.isOpen = true;
  document.body.classList.toggle("tasker-board", this.viewMode === "board");

  if (this.viewMode === "board") {
    this.host.innerHTML = `
      <div class="tasker-panel tasker-panel-board">
        ${this.renderHeader()}
        ${this.renderBoardBody()}
      </div>`;
  } else {
    this.host.innerHTML = `
      <div class="tasker-panel">
        ${this.renderHeader()}
        ${this.renderListBody()}
      </div>`;
  }

  this.setupEventListeners();

  // Preserve the existing list-mode composer autofocus.
  if (this.viewMode === "list") {
    queueMicrotask(() => {
      this.host.querySelector<HTMLInputElement>(".tasker-composer-input")?.focus();
    });
  }
}
```

Add a placeholder board body for now (real columns land in Task 2):

```ts
private renderBoardBody(): string {
  return `
    <div class="tasker-board-toolbar"></div>
    <div class="tasker-board-layout">
      <div class="kb-columns-host"></div>
      <aside class="tasker-board-dock"></aside>
    </div>`;
}
```

In `setupEventListeners()`, at the very top (runs in both modes), wire the toggle and Esc:

```ts
this.host.querySelectorAll<HTMLButtonElement>(".tasker-view-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const mode = btn.dataset.view === "board" ? "board" : "list";
    this.switchView(mode);
  });
});

if (this.boardKeyHandler) {
  document.removeEventListener("keydown", this.boardKeyHandler);
  this.boardKeyHandler = null;
}
if (this.viewMode === "board") {
  this.boardKeyHandler = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.viewMode === "board" && !this.openMenu) {
      this.switchView("list");
    }
  };
  document.addEventListener("keydown", this.boardKeyHandler);
}
```

> NOTE: the existing list-mode wiring in `setupEventListeners()` (filters, projects, composer, etc.) queries elements that only exist in list mode; `querySelectorAll` simply returns empty in board mode, so those blocks are safe to leave as-is.

Also update `close()` to clear the fullscreen state:

```ts
close(): void {
  this.host.classList.add("hidden");
  this.isOpen = false;
  document.body.classList.remove("tasker-board");
  if (this.boardKeyHandler) {
    document.removeEventListener("keydown", this.boardKeyHandler);
    this.boardKeyHandler = null;
  }
}
```

- [ ] **Step 5: Add the fullscreen CSS**

In `ui/src/styles.css`, immediately after the existing `body.sidebar-view-tasker ... #tasker-panel` grid rules (~line 15195), add:

```css
/* TASKER Board (kanban) fullscreen — mirrors .pn-fullscreen */
body.tasker-board #tasker-panel {
  position: fixed;
  inset: 38px 0 0 0;
  bottom: calc(var(--statusbar-h) + 1px);
  width: 100vw;
  height: auto;
  max-width: none;
  border: none;
  z-index: 80;
}
body.tabbar-left.tasker-board #tasker-panel {
  top: 38px;
}
body.tasker-board #tasker-panel .tasker-panel-board {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/board.test.ts`
Expected: PASS (4 tests). Then `npx vitest run ui/src/tasker/panel.test.ts` — Expected: still PASS (no regressions).

- [ ] **Step 7: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/styles.css ui/src/tasker/board.test.ts
git commit -m "feat(tasker): List/Board view toggle + fullscreen scaffold"
```

---

## Task 2: BoardView — columns, bucketing, sort, card markup

**Files:**
- Create: `ui/src/tasker/board.ts`
- Create: `ui/src/tasker/board.css`
- Modify: `ui/src/tasker/panel.ts` (instantiate + render BoardView)
- Test: `ui/src/tasker/board.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `ui/src/tasker/board.test.ts`:

```ts
import { BoardView } from "./board";
import { TaskStorage } from "./storage";
import type { TaskStatus } from "./types";

function boardHarness() {
  const storage = new TaskStorage();
  const project = storage.getProjects()[0] ?? storage.createProject("Inbox");
  const host = document.createElement("div");
  document.body.appendChild(host);
  let selected: { projectId: string; taskId: string } | null = null;
  let changes = 0;
  const view = new BoardView({
    storage,
    getProjectId: () => project.id,
    isSelected: (p, t) => selected?.projectId === p && selected?.taskId === t,
    onSelect: (p, t) => { selected = { projectId: p, taskId: t }; },
    onChange: () => { changes++; },
  });
  return { storage, project, host, view, getChanges: () => changes, getSelected: () => selected };
}

describe("BoardView columns", () => {
  it("renders three status columns", () => {
    const h = boardHarness();
    h.view.render(h.host);
    const cols = h.host.querySelectorAll(".kb-col");
    expect(cols.length).toBe(3);
    expect([...cols].map((c) => (c as HTMLElement).dataset.status)).toEqual(["pending", "active", "done"]);
  });

  it("buckets tasks by status and excludes cancelled", () => {
    const h = boardHarness();
    h.storage.createTask(h.project.id, "todo task", { status: "pending" });
    h.storage.createTask(h.project.id, "doing task", { status: "active" });
    h.storage.createTask(h.project.id, "done task", { status: "done" });
    h.storage.createTask(h.project.id, "cancelled task", { status: "cancelled" });
    h.view.render(h.host);
    const col = (s: TaskStatus) => h.host.querySelector(`.kb-col[data-status="${s}"]`)!;
    expect(col("pending").querySelectorAll(".kb-card").length).toBe(1);
    expect(col("active").querySelectorAll(".kb-card").length).toBe(1);
    expect(col("done").querySelectorAll(".kb-card").length).toBe(1);
    expect(h.host.textContent).not.toContain("cancelled task");
  });

  it("shows per-column counts", () => {
    const h = boardHarness();
    h.storage.createTask(h.project.id, "a", { status: "pending" });
    h.storage.createTask(h.project.id, "b", { status: "pending" });
    h.view.render(h.host);
    const count = h.host.querySelector('.kb-col[data-status="pending"] .kb-col-count')!;
    expect(count.textContent).toBe("2");
  });

  it("orders a column by priority then due date then creation", () => {
    const h = boardHarness();
    h.storage.createTask(h.project.id, "low-old", { status: "pending", priority: "low" });
    h.storage.createTask(h.project.id, "urgent", { status: "pending", priority: "urgent" });
    h.storage.createTask(h.project.id, "normal", { status: "pending", priority: "normal" });
    h.view.render(h.host);
    const titles = [...h.host.querySelectorAll('.kb-col[data-status="pending"] .kb-card-title')]
      .map((e) => e.textContent);
    expect(titles).toEqual(["urgent", "normal", "low-old"]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run ui/src/tasker/board.test.ts`
Expected: FAIL — cannot import `BoardView` from `./board`.

- [ ] **Step 3: Create `ui/src/tasker/board.ts`**

```ts
import "./board.css";
import type { TaskStorage } from "./storage";
import type { Task, TaskPriority, TaskStatus } from "./types";

export interface BoardViewDeps {
  storage: TaskStorage;
  getProjectId: () => string | null;
  isSelected: (projectId: string, taskId: string) => boolean;
  onSelect: (projectId: string, taskId: string) => void;
  onChange: () => void;
}

export const BOARD_COLUMNS: { status: TaskStatus; label: string }[] = [
  { status: "pending", label: "To Do" },
  { status: "active", label: "In Progress" },
  { status: "done", label: "Done" },
];

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

function compareTasks(a: Task, b: Task): number {
  const p = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
  if (p !== 0) return p;
  const ad = a.dueDate ?? Number.POSITIVE_INFINITY;
  const bd = b.dueDate ?? Number.POSITIVE_INFINITY;
  if (ad !== bd) return ad - bd;
  return a.createdAt - b.createdAt;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}

function fmtDue(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export class BoardView {
  private host: HTMLElement | null = null;
  private addingStatus: TaskStatus | null = null;

  constructor(private deps: BoardViewDeps) {}

  render(host: HTMLElement): void {
    this.host = host;
    const projectId = this.deps.getProjectId();
    const project = projectId ? this.deps.storage.getProject(projectId) : null;
    if (!project) {
      host.innerHTML = `<div class="kb-empty">No project selected.</div>`;
      return;
    }
    const bucket = (s: TaskStatus): Task[] =>
      project.tasks.filter((t) => t.status === s).slice().sort(compareTasks);

    host.innerHTML = `
      <div class="kb-columns">
        ${BOARD_COLUMNS.map((col) => this.renderColumn(project.id, col, bucket(col.status))).join("")}
      </div>`;

    this.wire(project.id);
  }

  private renderColumn(
    projectId: string,
    col: { status: TaskStatus; label: string },
    tasks: Task[],
  ): string {
    return `
      <section class="kb-col" data-status="${col.status}">
        <header class="kb-col-head">
          <span class="kb-col-name kb-dot-${col.status}">${col.label}</span>
          <span class="kb-col-count">${tasks.length}</span>
        </header>
        <div class="kb-col-body">
          ${tasks.map((t) => this.renderCard(projectId, t)).join("")}
          ${this.renderAdd(col.status)}
        </div>
      </section>`;
  }

  private renderCard(projectId: string, task: Task): string {
    const sel = this.deps.isSelected(projectId, task.id) ? " kb-card-selected" : "";
    const done = task.status === "done";
    const due = task.dueDate ? `<span class="kb-badge kb-due">${fmtDue(task.dueDate)}</span>` : "";
    const tags = (task.tags ?? [])
      .slice(0, 2)
      .map((t) => `<span class="kb-badge kb-tag">${escapeHtml(t)}</span>`)
      .join("");
    const note = task.description?.trim() ? `<span class="kb-note" aria-label="Has notes"></span>` : "";
    const meta = due || tags || note ? `<div class="kb-card-meta">${due}${tags}${note}</div>` : "";
    return `
      <article class="kb-card kb-prio-${task.priority}${done ? " kb-card-done" : ""}${sel}"
        data-project-id="${projectId}" data-task-id="${task.id}">
        <button class="kb-check${done ? " kb-check-done" : ""}" type="button" aria-label="Toggle done"></button>
        <div class="kb-card-body">
          <div class="kb-card-title">${escapeHtml(task.title)}</div>
          ${meta}
        </div>
      </article>`;
  }

  private renderAdd(status: TaskStatus): string {
    if (this.addingStatus === status) {
      return `<form class="kb-add-form" data-status="${status}">
        <input class="kb-add-input" type="text" placeholder="Task title" autocomplete="off" />
      </form>`;
    }
    return `<button class="kb-add" type="button" data-status="${status}">+ Add task</button>`;
  }

  // wiring lands in Task 3 (select/checkbox) and Tasks 4-5 (drag/add).
  private wire(_projectId: string): void {}

  /** Status mutation used by drag-drop. Mirrors the panel's completedAt convention. */
  moveTaskToStatus(projectId: string, taskId: string, status: TaskStatus): void {
    const task = this.deps.storage.getTask(projectId, taskId);
    if (!task || task.status === status) return;
    this.deps.storage.updateTask(projectId, taskId, {
      status,
      completedAt: status === "done" ? Date.now() : undefined,
    });
    this.deps.onChange();
  }

  /** Inline create for a column. */
  addTask(projectId: string, status: TaskStatus, title: string): void {
    const t = title.trim();
    if (!t) return;
    this.deps.storage.createTask(projectId, t, { status });
    this.addingStatus = null;
    this.deps.onChange();
  }
}
```

- [ ] **Step 4: Create `ui/src/tasker/board.css`**

```css
.kb-columns {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
  padding: 14px 16px 18px;
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
}
.kb-col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: rgba(255 255 255 / 0.022);
  border: 1px solid var(--border);
  border-radius: 10px;
}
body.theme-true-dark .kb-col { background: #111113; }
.kb-col-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 11px;
  border-bottom: 1px solid var(--border);
}
.kb-col-name {
  font: 600 11px ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: 0.07em;
  text-transform: uppercase;
  color: var(--muted);
}
.kb-col-name::before {
  content: "";
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  margin-right: 6px;
  vertical-align: middle;
  background: var(--muted);
}
.kb-dot-pending::before { background: #7b818c; }
.kb-dot-active::before { background: var(--accent); }
.kb-dot-done::before { background: #22c55e; }
.kb-col-count {
  margin-left: auto;
  font: 600 10.5px ui-monospace, monospace;
  color: var(--muted);
  background: rgba(255 255 255 / 0.05);
  border-radius: 20px;
  padding: 1px 7px;
}
.kb-col-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  overflow-y: auto;
  min-height: 0;
}

.kb-card {
  position: relative;
  display: flex;
  gap: 8px;
  background: rgba(255 255 255 / 0.04);
  border: 1px solid rgba(255 255 255 / 0.08);
  border-radius: 8px;
  padding: 9px 10px 9px 13px;
  cursor: pointer;
  user-select: none;
}
body.theme-true-dark .kb-card { background: #141416; }
.kb-card::before {
  content: "";
  position: absolute;
  left: 5px;
  top: 8px;
  bottom: 8px;
  width: 3px;
  border-radius: 3px;
  background: var(--sp, #eab308);
}
.kb-prio-urgent { --sp: #ef4444; }
.kb-prio-high { --sp: #f97316; }
.kb-prio-normal { --sp: #eab308; }
.kb-prio-low { --sp: #22c55e; }
.kb-card-selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }

.kb-check {
  width: 14px;
  height: 14px;
  margin-top: 1px;
  flex: none;
  border: 1.5px solid var(--muted);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  position: relative;
}
.kb-check-done { background: #22c55e; border-color: #22c55e; }
.kb-check-done::after {
  content: "✓";
  position: absolute;
  inset: -3px 0 0;
  font-size: 11px;
  font-weight: 700;
  text-align: center;
  color: #0b0d10;
}
.kb-card-body { min-width: 0; }
.kb-card-title { font-size: 12.5px; line-height: 1.35; color: var(--text-primary); }
.kb-card-done .kb-card-title { color: var(--muted); text-decoration: line-through; }
.kb-card-meta { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 7px; align-items: center; }
.kb-badge {
  font: 600 10px ui-monospace, monospace;
  padding: 1.5px 6px;
  border-radius: 5px;
  border: 1px solid var(--border);
  color: var(--muted);
}
.kb-due { color: #f0a868; border-color: rgba(240 168 104 / 0.3); }
.kb-tag { color: var(--accent); border-color: rgba(122 162 247 / 0.25); }
.kb-note { width: 6px; height: 6px; border-radius: 50%; background: var(--muted); display: inline-block; }

.kb-add {
  font: 600 11.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--muted);
  border: 1px dashed var(--border);
  border-radius: 7px;
  padding: 7px;
  text-align: center;
  background: transparent;
  cursor: pointer;
}
.kb-add:hover { color: var(--text-primary); }
.kb-add-form { display: flex; }
.kb-add-input {
  flex: 1;
  font-size: 12.5px;
  padding: 7px 9px;
  border-radius: 7px;
  border: 1px solid var(--accent);
  background: var(--bg);
  color: var(--text-primary);
}

.kb-empty { padding: 24px; color: var(--muted); }

/* drag (Task 4) */
.kb-card-ghost {
  position: fixed;
  z-index: 90;
  pointer-events: none;
  opacity: 0.95;
  left: 0;
  top: 0;
}
.kb-col--drop { outline: 2px dashed var(--accent); outline-offset: -2px; }
.kb-card-dragging { opacity: 0.4; }
```

- [ ] **Step 5: Wire BoardView into the panel's board body**

In `panel.ts`, replace the `renderBoardBody()` placeholder's post-render with a real mount. Update `render()`'s board branch to mount the board after setting innerHTML. The simplest reliable place is at the end of `setupEventListeners()`:

```ts
// at the end of setupEventListeners(), after existing wiring:
if (this.viewMode === "board") {
  this.mountBoard();
}
```

Add the `mountBoard` method:

```ts
private mountBoard(): void {
  const columnsHost = this.host.querySelector<HTMLElement>(".kb-columns-host");
  if (!columnsHost) return;
  if (!this.board) {
    this.board = new BoardView({
      storage: this.storage,
      getProjectId: () => this.boardProjectId,
      isSelected: (p, t) =>
        this.selectedTask?.projectId === p && this.selectedTask?.taskId === t,
      onSelect: (p, t) => {
        const same = this.selectedTask?.projectId === p && this.selectedTask?.taskId === t;
        this.selectedTask = same ? null : { projectId: p, taskId: t };
        this.render();
      },
      onChange: () => this.render(),
    });
  }
  this.board.render(columnsHost);
}
```

Add the static import at the top of `panel.ts` and declare the `board` field (use the imported `BoardView` directly in `mountBoard` — no `require`):

```ts
import { BoardView } from "./board";
// ...inside the class, with the other private fields:
private board: BoardView | null = null;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/board.test.ts`
Expected: PASS (all Task 1 + Task 2 tests). Run `npx tsc --noEmit -p ui/tsconfig.json` — Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/tasker/board.ts ui/src/tasker/board.css ui/src/tasker/panel.ts ui/src/tasker/board.test.ts
git commit -m "feat(tasker): BoardView columns, bucketing, sort + card markup"
```

---

## Task 3: Card selection → details dock; checkbox toggle

**Files:**
- Modify: `ui/src/tasker/board.ts` (wire select + checkbox)
- Modify: `ui/src/tasker/panel.ts` (render + bind the details dock in board mode)
- Test: `ui/src/tasker/board.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `board.test.ts`:

```ts
describe("board selection + checkbox", () => {
  it("clicking a card opens the details dock with the task's status control", () => {
    document.body.innerHTML = `<div id="tasker-panel"></div>`;
    const host = document.getElementById("tasker-panel")!;
    const panel = new TaskerPanel(host);
    const storage = (panel as unknown as { storage: TaskStorage }).storage;
    const pid = storage.getProjects()[0].id;
    storage.createTask(pid, "Pick me", { status: "pending" });
    (panel as unknown as { boardProjectId: string }).boardProjectId = pid;
    panel.render();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();

    host.querySelector<HTMLElement>(".kb-card")!.click();
    const dock = host.querySelector(".tasker-board-dock .tasker-edit");
    expect(dock).toBeTruthy();
    expect(dock!.querySelector('.tasker-seg-btn[data-status="pending"].on')).toBeTruthy();
  });

  it("checkbox toggles a task to done", () => {
    const h = boardHarness();
    const t = h.storage.createTask(h.project.id, "Finish", { status: "pending" })!;
    h.view.render(h.host);
    h.host.querySelector<HTMLButtonElement>(`.kb-card[data-task-id="${t.id}"] .kb-check`)!.click();
    expect(h.storage.getTask(h.project.id, t.id)!.status).toBe("done");
    expect(h.getChanges()).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run ui/src/tasker/board.test.ts`
Expected: FAIL — no dock; `.kb-check` click does nothing.

- [ ] **Step 3: Implement `wire()` select + checkbox in `board.ts`**

Replace the empty `wire()` with:

```ts
private wire(projectId: string): void {
  if (!this.host) return;

  // Checkbox toggles done (stops the card click/select).
  this.host.querySelectorAll<HTMLButtonElement>(".kb-check").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const card = btn.closest<HTMLElement>(".kb-card");
      const taskId = card?.dataset.taskId;
      if (!taskId) return;
      this.toggleDone(projectId, taskId);
    });
  });

  // Card click selects (drag in Task 4 sets suppressClick).
  this.host.querySelectorAll<HTMLElement>(".kb-card").forEach((card) => {
    card.addEventListener("click", () => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      const taskId = card.dataset.taskId;
      if (taskId) this.deps.onSelect(projectId, taskId);
    });
  });
}

private toggleDone(projectId: string, taskId: string): void {
  const task = this.deps.storage.getTask(projectId, taskId);
  if (!task) return;
  const next: TaskStatus = task.status === "done" ? "pending" : "done";
  this.deps.storage.updateTask(projectId, taskId, {
    status: next,
    completedAt: next === "done" ? Date.now() : undefined,
  });
  this.deps.onChange();
}
```

Add the field near the top of the class:

```ts
private suppressClick = false;
```

- [ ] **Step 4: Render + bind the details dock in `panel.ts`**

Update `renderBoardBody()` to fill the dock when a task is selected:

```ts
private renderBoardBody(): string {
  const sel = this.selectedTask;
  let dock = "";
  if (sel) {
    const task = this.storage.getTask(sel.projectId, sel.taskId);
    if (task) dock = this.renderTaskDetails(sel.projectId, task);
  }
  return `
    <div class="tasker-board-toolbar"></div>
    <div class="tasker-board-layout">
      <div class="kb-columns-host"></div>
      <aside class="tasker-board-dock${dock ? " tasker-board-dock-open" : ""}">${dock}</aside>
    </div>`;
}
```

In `setupEventListeners()`, ensure the details events are bound in board mode too. Find where `bindDetailsEvents()` is called for list mode and make sure it also runs in board mode (it queries `this.host.querySelectorAll(".tasker-edit")`, which now includes the dock). If the existing call is inside a list-only block, add an unconditional call near the end of `setupEventListeners()`:

```ts
this.bindDetailsEvents();
```

(Calling it once unconditionally is safe — in list mode the same `.tasker-edit` nodes are matched; verify no double-binding by confirming `bindDetailsEvents` is not also called elsewhere. If it already runs unconditionally, leave it.)

- [ ] **Step 5: Dock CSS**

Append to `ui/src/tasker/board.css`:

```css
.tasker-board-layout {
  display: flex;
  flex: 1;
  min-height: 0;
}
.tasker-board-layout .kb-columns-host { flex: 1; min-width: 0; min-height: 0; }
.tasker-board-dock {
  width: 0;
  overflow: hidden;
  border-left: 1px solid transparent;
  transition: width 0.14s ease;
}
.tasker-board-dock-open {
  width: 320px;
  overflow-y: auto;
  border-left: 1px solid var(--border);
  padding: 16px;
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/board.test.ts` — Expected: PASS.
Run: `npx vitest run ui/src/tasker/panel.test.ts` — Expected: PASS (dock reuse must not regress list details).

- [ ] **Step 7: Commit**

```bash
git add ui/src/tasker/board.ts ui/src/tasker/panel.ts ui/src/tasker/board.css ui/src/tasker/board.test.ts
git commit -m "feat(tasker): board card select → details dock + checkbox toggle"
```

---

## Task 4: Drag a card between columns (pointer events)

**Files:**
- Modify: `ui/src/tasker/board.ts` (pointer drag → `moveTaskToStatus`)
- Test: `ui/src/tasker/board.test.ts` (mutation logic; hit-testing verified in Task 7)

- [ ] **Step 1: Write the failing test**

Append to `board.test.ts`:

```ts
describe("board drag move", () => {
  it("moveTaskToStatus changes status and sets completedAt when done", () => {
    const h = boardHarness();
    const t = h.storage.createTask(h.project.id, "Ship", { status: "pending" })!;
    h.view.render(h.host);
    h.view.moveTaskToStatus(h.project.id, t.id, "done");
    const after = h.storage.getTask(h.project.id, t.id)!;
    expect(after.status).toBe("done");
    expect(typeof after.completedAt).toBe("number");
  });

  it("moving out of done clears completedAt", () => {
    const h = boardHarness();
    const t = h.storage.createTask(h.project.id, "Reopen", { status: "done", completedAt: 123 })!;
    h.view.render(h.host);
    h.view.moveTaskToStatus(h.project.id, t.id, "active");
    const after = h.storage.getTask(h.project.id, t.id)!;
    expect(after.status).toBe("active");
    expect(after.completedAt).toBeUndefined();
  });

  it("a no-op move (same status) does not call onChange", () => {
    const h = boardHarness();
    const t = h.storage.createTask(h.project.id, "Same", { status: "active" })!;
    h.view.render(h.host);
    const before = h.getChanges();
    h.view.moveTaskToStatus(h.project.id, t.id, "active");
    expect(h.getChanges()).toBe(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run ui/src/tasker/board.test.ts`
Expected: FAIL on the first two (the third already passes from Task 2's `moveTaskToStatus`). Note: if all `moveTaskToStatus` logic already exists from Task 2, these tests may pass immediately — that's acceptable; the new work in this task is the **pointer wiring**, which jsdom cannot exercise. Proceed to Step 3 regardless.

- [ ] **Step 3: Add pointer-drag wiring in `board.ts`**

Extend `wire()` to install drag on each card (after the click/checkbox handlers):

```ts
this.host.querySelectorAll<HTMLElement>(".kb-card").forEach((card) => {
  card.addEventListener("pointerdown", (e) => this.beginDrag(e, projectId, card));
});
```

Add the drag implementation (adapted from `tabs/manager.ts`):

```ts
private beginDrag(e: PointerEvent, projectId: string, card: HTMLElement): void {
  if (e.button !== 0) return;
  if ((e.target as HTMLElement).closest(".kb-check")) return; // checkbox is not a drag handle
  const taskId = card.dataset.taskId;
  if (!taskId || !this.host) return;

  const startX = e.clientX;
  const startY = e.clientY;
  const rect = card.getBoundingClientRect();
  let activated = false;
  let ghost: HTMLElement | null = null;

  const activate = (): void => {
    activated = true;
    this.suppressClick = true;
    card.classList.add("kb-card-dragging");
    const g = card.cloneNode(true) as HTMLElement;
    g.classList.add("kb-card-ghost");
    g.style.width = `${rect.width}px`;
    document.body.appendChild(g);
    ghost = g;
  };

  const clearDrop = (): void => {
    this.host?.querySelectorAll(".kb-col--drop").forEach((c) => c.classList.remove("kb-col--drop"));
  };

  const onMove = (ev: PointerEvent): void => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    if (!activated) {
      if (dx * dx + dy * dy < 5 * 5) return;
      activate();
    }
    if (ghost) {
      ghost.style.transform = `translate(${rect.left + dx}px, ${rect.top + dy}px) rotate(2deg) scale(0.97)`;
    }
    clearDrop();
    const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
    el?.closest<HTMLElement>(".kb-col")?.classList.add("kb-col--drop");
  };

  const onUp = (ev: PointerEvent): void => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onUp);
    card.classList.remove("kb-card-dragging");
    if (ghost) { ghost.remove(); ghost = null; }
    if (activated) {
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const col = el?.closest<HTMLElement>(".kb-col");
      const status = col?.dataset.status as TaskStatus | undefined;
      clearDrop();
      if (status) this.moveTaskToStatus(projectId, taskId, status);
    }
  };

  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
  window.addEventListener("pointercancel", onUp);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/board.test.ts` — Expected: PASS.
Run: `npx tsc --noEmit -p ui/tsconfig.json` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tasker/board.ts ui/src/tasker/board.test.ts
git commit -m "feat(tasker): pointer-drag cards between board columns"
```

---

## Task 5: Inline create per column

**Files:**
- Modify: `ui/src/tasker/board.ts` (wire `+ Add task` → inline input → `addTask`)
- Test: `ui/src/tasker/board.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `board.test.ts`:

```ts
describe("board inline add", () => {
  it("addTask creates a task with the column's status in the current project", () => {
    const h = boardHarness();
    h.view.render(h.host);
    h.view.addTask(h.project.id, "active", "Wire it up");
    const created = h.storage.getProject(h.project.id)!.tasks.find((t) => t.title === "Wire it up");
    expect(created).toBeTruthy();
    expect(created!.status).toBe("active");
  });

  it("clicking + Add task reveals an input that creates on submit", () => {
    const h = boardHarness();
    h.view.render(h.host);
    const addBtn = h.host.querySelector<HTMLButtonElement>('.kb-col[data-status="pending"] .kb-add')!;
    addBtn.click();
    const input = h.host.querySelector<HTMLInputElement>('.kb-col[data-status="pending"] .kb-add-input')!;
    expect(input).toBeTruthy();
    input.value = "From the board";
    input.closest("form")!.dispatchEvent(new Event("submit", { cancelable: true }));
    const created = h.storage.getProject(h.project.id)!.tasks.find((t) => t.title === "From the board");
    expect(created).toBeTruthy();
    expect(created!.status).toBe("pending");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run ui/src/tasker/board.test.ts`
Expected: FAIL on the second test — clicking `.kb-add` does nothing (`addingStatus` never set; no re-render).

- [ ] **Step 3: Wire add controls in `board.ts`**

Append to `wire()`:

```ts
// "+ Add task" reveals the inline input.
this.host.querySelectorAll<HTMLButtonElement>(".kb-add").forEach((btn) => {
  btn.addEventListener("click", () => {
    this.addingStatus = (btn.dataset.status as TaskStatus) ?? null;
    if (this.host) this.render(this.host);
    this.host?.querySelector<HTMLInputElement>(".kb-add-input")?.focus();
  });
});

// Submit creates; Escape cancels.
this.host.querySelectorAll<HTMLFormElement>(".kb-add-form").forEach((form) => {
  const status = form.dataset.status as TaskStatus | undefined;
  const input = form.querySelector<HTMLInputElement>(".kb-add-input");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (status && input) this.addTask(projectId, status, input.value);
  });
  input?.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      this.addingStatus = null;
      if (this.host) this.render(this.host);
    }
  });
});
```

> `addTask` already calls `this.deps.onChange()`, which re-renders the whole panel (and thus the board). When `addTask` runs through the panel's `onChange` path, the board re-renders fresh and `addingStatus` is reset. In the direct-call unit test, the project state is asserted from storage, which is correct.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/board.test.ts` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tasker/board.ts ui/src/tasker/board.test.ts
git commit -m "feat(tasker): inline add-task per board column"
```

---

## Task 6: Project switcher

**Files:**
- Modify: `ui/src/tasker/panel.ts` (toolbar switcher + persistence)
- Test: `ui/src/tasker/board.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `board.test.ts`:

```ts
describe("board project switcher", () => {
  function mountBoardPanel() {
    document.body.innerHTML = `<div id="tasker-panel"></div>`;
    const host = document.getElementById("tasker-panel")!;
    const panel = new TaskerPanel(host);
    const storage = (panel as unknown as { storage: TaskStorage }).storage;
    panel.render();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();
    return { panel, host, storage };
  }

  it("lists all projects and switches the board on change", () => {
    const { host, storage } = mountBoardPanel();
    const a = storage.getProjects()[0];
    const b = storage.createProject("Second");
    storage.createTask(a.id, "task in A", { status: "pending" });
    storage.createTask(b.id, "task in B", { status: "pending" });
    // re-render board after creating data
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="list"]')!.click();
    host.querySelector<HTMLButtonElement>('.tasker-view-btn[data-view="board"]')!.click();

    const select = host.querySelector<HTMLSelectElement>(".kb-project-select")!;
    expect(select).toBeTruthy();
    expect(select.options.length).toBe(2);

    select.value = b.id;
    select.dispatchEvent(new Event("change"));
    expect(host.textContent).toContain("task in B");
    expect(host.textContent).not.toContain("task in A");
  });

  it("shows the project name without a dropdown when only one project exists", () => {
    const { host } = mountBoardPanel();
    expect(host.querySelector(".kb-project-select")).toBeNull();
    expect(host.querySelector(".kb-project-name")!.textContent).toContain("Inbox");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run ui/src/tasker/board.test.ts`
Expected: FAIL — no `.kb-project-select` / `.kb-project-name` in the toolbar.

- [ ] **Step 3: Render the switcher in `panel.ts`**

Add a helper:

```ts
private renderProjectSwitcher(): string {
  const projects = this.storage.getProjects();
  if (projects.length <= 1) {
    const only = projects[0];
    return `<span class="kb-project-name">${escapeHtml(only?.name ?? "")}</span>`;
  }
  const current = this.boardProjectId ?? projects[0].id;
  return `
    <select class="kb-project-select" aria-label="Project">
      ${projects
        .map((p) => `<option value="${p.id}"${p.id === current ? " selected" : ""}>${escapeHtml(p.name)}</option>`)
        .join("")}
    </select>`;
}
```

> Reuse the panel's existing `escapeHtml`/`escapeAttr` helper. If it is module-private with a different name, use that exact name; do not introduce a second copy.

Fill the toolbar in `renderBoardBody()`:

```ts
<div class="tasker-board-toolbar">${this.renderProjectSwitcher()}</div>
```

Wire the change handler in `setupEventListeners()` (board mode block, near `mountBoard()`):

```ts
const projectSelect = this.host.querySelector<HTMLSelectElement>(".kb-project-select");
projectSelect?.addEventListener("change", () => {
  this.boardProjectId = projectSelect.value;
  this.selectedTask = null;
  this.saveViewPrefs();
  this.render();
});
```

- [ ] **Step 4: Toolbar CSS**

Append to `board.css`:

```css
.tasker-board-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 16px 0;
}
.kb-project-select,
.kb-project-name {
  font: 600 12.5px ui-monospace, "SF Mono", Menlo, monospace;
  color: var(--text-primary);
  background: rgba(255 255 255 / 0.04);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px 11px;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/board.test.ts` — Expected: PASS (entire file).
Run: `npx vitest run` — Expected: whole suite green.
Run: `npx tsc --noEmit -p ui/tsconfig.json` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/board.css ui/src/tasker/board.test.ts
git commit -m "feat(tasker): board project switcher"
```

---

## Task 7: Manual verification & polish (in the real app)

**Files:** none (verification), small CSS/UX fixes only if needed.

This task exists because jsdom cannot exercise `elementFromPoint` drag hit-testing or real theming. Use the `respawn` skill / `npm run tauri:dev` to launch.

- [ ] **Step 1: Launch the app**

Use the `respawn` skill (or run the project's `tauri dev` task). Open TASKER (⌘⌥K).

- [ ] **Step 2: Verify the flow**

Confirm each, fixing CSS-only issues in `board.css`/`styles.css` as needed:
- [ ] List → Board toggle expands TASKER to fullscreen (covers the terminal, status bar visible).
- [ ] Three columns render with correct counts; cancelled tasks absent.
- [ ] Drag a card to another column → it moves and persists (reload app, still there).
- [ ] Dragging onto the same column / outside → no change.
- [ ] Checkbox toggles done (card moves to Done column, strike-through).
- [ ] `+ Add task` under each column creates a task with that status.
- [ ] Click a card → details dock opens on the right; editing status/priority/due/notes works and reflects on the board.
- [ ] Project switcher changes the board; single-project case shows just the name.
- [ ] `Esc` and flipping to List return to the rail; `×` closes the panel.
- [ ] Theme check: `theme-light` and `true-dark` — columns/cards readable, neutral lifts on True Dark (no harsh accent tints on near-black).
- [ ] Vertical tabbar (`body.tabbar-left`): fullscreen top offset correct (38px).

- [ ] **Step 3: Commit any polish**

```bash
git add -A
git commit -m "fix(tasker): board polish from in-app verification"
```

> If verification surfaces a behavioral (non-CSS) bug, stop and use superpowers:systematic-debugging before patching.

---

## Definition of Done

- `npx vitest run` green (board + panel + rest of suite).
- `npx tsc --noEmit -p ui/tsconfig.json` clean.
- Manual checklist in Task 7 all checked.
- No new `as any` without a justifying comment; no `element.title` (use `attachTooltip` if tooltips are added).
- Commits are conventional and one-feature-each.
