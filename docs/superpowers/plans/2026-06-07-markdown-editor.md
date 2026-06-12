# MarkdownEditor (Milkdown WYSIWYG) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the raw markdown `<textarea>`s in the operator SOUL editor, Project Notes docs, Hard constraints, and the Spec Creator composer with a reusable, lazy-loaded, theme-aware WYSIWYG editor backed by Milkdown.

**Architecture:** A single vanilla `MarkdownEditor` class (mirroring `CustomSelect` ergonomics) wraps Milkdown. Milkdown + ProseMirror are pulled via dynamic `import()` so the initial bundle is untouched. Formatting is markdown-input-rules only (no toolbar/bubble/slash). Our own CSS skins the ProseMirror surface with Covenant tokens so True Dark / Light work for free.

**Tech Stack:** TypeScript (strict), Milkdown `@milkdown/kit` (ProseMirror), Vite, Vitest + jsdom.

**Note on dependencies:** The repo already ships the full CodeMirror 6 stack (incl. `@codemirror/lang-markdown`). Milkdown is a *different* engine (ProseMirror) and is net-new weight; it was chosen deliberately for true WYSIWYG and is mitigated by lazy loading. Do not try to reuse CodeMirror here.

**Spec:** `docs/superpowers/specs/2026-06-07-markdown-editor-design.md`

**Worktree:** Per project convention, implement on a dedicated git worktree, not on `main`.

---

## File Structure

- **Create** `ui/src/ui/markdown-editor.ts` — the `MarkdownEditor` class.
- **Create** `ui/src/ui/markdown-editor.css` — token-based skin for the ProseMirror surface.
- **Create** `ui/src/ui/markdown-editor.test.ts` — wrapper-contract unit tests.
- **Modify** `ui/src/main.ts` — import the new CSS (follow how other `ui/src/**/*.css` are imported).
- **Modify** `ui/src/project-notes/docs-tab.ts` — swap textarea+marked+toggle for `MarkdownEditor`.
- **Modify** `ui/src/project-notes/styles.css` — drop now-dead `.pn-docs-mode*` rules.
- **Modify** `ui/src/settings/operators.ts` — SOUL body → `MarkdownEditor` + `[editor·.md]` toggle; remove right-pane rendered preview; Hard constraints → `MarkdownEditor` inline.
- **Modify** `ui/src/settings/operator-creator.css` — styles for the editor/source toggle.
- **Modify** `ui/src/spec-chat/immersive.ts` — composer textarea → `MarkdownEditor` inline.
- **Modify** test files that query the replaced textareas: `ui/src/project-notes/*.test.ts`, `ui/src/settings/operators.test.ts`, `ui/src/spec-chat/*.test.ts` (only those that assert on a `<textarea>`).

---

## Task 1: Install Milkdown

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Install the kit**

Run from repo root:
```bash
npm install @milkdown/kit@^7.6.0
```
`@milkdown/kit` re-exports core, the commonmark preset, the listener plugin, utils, and the bundled ProseMirror under `@milkdown/kit/prose/*`. It pulls its ProseMirror peers transitively.

- [ ] **Step 2: Verify it resolves**

Run:
```bash
cd ui && node -e "import('@milkdown/kit/core').then(m=>console.log(!!m.Editor)).catch(e=>{console.error(e);process.exit(1)})"
```
Expected: prints `true`.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "build: add @milkdown/kit for WYSIWYG editor"
```

---

## Task 2: MarkdownEditor wrapper — synchronous contract

The class returns its `element` synchronously and boots Milkdown asynchronously via dynamic import. Value set/read and `destroy()` must work before and after boot. This task covers everything testable without a live ProseMirror.

**Files:**
- Create: `ui/src/ui/markdown-editor.ts`
- Test: `ui/src/ui/markdown-editor.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// ui/src/ui/markdown-editor.test.ts
import { describe, it, expect, vi } from "vitest";

// Stub the Milkdown kit so boot() never touches real ProseMirror in jsdom.
vi.mock("@milkdown/kit/core", () => ({
  Editor: { make: () => { throw new Error("boot-disabled-in-test"); } },
  rootCtx: Symbol("rootCtx"),
  defaultValueCtx: Symbol("defaultValueCtx"),
  editorViewOptionsCtx: Symbol("editorViewOptionsCtx"),
}));
vi.mock("@milkdown/kit/preset/commonmark", () => ({ commonmark: {} }));
vi.mock("@milkdown/kit/plugin/listener", () => ({ listener: {}, listenerCtx: Symbol("listenerCtx") }));
vi.mock("@milkdown/kit/utils", () => ({ getMarkdown: () => () => "", replaceAll: () => () => {} }));

import { MarkdownEditor } from "./markdown-editor";

describe("MarkdownEditor wrapper contract", () => {
  it("creates a mountable element with mode + className", () => {
    const ed = new MarkdownEditor({ value: "hi", mode: "inline", className: "x" });
    expect(ed.element.tagName).toBe("DIV");
    expect(ed.element.classList.contains("md-editor")).toBe(true);
    expect(ed.element.classList.contains("md-editor--inline")).toBe(true);
    expect(ed.element.classList.contains("x")).toBe(true);
  });

  it("defaults to full mode and stores placeholder", () => {
    const ed = new MarkdownEditor({ placeholder: "Write…" });
    expect(ed.element.classList.contains("md-editor--full")).toBe(true);
    expect(ed.element.dataset.placeholder).toBe("Write…");
  });

  it("returns the buffered value before the editor boots", () => {
    const ed = new MarkdownEditor({ value: "## seed" });
    expect(ed.value).toBe("## seed");
  });

  it("buffers value writes made before boot", () => {
    const ed = new MarkdownEditor({ value: "a" });
    ed.value = "b";
    expect(ed.value).toBe("b");
  });

  it("destroy before boot is safe and idempotent", () => {
    const ed = new MarkdownEditor({ value: "a" });
    expect(() => { ed.destroy(); ed.destroy(); }).not.toThrow();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd ui && npx vitest run src/ui/markdown-editor.test.ts`
Expected: FAIL — `Cannot find module './markdown-editor'`.

- [ ] **Step 3: Implement the wrapper**

```ts
// ui/src/ui/markdown-editor.ts
export type MarkdownEditorMode = "full" | "inline";

export interface MarkdownEditorOptions {
  value?: string;
  placeholder?: string;
  mode?: MarkdownEditorMode;
  className?: string;
  onChange?: (markdown: string) => void;
  /** inline mode only: Enter (no shift) calls this instead of inserting a newline. */
  onSubmit?: () => void;
}

/**
 * Lazy WYSIWYG markdown editor over Milkdown. The DOM `element` is available
 * synchronously; Milkdown boots asynchronously via dynamic import, so the heavy
 * ProseMirror bundle is paid only on first use. Value reads/writes and destroy()
 * work before boot completes (buffered).
 */
export class MarkdownEditor {
  readonly element: HTMLElement;

  private readonly opts: MarkdownEditorOptions;
  private buffered: string;
  private destroyed = false;

  // Set once Milkdown is ready.
  private editor: { destroy: () => void } | null = null;
  private getMd: (() => string) | null = null;
  private setMd: ((markdown: string) => void) | null = null;

  constructor(opts: MarkdownEditorOptions) {
    this.opts = opts;
    this.buffered = opts.value ?? "";
    this.element = document.createElement("div");
    this.element.className = [
      "md-editor",
      `md-editor--${opts.mode ?? "full"}`,
      opts.className ?? "",
    ].filter(Boolean).join(" ");
    if (opts.placeholder) this.element.dataset.placeholder = opts.placeholder;
    void this.boot();
  }

  get value(): string {
    return this.getMd ? this.getMd() : this.buffered;
  }

  set value(markdown: string) {
    this.buffered = markdown;
    this.setMd?.(markdown);
  }

  focus(): void {
    this.element.querySelector<HTMLElement>(".ProseMirror")?.focus();
  }

  destroy(): void {
    this.destroyed = true;
    this.editor?.destroy();
    this.editor = null;
    this.getMd = null;
    this.setMd = null;
  }

  private async boot(): Promise<void> {
    const [core, commonmarkMod, listenerMod, utils] = await Promise.all([
      import("@milkdown/kit/core"),
      import("@milkdown/kit/preset/commonmark"),
      import("@milkdown/kit/plugin/listener"),
      import("@milkdown/kit/utils"),
    ]);
    if (this.destroyed) return;

    const { Editor, rootCtx, defaultValueCtx, editorViewOptionsCtx } = core;
    const { commonmark } = commonmarkMod;
    const { listener, listenerCtx } = listenerMod;
    const { getMarkdown, replaceAll } = utils;

    const editor = await Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, this.element);
        ctx.set(defaultValueCtx, this.buffered);
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          if (this.destroyed) return;
          this.buffered = markdown;
          this.opts.onChange?.(markdown);
        });
        if (this.opts.mode === "inline" && this.opts.onSubmit) {
          ctx.update(editorViewOptionsCtx, (prev) => ({
            ...prev,
            handleKeyDown: (_view: unknown, event: KeyboardEvent) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                this.opts.onSubmit?.();
                return true;
              }
              return false;
            },
          }));
        }
      })
      .use(commonmark)
      .use(listener)
      .create();

    if (this.destroyed) { editor.destroy(); return; }

    this.editor = editor;
    this.getMd = () => editor.action(getMarkdown());
    this.setMd = (markdown: string) => editor.action(replaceAll(markdown));
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd ui && npx vitest run src/ui/markdown-editor.test.ts`
Expected: PASS (5 tests). The mocked `Editor.make()` throws inside `boot()`, but the rejection is swallowed by `void this.boot()`; the synchronous contract is unaffected. If the unhandled rejection warning fails the run, wrap the body of `boot()` in `try { … } catch { /* surfaced via app, not tests */ }`.

- [ ] **Step 5: Commit**

```bash
git add ui/src/ui/markdown-editor.ts ui/src/ui/markdown-editor.test.ts
git commit -m "feat(ui): MarkdownEditor wrapper over Milkdown (lazy, contract-tested)"
```

---

## Task 3: MarkdownEditor skin (Covenant tokens)

**Files:**
- Create: `ui/src/ui/markdown-editor.css`
- Modify: `ui/src/main.ts` (add the CSS import next to other UI css imports)

- [ ] **Step 1: Write the stylesheet**

```css
/* ui/src/ui/markdown-editor.css — token-based skin so Milkdown follows the
   active theme (incl. True Dark). We deliberately do NOT load Milkdown's theme. */
.md-editor {
  position: relative;
  width: 100%;
  background: var(--bg-overlay, #0c0d10);
  color: var(--text, #e6e8eb);
  border: 1px solid var(--border, #1c2027);
  border-radius: 10px;
}
.md-editor .ProseMirror {
  outline: none;
  padding: 12px 14px;
  min-height: 64px;
  font-family: var(--sans, -apple-system, system-ui, sans-serif);
  font-size: 14px;
  line-height: 1.55;
  caret-color: var(--accent, #7aa2f7);
}
.md-editor--full .ProseMirror { min-height: 240px; }
.md-editor--inline .ProseMirror { min-height: 22px; max-height: 180px; overflow-y: auto; }
.md-editor:focus-within { border-color: var(--accent, #7aa2f7); }

/* Empty-state placeholder (ProseMirror leaves the doc empty; we paint it). */
.md-editor .ProseMirror.ProseMirror-empty::before,
.md-editor .ProseMirror p.is-empty:first-child::before {
  content: attr(data-placeholder);
  color: var(--muted, #6c7280);
  pointer-events: none;
  height: 0;
  float: left;
}
.md-editor .ProseMirror h1 { font-size: 1.5em; font-weight: 700; margin: 0.4em 0; }
.md-editor .ProseMirror h2 { font-size: 1.25em; font-weight: 700; margin: 0.4em 0; }
.md-editor .ProseMirror h3 { font-size: 1.1em; font-weight: 600; margin: 0.4em 0; }
.md-editor .ProseMirror ul,
.md-editor .ProseMirror ol { padding-left: 1.4em; margin: 0.3em 0; }
.md-editor .ProseMirror blockquote {
  border-left: 2px solid var(--border, #2a2d35);
  margin: 0.4em 0; padding-left: 0.8em; color: var(--muted, #8a8aa8);
}
.md-editor .ProseMirror code {
  font-family: var(--mono, ui-monospace, Menlo, monospace);
  font-size: 0.92em;
  background: rgba(var(--ink-rgb, 255 255 255), 0.06);
  padding: 1px 5px; border-radius: 5px;
}
```

Note: Milkdown sets `data-placeholder` on the empty paragraph only if the placeholder plugin is used; we are not using it. Instead we forward the option onto the host (`.md-editor[data-placeholder]`). Update the empty-state selector to read from the host:

```css
.md-editor[data-placeholder] .ProseMirror.ProseMirror-empty::before {
  content: attr(data-placeholder);
}
```
(Replace the two `content: attr(...)` selectors above with this single host-based one.)

- [ ] **Step 2: Import the CSS**

In `ui/src/main.ts`, alongside the other `import "./**/*.css";` lines, add:
```ts
import "./ui/markdown-editor.css";
```
Run: `cd ui && grep -n "markdown-editor.css" src/main.ts`
Expected: prints the new import line.

- [ ] **Step 3: Commit**

```bash
git add ui/src/ui/markdown-editor.css ui/src/main.ts
git commit -m "feat(ui): theme-aware skin for MarkdownEditor"
```

---

## Task 4: Wire into Project Notes docs (simplest call site)

Replace textarea + `marked` preview + edit/preview toggle with one `MarkdownEditor`.

**Files:**
- Modify: `ui/src/project-notes/docs-tab.ts`
- Modify: `ui/src/project-notes/styles.css` (remove dead `.pn-docs-mode*`/`.pn-docs-modes` rules)
- Test: `ui/src/project-notes/*.test.ts` (whichever asserts the textarea)

- [ ] **Step 1: Replace the DocsTab body**

Rewrite `ui/src/project-notes/docs-tab.ts` to:

```ts
import { projectNotesApi } from "./api";
import { MarkdownEditor } from "../ui/markdown-editor";

export interface DocsTabOpts {
  groupId: string;
}

export class DocsTab {
  private container: HTMLElement;
  private editor: MarkdownEditor;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private opts: DocsTabOpts) {
    this.container = document.createElement("div");
    this.container.className = "pn-docs-tab";

    this.editor = new MarkdownEditor({
      mode: "full",
      placeholder: "# Project docs\n\nMarkdown supported.",
      onChange: () => { this.dirty = true; this.scheduleSave(); },
    });
    this.container.appendChild(this.editor.element);
  }

  mount(parent: HTMLElement): this {
    parent.appendChild(this.container);
    void this.load();
    return this;
  }

  private async load(): Promise<void> {
    try {
      const body = await projectNotesApi.getDocs(this.opts.groupId);
      this.editor.value = body;
      this.dirty = false;
    } catch (err) {
      console.error("docs load failed", err);
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.flush(); }, 500);
  }

  private async flush(): Promise<void> {
    if (!this.dirty) return;
    try {
      await projectNotesApi.saveDocs(this.opts.groupId, this.editor.value);
      this.dirty = false;
    } catch (err) {
      console.error("docs save failed", err);
    }
  }
}
```

- [ ] **Step 2: Remove dead toggle CSS**

In `ui/src/project-notes/styles.css`, delete the `.pn-docs-modes` and all `.pn-docs-mode*` rule blocks (the icon-toggle styling — no longer referenced). Keep `.pn-docs-tab`, `.pn-docs-editor`/`.pn-docs-textarea`, and `.pn-docs-preview` only if still referenced elsewhere; otherwise remove `.pn-docs-preview` too.

Run: `cd ui && grep -rn "pn-docs-mode" src` → expect no matches.

- [ ] **Step 3: Fix the docs-tab tests**

Open the failing project-notes test(s) and replace textarea assertions. Example shape:
```ts
// before: const ta = host.querySelector("textarea");
// after:
const editor = host.querySelector(".md-editor");
expect(editor).not.toBeNull();
```
Drop any assertion about edit/preview mode buttons.

- [ ] **Step 4: Run the project-notes tests**

Run: `cd ui && npx vitest run src/project-notes`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/project-notes/docs-tab.ts ui/src/project-notes/styles.css ui/src/project-notes
git commit -m "feat(project-notes): WYSIWYG docs editor; drop edit/preview toggle"
```

---

## Task 5: Wire into operator SOUL body + editor/source toggle

Replace `op-soul-body` textarea with `MarkdownEditor` (full). Add a small `[ editor · .md ]` header toggle swapping the WYSIWYG for a raw body-markdown textarea. Remove the right-pane rendered preview; keep the collapsible full "SOUL.md source".

**Files:**
- Modify: `ui/src/settings/operators.ts`
- Modify: `ui/src/settings/operator-creator.css`
- Test: `ui/src/settings/operators.test.ts`

- [ ] **Step 1: Replace the body editor construction**

In `buildSoulEditor` (`ui/src/settings/operators.ts`, ~line 1054) replace the `body` textarea with the editor + a raw fallback + a toggle. Add the import at the top (next to `CustomSelect`):
```ts
import { MarkdownEditor } from "../ui/markdown-editor";
```
Then where `const body = document.createElement("textarea"); body.className = "op-soul-body"; …` is defined, replace with:
```ts
// WYSIWYG body editor (+ raw markdown fallback behind a toggle).
const bodyWrap = document.createElement("div");
bodyWrap.className = "op-soul-bodywrap";

const bodyToggle = document.createElement("div");
bodyToggle.className = "op-soul-bodytoggle";
const tEditor = document.createElement("button");
tEditor.type = "button"; tEditor.className = "op-soul-bodytoggle-btn is-active";
tEditor.textContent = "editor";
const tSource = document.createElement("button");
tSource.type = "button"; tSource.className = "op-soul-bodytoggle-btn";
tSource.textContent = ".md";
bodyToggle.append(tEditor, tSource);

const bodyEditor = new MarkdownEditor({
  mode: "full",
  placeholder: "Write this operator's soul — who it is, how it judges, what it will never do without you.",
  onChange: (md) => { view.body = md; rawBody.value = md; commit(false); },
});

const rawBody = document.createElement("textarea");
rawBody.className = "op-soul-body op-soul-body--raw";
rawBody.spellcheck = false;
rawBody.style.display = "none";
rawBody.addEventListener("input", () => { view.body = rawBody.value; bodyEditor.value = rawBody.value; commit(false); });

function setBodyMode(raw: boolean): void {
  tEditor.classList.toggle("is-active", !raw);
  tSource.classList.toggle("is-active", raw);
  bodyEditor.element.style.display = raw ? "none" : "";
  rawBody.style.display = raw ? "" : "none";
}
tEditor.addEventListener("click", () => setBodyMode(false));
tSource.addEventListener("click", () => setBodyMode(true));

bodyWrap.append(bodyToggle, bodyEditor.element, rawBody);
```
Wherever the old `body` textarea was appended into the section, append `bodyWrap` instead. Wherever the old code set `body.value = view.body` (seeding), set both: `bodyEditor.value = view.body ?? ""; rawBody.value = view.body ?? "";`. Search for remaining `body.value`/`body.addEventListener`/`.op-soul-body"` references and update or remove them.

- [ ] **Step 2: Remove the right-pane rendered preview**

In the same file, delete the `preview` element (`op-soul-preview`), the `renderPreview()` function, the dynamic `marked` import inside the soul editor, and any call sites that invoke `renderPreview()`. Keep `rawDetails`/`src` (`op-soul-rawwrap` / `op-soul-source`) — the full SOUL.md source — intact, and keep `errLine`. In `mountLive`, append only the raw source (+ error), not the preview.

Run: `cd ui && grep -n "renderPreview\|op-soul-preview\|markedFn" src/settings/operators.ts`
Expected: no matches.

- [ ] **Step 3: Style the toggle (True-Dark friendly)**

Append to `ui/src/settings/operator-creator.css`:
```css
.op-creator .op-soul-bodywrap { display: flex; flex-direction: column; gap: 8px; }
.op-creator .op-soul-bodytoggle { display: inline-flex; gap: 4px; align-self: flex-start; }
.op-creator .op-soul-bodytoggle-btn {
  background: transparent; border: 0; cursor: pointer;
  color: var(--muted, #8a8aa8);
  font-family: var(--mono, ui-monospace, Menlo, monospace);
  font-size: 10.5px; text-transform: lowercase; letter-spacing: 0.04em;
  padding: 3px 8px; border-radius: 6px;
}
.op-creator .op-soul-bodytoggle-btn:hover { color: var(--text, #e6e8eb); background: rgba(var(--ink-rgb, 255 255 255), 0.05); }
.op-creator .op-soul-bodytoggle-btn.is-active { color: var(--accent, #7aa2f7); }
.op-creator .op-soul-body--raw {
  width: 100%; min-height: 240px; resize: vertical;
  background: var(--bg-overlay, #0a0a0a); color: var(--text, #d7dae6);
  border: 1px solid var(--border, #1a1a1a); border-radius: 8px; padding: 12px 14px;
  font-family: var(--mono, ui-monospace, Menlo, monospace); font-size: 13px;
}
```

- [ ] **Step 4: Fix the operators tests**

In `ui/src/settings/operators.test.ts`, replace any `.op-soul-body` textarea assertions with `.op-soul-bodywrap` / `.md-editor` presence, and drop assertions about `.op-soul-preview`.

- [ ] **Step 5: Run the operators tests**

Run: `cd ui && npx vitest run src/settings/operators`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/settings/operator-creator.css ui/src/settings/operators.test.ts
git commit -m "feat(operators): WYSIWYG SOUL body + editor/.md toggle; drop preview pane"
```

---

## Task 6: Wire Hard constraints (inline)

**Files:**
- Modify: `ui/src/settings/operators.ts`

- [ ] **Step 1: Replace the hard-constraints textarea**

In `buildSoulEditor`, where `hc` (`op-soul-hard` textarea, ~line 1260) is created and wired, replace with:
```ts
const hcEditor = new MarkdownEditor({
  mode: "inline",
  placeholder: "Extra deny rules — one per line.",
  value: view.hard_constraints ?? "",
  onChange: (md) => { view.hard_constraints = md; commit(false); },
});
hcEditor.element.classList.add("op-soul-hard");
```
Append `hcEditor.element` wherever the old `hc` textarea was appended. Update the seeding (`hc.value = …`) to `hcEditor.value = view.hard_constraints ?? ""` and remove the old `hc.addEventListener`. The `adv.open` logic stays.

- [ ] **Step 2: Typecheck + test**

Run: `cd ui && npx tsc --noEmit && npx vitest run src/settings/operators`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/settings/operators.ts
git commit -m "feat(operators): WYSIWYG hard-constraints editor"
```

---

## Task 7: Wire the Spec composer (inline, Enter=send)

**Files:**
- Modify: `ui/src/spec-chat/immersive.ts`
- Test: `ui/src/spec-chat/*.test.ts` (only if a test queries the composer `textarea`)

- [ ] **Step 1: Replace the composer textarea**

In `ui/src/spec-chat/immersive.ts`:
- Remove the `<textarea …>` from the `.box` template string (keep the spark svg and `.send` button).
- After the markup is mounted, construct the editor and define `submit()` against it. Add the import at the top: `import { MarkdownEditor } from '../ui/markdown-editor';`.

Replace the `const ta = …; const submit = …; …keydown…; grow` block (lines ~81-98) with:
```ts
const boxEl = root.querySelector('.box') as HTMLElement;
const composer = new MarkdownEditor({
  mode: 'inline',
  placeholder: 'Describe the problem, paste an error, or name the feature…',
  onSubmit: () => submit(),
});
boxEl.insertBefore(composer.element, root.querySelector('.send'));

const submit = () => {
  const text = composer.value.trim();
  if (!text) return;
  composer.value = '';
  state.addUserMessage(text);
  void opts.source
    .send(draftId, text, opts.cwd)
    .then((id) => { draftId = id; })
    .catch((err) => state.apply({ kind: 'error', message: String(err?.message ?? err) }));
};
(root.querySelector('.send') as HTMLElement).addEventListener('click', submit);
```
Update the starter-chip handler (line ~113) from `ta.value = s; ta.focus(); grow(); submit();` to:
```ts
chip.addEventListener('click', () => { composer.value = s; composer.focus(); submit(); });
```
Remove the now-unused `grow` function and its listener.

- [ ] **Step 2: Typecheck**

Run: `cd ui && npx tsc --noEmit`
Expected: no errors. Fix any leftover `ta` references.

- [ ] **Step 3: Fix spec-chat tests if needed**

Run: `cd ui && npx vitest run src/spec-chat`
If a test queries `textarea` in the composer, switch it to `.md-editor`. Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add ui/src/spec-chat/immersive.ts ui/src/spec-chat
git commit -m "feat(spec-chat): WYSIWYG composer (Enter=send)"
```

---

## Task 8: Full verification

- [ ] **Step 1: Typecheck + full test run**

Run: `cd ui && npx tsc --noEmit && npm run test`
Expected: clean typecheck; all suites PASS.

- [ ] **Step 2: Manual smoke (real ProseMirror)**

Respawn the app (`respawn` skill or `npm run tauri:dev`). Verify in each surface:
- Typing `## ` makes a heading; `- ` makes a bullet; `**x**` bolds; ⌘B/⌘I work.
- Project Notes docs persists across tab switches.
- Operator SOUL: editor↔`.md` toggle keeps content in sync; Save changes round-trips; the collapsible SOUL.md source still shows YAML front-matter.
- Hard constraints edits persist.
- Spec composer: Enter sends, Shift+Enter newlines, starter chips submit.
- Toggle Settings → Appearance → **True Dark**: all four editors are neutral black (no blue tint).

- [ ] **Step 3: Final commit (if manual fixes were needed)**

```bash
git add -A
git commit -m "fix(markdown-editor): manual-smoke fixes"
```

---

## Self-Review notes

- **Spec coverage:** component (T2/T3), theming (T3), operator body+toggle+preview-removal (T5), docs (T4), hard constraints (T6), spec composer (T7), testing (T2/T4/T5/T8), risks (lazy import T1/T2, normalization documented, Enter keymap T2/T7). All spec sections mapped.
- **Type consistency:** `MarkdownEditor` API (`element`, `value` get/set, `focus`, `destroy`, options `mode`/`onChange`/`onSubmit`/`placeholder`/`value`/`className`) is used identically across T4–T7.
- **Placeholders:** none — every code step shows full code.
- **Open risk:** Milkdown's empty-paragraph placeholder mechanism differs from a textarea's; T3 paints the placeholder from the host `data-placeholder`. If Milkdown's empty class differs in the installed version, adjust the selector during T8 manual smoke.
