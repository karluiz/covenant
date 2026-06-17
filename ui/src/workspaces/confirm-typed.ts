/// Type-to-confirm prompt for the highest-severity destructive actions: the
/// user must type the exact target name before the confirm button enables.
/// Same command-palette visual language as confirm-prompt.ts, with an extra
/// input gate (cf. "type the repo name to delete" on GitHub).

export interface ConfirmTypedOptions {
  /// Text for the label chip above the message (e.g. "Destroy group").
  label?: string;
  /// The warning, e.g. `This closes all 4 tabs in the group. Can't be undone.`
  message: string;
  /// The exact text the user must type to enable confirm (e.g. the name).
  expected: string;
  /// Confirm button caption. Defaults to "Delete".
  confirmText?: string;
  /// Called once when the user confirms with a matching value.
  onConfirm: () => void;
}

export function openConfirmTyped(opts: ConfirmTypedOptions): void {
  // Reuse the confirm overlay class so only one such prompt is ever live.
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

  const prompt = document.createElement("p");
  prompt.className = "workspace-confirm-typed-prompt";
  prompt.append("Type ");
  const name = document.createElement("code");
  name.className = "workspace-confirm-typed-name";
  name.textContent = opts.expected;
  prompt.appendChild(name);
  prompt.append(" to confirm.");
  card.appendChild(prompt);

  const input = document.createElement("input");
  input.type = "text";
  input.className = "command-palette-input workspace-confirm-typed-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = opts.expected;
  card.appendChild(input);

  const buttons = document.createElement("div");
  buttons.className = "workspace-confirm-buttons";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "workspace-confirm-cancel";
  cancelBtn.textContent = "Cancel";

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "workspace-confirm-confirm";
  confirmBtn.textContent = opts.confirmText ?? "Delete";
  confirmBtn.disabled = true;

  buttons.appendChild(cancelBtn);
  buttons.appendChild(confirmBtn);
  card.appendChild(buttons);
  overlay.appendChild(card);

  // Exact match (trimmed) — the name is shown verbatim, so case matters.
  const matches = (): boolean => input.value.trim() === opts.expected.trim();

  let done = false;
  const close = (): void => {
    done = true;
    overlay.remove();
  };
  const confirm = (): void => {
    if (done || !matches()) return;
    close();
    opts.onConfirm();
  };

  input.addEventListener("input", () => {
    confirmBtn.disabled = !matches();
  });
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  input.addEventListener("keydown", (e) => {
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
  input.focus();
}
