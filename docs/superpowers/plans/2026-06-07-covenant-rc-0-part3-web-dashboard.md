# Covenant RC-0 · Part 3: Web Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only remote dashboard page on the Covenant site (`/remote`) where you paste your pairing token, it connects to the relay's `/rc/web`, and renders the live list of your desktop tabs (title, executor, phase, cwd) plus desktop online/offline presence.

**Architecture:** A static Astro page (`src/pages/remote.astro`) hosting a client-side "island" (`src/islands/RemoteDashboard.ts`) that opens a WebSocket to `wss://forge.covenant.uno/rc/web?token=<jwt>`, sends `list_tabs`, and renders incoming `tabs`/`presence` frames. Pure protocol logic (frame parsing, URL building, a tabs+presence state reducer) lives in `src/remote/protocol.ts` and is unit-tested with vitest; the page wiring is covered by a Playwright test with a stubbed WebSocket. Token is persisted in `localStorage`.

**Tech Stack:** Astro 4 + Tailwind (existing site `@covenant/landing`), TypeScript, vitest (new, for pure logic), Playwright (existing, for page).

**Repo:** `~/Sources/karlTerminal` (the `karluiz/covenant` repo); the site is under `landing/`. Do the work in a git worktree. The site deploys to www.covenant.uno via GitHub Pages.

**Depends on:** RC-0 Part 1 (relay, live + verified) and Part 2 (desktop agent, merged). Auth model: **pairing token** — the user pastes a JWT (same `github_id` as the desktop). A small desktop "reveal/copy pairing token" affordance is a noted follow-on (not in this plan); for testing, mint a token with the server `JWT_SECRET`.

---

## Context the implementer needs

- The site is `landing/` (Astro 4, Tailwind). Pages live in `landing/src/pages/` (currently only `index.astro`). Client logic uses the "island" pattern: a `.ts` in `landing/src/islands/` (see `src/islands/ScoreFunnel.ts`) imported by an `.astro` component via a `<script>`.
- Test tooling today is **Playwright only** (`npm test` → `playwright test`, config `landing/playwright.config.ts`, specs in `landing/tests/`). This plan adds **vitest** for pure-logic unit tests.
- Aesthetic: phosphor-green terminal look (match the forge status page / the site's existing dark Tailwind theme). Reuse Tailwind classes already in the site.
- Relay endpoint: `wss://forge.covenant.uno/rc/web?token=<jwt>`. Frames (from Part 1/2):
  - inbound to web: `{"t":"tabs","device_id":"...","tabs":[{session_id,title,cwd,executor,phase,armed}]}` and `{"t":"presence","desktop_online":true|false}`.
  - outbound from web: `{"t":"list_tabs"}`.
- The browser `WebSocket` cannot set headers → token goes in the query string (already how the relay authenticates).

---

## File Structure

- **Create** `landing/src/remote/protocol.ts` — pure: frame TS types, `parseFrame`, `wsUrl`, and a `reduce(state, frame)` tabs+presence reducer. No DOM, no WS. Unit-tested.
- **Create** `landing/src/remote/protocol.test.ts` — vitest unit tests for `protocol.ts`.
- **Create** `landing/src/islands/RemoteDashboard.ts` — IO glue: token from localStorage/input, open WS, dispatch frames through `reduce`, render to DOM, reconnect.
- **Create** `landing/src/pages/remote.astro` — page shell + markup (token field, connect button, tab list container, presence badge) + Tailwind styling.
- **Create** `landing/tests/remote.spec.ts` — Playwright: load `/remote`, stub `WebSocket`, assert rendering of tabs + presence.
- **Modify** `landing/package.json` — add `vitest` devDep + a `test:unit` script.

---

## Task 1: Add vitest for pure-logic unit tests

**Files:**
- Modify: `landing/package.json`

- [ ] **Step 1: Add vitest + script**

In `landing/package.json`, add to `devDependencies`:
```json
"vitest": "^2.1.0"
```
Add to `scripts`:
```json
"test:unit": "vitest run"
```

- [ ] **Step 2: Install**

Run: `cd landing && npm install`
Expected: installs vitest, no errors.

- [ ] **Step 3: Commit**

```bash
git add landing/package.json landing/package-lock.json
git commit -m "chore(remote): add vitest for unit tests"
```

---

## Task 2: Protocol module (pure) + unit tests

**Files:**
- Create: `landing/src/remote/protocol.ts`
- Create: `landing/src/remote/protocol.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `landing/src/remote/protocol.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseFrame, wsUrl, reduce, initialState, type Frame } from "./protocol";

describe("parseFrame", () => {
  it("parses a tabs frame", () => {
    const f = parseFrame(JSON.stringify({
      t: "tabs", device_id: "mac-1",
      tabs: [{ session_id: "s1", title: "build", cwd: "~/p", executor: "claude", phase: "running", armed: false }],
    }));
    expect(f?.t).toBe("tabs");
    if (f?.t === "tabs") expect(f.tabs[0].title).toBe("build");
  });
  it("parses a presence frame", () => {
    const f = parseFrame(JSON.stringify({ t: "presence", desktop_online: true }));
    expect(f).toEqual({ t: "presence", desktop_online: true });
  });
  it("returns null on garbage", () => {
    expect(parseFrame("not json")).toBeNull();
    expect(parseFrame(JSON.stringify({ t: "mystery" }))).toBeNull();
  });
});

describe("wsUrl", () => {
  it("builds the web relay url", () => {
    expect(wsUrl("https://forge.covenant.uno", "T")).toBe("wss://forge.covenant.uno/rc/web?token=T");
  });
  it("encodes the token", () => {
    expect(wsUrl("https://forge.covenant.uno", "a b/c")).toBe("wss://forge.covenant.uno/rc/web?token=a%20b%2Fc");
  });
});

describe("reduce", () => {
  it("starts offline with no tabs", () => {
    expect(initialState()).toEqual({ desktopOnline: false, tabs: [] });
  });
  it("applies presence", () => {
    const s = reduce(initialState(), { t: "presence", desktop_online: true });
    expect(s.desktopOnline).toBe(true);
  });
  it("replaces tabs on a tabs frame", () => {
    const tabs = [{ session_id: "s1", title: "x", cwd: "~/p", executor: null, phase: "idle", armed: false }];
    const s = reduce(initialState(), { t: "tabs", device_id: "d", tabs });
    expect(s.tabs).toEqual(tabs);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd landing && npm run test:unit`
Expected: FAIL — `./protocol` not found.

- [ ] **Step 3: Implement `protocol.ts`**

Create `landing/src/remote/protocol.ts`:

```ts
export interface TabInfo {
  session_id: string;
  title: string;
  cwd: string;
  executor: string | null;
  phase: string;
  armed: boolean;
}

export type Frame =
  | { t: "tabs"; device_id: string; tabs: TabInfo[] }
  | { t: "presence"; desktop_online: boolean };

/** Parse a relay text frame. Returns null on bad JSON or unknown/invalid shape. */
export function parseFrame(text: string): Frame | null {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return null; }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (o.t === "presence" && typeof o.desktop_online === "boolean") {
    return { t: "presence", desktop_online: o.desktop_online };
  }
  if (o.t === "tabs" && Array.isArray(o.tabs) && typeof o.device_id === "string") {
    return { t: "tabs", device_id: o.device_id, tabs: o.tabs as TabInfo[] };
  }
  return null;
}

/** Build the web relay URL; force wss/ws and percent-encode the token. */
export function wsUrl(base: string, token: string): string {
  const b = base.replace(/\/+$/, "")
    .replace(/^https:\/\//, "wss://")
    .replace(/^http:\/\//, "ws://");
  return `${b}/rc/web?token=${encodeURIComponent(token)}`;
}

export interface DashState {
  desktopOnline: boolean;
  tabs: TabInfo[];
}

export function initialState(): DashState {
  return { desktopOnline: false, tabs: [] };
}

/** Pure reducer: fold a frame into dashboard state. */
export function reduce(state: DashState, frame: Frame): DashState {
  switch (frame.t) {
    case "presence":
      return { ...state, desktopOnline: frame.desktop_online };
    case "tabs":
      return { ...state, tabs: frame.tabs };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd landing && npm run test:unit`
Expected: PASS (all describe blocks).

- [ ] **Step 5: Commit**

```bash
git add landing/src/remote/protocol.ts landing/src/remote/protocol.test.ts
git commit -m "feat(remote): pure protocol module (parse/url/reducer) + unit tests"
```

---

## Task 3: The dashboard island (WS client + render)

**Files:**
- Create: `landing/src/islands/RemoteDashboard.ts`

- [ ] **Step 1: Implement the island**

Create `landing/src/islands/RemoteDashboard.ts`:

```ts
import { parseFrame, wsUrl, reduce, initialState, type DashState } from "../remote/protocol";

const RELAY_BASE = "https://forge.covenant.uno";
const TOKEN_KEY = "covenant_rc_token";

/** Wire up the dashboard. Call once on DOMContentLoaded. Expects these element ids:
 *  #rc-token (input), #rc-connect (button), #rc-status (span), #rc-tabs (container). */
export function mountRemoteDashboard(doc: Document = document): void {
  const tokenInput = doc.getElementById("rc-token") as HTMLInputElement | null;
  const connectBtn = doc.getElementById("rc-connect") as HTMLButtonElement | null;
  const statusEl = doc.getElementById("rc-status");
  const tabsEl = doc.getElementById("rc-tabs");
  if (!tokenInput || !connectBtn || !statusEl || !tabsEl) return;

  // Restore a saved token.
  const saved = localStorage.getItem(TOKEN_KEY);
  if (saved) tokenInput.value = saved;

  let state: DashState = initialState();
  let ws: WebSocket | null = null;
  let reconnectTimer: number | undefined;

  const render = () => {
    statusEl.textContent = state.desktopOnline ? "● desktop online" : "○ desktop offline";
    statusEl.className = state.desktopOnline ? "text-emerald-400" : "text-zinc-500";
    if (state.tabs.length === 0) {
      tabsEl.innerHTML = `<p class="text-zinc-500">No tabs.</p>`;
      return;
    }
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
    ws.onmessage = (e) => {
      const frame = parseFrame(typeof e.data === "string" ? e.data : "");
      if (frame) { state = reduce(state, frame); render(); }
    };
    ws.onclose = () => {
      state = { ...state, desktopOnline: false };
      render();
      reconnectTimer = window.setTimeout(connect, 3000);
    };
    ws.onerror = () => { ws?.close(); };
  };

  connectBtn.addEventListener("click", () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    connect();
  });

  render();
  if (saved) connect();
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string
  ));
}
```

- [ ] **Step 2: Type-check**

Run: `cd landing && npx astro check` (or `npx tsc --noEmit` if astro check is slow)
Expected: no type errors in the new files.

- [ ] **Step 3: Commit**

```bash
git add landing/src/islands/RemoteDashboard.ts
git commit -m "feat(remote): dashboard island — WS client, render, reconnect, token persistence"
```

---

## Task 4: The `/remote` page

**Files:**
- Create: `landing/src/pages/remote.astro`

- [ ] **Step 1: Create the page**

Create `landing/src/pages/remote.astro` (match the site's existing layout import if there is one — check `index.astro` for a `Layout`/`<html>` wrapper and reuse it; if `index.astro` is self-contained, mirror its `<head>`):

```astro
---
// Remote tab dashboard (read-only). Pairing-token auth.
---
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Covenant · Remote</title>
</head>
<body class="min-h-screen bg-zinc-950 text-zinc-200 font-mono">
  <main class="mx-auto max-w-2xl px-4 py-10">
    <h1 class="text-emerald-400 text-lg mb-1">Covenant · Remote</h1>
    <p class="text-zinc-500 text-sm mb-6">Paste your pairing token to view your desktop tabs. Read-only.</p>

    <div class="flex gap-2 mb-3">
      <input id="rc-token" type="password" placeholder="pairing token (JWT)"
        class="flex-1 rounded border border-zinc-800 bg-black/40 px-3 py-2 text-sm text-zinc-200" />
      <button id="rc-connect"
        class="rounded border border-emerald-700 bg-emerald-900/30 px-4 py-2 text-sm text-emerald-300 hover:bg-emerald-900/50">
        Connect
      </button>
    </div>
    <p id="rc-status" class="text-zinc-500 text-sm mb-4">○ desktop offline</p>

    <div id="rc-tabs" class="space-y-2"></div>
  </main>

  <script>
    import { mountRemoteDashboard } from "../islands/RemoteDashboard";
    mountRemoteDashboard();
  </script>
</body>
</html>
```

- [ ] **Step 2: Build the site**

Run: `cd landing && npm run build`
Expected: builds, `dist/remote/index.html` produced, no errors.

- [ ] **Step 3: Commit**

```bash
git add landing/src/pages/remote.astro
git commit -m "feat(remote): /remote dashboard page"
```

---

## Task 5: Playwright page test (stubbed WebSocket)

**Files:**
- Create: `landing/tests/remote.spec.ts`

- [ ] **Step 1: Write the test**

Create `landing/tests/remote.spec.ts` (match the existing specs' style in `landing/tests/` for `baseURL`/server setup):

```ts
import { test, expect } from "@playwright/test";

// Stub window.WebSocket before the island script runs, then drive frames.
test("renders tabs and presence from relay frames", async ({ page }) => {
  await page.addInitScript(() => {
    class FakeWS {
      onopen: (() => void) | null = null;
      onmessage: ((e: { data: string }) => void) | null = null;
      onclose: (() => void) | null = null;
      onerror: (() => void) | null = null;
      static last: FakeWS | null = null;
      constructor(public url: string) {
        FakeWS.last = this;
        setTimeout(() => this.onopen && this.onopen(), 0);
      }
      send(_: string) {
        // simulate the desktop replying
        setTimeout(() => {
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "presence", desktop_online: true }) });
          this.onmessage && this.onmessage({ data: JSON.stringify({ t: "tabs", device_id: "mac-1", tabs: [
            { session_id: "s1", title: "build", cwd: "~/proj", executor: "claude", phase: "running", armed: false },
          ] }) });
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
  await expect(page.locator("#rc-tabs")).toContainText("build");
  await expect(page.locator("#rc-tabs")).toContainText("claude");
  await expect(page.locator("#rc-tabs")).toContainText("~/proj");
});
```

- [ ] **Step 2: Run it**

Run: `cd landing && npx playwright test remote.spec.ts`
Expected: PASS (the page may need the dev/preview server — check `playwright.config.ts` `webServer`; if it serves `npm run preview` or `dev`, ensure the build/preview is wired; adjust the command if the config expects a built site).

- [ ] **Step 3: Commit**

```bash
git add landing/tests/remote.spec.ts
git commit -m "test(remote): playwright render test with stubbed WebSocket"
```

---

## Task 6: Manual end-to-end against the live relay

**Files:** none (verification). This ALSO closes the Part 2 desktop-agent e2e (real desktop + real dashboard exercise the whole channel).

- [ ] **Step 1: Run the dashboard locally**

Run: `cd landing && npm run dev` → open `http://localhost:4321/remote`.

- [ ] **Step 2: Have a desktop connected**

Run the Covenant app signed in (a valid forge JWT in Keychain). Confirm its rc-agent connects (log `relay connected`). [If verifying without a full sign-in: mint a token with the server `JWT_SECRET` and the SAME `sub` for both the desktop Keychain and the dashboard field.]

- [ ] **Step 3: Connect + observe**

Paste the matching token into `#rc-token`, click Connect. Expected: status flips to `● desktop online`; the tab list renders your real open tabs (title, executor, phase, cwd `~`-collapsed). Closing the desktop flips status to `○ desktop offline`.

- [ ] **Step 4: Record result honestly** (UNVERIFIED if not run).

---

## Self-Review

**Spec coverage (design RC-0 Part 3 = web dashboard):**
- ✅ Authed connect to `/rc/web` — pairing token (Task 3/4), per the chosen MVP.
- ✅ Send `list_tabs`, render `tabs` (title, executor, phase, cwd) — Tasks 2/3.
- ✅ Presence (online/offline) — Tasks 2/3.
- ✅ Reconnect on close — Task 3.
- ✅ Token persistence (localStorage) — Task 3.
- ⏸ Desktop "reveal/copy pairing token" affordance — **follow-on** (small Tauri command + copy button); noted, not in this plan. Until then, use a minted token.
- ⏸ Live mirror / control — later phases (RC-1+).

**Placeholder scan:** No TODOs. Tasks 5/6 are test/manual with concrete steps. Code steps are complete. The only "verify against existing" notes are about reusing the site's Layout wrapper and the Playwright `webServer` config — environmental, not placeholders.

**Type consistency:** `Frame`, `TabInfo`, `parseFrame`, `wsUrl`, `reduce`, `initialState`, `DashState`, `mountRemoteDashboard` are consistent across `protocol.ts`, its test, the island, and the Playwright test. Element ids (`#rc-token`, `#rc-connect`, `#rc-status`, `#rc-tabs`) match between the island and the page.

---

## Follow-on (to finish RC-0 and beyond)

- **Desktop pairing-token affordance**: a `rc_pairing_token()` Tauri command returning the Keychain JWT + a copy button in settings/UI, so users get the token without minting. Small, separate.
- **`backend_url()` fix**: desktop default is `https://covenant.uno` (apex); should be `forge.covenant.uno` (affects sync + future web OAuth). Separate.
- **RC-1**: per-tab arming + gated `send_input` (first control milestone).
