import type { Operator, TeammateMessage } from "../api";
import { operatorList, teammateListMessages, teammateSendText } from "../api";
import { renderAvatarHtml } from "../operator/avatars";

export interface TeammatePanelDeps {
  listMessages: (operatorId: string, limit?: number) => Promise<TeammateMessage[]>;
  sendText:     (operatorId: string, text: string) => Promise<TeammateMessage>;
  listOperators: () => Promise<Operator[]>;
}

const DEFAULT_DEPS: TeammatePanelDeps = {
  listMessages: teammateListMessages,
  sendText:     teammateSendText,
  listOperators: operatorList,
};

export class TeammatePanel {
  private host: HTMLElement;
  private deps: TeammatePanelDeps;
  private operator: Operator | null = null;
  private roster: Operator[] = [];
  private threadEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;
  private headerEl: HTMLElement | null = null;
  private switcherEl: HTMLElement | null = null;
  private dismissSwitcher: ((e: Event) => void) | null = null;

  constructor(host: HTMLElement, deps: TeammatePanelDeps = DEFAULT_DEPS) {
    this.host = host;
    this.deps = deps;
  }

  isOpen(): boolean { return this.operator !== null; }

  async openFor(operator: Operator): Promise<void> {
    this.operator = operator;
    this.host.innerHTML = "";
    this.host.classList.add("teammate-panel");
    this.host.append(this.renderHeader(), this.renderThread(), this.renderComposer());
    // Kick off thread load and roster fetch in parallel. Roster errors are
    // non-fatal — the switcher just won't have anyone else to offer.
    const [messages] = await Promise.all([
      this.deps.listMessages(operator.id, 200),
      this.deps.listOperators().then((ops) => { this.roster = ops; }).catch(() => { /* ignore */ }),
    ]);
    this.paintMessages(messages);
  }

  close(): void {
    this.closeSwitcher();
    this.operator = null;
    this.host.innerHTML = "";
    this.host.classList.remove("teammate-panel");
  }

  async send(text: string): Promise<void> {
    if (!this.operator) return;
    if (!text.trim()) return;
    const msg = await this.deps.sendText(this.operator.id, text.trim());
    this.appendBubble(msg);
    if (this.inputEl) this.inputEl.value = "";
  }

  private renderHeader(): HTMLElement {
    const h = document.createElement("button");
    h.type = "button";
    h.className = "teammate-panel-header";
    h.setAttribute("aria-label", "Switch teammate");
    h.innerHTML = `
      <span class="teammate-panel-avatar">${renderAvatarHtml(this.operator?.emoji ?? "🤖", 28)}</span>
      <span class="teammate-panel-title">${escapeHtml(this.operator?.name ?? "")}</span>
      <span class="teammate-panel-header-caret" aria-hidden="true">▾</span>
    `;
    h.addEventListener("click", () => this.toggleSwitcher());
    this.headerEl = h;
    return h;
  }

  private renderThread(): HTMLElement {
    const t = document.createElement("div");
    t.className = "teammate-panel-thread";
    this.threadEl = t;
    return t;
  }

  private renderComposer(): HTMLElement {
    const c = document.createElement("form");
    c.className = "teammate-panel-composer";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = `Hablar con ${this.operator?.name ?? ""}…`;
    input.className = "teammate-panel-input";
    this.inputEl = input;
    c.append(input);
    c.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.send(input.value);
    });
    return c;
  }

  private paintMessages(msgs: TeammateMessage[]): void {
    if (!this.threadEl) return;
    if (msgs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "teammate-panel-empty";
      const name = this.operator?.name ?? "tu operador";
      empty.textContent = `Sin conversación aún. Empezá hablándole a ${name}.`;
      this.threadEl.append(empty);
      return;
    }
    for (const m of msgs) this.appendBubble(m);
  }

  private appendBubble(msg: TeammateMessage): void {
    if (!this.threadEl) return;
    const empty = this.threadEl.querySelector(".teammate-panel-empty");
    empty?.remove();
    if (msg.content.kind !== "text") return; // Phase 1: text only
    const b = document.createElement("div");
    b.className = `teammate-bubble teammate-bubble-${msg.role}`;
    b.textContent = msg.content.data;
    this.threadEl.append(b);
    this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  private toggleSwitcher(): void {
    if (this.switcherEl) {
      this.closeSwitcher();
      return;
    }
    if (!this.headerEl || this.roster.length === 0) return;
    const list = document.createElement("div");
    list.className = "teammate-panel-switcher";
    for (const op of this.roster) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "teammate-panel-switcher-row";
      if (this.operator && op.id === this.operator.id) {
        row.classList.add("teammate-panel-switcher-row-active");
      }
      row.innerHTML = `
        ${renderAvatarHtml(op.emoji, 24)}
        <span class="teammate-panel-switcher-name">${escapeHtml(op.name)}</span>
        ${op.is_default ? `<span class="teammate-panel-switcher-tag">default</span>` : ""}
      `;
      row.addEventListener("click", () => {
        this.closeSwitcher();
        if (this.operator && op.id === this.operator.id) return;
        void this.openFor(op);
      });
      list.append(row);
    }
    this.host.append(list);
    this.switcherEl = list;

    // Click outside / Esc dismiss
    const dismiss = (e: Event) => {
      if (!this.switcherEl) return;
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "click" && this.switcherEl.contains(e.target as Node)) return;
      if (e.type === "click" && this.headerEl?.contains(e.target as Node)) return;
      this.closeSwitcher();
    };
    this.dismissSwitcher = dismiss;
    // Defer one tick so the current click doesn't immediately close.
    setTimeout(() => {
      document.addEventListener("click", dismiss);
      document.addEventListener("keydown", dismiss);
    }, 0);
  }

  private closeSwitcher(): void {
    if (this.dismissSwitcher) {
      document.removeEventListener("click", this.dismissSwitcher);
      document.removeEventListener("keydown", this.dismissSwitcher);
      this.dismissSwitcher = null;
    }
    this.switcherEl?.remove();
    this.switcherEl = null;
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
