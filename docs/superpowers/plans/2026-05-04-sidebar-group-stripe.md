# Sidebar Group + Tab Lateral Stripe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current per-tab and per-chip color stripes with a single thick lateral stripe per group that hugs the entire group (header + members) when expanded, shrinks to header height when collapsed.

**Architecture:** Introduce a `.tab-group-shell` flex wrapper element rendered around each group's chip + member pills. The shell holds two children: `.tab-group-stripe` (3px wide, group color, `align-self: stretch`) and `.tab-group-body` (column flex containing the existing chip + pills). All current per-tab `::after` color rules and the chip's `::before` top stripe are removed. The shell is built by a new pure DOM helper `createGroupShell(group)` so it can be unit-tested in isolation; the existing `renderTabbar` loop appends chip + member pills into the shell's body instead of directly into `tabbarHost`.

**Tech Stack:** TypeScript, Vite, vitest (jsdom env via existing test setup), CSS custom properties.

**Spec:** `docs/superpowers/specs/2026-05-04-sidebar-group-stripe-design.md`

---

## File Structure

- `ui/src/tabs/group-shell.ts` — **NEW.** Pure DOM helper: `createGroupShell(opts: { groupId: string; color?: string | null; collapsed: boolean }): { shell: HTMLElement; body: HTMLElement }`. No imports from `manager.ts`. Returned `body` is where the caller appends the chip + member pills.
- `ui/src/tabs/group-shell.test.ts` — **NEW.** vitest tests asserting shell DOM shape (classes, dataset, stripe color, body element).
- `ui/src/tabs/manager.ts` — **MODIFY** `renderTabbar` (~lines 2160–2220) to insert one shell per group and append chip + pills into the shell's body. Remove now-dead `tab-grouped-first` / `group-chip-has-members` bookkeeping.
- `ui/src/styles.css` — **MODIFY**:
  - Add `.tab-group-shell` and `.tab-group-stripe` rules.
  - Remove `.group-chip::before` top stripe (lines ~908–919).
  - Remove `.tab-grouped::after` left-edge color (lines ~1069–1097).
  - Clean up `body.tabbar-left` overrides that referenced the removed pseudo-elements (~lines 6411–6435).
  - Tweak member pill bg + active state per spec.

---

## Task 1: Extract `createGroupShell` pure helper

**Files:**
- Create: `ui/src/tabs/group-shell.ts`
- Test: `ui/src/tabs/group-shell.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/tabs/group-shell.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createGroupShell } from "./group-shell";

describe("createGroupShell", () => {
  it("returns a shell element with stripe + body children in that order", () => {
    const { shell, body } = createGroupShell({ groupId: "g1", color: "#3b82f6", collapsed: false });
    expect(shell.classList.contains("tab-group-shell")).toBe(true);
    expect(shell.dataset.groupId).toBe("g1");
    expect(shell.children.length).toBe(2);
    expect(shell.children[0].classList.contains("tab-group-stripe")).toBe(true);
    expect(shell.children[1]).toBe(body);
    expect(body.classList.contains("tab-group-body")).toBe(true);
  });

  it("paints stripe with --group-color when color is provided", () => {
    const { shell } = createGroupShell({ groupId: "g1", color: "#84cc16", collapsed: false });
    expect(shell.style.getPropertyValue("--group-color")).toBe("#84cc16");
    expect(shell.classList.contains("tab-group-shell-colored")).toBe(true);
  });

  it("omits colored class when no color", () => {
    const { shell } = createGroupShell({ groupId: "g1", color: null, collapsed: false });
    expect(shell.classList.contains("tab-group-shell-colored")).toBe(false);
    expect(shell.style.getPropertyValue("--group-color")).toBe("");
  });

  it("adds collapsed class when group is collapsed", () => {
    const { shell } = createGroupShell({ groupId: "g1", color: "#fff", collapsed: true });
    expect(shell.classList.contains("tab-group-shell-collapsed")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- group-shell`
Expected: FAIL with "Cannot find module './group-shell'".

- [ ] **Step 3: Implement helper**

Create `ui/src/tabs/group-shell.ts`:

```ts
export interface GroupShellOptions {
  groupId: string;
  color: string | null | undefined;
  collapsed: boolean;
}

export interface GroupShell {
  shell: HTMLElement;
  body: HTMLElement;
}

/**
 * Builds the per-group flex container used by the tab sidebar.
 * Layout: [stripe 3px][body]. Caller appends the group chip and any
 * member tab pills into `body`. The stripe paints the group color and
 * stretches to match body height automatically (CSS `align-self: stretch`).
 */
export function createGroupShell(opts: GroupShellOptions): GroupShell {
  const shell = document.createElement("div");
  shell.className = "tab-group-shell";
  shell.dataset.groupId = opts.groupId;
  if (opts.color) {
    shell.classList.add("tab-group-shell-colored");
    shell.style.setProperty("--group-color", opts.color);
  }
  if (opts.collapsed) {
    shell.classList.add("tab-group-shell-collapsed");
  }

  const stripe = document.createElement("div");
  stripe.className = "tab-group-stripe";
  shell.appendChild(stripe);

  const body = document.createElement("div");
  body.className = "tab-group-body";
  shell.appendChild(body);

  return { shell, body };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- group-shell`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/group-shell.ts ui/src/tabs/group-shell.test.ts
git commit -m "feat(tabs): add group-shell DOM helper for lateral stripe layout"
```

---

## Task 2: Wire `renderTabbar` to use the shell

**Files:**
- Modify: `ui/src/tabs/manager.ts` (function `renderTabbar`, lines ~2160–2235)

- [ ] **Step 1: Read the current `renderTabbar` body**

Open `ui/src/tabs/manager.ts` and locate `private renderTabbar(): void` (~line 2160). Note the current loop:
- Iterates `this.tabs`, detects new-group runs, appends `chipEl` + `pillEl` directly to `this.tabbarHost`.
- Tracks `pendingFirstGroupId` to add a `tab-grouped-first` class to the first member pill.
- After the loop, appends standalone chips for empty groups directly to `this.tabbarHost`.

- [ ] **Step 2: Replace the loop to use shells**

Replace the body of `renderTabbar` (everything between `this.tabbarHost.innerHTML = "";` and the `this.lastCollapsed.clear();` block, excluding the post-loop transition rAF logic) with:

```ts
this.tabbarHost.innerHTML = "";
const transitions: Array<{ el: HTMLElement; collapsing: boolean }> = [];

// Track open shell while iterating tabs.
let currentShellGroupId: string | null = null;
let currentShellBody: HTMLElement | null = null;
let currentShellEl: HTMLElement | null = null;

const openShell = (group: TabGroup): HTMLElement => {
  const { shell, body } = createGroupShell({
    groupId: group.id,
    color: group.color ?? null,
    collapsed: group.collapsed,
  });
  this.tabbarHost.appendChild(shell);
  currentShellGroupId = group.id;
  currentShellBody = body;
  currentShellEl = shell;
  return body;
};

const closeShell = (): void => {
  currentShellGroupId = null;
  currentShellBody = null;
  currentShellEl = null;
};

for (const tab of this.tabs) {
  // Ungrouped tab: close any open shell, append directly to host.
  if (!tab.groupId) {
    closeShell();
    const pillEl = this.renderTabPill(tab);
    this.tabbarHost.appendChild(pillEl);
    continue;
  }

  // Grouped tab: open a new shell if the group changed.
  if (tab.groupId !== currentShellGroupId) {
    closeShell();
    const group = this.groups.get(tab.groupId);
    if (!group) continue;
    const body = openShell(group);
    const memberCount = this.memberIndices(group.id).length;
    const chipEl = this.renderGroupChip(group, memberCount);
    body.appendChild(chipEl);
  }

  // Append member pill into current shell body.
  const group = this.groups.get(tab.groupId)!;
  const folded = group.collapsed;
  const wasCollapsed = this.lastCollapsed.get(group.id);
  const transitioning = wasCollapsed !== undefined && wasCollapsed !== folded;
  const pillEl = this.renderTabPill(tab);
  const initiallyFolded = transitioning ? wasCollapsed! : folded;
  if (initiallyFolded) pillEl.classList.add("tab-pill-folded");
  if (transitioning) {
    transitions.push({ el: pillEl, collapsing: folded });
  }
  currentShellBody!.appendChild(pillEl);
}
closeShell();

// Empty groups (no members) render at the end as standalone shells
// containing only the chip. Still valid drop targets.
const usedGroupIds = new Set<string>();
for (const t of this.tabs) if (t.groupId) usedGroupIds.add(t.groupId);
for (const g of this.groups.values()) {
  if (usedGroupIds.has(g.id)) continue;
  const { shell, body } = createGroupShell({
    groupId: g.id,
    color: g.color ?? null,
    collapsed: g.collapsed,
  });
  body.appendChild(this.renderGroupChip(g, 0));
  this.tabbarHost.appendChild(shell);
}

// Sync the snapshot now that we've captured the prev state above.
this.lastCollapsed.clear();
for (const g of this.groups.values()) {
  this.lastCollapsed.set(g.id, g.collapsed);
}
```

Suppress unused locals: remove the now-unused `prevGroupId`, `pendingFirstGroupId`, and the `tab-grouped-first` class addition.

- [ ] **Step 3: Add the import**

At the top of `ui/src/tabs/manager.ts`, near the other `./...` imports, add:

```ts
import { createGroupShell } from "./group-shell";
```

- [ ] **Step 4: Run typecheck and existing tests**

Run: `npm run typecheck 2>/dev/null || npx tsc --noEmit`
Expected: no errors. (If `typecheck` script doesn't exist, the `tsc --noEmit` form is the fallback.)

Run: `npm test`
Expected: all existing tests pass; new group-shell tests still pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "refactor(tabs): wrap each group in a tab-group-shell"
```

---

## Task 3: CSS — replace per-tab and per-chip stripes with shell stripe

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Add the shell rules**

Insert after the existing `.group-chip` block (around line 906, before the soon-to-be-removed `.group-chip::before`):

```css
/* ── Tab group shell — lateral stripe + body container ── */
.tab-group-shell {
    display: flex;
    align-items: stretch;
    gap: 8px;
    margin: 0 0 6px 0;
}

.tab-group-shell-colored .tab-group-stripe {
    background: var(--group-color, var(--accent));
}

.tab-group-stripe {
    width: 3px;
    border-radius: 2px;
    background: var(--muted);
    flex-shrink: 0;
    align-self: stretch;
}

.tab-group-body {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1 1 auto;
    min-width: 0;
}
```

- [ ] **Step 2: Remove the old chip top stripe**

Delete the `.group-chip::before` block (lines ~908–919, the `/* Top accent stripe ... */` comment and the rule):

```css
/* Top accent stripe — matches the .tab-grouped::after of member tabs ... */
.group-chip::before {
    content: "";
    position: absolute;
    top: 0;
    left: -1px;
    right: -1px;
    height: 3px;
    background: var(--group-color, var(--accent));
    border-radius: var(--tab-radius) var(--tab-radius) 0 0;
}
```

- [ ] **Step 3: Remove the per-tab left-edge color**

Locate the `.tab-grouped::after` block (~line 1069) and the related `.tab-grouped-first` / `.tab-grouped + .tab-grouped` blocks (~lines 1089–1097). Delete the `::after` rule entirely. The `.tab-grouped` base class can stay (no-op now), or be removed if grep confirms it's no longer referenced after Task 2.

Verify with: `grep -n "tab-grouped\|tab-grouped-first" ui/src ui/src/styles.css -r` after deletion. If `tab-grouped` is referenced only in `manager.ts` line ~2350, leave the addition (harmless) and remove the corresponding CSS rules.

- [ ] **Step 4: Tighten member pill bg per spec**

In the `.tab-btn` rule (search for the main `.tab-btn {` block), confirm/adjust the inactive bg to `rgba(255, 255, 255, 0.02)` and active to `rgba(255, 255, 255, 0.06)`. If the existing values differ but achieve the same spec intent (subtle inactive, slightly stronger active), leave them — the spec values are guidance, not absolute. **Do not change non-grouped tab visuals** beyond what's needed to harmonize with the new shell.

- [ ] **Step 5: Clean up `body.tabbar-left` overrides**

Locate the `body.tabbar-left .tab-grouped` and `body.tabbar-left .tab-grouped-first` rules (~lines 6411–6435). Remove blocks that styled the now-deleted `::after` pseudo-element. Leave any rules that still apply (e.g., layout direction), and verify visually in Task 4.

- [ ] **Step 6: Verify build**

Run: `npm test`
Expected: all tests still pass (CSS-only changes, no test impact).

Run: `npm run build` (from repo root) or whatever the project uses to bundle the UI. Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(tabs): lateral group stripe replaces per-tab/per-chip stripes"
```

---

## Task 4: Visual verification + dead-code cleanup

**Files:**
- Modify: `ui/src/tabs/manager.ts` (remove dead `tab-grouped-first`, `group-chip-has-members` references if any survived)
- Modify: `ui/src/styles.css` (final cleanup pass)

- [ ] **Step 1: Run the app**

```bash
./scripts/install.sh --skip-build --open
```

(or `npm run install:app:reuse && npm run install:app:open` depending on the user's preferred command).

Expected: terminal app launches.

- [ ] **Step 2: Visual checks against the spec**

Open the sidebar. Reproduce the baseline scenario (5 groups: Covenant, Raven, Karluiz, Nxt, Control). Verify:

1. Each group shows a 3px lateral stripe in its color.
2. Expanded group: stripe extends from top of header to bottom of last member.
3. Collapsed group: stripe shrinks to header height (~28px).
4. Member rows have no left-edge color; group identity comes from the shell's stripe.
5. Group header still shows UPPERCASE label, chevron, count pill (when collapsed).
6. Member avatars + badges render unchanged.
7. Active tab highlight is visible (stronger bg).
8. Drag tab → group: still works. Drag group: still works. Collapse/expand animation still works.

If any of these fail, fix the corresponding CSS/JS and re-verify before continuing.

- [ ] **Step 3: Grep and remove dead references**

Run: `grep -rn "tab-grouped-first\|group-chip-has-members\|tab-grouped::after" ui/src`

Delete remaining references (manager.ts class additions, any leftover CSS). Re-run `npm test` and `npm run build` to confirm.

- [ ] **Step 4: Final commit**

```bash
git add ui/src/tabs/manager.ts ui/src/styles.css
git commit -m "chore(tabs): remove dead group-stripe bookkeeping"
```

---

## Self-Review Notes

- **Spec coverage:** stripe behavior (expanded/collapsed), header preservation, member styling, spacing, file targets, and out-of-scope list — all mapped to Tasks 1–4.
- **Type consistency:** `createGroupShell` signature is fixed in Task 1 and used identically in Task 2. `GroupShellOptions.color` is `string | null | undefined` to match the call sites (`group.color ?? null`).
- **No placeholders:** all CSS values, file paths, and code blocks are concrete.
- **Risks:** the `.tab-grouped` class survives (harmless) — explicitly called out in Task 3 Step 3. The drag-and-drop pointer logic in `manager.ts` (`installTabPointerDrag`) is untouched; if it relied on tabs being direct children of `tabbarHost`, Task 4 visual verification will surface that — fix in-task if so.
