# Tasker Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Tasker right-rail panel visually homogeneous with Covenant, fix the three-state task lifecycle (Pending → Active → Done), replace the heavy inline form with lightweight inline editing, and remove the native `prompt()`.

**Architecture:** `TaskerPanel` (`ui/src/tasker/panel.ts`) keeps its full re-render model: every mutation calls `this.render()` which rebuilds `innerHTML` and re-binds listeners. We refactor the row renderer, replace the detail form with an inline edit block + popovers, add a status `start` affordance, and swap `prompt()` for an inline list composer. `TaskStorage` (`ui/src/tasker/storage.ts`) is unchanged — `updateTask`/`createTask`/`deleteTask`/`createProject` already cover every mutation; the reopen-clears-`completedAt` rule lives in the panel. Styling (`ui/src/tasker/styles.css`) is rewritten against real theme tokens.

**Tech Stack:** TypeScript (strict), vanilla DOM, Vitest + jsdom for tests, CSS with Covenant theme tokens.

---

## Spec reference

`docs/superpowers/specs/2026-06-07-tasker-redesign-design.md` (local, gitignored).

## File Structure

- **Modify** `ui/src/tasker/panel.ts` — rendering + interactions: new row, inline edit block, status transitions, popovers (status + priority), inline due-date editor, inline list composer. Replaces `showNewProjectDialog()`'s `prompt()`.
- **Modify** `ui/src/tasker/styles.css` — full rewrite against tokens; flat rows; popover + composer styles; uppercase list names via CSS.
- **Create** `ui/src/tasker/panel.test.ts` — Vitest/jsdom behavior tests.
- **Unchanged** `ui/src/tasker/types.ts`, `ui/src/tasker/storage.ts`.

## Conventions for every test

- Tests run from repo root: `npx vitest run ui/src/tasker/panel.test.ts`.
- jsdom backs `localStorage`; clear it in `beforeEach` so `TaskStorage` starts empty.
- `TaskerPanel`'s constructor seeds an "Inbox" project when none exist and auto-expands it.
- Test helper signatures used throughout (defined once in Task 1):
  - `mount(): { panel: TaskerPanel; host: HTMLElement }` — mounts and calls `render()`.
  - `inbox(panel): string` — returns the seeded Inbox project id via `panel["storage"].getProjects()[0].id`.
  - `addTask(panel, projectId, title): string` — creates a task through storage and returns its id.

---

## Task 1: Test harness + status `start` transition (Pending → Active)

**Files:**
- Create: `ui/src/tasker/panel.test.ts`
- Modify: `ui/src/tasker/panel.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/tasker/panel.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskerPanel } from "./panel";

function mount(): { panel: TaskerPanel; host: HTMLElement } {
  document.body.innerHTML = `<div id="tasker-panel"></div>`;
  const host = document.getElementById("tasker-panel")!;
  const panel = new TaskerPanel(host);
  panel.render();
  return { panel, host };
}

// Reach into the private storage to read state without rendering assumptions.
function storageOf(panel: TaskerPanel): any {
  return (panel as unknown as { storage: any }).storage;
}

function inbox(panel: TaskerPanel): string {
  return storageOf(panel).getProjects()[0].id;
}

function addTask(panel: TaskerPanel, projectId: string, title: string): string {
  const t = storageOf(panel).createTask(projectId, title, { priority: "normal" });
  return t.id;
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("TaskerPanel status lifecycle", () => {
  it("start affordance flips a pending task to active", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();

    const startBtn = host.querySelector<HTMLButtonElement>(
      `.tasker-task[data-task-id="${tid}"] .tasker-task-start`,
    );
    expect(startBtn).toBeTruthy();
    startBtn!.click();

    expect(storageOf(panel).getTask(pid, tid).status).toBe("active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: FAIL — `.tasker-task-start` is null (no start affordance rendered yet).

- [ ] **Step 3: Add the start affordance to the row renderer**

In `ui/src/tasker/panel.ts`, in `renderTask()`, replace the chevron-only trailing markup. Locate this block:

```ts
          ${dueDateHtml}
          <span class="tasker-task-chevron" aria-hidden="true">${selected ? "⌃" : "⌄"}</span>
        </div>
```

Replace with (adds a start button for non-done, non-active tasks):

```ts
          ${dueDateHtml}
          ${task.status === "pending"
            ? `<button class="tasker-task-start" type="button" data-project-id="${projectId}" data-task-id="${task.id}" aria-label="Start task">${Icons.play({ size: 12 })}<span>start</span></button>`
            : ""}
          <span class="tasker-task-chevron" aria-hidden="true">${selected ? "⌃" : "⌄"}</span>
        </div>
```

- [ ] **Step 4: Wire the start handler**

In `setupEventListeners()`, after the `.tasker-task-checkbox` handler block, add:

```ts
    this.host.querySelectorAll<HTMLButtonElement>(".tasker-task-start").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const projectId = btn.dataset.projectId;
        const taskId = btn.dataset.taskId;
        if (!projectId || !taskId) return;
        this.storage.updateTask(projectId, taskId, { status: "active" });
        this.render();
      });
    });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/tasker/panel.test.ts ui/src/tasker/panel.ts
git commit -m "feat(tasker): start affordance flips pending tasks to active"
```

---

## Task 2: Checkbox completes any state; reopening a done task clears completedAt

**Files:**
- Modify: `ui/src/tasker/panel.ts` (checkbox handler)
- Modify: `ui/src/tasker/panel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("TaskerPanel status lifecycle", ...)` block:

```ts
  it("checkbox completes an active task and sets completedAt", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    storageOf(panel).updateTask(pid, tid, { status: "active" });
    panel.render();

    host
      .querySelector<HTMLButtonElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-checkbox`)!
      .click();

    const t = storageOf(panel).getTask(pid, tid);
    expect(t.status).toBe("done");
    expect(typeof t.completedAt).toBe("number");
  });

  it("checkbox on a done task reopens it to pending and clears completedAt", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    storageOf(panel).updateTask(pid, tid, { status: "done", completedAt: Date.now() });
    panel.render();

    host
      .querySelector<HTMLButtonElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-checkbox`)!
      .click();

    const t = storageOf(panel).getTask(pid, tid);
    expect(t.status).toBe("pending");
    expect(t.completedAt).toBeUndefined();
  });
```

- [ ] **Step 2: Run tests to verify the active-complete test fails**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: FAIL — current checkbox handler only toggles `done ↔ pending` based on `task.status === "done"`, so completing an **active** task works, but it does not clear `completedAt` on reopen. Confirm which assertion fails (the reopen `completedAt` clear).

- [ ] **Step 3: Update the checkbox handler**

In `setupEventListeners()`, replace the existing `.tasker-task-checkbox` handler body. Find:

```ts
        const status: TaskStatus = task.status === "done" ? "pending" : "done";
        this.storage.updateTask(projectId, taskId, {
          status,
          completedAt: status === "done" ? Date.now() : undefined,
        });
        this.render();
```

Replace with:

```ts
        const done = task.status === "done";
        this.storage.updateTask(projectId, taskId, {
          status: done ? "pending" : "done",
          completedAt: done ? undefined : Date.now(),
        });
        this.render();
```

(Behavior is now explicit: completing from pending **or** active → done with timestamp; reopening a done task → pending with `completedAt` cleared.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: PASS (all status tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/panel.test.ts
git commit -m "feat(tasker): checkbox completes any state; reopen clears completedAt"
```

---

## Task 3: Filters show the correct contents per status

**Files:**
- Modify: `ui/src/tasker/panel.test.ts`

Note: filter logic already exists (`renderProject` filters `t.status === this.currentFilter`). This task locks the behavior with tests and confirms the Active filter is non-empty.

- [ ] **Step 1: Write the failing/locking tests**

Append a new describe block to `ui/src/tasker/panel.test.ts`:

```ts
describe("TaskerPanel filters", () => {
  function setupThree(panel: TaskerPanel): string {
    const pid = inbox(panel);
    const a = addTask(panel, pid, "pending one");
    const b = addTask(panel, pid, "active one");
    const c = addTask(panel, pid, "done one");
    storageOf(panel).updateTask(pid, b, { status: "active" });
    storageOf(panel).updateTask(pid, c, { status: "done", completedAt: Date.now() });
    return pid;
  }

  function visibleTitles(host: HTMLElement): string[] {
    return Array.from(host.querySelectorAll(".tasker-task-title")).map(
      (el) => el.textContent ?? "",
    );
  }

  it("Active filter shows only active tasks", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.tasker-filter-btn[data-filter="active"]')!.click();
    expect(visibleTitles(host)).toEqual(["active one"]);
  });

  it("Pending filter shows only pending tasks", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.tasker-filter-btn[data-filter="pending"]')!.click();
    expect(visibleTitles(host)).toEqual(["pending one"]);
  });

  it("All filter shows every task", () => {
    const { panel, host } = mount();
    setupThree(panel);
    host.querySelector<HTMLButtonElement>('.tasker-filter-btn[data-filter="all"]')!.click();
    expect(visibleTitles(host).sort()).toEqual(["active one", "done one", "pending one"]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: PASS (filter logic already present). If any fails, fix `renderProject`'s filter so it compares `t.status === this.currentFilter` for non-`all` filters — do not change the data model.

- [ ] **Step 3: Commit**

```bash
git add ui/src/tasker/panel.test.ts
git commit -m "test(tasker): lock filter-by-status behavior"
```

---

## Task 4: Status popover inside the open task sets state directly

**Files:**
- Modify: `ui/src/tasker/panel.ts`
- Modify: `ui/src/tasker/panel.test.ts`

This replaces the heavy detail form's status concept with a chip + popover. We build the new inline edit block in this task and Task 5.

- [ ] **Step 1: Write the failing test**

Append a new describe block:

```ts
describe("TaskerPanel inline edit", () => {
  function openTask(host: HTMLElement, tid: string): void {
    host
      .querySelector<HTMLElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-main`)!
      .click();
  }

  it("status chip popover sets the task to active", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);

    host.querySelector<HTMLButtonElement>(".tasker-chip-status")!.click();
    host
      .querySelector<HTMLButtonElement>('.tasker-menu-item[data-status="active"]')!
      .click();

    expect(storageOf(panel).getTask(pid, tid).status).toBe("active");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: FAIL — `.tasker-chip-status` does not exist yet (old `renderTaskDetails` renders a form, not chips).

- [ ] **Step 3: Replace `renderTaskDetails` with the inline edit block**

In `ui/src/tasker/panel.ts`, replace the entire `renderTaskDetails(projectId, task)` method body with:

```ts
  private renderTaskDetails(projectId: string, task: Task): string {
    const statusLabel = titleCase(task.status);
    const statusDot = `tasker-status-${task.status}`;
    const dueLabel = task.dueDate ? formatDueDate(task.dueDate) : "Add date";
    const open = this.openMenu;
    const isStatusOpen = open?.kind === "status" && open.taskId === task.id;
    const isPriorityOpen = open?.kind === "priority" && open.taskId === task.id;
    const isDateOpen = open?.kind === "date" && open.taskId === task.id;

    return `
      <div class="tasker-edit" data-project-id="${projectId}" data-task-id="${task.id}">
        <textarea class="tasker-edit-note" rows="1" placeholder="Add notes, links, acceptance criteria…">${escapeHtml(task.description ?? "")}</textarea>
        <div class="tasker-chip-row">
          <div class="tasker-chip-wrap">
            <button class="tasker-chip tasker-chip-status" type="button">
              <span class="tasker-status-dot ${statusDot}"></span>${statusLabel}
            </button>
            ${isStatusOpen ? this.renderStatusMenu() : ""}
          </div>
          <div class="tasker-chip-wrap">
            <button class="tasker-chip tasker-chip-priority" type="button">
              <span class="tasker-priority ${getPriorityClass(task.priority)}"></span>${titleCase(task.priority)}
            </button>
            ${isPriorityOpen ? this.renderPriorityMenu() : ""}
          </div>
          <div class="tasker-chip-wrap">
            <button class="tasker-chip tasker-chip-due" type="button">${escapeHtml(dueLabel)}</button>
            ${isDateOpen ? `<div class="tasker-menu tasker-date-menu"><input class="tasker-edit-date" type="date" value="${dateInputValue(task.dueDate)}" /></div>` : ""}
          </div>
          <button class="tasker-chip tasker-chip-delete" type="button" aria-label="Delete task">${Icons.trash({ size: 12 })}</button>
        </div>
      </div>
    `;
  }

  private renderStatusMenu(): string {
    const statuses: TaskStatus[] = ["pending", "active", "done"];
    return `
      <div class="tasker-menu tasker-status-menu" role="menu">
        ${statuses.map((s) => `
          <button class="tasker-menu-item" type="button" data-status="${s}" role="menuitem">
            <span class="tasker-status-dot tasker-status-${s}"></span>${titleCase(s)}
          </button>
        `).join("")}
      </div>
    `;
  }

  private renderPriorityMenu(): string {
    return `
      <div class="tasker-menu tasker-priority-menu" role="menu">
        ${PRIORITIES.map((p) => `
          <button class="tasker-menu-item" type="button" data-priority="${p}" role="menuitem">
            <span class="tasker-priority ${getPriorityClass(p)}"></span>${titleCase(p)}
          </button>
        `).join("")}
      </div>
    `;
  }
```

- [ ] **Step 4: Add the `openMenu` field**

Near the other private fields at the top of the class (after `selectedTask`), add:

```ts
  private openMenu: { kind: "status" | "priority" | "date"; taskId: string } | null = null;
```

- [ ] **Step 5: Replace `bindDetailsEvents` with chip/menu wiring**

Replace the entire `bindDetailsEvents()` method with:

```ts
  private bindDetailsEvents(): void {
    this.host.querySelectorAll<HTMLElement>(".tasker-edit").forEach((edit) => {
      const projectId = edit.dataset.projectId;
      const taskId = edit.dataset.taskId;
      if (!projectId || !taskId) return;

      const note = edit.querySelector<HTMLTextAreaElement>(".tasker-edit-note");
      note?.addEventListener("change", (e) => {
        const description = (e.target as HTMLTextAreaElement).value.trim();
        this.storage.updateTask(projectId, taskId, {
          description: description.length > 0 ? description : undefined,
        });
        this.render();
      });
      note?.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      });

      edit.querySelector<HTMLButtonElement>(".tasker-chip-status")?.addEventListener("click", () => {
        this.toggleMenu("status", taskId);
      });
      edit.querySelector<HTMLButtonElement>(".tasker-chip-priority")?.addEventListener("click", () => {
        this.toggleMenu("priority", taskId);
      });
      edit.querySelector<HTMLButtonElement>(".tasker-chip-due")?.addEventListener("click", () => {
        this.toggleMenu("date", taskId);
      });

      edit.querySelectorAll<HTMLButtonElement>(".tasker-status-menu .tasker-menu-item").forEach((mi) => {
        mi.addEventListener("click", () => {
          const status = mi.dataset.status as TaskStatus | undefined;
          if (!status) return;
          this.storage.updateTask(projectId, taskId, {
            status,
            completedAt: status === "done" ? Date.now() : undefined,
          });
          this.openMenu = null;
          this.render();
        });
      });

      edit.querySelectorAll<HTMLButtonElement>(".tasker-priority-menu .tasker-menu-item").forEach((mi) => {
        mi.addEventListener("click", () => {
          const priority = mi.dataset.priority as TaskPriority | undefined;
          if (!priority) return;
          this.storage.updateTask(projectId, taskId, { priority });
          this.openMenu = null;
          this.render();
        });
      });

      edit.querySelector<HTMLInputElement>(".tasker-edit-date")?.addEventListener("change", (e) => {
        const value = (e.target as HTMLInputElement).value;
        this.storage.updateTask(projectId, taskId, {
          dueDate: value ? new Date(`${value}T00:00:00`).getTime() : undefined,
        });
        this.openMenu = null;
        this.render();
      });

      edit.querySelector<HTMLButtonElement>(".tasker-chip-delete")?.addEventListener("click", () => {
        this.storage.deleteTask(projectId, taskId);
        this.selectedTask = null;
        this.openMenu = null;
        this.render();
      });
    });
  }

  private toggleMenu(kind: "status" | "priority" | "date", taskId: string): void {
    const same = this.openMenu?.kind === kind && this.openMenu.taskId === taskId;
    this.openMenu = same ? null : { kind, taskId };
    this.render();
  }
```

- [ ] **Step 6: Clear `openMenu` when a task collapses**

In `setupEventListeners()`, inside the `.tasker-task-main` `toggle` function, after computing `isSame`, set the menu closed. Replace:

```ts
        this.selectedTask = isSame ? null : { projectId, taskId };
        this.render();
```

with:

```ts
        this.selectedTask = isSame ? null : { projectId, taskId };
        this.openMenu = null;
        this.render();
```

- [ ] **Step 7: Run test to verify it passes**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: PASS.

- [ ] **Step 8: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0. (The old `renderTaskDetails` form markup and its `.tasker-detail-*` handlers are fully replaced; ensure no dangling references remain.)

- [ ] **Step 9: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/panel.test.ts
git commit -m "feat(tasker): inline edit block with status/priority/due popovers"
```

---

## Task 5: Inline edit — title-in-place, priority, due set/clear, delete

**Files:**
- Modify: `ui/src/tasker/panel.ts` (title-in-place rendering + handler)
- Modify: `ui/src/tasker/panel.test.ts`

The detail block from Task 4 covers note/priority/due/delete. This task adds **edit-title-in-place** (clicking the title text turns it into an input) and locks priority/due/delete with tests.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe("TaskerPanel inline edit", ...)` block:

```ts
  it("priority popover updates the task priority", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);
    host.querySelector<HTMLButtonElement>(".tasker-chip-priority")!.click();
    host.querySelector<HTMLButtonElement>('.tasker-menu-item[data-priority="high"]')!.click();
    expect(storageOf(panel).getTask(pid, tid).priority).toBe("high");
  });

  it("due-date input sets and clears dueDate", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);

    host.querySelector<HTMLButtonElement>(".tasker-chip-due")!.click();
    const dateInput = host.querySelector<HTMLInputElement>(".tasker-edit-date")!;
    dateInput.value = "2026-06-09";
    dateInput.dispatchEvent(new Event("change"));
    expect(typeof storageOf(panel).getTask(pid, tid).dueDate).toBe("number");

    openTask(host, tid); // collapse
    openTask(host, tid); // re-open (openMenu reset)
    host.querySelector<HTMLButtonElement>(".tasker-chip-due")!.click();
    const dateInput2 = host.querySelector<HTMLInputElement>(".tasker-edit-date")!;
    dateInput2.value = "";
    dateInput2.dispatchEvent(new Event("change"));
    expect(storageOf(panel).getTask(pid, tid).dueDate).toBeUndefined();
  });

  it("delete chip removes the task", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);
    host.querySelector<HTMLButtonElement>(".tasker-chip-delete")!.click();
    expect(storageOf(panel).getTask(pid, tid)).toBeNull();
  });

  it("clicking the title turns it into an editable input that commits on change", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();

    host
      .querySelector<HTMLElement>(`.tasker-task[data-task-id="${tid}"] .tasker-task-title`)!
      .click();
    const input = host.querySelector<HTMLInputElement>(
      `.tasker-task[data-task-id="${tid}"] .tasker-title-input`,
    )!;
    expect(input).toBeTruthy();
    input.value = "Deploy API to Pulzen";
    input.dispatchEvent(new Event("change"));

    expect(storageOf(panel).getTask(pid, tid).title).toBe("Deploy API to Pulzen");
  });
```

- [ ] **Step 2: Run tests to verify the title test fails**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: priority/due/delete PASS (from Task 4); the title-in-place test FAILS — `.tasker-title-input` does not exist and clicking the title currently toggles the row open.

- [ ] **Step 3: Add an editing-title state field**

After the `openMenu` field, add:

```ts
  private editingTitle: { projectId: string; taskId: string } | null = null;
```

- [ ] **Step 4: Render the title as an input when editing**

In `renderTask()`, replace the title span:

```ts
          <span class="tasker-task-title">${escapeHtml(task.title)}</span>
```

with:

```ts
          ${this.editingTitle?.taskId === task.id && this.editingTitle.projectId === projectId
            ? `<input class="tasker-title-input" type="text" value="${escapeAttr(task.title)}" autocomplete="off" />`
            : `<span class="tasker-task-title" role="button" tabindex="0">${escapeHtml(task.title)}</span>`}
```

- [ ] **Step 5: Wire title click → edit, and commit on change/Enter**

In `setupEventListeners()`, before `this.bindDetailsEvents();`, add:

```ts
    this.host.querySelectorAll<HTMLElement>(".tasker-task-title").forEach((titleEl) => {
      const enter = (e: Event): void => {
        e.stopPropagation();
        const taskEl = (e.currentTarget as HTMLElement).closest<HTMLElement>(".tasker-task");
        const projectId = taskEl?.dataset.projectId;
        const taskId = taskEl?.dataset.taskId;
        if (!projectId || !taskId) return;
        this.editingTitle = { projectId, taskId };
        this.render();
      };
      titleEl.addEventListener("click", enter);
      titleEl.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") enter(e);
      });
    });

    this.host.querySelectorAll<HTMLInputElement>(".tasker-title-input").forEach((input) => {
      const commit = (): void => {
        const taskEl = input.closest<HTMLElement>(".tasker-task");
        const projectId = taskEl?.dataset.projectId;
        const taskId = taskEl?.dataset.taskId;
        const title = input.value.trim();
        this.editingTitle = null;
        if (projectId && taskId && title.length > 0) {
          this.storage.updateTask(projectId, taskId, { title });
        }
        this.render();
      };
      input.addEventListener("change", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.editingTitle = null;
          this.render();
        }
      });
      queueMicrotask(() => input.focus());
    });
```

Note: because the title is now its own click target that stops propagation, it no longer toggles the row open — the rest of `.tasker-task-main` still does.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: PASS (all inline-edit tests).

- [ ] **Step 7: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/panel.test.ts
git commit -m "feat(tasker): edit title in place; lock priority/due/delete behavior"
```

---

## Task 6: Inline list composer replaces native prompt()

**Files:**
- Modify: `ui/src/tasker/panel.ts`
- Modify: `ui/src/tasker/panel.test.ts`

- [ ] **Step 1: Write the failing tests**

Append a new describe block:

```ts
describe("TaskerPanel new-list composer", () => {
  it("does not call window.prompt and creates a project from the inline composer", () => {
    const promptSpy = vi.spyOn(window, "prompt");
    const { panel, host } = mount();

    host.querySelector<HTMLButtonElement>(".tasker-btn-new-project")!.click();
    const input = host.querySelector<HTMLInputElement>(".tasker-newlist-input")!;
    expect(input).toBeTruthy();
    input.value = "Roadmap";
    input.dispatchEvent(new Event("change"));

    const names = storageOf(panel).getProjects().map((p: any) => p.name);
    expect(names).toContain("Roadmap");
    expect(promptSpy).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });

  it("Escape cancels the composer without creating a project", () => {
    const { panel, host } = mount();
    const before = storageOf(panel).getProjects().length;
    host.querySelector<HTMLButtonElement>(".tasker-btn-new-project")!.click();
    const input = host.querySelector<HTMLInputElement>(".tasker-newlist-input")!;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(host.querySelector(".tasker-newlist-input")).toBeNull();
    expect(storageOf(panel).getProjects().length).toBe(before);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: FAIL — `.tasker-newlist-input` does not exist; `.tasker-btn-new-project` currently calls `prompt()`.

- [ ] **Step 3: Add composer state field**

After `editingTitle`, add:

```ts
  private composingList = false;
```

- [ ] **Step 4: Render the composer in the header area**

In `render()`, locate the `.tasker-filters` block and insert the composer immediately after it (before `.tasker-projects`):

```ts
        ${this.composingList ? `
          <form class="tasker-newlist">
            <input class="tasker-newlist-input" type="text" autocomplete="off" placeholder="New list name…" />
          </form>
        ` : ""}
```

- [ ] **Step 5: Replace `showNewProjectDialog()` with composer toggle**

Replace the entire `showNewProjectDialog()` method body with:

```ts
  private showNewProjectDialog(): void {
    this.composingList = true;
    this.render();
  }
```

- [ ] **Step 6: Wire the composer events**

In `setupEventListeners()`, after the `.tasker-btn-new-project` handler, add:

```ts
    const newListForm = this.host.querySelector<HTMLFormElement>(".tasker-newlist");
    const newListInput = this.host.querySelector<HTMLInputElement>(".tasker-newlist-input");
    const commitNewList = (): void => {
      const name = newListInput?.value.trim() ?? "";
      this.composingList = false;
      if (name.length > 0) {
        const project = this.storage.createProject(name);
        this.expandedProjects.add(project.id);
        this.saveExpandedProjects();
      }
      this.render();
    };
    newListForm?.addEventListener("submit", (e) => {
      e.preventDefault();
      commitNewList();
    });
    newListInput?.addEventListener("change", commitNewList);
    newListInput?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.composingList = false;
        this.render();
      }
    });
    if (newListInput) queueMicrotask(() => newListInput.focus());
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/panel.test.ts
git commit -m "feat(tasker): inline list composer replaces native prompt()"
```

---

## Task 7: Restyle against Covenant tokens (flat rows, popovers, uppercase, start affordance)

**Files:**
- Modify: `ui/src/tasker/styles.css`

No new tests (visual). Verify with typecheck + full test run + a manual look.

- [ ] **Step 1: Replace token fallbacks and hardcoded grays**

In `ui/src/tasker/styles.css`, do a pass replacing wrong/non-existent tokens:
- Every `var(--text, #...)` → `var(--text-primary)`.
- Every `var(--text-secondary, #...)` → `var(--text-secondary)`.
- Every `var(--text-tertiary, #...)` → `var(--text-tertiary)`.
- Every `var(--accent, #6aa9ff)` and the raw `#3b82f6` in `.tasker-filter-btn.active` → `var(--accent)`.
- Every `color-mix(in srgb, var(--text) N%, transparent)` → `color-mix(in srgb, var(--text-primary) N%, transparent)`.
- Every `var(--border, #...)`, `var(--border-subtle, #...)`, `var(--border-hover, #...)` → `var(--border)` (Covenant uses a single `--border`; drop the `-subtle`/`-hover` variants in favor of `--border` plus `color-mix` tints where a hover border is needed, e.g. `color-mix(in srgb, var(--text-primary) 14%, var(--border))`).

- [ ] **Step 2: Flatten task rows**

Replace the `.tasker-task` rule:

```css
.tasker-task {
  display: flex;
  flex-direction: column;
  border-radius: 6px;
  background: var(--pn-subtle-1, rgb(var(--ink-rgb, 255 255 255) / 0.02));
  border: 1px solid var(--border, #2a2d35);
  color: var(--text, #d5d9de);
  overflow: hidden;
  transition: border-color 120ms, background 120ms;
}
```

with (no per-row border; flat surface):

```css
.tasker-task {
  display: flex;
  flex-direction: column;
  border-radius: 8px;
  background: transparent;
  color: var(--text-primary);
  overflow: hidden;
  transition: background 120ms;
}
```

And replace the hover/selected rule:

```css
.tasker-task:hover,
.tasker-task-selected {
  border-color: color-mix(in srgb, var(--accent, #6aa9ff) 40%, var(--border, #2a2d35));
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
```

with:

```css
.tasker-task:hover {
  background: color-mix(in srgb, var(--text-primary) 3.5%, transparent);
}
.tasker-task-selected {
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}
```

- [ ] **Step 3: Active task accent stripe**

Add a status class hook. In `renderTask()` the wrapper already gets `tasker-task-status-${task.status}`, so add this CSS:

```css
.tasker-task-status-active {
  position: relative;
}
.tasker-task-status-active::before {
  content: "";
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 2px;
  border-radius: 2px;
  background: var(--accent);
}
```

- [ ] **Step 4: Start affordance + chip styles**

Append:

```css
.tasker-task-start {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  padding: 2px 6px;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono, var(--ui-font));
  font-size: 10px;
  cursor: pointer;
  opacity: 0;
  transition: opacity 120ms, color 120ms;
}
.tasker-task:hover .tasker-task-start {
  opacity: 1;
}
.tasker-task-start:hover {
  color: var(--accent);
}

.tasker-edit {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 2px 12px 12px 38px;
}
.tasker-edit-note {
  width: 100%;
  min-height: 24px;
  resize: vertical;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  padding: 6px 0 9px;
  color: var(--text-primary);
  font-family: var(--ui-font);
  font-size: 12px;
  line-height: 1.45;
  outline: none;
}
.tasker-edit-note::placeholder { color: var(--text-tertiary); }

.tasker-chip-row {
  display: flex;
  align-items: center;
  gap: 7px;
  flex-wrap: wrap;
}
.tasker-chip-wrap { position: relative; }
.tasker-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: transparent;
  color: var(--text-primary);
  padding: 4px 8px;
  font-family: var(--font-mono, var(--ui-font));
  font-size: 11px;
  cursor: pointer;
  transition: border-color 120ms;
}
.tasker-chip:hover {
  border-color: color-mix(in srgb, var(--text-primary) 14%, var(--border));
}
.tasker-chip-delete {
  margin-left: auto;
  color: #f87171;
  border-color: color-mix(in srgb, #f87171 30%, var(--border));
}
.tasker-chip-delete:hover { background: color-mix(in srgb, #f87171 10%, transparent); }

.tasker-status-dot {
  width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0;
}
.tasker-status-pending { background: var(--text-tertiary); }
.tasker-status-active { background: var(--accent); }
.tasker-status-done { background: #22c55e; }

.tasker-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 130px;
  padding: 4px;
  background: color-mix(in srgb, var(--text-primary) 6%, var(--sidebar-bg));
  border: 1px solid var(--border);
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45);
}
.tasker-menu-item {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 7px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-primary);
  font-family: var(--font-mono, var(--ui-font));
  font-size: 11px;
  cursor: pointer;
  text-align: left;
}
.tasker-menu-item:hover {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.tasker-date-menu { padding: 6px; }
.tasker-edit-date {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  color: var(--text-primary);
  font-family: var(--ui-font);
  font-size: 12px;
  outline: none;
}

.tasker-newlist { padding: 0 12px 8px; }
.tasker-newlist-input {
  width: 100%;
  background: color-mix(in srgb, var(--text-primary) 4%, transparent);
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 7px 9px;
  color: var(--text-primary);
  font-family: var(--ui-font);
  font-size: 12px;
  outline: none;
}
.tasker-newlist-input:focus { border-color: var(--accent); }

.tasker-title-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--accent);
  border-radius: 0;
  padding: 0 0 2px;
  color: var(--text-primary);
  font-family: var(--ui-font);
  font-size: 12px;
  font-weight: 500;
  outline: none;
}
```

- [ ] **Step 5: Uppercase list names via CSS + active filter color**

Replace the `.tasker-filter-btn.active` rule:

```css
.tasker-filter-btn.active {
  background: var(--accent, #3b82f6);
  color: white;
  border-color: var(--accent, #3b82f6);
}
```

with (token accent, softer tint matching other Covenant active states):

```css
.tasker-filter-btn.active {
  background: color-mix(in srgb, var(--accent) 18%, transparent);
  color: var(--text-primary);
  border-color: color-mix(in srgb, var(--accent) 48%, var(--border));
}
```

And ensure `.tasker-project-name` is uppercase via CSS (house rule):

```css
.tasker-project-name {
  flex: 1;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}
```

- [ ] **Step 6: Remove now-dead CSS**

Delete these obsolete rules (their markup no longer exists after Task 4): `.tasker-details`, `.tasker-detail-field`, `.tasker-detail-field > span`, `.tasker-detail-title`, `.tasker-detail-date`, `.tasker-detail-description`, the `:focus` group for those, `.tasker-priority-options`, `.tasker-priority-option`(+`:hover`/`.active`), `.tasker-detail-actions`, `.tasker-detail-delete`(+`:hover`). Keep `.tasker-priority` and the `.tasker-priority-low/normal/high/urgent` dot colors (still used by chips/menus).

- [ ] **Step 7: Verify build + tests + manual look**

Run: `npx tsc --noEmit` → exit 0.
Run: `npx vitest run ui/src/tasker/panel.test.ts` → PASS.
Manual: with `npm run tauri:dev` running, open the Tasker rail, confirm: flat rows, soft accent on active filter, start affordance on hover, popovers themed, list names uppercase, no nested boxes. (Vite HMR picks up CSS; no respawn needed.)

- [ ] **Step 8: Commit**

```bash
git add ui/src/tasker/styles.css
git commit -m "style(tasker): Covenant tokens, flat rows, popovers, uppercase lists"
```

---

## Task 8: Full verification + finalize

**Files:** none (verification only)

- [ ] **Step 1: Full frontend test suite**

Run: `npx vitest run`
Expected: all suites pass (including the existing 365 + new tasker tests).

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit`
Expected: exit 0.

- [ ] **Step 3: Confirm no `prompt(`/`--text,`/`#3b82f6` regressions remain in tasker**

Run: `grep -rn "prompt(\|var(--text," ui/src/tasker/ ; grep -rn "#3b82f6" ui/src/tasker/`
Expected: no matches (prompt removed; `--text` token references gone; raw blue gone). `var(--text-primary` / `--text-secondary` / `--text-tertiary` are fine.

- [ ] **Step 4: Final commit (if grep surfaced stragglers, fix then commit)**

```bash
git add -A ui/src/tasker/
git commit -m "chore(tasker): redesign cleanup — verified tokens, no native prompt"
```

---

## Self-Review notes

- **Spec coverage:** visual tokens/flat (Task 7) · task row + start (Tasks 1,7) · status model start/complete/reopen/chip (Tasks 1,2,4) · filters (Task 3) · inline edit note/title/priority/due/delete (Tasks 4,5) · new-list composer, no prompt (Task 6) · testing (every task) · out-of-scope fields untouched (no task adds subtasks/tags/recurrence). All covered.
- **Type consistency:** `openMenu` kinds `"status"|"priority"|"date"`, `editingTitle`/`composingList` used identically across render + handlers; `TaskStatus`/`TaskPriority` imports already present in `panel.ts`; storage methods (`updateTask`, `createTask`, `createProject`, `deleteTask`, `getTask`, `getProjects`) match `storage.ts` signatures.
- **No placeholders:** every code step shows complete code; every run step shows command + expected result.
