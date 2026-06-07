// TaskerPanel: right-rail task list with inline task details.

import type { Task, Project, TaskStatus, TaskPriority } from "./types";
import { TaskStorage } from "./storage";
import { Icons } from "../icons";

const EXPANDED_PROJECTS_KEY = "covenant.tasker.expanded-projects";
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

function dateInputValue(ms?: number): string {
  if (!ms) return "";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function titleCase(s: string): string {
  return s.slice(0, 1).toUpperCase() + s.slice(1);
}

export class TaskerPanel {
  private storage: TaskStorage;
  private host: HTMLElement;
  private isOpen = false;
  private expandedProjects: Set<string> = new Set();
  private currentFilter: TaskStatus | "all" = "all";
  private composingProjectId: string | null = null;
  private selectedTask: { projectId: string; taskId: string } | null = null;

  constructor(host: HTMLElement) {
    this.host = host;
    this.storage = new TaskStorage();
    this.loadExpandedProjects();

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

  isOpenCheck(): boolean {
    return this.isOpen;
  }

  render(): void {
    this.host.classList.remove("hidden");
    this.isOpen = true;
    const projects = this.storage.getProjects();

    this.host.innerHTML = `
      <div class="tasker-panel">
        <div class="tasker-header">
          <h2 class="tasker-title">Tasker</h2>
          <div class="tasker-header-actions">
            <button class="tasker-btn-icon tasker-btn-new-project" type="button" title="New project">${Icons.folder({ size: 14 })}</button>
          </div>
        </div>

        <div class="tasker-filters">
          <button class="tasker-filter-btn${this.currentFilter === "all" ? " active" : ""}" data-filter="all">All</button>
          <button class="tasker-filter-btn${this.currentFilter === "active" ? " active" : ""}" data-filter="active">Active</button>
          <button class="tasker-filter-btn${this.currentFilter === "pending" ? " active" : ""}" data-filter="pending">Pending</button>
          <button class="tasker-filter-btn${this.currentFilter === "done" ? " active" : ""}" data-filter="done">Done</button>
        </div>

        <div class="tasker-projects">
          ${projects.map((p) => this.renderProject(p)).join("")}
        </div>

        <div class="tasker-footer">
          <small class="tasker-stats">${this.getStats()}</small>
        </div>
      </div>
    `;

    this.setupEventListeners();
    queueMicrotask(() => {
      this.host.querySelector<HTMLInputElement>(".tasker-composer-input")?.focus();
      const detailTitle = this.host.querySelector<HTMLInputElement>(".tasker-detail-title");
      if (detailTitle && document.activeElement?.closest(".tasker-details") === null) {
        // Do not steal focus when user is interacting with details.
      }
    });
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
          <button class="tasker-empty-action" data-project-id="${project.id}" type="button">New task</button>
        </div>
      `
      : "";

    return `
      <div class="tasker-project">
        <button class="tasker-project-header" data-project-id="${project.id}">
          <span class="tasker-project-toggle">${isExpanded ? "▼" : "▶"}</span>
          <span class="tasker-project-name">${escapeHtml(project.name)}</span>
          <span class="tasker-project-count">${tasks.length}</span>
        </button>
        ${isExpanded ? `
          <div class="tasker-tasks">
            ${isComposing ? this.renderComposer(project.id) : ""}
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
      <div class="tasker-task ${statusClass}${selected ? " tasker-task-selected" : ""}" data-project-id="${projectId}" data-task-id="${task.id}">
        <div class="tasker-task-main" role="button" tabindex="0" aria-expanded="${selected}">
          <button class="tasker-task-checkbox" type="button" title="Toggle task">${checkboxIcon}</button>
          <span class="tasker-priority ${priorityClass}" title="${task.priority}"></span>
          <span class="tasker-task-title">${escapeHtml(task.title)}</span>
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
    return `
      <div class="tasker-details" data-project-id="${projectId}" data-task-id="${task.id}">
        <label class="tasker-detail-field">
          <span>Title</span>
          <input class="tasker-detail-title" type="text" value="${escapeAttr(task.title)}" autocomplete="off" />
        </label>

        <label class="tasker-detail-field">
          <span>Description</span>
          <textarea class="tasker-detail-description" rows="4" placeholder="Add notes, links, acceptance criteria…">${escapeHtml(task.description ?? "")}</textarea>
        </label>

        <div class="tasker-detail-field">
          <span>Priority</span>
          <div class="tasker-priority-options" role="group" aria-label="Priority">
            ${PRIORITIES.map((p) => `
              <button class="tasker-priority-option${task.priority === p ? " active" : ""}" data-priority="${p}" type="button">
                <span class="tasker-priority ${getPriorityClass(p)}"></span>
                <span>${titleCase(p)}</span>
              </button>
            `).join("")}
          </div>
        </div>

        <label class="tasker-detail-field">
          <span>Due date</span>
          <input class="tasker-detail-date" type="date" value="${dateInputValue(task.dueDate)}" />
        </label>

        <div class="tasker-detail-actions">
          <button class="tasker-detail-delete" type="button">Delete task</button>
        </div>
      </div>
    `;
  }

  private getStats(): string {
    const all = this.storage.getAllTasks();
    const done = all.filter((t) => t.status === "done").length;
    const active = all.filter((t) => t.status === "active").length;
    return `${done} done · ${active} active · ${all.length - done - active} pending`;
  }

  private setupEventListeners(): void {
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

    this.host.querySelector<HTMLButtonElement>(".tasker-btn-new-project")?.addEventListener("click", () => {
      this.showNewProjectDialog();
    });

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
        this.render();
      };
      row.addEventListener("click", toggle);
      row.addEventListener("keydown", (e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        toggle();
      });
    });

    this.host.querySelectorAll<HTMLButtonElement>(".tasker-task-add-quick, .tasker-empty-action").forEach((btn) => {
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

    this.bindDetailsEvents();
  }

  private bindDetailsEvents(): void {
    this.host.querySelectorAll<HTMLElement>(".tasker-details").forEach((details) => {
      const projectId = details.dataset.projectId;
      const taskId = details.dataset.taskId;
      if (!projectId || !taskId) return;

      details.querySelector<HTMLInputElement>(".tasker-detail-title")?.addEventListener("change", (e) => {
        const title = (e.target as HTMLInputElement).value.trim();
        if (!title) return;
        this.storage.updateTask(projectId, taskId, { title });
        this.render();
      });

      details.querySelector<HTMLInputElement>(".tasker-detail-title")?.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        (e.target as HTMLInputElement).blur();
      });

      details.querySelector<HTMLTextAreaElement>(".tasker-detail-description")?.addEventListener("change", (e) => {
        const description = (e.target as HTMLTextAreaElement).value.trim();
        this.storage.updateTask(projectId, taskId, {
          description: description.length > 0 ? description : undefined,
        });
        this.render();
      });

      details.querySelector<HTMLTextAreaElement>(".tasker-detail-description")?.addEventListener("keydown", (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
          e.preventDefault();
          (e.target as HTMLTextAreaElement).blur();
        }
      });

      details.querySelector<HTMLInputElement>(".tasker-detail-date")?.addEventListener("change", (e) => {
        const value = (e.target as HTMLInputElement).value;
        this.storage.updateTask(projectId, taskId, {
          dueDate: value ? new Date(`${value}T00:00:00`).getTime() : undefined,
        });
        this.render();
      });

      details.querySelectorAll<HTMLButtonElement>(".tasker-priority-option").forEach((btn) => {
        btn.addEventListener("click", () => {
          const priority = btn.dataset.priority as TaskPriority | undefined;
          if (!priority) return;
          this.storage.updateTask(projectId, taskId, { priority });
          this.render();
        });
      });

      details.querySelector<HTMLButtonElement>(".tasker-detail-delete")?.addEventListener("click", () => {
        this.storage.deleteTask(projectId, taskId);
        this.selectedTask = null;
        this.render();
      });
    });
  }

  private showNewProjectDialog(): void {
    const name = prompt("Project name:");
    if (!name) return;
    const project = this.storage.createProject(name);
    this.expandedProjects.add(project.id);
    this.saveExpandedProjects();
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
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.render();
  }
}
