import { gistApi } from "./api";
import { pushInfoToast } from "../notifications/toast";
import { copyText } from "../ui/clipboard";

/// Copy, and if the webview refuses (transient activation is gone after the
/// network round-trip), fall back to a toast the user clicks — that click IS
/// a fresh user gesture, so the retry succeeds. Publishing already happened;
/// a clipboard hiccup must never read as "share failed".
async function copyOrOffer(url: string): Promise<void> {
  try {
    await copyText(url);
    pushInfoToast({ message: "Gist link copied" });
  } catch {
    pushInfoToast({
      message: `Gist published — click to copy: ${url}`,
      onClick: () => {
        void copyText(url);
      },
    });
  }
}

export async function shareFileAsGist(path: string): Promise<void> {
  const share = await gistApi.publish(path);
  await copyOrOffer(share.url);
}

export async function copyGistLink(path: string): Promise<void> {
  const share = await gistApi.getShare(path);
  if (!share) return;
  await copyOrOffer(share.url);
}

export async function revokeGist(path: string): Promise<void> {
  await gistApi.revoke(path);
  pushInfoToast({ message: "Gist revoked" });
}
