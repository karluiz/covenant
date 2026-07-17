import { invoke } from "@tauri-apps/api/core";

export interface GistShare {
  gistId: number;
  token: string;
  url: string;
}

export const gistApi = {
  getShare: (path: string) => invoke<GistShare | null>("gist_get_share", { path }),
  publish: (path: string) => invoke<GistShare>("gist_publish", { path }),
  revoke: (path: string) => invoke<void>("gist_revoke", { path }),
};
