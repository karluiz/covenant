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
  private suppressClick = false;

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
