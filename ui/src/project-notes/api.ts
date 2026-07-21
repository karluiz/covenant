import { invoke } from "@tauri-apps/api/core";

export interface Command {
  id: string;
  group_id: string;
  title: string;
  command: string;
  sort_order: number;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
}

export interface Note {
  id: string;
  group_id: string;
  body: string;
  source?: string | null;
  created_at_unix_ms: number;
}

export interface Snapshot {
  commands: Command[];
  notes: Note[];
}

export const projectNotesApi = {
  snapshot: (groupId: string) =>
    invoke<Snapshot>("project_notes_get", { groupId }),

  createCommand: (groupId: string, title: string, command: string) =>
    invoke<Command>("project_command_create", { groupId, title, command }),
  updateCommand: (id: string, title: string, command: string) =>
    invoke<Command | null>("project_command_update", { id, title, command }),
  deleteCommand: (id: string) =>
    invoke<void>("project_command_delete", { id }),
  reorderCommands: (groupId: string, orderedIds: string[]) =>
    invoke<void>("project_command_reorder", { groupId, orderedIds }),

  appendNote: (groupId: string, body: string, source?: string) =>
    invoke<Note>("project_note_append", { groupId, body, source: source ?? null }),
  updateNote: (id: string, body: string) =>
    invoke<Note | null>("project_note_update", { id, body }),
  deleteNote: (id: string) => invoke<void>("project_note_delete", { id }),
  listNotes: (groupId: string, limit: number, beforeTs?: number) =>
    invoke<Note[]>("project_note_list", { groupId, limit, beforeTs }),
};

export interface Prompt {
  id: string;
  title: string;
  body: string;
  sort_order: number;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
}

export const promptsApi = {
  list: () => invoke<Prompt[]>("prompt_list"),
  create: (title: string, body: string) =>
    invoke<Prompt>("prompt_create", { title, body }),
  update: (id: string, title: string, body: string) =>
    invoke<Prompt | null>("prompt_update", { id, title, body }),
  delete: (id: string) => invoke<void>("prompt_delete", { id }),
  reorder: (orderedIds: string[]) =>
    invoke<void>("prompt_reorder", { orderedIds }),
  improve: (text: string) => invoke<string>("improve_prompt", { text }),
};
