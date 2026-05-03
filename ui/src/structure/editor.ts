// Minimal in-app editor: <textarea> with ⌘S save and a "too large" /
// binary placeholder. No syntax highlighting, no LSP — explicitly out
// of scope per spec 3.3. The point is the one-line edit escape hatch.

import { structureReadFile, structureWriteFile } from "../api";

export interface EditorCallbacks {
  onSave?: (path: string) => void;
  onClose?: () => void;
  toast?: (message: string, severity?: "info" | "error") => void;
}

const SIZE_THRESHOLD_BYTES = 1024 * 1024; // 1 MiB per spec.

export class StructureEditor {
  private readonly root: HTMLElement;
  private readonly headerEl: HTMLElement;
  private readonly pathLabelEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly textareaEl: HTMLTextAreaElement;
  private readonly placeholderEl: HTMLElement;
  private currentPath: string | null = null;
  private originalContent: string | null = null;
  private dirty = false;
  private visible = false;

  constructor(
    private readonly host: HTMLElement,
    private readonly callbacks: EditorCallbacks,
  ) {
    this.root = document.createElement("div");
    this.root.className = "structure-editor";
    this.root.hidden = true;

    this.headerEl = document.createElement("header");
    this.headerEl.className = "structure-editor-header";
    this.root.appendChild(this.headerEl);

    this.pathLabelEl = document.createElement("span");
    this.pathLabelEl.className = "structure-editor-path";
    this.headerEl.appendChild(this.pathLabelEl);

    this.statusEl = document.createElement("span");
    this.statusEl.className = "structure-editor-status";
    this.headerEl.appendChild(this.statusEl);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "structure-editor-close";
    closeBtn.title = "Close editor";
    closeBtn.textContent = "✕";
    closeBtn.addEventListener("click", () => this.close());
    this.headerEl.appendChild(closeBtn);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "structure-editor-body";
    this.root.appendChild(this.bodyEl);

    this.textareaEl = document.createElement("textarea");
    this.textareaEl.className = "structure-editor-textarea";
    this.textareaEl.spellcheck = false;
    this.textareaEl.addEventListener("input", () => {
      this.dirty = this.textareaEl.value !== (this.originalContent ?? "");
      this.renderStatus();
    });
    this.textareaEl.addEventListener("keydown", (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === "s") {
        e.preventDefault();
        void this.save();
      }
    });
    this.bodyEl.appendChild(this.textareaEl);

    this.placeholderEl = document.createElement("div");
    this.placeholderEl.className = "structure-editor-placeholder";
    this.placeholderEl.hidden = true;
    this.bodyEl.appendChild(this.placeholderEl);

    this.host.appendChild(this.root);
  }

  isVisible(): boolean {
    return this.visible;
  }

  async open(path: string): Promise<void> {
    this.currentPath = path;
    this.pathLabelEl.textContent = shortenPath(path);
    this.pathLabelEl.title = path;
    this.statusEl.textContent = "loading…";
    this.show();
    let result;
    try {
      result = await structureReadFile(path, SIZE_THRESHOLD_BYTES);
    } catch (err) {
      this.showPlaceholder(`Failed to read: ${err}`);
      return;
    }
    if (result.kind === "too_large") {
      this.showPlaceholder(
        `File too large to preview (${formatBytes(result.size_bytes)}). ` +
          `Edit it in your editor of choice.`,
      );
      return;
    }
    if (result.kind === "binary") {
      this.showPlaceholder("Binary file — not editable here.");
      return;
    }
    const text = result.content ?? "";
    this.originalContent = text;
    this.dirty = false;
    this.placeholderEl.hidden = true;
    this.textareaEl.hidden = false;
    this.textareaEl.value = text;
    this.renderStatus();
    requestAnimationFrame(() => this.textareaEl.focus());
  }

  async save(): Promise<void> {
    if (!this.currentPath) return;
    if (!this.dirty) return;
    try {
      await structureWriteFile(this.currentPath, this.textareaEl.value);
      this.originalContent = this.textareaEl.value;
      this.dirty = false;
      this.renderStatus();
      this.callbacks.toast?.("Saved", "info");
      this.callbacks.onSave?.(this.currentPath);
    } catch (err) {
      this.callbacks.toast?.(`Save failed: ${err}`, "error");
    }
  }

  show(): void {
    if (this.visible) return;
    this.visible = true;
    this.root.hidden = false;
    this.host.classList.add("structure-editor-open");
  }

  close(): void {
    if (!this.visible) return;
    if (this.dirty) {
      const ok = window.confirm("Discard unsaved changes?");
      if (!ok) return;
    }
    this.visible = false;
    this.root.hidden = true;
    this.host.classList.remove("structure-editor-open");
    this.currentPath = null;
    this.originalContent = null;
    this.dirty = false;
    this.textareaEl.value = "";
    this.callbacks.onClose?.();
  }

  private showPlaceholder(message: string): void {
    this.textareaEl.hidden = true;
    this.placeholderEl.hidden = false;
    this.placeholderEl.textContent = message;
    this.originalContent = null;
    this.dirty = false;
    this.statusEl.textContent = "";
  }

  private renderStatus(): void {
    this.statusEl.textContent = this.dirty ? "modified · ⌘S to save" : "saved";
  }
}

function shortenPath(p: string): string {
  const parts = p.split("/").filter(Boolean);
  if (parts.length <= 3) return p;
  return ".../" + parts.slice(-3).join("/");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
}
