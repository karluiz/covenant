import { Familiars, type ChatOutput } from "./api";
import { renderDirectiveCard } from "./directive_card";

export class ChatPanel {
  private el: HTMLDivElement;
  private log: HTMLDivElement;
  private input: HTMLTextAreaElement;
  private familiarId: string | null = null;

  /** Hook the host wires up to deliver the rendered message into the operator. */
  onApprovedDirective: (familiarId: string, rendered: string) => Promise<void> = async () => {};

  constructor(parent: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "chat-panel";
    this.log = document.createElement("div");
    this.log.className = "chat-log";
    this.input = document.createElement("textarea");
    this.input.className = "chat-input";
    this.input.placeholder = "Talk to your Familiar… (⌘↵ to send)";
    this.input.rows = 3;
    this.input.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        this.send();
      }
    });
    this.el.append(this.log, this.input);
    parent.appendChild(this.el);
  }

  setFamiliar(id: string | null) {
    this.familiarId = id;
    this.log.innerHTML = "";
    if (!id) {
      const note = document.createElement("div");
      note.className = "chat-empty";
      note.textContent = "Pick a Familiar.";
      this.log.appendChild(note);
    }
  }

  private append(role: "user" | "assistant", text: string): HTMLElement {
    const row = document.createElement("div");
    row.className = `chat-msg chat-msg-${role}`;
    row.textContent = text;
    this.log.appendChild(row);
    this.log.scrollTop = this.log.scrollHeight;
    return row;
  }

  private async send() {
    if (!this.familiarId) return;
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = "";
    this.append("user", text);
    let out: ChatOutput;
    try {
      out = await Familiars.chat(this.familiarId, text);
    } catch (e) {
      this.append("assistant", `error: ${e}`);
      return;
    }
    this.append("assistant", out.assistant_text);
    if (out.directive_id) {
      const card = renderDirectiveCard({
        familiar_id: this.familiarId,
        directive_id: out.directive_id,
        kind: out.directive_kind ?? "custom",
        payload: out.directive_payload ?? "",
        rationale: out.directive_rationale ?? "",
        onApproved: async (rendered) => {
          await this.onApprovedDirective(this.familiarId!, rendered);
          await Familiars.markExecuted(this.familiarId!, out.directive_id!);
        },
      });
      this.log.appendChild(card);
      this.log.scrollTop = this.log.scrollHeight;
    } else if (out.safety_block_reason) {
      this.append("assistant",
        `(directive auto-rejected by safety: ${out.safety_block_reason})`);
    }
  }
}
