import { cloudSyncStatus, cloudSyncPush } from "../api";

let timer: ReturnType<typeof setTimeout> | null = null;

/** Debounced background push. Safe to call from any save path; cheap no-op
 *  when sync is disabled or the user is signed out. Never throws to callers. */
export function scheduleCloudPush(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void (async () => {
      try {
        const s = await cloudSyncStatus();
        if (!s.signed_in || !s.enabled) return;
        await cloudSyncPush();
      } catch {
        // one silent retry after 10s; then give up until the next change
        setTimeout(() => void cloudSyncPush().catch(() => {}), 10_000);
      }
    })();
  }, 5_000);
}
