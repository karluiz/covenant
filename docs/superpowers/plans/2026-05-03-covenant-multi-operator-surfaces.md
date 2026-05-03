# Covenant Multi-Operator — Plan 3: Tab + Statusbar + Picker + AFK + ESCALATE

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the assigned operator visible and switchable from the user's normal flow: a chip in the statusbar, a chip in each tab, a `⌘⇧O` picker for fast switching, an "Active operators" strip in the AFK overlay, and an `[OperatorName]` prefix on ESCALATE notifications. The operator pin survives app restart via the existing tab manifest JSON.

**Architecture:** All surfaces consume `operator_list` and `session_set_operator` / `session_get_operator` from Plan 1, plus the typed `Operator` shape from Plan 2's `api.ts`. The picker is a new `OperatorPicker` modal modeled after `ui/src/recall/palette.ts`. Per-tab persistence: extend the `Tab` interface in `ui/src/tabs/manager.ts` with `operator_id: string | null` and add it to `serializeManifest` / `applyManifest`. On tab restore (or new-tab default), call `session_set_operator(session_id, operator_id ?? null)` after the PTY is spawned and before AOM attaches.

**Tech Stack:** TypeScript (strict), vanilla DOM, existing tab manifest schema (frontend-owned JSON), existing notification path in `crates/app/src/notify.rs`.

**Depends on:** Plans 1 and 2 merged.

---

## File structure

- **Create**:
  - `ui/src/operator/picker.ts` — `OperatorPicker` modal (≤ 320 lines).
- **Modify**:
  - `ui/src/api.ts` — wrappers for `session_set_operator` / `session_get_operator` (≤ 25 lines added).
  - `ui/src/tabs/manager.ts` — `Tab.operator_id` + manifest plumbing + chip render in `renderTabbar` + replay on restore + setter API. ≤ 90 lines added.
  - `ui/src/status/bar.ts` — operator chip to the left of mission. ≤ 60 lines added.
  - `ui/src/operator/panel.ts` — operator chip per decision row + filter "By operator". ≤ 80 lines added.
  - `ui/src/aom/afk.ts` — "Active operators:" strip in `<header>`. ≤ 60 lines added.
  - `ui/src/main.ts` — register `⌘⇧O` shortcut + instantiate picker + wire callbacks. ≤ 35 lines added.
  - `ui/src/styles.css` — chips + picker styles. ≤ 180 lines added.
  - `crates/app/src/notify.rs` — prefix ESCALATE message with `[{operator_name}]` when one is resolvable. ≤ 25 lines.
- **Do NOT touch**:
  - `crates/app/src/operator_registry.rs` (Plan 1).
  - `ui/src/settings/operators.ts` (Plan 2).

---

## Task 1: API wrappers + Tab schema

**Files:**
- Modify: `ui/src/api.ts`
- Modify: `ui/src/tabs/manager.ts`

- [ ] **Step 1: API wrappers**

Append to `ui/src/api.ts`:

```ts
export async function sessionSetOperator(
  sessionId: SessionId,
  operatorId: string | null,
): Promise<void> {
  return invoke<void>("session_set_operator", {
    sessionId,
    operatorId,
  });
}

export async function sessionGetOperator(sessionId: SessionId): Promise<Operator> {
  return invoke<Operator>("session_get_operator", { sessionId });
}
```

- [ ] **Step 2: Extend `Tab` + manifest**

In `ui/src/tabs/manager.ts`, find the `Tab` interface (around line 87) and the persisted manifest schema (around line 145). Add a nullable `operator_id` field to both:

```ts
// Tab interface
operator_id: string | null;

// Persisted manifest schema (PersistedTab — name may differ; mirror mission_path)
operator_id: string | null;
```

Initialize `operator_id: null` everywhere a `Tab` is constructed (search `customName: null` — same shape, set `operator_id: null` next to it). In `serializeManifest`, include `operator_id`. In `applyManifest`, read it back (default `null` for legacy entries).

- [ ] **Step 3: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add ui/src/api.ts ui/src/tabs/manager.ts
git commit -m "feat(ui/tabs): operator_id on Tab + manifest schema (nullable, legacy-safe)"
```

---

## Task 2: Replay pin on tab spawn / restore

**Files:**
- Modify: `ui/src/tabs/manager.ts`

- [ ] **Step 1: Setter API**

Add a public method on `TabManager`:

```ts
public async setTabOperator(tabId: TabId, operatorId: string | null): Promise<void> {
  const tab = this.tabs.find((t) => t.id === tabId);
  if (!tab) return;
  tab.operator_id = operatorId;
  if (tab.sessionId) {
    await sessionSetOperator(tab.sessionId, operatorId);
  }
  this.persist();        // existing manifest writer
  this.renderTabbar();
  this.onActiveOperatorChanged?.(tab);
}

public onActiveOperatorChanged: ((tab: Tab) => void) | null = null;
```

- [ ] **Step 2: Replay on spawn / restore**

Find the path that spawns a session for a tab (search `spawn_session` invocation, near where `tab.sessionId` is set). Immediately after the session id is assigned, call:

```ts
if (tab.operator_id) {
  await sessionSetOperator(tab.sessionId, tab.operator_id);
}
```

Do this for both code paths: brand-new tabs (operator_id will be null → skipped, backend resolves to default automatically) and restored tabs from the manifest.

- [ ] **Step 3: Forget pin on close**

Find the tab-close handler. Before destroying the tab, call:

```ts
if (tab.sessionId) {
  await sessionSetOperator(tab.sessionId, null).catch(() => {});
}
```

(Backend's `unpin_session` is also called server-side on `close_session`; this is belt-and-suspenders for non-close reassignments.)

- [ ] **Step 4: Type-check + smoke**

Run: `cd ui && npx tsc --noEmit && cargo run -p covenant`. Manual: at this point chips don't render yet, but you can verify the round-trip:

1. Open devtools, run:
   ```js
   const ops = await __TAURI__.invoke('operator_list');
   const sec = ops.find(o => o.name !== 'Default') || ops[0];
   await __TAURI__.invoke('session_set_operator', {
     sessionId: <active session id from logs>,
     operatorId: sec.id,
   });
   await __TAURI__.invoke('session_get_operator', {
     sessionId: <same id>,
   });
   ```
   Expect the second call to return the chosen operator. (After Plan 2, ensure at least one non-Default operator exists.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(ui/tabs): replay session_set_operator on spawn/restore + setTabOperator API"
```

---

## Task 3: Tab strip chip

**Files:**
- Modify: `ui/src/tabs/manager.ts`
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Cache operators in TabManager**

The tab strip needs operator metadata (color, emoji, name) to render chips without an async hop per render. Add to `TabManager`:

```ts
private operatorCache: Map<string, Operator> = new Map();

public async refreshOperatorCache(): Promise<void> {
  const list = await operatorList();
  this.operatorCache = new Map(list.map((o) => [o.id, o]));
  this.renderTabbar();
}
```

Wire `refreshOperatorCache()` to be called once at app boot (from `main.ts`) and after every `setTabOperator` and after the picker triggers a list change. Add a public re-export on `TabManager` so `main.ts` can call it.

- [ ] **Step 2: Render chip in `renderTabbar`**

Inside `renderTabbar`, where each tab's HTML is built (look for the `mission-chip` rendering as a template), add — beside the mission chip — an operator chip:

```ts
const op = tab.operator_id ? this.operatorCache.get(tab.operator_id) : null;
const opChipHtml = op
  ? `<span class="tab-op-chip" style="background:${op.color}"
           title="${escapeHtml(op.name)}">
       ${escapeHtml(initials(op.name))}
     </span>`
  : "";
```

Helper (top of file or in a shared util):

```ts
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase())
    .join("")
    .slice(0, 3);
}
```

Insert `opChipHtml` next to the existing mission chip in the tab's inner template.

- [ ] **Step 3: Styles**

Append to `styles.css`:

```css
.tab-op-chip {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 16px;
  padding: 0 4px;
  margin-left: 4px;
  border-radius: 4px;
  font-size: 9px;
  font-weight: 600;
  color: #fff;
  text-shadow: 0 1px 0 rgba(0,0,0,0.4);
}
```

- [ ] **Step 4: Smoke**

Run app. Pin a tab to a non-default operator via devtools (or via the Settings round-trip from Task 2's smoke), then call `tabManager.refreshOperatorCache()`. The chip should appear.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "feat(ui/tabs): operator chip in tab strip (initials + operator color)"
```

---

## Task 4: Statusbar chip

**Files:**
- Modify: `ui/src/status/bar.ts`
- Modify: `ui/src/tabs/manager.ts` (wire `onActiveOperatorChanged`)
- Modify: `ui/src/main.ts` (initial push + click handler)
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Statusbar API**

In `ui/src/status/bar.ts`, add (mirror the `setMission` pattern at line ~142):

```ts
private currentOperator: Operator | null = null;

setOperator(op: Operator | null): void {
  this.currentOperator = op;
  this.render(this.lastDirCtx);
}

public onOperatorChipClick: ((sessionId: SessionId) => void) | null = null;
```

In `render(...)`, prepend the operator chip to the chip group (left of mission):

```ts
const opHtml = this.currentOperator
  ? `<button class="status-chip status-chip-operator"
             style="background:${this.currentOperator.color}">
       ${escapeHtml(this.currentOperator.emoji)}
       <span>${escapeHtml(this.currentOperator.name)}</span>
     </button>`
  : "";
```

After mounting the rendered HTML, hook the click:

```ts
this.root.querySelector<HTMLButtonElement>(".status-chip-operator")
  ?.addEventListener("click", () => {
    if (this.activeSessionId) this.onOperatorChipClick?.(this.activeSessionId);
  });
```

(`activeSessionId` already tracked by the bar; otherwise route via TabManager.)

- [ ] **Step 2: Push from TabManager**

In `TabManager.activate(...)` (search for `setMission` calls — same code path), add:

```ts
const op = tab.operator_id ? this.operatorCache.get(tab.operator_id) ?? null : null;
this.onActiveOperatorChanged?.(tab);   // existing hook from Task 2
this.statusBar?.setOperator(op);       // direct push (or via callback owner)
```

Pattern of choice: keep it consistent with how mission is pushed today.

- [ ] **Step 3: Wire click → picker (deferred to Task 5)**

In `main.ts`:

```ts
statusBar.onOperatorChipClick = (sessionId) => operatorPicker.open(sessionId);
```

(`operatorPicker` is created in Task 5.)

- [ ] **Step 4: Styles**

```css
.status-chip-operator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border-radius: 6px;
  border: none;
  color: #fff;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.status-chip-operator:hover { filter: brightness(1.1); }
```

- [ ] **Step 5: Smoke + commit**

Open app — Default chip appears in statusbar. Switch tabs after assigning different operators — chip updates.

```bash
git add ui/src/status/bar.ts ui/src/tabs/manager.ts ui/src/main.ts ui/src/styles.css
git commit -m "feat(ui/status): operator chip with click-to-picker hook"
```

---

## Task 5: Operator picker (`⌘⇧O`)

**Files:**
- Create: `ui/src/operator/picker.ts`
- Modify: `ui/src/main.ts`
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Picker module**

Model on `ui/src/recall/palette.ts`. Skeleton:

```ts
import {
  Operator,
  operatorList,
  sessionSetOperator,
} from "../api";
import type { SessionId } from "../api";

export class OperatorPicker {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private preview: HTMLElement;
  private operators: Operator[] = [];
  private filtered: Operator[] = [];
  private highlighted = 0;
  private targetSessionId: SessionId | null = null;
  private isOpen = false;

  public onAssigned: ((sessionId: SessionId, op: Operator) => void) | null = null;
  public onNewRequested: (() => void) | null = null;
  public onEditRequested: ((op: Operator) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "operator-picker";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="operator-picker__backdrop" data-role="backdrop"></div>
      <div class="operator-picker__modal">
        <input class="operator-picker__input" type="text" placeholder="Switch operator…" />
        <div class="operator-picker__layout">
          <ul class="operator-picker__list" data-role="list"></ul>
          <div class="operator-picker__preview" data-role="preview"></div>
        </div>
        <footer class="operator-picker__hint">
          ↵ assign · n new · e edit · Esc close
        </footer>
      </div>`;
    parent.appendChild(this.root);
    this.input = this.root.querySelector("input")!;
    this.list = this.root.querySelector('[data-role="list"]')!;
    this.preview = this.root.querySelector('[data-role="preview"]')!;

    this.input.addEventListener("input", () => this.applyFilter());
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.root.querySelector('[data-role="backdrop"]')!
      .addEventListener("click", () => this.close());
  }

  async open(sessionId: SessionId): Promise<void> {
    this.targetSessionId = sessionId;
    this.operators = await operatorList();
    this.filtered = this.operators;
    this.highlighted = 0;
    this.input.value = "";
    this.root.hidden = false;
    this.isOpen = true;
    this.input.focus();
    this.render();
  }

  close(): void {
    this.root.hidden = true;
    this.isOpen = false;
    this.targetSessionId = null;
  }

  private applyFilter(): void {
    const q = this.input.value.trim().toLowerCase();
    this.filtered = q.length === 0
      ? this.operators
      : this.operators.filter((o) =>
          o.name.toLowerCase().includes(q) ||
          o.tags.some((t) => t.toLowerCase().includes(q)),
        );
    this.highlighted = 0;
    this.render();
  }

  private render(): void {
    this.list.innerHTML = this.filtered
      .map((o, i) => `
        <li class="${i === this.highlighted ? "is-highlighted" : ""}"
            data-id="${o.id}">
          <span class="emoji" style="background:${o.color}">${escapeHtml(o.emoji)}</span>
          <span class="name">${escapeHtml(o.name)}</span>
          ${o.is_default ? '<span class="star">⭐</span>' : ""}
        </li>`)
      .join("");
    this.list.querySelectorAll<HTMLElement>("li").forEach((li, i) => {
      li.addEventListener("click", () => {
        this.highlighted = i;
        this.assignHighlighted();
      });
    });
    const sel = this.filtered[this.highlighted];
    this.preview.innerHTML = sel
      ? `
        <h4>${escapeHtml(sel.emoji)} ${escapeHtml(sel.name)}</h4>
        <p class="muted">${sel.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ")}</p>
        <dl>
          <dt>Threshold</dt><dd>${sel.escalate_threshold.toFixed(2)}</dd>
          <dt>Model</dt><dd>${escapeHtml(sel.model)}</dd>
        </dl>
        <pre class="persona">${escapeHtml(sel.persona.slice(0, 600))}${sel.persona.length > 600 ? "…" : ""}</pre>`
      : `<p class="muted">No matches.</p>`;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    switch (e.key) {
      case "Escape": e.preventDefault(); this.close(); break;
      case "ArrowDown":
        e.preventDefault();
        this.highlighted = Math.min(this.highlighted + 1, this.filtered.length - 1);
        this.render();
        break;
      case "ArrowUp":
        e.preventDefault();
        this.highlighted = Math.max(this.highlighted - 1, 0);
        this.render();
        break;
      case "Enter":
        e.preventDefault();
        this.assignHighlighted();
        break;
      case "n":
        if (this.input.value.length === 0) {
          e.preventDefault();
          this.close();
          this.onNewRequested?.();
        }
        break;
      case "e":
        if (this.input.value.length === 0) {
          e.preventDefault();
          const sel = this.filtered[this.highlighted];
          if (sel) { this.close(); this.onEditRequested?.(sel); }
        }
        break;
    }
  }

  private async assignHighlighted(): Promise<void> {
    const sel = this.filtered[this.highlighted];
    if (!sel || !this.targetSessionId) return;
    try {
      await sessionSetOperator(this.targetSessionId, sel.id);
      this.onAssigned?.(this.targetSessionId, sel);
      this.close();
    } catch (e) {
      alert(`Failed to assign operator: ${e}`);
    }
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Wire from `main.ts`**

```ts
import { OperatorPicker } from "./operator/picker";

const operatorPicker = new OperatorPicker(document.body);

operatorPicker.onAssigned = async (sessionId, op) => {
  const tab = tabManager.findBySessionId(sessionId);
  if (tab) {
    await tabManager.setTabOperator(tab.id, op.id);
  }
};
operatorPicker.onNewRequested = () => settingsPane.openTo("operators", "new");
operatorPicker.onEditRequested = (op) =>
  settingsPane.openTo("operators", op.id);

statusBar.onOperatorChipClick = (sid) => operatorPicker.open(sid);

// ⌘⇧O shortcut
window.addEventListener("keydown", (e) => {
  if (e.metaKey && e.shiftKey && (e.key === "O" || e.key === "o")) {
    e.preventDefault();
    const sid = tabManager.activeSessionId();
    if (sid) operatorPicker.open(sid);
  }
});
```

`settingsPane.openTo` is a small new helper on `SettingsPane` that opens the Settings overlay scrolled to the given section, and (Plan 2 dependency) optionally focuses a specific operator id or starts a new draft. If that helper does not exist yet, add a 10-line method to `SettingsPane` that opens Settings + scrolls to `#sec-operators` and exposes a callback to operatorsPane to select the right row.

- [ ] **Step 3: Styles**

```css
.operator-picker[hidden] { display: none; }
.operator-picker {
  position: fixed; inset: 0; z-index: 1000;
  display: flex; align-items: flex-start; justify-content: center;
  padding-top: 12vh;
}
.operator-picker__backdrop {
  position: absolute; inset: 0;
  background: rgba(0,0,0,0.4);
}
.operator-picker__modal {
  position: relative;
  width: min(720px, 90vw);
  background: var(--bg-overlay);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  display: flex; flex-direction: column; gap: 10px;
}
.operator-picker__input {
  background: var(--bg-panel);
  color: inherit;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font: inherit; font-size: 14px;
}
.operator-picker__layout {
  display: grid; grid-template-columns: 240px 1fr; gap: 12px;
  min-height: 240px; max-height: 50vh;
}
.operator-picker__list {
  list-style: none; margin: 0; padding: 0;
  overflow-y: auto;
  display: flex; flex-direction: column; gap: 2px;
}
.operator-picker__list li {
  display: grid; grid-template-columns: 24px 1fr 16px;
  align-items: center; gap: 8px;
  padding: 6px 8px; border-radius: 6px; cursor: pointer;
}
.operator-picker__list li.is-highlighted { background: var(--bg-panel); }
.operator-picker__list .emoji {
  width: 22px; height: 22px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 5px; color: #fff;
}
.operator-picker__preview {
  border-left: 1px solid var(--border);
  padding-left: 12px;
  overflow-y: auto;
}
.operator-picker__preview h4 { margin: 0 0 6px 0; }
.operator-picker__preview .tag {
  display: inline-block;
  padding: 1px 6px; border-radius: 4px;
  background: var(--bg-panel); font-size: 11px;
}
.operator-picker__preview dl {
  display: grid; grid-template-columns: max-content 1fr;
  gap: 2px 12px; margin: 8px 0;
  font-size: 12px;
}
.operator-picker__preview dt { color: var(--muted); }
.operator-picker__preview .persona {
  background: var(--bg-panel);
  padding: 8px; border-radius: 6px;
  font-size: 11px; white-space: pre-wrap; max-height: 220px; overflow: auto;
}
.operator-picker__hint {
  color: var(--muted); font-size: 11px; text-align: right;
}
```

- [ ] **Step 4: Smoke**

`⌘⇧O` opens picker. Type "sec" → filters. ↑/↓ moves highlight, preview updates. Enter assigns; statusbar/tab chips refresh. `n` opens Settings → Operators with new draft. `e` opens Settings on the highlighted row. `Esc` closes.

- [ ] **Step 5: Commit**

```bash
git add ui/src/operator/picker.ts ui/src/main.ts ui/src/styles.css ui/src/settings/panel.ts ui/src/settings/operators.ts
git commit -m "feat(ui/operator): ⌘⇧O picker with assign / new / edit / preview"
```

---

## Task 6: Operator-decisions panel chip + filter

**Files:**
- Modify: `ui/src/operator/panel.ts`
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Extend the row type to read `operator_id` / `operator_name`**

In the `OperatorDecisionRow` type (likely in `ui/src/api.ts` near the existing `list_operator_decisions` wrapper), add:

```ts
operator_id: string | null;
operator_name: string | null;
```

- [ ] **Step 2: Render chip per row**

In `ui/src/operator/panel.ts` row template, beside the existing mission/executor chips, add:

```ts
const opChip = row.operator_name
  ? `<span class="op-decision-chip"
           style="background:${this.opColor(row.operator_id)}">
       ${escapeHtml(row.operator_name)}
     </span>`
  : "";
```

`opColor(id)` looks up the cached operator list (passed in by `main.ts` after Task 3's cache is alive) and falls back to neutral gray for closed/unknown ids.

- [ ] **Step 3: Filter**

Add a select `<select data-role="filter-operator">` with `All` plus one option per cached operator. On change, filter the rendered rows by `operator_id`.

- [ ] **Step 4: Commit**

```bash
git add ui/src/operator/panel.ts ui/src/api.ts ui/src/styles.css
git commit -m "feat(ui/operator): per-decision operator chip + filter in operator-decisions panel"
```

---

## Task 7: AFK overlay — Active operators strip

**Files:**
- Modify: `ui/src/aom/afk.ts`
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Add the strip to header**

In `afk.ts`, the existing `<header class="afk-header">` (line ~64) gains a new row:

```html
<div class="afk-active-operators" data-role="active-operators"></div>
```

- [ ] **Step 2: Populate from decision events**

Whenever a decision fires (existing event subscription that updates the feed), record `decision.operator_id` in a `Set` for the current AOM session. After each update, render:

```ts
const html = [...this.activeOperatorIds]
  .map((id) => this.opCache.get(id))
  .filter((o): o is Operator => !!o)
  .map((o) => `
    <span class="afk-op-chip" style="background:${o.color}"
          title="${escapeHtml(o.name)}">
      ${escapeHtml(o.emoji)}<span>${escapeHtml(o.name)}</span>
    </span>`)
  .join("");
this.root.querySelector('[data-role="active-operators"]')!.innerHTML =
  this.activeOperatorIds.size === 0
    ? ""
    : `<span class="afk-active-label">Active operators:</span> ${html}`;
```

Reset the set on AOM start. Refresh the operator cache on AFK overlay open.

- [ ] **Step 3: Styles**

```css
.afk-active-operators {
  display: flex; flex-wrap: wrap; gap: 6px;
  padding: 4px 0;
}
.afk-active-label {
  color: var(--muted); font-size: 12px; align-self: center;
}
.afk-op-chip {
  display: inline-flex; align-items: center; gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  color: #fff; font-size: 11px;
}
```

- [ ] **Step 4: Commit**

```bash
git add ui/src/aom/afk.ts ui/src/styles.css
git commit -m "feat(ui/afk): active-operators strip in overlay header"
```

---

## Task 8: ESCALATE notification prefix

**Files:**
- Modify: `crates/app/src/notify.rs`
- Modify: `crates/app/src/operator.rs` (caller passes operator name through)

- [ ] **Step 1: Pass name into notify**

Find the call site that emits ESCALATE notifications in `operator.rs` (search `notify`, near the escalate decision branch). Right above the call, the per-session operator was already resolved as `op` (Task 7 of Plan 1). Pass `op.name.clone()` into the notify call.

In `notify.rs`, add an `operator_name: Option<String>` parameter to the relevant ESCALATE-shaped function. When `Some(name)`, prefix the emitted title/body with `[{name}]`:

```rust
let title = match operator_name.as_deref() {
    Some(n) => format!("[{n}] needs you on tab {tab}"),
    None    => format!("Operator needs you on tab {tab}"),
};
```

- [ ] **Step 2: Build + smoke**

Run: `cargo check -p covenant`. Trigger an ESCALATE (manually paste a non-routine prompt into a tab pinned to a non-default operator) — OS notification reads `[Sec-Op] needs you on tab 2 — …`.

- [ ] **Step 3: Commit**

```bash
git add crates/app/src/notify.rs crates/app/src/operator.rs
git commit -m "feat(notify): prefix ESCALATE with [operator name]"
```

---

## Task 9: End-to-end verification

- [ ] **Step 1: Build & test**

Run: `cargo test --workspace && cargo check --workspace && cd ui && npx tsc --noEmit`
Expected: green.

- [ ] **Step 2: Manual E2E**

1. Open app → Default chip in statusbar, Default chip on each tab.
2. Open Settings → create `Sec-Op` (red, 🛡️, threshold 0.4).
3. Tab 1: `⌘⇧O` → assign Sec-Op. Statusbar + tab chip turn red. Tab strip shows `S` (initials).
4. Quit + relaunch app → tab still pinned to Sec-Op.
5. Trigger an executor on tab 1 producing an ESCALATE → OS notification reads `[Sec-Op] …`.
6. Open AFK overlay → "Active operators: 🛡️ Sec-Op" appears.
7. Operator-decisions panel → row chip shows red `Sec-Op`, filter works.
8. Settings → delete Sec-Op → tab 1 falls back to Default chip.

- [ ] **Step 3: Commit final cleanup, push.**

---

## Acceptance criteria (this plan)

- [ ] Tab strip renders an operator chip per tab (initials, operator color); falls back to Default chip when unpinned.
- [ ] Statusbar shows the active tab's operator chip with emoji + name; click opens picker.
- [ ] `⌘⇧O` opens picker; ↑/↓/Enter/Esc/n/e all work; Enter assigns and persists.
- [ ] Tab manifest persists `operator_id`; pin survives app restart.
- [ ] Operator-decisions panel shows per-row operator chip + has a "By operator" filter.
- [ ] AFK overlay header shows "Active operators:" strip populated from session decisions.
- [ ] OS ESCALATE notifications carry `[operator-name]` prefix when one is resolvable.
- [ ] `cargo test --workspace`, `cargo check --workspace`, `npx tsc --noEmit` all clean.

## Open questions

None.
