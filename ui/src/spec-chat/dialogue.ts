import type { ChatMessage } from "./state";

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function renderMessage(msg: ChatMessage): HTMLElement {
  const el = document.createElement("div");
  el.className =
    msg.role === "user"
      ? "spec-chat-msg spec-chat-msg-user"
      : "spec-chat-msg spec-chat-msg-assistant";
  el.textContent = escapeHtml(msg.content);
  return el;
}
