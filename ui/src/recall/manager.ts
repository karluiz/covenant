// Recall sidebar — searchable command history that surfaces while
// the user is typing.
//
// The shell input the user is currently composing isn't directly
// observable (we don't render the prompt; xterm and the shell do).
// Instead we shadow it: subscribe to xterm.onData, maintain a
// best-effort buffer of "what was typed since the last prompt", and
// query the backend when it's non-empty.
//
// This is HEURISTIC. The buffer drifts when the user hits arrow keys,
// uses ^A/^E navigation, or pulls from shell history with up-arrow.
// That's acceptable for v1: the win case (typing fresh from a clean
// prompt) is by far the dominant one, and Recall gracefully reverts
// to Blocks the moment input looks empty.
//
// The real source of truth is the OSC 133 stream — `prompt_start`
// always resets the buffer to empty, so any drift is bounded to the
// duration of one command's input phase.

import { recallSearch, type RecallMatch } from "../api";
import { Icons } from "../icons";

export type InjectFn = (data: Uint8Array) => Promise<void>;

export interface RecallCallbacks {
  /// Fired when the Recall view becomes relevant (input looks
  /// non-empty) or stops being relevant (input cleared / Enter).
  /// TabManager uses this to flip visibility between Blocks and Recall.
  onShouldShow: (show: boolean) => void;

  /// Fired after a recall item is injected so the host can return
  /// keyboard focus to the terminal — without this, the user has
  /// to click the terminal again to type the Enter that submits.
  focusTerminal?: () => void;
}

const DEBOUNCE_MS = 100;
const MAX_RESULTS = 12;

export class RecallManager {
  private readonly root: HTMLElement;
  private readonly listEl: HTMLUListElement;
  private readonly headerEl: HTMLElement;
  private buffer = "";
  private lastQuery = "";
  private debounce: number | null = null;
  private inflight = 0;
  private latestSeen = 0;
  private currentCwd: string | null = null;
  private visible = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly inject: InjectFn,
    private readonly callbacks: RecallCallbacks,
  ) {
    this.root = document.createElement("div");
    this.root.className = "recall-host";
    this.root.hidden = true;

    this.headerEl = document.createElement("header");
    this.headerEl.className = "recall-header";
    this.root.appendChild(this.headerEl);

    this.listEl = document.createElement("ul");
    this.listEl.className = "recall-list";
    this.root.appendChild(this.listEl);

    this.host.appendChild(this.root);
    this.renderHeader("");
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    // Marker on the column lets CSS override the .blocks-collapsed
    // narrow-column rule — Recall always wants the full sidebar.
    this.host.classList.add("recall-active");
  }

  hide(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.host.classList.remove("recall-active");
  }

  /// OSC 133 prompt_start — the shell is about to draw a fresh
  /// prompt. Whatever we thought was buffered is wrong now (the
  /// user just hit Enter, or the previous block finished). Reset.
  notifyPromptStart(): void {
    this.resetBuffer();
  }

  /// Track the current cwd so backend queries can apply the cwd bonus.
  setCwd(cwd: string | null): void {
    this.currentCwd = cwd;
  }

  /// Forward every byte the user typed (xterm.onData). We keep this
  /// synchronous so keystroke order is preserved with PTY writes.
  notifyInput(data: string): void {
    let mutated = false;
    // Set when we see input that may mutate the shell buffer in ways
    // our shadow can't track (escape sequences, history nav, tab
    // completion, etc.). Forces a reset so a stale filter doesn't
    // linger after the user clears the prompt via ^W or accepts a
    // zsh-autosuggestion via Right arrow.
    let dirty = false;
    for (let i = 0; i < data.length; i++) {
      const ch = data.charCodeAt(i);
      // Enter (\r in raw mode, or \n) → command submitted; reset.
      if (ch === 13 || ch === 10) {
        if (this.buffer.length > 0) mutated = true;
        this.buffer = "";
        continue;
      }
      // ^U → kill line back; ^C → cancel input.
      if (ch === 21 || ch === 3) {
        if (this.buffer.length > 0) mutated = true;
        this.buffer = "";
        continue;
      }
      // DEL (^?) / ^H → backspace, drop last char.
      if (ch === 127 || ch === 8) {
        if (this.buffer.length > 0) {
          this.buffer = this.buffer.slice(0, -1);
          mutated = true;
        }
        continue;
      }
      // ^W → delete word back. Best-effort: strip trailing run of
      // non-whitespace + any spaces before it, mirroring the default
      // zsh WORDCHARS behavior closely enough for common cases.
      if (ch === 23) {
        if (this.buffer.length > 0) {
          const trimmed = this.buffer.replace(/\S+\s*$/, "");
          if (trimmed !== this.buffer) {
            this.buffer = trimmed;
            mutated = true;
          }
        }
        continue;
      }
      // Cursor / screen ops that don't change the input line:
      // ^A start, ^B back, ^E end, ^F forward, ^L clear-screen, ^Z suspend.
      if (
        ch === 1 ||
        ch === 2 ||
        ch === 5 ||
        ch === 6 ||
        ch === 12 ||
        ch === 26
      ) {
        continue;
      }
      // ESC + remainder is an escape sequence (arrow keys, alt-chords,
      // ZLE widgets like autosuggest-accept on Right arrow). The shell
      // may treat it as pure cursor navigation OR as an input-mutating
      // widget — we can't tell from the bytes. Drop the shadow buffer
      // and let prompt_start (or the user re-typing) reseed us.
      // Same for any other control char we haven't whitelisted above
      // (Tab/^I, history ^N/^P, search ^R, yank ^Y, transpose ^T,
      // forward-delete ^D, etc.).
      if (ch === 27 || ch < 32) {
        dirty = true;
        if (ch === 27) break;
        continue;
      }
      this.buffer += data[i];
      mutated = true;
    }
    if (dirty) {
      // resetBuffer hides recall and clears lastQuery in one shot.
      this.resetBuffer();
    } else if (mutated) {
      this.scheduleQuery();
    }
  }

  private resetBuffer(): void {
    if (this.buffer.length === 0 && !this.visible) return;
    this.buffer = "";
    this.lastQuery = "";
    this.callbacks.onShouldShow(false);
    this.renderHeader("");
    this.listEl.innerHTML = "";
  }

  private scheduleQuery(): void {
    if (this.debounce !== null) {
      window.clearTimeout(this.debounce);
    }
    this.debounce = window.setTimeout(() => {
      this.debounce = null;
      void this.runQuery();
    }, DEBOUNCE_MS);
  }

  private async runQuery(): Promise<void> {
    const q = this.buffer.trim();
    // Empty input → flip back to Blocks.
    if (q.length === 0) {
      this.callbacks.onShouldShow(false);
      this.lastQuery = "";
      return;
    }
    if (q === this.lastQuery) return;
    this.lastQuery = q;

    // Tag this fetch with a monotonic ticket so an out-of-order
    // late response can't paint over a fresher result.
    const ticket = ++this.inflight;
    let matches: RecallMatch[] = [];
    try {
      matches = await recallSearch(q, this.currentCwd, MAX_RESULTS);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("recall_search failed", err);
      return;
    }
    if (ticket < this.latestSeen) return;
    this.latestSeen = ticket;

    // Show Recall as soon as we have results. If the buffer was
    // cleared while in flight, runQuery's next tick will hide it.
    if (this.buffer.trim().length === 0) {
      this.callbacks.onShouldShow(false);
      return;
    }
    this.callbacks.onShouldShow(matches.length > 0);
    this.render(matches, q);
  }

  private renderHeader(query: string): void {
    if (query.length === 0) {
      this.headerEl.innerHTML = `
        <span class="recall-header-icon">${Icons.terminal({ size: 12 })}</span>
        <span class="recall-header-label">recall</span>
      `;
    } else {
      this.headerEl.innerHTML = `
        <span class="recall-header-icon">${Icons.terminal({ size: 12 })}</span>
        <span class="recall-header-label">recall</span>
        <span class="recall-header-query">${escapeHtml(query)}</span>
      `;
    }
  }

  private render(matches: RecallMatch[], query: string): void {
    this.renderHeader(query);

    if (matches.length === 0) {
      this.listEl.innerHTML = `<li class="recall-empty">no past commands match</li>`;
      return;
    }

    const now = Date.now();
    const items = matches
      .map((m) => {
        const stats = formatStats(m, now);
        const cmd = highlightMatch(m.command, query);
        return `
          <li class="recall-item" data-cmd="${escapeHtml(m.command)}" tabindex="0">
            <div class="recall-cmd">${cmd}</div>
            <div class="recall-stats">${stats}</div>
          </li>
        `;
      })
      .join("");
    this.listEl.innerHTML = items;

    this.listEl.querySelectorAll<HTMLElement>(".recall-item").forEach((el) => {
      const cmd = el.dataset.cmd ?? "";
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        if (cmd) void this.injectMatch(cmd);
      });
      el.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          if (cmd) void this.injectMatch(cmd);
        }
      });
    });
  }

  /// Replace whatever the user has typed at the prompt with the picked
  /// command. ^U clears the current line first, then we type the
  /// command (no trailing newline — user reviews and presses Enter).
  private async injectMatch(command: string): Promise<void> {
    const enc = new TextEncoder();
    try {
      // ^U then the command. Sent as one PTY write so the shell sees
      // them atomically and Recall's own buffer reset (driven by the
      // ^U byte we observe via xterm.onData) lines up correctly.
      await this.inject(enc.encode("\x15" + command));
      // Optimistic local update — the click already happened, no
      // point waiting for the next onData round-trip.
      this.buffer = command;
      this.lastQuery = "";
      this.callbacks.onShouldShow(false);
      // Return focus to the terminal so the user can immediately
      // press Enter (or edit) without an extra click on xterm.
      this.callbacks.focusTerminal?.();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("recall inject failed", err);
    }
  }
}

function formatStats(m: RecallMatch, now: number): string {
  const age = humanizeAge(now - m.last_used_unix_ms);
  const parts: string[] = [];
  parts.push(`${m.count}×`);
  parts.push(age);
  if (m.cwd_match_count > 0) {
    parts.push(`${m.cwd_match_count} here`);
  }
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

/// Wrap the matched substring in a <mark> for visual highlight.
/// Case-insensitive match; both sides are HTML-escaped first.
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
