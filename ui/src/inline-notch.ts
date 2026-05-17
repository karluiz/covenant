/// Inline notch rack — mirrors the overlay window's pill rendering but
/// lives inside the main Covenant webview. Activated when the OS-level
/// overlay is suppressed (currently: when Covenant is in fullscreen).

import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { StackStore, type PillInput, type ExecutorPhase } from "../notch/store";
import { mountRender } from "../notch/render";
import "../notch/styles.css";

const TAB_COLORS = [
  "#7c5cff",
  "#5ad1ff",
  "#7cffb2",
  "#ffcb5a",
  "#ffb13a",
  "#ff7cb2",
];
function hash(s: string): number {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return Math.abs(h);
}
const tabColorFor = (sid: string) => TAB_COLORS[hash(sid) % TAB_COLORS.length];

type StatePayload = {
  session: string;
  phase: ExecutorPhase;
  tab_label?: string | null;
};

/// Mount an inline pill rack inside `host`. Visible only while the main
/// window is fullscreen (controlled by `notch:inline-mode` events).
export function mountInlineNotch(host: HTMLElement): void {
  const root = document.createElement("div");
  root.className = "inline-notch";
  root.style.display = "none";
  const stack = document.createElement("div");
  stack.className = "stack";
  root.appendChild(stack);
  host.appendChild(root);

  const store = new StackStore();
  mountRender(stack, store);

  let inlineMode = false;
  const setMode = (enabled: boolean): void => {
    inlineMode = enabled;
    root.style.display = enabled ? "" : "none";
  };

  // Reuse the overlay's events. Both fire globally via app.emit, so the
  // main webview just needs to subscribe.
  listen<StatePayload>("notch:state", (ev) => {
    if (!inlineMode) return;
    const sid = ev.payload.session;
    if (ev.payload.phase.kind === "idle") {
      store.drop(sid);
      return;
    }
    const input: PillInput = {
      sessionId: sid,
      tabLabel: ev.payload.tab_label ?? `session ${sid.slice(0, 6)}`,
      tabColor: tabColorFor(sid),
      phase: ev.payload.phase,
    };
    store.apply(input);
  });

  listen<{ enabled: boolean }>("notch:inline-mode", (ev) => setMode(ev.payload.enabled));

  setInterval(() => {
    if (inlineMode) store.gc();
  }, 500);

  // Ask the backend to replay current state in case fullscreen toggled
  // before this component mounted.
  invoke("notch_ready").catch(() => {});
}
