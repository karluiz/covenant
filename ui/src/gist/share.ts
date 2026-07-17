import { gistApi } from "./api";
import { pushInfoToast } from "../notifications/toast";

export async function shareFileAsGist(path: string): Promise<void> {
  const share = await gistApi.publish(path);
  await navigator.clipboard.writeText(share.url);
  pushInfoToast({ message: "Gist link copied" });
}

export async function copyGistLink(path: string): Promise<void> {
  const share = await gistApi.getShare(path);
  if (!share) return;
  await navigator.clipboard.writeText(share.url);
  pushInfoToast({ message: "Gist link copied" });
}

export async function revokeGist(path: string): Promise<void> {
  await gistApi.revoke(path);
  pushInfoToast({ message: "Gist revoked" });
}
