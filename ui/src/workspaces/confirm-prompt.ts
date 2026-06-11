/// Centered confirm prompt — a message + confirm/cancel card in the
/// command-palette visual language, for destructive actions. The Tauri
/// capability set doesn't allow native dialog ask/confirm, and an
/// in-app card matches the palette anyway (see rename-prompt.ts).

export interface ConfirmPromptOptions {
  /// Text for the label chip above the message.
  label?: string;
  /// The question, e.g. `Delete "Workspace 7"? Its tabs will be closed.`
  message: string;
  /// Confirm button caption. Defaults to "Confirm".
  confirmText?: string;
  /// Called when the user confirms (button click or Enter).
  onConfirm: () => void;
}

export function openConfirmPrompt(opts: ConfirmPromptOptions): void {
  document.querySelector(".workspace-confirm-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "command-palette-overlay workspace-confirm-overlay";

  const card = document.createElement("div");
  card.className = "command-palette-card workspace-confirm-card";

  if (opts.label) {
    const label = document.createElement("span");
    label.className = "command-palette-label";
    label.textContent = opts.label;
    card.appendChild(label);
  }

  const message = document.createElement("p");
  message.className = "workspace-confirm-message";
  message.textContent = opts.message;
  card.appendChild(message);

  const buttons = document.createElement("div");
  buttons.className = "workspace-confirm-buttons";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "workspace-confirm-cancel";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "workspace-confirm-confirm";
  confirmBtn.textContent = opts.confirmText ?? "Confirm";

  buttons.appendChild(cancelBtn);
  buttons.appendChild(confirmBtn);
  card.appendChild(buttons);
  overlay.appendChild(card);

  // Enter on the focused confirm button fires both our keydown handler
  // and a synthetic click; the flag keeps onConfirm single-shot.
  let done = false;
  const close = (): void => {
    done = true;
    overlay.remove();
  };
  const confirm = (): void => {
    if (done) return;
    close();
    opts.onConfirm();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });
  cancelBtn.addEventListener("click", close);
  confirmBtn.addEventListener("click", confirm);

  document.body.appendChild(overlay);
  confirmBtn.focus();
}
