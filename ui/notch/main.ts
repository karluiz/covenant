import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { StackStore, type PillInput, type ExecutorPhase } from "./store";
import { mountRender } from "./render";

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

const store = new StackStore();
const stack = document.getElementById("stack") as HTMLElement;
mountRender(stack, store);

type StatePayload = {
  session: string;
  phase: ExecutorPhase;
  tab_label?: string | null;
};

listen<StatePayload>("notch:state", (ev) => {
  const sid = ev.payload.session;
  // Idle is the explicit "agent stopped" signal — drop any existing pill.
  // Thinking from the backend is now whitelist-only (Claude Code's
  // explicit processing-status line) so it's high-signal: render it.
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

setInterval(() => store.gc(), 500);

// Replay phases from sessions that started before this WebView mounted.
invoke("notch_ready").catch(() => {});

// Hotkey probe: when the user toggles the notch open and there are no
// active executor pills, drop a short-lived "ready" hint so the window
// is visibly there. Auto-dismisses via the Done TTL path.
listen("notch:probe", () => {
  if (store.pills().length === 0) {
    store.apply({
      sessionId: "__probe__",
      tabLabel: "notch",
      tabColor: "#7c5cff",
      phase: { kind: "done", summary: "ready — no active agents" },
    });
  }
});

const setPassthrough = (pass: boolean) =>
  invoke("notch_set_passthrough", { passthrough: pass }).catch(() => {});
stack.addEventListener("mouseenter", () => setPassthrough(false));
stack.addEventListener("mouseleave", () => setPassthrough(true));
setPassthrough(true);
