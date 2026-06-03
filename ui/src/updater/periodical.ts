// Periodical background update checker. Runs silently every hour after
// app startup. If an update is found, shows the update banner (same as
// manual check). Failures are logged but never surfaced to the user.

import { runUpdateCheck } from "./check";
import { showUpdateBanner } from "./banner";

let checkIntervalId: ReturnType<typeof setInterval> | null = null;

export async function startPeriodicUpdateCheck(currentVersion: string): Promise<void> {
  // Clear any existing interval (defensive against double-start)
  if (checkIntervalId !== null) {
    clearInterval(checkIntervalId);
  }

  // Check immediately on startup (after a short delay to let the UI settle)
  setTimeout(() => {
    void performSilentUpdateCheck(currentVersion);
  }, 2000);

  // Then check every hour
  checkIntervalId = setInterval(() => {
    void performSilentUpdateCheck(currentVersion);
  }, 60 * 60 * 1000); // 1 hour in milliseconds

  // eslint-disable-next-line no-console
  console.info("[updater] Periodic update checker started (1 hour interval)");
}

export function stopPeriodicUpdateCheck(): void {
  if (checkIntervalId !== null) {
    clearInterval(checkIntervalId);
    checkIntervalId = null;
    // eslint-disable-next-line no-console
    console.info("[updater] Periodic update checker stopped");
  }
}

async function performSilentUpdateCheck(currentVersion: string): Promise<void> {
  try {
    const result = await runUpdateCheck({ currentVersion, silent: true });
    if (result.kind === "available") {
      // Update found! Show the banner (same as if user manually checked)
      showUpdateBanner(result.update);
      // eslint-disable-next-line no-console
      console.info(
        `[updater] Update available: v${result.version} (currently v${currentVersion})`
      );
    } else if (result.kind === "uptodate") {
      // eslint-disable-next-line no-console
      console.debug("[updater] Covenant is up to date");
    }
  } catch (err) {
    // Silently log (already logged in runUpdateCheck with silent: true)
    // eslint-disable-next-line no-console
    console.warn("[updater] Periodic check error:", err);
  }
}
