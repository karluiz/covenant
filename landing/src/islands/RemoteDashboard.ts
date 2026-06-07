import { parseFrame, wsUrl, reduce, initialState, type DashState } from "../remote/protocol";

const RELAY_BASE = "https://forge.covenant.uno";
const TOKEN_KEY = "covenant_rc_token";

export function mountRemoteDashboard(doc: Document = document): void {
  const tokenInput = doc.getElementById("rc-token") as HTMLInputElement | null;
  const connectBtn = doc.getElementById("rc-connect") as HTMLButtonElement | null;
  const statusEl = doc.getElementById("rc-status");
  const tabsEl = doc.getElementById("rc-tabs");
  if (!tokenInput || !connectBtn || !statusEl || !tabsEl) return;

  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) tokenInput.value = saved;

  let state: DashState = initialState();
  let ws: WebSocket | null = null;
  let reconnectTimer: number | undefined;

  const render = () => {
    statusEl.textContent = state.desktopOnline ? "● desktop online" : "○ desktop offline";
    statusEl.className = state.desktopOnline ? "text-emerald-400 text-sm mb-4" : "text-zinc-500 text-sm mb-4";
    if (state.tabs.length === 0) { tabsEl.innerHTML = `<p class="text-zinc-500">No tabs.</p>`; return; }
    tabsEl.innerHTML = state.tabs.map((t) => `
      <div class="rounded border border-emerald-900/50 bg-black/30 p-3">
        <div class="flex items-center justify-between">
          <span class="text-emerald-300">${escapeHtml(t.title)}</span>
          <span class="text-xs text-zinc-400">${escapeHtml(t.executor ?? "shell")} · ${escapeHtml(t.phase)}</span>
        </div>
        <div class="text-xs text-zinc-500">${escapeHtml(t.cwd)}</div>
      </div>`).join("");
  };

  const connect = () => {
    const token = tokenInput.value.trim();
    if (!token) return;
    localStorage.setItem(TOKEN_KEY, token);
    if (ws) { ws.close(); ws = null; }
    ws = new WebSocket(wsUrl(RELAY_BASE, token));
    ws.onopen = () => { ws?.send(JSON.stringify({ t: "list_tabs" })); };
    ws.onmessage = (e) => { const f = parseFrame(typeof e.data === "string" ? e.data : ""); if (f) { state = reduce(state, f); render(); } };
    ws.onclose = () => { state = { ...state, desktopOnline: false }; render(); reconnectTimer = window.setTimeout(connect, 3000); };
    ws.onerror = () => { ws?.close(); };
  };

  connectBtn.addEventListener("click", () => { if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; } connect(); });
  render();
  if (saved) connect();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
