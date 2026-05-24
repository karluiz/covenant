import { MentionPopup, type MentionItem } from "./mention-popup";

export interface MentionDeps {
  /** Returns up to `limit` ranked matches for the given query. */
  searchFiles: (query: string, limit: number) => Promise<{ path: string }[]>;
}

export interface MentionHandle {
  detach: () => void;
}

const MAX_RESULTS = 8;
const SEARCH_DEBOUNCE_MS = 60;

/**
 * Attach `@`-trigger file mention behavior to an existing input or
 * textarea. The input's `.value` continues to be the source of truth;
 * selecting a mention rewrites the value to replace the active
 * `@query` span with `@<path>`.
 */
export function attachMentions(
  inputEl: HTMLInputElement | HTMLTextAreaElement,
  deps: MentionDeps,
): MentionHandle {
  const popup = new MentionPopup();
  let activeSpan: { start: number; end: number } | null = null;
  let lastQuery = "";
  let searchSeq = 0;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  popup.setOnPick((item) => insert(item));

  function detectActiveSpan(): { start: number; end: number; query: string } | null {
    const v = inputEl.value;
    const caret = inputEl.selectionStart ?? v.length;
    for (let i = caret - 1; i >= 0; i--) {
      const c = v[i];
      if (c === "@") {
        if (i === 0 || /\s/.test(v[i - 1])) {
          return { start: i, end: caret, query: v.slice(i + 1, caret) };
        }
        return null;
      }
      if (/\s/.test(c)) return null;
    }
    return null;
  }

  function caretAnchor(): { x: number; y: number } {
    const rect = inputEl.getBoundingClientRect();
    return { x: rect.left, y: rect.bottom + 2 };
  }

  function scheduleSearch(query: string): void {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => void runSearch(query), SEARCH_DEBOUNCE_MS);
  }

  async function runSearch(query: string): Promise<void> {
    const seq = ++searchSeq;
    const results = await deps.searchFiles(query, MAX_RESULTS);
    if (seq !== searchSeq) return;
    if (!activeSpan) { popup.hide(); return; }
    popup.show(caretAnchor(), results as MentionItem[], 0);
  }

  function insert(item: MentionItem): void {
    if (!activeSpan) return;
    const v = inputEl.value;
    const before = v.slice(0, activeSpan.start);
    const after = v.slice(activeSpan.end);
    const token = `@${item.path}`;
    const next = `${before}${token} ${after}`;
    inputEl.value = next;
    const caret = before.length + token.length + 1;
    inputEl.setSelectionRange(caret, caret);
    inputEl.dispatchEvent(new Event("input", { bubbles: true }));
    closePopup();
    inputEl.focus();
  }

  function closePopup(): void {
    activeSpan = null;
    lastQuery = "";
    popup.hide();
  }

  function onInput(): void {
    const span = detectActiveSpan();
    if (!span) { closePopup(); return; }
    activeSpan = { start: span.start, end: span.end };
    if (span.query !== lastQuery) {
      lastQuery = span.query;
      scheduleSearch(span.query);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!popup.isOpen()) return;
    if (e.key === "ArrowDown")     { popup.moveActive(+1); e.preventDefault(); }
    else if (e.key === "ArrowUp")  { popup.moveActive(-1); e.preventDefault(); }
    else if (e.key === "Enter" || e.key === "Tab") {
      const item = popup.getActive();
      if (item) { insert(item); e.preventDefault(); }
    } else if (e.key === "Escape") { closePopup(); e.preventDefault(); }
  }

  function onBlur(): void {
    setTimeout(() => closePopup(), 100);
  }

  inputEl.addEventListener("input", onInput);
  inputEl.addEventListener("keydown", onKeyDown);
  inputEl.addEventListener("blur", onBlur);

  return {
    detach: () => {
      inputEl.removeEventListener("input", onInput);
      inputEl.removeEventListener("keydown", onKeyDown);
      inputEl.removeEventListener("blur", onBlur);
      popup.destroy();
    },
  };
}
