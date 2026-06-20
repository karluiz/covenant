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
