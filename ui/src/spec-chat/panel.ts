import type { SpecChatState } from "./state";
import { renderMessage } from "./dialogue";
import { Icons } from "../icons";

const PHASE_LABELS: Record<string, string> = {
  goal: "Goal",
  outofscope: "Out of scope",
  acceptance: "Acceptance",
  fileboundaries: "File boundaries",
  complexity: "Complexity",
  openquestions: "Open questions",
  emit: "Ready",
};

export interface SpecChatPanel {
  open: () => void;
  close: () => void;
  isOpen: () => boolean;
  /** Called when the agent emits final markdown and the user clicks "Revisar y publicar". */
  onPublishRequest: ((markdown: string, draftId: string) => void) | null;
}

export function mountSpecChatPanel(
  _host: HTMLElement,
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

      const titleWrap = document.createElement("div");
      titleWrap.className = "spec-chat-title-wrap";
      const titleIcon = document.createElement("span");
      titleIcon.className = "spec-chat-title-icon";
      titleIcon.innerHTML = Icons.sparkles({ size: 14 });
      const title = document.createElement("span");
      title.className = "spec-chat-title";
      title.textContent = "New spec";
      titleWrap.appendChild(titleIcon);
      titleWrap.appendChild(title);

      const phaseChip = document.createElement("span");
      phaseChip.className = "spec-chat-phase";

      const closeBtn = document.createElement("button");
      closeBtn.className = "spec-chat-close";
      closeBtn.setAttribute("aria-label", "Close");
      closeBtn.innerHTML = Icons.x({ size: 14 });
      closeBtn.addEventListener("click", () => panel.close());

      header.appendChild(titleWrap);
      header.appendChild(phaseChip);
      header.appendChild(closeBtn);

      // Messages
      const messages = document.createElement("div");
      messages.className = "spec-chat-messages";
      messages.setAttribute("role", "log");
      messages.setAttribute("aria-live", "polite");

      // Empty state — shown when no messages yet
      const emptyState = document.createElement("div");
      emptyState.className = "spec-chat-empty";
      emptyState.innerHTML = `
        <div class="spec-chat-empty-icon">${Icons.sparkles({ size: 40 })}</div>
        <div class="spec-chat-empty-title">Describe the problem</div>
        <div class="spec-chat-empty-body">
          One or two sentences about what you want to solve. The agent will
          ask you 3–5 directed questions and emit a spec in the repo's format.
        </div>
      `;

      // Input row
      const inputRow = document.createElement("footer");
      inputRow.className = "spec-chat-input-row";

      const textarea = document.createElement("textarea");
      textarea.className = "spec-chat-input";
      textarea.rows = 2;
      textarea.placeholder = "Your answer…";

      const sendBtn = document.createElement("button");
      sendBtn.className = "spec-chat-send";
      sendBtn.setAttribute("aria-label", "Send");
      sendBtn.innerHTML = Icons.arrowRight({ size: 14 });

      // Typing indicator — appended into the messages stream while awaiting.
      const typing = document.createElement("div");
      typing.className = "spec-chat-msg spec-chat-msg-assistant spec-chat-typing";
      typing.innerHTML = `<span class="spec-chat-typing-dot"></span><span class="spec-chat-typing-dot"></span><span class="spec-chat-typing-dot"></span>`;
      typing.hidden = true;

      inputRow.appendChild(textarea);
      inputRow.appendChild(sendBtn);

      const errorDiv = document.createElement("div");
      errorDiv.className = "spec-chat-error";
      errorDiv.hidden = true;

      // Final row
      const finalRow = document.createElement("div");
      finalRow.className = "spec-chat-final";
      finalRow.hidden = true;

      const finalNote = document.createElement("span");
      finalNote.className = "spec-chat-final-note";
      finalNote.textContent = "Spec ready. Review and publish in the editor.";

      const publishBtn = document.createElement("button");
      publishBtn.className = "spec-chat-publish";
      publishBtn.innerHTML = `${Icons.arrowRight({ size: 13 })}<span>Review & publish</span>`;
      publishBtn.addEventListener("click", () => {
        const md = state.finalMarkdown();
        const id = state.draftId();
        if (md !== null && id !== null && panel.onPublishRequest) {
          panel.onPublishRequest(md, id);
        }
      });
      finalRow.appendChild(finalNote);
      finalRow.appendChild(publishBtn);

      panelEl.appendChild(header);
      panelEl.appendChild(emptyState);
      panelEl.appendChild(messages);
      panelEl.appendChild(inputRow);
      panelEl.appendChild(errorDiv);
      panelEl.appendChild(finalRow);
      root.appendChild(panelEl);
      // Mount on document.body so position:fixed isn't constrained by the
      // host's CSS grid ancestor (which makes the overlay land in a single
      // grid cell instead of the viewport).
      document.body.appendChild(root);
      // Backdrop click closes (but ignore clicks on the panel itself).
      root.addEventListener("click", (e) => {
        if (e.target === root) panel.close();
      });

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
            err instanceof Error ? err.message : "Failed to send";
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
        const msgs = state.messages();

        // Messages
        messages.innerHTML = "";
        for (const msg of msgs) {
          messages.appendChild(renderMessage(msg));
        }

        // Awaiting state
        const awaiting = state.awaitingAnswer();
        textarea.disabled = awaiting;
        sendBtn.disabled = awaiting;
        typing.hidden = !awaiting;
        if (awaiting) messages.appendChild(typing);

        emptyState.hidden = msgs.length > 0 || awaiting;
        messages.hidden = msgs.length === 0 && !awaiting;

        // Scroll to bottom so the latest user/assistant message is visible.
        requestAnimationFrame(() => {
          messages.scrollTop = messages.scrollHeight;
        });

        // Phase
        const phase = state.phase();
        if (phase !== null) {
          phaseChip.textContent = PHASE_LABELS[phase] ?? phase;
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
