// ⌘P Recall command palette — explicit search overlay.
//
// The contextual sidebar (RecallManager) is great when you're at a
// fresh prompt and start typing. The palette covers the other case:
// "I want to find something specific NOW, regardless of what's
// currently on the prompt line." Open it from anywhere with ⌘P,
// type, arrow-key through results, hit Enter to inject.

import { recallSearch, type RecallMatch } from "../api";

export type SessionIdProvider = () => string | null;
export type CwdProvider = () => string | null;
export type InjectFn = (sessionId: string, command: string) => Promise<void>;

const DEBOUNCE_MS = 80;
const MAX_RESULTS = 20;

export class RecallPalette {
  private overlay: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private listEl: HTMLUListElement | null = null;
  private statusEl: HTMLElement | null = null;
  private debounce: number | null = null;
  private inflight = 0;
  private currentResults: RecallMatch[] = [];
  private cursor = 0;

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly getSessionId: SessionIdProvider,
    private readonly getCwd: CwdProvider,
    private readonly inject: InjectFn,
    /// Called after a successful inject so the host can return
    /// keyboard focus to the active terminal — otherwise the next
    /// keystroke (typically Enter to run the command) is lost.
    private readonly focusTerminal?: () => void,
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
    this.render();
    // Kick off an empty-query fetch so the palette opens with the
    // most-recent commands already visible — no blank state.
    void this.runQuery("");
  }

  close(): void {
    if (!this.overlay) return;
    if (this.debounce !== null) {
      window.clearTimeout(this.debounce);
      this.debounce = null;
    }
    this.overlay.remove();
    this.overlay = null;
    this.inputEl = null;
    this.listEl = null;
    this.statusEl = null;
    this.currentResults = [];
    this.cursor = 0;
  }

  private render(): void {
    const overlay = document.createElement("div");
    overlay.className = "recall-palette-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "recall-palette-card";
    card.innerHTML = `
      <div class="recall-palette-input-row">
        <span class="recall-palette-label">⌘P</span>
        <input
          type="text"
          class="recall-palette-input"
          placeholder="search command history…"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="recall-palette-status" aria-live="polite"></span>
      </div>
      <ul class="recall-palette-list" role="listbox"></ul>
    `;
    overlay.appendChild(card);
    this.mountHost.appendChild(overlay);

    this.overlay = overlay;
    this.inputEl = card.querySelector<HTMLInputElement>(".recall-palette-input")!;
    this.listEl = card.querySelector<HTMLUListElement>(".recall-palette-list")!;
    this.statusEl = card.querySelector<HTMLElement>(".recall-palette-status")!;

    this.inputEl.addEventListener("input", () => {
      this.scheduleQuery();
    });
    this.inputEl.addEventListener("keydown", (e) => this.onKey(e));

    this.inputEl.focus();
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      this.move(1);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      this.move(-1);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = this.currentResults[this.cursor];
      if (pick) void this.injectAndClose(pick.command);
      return;
    }
  }

  private move(delta: number): void {
    if (this.currentResults.length === 0) return;
    this.cursor =
      (this.cursor + delta + this.currentResults.length) %
      this.currentResults.length;
    this.highlight();
  }

  private highlight(): void {
    if (!this.listEl) return;
    this.listEl.querySelectorAll<HTMLElement>(".recall-palette-item").forEach(
      (el, i) => {
        el.classList.toggle("active", i === this.cursor);
        if (i === this.cursor) {
          el.scrollIntoView({ block: "nearest" });
        }
      },
    );
  }

  private scheduleQuery(): void {
    if (this.debounce !== null) {
      window.clearTimeout(this.debounce);
    }
    this.debounce = window.setTimeout(() => {
      this.debounce = null;
      const q = this.inputEl?.value ?? "";
      void this.runQuery(q);
    }, DEBOUNCE_MS);
  }

  private async runQuery(query: string): Promise<void> {
    const ticket = ++this.inflight;
    if (this.statusEl) this.statusEl.textContent = "…";
    let matches: RecallMatch[] = [];
    try {
      matches = await recallSearch(query, this.getCwd(), MAX_RESULTS);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("recall_search failed", err);
      if (this.statusEl) this.statusEl.textContent = "error";
      return;
    }
    if (ticket !== this.inflight) return;

    this.currentResults = matches;
    this.cursor = 0;
    if (this.statusEl) {
      this.statusEl.textContent =
        matches.length === 0 ? "no matches" : `${matches.length}`;
    }
    this.renderList(query);
  }

  private renderList(query: string): void {
    if (!this.listEl) return;
    if (this.currentResults.length === 0) {
      this.listEl.innerHTML = `<li class="recall-palette-empty">no past commands match</li>`;
      return;
    }

    const now = Date.now();
    this.listEl.innerHTML = this.currentResults
      .map((m, i) => {
        const cmd = highlightMatch(m.command, query);
        const stats = formatStats(m, now);
        return `
          <li
            class="recall-palette-item${i === this.cursor ? " active" : ""}"
            role="option"
            data-index="${i}"
          >
            <div class="recall-palette-cmd">${cmd}</div>
            <div class="recall-palette-stats">${stats}</div>
          </li>
        `;
      })
      .join("");

    this.listEl.querySelectorAll<HTMLElement>(".recall-palette-item").forEach(
      (el) => {
        // Use mousemove (not mouseenter) so keyboard-driven scrolling
        // doesn't trigger a phantom hover when a new row slides under
        // a stationary cursor — that would yank the selection back to
        // whatever item happens to be near the viewport top.
        el.addEventListener("mousemove", () => {
          const idx = Number(el.dataset.index ?? "0");
          if (idx === this.cursor) return;
          this.cursor = idx;
          this.highlight();
        });
        el.addEventListener("click", () => {
          const idx = Number(el.dataset.index ?? "0");
          const pick = this.currentResults[idx];
          if (pick) void this.injectAndClose(pick.command);
        });
      },
    );
  }

  private async injectAndClose(command: string): Promise<void> {
    const sessionId = this.getSessionId();
    if (!sessionId) {
      this.close();
      return;
    }
    try {
      // The palette doesn't observe what the user has typed at the
      // shell prompt — pre-clear with ^U so we don't append to an
      // existing partial input. Then type the command (no newline;
      // user reviews and presses Enter).
      await this.inject(sessionId, "\x15" + command);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("recall palette inject failed", err);
    }
    this.close();
    // After the overlay is torn down, hand focus back to xterm so the
    // user can immediately press Enter to execute the chosen command.
    this.focusTerminal?.();
  }
}

function formatStats(m: RecallMatch, now: number): string {
  const age = humanizeAge(now - m.last_used_unix_ms);
  const parts: string[] = [];
  parts.push(`${m.count}×`);
  parts.push(age);
  if (m.cwd_match_count > 0) parts.push(`${m.cwd_match_count} here`);
  if (m.count > 0 && m.success_count < m.count) {
    const failed = m.count - m.success_count;
    parts.push(`<span class="recall-fail">${failed} failed</span>`);
  }
  return parts.join(" · ");
}

function humanizeAge(ms: number): string {
  if (ms < 0) return "just now";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

function highlightMatch(command: string, query: string): string {
  const safe = escapeHtml(command);
  if (query.length === 0) return safe;
  const safeQ = escapeHtml(query);
  const idx = safe.toLowerCase().indexOf(safeQ.toLowerCase());
  if (idx < 0) return safe;
  return (
    safe.slice(0, idx) +
    `<mark>${safe.slice(idx, idx + safeQ.length)}</mark>` +
    safe.slice(idx + safeQ.length)
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
