// Task and project types for the Tasker sidebar.

export type TaskStatus = "pending" | "active" | "done" | "cancelled";
export type TaskPriority = "low" | "normal" | "high" | "urgent";
export type RecurrenceType = "none" | "daily" | "weekly" | "monthly" | "yearly";

export interface Task {
  id: string; // UUID
  title: string;
  description?: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate?: number; // Unix timestamp in ms
  dueTime?: string; // HH:mm format
  completedAt?: number; // Unix timestamp in ms
  createdAt: number;
  updatedAt: number;
  projectId?: string;
  groupId?: string; // Associated workspace group
  sessionId?: string; // Associated terminal session for context
  tags?: string[];
  recurrence?: RecurrenceType;
  recurrenceEndDate?: number;
  estimatedMinutes?: number; // Time estimate
  spentMinutes?: number; // Time tracked
  subtasks?: SubTask[];
}

export interface SubTask {
  id: string;
  title: string;
  completed: boolean;
  createdAt: number;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  color?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
  tasks: Task[];
}

export interface TaskGroup {
  name: string;
  tasks: Task[];
}

export interface TaskStore {
  projects: Project[];
  version: number; // For migrations
}

export interface TaskFilterOptions {
  status?: TaskStatus | TaskStatus[];
  priority?: TaskPriority | TaskPriority[];
  projectId?: string;
  groupId?: string;
  overdueOnly?: boolean;
  dueSoonOnly?: boolean; // Next 7 days
  showCompleted?: boolean;
  searchQuery?: string;
}
