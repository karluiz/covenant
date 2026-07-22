export interface TabInfo { session_id: string; title: string; cwd: string; executor: string | null; phase: string; armed: boolean; }
export type Frame =
  | { t: "tabs"; device_id: string; tabs: TabInfo[] }
  | { t: "presence"; desktop_online: boolean }
  | { t: "rejected"; session_id: string; reason: string; message: string };

export function parseFrame(text: string): Frame | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.t === "presence" && typeof o.desktop_online === "boolean") return { t: "presence", desktop_online: o.desktop_online };
  if (o.t === "tabs" && Array.isArray(o.tabs) && typeof o.device_id === "string") return { t: "tabs", device_id: o.device_id, tabs: o.tabs as TabInfo[] };
  if (o.t === "rejected" && typeof o.session_id === "string" && typeof o.reason === "string" && typeof o.message === "string")
    return { t: "rejected", session_id: o.session_id, reason: o.reason, message: o.message };
  return null;
}
export function wsUrl(base: string, token: string): string {
  const b = base.replace(/\/+$/, "").replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  return `${b}/rc/web?token=${encodeURIComponent(token)}`;
}
export interface DashState { desktopOnline: boolean; tabs: TabInfo[]; rejections: Record<string, string>; }
export function initialState(): DashState { return { desktopOnline: false, tabs: [], rejections: {} }; }
export function reduce(state: DashState, frame: Frame): DashState {
  switch (frame.t) {
    case "presence": return { ...state, desktopOnline: frame.desktop_online };
    case "tabs": {
      // Authoritative rejection cleanup: keep rejections for sessions still
      // present, drop those whose tab disappeared. (The island's per-sid clear
      // on send is just optimistic snappiness.)
      const present = new Set(frame.tabs.map((t) => t.session_id));
      const rejections: Record<string, string> = {};
      for (const [sid, msg] of Object.entries(state.rejections)) {
        if (present.has(sid)) rejections[sid] = msg;
      }
      return { ...state, tabs: frame.tabs, rejections };
    }
    case "rejected": return { ...state, rejections: { ...state.rejections, [frame.session_id]: frame.message } };
  }
}
export function sendInputFrame(sessionId: string, text: string): string {
  const data = text.endsWith("\n") ? text : text + "\n";
  return JSON.stringify({ t: "send_input", session_id: sessionId, data });
}

export function closeTabFrame(sessionId: string): string { return JSON.stringify({ t: "close_tab", session_id: sessionId }); }
export function focusTabFrame(sessionId: string): string { return JSON.stringify({ t: "focus_tab", session_id: sessionId }); }

export function openTabFrame(cwd?: string): string {
  return cwd ? JSON.stringify({ t: "open_tab", cwd }) : JSON.stringify({ t: "open_tab" });
}

export function mirrorStartFrame(sessionId: string): string { return JSON.stringify({ t: "mirror_start", session_id: sessionId }); }
export function mirrorStopFrame(sessionId: string): string { return JSON.stringify({ t: "mirror_stop", session_id: sessionId }); }
// `cols`/`rows` are the source PTY's grid; absent from desktops older than
// the fix that added them, in which case the viewer falls back to fitting
// its own pane (and re-wraps every already-wrapped line at the wrong column).
export type MirrorMsg =
  | { kind: "screen"; sessionId: string; text: string; cols?: number; rows?: number }
  | { kind: "data"; sessionId: string; bytes: Uint8Array };
export function parseMirrorFrame(text: string): MirrorMsg | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.t === "mirror_screen" && typeof o.session_id === "string" && typeof o.screen === "string") {
    const cols = typeof o.cols === "number" && o.cols > 0 ? o.cols : undefined;
    const rows = typeof o.rows === "number" && o.rows > 0 ? o.rows : undefined;
    return { kind: "screen", sessionId: o.session_id, text: o.screen, cols, rows };
  }
  if (o.t === "mirror_data" && typeof o.session_id === "string" && typeof o.b64 === "string") {
    const bin = atob(o.b64); const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { kind: "data", sessionId: o.session_id, bytes };
  }
  return null;
}
