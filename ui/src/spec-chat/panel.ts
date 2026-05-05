import type { SpecChatState } from "./state";
import { renderMessage } from "./dialogue";

export interface SpecChatPanel {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  /** Called when the agent emits final markdown and the user clicks "Revisar y publicar". */
  onPublishRequest: ((markdown: string, draftId: string) => void) | null;
}

export function mountSpecChatPanel(
  host: HTMLElement,
  state: SpecChatState,
): SpecChatPanel {
  let root: HTMLElement | null = null;
  let unsub: (() => void) | null = null;

  const panel: SpecChatPanel = {
    onPublishRequest: null,
    isOpen: () => root !== null,

    open() {
      if (root) return;

      root = document.createElement("div");
      root.className = "spec-chat-overlay";

      const panelEl = document.createElement("div");
      panelEl.className = "spec-chat-panel";

      // Header
      const header = document.createElement("header");
      header.className = "spec-chat-header";

      const title = document.createElement("span");
      title.className = "spec-chat-title";
      title.textContent = "Nuevo spec";

      const phaseChip = document.createElement("span");
      phaseChip.className = "spec-chat-phase";

      const closeBtn = document.createElement("button");
      closeBtn.className = "spec-chat-close";
      closeBtn.setAttribute("aria-label", "Cerrar");
      closeBtn.textContent = "✕";
      closeBtn.addEventListener("click", () => panel.close());

      header.appendChild(title);
      header.appendChild(phaseChip);
      header.appendChild(closeBtn);

      // Messages
      const messages = document.createElement("div");
      messages.className = "spec-chat-messages";
      messages.setAttribute("role", "log");
      messages.setAttribute("aria-live", "polite");

      // Input row
      const inputRow = document.createElement("footer");
      inputRow.className = "spec-chat-input-row";

      const textarea = document.createElement("textarea");
      textarea.className = "spec-chat-input";
      textarea.rows = 2;
      textarea.placeholder = "Tu respuesta...";

      const sendBtn = document.createElement("button");
      sendBtn.className = "spec-chat-send";
      sendBtn.textContent = "Enviar";

      const spinner = document.createElement("span");
      spinner.className = "spec-chat-spinner";
      spinner.textContent = "…";
      spinner.hidden = true;

      inputRow.appendChild(textarea);
      inputRow.appendChild(sendBtn);
      inputRow.appendChild(spinner);

      const errorDiv = document.createElement("div");
      errorDiv.className = "spec-chat-error";
      errorDiv.hidden = true;

      // Final row
      const finalRow = document.createElement("div");
      finalRow.className = "spec-chat-final";
      finalRow.hidden = true;

      const publishBtn = document.createElement("button");
      publishBtn.className = "spec-chat-publish";
      publishBtn.textContent = "Revisar y publicar";
      publishBtn.addEventListener("click", () => {
        const md = state.finalMarkdown();
        const id = state.draftId();
        if (md !== null && id !== null && panel.onPublishRequest) {
          panel.onPublishRequest(md, id);
        }
      });
      finalRow.appendChild(publishBtn);

      panelEl.appendChild(header);
      panelEl.appendChild(messages);
      panelEl.appendChild(inputRow);
      panelEl.appendChild(errorDiv);
      panelEl.appendChild(finalRow);
      root.appendChild(panelEl);
      host.appendChild(root);

      // Submit logic
      const doSubmit = async () => {
        const text = textarea.value.trim();
        if (!text || state.awaitingAnswer()) return;
        textarea.value = "";
        errorDiv.hidden = true;
        try {
          await state.submit(text);
        } catch (err) {
          errorDiv.textContent =
            err instanceof Error ? err.message : "Error al enviar";
          errorDiv.hidden = false;
        }
      };

      textarea.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void doSubmit();
        }
      });

      sendBtn.addEventListener("click", () => { void doSubmit(); });

      // Re-render function
      const render = () => {
        // Messages
        messages.innerHTML = "";
        for (const msg of state.messages()) {
          messages.appendChild(renderMessage(msg));
        }

        // Awaiting state
        const awaiting = state.awaitingAnswer();
        textarea.disabled = awaiting;
        sendBtn.disabled = awaiting;
        spinner.hidden = !awaiting;

        // Phase
        const phase = state.phase();
        if (phase !== null) {
          phaseChip.textContent = phase;
          phaseChip.dataset["phase"] = phase;
          phaseChip.hidden = false;
        } else {
          phaseChip.hidden = true;
        }

        // Final markdown
        const md = state.finalMarkdown();
        if (md !== null) {
          inputRow.hidden = true;
          finalRow.hidden = false;
        } else {
          inputRow.hidden = false;
          finalRow.hidden = true;
        }
      };

      render();
      unsub = state.onChange(render);
      textarea.focus();
    },

    close() {
      if (!root) return;
      root.remove();
      root = null;
      if (unsub) {
        unsub();
        unsub = null;
      }
    },
  };

  return panel;
}
