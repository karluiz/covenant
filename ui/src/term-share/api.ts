import { invoke } from "@tauri-apps/api/core";

export type ShareMode = "ro" | "collab";

export interface TermShare {
  shareId: number;
  token: string;
  url: string;
  mode: ShareMode;
}

export interface TermShareEntry {
  sessionId: string;
  mode: ShareMode;
}

export const termShareApi = {
  getShare: (sessionId: string, mode: ShareMode) =>
    invoke<TermShare | null>("term_share_get", { sessionId, mode }),
  listShares: () => invoke<TermShareEntry[]>("term_share_list"),
  create: (sessionId: string, mode: ShareMode) =>
    invoke<TermShare>("term_share_create", { sessionId, mode }),
  revoke: (sessionId: string, mode: ShareMode) =>
    invoke<void>("term_share_revoke", { sessionId, mode }),
};
