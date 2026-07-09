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

// Resting glyph: in notch modes the HUD is a permanent extension of the
// physical notch, so show a quiet resting dot whenever there's no active
// pill. Corner modes stay hidden when idle.
const rest = document.getElementById("rest") as HTMLElement;
const syncRest = (): void => {
  // Only the minimal nub keeps a resting state (a small black tab flush with
  // the notch). The full Dynamic Island shows nothing at rest and only its
  // pill on activity — a persistent black box there just floats and misaligns.
  const restingMode = document.body.dataset.corner === "notch-mini";
  rest.hidden = !(restingMode && store.pills().length === 0);
};
store.subscribe(syncRest);

type StatePayload = {
  session: string;
  phase: ExecutorPhase;
  tab_label?: string | null;
};

const onNotchState = (ev: { payload: StatePayload }): void => {
  const sid = ev.payload.session;
  // Idle is the explicit "agent stopped" signal — drop any existing pill.
  if (ev.payload.phase.kind === "idle") {
    store.drop(sid);
    return;
  }
  // Backend already dedupes Done per turn, so any Done that reaches us
  // is the *first* one for this turn — safe to chime unconditionally.
  if (ev.payload.phase.kind === "done") {
    playDoneChime();
  }
  const input: PillInput = {
    sessionId: sid,
    tabLabel: ev.payload.tab_label ?? `session ${sid.slice(0, 6)}`,
    tabColor: tabColorFor(sid),
    phase: ev.payload.phase,
  };
  store.apply(input);
};

const notchStateListenerReady = listen<StatePayload>("notch:state", onNotchState);

setInterval(() => store.gc(), 500);

type NotchCorner =
  | "bottom-right"
  | "bottom-left"
  | "top-right"
  | "top-left"
  | "notch"
  | "notch-mini";
type NotchTheme = "dark" | "light" | "system";
type NotchReady = { corner: NotchCorner; sound_on_done: boolean; theme?: NotchTheme };
const applyCorner = (corner: NotchCorner) => {
  document.body.dataset.corner = corner;
  syncRest();
};
const applyTheme = (theme: NotchTheme) => {
  // `system` intentionally leaves both classes off so CSS can follow
  // prefers-color-scheme even if the notch webview mounted before the
  // main window resolved the setting.
  document.body.classList.toggle("notch-theme-light", theme === "light");
  document.body.classList.toggle("notch-theme-dark", theme === "dark");
};
applyCorner("bottom-right");
applyTheme("system");

// Done chime — soft 880 Hz sine pop. Quick attack, gentle decay.
// Generated on demand via Web Audio so we don't ship an audio file.
let soundOnDone = true;
function playDoneChime(): void {
  if (!soundOnDone) return;
  try {
    const ctx = new (window.AudioContext ||
      // @ts-expect-error webkit prefix
      window.webkitAudioContext)();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(880, now); // A5
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.005);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.185);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.25);
  } catch {
    // No-op: webview without audio support.
  }
}

// Replay phases from sessions that started before this WebView mounted.
// Also returns the current corner + sound preference from settings. Wait
// until the listener is registered so snapshot events are not lost.
notchStateListenerReady
  .then(() => invoke<NotchReady>("notch_ready"))
  .then((r) => {
    if (!r) return;
    applyCorner(r.corner);
    applyTheme(r.theme ?? "system");
    soundOnDone = r.sound_on_done;
  })
  .catch(() => {});

listen<{ corner: NotchCorner }>("notch:corner", (ev) => applyCorner(ev.payload.corner));
listen<{ mode: NotchTheme }>("notch:theme", (ev) => applyTheme(ev.payload.mode));
listen<{ sound_on_done: boolean }>("notch:sound", (ev) => {
  soundOnDone = ev.payload.sound_on_done;
});

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
