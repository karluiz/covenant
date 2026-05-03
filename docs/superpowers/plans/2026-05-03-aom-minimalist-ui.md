# AOM Minimalist Mode ("Battery Mode") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AFK overlay (`⌘⇧A` while AOM is on) that takes over the window and shows the operator's decision stream + budget — so the user can leave AOM running overnight and glance at it in the morning.

**Architecture:** Frontend-only feature. New `AfkOverlay` class mounts a full-window overlay on `document.body` (above tab strip and sidebar). The overlay subscribes to the existing `operator-decision` Tauri event for live cards and seeds initial cards by filtering `listOperatorDecisions(limit)` to the current AOM session window (using `aomStatus().started_at_unix_ms`). Header re-uses `aomStatus()` poll; tab count is derived from `TabManager` (operator-enabled, not AOM-excluded). No new Rust code, no new IPC events.

**Tech Stack:** TypeScript (strict), Tauri 2 events, existing CSS tokens (`--bg-overlay`, `--border`, `--muted`, `--accent`).

**Shortcut layering:** `⌘⇧A` is currently AOM toggle. New behavior: if AFK overlay is open → close it; else if AOM is on → open AFK; else start AOM (existing behavior). To stop AOM, the user clicks the banner's Stop button (already wired) — this avoids a 4-state shortcut. The banner stays visible behind AFK so the Stop button is reachable on exit.

**Click-to-jump scope:** The `operator-decision` event payload carries full `session_id` but no block_id. Click behavior in v1: focus the source tab, exit AFK, refit the terminal. Terminal is naturally scrolled to the latest output where the operator just typed; "scrolls block into view" is satisfied by tab focus + xterm's natural cursor-follow. (Adding block_id to the event would require backend changes and is out of scope per spec — ESCALATE if needed later.)

---

### Task 1: Skeleton — `AfkOverlay` class with mount/unmount

**Files:**
- Create: `ui/src/aom/afk.ts`

The skeleton renders the three-region shell (header / feed / footer) with placeholder content. No data yet, no events yet. Mount/unmount add/remove the overlay element from `document.body`. `isOpen()` reflects whether the overlay is currently mounted.

- [ ] **Step 1: Create `ui/src/aom/afk.ts` with skeleton**

```typescript
// AOM AFK ("Battery Mode") — full-window overlay surfacing the
// operator's decision stream + budget. For "leave it running
// overnight, glance at it in the morning."
//
// Subscribes to live `operator-decision` events; seeds initial feed
// from `listOperatorDecisions()` filtered to the current AOM window.
// Reads cost/budget/elapsed from `aomStatus()` (5s poll). No new
// backend code — pure frontend overlay.

import type { TabManager } from "../tabs/manager";

export interface AfkOverlayDeps {
  manager: TabManager;
  /// Called when AFK exits — main.ts uses this to refit the active
  /// terminal so xterm cell metrics are accurate after the overlay
  /// goes away.
  onExit?: () => void;
}

export class AfkOverlay {
  private root: HTMLElement | null = null;

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly deps: AfkOverlayDeps,
  ) {}

  isOpen(): boolean {
    return this.root !== null;
  }

  open(): void {
    if (this.isOpen()) return;
    const root = document.createElement("div");
    root.className = "afk-overlay";
    root.innerHTML = `
      <header class="afk-header">
        <div class="afk-header-stats">
          <span class="afk-stat afk-stat-cost">—</span>
          <span class="afk-stat afk-stat-elapsed">—</span>
          <span class="afk-stat afk-stat-tabs">—</span>
        </div>
      </header>
      <main class="afk-feed" tabindex="-1">
        <div class="afk-feed-empty">No decisions yet.</div>
      </main>
      <footer class="afk-footer">
        <button type="button" class="afk-wakeup">Wake up</button>
        <span class="afk-hint">Esc to exit</span>
      </footer>
    `;
    this.mountHost.appendChild(root);
    this.root = root;
    root
      .querySelector<HTMLButtonElement>(".afk-wakeup")!
      .addEventListener("click", () => this.close());
  }

  close(): void {
    if (!this.root) return;
    this.root.remove();
    this.root = null;
    this.deps.onExit?.();
  }
}
```

- [ ] **Step 2: Verify tsc passes**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS (no errors). The unused `TabManager` import will trigger a warning if `noUnusedParameters` is set; if so, prefix with `_` or use it in a noop later — but later tasks consume it.

- [ ] **Step 3: Commit**

```bash
git add ui/src/aom/afk.ts
git commit -m "feat(aom): AfkOverlay skeleton — three-region shell"
```

---

### Task 2: Wire `⌘⇧A` shortcut to open/close AFK

**Files:**
- Modify: `ui/src/main.ts:215-227, 370-374, 393-429`

Layered shortcut:
- AFK open → close it (stay in AOM mode)
- AOM on, AFK closed → open AFK
- AOM off → start AOM (existing `aomBanner.toggle()`)

Esc closes AFK before any other modal (it's the most "takeover" surface, so it has highest priority on Esc).

- [ ] **Step 1: Import and instantiate `AfkOverlay` in `main.ts`**

Add import after the AOM panel imports (around line 15):

```typescript
import { AfkOverlay } from "./aom/afk";
```

In `boot()` after `const aomReportPanel = new AomReportPanel(document.body);` (~line 238), add:

```typescript
  const afk = new AfkOverlay(document.body, {
    manager,
    onExit: () => manager.refitActive(),
  });
```

- [ ] **Step 2: Replace the `⌘⇧A` handler with the layered version**

Find the existing block at `main.ts:370-374`:

```typescript
    if (e.metaKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      void aomBanner.toggle();
      return;
    }
```

Replace with:

```typescript
    // ⌘⇧A — layered AOM/AFK toggle:
    //   AFK open       → close AFK (back to normal UI; AOM stays on)
    //   AOM on, AFK off → open AFK (Battery Mode)
    //   AOM off        → start AOM (existing banner toggle)
    // Stopping AOM is done via the banner's Stop button (intentional —
    // a four-state shortcut would be too easy to mistrigger overnight).
    if (e.metaKey && e.shiftKey && (e.key === "A" || e.key === "a")) {
      e.preventDefault();
      if (afk.isOpen()) {
        afk.close();
      } else if (aomBanner.isOn()) {
        afk.open();
      } else {
        void aomBanner.toggle();
      }
      return;
    }
```

- [ ] **Step 3: Add Esc → close AFK at the top of the Esc chain**

Find the `if (e.key === "Escape") {` block (~line 393). Add the AFK branch as the FIRST inside the block (before settings):

```typescript
    if (e.key === "Escape") {
      if (afk.isOpen()) {
        e.preventDefault();
        afk.close();
        return;
      }
      if (settings.isOpen()) {
        // …existing branches unchanged
```

- [ ] **Step 4: Verify tsc passes**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(aom): wire ⌘⇧A + Esc to AfkOverlay"
```

---

### Task 3: Header — cost / budget / elapsed / active-tab count

**Files:**
- Modify: `ui/src/aom/afk.ts`
- Modify: `ui/src/tabs/manager.ts` — add `aomActiveTabCount()`

The header uses `aomStatus()` for cost, budget, and `started_at_unix_ms` (elapsed). Active tab count comes from `TabManager`: tabs where `operatorEnabled === true`. (When AOM is on, AOM auto-enables operator on every non-excluded tab, so this is the right derivation.) Poll on a 5s timer while open.

- [ ] **Step 1: Add `aomActiveTabCount()` to `TabManager`**

In `ui/src/tabs/manager.ts`, add a method near `activeSessionId()` (~line 604):

```typescript
  /// Count of tabs that AOM is currently driving — operator-enabled
  /// tabs (AOM auto-enables on every non-excluded tab on start, and
  /// reverts on stop, so this count IS the AOM-active set while AOM
  /// is on).
  aomActiveTabCount(): number {
    return this.tabs.filter((t) => t.operatorEnabled).length;
  }
```

- [ ] **Step 2: Extend `AfkOverlay` to render header data**

In `ui/src/aom/afk.ts`, import `aomStatus` and add poll/render:

```typescript
import { aomStatus, type AomStatus } from "../api";
```

Add fields and methods to the class:

```typescript
  private poll: number | null = null;
  private status: AomStatus | null = null;
```

Add `private renderHeader(): void` and modify `open()` / `close()`:

```typescript
  open(): void {
    if (this.isOpen()) return;
    const root = document.createElement("div");
    root.className = "afk-overlay";
    root.innerHTML = `
      <header class="afk-header">
        <div class="afk-header-stats">
          <span class="afk-stat afk-stat-cost">—</span>
          <span class="afk-stat afk-stat-elapsed">—</span>
          <span class="afk-stat afk-stat-tabs">—</span>
        </div>
      </header>
      <main class="afk-feed" tabindex="-1">
        <div class="afk-feed-empty">No decisions yet.</div>
      </main>
      <footer class="afk-footer">
        <button type="button" class="afk-wakeup">Wake up</button>
        <span class="afk-hint">Esc to exit</span>
      </footer>
    `;
    this.mountHost.appendChild(root);
    this.root = root;
    root
      .querySelector<HTMLButtonElement>(".afk-wakeup")!
      .addEventListener("click", () => this.close());

    void this.refreshHeader();
    this.poll = window.setInterval(() => void this.refreshHeader(), 5_000);
  }

  close(): void {
    if (!this.root) return;
    if (this.poll !== null) {
      window.clearInterval(this.poll);
      this.poll = null;
    }
    this.root.remove();
    this.root = null;
    this.status = null;
    this.deps.onExit?.();
  }

  private async refreshHeader(): Promise<void> {
    if (!this.root) return;
    try {
      this.status = await aomStatus();
    } catch {
      return;
    }
    this.renderHeader();
  }

  private renderHeader(): void {
    if (!this.root || !this.status) return;
    const s = this.status;
    const costEl = this.root.querySelector<HTMLElement>(".afk-stat-cost");
    const elapsedEl = this.root.querySelector<HTMLElement>(".afk-stat-elapsed");
    const tabsEl = this.root.querySelector<HTMLElement>(".afk-stat-tabs");
    if (costEl) {
      costEl.textContent = `$${s.accumulated_cost_usd.toFixed(
        3,
      )} / $${s.budget_usd.toFixed(2)}`;
      const ratio = s.budget_usd > 0 ? s.accumulated_cost_usd / s.budget_usd : 0;
      costEl.classList.toggle("afk-stat-warn", ratio >= 0.8);
    }
    if (elapsedEl) {
      const ms = s.started_at_unix_ms > 0 ? Date.now() - s.started_at_unix_ms : 0;
      elapsedEl.textContent = formatElapsed(ms);
    }
    if (tabsEl) {
      const n = this.deps.manager.aomActiveTabCount();
      tabsEl.textContent = `${n} tab${n === 1 ? "" : "s"}`;
    }
  }
```

Add at the bottom of `afk.ts`:

```typescript
function formatElapsed(ms: number): string {
  if (ms <= 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m - h * 60;
  return rm === 0 ? `${h}h` : `${h}h ${rm}m`;
}
```

- [ ] **Step 3: Verify tsc passes**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/aom/afk.ts ui/src/tabs/manager.ts
git commit -m "feat(aom): AFK header — cost/budget/elapsed/tab-count"
```

---

### Task 4: Live decision feed via `operator-decision` event

**Files:**
- Modify: `ui/src/aom/afk.ts`

Subscribe to `operator-decision` on open, unsubscribe on close. Each event renders a card: timestamp, tab label (`…<short_id>`), action badge (DECIDE/REPLY/ESCALATE/WAIT), one-line rationale or reply preview. Newest-at-bottom (chronological), `appendChild` order.

Shape of the event already used by `activity-feed.ts` — re-use the `DecisionEvent` shape.

- [ ] **Step 1: Add event subscription scaffolding**

At the top of `afk.ts`:

```typescript
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
```

Add the same `DecisionEvent` interface used in `activity-feed.ts`:

```typescript
interface DecisionEvent {
  id: number | null;
  session_id: string;
  action: "reply" | "escalate" | "wait" | string;
  reply_text: string | null;
  rationale: string | null;
  escalation: string | null;
  executed: boolean;
  cost_usd: number;
  timestamp_unix_ms: number;
}
```

Add field:

```typescript
  private unlistenDecision: UnlistenFn | null = null;
```

In `open()`, after `this.poll = window.setInterval(...);`:

```typescript
    void listen<DecisionEvent>("operator-decision", (event) => {
      this.pushDecision(event.payload);
    }).then((un) => {
      // If close() ran before listen() resolved, immediately detach.
      if (this.root === null) un();
      else this.unlistenDecision = un;
    });
```

In `close()`, before `this.root.remove();`:

```typescript
    if (this.unlistenDecision) {
      this.unlistenDecision();
      this.unlistenDecision = null;
    }
```

- [ ] **Step 2: Implement `pushDecision()` and card renderer**

```typescript
  private pushDecision(d: DecisionEvent): void {
    if (!this.root) return;
    const feed = this.root.querySelector<HTMLElement>(".afk-feed");
    if (!feed) return;

    // Drop the empty-state on first card.
    const empty = feed.querySelector(".afk-feed-empty");
    if (empty) empty.remove();

    const card = renderDecisionCard(d);
    card.addEventListener("click", () => {
      this.deps.manager.activate(d.session_id);
      this.close();
    });
    feed.appendChild(card);
  }
```

Add the renderer at bottom of file:

```typescript
function renderDecisionCard(d: DecisionEvent): HTMLElement {
  let cls: string;
  let title: string;
  let body: string;
  switch (d.action) {
    case "reply":
      cls = d.executed ? "ok" : "muted";
      title = d.executed ? "REPLY" : "REPLY (dry)";
      body = formatReplyLine(d.reply_text, d.rationale);
      break;
    case "escalate":
      cls = "warn";
      title = "ESCALATE";
      body = d.escalation ?? d.rationale ?? "(no detail)";
      break;
    case "wait":
      cls = "muted";
      title = "WAIT";
      body = d.rationale ?? "(no detail)";
      break;
    default:
      cls = "muted";
      title = d.action.toUpperCase();
      body = d.rationale ?? "";
  }
  const tabSlug = shortSession(d.session_id);
  const time = formatClock(d.timestamp_unix_ms);

  const card = document.createElement("button");
  card.type = "button";
  card.className = `afk-card afk-card-${cls}`;
  card.innerHTML = `
    <span class="afk-card-time">${escapeHtml(time)}</span>
    <span class="afk-card-tab">…${escapeHtml(tabSlug)}</span>
    <span class="afk-card-action">${escapeHtml(title)}</span>
    <span class="afk-card-body"></span>
  `;
  card.querySelector<HTMLElement>(".afk-card-body")!.textContent = body;
  return card;
}

function formatReplyLine(text: string | null, rationale: string | null): string {
  const safe = (text ?? "").replace(/\n/g, "\\n").trim();
  const head = safe.length > 60 ? `"${safe.slice(0, 60)}…"` : `"${safe}"`;
  return rationale ? `${head} — ${rationale}` : head;
}

function shortSession(id: string): string {
  return id.length > 6 ? id.slice(-6) : id;
}

function formatClock(unixMs: number): string {
  const d = new Date(unixMs);
  return `${d.getHours().toString().padStart(2, "0")}:${d
    .getMinutes()
    .toString()
    .padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
```

- [ ] **Step 3: Verify tsc passes**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/aom/afk.ts
git commit -m "feat(aom): AFK live decision feed"
```

---

### Task 5: Seed feed with recent decisions on open

**Files:**
- Modify: `ui/src/aom/afk.ts`

On open, fetch `listOperatorDecisions(LIMIT)` and render any whose `timestamp_unix_ms >= status.started_at_unix_ms`. This reconstructs the current AOM session's history so AFK isn't blank when opened mid-run.

The shape is `OperatorDecisionRow` from `api.ts`, which differs from the live `DecisionEvent` (no full session_id, no cost_usd). Map it into a synthetic `DecisionEvent` for re-use of the renderer — session_id_short is enough for display; click-to-jump is disabled for seeded cards (no full session_id).

- [ ] **Step 1: Import `listOperatorDecisions`**

```typescript
import {
  aomStatus,
  listOperatorDecisions,
  type AomStatus,
  type OperatorDecisionRow,
} from "../api";
```

- [ ] **Step 2: Add `seedFeed()` and call from `open()`**

In `open()`, after the listen() call:

```typescript
    void this.seedFeed();
```

Add the method:

```typescript
  private async seedFeed(): Promise<void> {
    if (!this.root) return;
    let rows: OperatorDecisionRow[];
    try {
      rows = await listOperatorDecisions(200);
    } catch {
      return;
    }
    // Scope to the current AOM session — earlier decisions belong to a
    // previous run and would be misleading in the live feed.
    const startMs = this.status?.started_at_unix_ms ?? 0;
    const scoped = rows.filter((r) => r.timestamp_unix_ms >= startMs);
    // listOperatorDecisions returns newest-first; reverse so chronological
    // order matches live (newest at bottom).
    scoped.reverse();
    if (!this.root) return;
    const feed = this.root.querySelector<HTMLElement>(".afk-feed");
    if (!feed) return;
    if (scoped.length > 0) {
      const empty = feed.querySelector(".afk-feed-empty");
      if (empty) empty.remove();
    }
    for (const r of scoped) {
      feed.appendChild(renderSeededCard(r));
    }
  }
```

- [ ] **Step 3: Add the seeded-row renderer**

```typescript
function renderSeededCard(r: OperatorDecisionRow): HTMLElement {
  let cls: string;
  let title: string;
  let body: string;
  switch (r.action) {
    case "reply":
      cls = r.executed ? "ok" : "muted";
      title = r.executed ? "REPLY" : "REPLY (dry)";
      body = formatReplyLine(r.reply_text, r.rationale);
      break;
    case "escalate":
      cls = "warn";
      title = "ESCALATE";
      body = r.rationale ?? r.reply_text ?? "(no detail)";
      break;
    case "wait":
      cls = "muted";
      title = "WAIT";
      body = r.rationale ?? "(no detail)";
      break;
    default:
      cls = "muted";
      title = r.action.toUpperCase();
      body = r.rationale ?? "";
  }
  const time = formatClock(r.timestamp_unix_ms);
  // No `<button>`: seeded rows can't click-jump (we only have the short
  // session id, not the full SessionId). Render as plain div for parity.
  const card = document.createElement("div");
  card.className = `afk-card afk-card-${cls} afk-card-seeded`;
  card.innerHTML = `
    <span class="afk-card-time">${escapeHtml(time)}</span>
    <span class="afk-card-tab">…${escapeHtml(r.session_id_short)}</span>
    <span class="afk-card-action">${escapeHtml(title)}</span>
    <span class="afk-card-body"></span>
  `;
  card.querySelector<HTMLElement>(".afk-card-body")!.textContent = body;
  return card;
}
```

Note: `seedFeed()` may run before `refreshHeader()` resolves and stamps `this.status`. Reorder `open()` so the FIRST `refreshHeader()` is awaited before seeding:

In `open()`, replace:

```typescript
    void this.refreshHeader();
    this.poll = window.setInterval(() => void this.refreshHeader(), 5_000);

    void listen<DecisionEvent>(...)
    void this.seedFeed();
```

with:

```typescript
    this.poll = window.setInterval(() => void this.refreshHeader(), 5_000);
    void this.bootstrap();
```

And add:

```typescript
  private async bootstrap(): Promise<void> {
    await this.refreshHeader();
    if (!this.root) return; // closed during await
    const un = await listen<DecisionEvent>("operator-decision", (event) => {
      this.pushDecision(event.payload);
    });
    if (this.root === null) {
      un();
      return;
    }
    this.unlistenDecision = un;
    await this.seedFeed();
  }
```

- [ ] **Step 4: Verify tsc passes**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/aom/afk.ts
git commit -m "feat(aom): AFK seed feed from current AOM session history"
```

---

### Task 6: Auto-scroll behavior + "back to live" pill

**Files:**
- Modify: `ui/src/aom/afk.ts`

Auto-scroll feed to bottom on every new card. If the user scrolls UP (anything other than near-bottom), pause auto-scroll and show a "back to live" pill anchored bottom-center. Clicking the pill resumes auto-scroll and scrolls to bottom.

Threshold: if `scrollHeight - scrollTop - clientHeight < 32` we treat as "at bottom".

- [ ] **Step 1: Add auto-scroll state + scroll listener**

Add fields:

```typescript
  private autoScroll = true;
```

In the `open()` HTML, add the pill (initially hidden) inside `<main class="afk-feed">` parent — easier as a sibling:

Replace:

```html
      <main class="afk-feed" tabindex="-1">
        <div class="afk-feed-empty">No decisions yet.</div>
      </main>
```

with:

```html
      <main class="afk-feed-wrap">
        <div class="afk-feed" tabindex="-1">
          <div class="afk-feed-empty">No decisions yet.</div>
        </div>
        <button type="button" class="afk-live-pill" hidden>Back to live</button>
      </main>
```

Update selectors that previously used `.afk-feed`:
- `seedFeed()` and `pushDecision()` already query `.afk-feed`; they still work because `.afk-feed` is the inner div.

- [ ] **Step 2: Wire scroll/pill listeners in `open()`**

After `root .querySelector<HTMLButtonElement>(".afk-wakeup")!.addEventListener(...)`:

```typescript
    const feed = root.querySelector<HTMLElement>(".afk-feed")!;
    const pill = root.querySelector<HTMLButtonElement>(".afk-live-pill")!;
    feed.addEventListener("scroll", () => {
      const atBottom =
        feed.scrollHeight - feed.scrollTop - feed.clientHeight < 32;
      this.autoScroll = atBottom;
      pill.hidden = atBottom;
    });
    pill.addEventListener("click", () => {
      this.autoScroll = true;
      feed.scrollTop = feed.scrollHeight;
      pill.hidden = true;
    });
```

- [ ] **Step 3: Auto-scroll on `pushDecision`**

At the end of `pushDecision()`, after `feed.appendChild(card);`:

```typescript
    if (this.autoScroll) {
      feed.scrollTop = feed.scrollHeight;
    } else {
      const pill = this.root.querySelector<HTMLButtonElement>(".afk-live-pill");
      if (pill) pill.hidden = false;
    }
```

Also auto-scroll after seedFeed completes:

At end of `seedFeed()`:

```typescript
    if (this.autoScroll && this.root) {
      const feedEl = this.root.querySelector<HTMLElement>(".afk-feed");
      if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
    }
```

- [ ] **Step 4: Verify tsc passes**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/aom/afk.ts
git commit -m "feat(aom): AFK auto-scroll + back-to-live pill"
```

---

### Task 7: "Run complete — open report?" prompt when AOM ends

**Files:**
- Modify: `ui/src/aom/afk.ts`
- Modify: `ui/src/main.ts` — pass `aomReportPanel` opener into AfkOverlay

If AOM stops while AFK is open (user clicks Stop on the banner; or budget-hit auto-stop fires), the overlay swaps the footer for a "Run complete — open report?" prompt linking to the report panel. Detection: `refreshHeader()` poll sees `status.enabled === false`.

- [ ] **Step 1: Extend `AfkOverlayDeps` with `openReport`**

In `afk.ts`:

```typescript
export interface AfkOverlayDeps {
  manager: TabManager;
  /// Open the morning report panel (⌘⇧R surface). AFK calls this when
  /// the user clicks "Run complete — open report?" after AOM ends.
  openReport: () => void;
  onExit?: () => void;
}
```

- [ ] **Step 2: Detect AOM-stopped in `refreshHeader()` and swap footer**

At the end of `renderHeader()`:

```typescript
    if (this.status && !this.status.enabled) {
      this.renderRunComplete();
    }
```

Add:

```typescript
  private renderRunComplete(): void {
    if (!this.root) return;
    const footer = this.root.querySelector<HTMLElement>(".afk-footer");
    if (!footer || footer.classList.contains("afk-footer-complete")) return;
    footer.classList.add("afk-footer-complete");
    footer.innerHTML = `
      <span class="afk-complete-msg">Run complete.</span>
      <button type="button" class="afk-open-report">Open report</button>
      <button type="button" class="afk-wakeup">Wake up</button>
      <span class="afk-hint">Esc to exit</span>
    `;
    footer
      .querySelector<HTMLButtonElement>(".afk-open-report")!
      .addEventListener("click", () => {
        this.deps.openReport();
        this.close();
      });
    footer
      .querySelector<HTMLButtonElement>(".afk-wakeup")!
      .addEventListener("click", () => this.close());
  }
```

- [ ] **Step 3: Pass `openReport` from `main.ts`**

In `main.ts`, replace:

```typescript
  const afk = new AfkOverlay(document.body, {
    manager,
    onExit: () => manager.refitActive(),
  });
```

with:

```typescript
  const afk = new AfkOverlay(document.body, {
    manager,
    openReport: () => void aomReportPanel.open(),
    onExit: () => manager.refitActive(),
  });
```

- [ ] **Step 4: Verify tsc passes**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/aom/afk.ts ui/src/main.ts
git commit -m "feat(aom): AFK run-complete prompt links to report"
```

---

### Task 8: Banner "Enter AFK" button

**Files:**
- Modify: `ui/src/aom/banner.ts` — add a button that calls a callback
- Modify: `ui/src/main.ts` — wire the callback to `afk.open()`

Per spec File boundaries, banner gains ≤25 lines. Add a small button next to "Stop" labeled "AFK" (or moon icon) that triggers an injected `onEnterAfk` callback. Banner does NOT depend on AfkOverlay directly — it only invokes the callback.

- [ ] **Step 1: Add `onEnterAfk` parameter to `AomBanner`**

In `banner.ts`, add a constructor option:

```typescript
export class AomBanner {
  // …
  private onEnterAfk: (() => void) | null = null;

  constructor(private readonly mountHost: HTMLElement) {
    // …existing body unchanged
  }

  setEnterAfkHandler(fn: () => void): void {
    this.onEnterAfk = fn;
  }
```

- [ ] **Step 2: Add the AFK button to the banner template**

In `render()`, replace the `<button class="aom-banner-stop">…</button>` line with both buttons:

```typescript
      <button type="button" class="aom-banner-afk" title="Enter AFK mode (⌘⇧A)">
        AFK
      </button>
      <button type="button" class="aom-banner-stop" title="Stop AOM">
        Stop
      </button>
```

After the existing Stop button event wiring, add:

```typescript
    this.root
      .querySelector<HTMLButtonElement>(".aom-banner-afk")!
      .addEventListener("click", () => {
        if (this.onEnterAfk) this.onEnterAfk();
      });
```

- [ ] **Step 3: Wire the handler from `main.ts`**

In `main.ts`, after the `afk` instance is constructed:

```typescript
  aomBanner.setEnterAfkHandler(() => afk.open());
```

- [ ] **Step 4: Update banner's Stop button title**

The old title was "Stop AOM (⌘⇧A)". Now ⌘⇧A no longer stops AOM — change title to plain "Stop AOM".

The replacement above already does this.

- [ ] **Step 5: Verify tsc passes**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/aom/banner.ts ui/src/main.ts
git commit -m "feat(aom): banner AFK button + adjusted Stop title"
```

---

### Task 9: Styles — overlay, header, feed cards, footer, pill

**Files:**
- Modify: `ui/src/styles.css` (append at end, max 220 lines)

Reuse `--bg-overlay`, `--border`, `--muted`, `--accent`. No new color tokens. The overlay covers the full window above all other UI; z-index high (the AOM banner sits at `z-index: 40` per existing styles — pick `z-index: 200` for AFK so it covers banner too, then user can still see it bleed through if we want; spec says "above tab strip and sidebar" — banner is decorative, AFK can cover it).

Actually the spec footer mentions "Wake up" — banner Stop button should NOT be needed during AFK because the run-complete prompt handles end-of-AOM. So covering the banner is fine.

- [ ] **Step 1: Append AFK styles**

Append to `ui/src/styles.css`:

```css
/* ---- AOM AFK ("Battery Mode") overlay ---- */

.afk-overlay {
    position: fixed;
    inset: 0;
    z-index: 200;
    display: grid;
    grid-template-rows: auto 1fr auto;
    background: var(--bg-overlay);
    color: inherit;
    font-family: inherit;
    animation: afk-fade-in 0.15s ease-out;
}

@keyframes afk-fade-in {
    from {
        opacity: 0;
    }
    to {
        opacity: 1;
    }
}

.afk-header {
    display: flex;
    justify-content: center;
    padding: 24px 32px;
    border-bottom: 1px solid var(--border);
}

.afk-header-stats {
    display: flex;
    gap: 32px;
    align-items: baseline;
    font-variant-numeric: tabular-nums;
}

.afk-stat {
    font-size: 18px;
    color: var(--muted);
    letter-spacing: 0.02em;
}

.afk-stat-cost {
    color: inherit;
    font-weight: 500;
}

.afk-stat-warn {
    color: #d6a16a;
}

.afk-feed-wrap {
    position: relative;
    overflow: hidden;
}

.afk-feed {
    height: 100%;
    overflow-y: auto;
    padding: 24px 32px 48px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    scroll-behavior: smooth;
}

.afk-feed-empty {
    margin: auto;
    color: var(--muted);
    font-size: 14px;
}

.afk-card {
    display: grid;
    grid-template-columns: auto auto auto 1fr;
    gap: 12px;
    align-items: baseline;
    padding: 10px 14px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    text-align: left;
    font: inherit;
    cursor: pointer;
    transition: border-color 0.12s ease;
}

.afk-card:hover {
    border-color: var(--accent);
}

.afk-card-seeded {
    cursor: default;
    opacity: 0.85;
}

.afk-card-seeded:hover {
    border-color: var(--border);
}

.afk-card-time {
    color: var(--muted);
    font-variant-numeric: tabular-nums;
    font-size: 12px;
}

.afk-card-tab {
    color: var(--muted);
    font-size: 12px;
}

.afk-card-action {
    font-size: 12px;
    letter-spacing: 0.06em;
    padding: 2px 6px;
    border-radius: 3px;
    border: 1px solid var(--border);
}

.afk-card-ok .afk-card-action {
    color: var(--accent);
    border-color: color-mix(in srgb, var(--accent) 50%, transparent);
}

.afk-card-warn .afk-card-action {
    color: #d6a16a;
    border-color: color-mix(in srgb, #d6a16a 50%, transparent);
}

.afk-card-muted .afk-card-action {
    color: var(--muted);
}

.afk-card-body {
    color: inherit;
    font-size: 13px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

.afk-live-pill {
    position: absolute;
    bottom: 16px;
    left: 50%;
    transform: translateX(-50%);
    padding: 6px 14px;
    border: 1px solid var(--accent);
    border-radius: 999px;
    background: var(--bg-overlay);
    color: var(--accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
}

.afk-live-pill:hover {
    background: color-mix(in srgb, var(--accent) 10%, var(--bg-overlay));
}

.afk-footer {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 16px;
    padding: 20px 32px;
    border-top: 1px solid var(--border);
}

.afk-wakeup,
.afk-open-report {
    padding: 8px 18px;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 13px;
    cursor: pointer;
}

.afk-wakeup:hover,
.afk-open-report:hover {
    border-color: var(--accent);
    color: var(--accent);
}

.afk-hint {
    color: var(--muted);
    font-size: 12px;
}

.afk-complete-msg {
    color: var(--muted);
    font-size: 13px;
}

/* ---- AOM banner: AFK button ---- */

.aom-banner-afk {
    padding: 4px 10px;
    margin-left: 6px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font: inherit;
    font-size: 12px;
    cursor: pointer;
}

.aom-banner-afk:hover {
    border-color: var(--accent);
    color: var(--accent);
}
```

- [ ] **Step 2: Verify tsc still passes (no TS impact, but confirm)**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(aom): AFK overlay styles"
```

---

### Task 10: Hand-test in dev server + final verification

**Files:** none (verification only)

Per CLAUDE.md, frontend changes need browser hand-testing. Confirm: shortcut layering works, header populates, feed shows live and seeded cards, scroll-pause + pill work, click-to-jump focuses tab + closes overlay, banner AFK button works, run-complete prompt opens the report.

- [ ] **Step 1: Run `cargo check -p karl-app` for safety**

Run: `cargo check -p karl-app`
Expected: PASS — no Rust changes, should be a no-op.

- [ ] **Step 2: Final tsc check**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Manual test plan (run `cargo tauri dev` if user wants to verify)**

Document the hand-test plan in the task close-out (do not run unless user requests):

1. AOM off → press ⌘⇧A → AOM banner appears (existing behavior)
2. AOM on → press ⌘⇧A → AFK overlay opens; header shows cost / elapsed / tab count
3. Run an executor that triggers an operator-decision → card appears at bottom; auto-scrolls
4. Scroll up in feed → pill appears; new cards stop auto-scrolling
5. Click pill → scrolls to bottom, pill hides
6. Click a live card → tab focuses, AFK exits
7. Press Esc → AFK closes (no other modal opens)
8. Banner Stop while AFK open → footer swaps to "Run complete — Open report"
9. Click "Open report" → report panel opens, AFK exits

- [ ] **Step 4: Update spec status note**

The spec has an "AOM run notes" section (line 100-102) reserved for run notes. Don't touch it now — it's intentionally empty per spec.

- [ ] **Step 5: Final commit if any cleanup**

If no further changes, no commit. If small fixes from manual testing, commit per the surface fixed.

---

## Self-review

**Spec coverage check:**
- ⌘⇧A toggles AFK only when AOM active → Task 2 (layered: starts AOM if off; opens AFK if on)
- Three-region overlay (header / feed / footer) → Task 1 (skeleton), 3 (header), 4-5 (feed), 7 (footer)
- Header: total cost / budget / elapsed / active tab count → Task 3
- Decisions feed: timestamp, tab label, action, one-line rationale → Task 4
- Footer: Wake up + Esc hint → Task 1
- Auto-scroll, scroll-up pauses, "back to live" pill → Task 6
- Esc and Wake up exit AFK → Task 1 (Wake up), Task 2 (Esc)
- Respects active vibrancy mode → Task 9 (uses `--bg-overlay`)
- Decisions link to source block (focus tab, scroll, exit AFK) → Task 4 (focus tab + exit; scroll-into-view degrades to tab focus, documented in plan header)
- "Run complete — open report?" when AOM ends → Task 7
- tsc passes; cargo check no regression → Task 10

**Placeholder scan:** None — every task has full code or specific edits.

**Type consistency:**
- `AfkOverlayDeps.openReport` defined Task 7, called from Task 7 footer handler ✓
- `setEnterAfkHandler` defined Task 8 step 1, called from Task 8 step 3 ✓
- `aomActiveTabCount` defined Task 3 step 1, called Task 3 step 2 ✓
- `DecisionEvent` shape Task 4 mirrors `activity-feed.ts:17-27` ✓
- `OperatorDecisionRow` shape Task 5 mirrors `api.ts:274-284` ✓
- `bootstrap()` introduced Task 5 step 3 reorders the open() flow established in Task 4 — explicit in the task instruction ✓
