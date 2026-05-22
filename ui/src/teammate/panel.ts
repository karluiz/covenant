import type { Operator, TeammateMessage } from "../api";
import { onTeammateMessage, operatorList, teammateListMessages, teammateSendText } from "../api";
import { renderAvatarHtml } from "../operator/avatars";

export interface TeammatePanelDeps {
  listMessages:  (operatorId: string, limit?: number) => Promise<TeammateMessage[]>;
  sendText:      (operatorId: string, text: string, activeSessionId?: string | null) => Promise<TeammateMessage>;
  listOperators: () => Promise<Operator[]>;
  /// Optional in tests; production wires to the real Tauri listener.
  onMessage?:    (handler: (msg: TeammateMessage) => void) => Promise<() => void>;
  getActiveSessionId?: () => string | null;
}

const DEFAULT_DEPS: TeammatePanelDeps = {
  listMessages:  teammateListMessages,
  sendText:      teammateSendText,
  listOperators: operatorList,
  onMessage:     onTeammateMessage,
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
  private unlisten: (() => void) | null = null;

  constructor(host: HTMLElement, deps: TeammatePanelDeps = DEFAULT_DEPS) {
    this.host = host;
    this.deps = deps;
  }

  isOpen(): boolean { return this.operator !== null; }

  async openFor(operator: Operator): Promise<void> {
    this.operator = operator;
    this.host.innerHTML = "";
    this.host.classList.add("teammate-panel");
    if (operator.color) {
      this.host.style.setProperty("--operator-color", operator.color);
    } else {
      this.host.style.removeProperty("--operator-color");
    }
    this.host.append(this.renderHeader(), this.renderThread(), this.renderComposer());
    const [messages] = await Promise.all([
      this.deps.listMessages(operator.id, 200),
      this.deps.listOperators().then((ops) => { this.roster = ops; }).catch(() => { /* ignore */ }),
    ]);
    this.paintMessages(messages);
    if (!this.unlisten && this.deps.onMessage) {
      this.unlisten = await this.deps.onMessage((m) => this.onIncomingMessage(m));
    }
  }

  close(): void {
    this.closeSwitcher();
    this.unlisten?.();
    this.unlisten = null;
    this.operator = null;
    this.host.style.removeProperty("--operator-color");
    this.host.innerHTML = "";
    this.host.classList.remove("teammate-panel");
  }

  async send(text: string): Promise<void> {
    if (!this.operator) return;
    if (!text.trim()) return;
    const activeId = this.deps.getActiveSessionId?.() ?? null;
    const msg = await this.deps.sendText(this.operator.id, text.trim(), activeId);
    this.appendBubble(msg);
    if (this.inputEl) this.inputEl.value = "";
    this.setTyping(true);
  }

  private renderHeader(): HTMLElement {
    const h = document.createElement("button");
    h.type = "button";
    h.className = "teammate-panel-header";
    h.setAttribute("aria-label", "Switch teammate");
    const op = this.operator;
    h.innerHTML = `
      <span class="teammate-panel-avatar">${renderAvatarHtml(op?.emoji ?? "🤖", 32)}</span>
      <span class="teammate-panel-titlebox">
        <span class="teammate-panel-title">
          <span class="teammate-panel-title-name">${escapeHtml(op?.name ?? "")}</span>
          <span class="teammate-panel-header-caret" aria-hidden="true">▾</span>
        </span>
        <span class="teammate-panel-subtitle">${escapeHtml(op?.model ?? "")}</span>
      </span>
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

    // Skip the typing indicator when computing role-grouping — it's a
    // transient placeholder that should not be treated as a peer bubble.
    let prev: Element | null = this.threadEl.lastElementChild;
    while (prev && prev.classList.contains("teammate-typing")) {
      prev = prev.previousElementSibling;
    }
    const sameRoleAsPrev = prev?.getAttribute("data-role") === msg.role;

    if (msg.role === "user") {
      const b = document.createElement("div");
      b.className = "teammate-bubble teammate-bubble-user";
      b.setAttribute("data-role", "user");
      b.innerHTML = renderInlineContent(msg.content.data);
      this.threadEl.append(b);
    } else {
      const row = document.createElement("div");
      row.className = `teammate-bubble-row teammate-bubble-row-${msg.role}`;
      row.setAttribute("data-role", msg.role);
      const av = document.createElement("div");
      av.className = "teammate-bubble-avatar";
      if (sameRoleAsPrev) {
        av.classList.add("teammate-bubble-avatar-hidden");
      } else if (msg.role === "operator" && this.operator) {
        av.innerHTML = renderAvatarHtml(this.operator.emoji, 22);
      }
      const b = document.createElement("div");
      b.className = `teammate-bubble teammate-bubble-${msg.role}`;
      b.innerHTML = renderInlineContent(msg.content.data);
      row.append(av, b);
      this.threadEl.append(row);
    }
    this.threadEl.scrollTop = this.threadEl.scrollHeight;
  }

  private setTyping(on: boolean): void {
    if (!this.threadEl) return;
    const existing = this.threadEl.querySelector(".teammate-typing");
    if (on && !existing) {
      const row = document.createElement("div");
      row.className = "teammate-bubble-row teammate-bubble-row-operator teammate-typing";
      row.setAttribute("data-role", "operator");
      const av = document.createElement("div");
      av.className = "teammate-bubble-avatar";
      if (this.operator) av.innerHTML = renderAvatarHtml(this.operator.emoji, 22);
      const b = document.createElement("div");
      b.className = "teammate-bubble teammate-bubble-operator teammate-typing";
      b.innerHTML = `<span class="teammate-typing-dot"></span><span class="teammate-typing-dot"></span><span class="teammate-typing-dot"></span>`;
      row.append(av, b);
      this.threadEl.append(row);
      this.threadEl.scrollTop = this.threadEl.scrollHeight;
    } else if (!on && existing) {
      existing.remove();
    }
  }

  private onIncomingMessage(msg: TeammateMessage): void {
    if (!this.operator || msg.operator_id !== this.operator.id) return;
    this.setTyping(false);
    this.appendBubble(msg);
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
    this.host.classList.add("switcher-open");

    const dismiss = (e: Event) => {
      if (!this.switcherEl) return;
      if (e.type === "keydown" && (e as KeyboardEvent).key !== "Escape") return;
      if (e.type === "click" && this.switcherEl.contains(e.target as Node)) return;
      if (e.type === "click" && this.headerEl?.contains(e.target as Node)) return;
      this.closeSwitcher();
    };
    this.dismissSwitcher = dismiss;
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
    this.host.classList.remove("switcher-open");
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

/// Render a single text message as HTML. Escapes HTML first, then wraps
/// backtick-delimited spans in <code>. Phase 1 keeps this small and safe;
/// fuller Markdown rendering is a later polish if we need it.
function renderInlineContent(text: string): string {
  const escaped = escapeHtml(text);
  return escaped.replace(/`([^`\n]+)`/g, '<code>$1</code>');
}
