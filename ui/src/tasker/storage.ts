// Storage layer for persisting tasks to localStorage.

import type { Task, Project, TaskStore, TaskFilterOptions } from "./types";

const STORAGE_KEY = "covenant.tasker.store";
/// Fired after every write so board sharing can auto-push. Not scoped to the
/// mutated project — the whole store is one blob, and listeners filter.
export const TASKER_SAVED_EVENT = "covenant:tasker-saved";
const CURRENT_VERSION = 1;

function generateId(): string {
  return Math.random().toString(36).substring(2, 11);
}

export class TaskStorage {
  private store: TaskStore;

  constructor() {
    this.store = this.loadStore();
  }

  private loadStore(): TaskStore {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return { projects: [], version: CURRENT_VERSION };
      }
      const parsed = JSON.parse(raw) as TaskStore;
      // Run migrations if needed
      if (parsed.version < CURRENT_VERSION) {
        return this.migrate(parsed);
      }
      return parsed;
    } catch {
      return { projects: [], version: CURRENT_VERSION };
    }
  }

  private migrate(store: TaskStore): TaskStore {
    // Add migrations here as needed
    return store;
  }

  private saveStore(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.store));
    } catch {
      console.error("Failed to save task store");
      return;
    }
    window.dispatchEvent(
      new CustomEvent(TASKER_SAVED_EVENT, {
        detail: { projectIds: this.getProjects().map((p) => p.id) },
      }),
    );
  }

  // Project operations
  createProject(name: string, description?: string, color?: string): Project {
    const project: Project = {
      id: generateId(),
      name,
      description,
      color,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tasks: [],
    };
    this.store.projects.push(project);
    this.saveStore();
    return project;
  }

  getProjects(includeArchived = false): Project[] {
    return this.store.projects.filter(
      (p) => includeArchived || !p.archivedAt
    );
  }

  getProject(id: string): Project | null {
    return this.store.projects.find((p) => p.id === id) ?? null;
  }

  updateProject(
    id: string,
    updates: Partial<Project>
  ): Project | null {
    const project = this.getProject(id);
    if (!project) return null;
    Object.assign(project, updates, { updatedAt: Date.now() });
    this.saveStore();
    return project;
  }

  archiveProject(id: string): Project | null {
    return this.updateProject(id, { archivedAt: Date.now() });
  }

  deleteProject(id: string): boolean {
    const idx = this.store.projects.findIndex((p) => p.id === id);
    if (idx < 0) return false;
    this.store.projects.splice(idx, 1);
    this.saveStore();
    return true;
  }

  // Task operations
  createTask(
    projectId: string,
    title: string,
    options?: Partial<Task>
  ): Task | null {
    const project = this.getProject(projectId);
    if (!project) return null;

    const task: Task = {
      id: generateId(),
      title,
      status: "pending",
      priority: "normal",
      projectId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...options,
    };
    project.tasks.push(task);
    project.updatedAt = Date.now();
    this.saveStore();
    return task;
  }

  getTask(projectId: string, taskId: string): Task | null {
    const project = this.getProject(projectId);
    if (!project) return null;
    return project.tasks.find((t) => t.id === taskId) ?? null;
  }

  updateTask(
    projectId: string,
    taskId: string,
    updates: Partial<Task>
  ): Task | null {
    const task = this.getTask(projectId, taskId);
    if (!task) return null;
    Object.assign(task, updates, { updatedAt: Date.now() });
    const project = this.getProject(projectId);
    if (project) project.updatedAt = Date.now();
    this.saveStore();
    return task;
  }

  deleteTask(projectId: string, taskId: string): boolean {
    const project = this.getProject(projectId);
    if (!project) return false;
    const idx = project.tasks.findIndex((t) => t.id === taskId);
    if (idx < 0) return false;
    project.tasks.splice(idx, 1);
    project.updatedAt = Date.now();
    this.saveStore();
    return true;
  }

  getAllTasks(filter?: TaskFilterOptions): Task[] {
    const allTasks: Task[] = [];
    for (const project of this.getProjects()) {
      allTasks.push(...project.tasks);
    }

    if (!filter) return allTasks;

    return allTasks.filter((task) => {
      if (filter.status) {
        const statuses = Array.isArray(filter.status)
          ? filter.status
          : [filter.status];
        if (!statuses.includes(task.status)) return false;
      }

      if (filter.priority) {
        const priorities = Array.isArray(filter.priority)
          ? filter.priority
          : [filter.priority];
        if (!priorities.includes(task.priority)) return false;
      }

      if (filter.projectId && task.projectId !== filter.projectId) {
        return false;
      }

      if (filter.groupId && task.groupId !== filter.groupId) {
        return false;
      }

      if (filter.overdueOnly && task.dueDate) {
        if (task.dueDate > Date.now() || task.status === "done") {
          return false;
        }
      }

      if (filter.dueSoonOnly && task.dueDate) {
        const now = Date.now();
        const week = 7 * 24 * 60 * 60 * 1000;
        if (task.dueDate < now || task.dueDate > now + week) {
          return false;
        }
      }

      if (!filter.showCompleted && task.status === "done") {
        return false;
      }

      if (filter.searchQuery) {
        const q = filter.searchQuery.toLowerCase();
        if (
          !task.title.toLowerCase().includes(q) &&
          !task.description?.toLowerCase().includes(q)
        ) {
          return false;
        }
      }

      return true;
    });
  }

  // Utility
  export(): string {
    return JSON.stringify(this.store, null, 2);
  }

  import(data: string): boolean {
    try {
      const parsed = JSON.parse(data) as TaskStore;
      if (!parsed.projects) return false;
      this.store = parsed;
      this.saveStore();
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    this.store = { projects: [], version: CURRENT_VERSION };
    this.saveStore();
  }
}
