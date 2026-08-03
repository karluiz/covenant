/// Centered confirm prompt — a message + confirm/cancel card in the
/// command-palette visual language, for destructive actions. The Tauri
/// capability set doesn't allow native dialog ask/confirm, and an
/// in-app card matches the palette anyway (see rename-prompt.ts).

export interface ConfirmPromptOptions {
  /// Text for the label chip above the message.
  label?: string;
  /// Optional heading above the message, for rich confirms.
  title?: string;
  /// The question, e.g. `Delete "Workspace 7"? Its tabs will be closed.`
  message: string;
  /// Optional term/description rows rendered as a dl below the message.
  detail?: Array<[string, string]>;
  /// Optional danger-colored warning line below the detail rows.
  warn?: string;
  /// Confirm button caption. Defaults to "Confirm".
  confirmText?: string;
  /// Focus Cancel instead of Confirm, so Enter backs out. Use when
  /// confirming destroys data that cannot be recovered.
  focusCancel?: boolean;
  /// Called when the user confirms (button click or Enter).
  onConfirm: () => void;
  /// Called when the user backs out (Cancel, Esc, click outside).
  onCancel?: () => void;
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

  if (opts.title) {
    const title = document.createElement("h2");
    title.className = "workspace-confirm-title";
    title.textContent = opts.title;
    card.appendChild(title);
  }

  const message = document.createElement("p");
  message.className = "workspace-confirm-message";
  message.textContent = opts.message;
  card.appendChild(message);

  if (opts.detail?.length) {
    const dl = document.createElement("dl");
    dl.className = "workspace-confirm-detail";
    for (const [term, desc] of opts.detail) {
      const dt = document.createElement("dt");
      dt.textContent = term;
      const dd = document.createElement("dd");
      dd.textContent = desc;
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    card.appendChild(dl);
  }

  if (opts.warn) {
    const warn = document.createElement("p");
    warn.className = "workspace-confirm-warn";
    warn.textContent = opts.warn;
    card.appendChild(warn);
  }

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
  // and a synthetic click; the flag keeps onConfirm/onCancel single-shot.
  let done = false;
  const cancel = (): void => {
    if (done) return;
    done = true;
    overlay.remove();
    opts.onCancel?.();
  };
  const confirm = (): void => {
    if (done) return;
    done = true;
    overlay.remove();
    opts.onConfirm();
  };

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) cancel();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      // With focusCancel, Enter follows the focused button instead of
      // force-confirming — Enter must never destroy data by default.
      if (opts.focusCancel) {
        if (document.activeElement === confirmBtn) confirm();
        else cancel();
      } else {
        confirm();
      }
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  });
  cancelBtn.addEventListener("click", cancel);
  confirmBtn.addEventListener("click", confirm);

  document.body.appendChild(overlay);
  (opts.focusCancel ? cancelBtn : confirmBtn).focus();
}
