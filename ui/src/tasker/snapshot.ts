// The privacy boundary for board sharing: a Project becomes a BoardSnapshot.
// `description` is absent from these types on purpose — free-text notes hold
// paths, tokens and venting, and must have nowhere to land in the payload.

import { BOARD_COLUMNS } from "./board";
import type { Project, Task, TaskPriority, TaskStatus } from "./types";

export const DONE_LIMIT = 20;

export interface SharedSubtask {
  title: string;
  completed: boolean;
}

export interface SharedTask {
  id: string;
  title: string;
  priority: TaskPriority;
  dueDate?: number;
  dueTime?: string;
  tags?: string[];
  subtasks?: SharedSubtask[];
  estimatedMinutes?: number;
  spentMinutes?: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface BoardColumn {
  status: TaskStatus;
  label: string;
  tasks: SharedTask[];
}

export interface BoardSnapshot {
  v: 1;
  title: string;
  updatedAt: number;
  columns: BoardColumn[];
}

function shareTask(t: Task): SharedTask {
  const out: SharedTask = {
    id: t.id,
    title: t.title,
    priority: t.priority,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
  if (t.dueDate !== undefined) out.dueDate = t.dueDate;
  if (t.dueTime !== undefined) out.dueTime = t.dueTime;
  if (t.tags?.length) out.tags = [...t.tags];
  if (t.subtasks?.length) {
    out.subtasks = t.subtasks.map((s) => ({ title: s.title, completed: s.completed }));
  }
  if (t.estimatedMinutes !== undefined) out.estimatedMinutes = t.estimatedMinutes;
  if (t.spentMinutes !== undefined) out.spentMinutes = t.spentMinutes;
  if (t.completedAt !== undefined) out.completedAt = t.completedAt;
  return out;
}

export function toSnapshot(project: Project, now = Date.now()): BoardSnapshot {
  const columns = BOARD_COLUMNS.map(({ status, label }) => {
    let tasks = project.tasks.filter((t) => t.status === status);
    if (status === "done") {
      // ponytail: newest 20 only — the server paginates nothing and an
      // unbounded Done column would grow the payload forever.
      tasks = [...tasks]
        .sort((a, b) => (b.completedAt ?? b.updatedAt) - (a.completedAt ?? a.updatedAt))
        .slice(0, DONE_LIMIT);
    }
    return { status, label, tasks: tasks.map(shareTask) };
  });
  return { v: 1, title: project.name, updatedAt: now, columns };
}
