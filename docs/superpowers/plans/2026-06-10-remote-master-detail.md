# Remote Dashboard Master–Detail Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `/remote` card stack with a master–detail layout: compact armed-first tab list + a detail pane with controls and an auto-starting live mirror.

**Architecture:** A new pure module `view-model.ts` owns sort/selection/mirror-transition decisions (unit-tested with Vitest). `RemoteDashboard.ts` is rewritten to render a list pane and a detail pane from those decisions; the mirror xterm lives in a persistent DOM node outside the re-rendered region. `remote.astro` gets a new two-pane skeleton. Mobile (<768px) shows one pane at a time with in-memory view state.

**Tech Stack:** Astro 4 + vanilla TS island, Tailwind, @xterm/xterm + fit addon, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-06-10-remote-master-detail-design.md`

**Worktree:** `/Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/remote-master-detail` — all paths below are relative to `landing/` inside it. Run all commands from `landing/`.

**Commit policy (user preference):** ONE feature commit at the end (Task 6). Do not commit per TDD step.

**Domain notes for the implementer:**
- `TabInfo.title` already embeds the group: the desktop sends titles like `"COVENANT › covenant-server"`. Sorting by title therefore IS group-then-title sorting. There is no separate `group` field.
- The desktop rejects `send_input`/`focus_tab`/`close_tab`/`mirror_start` for unarmed tabs (`lifecycle_gate` in `crates/app/src/rc_agent.rs`). The unarmed detail pane shows metadata + hint only.
- The relay protocol is unchanged. `protocol.ts` is not modified.
- Playwright's webServer runs `pnpm preview` against `dist/`, so `npm run build` must precede `npm test`.

---

### Task 1: View-model module (pure logic + unit tests)

**Files:**
- Create: `src/remote/view-model.ts`
- Test: `src/remote/view-model.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/remote/view-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { sortTabs, resolveSelection, mirrorTransition } from "./view-model";
import type { TabInfo } from "./protocol";

function tab(sid: string, title: string, armed: boolean): TabInfo {
  return { session_id: sid, title, cwd: "~", executor: null, phase: "idle", armed };
}

describe("sortTabs", () => {
  it("puts armed tabs first", () => {
    const out = sortTabs([tab("s1", "Alpha › a", false), tab("s2", "Zeta › z", true)]);
    expect(out.map((t) => t.session_id)).toEqual(["s2", "s1"]);
  });
  it("sorts by title (case-insensitive) within the same armed state", () => {
    const out = sortTabs([tab("s1", "nxt › b", true), tab("s2", "COVENANT › a", true)]);
    expect(out.map((t) => t.session_id)).toEqual(["s2", "s1"]);
  });
  it("breaks title ties by session_id for determinism", () => {
    const out = sortTabs([tab("s2", "Same", true), tab("s1", "Same", true)]);
    expect(out.map((t) => t.session_id)).toEqual(["s1", "s2"]);
  });
  it("does not mutate the input array", () => {
    const input = [tab("s1", "b", false), tab("s2", "a", true)];
    sortTabs(input);
    expect(input[0].session_id).toBe("s1");
  });
});

describe("resolveSelection", () => {
  it("keeps the previous selection when its tab is still present (even unarmed)", () => {
    expect(resolveSelection("s1", [tab("s1", "a", false), tab("s2", "b", true)])).toBe("s1");
  });
  it("falls back to the first armed tab (sorted order) when the selection vanished", () => {
    expect(resolveSelection("gone", [tab("s1", "z", true), tab("s2", "a", true)])).toBe("s2");
  });
  it("selects the first armed tab when nothing was selected", () => {
    expect(resolveSelection(null, [tab("s1", "a", false), tab("s2", "b", true)])).toBe("s2");
  });
  it("returns null when no tab is armed", () => {
    expect(resolveSelection(null, [tab("s1", "a", false)])).toBeNull();
  });
  it("returns null for an empty tab list", () => {
    expect(resolveSelection("s1", [])).toBeNull();
  });
});

describe("mirrorTransition", () => {
  it("is a no-op when the armed selection is already mirrored and visible", () => {
    expect(mirrorTransition("s1", "s1", true, true)).toEqual({ stop: null, start: null });
  });
  it("starts when an armed tab is selected, visible, and nothing is mirrored", () => {
    expect(mirrorTransition(null, "s1", true, true)).toEqual({ stop: null, start: "s1" });
  });
  it("stops the old and starts the new when switching between armed tabs", () => {
    expect(mirrorTransition("s1", "s2", true, true)).toEqual({ stop: "s1", start: "s2" });
  });
  it("stops without starting when the new selection is not armed", () => {
    expect(mirrorTransition("s1", "s2", false, true)).toEqual({ stop: "s1", start: null });
  });
  it("stops when the detail pane is not visible (mobile list view)", () => {
    expect(mirrorTransition("s1", "s1", true, false)).toEqual({ stop: "s1", start: null });
  });
  it("stops when the selection is cleared", () => {
    expect(mirrorTransition("s1", null, false, true)).toEqual({ stop: "s1", start: null });
  });
  it("does nothing when not mirroring and detail is hidden", () => {
    expect(mirrorTransition(null, "s1", true, false)).toEqual({ stop: null, start: null });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/remote/view-model.test.ts`
Expected: FAIL — cannot resolve `./view-model`.

- [ ] **Step 3: Write the implementation**

Create `src/remote/view-model.ts`:

```ts
import type { TabInfo } from "./protocol";

// Titles arrive as "GROUP › name" from the desktop, so title order is
// group-then-name order; no separate group field exists in the protocol.
export function sortTabs(tabs: TabInfo[]): TabInfo[] {
  return [...tabs].sort((a, b) => {
    if (a.armed !== b.armed) return a.armed ? -1 : 1;
    const t = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    if (t !== 0) return t;
    return a.session_id.localeCompare(b.session_id);
  });
}

export function resolveSelection(prev: string | null, tabs: TabInfo[]): string | null {
  if (prev && tabs.some((t) => t.session_id === prev)) return prev;
  const firstArmed = sortTabs(tabs).find((t) => t.armed);
  return firstArmed ? firstArmed.session_id : null;
}

export interface MirrorIntent { stop: string | null; start: string | null; }

// Exactly one mirror at a time, and only while the detail pane is visible.
export function mirrorTransition(
  mirrored: string | null,
  selected: string | null,
  selectedArmed: boolean,
  detailVisible: boolean,
): MirrorIntent {
  const want = detailVisible && selectedArmed ? selected : null;
  if (want === mirrored) return { stop: null, start: null };
  return { stop: mirrored, start: want };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: PASS — 22 existing protocol tests + 16 new view-model tests, 0 failures.

---

### Task 2: New page skeleton

**Files:**
- Modify: `src/pages/remote.astro` (full replacement)

- [ ] **Step 1: Replace `src/pages/remote.astro` with:**

```astro
---
import Base from "../layouts/Base.astro";
---
<Base title="Covenant · Remote" description="Remote tab dashboard">
  <main class="mx-auto max-w-6xl px-4 py-4 font-mono flex flex-col h-[calc(100dvh-4rem)]">
    <div class="flex items-center gap-3 mb-2 flex-wrap">
      <h1 class="text-emerald-400 text-lg">Covenant · Remote</h1>
      <p id="rc-status" class="text-zinc-500 text-sm">○ not connected</p>
      <div class="flex-1"></div>
      <button id="rc-token-toggle"
        class="hidden rounded border border-zinc-700 bg-zinc-800/40 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700/50">change token</button>
      <button id="rc-new-tab"
        class="rounded border border-emerald-700 bg-emerald-900/30 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-900/50">+ New tab</button>
    </div>
    <div id="rc-token-row" class="flex gap-2 mb-2">
      <input id="rc-token" type="password" placeholder="pairing token (JWT)"
        class="flex-1 rounded border border-zinc-800 bg-black/40 px-3 py-2 text-sm text-zinc-200" />
      <button id="rc-connect"
        class="rounded border border-emerald-700 bg-emerald-900/30 px-4 py-2 text-sm text-emerald-300 hover:bg-emerald-900/50">Connect</button>
    </div>
    <p id="rc-open-error" class="text-xs text-red-400 mb-1"></p>
    <div class="flex-1 min-h-0 grid gap-3 auto-rows-fr md:grid-cols-[280px_1fr]">
      <div id="rc-list" class="min-h-0 overflow-y-auto space-y-1 md:block"></div>
      <div id="rc-detail" class="hidden flex md:flex min-h-0 flex-col rounded border border-emerald-900/50 bg-black/30 p-3">
        <div id="rc-detail-info"></div>
        <div id="rc-detail-mirror" class="hidden flex-col flex-1 min-h-0 mt-2">
          <span class="text-xs text-emerald-400 mb-1">live mirror</span>
          <div id="rc-mirror-term" class="flex-1 min-h-0 rounded border border-emerald-900/50 bg-black"></div>
        </div>
      </div>
    </div>
  </main>
  <script>
    import { mountRemoteDashboard } from "../islands/RemoteDashboard";
    mountRemoteDashboard();
  </script>
</Base>
```

Layout notes:
- `h-[calc(100dvh-4rem)]` accounts for the fixed navbar (`body` has `pt-16` in `Base.astro`); the grid's `flex-1 min-h-0` lets the mirror fill remaining height.
- `#rc-detail` carries `hidden flex md:flex`: Tailwind generates `.hidden` after `.flex` in the base layer (so `hidden` wins below md when present) and responsive variants after both (so `md:flex` wins at desktop regardless). The island only toggles `hidden` for the mobile list↔detail switch; when `hidden` is removed on mobile, the plain `flex` keeps the column height chain intact so the mirror can fill the screen.
- `auto-rows-fr` on the grid makes the single visible pane fill the viewport height on mobile (and the one desktop row fill it at md+).
- `#rc-detail-info` is the only region rebuilt via `innerHTML`; `#rc-detail-mirror` / `#rc-mirror-term` persist so the xterm instance survives re-renders.
- There is no Mirror or Stop button anymore — mirroring follows selection.

No test run in this task; the page renders empty panes until Task 3 and old Playwright tests are superseded by Task 4.

---

### Task 3: Island rewrite

**Files:**
- Modify: `src/islands/RemoteDashboard.ts` (full replacement)

Preserved behaviors from the old island (do not lose these): connection epoch (`gen`) guard, exponential backoff 3s→30s, token persisted only after a real open, IME-composition render deferral, focus+caret restoration across `innerHTML` rebuilds, mirror `screen` reset + `\n→\r\n` conversion.

- [ ] **Step 1: Replace `src/islands/RemoteDashboard.ts` with:**

```ts
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

  const hideMirror = () => {
    mirroredSid = null;
    if (term) { try { term.reset(); } catch { /* ignore */ } }
    if (mirrorWrapEl) { mirrorWrapEl.classList.add("hidden"); mirrorWrapEl.classList.remove("flex"); }
  };

  const syncMirror = () => {
    const sel = state.tabs.find((t) => t.session_id === selectedSid) ?? null;
    const intent = mirrorTransition(mirroredSid, selectedSid, sel?.armed ?? false, detailVisible());
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
      try { fit?.fit(); } catch { /* ignore */ }
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
    const online = conn === "online" && state.desktopOnline;
    const [text, cls] = online ? map.online : map[conn];
    statusEl.textContent = text;
    statusEl.className = cls;
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

    const sock = new WebSocket(wsUrl(RELAY_BASE, token));
    ws = sock;
    sock.onopen = () => {
      if (myGen !== gen) return;     // superseded
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
          if (mm.kind === "screen") { term.reset(); term.write(mm.text.replace(/\n/g, "\r\n")); }
          else { term.write(mm.bytes); }
        }
        return;
      }
      const f = parseFrame(text);
      if (!f) return;
      state = reduce(state, f);
      if (f.t === "tabs") selectedSid = resolveSelection(selectedSid, state.tabs);
      if (!state.desktopOnline && mirroredSid) hideMirror(); // desktop went away
      render();
      syncMirror();
    };
    sock.onclose = () => {
      if (myGen !== gen) return;     // a replaced socket: do nothing
      hideMirror();                  // socket gone; nothing to stop remotely
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
  window.addEventListener("resize", () => { if (mirroredSid) { try { fit?.fit(); } catch { /* ignore */ } } });

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
```

- [ ] **Step 2: Type-check**

Run: `npx astro check`
Expected: 0 errors (warnings about unused old IDs are acceptable only if 0 errors; there should be none).

---

### Task 4: Playwright spec rewrite

**Files:**
- Modify: `tests/remote.spec.ts` (full replacement)

Notes for the implementer:
- The FakeWS-in-`addInitScript` pattern is kept from the old spec (each test installs its own; Playwright init scripts can't share page-context classes across tests).
- Mirror auto-start means `mirror_start` frames now appear without clicking anything — several tests assert on `__sent` after the tabs frame lands.
- Tests that don't set `readyState = 1` on FakeWS suppress all outbound sends (the island checks `ws.readyState === WebSocket.OPEN`); the sorted-render test uses that to stay render-only.

- [ ] **Step 1: Replace `tests/remote.spec.ts` with:**

```ts
import { test, expect } from "@playwright/test";

test("renders sorted tab list (armed first) and presence", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(public url: string) { setTimeout(() => this.onopen && this.onopen(), 0); }
      send(_: string) {
        setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
            { session_id: "s1", title: "Zeta › unarmed", cwd: "~/z", executor: null, phase: "idle", armed: false },
            { session_id: "s2", title: "Alpha › armed", cwd: "~/a", executor: "claude", phase: "running", armed: true }] }) });
        }, 0);
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  await expect(page.locator("#rc-status")).toHaveText("● desktop online");
  const rows = page.locator("#rc-list button.rc-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute("data-sid", "s2"); // armed first
  await expect(rows.nth(1)).toHaveAttribute("data-sid", "s1");
  await expect(rows.nth(0)).toContainText("claude · running");
});

test("reconnect hygiene: repeated Connect doesn't stack sockets; close surfaces retrying", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      static instances = 0;
      static live: FakeWS[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      closed = false;
      constructor(public url: string) {
        FakeWS.instances++;
        FakeWS.live.push(this);
        // open asynchronously so a rapid replace can supersede before open
        setTimeout(() => { if (!this.closed) this.onopen && this.onopen(); }, 5);
      }
      send(_: string) {
        setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
        }, 0);
      }
      close() { this.closed = true; this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.__wsCount = () => FakeWS.instances;
    // @ts-ignore
    window.__wsCloseCurrent = () => { const l = FakeWS.live; if (l.length) l[l.length - 1].close(); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");

  await page.click("#rc-connect");
  await page.click("#rc-connect");

  await expect(page.locator("#rc-status")).toHaveText("● desktop online");

  const afterClicks = await page.evaluate(() => (window as any).__wsCount());
  expect(afterClicks).toBeLessThanOrEqual(2);

  await page.evaluate(() => (window as any).__wsCloseCurrent());
  await expect(page.locator("#rc-status")).toHaveText("○ disconnected — retrying");

  const afterClose = await page.evaluate(() => (window as any).__wsCount());
  await page.waitForTimeout(500);
  const stillBounded = await page.evaluate(() => (window as any).__wsCount());
  expect(stillBounded).toBe(afterClose);
});

test("auto-selects first armed tab, mirrors it, and switches mirror on selection change", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
              { session_id: "s1", title: "A › first", cwd: "~/a", executor: "claude", phase: "running", armed: true },
              { session_id: "s2", title: "B › second", cwd: "~/b", executor: null, phase: "idle", armed: true }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
    // @ts-ignore
    window.__pushScreen = () => { FakeWS.last && FakeWS.last.onmessage && FakeWS.last.onmessage({
      data: JSON.stringify({ t: "mirror_screen", session_id: "s1", screen: "HELLO-MIRROR" }) }); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  // Auto-selection of s1 (first armed, sorted) starts its mirror.
  await expect(page.locator('input.rc-cmd[data-sid="s1"]')).toBeVisible();
  let sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_start", session_id: "s1" }));
  await expect(page.locator("#rc-detail-mirror")).not.toHaveClass(/hidden/);

  await page.evaluate(() => (window as any).__pushScreen());
  await expect(page.locator("#rc-mirror-term")).toContainText("HELLO", { timeout: 5000 });

  // Switching selection stops s1 and starts s2.
  await page.click('button.rc-row[data-sid="s2"]');
  sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));
  expect(sent).toContain(JSON.stringify({ t: "mirror_start", session_id: "s2" }));
  await expect(page.locator('input.rc-cmd[data-sid="s2"]')).toBeVisible();
});

test("unarmed selection shows arm hint, no controls, and stops the mirror", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
              { session_id: "s1", title: "A › armed", cwd: "~/a", executor: "claude", phase: "running", armed: true },
              { session_id: "s2", title: "B › unarmed", cwd: "~/b", executor: null, phase: "idle", armed: false }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  await expect(page.locator('input.rc-cmd[data-sid="s1"]')).toBeVisible();

  await page.click('button.rc-row[data-sid="s2"]');
  await expect(page.locator("#rc-detail")).toContainText("Arm this tab on the desktop to control it.");
  await expect(page.locator("input.rc-cmd")).toHaveCount(0);
  await expect(page.locator("#rc-detail-mirror")).toHaveClass(/hidden/);

  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));
});

test("send_input from the detail pane and rejection display", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
    // @ts-ignore
    window.__pushRejection = () => { FakeWS.last && FakeWS.last.onmessage && FakeWS.last.onmessage({
      data: JSON.stringify({ t: "rejected", session_id: "s1", reason: "blocklisted", message: "rm -rf blocked" }) }); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  await expect(page.locator('input.rc-cmd[data-sid="s1"]')).toBeVisible();
  await page.fill('input.rc-cmd[data-sid="s1"]', "git status");
  await page.click('button.rc-send[data-sid="s1"]');

  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "send_input", session_id: "s1", data: "git status\n" }));

  await page.evaluate(() => (window as any).__pushRejection());
  await expect(page.locator("#rc-detail")).toContainText("rm -rf blocked");
});

test("Focus/Close in the detail pane push lifecycle frames", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  await expect(page.locator('button.rc-focus[data-sid="s1"]')).toBeVisible();
  await page.click('button.rc-focus[data-sid="s1"]');
  await page.click('button.rc-close[data-sid="s1"]');

  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "focus_tab", session_id: "s1" }));
  expect(sent).toContain(JSON.stringify({ t: "close_tab", session_id: "s1" }));
});

test("New Tab button sends open_tab and shows open_not_allowed rejection", async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
    // @ts-ignore
    window.__pushOpenReject = () => { FakeWS.last && FakeWS.last.onmessage && FakeWS.last.onmessage({
      data: JSON.stringify({ t: "rejected", session_id: "", reason: "open_not_allowed", message: "remote tab creation is disabled on the desktop" }) }); };
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  await expect(page.locator("#rc-status")).toHaveText("● desktop online");

  await page.click("#rc-new-tab");
  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "open_tab" }));

  await page.evaluate(() => (window as any).__pushOpenReject());
  await expect(page.locator("#rc-open-error")).toHaveText("remote tab creation is disabled on the desktop");
});

test("preserves input focus and caret across an unsolicited frame", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake");
  await page.click("#rc-connect");

  const input = page.locator('input.rc-cmd[data-sid="s1"]');
  await input.click();
  await input.fill("git stat");
  await page.evaluate(() => {
    const el = document.querySelector('input.rc-cmd[data-sid="s1"]') as HTMLInputElement;
    el.setSelectionRange(3, 3);
  });

  // Push an UNSOLICITED frame that triggers a render() / innerHTML rebuild.
  await page.evaluate(() => {
    (window as any).WebSocket.last.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
  });

  await expect(input).toBeFocused();
  await expect(input).toHaveValue("git stat");
  const caret = await page.evaluate(() => (document.activeElement as HTMLInputElement).selectionStart);
  expect(caret).toBe(3);
});

test("token row collapses when online and 'change token' re-expands it", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");
  await expect(page.locator("#rc-status")).toHaveText("● desktop online");

  await expect(page.locator("#rc-token-row")).toHaveClass(/hidden/);
  await expect(page.locator("#rc-token-toggle")).toBeVisible();

  await page.click("#rc-token-toggle");
  await expect(page.locator("#rc-token-row")).not.toHaveClass(/hidden/);
  await expect(page.locator("#rc-token")).toBeFocused();
});

test("mobile: list-first navigation, mirror starts in detail view and stops on back", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    (window as any).__sent = [];
    class FakeWS {
      static last: FakeWS | null = null;
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readyState = 1; // OPEN
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(data: string) {
        (window as any).__sent.push(data);
        const msg = JSON.parse(data);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
              { session_id: "s1", title: "armed-tab", cwd: "~/p", executor: "claude", phase: "running", armed: true }] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
    // @ts-ignore
    window.WebSocket.OPEN = 1;
  });
  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  // List view by default; auto-selection must NOT start a mirror while detail is hidden.
  await expect(page.locator('button.rc-row[data-sid="s1"]')).toBeVisible();
  await expect(page.locator("#rc-detail")).toBeHidden();
  let sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).not.toContain(JSON.stringify({ t: "mirror_start", session_id: "s1" }));

  // Tap → detail view, mirror starts, back button visible.
  await page.click('button.rc-row[data-sid="s1"]');
  await expect(page.locator("#rc-detail")).toBeVisible();
  await expect(page.locator("#rc-list")).toBeHidden();
  await expect(page.locator("#rc-back")).toBeVisible();
  sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_start", session_id: "s1" }));

  // Back → list view, mirror stops.
  await page.click("#rc-back");
  await expect(page.locator("#rc-list")).toBeVisible();
  await expect(page.locator("#rc-detail")).toBeHidden();
  sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent).toContain(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));
});
```

---

### Task 5: Full verification

- [ ] **Step 1: Unit tests**

Run: `npx vitest run`
Expected: PASS — protocol (22) + view-model (16), 0 failures.

- [ ] **Step 2: Type check**

Run: `npx astro check`
Expected: 0 errors.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: build completes; `dist/` regenerated (Playwright's preview server serves it).

- [ ] **Step 4: E2E**

Run: `npm test`
Expected: 10 Playwright tests PASS. If `pnpm` is unavailable for the webServer command, run `npx astro preview --port 4322` in the background and re-run `npm test` (it reuses an existing server outside CI).

- [ ] **Step 5: Fix-forward**

If any step fails, fix and re-run from the failing step. Do not weaken assertions to pass; if an assertion is wrong (not the code), correct the assertion and note why in the task report.

---

### Task 6: Single feature commit

- [ ] **Step 1: Commit everything in one feature commit (user preference: one commit per feature, not per TDD step)**

```bash
cd /Users/carlosgallardoarenas/Sources/karlTerminal/.claude/worktrees/remote-master-detail
git add landing/src/remote/view-model.ts landing/src/remote/view-model.test.ts \
        landing/src/islands/RemoteDashboard.ts landing/src/pages/remote.astro \
        landing/tests/remote.spec.ts
git commit -m "feat(remote): master-detail dashboard with auto-mirroring detail pane

Armed-first compact tab list + detail pane; mirror follows selection
(one at a time, only while the detail pane is visible). Mobile gets
list->detail navigation; token row collapses once paired.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

Expected: clean `git status` afterwards (the spec/plan under `docs/superpowers/` are gitignored in this repo and will remain untracked).
