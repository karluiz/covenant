// AOM liveness Task 4 — frontend connectivity bridge.
//
// Bridges the browser's `navigator.onLine` + `online`/`offline` window
// events to the Rust backend's global connectivity state via the
// `set_connectivity` Tauri command. The operator tick reads that
// state on every poll and short-circuits when offline so AOM doesn't
// burn rate-limit budget on calls that will fail with DNS errors.
//
// v0 trusts the browser as the single source of truth — backend
// heartbeat is a TODO. WebView2 / WKWebView fire `online`/`offline`
// when the OS network state flips, which is good enough for "AOM
// pauses when wifi drops".
//
// Module also exposes `subscribeOnline` so the AOM banner can render
// "AOM paused — offline" without re-querying the DOM listener stack.

import { invoke } from "@tauri-apps/api/core";

type Listener = (online: boolean) => void;

const listeners = new Set<Listener>();
let current: boolean = typeof navigator !== "undefined" ? navigator.onLine : true;
let installed = false;

async function pushBackend(online: boolean): Promise<void> {
  try {
    await invoke<void>("set_connectivity", { online });
  } catch (err) {
    // Best-effort: backend will recover on next transition. Don't let
    // a missing command crash the boot path during dev hot-reload.
    // eslint-disable-next-line no-console
    console.warn("[connectivity] set_connectivity failed", err);
  }
}

function notify(online: boolean): void {
  current = online;
  for (const l of listeners) {
    try {
      l(online);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[connectivity] listener threw", err);
    }
  }
}

/** Returns the most recently observed online state. */
export function isOnline(): boolean {
  return current;
}

/** Subscribe to online/offline transitions. Returns an unsubscribe fn. */
export function subscribeOnline(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/**
 * Mount a small floating pill that says "AOM paused — offline" while
 * the OS reports no network. Owned entirely by this module so it does
 * NOT conflict with the AOM banner being refactored in parallel; once
 * the banner integrates `subscribeOnline` directly we can drop this.
 *
 * Placed at top-center, fixed position, hidden when online.
 */
export function mountOfflinePill(host: HTMLElement = document.body): () => void {
  const el = document.createElement("div");
  el.className = "aom-offline-pill";
  el.hidden = true;
  el.setAttribute("role", "status");
  el.textContent = "AOM paused — offline";
  host.appendChild(el);

  const apply = (on: boolean) => {
    el.hidden = on;
  };
  apply(isOnline());
  const unsub = subscribeOnline(apply);
  return () => {
    unsub();
    el.remove();
  };
}

/**
 * Install the window listeners and seed the backend with the current
 * `navigator.onLine` value. Idempotent — safe to call from main()
 * regardless of hot-reload state.
 */
export function installConnectivityBridge(): void {
  if (installed) return;
  installed = true;

  const onOnline = () => {
    notify(true);
    void pushBackend(true);
  };
  const onOffline = () => {
    notify(false);
    void pushBackend(false);
  };

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  // Seed: the backend defaults to Online but the OS may already be
  // offline at boot. Push the current value so the gate engages
  // immediately when starting offline.
  const initial = typeof navigator !== "undefined" ? navigator.onLine : true;
  notify(initial);
  void pushBackend(initial);
}
