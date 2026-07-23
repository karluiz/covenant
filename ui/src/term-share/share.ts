import { termShareApi } from "./api";
import { pushInfoToast } from "../notifications/toast";
import { copyLinkOrOffer } from "../ui/share-link";

/// Locally-known shared sessions, mirrored from the backend store so the
/// tab strip can badge synchronously. Same shape as gist/share.ts.
export const TERM_SHARE_EVENT = "covenant:term-shares-changed";
const sharedSessions = new Set<string>();
let sharesLoaded = false;

function notifyChanged(): void {
  window.dispatchEvent(new CustomEvent(TERM_SHARE_EVENT));
}

export function isTermShared(sessionId: string): boolean {
  return sharedSessions.has(sessionId);
}

/// Idempotent — first caller triggers the fetch, later calls no-op.
export function ensureTermSharesLoaded(): void {
  if (sharesLoaded) return;
  sharesLoaded = true;
  void termShareApi
    .listShares()
    .then((ids) => {
      for (const id of ids) sharedSessions.add(id);
      if (ids.length > 0) notifyChanged();
    })
    .catch(() => {
      sharesLoaded = false; // transient failure — retry on next call
    });
}

function copyOrOffer(url: string): Promise<void> {
  return copyLinkOrOffer(
    url,
    "Share link copied — read-only",
    "Session shared — click to copy",
  );
}

export async function shareSession(sessionId: string): Promise<void> {
  const share = await termShareApi.create(sessionId);
  sharedSessions.add(sessionId);
  notifyChanged();
  await copyOrOffer(share.url);
}

export async function copyTermShareLink(sessionId: string): Promise<void> {
  const share = await termShareApi.getShare(sessionId);
  if (share) await copyOrOffer(share.url);
}

export async function stopSharing(sessionId: string): Promise<void> {
  await termShareApi.revoke(sessionId);
  sharedSessions.delete(sessionId);
  notifyChanged();
  pushInfoToast({ message: "Stopped sharing" });
}

/// Fire-and-forget close-path hook: a failed revoke must never block a
/// tab close (startup cleanup in Rust catches leftovers next boot).
export function revokeIfShared(sessionId: string): void {
  if (!sharedSessions.has(sessionId)) return;
  sharedSessions.delete(sessionId);
  notifyChanged();
  void termShareApi.revoke(sessionId).catch(() => {});
}

/// Test-only.
export function _resetForTest(): void {
  sharedSessions.clear();
  sharesLoaded = false;
}
