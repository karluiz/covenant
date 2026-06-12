# Covenant RC-3b · Web: xterm Mirror Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** On the `/remote` dashboard, a "Mirror" button per armed tab opens a live xterm.js terminal that reflects the desktop tab's screen — initial paint from `mirror_screen`, then live `mirror_data` (base64) bytes. "Stop" ends it. Completes RC-3 and the whole RC read/control surface.

**Architecture:** Add `@xterm/xterm` + fit addon to the landing site. The island intercepts inbound `mirror_screen`/`mirror_data` frames (a high-volume side stream, kept OUT of the pure `reduce` state), routing them to a single mounted `Terminal`. Mirror controls send `mirror_start`/`mirror_stop`. One mirror at a time.

**Tech Stack:** Astro `landing/` (pnpm), TypeScript, `@xterm/xterm` + `@xterm/addon-fit`, vitest (pure base64-decode parse), Playwright (wiring).

**Repo:** `~/Sources/karlTerminal`, work under `landing/`, git worktree.

**Depends on:** RC-3a (desktop emits `mirror_screen{session_id,screen}` + `mirror_data{session_id,b64}`, accepts `mirror_start`/`mirror_stop`, all armed-gated — merged). RC-1a/2a (dashboard, armed-tab control rows, rejection display).

---

## Context (current `landing/src/islands/RemoteDashboard.ts`)

- Imports from `../remote/protocol`: `parseFrame, wsUrl, reduce, initialState, sendInputFrame, closeTabFrame, focusTabFrame, openTabFrame`.
- `onmessage` (line ~153): `const f = parseFrame(text); if (f) { state = reduce(state, f); render(); }`.
- Per-armed-tab control row renders `input.rc-cmd` + `.rc-send`/`.rc-focus`/`.rc-close` buttons (event-delegated `click` on `tabsEl`). `ws` is the socket; `state.rejections` shown per tab.
- Page `landing/src/pages/remote.astro` has `#rc-token`/#rc-connect/#rc-status/#rc-new-tab/#rc-open-error/#rc-tabs. No xterm.
- `landing/package.json` has NO xterm. Desktop reference: `new Terminal({...})`, `term.open(el)`, `term.write(bytesOrString)`, `FitAddon`.

---

## Task 1: Add xterm deps

**Files:** Modify `landing/package.json`

- [ ] **Step 1: Add deps**

In `landing/package.json` `dependencies`:
```json
"@xterm/xterm": "^5.5.0",
"@xterm/addon-fit": "^0.10.0"
```

- [ ] **Step 2: Install**

Run: `cd landing && pnpm install`
Expected: resolves both.

- [ ] **Step 3: Commit**

```bash
git add landing/package.json landing/pnpm-lock.yaml
git commit -m "chore(remote): add @xterm/xterm + fit addon"
```

---

## Task 2: protocol — mirror frame builders + pure parse (base64 decode) + tests

**Files:** Modify `landing/src/remote/protocol.test.ts`, `landing/src/remote/protocol.ts`

- [ ] **Step 1: Add failing tests**

```ts
import { mirrorStartFrame, mirrorStopFrame, parseMirrorFrame } from "./protocol";

describe("mirror frames", () => {
  it("builds mirror_start/stop", () => {
    expect(mirrorStartFrame("s1")).toBe(JSON.stringify({ t: "mirror_start", session_id: "s1" }));
    expect(mirrorStopFrame("s1")).toBe(JSON.stringify({ t: "mirror_stop", session_id: "s1" }));
  });
  it("parses a mirror_screen frame", () => {
    const m = parseMirrorFrame(JSON.stringify({ t: "mirror_screen", session_id: "s1", screen: "hello" }));
    expect(m).toEqual({ kind: "screen", sessionId: "s1", text: "hello" });
  });
  it("parses a mirror_data frame, decoding base64 to bytes", () => {
    const b64 = btoa("hi"); // "aGk="
    const m = parseMirrorFrame(JSON.stringify({ t: "mirror_data", session_id: "s1", b64 }));
    expect(m?.kind).toBe("data");
    if (m?.kind === "data") {
      expect(m.sessionId).toBe("s1");
      expect(Array.from(m.bytes)).toEqual([104, 105]); // 'h','i'
    }
  });
  it("returns null for non-mirror frames", () => {
    expect(parseMirrorFrame(JSON.stringify({ t: "presence", desktop_online: true }))).toBeNull();
    expect(parseMirrorFrame("garbage")).toBeNull();
  });
});
```

- [ ] **Step 2: Implement** (append to `protocol.ts`)

```ts
export function mirrorStartFrame(sessionId: string): string { return JSON.stringify({ t: "mirror_start", session_id: sessionId }); }
export function mirrorStopFrame(sessionId: string): string { return JSON.stringify({ t: "mirror_stop", session_id: sessionId }); }

export type MirrorMsg =
  | { kind: "screen"; sessionId: string; text: string }
  | { kind: "data"; sessionId: string; bytes: Uint8Array };

/** Parse a mirror side-stream frame (kept out of the pure reduce state). Null if not a mirror frame. */
export function parseMirrorFrame(text: string): MirrorMsg | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.t === "mirror_screen" && typeof o.session_id === "string" && typeof o.screen === "string") {
    return { kind: "screen", sessionId: o.session_id, text: o.screen };
  }
  if (o.t === "mirror_data" && typeof o.session_id === "string" && typeof o.b64 === "string") {
    const bin = atob(o.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return { kind: "data", sessionId: o.session_id, bytes };
  }
  return null;
}
```

- [ ] **Step 3: Run → pass**

Run: `cd landing && pnpm test:unit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add landing/src/remote/protocol.ts landing/src/remote/protocol.test.ts
git commit -m "feat(remote): mirror frame builders + parseMirrorFrame (base64 decode)"
```

---

## Task 3: Mirror panel markup

**Files:** Modify `landing/src/pages/remote.astro`

- [ ] **Step 1: Add the panel + xterm css import**

In the frontmatter or a `<style>`/import, bring in the xterm CSS (Astro: `import "@xterm/xterm/css/xterm.css";` in the page's client script, OR a `<link>`; put it in the island import — see Task 4). Add, after `#rc-tabs`:
```html
<div id="rc-mirror" class="mt-4 hidden">
  <div class="flex items-center justify-between mb-1">
    <span class="text-xs text-emerald-400">live mirror</span>
    <button id="rc-mirror-stop" class="rounded border border-zinc-700 bg-zinc-800/40 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700/50">Stop</button>
  </div>
  <div id="rc-mirror-term" class="rounded border border-emerald-900/50 bg-black"></div>
</div>
```

- [ ] **Step 2: Build sanity**

Run: `cd landing && pnpm build`
Expected: builds (the empty term div is fine).

- [ ] **Step 3: Commit**

```bash
git add landing/src/pages/remote.astro
git commit -m "feat(remote): mirror panel markup (#rc-mirror + xterm container)"
```

---

## Task 4: Island — Mirror button, xterm mount, stream routing

**Files:** Modify `landing/src/islands/RemoteDashboard.ts`

- [ ] **Step 1: Imports**

Add to the protocol import: `mirrorStartFrame, mirrorStopFrame, parseMirrorFrame`. Add at top:
```ts
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
```

- [ ] **Step 2: Mirror state + helpers inside `mountRemoteDashboard`**

```ts
  const mirrorPanel = doc.getElementById("rc-mirror");
  const mirrorTermEl = doc.getElementById("rc-mirror-term");
  const mirrorStopBtn = doc.getElementById("rc-mirror-stop");
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let mirroringSid: string | null = null;

  const startMirror = (sid: string) => {
    if (!mirrorPanel || !mirrorTermEl) return;
    if (mirroringSid) stopMirror(); // one at a time
    mirroringSid = sid;
    term = new Terminal({ fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12, convertEol: false, theme: { background: "#000000" } });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(mirrorTermEl);
    try { fit.fit(); } catch {}
    mirrorPanel.classList.remove("hidden");
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(mirrorStartFrame(sid));
  };

  function stopMirror() {
    if (mirroringSid && ws && ws.readyState === WebSocket.OPEN) ws.send(mirrorStopFrame(mirroringSid));
    mirroringSid = null;
    term?.dispose(); term = null; fit = null;
    if (mirrorTermEl) mirrorTermEl.innerHTML = "";
    mirrorPanel?.classList.add("hidden");
  }
  mirrorStopBtn?.addEventListener("click", () => stopMirror());
```

- [ ] **Step 3: Route mirror frames in `onmessage` (before parseFrame)**

Change the `onmessage` body (line ~153) to intercept mirror frames first:
```ts
    sock.onmessage = (e) => {
      if (myGen !== gen) return;
      const text = typeof e.data === "string" ? e.data : "";
      const mm = parseMirrorFrame(text);
      if (mm) {
        if (term && mm.sessionId === mirroringSid) {
          if (mm.kind === "screen") { term.reset(); term.write(mm.text.replace(/\n/g, "\r\n")); }
          else { term.write(mm.bytes); }
        }
        return; // mirror frames never touch reduce state
      }
      const f = parseFrame(text);
      if (f) { state = reduce(state, f); render(); }
    };
```
> Match the exact existing `onmessage` signature/guards in the file (epoch `myGen !== gen` guard, etc.).

- [ ] **Step 4: Mirror button per armed tab**

In `render()`, add a `Mirror` button to the armed-tab control row (with `data-sid`), next to Focus/Close:
```ts
<button data-sid="${escapeAttr(t.session_id)}" class="rc-mirror-btn rounded border border-sky-800 bg-sky-900/20 px-2 py-1 text-xs text-sky-300 hover:bg-sky-900/40">Mirror</button>
```
Extend the delegated `tabsEl` click handler to handle `.rc-mirror-btn`:
```ts
    const mirBtn = (e.target as HTMLElement).closest("button.rc-mirror-btn") as HTMLElement | null;
    if (mirBtn) { startMirror(mirBtn.getAttribute("data-sid") || ""); return; }
```

- [ ] **Step 5: Stop mirror on socket close**

In `sock.onclose` (the reconnect path), call `stopMirror()` so a dropped connection tears down the terminal (the desktop's mirror task also ends when the relay drops).

- [ ] **Step 6: Type-check + build**

Run: `cd landing && pnpm exec astro check && pnpm build`
Expected: no errors; builds.

- [ ] **Step 7: Commit**

```bash
git add landing/src/islands/RemoteDashboard.ts
git commit -m "feat(remote): xterm mirror — Mirror button, mount, mirror_screen/data routing, Stop"
```

---

## Task 5: Playwright — mirror wiring

**Files:** Modify `landing/tests/remote.spec.ts`

- [ ] **Step 1: Add a test**

Stub WebSocket; on `list_tabs` reply with one armed tab `s1`. Assert clicking `button.rc-mirror-btn[data-sid="s1"]` sends `{"t":"mirror_start","session_id":"s1"}` (in `window.__sent`) and reveals `#rc-mirror` (no longer `.hidden`). Push a `mirror_screen` frame `{t:"mirror_screen",session_id:"s1",screen:"HELLO-MIRROR"}` and assert `#rc-mirror-term` contains text "HELLO" (xterm renders into the DOM; query `#rc-mirror-term` textContent — allow a short wait). Click `#rc-mirror-stop` → asserts `{"t":"mirror_stop","session_id":"s1"}` sent and `#rc-mirror` hidden again.
> If asserting xterm's rendered glyphs proves flaky in the headless run, fall back to asserting only the frames sent + panel visibility, and note it.

- [ ] **Step 2: Run**

Run: `cd landing && pnpm build && pnpm test -- remote.spec.ts`
Expected: pass (prior tests + new). Install browsers if needed (`pnpm exec playwright install chromium`).

- [ ] **Step 3: Commit**

```bash
git add landing/tests/remote.spec.ts
git commit -m "test(remote): mirror start/stop + screen render playwright test"
```

---

## Task 6: Manual end-to-end (closes RC-3 and the full RC channel)

**Files:** none.

- [ ] Desktop running, arm a tab. On `/remote` (local `pnpm dev`), click that tab's **Mirror** → a terminal appears showing the tab's current screen, then live output as you (or a remote command) drive it. Type into the desktop tab → the mirror updates.
- [ ] Click **Stop** → mirror closes. Mirror on an UNarmed tab → no button (and if forced, a `rejected` `tab_not_armed`).
- [ ] Record honestly (UNVERIFIED if not run).

---

## Self-Review

**Spec coverage (RC-3b):**
- ✅ xterm in the dashboard reflecting a tab byte-for-byte — Tasks 1/4.
- ✅ Mirror button only on armed tabs (desktop also gates) — Task 4.
- ✅ Initial paint from `mirror_screen`, live `mirror_data` base64 → bytes → `term.write` — Tasks 2/4.
- ✅ Mirror frames kept OUT of `reduce` (side stream) — Task 4 step 3.
- ✅ Stop sends `mirror_stop` + disposes; socket close tears down — Tasks 4.
- ✅ One mirror at a time — Task 4.

**Placeholder scan:** none. Task 5 has an explicit fallback if xterm glyph assertion is flaky; Task 6 manual.

**Type consistency:** `mirrorStartFrame`/`mirrorStopFrame`/`parseMirrorFrame`/`MirrorMsg` ↔ desktop `mirror_start`/`mirror_stop`/`mirror_screen`/`mirror_data`; `b64` decoded to `Uint8Array` for `term.write`; classes `rc-mirror-btn`/ids `#rc-mirror`/`#rc-mirror-term`/`#rc-mirror-stop` consistent across page, island, test.

---

## Follow-on (RC essentially complete after this)

- Resync-on-lag (desktop re-send snapshot on broadcast Lagged); binary WS frames (needs relay change) to cut base64 overhead.
- Pairing-token desktop affordance; `backend_url()` covenant.uno→forge fix.
- Full-channel manual e2e.
