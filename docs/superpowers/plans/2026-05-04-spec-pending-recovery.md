# Spec Pending Recovery (3.17) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent badge per tab and a contextual menu on `docs/specs/**/*.md` cmd+click so the spec-detection wow-moment of 3.16 survives missed toasts and ambiguous targets — and fix the multi-toast confusion bug observed in production.

**Architecture:** Frontend-only. Reuses 3.16's `SpecPromptState` (already exposes `getPendingForTab` per tab). Adds (1) a tiny pub-sub on the state so the badge re-renders reactively, (2) a single-toast renderer bound to one tab with a visible target label, (3) a `paperclip` badge per tab opened by `TabManager`, (4) a global cmd+click interceptor that detects spec paths and shows a contextual menu, (5) a small tab-picker modal.

**Tech Stack:** TypeScript (strict), no framework, vanilla DOM. xterm.js for terminal output. Tests via vitest (matches `*.test.ts` already in repo).

---

## File Structure

**Create:**
- `ui/src/aom/spec-badge.ts` (~180 lines) — badge per tab + popover.
- `ui/src/aom/spec-badge.test.ts` (~80 lines).
- `ui/src/aom/spec-link-menu.ts` (~150 lines) — `isSpecPath` matcher, contextual menu, tab picker modal, cmd+click interceptor wiring.
- `ui/src/aom/spec-link-menu.test.ts` (~80 lines) — focused on `isSpecPath`.

**Modify:**
- `ui/src/aom/spec-prompt-state.ts` — add subscription mechanism (`onChange(cb)`) fired on `recordCandidate / dismiss / acceptOnTab`, and a `getPendingByPath(path)` lookup helper.
- `ui/src/aom/spec-prompt.ts` — replace N-toast loop with a single-toast renderer bound to an explicit target tab, displaying the tab name. Re-render when active tab changes.
- `ui/src/aom/spec-prompt.test.ts` — update for single-toast semantics.
- `ui/src/tabs/manager.ts` — mount the badge node into each tab header on creation; unmount on close.
- `ui/src/main.ts` — bootstrap badge listener and cmd+click interceptor.
- `ui/src/styles.css` — badge, popover, contextual menu, tab-picker modal styles.

---

## Task 1: Add reactive subscription + multi-pending lookup to `SpecPromptState`

**Files:**
- Modify: `ui/src/aom/spec-prompt-state.ts`
- Test: (covered by existing `spec-prompt.test.ts` updates in Task 2)

**Why:** `spec-prompt-state.ts` exposes per-tab pending list synchronously (`getPendingForTab`). The badge needs to know *when* to re-render. Adding a tiny pub-sub keeps the change minimal and avoids polling.

- [ ] **Step 1: Extend the `SpecPromptState` interface**

In `ui/src/aom/spec-prompt-state.ts`, after the existing `getPendingForTab` line in the interface, add:

```typescript
  onChange(cb: () => void): () => void;
```

- [ ] **Step 2: Implement subscription inside `createSpecPromptState`**

At the top of `createSpecPromptState`, after the existing `pending`/`consumed` maps, add:

```typescript
  const listeners = new Set<() => void>();
  const fire = () => {
    for (const cb of listeners) cb();
  };
```

Then wrap the three mutation methods (`recordCandidate`, `dismiss`, `acceptOnTab`) so they call `fire()` after mutation. Example for `recordCandidate`:

```typescript
    recordCandidate(c, nowMs) {
      pending.set(c.path, { candidate: c, receivedAtMs: nowMs });
      fire();
    },
```

Apply the same pattern to `dismiss` and `acceptOnTab`.

Add the `onChange` implementation to the returned `state` object:

```typescript
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb) as unknown as void;
    },
```

- [ ] **Step 3: Add `getPendingByPath` helper for the contextual menu**

Add to interface:

```typescript
  getPendingByPath(path: string): SpecCandidate | null;
```

Add to implementation:

```typescript
    getPendingByPath(path) {
      return pending.get(path)?.candidate ?? null;
    },
```

- [ ] **Step 4: Run typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: PASS (no errors).

- [ ] **Step 5: Commit**

```bash
git add ui/src/aom/spec-prompt-state.ts
git commit -m "feat(spec-prompt): reactive subscription + by-path lookup on state"
```

---

## Task 2: Fix multi-toast bug — render single toast bound to a target tab

**Files:**
- Modify: `ui/src/aom/spec-prompt.ts`
- Test: `ui/src/aom/spec-prompt.test.ts`

**Why:** Today `onCandidate` loops over `eligibleTabs` and renders one toast per tab in a body-level stack. The user has no visual indication which toast belongs to which tab and clicking any of them assigns the spec to that toast's tab — which is rarely the tab the user is looking at. Fix: render *one* toast at a time, prefer the currently-active tab if eligible (else the first eligible), and label the target tab visibly. Other eligible tabs get the badge (Task 4) instead.

- [ ] **Step 1: Write failing test for single-toast behavior**

In `ui/src/aom/spec-prompt.test.ts`, add (or replace the equivalent existing scenario):

```typescript
it("renders exactly one toast bound to the active eligible tab", async () => {
  const tabs: TabSnapshot[] = [
    { id: "t1", cwd: "/repo", hasMission: false, hasOperator: true },
    { id: "t2", cwd: "/repo", hasMission: false, hasOperator: true },
  ];
  const host = makeHost(tabs, { activeTabId: "t2" });
  await startSpecPrompts(host);
  emitCandidate({ path: "/repo/docs/specs/3.20.md", repo_root: "/repo", source: "covenant", goal_snippet: "..." });
  const toasts = document.querySelectorAll(".spec-prompt-toast");
  expect(toasts.length).toBe(1);
  expect((toasts[0] as HTMLElement).dataset.tabId).toBe("t2");
});

it("falls back to first eligible tab if active is not eligible", async () => {
  const tabs: TabSnapshot[] = [
    { id: "t1", cwd: "/other", hasMission: false, hasOperator: true },     // wrong cwd
    { id: "t2", cwd: "/repo",  hasMission: true,  hasOperator: true },     // has mission
    { id: "t3", cwd: "/repo",  hasMission: false, hasOperator: true },     // eligible
  ];
  const host = makeHost(tabs, { activeTabId: "t1" });
  await startSpecPrompts(host);
  emitCandidate({ path: "/repo/docs/specs/3.20.md", repo_root: "/repo", source: "covenant", goal_snippet: "..." });
  const toasts = document.querySelectorAll(".spec-prompt-toast");
  expect(toasts.length).toBe(1);
  expect((toasts[0] as HTMLElement).dataset.tabId).toBe("t3");
});
```

The existing test helper `makeHost` likely doesn't take `activeTabId` yet — extend it to accept and expose `getActiveTabId()`. Mirror the helper additions in the corresponding `SpecPromptHost` interface change in Step 2.

- [ ] **Step 2: Extend `SpecPromptHost` with active-tab awareness**

In `ui/src/aom/spec-prompt.ts`, change the host interface:

```typescript
export interface SpecPromptHost {
  listTabs(): TabSnapshot[];
  getActiveTabId(): string | null;
  setMissionForTab(tabId: string, path: string): Promise<void>;
  /** Optional: human-friendly name to display on the toast ("tab 2 — repo"). */
  getTabLabel?(tabId: string): string;
}
```

- [ ] **Step 3: Replace the loop in `onCandidate` with single-target selection**

Replace the `for (const tab of state.eligibleTabs(...))` loop with:

```typescript
function onCandidate(cand: SpecCandidate) {
  const state = getSpecPromptState();
  const host = hostRef;
  if (!host) return;
  state.recordCandidate(cand, Date.now());

  const tabs = host.listTabs();
  const eligible = state.eligibleTabs(cand, tabs);
  if (eligible.length === 0) return;

  const activeId = host.getActiveTabId();
  const target =
    eligible.find((t) => t.id === activeId) ?? eligible[0];

  if (state.isDismissed(target.id, cand.path)) return;
  renderToast(host, target, cand);
}
```

- [ ] **Step 4: Show the target tab label in the toast**

Inside `renderToast`, change the inner HTML to include the tab label. Replace the `spec-prompt-toast-head` block with:

```typescript
  const tabLabel = host.getTabLabel?.(tab.id) ?? tab.id;
  el.innerHTML = `
    <div class="spec-prompt-toast-head">
      <span class="spec-prompt-toast-label">${escapeHtml(label)}</span>
      <span class="spec-prompt-toast-file">${escapeHtml(fileName)}</span>
    </div>
    <div class="spec-prompt-toast-target">→ ${escapeHtml(tabLabel)}</div>
    <div class="spec-prompt-toast-snippet">${escapeHtml(cand.goal_snippet)}</div>
    <div class="spec-prompt-toast-actions">
      <button type="button" class="spec-prompt-toast-set">Set as mission</button>
      <button type="button" class="spec-prompt-toast-dismiss">Dismiss</button>
    </div>
  `;
```

- [ ] **Step 5: Wire the new host fields in `main.ts`**

In `ui/src/main.ts`, locate the `startSpecPrompts({ ... })` call (around line 361) and extend the host literal:

```typescript
  void startSpecPrompts({
    listTabs: () => manager.listTabSnapshots(),
    getActiveTabId: () => manager.getActiveTabId(),
    setMissionForTab: (tabId, path) => manager.setMissionPathForTab(tabId, path),
    getTabLabel: (tabId) => manager.getTabLabel(tabId),
  });
```

If `getActiveTabId()` and `getTabLabel(tabId)` don't exist on `TabManager`, add them in the same task. Open `ui/src/tabs/manager.ts` and append, near the other public getters:

```typescript
  getActiveTabId(): string | null {
    return this.activeId ?? null;
  }

  getTabLabel(tabId: string): string {
    const tab = this.tabs.find((t) => t.id === tabId);
    if (!tab) return tabId;
    return tab.name ?? `Tab ${this.tabs.indexOf(tab) + 1}`;
  }
```

(If `tab.name` is named differently in this codebase — e.g. `title` — adjust to match. Verify by grepping the existing render code in `manager.ts`.)

- [ ] **Step 6: Run tests**

Run: `cd ui && npx vitest run src/aom/spec-prompt.test.ts`
Expected: PASS for both new tests.

Run: `cd ui && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Add minimal CSS for the new target line**

In `ui/src/styles.css`, near the existing `.spec-prompt-toast` rules:

```css
.spec-prompt-toast-target {
  font-size: 11px;
  color: var(--text-muted, #888);
  margin-top: 2px;
}
```

- [ ] **Step 8: Commit**

```bash
git add ui/src/aom/spec-prompt.ts ui/src/aom/spec-prompt.test.ts ui/src/main.ts ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "fix(spec-prompt): render single toast bound to active tab with target label"
```

---

## Task 3: `isSpecPath` matcher + unit tests

**Files:**
- Create: `ui/src/aom/spec-link-menu.ts` (matcher only in this task)
- Create: `ui/src/aom/spec-link-menu.test.ts`

**Why:** The cmd+click interceptor and the badge popover both need to know if a path is a "spec we care about". Same rule as 3.16 backend: under `docs/specs/`, `.md`, excluding `_template.md` and anything under `drafts/`.

- [ ] **Step 1: Write failing tests**

`ui/src/aom/spec-link-menu.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { isSpecPath } from "./spec-link-menu";

describe("isSpecPath", () => {
  it("matches absolute paths under docs/specs ending in .md", () => {
    expect(isSpecPath("/Users/x/repo/docs/specs/3.17-foo.md")).toBe(true);
    expect(isSpecPath("/repo/docs/specs/sub/3.17-foo.md")).toBe(true);
  });
  it("matches relative paths", () => {
    expect(isSpecPath("docs/specs/3.17-foo.md")).toBe(true);
    expect(isSpecPath("./docs/specs/3.17-foo.md")).toBe(true);
  });
  it("rejects _template.md", () => {
    expect(isSpecPath("/repo/docs/specs/_template.md")).toBe(false);
  });
  it("rejects drafts/", () => {
    expect(isSpecPath("/repo/docs/specs/drafts/foo.md")).toBe(false);
    expect(isSpecPath("docs/specs/drafts/2026-01-foo.md")).toBe(false);
  });
  it("rejects non-md files", () => {
    expect(isSpecPath("/repo/docs/specs/3.17.txt")).toBe(false);
  });
  it("rejects paths outside docs/specs", () => {
    expect(isSpecPath("/repo/docs/plans/3.17.md")).toBe(false);
    expect(isSpecPath("/repo/README.md")).toBe(false);
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `cd ui && npx vitest run src/aom/spec-link-menu.test.ts`
Expected: FAIL with "Cannot find module './spec-link-menu'".

- [ ] **Step 3: Implement matcher**

Create `ui/src/aom/spec-link-menu.ts`:

```typescript
const SPEC_RE = /(^|\/)docs\/specs\/(.+)$/;

export function isSpecPath(path: string): boolean {
  if (!path.endsWith(".md")) return false;
  const m = SPEC_RE.exec(path);
  if (!m) return false;
  const rest = m[2];                       // e.g. "drafts/foo.md" or "_template.md" or "3.17-foo.md"
  if (rest.startsWith("drafts/")) return false;
  if (rest.includes("/drafts/")) return false;
  const fileName = rest.split("/").pop() ?? "";
  if (fileName === "_template.md") return false;
  return true;
}
```

- [ ] **Step 4: Run tests**

Run: `cd ui && npx vitest run src/aom/spec-link-menu.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add ui/src/aom/spec-link-menu.ts ui/src/aom/spec-link-menu.test.ts
git commit -m "feat(spec-link): isSpecPath matcher for docs/specs/**/*.md"
```

---

## Task 4: Tab badge component (mount + render reactive count)

**Files:**
- Create: `ui/src/aom/spec-badge.ts` (mount + render only in this task; popover in Task 5)
- Modify: `ui/src/tabs/manager.ts`
- Test: `ui/src/aom/spec-badge.test.ts`

**Why:** Persistent visual cue on each tab whenever pending candidates exist for it.

- [ ] **Step 1: Write failing badge test**

`ui/src/aom/spec-badge.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import { createSpecPromptState } from "./spec-prompt-state";
import { mountSpecBadge } from "./spec-badge";

describe("spec badge", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("hidden when no pending candidates", () => {
    const state = createSpecPromptState();
    const host = document.createElement("div");
    document.body.appendChild(host);
    mountSpecBadge(host, "t1", state, () => [
      { id: "t1", cwd: "/repo", hasMission: false, hasOperator: true },
    ]);
    expect(host.querySelector(".spec-badge")?.classList.contains("hidden")).toBe(true);
  });

  it("shows count when pending exists", () => {
    const state = createSpecPromptState();
    const host = document.createElement("div");
    document.body.appendChild(host);
    const tabs = [{ id: "t1", cwd: "/repo", hasMission: false, hasOperator: true }];
    mountSpecBadge(host, "t1", state, () => tabs);
    state.recordCandidate(
      { path: "/repo/docs/specs/a.md", repo_root: "/repo", source: "covenant", goal_snippet: "g" },
      Date.now(),
    );
    state.recordCandidate(
      { path: "/repo/docs/specs/b.md", repo_root: "/repo", source: "covenant", goal_snippet: "g" },
      Date.now(),
    );
    const badge = host.querySelector(".spec-badge") as HTMLElement;
    expect(badge.classList.contains("hidden")).toBe(false);
    expect(badge.textContent).toContain("2");
  });
});
```

- [ ] **Step 2: Verify tests fail**

Run: `cd ui && npx vitest run src/aom/spec-badge.test.ts`
Expected: FAIL with "Cannot find module './spec-badge'".

- [ ] **Step 3: Implement badge mount + render**

Create `ui/src/aom/spec-badge.ts`:

```typescript
import type { SpecCandidate } from "../api";
import type { SpecPromptState, TabSnapshot } from "./spec-prompt-state";

export interface SpecBadgeHandle {
  destroy(): void;
}

export function mountSpecBadge(
  parent: HTMLElement,
  tabId: string,
  state: SpecPromptState,
  listTabs: () => TabSnapshot[],
): SpecBadgeHandle {
  const badge = document.createElement("button");
  badge.type = "button";
  badge.className = "spec-badge hidden";
  badge.title = "Specs pending for this tab";
  badge.innerHTML = `<span class="spec-badge-icon">📎</span><span class="spec-badge-count"></span>`;
  parent.appendChild(badge);

  const render = () => {
    const tab = listTabs().find((t) => t.id === tabId);
    if (!tab) {
      badge.classList.add("hidden");
      return;
    }
    const pending = state.getPendingForTab(tab, listTabs(), Date.now());
    if (pending.length === 0) {
      badge.classList.add("hidden");
      return;
    }
    badge.classList.remove("hidden");
    const count = badge.querySelector(".spec-badge-count")!;
    count.textContent = pending.length > 1 ? String(pending.length) : "";
  };

  const unsub = state.onChange(render);
  render();

  // Popover wired in Task 5
  return {
    destroy() {
      unsub();
      badge.remove();
    },
  };
}

export function _pendingForTab(
  state: SpecPromptState,
  tabId: string,
  listTabs: () => TabSnapshot[],
): SpecCandidate[] {
  const tab = listTabs().find((t) => t.id === tabId);
  if (!tab) return [];
  return state.getPendingForTab(tab, listTabs(), Date.now());
}
```

- [ ] **Step 4: Add CSS for the badge**

In `ui/src/styles.css`:

```css
.spec-badge {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 0 4px;
  height: 16px;
  margin-left: 4px;
  font-size: 11px;
  color: var(--accent, #3b82f6);
  background: transparent;
  border: 1px solid var(--accent, #3b82f6);
  border-radius: 3px;
  cursor: pointer;
}
.spec-badge.hidden { display: none; }
.spec-badge-count:empty { display: none; }
.spec-badge-icon { font-size: 10px; line-height: 1; }
```

- [ ] **Step 5: Mount the badge from `TabManager` on tab creation**

In `ui/src/tabs/manager.ts`, locate the method that builds the tab header DOM (likely `renderTabs` or a `createTabElement` helper — grep for `tab-header` or `tab.name`). At the end of the per-tab header construction, add:

```typescript
import { mountSpecBadge, type SpecBadgeHandle } from "../aom/spec-badge";
import { getSpecPromptState } from "../aom/spec-prompt";
// ...

// Inside the per-tab header builder, after appending name/close button:
const badgeHandle: SpecBadgeHandle = mountSpecBadge(
  headerEl,
  tab.id,
  getSpecPromptState(),
  () => this.listTabSnapshots(),
);
// Stash handle so close() can destroy:
(tab as any)._specBadge = badgeHandle;
```

In the tab close path (grep for `closeTab` or `removeTab`), call:

```typescript
(tab as any)._specBadge?.destroy();
```

If `TabManager` already has a typed slot for per-tab UI handles, prefer that to `as any`. Otherwise add a non-enumerable `specBadge?: SpecBadgeHandle` field to the tab type.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd ui && npx vitest run src/aom/spec-badge.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/aom/spec-badge.ts ui/src/aom/spec-badge.test.ts ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(spec-badge): persistent badge per tab driven by SpecPromptState"
```

---

## Task 5: Badge popover with `Asignar / Abrir / Descartar`

**Files:**
- Modify: `ui/src/aom/spec-badge.ts`
- Modify: `ui/src/aom/spec-badge.test.ts`

**Why:** Badge is useless without a recovery action. Popover lists pending candidates with the same actions as the toast plus `Abrir`.

- [ ] **Step 1: Add test for popover open + assign action**

Append to `ui/src/aom/spec-badge.test.ts`:

```typescript
it("opens popover on click and assigns spec to tab", async () => {
  const state = createSpecPromptState();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const tabs = [{ id: "t1", cwd: "/repo", hasMission: false, hasOperator: true }];
  let assigned: { tabId: string; path: string } | null = null;
  mountSpecBadge(host, "t1", state, () => tabs, {
    setMissionForTab: async (tabId, path) => { assigned = { tabId, path }; },
    openSpec: async () => {},
  });
  state.recordCandidate(
    { path: "/repo/docs/specs/a.md", repo_root: "/repo", source: "covenant", goal_snippet: "goal" },
    Date.now(),
  );
  (host.querySelector(".spec-badge") as HTMLButtonElement).click();
  const item = document.querySelector(".spec-badge-popover .spec-badge-set") as HTMLButtonElement;
  expect(item).toBeTruthy();
  item.click();
  await Promise.resolve();
  expect(assigned).toEqual({ tabId: "t1", path: "/repo/docs/specs/a.md" });
});
```

- [ ] **Step 2: Verify it fails**

Run: `cd ui && npx vitest run src/aom/spec-badge.test.ts`
Expected: FAIL (popover not implemented; signature mismatch).

- [ ] **Step 3: Add popover + actions to `spec-badge.ts`**

Change the `mountSpecBadge` signature to accept a host:

```typescript
export interface SpecBadgeHost {
  setMissionForTab(tabId: string, path: string): Promise<void>;
  openSpec(path: string): Promise<void>;
}

export function mountSpecBadge(
  parent: HTMLElement,
  tabId: string,
  state: SpecPromptState,
  listTabs: () => TabSnapshot[],
  host: SpecBadgeHost,
): SpecBadgeHandle {
  // ... existing badge creation ...

  let popover: HTMLElement | null = null;

  const closePopover = () => {
    popover?.remove();
    popover = null;
    document.removeEventListener("click", onDocClick, true);
  };

  const onDocClick = (e: MouseEvent) => {
    if (!popover) return;
    if (popover.contains(e.target as Node) || badge.contains(e.target as Node)) return;
    closePopover();
  };

  const openPopover = () => {
    if (popover) { closePopover(); return; }
    const tab = listTabs().find((t) => t.id === tabId);
    if (!tab) return;
    const pending = state.getPendingForTab(tab, listTabs(), Date.now());
    popover = document.createElement("div");
    popover.className = "spec-badge-popover";
    popover.innerHTML = pending.map((c) => {
      const fileName = c.path.split("/").pop() ?? c.path;
      return `
        <div class="spec-badge-item" data-path="${escapeAttr(c.path)}">
          <div class="spec-badge-item-file">${escapeHtml(fileName)}</div>
          <div class="spec-badge-item-snippet">${escapeHtml(c.goal_snippet)}</div>
          <div class="spec-badge-item-actions">
            <button type="button" class="spec-badge-set">Asignar</button>
            <button type="button" class="spec-badge-open">Abrir</button>
            <button type="button" class="spec-badge-dismiss">Descartar</button>
          </div>
        </div>`;
    }).join("");
    document.body.appendChild(popover);
    const r = badge.getBoundingClientRect();
    popover.style.position = "fixed";
    popover.style.top = `${r.bottom + 4}px`;
    popover.style.left = `${r.left}px`;

    popover.querySelectorAll<HTMLElement>(".spec-badge-item").forEach((item) => {
      const path = item.dataset.path!;
      item.querySelector(".spec-badge-set")!.addEventListener("click", async () => {
        state.acceptOnTab(tabId, path);
        closePopover();
        try { await host.setMissionForTab(tabId, path); }
        catch (e) { console.error("setMissionForTab failed", e); }
      });
      item.querySelector(".spec-badge-open")!.addEventListener("click", async () => {
        try { await host.openSpec(path); } catch (e) { console.error("openSpec failed", e); }
      });
      item.querySelector(".spec-badge-dismiss")!.addEventListener("click", () => {
        state.dismiss(tabId, path);
        closePopover();
      });
    });

    setTimeout(() => document.addEventListener("click", onDocClick, true), 0);
  };

  badge.addEventListener("click", openPopover);

  return {
    destroy() {
      unsub();
      closePopover();
      badge.remove();
    },
  };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function escapeAttr(s: string): string { return escapeHtml(s); }
```

- [ ] **Step 4: Add popover CSS**

In `ui/src/styles.css`:

```css
.spec-badge-popover {
  z-index: 9999;
  background: var(--bg-overlay, #1a1a1a);
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  padding: 6px;
  min-width: 280px;
  max-width: 380px;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.spec-badge-item { padding: 6px; border-bottom: 1px solid var(--border, #2a2a2a); }
.spec-badge-item:last-child { border-bottom: none; }
.spec-badge-item-file { font-weight: 600; font-size: 12px; }
.spec-badge-item-snippet { font-size: 11px; color: var(--text-muted, #888); margin: 4px 0; }
.spec-badge-item-actions { display: flex; gap: 6px; }
.spec-badge-item-actions button {
  font-size: 11px; padding: 2px 8px; cursor: pointer;
  background: transparent; border: 1px solid var(--border, #444); color: inherit; border-radius: 3px;
}
.spec-badge-set { color: var(--accent, #3b82f6); border-color: var(--accent, #3b82f6) !important; }
```

- [ ] **Step 5: Wire `host` into TabManager mount call**

In `ui/src/tabs/manager.ts`, update the `mountSpecBadge` call to pass the host:

```typescript
mountSpecBadge(headerEl, tab.id, getSpecPromptState(), () => this.listTabSnapshots(), {
  setMissionForTab: (tabId, path) => this.setMissionPathForTab(tabId, path),
  openSpec: (path) => this.openSpecInViewer(path),
});
```

If `openSpecInViewer` doesn't exist on `TabManager`, add a thin wrapper. Look for whatever method handles cmd+click on `.md` paths today (grep for `revealItemInDir`, `openPath`, or similar). If the existing handler is in `main.ts`, expose it as a free function and import here instead.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd ui && npx vitest run src/aom/spec-badge.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add ui/src/aom/spec-badge.ts ui/src/aom/spec-badge.test.ts ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(spec-badge): popover with assign/open/dismiss actions"
```

---

## Task 6: Cmd+click contextual menu on spec links

**Files:**
- Modify: `ui/src/aom/spec-link-menu.ts`
- Modify: `ui/src/main.ts`

**Why:** When the agent's output mentions a spec path and the user cmd+clicks it, default-opening Finder is unhelpful — most of the time they want to assign it. Show a small menu with the four options.

- [ ] **Step 1: Add `installSpecLinkInterceptor` to `spec-link-menu.ts`**

Append to `ui/src/aom/spec-link-menu.ts`:

```typescript
export interface SpecLinkMenuHost {
  getActiveTabId(): string | null;
  listTabsForRepo(repoRoot: string | null): { id: string; label: string; cwd: string; hasMission: boolean }[];
  setMissionForTab(tabId: string, path: string): Promise<void>;
  openSpec(path: string): Promise<void>;
  revealInFinder(path: string): Promise<void>;
}

export function installSpecLinkInterceptor(host: SpecLinkMenuHost): () => void {
  const handler = (e: MouseEvent) => {
    if (!(e.metaKey || e.ctrlKey)) return;
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const link = target.closest<HTMLElement>("[data-path], a[href^='file://'], a[data-spec-path]");
    if (!link) return;
    const path =
      link.dataset.specPath ??
      link.dataset.path ??
      decodeURIComponent((link.getAttribute("href") ?? "").replace(/^file:\/\//, ""));
    if (!path || !isSpecPath(path)) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(e.clientX, e.clientY, path, host);
  };
  document.addEventListener("click", handler, true);
  return () => document.removeEventListener("click", handler, true);
}

function showMenu(x: number, y: number, path: string, host: SpecLinkMenuHost) {
  const existing = document.querySelector(".spec-link-menu");
  existing?.remove();
  const menu = document.createElement("div");
  menu.className = "spec-link-menu";
  menu.innerHTML = `
    <button type="button" data-act="open">Abrir spec</button>
    <button type="button" data-act="assign-active">Asignar a esta sesión</button>
    <button type="button" data-act="assign-other">Asignar a otra sesión…</button>
    <button type="button" data-act="reveal">Revelar en Finder</button>
  `;
  menu.style.position = "fixed";
  menu.style.top = `${y}px`;
  menu.style.left = `${x}px`;
  document.body.appendChild(menu);

  const close = () => {
    menu.remove();
    document.removeEventListener("click", outside, true);
  };
  const outside = (ev: MouseEvent) => {
    if (!menu.contains(ev.target as Node)) close();
  };
  setTimeout(() => document.addEventListener("click", outside, true), 0);

  menu.addEventListener("click", async (ev) => {
    const btn = (ev.target as HTMLElement).closest("button");
    if (!btn) return;
    const act = btn.dataset.act;
    close();
    if (act === "open") await host.openSpec(path);
    else if (act === "reveal") await host.revealInFinder(path);
    else if (act === "assign-active") {
      const id = host.getActiveTabId();
      if (id) await host.setMissionForTab(id, path);
    }
    else if (act === "assign-other") {
      const repoRoot = inferRepoRoot(path);
      const tabs = host.listTabsForRepo(repoRoot);
      const picked = await pickTab(tabs);
      if (picked) await host.setMissionForTab(picked, path);
    }
  });
}

function inferRepoRoot(path: string): string | null {
  const m = /^(.*)\/docs\/specs\//.exec(path);
  return m ? m[1] : null;
}

async function pickTab(
  tabs: { id: string; label: string; cwd: string; hasMission: boolean }[],
): Promise<string | null> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "spec-link-modal-overlay";
    overlay.innerHTML = `
      <div class="spec-link-modal">
        <div class="spec-link-modal-title">Asignar a otra sesión</div>
        <div class="spec-link-modal-body">
          ${tabs.length === 0
            ? `<div class="spec-link-modal-empty">No hay otras sesiones elegibles.</div>`
            : tabs.map((t) => `
              <button type="button" class="spec-link-modal-tab" data-id="${t.id}">
                <div class="spec-link-modal-tab-label">${escapeHtml(t.label)}${t.hasMission ? " (tiene misión)" : ""}</div>
                <div class="spec-link-modal-tab-cwd">${escapeHtml(t.cwd)}</div>
              </button>`).join("")}
        </div>
        <div class="spec-link-modal-actions">
          <button type="button" class="spec-link-modal-cancel">Cancelar</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    const cleanup = (val: string | null) => { overlay.remove(); resolve(val); };
    overlay.querySelector(".spec-link-modal-cancel")!.addEventListener("click", () => cleanup(null));
    overlay.querySelectorAll<HTMLElement>(".spec-link-modal-tab").forEach((b) => {
      b.addEventListener("click", () => cleanup(b.dataset.id ?? null));
    });
  });
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Add CSS for menu and modal**

In `ui/src/styles.css`:

```css
.spec-link-menu {
  z-index: 10000;
  background: var(--bg-overlay, #1a1a1a);
  border: 1px solid var(--border, #333);
  border-radius: 6px;
  padding: 4px;
  min-width: 200px;
  display: flex; flex-direction: column;
  box-shadow: 0 4px 12px rgba(0,0,0,0.4);
}
.spec-link-menu button {
  background: transparent; border: none; color: inherit;
  text-align: left; padding: 6px 10px; font-size: 12px; cursor: pointer; border-radius: 3px;
}
.spec-link-menu button:hover { background: var(--bg-hover, #2a2a2a); }

.spec-link-modal-overlay {
  position: fixed; inset: 0; background: rgba(0,0,0,0.5);
  display: flex; align-items: center; justify-content: center; z-index: 10001;
}
.spec-link-modal {
  background: var(--bg-overlay, #1a1a1a); border: 1px solid var(--border, #333);
  border-radius: 8px; padding: 16px; min-width: 360px; max-width: 480px;
}
.spec-link-modal-title { font-weight: 600; margin-bottom: 12px; }
.spec-link-modal-body { max-height: 300px; overflow-y: auto; display: flex; flex-direction: column; gap: 4px; }
.spec-link-modal-tab {
  text-align: left; padding: 8px; background: transparent; border: 1px solid var(--border, #333);
  border-radius: 4px; cursor: pointer; color: inherit;
}
.spec-link-modal-tab:hover { background: var(--bg-hover, #2a2a2a); }
.spec-link-modal-tab-label { font-size: 12px; }
.spec-link-modal-tab-cwd { font-size: 10px; color: var(--text-muted, #888); margin-top: 2px; }
.spec-link-modal-empty { color: var(--text-muted, #888); padding: 12px; text-align: center; }
.spec-link-modal-actions { margin-top: 12px; display: flex; justify-content: flex-end; }
.spec-link-modal-cancel {
  background: transparent; border: 1px solid var(--border, #444); color: inherit;
  padding: 4px 12px; border-radius: 4px; cursor: pointer;
}
```

- [ ] **Step 3: Wire interceptor in `main.ts`**

In `ui/src/main.ts`, after the `startSpecPrompts` call, add:

```typescript
import { installSpecLinkInterceptor } from "./aom/spec-link-menu";
import { revealItemInDir, openPath } from "@tauri-apps/plugin-opener"; // adjust to actual import already used in repo
// ...

installSpecLinkInterceptor({
  getActiveTabId: () => manager.getActiveTabId(),
  listTabsForRepo: (repoRoot) => {
    const tabs = manager.listTabSnapshots();
    return tabs
      .filter((t) => !repoRoot || t.cwd.startsWith(repoRoot))
      .map((t) => ({
        id: t.id,
        label: manager.getTabLabel(t.id),
        cwd: t.cwd,
        hasMission: t.hasMission,
      }));
  },
  setMissionForTab: (tabId, path) => manager.setMissionPathForTab(tabId, path),
  openSpec: (path) => openPath(path),
  revealInFinder: (path) => revealItemInDir(path),
});
```

Before adopting the Tauri import line above, grep `ui/src/main.ts` and `ui/src/api.ts` for the existing way the app reveals files in Finder / opens markdown. Reuse that import — do NOT add a new dependency.

- [ ] **Step 4: Typecheck and run all tests**

Run: `cd ui && npx tsc --noEmit && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/aom/spec-link-menu.ts ui/src/main.ts ui/src/styles.css
git commit -m "feat(spec-link): cmd+click contextual menu for docs/specs/**/*.md"
```

---

## Task 7: Manual verification

**Files:** none (runtime check).

**Why:** The acceptance criteria in `docs/specs/3.17-spec-pending-recovery.md` include UI behaviors that unit tests can't cover (visual badge in tab header, popover positioning, contextual menu position). Per CLAUDE.md, UI changes require a real run.

- [ ] **Step 1: Build & launch**

Run: `cd ui && npm run dev` (in one terminal) and `cargo tauri dev` (in another), or whatever the existing run script is — check `package.json` and `README.md`.

- [ ] **Step 2: Verify single-toast bug fix**

  1. Open 3 tabs in the same repo, all with operator assigned, none with mission.
  2. Activate tab 2.
  3. Create a new spec under `docs/specs/9.99-test.md`.
  4. **Expect:** exactly one toast appears, labeled `→ <tab 2 name>`.
  5. Click `Set as mission`. Confirm tab 2 (and only tab 2) receives the mission.

- [ ] **Step 3: Verify badge persistence**

  1. Repeat the spec creation. Toast appears on active tab.
  2. **Without clicking Set or Dismiss**, switch to a different non-eligible tab and wait >30s.
  3. Switch back. **Expect:** badge `📎` visible on each eligible tab.
  4. Click the badge → popover shows the spec.
  5. Click `Asignar`. Mission set; badge disappears.

- [ ] **Step 4: Verify cmd+click contextual menu**

  1. Have the agent print a path like `docs/specs/9.99-test.md` in its output.
  2. Cmd+click the path.
  3. **Expect:** menu with `Abrir / Asignar a esta sesión / Asignar a otra sesión / Revelar en Finder`.
  4. Test each option. `Asignar a otra sesión` opens the tab picker modal.

- [ ] **Step 5: Verify exclusions**

  1. Cmd+click `docs/specs/_template.md` and `docs/specs/drafts/foo.md` paths in agent output.
  2. **Expect:** default cmd+click behavior (no menu).

- [ ] **Step 6: Commit verification notes**

If any deviation from acceptance is found, file a follow-up entry in the spec's "AOM run notes" section and either fix or escalate before declaring done. If clean:

```bash
# no code changes — annotate AOM run notes only
```

Edit `docs/specs/3.17-spec-pending-recovery.md` "AOM run notes" to record completion date and branch.

```bash
git add docs/specs/3.17-spec-pending-recovery.md
git commit -m "docs(3.17): record AOM run notes after manual verification"
```

---

## Self-Review Checklist

Run after the plan is written, fix issues inline:

- ✅ **Spec coverage:**
  - Bug fix (toast tab-equivocada) → Task 2
  - Badge mount + reactive count → Task 4
  - Badge popover (Asignar/Abrir/Descartar) → Task 5
  - `isSpecPath` matcher → Task 3
  - Cmd+click contextual menu → Task 6
  - Tab picker modal → Task 6
  - Filter `_template.md` / `drafts/` → Task 3
  - Manual UI verification → Task 7

- ✅ **No placeholders:** every step has runnable commands or concrete code.

- ✅ **Type consistency:** `SpecPromptHost` extended once (Task 2) and consumed in `main.ts` (Task 2). `SpecBadgeHost` introduced in Task 5 and used identically in Task 5's TabManager wiring. `SpecLinkMenuHost` introduced in Task 6.

- ⚠️ **Uncertainty acknowledged:** `tab.name` field name in `manager.ts` (Task 2 Step 5) and the existing Tauri opener import (Task 6 Step 3) need to be confirmed by grepping during execution. Plan flags both with explicit grep instructions instead of guessing.
