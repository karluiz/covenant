import { formatChord } from "../platform";
/// Centered rename prompt — a single-input card in the command-palette
/// visual language. Used for workspace rename, where the palette closes
/// before the action runs and the Tauri webview suppresses window.prompt.

export interface RenamePromptOptions {
  /// Text for the label chip at the left of the input row.
  label?: string;
  /// Initial value; focused and fully selected on open.
  value: string;
  /// Called with the trimmed value on Enter (skipped when empty).
  onCommit: (value: string) => void;
}

export function openRenamePrompt(opts: RenamePromptOptions): void {
  document.querySelector(".workspace-rename-overlay")?.remove();

  const overlay = document.createElement("div");
  overlay.className = "command-palette-overlay workspace-rename-overlay";

  const card = document.createElement("div");
  card.className = "command-palette-card workspace-rename-card";

  const row = document.createElement("div");
  row.className = "command-palette-input-row";

  const label = document.createElement("span");
  label.className = "command-palette-label";
  label.textContent = opts.label ?? "Rename";

  const input = document.createElement("input");
  input.type = "text";
  input.className = "command-palette-input";
  input.autocomplete = "off";
  input.spellcheck = false;
  input.value = opts.value;

  const hint = document.createElement("div");
  hint.className = "workspace-rename-hint";
  hint.textContent = `${formatChord(["enter"])} save · esc cancel`;

  row.appendChild(label);
  row.appendChild(input);
  card.appendChild(row);
  card.appendChild(hint);
  overlay.appendChild(card);

  const close = (): void => overlay.remove();

  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const v = input.value.trim();
      close();
      if (v !== "") opts.onCommit(v);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  });

  document.body.appendChild(overlay);
  input.focus();
  input.select();
}
