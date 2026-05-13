// Thin typed wrapper around @tauri-apps/plugin-updater. Lets the rest
// of the UI consume update state as a discriminated union instead of
// the plugin's looser shape, and centralises error handling for the
// silent boot-time check (which must never surface a toast on its own
// — failures are logged, not shown).

import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateCheckResult =
  | { kind: "available"; version: string; notes: string | null; update: Update }
  | { kind: "uptodate"; currentVersion: string }
  | { kind: "error"; message: string };

export async function runUpdateCheck(opts: {
  currentVersion: string;
  silent: boolean;
}): Promise<UpdateCheckResult> {
  try {
    const update = await check();
    if (update?.available) {
      return {
        kind: "available",
        version: update.version,
        notes: update.body ?? null,
        update,
      };
    }
    return { kind: "uptodate", currentVersion: opts.currentVersion };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (opts.silent) {
      console.warn("[updater] silent check failed:", message);
    }
    return { kind: "error", message };
  }
}

export async function installAndRelaunch(update: Update): Promise<void> {
  await update.downloadAndInstall();
  // On macOS the plugin auto-restarts after install. On Windows the
  // MSI installer takes over and the app exits; tauri-plugin-process
  // gives us an explicit relaunch in case the platform doesn't.
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
