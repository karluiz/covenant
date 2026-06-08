import { parseFrame, wsUrl, reduce, initialState, sendInputFrame, type DashState } from "../remote/protocol";

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
  let composing = false;     // true while an .rc-cmd input is mid-IME-composition
  let pendingRender = false;  // a render was deferred during composition

  const render = () => {
    // Defer any innerHTML rebuild while composing (CJK/accents/dictation):
    // rebuilding would destroy the composition node and lose input. State is
    // already updated by reduce(); compositionend replays a single render().
    if (composing) { pendingRender = true; return; }
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

    // Focus preservation: capture the focused .rc-cmd input's identity + caret.
    const active = doc.activeElement as HTMLInputElement | null;
    let focusedSid: string | null = null;
    let focusedVal = "";
    let selStart = 0, selEnd = 0;
    if (active && active.classList.contains("rc-cmd")) {
      focusedSid = active.getAttribute("data-sid");
      focusedVal = active.value;
      selStart = active.selectionStart ?? focusedVal.length;
      selEnd = active.selectionEnd ?? focusedVal.length;
    }

    tabsEl.innerHTML = state.tabs.map((t) => {
      const sid = escapeAttr(t.session_id);
      const rejection = state.rejections[t.session_id];
      const armedBadge = t.armed
        ? `<span class="text-xs text-emerald-400">● armed</span>`
        : `<span class="text-xs text-zinc-500">○ not armed</span>`;
      const control = t.armed
        ? `<div class="mt-2 flex gap-2">
            <input class="rc-cmd flex-1 rounded border border-emerald-900/50 bg-black/40 px-2 py-1 text-sm text-emerald-100" data-sid="${sid}" placeholder="command…" />
            <button class="rc-send rounded border border-emerald-700 bg-emerald-900/40 px-3 py-1 text-sm text-emerald-200" data-sid="${sid}">Send</button>
          </div>`
        : `<div class="mt-2 text-xs text-zinc-500">Arm this tab on the desktop to control it.</div>`;
      const rejLine = rejection
        ? `<div class="mt-1 text-xs text-red-400">✗ ${escapeHtml(rejection)}</div>`
        : "";
      return `
      <div class="rounded border border-emerald-900/50 bg-black/30 p-3">
        <div class="flex items-center justify-between">
          <span class="text-emerald-300">${escapeHtml(t.title)}</span>
          <span class="text-xs text-zinc-400">${escapeHtml(t.executor ?? "shell")} · ${escapeHtml(t.phase)}</span>
        </div>
        <div class="text-xs text-zinc-500">${escapeHtml(t.cwd)}</div>
        <div class="mt-1">${armedBadge}</div>
        ${control}
        ${rejLine}
      </div>`;
    }).join("");

    // Restore focus + caret on the matching input after innerHTML rebuild.
    if (focusedSid) {
      const sel = `input.rc-cmd[data-sid="${cssEscape(focusedSid)}"]`;
      const next = tabsEl.querySelector(sel) as HTMLInputElement | null;
      if (next) {
        next.value = focusedVal;
        next.focus();
        try { next.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
      }
    }
  };

  const sendFor = (sid: string) => {
    const input = tabsEl.querySelector(`input.rc-cmd[data-sid="${cssEscape(sid)}"]`) as HTMLInputElement | null;
    if (!input) return;
    const text = input.value;
    if (text.trim() === "") return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(sendInputFrame(sid, text));
      input.value = "";
      if (state.rejections[sid]) {
        const { [sid]: _, ...rest } = state.rejections;
        state = { ...state, rejections: rest };
      }
      render();
    }
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

  // Event delegation, attached once.
  tabsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button.rc-send") as HTMLElement | null;
    if (!btn) return;
    const sid = btn.getAttribute("data-sid");
    if (sid) sendFor(sid);
  });
  tabsEl.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key !== "Enter") return;
    const input = (ev.target as HTMLElement).closest("input.rc-cmd") as HTMLElement | null;
    if (!input) return;
    ev.preventDefault();
    const sid = input.getAttribute("data-sid");
    if (sid) sendFor(sid);
  });
  tabsEl.addEventListener("compositionstart", (e) => {
    if ((e.target as HTMLElement).classList?.contains("rc-cmd")) composing = true;
  });
  tabsEl.addEventListener("compositionend", (e) => {
    if ((e.target as HTMLElement).classList?.contains("rc-cmd")) {
      composing = false;
      if (pendingRender) { pendingRender = false; render(); }
    }
  });

  render();
  if (saved) connect();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
}
function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/`/g, "&#96;");
}
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, "\\$&");
}
