// Minimal in-app editor: <textarea> backed by a synced line-number
// gutter, with ⌘S save and a "too large" / binary placeholder. No
// syntax highlighting, no LSP — explicitly out of scope per spec 3.3.
// The point is the one-line edit escape hatch with enough polish to
// feel intentional next to the rest of Covenant's surface.

import { Icons } from "../icons";
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
  private readonly extEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly wrapBtn: HTMLButtonElement;
  private readonly bodyEl: HTMLElement;
  private readonly gutterEl: HTMLElement;
  private readonly textareaEl: HTMLTextAreaElement;
  private readonly placeholderEl: HTMLElement;
  private currentPath: string | null = null;
  private originalContent: string | null = null;
  private dirty = false;
  private visible = false;
  private lastLineCount = 0;
  private wrap: boolean;

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

    this.extEl = document.createElement("span");
    this.extEl.className = "structure-editor-ext";
    this.extEl.hidden = true;
    this.headerEl.appendChild(this.extEl);

    this.statusEl = document.createElement("span");
    this.statusEl.className = "structure-editor-status";
    this.headerEl.appendChild(this.statusEl);

    // Wrap toggle — flips between soft-wrap (default) and no-wrap
    // (horizontal scroll for code with long aligned lines). The
    // preference is per-OPEN-FILE, NOT persisted across sessions:
    // every time the user opens a file the editor starts wrapped so
    // they always see the full content immediately. A previous design
    // persisted the choice in localStorage, but a single accidental
    // OFF click left the user stuck — every subsequent file opened
    // with horizontal-scroll cuts and no obvious recovery.
    this.wrap = true;
    this.wrapBtn = document.createElement("button");
    this.wrapBtn.type = "button";
    this.wrapBtn.className = "structure-editor-wrap-btn";
    this.wrapBtn.addEventListener("click", () => this.toggleWrap());
    this.headerEl.appendChild(this.wrapBtn);

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "structure-editor-close";
    closeBtn.title = "Close editor";
    closeBtn.innerHTML = Icons.x({ size: 12 });
    closeBtn.addEventListener("click", () => this.close());
    this.headerEl.appendChild(closeBtn);

    this.bodyEl = document.createElement("div");
    this.bodyEl.className = "structure-editor-body";
    this.root.appendChild(this.bodyEl);

    this.gutterEl = document.createElement("div");
    this.gutterEl.className = "structure-editor-gutter";
    this.gutterEl.setAttribute("aria-hidden", "true");
    this.bodyEl.appendChild(this.gutterEl);

    this.textareaEl = document.createElement("textarea");
    this.textareaEl.className = "structure-editor-textarea";
    this.textareaEl.spellcheck = false;
    // wrap attribute mirrors the wrap CSS — set in applyWrap() below.
    this.textareaEl.addEventListener("input", () => {
      this.dirty = this.textareaEl.value !== (this.originalContent ?? "");
      this.renderGutter();
      this.renderStatus();
    });
    this.textareaEl.addEventListener("scroll", () => {
      this.gutterEl.scrollTop = this.textareaEl.scrollTop;
    });
    this.textareaEl.addEventListener("keydown", (e) => {
      const isMod = e.metaKey || e.ctrlKey;
      if (isMod && e.key === "s") {
        e.preventDefault();
        void this.save();
      } else if (e.key === "Tab") {
        // Two-space indent on Tab (Shift+Tab dedents). Without this the
        // textarea moves focus out of the editor on every Tab — useless
        // for code.
        e.preventDefault();
        this.handleTab(e.shiftKey);
      }
    });
    this.bodyEl.appendChild(this.textareaEl);

    this.placeholderEl = document.createElement("div");
    this.placeholderEl.className = "structure-editor-placeholder";
    this.placeholderEl.hidden = true;
    this.bodyEl.appendChild(this.placeholderEl);

    this.host.appendChild(this.root);

    // Initial wrap state — applies CSS class, textarea attr, and sets
    // the toggle button label. Run after the DOM is wired so the body
    // class lands on a real element.
    this.applyWrap();
  }

  /// Flip between soft-wrap and no-wrap for the currently-open file.
  /// Not persisted — the next file open starts wrapped again.
  private toggleWrap(): void {
    this.wrap = !this.wrap;
    this.applyWrap();
  }

  /// Apply current `wrap` state to the DOM:
  ///   - textarea wrap attribute (browser line breaking)
  ///   - body CSS class (drives white-space + gutter visibility)
  ///   - button label/title for affordance
  /// Hides the gutter when wrap is on — the gutter lists ONE line per
  /// logical newline, but a wrapped textarea has more visual lines than
  /// logical, so the line numbers desync from cursor position. Hiding
  /// is simpler and more honest than fighting the math.
  private applyWrap(): void {
    this.textareaEl.wrap = this.wrap ? "soft" : "off";
    this.bodyEl.classList.toggle("structure-editor-wrap-on", this.wrap);
    this.bodyEl.classList.toggle("structure-editor-wrap-off", !this.wrap);
    this.wrapBtn.textContent = this.wrap ? "wrap: on" : "wrap: off";
    this.wrapBtn.title = this.wrap
      ? "Wrap on — long lines fold to fit the pane. Click to disable."
      : "Wrap off — long lines extend horizontally with scroll. Click to enable.";
  }

  isVisible(): boolean {
    return this.visible;
  }

  async open(path: string, opts?: { line?: number }): Promise<void> {
    this.currentPath = path;
    this.pathLabelEl.textContent = shortenPath(path);
    this.pathLabelEl.title = path;
    this.setExt(path);
    this.statusEl.textContent = "loading…";
    this.statusEl.classList.remove("dirty");
    // Reset wrap to ON for every fresh file open. The toggle is a
    // per-file knob — opening a different file always starts wrapped
    // so the user immediately sees full content, never has to fight
    // a stale preference from the previous file.
    // EXCEPTION: when opening AT a specific line (jump from global
    // search), force wrap OFF — line-jumping only makes sense if line
    // numbers in the source map 1:1 to visible rows, which wrap breaks.
    const wantWrap = opts?.line === undefined;
    if (this.wrap !== wantWrap) {
      this.wrap = wantWrap;
      this.applyWrap();
    }
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
    this.gutterEl.hidden = false;
    this.textareaEl.value = text;
    this.renderGutter();
    this.renderStatus();
    requestAnimationFrame(() => {
      this.textareaEl.focus();
      if (opts?.line !== undefined) {
        this.jumpToLine(opts.line);
      }
    });
  }

  /// Position the caret at the start of `line` (1-based) and scroll
  /// the textarea so that line is roughly centered in the viewport.
  /// Used by global search "click to open" — caret position acts as
  /// a visual marker for which match the user landed on.
  private jumpToLine(line: number): void {
    const value = this.textareaEl.value;
    const lines = value.split("\n");
    const targetIdx = Math.max(0, Math.min(line - 1, lines.length - 1));
    // Compute byte offset of the start of the target line.
    let offset = 0;
    for (let i = 0; i < targetIdx; i++) {
      offset += lines[i].length + 1; // +1 for \n
    }
    this.textareaEl.selectionStart = offset;
    this.textareaEl.selectionEnd = offset + lines[targetIdx].length;
    // Scroll: approximate by line-height × target line, then center.
    const lineHeight = 12.5 * 1.55; // matches CSS .structure-editor-textarea
    const desired = lineHeight * targetIdx - this.textareaEl.clientHeight / 2;
    this.textareaEl.scrollTop = Math.max(0, desired);
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
    this.gutterEl.textContent = "";
    this.lastLineCount = 0;
    this.callbacks.onClose?.();
  }

  private showPlaceholder(message: string): void {
    this.textareaEl.hidden = true;
    this.gutterEl.hidden = true;
    this.placeholderEl.hidden = false;
    this.placeholderEl.textContent = message;
    this.originalContent = null;
    this.dirty = false;
    this.statusEl.textContent = "";
    this.statusEl.classList.remove("dirty");
  }

  /// `●` when modified, empty when clean. Tooltip carries the full
  /// "press ⌘S to save" hint so the affordance isn't lost.
  private renderStatus(): void {
    if (this.dirty) {
      this.statusEl.textContent = "●";
      this.statusEl.title = "Unsaved changes — ⌘S to save";
      this.statusEl.classList.add("dirty");
    } else {
      this.statusEl.textContent = "";
      this.statusEl.title = "";
      this.statusEl.classList.remove("dirty");
    }
  }

  /// Recompute the gutter only if the line count changed. Building DOM
  /// for every keystroke at long files (>5k lines) would jank scroll.
  private renderGutter(): void {
    const value = this.textareaEl.value;
    // String.split('\n') is fast enough at our sizes (we cap at 1 MiB).
    // +1 because trailing-empty doesn't show as a line in `split` if the
    // string ends without `\n` — but if it ends WITH `\n` we want one
    // empty trailing line shown.
    const lineCount = countLines(value);
    if (lineCount === this.lastLineCount) return;
    this.lastLineCount = lineCount;
    let html = "";
    for (let i = 1; i <= lineCount; i++) {
      html += `<span>${i}</span>`;
    }
    this.gutterEl.innerHTML = html;
  }

  private setExt(path: string): void {
    const ext = extensionOf(path);
    if (!ext) {
      this.extEl.hidden = true;
      this.extEl.textContent = "";
      return;
    }
    this.extEl.hidden = false;
    this.extEl.textContent = ext;
  }

  private handleTab(shift: boolean): void {
    const ta = this.textareaEl;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const value = ta.value;
    if (start === end && !shift) {
      const insert = "  ";
      ta.value = value.slice(0, start) + insert + value.slice(end);
      ta.selectionStart = ta.selectionEnd = start + insert.length;
    } else {
      // Multi-line selection: indent / dedent each line.
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const block = value.slice(lineStart, end);
      const replaced = shift
        ? block.replace(/^( {1,2}|\t)/gm, "")
        : block.replace(/^/gm, "  ");
      ta.value = value.slice(0, lineStart) + replaced + value.slice(end);
      ta.selectionStart = lineStart;
      ta.selectionEnd = lineStart + replaced.length;
    }
    this.dirty = ta.value !== (this.originalContent ?? "");
    this.renderGutter();
    this.renderStatus();
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

function extensionOf(path: string): string | null {
  const base = path.split("/").pop() ?? "";
  // Dotfiles without an extension (e.g. `.gitignore`) — show "dot".
  if (base.startsWith(".") && !base.slice(1).includes(".")) {
    return base.slice(1).toLowerCase().slice(0, 8) || null;
  }
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = base.slice(dot + 1).toLowerCase();
  if (!ext || ext.length > 8) return null;
  return ext;
}

function countLines(s: string): number {
  if (s.length === 0) return 1;
  let count = 1;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) count++;
  }
  return count;
}

