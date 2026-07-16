// In-terminal find overlay. Cmd+F opens a floating search bar inside
// the active tab's pane (top-right, matching the tooltip aesthetic).
// Backed by @xterm/addon-search; the addon highlights every match and
// scrolls the active one into view.
//
// Controls:
//   Enter         → next match
//   Shift+Enter   → previous match
//   Esc / blur ✕  → close (clears highlights)
//   ⌥ buttons     → prev/next siblings of the input, mirrors macOS Terminal

import type { Terminal } from "@xterm/xterm";
import type { SearchAddon, ISearchOptions } from "@xterm/addon-search";
import { formatChord } from "../platform";

const SEARCH_ICON_SVG =
  '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

export interface TerminalFinderOptions {
  // Defaults: { regex: false, caseSensitive: false, wholeWord: false }
  // The current values are reused across find* calls so the toggles
  // persist while the bar is open (and are reset when closed).
  initial?: Partial<ISearchOptions>;
}

const SEARCH_OPTS_BASE: ISearchOptions = {
  regex: false,
  caseSensitive: false,
  wholeWord: false,
  incremental: true,
};

export class TerminalFinder {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private counter: HTMLElement;
  private opts: ISearchOptions;
  private resultDecorations: { resultIndex: number; resultCount: number } = {
    resultIndex: -1,
    resultCount: 0,
  };
  private opened = false;

  constructor(
    private host: HTMLElement,
    private term: Terminal,
    private addon: SearchAddon,
    options: TerminalFinderOptions = {},
  ) {
    this.opts = { ...SEARCH_OPTS_BASE, ...(options.initial ?? {}) };

    this.root = document.createElement("div");
    this.root.className = "term-finder";
    this.root.setAttribute("role", "search");
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="term-finder__field">
        <span class="term-finder__icon">${SEARCH_ICON_SVG}</span>
        <input class="term-finder__input" type="search" spellcheck="false"
               autocapitalize="off" autocorrect="off" placeholder="Find" />
        <span class="term-finder__counter" aria-live="polite"></span>
        <button class="term-finder__clear" type="button" aria-label="Clear" tabindex="-1">×</button>
      </div>
      <div class="term-finder__nav">
        <button class="term-finder__btn" data-act="prev" type="button" aria-label="Previous match" title="Previous (${formatChord(["shift", "enter"])})">‹</button>
        <button class="term-finder__btn" data-act="next" type="button" aria-label="Next match" title="Next (${formatChord(["enter"])})">›</button>
      </div>
      <button class="term-finder__done" type="button">Done</button>
    `;

    this.input = this.root.querySelector(".term-finder__input") as HTMLInputElement;
    this.counter = this.root.querySelector(".term-finder__counter") as HTMLElement;

    this.host.appendChild(this.root);

    // Subscribe to result-count updates from the addon so the
    // "3 of 27" counter stays in sync with incremental searches.
    this.addon.onDidChangeResults((res) => {
      if (!res) {
        this.resultDecorations = { resultIndex: -1, resultCount: 0 };
      } else {
        this.resultDecorations = {
          resultIndex: res.resultIndex,
          resultCount: res.resultCount,
        };
      }
      this.renderCounter();
    });

    this.input.addEventListener("input", () => this.search("incremental"));
    this.input.addEventListener("keydown", (e) => this.onKeyDown(e));
    (this.root.querySelector(".term-finder__clear") as HTMLElement).addEventListener(
      "click",
      () => {
        this.input.value = "";
        this.search("incremental");
        this.input.focus();
      },
    );
    (this.root.querySelector('[data-act="prev"]') as HTMLElement).addEventListener(
      "click",
      () => this.next(-1),
    );
    (this.root.querySelector('[data-act="next"]') as HTMLElement).addEventListener(
      "click",
      () => this.next(+1),
    );
    (this.root.querySelector(".term-finder__done") as HTMLElement).addEventListener(
      "click",
      () => this.close(),
    );
  }

  /** Open or focus the finder. If text is selected in the terminal,
   * preload it as the query — matches macOS Terminal's behavior. */
  open(): void {
    if (!this.opened) {
      this.root.hidden = false;
      this.opened = true;
    }
    const sel = this.term.getSelection?.();
    if (sel && sel.length > 0 && sel.length < 256 && !sel.includes("\n")) {
      this.input.value = sel;
      this.search("incremental");
    } else if (this.input.value) {
      this.search("incremental");
    }
    requestAnimationFrame(() => {
      this.input.focus();
      this.input.select();
    });
  }

  close(): void {
    if (!this.opened) return;
    this.opened = false;
    this.root.hidden = true;
    try {
      this.addon.clearDecorations();
    } catch {
      /* noop */
    }
    this.term.focus();
  }

  isOpen(): boolean {
    return this.opened;
  }

  /** Called from TabManager when the tab is closed. */
  dispose(): void {
    this.close();
    this.root.remove();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      this.close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      this.next(e.shiftKey ? -1 : +1);
      return;
    }
    // Cmd+G / Cmd+Shift+G — convention for next/prev result.
    if ((e.metaKey || e.ctrlKey) && (e.key === "g" || e.key === "G")) {
      e.preventDefault();
      this.next(e.shiftKey ? -1 : +1);
      return;
    }
  }

  private search(_mode: "incremental"): void {
    const q = this.input.value;
    if (!q) {
      try {
        this.addon.clearDecorations();
      } catch {
        /* noop */
      }
      this.resultDecorations = { resultIndex: -1, resultCount: 0 };
      this.renderCounter();
      return;
    }
    // Incremental: addon highlights everything; we don't need to
    // call findNext explicitly — onDidChangeResults fires regardless.
    this.addon.findNext(q, { ...this.opts });
  }

  private next(direction: 1 | -1): void {
    const q = this.input.value;
    if (!q) return;
    if (direction > 0) this.addon.findNext(q, { ...this.opts });
    else this.addon.findPrevious(q, { ...this.opts });
  }

  private renderCounter(): void {
    const { resultIndex, resultCount } = this.resultDecorations;
    if (resultCount <= 0 || !this.input.value) {
      this.counter.textContent = "";
      this.root.classList.remove("term-finder--nomatch");
      return;
    }
    if (resultIndex < 0) {
      this.counter.textContent = `0 / ${resultCount}`;
    } else {
      this.counter.textContent = `${resultIndex + 1} / ${resultCount}`;
    }
    this.root.classList.toggle(
      "term-finder--nomatch",
      this.input.value !== "" && resultCount === 0,
    );
  }
}
