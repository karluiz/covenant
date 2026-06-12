# Covenant RC-1a · Web: Command Input + Rejection Display — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the `/remote` dashboard, let the user send a command string to a tab that is **armed** on the desktop. The desktop gates it (arming + blocklist) and may reply with a `rejected` frame, which the dashboard shows. Unarmed tabs show a hint and a disabled input.

**Architecture:** Extend the pure `protocol.ts` with a `rejected` inbound frame, a `sendInputFrame(session_id, data)` builder, and a `rejections` map in `DashState`/`reduce` (all unit-tested). Extend the `RemoteDashboard` island to render a per-armed-tab command input (event-delegated, focus-preserving across re-renders) that sends `send_input` frames and renders rejection messages. A Playwright test stubs the WebSocket and asserts the outgoing frame + rejection rendering.

**Tech Stack:** Astro site `landing/` (pnpm), TypeScript, vitest (pure), Playwright (page).

**Repo:** `~/Sources/karlTerminal`, work under `landing/`, in a git worktree.

**Depends on:** RC-0 Part 3 (`/remote` dashboard, merged) + RC-1a desktop (arming + gated `send_input`, merged). The desktop emits `{"t":"rejected","session_id","reason","message"}` and accepts `{"t":"send_input","session_id","data"}`.

---

## Context (current state in `landing/src/remote/protocol.ts`)

```ts
export interface TabInfo { session_id: string; title: string; cwd: string; executor: string | null; phase: string; armed: boolean; }
export type Frame = { t: "tabs"; device_id: string; tabs: TabInfo[] } | { t: "presence"; desktop_online: boolean };
export function parseFrame(text: string): Frame | null { ... }   // returns null on unknown t
export function wsUrl(base: string, token: string): string { ... }
export interface DashState { desktopOnline: boolean; tabs: TabInfo[]; }
export function initialState(): DashState { return { desktopOnline: false, tabs: [] }; }
export function reduce(state: DashState, frame: Frame): DashState { ... }  // presence | tabs
```
Island (`landing/src/islands/RemoteDashboard.ts`): `render()` rebuilds `tabsEl.innerHTML` from `state.tabs` (line ~38); `connect()` opens the WS and `ws.send(JSON.stringify({ t: "list_tabs" }))` on open. Reconnect/epoch logic already robust.

The wire `armed` field already arrives per tab (RC-1a desktop wired it).

---

## Task 1: protocol — rejected frame, send_input builder, rejections state (+ unit tests)

**Files:** Modify `landing/src/remote/protocol.test.ts`, `landing/src/remote/protocol.ts`

- [ ] **Step 1: Add failing tests** (append to `protocol.test.ts`)

```ts
import { sendInputFrame } from "./protocol";

describe("rejected frame", () => {
  it("parses a rejected frame", () => {
    const f = parseFrame(JSON.stringify({ t: "rejected", session_id: "s1", reason: "tab_not_armed", message: "tab not armed" }));
    expect(f).toEqual({ t: "rejected", session_id: "s1", reason: "tab_not_armed", message: "tab not armed" });
  });
  it("reduce records a rejection by session", () => {
    const s = reduce(initialState(), { t: "rejected", session_id: "s1", reason: "blocklisted", message: "rm -rf blocked" });
    expect(s.rejections["s1"]).toBe("rm -rf blocked");
  });
  it("a tabs frame clears stale rejections", () => {
    let s = reduce(initialState(), { t: "rejected", session_id: "s1", reason: "blocklisted", message: "x" });
    s = reduce(s, { t: "tabs", device_id: "d", tabs: [] });
    expect(s.rejections).toEqual({});
  });
});

describe("sendInputFrame", () => {
  it("builds a send_input frame and appends a newline (submit)", () => {
    expect(sendInputFrame("s1", "git status")).toBe(JSON.stringify({ t: "send_input", session_id: "s1", data: "git status\n" }));
  });
  it("does not double-append if the text already ends in newline", () => {
    expect(sendInputFrame("s1", "echo hi\n")).toBe(JSON.stringify({ t: "send_input", session_id: "s1", data: "echo hi\n" }));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd landing && pnpm test:unit`
Expected: FAIL (sendInputFrame/rejections not defined).

- [ ] **Step 3: Implement in `protocol.ts`**

Extend `Frame`:
```ts
export type Frame =
  | { t: "tabs"; device_id: string; tabs: TabInfo[] }
  | { t: "presence"; desktop_online: boolean }
  | { t: "rejected"; session_id: string; reason: string; message: string };
```
Extend `parseFrame` (add before the final `return null`):
```ts
  if (o.t === "rejected" && typeof o.session_id === "string"
      && typeof o.reason === "string" && typeof o.message === "string") {
    return { t: "rejected", session_id: o.session_id, reason: o.reason, message: o.message };
  }
```
Extend `DashState` + `initialState`:
```ts
export interface DashState { desktopOnline: boolean; tabs: TabInfo[]; rejections: Record<string, string>; }
export function initialState(): DashState { return { desktopOnline: false, tabs: [], rejections: {} }; }
```
Extend `reduce`:
```ts
export function reduce(state: DashState, frame: Frame): DashState {
  switch (frame.t) {
    case "presence": return { ...state, desktopOnline: frame.desktop_online };
    case "tabs":     return { ...state, tabs: frame.tabs, rejections: {} }; // fresh snapshot clears stale rejections
    case "rejected": return { ...state, rejections: { ...state.rejections, [frame.session_id]: frame.message } };
  }
}
```
Add the builder:
```ts
/** Build a send_input frame; ensures a trailing newline so the command submits. */
export function sendInputFrame(sessionId: string, text: string): string {
  const data = text.endsWith("\n") ? text : text + "\n";
  return JSON.stringify({ t: "send_input", session_id: sessionId, data });
}
```

- [ ] **Step 4: Run tests**

Run: `cd landing && pnpm test:unit`
Expected: PASS (existing 8 + new).

- [ ] **Step 5: Commit**

```bash
git add landing/src/remote/protocol.ts landing/src/remote/protocol.test.ts
git commit -m "feat(remote): rejected frame + send_input builder + rejections state"
```

---

## Task 2: island — per-armed-tab command input + rejection render

**Files:** Modify `landing/src/islands/RemoteDashboard.ts`

- [ ] **Step 1: Render an input per armed tab + rejection line**

Replace the per-tab template in `render()` so each tab card includes, when `t.armed`, a command row; when not armed, a hint. Each input/button carries `data-sid` for event delegation. Render any rejection for that session in red.

```ts
    tabsEl.innerHTML = state.tabs.map((t) => {
      const rej = state.rejections[t.session_id];
      const control = t.armed
        ? `<div class="mt-2 flex gap-2">
             <input data-sid="${escapeAttr(t.session_id)}" class="rc-cmd flex-1 rounded border border-zinc-800 bg-black/40 px-2 py-1 text-xs text-zinc-200" placeholder="command…" />
             <button data-sid="${escapeAttr(t.session_id)}" class="rc-send rounded border border-emerald-700 bg-emerald-900/30 px-3 py-1 text-xs text-emerald-300 hover:bg-emerald-900/50">Send</button>
           </div>`
        : `<div class="mt-2 text-xs text-zinc-600">Arm this tab on the desktop to control it.</div>`;
      const rejLine = rej ? `<div class="mt-1 text-xs text-red-400">✗ ${escapeHtml(rej)}</div>` : "";
      return `
      <div class="rounded border border-emerald-900/50 bg-black/30 p-3">
        <div class="flex items-center justify-between">
          <span class="text-emerald-300">${escapeHtml(t.title)}${t.armed ? ` <span class="text-xs text-amber-400">● armed</span>` : ""}</span>
          <span class="text-xs text-zinc-400">${escapeHtml(t.executor ?? "shell")} · ${escapeHtml(t.phase)}</span>
        </div>
        <div class="text-xs text-zinc-500">${escapeHtml(t.cwd)}</div>
        ${control}${rejLine}
      </div>`;
    }).join("");
```

Add an `escapeAttr` helper next to `escapeHtml`:
```ts
function escapeAttr(s: string): string { return escapeHtml(s).replace(/`/g, "&#96;"); }
```

- [ ] **Step 2: Preserve focus/value across re-renders**

Frames arrive and rebuild `innerHTML`, which would wipe an in-progress command. Before rebuilding in `render()`, capture the focused command input; after, restore it. At the top of `render()`:
```ts
    const active = doc.activeElement as HTMLInputElement | null;
    const focusedSid = active && active.classList.contains("rc-cmd") ? active.getAttribute("data-sid") : null;
    const focusedVal = focusedSid ? active!.value : "";
    const caret = focusedSid ? active!.selectionStart ?? focusedVal.length : 0;
```
After setting `tabsEl.innerHTML`:
```ts
    if (focusedSid) {
      const el = tabsEl.querySelector(`input.rc-cmd[data-sid="${cssEscape(focusedSid)}"]`) as HTMLInputElement | null;
      if (el) { el.value = focusedVal; el.focus(); try { el.setSelectionRange(caret, caret); } catch {} }
    }
```
Add a tiny `cssEscape` (session ids are ULIDs — alphanumeric — so a minimal escape suffices):
```ts
function cssEscape(s: string): string { return s.replace(/["\\]/g, "\\$&"); }
```

- [ ] **Step 3: Wire send via event delegation (once)**

After the elements are resolved in `mountRemoteDashboard` (near the `connectBtn` listener), add delegated handlers on `tabsEl`:
```ts
  const sendFor = (sid: string) => {
    const input = tabsEl.querySelector(`input.rc-cmd[data-sid="${cssEscape(sid)}"]`) as HTMLInputElement | null;
    if (!input) return;
    const text = input.value;
    if (!text.trim()) return;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(sendInputFrame(sid, text));
      input.value = "";
      // optimistic: clear any prior rejection for this tab
      if (state.rejections[sid]) { const { [sid]: _, ...rest } = state.rejections; state = { ...state, rejections: rest }; render(); }
    }
  };
  tabsEl.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest("button.rc-send") as HTMLElement | null;
    if (btn) sendFor(btn.getAttribute("data-sid") || "");
  });
  tabsEl.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const input = (e.target as HTMLElement).closest("input.rc-cmd") as HTMLElement | null;
    if (input) { e.preventDefault(); sendFor(input.getAttribute("data-sid") || ""); }
  });
```
Import `sendInputFrame` from `../remote/protocol` (alongside the existing imports).

- [ ] **Step 4: Type-check**

Run: `cd landing && pnpm exec astro check`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add landing/src/islands/RemoteDashboard.ts
git commit -m "feat(remote): per-armed-tab command input, send_input, rejection display"
```

---

## Task 3: Playwright test — send + rejection + unarmed gating

**Files:** Modify `landing/tests/remote.spec.ts`

- [ ] **Step 1: Add a test**

Append a test that captures outgoing frames from the stub and drives a rejection:
```ts
test("sends send_input for armed tab and shows rejection", async ({ page }) => {
  await page.addInitScript(() => {
    const sent: string[] = [];
    (window as any).__sent = sent;
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      static last: FakeWS | null = null;
      constructor(public url: string) { FakeWS.last = this; setTimeout(() => this.onopen && this.onopen(), 0); }
      send(s: string) {
        sent.push(s);
        const msg = JSON.parse(s);
        if (msg.t === "list_tabs") {
          setTimeout(() => {
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
            this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "d", tabs: [
              { session_id: "s1", title: "build", cwd: "~/p", executor: "claude", phase: "idle", armed: true },
              { session_id: "s2", title: "logs", cwd: "~/q", executor: null, phase: "idle", armed: false },
            ] }) });
          }, 0);
        }
      }
      close() { this.onclose && this.onclose(); }
    }
    // @ts-ignore
    window.WebSocket = FakeWS;
  });

  await page.goto("/remote");
  await page.fill("#rc-token", "fake.jwt.token");
  await page.click("#rc-connect");

  // armed tab has an input; unarmed tab does not
  const armedInput = page.locator('input.rc-cmd[data-sid="s1"]');
  await expect(armedInput).toBeVisible();
  await expect(page.locator('input.rc-cmd[data-sid="s2"]')).toHaveCount(0);

  await armedInput.fill("git status");
  await page.click('button.rc-send[data-sid="s1"]');

  // assert the outgoing send_input frame (with trailing newline)
  const sent = await page.evaluate(() => (window as any).__sent as string[]);
  expect(sent.some((s) => s === JSON.stringify({ t: "send_input", session_id: "s1", data: "git status\n" }))).toBe(true);

  // simulate a rejection coming back
  await page.evaluate(() => {
    const ws = (window as any).WebSocket.last;
    ws.onmessage({ data: JSON.stringify({ t: "rejected", session_id: "s1", reason: "blocklisted", message: "rm -rf blocked" }) });
  });
  await expect(page.locator("#rc-tabs")).toContainText("rm -rf blocked");
});
```

- [ ] **Step 2: Run**

Run: `cd landing && pnpm build && pnpm test -- remote.spec.ts`
Expected: PASS (the original 2 tests + this one).

- [ ] **Step 3: Commit**

```bash
git add landing/tests/remote.spec.ts
git commit -m "test(remote): send_input + rejection + unarmed-gating playwright test"
```

---

## Task 4: Manual end-to-end (closes RC-1a)

**Files:** none.

- [ ] With a desktop signed in, arm a tab via its right-click menu. Open `/remote` (local `pnpm dev` or prod), paste a matching token.
- [ ] Type `echo hello` into the armed tab's input → Send. Expect it runs in that tab on the desktop.
- [ ] Try `rm -rf /` → expect a red rejection "…" under the tab, nothing runs.
- [ ] The unarmed tab shows the "Arm this tab on the desktop" hint and no input.
- [ ] Record honestly (UNVERIFIED if not run).

---

## Self-Review

**Spec coverage (RC-1a web):**
- ✅ Per-armed-tab command input; unarmed tabs gated (no input + hint) — Task 2.
- ✅ Sends `send_input{session_id,data}` with submit newline — Tasks 1/2.
- ✅ Shows `rejected` frames inline per tab — Tasks 1/2.
- ✅ Pure protocol additions unit-tested; page behavior Playwright-tested — Tasks 1/3.
- ✅ Focus/value preserved across frame-driven re-renders — Task 2 step 2.

**Placeholder scan:** None. Task 4 is manual with concrete steps.

**Type consistency:** `Frame` `rejected` variant, `DashState.rejections`, `sendInputFrame`, `escapeAttr`/`cssEscape`, `data-sid`, classes `rc-cmd`/`rc-send` are consistent across protocol, island, and test. The `rejected` `reason` strings match the desktop's (`tab_not_armed`/`blocklisted`/`no_such_tab`/`inject_failed`).

---

## Follow-on

- **RC-1b**: desktop banner when ≥1 web client connected + visible kill-switch button (wire `disarmAllRemote`) + relay change to push web-presence → desktop.
- Desktop "reveal/copy pairing token" affordance; `backend_url()` default fix.
