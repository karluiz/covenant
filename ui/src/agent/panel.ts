// ⌘K super-agent overlay. Single-shot Q&A: type a question, hit Enter,
// watch tokens stream into the response area. Esc dismisses. The panel
// stays open after a response so follow-ups are one keystroke away.
//
// Each call is independent (no transcript across questions) — that's
// M5+. World model context is built backend-side per call.
//
// The response renderer parses a tiny subset of markdown live: fenced
// code blocks (```lang … ```) and inline code (`…`). Fenced blocks
// render with a Copy button — the whole point of the agent panel is
// that you can lift the suggestion into your terminal in one click.
// Unterminated fences (still streaming) show without a Copy button so
// you don't copy half a command.

import { askAgent } from "../api";
import { Icons } from "../icons";

export class AgentPanel {
  private modal: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private responseEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inProgress = false;
  /// Raw, ANSI-free response buffer. We parse + render from this on
  /// every streaming delta — innerHTML rebuild per chunk is fine at
  /// the token rates Anthropic streams (≤ ~60/s).
  private buffer = "";

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly getActiveSessionId: () => string | null,
  ) {}

  isOpen(): boolean {
    return this.modal !== null;
  }

  toggle(): void {
    if (this.isOpen()) {
      this.close();
    } else {
      this.open();
    }
  }

  open(): void {
    if (this.isOpen()) return;
    this.render();
  }

  /// Open the panel and pre-fill the input with `seed`. Used by toast
  /// click-through so the user can immediately ask the agent about the
  /// flagged cross-session finding.
  openWithSeed(seed: string): void {
    if (!this.isOpen()) this.render();
    if (this.inputEl) {
      this.inputEl.value = seed;
      this.inputEl.focus();
      this.inputEl.setSelectionRange(seed.length, seed.length);
    }
  }

  close(): void {
    if (!this.modal) return;
    this.modal.remove();
    this.modal = null;
    this.inputEl = null;
    this.responseEl = null;
    this.statusEl = null;
    this.inProgress = false;
  }

  private render(): void {
    const overlay = document.createElement("div");
    overlay.className = "agent-overlay";
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.close();
    });

    const card = document.createElement("div");
    card.className = "agent-card";
    overlay.appendChild(card);

    card.innerHTML = `
      <div class="agent-input-row">
        <span class="agent-prompt-label">⌘K</span>
        <input
          type="text"
          class="agent-input"
          placeholder="ask the super-agent…"
          autocomplete="off"
          spellcheck="false"
        />
        <span class="agent-status" aria-live="polite"></span>
      </div>
      <div class="agent-response" tabindex="-1"></div>
    `;

    this.inputEl = card.querySelector<HTMLInputElement>(".agent-input")!;
    this.responseEl = card.querySelector<HTMLElement>(".agent-response")!;
    this.statusEl = card.querySelector<HTMLElement>(".agent-status")!;

    // Delegated click handler for Copy buttons inside code blocks.
    // Re-rendering the response on every streaming delta means we
    // can't bind per-button — delegation survives innerHTML rebuilds.
    this.responseEl.addEventListener("click", (e) => {
      const target = e.target as HTMLElement | null;
      const btn = target?.closest<HTMLElement>(".agent-code-copy");
      if (!btn) return;
      const code = btn.dataset.code;
      if (!code) return;
      void navigator.clipboard
        .writeText(code)
        .then(() => {
          btn.classList.add("copied");
          btn.setAttribute("aria-label", "Copied");
          window.setTimeout(() => btn.classList.remove("copied"), 1200);
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.error("clipboard write failed", err);
        });
    });

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !this.inProgress) {
        e.preventDefault();
        const q = this.inputEl!.value.trim();
        if (q.length === 0) return;
        void this.ask(q);
      }
    });

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    this.inputEl.focus();
  }

  private async ask(question: string): Promise<void> {
    if (!this.responseEl || !this.inputEl || !this.statusEl) return;

    const sessionId = this.getActiveSessionId();
    if (!sessionId) {
      this.showError("no active session");
      return;
    }

    this.inProgress = true;
    this.buffer = "";
    this.responseEl.innerHTML = "";
    this.responseEl.classList.remove("err");
    this.statusEl.textContent = "thinking…";
    this.statusEl.classList.remove("err");

    try {
      await askAgent(sessionId, question, (delta) => {
        if (this.statusEl && this.statusEl.textContent !== "") {
          this.statusEl.textContent = "";
        }
        this.buffer += delta;
        this.renderResponse();
      });
      this.statusEl.textContent = "";
    } catch (err) {
      this.showError(String(err));
    } finally {
      this.inProgress = false;
      if (this.inputEl) {
        this.inputEl.value = "";
        this.inputEl.focus();
      }
    }
  }

  /// Parse the buffer + paint into responseEl. Cheap enough to run on
  /// every delta — the buffer caps at a few KB of tokens per turn.
  private renderResponse(): void {
    if (!this.responseEl) return;
    const segments = parseSegments(this.buffer);
    this.responseEl.innerHTML = segments.map(renderSegment).join("");
    this.responseEl.scrollTop = this.responseEl.scrollHeight;
  }

  private showError(msg: string): void {
    if (this.statusEl) {
      this.statusEl.textContent = msg;
      this.statusEl.classList.add("err");
    }
    if (this.responseEl) {
      this.responseEl.classList.add("err");
    }
  }
}

/// Parsed segment of the response buffer.
type Segment =
  | { kind: "text"; content: string }
  | { kind: "code"; lang: string; content: string; terminated: boolean };

/// Split the buffer on triple-backtick fences. Tolerates an unclosed
/// trailing fence (still streaming) by emitting a `terminated: false`
/// code segment — the renderer suppresses Copy until it closes.
function parseSegments(src: string): Segment[] {
  const out: Segment[] = [];
  let i = 0;
  while (i < src.length) {
    const fence = src.indexOf("```", i);
    if (fence === -1) {
      if (i < src.length) out.push({ kind: "text", content: src.slice(i) });
      break;
    }
    if (fence > i) {
      out.push({ kind: "text", content: src.slice(i, fence) });
    }
    // Optional language identifier on the same line as the opening fence.
    const newlineAfterOpen = src.indexOf("\n", fence + 3);
    const langEnd = newlineAfterOpen === -1 ? src.length : newlineAfterOpen;
    const lang = src.slice(fence + 3, langEnd).trim();
    const codeStart = newlineAfterOpen === -1 ? src.length : newlineAfterOpen + 1;
    const close = src.indexOf("```", codeStart);
    if (close === -1) {
      out.push({
        kind: "code",
        lang,
        content: src.slice(codeStart),
        terminated: false,
      });
      break;
    }
    let codeEnd = close;
    // Drop the trailing newline that conventionally precedes the
    // closing fence so the rendered <code> doesn't end in a blank line.
    if (codeEnd > codeStart && src[codeEnd - 1] === "\n") codeEnd -= 1;
    out.push({
      kind: "code",
      lang,
      content: src.slice(codeStart, codeEnd),
      terminated: true,
    });
    i = close + 3;
    // Skip the newline following the closing fence so it doesn't emit
    // a stray blank line in the next text segment.
    if (src[i] === "\n") i += 1;
  }
  return out;
}

function renderSegment(s: Segment): string {
  if (s.kind === "text") {
    return `<div class="agent-text">${renderInline(s.content)}</div>`;
  }
  const langLabel = s.lang ? escapeHtml(s.lang) : "code";
  const copyBtn = s.terminated
    ? `<button
         type="button"
         class="agent-code-copy"
         data-code="${escapeAttr(s.content)}"
         aria-label="Copy code"
         title="Copy">
         ${Icons.copy({ size: 12 })}<span>Copy</span>
       </button>`
    : `<span class="agent-code-streaming">streaming…</span>`;
  return `
    <div class="agent-code">
      <div class="agent-code-head">
        <span class="agent-code-lang">${langLabel}</span>
        ${copyBtn}
      </div>
      <pre class="agent-code-body"><code>${escapeHtml(s.content)}</code></pre>
    </div>
  `;
}

/// Inline pass: backtick spans → <code>; everything else escaped and
/// wrapped so newlines + whitespace render via CSS pre-wrap.
function renderInline(text: string): string {
  // Split on backticks; alternating tokens are inline-code spans.
  // Empty pairs (``) collapse to a literal pair, which is fine.
  const parts = text.split("`");
  return parts
    .map((p, idx) =>
      idx % 2 === 1
        ? `<code class="agent-inline-code">${escapeHtml(p)}</code>`
        : escapeHtml(p),
    )
    .join("");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/// Same as escapeHtml — kept as a separate name so the call sites that
/// embed in attribute context document intent. (Currently identical
/// because we always use double-quoted attributes; if a single-quoted
/// site appears, this is the function to extend.)
const escapeAttr = escapeHtml;
