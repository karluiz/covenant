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
  created_at_unix_ms: number;
}

export interface Snapshot {
  commands: Command[];
  notes: Note[];
  docs: string;
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

  appendNote: (groupId: string, body: string) =>
    invoke<Note>("project_note_append", { groupId, body }),
  deleteNote: (id: string) => invoke<void>("project_note_delete", { id }),
  listNotes: (groupId: string, limit: number, beforeTs?: number) =>
    invoke<Note[]>("project_note_list", { groupId, limit, beforeTs }),

  getDocs: (groupId: string) =>
    invoke<string>("project_docs_get", { groupId }),
  saveDocs: (groupId: string, body: string) =>
    invoke<void>("project_docs_save", { groupId, body }),
};
