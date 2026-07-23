import { parseFrame, wsUrl, reduce, initialState, sendInputFrame, sendKeysFrame, closeTabFrame, focusTabFrame, openTabFrame, mirrorStartFrame, mirrorStopFrame, parseMirrorFrame, type DashState, type TabInfo } from "../remote/protocol";
import { resolveSelection, mirrorTransition, groupTabs, splitTitle, phaseLabel, attentionSummary } from "../remote/view-model";

// The quick-key row: the tokens the desktop whitelists (rc_agent::key_bytes),
// with their labels and severity tone. What a stopped agent asks for from a
// phone is a key, not a command.
const QUICK_KEYS: Array<{ key: string; label: string; cls?: string }> = [
  { key: "enter", label: "⏎" },
  { key: "y", label: "y" },
  { key: "n", label: "n" },
  { key: "1", label: "1" },
  { key: "2", label: "2" },
  { key: "3", label: "3" },
  { key: "up", label: "↑" },
  { key: "down", label: "↓" },
  { key: "esc", label: "esc", cls: "warn" },
  { key: "shift-tab", label: "⇧⇥", cls: "warn" },
  { key: "ctrl-c", label: "^C", cls: "stop" },
];

// Groups the viewer has manually folded. Not persisted — a session thing.
const foldedGroups = new Set<string>();
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
  const filterEl = doc.getElementById("rc-filter") as HTMLInputElement | null;
  const bodyEl = doc.getElementById("rc-body");
  if (!tokenInput || !connectBtn || !statusEl || !listEl || !detailEl || !detailInfoEl) return;

  let filterText = "";

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
    if (mirrorWrapEl) { mirrorWrapEl.classList.add("hidden"); }
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
      if (mirrorWrapEl) { mirrorWrapEl.classList.remove("hidden"); }
      try { fit?.fit(); } catch { /* ignore */ }  // provisional; the screen frame's cols/rows win
      ws!.send(mirrorStartFrame(intent.start));
      mirroredSid = intent.start;
    }
  };

  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) tokenInput.value = saved;

  const matchesFilter = (t: TabInfo): boolean => {
    if (!filterText) return true;
    const q = filterText.toLowerCase();
    return t.title.toLowerCase().includes(q)
      || (t.executor ?? "shell").toLowerCase().includes(q)
      || t.phase.toLowerCase().includes(q);
  };

  const renderList = () => {
    const tabs = state.tabs.filter(matchesFilter);
    if (tabs.length === 0) {
      listEl.innerHTML = `<p class="rc-empty">${state.tabs.length === 0 ? "No tabs." : "No tabs match."}</p>`;
      return;
    }
    // A single ungrouped bucket needs no header row; only decorate real groups.
    const groups = groupTabs(tabs);
    const showHeaders = groups.length > 1 || (groups[0] && groups[0].key !== "");
    listEl.innerHTML = groups.map((g) => {
      const folded = foldedGroups.has(g.key);
      const head = (showHeaders && g.key !== "")
        ? `<button class="rc-group-head" data-group="${escapeAttr(g.key)}">
             <span class="rc-caret">${folded ? "▸" : "▾"}</span>
             <span>${escapeHtml(g.key)}</span>
             <span class="rc-count">${g.tabs.length}${g.active ? ` · ${g.active} active` : ""}</span>
           </button>`
        : "";
      const rows = folded ? "" : g.tabs.map((t) => {
        const sid = escapeAttr(t.session_id);
        const { leaf } = splitTitle(t.title);
        const { text, tone } = phaseLabel(t.phase);
        const selCls = t.session_id === selectedSid ? " sel" : "";
        return `<button class="rc-row${t.armed ? " armed" : ""}${selCls}" data-sid="${sid}">
          <span class="rc-dot">${t.armed ? "●" : "○"}</span>
          <span class="rc-leaf">${escapeHtml(leaf)}</span>
          <span class="rc-phase tone-${tone}">${escapeHtml(text)}</span>
        </button>`;
      }).join("");
      return head + rows;
    }).join("");
  };

  const render = () => {
    // Defer any innerHTML rebuild while composing (CJK/accents/dictation):
    // rebuilding would destroy the composition node and lose input. State is
    // already updated; compositionend replays a single render().
    if (composing) { pendingRender = true; return; }
    // Status: the header answers "should I have opened this?" — when online,
    // that's the attention summary (2 waiting · 3 active · 15 idle), not a
    // bare "online". State drives the dot color/shape via a data attribute.
    let statusText: string;
    let statusState: "off" | "connecting" | "online" | "partial" | "warn";
    if (conn === "online" && state.desktopOnline) {
      statusText = attentionSummary(state.tabs);
      statusState = "online";
    } else if (conn === "online" && !state.desktopOnline) {
      statusText = "connected · desktop offline";
      statusState = "partial";
    } else if (conn === "retrying" && failedHandshakes >= 2) {
      statusText = "token rejected — expired? File → Copy Remote Pairing Token";
      statusState = "warn";
    } else if (conn === "connecting") {
      statusText = "connecting";
      statusState = "connecting";
    } else if (conn === "retrying") {
      statusText = "disconnected — retrying";
      statusState = "off";
    } else {
      statusText = "not connected";
      statusState = "off";
    }
    statusEl.textContent = statusText;
    statusEl.setAttribute("data-state", statusState);
    if (openErrEl) openErrEl.textContent = state.rejections[""] ?? "";

    // Token row collapses once paired; "change token" re-expands it.
    const collapsed = conn === "online" && !tokenRowOpen;
    tokenRow?.classList.toggle("hidden", collapsed);
    tokenToggle?.classList.toggle("hidden", !collapsed);

    // Filter appears once the list is long enough to need it.
    filterEl?.classList.toggle("hidden", state.tabs.length < 10);

    // Mobile pane switching via data-view (a media query keeps both panes
    // visible on desktop, so this only bites below 768px).
    bodyEl?.setAttribute("data-view", mobileView);

    // --- list pane: attention-ordered, folded by group
    renderList();

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

  // List: a group header folds/unfolds; a row selects (and enters detail on mobile).
  listEl.addEventListener("click", (e) => {
    const head = (e.target as HTMLElement).closest("button.rc-group-head") as HTMLElement | null;
    if (head) {
      const g = head.getAttribute("data-group");
      if (g !== null) { foldedGroups.has(g) ? foldedGroups.delete(g) : foldedGroups.add(g); render(); }
      return;
    }
    const row = (e.target as HTMLElement).closest("button.rc-row") as HTMLElement | null;
    if (!row) return;
    const sid = row.getAttribute("data-sid");
    if (!sid) return;
    selectedSid = sid;
    if (!isDesktop()) mobileView = "detail";
    render();
    syncMirror();
  });

  // Filter box: refilter on input; Enter jumps to the first waiting/armed tab.
  filterEl?.addEventListener("input", () => { filterText = filterEl.value.trim(); render(); });
  filterEl?.addEventListener("keydown", (e) => {
    if ((e as KeyboardEvent).key !== "Enter") return;
    const target = groupTabs(state.tabs.filter(matchesFilter)).flatMap((g) => g.tabs)[0];
    if (target) { selectedSid = target.session_id; if (!isDesktop()) mobileView = "detail"; render(); syncMirror(); }
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
    const keyBtn = target.closest("button.rc-key") as HTMLElement | null;
    if (keyBtn) {
      const sid = keyBtn.getAttribute("data-sid");
      const key = keyBtn.getAttribute("data-key");
      if (sid && key && ws && ws.readyState === WebSocket.OPEN) ws.send(sendKeysFrame(sid, key));
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
    return `<p class="rc-empty">${msg}</p>`;
  }
  const sid = escapeAttr(sel.session_id);
  const { text: phText, tone } = phaseLabel(sel.phase);
  const back = `<button id="rc-back" class="rc-back rc-btn rc-btn-ghost" style="margin-bottom:0.5rem">← tabs</button>`;
  const badge = sel.armed
    ? `<div class="rc-badge armed">● armed</div>`
    : `<div class="rc-badge unarmed">○ not armed</div>`;
  const rejection = state.rejections[sel.session_id];
  const rejLine = rejection ? `<div class="rc-rej">✗ ${escapeHtml(rejection)}</div>` : "";

  // Quick keys first — the common case is one tap, not a typed command.
  const keys = QUICK_KEYS.map((k) =>
    `<button class="rc-key${k.cls ? " " + k.cls : ""}" data-sid="${sid}" data-key="${k.key}">${escapeHtml(k.label)}</button>`
  ).join("");
  const controls = sel.armed
    ? `<div class="rc-keys">${keys}</div>
       <div class="rc-cmd-row">
         <input class="rc-cmd" data-sid="${sid}" placeholder="type a command…" />
         <button class="rc-send rc-btn rc-btn-accent" data-sid="${sid}">Send</button>
         <button class="rc-focus rc-btn rc-btn-ghost" data-sid="${sid}">Focus</button>
         <button class="rc-close rc-btn" data-sid="${sid}">Close</button>
       </div>`
    : `<div class="rc-arm-hint">Arm this tab on the desktop to control it.</div>`;

  return `${back}
    <div class="rc-detail-title">
      <span class="rc-t${sel.armed ? " armed" : ""}">${escapeHtml(splitTitle(sel.title).leaf)}</span>
      <span class="rc-detail-meta">${escapeHtml(sel.executor ?? "shell")} · <span class="rc-phase tone-${tone}">${escapeHtml(phText)}</span></span>
    </div>
    <div class="rc-cwd">${escapeHtml(sel.cwd)}</div>
    ${badge}
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
