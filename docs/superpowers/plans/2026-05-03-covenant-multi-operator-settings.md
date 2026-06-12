# Covenant Multi-Operator — Plan 2: Settings → Operators UI

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the singular `Settings → Operator` pane (one persona textarea) with `Settings → Operators` (plural): a sidebar list + right-side editor for full CRUD over the operator roster, consuming the Tauri commands shipped by Plan 1.

**Architecture:** Single new component `ui/src/settings/operators.ts` exporting an `OperatorsPane` class that owns its sidebar list and editor form. Mounted from `ui/src/settings/panel.ts` in place of the current `#sec-operator` content. State is hydrated by `operator_list` on open and re-hydrated after every successful CRUD call so the list always reflects storage truth. The legacy persona/threshold textarea inside `OperatorConfig` is removed from the UI but left intact in the settings store (Plan 1 keeps it as the migration source).

**Tech Stack:** TypeScript (strict), vanilla DOM (no framework). Existing patterns: `SettingsPane` in `ui/src/settings/panel.ts`, the `MissionOverlay` modal style, and the `operator_*` commands defined in Plan 1.

**Depends on:** Plan 1 merged (commands `operator_list / operator_get / operator_create / operator_update / operator_delete / operator_set_default` available).

---

## File structure

- **Create**:
  - `ui/src/settings/operators.ts` — `OperatorsPane` (≤ 450 lines).
- **Modify**:
  - `ui/src/api.ts` — typed wrappers for the 6 operator commands (≤ 70 lines added).
  - `ui/src/settings/panel.ts` — replace `#sec-operator` body with a mount point + delegate to `OperatorsPane`. Drop the legacy persona/idle/rate editing rows from this section.
  - `ui/src/index.html` — rename the nav link `Operator` → `Operators` and the section id; the inner content becomes a single mount `<div id="operators-pane"></div>`.
  - `ui/src/styles.css` — append styles for the list + editor (≤ 220 lines, scoped under `.operators-pane`).
- **Do NOT touch**:
  - `crates/app/` — backend is fixed by Plan 1.
  - Anything under `ui/src/aom/`, `ui/src/tabs/`, `ui/src/status/`, `ui/src/operator/` — those are Plan 3.

---

## Task 1: API wrappers

**Files:**
- Modify: `ui/src/api.ts`

- [ ] **Step 1: Add type + wrappers**

Append to `ui/src/api.ts` (after the existing operator block near line ~130):

```ts
export interface Operator {
  id: string;
  name: string;
  emoji: string;
  color: string;
  tags: string[];
  persona: string;
  escalate_threshold: number;
  model: string;
  hard_constraints: string;
  is_default: boolean;
  created_at_unix_ms: number;
  updated_at_unix_ms: number;
}

export interface OperatorDraft {
  name: string;
  emoji: string;
  color: string;
  tags: string[];
  persona: string;
  escalate_threshold: number;
  model: string;
  hard_constraints: string;
}

export async function operatorList(): Promise<Operator[]> {
  return invoke<Operator[]>("operator_list");
}

export async function operatorGet(id: string): Promise<Operator | null> {
  return invoke<Operator | null>("operator_get", { id });
}

export async function operatorCreate(draft: OperatorDraft): Promise<Operator> {
  return invoke<Operator>("operator_create", { draft });
}

export async function operatorUpdate(id: string, draft: OperatorDraft): Promise<Operator> {
  return invoke<Operator>("operator_update", { id, draft });
}

export async function operatorDelete(id: string): Promise<void> {
  return invoke<void>("operator_delete", { id });
}

export async function operatorSetDefault(id: string): Promise<void> {
  return invoke<void>("operator_set_default", { id });
}
```

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add ui/src/api.ts
git commit -m "feat(ui/api): typed wrappers for operator CRUD commands"
```

---

## Task 2: HTML mount point + nav rename

**Files:**
- Modify: `ui/src/index.html`

- [ ] **Step 1: Find the settings panel markup**

Search `index.html` for `data-target="sec-operator"`. Note the surrounding nav and section.

- [ ] **Step 2: Rename nav link + section id**

Replace:

```html
<a href="#sec-operator" data-target="sec-operator">Operator</a>
```

with:

```html
<a href="#sec-operators" data-target="sec-operators">Operators</a>
```

And the section heading:

```html
<section class="settings-section" id="sec-operators">
  <h3 class="settings-section-title">Operators</h3>
  <p class="settings-section-desc">
    Roster of personas the autonomous orchestrator can use. One operator
    is marked default and is used for any tab without an explicit pin.
  </p>
  <div id="operators-pane" class="operators-pane"></div>
</section>
```

Remove the existing `<textarea name="operator_persona">` row, the idle/rate inputs (`name="operator_idle_threshold"`, `name="operator_max_decisions_per_minute"`), and any associated labels inside what used to be `#sec-operator`. The AOM subsection (heading "Autonomous Operator Mode (AOM)") stays — it controls global AOM behavior, not per-operator state.

- [ ] **Step 3: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean (TS will likely flag missing `opPersona` / `opIdle` / `opRate` references in `panel.ts` — fixed in Task 4).

- [ ] **Step 4: Commit**

```bash
git add ui/index.html ui/src/index.html
git commit -m "feat(ui/settings): rename Operator → Operators section + mount point"
```

(Adjust paths if `index.html` lives at root vs. `ui/`.)

---

## Task 3: `OperatorsPane` — list + select skeleton

**Files:**
- Create: `ui/src/settings/operators.ts`

- [ ] **Step 1: Build skeleton with list-only**

```ts
// ui/src/settings/operators.ts
import {
  Operator,
  OperatorDraft,
  operatorCreate,
  operatorDelete,
  operatorList,
  operatorSetDefault,
  operatorUpdate,
} from "../api";

const DEFAULT_DRAFT: OperatorDraft = {
  name: "",
  emoji: "🤖",
  color: "#6B7280",
  tags: [],
  persona: "",
  escalate_threshold: 0.6,
  model: "claude-sonnet-4-6",
  hard_constraints: "",
};

export class OperatorsPane {
  private operators: Operator[] = [];
  private selectedId: string | null = null;
  private dirty = false;
  private editing: OperatorDraft = { ...DEFAULT_DRAFT };

  constructor(private mount: HTMLElement) {
    this.mount.innerHTML = `
      <div class="operators-pane__layout">
        <aside class="operators-pane__list" data-role="list"></aside>
        <section class="operators-pane__editor" data-role="editor"></section>
      </div>
    `;
  }

  async open(): Promise<void> {
    await this.refresh();
  }

  private async refresh(): Promise<void> {
    this.operators = await operatorList();
    if (this.selectedId === null && this.operators.length > 0) {
      this.selectedId = this.operators.find((o) => o.is_default)?.id
        ?? this.operators[0].id;
      this.loadDraftFromSelected();
    }
    this.renderList();
    this.renderEditor();
  }

  private loadDraftFromSelected(): void {
    const sel = this.operators.find((o) => o.id === this.selectedId);
    if (!sel) {
      this.editing = { ...DEFAULT_DRAFT };
      this.dirty = false;
      return;
    }
    this.editing = {
      name: sel.name,
      emoji: sel.emoji,
      color: sel.color,
      tags: [...sel.tags],
      persona: sel.persona,
      escalate_threshold: sel.escalate_threshold,
      model: sel.model,
      hard_constraints: sel.hard_constraints,
    };
    this.dirty = false;
  }

  private renderList(): void {
    const root = this.mount.querySelector<HTMLElement>('[data-role="list"]')!;
    const items = this.operators
      .map((op) => {
        const star = op.is_default ? "⭐" : "";
        const selected = op.id === this.selectedId ? " is-selected" : "";
        return `
          <button class="operators-pane__row${selected}" data-id="${op.id}">
            <span class="operators-pane__row-emoji"
                  style="background:${op.color}">${op.emoji}</span>
            <span class="operators-pane__row-name">${escapeHtml(op.name)}</span>
            <span class="operators-pane__row-star">${star}</span>
          </button>`;
      })
      .join("");
    root.innerHTML = `
      ${items}
      <button class="operators-pane__new" data-role="new">+ New operator</button>
    `;
    root.querySelectorAll<HTMLButtonElement>('.operators-pane__row').forEach((btn) => {
      btn.addEventListener("click", () => this.selectId(btn.dataset.id!));
    });
    root.querySelector<HTMLButtonElement>('[data-role="new"]')!
      .addEventListener("click", () => this.startNew());
  }

  private selectId(id: string): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    this.selectedId = id;
    this.loadDraftFromSelected();
    this.renderList();
    this.renderEditor();
  }

  private startNew(): void {
    if (this.dirty && !confirm("Discard unsaved changes?")) return;
    this.selectedId = null;
    this.editing = { ...DEFAULT_DRAFT };
    this.dirty = true;
    this.renderList();
    this.renderEditor();
  }

  private renderEditor(): void {
    // implemented in Task 4
    const root = this.mount.querySelector<HTMLElement>('[data-role="editor"]')!;
    root.innerHTML = `<p class="muted">editor pending</p>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
```

- [ ] **Step 2: Mount it from `panel.ts`**

In `ui/src/settings/panel.ts`, find the `SettingsPane` constructor / `open` method. After settings are hydrated, instantiate the pane:

```ts
import { OperatorsPane } from "./operators";

// inside the SettingsPane class, in open() after rendering markup:
const opMount = this.root.querySelector<HTMLElement>("#operators-pane");
if (opMount) {
  this.operatorsPane = new OperatorsPane(opMount);
  await this.operatorsPane.open();
}
```

Remove the now-dead references to `opPersona`, `opIdle`, `opRate` and their save logic at lines ~456, ~499–501, ~597–602 (whatever survives after Task 2's HTML edits). Any TypeScript errors from those removals are the signal you got them all.

- [ ] **Step 3: Type-check + smoke**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

Run: `cargo run -p covenant`, open Settings → Operators. Expect: a single `Default` row with ⭐ visible, "+ New operator" button, "editor pending" placeholder on the right.

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/panel.ts
git commit -m "feat(ui/settings): OperatorsPane list skeleton + mount from panel"
```

---

## Task 4: Editor form + create/update path

**Files:**
- Modify: `ui/src/settings/operators.ts`

- [ ] **Step 1: Replace `renderEditor`**

```ts
private renderEditor(): void {
  const root = this.mount.querySelector<HTMLElement>('[data-role="editor"]')!;
  const isNew = this.selectedId === null;
  const sel = this.operators.find((o) => o.id === this.selectedId);
  const isDefault = sel?.is_default ?? false;
  const canDelete = !isNew && !isDefault && this.operators.length > 1;
  const canSetDefault = !isNew && !isDefault;

  root.innerHTML = `
    <header class="operators-pane__editor-head">
      <h4>${isNew ? "New operator" : escapeHtml(sel!.name)}</h4>
      <div class="operators-pane__editor-actions">
        <button data-act="set-default" ${canSetDefault ? "" : "disabled"}>
          Set as default
        </button>
        <button data-act="duplicate" ${isNew ? "disabled" : ""}>
          Duplicate
        </button>
        <button data-act="delete" class="danger" ${canDelete ? "" : "disabled"}>
          Delete
        </button>
      </div>
    </header>

    <div class="operators-pane__field">
      <label>Name</label>
      <input data-bind="name" type="text" maxlength="64"
             value="${escapeHtml(this.editing.name)}" />
    </div>

    <div class="operators-pane__row-2">
      <div class="operators-pane__field">
        <label>Emoji</label>
        <input data-bind="emoji" type="text" maxlength="4"
               value="${escapeHtml(this.editing.emoji)}" />
      </div>
      <div class="operators-pane__field">
        <label>Color</label>
        <input data-bind="color" type="color"
               value="${this.editing.color}" />
      </div>
    </div>

    <div class="operators-pane__field">
      <label>Tags <span class="muted">(comma-separated)</span></label>
      <input data-bind="tags" type="text"
             value="${escapeHtml(this.editing.tags.join(", "))}" />
    </div>

    <div class="operators-pane__field">
      <label>Persona / authorization charter</label>
      <textarea data-bind="persona" rows="14">${escapeHtml(this.editing.persona)}</textarea>
    </div>

    <div class="operators-pane__row-2">
      <div class="operators-pane__field">
        <label>Escalate threshold
          <span class="muted" data-role="threshold-readout">
            ${this.editing.escalate_threshold.toFixed(2)}
          </span>
        </label>
        <input data-bind="escalate_threshold" type="range"
               min="0" max="1" step="0.05"
               value="${this.editing.escalate_threshold}" />
      </div>
      <div class="operators-pane__field">
        <label>Model</label>
        <select data-bind="model">
          <option value="claude-haiku-4-5-20251001"
            ${this.editing.model.startsWith("claude-haiku") ? "selected" : ""}>
            Haiku 4.5
          </option>
          <option value="claude-sonnet-4-6"
            ${this.editing.model.startsWith("claude-sonnet") ? "selected" : ""}>
            Sonnet 4.6
          </option>
          <option value="claude-opus-4-7"
            ${this.editing.model.startsWith("claude-opus") ? "selected" : ""}>
            Opus 4.7
          </option>
        </select>
      </div>
    </div>

    <div class="operators-pane__field">
      <label>Hard constraints
        <span class="muted">(extra ALWAYS-ASK-ME, one per line)</span>
      </label>
      <textarea data-bind="hard_constraints" rows="5"
        >${escapeHtml(this.editing.hard_constraints)}</textarea>
    </div>

    <footer class="operators-pane__editor-foot">
      <button data-act="cancel">Cancel</button>
      <button data-act="save" class="primary">
        ${isNew ? "Create" : "Save"}
      </button>
    </footer>
  `;

  this.wireEditor(root);
}

private wireEditor(root: HTMLElement): void {
  const bind = <K extends keyof OperatorDraft>(name: K, parse: (v: string) => OperatorDraft[K]) => {
    const el = root.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      `[data-bind="${String(name)}"]`,
    );
    el?.addEventListener("input", () => {
      (this.editing as any)[name] = parse(el.value);
      this.dirty = true;
      if (name === "escalate_threshold") {
        const out = root.querySelector<HTMLElement>('[data-role="threshold-readout"]');
        if (out) out.textContent = this.editing.escalate_threshold.toFixed(2);
      }
    });
  };

  bind("name", (v) => v);
  bind("emoji", (v) => v);
  bind("color", (v) => v);
  bind("tags", (v) =>
    v.split(",").map((s) => s.trim()).filter((s) => s.length > 0),
  );
  bind("persona", (v) => v);
  bind("escalate_threshold", (v) => Number.parseFloat(v));
  bind("model", (v) => v);
  bind("hard_constraints", (v) => v);

  root.querySelector<HTMLButtonElement>('[data-act="cancel"]')!
    .addEventListener("click", () => {
      this.loadDraftFromSelected();
      this.renderEditor();
    });

  root.querySelector<HTMLButtonElement>('[data-act="save"]')!
    .addEventListener("click", () => this.save());

  root.querySelector<HTMLButtonElement>('[data-act="set-default"]')
    ?.addEventListener("click", () => this.setDefault());

  root.querySelector<HTMLButtonElement>('[data-act="delete"]')
    ?.addEventListener("click", () => this.deleteSelected());

  root.querySelector<HTMLButtonElement>('[data-act="duplicate"]')
    ?.addEventListener("click", () => this.duplicate());
}

private async save(): Promise<void> {
  if (this.editing.name.trim().length === 0) {
    alert("Name is required.");
    return;
  }
  try {
    if (this.selectedId === null) {
      const created = await operatorCreate(this.editing);
      this.selectedId = created.id;
    } else {
      await operatorUpdate(this.selectedId, this.editing);
    }
    this.dirty = false;
    await this.refresh();
  } catch (e) {
    alert(`Save failed: ${e}`);
  }
}

private async setDefault(): Promise<void> {
  if (this.selectedId === null) return;
  try {
    await operatorSetDefault(this.selectedId);
    await this.refresh();
  } catch (e) {
    alert(`Set default failed: ${e}`);
  }
}

private async deleteSelected(): Promise<void> {
  if (this.selectedId === null) return;
  const name = this.operators.find((o) => o.id === this.selectedId)?.name ?? "?";
  if (!confirm(`Delete operator "${name}"? Tabs pinned to it will fall back to the default.`))
    return;
  try {
    await operatorDelete(this.selectedId);
    this.selectedId = null;
    await this.refresh();
  } catch (e) {
    alert(`Delete failed: ${e}`);
  }
}

private duplicate(): void {
  const sel = this.operators.find((o) => o.id === this.selectedId);
  if (!sel) return;
  this.selectedId = null;
  this.editing = {
    name: `${sel.name} copy`,
    emoji: sel.emoji,
    color: sel.color,
    tags: [...sel.tags],
    persona: sel.persona,
    escalate_threshold: sel.escalate_threshold,
    model: sel.model,
    hard_constraints: sel.hard_constraints,
  };
  this.dirty = true;
  this.renderList();
  this.renderEditor();
}
```

- [ ] **Step 2: Type-check**

Run: `cd ui && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Smoke**

Run: `cargo run -p covenant`, Settings → Operators:

1. Edit Default's persona. Save. Reopen Settings — change persisted.
2. Click "+ New operator". Set name `Sec-Op`, emoji `🛡️`, color red, tags `security, paranoid`, paste a short persona, threshold 0.4, save. Row appears in list.
3. Set as default → ⭐ moves to Sec-Op.
4. Delete Sec-Op → row gone, Default ⭐ comes back.
5. Try deleting Default → button disabled (and command would also reject).

- [ ] **Step 4: Commit**

```bash
git add ui/src/settings/operators.ts
git commit -m "feat(ui/settings): operator editor (create/update/delete/set-default/duplicate)"
```

---

## Task 5: Styles

**Files:**
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Append styles**

At the end of `styles.css`:

```css
/* ----- Settings → Operators ----- */
.operators-pane {
  display: block;
  width: 100%;
}

.operators-pane__layout {
  display: grid;
  grid-template-columns: 240px 1fr;
  gap: 16px;
  min-height: 0;
}

.operators-pane__list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-right: 1px solid var(--border);
  padding-right: 12px;
  overflow-y: auto;
}

.operators-pane__row {
  display: grid;
  grid-template-columns: 28px 1fr 20px;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 6px;
  text-align: left;
  cursor: pointer;
  color: inherit;
  font: inherit;
}
.operators-pane__row:hover { background: var(--bg-panel); }
.operators-pane__row.is-selected {
  background: var(--bg-panel);
  border-color: var(--accent);
}

.operators-pane__row-emoji {
  width: 28px; height: 28px;
  display: inline-flex; align-items: center; justify-content: center;
  border-radius: 6px;
  font-size: 14px;
}
.operators-pane__row-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.operators-pane__row-star { font-size: 12px; }

.operators-pane__new {
  margin-top: 4px;
  padding: 8px 10px;
  background: transparent;
  border: 1px dashed var(--border);
  border-radius: 6px;
  cursor: pointer;
  color: var(--muted);
  font: inherit;
}
.operators-pane__new:hover { color: inherit; border-color: var(--accent); }

.operators-pane__editor {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}

.operators-pane__editor-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.operators-pane__editor-head h4 { margin: 0; }
.operators-pane__editor-actions { display: flex; gap: 6px; }
.operators-pane__editor-actions button {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 4px 8px;
  font-size: 12px;
  color: inherit;
  cursor: pointer;
}
.operators-pane__editor-actions button:disabled {
  opacity: 0.4; cursor: not-allowed;
}
.operators-pane__editor-actions .danger { color: #ef4444; }

.operators-pane__field { display: flex; flex-direction: column; gap: 4px; }
.operators-pane__field label { font-size: 12px; color: var(--muted); }
.operators-pane__field input[type="text"],
.operators-pane__field textarea,
.operators-pane__field select {
  background: var(--bg-overlay);
  color: inherit;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 8px;
  font: inherit;
}
.operators-pane__field textarea { resize: vertical; }
.operators-pane__row-2 {
  display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
}

.operators-pane__editor-foot {
  display: flex; justify-content: flex-end; gap: 8px;
  padding-top: 6px;
  border-top: 1px solid var(--border);
}
.operators-pane__editor-foot button {
  background: transparent;
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 6px 14px;
  color: inherit;
  cursor: pointer;
}
.operators-pane__editor-foot .primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-fg, #fff);
}
```

- [ ] **Step 2: Visual smoke**

Run app, scroll the editor, resize Settings — list scrolls, editor scrolls independently, selected row has accent border.

- [ ] **Step 3: Commit**

```bash
git add ui/src/styles.css
git commit -m "feat(ui/styles): Settings → Operators list + editor styling"
```

---

## Task 6: Final verification

- [ ] **Step 1: Type-check + build**

Run: `cd ui && npx tsc --noEmit && cd .. && cargo check -p covenant`
Expected: clean.

- [ ] **Step 2: Manual regression**

1. Open Settings — `Operators` (plural) appears in nav, replacing `Operator`.
2. Default row is present with 🤖, neutral color, ⭐.
3. CRUD all works (Task 4 smoke list).
4. AOM still triggers correctly (open a tab matching an executor pattern, watch a decision fire — should use the Default operator's persona).

- [ ] **Step 3: Commit any cleanup, push.**

---

## Acceptance criteria (this plan)

- [ ] `Settings → Operator` (singular) is replaced by `Settings → Operators` (plural).
- [ ] Sidebar list shows all operators with ⭐ on default; clicking a row opens the editor with current values.
- [ ] "+ New operator" button creates a fresh draft; Save produces a new row via `operator_create`.
- [ ] Edit + Save updates via `operator_update`; UI re-hydrates from `operator_list` afterwards.
- [ ] Set-as-default button only enabled on non-default rows; clicking moves the ⭐ atomically.
- [ ] Delete button disabled on default; deleting a non-default row removes it and tabs that were pinned to it fall back to default at the next AOM tick.
- [ ] No console errors; `npx tsc --noEmit` and `cargo check -p covenant` clean.

## Open questions

None.
