# Familiar Panel Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the full-screen Familiar roster overlay with a per-workspace right-side panel that re-binds to the active tab's Familiar.

**Architecture:** Add `<aside id="familiar-panel">` as a second grid column of `#layout`. A new `FamiliarPanel` class owns header + tab strip + body and delegates content to the existing `ChatPanel`, `SnapshotPanel`, `AuditLog`. TabManager exposes a new `onActiveSessionChange` callback so the panel re-binds when tabs are switched. Open state, active sub-tab, and resize hooks are wired through localStorage and a synthetic `resize` event.

**Tech Stack:** TypeScript, vanilla DOM, Vite, vitest, xterm.js (only consumed indirectly via the resize hook).

**Spec:** `docs/superpowers/specs/2026-05-15-familiar-panel-redesign-design.md`

---

## File Structure

**Create:**
- `ui/src/familiars/panel.ts` — `FamiliarPanel` class (replaces `Roster`).
- `ui/src/familiars/panel.test.ts` — unit tests.

**Modify:**
- `ui/src/tabs/manager.ts` — add `onActiveSessionChange` callback, fire alongside `onActiveTabChange`.
- `ui/index.html` — add `<aside id="familiar-panel">`, remove `<div id="familiars-roster">`.
- `ui/src/styles.css` — add `.familiar-panel*` rules, layout grid changes; remove `.roster*`, `.familiar-row*`, `.familiar-list-empty`, `.familiar-name`, `.familiar-session` (keep `.familiar-dot` — shared by status indicator).
- `ui/src/main.ts` — instantiate `FamiliarPanel` instead of `Roster`; subscribe to `onActiveSessionChange`; convert `familiars:open` handler to toggle.

**Delete:**
- `ui/src/familiars/roster.ts`
- `ui/src/familiars/list.ts`

---

### Task 1: Expose active session changes from TabManager

**Files:**
- Modify: `ui/src/tabs/manager.ts` (callback declaration near line 495; firing sites near lines 1098 and 1102)

- [ ] **Step 1: Add the callback property next to `onActiveTabChange`**

In `ui/src/tabs/manager.ts`, immediately after the `onActiveTabChange` declaration (around line 502), add:

```ts
  /// Fires whenever the active tab changes (including when the active tab
  /// closes and there is no replacement). Receives the new active tab's
  /// sessionId, or null when no tab is active. Used by FamiliarPanel to
  /// re-bind its chat/status/audit to the per-tab Familiar.
  public onActiveSessionChange:
    | ((sessionId: SessionId | null) => void)
    | null = null;
```

- [ ] **Step 2: Fire the callback at both `onActiveTabChange` sites**

In `ui/src/tabs/manager.ts`, find the two existing firing sites near lines 1098 and 1102:

```ts
      this.onActiveTabChange?.(null);
```

and

```ts
    this.onActiveTabChange?.({
      ...
    });
```

Right after each, add:

```ts
    this.onActiveSessionChange?.(tab?.sessionId ?? null);
```

(For the `null` branch — where there is no active tab — pass `null` explicitly: `this.onActiveSessionChange?.(null);`.)

- [ ] **Step 3: Build to confirm types compile**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(tabs): emit onActiveSessionChange for FamiliarPanel binding"
```

---

### Task 2: FamiliarPanel — failing test for empty mount

**Files:**
- Create: `ui/src/familiars/panel.test.ts`
- Create: `ui/src/familiars/panel.ts` (stub only in this task)

- [ ] **Step 1: Write the failing test**

Create `ui/src/familiars/panel.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { FamiliarPanel } from "./panel";

// Module-level mock so all tests share the same vi.fn instances.
vi.mock("./api", () => ({
  Familiars: {
    list: vi.fn().mockResolvedValue([]),
    snapshot: vi.fn().mockResolvedValue({
      rolling_summary: "",
      last_event_ms: 0,
      recent_missions: [],
      spend_today_usd: 0,
      frozen: false,
    }),
    audit: vi.fn().mockResolvedValue([]),
    hasRecentClosedMission: vi.fn().mockResolvedValue(false),
  },
}));

function mountHost(): HTMLElement {
  document.body.innerHTML = `<aside id="familiar-panel" class="hidden"></aside>`;
  return document.getElementById("familiar-panel")!;
}

describe("FamiliarPanel", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("mounts header, tabs and body inside #familiar-panel", () => {
    mountHost();
    new FamiliarPanel();
    const host = document.getElementById("familiar-panel")!;
    expect(host.querySelector(".familiar-panel__header")).not.toBeNull();
    expect(host.querySelectorAll(".familiar-panel__tab").length).toBe(3);
    expect(host.querySelector(".familiar-panel__body")).not.toBeNull();
  });
});
```

- [ ] **Step 2: Create a stub `panel.ts` so the import resolves but the test still fails**

Create `ui/src/familiars/panel.ts`:

```ts
export class FamiliarPanel {
  constructor() {
    // intentionally empty — fails the first test
  }
}
```

- [ ] **Step 3: Run the test and verify it fails**

Run: `cd ui && npx vitest run src/familiars/panel.test.ts`
Expected: 1 failed — "expected null not to be null" (header missing).

- [ ] **Step 4: Implement the minimal panel that passes the test**

Replace `ui/src/familiars/panel.ts` with:

```ts
import { ChatPanel } from "./chat";
import { SnapshotPanel } from "./snapshot";
import { AuditLog } from "./audit_log";
import { Familiars, type FamiliarSummary } from "./api";

type SubTab = "chat" | "status" | "audit";

const LS_OPEN = "familiar-panel-open";
const LS_TAB = "familiar-panel-tab";

export class FamiliarPanel {
  private root: HTMLElement;
  private header: HTMLElement;
  private title: HTMLElement;
  private tabs: Record<SubTab, HTMLButtonElement>;
  private bodies: Record<SubTab, HTMLElement>;
  private empty: HTMLElement;
  private chat: ChatPanel;
  private snap: SnapshotPanel;
  private audit: AuditLog;
  private currentFamiliarId: string | null = null;
  private active: SubTab;

  /** Host hook: deliver an approved directive into the operator session. */
  onDeliverDirective: (sessionId: string, rendered: string) => Promise<void> =
    async () => {};

  constructor() {
    this.root = document.getElementById("familiar-panel")!;
    this.root.classList.add("familiar-panel");

    this.root.innerHTML = `
      <div class="familiar-panel__header">
        <span class="familiar-panel__title">Familiar</span>
        <button class="familiar-panel__close" aria-label="Close">✕</button>
      </div>
      <div class="familiar-panel__tabs" role="tablist">
        <button class="familiar-panel__tab" data-tab="chat">Chat</button>
        <button class="familiar-panel__tab" data-tab="status">Status</button>
        <button class="familiar-panel__tab" data-tab="audit">Audit</button>
      </div>
      <div class="familiar-panel__body">
        <div class="familiar-panel__view" data-view="chat"></div>
        <div class="familiar-panel__view" data-view="status" hidden></div>
        <div class="familiar-panel__view" data-view="audit" hidden></div>
        <div class="familiar-panel__empty" hidden>
          No Familiar for this tab. Open Settings → Familiars to create one.
        </div>
      </div>`;

    this.header = this.root.querySelector(".familiar-panel__header")!;
    this.title = this.root.querySelector(".familiar-panel__title")!;
    this.empty = this.root.querySelector(".familiar-panel__empty")!;

    this.tabs = {
      chat: this.root.querySelector('[data-tab="chat"]')!,
      status: this.root.querySelector('[data-tab="status"]')!,
      audit: this.root.querySelector('[data-tab="audit"]')!,
    };
    this.bodies = {
      chat: this.root.querySelector('[data-view="chat"]')!,
      status: this.root.querySelector('[data-view="status"]')!,
      audit: this.root.querySelector('[data-view="audit"]')!,
    };

    this.chat = new ChatPanel(this.bodies.chat);
    this.snap = new SnapshotPanel(this.bodies.status);
    this.audit = new AuditLog(this.bodies.audit);

    this.chat.onApprovedDirective = async (familiarId, rendered) => {
      const list = await Familiars.list();
      const f = list.find((x) => x.id === familiarId);
      if (f) await this.onDeliverDirective(f.session_id, rendered);
    };

    (this.root.querySelector(".familiar-panel__close") as HTMLButtonElement)
      .addEventListener("click", () => this.hide());

    for (const t of ["chat", "status", "audit"] as SubTab[]) {
      this.tabs[t].addEventListener("click", () => this.selectTab(t));
    }

    this.active = (localStorage.getItem(LS_TAB) as SubTab | null) ?? "chat";
    this.selectTab(this.active);

    const wasOpen = localStorage.getItem(LS_OPEN) === "true";
    if (wasOpen) this.show();
    else this.hide();
  }

  show() {
    this.root.classList.remove("hidden");
    document.body.classList.add("familiar-panel-open");
    localStorage.setItem(LS_OPEN, "true");
    window.dispatchEvent(new Event("resize"));
  }

  hide() {
    this.root.classList.add("hidden");
    document.body.classList.remove("familiar-panel-open");
    localStorage.setItem(LS_OPEN, "false");
    window.dispatchEvent(new Event("resize"));
  }

  toggle() {
    if (this.root.classList.contains("hidden")) this.show();
    else this.hide();
  }

  private selectTab(t: SubTab) {
    this.active = t;
    localStorage.setItem(LS_TAB, t);
    for (const k of ["chat", "status", "audit"] as SubTab[]) {
      this.tabs[k].classList.toggle("familiar-panel__tab--active", k === t);
      this.bodies[k].hidden = k !== t;
    }
  }

  async bindToSession(sessionId: string | null): Promise<void> {
    if (!sessionId) {
      this.setFamiliar(null, null);
      return;
    }
    let list: FamiliarSummary[] = [];
    try {
      list = await Familiars.list();
    } catch {
      list = [];
    }
    const f = list.find((x) => x.session_id === sessionId) ?? null;
    this.setFamiliar(f?.id ?? null, f?.name ?? null);
  }

  private setFamiliar(id: string | null, name: string | null) {
    this.currentFamiliarId = id;
    this.title.textContent = id ? (name ?? "Familiar") : "Familiar";
    const hasFamiliar = id !== null;
    for (const k of ["chat", "status", "audit"] as SubTab[]) {
      this.tabs[k].disabled = !hasFamiliar;
    }
    this.empty.hidden = hasFamiliar;
    this.bodies[this.active].hidden = !hasFamiliar;
    this.chat.setFamiliar(id);
    this.snap.setFamiliar(id);
    this.audit.setFamiliar(id);
  }
}
```

- [ ] **Step 5: Run the test and verify it passes**

Run: `cd ui && npx vitest run src/familiars/panel.test.ts`
Expected: 1 passed.

- [ ] **Step 6: Commit**

```bash
git add ui/src/familiars/panel.ts ui/src/familiars/panel.test.ts
git commit -m "feat(familiars): FamiliarPanel skeleton with header, tabs and body"
```

---

### Task 3: Test toggle + localStorage persistence

**Files:**
- Modify: `ui/src/familiars/panel.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `ui/src/familiars/panel.test.ts`:

```ts
describe("FamiliarPanel — toggle and persistence", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
  });

  it("starts hidden by default and toggle() shows then hides", () => {
    mountHost();
    const p = new FamiliarPanel();
    const host = document.getElementById("familiar-panel")!;
    expect(host.classList.contains("hidden")).toBe(true);

    p.toggle();
    expect(host.classList.contains("hidden")).toBe(false);
    expect(document.body.classList.contains("familiar-panel-open")).toBe(true);
    expect(localStorage.getItem("familiar-panel-open")).toBe("true");

    p.toggle();
    expect(host.classList.contains("hidden")).toBe(true);
    expect(document.body.classList.contains("familiar-panel-open")).toBe(false);
    expect(localStorage.getItem("familiar-panel-open")).toBe("false");
  });

  it("restores open state from localStorage", () => {
    mountHost();
    localStorage.setItem("familiar-panel-open", "true");
    new FamiliarPanel();
    const host = document.getElementById("familiar-panel")!;
    expect(host.classList.contains("hidden")).toBe(false);
  });

  it("persists the active sub-tab and restores it", () => {
    mountHost();
    const p = new FamiliarPanel();
    // Cast to access private via bracket — vitest runs against TS source.
    (p as unknown as { selectTab: (t: "chat" | "status" | "audit") => void })
      .selectTab("audit");
    expect(localStorage.getItem("familiar-panel-tab")).toBe("audit");

    document.body.innerHTML = "";
    mountHost();
    new FamiliarPanel();
    const host = document.getElementById("familiar-panel")!;
    const auditTab = host.querySelector('[data-tab="audit"]') as HTMLElement;
    expect(auditTab.classList.contains("familiar-panel__tab--active")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests and verify they pass**

Run: `cd ui && npx vitest run src/familiars/panel.test.ts`
Expected: 4 passed (the existing mount test plus three new ones).

The implementation from Task 2 already covers these. If any fail, fix `panel.ts` before continuing.

- [ ] **Step 3: Commit**

```bash
git add ui/src/familiars/panel.test.ts
git commit -m "test(familiars): cover toggle and localStorage persistence"
```

---

### Task 4: Test bindToSession for found / missing / null

**Files:**
- Modify: `ui/src/familiars/panel.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `ui/src/familiars/panel.test.ts`:

```ts
import { Familiars } from "./api";

describe("FamiliarPanel — bindToSession", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = "";
    vi.mocked(Familiars.list).mockReset();
    vi.mocked(Familiars.list).mockResolvedValue([]);
  });

  it("shows empty state when no Familiar matches the session", async () => {
    mountHost();
    const p = new FamiliarPanel();
    vi.mocked(Familiars.list).mockResolvedValueOnce([]);
    await p.bindToSession("session-xyz");
    const host = document.getElementById("familiar-panel")!;
    const empty = host.querySelector(".familiar-panel__empty") as HTMLElement;
    expect(empty.hidden).toBe(false);
    expect(host.querySelector(".familiar-panel__title")!.textContent).toBe("Familiar");
  });

  it("sets header and enables tabs when a Familiar exists", async () => {
    mountHost();
    const p = new FamiliarPanel();
    vi.mocked(Familiars.list).mockResolvedValueOnce([{
      id: "fam-1",
      session_id: "session-xyz",
      name: "Vex",
      style: "conversational",
      daily_cap_usd: 5,
    }]);
    await p.bindToSession("session-xyz");
    const host = document.getElementById("familiar-panel")!;
    expect(host.querySelector(".familiar-panel__title")!.textContent).toBe("Vex");
    const empty = host.querySelector(".familiar-panel__empty") as HTMLElement;
    expect(empty.hidden).toBe(true);
    const chatTab = host.querySelector('[data-tab="chat"]') as HTMLButtonElement;
    expect(chatTab.disabled).toBe(false);
  });

  it("shows empty state when sessionId is null", async () => {
    mountHost();
    const p = new FamiliarPanel();
    await p.bindToSession(null);
    const host = document.getElementById("familiar-panel")!;
    const empty = host.querySelector(".familiar-panel__empty") as HTMLElement;
    expect(empty.hidden).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests and verify they pass**

Run: `cd ui && npx vitest run src/familiars/panel.test.ts`
Expected: all tests pass (7 total).

- [ ] **Step 3: Commit**

```bash
git add ui/src/familiars/panel.test.ts
git commit -m "test(familiars): bindToSession found / missing / null cases"
```

---

### Task 5: HTML + CSS — mount the panel into the layout

**Files:**
- Modify: `ui/index.html` (line 81)
- Modify: `ui/src/styles.css` (around `#layout` at line 131 and new section near old roster CSS at line 9394)

- [ ] **Step 1: Replace the roster div with the panel aside in index.html**

In `ui/index.html`, replace line 81:

```html
    <div id="familiars-roster" class="hidden"></div>
```

with:

```html
    <aside id="familiar-panel" class="familiar-panel hidden"></aside>
```

Move the `<aside>` so it is a child of `#layout` (sibling of `<main>`), not outside of it. After this change the structure inside `<body>` should be:

```html
<div id="layout">
  ...
  <main>...</main>
  <aside id="familiar-panel" class="familiar-panel hidden"></aside>
</div>
```

If `#layout` does not currently wrap `<main>`, check the file — keep whatever wrapper already exists and place the `<aside>` next to `<main>`. The panel must be a sibling of `<main>` inside the same grid container so the CSS grid placement works.

- [ ] **Step 2: Update `#layout` grid in styles.css**

In `ui/src/styles.css`, replace the `#layout` block at line 131:

```css
#layout {
    display: grid;
    grid-template-rows: 38px 1fr auto;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
    width: 100%;
}

body.familiar-panel-open #layout {
    grid-template-columns: minmax(0, 1fr) 380px;
}

#familiar-panel {
    grid-row: 1 / 4;
    grid-column: 2;
    min-height: 0;
}
body:not(.familiar-panel-open) #familiar-panel {
    display: none;
}
```

- [ ] **Step 3: Add panel component styles**

Append to `ui/src/styles.css` (anywhere after the existing familiar styles):

```css
.familiar-panel {
    display: flex;
    flex-direction: column;
    background: var(--bg-elevated, #16181d);
    border-left: 1px solid var(--border, #2a2a2f);
    color: #e5e7eb;
    font: 13px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    overflow: hidden;
}
.familiar-panel.hidden { display: none; }

.familiar-panel__header {
    display: flex;
    align-items: center;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border, #2a2a2f);
}
.familiar-panel__title { flex: 1; font-weight: 600; }
.familiar-panel__close {
    background: transparent; border: none; color: #9ca3af;
    cursor: pointer; font-size: 14px; padding: 2px 6px;
}

.familiar-panel__tabs {
    display: flex; gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border, #2a2a2f);
}
.familiar-panel__tab {
    background: transparent; border: 1px solid transparent;
    color: #9ca3af; padding: 4px 10px; border-radius: 4px;
    cursor: pointer; font-size: 12px;
}
.familiar-panel__tab:hover:not(:disabled) { background: #1a2230; color: #e5e7eb; }
.familiar-panel__tab:disabled { opacity: 0.4; cursor: default; }
.familiar-panel__tab--active {
    background: #1f2937; color: #fff; border-color: #374151;
}

.familiar-panel__body {
    flex: 1; min-height: 0;
    padding: 10px 12px;
    position: relative;
    overflow: hidden;
}
.familiar-panel__view {
    height: 100%;
    overflow: auto;
}
.familiar-panel__view[hidden] { display: none; }

.familiar-panel__empty {
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    text-align: center; padding: 24px;
    color: #6b7280;
}
.familiar-panel__empty[hidden] { display: none; }
```

- [ ] **Step 4: Build and verify**

Run: `cd ui && npx tsc --noEmit && npm run build`
Expected: success.

- [ ] **Step 5: Commit**

```bash
git add ui/index.html ui/src/styles.css
git commit -m "feat(familiars): mount #familiar-panel aside into #layout grid"
```

---

### Task 6: Wire FamiliarPanel into main.ts

**Files:**
- Modify: `ui/src/main.ts` (lines 1158–1169 and the section where `manager.onActiveTabChange` is wired around line 375)

- [ ] **Step 1: Replace the Roster instantiation and event wiring**

In `ui/src/main.ts`, find this block (around lines 1158–1169):

```ts
const roster = new Roster();
roster.onDeliverDirective = async (sessionId, rendered) => {
  const bytes = new TextEncoder().encode(rendered);
  await invoke("write_to_session", { id: sessionId, data: Array.from(bytes) });
};

document.addEventListener("familiars:open", () => roster.show());
```

Replace with:

```ts
const familiarPanel = new FamiliarPanel();
familiarPanel.onDeliverDirective = async (sessionId, rendered) => {
  const bytes = new TextEncoder().encode(rendered);
  await invoke("write_to_session", { id: sessionId, data: Array.from(bytes) });
};

document.addEventListener("familiars:open", () => familiarPanel.toggle());
```

- [ ] **Step 2: Update the import**

At the top of `ui/src/main.ts`, find the existing import of `Roster` and replace it:

Before:

```ts
import { Roster } from "./familiars/roster";
```

After:

```ts
import { FamiliarPanel } from "./familiars/panel";
```

- [ ] **Step 3: Subscribe to active session changes**

Find the section where other `manager.onActive*` callbacks are wired (search for `manager.onActiveTabChange =`). Immediately after the existing `onActiveTabChange` wiring, add:

```ts
manager.onActiveSessionChange = (sessionId) => {
  void familiarPanel.bindToSession(sessionId);
};
```

`familiarPanel` is module-scope (declared after this section in the file). The reference is fine because the callback only fires after `manager` starts emitting events, which happens after both `manager` and `familiarPanel` are constructed. If TypeScript objects to use-before-declaration, hoist `let familiarPanel: FamiliarPanel;` near the top of the file and assign in place of `const familiarPanel = ...`.

- [ ] **Step 4: Build and verify types**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Run all tests**

Run: `cd ui && npx vitest run`
Expected: previously-passing tests still pass; panel tests pass.

- [ ] **Step 6: Commit**

```bash
git add ui/src/main.ts
git commit -m "feat(familiars): wire FamiliarPanel into main and active-tab events"
```

---

### Task 7: Delete the old roster + list code

**Files:**
- Delete: `ui/src/familiars/roster.ts`
- Delete: `ui/src/familiars/list.ts`
- Modify: `ui/src/styles.css` (remove old roster rules)

- [ ] **Step 1: Verify there are no remaining references**

Run:

```bash
rg "from \"./familiars/roster\"|from \"./familiars/list\"|new Roster\(|FamiliarList" ui/src
```

Expected: no results outside `roster.ts` and `list.ts` themselves. If results appear, update those files first to use `FamiliarPanel` or remove the reference.

- [ ] **Step 2: Delete the two source files**

```bash
git rm ui/src/familiars/roster.ts ui/src/familiars/list.ts
```

- [ ] **Step 3: Remove the obsolete CSS rules**

In `ui/src/styles.css`, delete the following blocks (line numbers from current file state, will shift as edits land — search by selector):

- `#familiars-roster.roster { ... }`
- `.roster-left, .roster-center, .roster-right { ... }`
- `.roster-left { ... }`
- `.roster-close { ... }`
- `.familiar-list-empty { ... }`
- `.familiar-row { ... }`, `.familiar-row.selected { ... }`, `.familiar-row:hover { ... }`
- `.familiar-name { ... }`
- `.familiar-session { ... }`

Keep `.familiar-dot { ... }` — the status indicator uses it (verify by `rg "familiar-dot" ui/src`).

- [ ] **Step 4: Build and run tests**

Run: `cd ui && npx tsc --noEmit && npm run build && npx vitest run`
Expected: success across the board.

- [ ] **Step 5: Commit**

```bash
git add -A ui/src/familiars ui/src/styles.css
git commit -m "chore(familiars): remove obsolete Roster overlay and FamiliarList"
```

---

### Task 8: Manual smoke test

**Files:** none — runtime verification only.

- [ ] **Step 1: Start the dev app**

Run: `npm run tauri dev` (or the project's standard dev command).

- [ ] **Step 2: Verify each behavior**

- Open a tab that has a Familiar — panel shows correct name and tabs are enabled.
- Press `⌘⇧L` — panel toggles open / closed; layout reflows; no ghost overlay.
- Click the Familiar dot in the status bar — same toggle behavior.
- Switch to a tab without a Familiar — empty state appears; chat input is gone.
- Open the panel, then resize the window — xterm refits and no clipping.
- Click `Chat → Status → Audit` tabs inside the panel — each view shows correct content.
- Reload the app — panel re-opens if it was open, with the previously active sub-tab.
- Approve a directive in a chat — verify it is delivered to the operator session (same path as the old roster).

- [ ] **Step 3: If anything is broken, fix and re-commit. Otherwise stop.**

No commit needed if everything passes — the prior commits already cover the implementation.

---

## Self-Review Summary

Spec coverage:
- Layout / right-side panel — Tasks 5, 6.
- Per-workspace binding — Tasks 1, 4, 6.
- Toggle (`⌘⇧L` + status-bar) — Task 6 (shortcut already maps to `familiars:open`).
- Sub-tabs (Chat / Status / Audit) — Tasks 2, 3.
- Persistence (open + sub-tab) — Tasks 2, 3.
- Resize hook — Task 2 (`window.dispatchEvent` inside show/hide).
- Empty state for missing Familiar / null session — Tasks 2, 4.
- Directive delivery path — Task 2 (constructor wiring) + Task 6 (host hook).
- Roster removal — Task 7.

All steps include the exact code to write. No placeholders.
