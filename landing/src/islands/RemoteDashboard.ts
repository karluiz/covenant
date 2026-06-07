import { parseFrame, wsUrl, reduce, initialState, type DashState } from "../remote/protocol";

const RELAY_BASE = "https://forge.covenant.uno";
const TOKEN_KEY = "covenant_rc_token";
const MAX_BACKOFF = 30000;

type Conn = "idle" | "connecting" | "online" | "retrying";

export function mountRemoteDashboard(doc: Document = document): void {
  const tokenInput = doc.getElementById("rc-token") as HTMLInputElement | null;
  const connectBtn = doc.getElementById("rc-connect") as HTMLButtonElement | null;
  const statusEl = doc.getElementById("rc-status");
  const tabsEl = doc.getElementById("rc-tabs");
  if (!tokenInput || !connectBtn || !statusEl || !tabsEl) return;

  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) tokenInput.value = saved;

  let state: DashState = initialState();
  let conn: Conn = "idle";
  let ws: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let backoff = 3000;
  let gen = 0; // epoch: increments every (re)connect; stale handlers no-op

  const render = () => {
    const map: Record<Conn, [string, string]> = {
      idle: ["○ not connected", "text-zinc-500 text-sm mb-4"],
      connecting: ["… connecting", "text-amber-400 text-sm mb-4"],
      online: ["● desktop online", "text-emerald-400 text-sm mb-4"],
      retrying: ["○ disconnected — retrying", "text-zinc-500 text-sm mb-4"],
    };
    const online = conn === "online" && state.desktopOnline;
    const [text, cls] = online ? map.online : map[conn];
    statusEl.textContent = text;
    statusEl.className = cls;
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

  const teardown = (sock: WebSocket | null) => {
    if (!sock) return;
    sock.onopen = sock.onmessage = sock.onclose = sock.onerror = null;
    try { sock.close(); } catch { /* ignore */ }
  };

  const scheduleReconnect = () => {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    conn = "retrying";
    render();
    reconnectTimer = window.setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  };

  function connect() {
    const token = tokenInput!.value.trim();
    if (!token) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    teardown(ws);
    ws = null;

    const myGen = ++gen;            // claim this epoch
    conn = "connecting";
    render();

    const sock = new WebSocket(wsUrl(RELAY_BASE, token));
    ws = sock;
    sock.onopen = () => {
      if (myGen !== gen) return;     // superseded
      localStorage.setItem(TOKEN_KEY, token); // persist only after a real open
      backoff = 3000;                // reset backoff on success
      conn = "online";
      render();
      sock.send(JSON.stringify({ t: "list_tabs" }));
    };
    sock.onmessage = (e) => {
      if (myGen !== gen) return;
      const f = parseFrame(typeof e.data === "string" ? e.data : "");
      if (f) { state = reduce(state, f); render(); }
    };
    sock.onclose = () => {
      if (myGen !== gen) return;     // a replaced socket: do nothing
      state = { ...state, desktopOnline: false };
      scheduleReconnect();
    };
    sock.onerror = () => {
      if (myGen !== gen) return;
      teardown(sock);                // routes to no handler (detached); we drive reconnect
      scheduleReconnect();
    };
  }

  connectBtn.addEventListener("click", () => connect());
  render();
  if (saved) connect();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
