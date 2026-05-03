// In-app editor backed by CodeMirror 6. The pane lives inside the
// Structure split (between terminal and sidebar); same header as
// before (path, ext chip, dirty indicator, wrap toggle, close), but
// the body is now an EditorView with syntax highlighting, gutter,
// undo, multi-cursor, in-file ⌘F search, and virtualised rendering.
//
// ⌘F     — open in-file search panel (CM6 default).
// ⌘⇧F    — UNTOUCHED. The global content-search palette wins; we
//          deliberately don't register Mod-Shift-f anywhere here.
// ⌘S     — save file (custom keymap below).
// ⌘Z/⌘⇧Z — undo / redo (history extension).
// Tab / Shift-Tab — indent / dedent (CM6 default).
//
// Wrap toggle, save, jumpToLine and the size/binary placeholder all
// route through CM6's reconfiguration / dispatch APIs instead of the
// previous textarea+gutter DOM.

import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  rectangularSelection,
  crosshairCursor,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  indentUnit,
} from "@codemirror/language";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";

import { Icons } from "../icons";
import { structureReadFile, structureWriteFile } from "../api";
import { languageForPath } from "./languages";
import { editorHighlight, editorTheme } from "./theme";

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
  private readonly editorHostEl: HTMLElement;
  private readonly placeholderEl: HTMLElement;
  private currentPath: string | null = null;
  private originalContent: string | null = null;
  private dirty = false;
  private visible = false;
  private wrap: boolean;

  /// CM6 view + reconfigurable compartments. Compartments let us swap
  /// the language extension and toggle line-wrapping without rebuilding
  /// the editor state from scratch on every file open / wrap toggle.
  private view: EditorView | null = null;
  private readonly languageCompartment = new Compartment();
  private readonly wrapCompartment = new Compartment();

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

    // Wrap toggle — flips between soft-wrap (default) and no-wrap.
    // Per-file, not persisted: every fresh file open starts wrapped.
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

    // Editor host — CM6 mounts here. Kept separate from `bodyEl` so the
    // placeholder can sit alongside without colliding with CM6's layout.
    this.editorHostEl = document.createElement("div");
    this.editorHostEl.className = "structure-editor-cm";
    this.bodyEl.appendChild(this.editorHostEl);

    this.placeholderEl = document.createElement("div");
    this.placeholderEl.className = "structure-editor-placeholder";
    this.placeholderEl.hidden = true;
    this.bodyEl.appendChild(this.placeholderEl);

    this.host.appendChild(this.root);

    this.refreshWrapButton();
  }

  /// Build a fresh EditorState for `text` with the language matching
  /// `path` (null → no language, plain editing). Reusable on every
  /// file open: CM6 is fastest when the state is constructed once
  /// per document instead of mutated piecemeal.
  private buildState(path: string, text: string): EditorState {
    const lang = languageForPath(path);
    const langExtension = lang ? [lang] : [];

    return EditorState.create({
      doc: text,
      extensions: [
        // Chrome.
        editorTheme,
        editorHighlight,
        lineNumbers(),
        foldGutter(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        drawSelection(),
        rectangularSelection(),
        crosshairCursor(),
        highlightSelectionMatches(),

        // Editing.
        history(),
        bracketMatching(),
        indentOnInput(),
        indentUnit.of("  "), // 2-space indent — matches the previous textarea behaviour.
        EditorView.lineWrapping, // placeholder; replaced by wrap compartment below
        this.wrapCompartment.of(this.wrap ? EditorView.lineWrapping : []),

        // Language (in a compartment so future file opens swap it
        // without rebuilding the whole state).
        this.languageCompartment.of(langExtension),

        // Keymap. Order matters — search/history/default keep their
        // standard bindings; we add Mod-s explicitly. We deliberately
        // do NOT include any binding that would touch Mod-Shift-f
        // (the global content-search palette owns that).
        keymap.of([
          { key: "Mod-s", preventDefault: true, run: () => this.handleSave() },
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...defaultKeymap,
          indentWithTab,
        ]),

        // Track dirty state. Cheaper than diffing the whole doc — the
        // listener fires only when the document actually changes.
        EditorView.updateListener.of((u) => {
          if (u.docChanged) this.onDocChanged();
        }),
      ],
    });
  }

  private onDocChanged(): void {
    if (!this.view) return;
    const current = this.view.state.doc.toString();
    const next = current !== (this.originalContent ?? "");
    if (next !== this.dirty) {
      this.dirty = next;
      this.renderStatus();
    }
  }

  /// Save handler bound to ⌘S in the keymap. Returns `true` to stop
  /// CM6 from also handling the event.
  private handleSave(): boolean {
    void this.save();
    return true;
  }

  /// Flip between soft-wrap and no-wrap for the currently-open file.
  /// Reconfigures the wrap compartment in-place — no state rebuild.
  private toggleWrap(): void {
    this.wrap = !this.wrap;
    if (this.view) {
      this.view.dispatch({
        effects: this.wrapCompartment.reconfigure(
          this.wrap ? EditorView.lineWrapping : [],
        ),
      });
    }
    this.refreshWrapButton();
  }

  private refreshWrapButton(): void {
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

    // Reset wrap to ON for every fresh file open. EXCEPTION: when
    // jumping to a specific line (global search → editor), force wrap
    // OFF so line numbers map 1:1 to visible rows.
    const wantWrap = opts?.line === undefined;
    if (this.wrap !== wantWrap) {
      this.wrap = wantWrap;
      this.refreshWrapButton();
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
    this.editorHostEl.hidden = false;

    // Tear down any previous view + state. Cheaper than reconfiguring
    // language + replacing the whole document on a totally different
    // file; CM6 dispatches per-line for big inserts otherwise.
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    const state = this.buildState(path, text);
    this.view = new EditorView({
      state,
      parent: this.editorHostEl,
    });
    this.renderStatus();

    requestAnimationFrame(() => {
      if (!this.view) return;
      this.view.focus();
      if (opts?.line !== undefined) {
        this.jumpToLine(opts.line);
      }
    });
  }

  /// Move caret + scroll to `line` (1-based) in the active doc. Used
  /// by global content search "click to open" and intentional jumps
  /// from elsewhere in the app.
  private jumpToLine(line: number): void {
    if (!this.view) return;
    const doc = this.view.state.doc;
    const target = Math.max(1, Math.min(line, doc.lines));
    const lineInfo = doc.line(target);
    this.view.dispatch({
      selection: { anchor: lineInfo.from, head: lineInfo.to },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: "center" }),
    });
  }

  async save(): Promise<void> {
    if (!this.currentPath || !this.view) return;
    if (!this.dirty) return;
    const text = this.view.state.doc.toString();
    try {
      await structureWriteFile(this.currentPath, text);
      this.originalContent = text;
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
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.callbacks.onClose?.();
  }

  private showPlaceholder(message: string): void {
    if (this.view) {
      this.view.destroy();
      this.view = null;
    }
    this.editorHostEl.hidden = true;
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
