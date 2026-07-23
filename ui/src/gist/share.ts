import { gistApi } from "./api";
import { pushInfoToast } from "../notifications/toast";
import { copyLinkOrOffer } from "../ui/share-link";

/// Locally-known shared paths, mirrored from the backend's share store so
/// views can badge rows synchronously. Views listen for GIST_SHARES_EVENT
/// to re-badge after a share / revoke (or the initial load).
export const GIST_SHARES_EVENT = "covenant:gist-shares-changed";
const sharedPaths = new Set<string>();
let sharesLoaded = false;

function notifySharesChanged(): void {
  window.dispatchEvent(new CustomEvent(GIST_SHARES_EVENT));
}

export function isGistShared(path: string): boolean {
  return sharedPaths.has(path);
}

/// Idempotent — first caller triggers the fetch, later calls no-op.
export function ensureGistSharesLoaded(): void {
  if (sharesLoaded) return;
  sharesLoaded = true;
  void gistApi
    .listShares()
    .then((paths) => {
      for (const p of paths) sharedPaths.add(p);
      if (paths.length > 0) notifySharesChanged();
    })
    .catch(() => {
      sharesLoaded = false; // transient failure — retry on next call
    });
}

export async function shareFileAsGist(path: string): Promise<void> {
  const share = await gistApi.publish(path);
  sharedPaths.add(path);
  notifySharesChanged();
  await copyLinkOrOffer(share.url, "Gist link copied", "Gist published — click to copy");
}

export async function copyGistLink(path: string): Promise<void> {
  const share = await gistApi.getShare(path);
  if (!share) return;
  await copyLinkOrOffer(share.url, "Gist link copied", "Gist published — click to copy");
}

export async function revokeGist(path: string): Promise<void> {
  await gistApi.revoke(path);
  sharedPaths.delete(path);
  notifySharesChanged();
  pushInfoToast({ message: "Gist revoked" });
}
