import { invoke } from "@tauri-apps/api/core";

export interface TermShare {
  shareId: number;
  token: string;
  url: string;
}

export const termShareApi = {
  getShare: (sessionId: string) =>
    invoke<TermShare | null>("term_share_get", { sessionId }),
  listShares: () => invoke<string[]>("term_share_list"),
  create: (sessionId: string) =>
    invoke<TermShare>("term_share_create", { sessionId }),
  revoke: (sessionId: string) =>
    invoke<void>("term_share_revoke", { sessionId }),
};
