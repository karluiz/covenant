// ⌘⇧O Operator Picker — modal for fast operator switching.
//
// Modeled on ui/src/recall/palette.ts. Opens over any surface, lets the
// user filter operators, arrow-key through them, and assign to a session.
// n → open Settings (TODO: scroll to Operators pane new-draft)
// e → open Settings (TODO: scroll to specific operator row)
// Esc / backdrop-click → close.

import {
  operatorList,
  sessionSetOperator,
  type Operator,
  type SessionId,
} from "../api";

export class OperatorPicker {
  private root: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private preview: HTMLElement;
  private operators: Operator[] = [];
  private filtered: Operator[] = [];
  private highlighted = 0;
  private targetSessionId: SessionId | null = null;
  private isOpen = false;

  public onAssigned: ((sessionId: SessionId, op: Operator) => void) | null = null;
  public onNewRequested: (() => void) | null = null;
  public onEditRequested: ((op: Operator) => void) | null = null;

  constructor(parent: HTMLElement) {
    this.root = document.createElement("div");
    this.root.className = "operator-picker";
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="operator-picker__backdrop" data-role="backdrop"></div>
      <div class="operator-picker__modal">
        <input class="operator-picker__input" type="text" placeholder="Switch operator…"
               autocomplete="off" spellcheck="false" />
        <div class="operator-picker__layout">
          <ul class="operator-picker__list" data-role="list"></ul>
          <div class="operator-picker__preview" data-role="preview"></div>
        </div>
        <footer class="operator-picker__hint">
          ↵ assign · n new · e edit · Esc close
        </footer>
      </div>`;
    parent.appendChild(this.root);
    this.input = this.root.querySelector<HTMLInputElement>("input")!;
    this.list = this.root.querySelector<HTMLElement>('[data-role="list"]')!;
    this.preview = this.root.querySelector<HTMLElement>('[data-role="preview"]')!;

    this.input.addEventListener("input", () => { this.applyFilter(); });
    this.input.addEventListener("keydown", (e) => { this.onKey(e); });
    this.root.querySelector('[data-role="backdrop"]')!
      .addEventListener("click", () => { this.close(); });
  }

  async open(sessionId: SessionId): Promise<void> {
    this.targetSessionId = sessionId;
    this.operators = await operatorList();
    this.filtered = this.operators;
    this.highlighted = 0;
    this.input.value = "";
    this.root.hidden = false;
    this.isOpen = true;
    this.input.focus();
    this.render();
  }

  close(): void {
    this.root.hidden = true;
    this.isOpen = false;
    this.targetSessionId = null;
  }

  private applyFilter(): void {
    const q = this.input.value.trim().toLowerCase();
    this.filtered =
      q.length === 0
        ? this.operators
        : this.operators.filter(
            (o) =>
              o.name.toLowerCase().includes(q) ||
              o.tags.some((t) => t.toLowerCase().includes(q)),
          );
    this.highlighted = 0;
    this.render();
  }

  private render(): void {
    this.list.innerHTML = this.filtered
      .map(
        (o, i) => `
        <li class="${i === this.highlighted ? "is-highlighted" : ""}"
            data-id="${o.id}">
          <span class="emoji" style="background:${o.color}">${escapeHtml(o.emoji)}</span>
          <span class="name">${escapeHtml(o.name)}</span>
          ${o.is_default ? '<span class="star">⭐</span>' : ""}
        </li>`,
      )
      .join("");

    this.list.querySelectorAll<HTMLElement>("li").forEach((li, i) => {
      li.addEventListener("click", () => {
        this.highlighted = i;
        void this.assignHighlighted();
      });
    });

    const sel = this.filtered[this.highlighted];
    this.preview.innerHTML = sel
      ? `
        <h4>${escapeHtml(sel.emoji)} ${escapeHtml(sel.name)}</h4>
        <p class="muted">${sel.tags.map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join(" ")}</p>
        <dl>
          <dt>Threshold</dt><dd>${sel.escalate_threshold.toFixed(2)}</dd>
          <dt>Model</dt><dd>${escapeHtml(sel.model)}</dd>
        </dl>
        <pre class="persona">${escapeHtml(sel.persona.slice(0, 600))}${sel.persona.length > 600 ? "…" : ""}</pre>`
      : `<p class="muted">No matches.</p>`;
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.isOpen) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        this.close();
        break;
      case "ArrowDown":
        e.preventDefault();
        this.highlighted = Math.min(this.highlighted + 1, this.filtered.length - 1);
        this.render();
        break;
      case "ArrowUp":
        e.preventDefault();
        this.highlighted = Math.max(this.highlighted - 1, 0);
        this.render();
        break;
      case "Enter":
        e.preventDefault();
        void this.assignHighlighted();
        break;
      case "n":
        if (this.input.value.length === 0) {
          e.preventDefault();
          this.close();
          // TODO: open directly to Operators pane new-draft when openTo API exists
          this.onNewRequested?.();
        }
        break;
      case "e":
        if (this.input.value.length === 0) {
          e.preventDefault();
          const sel = this.filtered[this.highlighted];
          if (sel) {
            this.close();
            // TODO: scroll to specific operator row when openTo API exists
            this.onEditRequested?.(sel);
          }
        }
        break;
    }
  }

  private async assignHighlighted(): Promise<void> {
    const sel = this.filtered[this.highlighted];
    if (!sel || !this.targetSessionId) return;
    try {
      await sessionSetOperator(this.targetSessionId, sel.id);
      this.onAssigned?.(this.targetSessionId, sel);
      this.close();
    } catch (e) {
      // eslint-disable-next-line no-alert
      alert(`Failed to assign operator: ${String(e)}`);
    }
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
