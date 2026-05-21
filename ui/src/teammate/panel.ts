import type { TeammateMessage } from "../api";
import { teammateListMessages, teammateSendText } from "../api";

export interface TeammatePanelDeps {
  listMessages: (operatorId: string, limit?: number) => Promise<TeammateMessage[]>;
  sendText:     (operatorId: string, text: string) => Promise<TeammateMessage>;
}

const DEFAULT_DEPS: TeammatePanelDeps = {
  listMessages: teammateListMessages,
  sendText:     teammateSendText,
};

export class TeammatePanel {
  private host: HTMLElement;
  private deps: TeammatePanelDeps;
  private operatorId: string | null = null;
  private operatorName: string = "";
  private threadEl: HTMLElement | null = null;
  private inputEl: HTMLInputElement | null = null;

  constructor(host: HTMLElement, deps: TeammatePanelDeps = DEFAULT_DEPS) {
    this.host = host;
    this.deps = deps;
  }

  isOpen(): boolean { return this.operatorId !== null; }

  async openFor(operatorId: string, operatorName: string): Promise<void> {
    this.operatorId = operatorId;
    this.operatorName = operatorName;
    this.host.innerHTML = "";
    this.host.classList.add("teammate-panel");
    this.host.append(this.renderHeader(), this.renderThread(), this.renderComposer());
    const messages = await this.deps.listMessages(operatorId, 200);
    this.paintMessages(messages);
  }

  close(): void {
    this.operatorId = null;
    this.host.innerHTML = "";
    this.host.classList.remove("teammate-panel");
  }

  async send(text: string): Promise<void> {
    if (!this.operatorId) return;
    if (!text.trim()) return;
    const msg = await this.deps.sendText(this.operatorId, text.trim());
    this.appendBubble(msg);
    if (this.inputEl) this.inputEl.value = "";
  }

  private renderHeader(): HTMLElement {
    const h = document.createElement("div");
    h.className = "teammate-panel-header";
    const title = document.createElement("div");
    title.className = "teammate-panel-title";
    title.textContent = this.operatorName;
    h.append(title);
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
    input.placeholder = `Hablar con ${this.operatorName}…`;
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
      empty.textContent = `Sin conversación aún. Empezá hablándole a ${this.operatorName}.`;
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
}
