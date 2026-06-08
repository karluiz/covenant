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
