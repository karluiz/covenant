import { pushInfoToast } from "../notifications/toast";
import { copyText } from "./clipboard";

/// Copy, and if the webview refuses (transient activation is gone after a
/// network round-trip), fall back to a toast the user clicks — that click
/// IS a fresh user gesture, so the retry succeeds. Publishing already
/// happened; a clipboard hiccup must never read as "share failed".
export async function copyLinkOrOffer(
  url: string,
  copiedMsg: string,
  offerMsg: string,
): Promise<void> {
  try {
    await copyText(url);
    pushInfoToast({ message: copiedMsg });
  } catch {
    pushInfoToast({
      message: `${offerMsg}: ${url}`,
      onClick: () => {
        void copyText(url);
      },
    });
  }
}
