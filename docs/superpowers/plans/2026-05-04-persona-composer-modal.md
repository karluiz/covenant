# Persona Composer Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an 85% × 85% modal editor with shipped templates for the operator's "Persona / authorization charter" field, matching the Convergence overlay's visual language.

**Architecture:** A self-contained `PersonaComposerModal` class owns its DOM, takes `(initial, onSave)`, and writes back via the host textarea's `input` event so the existing OperatorsPane save pipeline activates unchanged. Templates are a hardcoded array of 6 entries. The Convergence overlay's Esc-button kbd styling is refactored into shared `.modal-cancel-btn` / `.modal-kbd` classes that both modals consume.

**Tech Stack:** TypeScript (strict), Vite, vitest with jsdom, plain CSS (no framework).

**Spec:** `docs/superpowers/specs/2026-05-04-persona-composer-modal-design.md`

---

## File Structure

- `ui/src/operator/persona-templates.ts` — **NEW.** Exports `OPERATOR_PERSONA_TEMPLATES`, a frozen readonly array of `{ name, persona }` entries. Pure data, no imports.
- `ui/src/operator/persona-composer.ts` — **NEW.** `PersonaComposerModal` class. Public surface: constructor, `open(initial, onSave)`, `close()`. Owns its DOM (created on first `open`, hidden between opens). Listens on `window` for keydown only while open.
- `ui/src/operator/persona-composer.test.ts` — **NEW.** vitest jsdom tests for the modal.
- `ui/src/icons/index.ts` — **MODIFY.** Add `maximize` icon (Lucide `maximize-2` SVG) used as the trigger icon.
- `ui/src/settings/operators.ts` — **MODIFY.** Inject the expand button into the persona field (line ~183), instantiate one `PersonaComposerModal` per `OperatorsPane`, wire click → `composer.open(textarea.value, …)`.
- `ui/src/styles.css` — **MODIFY.** Add `.persona-composer-*` rules. Extract shared `.modal-cancel-btn` / `.modal-kbd` from `.convergence-overlay__exit*` and update `convergence/overlay.ts` to use the shared classes (Convergence's Exit button must not regress).

---

## Task 1: Add `maximize` icon + extract shared modal-kbd classes

**Files:**
- Modify: `ui/src/icons/index.ts`
- Modify: `ui/src/styles.css`
- Modify: `ui/src/convergence/overlay.ts`

- [ ] **Step 1: Add the icon**

Open `ui/src/icons/index.ts`. Find the icon table (entries like `terminal:`, `folder:`). Add this entry alongside the others (alphabetically near `lightbulb`):

```ts
  maximize: (o?: IconOptions): string =>
    svg(
      o,
      `<polyline points="15 3 21 3 21 9"/>` +
      `<polyline points="9 21 3 21 3 15"/>` +
      `<line x1="21" y1="3" x2="14" y2="10"/>` +
      `<line x1="3" y1="21" x2="10" y2="14"/>`,
    ),
```

(Mirrors Lucide `maximize-2`. Use the same `svg()` helper the file already uses; if it isn't named `svg`, follow the existing entries' construction pattern verbatim.)

- [ ] **Step 2: Extract shared modal-kbd CSS**

Open `ui/src/styles.css`. Locate `.convergence-overlay__exit` (~line 5908) and `.convergence-overlay__exit-kbd`. Replace those rules with the following:

```css
/* Generic modal cancel button + keycap. Used by Convergence overlay
   and the Persona Composer modal so they share visual language. */
.modal-cancel-btn {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  color: var(--fg, inherit);
  padding: 6px 10px 6px 14px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.modal-cancel-btn:hover { border-color: var(--accent); }
.modal-cancel-btn:hover .modal-kbd {
  color: #c8ccd2;
  border-color: rgba(255, 255, 255, 0.12);
}

.modal-kbd {
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 10px;
  letter-spacing: 0.02em;
  color: color-mix(in srgb, var(--muted) 80%, transparent);
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 4px;
  padding: 2px 5px;
  line-height: 1;
}

/* Backwards-compatible aliases — Convergence Exit button. */
.convergence-overlay__exit { /* alias of .modal-cancel-btn */ }
.convergence-overlay__exit-kbd { /* alias of .modal-kbd */ }
```

(The aliases are empty rules; they exist purely to keep the old class name as a marker if anyone greps for it.)

- [ ] **Step 3: Update Convergence overlay to apply the shared classes**

Open `ui/src/convergence/overlay.ts`. Find the Exit button construction (~line 84):

```ts
    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "convergence-overlay__exit";
    exit.title = "Close (Esc)";
    exit.innerHTML = `<span>Exit</span><kbd class="convergence-overlay__exit-kbd">Esc</kbd>`;
```

Replace with:

```ts
    const exit = document.createElement("button");
    exit.type = "button";
    exit.className = "convergence-overlay__exit modal-cancel-btn";
    exit.title = "Close (Esc)";
    exit.innerHTML = `<span>Exit</span><kbd class="modal-kbd">Esc</kbd>`;
```

- [ ] **Step 4: Run tests + typecheck**

```bash
npx tsc --noEmit
npm test
```

Expected: typecheck clean, all 86 tests still pass.

- [ ] **Step 5: Commit**

```bash
git add ui/src/icons/index.ts ui/src/styles.css ui/src/convergence/overlay.ts
git commit -m "refactor(ui): extract shared modal-cancel-btn + modal-kbd CSS classes"
```

---

## Task 2: Persona templates module + tests

**Files:**
- Create: `ui/src/operator/persona-templates.ts`
- Create: `ui/src/operator/persona-templates.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/operator/persona-templates.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { OPERATOR_PERSONA_TEMPLATES } from "./persona-templates";

describe("OPERATOR_PERSONA_TEMPLATES", () => {
  it("ships exactly 6 templates", () => {
    expect(OPERATOR_PERSONA_TEMPLATES).toHaveLength(6);
  });

  it("each template has a non-empty name and persona", () => {
    for (const t of OPERATOR_PERSONA_TEMPLATES) {
      expect(t.name.trim().length).toBeGreaterThan(0);
      expect(t.persona.trim().length).toBeGreaterThan(20);
    }
  });

  it("template names are unique", () => {
    const names = OPERATOR_PERSONA_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes the canonical Cautious senior baseline", () => {
    const names = OPERATOR_PERSONA_TEMPLATES.map((t) => t.name);
    expect(names).toContain("Cautious senior");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- persona-templates
```

Expected: FAIL with "Cannot find module './persona-templates'".

- [ ] **Step 3: Implement the templates module**

Create `ui/src/operator/persona-templates.ts`:

```ts
export interface PersonaTemplate {
  readonly name: string;
  readonly persona: string;
}

const CAUTIOUS_SENIOR = `I'm a senior engineer who delegates trivial decisions and wants to
sleep through routine agent prompts.

ALWAYS-YES (when no destructive flags appear):
- "run tests" / "cargo test" / "yarn test" / "pytest" / "npm test"
- "should I commit?" — yes, if the branch is not main or master
- "subagent: Sonnet or Opus?" — Sonnet (cheaper)
- "fix N lint errors?" / "format the file?" — yes
- "shall we continue?" / "proceed?" / "ready to move on?" — yes
- "should I add a test for this?" — yes
- "use approach A or B?" — pick the simpler one and document briefly
- inline edits vs subagent dispatch — inline for one-file changes

ESCALATE on:
- production deploys, k8s apply, terraform apply
- API key, secret, .env changes
- estimated cost over $5 in API calls
- architectural decisions (which framework, db, language)
- refactors larger than ~100 lines
- migrations, schema changes

STYLE:
- terse, no apologies
- when escalating, give me one sentence on what's blocking and why you're not confident
- when answering, output exactly the keystrokes the executor expects (e.g. "y\\n", "1\\n", "yes\\n")`;

const YOLO_AUTOPILOT = `Throughput-first autopilot. Answer yes on every routine prompt.
Only escalate when an action would be irreversible at the OS level.

ALWAYS-YES:
- any test, build, lint, format, type-check
- any commit, branch creation, stash, rebase on a feature branch
- any package install, dependency upgrade, lockfile regeneration
- any file edit, file rename, directory creation
- "subagent: which model?" — cheapest available
- "use approach A or B?" — pick A and move on

ESCALATE only on:
- rm -rf with a path outside the repo
- force-push to main / master / production branches
- any operation requiring sudo
- secret or credential changes

STYLE:
- one-token answers when possible ("y", "1", "yes")
- never explain unless asked`;

const SPEC_DRIVEN = `Spec-driven operator. Answer based on what the active plan or spec
documents. Escalate when no plan covers the next step.

ALWAYS-YES (when the next action is documented in a plan/spec):
- the action matches the next unchecked step in docs/superpowers/plans/*
- a test the spec asked for is being added
- a refactor the spec scoped is being executed

ESCALATE when:
- no plan is active in this session
- the agent's next move diverges from the plan's next step
- the agent proposes adding scope the plan didn't authorize

STYLE:
- when answering, cite the plan path and step that authorizes the action
- when escalating, name the plan section that doesn't cover this`;

const READ_ONLY_AUDITOR = `Pure observer mode. Never inject keystrokes — always escalate so the
human decides.

For every prompt:
- escalate with a one-paragraph analysis of what the agent is asking,
  what the likely correct answer is, and what risks you see
- never produce a y/n keystroke
- if the question is trivially safe (e.g. "run tests?"), still escalate
  but flag it as low-risk so the human can answer in one keystroke

STYLE:
- structured analysis: Question / Likely answer / Risks / Recommendation
- never speak first-person on behalf of the user`;

const JUNIOR_PAIR = `Friendly conservative pair. Slower throughput, more questions, more
explanation. Bias toward escalating ambiguous decisions.

ALWAYS-YES on:
- read-only commands (ls, cat, git status, git diff)
- test runs, lint runs

ESCALATE on:
- any write to disk
- any commit
- any package install
- anything not explicitly listed above

STYLE:
- when escalating, explain in plain language what the agent is about to
  do, what could go wrong, and what you'd do if you were sure
- prefer asking a clarifying question to guessing`;

const DEBUGGER = `Test-failure focus. Treat every escalation as a debugging signal.

ALWAYS-YES on:
- re-running a failing test
- adding a print/log statement to narrow down a failure
- reverting an experimental change
- bisecting (git bisect, manual binary search)

ESCALATE with structured detail when:
- a test fails — include: which assertion, expected vs. actual, last
  green commit if you can identify it
- a build breaks — include: the exact compiler/linker error and the
  file:line it points at
- the agent is about to skip a failing test or mark it as expected-fail

STYLE:
- failure first: lead the escalation message with the assertion that
  failed, then the surrounding context
- never accept "intermittent" — always ask for the seed/timing detail`;

export const OPERATOR_PERSONA_TEMPLATES: readonly PersonaTemplate[] =
  Object.freeze([
    { name: "Cautious senior", persona: CAUTIOUS_SENIOR },
    { name: "YOLO autopilot", persona: YOLO_AUTOPILOT },
    { name: "Spec-driven", persona: SPEC_DRIVEN },
    { name: "Read-only auditor", persona: READ_ONLY_AUDITOR },
    { name: "Junior pair", persona: JUNIOR_PAIR },
    { name: "Debugger", persona: DEBUGGER },
  ]);
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- persona-templates
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/operator/persona-templates.ts ui/src/operator/persona-templates.test.ts
git commit -m "feat(operator): ship 6 persona templates for the composer modal"
```

---

## Task 3: PersonaComposerModal class + tests

**Files:**
- Create: `ui/src/operator/persona-composer.ts`
- Create: `ui/src/operator/persona-composer.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/operator/persona-composer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonaComposerModal } from "./persona-composer";
import { OPERATOR_PERSONA_TEMPLATES } from "./persona-templates";

describe("PersonaComposerModal", () => {
  let modal: PersonaComposerModal;

  beforeEach(() => {
    modal = new PersonaComposerModal();
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("attaches to body and shows the initial text on open", () => {
    modal.open("hello world", () => {});
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    );
    expect(ta).not.toBeNull();
    expect(ta!.value).toBe("hello world");
  });

  it("renders one pill per shipped template", () => {
    modal.open("", () => {});
    const pills = document.querySelectorAll(".persona-composer__template");
    expect(pills.length).toBe(OPERATOR_PERSONA_TEMPLATES.length);
  });

  it("loading a template into an empty editor replaces text without confirm", () => {
    modal.open("", () => {});
    const confirmSpy = vi.spyOn(window, "confirm");
    const firstPill = document.querySelector<HTMLButtonElement>(
      ".persona-composer__template",
    );
    firstPill!.click();
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    )!;
    expect(ta.value).toBe(OPERATOR_PERSONA_TEMPLATES[0].persona);
    expect(confirmSpy).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it("loading a template into non-empty editor prompts confirm", () => {
    modal.open("existing content", () => {});
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const firstPill = document.querySelector<HTMLButtonElement>(
      ".persona-composer__template",
    );
    firstPill!.click();
    expect(confirmSpy).toHaveBeenCalledOnce();
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    )!;
    expect(ta.value).toBe(OPERATOR_PERSONA_TEMPLATES[0].persona);
    confirmSpy.mockRestore();
  });

  it("declined confirm leaves text untouched", () => {
    modal.open("existing content", () => {});
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    const firstPill = document.querySelector<HTMLButtonElement>(
      ".persona-composer__template",
    );
    firstPill!.click();
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    )!;
    expect(ta.value).toBe("existing content");
    confirmSpy.mockRestore();
  });

  it("Save fires onSave with current text and removes modal from DOM", () => {
    const onSave = vi.fn();
    modal.open("initial", onSave);
    const ta = document.querySelector<HTMLTextAreaElement>(
      ".persona-composer__textarea",
    )!;
    ta.value = "edited";
    const saveBtn = document.querySelector<HTMLButtonElement>(
      ".persona-composer__save",
    )!;
    saveBtn.click();
    expect(onSave).toHaveBeenCalledWith("edited");
    expect(document.querySelector(".persona-composer")).toBeNull();
  });

  it("Esc closes without firing onSave", () => {
    const onSave = vi.fn();
    modal.open("initial", onSave);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onSave).not.toHaveBeenCalled();
    expect(document.querySelector(".persona-composer")).toBeNull();
  });

  it("Cmd+S triggers save", () => {
    const onSave = vi.fn();
    modal.open("foo", onSave);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "s", metaKey: true }),
    );
    expect(onSave).toHaveBeenCalledWith("foo");
    expect(document.querySelector(".persona-composer")).toBeNull();
  });

  it("backdrop click does NOT close", () => {
    const onSave = vi.fn();
    modal.open("foo", onSave);
    const backdrop = document.querySelector<HTMLElement>(
      ".persona-composer__backdrop",
    )!;
    backdrop.click();
    expect(document.querySelector(".persona-composer")).not.toBeNull();
    expect(onSave).not.toHaveBeenCalled();
  });

  it("Esc keydown handler is removed after close", () => {
    const onSave = vi.fn();
    modal.open("foo", onSave);
    const closeBtn = document.querySelector<HTMLButtonElement>(
      ".persona-composer__cancel",
    )!;
    closeBtn.click();
    // Now no modal in DOM. Dispatching Escape must not throw nor call onSave.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onSave).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- persona-composer
```

Expected: FAIL with "Cannot find module './persona-composer'".

- [ ] **Step 3: Implement the modal class**

Create `ui/src/operator/persona-composer.ts`:

```ts
import { Icons } from "../icons";
import {
  OPERATOR_PERSONA_TEMPLATES,
  type PersonaTemplate,
} from "./persona-templates";

type SaveHandler = (text: string) => void;

/**
 * Fullscreen-ish modal for editing the operator persona / authorization
 * charter. Owns its DOM. The host (OperatorsPane) calls `open` with the
 * current textarea value and a callback; the modal writes the edited
 * text back via the callback on Save and closes itself on Save or Cancel.
 *
 * The modal does NOT touch the operator persistence layer — that's the
 * host's job. This keeps the widget unit-testable in isolation.
 */
export class PersonaComposerModal {
  private root: HTMLElement | null = null;
  private textarea: HTMLTextAreaElement | null = null;
  private onSave: SaveHandler | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  open(initial: string, onSave: SaveHandler): void {
    if (this.root) this.close();
    this.onSave = onSave;
    this.root = this.buildDom(initial);
    document.body.appendChild(this.root);
    this.keydownHandler = (e) => this.handleKeydown(e);
    window.addEventListener("keydown", this.keydownHandler);
    // Focus the textarea so the user can start typing immediately.
    requestAnimationFrame(() => this.textarea?.focus());
  }

  close(): void {
    if (this.keydownHandler) {
      window.removeEventListener("keydown", this.keydownHandler);
      this.keydownHandler = null;
    }
    this.root?.remove();
    this.root = null;
    this.textarea = null;
    this.onSave = null;
  }

  private save(): void {
    if (!this.textarea || !this.onSave) return;
    const text = this.textarea.value;
    const cb = this.onSave;
    this.close();
    cb(text);
  }

  private handleKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      this.save();
      return;
    }
  }

  private buildDom(initial: string): HTMLElement {
    const root = document.createElement("div");
    root.className = "persona-composer";

    const backdrop = document.createElement("div");
    backdrop.className = "persona-composer__backdrop";
    // Backdrop click does NOT close (prevents accidental data loss).
    root.appendChild(backdrop);

    const panel = document.createElement("div");
    panel.className = "persona-composer__panel";
    root.appendChild(panel);

    panel.appendChild(this.buildHeader());
    panel.appendChild(this.buildTemplatesRow());
    panel.appendChild(this.buildEditor(initial));
    panel.appendChild(this.buildFooter());

    return root;
  }

  private buildHeader(): HTMLElement {
    const header = document.createElement("header");
    header.className = "persona-composer__header";

    const title = document.createElement("h2");
    title.className = "persona-composer__title";
    title.textContent = "PERSONA / AUTHORIZATION CHARTER";

    const actions = document.createElement("div");
    actions.className = "persona-composer__actions";

    const save = document.createElement("button");
    save.type = "button";
    save.className = "persona-composer__save";
    save.textContent = "Save";
    save.addEventListener("click", () => this.save());

    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "persona-composer__cancel modal-cancel-btn";
    cancel.title = "Cancel (Esc)";
    cancel.innerHTML = `<span>Cancel</span><kbd class="modal-kbd">Esc</kbd>`;
    cancel.addEventListener("click", () => this.close());

    actions.append(save, cancel);
    header.append(title, actions);
    return header;
  }

  private buildTemplatesRow(): HTMLElement {
    const row = document.createElement("div");
    row.className = "persona-composer__templates";

    const label = document.createElement("span");
    label.className = "persona-composer__templates-label";
    label.textContent = "Templates:";
    row.appendChild(label);

    for (const t of OPERATOR_PERSONA_TEMPLATES) {
      row.appendChild(this.buildTemplatePill(t));
    }
    return row;
  }

  private buildTemplatePill(template: PersonaTemplate): HTMLElement {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "persona-composer__template";
    pill.textContent = template.name;
    pill.addEventListener("click", () => this.loadTemplate(template));
    return pill;
  }

  private loadTemplate(template: PersonaTemplate): void {
    if (!this.textarea) return;
    const current = this.textarea.value.trim();
    if (current.length > 0) {
      const ok = window.confirm("Overwrite current persona?");
      if (!ok) return;
    }
    this.textarea.value = template.persona;
    this.textarea.focus();
  }

  private buildEditor(initial: string): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "persona-composer__editor";

    const ta = document.createElement("textarea");
    ta.className = "persona-composer__textarea";
    ta.value = initial;
    ta.spellcheck = false;
    ta.autocapitalize = "off";
    ta.autocomplete = "off";
    this.textarea = ta;

    wrap.appendChild(ta);
    return wrap;
  }

  private buildFooter(): HTMLElement {
    const footer = document.createElement("footer");
    footer.className = "persona-composer__footer";
    const modKey = navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";
    footer.innerHTML =
      `<kbd class="modal-kbd">${modKey}S</kbd> save · ` +
      `<kbd class="modal-kbd">Esc</kbd> cancel`;
    return footer;
  }
}

void Icons; // silence unused-import warning if Icons isn't referenced yet
```

Note: the `void Icons` line is there because the import isn't strictly needed in this file — remove the `import` and the `void Icons` line if your linter complains. (The icon is used by `OperatorsPane`, not the modal itself.)

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- persona-composer
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add ui/src/operator/persona-composer.ts ui/src/operator/persona-composer.test.ts
git commit -m "feat(operator): PersonaComposerModal with templates, kbd shortcuts, tests"
```

---

## Task 4: Wire modal into OperatorsPane + CSS

**Files:**
- Modify: `ui/src/settings/operators.ts`
- Modify: `ui/src/styles.css`

- [ ] **Step 1: Add the modal CSS**

Open `ui/src/styles.css`. Add at the bottom of the file (before the last `}` if any are dangling — append cleanly):

```css
/* ── Persona composer modal ─────────────────────────── */

.persona-composer {
  position: fixed;
  inset: 0;
  z-index: 9000;
  display: grid;
  place-items: center;
  pointer-events: auto;
}

.persona-composer__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(4px);
}

.persona-composer__panel {
  position: relative;
  width: 85vw;
  height: 85vh;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  padding: 16px 20px 14px;
  gap: 12px;
  color: var(--fg);
}

.persona-composer__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.persona-composer__title {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--muted);
}

.persona-composer__actions {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.persona-composer__save {
  background: var(--accent, #3b82f6);
  color: #fff;
  border: 1px solid transparent;
  border-radius: 6px;
  padding: 6px 14px;
  cursor: pointer;
  font: inherit;
  font-weight: 600;
}
.persona-composer__save:hover { filter: brightness(1.1); }

.persona-composer__templates {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.persona-composer__templates-label {
  font-size: 11px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
  margin-right: 4px;
}

.persona-composer__template {
  background: var(--bg-panel);
  border: 1px solid var(--border);
  color: var(--fg);
  padding: 4px 10px;
  border-radius: 999px;
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: border-color 0.12s ease-out, color 0.12s ease-out;
}
.persona-composer__template:hover {
  border-color: var(--accent);
  color: #fff;
}

.persona-composer__editor {
  flex: 1 1 auto;
  display: flex;
  min-height: 0;
}

.persona-composer__textarea {
  flex: 1 1 auto;
  resize: none;
  background: var(--bg-panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--fg);
  padding: 12px 14px;
  font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
  font-size: 13px;
  line-height: 1.5;
  outline: none;
}
.persona-composer__textarea:focus {
  border-color: var(--accent);
}

.persona-composer__footer {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--muted);
}
```

- [ ] **Step 2: Add the expand button + wire the modal in OperatorsPane**

Open `ui/src/settings/operators.ts`. Read the file fully to confirm import paths.

At the top of the file, with the other imports, add:

```ts
import { PersonaComposerModal } from "../operator/persona-composer";
import { Icons } from "../icons";
```

Inside `class OperatorsPane`, add a private field next to the other fields:

```ts
  private composer = new PersonaComposerModal();
```

Locate the persona field block (currently around line 183):

```ts
      <div class="operators-pane__field">
        <label>Persona / authorization charter</label>
        <textarea data-bind="persona" rows="14">${escapeHtml(this.editing.persona)}</textarea>
      </div>
```

Replace with:

```ts
      <div class="operators-pane__field operators-pane__field--persona">
        <label>
          Persona / authorization charter
          <button type="button" class="operators-pane__persona-expand"
                  data-role="persona-expand" title="Expand editor">
            ${Icons.maximize({ size: 14 })}
          </button>
        </label>
        <textarea data-bind="persona" rows="14">${escapeHtml(this.editing.persona)}</textarea>
      </div>
```

Now find the function that runs after the editor HTML is rendered and bindings are wired (search for `bind("persona"` — around line 271 — and find the surrounding render method). At the end of that method (just before its closing brace, after the `bind` calls complete), add:

```ts
    const expandBtn = this.mount.querySelector<HTMLButtonElement>(
      '[data-role="persona-expand"]',
    );
    const personaTextarea = this.mount.querySelector<HTMLTextAreaElement>(
      'textarea[data-bind="persona"]',
    );
    if (expandBtn && personaTextarea) {
      expandBtn.onclick = () => {
        this.composer.open(personaTextarea.value, (next) => {
          personaTextarea.value = next;
          // Fire 'input' so the existing data-bind plumbing picks up
          // the change and marks the form dirty.
          personaTextarea.dispatchEvent(new Event("input", { bubbles: true }));
        });
      };
    }
```

(If a similar wire-up pattern exists for other field actions, follow that pattern instead. Read `renderEditor` end-to-end first; do not blindly paste at the function tail if it would land outside the binding-installation phase.)

- [ ] **Step 3: Add CSS for the expand button**

Append to `ui/src/styles.css`:

```css
/* Persona-field expand button — opens PersonaComposerModal. */
.operators-pane__field--persona > label {
  display: flex;
  align-items: center;
  gap: 8px;
}

.operators-pane__persona-expand {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  width: 22px;
  height: 22px;
  border-radius: 4px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  padding: 0;
  transition: color 0.12s ease-out, border-color 0.12s ease-out;
}
.operators-pane__persona-expand:hover {
  color: #fff;
  border-color: var(--accent);
}
.operators-pane__persona-expand svg {
  display: block;
}
```

- [ ] **Step 4: Typecheck + tests + visual smoke**

```bash
npx tsc --noEmit
npm test
```

Expected: typecheck clean, all tests pass (existing 86 + 4 + 9 = 99).

Then build + install:

```bash
./scripts/install.sh --open
```

In the running app:
1. Open `Settings → Operators`. Pick any operator.
2. The persona field now shows a small expand icon next to the label.
3. Click the icon — modal opens at 85% × 85%.
4. Title reads `PERSONA / AUTHORIZATION CHARTER`.
5. Templates row shows 6 pills.
6. Click `YOLO autopilot` with a non-empty editor — confirm appears.
7. Edit text, press ⌘S — modal closes, text persists in the underlying form (mark form dirty).
8. Re-open, press Esc — modal closes, no save.
9. Open Convergence Mode (⌘⇧M) — Exit button still styled identically.

If anything visual fails, fix in the same task before commit.

- [ ] **Step 5: Commit**

```bash
git add ui/src/settings/operators.ts ui/src/styles.css
git commit -m "feat(operator): wire PersonaComposerModal into Settings → Operators"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Trigger button → Task 4 Step 2.
  - Modal layout (85% × 85%, backdrop, header, templates row, editor, footer hint) → Task 3 + Task 4 CSS.
  - Backdrop click does nothing → Task 3 (no listener) + asserted in test.
  - Templates: 6 hardcoded → Task 2.
  - Save semantics (writes back to host textarea + dispatches `input`) → Task 4 Step 2.
  - Cancel discards → Task 3 (Esc/Cancel does not call `onSave`).
  - Esc / ⌘S keybindings → Task 3.
  - Shared kbd styling with Convergence → Task 1.
  - Acceptance criteria (visual, behavior, no Convergence regression) → Task 4 visual smoke.
- **No placeholders:** all CSS values, file paths, code snippets are concrete.
- **Type consistency:** `PersonaTemplate`, `SaveHandler`, modal class API used identically across Tasks 2–4.
- **Risk:** `void Icons` line in `persona-composer.ts` is a guard against an unused import. Remove the `import { Icons }` and the `void Icons` line if the implementer doesn't end up using `Icons` in that file (they currently don't — the icon is consumed in `operators.ts`). The plan is intentionally permissive here so the implementer can drop it cleanly.
