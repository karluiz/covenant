// Discreet top-of-window banner shown when an update is available.
// "Install now" triggers download + install + relaunch.
// "Later" hides the banner for this session only — next boot will
// re-check and re-show it.

import type { Update } from "@tauri-apps/plugin-updater";
import { installAndRelaunch } from "./check";

const BANNER_ID = "covenant-update-banner";

export function showUpdateBanner(update: Update): void {
  if (document.getElementById(BANNER_ID)) return; // idempotent

  const banner = document.createElement("div");
  banner.id = BANNER_ID;
  banner.className = "update-banner";
  banner.innerHTML = `
    <span class="update-banner__text">Covenant ${update.version} is available.</span>
    <button class="update-banner__install" type="button">Install now</button>
    <button class="update-banner__dismiss" type="button" aria-label="Dismiss">×</button>
  `;

  banner.querySelector<HTMLButtonElement>(".update-banner__install")!
    .addEventListener("click", async () => {
      banner.classList.add("update-banner--installing");
      banner.querySelector<HTMLElement>(".update-banner__text")!.textContent =
        "Downloading…";
      try {
        await installAndRelaunch(update);
      } catch (err) {
        banner.querySelector<HTMLElement>(".update-banner__text")!.textContent =
          `Install failed: ${err instanceof Error ? err.message : String(err)}`;
        banner.classList.remove("update-banner--installing");
      }
    });

  banner.querySelector<HTMLButtonElement>(".update-banner__dismiss")!
    .addEventListener("click", () => banner.remove());

  document.body.prepend(banner);
}
