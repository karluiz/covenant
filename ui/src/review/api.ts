import { invoke } from "@tauri-apps/api/core";

export interface ShareState { specId: number; token: string; url: string; version: number; title: string }
export interface ReviewComment {
  id: number; version: number; anchorHeading: string | null; parentId: number | null;
  authorName: string; body: string; resolved: boolean; createdAt: string;
}
export interface ReviewVerdict { version: number; authorName: string; verdict: string; note: string | null; createdAt: string }
export interface ReviewActivity { latestVersion: number; comments: ReviewComment[]; verdicts: ReviewVerdict[] }

export const reviewApi = {
  getShare: (path: string) => invoke<ShareState | null>("review_get_share", { path }),
  publish: (path: string, title: string) => invoke<ShareState>("review_publish_spec", { path, title }),
  republish: (path: string) => invoke<ShareState>("review_republish_spec", { path }),
  revoke: (path: string) => invoke<void>("review_revoke_spec", { path }),
  activity: (path: string) => invoke<ReviewActivity>("review_activity", { path }),
  resolveComment: (path: string, commentId: number) => invoke<void>("review_resolve_comment", { path, commentId }),
};
