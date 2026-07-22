import { parseFrame, wsUrl, reduce, initialState, sendInputFrame, closeTabFrame, focusTabFrame, openTabFrame, mirrorStartFrame, mirrorStopFrame, parseMirrorFrame, type DashState, type TabInfo } from "../remote/protocol";
import { sortTabs, resolveSelection, mirrorTransition } from "../remote/view-model";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

const RELAY_BASE = "https://forge.covenant.uno";
const TOKEN_KEY = "covenant_rc_token";
const MAX_BACKOFF = 30000;

type Conn = "idle" | "connecting" | "online" | "retrying";
type MobileView = "list" | "detail";

export function mountRemoteDashboard(doc: Document = document): void {
  const tokenRow = doc.getElementById("rc-token-row");
  const tokenInput = doc.getElementById("rc-token") as HTMLInputElement | null;
  const connectBtn = doc.getElementById("rc-connect") as HTMLButtonElement | null;
  const tokenToggle = doc.getElementById("rc-token-toggle") as HTMLButtonElement | null;
  const statusEl = doc.getElementById("rc-status");
  const listEl = doc.getElementById("rc-list");
  const detailEl = doc.getElementById("rc-detail");
  const detailInfoEl = doc.getElementById("rc-detail-info");
  const mirrorWrapEl = doc.getElementById("rc-detail-mirror");
  const mirrorTermEl = doc.getElementById("rc-mirror-term");
  const newTabBtn = doc.getElementById("rc-new-tab") as HTMLButtonElement | null;
  const openErrEl = doc.getElementById("rc-open-error");
  if (!tokenInput || !connectBtn || !statusEl || !listEl || !detailEl || !detailInfoEl) return;

  let state: DashState = initialState();
  let conn: Conn = "idle";
  let selectedSid: string | null = null;
  let mobileView: MobileView = "list";
  let tokenRowOpen = true;   // collapses after first successful open
  let ws: WebSocket | null = null;
  let reconnectTimer: number | undefined;
  let backoff = 3000;
  let gen = 0; // epoch: increments every (re)connect; stale handlers no-op
  // Consecutive attempts that died before the socket ever opened. The relay
  // answers a bad/expired token with a plain 401 (no upgrade), which the
  // WebSocket API surfaces as an indistinguishable error+close — so two
  // handshakes in a row that never opened is our only signal that the token,
  // not the network, is the problem. Reset on any successful open.
  let failedHandshakes = 0;
  let composing = false;     // true while the .rc-cmd input is mid-IME-composition
  let pendingRender = false; // a render was deferred during composition

  // One xterm instance, created lazily, reused across selections.
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let mirroredSid: string | null = null;

  const mq = window.matchMedia("(min-width: 768px)");
  const isDesktop = () => mq.matches;
  const detailVisible = () => isDesktop() || mobileView === "detail";

  const ensureTerm = () => {
    if (term || !mirrorTermEl) return;
    term = new Terminal({ convertEol: false, fontSize: 12, theme: { background: "#000000" } });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mirrorTermEl);
  };

  // A mirror is a copy of someone else's grid, not a terminal of our own:
  // fitting it to this pane re-wraps every line the source already wrapped
  // and puts every absolute cursor move in the wrong column. So adopt the
  // source's cols/rows verbatim and shrink the whole thing with a transform
  // until it fits. Kept in sync on pane resize by `scaleMirror`.
  let srcCols = 0, srcRows = 0;
  const scaleMirror = () => {
    const el = mirrorTermEl?.querySelector(".xterm") as HTMLElement | null;
    if (!el || !mirrorTermEl || !srcCols) return;
    el.style.transformOrigin = "top left";
    el.style.transform = "";                       // measure unscaled
    const w = el.offsetWidth, h = el.offsetHeight;
    if (!w || !h) return;
    const s = Math.min(1, mirrorTermEl.clientWidth / w, mirrorTermEl.clientHeight / h);
    if (s < 1) el.style.transform = `scale(${s})`;
  };
  const matchSourceGrid = (cols: number, rows: number) => {
    if (!term || (cols === srcCols && rows === srcRows)) { scaleMirror(); return; }
    srcCols = cols; srcRows = rows;
    try { term.resize(cols, rows); } catch { /* ignore */ }
    scaleMirror();
  };

  const hideMirror = () => {
    mirroredSid = null;
    srcCols = srcRows = 0;
    if (term) { try { term.reset(); } catch { /* ignore */ } }
    if (mirrorWrapEl) { mirrorWrapEl.classList.add("hidden"); mirrorWrapEl.classList.remove("flex"); }
  };

  const syncMirror = () => {
    const sel = state.tabs.find((t) => t.session_id === selectedSid) ?? null;
    // Gate on desktop being online: mirroring is impossible when the desktop is offline.
    const intent = mirrorTransition(mirroredSid, selectedSid, sel?.armed ?? false, detailVisible() && state.desktopOnline);
    if (!intent.stop && !intent.start) return;
    const open = ws !== null && ws.readyState === WebSocket.OPEN;
    if (intent.stop) {
      if (open) ws!.send(mirrorStopFrame(intent.stop));
      hideMirror();
    }
    if (intent.start && open) {
      ensureTerm();
      if (term) { try { term.reset(); } catch { /* ignore */ } }
      if (mirrorWrapEl) { mirrorWrapEl.classList.remove("hidden"); mirrorWrapEl.classList.add("flex"); }
      try { fit?.fit(); } catch { /* ignore */ }  // provisional; the screen frame's cols/rows win
      ws!.send(mirrorStartFrame(intent.start));
      mirroredSid = intent.start;
    }
  };

  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) tokenInput.value = saved;

  const render = () => {
    // Defer any innerHTML rebuild while composing (CJK/accents/dictation):
    // rebuilding would destroy the composition node and lose input. State is
    // already updated; compositionend replays a single render().
    if (composing) { pendingRender = true; return; }
    const map: Record<Conn, [string, string]> = {
      idle: ["○ not connected", "text-zinc-500 text-sm"],
      connecting: ["… connecting", "text-amber-400 text-sm"],
      online: ["● desktop online", "text-emerald-400 text-sm"],
      retrying: ["○ disconnected — retrying", "text-zinc-500 text-sm"],
    };
    let statusText: string;
    let statusCls: string;
    if (conn === "online" && state.desktopOnline) {
      [statusText, statusCls] = map.online;
    } else if (conn === "online" && !state.desktopOnline) {
      statusText = "● connected · desktop offline";
      statusCls = "text-amber-400 text-sm";
    } else if (conn === "retrying" && failedHandshakes >= 2) {
      statusText = "○ token rejected — expired? Copy a fresh one: Covenant → File → Copy Remote Pairing Token";
      statusCls = "text-amber-400 text-sm";
    } else {
      [statusText, statusCls] = map[conn];
    }
    statusEl.textContent = statusText;
    statusEl.className = statusCls;
    if (openErrEl) openErrEl.textContent = state.rejections[""] ?? "";

    // Token row collapses once paired; "change token" re-expands it.
    const collapsed = conn === "online" && !tokenRowOpen;
    tokenRow?.classList.toggle("hidden", collapsed);
    tokenToggle?.classList.toggle("hidden", !collapsed);

    // Mobile pane switching (md: classes keep both visible on desktop).
    listEl.classList.toggle("hidden", mobileView === "detail");
    detailEl.classList.toggle("hidden", mobileView === "list");

    // --- list pane
    if (state.tabs.length === 0) {
      listEl.innerHTML = `<p class="text-zinc-500 text-sm">No tabs.</p>`;
    } else {
      listEl.innerHTML = sortTabs(state.tabs).map((t) => {
        const sid = escapeAttr(t.session_id);
        const selCls = t.session_id === selectedSid
          ? "bg-emerald-900/30 border border-emerald-800"
          : "border border-transparent hover:bg-zinc-800/40";
        const dot = t.armed
          ? `<span class="text-emerald-400">●</span>`
          : `<span class="text-zinc-600">○</span>`;
        const titleCls = t.armed ? "text-emerald-300" : "text-zinc-400";
        return `
        <button class="rc-row w-full text-left flex items-center gap-2 rounded px-2 py-1.5 text-sm ${selCls}" data-sid="${sid}">
          ${dot}
          <span class="flex-1 truncate ${titleCls}">${escapeHtml(t.title)}</span>
          <span class="text-xs text-zinc-500 shrink-0">${escapeHtml(t.executor ?? "shell")} · ${escapeHtml(t.phase)}</span>
        </button>`;
      }).join("");
    }

    // --- detail pane (focus preservation across the innerHTML rebuild)
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

    const sel = state.tabs.find((t) => t.session_id === selectedSid) ?? null;
    detailInfoEl.innerHTML = renderDetailInfo(sel, state);

    if (focusedSid && focusedSid === selectedSid) {
      const next = detailInfoEl.querySelector(`input.rc-cmd[data-sid="${cssEscape(focusedSid)}"]`) as HTMLInputElement | null;
      if (next) {
        next.value = focusedVal;
        next.focus();
        try { next.setSelectionRange(selStart, selEnd); } catch { /* ignore */ }
      }
    }
  };

  const sendFor = (sid: string) => {
    const input = detailInfoEl.querySelector(`input.rc-cmd[data-sid="${cssEscape(sid)}"]`) as HTMLInputElement | null;
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

    let opened = false;
    const sock = new WebSocket(wsUrl(RELAY_BASE, token));
    ws = sock;
    sock.onopen = () => {
      if (myGen !== gen) return;     // superseded
      opened = true;
      failedHandshakes = 0;
      localStorage.setItem(TOKEN_KEY, token); // persist only after a real open
      backoff = 3000;                // reset backoff on success
      conn = "online";
      tokenRowOpen = false;
      render();
      sock.send(JSON.stringify({ t: "list_tabs" }));
    };
    sock.onmessage = (e) => {
      if (myGen !== gen) return;
      const text = typeof e.data === "string" ? e.data : "";
      const mm = parseMirrorFrame(text);
      if (mm) {
        if (term && mm.sessionId === mirroredSid) {
          if (mm.kind === "screen") {
            if (mm.cols && mm.rows) matchSourceGrid(mm.cols, mm.rows);
            term.reset();
            term.write(mm.text.replace(/\n/g, "\r\n"));
          }
          else { term.write(mm.bytes); }
        }
        return;
      }
      const f = parseFrame(text);
      if (!f) return;
      state = reduce(state, f);
      if (f.t === "tabs") selectedSid = resolveSelection(selectedSid, state.tabs);
      render();
      syncMirror();
    };
    sock.onclose = () => {
      if (myGen !== gen) return;     // a replaced socket: do nothing
      if (!opened) failedHandshakes++;
      hideMirror();                  // socket gone; nothing to stop remotely
      state = { ...state, desktopOnline: false };
      scheduleReconnect();
    };
    sock.onerror = () => {
      if (myGen !== gen) return;
      if (!opened) failedHandshakes++;
      teardown(sock);                // routes to no handler (detached); we drive reconnect
      scheduleReconnect();
    };
  }

  connectBtn.addEventListener("click", () => connect());

  tokenToggle?.addEventListener("click", () => {
    tokenRowOpen = true;
    render();
    tokenInput.focus();
  });

  newTabBtn?.addEventListener("click", () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(openTabFrame());
      if (state.rejections[""]) {
        const { ["" as string]: _, ...rest } = state.rejections;
        state = { ...state, rejections: rest };
        render();
      }
    }
  });

  // List: row click selects (and enters detail view on mobile).
  listEl.addEventListener("click", (e) => {
    const row = (e.target as HTMLElement).closest("button.rc-row") as HTMLElement | null;
    if (!row) return;
    const sid = row.getAttribute("data-sid");
    if (!sid) return;
    selectedSid = sid;
    if (!isDesktop()) mobileView = "detail";
    render();
    syncMirror();
  });

  // Detail: event delegation, attached once.
  detailEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("#rc-back")) {
      mobileView = "list";
      render();
      syncMirror();
      return;
    }
    const sendBtn = target.closest("button.rc-send") as HTMLElement | null;
    if (sendBtn) { const sid = sendBtn.getAttribute("data-sid"); if (sid) sendFor(sid); return; }
    const focusBtn = target.closest("button.rc-focus") as HTMLElement | null;
    if (focusBtn) {
      const sid = focusBtn.getAttribute("data-sid");
      if (sid && ws && ws.readyState === WebSocket.OPEN) ws.send(focusTabFrame(sid));
      return;
    }
    const closeBtn = target.closest("button.rc-close") as HTMLElement | null;
    if (closeBtn) {
      const sid = closeBtn.getAttribute("data-sid");
      if (sid && ws && ws.readyState === WebSocket.OPEN) ws.send(closeTabFrame(sid));
      return;
    }
  });
  detailEl.addEventListener("keydown", (e) => {
    const ev = e as KeyboardEvent;
    if (ev.key !== "Enter") return;
    if (ev.isComposing || composing) return;
    const input = (ev.target as HTMLElement).closest("input.rc-cmd") as HTMLElement | null;
    if (!input) return;
    ev.preventDefault();
    const sid = input.getAttribute("data-sid");
    if (sid) sendFor(sid);
  });
  detailEl.addEventListener("compositionstart", (e) => {
    if ((e.target as HTMLElement).classList?.contains("rc-cmd")) composing = true;
  });
  detailEl.addEventListener("compositionend", (e) => {
    if ((e.target as HTMLElement).classList?.contains("rc-cmd")) {
      composing = false;
      if (pendingRender) { pendingRender = false; render(); }
    }
  });

  // Crossing the breakpoint changes detail visibility (mobile list view hides it).
  mq.addEventListener("change", () => { render(); syncMirror(); });
  window.addEventListener("resize", () => {
    if (!mirroredSid) return;
    if (srcCols) scaleMirror();                        // source grid known: rescale, never refit
    else try { fit?.fit(); } catch { /* ignore */ }
  });

  render();
  if (saved) connect();
}

function renderDetailInfo(sel: TabInfo | null, state: DashState): string {
  if (!sel) {
    const msg = state.tabs.length === 0
      ? "No tabs."
      : "No tabs armed — arm one on the desktop to control it.";
    return `<p class="text-zinc-500 text-sm">${msg}</p>`;
  }
  const sid = escapeAttr(sel.session_id);
  const back = `<button id="rc-back" class="md:hidden mb-2 rounded border border-zinc-700 bg-zinc-800/40 px-2 py-1 text-xs text-zinc-300">← tabs</button>`;
  const badge = sel.armed
    ? `<span class="text-xs text-emerald-400">● armed</span>`
    : `<span class="text-xs text-zinc-500">○ not armed</span>`;
  const rejection = state.rejections[sel.session_id];
  const rejLine = rejection
    ? `<div class="mt-1 text-xs text-red-400">✗ ${escapeHtml(rejection)}</div>`
    : "";
  const controls = sel.armed
    ? `<div class="mt-2 flex gap-2 flex-wrap">
        <input class="rc-cmd flex-1 min-w-32 rounded border border-emerald-900/50 bg-black/40 px-2 py-1 text-sm text-emerald-100" data-sid="${sid}" placeholder="command…" />
        <button class="rc-send rounded border border-emerald-700 bg-emerald-900/40 px-3 py-1 text-sm text-emerald-200" data-sid="${sid}">Send</button>
        <button data-sid="${sid}" class="rc-focus rounded border border-zinc-700 bg-zinc-800/40 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700/50">Focus</button>
        <button data-sid="${sid}" class="rc-close rounded border border-red-800 bg-red-900/20 px-2 py-1 text-xs text-red-300 hover:bg-red-900/40">Close</button>
      </div>`
    : `<div class="mt-2 text-xs text-zinc-500">Arm this tab on the desktop to control it.</div>`;
  return `${back}
    <div class="flex items-center justify-between">
      <span class="text-emerald-300">${escapeHtml(sel.title)}</span>
      <span class="text-xs text-zinc-400">${escapeHtml(sel.executor ?? "shell")} · ${escapeHtml(sel.phase)}</span>
    </div>
    <div class="text-xs text-zinc-500">${escapeHtml(sel.cwd)}</div>
    <div class="mt-1">${badge}</div>
    ${controls}
    ${rejLine}`;
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
