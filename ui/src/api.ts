// Typed wrappers around Tauri commands.
//
// Every command exposed by `karl-app` MUST funnel through this file so the
// frontend has a single, type-safe surface and we can swap transports
// without touching call sites.

import { invoke } from "@tauri-apps/api/core";

// M0 placeholder: no commands yet. M0 step 4 will add `spawnSession()` and
// the matching event subscription helpers.

export async function ping(): Promise<string> {
  // Will be replaced by the real session API. For now this just exists to
  // give `main.ts` something to import without `@tauri-apps/api` being
  // tree-shaken to oblivion.
  return invoke<string>("ping").catch(() => "no-tauri");
}
