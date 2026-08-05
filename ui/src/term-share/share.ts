import { termShareApi, type ShareMode } from "./api";
import { pushInfoToast } from "../notifications/toast";
import { copyLinkOrOffer } from "../ui/share-link";

/// Locally-known shared sessions, mirrored from the backend store so the
/// tab strip can badge synchronously. Same shape as gist/share.ts.
export const TERM_SHARE_EVENT = "covenant:term-shares-changed";
const roShares = new Set<string>();
const collabShares = new Set<string>();
let sharesLoaded = false;

function setFor(mode: ShareMode): Set<string> {
  return mode === "collab" ? collabShares : roShares;
}

function notifyChanged(): void {
  window.dispatchEvent(new CustomEvent(TERM_SHARE_EVENT));
}

/// Any mode.
export function isTermShared(sessionId: string): boolean {
  return roShares.has(sessionId) || collabShares.has(sessionId);
}

export function isRoShared(sessionId: string): boolean {
  return roShares.has(sessionId);
}

export function isCollabShared(sessionId: string): boolean {
  return collabShares.has(sessionId);
}

/// Idempotent — first caller triggers the fetch, later calls no-op.
export function ensureTermSharesLoaded(): void {
  if (sharesLoaded) return;
  sharesLoaded = true;
  void termShareApi
    .listShares()
    .then((entries) => {
      for (const e of entries) setFor(e.mode).add(e.sessionId);
      if (entries.length > 0) notifyChanged();
    })
    .catch(() => {
      sharesLoaded = false; // transient failure — retry on next call
    });
}

function copyOrOffer(url: string, mode: ShareMode): Promise<void> {
  return copyLinkOrOffer(
    url,
    mode === "collab"
      ? "Share link copied — collaborative (guest can request control)"
      : "Share link copied — read-only",
    "Session shared — click to copy",
  );
}

export async function shareSession(
  sessionId: string,
  mode: ShareMode,
): Promise<void> {
  const share = await termShareApi.create(sessionId, mode);
  setFor(mode).add(sessionId);
  notifyChanged();
  await copyOrOffer(share.url, mode);
}

export async function copyTermShareLink(
  sessionId: string,
  mode: ShareMode,
): Promise<void> {
  const share = await termShareApi.getShare(sessionId, mode);
  if (share) await copyOrOffer(share.url, mode);
}

export async function stopSharing(
  sessionId: string,
  mode: ShareMode,
): Promise<void> {
  await termShareApi.revoke(sessionId, mode);
  setFor(mode).delete(sessionId);
  notifyChanged();
  pushInfoToast({ message: "Stopped sharing" });
}

/// Fire-and-forget close-path hook: a failed revoke must never block a
/// tab close (startup cleanup in Rust catches leftovers next boot).
/// Revokes ALL modes for the session.
export function revokeIfShared(sessionId: string): void {
  const modes: ShareMode[] = [];
  if (roShares.has(sessionId)) modes.push("ro");
  if (collabShares.has(sessionId)) modes.push("collab");
  if (modes.length === 0) return;
  for (const mode of modes) {
    setFor(mode).delete(sessionId);
    void termShareApi.revoke(sessionId, mode).catch(() => {});
  }
  notifyChanged();
}

/// Test-only.
export function _resetForTest(): void {
  roShares.clear();
  collabShares.clear();
  sharesLoaded = false;
}
