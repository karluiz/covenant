# Covenant Panel rail-* Homologation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate the Covenant panel's list tabs (commands / prompts / notes / drafts) to the shared `rail-*` chrome so they render dense, edge-to-edge rows like Tasker, and delete the duplicated `pn-*` row CSS.

**Architecture:** Frontend-only. The shared rail primitives in `ui/src/styles.css` (`.rail-row`, `.rail-name`, `.rail-cmd`, `.rail-meta`, `.rail-new`, `.rail-row-action`, `.rail-empty`, `.rail-divider`) become the only row language. `panel.ts` zeroes the body padding for list tabs; each tab's markup switches to rail classes while KEEPING its `pn-*` classes as behavior/test hooks (dual class). A new `.rail-row-actions` group extends the existing single hover-action chrome to multi-action rows.

**Tech Stack:** TypeScript (strict), vanilla DOM, Vitest (jsdom). No new deps.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-07-pn-panel-rail-homologation-design.md`
- Run tests from repo ROOT: `npm test -- <file>` (never from `ui/`)
- `main` has ~15 pre-existing unrelated test failures — only the project-notes suites must be green; do not chase others
- No native tooltips: `attachTooltip` from `ui/src/tooltip/tooltip.ts`, never `element.title`
- Sharp corners: no new `border-radius` (existing shared rail chrome values stay as-is)
- English-first copy; no string changes needed
- `docs` tab is untouched (keeps padded body)
- Icons: paste → `Icons.clipboard`, send → `Icons.play`, edit → `Icons.pencil`, delete → `Icons.trash`, all `{ size: 13 }`

---

### Task 1: Shared multi-action row chrome

**Files:**
- Modify: `ui/src/styles.css` (rail block, after the `.rail-row-action` rules ~line 19777)

**Interfaces:**
- Produces: `.rail-row-actions` (absolute hover-reveal flex group of `.rail-row-action` buttons inside a `.rail-row`) and `.rail-row-action.is-neutral` (hover = fg, not danger). Tasks 4–6 rely on these class names exactly.

- [ ] **Step 1: Add the group + neutral-hover CSS**

Append after the `.rail-row-action svg` rule (`ui/src/styles.css:19777`):

```css
/* —— multi-action group: N hover-revealed buttons on one row —— */
.rail-row-actions {
  position: absolute; top: 6px; right: 6px;
  display: flex; gap: 2px; opacity: 0; transition: opacity .1s;
}
.rail-row:hover .rail-row-actions, .rail-row:focus-within .rail-row-actions { opacity: 1; }
.rail-row-actions .rail-row-action { position: static; opacity: 1; }
.rail-row:has(.rail-row-actions) { padding-right: 82px; }
.rail-row-action.is-neutral:hover { color: var(--fg); }
```

- [ ] **Step 2: Type-check + commit**

Run: `npm run build` — Expected: PASS (CSS-only change).

```bash
git add ui/src/styles.css
git commit -m "feat(rail): multi-action hover group for rail rows"
```

---

### Task 2: Flush panel body for list tabs

**Files:**
- Modify: `ui/src/project-notes/panel.ts:158-179` (`updateTabUI`)
- Modify: `ui/src/project-notes/styles.css:111-117` (after `.pn-body`)
- Test: `ui/src/project-notes/panel.test.ts`

**Interfaces:**
- Produces: `.pn-body--flush` (padding 0) toggled on `.pn-body` whenever the active tab is NOT `docs`. Tasks 3–6 assume list tabs render edge-to-edge.

- [ ] **Step 1: Write the failing test**

Append to `ui/src/project-notes/panel.test.ts`:

```ts
it("flushes the body padding for list tabs but not docs", () => {
  const p = new ProjectNotesPanel({ groupId: "g1", groupLabel: "G1" }).mount(host);
  const body = host.querySelector(".pn-body") as HTMLElement;
  expect(body.classList.contains("pn-body--flush")).toBe(true); // default: commands
  p.switchTab("docs");
  expect(body.classList.contains("pn-body--flush")).toBe(false);
  p.switchTab("drafts");
  expect(body.classList.contains("pn-body--flush")).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- ui/src/project-notes/panel.test.ts`
Expected: FAIL — new test asserts `true`, gets `false`.

- [ ] **Step 3: Implement**

In `panel.ts` `updateTabUI()`, right after `this.body.replaceChildren();`:

```ts
this.body.classList.toggle("pn-body--flush", this.currentTab !== "docs");
```

In `project-notes/styles.css`, directly under the `.pn-body` rule (line 116):

```css
/* List tabs run rail-* rows edge-to-edge; docs keeps the padded surface.
   Single-class selector so `.pn-fullscreen .pn-body` still wins in fullscreen. */
.pn-body--flush { padding: 0; }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- ui/src/project-notes/panel.test.ts` — Expected: PASS (all suites in file).

- [ ] **Step 5: Commit**

```bash
git add ui/src/project-notes/panel.ts ui/src/project-notes/styles.css ui/src/project-notes/panel.test.ts
git commit -m "feat(covenant-panel): flush body padding on list tabs"
```

---

### Task 3: Drafts tab — drop the double inset

**Files:**
- Modify: `ui/src/project-notes/styles.css:331-338` (`.pn-drafts-tab`)

No TS/markup changes — drafts already uses `rail-new` / `rail-row` / `rail-empty`.

- [ ] **Step 1: Replace the rule**

```css
.pn-drafts-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
}
```

(Removes `gap: 8px; padding: 8px;` — `.rail-row` carries its own padding + hairline separators; `.rail-new` carries its own margins.)

- [ ] **Step 2: Verify + commit**

Run: `npm test -- ui/src/project-notes/drafts-tab.test.ts` — Expected: PASS.

```bash
git add ui/src/project-notes/styles.css
git commit -m "fix(covenant-panel): drafts rows edge-to-edge like tasker"
```

---

### Task 4: Commands tab → rail rows

**Files:**
- Modify: `ui/src/project-notes/commands-tab.ts`
- Modify: `ui/src/project-notes/styles.css`
- Test: `ui/src/project-notes/commands-tab.test.ts`

**Interfaces:**
- Consumes: `.rail-row-actions` / `.is-neutral` (Task 1)
- Produces: rows keep hook classes `pn-cmd-title`, `pn-cmd-code`, `pn-cmd-paste`, `pn-cmd-edit`, `pn-cmd-del`; new-button keeps `pn-cmd-new`. Existing tests stay green.

- [ ] **Step 1: Add a failing structure assertion**

Append inside the first test of `commands-tab.test.ts` (after the existing expectations):

```ts
expect(host.querySelector(".rail-row .rail-name.pn-cmd-title")).not.toBeNull();
expect(host.querySelector(".rail-new.pn-cmd-new")).not.toBeNull();
```

Run: `npm test -- ui/src/project-notes/commands-tab.test.ts` — Expected: FAIL.

- [ ] **Step 2: Migrate the markup**

In `commands-tab.ts`:

1. Add import: `import { Icons } from "../icons";`
2. Constructor button: `newBtn.className = "rail-new pn-cmd-new";`
3. Replace the row block in `render()`:

```ts
for (const c of this.commands) {
  const li = document.createElement("li");
  li.className = "rail-row";
  li.dataset.id = c.id;
  li.innerHTML = `
    <div class="rail-row-line"><span class="rail-name pn-cmd-title"></span></div>
    <code class="rail-cmd pn-cmd-code"></code>
    <div class="rail-row-actions">
      <button class="rail-row-action is-neutral pn-cmd-paste" aria-label="Paste into active tab">${Icons.clipboard({ size: 13 })}</button>
      <button class="rail-row-action is-neutral pn-cmd-edit" aria-label="Edit">${Icons.pencil({ size: 13 })}</button>
      <button class="rail-row-action pn-cmd-del" aria-label="Delete">${Icons.trash({ size: 13 })}</button>
    </div>
  `;
  (li.querySelector(".pn-cmd-title") as HTMLElement).textContent = c.title;
  (li.querySelector(".pn-cmd-code") as HTMLElement).textContent = c.command;
  const pasteBtn = li.querySelector<HTMLElement>(".pn-cmd-paste")!;
  pasteBtn.addEventListener("click", () => this.paste(c));
  attachTooltip(pasteBtn, "Paste into active tab");
  const editBtn = li.querySelector<HTMLElement>(".pn-cmd-edit")!;
  editBtn.addEventListener("click", () => this.openEditor(c));
  attachTooltip(editBtn, "Edit");
  const delBtn = li.querySelector<HTMLElement>(".pn-cmd-del")!;
  delBtn.addEventListener("click", () => this.delete(c));
  attachTooltip(delBtn, "Delete");
  this.list.appendChild(li);
}
```

4. In `project-notes/styles.css`: `.pn-cmd-tab { display: flex; flex-direction: column; }` (drop `gap: 12px`) and give the inline editor side margins so it doesn't touch the flush edges — change `.pn-cmd-editor`'s `margin-top: 12px;` to `margin: 8px var(--rail-pad-x);`.

- [ ] **Step 3: Run tests**

Run: `npm test -- ui/src/project-notes/commands-tab.test.ts` — Expected: PASS (both existing tests + new assertions).

- [ ] **Step 4: Commit**

```bash
git add ui/src/project-notes/commands-tab.ts ui/src/project-notes/styles.css ui/src/project-notes/commands-tab.test.ts
git commit -m "feat(covenant-panel): commands tab on rail-row chrome"
```

---

### Task 5: Prompts tab → rail rows

**Files:**
- Modify: `ui/src/project-notes/prompts-tab.ts`
- Modify: `ui/src/project-notes/styles.css`
- Test: `ui/src/project-notes/prompts-tab.test.ts`

**Interfaces:**
- Consumes: `.rail-row-actions` / `.is-neutral` (Task 1)
- Produces: hook classes `pn-prompt-title`, `pn-prompt-body`, `pn-prompt-send`, `pn-prompt-edit`, `pn-prompt-del`, `pn-prompt-new` preserved; drag classes `pn-prompt-dragging`, `pn-prompt-drop-before/after` unchanged.

- [ ] **Step 1: Add a failing structure assertion**

Append inside the first test of `prompts-tab.test.ts`:

```ts
expect(host.querySelector(".rail-row .rail-name.pn-prompt-title")).not.toBeNull();
expect(host.querySelector(".rail-new.pn-prompt-new")).not.toBeNull();
```

Run: `npm test -- ui/src/project-notes/prompts-tab.test.ts` — Expected: FAIL.

- [ ] **Step 2: Migrate the markup**

In `prompts-tab.ts`:

1. Add import: `import { Icons } from "../icons";`
2. Constructor button: `newBtn.className = "rail-new pn-prompt-new";`
3. Row: `li.className = "rail-row";` (drag handlers stay exactly as they are), and replace the `li.innerHTML` block:

```ts
li.innerHTML = `
  <div class="rail-row-line"><span class="rail-name pn-prompt-title"></span></div>
  <div class="rail-meta"><span class="pn-prompt-body"></span></div>
  <div class="rail-row-actions">
    <button class="rail-row-action is-neutral pn-prompt-send" aria-label="Send to active tab">${Icons.play({ size: 13 })}</button>
    <button class="rail-row-action is-neutral pn-prompt-edit" aria-label="Edit">${Icons.pencil({ size: 13 })}</button>
    <button class="rail-row-action pn-prompt-del" aria-label="Delete">${Icons.trash({ size: 13 })}</button>
  </div>
`;
```

(The existing `textContent` wiring and the send/edit/del listeners + tooltips below it stay unchanged.)

4. In `project-notes/styles.css`:
   - `.pn-prompt-tab { display: flex; flex-direction: column; }` (drop `gap: 12px`)
   - `.pn-prompt-editor` margins: same treatment as the commands editor — `margin: 8px var(--rail-pad-x);`
   - New body-preview rule (replaces the old card body):

```css
.pn-prompt-body { display: block; max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
```

   - Keep `.pn-prompt-dragging { opacity: 0.5; }` as a standalone class-only rule (it currently rides on `.pn-prompt-row`), and keep the `!important` drop-indicator rules at lines 341-346 (they target class-only selectors and work on `rail-row`).

- [ ] **Step 3: Run tests**

Run: `npm test -- ui/src/project-notes/prompts-tab.test.ts` — Expected: PASS (create/send/reorder + new assertions).

- [ ] **Step 4: Commit**

```bash
git add ui/src/project-notes/prompts-tab.ts ui/src/project-notes/styles.css ui/src/project-notes/prompts-tab.test.ts
git commit -m "feat(covenant-panel): prompts tab on rail-row chrome"
```

---

### Task 6: Notes tab → rail rows

**Files:**
- Modify: `ui/src/project-notes/notes-tab.ts`
- Modify: `ui/src/project-notes/styles.css`
- Test: `ui/src/project-notes/notes-tab.test.ts`

**Interfaces:**
- Consumes: single-action `.rail-row-action` chrome (pre-existing)
- Produces: hook classes `pn-note-card` (on the rail-row — delete test queries it), `pn-note-body`, `pn-note-stamp`, `pn-note-del`, `pn-note-input` preserved.

- [ ] **Step 1: Add a failing structure assertion**

Append inside the delete test of `notes-tab.test.ts`, before the `.pn-note-del` click:

```ts
expect(host.querySelector(".rail-row.pn-note-card")).not.toBeNull();
```

Run: `npm test -- ui/src/project-notes/notes-tab.test.ts` — Expected: FAIL.

- [ ] **Step 2: Migrate the markup**

In `notes-tab.ts`:

1. Add import: `import { Icons } from "../icons";`
2. Section label: `this.sectionLabel.className = "rail-divider";`
3. Row block in `render()`:

```ts
const li = document.createElement("li");
li.className = "rail-row pn-note-card";
li.dataset.id = n.id;
const stamp = formatRelative(n.created_at_unix_ms);
li.innerHTML = `
  <div class="pn-note-body"></div>
  <div class="rail-meta pn-note-stamp"></div>
  <button class="rail-row-action pn-note-del" aria-label="Delete note">${Icons.trash({ size: 13 })}</button>
`;
(li.querySelector(".pn-note-stamp") as HTMLElement).textContent = stamp;
(li.querySelector(".pn-note-body") as HTMLElement).textContent = n.body;
li.querySelector(".pn-note-del")!.addEventListener("click", () => this.delete(n));
this.list.appendChild(li);
```

4. In `project-notes/styles.css`:
   - `.pn-note-input`: add `margin: 10px var(--rail-pad-x) 0; width: auto;` to the existing rule (it sits inside the flush body now)
   - `.pn-note-list`: drop the `gap: 8px`
   - Replace the old `.pn-note-body` rule with the in-row version:

```css
.pn-note-body {
  font-size: var(--fs-body);
  color: var(--fg);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
```

- [ ] **Step 3: Run tests**

Run: `npm test -- ui/src/project-notes/notes-tab.test.ts` — Expected: PASS (all 3 tests + new assertion).

- [ ] **Step 4: Commit**

```bash
git add ui/src/project-notes/notes-tab.ts ui/src/project-notes/styles.css ui/src/project-notes/notes-tab.test.ts
git commit -m "feat(covenant-panel): notes tab on rail-row chrome"
```

---

### Task 7: Dead CSS sweep + full verification

**Files:**
- Modify: `ui/src/project-notes/styles.css`

**Interfaces:**
- Consumes: Tasks 4–6 (no TS references the deleted selectors anymore)

- [ ] **Step 1: Delete the dead `pn-*` row chrome**

Remove these rule blocks from `project-notes/styles.css` (line numbers pre-sweep):

- `.pn-cmd-new`, `.pn-cmd-new:hover` (156-171)
- `.pn-cmd-row`, `.pn-cmd-row:hover`, `.pn-cmd-meta`, `.pn-cmd-title`, `.pn-cmd-code`, `.pn-cmd-actions`, `.pn-cmd-row:hover .pn-cmd-actions`, `.pn-cmd-actions button`, `.pn-cmd-actions button:hover` (173-210)
- `.pn-note-card`, `.pn-note-card:hover`, `.pn-note-stamp`, `.pn-note-del`, `.pn-note-card:hover .pn-note-del`, `.pn-note-del:hover` (234-273, EXCEPT the new `.pn-note-body` rule from Task 6)
- `.pn-prompt-new`, `.pn-prompt-new:hover` (350-365)
- `.pn-prompt-row`, `.pn-prompt-row:hover`, `.pn-prompt-row.pn-prompt-dragging` (already replaced by the class-only rule), `.pn-prompt-row.pn-prompt-drop-before`, `.pn-prompt-meta`, `.pn-prompt-title`, old `.pn-prompt-body`, `.pn-prompt-actions`, `.pn-prompt-row:hover .pn-prompt-actions`, `.pn-prompt-actions button`, `.pn-prompt-actions button:hover` (367-400, EXCEPT the new `.pn-prompt-body` one-liner from Task 5)

Sanity: `grep -n "pn-cmd-row\|pn-prompt-row\|pn-note-card\|pn-cmd-new\|pn-prompt-new" ui/src/project-notes/styles.css` → only `.pn-note-card` inside the Task 6 hook comment (or nothing), and `grep -rn "pn-cmd-row\|pn-prompt-row" ui/src` → no TS hits.

- [ ] **Step 2: Full verification**

Run: `npm test -- ui/src/project-notes` — Expected: all 5 project-notes suites PASS.
Run: `npm run build` — Expected: tsc + vite PASS.
Run: `npm test` — Expected: no NEW failures vs the ~15 pre-existing on main.

- [ ] **Step 3: Commit**

```bash
git add ui/src/project-notes/styles.css
git commit -m "refactor(covenant-panel): delete duplicated pn-* row chrome"
```
