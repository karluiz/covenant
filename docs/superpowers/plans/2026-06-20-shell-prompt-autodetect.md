# Shell-prompt autodetect → super-agent — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a terminal tab is a bare shell (no executor running), live-detect a natural-language line as the user types and offer to route it to the ⌘K super-agent panel instead of running it.

**Architecture:** One new frontend module (`prompt-detect.ts`) holding a pure classifier plus a tiny DOM overlay controller. It reuses `RecallManager`'s existing shadow line-buffer (no new keystroke parsing). Detection + Enter-interception run in the terminal's `onData` handler; ⌘I override runs in the existing custom-key handler. Routing goes through a new `TabManager.onAskAgent` callback wired in `main.ts` to `AgentPanel.openWithSeed`. No Rust changes.

**Tech Stack:** TypeScript (strict), xterm.js, Vitest, existing Tauri command wrappers.

## Global Constraints

- TypeScript `strict: true` — no implicit `any`, no `as any` without a justifying comment.
- All UI chrome copy in **English**.
- Never use `element.title=` for tooltips (not needed here, but the rule stands).
- Tests + typecheck run from the **repo root** (this worktree root), not `ui/`.
- This work lives in the worktree `/Users/carlosgallardoarenas/Sources/karlTerminal-autodetect` on branch `feat/shell-prompt-autodetect`.
- Worst-case behavior must stay non-destructive: never auto-execute, never lose typed input. The only side effect on a misfire is opening the ⌘K panel.

## Prerequisite (once, before Task 1)

The worktree has no `node_modules` yet. From the worktree root:

```bash
npm install
```

Verify: `npx vitest run ui/src/spec-chat/prose.test.ts` runs (any existing test passing is fine).

## File Structure

- **Create** `ui/src/terminal/prompt-detect.ts` — `looksLikePrompt(line)`, `shouldHint(inputs)` (pure), and `mountPromptHint(host, term)` (DOM overlay controller).
- **Create** `ui/src/terminal/prompt-detect.test.ts` — classifier + `shouldHint` tables + a jsdom controller smoke test.
- **Modify** `ui/src/recall/manager.ts` — add `currentLine()` and `isVisible()` getters.
- **Modify** `ui/src/tabs/manager.ts` — add `onAskAgent` field; mount the hint; wire `onData` eval + Enter intercept; wire ⌘I in the custom-key handler; reset on `prompt_start`; dispose on teardown.
- **Modify** `ui/src/main.ts` — `manager.onAskAgent = (seed) => agent.openWithSeed(seed)`.
- **Modify** `ui/src/styles.css` — `.prompt-hint` overlay styles.

---

### Task 1: Classifier + gate decision (pure functions)

**Files:**
- Create: `ui/src/terminal/prompt-detect.ts`
- Test: `ui/src/terminal/prompt-detect.test.ts`

**Interfaces:**
- Produces:
  - `looksLikePrompt(line: string): boolean`
  - `shouldHint(i: { bareShell: boolean; recallVisible: boolean; line: string }): boolean`

- [ ] **Step 1: Write the failing test**

Create `ui/src/terminal/prompt-detect.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { looksLikePrompt, shouldHint } from "./prompt-detect";

describe("looksLikePrompt", () => {
  it("detects natural-language / question lines", () => {
    for (const s of [
      "how to reload env",
      "what is this?",
      "why did it fail",
      "how do i undo this",
      "can you explain the error",
      "tell me the current branch",
    ]) {
      expect(looksLikePrompt(s), s).toBe(true);
    }
  });

  it("ignores real commands and shell syntax", () => {
    for (const s of [
      "git status",
      "npm run dev",
      "ls -la",
      "./build.sh",
      "make",
      "FOO=bar cmd",
      "htop",
      "cd ~/src",
      "cat a | grep b",
      "echo $HOME",
      "",
    ]) {
      expect(looksLikePrompt(s), s).toBe(false);
    }
  });
});

describe("shouldHint", () => {
  it("is true only on a bare shell, with Recall hidden, for prose", () => {
    expect(shouldHint({ bareShell: true, recallVisible: false, line: "how to x" })).toBe(true);
    expect(shouldHint({ bareShell: false, recallVisible: false, line: "how to x" })).toBe(false);
    expect(shouldHint({ bareShell: true, recallVisible: true, line: "how to x" })).toBe(false);
    expect(shouldHint({ bareShell: true, recallVisible: false, line: "git status" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/terminal/prompt-detect.test.ts`
Expected: FAIL — `Failed to resolve import "./prompt-detect"` / functions not defined.

- [ ] **Step 3: Write minimal implementation**

Create `ui/src/terminal/prompt-detect.ts` (pure functions only — the controller is added in Task 2):

```ts
// Heuristic detection of a natural-language line typed at a bare shell
// prompt, so we can offer to route it to the super-agent instead of the
// shell. Deliberately conservative: triggers on clear question/prose
// shapes and avoids colliding with real command names.

const QUESTION_WORDS = new Set([
  "how", "what", "why", "when", "where", "who", "which", "whats", "hows",
  "can", "could", "should", "would", "is", "are", "do", "does",
]);
const TWO_WORD_OPENERS = ["tell me", "show me", "give me", "help me", "how to"];
const SHELL_META = /[|&;<>$()`=]/;

export function looksLikePrompt(line: string): boolean {
  const s = line.trim();
  if (!s) return false;
  const words = s.split(/\s+/);
  if (words.length < 2) return false; // single token is never prose
  if (SHELL_META.test(s)) return false; // pipes, redirects, subshells, var-assign
  const first = words[0]!;
  if (/[/.~]/.test(first)) return false; // paths / ./script / ~/x
  if (s.endsWith("?")) return true;
  const lower = s.toLowerCase();
  if (TWO_WORD_OPENERS.some((o) => lower === o || lower.startsWith(o + " "))) return true;
  return QUESTION_WORDS.has(first.toLowerCase());
  // ponytail: heuristic only, no PATH resolution. Misses imperative prose
  // (refactor/fix/make…) to avoid colliding with real binaries. Upgrade =
  // a backend `command -v` check.
}

export interface HintInputs {
  bareShell: boolean;
  recallVisible: boolean;
  line: string;
}

/** Pure gate: show the hint only on a bare shell, when Recall isn't already
 *  claiming the sidebar, and the line reads as prose. */
export function shouldHint(i: HintInputs): boolean {
  return i.bareShell && !i.recallVisible && looksLikePrompt(i.line);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run ui/src/terminal/prompt-detect.test.ts`
Expected: PASS (2 files? no — 1 file, all assertions green).

- [ ] **Step 5: Commit**

```bash
git add ui/src/terminal/prompt-detect.ts ui/src/terminal/prompt-detect.test.ts
git commit -m "feat(autodetect): prose classifier + hint gate (pure)"
```

---

### Task 2: Hint overlay controller

**Files:**
- Modify: `ui/src/terminal/prompt-detect.ts`
- Modify: `ui/src/terminal/prompt-detect.test.ts`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: `import type { Terminal } from "@xterm/xterm"`.
- Produces:
  - `interface PromptHint { readonly shown: boolean; overridden: boolean; readonly line: string; update(show: boolean, line: string): void; override(): void; reset(): void; dispose(): void; }`
  - `mountPromptHint(host: HTMLElement, term: Terminal): PromptHint`

- [ ] **Step 1: Write the failing test**

Append to `ui/src/terminal/prompt-detect.test.ts`:

```ts
import { mountPromptHint } from "./prompt-detect";
import type { Terminal } from "@xterm/xterm";

// Minimal Terminal stub: only the fields mountPromptHint reads for anchoring.
const fakeTerm = (): Terminal =>
  ({
    buffer: { active: { cursorY: 0 } },
    _core: { _renderService: { dimensions: { css: { cell: { width: 9, height: 17 } } } } },
  } as unknown as Terminal);

describe("mountPromptHint", () => {
  it("starts hidden, shows on update(true,...), hides on update(false,...)", () => {
    const host = document.createElement("div");
    const hint = mountPromptHint(host, fakeTerm());
    const el = host.querySelector(".prompt-hint") as HTMLElement;
    expect(el).toBeTruthy();
    expect(el.hidden).toBe(true);
    expect(hint.shown).toBe(false);

    hint.update(true, "how to reload env");
    expect(hint.shown).toBe(true);
    expect(hint.line).toBe("how to reload env");
    expect(el.hidden).toBe(false);
    expect(el.textContent).toContain("super-agent");

    hint.update(false, "");
    expect(hint.shown).toBe(false);
    expect(el.hidden).toBe(true);

    hint.dispose();
    expect(host.querySelector(".prompt-hint")).toBeNull();
  });

  it("override() hides and sets overridden; reset() clears it", () => {
    const host = document.createElement("div");
    const hint = mountPromptHint(host, fakeTerm());
    hint.update(true, "what is this");
    hint.override();
    expect(hint.overridden).toBe(true);
    expect(hint.shown).toBe(false);
    hint.reset();
    expect(hint.overridden).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run ui/src/terminal/prompt-detect.test.ts`
Expected: FAIL — `mountPromptHint` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `ui/src/terminal/prompt-detect.ts`:

```ts
import type { Terminal } from "@xterm/xterm";

export interface PromptHint {
  readonly shown: boolean;
  overridden: boolean;
  readonly line: string;
  /** Show or hide the hint; when showing, capture `line` and reposition. */
  update(show: boolean, line: string): void;
  /** ⌘I: user wants the line run literally — hide + remember for this line. */
  override(): void;
  /** prompt_start: new prompt, clear per-line state. */
  reset(): void;
  dispose(): void;
}

export function mountPromptHint(host: HTMLElement, term: Terminal): PromptHint {
  const el = document.createElement("div");
  el.className = "prompt-hint";
  el.hidden = true;
  // Pointer-events off so it never blocks terminal interaction.
  el.innerHTML =
    `<kbd>↵</kbd> ask the super-agent ` +
    `<span class="prompt-hint-sep">·</span> <kbd>⌘I</kbd> run literally`;
  host.appendChild(el);

  let shown = false;
  let overridden = false;
  let line = "";

  const reposition = (): void => {
    // ponytail: reads xterm's private renderer cell dimensions to anchor under
    // the cursor row. Falls back to sane defaults if the internal shape moves.
    const core = (term as unknown as {
      _core?: { _renderService?: { dimensions?: { css?: { cell?: { height?: number } } } } };
    })._core;
    const cellH = core?._renderService?.dimensions?.css?.cell?.height ?? 17;
    const cy = term.buffer.active.cursorY;
    el.style.top = `${(cy + 1) * cellH + 4}px`;
    el.style.left = `8px`;
  };

  return {
    get shown() { return shown; },
    get line() { return line; },
    get overridden() { return overridden; },
    set overridden(v: boolean) { overridden = v; },
    update(show: boolean, nextLine: string): void {
      if (show && !overridden) {
        line = nextLine;
        reposition();
        el.hidden = false;
        shown = true;
      } else {
        el.hidden = true;
        shown = false;
      }
    },
    override(): void {
      overridden = true;
      el.hidden = true;
      shown = false;
    },
    reset(): void {
      overridden = false;
      line = "";
      el.hidden = true;
      shown = false;
    },
    dispose(): void {
      el.remove();
    },
  };
}
```

- [ ] **Step 4: Add styles**

In `ui/src/styles.css`, add (near other terminal-overlay styles):

```css
/* Ensure overlays anchor to the terminal pane. */
.tab-terminal { position: relative; }

/* Warp-style prose autodetect hint, anchored under the cursor row. */
.prompt-hint {
  position: absolute;
  z-index: 6;
  pointer-events: none;
  font-size: 12px;
  line-height: 1;
  color: var(--text-secondary, #8a8f98);
  background: color-mix(in srgb, var(--bg-elev, #1b1d24) 88%, transparent);
  border: 1px solid var(--line-soft, #2a2d37);
  border-radius: 7px;
  padding: 5px 9px;
  white-space: nowrap;
}
.prompt-hint kbd {
  font-family: inherit;
  font-size: 11px;
  color: var(--text-primary, #eef0f7);
  background: var(--bg-base, #0e0f13);
  border: 1px solid var(--line-soft, #2a2d37);
  border-radius: 4px;
  padding: 1px 5px;
}
.prompt-hint-sep { opacity: 0.5; margin: 0 2px; }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run ui/src/terminal/prompt-detect.test.ts`
Expected: PASS — all describe blocks green.

- [ ] **Step 6: Commit**

```bash
git add ui/src/terminal/prompt-detect.ts ui/src/terminal/prompt-detect.test.ts ui/src/styles.css
git commit -m "feat(autodetect): cursor-anchored hint overlay controller"
```

---

### Task 3: Recall getters + `onAskAgent` plumbing

**Files:**
- Modify: `ui/src/recall/manager.ts`
- Modify: `ui/src/tabs/manager.ts` (add public field only)
- Modify: `ui/src/main.ts`

**Interfaces:**
- Produces:
  - `RecallManager.currentLine(): string` — trimmed shadow buffer
  - `RecallManager.isVisible(): boolean`
  - `TabManager.onAskAgent: ((seed: string) => void) | null`

- [ ] **Step 1: Add the Recall getters**

In `ui/src/recall/manager.ts`, alongside the other public methods (e.g. right after `notifyPromptStart()`), add:

```ts
  /// The current best-effort shell line (shadow buffer), trimmed. Used by
  /// shell-prompt autodetect — see ui/src/terminal/prompt-detect.ts.
  currentLine(): string {
    return this.buffer.trim();
  }

  /// Whether the Recall sidebar is currently showing results.
  isVisible(): boolean {
    return this.visible;
  }
```

- [ ] **Step 2: Add the TabManager callback field**

In `ui/src/tabs/manager.ts`, next to `public onActiveExecutorChange` (around line 1578), add:

```ts
  /// Fired when shell-prompt autodetect routes a prose line to the
  /// super-agent. main.ts wires this to AgentPanel.openWithSeed.
  public onAskAgent: ((seed: string) => void) | null = null;
```

- [ ] **Step 3: Wire it in main.ts**

In `ui/src/main.ts`, immediately after `const agent = new AgentPanel(...)` (around line 1381), add:

```ts
  manager.onAskAgent = (seed) => agent.openWithSeed(seed);
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no errors. (No behavior wired yet; this just compiles the new surface.)

- [ ] **Step 5: Commit**

```bash
git add ui/src/recall/manager.ts ui/src/tabs/manager.ts ui/src/main.ts
git commit -m "feat(autodetect): Recall currentLine/isVisible getters + onAskAgent callback"
```

---

### Task 4: Wire detection into the terminal session

**Files:**
- Modify: `ui/src/tabs/manager.ts`

**Interfaces:**
- Consumes: `mountPromptHint`, `shouldHint` (Task 1–2); `recall.currentLine()`, `recall.isVisible()`, `this.onAskAgent` (Task 3); existing `activePane(tab)`, `writeToSession`, `encoder`, `term`, `sessionId`, `tabRef`.

- [ ] **Step 1: Import the module**

At the top of `ui/src/tabs/manager.ts`, near the `mountWelcomeHint` import (line 25), add:

```ts
import { mountPromptHint, shouldHint } from "../terminal/prompt-detect";
```

- [ ] **Step 2: Mount the hint controller**

In the main spawn path, right after the `mountWelcomeHint(paneHost0, term)` line (around line 3007), add:

```ts
    // Warp-style prose autodetect: a live hint that offers to route a
    // natural-language line at a bare shell to the super-agent. Anchored to
    // the terminal pane; updated from onData below.
    const promptHint = mountPromptHint(termHost, term);
```

- [ ] **Step 3: Replace the onData handler body with intercept + eval**

Find the main-path `term.onData` handler (around line 3601):

```ts
    const dataDispose = term.onData((data) => {
      void writeToSession(sessionId, encoder.encode(data)).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("write failed", e),
      );
      if (!tabRef.current || !activePane(tabRef.current).executor) {
        recall?.notifyInput(data);
      }
    });
```

Replace it with:

```ts
    const dataDispose = term.onData((data) => {
      const tab = tabRef.current;
      const bare = !!tab && !activePane(tab).executor;
      // Intercept Enter while the autodetect hint is showing: clear the typed
      // shell line and route it to the super-agent instead of running it.
      if (data === "\r" && promptHint.shown && !promptHint.overridden) {
        const line = promptHint.line;
        void writeToSession(sessionId, encoder.encode("\x15")).catch((e) =>
          // eslint-disable-next-line no-console
          console.error("clear-line write failed", e),
        );
        this.onAskAgent?.(line);
        promptHint.reset();
        return; // do NOT forward the carriage return to the shell
      }
      void writeToSession(sessionId, encoder.encode(data)).catch((e) =>
        // eslint-disable-next-line no-console
        console.error("write failed", e),
      );
      if (bare) {
        recall?.notifyInput(data);
        // Re-evaluate with the freshly-updated shadow buffer.
        const line = recall?.currentLine() ?? "";
        promptHint.update(
          shouldHint({ bareShell: true, recallVisible: !!recall?.isVisible(), line }),
          line,
        );
      } else {
        promptHint.update(false, "");
      }
    });
```

- [ ] **Step 4: Wire ⌘I override in the custom-key handler**

In the `term.attachCustomKeyEventHandler((ev) => { ... })` block (around line 3621), add this branch immediately before the final `return true;`:

```ts
      // ⌘I overrides the prose-autodetect hint: run the line literally.
      // (Cmd shortcuts emit no onData byte, so we catch it here. Ctrl+I is
      // Tab, so we require metaKey and exclude ctrl/alt.)
      if (
        ev.type === "keydown" &&
        ev.metaKey &&
        !ev.ctrlKey &&
        !ev.altKey &&
        ev.key.toLowerCase() === "i" &&
        promptHint.shown
      ) {
        promptHint.override();
        ev.preventDefault();
        return false;
      }
```

- [ ] **Step 5: Reset on prompt_start**

In the main-path `onSessionEvent` handler, find the `prompt_start` case that calls `recall?.notifyPromptStart()` (around line 3139) and add a reset right after it:

```ts
            if (event.kind === "prompt_start") {
              recall?.notifyPromptStart();
              promptHint.reset();
```

(Keep the existing `initialCmdPending` logic that follows inside this branch unchanged.)

- [ ] **Step 6: Dispose on teardown**

Find where `dataDispose` is disposed (search `dataDispose` for its `.dispose()` call in the pane teardown) and add alongside it:

```ts
    promptHint.dispose();
```

- [ ] **Step 7: Typecheck**

Run: `npx tsc --noEmit`
Expected: PASS — no errors.

- [ ] **Step 8: Run the full prompt-detect test file**

Run: `npx vitest run ui/src/terminal/prompt-detect.test.ts`
Expected: PASS.

- [ ] **Step 9: Manual verification (in-app)**

Use the `respawn` skill (or `npm run tauri:dev`) to launch the app, then:
1. Open a fresh terminal tab (bare shell, no executor).
2. Type `how to reload env` — the hint `↵ ask the super-agent · ⌘I run literally` appears under the cursor row.
3. Press **Enter** — the shell line clears (Ctrl-U) and the ⌘K panel opens prefilled with `how to reload env`. Nothing runs in the shell.
4. Type `how to reload env` again, press **⌘I**, then **Enter** — it runs literally (`command not found: how`), no panel.
5. Type `git status` — no hint; Enter runs it normally.
6. Run `claude` (or any executor); while it holds the PTY, type prose — no hint appears.

- [ ] **Step 10: Commit**

```bash
git add ui/src/tabs/manager.ts
git commit -m "feat(autodetect): live prose hint + Enter→super-agent routing in terminal"
```

---

## Self-Review

**Spec coverage:**
- Component 1 (reuse Recall buffer) → Task 3 getters + Task 4 eval. ✓
- Component 2 (gate: bare shell, Recall hidden, non-empty) → `shouldHint` Task 1, applied Task 4. ✓
- Component 3 (`looksLikePrompt`) → Task 1. ✓
- Component 4 (hint overlay, ⌘I, Enter intercept, Ctrl-U clear, openWithSeed) → Task 2 controller + Task 4 wiring. ✓
- Routing to ⌘K panel → `onAskAgent` Task 3 + Task 4. ✓
- Testing section → Task 1 tables, Task 2 controller smoke test; `currentLine()` getter is a trivial one-liner (no dedicated test, per the spec's "one-line test" note folded into typecheck). ✓
- Safety (fail-toward-hidden, non-destructive) → intercept guarded by `promptHint.shown && !overridden`, which only holds for a clean non-empty prose buffer. ✓

**Placeholder scan:** none — every step has concrete code or an exact command.

**Type consistency:** `mountPromptHint(host, term)` / `PromptHint` / `shouldHint({bareShell,recallVisible,line})` / `currentLine()` / `isVisible()` / `onAskAgent` are spelled identically across Tasks 1–4. ✓

## Out of scope (v1)

- PATH/alias resolution for imperative prose (`refactor this`).
- Multi-line / pasted prose (Recall marks its buffer untrusted → no hint).
- Split-pane and restore terminal paths — only the main spawn path is wired (it's the one that mounts `welcome-hint` / `recall` today). Extending to the other paths is a follow-up.
- Windows key handling (M8).
