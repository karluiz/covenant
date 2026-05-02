// ⌘K super-agent overlay. Single-shot Q&A: type a question, hit Enter,
// watch tokens stream into the response area. Esc dismisses. The panel
// stays open after a response so follow-ups are one keystroke away.
//
// Each call is independent (no transcript across questions) — that's
// M5+. World model context is built backend-side per call.

import { askAgent } from "../api";

export class AgentPanel {
  private modal: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private responseEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inProgress = false;

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
      <pre class="agent-response" tabindex="-1"></pre>
    `;

    this.inputEl = card.querySelector<HTMLInputElement>(".agent-input")!;
    this.responseEl = card.querySelector<HTMLElement>(".agent-response")!;
    this.statusEl = card.querySelector<HTMLElement>(".agent-status")!;

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
    this.responseEl.textContent = "";
    this.responseEl.classList.remove("err");
    this.statusEl.textContent = "thinking…";
    this.statusEl.classList.remove("err");

    try {
      await askAgent(sessionId, question, (delta) => {
        if (this.statusEl && this.statusEl.textContent !== "") {
          this.statusEl.textContent = "";
        }
        if (this.responseEl) {
          this.responseEl.textContent =
            (this.responseEl.textContent ?? "") + delta;
          this.responseEl.scrollTop = this.responseEl.scrollHeight;
        }
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
