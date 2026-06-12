# Tasker Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Tasker right-rail into a clean linear/dense layout with inline-edited task detail (segmented status, priority dots, calendar Due), and fix the custom date picker so it renders by portaling it to `document.body`.

**Architecture:** All work is in `ui/src/tasker/panel.ts` (markup + event wiring) and `ui/src/tasker/styles.css` (visual language). The data model (`storage.ts`, `types.ts`) is untouched. The expanded task detail becomes a key:value "sheet"; status/priority popover menus are replaced by always-visible inline controls; the date picker is portaled to `<body>` to escape `overflow:hidden` / `transform` clipping. Tests in `ui/src/tasker/panel.test.ts` are updated to the new markup.

**Tech Stack:** TypeScript (strict), template-string rendering, Vitest + jsdom, vanilla DOM.

**Run tests with:** `npx vitest run ui/src/tasker/panel.test.ts` (from repo root — vitest config lives at root).

---

### Task 1: Portal the date picker to `document.body` (bug fix)

The custom calendar already exists but is clipped by `.tasker-task { overflow:hidden }` and the panel's `transform`. Move it out of the task subtree into `<body>`.

**Files:**
- Modify: `ui/src/tasker/panel.ts` (renderTaskDetails date menu, bindDetailsEvents date handlers, positionDateMenu)
- Modify: `ui/src/tasker/styles.css` (`.tasker-date-menu`)
- Test: `ui/src/tasker/panel.test.ts`

- [ ] **Step 1: Update the existing date test to query the portaled calendar**

In `panel.test.ts`, the "calendar sets and clears dueDate" test currently queries inside `host`. The calendar will live on `document.body`. Replace its body with:

```ts
  it("calendar sets and clears dueDate", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Deploy API");
    panel.render();
    openTask(host, tid);

    host.querySelector<HTMLButtonElement>(".tasker-chip-due")!.click();
    const day = document.querySelector<HTMLButtonElement>('.tasker-date-menu .tasker-cal-day[data-date="2026-06-09"]')!;
    expect(day).toBeTruthy();
    day.click();
    expect(typeof storageOf(panel).getTask(pid, tid).dueDate).toBe("number");

    host.querySelector<HTMLButtonElement>(".tasker-chip-due")!.click();
    document.querySelector<HTMLButtonElement>(".tasker-date-menu .tasker-cal-clear")!.click();
    expect(storageOf(panel).getTask(pid, tid).dueDate).toBeUndefined();
  });
```

Also add an afterEach cleanup so portaled nodes don't leak between tests — add near the top `describe` body if not present:

```ts
  afterEach(() => {
    document.querySelectorAll(".tasker-date-menu").forEach((n) => n.remove());
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/tasker/panel.test.ts -t "calendar sets and clears"`
Expected: FAIL (calendar still rendered under `host`, `document.querySelector('.tasker-date-menu …')` is null).

- [ ] **Step 3: Stop rendering the calendar inline; add a portal field**

In `panel.ts`, add a field near the other state (after `private dateView`):

```ts
  private dateMenuEl: HTMLElement | null = null;
```

In `renderTaskDetails`, remove the inline calendar so the wrap only holds the chip:

```ts
          <div class="tasker-chip-wrap">
            <button class="tasker-chip tasker-chip-due${task.dueDate ? " tasker-chip-due-set" : ""}" type="button">${escapeHtml(dueLabel)}</button>
          </div>
```

(`isDateOpen` is no longer used in render — remove that line in `renderTaskDetails`.)

- [ ] **Step 4: Add open/close/portal helpers**

In `panel.ts`, replace the `.tasker-chip-due` click handler and the `cal` block in `bindDetailsEvents` with an open call, and add the helpers. The chip handler becomes:

```ts
      edit.querySelector<HTMLButtonElement>(".tasker-chip-due")?.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openDatePicker(projectId, taskId, e.currentTarget as HTMLElement);
      });
```

Add these methods (replace the old `positionDateMenu`):

```ts
  private closeDatePicker(): void {
    this.dateMenuEl?.remove();
    this.dateMenuEl = null;
    this.dateView = null;
    this.openMenu = null;
  }

  private openDatePicker(projectId: string, taskId: string, anchor: HTMLElement): void {
    if (this.dateMenuEl) { this.closeDatePicker(); return; }
    const task = this.storage.getTask(projectId, taskId);
    if (!task) return;
    const base = task.dueDate ? new Date(task.dueDate) : new Date();
    this.dateView = { year: base.getFullYear(), month: base.getMonth() };
    this.openMenu = { kind: "date", taskId };

    const el = document.createElement("div");
    el.className = "tasker-menu tasker-date-menu";
    document.body.appendChild(el);
    this.dateMenuEl = el;

    const paint = (): void => {
      const t = this.storage.getTask(projectId, taskId);
      if (!t) { this.closeDatePicker(); return; }
      el.innerHTML = this.dateCalendarHtml(t);
      this.bindDateCalendar(el, projectId, taskId);
      this.positionDateMenu(anchor, el);
    };
    this.datePickerRepaint = paint;
    paint();

    const onOutside = (ev: MouseEvent): void => {
      const target = ev.target as HTMLElement;
      if (el.contains(target) || anchor.contains(target)) return;
      document.removeEventListener("mousedown", onOutside, true);
      this.closeDatePicker();
    };
    queueMicrotask(() => document.addEventListener("mousedown", onOutside, true));
  }
```

Add the repaint field near `dateMenuEl`:

```ts
  private datePickerRepaint: (() => void) | null = null;
```

- [ ] **Step 5: Split calendar render + bind into reusable methods**

Rename `renderDateMenu(task)` body into `dateCalendarHtml(task)` returning ONLY the inner markup (no outer `.tasker-menu` wrapper, since `openDatePicker` creates it):

```ts
  private dateCalendarHtml(task: Task): string {
    const base = task.dueDate ? new Date(task.dueDate) : new Date();
    const view = this.dateView ?? { year: base.getFullYear(), month: base.getMonth() };
    const selected = task.dueDate ? ymd(new Date(task.dueDate)) : "";
    const today = ymd(new Date());
    const cells = calendarCells(view.year, view.month);
    return `
      <div class="tasker-cal-head">
        <span class="tasker-cal-title">${MONTHS[view.month]} ${view.year}</span>
        <div class="tasker-cal-nav">
          <button class="tasker-cal-prev" type="button" aria-label="Previous month">‹</button>
          <button class="tasker-cal-today" type="button">Today</button>
          <button class="tasker-cal-next" type="button" aria-label="Next month">›</button>
        </div>
      </div>
      <div class="tasker-cal-grid">
        ${WEEKDAYS.map((w) => `<span class="tasker-cal-wd">${w}</span>`).join("")}
        ${cells.map((c) => {
          const cls = ["tasker-cal-day", c.outside ? "tasker-cal-out" : "",
            c.date === today ? "tasker-cal-is-today" : "", c.date === selected ? "tasker-cal-sel" : ""]
            .filter(Boolean).join(" ");
          return `<button class="${cls}" type="button" data-date="${c.date}">${c.day}</button>`;
        }).join("")}
      </div>
      ${task.dueDate ? `<button class="tasker-cal-clear" type="button">Clear date</button>` : ""}
    `;
  }

  private bindDateCalendar(el: HTMLElement, projectId: string, taskId: string): void {
    const shift = (delta: number): void => {
      const v = this.dateView ?? { year: new Date().getFullYear(), month: new Date().getMonth() };
      const d = new Date(v.year, v.month + delta, 1);
      this.dateView = { year: d.getFullYear(), month: d.getMonth() };
      this.datePickerRepaint?.();
    };
    el.querySelector<HTMLButtonElement>(".tasker-cal-prev")?.addEventListener("click", () => shift(-1));
    el.querySelector<HTMLButtonElement>(".tasker-cal-next")?.addEventListener("click", () => shift(1));
    el.querySelector<HTMLButtonElement>(".tasker-cal-today")?.addEventListener("click", () => {
      const n = new Date();
      this.dateView = { year: n.getFullYear(), month: n.getMonth() };
      this.datePickerRepaint?.();
    });
    el.querySelector<HTMLButtonElement>(".tasker-cal-clear")?.addEventListener("click", () => {
      this.storage.updateTask(projectId, taskId, { dueDate: undefined });
      this.closeDatePicker();
      this.render();
    });
    el.querySelectorAll<HTMLButtonElement>(".tasker-cal-day").forEach((btn) => {
      btn.addEventListener("click", () => {
        const value = btn.dataset.date;
        if (!value) return;
        this.storage.updateTask(projectId, taskId, { dueDate: new Date(`${value}T00:00:00`).getTime() });
        this.closeDatePicker();
        this.render();
      });
    });
  }
```

Keep `positionDateMenu(anchor, cal)` but change its signature to take the anchor element directly:

```ts
  private positionDateMenu(anchor: HTMLElement, cal: HTMLElement): void {
    const r = anchor.getBoundingClientRect();
    const margin = 8;
    const calW = cal.offsetWidth || 232;
    const calH = cal.offsetHeight || 280;
    let left = r.left;
    if (left + calW > window.innerWidth - margin) left = Math.max(margin, window.innerWidth - margin - calW);
    let top = r.bottom + 4;
    if (top + calH > window.innerHeight - margin) top = Math.max(margin, r.top - 4 - calH);
    cal.style.left = `${Math.round(left)}px`;
    cal.style.top = `${Math.round(top)}px`;
  }
```

Delete the old `renderDateMenu`, the old `cal` block, and the `positionDateMenu(edit, cal)` call site. In `render()`'s outside-click handler, also close the portal: at the top of that handler (or in `closeDatePicker` already), ensure `this.dateMenuEl` is removed when the panel re-renders — add to the start of `render()`:

```ts
    if (this.dateMenuEl && !this.openMenu) this.closeDatePicker();
```

(Place it before the host innerHTML is rebuilt.)

- [ ] **Step 6: CSS — date menu is body-level fixed**

In `styles.css`, the `.tasker-date-menu` rule already sets `position: fixed`. Ensure it also has a high z-index and theme background (it relies on `.tasker-menu`, which won't apply at body level). Replace the `.tasker-date-menu` block with a self-contained one:

```css
.tasker-date-menu {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: 232px;
  padding: 8px;
  background: color-mix(in srgb, var(--text-primary) 6%, var(--sidebar-bg));
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 12px 34px rgba(0, 0, 0, 0.5);
  font-family: var(--ui-font);
}
```

- [ ] **Step 7: Run the date test**

Run: `npx vitest run ui/src/tasker/panel.test.ts -t "calendar sets and clears"`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/styles.css ui/src/tasker/panel.test.ts
git commit -m "fix(tasker): portal date picker to body so it isn't clipped"
```

---

### Task 2: Status as an inline segmented switch

Replace the status chip + popover with a 3-segment switch in the detail sheet.

**Files:**
- Modify: `ui/src/tasker/panel.ts` (renderTaskDetails, bindDetailsEvents, remove renderStatusMenu)
- Modify: `ui/src/tasker/styles.css`
- Test: `ui/src/tasker/panel.test.ts`

- [ ] **Step 1: Update the status test**

Find the existing status test (it clicks `.tasker-chip-status` then a menu item). Replace its interaction with the segment:

```ts
  it("status segmented switch updates status", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Ship it");
    panel.render();
    openTask(host, tid);

    host.querySelector<HTMLButtonElement>('.tasker-seg-status [data-status="active"]')!.click();
    expect(storageOf(panel).getTask(pid, tid).status).toBe("active");

    openTask(host, tid); openTask(host, tid); // ensure still rendered
    host.querySelector<HTMLButtonElement>('.tasker-seg-status [data-status="done"]')!.click();
    expect(storageOf(panel).getTask(pid, tid).status).toBe("done");
    expect(typeof storageOf(panel).getTask(pid, tid).completedAt).toBe("number");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run ui/src/tasker/panel.test.ts -t "status segmented"`
Expected: FAIL (`.tasker-seg-status` not found).

- [ ] **Step 3: Render the segmented switch**

In `renderTaskDetails`, replace the status chip-wrap block with a key:value row:

```ts
          <div class="tasker-kv">
            <span class="tasker-kv-key">Status</span>
            <div class="tasker-seg tasker-seg-status" role="group">
              ${(["pending","active","done"] as TaskStatus[]).map((s) =>
                `<button class="tasker-seg-btn${task.status === s ? " on" : ""}" type="button" data-status="${s}">${titleCase(s)}</button>`
              ).join("")}
            </div>
          </div>
```

Remove `isStatusOpen` and the `renderStatusMenu()` call from `renderTaskDetails`.

- [ ] **Step 4: Wire the segments; delete old status handlers**

In `bindDetailsEvents`, remove the `.tasker-chip-status` click handler and the `.tasker-status-menu .tasker-menu-item` loop. Add:

```ts
      edit.querySelectorAll<HTMLButtonElement>(".tasker-seg-status .tasker-seg-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          const status = btn.dataset.status as TaskStatus | undefined;
          if (!status) return;
          this.storage.updateTask(projectId, taskId, {
            status,
            completedAt: status === "done" ? Date.now() : undefined,
          });
          this.render();
        });
      });
```

Delete the `renderStatusMenu` method.

- [ ] **Step 5: CSS for the segmented switch and key:value rows**

Add to `styles.css`:

```css
.tasker-kv { display: flex; align-items: center; gap: 10px; font-size: 12px; }
.tasker-kv-key { width: 66px; flex-shrink: 0; color: var(--text-tertiary); }
.tasker-seg {
  display: inline-flex;
  border: 1px solid var(--border);
  border-radius: 7px;
  overflow: hidden;
}
.tasker-seg-btn {
  padding: 3px 10px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-family: var(--font-mono, var(--ui-font));
  font-size: 10px;
  cursor: pointer;
  transition: background 120ms, color 120ms;
}
.tasker-seg-btn + .tasker-seg-btn { border-left: 1px solid var(--border); }
.tasker-seg-btn:hover { color: var(--text-primary); }
.tasker-seg-btn.on { background: color-mix(in srgb, var(--accent) 22%, transparent); color: var(--text-primary); }
```

- [ ] **Step 6: Run the status test**

Run: `npx vitest run ui/src/tasker/panel.test.ts -t "status segmented"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/styles.css ui/src/tasker/panel.test.ts
git commit -m "feat(tasker): inline segmented status switch"
```

---

### Task 3: Priority as inline selectable dots

**Files:**
- Modify: `ui/src/tasker/panel.ts` (renderTaskDetails, bindDetailsEvents, remove renderPriorityMenu, toggleMenu)
- Modify: `ui/src/tasker/styles.css`
- Test: `ui/src/tasker/panel.test.ts`

- [ ] **Step 1: Update the priority test**

```ts
  it("priority dots update priority", () => {
    const { panel, host } = mount();
    const pid = inbox(panel);
    const tid = addTask(panel, pid, "Tune");
    panel.render();
    openTask(host, tid);
    host.querySelector<HTMLButtonElement>('.tasker-prio-dots [data-priority="high"]')!.click();
    expect(storageOf(panel).getTask(pid, tid).priority).toBe("high");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run ui/src/tasker/panel.test.ts -t "priority dots"`
Expected: FAIL.

- [ ] **Step 3: Render priority dots**

In `renderTaskDetails`, replace the priority chip-wrap with:

```ts
          <div class="tasker-kv">
            <span class="tasker-kv-key">Priority</span>
            <div class="tasker-prio-dots" role="group">
              ${PRIORITIES.map((p) =>
                `<button class="tasker-prio-dot ${getPriorityClass(p)}${task.priority === p ? " on" : ""}" type="button" data-priority="${p}" aria-label="${titleCase(p)}"></button>`
              ).join("")}
            </div>
          </div>
```

Remove `isPriorityOpen` and the `renderPriorityMenu()` call.

- [ ] **Step 4: Wire dots; delete old priority handlers + toggleMenu**

In `bindDetailsEvents`, remove the `.tasker-chip-priority` handler and `.tasker-priority-menu .tasker-menu-item` loop. Add:

```ts
      edit.querySelectorAll<HTMLButtonElement>(".tasker-prio-dots .tasker-prio-dot").forEach((btn) => {
        btn.addEventListener("click", () => {
          const priority = btn.dataset.priority as TaskPriority | undefined;
          if (!priority) return;
          this.storage.updateTask(projectId, taskId, { priority });
          this.render();
        });
      });
```

Delete `renderPriorityMenu`. Now that no caller uses status/priority kinds, simplify `toggleMenu` and `openMenu`: change the field type to:

```ts
  private openMenu: { kind: "date"; taskId: string } | null = null;
```

and delete the `toggleMenu` method (no longer referenced). Remove the `open`/`isStatusOpen`/`isPriorityOpen` locals at the top of `renderTaskDetails` (all gone now).

- [ ] **Step 5: CSS for priority dots**

Add to `styles.css`:

```css
.tasker-prio-dots { display: inline-flex; gap: 8px; }
.tasker-prio-dot {
  width: 14px; height: 14px;
  border-radius: 50%;
  border: none;
  padding: 0;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 120ms, outline-color 120ms;
  outline: 2px solid transparent;
  outline-offset: 2px;
}
.tasker-prio-dot:hover { opacity: 0.85; }
.tasker-prio-dot.on { opacity: 1; outline-color: color-mix(in srgb, currentColor 50%, transparent); }
/* reuse existing .tasker-priority-* background colors */
.tasker-prio-dot.tasker-priority-urgent { background: #ef4444; color: #ef4444; }
.tasker-prio-dot.tasker-priority-high { background: #f97316; color: #f97316; }
.tasker-prio-dot.tasker-priority-normal { background: #eab308; color: #eab308; }
.tasker-prio-dot.tasker-priority-low { background: #22c55e; color: #22c55e; }
```

- [ ] **Step 6: Run the priority test + full file**

Run: `npx vitest run ui/src/tasker/panel.test.ts -t "priority dots"` → PASS
Run: `npx vitest run ui/src/tasker/panel.test.ts` → all PASS

- [ ] **Step 7: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/styles.css ui/src/tasker/panel.test.ts
git commit -m "feat(tasker): inline priority dots; drop status/priority popovers"
```

---

### Task 4: Detail sheet shell — Due row, Notes, Delete action

Recompose `renderTaskDetails` so the sheet is a tidy key:value column with the chip row removed and a muted delete action.

**Files:**
- Modify: `ui/src/tasker/panel.ts` (renderTaskDetails, bindDetailsEvents delete handler)
- Modify: `ui/src/tasker/styles.css`
- Test: `ui/src/tasker/panel.test.ts` (delete test markup)

- [ ] **Step 1: Update the delete test selector if needed**

The delete chip becomes `.tasker-sheet-delete`. Update the existing "delete chip removes the task" test to click `.tasker-sheet-delete` instead of `.tasker-chip-delete`:

```ts
    host.querySelector<HTMLButtonElement>(".tasker-sheet-delete")!.click();
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run ui/src/tasker/panel.test.ts -t "delete"`
Expected: FAIL (`.tasker-sheet-delete` not found).

- [ ] **Step 3: Recompose renderTaskDetails**

Replace the whole returned template of `renderTaskDetails` with the sheet structure (Status and Priority rows from Tasks 2-3 included, plus Due, Notes, Delete):

```ts
    const dueLabel = task.dueDate ? formatDueDate(task.dueDate) : "Add date";
    return `
      <div class="tasker-edit tasker-sheet" data-project-id="${projectId}" data-task-id="${task.id}">
        <div class="tasker-kv">
          <span class="tasker-kv-key">Status</span>
          <div class="tasker-seg tasker-seg-status" role="group">
            ${(["pending","active","done"] as TaskStatus[]).map((s) =>
              `<button class="tasker-seg-btn${task.status === s ? " on" : ""}" type="button" data-status="${s}">${titleCase(s)}</button>`).join("")}
          </div>
        </div>
        <div class="tasker-kv">
          <span class="tasker-kv-key">Priority</span>
          <div class="tasker-prio-dots" role="group">
            ${PRIORITIES.map((p) =>
              `<button class="tasker-prio-dot ${getPriorityClass(p)}${task.priority === p ? " on" : ""}" type="button" data-priority="${p}" aria-label="${titleCase(p)}"></button>`).join("")}
          </div>
        </div>
        <div class="tasker-kv">
          <span class="tasker-kv-key">Due</span>
          <button class="tasker-chip tasker-chip-due${task.dueDate ? " tasker-chip-due-set" : ""}" type="button">${escapeHtml(dueLabel)}</button>
        </div>
        <div class="tasker-kv tasker-kv-notes">
          <span class="tasker-kv-key">Notes</span>
          <textarea class="tasker-edit-note" rows="1" placeholder="Add notes…">${escapeHtml(task.description ?? "")}</textarea>
        </div>
        <button class="tasker-sheet-delete" type="button">Delete task</button>
      </div>
    `;
```

- [ ] **Step 4: Update the delete handler selector**

In `bindDetailsEvents`, change the delete handler selector from `.tasker-chip-delete` to `.tasker-sheet-delete` (body unchanged):

```ts
      edit.querySelector<HTMLButtonElement>(".tasker-sheet-delete")?.addEventListener("click", () => {
        this.storage.deleteTask(projectId, taskId);
        this.selectedTask = null;
        this.openMenu = null;
        this.render();
      });
```

- [ ] **Step 5: CSS — sheet layout, notes row, delete action**

Add/replace in `styles.css`:

```css
.tasker-sheet {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 6px 12px 12px 35px;
}
.tasker-kv-notes { align-items: flex-start; }
.tasker-kv-notes .tasker-kv-key { margin-top: 6px; }
.tasker-edit-note {
  flex: 1;
  min-width: 0;
  min-height: 22px;
  resize: vertical;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  padding: 4px 0 6px;
  color: var(--text-primary);
  font-family: var(--ui-font);
  font-size: 12px;
  line-height: 1.45;
  outline: none;
}
.tasker-edit-note::placeholder { color: var(--text-tertiary); }
.tasker-sheet-delete {
  align-self: flex-end;
  margin-top: 2px;
  padding: 4px 8px;
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  font-family: var(--font-mono, var(--ui-font));
  font-size: 11px;
  cursor: pointer;
  transition: color 120ms;
}
.tasker-sheet-delete:hover { color: #f87171; }
```

Remove now-dead rules: `.tasker-chip-delete`, `.tasker-chip-row`, `.tasker-chip-wrap` (if unused), and the old `.tasker-edit` padding rule superseded by `.tasker-sheet`. Keep `.tasker-chip` (used by Due).

- [ ] **Step 6: Run full test file**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/styles.css ui/src/tasker/panel.test.ts
git commit -m "feat(tasker): key:value detail sheet with Due/Notes/Delete"
```

---

### Task 5: Task row — priority spine, hover actions, group/add-task cleanup

Polish the collapsed row and group chrome to the linear/dense language.

**Files:**
- Modify: `ui/src/tasker/panel.ts` (renderTask)
- Modify: `ui/src/tasker/styles.css`
- Test: none (visual only; existing tests must still pass)

- [ ] **Step 1: Update renderTask for the spine + hover affordances**

In `renderTask`, the row already has `.tasker-task ${statusClass}`. Add the priority class to the row container so the spine can be colored, and drop the inline `.tasker-priority` dot (priority now shown via spine + detail dots):

```ts
    return `
      <div class="tasker-task ${statusClass} ${priorityClass}${selected ? " tasker-task-selected" : ""}" data-project-id="${projectId}" data-task-id="${task.id}">
        <div class="tasker-task-main" role="button" tabindex="0" aria-expanded="${selected}">
          <button class="tasker-task-checkbox" type="button" title="Toggle task">${checkboxIcon}</button>
          ${this.editingTitle?.taskId === task.id && this.editingTitle.projectId === projectId
            ? `<input class="tasker-title-input" type="text" value="${escapeAttr(task.title)}" autocomplete="off" />`
            : `<span class="tasker-task-title" role="button" tabindex="0">${escapeHtml(task.title)}</span>`}
          ${task.description?.trim() ? `<span class="tasker-note-indicator" title="Has description">${Icons.noteText({ size: 12 })}</span>` : ""}
          ${dueDateHtml}
          ${task.status === "pending"
            ? `<button class="tasker-task-start" type="button" data-project-id="${projectId}" data-task-id="${task.id}" aria-label="Start task">${Icons.play({ size: 12 })}<span>start</span></button>`
            : ""}
          <span class="tasker-task-chevron" aria-hidden="true">${selected ? "⌃" : "⌄"}</span>
        </div>
        ${selected ? this.renderTaskDetails(projectId, task) : ""}
      </div>
    `;
```

(Note: `priorityClass` is already computed at the top of `renderTask`. The `.tasker-priority` span is removed from the row.)

- [ ] **Step 2: CSS — colored left spine by priority on the row**

Add to `styles.css`:

```css
/* Priority spine on the task row */
.tasker-task { position: relative; }
.tasker-task::before {
  content: "";
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 2px;
  background: var(--border);
  border-radius: 2px;
}
.tasker-task.tasker-priority-urgent::before { background: #ef4444; }
.tasker-task.tasker-priority-high::before { background: #f97316; }
.tasker-task.tasker-priority-normal::before { background: #eab308; }
.tasker-task.tasker-priority-low::before { background: #22c55e; }
.tasker-task-main { padding-left: 6px; }
/* start action: reveal on hover/selected */
.tasker-task-start { opacity: 0; transition: opacity 120ms; }
.tasker-task:hover .tasker-task-start,
.tasker-task-selected .tasker-task-start { opacity: 1; }
```

- [ ] **Step 3: CSS — group headers + add task, remove dashed borders**

In `styles.css`, find the `.tasker-task-add-quick` rule and change its dashed border to none (flat quiet row), and ensure group headers use a hairline top border with no band. Replace `.tasker-task-add-quick` border line:

```css
.tasker-task-add-quick {
  width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: transparent;
  border: none;
  color: var(--text-secondary);
  border-radius: 6px;
  padding: 8px 6px;
  font-family: var(--font-mono, var(--ui-font));
  font-size: 11px;
  cursor: pointer;
  text-align: left;
  transition: color 120ms, background 120ms;
}
.tasker-task-add-quick:hover { color: var(--text-primary); background: color-mix(in srgb, var(--text-primary) 5%, transparent); }
```

Confirm `.tasker-project-header` (group row) has `text-transform: uppercase` on `.tasker-project-name` (already present) and `.tasker-project` separates via `border-bottom`/`border-top` hairline only.

- [ ] **Step 4: Run full test file**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: all PASS (no test asserts on the removed row `.tasker-priority` span; if one does, update it to assert the row class `.tasker-task.tasker-priority-*`).

- [ ] **Step 5: Commit**

```bash
git add ui/src/tasker/panel.ts ui/src/tasker/styles.css
git commit -m "feat(tasker): priority spine, hover actions, flat group/add-task chrome"
```

---

### Task 6: Verify in the running app

- [ ] **Step 1: Restart dev**

Use the `respawn` skill (kills `tauri dev`, frees port 1420, relaunches). Open the Tasker panel.

- [ ] **Step 2: Manual checks**

- Group headers uppercase, hairline separated, no dashed borders.
- Task row shows a colored left spine matching priority; `start`/actions appear on hover.
- Expand a task: Status segmented switch toggles; Priority dots select; Notes persists.
- Click "Add date": the calendar appears as a floating popover (NOT clipped), anchored to the chip, flips above if near the bottom; pick a day → chip shows the date; reopen → "Clear date" works.
- Delete task removes the row.

- [ ] **Step 3: Final full test run**

Run: `npx vitest run ui/src/tasker/panel.test.ts`
Expected: all PASS.

---

## Self-Review Notes

- **Spec coverage:** Header/filters (Task 5/unchanged), groups (Task 5), task row spine + hover (Task 5), key:value sheet with segmented status (Task 2), priority dots (Task 3), Due pill + Notes + Delete (Task 4), date picker portal fix (Task 1), add-task flat (Task 5). All spec sections mapped.
- **Type consistency:** `openMenu` narrowed to `{kind:"date"}` in Task 3 after status/priority kinds removed; `dateMenuEl`/`datePickerRepaint`/`dateView` fields introduced in Task 1; calendar split into `dateCalendarHtml` + `bindDateCalendar`; `positionDateMenu(anchor, cal)` signature consistent across Task 1.
- **No placeholders:** every code step shows full code.
