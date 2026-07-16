// ⌘K Action Palette. The agent returns a structured response via
// tool-use: optional explanation text (streamed), optional top-1
// command chip, and 0–3 follow-up questions. ⏎ inserts the command
// into the active PTY without a trailing newline; ⌘⏎ runs it (unless
// risk=destructive, which downgrades to insert + warning).

import {
  askAgent,
  writeToSession,
  type AgentResponse,
  type CommandAction,
} from "../api";
import { formatChord } from "../platform";

export class AgentPanel {
  private modal: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private explEl: HTMLElement | null = null;
  private chipEl: HTMLElement | null = null;
  private followupsEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inProgress = false;
  private lastCommand: CommandAction | null = null;
  private explBuffer = "";

  constructor(
    private readonly mountHost: HTMLElement,
    private readonly getActiveSessionId: () => string | null,
  ) {}

  isOpen(): boolean {
    return this.modal !== null;
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  open(): void {
    if (this.isOpen()) return;
    this.render();
  }

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
    this.explEl = null;
    this.chipEl = null;
    this.followupsEl = null;
    this.statusEl = null;
    this.inProgress = false;
    this.lastCommand = null;
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
        <span class="agent-prompt-label">${formatChord(["mod", "K"])}</span>
        <input type="text" class="agent-input" placeholder="ask the super-agent…" autocomplete="off" spellcheck="false" />
        <span class="agent-status" aria-live="polite"></span>
      </div>
      <div class="agent-explanation"></div>
      <div class="agent-chip-slot"></div>
      <div class="agent-followups"></div>
    `;

    this.inputEl = card.querySelector<HTMLInputElement>(".agent-input")!;
    this.explEl = card.querySelector<HTMLElement>(".agent-explanation")!;
    this.chipEl = card.querySelector<HTMLElement>(".agent-chip-slot")!;
    this.followupsEl = card.querySelector<HTMLElement>(".agent-followups")!;
    this.statusEl = card.querySelector<HTMLElement>(".agent-status")!;

    this.inputEl.addEventListener("keydown", (e) => this.onInputKey(e));
    overlay.addEventListener("keydown", (e) => this.onGlobalKey(e));

    this.mountHost.appendChild(overlay);
    this.modal = overlay;
    this.inputEl.focus();
  }

  private onInputKey(e: KeyboardEvent): void {
    if (e.key !== "Enter" || this.inProgress) return;
    const q = this.inputEl!.value.trim();
    if (q.length === 0) {
      if (this.lastCommand) {
        e.preventDefault();
        void this.doInsert(this.lastCommand, false);
      }
      return;
    }
    e.preventDefault();
    void this.ask(q);
  }

  private onGlobalKey(e: KeyboardEvent): void {
    if (!this.lastCommand) return;
    const cmd = this.lastCommand;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void this.doInsert(cmd, true);
    } else if (
      (e.key === "c" || e.key === "C") &&
      (e.metaKey || e.ctrlKey) &&
      !e.shiftKey
    ) {
      const sel = window.getSelection();
      if (sel && sel.toString().length > 0) return;
      e.preventDefault();
      void navigator.clipboard
        .writeText(cmd.cmd)
        .then(() => this.setStatus("copied"));
    }
  }

  private async ask(question: string): Promise<void> {
    if (
      !this.explEl ||
      !this.chipEl ||
      !this.followupsEl ||
      !this.inputEl ||
      !this.statusEl
    )
      return;
    const sessionId = this.getActiveSessionId();
    if (!sessionId) {
      this.showError("no active session");
      return;
    }
    this.inProgress = true;
    this.lastCommand = null;
    this.explBuffer = "";
    this.explEl.textContent = "";
    this.chipEl.innerHTML = "";
    this.followupsEl.innerHTML = "";
    this.setStatus("thinking…");

    try {
      await askAgent(
        sessionId,
        question,
        (delta) => {
          this.explBuffer += delta;
          if (this.explEl) this.explEl.textContent = this.explBuffer;
          this.setStatus("");
        },
        (resp) => this.renderFinal(resp),
      );
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

  private renderFinal(resp: AgentResponse): void {
    if (!this.explEl || !this.chipEl || !this.followupsEl) return;
    // Some models won't stream `explanation` as text deltas — it
    // arrives only inside the tool input. Fall back to the parsed
    // value when no text streamed.
    if (this.explBuffer.length === 0 && resp.explanation.length > 0) {
      this.explEl.textContent = resp.explanation;
    }
    this.lastCommand = resp.command;
    this.chipEl.innerHTML = resp.command ? this.renderChip(resp.command) : "";
    this.followupsEl.innerHTML = resp.followups
      .map(
        (q, i) =>
          `<button type="button" class="agent-followup" data-i="${i}">${escapeHtml(q)}</button>`,
      )
      .join("");
    this.followupsEl
      .querySelectorAll<HTMLButtonElement>(".agent-followup")
      .forEach((btn) => {
        btn.addEventListener("click", () => {
          const idx = Number(btn.dataset.i);
          const q = resp.followups[idx];
          if (q && this.inputEl) {
            this.inputEl.value = q;
            void this.ask(q);
          }
        });
      });
  }

  private renderChip(c: CommandAction): string {
    const runLabel = c.risk === "destructive" ? "<s>run</s>" : "run";
    const hints = `<span class="agent-chip-hints">
        <kbd>${formatChord(["enter"])}</kbd> insert &nbsp;
        <kbd>${formatChord(["mod", "enter"])}</kbd> ${runLabel} &nbsp;
        <kbd>${formatChord(["mod", "C"])}</kbd> copy
      </span>`;
    return `
      <div class="agent-chip agent-risk-${c.risk}">
        <div class="agent-chip-head">
          <span class="agent-risk-badge">${c.risk}</span>
          <span class="agent-chip-rationale">${escapeHtml(c.rationale)}</span>
        </div>
        <pre class="agent-chip-cmd"><code>${escapeHtml(c.cmd)}</code></pre>
        <div class="agent-chip-foot">${hints}</div>
      </div>
    `;
  }

  private async doInsert(c: CommandAction, withEnter: boolean): Promise<void> {
    const sessionId = this.getActiveSessionId();
    if (!sessionId) {
      this.showError("no active session");
      return;
    }
    const destructive = c.risk === "destructive";
    const append = withEnter && !destructive ? "\r" : "";
    try {
      const bytes = new TextEncoder().encode(c.cmd + append);
      await writeToSession(sessionId, bytes);
      if (destructive && withEnter) {
        this.setStatus(
          "destructive — inserted, press Enter in shell to confirm",
        );
        return;
      }
      this.close();
    } catch (err) {
      this.showError(String(err));
    }
  }

  private setStatus(msg: string): void {
    if (!this.statusEl) return;
    this.statusEl.textContent = msg;
    this.statusEl.classList.remove("err");
  }

  private showError(msg: string): void {
    if (this.statusEl) {
      this.statusEl.textContent = msg;
      this.statusEl.classList.add("err");
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
