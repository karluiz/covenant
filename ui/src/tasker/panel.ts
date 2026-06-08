// TaskerPanel: right-rail task list with inline task details.

import type { Task, Project, TaskStatus, TaskPriority } from "./types";
import { TaskStorage } from "./storage";
import { Icons } from "../icons";
import { BoardView } from "./board";

const EXPANDED_PROJECTS_KEY = "covenant.tasker.expanded-projects";
const VIEW_KEY = "covenant.tasker.view";
const BOARD_PROJECT_KEY = "covenant.tasker.board-project";
const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];

function formatDueDate(ms: number): string {
  const date = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  const dateOnly = (d: Date) => d.toISOString().split("T")[0];
  if (dateOnly(date) === dateOnly(today)) return "Today";
  if (dateOnly(date) === dateOnly(tomorrow)) return "Tomorrow";

  const diff = Math.floor((ms - today.getTime()) / (1000 * 60 * 60 * 24));
  if (diff < 7 && diff > 0) {
    return date.toLocaleDateString("en-US", { weekday: "short" });
  }

  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function isOverdue(ms: number): boolean {
  return ms < Date.now();
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

function getPriorityClass(priority: TaskPriority): string {
  return `tasker-priority-${priority}`;
}

function titleCase(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

const WEEKDAYS = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Build a Mon-first 6×7 day grid for the given month.
function calendarCells(year: number, month: number): Array<{ date: string; day: number; outside: boolean }> {
  const first = new Date(year, month, 1);
  // JS: 0=Sun … 6=Sat → shift so Monday=0
  const lead = (first.getDay() + 6) % 7;
  const start = new Date(year, month, 1 - lead);
  const cells: Array<{ date: string; day: number; outside: boolean }> = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({ date: ymd(d), day: d.getDate(), outside: d.getMonth() !== month });
  }
  return cells;
}

export class TaskerPanel {
  private storage: TaskStorage;
  private host: HTMLElement;
  private isOpen = false;
  private expandedProjects: Set<string> = new Set();
  private currentFilter: TaskStatus | "all" = "all";
  private composingProjectId: string | null = null;
  private selectedTask: { projectId: string; taskId: string } | null = null;
  private openMenu: { kind: "date"; taskId: string } | null = null;
  private dateView: { year: number; month: number } | null = null;
  private dateMenuEl: HTMLElement | null = null;
  private datePickerRepaint: (() => void) | null = null;
  private dateOutsideListener: ((ev: MouseEvent) => void) | null = null;
  private editingTitle: { projectId: string; taskId: string } | null = null;
  private composingList = false;
  private viewMode: "list" | "board" = "list";
  private boardProjectId: string | null = null;
  private boardKeyHandler: ((e: KeyboardEvent) => void) | null = null;
  private board: BoardView | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.storage = new TaskStorage();
    this.loadExpandedProjects();
    this.loadViewPrefs();

    if (this.storage.getProjects().length === 0) {
      const inbox = this.storage.createProject("Inbox", "Quick tasks and todos");
      this.expandedProjects.add(inbox.id);
      this.saveExpandedProjects();
    } else if (this.expandedProjects.size === 0) {
      const first = this.storage.getProjects()[0];
      if (first) this.expandedProjects.add(first.id);
    }
  }

  private loadExpandedProjects(): void {
    try {
      const raw = localStorage.getItem(EXPANDED_PROJECTS_KEY);
      if (raw) this.expandedProjects = new Set(JSON.parse(raw));
    } catch {
      // ignore corrupt prefs
    }
  }

  private saveExpandedProjects(): void {
    try {
      localStorage.setItem(EXPANDED_PROJECTS_KEY, JSON.stringify(Array.from(this.expandedProjects)));
    } catch {
      // ignore quota/private-mode failures
    }
  }

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

  isOpenCheck(): boolean {
    return this.isOpen;
  }

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

  private renderListBody(): string {
    const projects = this.storage.getProjects();
    return `
        <div class="tasker-filters">
          <button class="tasker-filter-btn${this.currentFilter === "all" ? " active" : ""}" data-filter="all">All</button>
          <button class="tasker-filter-btn${this.currentFilter === "active" ? " active" : ""}" data-filter="active">Active</button>
          <button class="tasker-filter-btn${this.currentFilter === "pending" ? " active" : ""}" data-filter="pending">Pending</button>
          <button class="tasker-filter-btn${this.currentFilter === "done" ? " active" : ""}" data-filter="done">Done</button>
        </div>

        ${this.composingList ? `
          <form class="tasker-newlist">
            <input class="tasker-newlist-input" type="text" autocomplete="off" placeholder="New list name…" />
            <button class="tasker-newlist-cancel" type="button" title="Cancel" aria-label="Cancel">${Icons.x({ size: 12 })}</button>
          </form>
        ` : ""}

        <div class="tasker-projects">
          ${projects.map((p) => this.renderProject(p)).join("")}
        </div>

        <div class="tasker-footer">
          <small class="tasker-stats">${this.getStats()}</small>
        </div>`;
  }

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

  private renderProject(project: Project): string {
    const isExpanded = this.expandedProjects.has(project.id);
    const isComposing = this.composingProjectId === project.id;
    const tasks = project.tasks.filter((t) =>
      this.currentFilter === "all" ? true : t.status === this.currentFilter,
    );

    const emptyHtml = tasks.length === 0 && !isComposing
      ? `
        <div class="tasker-empty">
          ${Icons.checklist({ size: 26 })}
          <div class="tasker-empty-title">No tasks yet</div>
          <div class="tasker-empty-hint">Capture a task for ${escapeHtml(project.name)}.</div>
        </div>
      `
      : "";

    return `
      <div class="tasker-project">
        <div class="tasker-project-headrow">
          <button class="tasker-project-header" data-project-id="${project.id}">
            <span class="tasker-project-toggle${isExpanded ? " tasker-project-toggle-open" : ""}">${Icons.chevronRight({ size: 14 })}</span>
            <span class="tasker-project-name">${escapeHtml(project.name)}</span>
            <span class="tasker-project-count">${tasks.length}</span>
          </button>
          ${project.name === "Inbox" ? "" : `<button class="tasker-project-delete" type="button" data-project-id="${project.id}" aria-label="Delete project">${Icons.trash({ size: 13 })}</button>`}
        </div>
        ${isExpanded ? `
          <div class="tasker-tasks">
            ${isComposing ? this.renderComposer(project.id) : ""}
            ${!isComposing && tasks.length === 0 ? `<button class="tasker-task-add-quick" data-project-id="${project.id}" type="button">+ New task</button>` : ""}
            ${emptyHtml}
            ${tasks.map((t) => this.renderTask(project.id, t)).join("")}
            ${!isComposing && tasks.length > 0 ? `<button class="tasker-task-add-quick" data-project-id="${project.id}" type="button">${Icons.plus({ size: 12 })}<span>Add task</span></button>` : ""}
          </div>
        ` : ""}
      </div>
    `;
  }

  private renderComposer(projectId: string): string {
    return `
      <form class="tasker-composer" data-project-id="${projectId}">
        <input class="tasker-composer-input" name="title" type="text" autocomplete="off" placeholder="What needs doing?" />
        <div class="tasker-composer-actions">
          <button class="tasker-composer-submit" type="submit">Add task</button>
          <button class="tasker-composer-cancel" type="button">Cancel</button>
        </div>
      </form>
    `;
  }

  private renderTask(projectId: string, task: Task): string {
    const selected = this.selectedTask?.projectId === projectId && this.selectedTask.taskId === task.id;
    const priorityClass = getPriorityClass(task.priority);
    const statusClass = `tasker-task-status-${task.status}`;
    const checkboxIcon = task.status === "done" ? Icons.check({ size: 12 }) : Icons.square({ size: 12 });

    const dueDateHtml = task.dueDate
      ? `<span class="tasker-due ${isOverdue(task.dueDate) && task.status !== "done" ? "tasker-due-overdue" : ""}">${formatDueDate(task.dueDate)}</span>`
      : "";

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
  }

  private renderTaskDetails(projectId: string, task: Task): string {
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
          <span class="tasker-kv-key tasker-notes-label">Notes</span>
          <textarea class="tasker-edit-note" rows="1" placeholder="Add notes…">${escapeHtml(task.description ?? "")}</textarea>
        </div>
        <button class="tasker-sheet-delete" type="button">Delete task</button>
      </div>
    `;
  }

  private closeDatePicker(): void {
    if (this.dateOutsideListener) {
      document.removeEventListener("mousedown", this.dateOutsideListener, true);
      this.dateOutsideListener = null;
    }
    this.datePickerRepaint = null;
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
    el.className = "tasker-date-menu";
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
      this.closeDatePicker();
    };
    this.dateOutsideListener = onOutside;
    queueMicrotask(() => {
      if (this.dateOutsideListener === onOutside) {
        document.addEventListener("mousedown", onOutside, true);
      }
    });
  }

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

  private getStats(): string {
    const all = this.storage.getAllTasks();
    const done = all.filter((t) => t.status === "done").length;
    const active = all.filter((t) => t.status === "active").length;
    return `${done} done · ${active} active · ${all.length - done - active} pending`;
  }

  private setupEventListeners(): void {
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
      this.mountBoard();
    }

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-filter-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.currentFilter = (btn.dataset.filter as TaskStatus | "all") || "all";
        this.selectedTask = null;
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-project-header").forEach((btn) => {
      btn.addEventListener("click", () => {
        const projectId = btn.dataset.projectId;
        if (!projectId) return;
        if (this.expandedProjects.has(projectId)) this.expandedProjects.delete(projectId);
        else this.expandedProjects.add(projectId);
        this.saveExpandedProjects();
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-project-delete").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const projectId = btn.dataset.projectId;
        if (!projectId) return;
        const project = this.storage.getProject(projectId);
        if (!project) return;
        const count = project.tasks.length;
        const suffix = count > 0 ? ` and its ${count} task${count === 1 ? "" : "s"}` : "";
        if (!confirm(`Delete project "${project.name}"${suffix}? This can't be undone.`)) return;
        this.storage.deleteProject(projectId);
        this.expandedProjects.delete(projectId);
        this.saveExpandedProjects();
        this.render();
      });
    });

    this.host.querySelector<HTMLButtonElement>(".tasker-btn-new-project")?.addEventListener("click", () => {
      this.showNewProjectDialog();
    });

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
    const cancelNewList = (): void => {
      this.composingList = false;
      this.render();
    };
    newListInput?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelNewList();
      }
    });
    newListInput?.addEventListener("blur", () => {
      // Cancel if dismissed without typing; commit happens via change/submit otherwise.
      if ((newListInput.value.trim().length ?? 0) === 0) {
        queueMicrotask(() => {
          if (this.composingList) cancelNewList();
        });
      }
    });
    this.host.querySelector<HTMLButtonElement>(".tasker-newlist-cancel")?.addEventListener("mousedown", (e) => {
      e.preventDefault();
      cancelNewList();
    });
    if (newListInput) queueMicrotask(() => newListInput.focus());

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-task-checkbox").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const taskEl = (e.currentTarget as HTMLElement).closest<HTMLElement>(".tasker-task");
        const projectId = taskEl?.dataset.projectId;
        const taskId = taskEl?.dataset.taskId;
        if (!projectId || !taskId) return;
        const task = this.storage.getTask(projectId, taskId);
        if (!task) return;
        const done = task.status === "done";
        this.storage.updateTask(projectId, taskId, {
          status: done ? "pending" : "done",
          completedAt: done ? undefined : Date.now(),
        });
        this.render();
      });
    });

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

    this.host.querySelectorAll<HTMLElement>(".tasker-task-main").forEach((row) => {
      const toggle = (): void => {
        const taskEl = row.closest<HTMLElement>(".tasker-task");
        const projectId = taskEl?.dataset.projectId;
        const taskId = taskEl?.dataset.taskId;
        if (!projectId || !taskId) return;
        const isSame = this.selectedTask?.projectId === projectId && this.selectedTask.taskId === taskId;
        this.selectedTask = isSame ? null : { projectId, taskId };
        this.openMenu = null;
        this.render();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggle();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-task-add-quick").forEach((btn) => {
      btn.addEventListener("click", () => {
        const projectId = btn.dataset.projectId;
        if (projectId) this.openComposer(projectId);
      });
    });

    this.host.querySelectorAll<HTMLFormElement>(".tasker-composer").forEach((form) => {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const projectId = form.dataset.projectId;
        const input = form.querySelector<HTMLInputElement>(".tasker-composer-input");
        const title = input?.value.trim() ?? "";
        if (!projectId || title.length === 0) return;
        const task = this.storage.createTask(projectId, title, { priority: "normal" });
        this.currentFilter = "all";
        this.composingProjectId = null;
        if (task) this.selectedTask = { projectId, taskId: task.id };
        this.expandedProjects.add(projectId);
        this.saveExpandedProjects();
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-composer-cancel").forEach((btn) => {
      btn.addEventListener("click", () => {
        this.composingProjectId = null;
        this.render();
      });
    });

    this.host.querySelectorAll<HTMLInputElement>(".tasker-composer-input").forEach((input) => {
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        this.composingProjectId = null;
        this.render();
      });
    });

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
      let cancelled = false;
      const commit = (): void => {
        if (cancelled) return;
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
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          input.blur();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancelled = true;
          this.editingTitle = null;
          this.render();
        }
      });
      queueMicrotask(() => input.focus());
    });

    this.bindDetailsEvents();

  }

  private bindDetailsEvents(): void {
    this.host.querySelectorAll<HTMLElement>(".tasker-edit").forEach((edit) => {
      const projectId = edit.dataset.projectId;
      const taskId = edit.dataset.taskId;
      if (!projectId || !taskId) return;

      const note = edit.querySelector<HTMLTextAreaElement>(".tasker-edit-note");
      const autoGrow = (el: HTMLTextAreaElement): void => {
        el.style.height = "auto";
        el.style.height = `${el.scrollHeight}px`;
      };
      if (note) {
        autoGrow(note);
        note.addEventListener("input", () => autoGrow(note));
      }
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

      edit.querySelectorAll<HTMLButtonElement>(".tasker-prio-dots .tasker-prio-dot").forEach((btn) => {
        btn.addEventListener("click", () => {
          const priority = btn.dataset.priority as TaskPriority | undefined;
          if (!priority) return;
          this.storage.updateTask(projectId, taskId, { priority });
          this.render();
        });
      });

      edit.querySelector<HTMLButtonElement>(".tasker-chip-due")?.addEventListener("click", (e) => {
        e.stopPropagation();
        this.openDatePicker(projectId, taskId, e.currentTarget as HTMLElement);
      });

      edit.querySelector<HTMLButtonElement>(".tasker-sheet-delete")?.addEventListener("click", () => {
        this.storage.deleteTask(projectId, taskId);
        this.selectedTask = null;
        this.openMenu = null;
        this.render();
      });
    });
  }

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

  private showNewProjectDialog(): void {
    this.composingList = true;
    this.render();
  }

  private openComposer(projectId: string): void {
    this.composingProjectId = projectId;
    this.selectedTask = null;
    this.expandedProjects.add(projectId);
    this.saveExpandedProjects();
    this.render();
  }

  close(): void {
    this.host.classList.add("hidden");
    this.isOpen = false;
    document.body.classList.remove("tasker-board");
    if (this.boardKeyHandler) {
      document.removeEventListener("keydown", this.boardKeyHandler);
      this.boardKeyHandler = null;
    }
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.render();
  }
}
