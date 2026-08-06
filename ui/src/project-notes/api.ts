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
  /** Sorts to the top of the list regardless of age. */
  pinned?: boolean;
  /** Kept in the panel but withheld from executors — MCP `notes_read` skips it. */
  agent_hidden?: boolean;
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
  setPinned: (id: string, pinned: boolean) =>
    invoke<Note | null>("project_note_set_pinned", { id, pinned }),
  setAgentHidden: (id: string, hidden: boolean) =>
    invoke<Note | null>("project_note_set_agent_hidden", { id, hidden }),
  deleteNote: (id: string) => invoke<void>("project_note_delete", { id }),
  listNotes: (groupId: string, limit: number, beforeTs?: number) =>
    invoke<Note[]>("project_note_list", { groupId, limit, beforeTs }),
};

/** A note published view-only. Rides the gist surface: one text document
 *  behind a secret token, so the URL is /g/<token>. */
export interface NoteShare {
  gistId: number;
  token: string;
  url: string;
}

export const noteShareApi = {
  get: (noteId: string) => invoke<NoteShare | null>("note_get_share", { noteId }),
  list: () => invoke<string[]>("note_list_shares"),
  publish: (noteId: string, body: string) =>
    invoke<NoteShare>("note_publish", { noteId, body }),
  revoke: (noteId: string) => invoke<void>("note_revoke", { noteId }),
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
