export interface TabInfo { session_id: string; title: string; cwd: string; executor: string | null; phase: string; armed: boolean; }
export type Frame = { t: "tabs"; device_id: string; tabs: TabInfo[] } | { t: "presence"; desktop_online: boolean };

export function parseFrame(text: string): Frame | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.t === "presence" && typeof o.desktop_online === "boolean") return { t: "presence", desktop_online: o.desktop_online };
  if (o.t === "tabs" && Array.isArray(o.tabs) && typeof o.device_id === "string") return { t: "tabs", device_id: o.device_id, tabs: o.tabs as TabInfo[] };
  return null;
}
export function wsUrl(base: string, token: string): string {
  const b = base.replace(/\/+$/, "").replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  return `${b}/rc/web?token=${encodeURIComponent(token)}`;
}
export interface DashState { desktopOnline: boolean; tabs: TabInfo[]; }
export function initialState(): DashState { return { desktopOnline: false, tabs: [] }; }
export function reduce(state: DashState, frame: Frame): DashState {
  switch (frame.t) {
    case "presence": return { ...state, desktopOnline: frame.desktop_online };
    case "tabs": return { ...state, tabs: frame.tabs };
  }
}
