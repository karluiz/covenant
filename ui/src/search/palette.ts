// Global file-search palette — ⌘⇧F.
//
// A full-screen overlay that takes a query and lists matching lines
// across the active tab's cwd, honoring .gitignore. Keyboard-driven:
// type to search, ↑/↓ moves the selection, Enter opens the file at
// the matched line, Esc closes.
//
// Search is debounced (180ms) so we don't spam the backend on every
// keystroke. Backend has its own caps (max file size, hits per file,
// total limit) — the palette just renders whatever comes back.

import {
  structureFindFiles,
  structureSearch,
  type FileHit,
  type SearchHit,
} from "../api";

type Mode = "content" | "files";

const SEARCH_ICON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" width="14" height="14"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';

const DEBOUNCE_MS = 180;
const HIT_LIMIT = 200;

export interface PaletteCallbacks {
  /// Resolve the cwd to search in. Returns null if no active tab —
  /// the palette refuses to open in that case.
  cwd: () => string | null;
  /// Open a file at a 1-based line number. The palette doesn't know
  /// about TabManager / StructureEditor; main.ts wires this up.
  open: (path: string, line: number) => void;
}

export class GlobalSearchPalette {
  private overlay: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private resultsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private hits: SearchHit[] = [];
  private fileHits: FileHit[] = [];
  /// 'content' = grep lines (default, original behavior).
  /// 'files'   = fuzzy filename finder. Tab toggles.
  private mode: Mode = "content";
  private modeEl: HTMLElement | null = null;
  /// Currently-selected result index, used by ↑/↓ + Enter.
  private cursor = 0;
  /// Bumped on every search request; late-arriving responses with a
  /// smaller ticket are ignored (user typed faster than rg returned).
  private fetchTicket = 0;
  private debounceTimer: number | null = null;
  /// Last rendered cwd so the empty state can show context.
  private currentCwd: string | null = null;

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly callbacks: PaletteCallbacks,
  ) {}

  isOpen(): boolean {
    return this.overlay !== null;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen()) return;
    const cwd = this.callbacks.cwd();
    if (!cwd) return; // no active tab — silently bail
    this.currentCwd = cwd;
    this.render();
    requestAnimationFrame(() => this.inputEl?.focus());
  }

  close(): void {
    if (!this.overlay) return;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    this.overlay.remove();
    this.overlay = null;
    this.inputEl = null;
    this.resultsEl = null;
    this.statusEl = null;
    this.modeEl = null;
    this.hits = [];
    this.fileHits = [];
    this.cursor = 0;
  }

  private resultCount(): number {
    return this.mode === "content" ? this.hits.length : this.fileHits.length;
  }

  private render(): void {
    const overlay = document.createElement("div");
    overlay.className = "global-search-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "global-search-card";
    card.innerHTML = `
      <header class="global-search-header">
        <span class="global-search-icon" aria-hidden="true">${SEARCH_ICON_SVG}</span>
        <input
          type="text"
          class="global-search-input"
          placeholder="${this.placeholderText()}"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="global-search-mode" title="Tab to toggle">${this.modeLabel()}</span>
        <span class="global-search-status" aria-live="polite"></span>
      </header>
      <div class="global-search-results" role="listbox"></div>
    `;
    overlay.appendChild(card);
    this.mountHost.appendChild(overlay);
    this.overlay = overlay;

    this.inputEl = card.querySelector<HTMLInputElement>(".global-search-input");
    this.resultsEl = card.querySelector<HTMLElement>(".global-search-results");
    this.statusEl = card.querySelector<HTMLElement>(".global-search-status");
    this.modeEl = card.querySelector<HTMLElement>(".global-search-mode");

    if (this.inputEl) {
      this.inputEl.addEventListener("input", () => this.scheduleSearch());
      this.inputEl.addEventListener("keydown", (e) => this.onKey(e));
    }
    if (this.resultsEl) {
      this.resultsEl.addEventListener("click", (e) => this.onResultsClick(e));
    }
    this.renderEmpty(this.emptyHint());
  }

  private modeLabel(): string {
    return this.mode === "content" ? "content" : "files";
  }

  private placeholderText(): string {
    const where = shortenCwd(this.currentCwd ?? "");
    return this.mode === "content"
      ? `Search in ${escapeHtml(where)}…`
      : `Find file in ${escapeHtml(where)}…`;
  }

  private emptyHint(): string {
    return this.mode === "content"
      ? "Type to search. Tab → find files."
      : "Type to find files. Tab → search content.";
  }

  private toggleMode(): void {
    this.mode = this.mode === "content" ? "files" : "content";
    if (this.inputEl) this.inputEl.placeholder = this.placeholderText();
    if (this.modeEl) this.modeEl.textContent = this.modeLabel();
    this.cursor = 0;
    this.hits = [];
    this.fileHits = [];
    if (this.inputEl && this.inputEl.value.trim() !== "") {
      void this.runSearch();
    } else {
      this.renderEmpty(this.emptyHint());
      if (this.statusEl) this.statusEl.textContent = "";
    }
  }

  private scheduleSearch(): void {
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch();
    }, DEBOUNCE_MS);
  }

  private async runSearch(): Promise<void> {
    if (!this.inputEl || !this.statusEl) return;
    const query = this.inputEl.value;
    const cwd = this.currentCwd;
    if (!cwd) return;
    if (query.trim() === "") {
      this.hits = [];
      this.fileHits = [];
      this.cursor = 0;
      this.renderEmpty(this.emptyHint());
      this.statusEl.textContent = "";
      return;
    }
    const ticket = ++this.fetchTicket;
    this.statusEl.textContent = "searching…";
    const mode = this.mode;
    try {
      if (mode === "content") {
        const results = await structureSearch(cwd, query, HIT_LIMIT);
        if (ticket !== this.fetchTicket || this.mode !== mode) return;
        this.hits = results;
      } else {
        const results = await structureFindFiles(cwd, query, HIT_LIMIT);
        if (ticket !== this.fetchTicket || this.mode !== mode) return;
        this.fileHits = results;
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("search failed", err);
      if (ticket === this.fetchTicket) {
        this.renderEmpty(`Search failed: ${String(err)}`);
        this.statusEl.textContent = "";
      }
      return;
    }
    this.cursor = 0;
    const count = this.resultCount();
    if (count === 0) {
      this.renderEmpty(`No matches for “${escapeHtml(query)}”.`);
      this.statusEl.textContent = "0";
      return;
    }
    this.renderResults(query);
    this.statusEl.textContent = count >= HIT_LIMIT ? `${HIT_LIMIT}+` : String(count);
  }

  private renderEmpty(message: string): void {
    if (!this.resultsEl) return;
    this.resultsEl.innerHTML = `<div class="global-search-empty">${escapeHtml(message)}</div>`;
  }

  private renderResults(query: string): void {
    if (!this.resultsEl) return;
    let html = "";
    if (this.mode === "content") {
      // Group hits by file for visual scannability — one header per
      // file, then its lines indented under it.
      const byFile = new Map<string, SearchHit[]>();
      for (const h of this.hits) {
        const arr = byFile.get(h.path);
        if (arr) arr.push(h);
        else byFile.set(h.path, [h]);
      }
      let flatIdx = 0;
      for (const [path, hitsForFile] of byFile) {
        html += `<div class="global-search-file">${escapeHtml(shortenPath(path))} <span class="global-search-file-count">${hitsForFile.length}</span></div>`;
        for (const h of hitsForFile) {
          const active = flatIdx === this.cursor ? " active" : "";
          html += `
            <div class="global-search-hit${active}" data-idx="${flatIdx}" role="option" aria-selected="${flatIdx === this.cursor}">
              <span class="global-search-line-no">${h.line_number}</span>
              <span class="global-search-line-text">${highlightMatch(h.line_text, h.match_start, h.match_end)}</span>
            </div>`;
          flatIdx++;
        }
      }
    } else {
      this.fileHits.forEach((h, idx) => {
        const active = idx === this.cursor ? " active" : "";
        html += `
          <div class="global-search-hit global-search-file-hit${active}" data-idx="${idx}" role="option" aria-selected="${idx === this.cursor}">
            <span class="global-search-line-text">${highlightIndices(h.rel_path, h.match_indices)}</span>
          </div>`;
      });
    }
    this.resultsEl.innerHTML = html;
    void query;
    this.scrollCursorIntoView();
  }

  private scrollCursorIntoView(): void {
    const el = this.resultsEl?.querySelector<HTMLElement>(
      `.global-search-hit[data-idx="${this.cursor}"]`,
    );
    if (el) el.scrollIntoView({ block: "nearest" });
  }

  private moveCursor(delta: number): void {
    const count = this.resultCount();
    if (count === 0) return;
    this.cursor = (this.cursor + delta + count) % count;
    // Cheap re-render: just toggle the `active` class on rows.
    if (!this.resultsEl) return;
    const rows = this.resultsEl.querySelectorAll<HTMLElement>(".global-search-hit");
    rows.forEach((row) => {
      const idx = Number(row.dataset.idx);
      const active = idx === this.cursor;
      row.classList.toggle("active", active);
      row.setAttribute("aria-selected", String(active));
    });
    this.scrollCursorIntoView();
  }

  private openSelected(): void {
    if (this.mode === "content") {
      const hit = this.hits[this.cursor];
      if (!hit) return;
      const { path, line_number } = hit;
      this.close();
      this.callbacks.open(path, line_number);
    } else {
      const hit = this.fileHits[this.cursor];
      if (!hit) return;
      const path = hit.path;
      this.close();
      // Filename matches don't have a line — open at line 1.
      this.callbacks.open(path, 1);
    }
  }

  private onKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.close();
        return;
      case "Enter":
        e.preventDefault();
        this.openSelected();
        return;
      case "ArrowDown":
        e.preventDefault();
        this.moveCursor(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        this.moveCursor(-1);
        return;
      case "Tab":
        e.preventDefault();
        this.toggleMode();
        return;
    }
  }

  private onResultsClick(e: MouseEvent): void {
    const target = (e.target as HTMLElement).closest<HTMLElement>(".global-search-hit");
    if (!target) return;
    const idx = Number(target.dataset.idx);
    if (Number.isFinite(idx)) {
      this.cursor = idx;
      this.openSelected();
    }
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 4) return p;
  return ".../" + parts.slice(-4).join("/");
}

function shortenCwd(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return ".../" + parts.slice(-2).join("/");
}

function highlightMatch(line: string, start: number, end: number): string {
  // Slice in CHAR units (the backend reports char offsets), then
  // escape each segment independently before assembling. Keeps the
  // <mark> intact while everything around it is properly escaped.
  const chars = Array.from(line);
  const before = chars.slice(0, start).join("");
  const match = chars.slice(start, end).join("");
  const after = chars.slice(end).join("");
  return `${escapeHtml(before)}<mark>${escapeHtml(match)}</mark>${escapeHtml(after)}`;
}

function highlightIndices(text: string, indices: number[]): string {
  if (indices.length === 0) return escapeHtml(text);
  const chars = Array.from(text);
  const marked = new Set(indices);
  let out = "";
  let i = 0;
  while (i < chars.length) {
    if (marked.has(i)) {
      let j = i;
      while (j < chars.length && marked.has(j)) j++;
      out += `<mark>${escapeHtml(chars.slice(i, j).join(""))}</mark>`;
      i = j;
    } else {
      let j = i;
      while (j < chars.length && !marked.has(j)) j++;
      out += escapeHtml(chars.slice(i, j).join(""));
      i = j;
    }
  }
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
